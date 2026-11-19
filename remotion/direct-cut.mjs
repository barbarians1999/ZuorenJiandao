import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { statfsSync } from 'node:fs';
import { localVideoPath, opaqueNativeVideo } from './native-video.mjs';
import { normalizeH264Profile } from './render-contract.mjs';
import { h264FfmpegOverride, renderFfmpegOverride, resolveH264VideoBitrate, withEncoderProfileFallback } from './performance.mjs';
import { neutralPictureProps, pictureOnlyProps, pictureAnimationWindows } from '../shared/picture-animation-timing.mjs';

const STATE_KEYS = new Set(['fps', 'width', 'height', 'fit', 'items', 'tracks', 'trackOrder', 'transitions',
  'markers', 'linkGroups', 'multicamGroups', 'assets', 'captionsHidden', 'selectedId', 'selectedIds',
  'captions', 'watermark', 'fxDefs', 'id', 'name', 'order', 'hidden', 'interaction', 'compositingOrder']);
const ITEM_KEYS = new Set(['id', 'track', 'startFrame', 'durationInFrames', 'name', 'kind', 'width', 'height',
  'src', 'sourceFilename', 'originalFilePath', 'sourceAssetId', 'sourceRevision', 'sourceContentHash',
  'volume', 'srcInFrame', 'playbackRate', 'fadeInFrames', 'fadeOutFrames', 'transform', 'props',
  'effects', 'filters', 'keyframes', 'backgroundFill', 'mainClipId']);
const TRACK_KEYS = new Set(['kind', 'name', 'captions', 'hidden', 'muted', 'soloed', 'locked', 'collapsed', 'role', 'audioRouting']);
const empty = (value) => value == null || typeof value === 'object' && Object.keys(value).length === 0;
const known = (value, keys) => value && Object.keys(value).every((key) => value[key] === undefined || keys.has(key));
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const refusal = (reason) => ({ eligible: false, reason });

function neutralTransform(transform) {
  if (transform == null) return true;
  const defaults = { x: 0, y: 0, rotation: 0, borderRadius: 0, opacity: 1, scale: 1, scaleX: 1, scaleY: 1 };
  return Object.entries(transform).every(([key, value]) => value === undefined
    || key in defaults && value === defaults[key]);
}

/** Conservative, immutable planning. Unsupported rendering never loses effects.
 * Gaps/ranges are timeline frames; source inpoints are mapped exactly once. */
function hasCompositionMosaic(state, project, visited = new Set()) {
  if (!Array.isArray(state?.items)) return false;
  if (state.items.some((item) => item.kind === 'mosaic')) return true;
  for (const item of state.items) {
    if (item.kind !== 'sequence' || !item.timelineId || visited.has(item.timelineId)) continue;
    visited.add(item.timelineId);
    const child = project?.timelines?.find((timeline) => timeline.id === item.timelineId);
    if (hasCompositionMosaic(child, project, visited)) return true;
  }
  return false;
}

