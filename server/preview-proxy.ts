import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import { ffmpegThreadCount, spawnMediaProcess } from './media-process.ts';
import { h264EncoderFallbackReason, h264EncodingArgs, h264FilterChain, h264GlobalArgs, resolveH264Encoder, type H264Encoder } from './media-acceleration.ts';

const PROBE_TIMEOUT_MS = 60_000;
const PROXY_TIMEOUT_MS = 30 * 60_000;
const GOP_SAMPLE_SECONDS = 12;
const LONG_GOP_SECONDS = 4;
const HD_BITRATE_THRESHOLD = 12_000_000;
const PROXY_TARGET_BITRATE = 2_500_000;
const PROXY_PEAK_BITRATE = 4_000_000;
const PROXY_SCALE = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
const MAX_CAPTURE_CHARS = 512 * 1024;
const DIRECT_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const ALPHA_PIX_FMT = /^(?:yuva|rgba|bgra|argb|abgr|gbrap|ya\d|ayuv|pal8)/i;
export const PREVIEW_PROXY_KIND = 'proxy-720-v2';
export const PREVIEW_ALPHA_PROXY_KIND = 'proxy-720-alpha-v3';

export interface PreviewSourceProbe {
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  longGop: boolean;
  unstableCodec: boolean;
  bitrate: number;
  hasBFrames: boolean;
  maxKeyframeGapSeconds: number | null;
  frameRate: number;
  pixFmt?: string;
  hasAlpha?: boolean;
  hasAudio?: boolean;
}

export interface PreviewProcessOutput { stdout: string; stderr: string }

function abortError(): Error {
  const error = new Error('derivative request cancelled');
  error.name = 'AbortError';
  return error;
}

function appendBounded(value: string, chunk: Buffer): string {
  const next = value + String(chunk);
  return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS / 2);
}

