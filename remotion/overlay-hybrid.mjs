import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { availableParallelism, freemem } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  checkDirectCutDisk,
  directCutCommand,
} from './direct-cut.mjs';
import { localVideoPath } from './native-video.mjs';
import {
  h264FfmpegOverride,
  renderFfmpegOverride,
  resolveH264VideoBitrate,
  withEncoderProfileFallback,
} from './performance.mjs';
import { normalizeH264Profile } from './render-contract.mjs';
import {
  neutralPictureProps,
  pictureAnimationWindows,
  pictureOnlyProps,
} from '../shared/picture-animation-timing.mjs';
import {
  computeAudioSampleWindow,
  isVisualOverlayItemVisible,
} from '../shared/timeline-media-schedule.mjs';
import {
  CLIP_MASK_KEYS,
  OVERLAY_KINDS,
  TRACK_ORDER_DEFAULT,
  defaultVideoTrackId,
  planOverlayHybridExport,
  resolveBaseTimelineState,
  timelineTrackIds,
  trackKind,
} from '../shared/export-route-plan.mjs';

export { planOverlayHybridExport } from '../shared/export-route-plan.mjs';

const PREROLL_FRAMES = 60;
const MAX_BASE_SEGMENTS_PER_CHUNK = 8;
const MAX_OVERLAY_VIDEOS_PER_CHUNK = 6;
const MAX_AUDIO_INPUTS_PER_BATCH = 48;
const INLINE_FILTER_CHAR_LIMIT = 4000;
const CHUNK_TIMEOUT_MS = 600_000;
const FINALIZATION_TIMEOUT_MIN_MS = 180_000;
const FINALIZATION_TIMEOUT_MAX_MS = 45 * 60_000;
const GIB_BYTES = 1024 ** 3;
const SUPPORTED_HYBRID_VIDEO_CODECS = new Set([
  'h264', 'hevc', 'vp8', 'vp9', 'av1', 'prores', 'mpeg4', 'mjpeg',
  'gif', 'png', 'webp', 'dnxhd', 'ffv1', 'huffyuv', 'utvideo', 'rawvideo', 'mpeg2video', 'wmv3', 'vc1',
]);
const OPAQUE_HYBRID_PIX_FMTS = /^(?:yuvj?(?:420|422|444)p(?:(?:10|12|16)le)?|nv12|p010le|p016le|rgb24|bgr24|gbrp(?:(?:10|12|16)le)?|gray(?:16le)?|rgb48le|bgr48le|pal8)$/;
const ALPHA_HYBRID_PIX_FMTS = /^(?:yuva(?:420|422|444)p(?:(?:10|12|16)le)?|rgba|bgra|argb|abgr|gbrap(?:10le|12le)?)$/;
const RGB_ALPHA_PIX_FMTS = /^(?:rgba|bgra|argb|abgr|gbrap)/;

function streamHasAlpha(video) {
  if (!video) return false;
  const pixFmt = String(video.pix_fmt ?? '').trim();
  if (ALPHA_HYBRID_PIX_FMTS.test(pixFmt)) return true;
  if (video.codec_name === 'gif' || pixFmt === 'pal8') return true;
  if (video.tags && typeof video.tags === 'object') {
    for (const [key, value] of Object.entries(video.tags)) {
      if (/^alpha_mode$/i.test(key) && /^(?:1|true)$/i.test(String(value ?? '').trim())) return true;
    }
  }
  return false;
}

const integer = (value, min = 0) => Number.isInteger(value) && value >= min;
const hasOwnKeys = (value) => value != null && typeof value === 'object' && Object.keys(value).some((k) => value[k] !== undefined);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const escapeFfmpegFilterPath = (filePath) => String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

async function filterComplexArgs(filterText, scriptPath) {
  if (filterText.length <= INLINE_FILTER_CHAR_LIMIT || !scriptPath) {
    return ['-filter_complex', filterText];
  }
  await writeFile(scriptPath, filterText, 'utf8');
  return ['-filter_complex_script', scriptPath];
}