export function planDirectCutExport({ state, codec = 'h264', scale, frameRange, separateAudioTo, project, timelineId }) {
  if (hasCompositionMosaic(state, project)) return refusal('composition-mosaic');
  if (codec !== 'h264' || scale !== undefined && scale !== 1 || separateAudioTo) return refusal('output-options');
  if (!state || !known(state, STATE_KEYS) || !Array.isArray(state.items) || !state.items.length) return refusal('timeline-shape');
  if (state.compositingOrder !== undefined && state.compositingOrder !== 'tracks') return refusal('compositing-order');
  if (![24, 25, 30, 50, 60].includes(state.fps)
    || ![state.width, state.height].every((n) => integer(n) && n > 0 && n % 2 === 0)) return refusal('canvas');
  if (project) {
    const root = project.timelines?.find((timeline) => timeline.id === timelineId);
    // Root calculateMetadata reads the project; do not mix two different snapshots.
    if (!root || JSON.stringify(root) !== JSON.stringify(state)) return refusal('project-snapshot');
  }
  if (!empty(state.transitions) || state.captions?.enabled || state.watermark?.enabled) return refusal('overlays-or-transitions');
  const tracks = state.tracks ?? {};
  for (const flags of Object.values(tracks)) {
    if (!known(flags, TRACK_KEYS) || flags.captions?.enabled || flags.role === 'follower'
      || !known(flags.audioRouting ?? {}, new Set(['gainDb', 'duckDepthDb']))) return refusal('track-processing');
  }
  const items = [...state.items].sort((a, b) => a.startFrame - b.startFrame);
  const videos = items.filter((item) => item.kind === 'video');
  const track = videos[0]?.track;
  if (!videos.length || items.filter((item) => item.kind === 'audio').length > 8) return refusal('media-count');
  let end = 0;
  let videoEnd = 0;
  for (const item of items) {
    if (!known(item, ITEM_KEYS) || !['video', 'audio'].includes(item.kind) || typeof item.src !== 'string'
      || !integer(item.startFrame) || !integer(item.durationInFrames) || item.durationInFrames < 1
      || !integer(item.srcInFrame ?? 0)) return refusal('invalid-media');
    if (item.kind === 'video') {
      if (item.track !== track || item.startFrame < videoEnd
        || item.width !== state.width || item.height !== state.height) return refusal('not-plain-single-track');
      videoEnd = item.startFrame + item.durationInFrames;
    }
    if ((item.playbackRate ?? 1) !== 1 || (item.fadeInFrames ?? 0) !== 0 || (item.fadeOutFrames ?? 0) !== 0
      || !neutralTransform(item.transform) || !neutralPictureProps(item) || !empty(item.effects)
      || !empty(item.filters) || !empty(item.keyframes) || item.backgroundFill === true) return refusal('clip-processing');
    if (!Number.isFinite(item.volume ?? 1) || (item.volume ?? 1) < 0 || (item.volume ?? 1) > 2) return refusal('volume');
    end = Math.max(end, item.startFrame + item.durationInFrames);
    if (!integer(end) || !integer((item.srcInFrame ?? 0) + item.durationInFrames)) return refusal('frame-overflow');
  }
  const flags = tracks[track] ?? {};
  if ((flags.kind ?? (track?.toUpperCase().startsWith('A') ? 'audio' : track?.toUpperCase().startsWith('C') ? 'caption' : 'video')) !== 'video') return refusal('non-video-track');
  const duration = Math.max(state.fps, end);
  const from = frameRange?.[0] ?? 0, to = frameRange ? frameRange[1] + 1 : duration;
  if (!integer(from) || !integer(to) || to <= from || to > duration
    || frameRange && (!Array.isArray(frameRange) || frameRange.length !== 2)) return refusal('range');
  const anySolo = Object.entries(tracks).some(([id, config]) => config.soloed
    && (config.kind === 'audio' || config.kind !== 'caption' && items.some((item) => item.track === id)));
  const volumeFor = (item) => {
    const config = tracks[item.track] ?? {};
    if (config.hidden || config.muted || anySolo && !config.soloed) return 0;
    const rawGain = config.audioRouting?.gainDb ?? 0;
    return (item.volume ?? 1) * 10 ** (Math.max(-60, Math.min(12, Number.isFinite(rawGain) ? rawGain : 0)) / 20);
  };
  const audio = items.filter((item) => item.kind === 'audio').flatMap((item) => {
    const start = Math.max(from, item.startFrame), stop = Math.min(to, item.startFrame + item.durationInFrames);
    const volume = volumeFor(item);
    return stop > start && volume > 0 ? [{ src: item.src, startFrame: start - from,
      frames: stop - start, sourceFrame: (item.srcInFrame ?? 0) + start - item.startFrame, volume }] : [];
  });
  const segments = [];
  let cursor = from;
  for (const item of flags.hidden ? [] : videos) {
    const start = Math.max(from, item.startFrame), stop = Math.min(to, item.startFrame + item.durationInFrames);
    if (stop <= start) continue;
    if (start > cursor) segments.push({ frames: start - cursor, src: null, volume: 0 });
    const next = { frames: stop - start, src: item.src, sourceFrame: (item.srcInFrame ?? 0) + start - item.startFrame,
      volume: volumeFor(item) };
    const last = segments.at(-1);
    if (last?.src === next.src && last.volume === next.volume && last.sourceFrame + last.frames === next.sourceFrame) last.frames += next.frames;
    else segments.push(next);
    cursor = stop;
  }
  if (cursor < to) segments.push({ frames: to - cursor, src: null, volume: 0 });
  return { eligible: true, fps: state.fps, width: state.width, height: state.height, frames: to - from, segments, audio };
}