export function runPreviewProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<PreviewProcessOutput> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const child = spawnMediaProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const abort = () => child.kill('SIGKILL');
    process.once('exit', abort);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      process.removeListener('exit', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      process.removeListener('exit', abort);
      if (signal.aborted) reject(abortError());
      else if (timedOut) reject(new Error(`${command} timed out`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function sampledKeyframeGap(frames: Array<{ best_effort_timestamp_time?: string }> | undefined, durationMs: number): number | null {
  const sampleEnd = Math.min(GOP_SAMPLE_SECONDS, durationMs / 1000);
  const times = (frames ?? [])
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= sampleEnd)
    .sort((a, b) => a - b);
  if (!times.length) return null;
  let previous = 0;
  let largestGap = times[0];
  for (const time of times) {
    largestGap = Math.max(largestGap, time - previous);
    previous = time;
  }
  return Math.max(largestGap, sampleEnd - previous);
}

function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function rationalFrameRate(value = ''): number {
  const [numerator, denominator = '1'] = value.split('/');
  return positiveNumber(Number(numerator) / Number(denominator));
}

export function hasAlphaChannel(pixFmt?: string, tags?: Record<string, string>): boolean {
  if (pixFmt && ALPHA_PIX_FMT.test(pixFmt.trim())) return true;
  if (tags) {
    for (const [key, value] of Object.entries(tags)) {
      if (/^alpha_mode$/i.test(key) && /^(?:1|true)$/i.test(value.trim())) return true;
    }
  }
  return false;
}

export async function probePreviewSource(file: string, signal: AbortSignal): Promise<PreviewSourceProbe> {
  const { stdout } = await runPreviewProcess(ffprobeBin(), [
    '-v', 'error', '-threads', '1',
    '-read_intervals', `%+${GOP_SAMPLE_SECONDS}`, '-show_packets', '-show_streams', '-show_format',
    '-show_entries', 'format=duration,bit_rate:stream=index,codec_type,codec_name,pix_fmt,width,height,bit_rate,has_b_frames,avg_frame_rate,r_frame_rate:stream_tags=alpha_mode,ALPHA_MODE:packet=stream_index,flags,pts_time,dts_time',
    '-of', 'json', file,
  ], signal, PROBE_TIMEOUT_MS);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<{
      index?: number; codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; bit_rate?: string; has_b_frames?: number;
      avg_frame_rate?: string; r_frame_rate?: string; tags?: Record<string, string>;
    }>;
    packets?: Array<{ stream_index?: number; flags?: string; pts_time?: string; dts_time?: string }>;
  };
  const stream = parsed.streams?.find((candidate) => candidate.codec_type === 'video') ?? parsed.streams?.[0];
  const hasAudio = Boolean(parsed.streams?.some((candidate) => candidate.codec_type === 'audio'));
  const videoIndex = stream?.index ?? 0;
  const keyframeFrames = (parsed.packets ?? [])
    .filter((packet) => packet.stream_index === videoIndex && typeof packet.flags === 'string' && packet.flags.includes('K'))
    .map((packet) => ({ best_effort_timestamp_time: packet.pts_time ?? packet.dts_time }));
  const durationMs = Math.round(positiveNumber(parsed.format?.duration) * 1000);
  const codec = stream?.codec_name?.toLowerCase() ?? '';
  const maxKeyframeGapSeconds = sampledKeyframeGap(keyframeFrames, durationMs);
  return {
    durationMs,
    width: stream?.width ?? 0,
    height: stream?.height ?? 0,
    codec,
    longGop: durationMs > LONG_GOP_SECONDS * 2000 && (maxKeyframeGapSeconds ?? Infinity) > LONG_GOP_SECONDS,
    unstableCodec: !DIRECT_CODECS.has(codec),
    bitrate: positiveNumber(stream?.bit_rate) || positiveNumber(parsed.format?.bit_rate),
    hasBFrames: positiveNumber(stream?.has_b_frames) > 0,
    maxKeyframeGapSeconds,
    frameRate: rationalFrameRate(stream?.avg_frame_rate) || rationalFrameRate(stream?.r_frame_rate) || 30,
    pixFmt: stream?.pix_fmt?.toLowerCase() ?? '',
    hasAlpha: hasAlphaChannel(stream?.pix_fmt, stream?.tags),
    hasAudio,
  };
}

export function previewProxyReason(probe: PreviewSourceProbe, force: boolean): string | null {
  if (probe.hasAlpha) {
    // Opaque H.264 proxies strip alpha and turn transparent overlays black.
    // Downscale >720p or long-GOP transparent overlays into fast-seek 720p VP9+Alpha WebM proxies,
    // and leave lightweight <=720p short-GOP transparent streams untouched.
    if (probe.unstableCodec) return 'unstable-codec';
    const longEdge = Math.max(probe.width, probe.height);
    const shortEdge = Math.min(probe.width, probe.height);
    if (longEdge > 1280 || shortEdge > 720) return 'high-resolution-alpha';
    if (probe.longGop) return 'long-gop-alpha';
    return null;
  }
  if (force) return 'direct-preview-failed';
  if (probe.pixFmt && /(?:10|12|16)(?:le|be)|p010|p016/i.test(probe.pixFmt)) return 'high-bit-depth';
  const longEdge = Math.max(probe.width, probe.height);
  const shortEdge = Math.min(probe.width, probe.height);
  if (longEdge > 1920 || shortEdge > 1080) return 'high-resolution';
  if (probe.longGop) return 'long-gop';
  if (probe.unstableCodec) return 'unstable-codec';
  if (shortEdge >= 1080 && probe.durationMs >= 10_000 && probe.frameRate >= 48) return 'high-framerate-hd';
  if (shortEdge >= 1080 && probe.durationMs >= 30_000 && probe.bitrate >= HD_BITRATE_THRESHOLD) return 'high-hd-bitrate';
  if (shortEdge >= 1080 && probe.durationMs >= 20_000 && probe.hasBFrames
    && (probe.maxKeyframeGapSeconds ?? 0) >= 2) return 'long-hd-gop';
  return null;
}

export function previewProxyEncodeArgs(file: string, output: string, encoder: H264Encoder = 'libx264', frameRate = 30): string[] {
  const threads = String(Math.min(4, ffmpegThreadCount(), Math.max(1, Math.floor(availableParallelism() / 4))));
  const software = encoder === 'libx264';
  const encoding = software
    ? ['-c:v', encoder, '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '25', '-pix_fmt', 'yuv420p',
      '-maxrate', String(PROXY_PEAK_BITRATE), '-bufsize', String(PROXY_PEAK_BITRATE)]
    : h264EncodingArgs({ encoder, targetBitrate: PROXY_TARGET_BITRATE,
      maxBitrate: PROXY_PEAK_BITRATE, bufferSize: PROXY_PEAK_BITRATE });
  const profile = encoder === 'h264_amf' || encoder === 'h264_vaapi' ? 'constrained_baseline' : 'baseline';
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    ...h264GlobalArgs(encoder), '-filter_threads', '1', '-threads', threads, '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', h264FilterChain(encoder, [PROXY_SCALE]), ...encoding,
    '-threads', threads, '-profile:v', profile, '-bf', '0',
    // Some hardware encoders ignore force_key_frames. Their GOP length is in frames.
    ...(software ? [] : ['-g', String(Math.max(1, Math.floor(frameRate / 2)))]),
    ...(encoder === 'h264_amf' ? ['-gops_per_idr', '1'] : []),
    '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', output,
  ];
}

const disqualifiedAutoHardwareEncoders = new Set<H264Encoder>();

