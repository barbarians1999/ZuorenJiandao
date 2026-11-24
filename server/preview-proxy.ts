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
const MAX_CAPTURE_CHARS = 128 * 1024;
const DIRECT_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
export const PREVIEW_PROXY_KIND = 'proxy-720-v2';

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

export async function probePreviewSource(file: string, signal: AbortSignal): Promise<PreviewSourceProbe> {
  const { stdout } = await runPreviewProcess(ffprobeBin(), [
    '-v', 'error', '-threads', '1', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-read_intervals', `%+${GOP_SAMPLE_SECONDS}`, '-show_frames', '-show_streams', '-show_format',
    '-show_entries', 'format=duration,bit_rate:stream=codec_name,width,height,bit_rate,has_b_frames,avg_frame_rate,r_frame_rate:frame=best_effort_timestamp_time',
    '-of', 'json', file,
  ], signal, PROBE_TIMEOUT_MS);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<{
      codec_name?: string; width?: number; height?: number; bit_rate?: string; has_b_frames?: number;
      avg_frame_rate?: string; r_frame_rate?: string;
    }>;
    frames?: Array<{ best_effort_timestamp_time?: string }>;
  };
  const stream = parsed.streams?.[0];
  const durationMs = Math.round(positiveNumber(parsed.format?.duration) * 1000);
  const codec = stream?.codec_name?.toLowerCase() ?? '';
  const maxKeyframeGapSeconds = sampledKeyframeGap(parsed.frames, durationMs);
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
  };
}

export function previewProxyReason(probe: PreviewSourceProbe, force: boolean): string | null {
  if (force) return 'direct-preview-failed';
  const longEdge = Math.max(probe.width, probe.height);
  const shortEdge = Math.min(probe.width, probe.height);
  if (longEdge > 1920 || shortEdge > 1080) return 'high-resolution';
  if (probe.longGop) return 'long-gop';
  if (probe.unstableCodec) return 'unstable-codec';
  if (shortEdge >= 1080 && probe.durationMs >= 30_000 && probe.bitrate >= HD_BITRATE_THRESHOLD) return 'high-hd-bitrate';
  if (shortEdge >= 1080 && probe.durationMs >= 120_000 && probe.hasBFrames
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
    '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '128k', output,
  ];
}

export async function buildPreviewProxy(file: string, output: string, signal: AbortSignal, {
  preferred, frameRate = 30,
}: { preferred?: H264Encoder; frameRate?: number } = {}): Promise<void> {
  if (signal.aborted) throw abortError();
  const ffmpeg = ffmpegBin();
  const encoder = preferred ?? await resolveH264Encoder(ffmpeg);
  const deadline = Date.now() + PROXY_TIMEOUT_MS;
  try {
    await runPreviewProcess(ffmpeg, previewProxyEncodeArgs(file, output, encoder, frameRate), signal, PROXY_TIMEOUT_MS);
    if (encoder !== 'libx264') {
      const probe = await probePreviewSource(output, signal);
      const maxGap = 0.5 + 1 / frameRate + 0.001;
      if (probe.hasBFrames || probe.maxKeyframeGapSeconds === null || probe.maxKeyframeGapSeconds > maxGap) {
        throw new Error('Hardware preview proxy has incompatible keyframe spacing or B-frames');
      }
    }
  } catch (error) {
    if (encoder === 'libx264' || signal.aborted || Date.now() >= deadline) throw error;
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
  source: Pick<PreviewSourceProbe, 'durationMs' | 'width' | 'height' | 'codec' | 'longGop'> & { src: string };
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
  proxyPath: string,
  statusPath: string,
  deps: PreviewProxyDependencies,
  signal: AbortSignal,
): Promise<ProxyPayload> {
  const probe = await probePreviewSource(hit.file, signal);
  const source = sourcePayload(src, probe);
  const reason = previewProxyReason(probe, force);
  if (!reason) return { source, proxy: { status: 'not-needed', reason: 'source-compatible' } };
  const previewSource = async () => `/api/preview-proxy-file?src=${encodeURIComponent(src)}&revision=${Math.floor((await stat(proxyPath)).mtimeMs * 1000)}`;
  // A rebuilt file at the same URL can reuse a poisoned browser/decoder cache.
  // The revision changes only when this derivative is actually replaced.
  if (existsSync(proxyPath)) return { source, proxy: { status: 'ready', reason, previewSrc: await previewSource() } };
  const failed = await previousFailure(statusPath);
  if (failed) return { source, proxy: { status: 'failed', ...failed } };
  try {
    await deps.atomicBuild(proxyPath, (tmp) => buildPreviewProxy(hit.file, tmp, signal, { frameRate: probe.frameRate }));
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
    const proxyPath = deps.cachePath(hit.name, hit.source, PREVIEW_PROXY_KIND, 'mp4');
    const statusPath = deps.cachePath(hit.name, hit.source, `${PREVIEW_PROXY_KIND}-status`, 'json');
    // Long proxy builds keep their bounded queue lease when the view disconnects.
    let payload = await deps.runDerivative(req, res, proxyPath, async (signal) => {
      if (retry) {
        if (signal.aborted) throw abortError();
        // Only this source's derivative artifacts, never the master media.
        for (const path of [statusPath, proxyPath]) {
          await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
      return createProxyPayload(hit, src, force, proxyPath, statusPath, deps, signal);
    }, proxyPath, true);
    if (force && payload.proxy.status === 'not-needed') {
      payload = await deps.runDerivative(req, res, `${proxyPath}#force`, (signal) => (
        createProxyPayload(hit, src, true, proxyPath, statusPath, deps, signal)
      ), proxyPath, true);
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
    const proxyPath = deps.cachePath(hit.name, hit.source, PREVIEW_PROXY_KIND, 'mp4');
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