/** Text and local picture animations have no audio. Render their windows through
 * the existing composition, preserving its global frame clock and typography.
 * All other unsupported effects retain the full compatibility renderer. */
export function planNativeExport(options) {
  if (hasCompositionMosaic(options.state, options.project)) return refusal('composition-mosaic');
  const direct = planDirectCutExport(options);
  if (direct.eligible || !options.allowTextWindows) return direct;
  const { state, project, timelineId } = options;
  if (!Array.isArray(state?.items) || !state.items.some((item) => item.kind === 'text'
    || item.kind === 'video' && pictureOnlyProps(item.props) && pictureAnimationWindows(item).length)) return direct;
  if (project && JSON.stringify(project.timelines?.find((t) => t.id === timelineId)) !== JSON.stringify(state)) return refusal('project-snapshot');
  const text = state.items.filter((item) => item.kind === 'text');
  if (text.some((item) => !integer(item.startFrame) || !integer(item.durationInFrames) || item.durationInFrames < 1)) return refusal('text-range');
  const base = { ...state, items: state.items.filter((item) => item.kind !== 'text').map((item) =>
    item.kind === 'video' && pictureOnlyProps(item.props) ? { ...item, props: undefined } : item) };
  const baseEnd = Math.max(state.fps, ...base.items.map((item) => item.startFrame + item.durationInFrames));
  if (text.some((item) => item.startFrame + item.durationInFrames > baseEnd)) return refusal('trailing-title');
  const baseProject = project ? { ...project, timelines: project.timelines.map((t) => t.id === timelineId ? base : t) } : undefined;
  const plan = planDirectCutExport({ ...options, state: base, project: baseProject });
  if (!plan.eligible) return plan;
  const from = options.frameRange?.[0] ?? 0, end = from + plan.frames;
  const rawWindows = text.filter((item) => !state.tracks?.[item.track]?.hidden).map((item) => [
    Math.max(from, item.startFrame), Math.min(end, item.startFrame + item.durationInFrames),
  ]).concat(state.items.filter((item) => item.kind === 'video' && !state.tracks?.[item.track]?.hidden)
    .flatMap((item) => pictureAnimationWindows(item).map(([a, b]) => [Math.max(from, a), Math.min(end, b)])))
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const windows = [];
  for (const window of rawWindows) {
    const previous = windows.at(-1);
    if (previous && window[0] <= previous[1]) previous[1] = Math.max(previous[1], window[1]);
    else windows.push([...window]);
  }
  const cuts = [...new Set(windows.flat())].sort((a, b) => a - b);
  let cursor = from;
  const segments = plan.segments.flatMap((segment) => {
    const start = cursor, stop = start + segment.frames; cursor = stop;
    const points = [start, ...cuts.filter((cut) => cut > start && cut < stop), stop];
    return points.slice(0, -1).map((at, index) => ({ ...segment, frames: points[index + 1] - at,
      // A title boundary changes pixels, not sound. Decode the original audio
      // run once; never introduce an audio seek merely to draw an overlay.
      audioFrames: index === 0 ? segment.frames : 0,
      ...(segment.src ? { sourceFrame: segment.sourceFrame + at - start } : {}),
      ...(windows.some(([a, b]) => at >= a && at < b) ? { compositionRange: [at, points[index + 1] - 1] } : {}),
    }));
  });
  // This route pays a browser startup per affected source run. A full-length
  // title (or many tiny windows) is not automatically faster than WebCodecs.
  const composed = segments.filter((segment) => segment.compositionRange);
  if (composed.length > 8 || composed.reduce((n, s) => n + s.frames, 0) > plan.frames / 2) return refusal('dense-title-windows');
  return { ...plan, segments, renderRoute: segments.some((s) => s.compositionRange) ? 'hybrid' : 'direct-cut' };
}