export function previewAlphaProxyEncodeArgs(
  file: string,
  output: string,
  frameRate = 30,
  sourceCodec = '',
): string[] {
  const threads = String(Math.min(4, ffmpegThreadCount(), Math.max(1, Math.floor(availableParallelism() / 4))));
  const keyframeInterval = String(Math.max(1, Math.floor(frameRate / 2)));
  const inputDecoder = sourceCodec === 'vp9' ? ['-c:v', 'libvpx-vp9'] : sourceCodec === 'vp8' ? ['-c:v', 'libvpx'] : [];
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-filter_threads', '1', '-threads', threads, ...inputDecoder, '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    '-vf', PROXY_SCALE,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
    '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
    '-tile-columns', '2', '-frame-parallel', '1',
    '-crf', '32', '-b:v', '0', '-g', keyframeInterval,
    '-threads', threads,
    '-c:a', 'libopus', '-b:a', '96k', output,
  ];
}

export async function buildPreviewProxy(file: string, output: string, signal: AbortSignal, {
  preferred, frameRate = 30, preserveAlpha = false, sourceCodec = '',
}: { preferred?: H264Encoder; frameRate?: number; preserveAlpha?: boolean; sourceCodec?: string } = {}): Promise<void> {
  if (signal.aborted) throw abortError();
  const ffmpeg = ffmpegBin();
  if (preserveAlpha) {
    await runPreviewProcess(ffmpeg, previewAlphaProxyEncodeArgs(file, output, frameRate, sourceCodec), signal, PROXY_TIMEOUT_MS);
    return;
  }
  const resolvedCandidate = preferred ?? await resolveH264Encoder(ffmpeg);
  const encoder = !preferred && disqualifiedAutoHardwareEncoders.has(resolvedCandidate) ? 'libx264' : resolvedCandidate;
  const deadline = Date.now() + PROXY_TIMEOUT_MS;
  try {
    await runPreviewProcess(ffmpeg, previewProxyEncodeArgs(file, output, encoder, frameRate), signal, PROXY_TIMEOUT_MS);
    if (encoder !== 'libx264') {
      const probe = await probePreviewSource(output, signal);
      const maxGap = 0.5 + 1 / frameRate + 0.001;
      const singleGopShortClip = probe.durationMs > 0 && probe.durationMs <= 600 && probe.maxKeyframeGapSeconds === null;
      if (probe.hasBFrames || (!singleGopShortClip && (probe.maxKeyframeGapSeconds === null || probe.maxKeyframeGapSeconds > maxGap))) {
        throw new Error('Hardware preview proxy has incompatible keyframe spacing or B-frames');
      }
    }
  } catch (error) {
    if (encoder === 'libx264' || signal.aborted || Date.now() >= deadline) throw error;
    if (!preferred) disqualifiedAutoHardwareEncoders.add(encoder);
    console.warn(`[preview-proxy] ${h264EncoderFallbackReason(encoder, error)}; falling back to libx264`);
    await unlink(output).catch(() => {});
    await runPreviewProcess(ffmpeg, previewProxyEncodeArgs(file, output), signal, Math.max(1, deadline - Date.now()));
  }
}

interface PreviewHit {
  name: string;
  file: string;
  source: { size: number; mtimeMs: number };
}

interface PreviewProxyDependencies {
  resolve: (req: IncomingMessage, res: ServerResponse) => Promise<PreviewHit | null>;
  cachePath: (name: string, source: PreviewHit['source'], kind: string, ext: string) => string;
  atomicBuild: (path: string, build: (tmp: string) => Promise<void>) => Promise<void>;
  runDerivative: <T>(
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    protectedPath?: string,
    retainUntilComplete?: boolean,
  ) => Promise<T>;
  serveCached: (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  handleError: (res: ServerResponse, label: string, error: unknown) => void;
  logError: (message: string) => void;
}

type ProxyPayload = {
  source: Pick<PreviewSourceProbe, 'durationMs' | 'width' | 'height' | 'codec' | 'longGop'> & { src: string; hasAlpha: boolean; hasAudio?: boolean };
  proxy:
    | { status: 'not-needed'; reason: string }
    | { status: 'ready'; reason: string; previewSrc: string }
    | { status: 'failed'; reason: string; error: string };
};

function sourcePayload(src: string, probe: PreviewSourceProbe): ProxyPayload['source'] {
  return {
    src,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height,
    codec: probe.codec,
    longGop: probe.longGop,
    hasAlpha: Boolean(probe.hasAlpha),
    ...(typeof probe.hasAudio === 'boolean' ? { hasAudio: probe.hasAudio } : {}),
  };
}

async function previousFailure(path: string): Promise<{ reason: string; error: string } | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as { reason: string; error: string };
  } catch {
    return null;
  }
}