function defaultResolveLutPath(relPath, assetsDirectory) {
  if (!relPath) return null;
  const candidates = [
    assetsDirectory ? path.join(assetsDirectory, relPath) : null,
    assetsDirectory ? path.join(assetsDirectory, '..', relPath) : null,
    assetsDirectory ? path.join(assetsDirectory, '..', 'public', relPath) : null,
    path.join(process.cwd(), 'assets', relPath),
    path.join(process.cwd(), 'public', relPath),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function exportFinalizationTimeoutMs({ frames, fps, inputBytes = 0 } = {}) {
  const durationMs = Number.isFinite(frames) && frames > 0 && Number.isFinite(fps) && fps > 0
    ? frames / fps * 1000 : 0;
  const sizeGiB = Number.isFinite(inputBytes) && inputBytes > 0 ? inputBytes / GIB_BYTES : 0;
  return Math.min(FINALIZATION_TIMEOUT_MAX_MS, Math.max(FINALIZATION_TIMEOUT_MIN_MS,
    Math.ceil(FINALIZATION_TIMEOUT_MIN_MS + durationMs * 0.35 + sizeGiB * 180_000)));
}

/**
 * Determine safe parallel FFmpeg worker count considering CPU cores, 4K+ VRAM pressure,
 * and current free system memory.
 */
export function resolveHybridWorkerCount({
  cores = availableParallelism(),
  frames = 0,
  width = 1920,
  height = 1080,
  freeMemBytes = freemem(),
  hardware = false,
  envMaxWorkers = process.env.CC_HYBRID_MAX_WORKERS,
} = {}) {
  const safeCores = Math.max(1, Math.floor(Number.isFinite(cores) ? cores : 1));
  let desired = hardware
    ? (safeCores >= 8 && frames >= 1200 ? Math.min(4, Math.floor(safeCores / 4)) : Math.min(2, safeCores >= 4 ? 2 : 1))
    : Math.min(3, Math.max(1, Math.floor(safeCores / 2)));

  if (hardware && (width >= 3840 || height >= 2160)) {
    desired = Math.min(desired, 2);
  }
  if (Number.isFinite(freeMemBytes) && freeMemBytes > 0) {
    if (freeMemBytes < 4 * GIB_BYTES) desired = Math.min(desired, 1);
    else if (freeMemBytes < 8 * GIB_BYTES) desired = Math.min(desired, 2);
  }
  const parsedEnv = Number.parseInt(String(envMaxWorkers ?? '').trim(), 10);
  if (Number.isFinite(parsedEnv) && parsedEnv > 0) {
    desired = Math.min(desired, Math.max(1, Math.min(8, parsedEnv)));
  }
  return Math.max(1, desired);
}

async function totalFileBytes(files) {
  const sizes = await Promise.all(files.filter(Boolean).map(async (file) => (await stat(file)).size));
  return sizes.reduce((total, size) => total + size, 0);
}

export function buildAtempoChain(rate) {
  if (!Number.isFinite(rate) || Math.abs(rate - 1) < 1e-6) return [];
  const filters = [];
  let rem = rate;
  while (rem > 2.0 + 1e-6) {
    filters.push('atempo=2');
    rem /= 2;
  }
  while (rem < 0.5 - 1e-6) {
    filters.push('atempo=0.5');
    rem /= 0.5;
  }
  if (Math.abs(rem - 1) >= 1e-6) {
    filters.push(`atempo=${Number(rem.toFixed(6))}`);
  }
  return filters;
}

/**
 * Create a derived state for rendering ONLY overlay plates (`captions`, `text`, `solid`, `image`, `svg`, `watermark`).
 * Moves stripped `video`, `audio`, and admitted `mosaic` items onto a hidden track instead of deleting them so caption items referencing
 * a video/audio item's `transcript` and `timelineDuration()` keep 100% identical timing!
 */
export function buildOverlayOnlyState(state, excludedItemIds = null) {
  const hiddenTrackId = '__cc_hidden_media__';
  const excluded = excludedItemIds?.length ? new Set(excludedItemIds) : null;
  const trackOrder = Array.isArray(state.trackOrder)
    ? [...state.trackOrder.filter((id) => id !== hiddenTrackId), hiddenTrackId]
    : [...TRACK_ORDER_DEFAULT, hiddenTrackId];
  return {
    ...state,
    transitions: [],
    trackOrder,
    tracks: {
      ...(state.tracks ?? {}),
      [hiddenTrackId]: { kind: 'video', hidden: true, muted: true },
    },
    items: (state.items ?? []).map((item) => (
      item.kind === 'video' || item.kind === 'audio' || item.kind === 'mosaic' || excluded?.has(item.id)
        ? { ...item, track: hiddenTrackId }
        : item
    )),
  };
}

export function buildUnderlayOnlyState(state, underlayItemIds = []) {
  const hiddenTrackId = '__cc_hidden_media__';
  const keepSet = new Set(underlayItemIds);
  const trackOrder = Array.isArray(state.trackOrder)
    ? [...state.trackOrder.filter((id) => id !== hiddenTrackId), hiddenTrackId]
    : [...TRACK_ORDER_DEFAULT, hiddenTrackId];
  const tracks = {
    ...(state.tracks ?? {}),
    [hiddenTrackId]: { kind: 'video', hidden: true, muted: true },
  };
  for (const [id, tr] of Object.entries(tracks)) {
    if (trackKind(state, id) === 'caption') {
      tracks[id] = { ...tr, hidden: true, captions: tr?.captions ? { ...tr.captions, enabled: false } : tr?.captions };
    }
  }
  return {
    ...state,
    transitions: [],
    captionsHidden: true,
    captions: state.captions ? { ...state.captions, enabled: false } : state.captions,
    watermark: state.watermark ? { ...state.watermark, enabled: false } : state.watermark,
    trackOrder,
    tracks,
    items: (state.items ?? []).map((item) => (
      keepSet.has(item.id) ? item : { ...item, track: hiddenTrackId }
    )),
  };
}

function mergeRanges(ranges, minVal, maxVal) {
  const valid = [];
  for (const [rawA, rawB] of ranges) {
    const a = Math.max(minVal, Math.floor(rawA));
    const b = Math.min(maxVal, Math.ceil(rawB));
    if (b > a) valid.push([a, b]);
  }
  if (!valid.length) return [];
  valid.sort((l, r) => l[0] - r[0] || l[1] - r[1]);
  const out = [];
  for (const [a, b] of valid) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function pointInMergedRanges(merged, frame) {
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = merged[mid];
    if (frame < a) hi = mid - 1;
    else if (frame >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

function resolveTextAnimationTiming(props = {}, durationInFrames = 1) {
  const isLowerThird = props.textStylePreset === 'lower-third';
  const entrance = props.entrance ?? (isLowerThird ? 'slide-left' : 'none');
  const exit = props.exit ?? (isLowerThird ? 'fade' : 'none');
  const clampedCount = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(clamp(n, 1, 300)) : fallback;
  };
  return {
    entrance: entrance && entrance !== 'none' ? clampedCount(props.entranceFrames, 12) : 0,
    exit: exit && exit !== 'none' ? clampedCount(props.exitFrames, isLowerThird ? 8 : 12) : 0,
    maxFrames: Math.max(0, durationInFrames),
  };
}

/**
 * Partition `[rangeStart, rangeEnd)` into disjoint spans:
 * - `{ from, to, sampleFrame: null }` for gaps with NO visible overlay items
 * - `{ from, to, sampleFrame: from }` for static spans (only 1 PNG rendered for the whole span)
 * - `{ from: f, to: f+1, sampleFrame: f }` per frame inside animated spans (fades, entrances, keyframes)
 */
export function buildSparseOverlayPlan(state, rangeStart, rangeEnd, captionSummary = null, excludeRanges = []) {
  const cuts = new Set([rangeStart, rangeEnd]);
  const animated = [];
  const active = [];

  if (state.watermark?.enabled && state.watermark.text?.trim()) {
    active.push([rangeStart, rangeEnd]);
  }
  if (captionSummary) {
    for (const c of captionSummary.cutFrames ?? []) if (c >= rangeStart && c <= rangeEnd) cuts.add(c);
    for (const range of captionSummary.animatedRanges ?? []) animated.push(range);
    for (const range of captionSummary.activeRanges ?? []) active.push(range);
  }

  for (const item of state.items ?? []) {
    if (!OVERLAY_KINDS.has(item.kind)) continue;
    if (!isVisualOverlayItemVisible(state, item)) continue;
    const itemStart = item.startFrame;
    const itemEnd = itemStart + item.durationInFrames;
    const s = Math.max(rangeStart, itemStart);
    const e = Math.min(rangeEnd, itemEnd);
    if (e <= s) continue;

    active.push([s, e]);
    cuts.add(s);
    cuts.add(e);
    const fadeIn = Math.max(0, Number(item.fadeInFrames ?? 0));
    const fadeOut = Math.max(0, Number(item.fadeOutFrames ?? 0));
    if (fadeIn > 0) animated.push([itemStart, itemStart + fadeIn]);
    if (fadeOut > 0) animated.push([itemEnd - fadeOut, itemEnd]);

    if (item.kind === 'text') {
      const { entrance, exit } = resolveTextAnimationTiming(item.props ?? {}, item.durationInFrames);
      if (entrance > 0) animated.push([itemStart, Math.min(itemEnd, itemStart + entrance)]);
      if (exit > 0) animated.push([Math.max(itemStart, itemEnd - exit), itemEnd]);
    } else {
      for (const [wFrom, wUntil] of pictureAnimationWindows(item)) {
        animated.push([wFrom, wUntil]);
      }
    }

    if (item.kind === 'gif' || item.zoom || (item.effects?.length ?? 0) > 0) {
      animated.push([s, e]);
    } else if (item.keyframes) {
      for (const kfList of Object.values(item.keyframes)) {
        if (!Array.isArray(kfList) || kfList.length < 2) continue;
        const sorted = kfList
          .filter((kf) => kf && Number.isFinite(kf.frame) && Number.isFinite(kf.value))
          .sort((a, b) => a.frame - b.frame);
        if (sorted.length < 2) continue;
        for (let ki = 0; ki + 1 < sorted.length; ki++) {
          const a = sorted[ki];
          const b = sorted[ki + 1];
          const segStart = clamp(itemStart + Math.floor(a.frame), s, e);
          const segEnd = clamp(itemStart + Math.ceil(b.frame), s, e);
          cuts.add(segStart);
          cuts.add(segEnd);
          if (a.value !== b.value) {
            animated.push([
              itemStart + Math.max(0, Math.floor(a.frame)),
              itemStart + Math.min(item.durationInFrames, Math.ceil(b.frame) + 1),
            ]);
          }
        }
      }
    }
  }

  const mergedExcluded = mergeRanges(excludeRanges, rangeStart, rangeEnd);
  const mergedAnimated = mergeRanges(animated, rangeStart, rangeEnd);
  const mergedActive = mergeRanges(active, rangeStart, rangeEnd);
  for (const [a, b] of mergedExcluded) { cuts.add(a); cuts.add(b); }
  for (const [a, b] of mergedAnimated) { cuts.add(a); cuts.add(b); }
  for (const [a, b] of mergedActive) { cuts.add(a); cuts.add(b); }

  const sortedCuts = [...cuts].sort((a, b) => a - b);
  const spans = [];
  const sampleSet = new Set();

  for (let i = 0; i + 1 < sortedCuts.length; i++) {
    const from = sortedCuts[i];
    const to = sortedCuts[i + 1];
    if (to <= from) continue;
    if (pointInMergedRanges(mergedExcluded, from)) {
      spans.push({ from, to, sampleFrame: null });
    } else if (pointInMergedRanges(mergedAnimated, from)) {
      for (let f = from; f < to; f++) {
        spans.push({ from: f, to: f + 1, sampleFrame: f });
        sampleSet.add(f);
      }
    } else if (pointInMergedRanges(mergedActive, from)) {
      spans.push({ from, to, sampleFrame: from });
      sampleSet.add(from);
    } else {
      spans.push({ from, to, sampleFrame: null });
    }
  }

  return {
    spans,
    framesToRender: [...sampleSet].sort((a, b) => a - b),
  };
}

const PNG_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function encodePng(width, height, colorType, raw) {
  const idatData = zlib.deflateSync(raw, { level: 1 });
  const chunk = (type, payload) => {
    const buf = Buffer.alloc(12 + payload.length);
    buf.writeUInt32BE(payload.length, 0);
    buf.write(type, 4, 4, 'ascii');
    payload.copy(buf, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < 8 + payload.length; i++) crc = PNG_CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    buf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length);
    return buf;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType; // 0 = Grayscale, 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Inspect the PNG IHDR header without decoding pixel data; returns null for non-PNG stubs. */
export function inspectPngIhdr(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    compression: buf[26],
    filter: buf[27],
    interlace: buf[28],
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterPngScanlines(inflated, width, height, bpp) {
  const stride = width * bpp;
  const rowBytes = 1 + stride;
  if (inflated.length !== height * rowBytes) return null;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const srcOff = y * rowBytes;
    const dstOff = y * stride;
    const prevOff = (y - 1) * stride;
    const filterType = inflated[srcOff];
    for (let i = 0; i < stride; i++) {
      const raw = inflated[srcOff + 1 + i];
      const a = i >= bpp ? pixels[dstOff + i - bpp] : 0;
      const b = y > 0 ? pixels[prevOff + i] : 0;
      const c = y > 0 && i >= bpp ? pixels[prevOff + i - bpp] : 0;
      let val;
      if (filterType === 0) val = raw;
      else if (filterType === 1) val = (raw + a) & 0xff;
      else if (filterType === 2) val = (raw + b) & 0xff;
      else if (filterType === 3) val = (raw + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) val = (raw + paethPredictor(a, b, c)) & 0xff;
      else return null;
      pixels[dstOff + i] = val;
    }
  }
  return pixels;
}

function convertSimple8BitPngToRgba(buf, ihdr) {
  if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0) return null;
  const srcBpp = ihdr.colorType === 0 ? 1 : ihdr.colorType === 2 ? 3 : ihdr.colorType === 4 ? 2 : 0;
  if (!srcBpp) return null;
  const idats = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataEnd = offset + 8 + len;
    if (dataEnd + 4 > buf.length) return null;
    if (type === 'tRNS') return null;
    if (type === 'IDAT') idats.push(buf.subarray(offset + 8, dataEnd));
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (!idats.length) return null;
  const inflated = zlib.inflateSync(Buffer.concat(idats));
  const pixels = unfilterPngScanlines(inflated, ihdr.width, ihdr.height, srcBpp);
  if (!pixels) return null;
  const outRowBytes = 1 + ihdr.width * 4;
  const outRaw = Buffer.alloc(ihdr.height * outRowBytes);
  for (let y = 0; y < ihdr.height; y++) {
    const rowOff = y * outRowBytes;
    outRaw[rowOff] = 0;
    for (let x = 0; x < ihdr.width; x++) {
      const s = (y * ihdr.width + x) * srcBpp;
      const d = rowOff + 1 + x * 4;
      if (srcBpp === 3) {
        outRaw[d] = pixels[s];
        outRaw[d + 1] = pixels[s + 1];
        outRaw[d + 2] = pixels[s + 2];
        outRaw[d + 3] = 255;
      } else if (srcBpp === 1) {
        const v = pixels[s];
        outRaw[d] = v;
        outRaw[d + 1] = v;
        outRaw[d + 2] = v;
        outRaw[d + 3] = 255;
      } else {
        const v = pixels[s];
        outRaw[d] = v;
        outRaw[d + 1] = v;
        outRaw[d + 2] = v;
        outRaw[d + 3] = pixels[s + 1];
      }
    }
  }
  return encodePng(ihdr.width, ihdr.height, 6, outRaw);
}

/**
 * Ensure an overlay/underlay PNG plate is 8-bit non-interlaced RGBA (`colorType = 6`)
 * at `width x height`. Mixed `rgba` + `rgb24`/`gray` PNGs in a single `ffconcat` input
 * force FFmpeg filtergraph reconfiguration mid-stream, dropping frames and desyncing clips.
 */
export async function normalizePngToRgba({ pngPath, width, height, ffmpegExecutable, signal, run = directCutCommand }) {
  const buf = await readFile(pngPath);
  const ihdr = inspectPngIhdr(buf);
  if (!ihdr) return false;
  if (ihdr.width === width && ihdr.height === height && ihdr.bitDepth === 8 && ihdr.colorType === 6 && ihdr.interlace === 0) {
    return false;
  }
  const tmpPath = `${pngPath}.rgba.tmp.png`;
  const converted = ihdr.width === width && ihdr.height === height ? convertSimple8BitPngToRgba(buf, ihdr) : null;
  if (converted) {
    await writeFile(tmpPath, converted);
    await rename(tmpPath, pngPath);
    return true;
  }
  if (!ffmpegExecutable) {
    throw new Error(`Cannot normalize PNG plate ${pngPath} (colorType=${ihdr.colorType}, ${ihdr.width}x${ihdr.height}) without ffmpegExecutable`);
  }
  await run(ffmpegExecutable, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', pngPath,
    '-vf', `scale=${width}:${height}:flags=lanczos,format=rgba`,
    '-pix_fmt', 'rgba',
    '-frames:v', '1',
    '-y', tmpPath,
  ], { signal, timeoutMs: 30_000, collect: false });
  await rename(tmpPath, pngPath);
  return true;
}

export async function normalizeOverlayPlatesToRgba({ plateFiles, width, height, ffmpegExecutable, signal, run = directCutCommand }) {
  if (!plateFiles || plateFiles.size === 0) return 0;
  const uniquePaths = [...new Set([...plateFiles.values()].filter((p) => typeof p === 'string' && existsSync(p)))];
  if (!uniquePaths.length) return 0;
  let nextIdx = 0;
  let convertedCount = 0;
  const workers = Array.from({ length: Math.min(4, uniquePaths.length) }, async () => {
    while (true) {
      signal?.throwIfAborted();
      const idx = nextIdx++;
      if (idx >= uniquePaths.length) return;
      if (await normalizePngToRgba({ pngPath: uniquePaths[idx], width, height, ffmpegExecutable, signal, run })) {
        convertedCount += 1;
      }
    }
  });
  await Promise.all(workers);
  return convertedCount;
}

/** Generate a minimal valid fully transparent RGBA PNG image of given dimensions (pure Node zlib). */
function createBlankTransparentPng(width, height) {
  const rowBytes = 1 + width * 4; // filter byte (0) + RGBA zeros
  return encodePng(width, height, 6, Buffer.alloc(rowBytes * height, 0));
}

/** Match SDF feather falloff (including rounded rect & circle invert) into an 8-bit grayscale mask PNG. */
function createFeatheredShapeMaskPng({
  shape = 'rectangle', rw, rh, localCx, localCy, halfW, halfH, feather, opacity = 1,
  cornerRadius = 0, invert = false, centeredFeather = false,
}) {
  const rowBytes = 1 + rw;
  const raw = Buffer.alloc(rowBytes * rh);
  const rx = Math.max(0.5, halfW);
  const ry = Math.max(0.5, halfH);
  const op = clamp(opacity, 0, 1);
  const isEllipse = shape === 'ellipse';
  const normScale = Math.min(rx, ry);
  const radius = isEllipse ? 0 : clamp(cornerRadius, 0, Math.min(halfW, halfH));
  const adjHalfW = halfW - radius;
  const adjHalfH = halfH - radius;
  for (let y = 0; y < rh; y++) {
    const off = y * rowBytes;
    raw[off] = 0;
    const dyPix = (y + 0.5) - localCy;
    const dy = Math.abs(dyPix) - adjHalfH;
    for (let x = 0; x < rw; x++) {
      const dxPix = (x + 0.5) - localCx;
      let dist;
      if (isEllipse) {
        const nx = dxPix / rx;
        const ny = dyPix / ry;
        dist = (Math.hypot(nx, ny) - 1) * normScale;
      } else {
        const dx = Math.abs(dxPix) - adjHalfW;
        dist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
      }
      let alpha;
      if (centeredFeather) {
        const f = Math.max(feather, 0.001);
        const t = clamp((dist + f * 0.5) / f, 0, 1);
        alpha = 1 - t * t * (3 - 2 * t);
      } else {
        const t = feather > 0 ? clamp((dist + feather) / feather, 0, 1) : (dist <= 0 ? 0 : 1);
        alpha = 1 - t * t * (3 - 2 * t);
      }
      if (invert) alpha = 1 - alpha;
      raw[off + 1 + x] = Math.round(alpha * op * 255);
    }
  }
  return encodePng(rw, rh, 0, raw);
}

export function buildVideoTrimSteps(seg, fps) {
  const rate = seg.playbackRate ?? 1;
  const isRetimed = Math.abs(rate - 1) >= 1e-6;
  const vf = seg.visualFade;
  const loc0 = seg.clipLocalStart ?? 0;
  const rawFadePre = vf ? Math.max(
    0,
    vf.fadeIn && vf.fadeIn.until > loc0 && vf.fadeIn.from < loc0 ? Math.round(loc0 - vf.fadeIn.from) : 0,
    vf.fadeOut && vf.fadeOut.until > loc0 && vf.fadeOut.from < loc0 ? Math.round(loc0 - vf.fadeOut.from) : 0,
  ) : 0;

  let fadePre = 0;
  let seekSec = 0;
  const steps = [];
  const useIntegerFrameFastTrim = !isRetimed
    && !seg.sourceIsVfr
    && Number.isInteger(seg.sourceFrame);
  if (useIntegerFrameFastTrim) {
    fadePre = Math.min(seg.sourceFrame, rawFadePre);
    const preroll = Math.min(seg.sourceFrame - fadePre, PREROLL_FRAMES);
    const localTrimStart = preroll;
    const localTrimEnd = localTrimStart + fadePre + seg.frames;
    const fpsPrefix = Number.isFinite(seg.sourceFps) && Math.abs(seg.sourceFps - fps) > 0.05 ? `fps=${fps},` : '';
    steps.push(`${fpsPrefix}trim=start_frame=${localTrimStart}:end_frame=${localTrimEnd}`, 'setpts=PTS-STARTPTS', 'setsar=1');
    seekSec = (seg.sourceFrame - fadePre - preroll) / fps;
  } else {
    fadePre = Math.min(Math.floor(seg.sourceFrame / rate), rawFadePre);
    const exactSrcStartFrame = Math.max(0, seg.sourceFrame - fadePre * rate);
    const exactSrcStartSec = exactSrcStartFrame / fps;
    const prerollSec = Math.min(exactSrcStartSec, Math.max(0.5, PREROLL_FRAMES / fps));
    seekSec = Number(Math.max(0, exactSrcStartSec - prerollSec).toFixed(6));
    const relStartSec = Math.max(0, exactSrcStartSec - seekSec);
    const relDurSec = ((fadePre + seg.frames) * rate) / fps;
    const shiftExpr = relStartSec > 1e-6 ? `(PTS-${relStartSec.toFixed(6)}/TB)` : '(PTS-STARTPTS)';
    steps.push(
      `trim=end=${(relStartSec + relDurSec + 0.25).toFixed(6)}`,
      `setpts=${shiftExpr}/${rate.toFixed(6)}`,
      `fps=${fps}:start_time=0`,
      'tpad=stop_mode=clone:stop_duration=0.15',
      `trim=start_frame=0:end_frame=${fadePre + seg.frames}`,
      'setpts=PTS-STARTPTS',
      'setsar=1',
    );
  }
  return { fadePre, seekSec, steps };
}

function videoDecoderArgs(seg) {
  if (!seg?.sourceHasAlpha) return [];
  if (seg.sourceCodec === 'vp9') return ['-c:v', 'libvpx-vp9'];
  if (seg.sourceCodec === 'vp8') return ['-c:v', 'libvpx'];
  return [];
}

function appendRgbFilterSteps(rgbSteps, filters, brightnessMul = 1, saturateMul = 1) {
  const b = Number(filters?.brightness ?? 1) * brightnessMul;
  const c = Number(filters?.contrast ?? 1);
  const s = Number(filters?.saturate ?? 1) * saturateMul;
  if (Math.abs(b - 1) > 1e-6) {
    rgbSteps.push(`lutrgb=r='clip(val*${b},0,255)':g='clip(val*${b},0,255)':b='clip(val*${b},0,255)'`);
  }
  if (Math.abs(c - 1) > 1e-6) {
    rgbSteps.push(`lutrgb=r='clip(127.5+${c}*(val-127.5),0,255)':g='clip(127.5+${c}*(val-127.5),0,255)':b='clip(127.5+${c}*(val-127.5),0,255)'`);
  }
  if (Math.abs(s - 1) > 1e-6) {
    const rr = (0.2126 + 0.7874 * s).toFixed(6);
    const rg = (0.7152 - 0.7152 * s).toFixed(6);
    const rb = (0.0722 - 0.0722 * s).toFixed(6);
    const gr = (0.2126 - 0.2126 * s).toFixed(6);
    const gg = (0.7152 + 0.2848 * s).toFixed(6);
    const gb = (0.0722 - 0.0722 * s).toFixed(6);
    const br = (0.2126 - 0.2126 * s).toFixed(6);
    const bg = (0.7152 - 0.7152 * s).toFixed(6);
    const bb = (0.0722 + 0.9278 * s).toFixed(6);
    rgbSteps.push(`colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`);
  }
}

export function buildClipFilterChain(seg, segIdx, fps, width, height, options = {}) {
  const durationSec = (seg.frames / fps).toFixed(6);
  if (seg.kind === 'black') {
    return {
      usesInput: false,
      filter: `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSec},format=yuv420p,trim=end_frame=${seg.frames},setpts=PTS-STARTPTS,setsar=1[bv${segIdx}]`,
      outLabel: `[bv${segIdx}]`,
    };
  }
  const vf = seg.visualFade;
  const loc0 = seg.clipLocalStart ?? 0;
  const loc1 = loc0 + seg.frames;
  const { fadePre, seekSec, steps } = buildVideoTrimSteps(seg, fps);
  const decoderArgs = videoDecoderArgs(seg);
  const bg = seg.backgroundFill ?? null;
  const effectiveFit = bg ? 'contain' : seg.fit;
  const borderRadius = Math.max(0, Number(seg.transform?.borderRadius ?? 0));
  const rotDeg = Number(seg.transform?.rotation ?? 0) % 360;
  const hasRotation = Math.abs(rotDeg) > 1e-4;
  const sourceWidth = Number(seg.sourceWidth ?? width);
  const sourceHeight = Number(seg.sourceHeight ?? height);
  const fgRatio = effectiveFit === 'cover'
    ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const estFrameW = effectiveFit === 'cover' ? width : Math.max(2, Math.round(sourceWidth * fgRatio));
  const estFrameH = effectiveFit === 'cover' ? height : Math.max(2, Math.round(sourceHeight * fgRatio));
  const resolvedRadius = Math.min(borderRadius, Math.max(0, Math.floor(Math.min(estFrameW, estFrameH) / 2)));
  const enhancedPath = Boolean(seg.sourceHasAlpha || bg || resolvedRadius > 0 || hasRotation);

  const rgbInSteps = ['scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int', 'format=rgb24'];
  const rgbOutSteps = ['scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuv420p'];
  const blurs = seg.localGaussianBlurs ?? [];
  const f = seg.filters;
  const opacity = seg.transform?.opacity ?? 1;
  const crop = seg.transform?.crop;
  const cx = crop ? crop.x : 0;
  const cy = crop ? crop.y : 0;
  const cw = crop ? crop.width : width;
  const ch = crop ? crop.height : height;
  if (!bg && (cw <= 0 || ch <= 0)) {
    return {
      usesInput: false,
      filter: `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSec},format=yuv420p,trim=end_frame=${seg.frames},setpts=PTS-STARTPTS,setsar=1[bv${segIdx}]`,
      outLabel: `[bv${segIdx}]`,
    };
  }
  const sx = seg.transform?.scaleX ?? 1;
  const sy = seg.transform?.scaleY ?? 1;
  const x = seg.transform?.x ?? 0;
  const y = seg.transform?.y ?? 0;
  const scaledW = Math.max(2, Math.round(cw * sx));
  const scaledH = Math.max(2, Math.round(ch * sy));
  const dx = Math.round((width - width * sx) / 2 + cx * sx + (x / 100) * width);
  const dy = Math.round((height - height * sy) / 2 + cy * sy + (y / 100) * height);
  const visX0 = Math.max(0, dx);
  const visY0 = Math.max(0, dy);
  const visX1 = Math.min(width, dx + scaledW);
  const visY1 = Math.min(height, dy + scaledH);
  const visW = visX1 - visX0;
  const visH = visY1 - visY0;
  if (!bg && !hasRotation && (visW <= 0 || visH <= 0)) {
    return {
      usesInput: false,
      filter: `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSec},format=yuv420p,trim=end_frame=${seg.frames},setpts=PTS-STARTPTS,setsar=1[bv${segIdx}]`,
      outLabel: `[bv${segIdx}]`,
    };
  }

  if (enhancedPath) {
    if (seg.sourceHasAlpha) {
      if (RGB_ALPHA_PIX_FMTS.test(String(seg.sourcePixFmt ?? ''))) {
        steps.push('scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuva444p');
      } else {
        steps.push('format=yuva444p');
      }
    } else if (seg.sourcePixFmt && seg.sourcePixFmt !== 'yuv420p') {
      const inRange = seg.sourceColorRange === 'pc' ? 'pc' : 'tv';
      steps.push(`scale=in_range=${inRange}:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int`, 'format=yuv420p');
    }

    const chainParts = [];
    let bgOutLabel;
    let activeSteps;
    if (bg) {
      const bgsLabel = `bgs${segIdx}`;
      const fgInLabel = `fgi${segIdx}`;
      steps.push(`split=2[${bgsLabel}][${fgInLabel}]`);
      chainParts.push(steps.join(','));
      const osW = Math.max(2, Math.round(width * bg.overscanScale));
      const osH = Math.max(2, Math.round(height * bg.overscanScale));
      const bgSteps = [
        `[${bgsLabel}]scale=${osW}:${osH}:force_original_aspect_ratio=increase:flags=bilinear`,
        `crop=${width}:${height}`,
      ];
      const bgRgbSteps = [];
      appendRgbFilterSteps(bgRgbSteps, f, bg.brightness, bg.saturate);
      if (bgRgbSteps.length > 0) bgSteps.push(...rgbInSteps, ...bgRgbSteps, ...rgbOutSteps);
      const totalBlur = bg.blurPx + (f?.blur ?? 0);
      if (totalBlur >= 8) {
        const dw = Math.max(2, Math.round(width / 4) & ~1);
        const dh = Math.max(2, Math.round(height / 4) & ~1);
        bgSteps.push(`scale=${dw}:${dh}:flags=bilinear`, `gblur=sigma=${(totalBlur / 4).toFixed(3)}:steps=2`, `scale=${width}:${height}:flags=bilinear`);
      } else if (totalBlur > 0) {
        bgSteps.push(`gblur=sigma=${totalBlur.toFixed(3)}:steps=2`);
      }
      bgSteps.push('format=yuv420p');
      bgOutLabel = `bgcov${segIdx}`;
      chainParts.push(`${bgSteps.join(',')}[${bgOutLabel}]`);
      activeSteps = [`[${fgInLabel}]format=yuva444p`];
    } else {
      steps.push('format=yuva444p');
      activeSteps = steps;
      const baseFrameCount = fadePre + seg.frames;
      const baseDurationSec = (baseFrameCount / fps).toFixed(6);
      bgOutLabel = `bgblk${segIdx}`;
      chainParts.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${baseDurationSec},format=yuv420p,trim=end_frame=${baseFrameCount},setpts=PTS-STARTPTS,setsar=1[${bgOutLabel}]`);
    }

    let frameW = width;
    let frameH = height;
    let needsPadToCanvas = false;
    if (sourceWidth !== width || sourceHeight !== height) {
      if (effectiveFit === 'cover') {
        activeSteps.push(`scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${width}:${height}`);
      } else {
        frameW = estFrameW;
        frameH = estFrameH;
        activeSteps.push(`scale=${frameW}:${frameH}:flags=lanczos`);
        needsPadToCanvas = frameW !== width || frameH !== height;
      }
    }

    const applyAlphaRgb = (rgbSteps, tag) => {
      const sRgb = `crgbs_${segIdx}_${tag}`;
      const sAlp = `calps_${segIdx}_${tag}`;
      const oRgb = `crgbo_${segIdx}_${tag}`;
      const oAlp = `calpo_${segIdx}_${tag}`;
      activeSteps.push('format=yuva444p', `split=2[${sRgb}][${sAlp}]`);
      chainParts.push(
        activeSteps.join(','),
        `[${sRgb}]${rgbInSteps.join(',')},${rgbSteps.join(',')}[${oRgb}]`,
        `[${sAlp}]alphaextract[${oAlp}]`,
      );
      activeSteps = [`[${oRgb}][${oAlp}]alphamerge=eof_action=repeat`, 'format=yuva444p'];
    };
    const applyAlphaMask = (maskSpec, tag) => {
      const fgLabel = `cmfg_${segIdx}_${tag}`;
      const sBase = `cmb_${segIdx}_${tag}`;
      const sOrigA = `cmoa_${segIdx}_${tag}`;
      const combA = `cmca_${segIdx}_${tag}`;
      const mLabel = `cmm_${segIdx}_${tag}`;
      const maskInLabel = options.registerBlurMask
        ? options.registerBlurMask(maskSpec)
        : `[cmm_in_${segIdx}_${tag}]`;
      activeSteps.push('format=yuva444p', `split=2[${fgLabel}][${sBase}]`);
      chainParts.push(
        activeSteps.join(','),
        `[${sBase}]alphaextract[${sOrigA}]`,
        `${maskInLabel}format=gray[${mLabel}]`,
        `[${sOrigA}][${mLabel}]blend=all_expr='(A*B)/255'[${combA}]`,
      );
      activeSteps = [`[${fgLabel}][${combA}]alphamerge=eof_action=repeat`, 'format=yuva444p'];
    };

    for (let bi = 0; bi < blurs.length; bi++) {
      const b = blurs[bi];
      if (b.kind === 'pixelate') {
        const bs = Math.max(1, Math.round(b.blockSize));
        if (bs > 1) {
          const dw = Math.max(1, Math.round(frameW / bs));
          const dh = Math.max(1, Math.round(frameH / bs));
          activeSteps.push('format=yuva444p', `scale=${dw}:${dh}:flags=neighbor`, `scale=${frameW}:${frameH}:flags=neighbor`, 'format=yuva444p');
        }
        continue;
      }
      if (b.kind === 'lut3d') {
        const intensity = clamp(Number(b.intensity ?? 1), 0, 1);
        if (intensity <= 0) continue;
        const cubePath = b.cubePath ?? options.resolveLutPath?.(b.cubeRelPath);
        if (!cubePath) continue;
        const escaped = escapeFfmpegFilterPath(cubePath);
        if (intensity >= 0.9999) {
          applyAlphaRgb([`lut3d=file='${escaped}':interp=tetrahedral`], `l${bi}`);
        } else {
          const lBase = `clutb_${segIdx}_${bi}`;
          const lWet = `clutw_${segIdx}_${bi}`;
          const lGraded = `clutg_${segIdx}_${bi}`;
          const dryW = (1 - intensity).toFixed(6);
          const wetW = intensity.toFixed(6);
          applyAlphaRgb([
            `split=2[${lBase}][${lWet}]`,
            `[${lWet}]lut3d=file='${escaped}':interp=tetrahedral[${lGraded}]`,
            `[${lBase}][${lGraded}]blend=all_expr='A*${dryW}+B*${wetW}'`,
          ], `l${bi}`);
        }
        continue;
      }
      if (b.kind === 'shape-mask') {
        const halfW = b.shape === 'circle'
          ? Math.max(0.5, b.radius * Math.min(frameW, frameH) * 0.5)
          : Math.max(0.5, (b.widthRatio * frameW) / 2);
        const halfH = b.shape === 'circle' ? halfW : Math.max(0.5, (b.heightRatio * frameH) / 2);
        applyAlphaMask({
          shape: b.shape === 'circle' ? 'ellipse' : 'rectangle',
          rw: frameW,
          rh: frameH,
          localCx: b.centerX * frameW,
          localCy: b.centerY * frameH,
          halfW,
          halfH,
          feather: b.feather,
          opacity: 1,
          cornerRadius: b.cornerRadius ?? 0,
          invert: Boolean(b.invert),
          centeredFeather: true,
        }, `sm${bi}`);
        continue;
      }
      const bCx = b.centerX * frameW;
      const bCy = b.centerY * frameH;
      const halfW = (b.widthRatio * frameW) / 2;
      const halfH = (b.heightRatio * frameH) / 2;
      const x0 = Math.max(0, Math.floor(bCx - halfW));
      const y0 = Math.max(0, Math.floor(bCy - halfH));
      const x1 = Math.min(frameW, Math.ceil(bCx + halfW));
      const y1 = Math.min(frameH, Math.ceil(bCy + halfH));
      const rw = x1 - x0;
      const rh = y1 - y0;
      if (rw < 2 || rh < 2) continue;
      const bLabel = `cgbb_${segIdx}_${bi}`;
      const sLabel = `cgbs_${segIdx}_${bi}`;
      const rLabel = `cgbr_${segIdx}_${bi}`;
      if (b.kind === 'local-mosaic') {
        const bs = Math.max(1, Math.round(b.blockSize));
        if (bs <= 1) continue;
        const dw = Math.max(1, Math.round(rw / bs));
        const dh = Math.max(1, Math.round(rh / bs));
        if (b.feather === 0 && x0 === 0 && y0 === 0 && x1 === frameW && y1 === frameH) {
          activeSteps.push('format=yuva444p', `scale=${dw}:${dh}:flags=neighbor`, `scale=${frameW}:${frameH}:flags=neighbor`, 'format=yuva444p');
          continue;
        }
        activeSteps.push(`split=2[${bLabel}][${sLabel}]`);
        chainParts.push(activeSteps.join(','));
        chainParts.push(
          `[${sLabel}]format=yuva444p,crop=${rw}:${rh}:${x0}:${y0},scale=${dw}:${dh}:flags=neighbor,scale=${rw}:${rh}:flags=neighbor[${rLabel}]`,
        );
      } else {
        if (b.feather === 0 && x0 === 0 && y0 === 0 && x1 === frameW && y1 === frameH) {
          activeSteps.push(`gblur=sigma=${b.sigma}:steps=2`);
          continue;
        }
        const pad = Math.ceil(b.sigma * 3);
        const px0 = Math.max(0, x0 - pad);
        const py0 = Math.max(0, y0 - pad);
        const px1 = Math.min(frameW, x1 + pad);
        const py1 = Math.min(frameH, y1 + pad);
        const pw = px1 - px0;
        const ph = py1 - py0;
        const ix = x0 - px0;
        const iy = y0 - py0;
        activeSteps.push(`split=2[${bLabel}][${sLabel}]`);
        chainParts.push(activeSteps.join(','));
        chainParts.push(
          `[${sLabel}]format=yuva444p,crop=${pw}:${ph}:${px0}:${py0},gblur=sigma=${b.sigma}:steps=2,crop=${rw}:${rh}:${ix}:${iy}[${rLabel}]`,
        );
      }
      if (b.feather > 0) {
        const maskLabel = options.registerBlurMask
          ? options.registerBlurMask({ shape: 'rectangle', rw, rh, localCx: bCx - x0, localCy: bCy - y0, halfW, halfH, feather: b.feather, opacity: 1 })
          : `[cgbm_in_${segIdx}_${bi}]`;
        const mLabel = `cgbm_${segIdx}_${bi}`;
        const aLabel = `cgba_${segIdx}_${bi}`;
        chainParts.push(`${maskLabel}format=gray[${mLabel}]`, `[${rLabel}][${mLabel}]alphamerge=eof_action=repeat[${aLabel}]`);
        activeSteps = [`[${bLabel}][${aLabel}]overlay=${x0}:${y0}:format=yuv444`, 'format=yuva444p'];
      } else {
        activeSteps = [`[${bLabel}][${rLabel}]overlay=${x0}:${y0}:format=yuv444`, 'format=yuva444p'];
      }
    }

    if (resolvedRadius > 0) {
      applyAlphaMask({
        shape: 'rectangle',
        rw: frameW,
        rh: frameH,
        localCx: frameW / 2,
        localCy: frameH / 2,
        halfW: frameW / 2,
        halfH: frameH / 2,
        feather: 1,
        cornerRadius: resolvedRadius,
        opacity: 1,
        centeredFeather: true,
      }, 'br');
    }
    if (needsPadToCanvas) {
      activeSteps.push('format=yuva444p', `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
    }
    if (seg.clipMask) {
      applyAlphaMask({ ...seg.clipMask, opacity: 1 }, 'cm');
    }
    if (crop) {
      if (cw <= 0 || ch <= 0) {
        activeSteps.push('format=yuva444p', `lut=a='0'`);
      } else if (hasRotation) {
        activeSteps.push('format=yuva444p', `crop=${cw}:${ch}:${cx}:${cy}`, `pad=${width}:${height}:${cx}:${cy}:color=0x00000000`);
      } else {
        activeSteps.push('format=yuva444p', `crop=${cw}:${ch}:${cx}:${cy}`);
      }
    }
    if (f) {
      const rgbSteps = [];
      appendRgbFilterSteps(rgbSteps, f, 1, 1);
      if (rgbSteps.length > 0) applyAlphaRgb(rgbSteps, 'flt');
      if (f.blur > 0) activeSteps.push(`gblur=sigma=${f.blur}`);
    }
    if (!bg && opacity < 1) {
      activeSteps.push('format=yuva444p', `lut=a='clip(val*${opacity},0,255)'`);
    }

    const fgReadyLabel = `fgrdy${segIdx}`;
    let compSteps;
    if (hasRotation) {
      const scaledCanvasW = Math.max(2, Math.round(width * sx));
      const scaledCanvasH = Math.max(2, Math.round(height * sy));
      if (scaledCanvasW !== width || scaledCanvasH !== height) {
        activeSteps.push(`scale=${scaledCanvasW}:${scaledCanvasH}:flags=bilinear`);
      }
      const rad = (rotDeg * Math.PI) / 180;
      activeSteps.push('format=yuva444p', `rotate=${rad.toFixed(8)}:ow=rotw(${rad.toFixed(8)}):oh=roth(${rad.toFixed(8)}):c=none`);
      const shiftX = Math.round((x / 100) * width);
      const shiftY = Math.round((y / 100) * height);
      chainParts.push(`${activeSteps.join(',')}[${fgReadyLabel}]`);
      compSteps = [`[${bgOutLabel}][${fgReadyLabel}]overlay=x=(W-w)/2+(${shiftX}):y=(H-h)/2+(${shiftY}):shortest=1:format=yuv420`];
    } else if (visW <= 0 || visH <= 0) {
      chainParts.push(`${activeSteps.join(',')},nullsink`);
      compSteps = [`[${bgOutLabel}]setsar=1`];
    } else {
      if (scaledW !== cw || scaledH !== ch) activeSteps.push(`scale=${scaledW}:${scaledH}:flags=bilinear`);
      if (visW !== scaledW || visH !== scaledH) {
        activeSteps.push('format=yuva444p', `crop=${visW}:${visH}:${visX0 - dx}:${visY0 - dy}`);
      }
      chainParts.push(`${activeSteps.join(',')}[${fgReadyLabel}]`);
      compSteps = [`[${bgOutLabel}][${fgReadyLabel}]overlay=${visX0}:${visY0}:shortest=1:format=yuv420`];
    }

    if (bg && opacity < 1) {
      compSteps.push(...rgbInSteps, `lutrgb=r='val*${opacity}':g='val*${opacity}':b='val*${opacity}'`, ...rgbOutSteps);
    }

    let compPrefix = '';
    const hasIn = Boolean(vf?.fadeIn && vf.fadeIn.until > loc0 && vf.fadeIn.from < loc1);
    const hasOut = Boolean(vf?.fadeOut && vf.fadeOut.until > loc0 && vf.fadeOut.from < loc1);
    if (hasIn || hasOut) {
      const decodeLoc0 = loc0 - fadePre;
      const inEnd = hasIn ? Math.min(seg.frames, Math.ceil(vf.fadeIn.until - loc0)) : 0;
      const outStart = hasOut ? Math.max(0, Math.floor(vf.fadeOut.from - loc0)) : seg.frames;
      const fadeFrameCount = (hasIn ? inEnd : 0) + (hasOut ? seg.frames - outStart : 0);
      if (inEnd < outStart && fadeFrameCount * 2 < seg.frames) {
        const parts = [];
        if (hasIn) parts.push({ label: `cfi${segIdx}`, a: 0, b: fadePre + inEnd, trimAfter: fadePre, kind: 'in' });
        if (outStart > inEnd) parts.push({ label: `cfm${segIdx}`, a: fadePre + inEnd, b: fadePre + outStart, trimAfter: 0, kind: 'mid' });
        if (hasOut) parts.push({ label: `cfo${segIdx}`, a: fadePre + outStart, b: fadePre + seg.frames, trimAfter: outStart === 0 ? fadePre : 0, kind: 'out' });
        if (parts.length > 1) {
          const splitLabels = parts.map((p) => `[s${p.label}]`).join('');
          const subChains = parts.map((p) => {
            const base = `[s${p.label}]trim=start_frame=${p.a}:end_frame=${p.b},setpts=PTS-STARTPTS`;
            if (p.kind === 'mid') return `${base},setsar=1[${p.label}]`;
            const fadeCfg = p.kind === 'in'
              ? `fade=t=in:s=${Math.max(0, Math.round(vf.fadeIn.from - (loc0 + p.a - fadePre)))}:n=${Math.max(1, Math.round(vf.fadeIn.until - vf.fadeIn.from))}:c=black`
              : `fade=t=out:s=${Math.max(0, Math.round(vf.fadeOut.from - (loc0 + p.a - fadePre)))}:n=${Math.max(1, Math.round(vf.fadeOut.until - vf.fadeOut.from))}:c=black`;
            const post = p.trimAfter > 0 ? `,trim=start_frame=${p.trimAfter}:end_frame=${p.b - p.a},setpts=PTS-STARTPTS` : '';
            return `${base},${rgbInSteps.join(',')},${fadeCfg}${post},${rgbOutSteps.join(',')},setsar=1[${p.label}]`;
          });
          compPrefix = `${compSteps.join(',')},split=${parts.length}${splitLabels};${subChains.join(';')};${parts.map((p) => `[${p.label}]`).join('')}concat=n=${parts.length}:v=1:a=0,setsar=1`;
        }
      }
      if (!compPrefix) {
        compSteps.push(...rgbInSteps);
        if (hasIn) {
          const s = Math.max(0, Math.round(vf.fadeIn.from - decodeLoc0));
          const n = Math.max(1, Math.round(vf.fadeIn.until - vf.fadeIn.from));
          compSteps.push(`fade=t=in:s=${s}:n=${n}:c=black`);
        }
        if (hasOut) {
          const s = Math.max(0, Math.round(vf.fadeOut.from - decodeLoc0));
          const n = Math.max(1, Math.round(vf.fadeOut.until - vf.fadeOut.from));
          compSteps.push(`fade=t=out:s=${s}:n=${n}:c=black`);
        }
        if (fadePre > 0) compSteps.push(`trim=start_frame=${fadePre}:end_frame=${fadePre + seg.frames}`, 'setpts=PTS-STARTPTS');
        compSteps.push(...rgbOutSteps);
      }
    }
    const tailFilter = compPrefix ? `${compPrefix}[bv${segIdx}]` : `${compSteps.join(',')},setsar=1[bv${segIdx}]`;
    const fullFilter = `${chainParts.join(';')};${tailFilter}`;
    return {
      usesInput: true,
      seekSec,
      decoderArgs,
      filter: fullFilter,
      outLabel: `[bv${segIdx}]`,
    };
  }

  if (seg.sourcePixFmt && seg.sourcePixFmt !== 'yuv420p') {
    const inRange = seg.sourceColorRange === 'pc' ? 'pc' : 'tv';
    steps.push(`scale=in_range=${inRange}:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int`, 'format=yuv420p');
  }

  let frameW = width;
  let frameH = height;
  let needsLetterboxPad = false;
  if (sourceWidth !== width || sourceHeight !== height) {
    if (effectiveFit !== 'cover' && blurs.length > 0) {
      frameW = estFrameW;
      frameH = estFrameH;
      steps.push(`scale=${frameW}:${frameH}:flags=lanczos`);
      needsLetterboxPad = frameW !== width || frameH !== height;
    } else {
      const mode = effectiveFit === 'cover' ? 'increase' : 'decrease';
      const scale = `scale=${width}:${height}:force_original_aspect_ratio=${mode}:flags=lanczos`;
      steps.push(effectiveFit === 'cover'
        ? `${scale},crop=${width}:${height}`
        : `${scale},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
  }

  const chainParts = [];
  let activeSteps = steps;
  for (let bi = 0; bi < blurs.length; bi++) {
    const b = blurs[bi];
    if (b.kind === 'pixelate') {
      const bs = Math.max(1, Math.round(b.blockSize));
      if (bs > 1) {
        const dw = Math.max(1, Math.round(frameW / bs));
        const dh = Math.max(1, Math.round(frameH / bs));
        activeSteps.push('format=yuv444p', `scale=${dw}:${dh}:flags=neighbor`, `scale=${frameW}:${frameH}:flags=neighbor`, 'format=yuv420p');
      }
      continue;
    }
    if (b.kind === 'lut3d') {
      const intensity = clamp(Number(b.intensity ?? 1), 0, 1);
      if (intensity <= 0) continue;
      const cubePath = b.cubePath ?? options.resolveLutPath?.(b.cubeRelPath);
      if (!cubePath) continue;
      const escaped = escapeFfmpegFilterPath(cubePath);
      if (intensity >= 0.9999) {
        activeSteps.push(...rgbInSteps, `lut3d=file='${escaped}':interp=tetrahedral`, ...rgbOutSteps);
      } else {
        const lBase = `lutb${segIdx}_${bi}`;
        const lWet = `lutw${segIdx}_${bi}`;
        const lGraded = `lutg${segIdx}_${bi}`;
        activeSteps.push(...rgbInSteps, `split=2[${lBase}][${lWet}]`);
        chainParts.push(activeSteps.join(','));
        chainParts.push(`[${lWet}]lut3d=file='${escaped}':interp=tetrahedral[${lGraded}]`);
        const dryW = (1 - intensity).toFixed(6);
        const wetW = intensity.toFixed(6);
        activeSteps = [
          `[${lBase}][${lGraded}]blend=all_expr='A*${dryW}+B*${wetW}'`,
          ...rgbOutSteps,
        ];
      }
      continue;
    }
    if (b.kind === 'shape-mask') {
      const maskFrameCount = fadePre + seg.frames;
      const maskDurationSec = (maskFrameCount / fps).toFixed(6);
      const halfW = b.shape === 'circle'
        ? Math.max(0.5, b.radius * Math.min(frameW, frameH) * 0.5)
        : Math.max(0.5, (b.widthRatio * frameW) / 2);
      const halfH = b.shape === 'circle'
        ? halfW
        : Math.max(0.5, (b.heightRatio * frameH) / 2);
      const fgLabel = `smf${segIdx}_${bi}`;
      const mLabel = `smm${segIdx}_${bi}`;
      const aLabel = `sma${segIdx}_${bi}`;
      const bgLabel = `smb${segIdx}_${bi}`;
      const maskInLabel = options.registerBlurMask
        ? options.registerBlurMask({
          shape: b.shape === 'circle' ? 'ellipse' : 'rectangle',
          rw: frameW,
          rh: frameH,
          localCx: b.centerX * frameW,
          localCy: b.centerY * frameH,
          halfW,
          halfH,
          feather: b.feather,
          opacity: 1,
          cornerRadius: b.cornerRadius ?? 0,
          invert: Boolean(b.invert),
          centeredFeather: true,
        })
        : `[smm_in_${segIdx}_${bi}]`;
      activeSteps.push('format=yuva444p');
      chainParts.push(
        `${activeSteps.join(',')}[${fgLabel}]`,
        `${maskInLabel}format=gray[${mLabel}]`,
        `[${fgLabel}][${mLabel}]alphamerge=eof_action=repeat[${aLabel}]`,
        `color=c=black:s=${frameW}x${frameH}:r=${fps}:d=${maskDurationSec},format=yuv420p,trim=end_frame=${maskFrameCount},setpts=PTS-STARTPTS,setsar=1[${bgLabel}]`,
      );
      activeSteps = [`[${bgLabel}][${aLabel}]overlay=0:0:shortest=1:format=yuv420`];
      continue;
    }
    const bCx = b.centerX * frameW;
    const bCy = b.centerY * frameH;
    const halfW = (b.widthRatio * frameW) / 2;
    const halfH = (b.heightRatio * frameH) / 2;
    const x0 = Math.max(0, Math.floor(bCx - halfW));
    const y0 = Math.max(0, Math.floor(bCy - halfH));
    const x1 = Math.min(frameW, Math.ceil(bCx + halfW));
    const y1 = Math.min(frameH, Math.ceil(bCy + halfH));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw < 2 || rh < 2) continue;
    if (b.kind === 'local-mosaic') {
      const bs = Math.max(1, Math.round(b.blockSize));
      if (bs <= 1) continue;
      const dw = Math.max(1, Math.round(rw / bs));
      const dh = Math.max(1, Math.round(rh / bs));
      if (b.feather === 0 && x0 === 0 && y0 === 0 && x1 === frameW && y1 === frameH) {
        activeSteps.push('format=yuv444p', `scale=${dw}:${dh}:flags=neighbor`, `scale=${frameW}:${frameH}:flags=neighbor`, 'format=yuv420p');
        continue;
      }
      const bLabel = `gbb${segIdx}_${bi}`;
      const sLabel = `gbs${segIdx}_${bi}`;
      const rLabel = `gbr${segIdx}_${bi}`;
      activeSteps.push(`split=2[${bLabel}][${sLabel}]`);
      chainParts.push(activeSteps.join(','));
      chainParts.push(
        `[${sLabel}]format=yuv444p,crop=${rw}:${rh}:${x0}:${y0},scale=${dw}:${dh}:flags=neighbor,scale=${rw}:${rh}:flags=neighbor${b.feather > 0 ? ',format=yuva444p' : ''}[${rLabel}]`,
      );
      if (b.feather > 0) {
        const maskLabel = options.registerBlurMask
          ? options.registerBlurMask({ shape: 'rectangle', rw, rh, localCx: bCx - x0, localCy: bCy - y0, halfW, halfH, feather: b.feather, opacity: 1 })
          : `[gbm_in_${segIdx}_${bi}]`;
        const mLabel = `gbm${segIdx}_${bi}`;
        const aLabel = `gba${segIdx}_${bi}`;
        chainParts.push(
          `${maskLabel}format=gray[${mLabel}]`,
          `[${rLabel}][${mLabel}]alphamerge=eof_action=repeat[${aLabel}]`,
        );
        activeSteps = [`[${bLabel}][${aLabel}]overlay=${x0}:${y0}:format=yuv420`];
      } else {
        activeSteps = [`[${bLabel}][${rLabel}]overlay=${x0}:${y0}:format=yuv420`];
      }
      continue;
    }
    if (b.feather === 0 && x0 === 0 && y0 === 0 && x1 === frameW && y1 === frameH) {
      activeSteps.push(`gblur=sigma=${b.sigma}:steps=2`);
      continue;
    }
    const pad = Math.ceil(b.sigma * 3);
    const px0 = Math.max(0, x0 - pad);
    const py0 = Math.max(0, y0 - pad);
    const px1 = Math.min(frameW, x1 + pad);
    const py1 = Math.min(frameH, y1 + pad);
    const pw = px1 - px0;
    const ph = py1 - py0;
    const ix = x0 - px0;
    const iy = y0 - py0;
    const bLabel = `gbb${segIdx}_${bi}`;
    const sLabel = `gbs${segIdx}_${bi}`;
    const rLabel = `gbr${segIdx}_${bi}`;
    activeSteps.push(`split=2[${bLabel}][${sLabel}]`);
    chainParts.push(activeSteps.join(','));
    chainParts.push(
      `[${sLabel}]format=yuv444p,crop=${pw}:${ph}:${px0}:${py0},gblur=sigma=${b.sigma}:steps=2,crop=${rw}:${rh}:${ix}:${iy}${b.feather > 0 ? ',format=yuva444p' : ''}[${rLabel}]`,
    );
    if (b.feather > 0) {
      const maskLabel = options.registerBlurMask
        ? options.registerBlurMask({ shape: 'rectangle', rw, rh, localCx: bCx - x0, localCy: bCy - y0, halfW, halfH, feather: b.feather, opacity: 1 })
        : `[gbm_in_${segIdx}_${bi}]`;
      const mLabel = `gbm${segIdx}_${bi}`;
      const aLabel = `gba${segIdx}_${bi}`;
      chainParts.push(
        `${maskLabel}format=gray[${mLabel}]`,
        `[${rLabel}][${mLabel}]alphamerge=eof_action=repeat[${aLabel}]`,
      );
      activeSteps = [`[${bLabel}][${aLabel}]overlay=${x0}:${y0}:format=yuv420`];
    } else {
      activeSteps = [`[${bLabel}][${rLabel}]overlay=${x0}:${y0}:format=yuv420`];
    }
  }
  if (needsLetterboxPad) {
    activeSteps.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }
  if (seg.sourceHasAlpha) {
    const fgLabel = `abfg${segIdx}`;
    const bgLabel = `abbg${segIdx}`;
    const baseFrameCount = fadePre + seg.frames;
    const baseDurationSec = (baseFrameCount / fps).toFixed(6);
    activeSteps.push('format=yuva444p');
    chainParts.push(
      `${activeSteps.join(',')}[${fgLabel}]`,
      `color=c=black:s=${width}x${height}:r=${fps}:d=${baseDurationSec},format=yuv420p,trim=end_frame=${baseFrameCount},setpts=PTS-STARTPTS,setsar=1[${bgLabel}]`,
    );
    activeSteps = [`[${bgLabel}][${fgLabel}]overlay=0:0:shortest=1:format=yuv420`];
  }
  if (seg.clipMask) {
    const cm = seg.clipMask;
    const maskFrameCount = fadePre + seg.frames;
    const maskDurationSec = (maskFrameCount / fps).toFixed(6);
    const fgLabel = `cmf${segIdx}`;
    const mLabel = `cmm${segIdx}`;
    const aLabel = `cma${segIdx}`;
    const bgLabel = `cmb${segIdx}`;
    const maskInLabel = options.registerBlurMask
      ? options.registerBlurMask({
        shape: cm.shape,
        rw: cm.rw,
        rh: cm.rh,
        localCx: cm.localCx,
        localCy: cm.localCy,
        halfW: cm.halfW,
        halfH: cm.halfH,
        feather: cm.feather,
        opacity: 1,
      })
      : `[cmm_in_${segIdx}]`;
    activeSteps.push('format=yuva444p');
    chainParts.push(
      `${activeSteps.join(',')}[${fgLabel}]`,
      `${maskInLabel}format=gray[${mLabel}]`,
      `[${fgLabel}][${mLabel}]alphamerge=eof_action=repeat[${aLabel}]`,
      `color=c=black:s=${width}x${height}:r=${fps}:d=${maskDurationSec},format=yuv420p,trim=end_frame=${maskFrameCount},setpts=PTS-STARTPTS,setsar=1[${bgLabel}]`,
    );
    activeSteps = [`[${bgLabel}][${aLabel}]overlay=0:0:shortest=1:format=yuv420`];
  }
  if (crop) activeSteps.push(`crop=${cw}:${ch}:${cx}:${cy}`);

  if (f || opacity < 1) {
    activeSteps.push(...rgbInSteps);
    appendRgbFilterSteps(activeSteps, f, 1, 1);
    if (f && f.blur > 0) activeSteps.push(`gblur=sigma=${f.blur}`);
    if (opacity < 1) activeSteps.push(`lutrgb=r='val*${opacity}':g='val*${opacity}':b='val*${opacity}'`);
    activeSteps.push(...rgbOutSteps);
  }

  let prefixFilter = '';
  const tailSteps = [];
  const hasIn = Boolean(vf?.fadeIn && vf.fadeIn.until > loc0 && vf.fadeIn.from < loc1);
  const hasOut = Boolean(vf?.fadeOut && vf.fadeOut.until > loc0 && vf.fadeOut.from < loc1);
  if (hasIn || hasOut) {
    const decodeLoc0 = loc0 - fadePre;
    const inEnd = hasIn ? Math.min(seg.frames, Math.ceil(vf.fadeIn.until - loc0)) : 0;
    const outStart = hasOut ? Math.max(0, Math.floor(vf.fadeOut.from - loc0)) : seg.frames;
    const fadeFrameCount = (hasIn ? inEnd : 0) + (hasOut ? seg.frames - outStart : 0);
    if (inEnd < outStart && fadeFrameCount * 2 < seg.frames) {
      // Only convert the short fade-in/out edge frames to RGB24 so long middle footage stays fast YUV420P.
      const parts = [];
      if (hasIn) parts.push({ label: `fi${segIdx}`, a: 0, b: fadePre + inEnd, trimAfter: fadePre, kind: 'in' });
      if (outStart > inEnd) parts.push({ label: `fm${segIdx}`, a: fadePre + inEnd, b: fadePre + outStart, trimAfter: 0, kind: 'mid' });
      if (hasOut) parts.push({ label: `fo${segIdx}`, a: fadePre + outStart, b: fadePre + seg.frames, trimAfter: outStart === 0 ? fadePre : 0, kind: 'out' });
      if (parts.length > 1) {
        const splitLabels = parts.map((p) => `[s${p.label}]`).join('');
        const subChains = parts.map((p) => {
          const base = `[s${p.label}]trim=start_frame=${p.a}:end_frame=${p.b},setpts=PTS-STARTPTS`;
          if (p.kind === 'mid') return `${base},setsar=1[${p.label}]`;
          const fadeCfg = p.kind === 'in'
            ? `fade=t=in:s=${Math.max(0, Math.round(vf.fadeIn.from - (loc0 + p.a - fadePre)))}:n=${Math.max(1, Math.round(vf.fadeIn.until - vf.fadeIn.from))}:c=black`
            : `fade=t=out:s=${Math.max(0, Math.round(vf.fadeOut.from - (loc0 + p.a - fadePre)))}:n=${Math.max(1, Math.round(vf.fadeOut.until - vf.fadeOut.from))}:c=black`;
          const post = p.trimAfter > 0 ? `,trim=start_frame=${p.trimAfter}:end_frame=${p.b - p.a},setpts=PTS-STARTPTS` : '';
          return `${base},${rgbInSteps.join(',')},${fadeCfg}${post},${rgbOutSteps.join(',')},setsar=1[${p.label}]`;
        });
        prefixFilter = `${activeSteps.join(',')},split=${parts.length}${splitLabels};${subChains.join(';')};${parts.map((p) => `[${p.label}]`).join('')}concat=n=${parts.length}:v=1:a=0`;
      }
    }
    if (!prefixFilter) {
      activeSteps.push(...rgbInSteps);
      if (hasIn) {
        const s = Math.max(0, Math.round(vf.fadeIn.from - decodeLoc0));
        const n = Math.max(1, Math.round(vf.fadeIn.until - vf.fadeIn.from));
        activeSteps.push(`fade=t=in:s=${s}:n=${n}:c=black`);
      }
      if (hasOut) {
        const s = Math.max(0, Math.round(vf.fadeOut.from - decodeLoc0));
        const n = Math.max(1, Math.round(vf.fadeOut.until - vf.fadeOut.from));
        activeSteps.push(`fade=t=out:s=${s}:n=${n}:c=black`);
      }
      if (fadePre > 0) activeSteps.push(`trim=start_frame=${fadePre}:end_frame=${fadePre + seg.frames}`, 'setpts=PTS-STARTPTS');
      activeSteps.push(...rgbOutSteps);
    }
  }
  const posSteps = prefixFilter ? tailSteps : activeSteps;

  if (scaledW !== cw || scaledH !== ch) posSteps.push(`scale=${scaledW}:${scaledH}:flags=bilinear`);

  const srcCropX = visX0 - dx;
  const srcCropY = visY0 - dy;
  const padX = visX0;
  const padY = visY0;
  const needsCrop = visW !== scaledW || visH !== scaledH;
  const needsPad = visW !== width || visH !== height;
  if (needsCrop || needsPad) {
    const evenAligned = [visW, visH, srcCropX, srcCropY, padX, padY].every((v) => v % 2 === 0);
    if (!evenAligned) posSteps.push('scale=flags=accurate_rnd+full_chroma_int', 'format=yuv444p');
    if (needsCrop) posSteps.push(`crop=${visW}:${visH}:${srcCropX}:${srcCropY}`);
    if (needsPad) posSteps.push(`pad=${width}:${height}:${padX}:${padY}:black`);
    if (!evenAligned) posSteps.push('scale=flags=accurate_rnd+full_chroma_int', 'format=yuv420p');
  }

  const tailFilter = prefixFilter
    ? (posSteps.length ? `${prefixFilter},${posSteps.join(',')}[bv${segIdx}]` : `${prefixFilter}[bv${segIdx}]`)
    : `${posSteps.join(',')}[bv${segIdx}]`;
  const fullFilter = chainParts.length ? `${chainParts.join(';')};${tailFilter}` : tailFilter;

  return {
    usesInput: true,
    seekSec,
    decoderArgs,
    filter: fullFilter,
    outLabel: `[bv${segIdx}]`,
  };
}

function buildOverlayVideoFilterChain(ov, labelKey, fps, width, height, chunkFrom, chunkTo, options = {}) {
  const ovStart = Math.max(chunkFrom, ov.startFrame);
  const ovEnd = Math.min(chunkTo, ov.endFrame);
  const ovFrames = ovEnd - ovStart;
  if (ovFrames <= 0) return { usesInput: false };

  const bg = ov.backgroundFill ?? null;
  const effectiveFit = bg ? 'contain' : ov.fit;
  const crop = ov.transform?.crop;
  const cx = crop ? crop.x : 0;
  const cy = crop ? crop.y : 0;
  const cw = crop ? crop.width : width;
  const ch = crop ? crop.height : height;
  if (!bg && (cw <= 0 || ch <= 0)) return { usesInput: false };

  const sx = ov.transform?.scaleX ?? 1;
  const sy = ov.transform?.scaleY ?? 1;
  const x = ov.transform?.x ?? 0;
  const y = ov.transform?.y ?? 0;
  const borderRadius = Math.max(0, Number(ov.transform?.borderRadius ?? 0));
  const rotDeg = Number(ov.transform?.rotation ?? 0) % 360;
  const hasRotation = Math.abs(rotDeg) > 1e-4;
  const scaledW = Math.max(2, Math.round(cw * sx));
  const scaledH = Math.max(2, Math.round(ch * sy));
  const dx = Math.round((width - width * sx) / 2 + cx * sx + (x / 100) * width);
  const dy = Math.round((height - height * sy) / 2 + cy * sy + (y / 100) * height);
  const visX0 = Math.max(0, dx);
  const visY0 = Math.max(0, dy);
  const visX1 = Math.min(width, dx + scaledW);
  const visY1 = Math.min(height, dy + scaledH);
  const visW = visX1 - visX0;
  const visH = visY1 - visY0;
  if (!bg && !hasRotation && (visW <= 0 || visH <= 0)) return { usesInput: false };

  const localStart = ovStart - chunkFrom;
  const localEnd = ovEnd - 1 - chunkFrom;
  const rate = ov.playbackRate ?? ov.rate ?? 1;
  const clipLocalStart = ovStart - ov.startFrame;
  const sourceFrame = ov.srcInFrame + clipLocalStart * rate;
  const { fadePre, seekSec, steps } = buildVideoTrimSteps({
    sourceFrame,
    frames: ovFrames,
    playbackRate: rate,
    sourceFps: ov.sourceFps,
    visualFade: ov.visualFade,
    clipLocalStart,
  }, fps);
  const decoderArgs = videoDecoderArgs(ov);
  const sourceWidth = Number(ov.sourceWidth ?? width);
  const sourceHeight = Number(ov.sourceHeight ?? height);
  const sizeDiffers = sourceWidth !== width || sourceHeight !== height;
  const fgRatio = effectiveFit === 'cover'
    ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const estFrameW = effectiveFit === 'cover' ? width : Math.max(2, Math.round(sourceWidth * fgRatio));
  const estFrameH = effectiveFit === 'cover' ? height : Math.max(2, Math.round(sourceHeight * fgRatio));
  const resolvedRadius = Math.min(borderRadius, Math.max(0, Math.floor(Math.min(estFrameW, estFrameH) / 2)));

  const opacity = ov.transform?.opacity ?? 1;
  const vf = ov.visualFade;
  const loc0 = clipLocalStart;
  const loc1 = loc0 + ovFrames;
  const hasIn = Boolean(vf?.fadeIn && vf.fadeIn.until > loc0 && vf.fadeIn.from < loc1);
  const hasOut = Boolean(vf?.fadeOut && vf.fadeOut.until > loc0 && vf.fadeOut.from < loc1);
  const preserveAlpha = Boolean(
    ov.sourceHasAlpha
    || bg
    || opacity < 1
    || ov.clipMask
    || resolvedRadius > 0
    || hasRotation
    || hasIn
    || hasOut
    || (effectiveFit !== 'cover' && sizeDiffers),
  );

  if (preserveAlpha) {
    if (ov.sourceHasAlpha && RGB_ALPHA_PIX_FMTS.test(String(ov.sourcePixFmt ?? ''))) {
      steps.push('scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuva444p');
    } else if (!ov.sourceHasAlpha && ov.sourcePixFmt && ov.sourcePixFmt !== 'yuv420p') {
      const inRange = ov.sourceColorRange === 'pc' ? 'pc' : 'tv';
      steps.push(`scale=in_range=${inRange}:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int`, 'format=yuva444p');
    } else if (!bg) {
      steps.push('format=yuva444p');
    }
  } else if (ov.sourcePixFmt && ov.sourcePixFmt !== 'yuv420p') {
    const inRange = ov.sourceColorRange === 'pc' ? 'pc' : 'tv';
    steps.push(`scale=in_range=${inRange}:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int`, 'format=yuv420p');
  }

  const rgbInSteps = ['scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int', 'format=rgb24'];
  const rgbOutSteps = ['scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', preserveAlpha ? 'format=yuva444p' : 'format=yuv420p'];
  const chainParts = [];
  const f = ov.filters;
  let activeSteps = steps;
  let bgOutLabel = null;
  if (bg) {
    const bgsLabel = `ovbgs_${labelKey}`;
    const fgInLabel = `ovfgi_${labelKey}`;
    steps.push(`split=2[${bgsLabel}][${fgInLabel}]`);
    chainParts.push(steps.join(','));
    const osW = Math.max(2, Math.round(width * bg.overscanScale));
    const osH = Math.max(2, Math.round(height * bg.overscanScale));
    const bgSteps = [
      `[${bgsLabel}]scale=${osW}:${osH}:force_original_aspect_ratio=increase:flags=bilinear`,
      `crop=${width}:${height}`,
    ];
    const bgRgbSteps = [];
    appendRgbFilterSteps(bgRgbSteps, f, bg.brightness, bg.saturate);
    if (bgRgbSteps.length > 0) bgSteps.push(...rgbInSteps, ...bgRgbSteps, 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuv420p');
    const totalBlur = bg.blurPx + (f?.blur ?? 0);
    if (totalBlur >= 8) {
      const dw = Math.max(2, Math.round(width / 4) & ~1);
      const dh = Math.max(2, Math.round(height / 4) & ~1);
      bgSteps.push(`scale=${dw}:${dh}:flags=bilinear`, `gblur=sigma=${(totalBlur / 4).toFixed(3)}:steps=2`, `scale=${width}:${height}:flags=bilinear`);
    } else if (totalBlur > 0) {
      bgSteps.push(`gblur=sigma=${totalBlur.toFixed(3)}:steps=2`);
    }
    bgSteps.push('format=yuva444p');
    bgOutLabel = `ovbgcov_${labelKey}`;
    chainParts.push(`${bgSteps.join(',')}[${bgOutLabel}]`);
    activeSteps = [`[${fgInLabel}]format=yuva444p`];
  }

  const blurs = ov.localGaussianBlurs ?? [];
  let frameW = width;
  let frameH = height;
  let needsTransparentPad = false;
  if (sizeDiffers) {
    if (effectiveFit === 'cover') {
      activeSteps.push(`scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${width}:${height}`);
    } else {
      frameW = estFrameW;
      frameH = estFrameH;
      activeSteps.push(`scale=${frameW}:${frameH}:flags=lanczos`);
      if (frameW !== width || frameH !== height) {
        if (blurs.length > 0 || resolvedRadius > 0) needsTransparentPad = true;
        else activeSteps.push('format=yuva444p', `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
      }
    }
  }
  const applyRgbWithPreservedAlpha = (rgbFilterSteps, tag) => {
    if (!preserveAlpha) {
      activeSteps.push(...rgbInSteps, ...rgbFilterSteps, ...rgbOutSteps);
      return;
    }
    const sRgb = `ovrgbs_${labelKey}_${tag}`;
    const sAlp = `ovalps_${labelKey}_${tag}`;
    const oRgb = `ovrgbo_${labelKey}_${tag}`;
    const oAlp = `ovalpo_${labelKey}_${tag}`;
    activeSteps.push('format=yuva444p', `split=2[${sRgb}][${sAlp}]`);
    chainParts.push(
      activeSteps.join(','),
      `[${sRgb}]${rgbInSteps.join(',')},${rgbFilterSteps.join(',')}[${oRgb}]`,
      `[${sAlp}]alphaextract[${oAlp}]`,
    );
    activeSteps = [`[${oRgb}][${oAlp}]alphamerge=eof_action=repeat`, 'format=yuva444p'];
  };
  const applyMaskToAlpha = (maskSpec, tag) => {
    const fgLabel = `ovmfg_${labelKey}_${tag}`;
    const mLabel = `ovmm_${labelKey}_${tag}`;
    const maskInLabel = options.registerBlurMask
      ? options.registerBlurMask(maskSpec)
      : `[ovm_in_${labelKey}_${tag}]`;
    if (preserveAlpha) {
      const sBase = `ovmb_${labelKey}_${tag}`;
      const sOrigA = `ovmoa_${labelKey}_${tag}`;
      const combA = `ovmca_${labelKey}_${tag}`;
      activeSteps.push('format=yuva444p', `split=2[${fgLabel}][${sBase}]`);
      chainParts.push(
        activeSteps.join(','),
        `[${sBase}]alphaextract[${sOrigA}]`,
        `${maskInLabel}format=gray[${mLabel}]`,
        `[${sOrigA}][${mLabel}]blend=all_expr='(A*B)/255'[${combA}]`,
      );
      activeSteps = [`[${fgLabel}][${combA}]alphamerge=eof_action=repeat`, 'format=yuva444p'];
    } else {
      activeSteps.push('format=yuva444p');
      chainParts.push(`${activeSteps.join(',')}[${fgLabel}]`, `${maskInLabel}format=gray[${mLabel}]`);
      activeSteps = [`[${fgLabel}][${mLabel}]alphamerge=eof_action=repeat`, 'format=yuva444p'];
    }
  };

  for (let bi = 0; bi < blurs.length; bi++) {
    const b = blurs[bi];
    if (b.kind === 'pixelate') {
      const bs = Math.max(1, Math.round(b.blockSize));
      if (bs > 1) {
        const dw = Math.max(1, Math.round(frameW / bs));
        const dh = Math.max(1, Math.round(frameH / bs));
        activeSteps.push(preserveAlpha ? 'format=yuva444p' : 'format=yuv444p', `scale=${dw}:${dh}:flags=neighbor`, `scale=${frameW}:${frameH}:flags=neighbor`, preserveAlpha ? 'format=yuva444p' : 'format=yuv420p');
      }
      continue;
    }
    if (b.kind === 'lut3d') {
      const intensity = clamp(Number(b.intensity ?? 1), 0, 1);
      if (intensity <= 0) continue;
      const cubePath = b.cubePath ?? options.resolveLutPath?.(b.cubeRelPath);
      if (!cubePath) continue;
      const escaped = escapeFfmpegFilterPath(cubePath);
      if (intensity >= 0.9999) {
        applyRgbWithPreservedAlpha([`lut3d=file='${escaped}':interp=tetrahedral`], `l${bi}`);
      } else {
        const lBase = `ovlutb_${labelKey}_${bi}`;
        const lWet = `ovlutw_${labelKey}_${bi}`;
        const lGraded = `ovlutg_${labelKey}_${bi}`;
        const dryW = (1 - intensity).toFixed(6);
        const wetW = intensity.toFixed(6);
        applyRgbWithPreservedAlpha([
          `split=2[${lBase}][${lWet}]`,
          `[${lWet}]lut3d=file='${escaped}':interp=tetrahedral[${lGraded}]`,
          `[${lBase}][${lGraded}]blend=all_expr='A*${dryW}+B*${wetW}'`,
        ], `l${bi}`);
      }
      continue;
    }
    if (b.kind === 'shape-mask') {
      const halfW = b.shape === 'circle'
        ? Math.max(0.5, b.radius * Math.min(frameW, frameH) * 0.5)
        : Math.max(0.5, (b.widthRatio * frameW) / 2);
      const halfH = b.shape === 'circle' ? halfW : Math.max(0.5, (b.heightRatio * frameH) / 2);
      applyMaskToAlpha({
        shape: b.shape === 'circle' ? 'ellipse' : 'rectangle',
        rw: frameW,
        rh: frameH,
        localCx: b.centerX * frameW,
        localCy: b.centerY * frameH,
        halfW,
        halfH,
        feather: b.feather,
        opacity: 1,
        cornerRadius: b.cornerRadius ?? 0,
        invert: Boolean(b.invert),
        centeredFeather: true,
      }, `sm${bi}`);
      continue;
    }
    const bCx = b.centerX * frameW;
    const bCy = b.centerY * frameH;
    const halfW = (b.widthRatio * frameW) / 2;
    const halfH = (b.heightRatio * frameH) / 2;
    const x0 = Math.max(0, Math.floor(bCx - halfW));
    const y0 = Math.max(0, Math.floor(bCy - halfH));
    const x1 = Math.min(frameW, Math.ceil(bCx + halfW));
    const y1 = Math.min(frameH, Math.ceil(bCy + halfH));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw < 2 || rh < 2) continue;
    const fmtWork = preserveAlpha ? 'yuva444p' : 'yuv444p';
    const bLabel = `ovgbb_${labelKey}_${bi}`;
    const sLabel = `ovgbs_${labelKey}_${bi}`;
    const rLabel = `ovgbr_${labelKey}_${bi}`;
    if (b.kind === 'local-mosaic') {
      const bs = Math.max(1, Math.round(b.blockSize));
      if (bs <= 1) continue;
      const dw = Math.max(1, Math.round(rw / bs));
      const dh = Math.max(1, Math.round(rh / bs));
      if (b.feather === 0 && x0 === 0 && y0 === 0 && x1 === frameW && y1 === frameH) {
        activeSteps.push(`format=${fmtWork}`, `scale=${dw}:${dh}:flags=neighbor`, `scale=${frameW}:${frameH}:flags=neighbor`, preserveAlpha ? 'format=yuva444p' : 'format=yuv420p');
        continue;
      }
      activeSteps.push(`split=2[${bLabel}][${sLabel}]`);
      chainParts.push(activeSteps.join(','));
      chainParts.push(
        `[${sLabel}]format=${fmtWork},crop=${rw}:${rh}:${x0}:${y0},scale=${dw}:${dh}:flags=neighbor,scale=${rw}:${rh}:flags=neighbor${b.feather > 0 ? ',format=yuva444p' : ''}[${rLabel}]`,
      );
    } else {
      if (b.feather === 0 && x0 === 0 && y0 === 0 && x1 === frameW && y1 === frameH) {
        activeSteps.push(`gblur=sigma=${b.sigma}:steps=2`);
        continue;
      }
      const pad = Math.ceil(b.sigma * 3);
      const px0 = Math.max(0, x0 - pad);
      const py0 = Math.max(0, y0 - pad);
      const px1 = Math.min(frameW, x1 + pad);
      const py1 = Math.min(frameH, y1 + pad);
      const pw = px1 - px0;
      const ph = py1 - py0;
      const ix = x0 - px0;
      const iy = y0 - py0;
      activeSteps.push(`split=2[${bLabel}][${sLabel}]`);
      chainParts.push(activeSteps.join(','));
      chainParts.push(
        `[${sLabel}]format=${fmtWork},crop=${pw}:${ph}:${px0}:${py0},gblur=sigma=${b.sigma}:steps=2,crop=${rw}:${rh}:${ix}:${iy}${b.feather > 0 ? ',format=yuva444p' : ''}[${rLabel}]`,
      );
    }
    if (b.feather > 0) {
      const maskLabel = options.registerBlurMask
        ? options.registerBlurMask({ shape: 'rectangle', rw, rh, localCx: bCx - x0, localCy: bCy - y0, halfW, halfH, feather: b.feather, opacity: 1 })
        : `[ovgbm_in_${labelKey}_${bi}]`;
      const mLabel = `ovgbm_${labelKey}_${bi}`;
      const aLabel = `ovgba_${labelKey}_${bi}`;
      chainParts.push(`${maskLabel}format=gray[${mLabel}]`, `[${rLabel}][${mLabel}]alphamerge=eof_action=repeat[${aLabel}]`);
      activeSteps = [`[${bLabel}][${aLabel}]overlay=${x0}:${y0}:format=${preserveAlpha ? 'yuv444' : 'yuv420'}`];
    } else {
      activeSteps = [`[${bLabel}][${rLabel}]overlay=${x0}:${y0}:format=${preserveAlpha ? 'yuv444' : 'yuv420'}`];
    }
  }

  if (resolvedRadius > 0) {
    applyMaskToAlpha({
      shape: 'rectangle',
      rw: frameW,
      rh: frameH,
      localCx: frameW / 2,
      localCy: frameH / 2,
      halfW: frameW / 2,
      halfH: frameH / 2,
      feather: 1,
      cornerRadius: resolvedRadius,
      opacity: 1,
      centeredFeather: true,
    }, 'br');
  }
  if (needsTransparentPad) {
    activeSteps.push('format=yuva444p', `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
  }
  if (ov.clipMask) {
    applyMaskToAlpha({
      shape: ov.clipMask.shape,
      rw: ov.clipMask.rw,
      rh: ov.clipMask.rh,
      localCx: ov.clipMask.localCx,
      localCy: ov.clipMask.localCy,
      halfW: ov.clipMask.halfW,
      halfH: ov.clipMask.halfH,
      feather: ov.clipMask.feather,
      opacity: 1,
    }, 'cm');
  }
  if (crop) {
    if (cw <= 0 || ch <= 0) {
      activeSteps.push('format=yuva444p', `lut=a='0'`);
    } else if (hasRotation) {
      activeSteps.push('format=yuva444p', `crop=${cw}:${ch}:${cx}:${cy}`, `pad=${width}:${height}:${cx}:${cy}:color=0x00000000`);
    } else {
      activeSteps.push(`crop=${cw}:${ch}:${cx}:${cy}`);
    }
  }

  if (f) {
    const rgbSteps = [];
    appendRgbFilterSteps(rgbSteps, f, 1, 1);
    if (rgbSteps.length > 0) applyRgbWithPreservedAlpha(rgbSteps, 'flt');
    if (f.blur > 0) activeSteps.push(`gblur=sigma=${f.blur}`);
  }

  let overlayX = visX0;
  let overlayY = visY0;
  let overlayXExpr = null;
  let overlayYExpr = null;
  if (hasRotation) {
    const scaledCanvasW = Math.max(2, Math.round(width * sx));
    const scaledCanvasH = Math.max(2, Math.round(height * sy));
    if (scaledCanvasW !== width || scaledCanvasH !== height) {
      activeSteps.push(`scale=${scaledCanvasW}:${scaledCanvasH}:flags=bilinear`);
    }
    const rad = (rotDeg * Math.PI) / 180;
    activeSteps.push('format=yuva444p', `rotate=${rad.toFixed(8)}:ow=rotw(${rad.toFixed(8)}):oh=roth(${rad.toFixed(8)}):c=none`);
    const shiftX = Math.round((x / 100) * width);
    const shiftY = Math.round((y / 100) * height);
    if (bgOutLabel) {
      const fgRotLabel = `ovfgrot_${labelKey}`;
      chainParts.push(`${activeSteps.join(',')}[${fgRotLabel}]`);
      activeSteps = [`[${bgOutLabel}][${fgRotLabel}]overlay=x=(W-w)/2+(${shiftX}):y=(H-h)/2+(${shiftY}):shortest=1:format=yuv444`, 'format=yuva444p'];
      overlayX = 0;
      overlayY = 0;
    } else {
      overlayXExpr = `(W-w)/2+(${shiftX})`;
      overlayYExpr = `(H-h)/2+(${shiftY})`;
    }
  } else {
    if (scaledW !== cw || scaledH !== ch) activeSteps.push(`scale=${scaledW}:${scaledH}:flags=bilinear`);
    const srcCropX = visX0 - dx;
    const srcCropY = visY0 - dy;
    if (visW !== scaledW || visH !== scaledH) {
      if (!preserveAlpha && [visW, visH, srcCropX, srcCropY].some((v) => v % 2 !== 0)) {
        activeSteps.push('scale=flags=accurate_rnd+full_chroma_int', 'format=yuv444p');
      }
      activeSteps.push(`crop=${visW}:${visH}:${srcCropX}:${srcCropY}`);
    }
    if (bgOutLabel) {
      if (visW <= 0 || visH <= 0) {
        chainParts.push(`${activeSteps.join(',')},nullsink`);
        activeSteps = [`[${bgOutLabel}]setsar=1`];
      } else {
        const fgCovLabel = `ovfgcov_${labelKey}`;
        chainParts.push(`${activeSteps.join(',')}[${fgCovLabel}]`);
        activeSteps = [`[${bgOutLabel}][${fgCovLabel}]overlay=${visX0}:${visY0}:shortest=1:format=yuv444`, 'format=yuva444p'];
      }
      overlayX = 0;
      overlayY = 0;
    }
  }

  if (opacity < 1) {
    activeSteps.push('format=yuva444p', `lut=a='clip(val*${opacity},0,255)'`);
  }
  if (hasIn || hasOut) {
    const decodeLoc0 = loc0 - fadePre;
    activeSteps.push('format=yuva444p');
    if (hasIn) {
      const s = Math.max(0, Math.round(vf.fadeIn.from - decodeLoc0));
      const n = Math.max(1, Math.round(vf.fadeIn.until - vf.fadeIn.from));
      activeSteps.push(`fade=t=in:s=${s}:n=${n}:alpha=1`);
    }
    if (hasOut) {
      const s = Math.max(0, Math.round(vf.fadeOut.from - decodeLoc0));
      const n = Math.max(1, Math.round(vf.fadeOut.until - vf.fadeOut.from));
      activeSteps.push(`fade=t=out:s=${s}:n=${n}:alpha=1`);
    }
    if (fadePre > 0) activeSteps.push(`trim=start_frame=${fadePre}:end_frame=${fadePre + ovFrames}`, 'setpts=PTS-STARTPTS');
  }
  activeSteps.push('setsar=1', `settb=1/${fps}`, `setpts=N+${localStart}`);
  const outLabel = `[ovv_${labelKey}]`;
  const tailFilter = `${activeSteps.join(',')}${outLabel}`;
  const fullFilter = chainParts.length ? `${chainParts.join(';')};${tailFilter}` : tailFilter;
  return {
    usesInput: true,
    seekSec,
    decoderArgs,
    filter: fullFilter,
    outLabel,
    overlayX,
    overlayY,
    overlayXExpr,
    overlayYExpr,
    localStart,
    localEnd,
  };
}

function sliceBaseSegments(segments, chunkFrom, chunkTo) {
  const out = [];
  for (const seg of segments) {
    const segEnd = seg.timelineFrame + seg.frames;
    const a = Math.max(chunkFrom, seg.timelineFrame);
    const b = Math.min(chunkTo, segEnd);
    if (b <= a) continue;
    if (seg.kind === 'black') {
      out.push({ kind: 'black', timelineFrame: a, frames: b - a });
    } else if (seg.kind === 'transition') {
      if (a !== seg.timelineFrame || b !== segEnd) {
        throw new Error(`Transition segment [${seg.timelineFrame}, ${segEnd}) split across chunk [${chunkFrom}, ${chunkTo})`);
      }
      out.push(seg);
    } else {
      const rate = seg.playbackRate ?? 1;
      out.push({
        ...seg,
        timelineFrame: a,
        frames: b - a,
        sourceFrame: seg.sourceFrame + (a - seg.timelineFrame) * rate,
        clipLocalStart: (seg.clipLocalStart ?? 0) + (a - seg.timelineFrame),
      });
    }
  }
  return out;
}

function sliceOverlaySpans(spans, chunkFrom, chunkTo) {
  const out = [];
  for (const span of spans) {
    const a = Math.max(chunkFrom, span.from);
    const b = Math.min(chunkTo, span.to);
    if (b > a) out.push({ from: a, to: b, sampleFrame: span.sampleFrame });
  }
  return out;
}

export async function encodeChunk({
  chunk, chunkIdx, plan, sources, plateFiles, underlayPlateFiles, blankPngPath, temporary, blurMaskCache, ffmpegExecutable,
  h264Profile, videoBitrate, vaapiDevice, renderArgsOverride, onChunkFrame, checkResources, signal, run = directCutCommand,
  verifyChunkFrames,
}) {
  const { fps, width, height, outputWidth, outputHeight } = plan;
  const chunkFrames = chunk.to - chunk.from;
  const chunkSegs = sliceBaseSegments(plan.baseSegments, chunk.from, chunk.to);
  const chunkSpans = sliceOverlaySpans(chunk.spans, chunk.from, chunk.to);
  const chunkUnderlaySpans = sliceOverlaySpans(chunk.underlaySpans ?? [], chunk.from, chunk.to);
  const hasAnyOverlay = chunkSpans.some((s) => s.sampleFrame !== null);
  const hasAnyUnderlay = chunkUnderlaySpans.some((s) => s.sampleFrame !== null);

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const filters = [];
  let inputIdx = 0;
  const concatInputs = [];
  const maskDir = path.join(temporary, 'blur-masks');
  const ensureBlurMaskFile = (spec) => {
    const cache = blurMaskCache ?? (encodeChunk._fallbackMaskCache ??= new Map());
    const shape = spec.shape ?? 'rectangle';
    const op = spec.opacity ?? 1;
    const cornerRadius = spec.cornerRadius ?? 0;
    const inv = spec.invert ? 1 : 0;
    const centered = spec.centeredFeather ? 1 : 0;
    const key = `${shape}_${spec.rw}x${spec.rh}_${spec.localCx.toFixed(3)}_${spec.localCy.toFixed(3)}_${spec.halfW.toFixed(3)}_${spec.halfH.toFixed(3)}_${spec.feather.toFixed(3)}_${op.toFixed(3)}_${cornerRadius.toFixed(2)}_${inv}_${centered}`;
    const cached = cache.get(key);
    if (cached) return cached;
    // Reserve filename synchronously before any await so parallel chunk workers never overwrite mask-N.png.
    const filePath = path.join(maskDir, `mask-${cache.size}.png`);
    const task = (async () => {
      await mkdir(maskDir, { recursive: true });
      await writeFile(filePath, createFeatheredShapeMaskPng(spec));
      return filePath;
    })();
    cache.set(key, task);
    return task;
  };

  const attachVideoSegment = async (videoSeg, labelKey) => {
    const pendingMasks = [];
    const chain = buildClipFilterChain(videoSeg, labelKey, fps, width, height, {
      registerBlurMask: (spec) => {
        const token = `__CC_BLUR_MASK_${labelKey}_${pendingMasks.length}__`;
        pendingMasks.push({ token, spec });
        return token;
      },
      resolveLutPath: (relPath) => defaultResolveLutPath(relPath, plan.assetsDirectory),
    });
    if (chain.usesInput) {
      const file = sources.get(videoSeg.src).file;
      const videoInputIdx = inputIdx++;
      args.push('-ss', chain.seekSec.toFixed(6), ...(chain.decoderArgs ?? []), '-i', file);
      let resolvedFilter = chain.filter;
      for (const maskEntry of pendingMasks) {
        const maskPath = await ensureBlurMaskFile(maskEntry.spec);
        const maskIdx = inputIdx++;
        args.push('-i', maskPath);
        resolvedFilter = resolvedFilter.replace(maskEntry.token, `[${maskIdx}:v]`);
      }
      filters.push(`[${videoInputIdx}:v]${resolvedFilter}`);
    } else {
      filters.push(chain.filter);
    }
    return chain.outLabel;
  };

  for (let i = 0; i < chunkSegs.length; i++) {
    const seg = chunkSegs[i];
    if (seg.kind === 'transition') {
      const outLabelA = await attachVideoSegment(seg.outgoingSeg, `${i}a`);
      const outLabelB = await attachVideoSegment(seg.incomingSeg, `${i}b`);
      const denom = Math.max(1, seg.frames - 1);
      const expr = seg.transitionType === 'dip-to-black'
        ? `st(0,clip(((N-1)/${denom})/0.4,0,1));st(1,clip((((N-1)/${denom})-0.6)/0.4,0,1));A*(1-ld(0)*ld(0)*(3-2*ld(0)))+B*(ld(1)*ld(1)*(3-2*ld(1)))`
        : `st(0,clip((N-1)/${denom},0,1));st(1,ld(0)*ld(0)*(3-2*ld(0)));A*(1-ld(1))+B*ld(1)`;
      filters.push(
        `${outLabelA}scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24[ta${i}]`,
        `${outLabelB}scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24[tb${i}]`,
        `[ta${i}][tb${i}]blend=all_expr='${expr}',scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setsar=1[bv${i}]`,
      );
      concatInputs.push(`[bv${i}]`);
    } else {
      concatInputs.push(await attachVideoSegment(seg, i));
    }
  }

  let baseOutLabel = concatInputs[0];
  if (concatInputs.length > 1) {
    filters.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[basev]`);
    baseOutLabel = '[basev]';
  }

  if (hasAnyUnderlay && underlayPlateFiles) {
    const ffconcatLines = ['ffconcat version 1.0'];
    const frameToMicroseconds = (frame) => Math.round((frame - chunk.from) * 1e6 / fps);
    let lastPath = blankPngPath;
    for (const span of chunkUnderlaySpans) {
      const pngPath = span.sampleFrame === null ? blankPngPath : underlayPlateFiles.get(span.sampleFrame);
      if (!pngPath || !existsSync(pngPath)) {
        throw new Error(`Missing underlay plate for frame ${span.sampleFrame}`);
      }
      const escaped = pngPath.replace(/\\/g, '/').replace(/'/g, "'\\''");
      const duration = (frameToMicroseconds(span.to) - frameToMicroseconds(span.from)) / 1e6;
      ffconcatLines.push(`file '${escaped}'`, `option framerate ${fps}`, `duration ${duration.toFixed(6)}`);
      lastPath = escaped;
    }
    ffconcatLines.push(`file '${lastPath}'`, `option framerate ${fps}`);
    const concatPath = path.join(temporary, `underlay-${chunkIdx}.ffconcat`);
    await writeFile(concatPath, ffconcatLines.join('\n') + '\n', 'utf8');
    args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
    const ulIdx = inputIdx++;
    filters.push(
      `[${ulIdx}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,fps=${fps},trim=end_frame=${chunkFrames},setpts=PTS-STARTPTS[ul]`,
      `${baseOutLabel}[ul]overlay=0:0:eof_action=repeat:format=yuv420[ulout]`,
    );
    baseOutLabel = '[ulout]';
  }

  const chunkMosaics = (plan.mosaics ?? []).filter((m) => m.endFrame > chunk.from && m.startFrame < chunk.to);
  const chunkOverlayVideos = (plan.overlayVideos ?? []).filter((ov) => ov.endFrame > chunk.from && ov.startFrame < chunk.to);
  const trackOrderOf = (trackId) => {
    const idx = plan.visualTrackIds?.indexOf(trackId) ?? -1;
    return idx >= 0 ? idx : -1;
  };
  const upperLayers = [
    ...chunkMosaics.map((m) => ({ kind: 'mosaic', track: m.track, startFrame: m.startFrame, data: m })),
    ...chunkOverlayVideos.map((ov) => ({ kind: 'overlay-video', track: ov.track, startFrame: ov.startFrame, data: ov })),
  ].sort((a, b) => (
    trackOrderOf(b.track) - trackOrderOf(a.track)
    || (a.kind === b.kind ? 0 : a.kind === 'mosaic' ? -1 : 1)
    || a.startFrame - b.startFrame
  ));

  if (upperLayers.length > 0) {
    filters.push(`${baseOutLabel}settb=1/${fps},setpts=N[base_tb]`);
    baseOutLabel = '[base_tb]';
  }

  for (let ui = 0; ui < upperLayers.length; ui++) {
    const layer = upperLayers[ui];
    if (layer.kind === 'mosaic') {
      const m = layer.data;
      if ((m.opacity ?? 1) <= 0 || m.w < 2 || m.h < 2) continue;
      const localStart = Math.max(0, m.startFrame - chunk.from);
      const localEnd = Math.min(chunkFrames - 1, m.endFrame - 1 - chunk.from);
      if (localEnd < localStart) continue;
      const fiFrames = Math.max(0, Number(m.fadeInFrames ?? 0));
      const foFrames = Math.max(0, Number(m.fadeOutFrames ?? 0));
      const maFades = [];
      if (fiFrames > 0) {
        const fiStart = m.startFrame - chunk.from;
        if (fiStart >= 0 && fiStart < chunkFrames) {
          maFades.push(`fade=t=in:s=${fiStart}:n=${fiFrames}:alpha=1`);
        }
      }
      if (foFrames > 0) {
        const foStart = m.endFrame - foFrames - chunk.from;
        if (foStart >= 0 && foStart < chunkFrames) {
          maFades.push(`fade=t=out:s=${foStart}:n=${foFrames}:alpha=1`);
        }
      }
      const needsMask = m.shape === 'ellipse' || (m.feather ?? 0) > 0 || (m.opacity ?? 1) < 1 || maFades.length > 0;
      const pad = Math.ceil(m.sigma * 2);
      const px0 = Math.max(0, m.x0 - pad);
      const py0 = Math.max(0, m.y0 - pad);
      const px1 = Math.min(width, m.x0 + m.w + pad);
      const py1 = Math.min(height, m.y0 + m.h + pad);
      const pw = px1 - px0;
      const ph = py1 - py0;
      const ix = m.x0 - px0;
      const iy = m.y0 - py0;
      const blurStep = `gblur=sigma=${m.sigma}:enable='between(n,${localStart},${localEnd})'`;
      if (needsMask) {
        const maskPath = await ensureBlurMaskFile({
          shape: m.shape ?? 'rectangle',
          rw: m.w,
          rh: m.h,
          localCx: m.localCx,
          localCy: m.localCy,
          halfW: m.halfW,
          halfH: m.halfH,
          feather: m.feather ?? 0,
          opacity: m.opacity ?? 1,
        });
        const maskIdx = inputIdx++;
        args.push('-i', maskPath);
        const fadeSuffix = maFades.length > 0 ? `,${maFades.join(',')}` : '';
        filters.push(
          `${baseOutLabel}split=2[mb${ui}][mr${ui}]`,
          `[mr${ui}]format=yuv444p,crop=${pw}:${ph}:${px0}:${py0},${blurStep},crop=${m.w}:${m.h}:${ix}:${iy},format=yuva444p[mblur${ui}]`,
          `[${maskIdx}:v]format=gray[mmask${ui}]`,
          `[mblur${ui}][mmask${ui}]alphamerge=eof_action=repeat${fadeSuffix}[ma${ui}]`,
          `[mb${ui}][ma${ui}]overlay=${m.x0}:${m.y0}:enable='between(n,${localStart},${localEnd})':format=yuv420[mbase${ui}]`,
        );
      } else {
        filters.push(
          `${baseOutLabel}split=2[mb${ui}][mr${ui}]`,
          `[mr${ui}]format=yuv444p,crop=${pw}:${ph}:${px0}:${py0},${blurStep},crop=${m.w}:${m.h}:${ix}:${iy}[mblur${ui}]`,
          `[mb${ui}][mblur${ui}]overlay=${m.x0}:${m.y0}:enable='between(n,${localStart},${localEnd})':format=yuv420[mbase${ui}]`,
        );
      }
      baseOutLabel = `[mbase${ui}]`;
      continue;
    }

    const ov = layer.data;
    const pendingMasks = [];
    const chain = buildOverlayVideoFilterChain(ov, `u${ui}`, fps, width, height, chunk.from, chunk.to, {
      registerBlurMask: (spec) => {
        const token = `__CC_OV_MASK_${ui}_${pendingMasks.length}__`;
        pendingMasks.push({ token, spec });
        return token;
      },
      resolveLutPath: (relPath) => defaultResolveLutPath(relPath, plan.assetsDirectory),
    });
    if (!chain.usesInput) continue;
    const file = sources.get(ov.src).file;
    const ovInputIdx = inputIdx++;
    args.push('-ss', chain.seekSec.toFixed(6), ...(chain.decoderArgs ?? []), '-i', file);
    let resolvedFilter = chain.filter;
    for (const maskEntry of pendingMasks) {
      const maskPath = await ensureBlurMaskFile(maskEntry.spec);
      const maskIdx = inputIdx++;
      args.push('-i', maskPath);
      resolvedFilter = resolvedFilter.replace(maskEntry.token, `[${maskIdx}:v]`);
    }
    filters.push(`[${ovInputIdx}:v]${resolvedFilter}`);
    const ovPosX = chain.overlayXExpr ?? chain.overlayX;
    const ovPosY = chain.overlayYExpr ?? chain.overlayY;
    // `overlay` framesync only increments `n` once the secondary stream's shifted PTS
    // (`setpts=N+localStart`) begins, so `between(n, localStart, localEnd)` drops the first
    // `localStart` frames — or the entire clip whenever `localStart >= duration`.
    // Evaluate against `t` on `[base_tb]`'s exact `1/fps` clock with a ±0.5-frame margin.
    const enableStart = `${chain.localStart - 0.5}/${fps}`;
    const enableEnd = `${chain.localEnd + 0.5}/${fps}`;
    filters.push(
      `${baseOutLabel}${chain.outLabel}overlay=x=${ovPosX}:y=${ovPosY}:enable='between(t,${enableStart},${enableEnd})':eof_action=pass:format=yuv420[ovc${ui}]`,
    );
    baseOutLabel = `[ovc${ui}]`;
  }

  if (hasAnyOverlay) {
    const ffconcatLines = ['ffconcat version 1.0'];
    const frameToMicroseconds = (frame) => Math.round((frame - chunk.from) * 1e6 / fps);
    let lastPath = blankPngPath;
    for (const span of chunkSpans) {
      const pngPath = span.sampleFrame === null ? blankPngPath : plateFiles.get(span.sampleFrame);
      if (!pngPath || !existsSync(pngPath)) {
        throw new Error(`Missing overlay plate for frame ${span.sampleFrame}`);
      }
      const escaped = pngPath.replace(/\\/g, '/').replace(/'/g, "'\\''");
      const duration = (frameToMicroseconds(span.to) - frameToMicroseconds(span.from)) / 1e6;
      ffconcatLines.push(`file '${escaped}'`, `option framerate ${fps}`, `duration ${duration.toFixed(6)}`);
      lastPath = escaped;
    }
    ffconcatLines.push(`file '${lastPath}'`, `option framerate ${fps}`);
    const concatPath = path.join(temporary, `overlay-${chunkIdx}.ffconcat`);
    await writeFile(concatPath, ffconcatLines.join('\n') + '\n', 'utf8');
    args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
    const ovIdx = inputIdx++;
    // Convert each sparse PNG decode once BEFORE `fps` duplicates frame references across static spans.
    filters.push(
      `[${ovIdx}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,fps=${fps},trim=end_frame=${chunkFrames},setpts=PTS-STARTPTS[ov]`,
      `${baseOutLabel}[ov]overlay=0:0:eof_action=repeat:format=yuv420[vout]`,
    );
    baseOutLabel = '[vout]';
  }

  // Compose at the timeline's geometry to preserve overlay and mask coordinates.
  if (outputWidth !== width || outputHeight !== height) {
    filters.push(`${baseOutLabel}scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1[scaledv]`);
    baseOutLabel = '[scaledv]';
  }
  const outFile = path.join(temporary, `chunk-${chunkIdx}.mp4`);
  const effectiveBitrate = videoBitrate ?? resolveH264VideoBitrate({ width: outputWidth, height: outputHeight, fps });
  const chunkFilterArgs = await filterComplexArgs(
    filters.join(';'),
    path.join(temporary, `filter-chunk-${chunkIdx}.txt`),
  );
  const rawArgs = [
    ...args,
    ...chunkFilterArgs,
    '-map', baseOutLabel,
    '-an',
    '-r', String(fps),
    '-frames:v', String(chunkFrames),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
    ...(effectiveBitrate ? ['-b:v', String(effectiveBitrate)] : ['-crf', '18', '-preset', 'medium']),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-y', outFile,
  ];
  const finalArgs = renderArgsOverride ? renderArgsOverride({ args: rawArgs }) : rawArgs;
  await run(ffmpegExecutable, finalArgs, {
    signal,
    timeoutMs: Math.max(CHUNK_TIMEOUT_MS, Math.ceil((chunkFrames / fps) * 20_000)),
    collect: false,
    onFrame: (f) => onChunkFrame(chunkIdx, Math.min(chunkFrames, Math.max(0, Number(f)))),
    checkResources,
  });
  if (verifyChunkFrames) {
    const actualFrames = await verifyChunkFrames(outFile);
    if (Number.isInteger(actualFrames) && actualFrames !== chunkFrames) {
      throw new Error(`Overlay-hybrid chunk ${chunkIdx} [${chunk.from}, ${chunk.to}) produced ${actualFrames} frames, expected ${chunkFrames}`);
    }
  }
  return outFile;
}

/** Pack audio segments into minimal non-overlapping lanes so many sequential clips collapse into 1-2 WAV passes. */
function packAudioLanes(audioSegments) {
  const sorted = [...audioSegments].sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
  const lanes = [];
  for (const seg of sorted) {
    const lane = lanes.find((l) => l.endFrame <= seg.timelineStartFrame);
    if (lane) {
      lane.segments.push(seg);
      lane.endFrame = seg.timelineStartFrame + seg.frames;
    } else {
      lanes.push({ segments: [seg], endFrame: seg.timelineStartFrame + seg.frames });
    }
  }
  return lanes.map((l) => l.segments);
}

export async function renderAudioTrack({ plan, sources, temporary, ffmpegExecutable, checkResources, signal, run = directCutCommand }) {
  if (!plan.audioSegments.length) return null;
  const { fps, rangeStart, rangeEnd, frames } = plan;
  const sampleRate = 48000;
  const totalSamples = Math.round((frames / fps) * sampleRate);
  const lanes = packAudioLanes(plan.audioSegments);
  const laneWavs = [];

  const renderAudioBatch = async (segs, batchStartSample, batchEndSample, wavPath, filterScriptBase) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const filters = [];
    const concatLabels = [];
    let cursorSample = batchStartSample;
    let inputIdx = 0;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const segWindow = Number.isInteger(seg.timelineStartSample) && Number.isInteger(seg.timelineEndSample)
        ? {
            startSample: seg.timelineStartSample,
            endSample: seg.timelineEndSample,
            durationSamples: Math.max(0, seg.timelineEndSample - seg.timelineStartSample),
          }
        : computeAudioSampleWindow(seg.timelineStartFrame, seg.timelineStartFrame + seg.frames, rangeStart, fps, sampleRate);
      if (segWindow.startSample > cursorSample) {
        const gapSamples = segWindow.startSample - cursorSample;
        filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${gapSamples},asetpts=PTS-STARTPTS[agap${i}]`);
        concatLabels.push(`[agap${i}]`);
        cursorSample += gapSamples;
      }
      const file = sources.get(seg.src).file;
      const rate = seg.playbackRate ?? 1;
      const startSec = seg.sourceFrame / fps;
      const durSec = (seg.frames * rate) / fps;
      args.push('-ss', startSec.toFixed(6), '-t', (durSec + 0.1).toFixed(6), '-i', file);
      const targetSamples = Math.max(1, segWindow.durationSamples || Math.round((seg.frames / fps) * sampleRate));
      const chain = [
        `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`,
        ...buildAtempoChain(rate),
        `atrim=end_sample=${targetSamples}`,
        'asetpts=PTS-STARTPTS',
      ];

      // Linear fadeIn / fadeOut inside this segment accounting for slice offset within original clip.
      if (seg.fadeInFrames > 0 && seg.offsetInItem < seg.fadeInFrames) {
        const startRatio = clamp(seg.offsetInItem / seg.fadeInFrames, 0, 1);
        const remFadeSamples = Math.max(1, Math.round(((seg.fadeInFrames - seg.offsetInItem) / fps) * sampleRate));
        if (startRatio === 0) {
          chain.push(`afade=t=in:ss=0:ns=${remFadeSamples}:curve=tri`);
        } else {
          const endFactor = clamp((seg.offsetInItem + seg.frames) / seg.fadeInFrames, 0, 1);
          const fadeTotalSec = seg.fadeInFrames / fps;
          const offSec = seg.offsetInItem / fps;
          chain.push(`volume='min(1,(t+${offSec.toFixed(6)})/${fadeTotalSec.toFixed(6)})':eval=frame`);
          void endFactor;
        }
      }
      if (seg.fadeOutFrames > 0 && seg.offsetInItem + seg.frames > seg.itemDuration - seg.fadeOutFrames) {
        const fadeStartInItem = Math.max(0, seg.itemDuration - seg.fadeOutFrames);
        const startInSeg = Math.max(0, fadeStartInItem - seg.offsetInItem);
        const startSample = Math.round((startInSeg / fps) * sampleRate);
        const fadeDurationFrames = Math.min(seg.frames - startInSeg, seg.itemDuration - seg.offsetInItem - fadeStartInItem);
        const fadeSamples = Math.max(1, Math.round((seg.fadeOutFrames / fps) * sampleRate));
        if (seg.offsetInItem <= fadeStartInItem && seg.offsetInItem + seg.frames >= seg.itemDuration) {
          chain.push(`afade=t=out:ss=${startSample}:ns=${Math.max(1, fadeSamples)}:curve=tri`);
        } else {
          const endSec = (seg.itemDuration - seg.offsetInItem) / fps;
          const totalFadeSec = seg.fadeOutFrames / fps;
          chain.push(`volume='max(0,min(1,(${endSec.toFixed(6)}-t)/${totalFadeSec.toFixed(6)}))':eval=frame`);
          void fadeDurationFrames;
        }
      }
      if (seg.duckIntervals?.length && seg.duckFactor !== 1) {
        for (let di = 0; di < seg.duckIntervals.length; di += 12) {
          const slice = seg.duckIntervals.slice(di, di + 12);
          const cond = slice.map(([a, b]) => `between(t,${a.toFixed(6)},${b.toFixed(6)})`).join('+');
          chain.push(`volume='if(gt(${cond},0),${seg.duckFactor.toFixed(6)},1)':eval=frame`);
        }
      }
      if (seg.crossfades?.length) {
        for (const cf of seg.crossfades) {
          const sSec = (cf.startFrame / fps).toFixed(6);
          const dSec = (cf.durationFrames / fps).toFixed(6);
          const eSec = ((cf.startFrame + cf.durationFrames) / fps).toFixed(6);
          const expr = cf.direction === 'in'
            ? `if(between(t,${sSec},${eSec}),clip((t-(${sSec}))/${dSec},0,1),1)`
            : `if(between(t,${sSec},${eSec}),clip(1-(t-(${sSec}))/${dSec},0,1),1)`;
          chain.push(`volume='${expr}':eval=frame`);
        }
      }
      if (seg.volumeKeyframes?.length >= 2) {
        const kfs = seg.volumeKeyframes;
        const frameExpr = `(${seg.offsetInItem}+t*${fps})`;
        let kfExpr = kfs[kfs.length - 1].value.toFixed(6);
        for (let ki = kfs.length - 2; ki >= 0; ki--) {
          const a = kfs[ki];
          const b = kfs[ki + 1];
          const span = b.frame - a.frame;
          const segExpr = span <= 0 || a.value === b.value
            ? b.value.toFixed(6)
            : `(${a.value.toFixed(6)}+(${((b.value - a.value) / span).toFixed(8)})*(${frameExpr}-(${a.frame})))`;
          kfExpr = `if(lte(${frameExpr},${b.frame}),${segExpr},${kfExpr})`;
        }
        kfExpr = `if(lte(${frameExpr},${kfs[0].frame}),${kfs[0].value.toFixed(6)},${kfExpr})`;
        chain.push(`volume='clip(${kfExpr},0,2)':eval=frame`);
      }
      if (seg.gain !== 1) chain.push(`volume=${seg.gain.toFixed(6)}`);
      filters.push(`[${inputIdx}:a]${chain.join(',')}[aseg${i}]`);
      concatLabels.push(`[aseg${i}]`);
      inputIdx += 1;
      cursorSample += targetSamples;
    }

    if (cursorSample < batchEndSample) {
      const tailSamples = batchEndSample - cursorSample;
      if (tailSamples > 0) {
        filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${tailSamples},asetpts=PTS-STARTPTS[atail]`);
        concatLabels.push('[atail]');
      }
    }

    const batchSamples = Math.max(1, batchEndSample - batchStartSample);
    const combinedFilter = concatLabels.length === 1
      ? `${filters.join(';')};${concatLabels[0]}atrim=end_sample=${batchSamples}[aout]`
      : `${filters.join(';')};${concatLabels.join('')}concat=n=${concatLabels.length}:v=0:a=1,atrim=end_sample=${batchSamples}[aout]`;
    const filterArgs = await filterComplexArgs(combinedFilter, filterScriptBase);

    await run(ffmpegExecutable, [
      ...args,
      ...filterArgs,
      '-map', '[aout]',
      '-c:a', 'pcm_f32le',
      '-ar', String(sampleRate),
      '-ac', '2',
      '-y', wavPath,
    ], { signal, timeoutMs: 300_000, collect: false, checkResources });
  };

  for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
    const segs = lanes[laneIdx];
    const wavPath = path.join(temporary, `audio-lane-${laneIdx}.wav`);
    if (segs.length <= MAX_AUDIO_INPUTS_PER_BATCH) {
      await renderAudioBatch(segs, 0, totalSamples, wavPath, path.join(temporary, `filter-audio-lane-${laneIdx}.txt`));
      laneWavs.push(wavPath);
      continue;
    }

    const partWavs = [];
    let batchCursorSample = 0;
    for (let startIdx = 0, batchIdx = 0; startIdx < segs.length; startIdx += MAX_AUDIO_INPUTS_PER_BATCH, batchIdx += 1) {
      const batchSegs = segs.slice(startIdx, startIdx + MAX_AUDIO_INPUTS_PER_BATCH);
      const isLast = startIdx + MAX_AUDIO_INPUTS_PER_BATCH >= segs.length;
      const lastSeg = batchSegs[batchSegs.length - 1];
      const lastEndSample = Number.isInteger(lastSeg.timelineEndSample)
        ? lastSeg.timelineEndSample
        : computeAudioSampleWindow(lastSeg.timelineStartFrame, lastSeg.timelineStartFrame + lastSeg.frames, rangeStart, fps, sampleRate).endSample;
      const batchEndSample = isLast
        ? totalSamples
        : Math.min(totalSamples, Math.max(batchCursorSample + 1, lastEndSample));
      const partPath = path.join(temporary, `audio-lane-${laneIdx}-part-${batchIdx}.wav`);
      await renderAudioBatch(batchSegs, batchCursorSample, batchEndSample, partPath, path.join(temporary, `filter-audio-lane-${laneIdx}-part-${batchIdx}.txt`));
      partWavs.push(partPath);
      batchCursorSample = batchEndSample;
    }

    const concatListPath = path.join(temporary, `audio-lane-${laneIdx}.ffconcat`);
    const lines = [
      'ffconcat version 1.0',
      ...partWavs.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`),
    ];
    await writeFile(concatListPath, lines.join('\n') + '\n', 'utf8');
    await run(ffmpegExecutable, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c:a', 'copy',
      '-y', wavPath,
    ], { signal, timeoutMs: 300_000, collect: false, checkResources });
    void rangeEnd;
    laneWavs.push(wavPath);
  }

  if (laneWavs.length === 1) return laneWavs[0];
  const mixedWav = path.join(temporary, 'audio-mixed.wav');
  const mixArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  for (const wav of laneWavs) mixArgs.push('-i', wav);
  const mixFilter = `amix=inputs=${laneWavs.length}:normalize=0:dropout_transition=0,atrim=end_sample=${totalSamples}[amixout]`;
  const mixFilterArgs = await filterComplexArgs(mixFilter, path.join(temporary, 'filter-audio-mix.txt'));
  mixArgs.push(
    ...mixFilterArgs,
    '-map', '[amixout]',
    '-c:a', 'pcm_f32le',
    '-ar', String(sampleRate),
    '-ac', '2',
    '-y', mixedWav,
  );
  await run(ffmpegExecutable, mixArgs, { signal, timeoutMs: 300_000, collect: false, checkResources });
  return mixedWav;
}

const probeRate = (value) => {
  const [n, d] = String(value).split('/').map(Number);
  return d > 0 ? n / d : NaN;
};

async function probeVideoFrameCount(file, { ffprobeExecutable, signal, run = directCutCommand }) {
  if (!ffprobeExecutable) return null;
  try {
    const raw = await run(ffprobeExecutable, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'json', file,
    ], { signal, timeoutMs: 10_000 });
    const parsed = JSON.parse(raw);
    const nb = Number(parsed?.streams?.[0]?.nb_frames);
    return Number.isInteger(nb) && nb >= 0 ? nb : null;
  } catch {
    return null;
  }
}

function hybridVideoSourceSupported(metadata, plan, segments, { allowAlpha = false } = {}) {
  const streams = metadata?.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === 'video');
  const video = videos[0];
  const avgRate = probeRate(video?.avg_frame_rate);
  const realRate = probeRate(video?.r_frame_rate);
  const hasAlpha = streamHasAlpha(video);
  const pixFmtSupported = OPAQUE_HYBRID_PIX_FMTS.test(video?.pix_fmt ?? '') || (allowAlpha && hasAlpha);
  if (videos.length !== 1 || !SUPPORTED_HYBRID_VIDEO_CODECS.has(video?.codec_name)
    || !pixFmtSupported
    || !integer(video.width, 2) || !integer(video.height, 2)
    || !(avgRate > 0 && avgRate <= 240) || !(realRate > 0 && realRate <= 240)
    || !['1:1', '0:1', 'N/A', '', undefined].includes(video.sample_aspect_ratio)
    || !['progressive', 'unknown', undefined].includes(video.field_order)
    || Math.abs(Number(video.start_time ?? 0)) > 2.0
    || Math.abs(Number(metadata.format?.start_time ?? 0)) > 2.0) return false;
  const rawRot = video.tags?.rotate ?? video.side_data_list?.find((d) => Number.isFinite(Number(d.rotation)))?.rotation ?? 0;
  const normRot = ((Math.round(Number(rawRot) || 0) % 360) + 360) % 360;
  const swapped = normRot === 90 || normRot === 270;
  const dispW = swapped ? video.height : video.width;
  const dispH = swapped ? video.width : video.height;
  const isVfr = avgRate > 0 && realRate > 0 && Math.abs(avgRate - realRate) / Math.max(avgRate, realRate) > 0.02;
  const sourceFrames = Number(video.nb_frames);
  const streamDur = Number(video.duration);
  const formatDur = Number(metadata.format?.duration);
  const nbFramesDur = (!isVfr && integer(sourceFrames, 1) && avgRate > 0) ? (sourceFrames / avgRate) : NaN;
  const reliableStreamDur = Number.isFinite(streamDur) && streamDur > 0
    ? streamDur
    : (Number.isFinite(formatDur) && formatDur > 0 ? formatDur : NaN);
  const videoDurationSec = isVfr
    ? reliableStreamDur
    : (Number.isFinite(nbFramesDur) && nbFramesDur > 0
        ? (Number.isFinite(reliableStreamDur) ? Math.min(reliableStreamDur, nbFramesDur) : nbFramesDur)
        : reliableStreamDur);
  const segRequiredEndSec = (s) => (
    (s.sourceFrame ?? s.srcInFrame ?? 0) + (s.frames ?? (s.endFrame - s.startFrame)) * (s.playbackRate ?? 1)
  ) / plan.fps;
  const tolSec = Math.max(0.02, 0.75 / Math.max(plan.fps, avgRate || 30));
  if (!(Number.isFinite(videoDurationSec) && videoDurationSec > 0)
    || segments.some((s) => segRequiredEndSec(s) > videoDurationSec + tolSec)) {
    return false;
  }
  for (const segment of segments) Object.assign(segment, {
    sourceWidth: dispW,
    sourceHeight: dispH,
    sourceFps: avgRate,
    sourceIsVfr: isVfr,
    sourcePixFmt: video.pix_fmt,
    sourceColorRange: video.color_range,
    sourceCodec: video.codec_name,
    sourceHasAlpha: hasAlpha,
    fit: plan.fit,
  });
  return true;
}

/** Probe source files & decide eligibility for overlay-hybrid export (null if Remotion should handle). */
export async function inspectOverlayHybridExport(options, { run = directCutCommand, probe, onDecline } = {}) {
  const { signal, uploadsDirectory, assetsDirectory, ffmpegExecutable, ffprobeExecutable, allowCompatSpans = false } = options;
  signal?.throwIfAborted();
  const decline = (reason) => { onDecline?.(reason); return null; };
  if (process.env.CC_DIRECT_CUT_EXPORT === '0') return decline('disabled');
  const plan = planOverlayHybridExport({ ...options, allowCompatSpans });
  if (!plan.eligible) {
    console.info(`[render] overlay hybrid declined: ${plan.reason}`);
    return decline(plan.reason);
  }
  if (!ffmpegExecutable || !ffprobeExecutable) {
    console.info('[render] overlay hybrid declined: full-media-binaries');
    return decline('full-media-binaries');
  }

  const probeSourceSet = async () => {
    const sources = new Map();
    const extraCompat = [];
    const baseVideoLeafSegs = [];
    for (const s of plan.baseSegments) {
      if (s.kind === 'video') baseVideoLeafSegs.push(s);
      else if (s.kind === 'transition') baseVideoLeafSegs.push(s.outgoingSeg, s.incomingSeg);
    }
    const overlayVideoSegs = plan.overlayVideos ?? [];

    // Resolve .cube LUT paths before probing.
    for (const seg of [...baseVideoLeafSegs, ...overlayVideoSegs]) {
      for (const eff of seg.localGaussianBlurs ?? []) {
        if (eff.kind === 'lut3d') {
          const resolved = options.resolveLutPath?.(eff.cubeRelPath) ?? defaultResolveLutPath(eff.cubeRelPath, assetsDirectory);
          if (!resolved) {
            if (!allowCompatSpans) return { declineReason: 'video-clip-effects' };
            const from = seg.timelineFrame ?? seg.startFrame;
            const to = seg.endFrame ?? (seg.timelineFrame + seg.frames);
            extraCompat.push({ from, to, compatAudio: false, reason: 'video-clip-effects' });
          } else {
            eff.cubePath = resolved;
          }
        }
      }
    }

    const allSrcs = new Set([
      ...baseVideoLeafSegs.map((s) => s.src),
      ...overlayVideoSegs.map((s) => s.src),
      ...plan.audioSegments.map((s) => s.src),
    ]);

    for (const src of allSrcs) {
      const videoSegs = baseVideoLeafSegs.filter((s) => s.src === src);
      const ovSegs = overlayVideoSegs.filter((s) => s.src === src);
      const audioSegs = plan.audioSegments.filter((s) => s.src === src);
      const markBadSrc = (reason, audioBad) => {
        for (const s of videoSegs) extraCompat.push({ from: s.timelineFrame, to: s.timelineFrame + s.frames, compatAudio: audioBad, reason });
        for (const s of ovSegs) extraCompat.push({ from: s.startFrame, to: s.endFrame, compatAudio: audioBad, reason });
        if (audioBad) {
          for (const s of audioSegs) extraCompat.push({ from: s.timelineStartFrame, to: s.timelineStartFrame + s.frames, compatAudio: true, reason });
        }
      };

      const local = localVideoPath(src, uploadsDirectory, assetsDirectory);
      if (!local) {
        if (!allowCompatSpans) return { declineReason: 'nonlocal-source' };
        markBadSrc('nonlocal-source', audioSegs.length > 0);
        continue;
      }
      const file = options.resolveMediaSource?.(src) ?? local;
      let metadata;
      try {
        metadata = probe
          ? await probe(file)
          : JSON.parse(await run(ffprobeExecutable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 5000 }));
      } catch (error) {
        signal?.throwIfAborted();
        if (!allowCompatSpans) {
          console.warn(`[render] overlay hybrid source probe failed; retaining compositor: ${error.message}`);
          return { declineReason: 'probe-failed' };
        }
        markBadSrc('probe-failed', audioSegs.length > 0);
        continue;
      }
      signal?.throwIfAborted();

      const audioStream = metadata.streams?.find((s) => s.codec_type === 'audio');
      const videoOnlyAudioSegs = audioSegs.length > 0 && audioSegs.every((s) => s.fromVideo);
      if (!audioStream && videoOnlyAudioSegs) {
        plan.audioSegments = plan.audioSegments.filter((s) => s.src !== src);
      }
      const remainingAudioSegs = plan.audioSegments.filter((s) => s.src === src);
      const audioOk = !remainingAudioSegs.length || (
        audioStream
        && Number(audioStream.channels) >= 1
        && Number(audioStream.channels) <= 8
        && Math.abs(Number(audioStream.start_time ?? 0)) <= 2.0
        && Math.abs(Number(metadata.format?.start_time ?? 0)) <= 2.0
        && Number(audioStream.sample_rate) > 0
        && remainingAudioSegs.every((s) => Number(audioStream.duration) >= (s.sourceFrame + s.frames * (s.playbackRate ?? 1)) / plan.fps - 0.1)
      );
      const allVideoChecks = [...videoSegs, ...ovSegs];
      const videoOk = !allVideoChecks.length || hybridVideoSourceSupported(metadata, plan, allVideoChecks, { allowAlpha: true });
      if (!videoOk || !audioOk) {
        if (!allowCompatSpans) return { declineReason: 'source-metadata' };
        markBadSrc('source-metadata', !audioOk);
        continue;
      }
      const vStream = metadata.streams?.find((s) => s.codec_type === 'video');
      const firstSeg = allVideoChecks[0];
      sources.set(src, {
        file,
        hasAudio: Boolean(audioStream),
        hasAlpha: Boolean(firstSeg?.sourceHasAlpha ?? streamHasAlpha(vStream)),
        codec: firstSeg?.sourceCodec ?? vStream?.codec_name,
        width: firstSeg?.sourceWidth ?? vStream?.width,
        height: firstSeg?.sourceHeight ?? vStream?.height,
      });
    }
    return { sources, extraCompat };
  };

  const firstPass = await probeSourceSet();
  if (firstPass.declineReason) {
    console.info(`[render] overlay hybrid declined: ${firstPass.declineReason}`);
    return decline(firstPass.declineReason);
  }
  if (firstPass.extraCompat.length > 0 && plan._rebuildForExtraCompat) {
    const rebuilt = plan._rebuildForExtraCompat(firstPass.extraCompat);
    if (!rebuilt.eligible) {
      console.info(`[render] overlay hybrid declined: ${rebuilt.reason}`);
      return decline(rebuilt.reason);
    }
    plan.compatSpans = rebuilt.compatSpans;
    plan.fastSpans = rebuilt.fastSpans;
    plan.compatFrames = rebuilt.compatFrames;
    plan.compatReasons = rebuilt.compatReasons;
    plan.baseSegments = rebuilt.baseSegments;
    plan.overlayVideos = rebuilt.overlayVideos ?? [];
    plan.mosaics = rebuilt.mosaics ?? [];
    plan.hybridMode = plan.compatSpans.length > 0 ? 'segmented-hybrid' : 'overlay-plates';
    const secondPass = await probeSourceSet();
    if (secondPass.declineReason) {
      console.info(`[render] overlay hybrid declined: ${secondPass.declineReason}`);
      return decline(secondPass.declineReason);
    }
    return { plan, sources: secondPass.sources };
  }
  return { plan, sources: firstPass.sources };
}

export function splitOutputChunks(totalStart, totalEnd, workerCount, baseSegments = [], mosaics = []) {
  const total = totalEnd - totalStart;
  const minChunkFrames = 150;
  const count = Math.max(1, Math.min(workerCount, Math.floor(total / minChunkFrames) || 1));
  const avoidRanges = [];
  for (const seg of baseSegments) {
    if (seg.kind === 'transition') {
      avoidRanges.push([seg.timelineFrame, seg.timelineFrame + seg.frames]);
      continue;
    }
    if (!seg.visualFade) continue;
    const base = seg.timelineFrame - (seg.clipLocalStart ?? 0);
    for (const w of [seg.visualFade.fadeIn, seg.visualFade.fadeOut]) {
      if (w) avoidRanges.push([base + Math.floor(w.from), base + Math.ceil(w.until)]);
    }
  }
  for (const m of mosaics) {
    if ((m.fadeInFrames ?? 0) > 0) {
      avoidRanges.push([m.startFrame, Math.min(m.endFrame, m.startFrame + m.fadeInFrames)]);
    }
    if ((m.fadeOutFrames ?? 0) > 0) {
      avoidRanges.push([Math.max(m.startFrame, m.endFrame - m.fadeOutFrames), m.endFrame]);
    }
  }
  const nudgeOutsideFade = (frame, minFrame, maxFrame) => {
    for (const [a, b] of avoidRanges) {
      if (frame > a && frame < b) {
        if (b <= maxFrame) return b;
        if (a >= minFrame) return a;
      }
    }
    return frame;
  };
  const rawChunks = [];
  let cursor = totalStart;
  for (let i = 0; i < count; i++) {
    const rawTo = i === count - 1 ? totalEnd : totalStart + Math.floor(((i + 1) * total) / count);
    const to = i === count - 1 ? totalEnd : nudgeOutsideFade(rawTo, cursor + 30, totalEnd - 30);
    if (to > cursor) {
      rawChunks.push({ from: cursor, to });
      cursor = to;
    }
  }

  // Subdivide any chunk overlapping > MAX_BASE_SEGMENTS_PER_CHUNK non-black segments so low-RAM hosts
  // don't open dozens of concurrent H.264 decoders inside one FFmpeg process.
  const isInsideAvoidRange = (frame) => avoidRanges.some(([a, b]) => frame > a && frame < b);
  const chunks = [];
  for (const chunk of rawChunks) {
    const overlappingNonBlack = baseSegments.filter(
      (s) => s.kind !== 'black' && s.timelineFrame < chunk.to && s.timelineFrame + s.frames > chunk.from,
    );
    if (overlappingNonBlack.length <= MAX_BASE_SEGMENTS_PER_CHUNK) {
      chunks.push(chunk);
      continue;
    }
    let subStart = chunk.from;
    let nonBlackInSub = 0;
    for (const seg of overlappingNonBlack) {
      if (nonBlackInSub >= MAX_BASE_SEGMENTS_PER_CHUNK && seg.timelineFrame > subStart && seg.timelineFrame < chunk.to) {
        const splitAt = isInsideAvoidRange(seg.timelineFrame)
          ? nudgeOutsideFade(seg.timelineFrame, subStart + 1, chunk.to - 1)
          : seg.timelineFrame;
        if (splitAt > subStart && splitAt < chunk.to && !isInsideAvoidRange(splitAt)) {
          chunks.push({ from: subStart, to: splitAt });
          subStart = splitAt;
          nonBlackInSub = 0;
        }
      }
      nonBlackInSub += 1;
    }
    if (subStart < chunk.to) chunks.push({ from: subStart, to: chunk.to });
  }
  return chunks;
}

/**
 * Execute decoupled overlay-hybrid export:
 * 1) Render sparse overlay PNG plates (ONLY unique overlay frames, video/audio stripped) via `renderOverlayPlates`.
 * 2) Encode chunked MP4 video in parallel via FFmpeg + sparse `ffconcat` overlay + hardware encoder.
 * 3) Render/mix audio to lossless PCM WAV and losslessly mux `-c:v copy -c:a aac`.
 */
export async function tryOverlayHybridExport(options, dependencies = {}) {
  const startedAt = Date.now();
  const inspected = await inspectOverlayHybridExport(options, dependencies);
  if (!inspected) return null;
  const { plan, sources } = inspected;
  const { renderOverlayPlates, renderCompatRange } = options;
  if (typeof renderOverlayPlates !== 'function') {
    dependencies.onDecline?.('missing-overlay-renderer');
    return null;
  }
  if ((plan.compatSpans?.length ?? 0) > 0 && typeof renderCompatRange !== 'function') {
    dependencies.onDecline?.('missing-compat-renderer');
    return null;
  }

  const { checkDisk = checkDirectCutDisk, run = directCutCommand, probe } = dependencies;
  const {
    outputLocation, onProgress, onProgressStage, h264Profile, videoBitrate, vaapiDevice,
    signal: ownerSignal, ffmpegExecutable, ffprobeExecutable, assetsDirectory,
  } = options;
  const profile = normalizeH264Profile('h264', h264Profile);
  const outputDirectory = path.dirname(path.resolve(outputLocation));
  await mkdir(outputDirectory, { recursive: true });
  const seconds = plan.frames / plan.fps;
  checkDisk(outputDirectory, seconds * ((Number(videoBitrate) || 30_000_000) / 8 * 2 + 48000 * 2 * 4));
  const checkResources = () => checkDisk(outputDirectory);
  const temporary = await mkdtemp(path.join(outputDirectory, '.zuoren-hybrid-'));
  const stagingOut = path.join(temporary, 'final.mp4');

  const controller = new AbortController();
  const signal = controller.signal;
  const onOwnerAbort = () => controller.abort(ownerSignal?.reason);
  if (ownerSignal?.aborted) onOwnerAbort();
  else ownerSignal?.addEventListener('abort', onOwnerAbort, { once: true });
  const guard = setInterval(() => {
    try { checkResources(); } catch (error) { controller.abort(error); }
  }, 1000);

  const probeCompatHasAudio = async (file) => {
    try {
      const meta = probe
        ? await probe(file)
        : JSON.parse(await run(ffprobeExecutable, ['-v', 'error', '-show_streams', '-of', 'json', file], { signal, timeoutMs: 5000 }));
      return Boolean(meta?.streams?.some((s) => s.codec_type === 'audio'));
    } catch {
      return false;
    }
  };

  try {
    const platesDir = path.join(temporary, 'plates');
    await mkdir(platesDir, { recursive: true });
    const blankPngPath = path.join(temporary, 'blank.png');
    await writeFile(blankPngPath, createBlankTransparentPng(plan.width, plan.height));
    const blurMaskCache = new Map();

    const platesStart = Date.now();
    const overlayState = buildOverlayOnlyState(plan.state, plan.underlayItemIds);
    const plateResult = await renderOverlayPlates({
      overlayState,
      originalState: plan.state,
      plan,
      platesDir,
      onPhaseProgress: (renderedCount, totalPlateCount) => {
        const plateWeight = totalPlateCount > 0 ? Math.min(0.45, Math.max(0.05, totalPlateCount / (totalPlateCount + plan.frames * 0.25))) : 0;
        const frac = totalPlateCount > 0 ? renderedCount / totalPlateCount : 1;
        onProgress?.(frac * plateWeight * (plan.hasUnderlays ? 0.5 : 1));
      },
      signal,
    });
    const { spans, plateFiles } = plateResult;
    await normalizeOverlayPlatesToRgba({
      plateFiles,
      width: plan.width,
      height: plan.height,
      ffmpegExecutable,
      signal,
      run,
    });
    let underlaySpans = [];
    let underlayPlateFiles = new Map();
    if (plan.hasUnderlays) {
      const underlayPlatesDir = path.join(temporary, 'underlay-plates');
      await mkdir(underlayPlatesDir, { recursive: true });
      const underlayState = buildUnderlayOnlyState(plan.state, plan.underlayItemIds);
      const underlayResult = await renderOverlayPlates({
        overlayState: underlayState,
        originalState: plan.state,
        plan: { ...plan, hasOverlays: true, hasCaptions: false, hasWatermark: false },
        platesDir: underlayPlatesDir,
        onPhaseProgress: (renderedCount, totalPlateCount) => {
          const frac = totalPlateCount > 0 ? renderedCount / totalPlateCount : 1;
          onProgress?.(0.15 + frac * 0.15);
        },
        signal,
      });
      underlaySpans = underlayResult.spans ?? [];
      underlayPlateFiles = underlayResult.plateFiles ?? new Map();
      await normalizeOverlayPlatesToRgba({
        plateFiles: underlayPlateFiles,
        width: plan.width,
        height: plan.height,
        ffmpegExecutable,
        signal,
        run,
      });
    }
    const platesMs = Date.now() - platesStart;

    signal.throwIfAborted();
    const totalPlateCount = plateFiles.size + underlayPlateFiles.size;
    const plateWeight = totalPlateCount > 0
      ? Math.min(0.45, Math.max(0.05, totalPlateCount / (totalPlateCount + plan.frames * 0.25)))
      : 0;
    onProgress?.(plateWeight);

    const cores = availableParallelism();
    const workerSize = { width: Math.max(plan.width, plan.outputWidth), height: Math.max(plan.height, plan.outputHeight) };
    let usedWorkers = resolveHybridWorkerCount({
      cores,
      frames: plan.frames,
      ...workerSize,
      hardware: Boolean(profile?.hardware),
    });
    let concurrencyFallback = false;
    let encodeMs = 0;
    let audioMs = 0;
    let muxMs = 0;

    const cleanupPartial = async () => {
      await rm(stagingOut, { force: true }).catch(() => {});
    };

    const runEncodingAttempt = async (activeProfile, workerOverride) => {
      const workerCount = workerOverride ?? resolveHybridWorkerCount({
        cores,
        frames: plan.frames,
        ...workerSize,
        hardware: Boolean(activeProfile?.hardware),
      });
      usedWorkers = workerCount;

      const timelinePieces = [
        ...(plan.fastSpans ?? [{ from: plan.rangeStart, to: plan.rangeEnd }]).map((s) => ({ kind: 'fast', from: s.from, to: s.to })),
        ...(plan.compatSpans ?? []).map((s) => ({ kind: 'compat', from: s.from, to: s.to, compatAudio: s.compatAudio, reasons: s.reasons })),
      ].sort((a, b) => a.from - b.from);

      const chunks = [];
      for (const piece of timelinePieces) {
        if (piece.kind === 'compat') {
          chunks.push(piece);
        } else {
          const pieceSegs = sliceBaseSegments(plan.baseSegments, piece.from, piece.to);
          const pieceMosaics = (plan.mosaics ?? []).filter((m) => m.endFrame > piece.from && m.startFrame < piece.to);
          for (const sub of splitOutputChunks(piece.from, piece.to, workerCount, pieceSegs, pieceMosaics)) {
            const subOverlays = (plan.overlayVideos ?? [])
              .filter((ov) => ov.endFrame > sub.from && ov.startFrame < sub.to)
              .sort((a, b) => a.startFrame - b.startFrame);
            if (subOverlays.length <= MAX_OVERLAY_VIDEOS_PER_CHUNK) {
              chunks.push({ kind: 'fast', from: sub.from, to: sub.to, spans, underlaySpans });
              continue;
            }
            let ovSubStart = sub.from;
            while (ovSubStart < sub.to) {
              const activeInWindow = subOverlays.filter((ov) => ov.endFrame > ovSubStart && ov.startFrame < sub.to);
              if (activeInWindow.length <= MAX_OVERLAY_VIDEOS_PER_CHUNK) {
                chunks.push({ kind: 'fast', from: ovSubStart, to: sub.to, spans, underlaySpans });
                break;
              }
              const kth = activeInWindow[MAX_OVERLAY_VIDEOS_PER_CHUNK];
              const splitAt = Math.max(ovSubStart + 30, Math.min(sub.to - 1, kth.startFrame));
              if (splitAt <= ovSubStart || splitAt >= sub.to) {
                chunks.push({ kind: 'fast', from: ovSubStart, to: sub.to, spans, underlaySpans });
                break;
              }
              chunks.push({ kind: 'fast', from: ovSubStart, to: splitAt, spans, underlaySpans });
              ovSubStart = splitAt;
            }
          }
        }
      }

      onProgressStage?.('rendering');
      const customOverride = activeProfile?.hardware ? h264FfmpegOverride(activeProfile.id, { vaapiDevice }) : undefined;
      const override = renderFfmpegOverride({ hardwareOverride: customOverride });
      const chunkProgress = new Array(chunks.length).fill(0);
      const reportChunkFrame = (chunkIdx, f) => {
        chunkProgress[chunkIdx] = f;
        const sumFrames = chunkProgress.reduce((s, n) => s + n, 0);
        const encodeSpan = 0.96 - plateWeight;
        const frac = clamp(sumFrames / Math.max(1, plan.frames), 0, 1);
        onProgress?.(plateWeight + frac * encodeSpan);
      };

      const encodeStart = Date.now();
      const attempt = new AbortController();
      const chunkSignal = AbortSignal.any([signal, attempt.signal]);
      const chunkFiles = new Array(chunks.length);
      const compatRawFiles = new Map();

      const fastIndices = [];
      const compatIndices = [];
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].kind === 'compat') compatIndices.push(i);
        else fastIndices.push(i);
      }

      const verifyChunkFrames = !dependencies.run && !dependencies.probe && ffprobeExecutable
        ? (file) => probeVideoFrameCount(file, { ffprobeExecutable, signal: chunkSignal, run })
        : undefined;

      let nextFastPos = 0;
      const maxConcurrent = Math.max(1, Math.min(workerCount, fastIndices.length || 1));
      const fastWorkers = fastIndices.length > 0
        ? Array.from({ length: maxConcurrent }, async () => {
          while (!chunkSignal.aborted) {
            const pos = nextFastPos++;
            if (pos >= fastIndices.length) return;
            const idx = fastIndices[pos];
            chunkFiles[idx] = await encodeChunk({
              chunk: chunks[idx],
              chunkIdx: idx,
              plan: { ...plan, assetsDirectory },
              sources,
              plateFiles,
              underlayPlateFiles,
              blankPngPath,
              temporary,
              blurMaskCache,
              ffmpegExecutable,
              h264Profile: activeProfile,
              videoBitrate,
              vaapiDevice,
              renderArgsOverride: override,
              onChunkFrame: reportChunkFrame,
              checkResources,
              signal: chunkSignal,
              run,
              verifyChunkFrames,
            });
          }
        })
        : [];
      try {
        await Promise.all(fastWorkers);
      } catch (error) {
        attempt.abort(error);
        await Promise.allSettled(fastWorkers);
        throw error;
      }

      const effectiveBitrate = videoBitrate ?? resolveH264VideoBitrate({
        width: plan.outputWidth, height: plan.outputHeight, fps: plan.fps,
      });
      for (const idx of compatIndices) {
        chunkSignal.throwIfAborted();
        const ch = chunks[idx];
        const chFrames = ch.to - ch.from;
        const rawCompatFile = path.join(temporary, `compat-raw-${idx}.mp4`);
        await renderCompatRange({
          frameRange: [ch.from, ch.to - 1],
          outputPath: rawCompatFile,
          includeAudio: Boolean(ch.compatAudio),
          h264Profile: activeProfile,
          signal: chunkSignal,
        });
        compatRawFiles.set(idx, rawCompatFile);
        const normFile = path.join(temporary, `chunk-${idx}.mp4`);
        const rawNormArgs = [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-i', rawCompatFile,
          '-an',
          '-vf', `scale=${plan.outputWidth}:${plan.outputHeight}:flags=lanczos,setsar=1`,
          '-r', String(plan.fps),
          '-frames:v', String(chFrames),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-color_primaries', 'bt709',
          '-color_trc', 'bt709',
          '-colorspace', 'bt709',
          '-color_range', 'tv',
          ...(effectiveBitrate ? ['-b:v', String(effectiveBitrate)] : ['-crf', '18', '-preset', 'medium']),
          '-movflags', '+faststart',
          '-progress', 'pipe:1',
          '-y', normFile,
        ];
        const finalNormArgs = override ? override({ args: rawNormArgs }) : rawNormArgs;
        await run(ffmpegExecutable, finalNormArgs, {
          signal: chunkSignal,
          timeoutMs: Math.max(CHUNK_TIMEOUT_MS, Math.ceil((chFrames / plan.fps) * 20_000)),
          collect: false,
          onFrame: (f) => reportChunkFrame(idx, Math.min(chFrames, Math.max(0, Number(f)))),
          checkResources,
        });
        if (verifyChunkFrames) {
          const actualFrames = await verifyChunkFrames(normFile);
          if (Number.isInteger(actualFrames) && actualFrames !== chFrames) {
            throw new Error(`Overlay-hybrid compat chunk ${idx} [${ch.from}, ${ch.to}) produced ${actualFrames} frames, expected ${chFrames}`);
          }
        }
        reportChunkFrame(idx, chFrames);
        chunkFiles[idx] = normFile;
      }
      encodeMs = Date.now() - encodeStart;

      signal.throwIfAborted();
      onProgressStage?.('finalizing');
      const audioStart = Date.now();
      let audioWav = null;
      const needsCompatAudioSplice = chunks.some((ch) => ch.kind === 'compat' && ch.compatAudio);
      if (!needsCompatAudioSplice) {
        audioWav = await renderAudioTrack({ plan, sources, temporary, ffmpegExecutable, checkResources, signal, run });
      } else {
        const hasAnyFastAudioChunk = chunks.some((ch) => !(ch.kind === 'compat' && ch.compatAudio));
        const baseAudioWav = hasAnyFastAudioChunk
          ? await renderAudioTrack({ plan, sources, temporary, ffmpegExecutable, checkResources, signal, run })
          : null;
        const sampleRate = 48000;
        const totalSamples = Math.round((plan.frames / plan.fps) * sampleRate);
        const spliceArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
        const spliceFilters = [];
        const spliceConcatLabels = [];
        let spliceInputIdx = 0;
        for (let ci = 0; ci < chunks.length; ci++) {
          const ch = chunks[ci];
          const segSamples = Math.max(1, Math.round(((ch.to - ch.from) / plan.fps) * sampleRate));
          if (ch.kind === 'compat' && ch.compatAudio) {
            const rawCompatFile = compatRawFiles.get(ci);
            const hasAudio = rawCompatFile && await probeCompatHasAudio(rawCompatFile);
            if (hasAudio) {
              const inIdx = spliceInputIdx++;
              spliceArgs.push('-i', rawCompatFile);
              spliceFilters.push(
                `[${inIdx}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo,apad,atrim=end_sample=${segSamples},asetpts=PTS-STARTPTS[as${ci}]`,
              );
            } else {
              spliceFilters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${segSamples},asetpts=PTS-STARTPTS[as${ci}]`);
            }
          } else if (baseAudioWav) {
            const offSample = Math.round(((ch.from - plan.rangeStart) / plan.fps) * sampleRate);
            const inIdx = spliceInputIdx++;
            spliceArgs.push('-i', baseAudioWav);
            spliceFilters.push(
              `[${inIdx}:a]atrim=start_sample=${offSample}:end_sample=${offSample + segSamples},asetpts=PTS-STARTPTS[as${ci}]`,
            );
          } else {
            spliceFilters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${segSamples},asetpts=PTS-STARTPTS[as${ci}]`);
          }
          spliceConcatLabels.push(`[as${ci}]`);
        }
        const splicedWav = path.join(temporary, 'audio-spliced.wav');
        const spliceFilter = spliceConcatLabels.length === 1
          ? `${spliceFilters.join(';')};${spliceConcatLabels[0]}atrim=end_sample=${totalSamples}[aout]`
          : `${spliceFilters.join(';')};${spliceConcatLabels.join('')}concat=n=${spliceConcatLabels.length}:v=0:a=1,atrim=end_sample=${totalSamples}[aout]`;
        const spliceFilterArgs = await filterComplexArgs(spliceFilter, path.join(temporary, 'filter-splice.txt'));
        await run(ffmpegExecutable, [
          ...spliceArgs,
          ...spliceFilterArgs,
          '-map', '[aout]',
          '-c:a', 'pcm_f32le',
          '-ar', String(sampleRate),
          '-ac', '2',
          '-y', splicedWav,
        ], { signal, timeoutMs: 300_000, collect: false, checkResources });
        audioWav = splicedWav;
      }
      audioMs = Date.now() - audioStart;

      const muxStart = Date.now();
      let videoOnlyFile = chunkFiles[0];
      if (chunkFiles.length > 1) {
        const videoConcatPath = path.join(temporary, 'video-chunks.ffconcat');
        const lines = ['ffconcat version 1.0', ...chunkFiles.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)];
        await writeFile(videoConcatPath, lines.join('\n') + '\n', 'utf8');
        videoOnlyFile = path.join(temporary, 'video-joined.mp4');
        const timeoutMs = exportFinalizationTimeoutMs({
          frames: plan.frames, fps: plan.fps, inputBytes: await totalFileBytes(chunkFiles),
        });
        await run(ffmpegExecutable, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-f', 'concat', '-safe', '0', '-i', videoConcatPath,
          '-c', 'copy', '-y', videoOnlyFile,
        ], { signal, timeoutMs, collect: false, checkResources });
      }

      const muxArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', videoOnlyFile];
      if (audioWav) muxArgs.push('-i', audioWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest');
      else muxArgs.push('-map', '0:v:0', '-c:v', 'copy', '-an');
      muxArgs.push('-movflags', '+faststart', '-y', stagingOut);
      const timeoutMs = exportFinalizationTimeoutMs({
        frames: plan.frames, fps: plan.fps, inputBytes: await totalFileBytes([videoOnlyFile, audioWav]),
      });
      await run(ffmpegExecutable, muxArgs, { signal, timeoutMs, collect: false, checkResources });
      if (!dependencies.run && !dependencies.probe && ffprobeExecutable) {
        const finalFrames = await probeVideoFrameCount(stagingOut, { ffprobeExecutable, signal, run });
        if (Number.isInteger(finalFrames) && finalFrames !== plan.frames) {
          throw new Error(`Overlay-hybrid final output produced ${finalFrames} frames, expected ${plan.frames}`);
        }
      }
      muxMs = Date.now() - muxStart;
      return stagingOut;
    };

    const runHardwareWithConcurrencyGuard = async (activeProfile) => {
      const initialWorkers = resolveHybridWorkerCount({
        cores,
        frames: plan.frames,
        ...workerSize,
        hardware: Boolean(activeProfile?.hardware),
      });
      try {
        return await runEncodingAttempt(activeProfile, initialWorkers);
      } catch (err) {
        if (signal.aborted || !activeProfile?.hardware || initialWorkers <= 1) throw err;
        const reducedWorkers = Math.max(1, Math.floor(initialWorkers / 2));
        console.warn(`[render] overlay-hybrid ${activeProfile.label} failed with ${initialWorkers} workers; retrying with ${reducedWorkers}: ${err instanceof Error ? err.message : String(err)}`);
        concurrencyFallback = true;
        await cleanupPartial();
        return await runEncodingAttempt(activeProfile, reducedWorkers);
      }
    };

    const softwareProfile = { id: 'libx264', label: 'Software (libx264)', hardware: false, transport: 'server' };
    const encoded = profile
      ? await withEncoderProfileFallback({
        render: runHardwareWithConcurrencyGuard,
        signal,
        hardwareOptions: profile,
        softwareOptions: softwareProfile,
        hardwareProfile: profile,
        cleanup: cleanupPartial,
        onFallback: (err) => {
          console.warn(`[render] overlay-hybrid ${profile.label} failed; retrying libx264: ${err instanceof Error ? err.message : String(err)}`);
        },
      })
      : { result: await runEncodingAttempt(undefined), encoder: undefined };

    await rename(encoded.result, outputLocation);
    onProgress?.(1);
    return {
      outputLocation,
      renderRoute: 'hybrid',
      hybridMode: plan.hybridMode ?? 'overlay-plates',
      ...(plan.compatFrames ? { compatFrames: plan.compatFrames } : {}),
      ...(plan.compatReasons?.length ? { compatReasons: plan.compatReasons } : {}),
      ...(encoded.encoder ? { encoder: encoded.encoder } : {}),
      ...(encoded.encoderFallbackReason ? { encoderFallbackReason: encoded.encoderFallbackReason } : {}),
      plateCount: totalPlateCount,
      totalFrames: plan.frames,
      workers: usedWorkers,
      concurrencyFallback,
      timingsMs: {
        total: Date.now() - startedAt,
        plates: platesMs,
        encode: encodeMs,
        audio: audioMs,
        mux: muxMs,
      },
    };
  } finally {
    clearInterval(guard);
    ownerSignal?.removeEventListener('abort', onOwnerAbort);
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