const rate = (value) => { const [n, d] = String(value).split('/').map(Number); return d > 0 ? n / d : NaN; };
export function directCutSourceSupported(metadata, plan, segments) {
  const streams = metadata?.streams ?? [], videos = streams.filter((s) => s.codec_type === 'video');
  const video = videos[0], audio = streams.find((s) => s.codec_type === 'audio');
  if (videos.length !== 1 || !opaqueNativeVideo(video) || video.pix_fmt !== 'yuv420p'
    || video.width !== plan.width || video.height !== plan.height
    || rate(video.avg_frame_rate) !== plan.fps || rate(video.r_frame_rate) !== plan.fps
    || !['1:1', undefined].includes(video.sample_aspect_ratio)
    || !['progressive', 'unknown', undefined].includes(video.field_order)
    || Number(video.start_time ?? 0) !== 0 || Number(metadata.format?.start_time ?? 0) !== 0
    || video.tags?.rotate && Number(video.tags.rotate) !== 0
    || video.side_data_list?.some((data) => Number(data.rotation ?? 0) !== 0)
    || !['bt709', 'unknown', undefined].includes(video.color_space)
    || !['bt709', 'unknown', undefined].includes(video.color_transfer)
    || !['bt709', 'unknown', undefined].includes(video.color_primaries)
    || !['tv', 'unknown', undefined].includes(video.color_range)) return false;
  // Chromium's unspecified HD SDR interpretation is BT.709. Do not guess the
  // different defaults of untagged SD sources, or relabel known non-709 media.
  if (video.color_space !== 'bt709' && video.height < 720) return false;
  const sourceFrames = Number(video.nb_frames);
  // Known sample count prevents freeze/padding at an exhausted source boundary.
  if (!integer(sourceFrames) || sourceFrames < 1 || segments.some((s) => s.sourceFrame + s.frames > sourceFrames)) return false;
  return !audio || Number(audio.start_time ?? 0) === 0 && [1, 2].includes(audio.channels)
    && Number(audio.sample_rate) > 0 && Number(audio.duration) >= Math.max(...segments.map((s) => (s.sourceFrame + s.frames) / plan.fps));
}

/** Spawn no shell, retain a bounded error tail, wait for close after cancellation.
 * Runtime encoding is bounded per segment; only this exact subprocess is killed. */