async function createProxyPayload(
  hit: PreviewHit,
  src: string,
  force: boolean,
  paths: {
    standardProxy: string;
    standardStatus: string;
    alphaProxy: string;
    alphaStatus: string;
  },
  deps: PreviewProxyDependencies,
  signal: AbortSignal,
): Promise<ProxyPayload> {
  const probe = await probePreviewSource(hit.file, signal);
  const source = sourcePayload(src, probe);
  const reason = previewProxyReason(probe, force);
  if (!reason) {
    return {
      source,
      proxy: { status: 'not-needed', reason: probe.hasAlpha ? 'alpha-channel-preserved' : 'source-compatible' },
    };
  }
  const preserveAlpha = Boolean(probe.hasAlpha);
  const proxyPath = preserveAlpha ? paths.alphaProxy : paths.standardProxy;
  const statusPath = preserveAlpha ? paths.alphaStatus : paths.standardStatus;
  const formatParam = preserveAlpha ? '&format=webm' : '';
  const previewSource = async () => (
    `/api/preview-proxy-file?src=${encodeURIComponent(src)}${formatParam}&revision=${Math.floor((await stat(proxyPath)).mtimeMs * 1000)}`
  );
  // A rebuilt file at the same URL can reuse a poisoned browser/decoder cache.
  // The revision changes only when this derivative is actually replaced.
  if (existsSync(proxyPath)) return { source, proxy: { status: 'ready', reason, previewSrc: await previewSource() } };
  const failed = await previousFailure(statusPath);
  if (failed) return { source, proxy: { status: 'failed', ...failed } };
  try {
    await deps.atomicBuild(proxyPath, (tmp) => buildPreviewProxy(hit.file, tmp, signal, {
      frameRate: probe.frameRate,
      preserveAlpha,
      sourceCodec: probe.codec,
    }));
    await unlink(statusPath).catch(() => {});
    return { source, proxy: { status: 'ready', reason, previewSrc: await previewSource() } };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await deps.atomicBuild(statusPath, (tmp) => writeFile(tmp, JSON.stringify({ reason, error: message })));
    deps.logError(`[preview-proxy] ${message}`);
    return { source, proxy: { status: 'failed', reason, error: message } };
  }
}

export async function handlePreviewProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreviewProxyDependencies,
): Promise<void> {
  try {
    const hit = await deps.resolve(req, res);
    if (!hit) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const src = url.searchParams.get('src') ?? '';
    const retry = url.searchParams.get('retry') === '1';
    const force = url.searchParams.get('force') === '1' || retry;
    const paths = {
      standardProxy: deps.cachePath(hit.name, hit.source, PREVIEW_PROXY_KIND, 'mp4'),
      standardStatus: deps.cachePath(hit.name, hit.source, `${PREVIEW_PROXY_KIND}-status`, 'json'),
      alphaProxy: deps.cachePath(hit.name, hit.source, PREVIEW_ALPHA_PROXY_KIND, 'webm'),
      alphaStatus: deps.cachePath(hit.name, hit.source, `${PREVIEW_ALPHA_PROXY_KIND}-status`, 'json'),
    };
    // Long proxy builds keep their bounded queue lease when the view disconnects.
    let payload = await deps.runDerivative(req, res, paths.standardProxy, async (signal) => {
      if (retry) {
        if (signal.aborted) throw abortError();
        // Only this source's derivative artifacts, never the master media.
        for (const path of [paths.standardStatus, paths.standardProxy, paths.alphaStatus, paths.alphaProxy]) {
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
      return createProxyPayload(hit, src, force, paths, deps, signal);
    }, paths.standardProxy, true);
    if (force && payload.proxy.status === 'not-needed' && payload.proxy.reason !== 'alpha-channel-preserved') {
      payload = await deps.runDerivative(req, res, `${paths.standardProxy}#force`, (signal) => (
        createProxyPayload(hit, src, true, paths, deps, signal)
      ), paths.standardProxy, true);
    }
    if (!res.destroyed) deps.sendJson(res, 200, payload);
  } catch (error) {
    deps.handleError(res, 'preview-proxy', error);
  }
}

export async function handlePreviewProxyFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreviewProxyDependencies,
): Promise<void> {
  try {
    const hit = await deps.resolve(req, res);
    if (!hit) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isAlphaWebm = url.searchParams.get('format') === 'webm';
    const proxyPath = isAlphaWebm
      ? deps.cachePath(hit.name, hit.source, PREVIEW_ALPHA_PROXY_KIND, 'webm')
      : deps.cachePath(hit.name, hit.source, PREVIEW_PROXY_KIND, 'mp4');
    if (!existsSync(proxyPath)) {
      deps.sendJson(res, 404, { error: 'preview proxy is not ready' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    await deps.serveCached(req, res, proxyPath);
  } catch (error) {
    deps.handleError(res, 'preview-proxy-file', error);
  }
}