export function directCutCommand(executable, args, { signal, timeoutMs = 120000, maxBytes = 65536, collect = true, onFrame = () => {}, checkResources } = {}) {
  signal?.throwIfAborted();
  checkResources?.();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', failure, pending = '';
    const abort = () => child.kill();
    const timer = setTimeout(() => { failure = new Error(`Direct video processing timeout after ${timeoutMs}ms`); abort(); }, timeoutMs);
    const resourceTimer = checkResources && setInterval(() => {
      try { checkResources(); } catch (error) { failure = error; abort(); }
    }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => { failure = error; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32768); });
    child.stdout.on('data', (chunk) => {
      if (collect) output += chunk;
      if (Buffer.byteLength(output) > maxBytes) { failure = new Error('Direct processing stdout limit'); abort(); return; }
      pending = (pending + chunk).slice(-maxBytes);
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (/^frame=\s*\d+/.test(line)) {
        try { onFrame(Number(line.split('=')[1])); } catch (error) { failure = error; abort(); }
      }
    });
    child.once('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (resourceTimer) clearInterval(resourceTimer);
      if (signal?.aborted) reject(signal.reason ?? new Error('Cancelled'));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Direct video processing failed (${code}): ${stderr}`));
      else resolve(output);
    });
    if (signal?.aborted) abort();
  });
}

/** null means preflight declined BEFORE browser or output creation. A render
 * failure throws with its cause; it never silently launches a second renderer. */
export async function inspectDirectCutExport(options, { run = directCutCommand, probe } = {}) {
  const { signal, uploadsDirectory, assetsDirectory, ffmpegExecutable, ffprobeExecutable } = options;
  signal?.throwIfAborted();
  if (process.env.CC_DIRECT_CUT_EXPORT === '0') return null;
  const plan = planNativeExport(options);
  if (!plan.eligible) { console.info(`[render] direct cut declined: ${plan.reason}`); return null; }
  // Remotion's minimal FFmpeg lacks the filters needed here. The host supplies
  // its already-bundled full media binary (including unpacked asar resolution).
  if (!ffmpegExecutable || !ffprobeExecutable) { console.info('[render] direct cut declined: full-media-binaries'); return null; }
  const sources = new Map();
  const allMedia = [...plan.segments, ...plan.audio];
  for (const src of new Set(allMedia.map((s) => s.src).filter(Boolean))) {
    const local = localVideoPath(src, uploadsDirectory, assetsDirectory);
    if (!local) { console.info('[render] direct cut declined: nonlocal source'); return null; }
    // The desktop media registry can map an upload URL to a user-authorized
    // original file. Resolve through that registry without copying/downloading.
    const file = options.resolveMediaSource?.(src) ?? local;
    let metadata;
    try {
      metadata = probe ? await probe(file) : JSON.parse(await run(ffprobeExecutable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 5000 }));
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(`[render] direct cut source check failed; retaining compositor: ${error.message}`); return null;
    }
    signal?.throwIfAborted();
    const videoSegments = plan.segments.filter((s) => s.src === src);
    const audioStream = metadata.streams?.find((stream) => stream.codec_type === 'audio');
    const audioSegments = plan.audio.filter((s) => s.src === src);
    const audioSupported = !audioSegments.length || audioStream && [1, 2].includes(audioStream.channels)
      && Number(audioStream.start_time ?? 0) === 0 && Number(metadata.format?.start_time ?? 0) === 0
      && Number(audioStream.sample_rate) > 0
      && audioSegments.every((s) => Number(audioStream.duration) >= (s.sourceFrame + s.frames) / plan.fps);
    if (videoSegments.length && !directCutSourceSupported(metadata, plan, videoSegments) || !audioSupported) {
      console.info('[render] direct cut declined: source metadata'); return null;
    }
    sources.set(src, { file, audio: metadata.streams.some((s) => s.codec_type === 'audio') });
  }
  return { plan, sources };
}

export function checkDirectCutDisk(directory, requiredBytes = 0, inspect = statfsSync) {
  const disk = inspect(directory);
  if (Number(disk.bavail) * Number(disk.bsize) < 2 * 1024 ** 3 + requiredBytes) {
    throw new Error('Insufficient disk space for fast export; free space or choose another output disk');
  }
}

export async function tryDirectCutExport(options, dependencies = {}) {
  const inspected = await inspectDirectCutExport(options, dependencies);
  if (!inspected) return null;
  const { plan, sources } = inspected;
  const { run = directCutCommand, checkDisk = checkDirectCutDisk } = dependencies;
  const { outputLocation, onProgress, h264Profile, videoBitrate, vaapiDevice, signal: ownerSignal, ffmpegExecutable } = options;
  if (plan.renderRoute === 'hybrid' && !options.renderVisualRange) return null;
  const profile = normalizeH264Profile('h264', h264Profile);
  const outputDirectory = path.dirname(path.resolve(outputLocation));
  await mkdir(outputDirectory, { recursive: true });
  // Budget for all encoded parts + final video + PCM audio. This is an estimate,
  // so a live guard remains active during encoding/muxing, not only at startup.
  const seconds = plan.frames / plan.fps;
  checkDisk(outputDirectory, seconds * ((videoBitrate || 30_000_000) / 8 * 2 + 48000 * 2 * 4));
  const checkResources = () => checkDisk(outputDirectory);
  const temporary = await mkdtemp(path.join(outputDirectory, '.zuoren-direct-'));
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort(ownerSignal.reason);
  if (ownerSignal?.aborted) abort(); else ownerSignal?.addEventListener('abort', abort, { once: true });
  const guard = setInterval(() => { try { checkResources(); } catch (error) { controller.abort(error); } }, 1000);
  // Only files under this unique owned directory are removed. Caller output is
  // committed by rename after encoding/muxing, never deleted for a retry here.
  try {
    async function render(encoder) {
      let completed = 0;
      const parts = [];
      const audioParts = [];
      for (const [index, segment] of plan.segments.entries()) {
        signal?.throwIfAborted();
        const part = `part-${String(index).padStart(6, '0')}.mp4`, file = path.join(temporary, part);
        const audioPart = `audio-${String(index).padStart(6, '0')}.wav`;
        const duration = segment.frames / plan.fps;
        const audioFrames = segment.audioFrames ?? segment.frames;
        const samples = audioFrames * 48000 / plan.fps;
        const source = sources.get(segment.src);
        // AAC needs decoder preroll; even an input seek to zero can discard
        // its priming packet. Seek slightly early, then trim on exact clocks.
        const preroll = source ? Math.min(segment.sourceFrame, Math.ceil(plan.fps / 10)) : 0;
        const seekFrame = source ? segment.sourceFrame - preroll : 0;
        const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];
        let composite;
        if (segment.compositionRange) {
          checkResources();
          composite = path.join(temporary, `title-${index}.mp4`);
          await options.renderVisualRange(segment.compositionRange, composite, signal);
          signal?.throwIfAborted(); checkResources();
          args.push('-threads', '2', '-i', composite);
        }
        if (source) args.push('-threads', '2', ...(seekFrame > 0 ? ['-ss', String(seekFrame / plan.fps)] : []), '-i', source.file);
        else args.push('-f', 'lavfi', '-i', `color=black:s=${plan.width}x${plan.height}:r=${plan.fps}:d=${duration}`);
        const audible = source?.audio && segment.volume !== 0;
        if (audioFrames && !audible) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
        args.push('-map', '0:v:0', '-an',
          '-vf', `trim=start_frame=${composite ? 0 : preroll}:end_frame=${segment.frames + (composite ? 0 : preroll)},setpts=N/(${plan.fps}*TB),setsar=1${composite ? ',scale=in_color_matrix=auto:out_color_matrix=bt709:out_range=tv' : ''}`,
          '-r', String(plan.fps), '-fps_mode', 'cfr', '-frames:v', String(segment.frames),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads:v', '2',
          '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
        if (Number.isFinite(videoBitrate) && videoBitrate > 0) args.push('-b:v', String(Math.round(videoBitrate)));
        else if (encoder.hardware) args.push('-b:v', resolveH264VideoBitrate(plan));
        else args.push('-crf', '18');
        // Keep audio on its exact sample clock. Muxing short PCM cuts into MKV
        // quantizes timestamps to milliseconds and can truncate cut boundaries.
        args.push('-progress', 'pipe:1', '-nostats', '-video_track_timescale', String(plan.fps * 1000), file);
        if (audioFrames) args.push(
          '-map', `${(composite ? 1 : 0) + (audible ? 0 : 1)}:a:0`, '-vn',
          '-af', `aresample=48000,aformat=channel_layouts=stereo,atrim=start_sample=${audible ? preroll * 48000 / plan.fps : 0},volume=${segment.volume},apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB`,
          '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', path.join(temporary, audioPart));
        const encodedArgs = encoder.hardware ? h264FfmpegOverride(encoder.id, { vaapiDevice })({ args }) : renderFfmpegOverride()({ args });
        await run(ffmpegExecutable, encodedArgs, { signal, checkResources, timeoutMs: Math.max(120000, duration * 10000), collect: false,
          onFrame: (frame) => onProgress?.(Math.min(0.95, (completed + Math.min(segment.frames, frame)) / plan.frames * 0.95)) });
        completed += segment.frames; parts.push(`file '${part}'\nduration ${duration}`);
        if (audioFrames) audioParts.push(`file '${audioPart}'\nduration ${audioFrames / plan.fps}`);
        if (composite) await rm(composite);
      }
      signal?.throwIfAborted();
      const list = path.join(temporary, 'parts.txt'), joined = path.join(temporary, 'joined.mp4');
      await writeFile(list, parts.join('\n') + '\n', 'ascii');
      const audioList = path.join(temporary, 'audio.txt');
      await writeFile(audioList, audioParts.join('\n') + '\n', 'ascii');
      const mux = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-filter_complex_threads', '1',
        '-f', 'concat', '-safe', '1', '-i', list, '-f', 'concat', '-safe', '1', '-i', audioList];
      const totalSamples = plan.frames * 48000 / plan.fps;
      const filters = [`[1:a]aresample=48000,asetpts=N/SR/TB,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[base]`];
      const labels = ['[base]'];
      for (const [index, audio] of plan.audio.entries()) {
        const preroll = Math.min(audio.sourceFrame, Math.ceil(plan.fps / 10)), seekFrame = audio.sourceFrame - preroll;
        mux.push('-threads', '2', ...(seekFrame > 0 ? ['-ss', String(seekFrame / plan.fps)] : []),
          '-t', String((audio.frames + preroll) / plan.fps), '-i', sources.get(audio.src).file);
        filters.push(`[${index + 2}:a:0]aresample=48000,aformat=channel_layouts=stereo,atrim=start_sample=${preroll * 48000 / plan.fps}:end_sample=${(audio.frames + preroll) * 48000 / plan.fps},asetpts=N/SR/TB,volume=${audio.volume},adelay=${audio.startFrame * 48000 / plan.fps}S:all=1[a${index}]`);
        labels.push(`[a${index}]`);
      }
      filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0[mix]`);
      mux.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k',
        '-t', String(seconds), '-video_track_timescale', String(plan.fps * 1000), '-movflags', '+faststart', joined);
      await run(ffmpegExecutable, mux, {
        signal, checkResources, timeoutMs: Math.max(120000, seconds * 2000),
      });
      signal?.throwIfAborted();
      return joined;
    }
    const rendered = await withEncoderProfileFallback({
      render, hardwareOptions: profile, softwareOptions: normalizeH264Profile('h264'), hardwareProfile: profile, signal,
      onFallback: (error) => console.warn(`[render] direct cut hardware failed; one software retry; original error: ${error.message}`),
    });
    signal?.throwIfAborted();
    await rename(rendered.result, outputLocation);
    onProgress?.(1);
    console.info(`[render] direct cut complete: ${plan.frames} frames, ${plan.segments.length} serial segments, ${rendered.encoder.id}`);
    const renderRoute = plan.renderRoute ?? 'direct-cut';
    return { outputLocation, encoder: { ...rendered.encoder, renderRoute,
      label: `${renderRoute === 'hybrid' ? '局部合成快导' : '快速剪切'} · ${rendered.encoder.label}` }, renderRoute,
      ...(rendered.encoderFallbackReason ? { encoderFallbackReason: rendered.encoderFallbackReason } : {}) };
  } finally {
    clearInterval(guard); ownerSignal?.removeEventListener('abort', abort);
    await rm(temporary, { recursive: true, force: true }).catch((error) => {
      // A cleanup error must not replace the original render failure, nor turn
      // a successfully committed file into a failed job that deletes that file.
      console.warn(`[render] direct cut cleanup retained ${temporary}: ${error.message}`);
    });
  }
}
