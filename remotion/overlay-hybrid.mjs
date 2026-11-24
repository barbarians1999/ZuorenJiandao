import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  pictureAnimationTiming,
  pictureAnimationWindows,
  pictureOnlyProps,
} from '../shared/picture-animation-timing.mjs';

const STATE_KEYS = new Set([
  'fps', 'width', 'height', 'fit', 'compositingOrder', 'items', 'interaction',
  'trackOrder', 'tracks', 'transitions', 'markers', 'linkGroups', 'multicamGroups',
  'assets', 'captionsHidden', 'selectedId', 'selectedIds', 'captions', 'watermark',
  'fxDefs', 'id', 'name', 'order', 'hidden',
]);

const ITEM_KEYS = new Set([
  'id', 'mainClipId', 'track', 'startFrame', 'durationInFrames', 'name', 'kind',
  'templateId', 'code', 'props', 'width', 'height', 'src', 'sourceFilename',
  'originalFilePath', 'sourceAssetId', 'sourceRevision', 'sourceContentHash',
  'timelineId', 'pictureDisabled', 'multicamGroupId', 'multicamAngleId',
  'volume', 'audioDetached', 'srcInFrame', 'fadeInFrames', 'fadeOutFrames',
  'transform', 'keyframes', 'filters', 'mask', 'mosaic', 'backgroundFill',
  'backgroundFillStrength', 'zoom', 'effects', 'playbackRate', 'deletedWordIdx',
  'variants', 'silenceFrames', 'cutPadFrames', 'gapCapsMs', 'transcriptPlayOrder',
  'denoisedSrc', 'denoiseStrength', 'transcript', 'transcriptGenerationId', 'transcriptStale',
]);

const OVERLAY_KINDS = new Set(['text', 'solid', 'image', 'svg']);
const SUPPORTED_HYBRID_TRANSITIONS = new Set(['cross-dissolve', 'dip-to-black']);
const BASE_TRANSFORM_KEYS = new Set(['scale', 'scaleX', 'scaleY', 'x', 'y', 'rotation', 'opacity', 'borderRadius', 'crop']);
const BASE_FILTER_KEYS = new Set(['brightness', 'contrast', 'saturate', 'blur']);
const LOCAL_GAUSSIAN_BLUR_ASSET_ID = 'builtin:fx-local-gaussian-blur';
const LOCAL_MOSAIC_ASSET_ID = 'builtin:fx-local-mosaic';
const PIXELATE_ASSET_ID = 'builtin:fx-pixelate';
const RECT_MASK_ASSET_ID = 'builtin:fx-rect-mask';
const CIRCLE_MASK_ASSET_ID = 'builtin:fx-circle-mask';
const CUBE_LUT_ASSETS = {
  'builtin:slog3-s709': 'luts/Sony_Slog3_s709.cube',
  'builtin:canon-log3-709': 'luts/CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube',
};
const CLIP_EFFECT_KEYS = new Set(['id', 'assetId', 'overrides', 'mosaicTrack']);
const LOCAL_GAUSSIAN_BLUR_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'width_ratio', 'height_ratio', 'strength', 'feather']);
const LOCAL_MOSAIC_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'width_ratio', 'height_ratio', 'block_size', 'feather']);
const PIXELATE_OVERRIDE_KEYS = new Set(['blockSize']);
const RECT_MASK_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'width', 'height', 'corner_radius', 'feather', 'invert']);
const CIRCLE_MASK_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'radius', 'feather', 'invert']);
const LUT_OVERRIDE_KEYS = new Set(['intensity']);
const CLIP_MASK_KEYS = new Set(['type', 'x', 'y', 'width', 'height', 'feather']);
const TRACK_ORDER_DEFAULT = ['V2', 'V1', 'A1', 'A2'];
const PREROLL_FRAMES = 60;
const MAX_BASE_SEGMENTS_PER_CHUNK = 8;
const COMPAT_MIN_FAST_GAP_FRAMES = 15;
const CHUNK_TIMEOUT_MS = 600_000;
const FINALIZATION_TIMEOUT_MIN_MS = 180_000;
const FINALIZATION_TIMEOUT_MAX_MS = 45 * 60_000;
const GIB_BYTES = 1024 ** 3;
const SUPPORTED_HYBRID_VIDEO_CODECS = new Set(['h264', 'hevc', 'vp9', 'av1', 'prores', 'mpeg4', 'mjpeg']);
const OPAQUE_HYBRID_PIX_FMTS = /^(?:yuvj?(?:420|422|444)p(?:10le)?|nv12|p010le|rgb24|bgr24|gbrp)$/;

const integer = (value, min = 0) => Number.isInteger(value) && value >= min;
const refusal = (reason) => ({ eligible: false, reason, renderRoute: null });
const hasOwnKeys = (value) => value != null && typeof value === 'object' && Object.keys(value).some((k) => value[k] !== undefined);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const escapeFfmpegFilterPath = (filePath) => String(filePath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

function voiceIsolationMix(strength) {
  const wet = clamp(Number(strength ?? 100) / 100, 0, 1);
  if (wet === 0) return { dry: 1, wet: 0 };
  if (wet === 1) return { dry: 0, wet: 1 };
  return {
    dry: Math.cos((wet * Math.PI) / 2),
    wet: Math.sin((wet * Math.PI) / 2),
  };
}

function hasNonVolumeKeyframes(keyframes) {
  if (!keyframes || typeof keyframes !== 'object') return false;
  return Object.entries(keyframes).some(([prop, frames]) => prop !== 'volume' && Array.isArray(frames) && frames.length > 0);
}

function resolveAudioVolumeKeyframes(keyframes) {
  const raw = keyframes?.volume;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (raw.length > 24) return { unsupported: true };
  const cleaned = [];
  for (const kf of raw) {
    if (!kf || !Number.isFinite(kf.frame) || !Number.isFinite(kf.value)) return { unsupported: true };
    if (kf.easing && kf.easing !== 'linear') return { unsupported: true };
    cleaned.push({ frame: Number(kf.frame), value: clamp(Number(kf.value), 0, 2) });
  }
  cleaned.sort((a, b) => a.frame - b.frame);
  return cleaned;
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

function trackKind(state, id) {
  const prefix = String(id).toUpperCase()[0];
  return state.tracks?.[id]?.kind ?? (prefix === 'A' ? 'audio' : prefix === 'C' ? 'caption' : 'video');
}

function timelineTrackIds(state) {
  const ids = Array.isArray(state.trackOrder) ? [...state.trackOrder] : [...TRACK_ORDER_DEFAULT];
  for (const id of Object.keys(state.tracks ?? {})) if (!ids.includes(id)) ids.push(id);
  for (const item of state.items ?? []) if (!ids.includes(item.track)) ids.push(item.track);
  return ids;
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

function resolveStaticCompositionMosaic(item, width, height) {
  const m = item?.mosaic;
  if (!m || typeof m !== 'object' || (m.shape !== 'rectangle' && m.shape !== 'ellipse')) return null;
  const bounds = {
    centerX: [0, 1], centerY: [0, 1], width: [0.01, 1], height: [0.01, 1],
    strength: [1, 100], feather: [0, 100], opacity: [0, 1],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const v = m[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  }
  if (item.fadeInFrames || item.fadeOutFrames) return null;
  if (hasAnyKeyframes(item.keyframes) || hasOwnKeys(item.zoom) || (item.effects?.length ?? 0) > 0
    || item.backgroundFill || hasOwnKeys(item.mask) || item.filters) {
    return null;
  }
  if (!neutralPictureProps(item)) return null;
  if (item.transform && typeof item.transform === 'object') {
    for (const key of Object.keys(item.transform)) {
      if (item.transform[key] !== undefined && !BASE_TRANSFORM_KEYS.has(key)) return null;
    }
    const tr = item.transform;
    if (Number(tr.rotation ?? 0) !== 0 || Number(tr.borderRadius ?? 0) !== 0
      || Number(tr.scaleX ?? tr.scale ?? 1) !== 1 || Number(tr.scaleY ?? tr.scale ?? 1) !== 1
      || Number(tr.x ?? 0) !== 0 || Number(tr.y ?? 0) !== 0
      || Number(tr.opacity ?? 1) !== 1 || resolveFlexCrop(tr.crop, width, height)) {
      return null;
    }
  }
  const rawW = m.width * width;
  const rawH = m.height * height;
  const rawX = m.centerX * width - rawW / 2;
  const rawY = m.centerY * height - rawH / 2;
  const x0 = Math.max(0, Math.round(rawX));
  const y0 = Math.max(0, Math.round(rawY));
  const x1 = Math.min(width, Math.round(rawX + rawW));
  const y1 = Math.min(height, Math.round(rawY + rawH));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return null;
  const sigma = Math.max(1, Math.round(clamp(m.strength, 1, 100) * 0.24));
  return {
    shape: m.shape,
    x0,
    y0,
    w,
    h,
    localCx: m.centerX * width - x0,
    localCy: m.centerY * height - y0,
    halfW: rawW / 2,
    halfH: rawH / 2,
    sigma,
    feather: m.feather,
    opacity: m.opacity,
    startFrame: item.startFrame,
    endFrame: item.startFrame + item.durationInFrames,
    track: item.track,
  };
}

function hasAnyKeyframes(keyframes) {
  if (!keyframes || typeof keyframes !== 'object') return false;
  return Object.values(keyframes).some((frames) => Array.isArray(frames) && frames.length > 0);
}

function resolveFlexCrop(crop, width, height) {
  if (!crop || typeof crop !== 'object') return null;
  const left = Math.max(0, Number(crop.left ?? 0));
  const top = Math.max(0, Number(crop.top ?? 0));
  const right = Math.max(0, Number(crop.right ?? 0));
  const bottom = Math.max(0, Number(crop.bottom ?? 0));
  if (left <= 0 && top <= 0 && right <= 0 && bottom <= 0) return null;
  const px = (fraction, axis) => (fraction <= 0 ? 0 : Math.min(axis, Math.max(1, Math.round(fraction * axis))));
  const lx = px(left, width);
  const ty = px(top, height);
  const rx = px(right, width);
  const by = px(bottom, height);
  return { x: lx, y: ty, width: Math.max(0, width - lx - rx), height: Math.max(0, height - ty - by) };
}

function resolveBaseTransform(transform, canvasW, canvasH) {
  if (!transform || typeof transform !== 'object') return null;
  for (const key of Object.keys(transform)) {
    if (transform[key] !== undefined && !BASE_TRANSFORM_KEYS.has(key)) return { unsupported: `transform:${key}` };
  }
  const rotation = Number(transform.rotation ?? 0);
  const borderRadius = Math.max(0, Number(transform.borderRadius ?? 0));
  if (rotation !== 0 || borderRadius !== 0) return { unsupported: 'transform-rotation-or-radius' };
  const scaleX = Number(transform.scaleX ?? transform.scale ?? 1);
  const scaleY = Number(transform.scaleY ?? transform.scale ?? 1);
  const x = Number(transform.x ?? 0);
  const y = Number(transform.y ?? 0);
  const opacity = clamp(Number(transform.opacity ?? 1), 0, 1);
  const crop = resolveFlexCrop(transform.crop, canvasW, canvasH);
  if (![scaleX, scaleY, x, y, opacity].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) {
    return { unsupported: 'transform-invalid' };
  }
  return { scaleX, scaleY, x, y, opacity, crop };
}

function resolveBaseFilters(filters) {
  if (!filters || typeof filters !== 'object') return null;
  for (const key of Object.keys(filters)) {
    if (filters[key] !== undefined && !BASE_FILTER_KEYS.has(key)) return { unsupported: `filter:${key}` };
  }
  const brightness = Number(filters.brightness ?? 1);
  const contrast = Number(filters.contrast ?? 1);
  const saturate = Number(filters.saturate ?? 1);
  const blur = Number(filters.blur ?? 0);
  if (![brightness, contrast, saturate, blur].every(Number.isFinite) || brightness < 0 || contrast < 0 || saturate < 0 || blur < 0) {
    return { unsupported: 'filter-invalid' };
  }
  if (brightness === 1 && contrast === 1 && saturate === 1 && blur === 0) return null;
  return { brightness, contrast, saturate, blur };
}

function resolveBaseClipEffects(effects) {
  if (!effects || (Array.isArray(effects) && effects.length === 0)) return [];
  if (!Array.isArray(effects)) return { unsupported: true };
  const resolved = [];
  for (const effect of effects) {
    if (!effect || typeof effect !== 'object') return { unsupported: true };
    for (const key of Object.keys(effect)) {
      if (effect[key] !== undefined && !CLIP_EFFECT_KEYS.has(key)) return { unsupported: true };
    }
    if (effect.mosaicTrack) return { unsupported: true };
    const o = effect.overrides ?? {};
    if (typeof o !== 'object' || Array.isArray(o)) return { unsupported: true };
    if (effect.assetId === LOCAL_GAUSSIAN_BLUR_ASSET_ID) {
      for (const key of Object.keys(o)) {
        if (o[key] !== undefined && !LOCAL_GAUSSIAN_BLUR_OVERRIDE_KEYS.has(key)) return { unsupported: true };
      }
      const centerX = Number(o.center_x ?? 0.5);
      const centerY = Number(o.center_y ?? 0.5);
      const widthRatio = Number(o.width_ratio ?? 0.35);
      const heightRatio = Number(o.height_ratio ?? 0.35);
      const strength = Number(o.strength ?? 70);
      const feather = Number(o.feather ?? 0);
      if (![centerX, centerY, widthRatio, heightRatio, strength, feather].every(Number.isFinite)
        || centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1
        || widthRatio < 0.01 || widthRatio > 1 || heightRatio < 0.01 || heightRatio > 1
        || strength < 1 || strength > 100 || feather < 0 || feather > 100) {
        return { unsupported: true };
      }
      const sigma = Math.max(1, Math.round(clamp(strength, 1, 100) * 0.24));
      resolved.push({ kind: 'blur', centerX, centerY, widthRatio, heightRatio, sigma, feather });
    } else if (effect.assetId === LOCAL_MOSAIC_ASSET_ID) {
      for (const key of Object.keys(o)) {
        if (o[key] !== undefined && !LOCAL_MOSAIC_OVERRIDE_KEYS.has(key)) return { unsupported: true };
      }
      const centerX = Number(o.center_x ?? 0.5);
      const centerY = Number(o.center_y ?? 0.3);
      const widthRatio = Number(o.width_ratio ?? 0.2);
      const heightRatio = Number(o.height_ratio ?? 0.2);
      const blockSize = Number(o.block_size ?? 20);
      const feather = Number(o.feather ?? 4);
      if (![centerX, centerY, widthRatio, heightRatio, blockSize, feather].every(Number.isFinite)
        || centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1
        || widthRatio < 0.01 || widthRatio > 1 || heightRatio < 0.01 || heightRatio > 1
        || blockSize < 1 || blockSize > 200 || feather < 0 || feather > 100) {
        return { unsupported: true };
      }
      resolved.push({ kind: 'local-mosaic', centerX, centerY, widthRatio, heightRatio, blockSize, feather });
    } else if (effect.assetId === PIXELATE_ASSET_ID) {
      for (const key of Object.keys(o)) {
        if (o[key] !== undefined && !PIXELATE_OVERRIDE_KEYS.has(key)) return { unsupported: true };
      }
      const blockSize = Number(o.blockSize ?? 12);
      if (!Number.isFinite(blockSize) || blockSize < 1 || blockSize > 200) {
        return { unsupported: true };
      }
      resolved.push({ kind: 'pixelate', blockSize });
    } else if (effect.assetId === RECT_MASK_ASSET_ID) {
      for (const key of Object.keys(o)) {
        if (o[key] !== undefined && !RECT_MASK_OVERRIDE_KEYS.has(key)) return { unsupported: true };
      }
      const centerX = Number(o.center_x ?? 0.5);
      const centerY = Number(o.center_y ?? 0.5);
      const widthRatio = Number(o.width ?? 0.5);
      const heightRatio = Number(o.height ?? 0.5);
      const cornerRadius = Number(o.corner_radius ?? 0);
      const feather = Number(o.feather ?? 2);
      const invert = Number(o.invert ?? 0);
      if (![centerX, centerY, widthRatio, heightRatio, cornerRadius, feather, invert].every(Number.isFinite)
        || centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1
        || widthRatio < 0 || widthRatio > 1 || heightRatio < 0 || heightRatio > 1
        || cornerRadius < 0 || cornerRadius > 1000 || feather < 0 || feather > 200) {
        return { unsupported: true };
      }
      resolved.push({
        kind: 'shape-mask',
        shape: 'rectangle',
        centerX,
        centerY,
        widthRatio,
        heightRatio,
        cornerRadius,
        feather,
        invert: invert > 0.5,
      });
    } else if (effect.assetId === CIRCLE_MASK_ASSET_ID) {
      for (const key of Object.keys(o)) {
        if (o[key] !== undefined && !CIRCLE_MASK_OVERRIDE_KEYS.has(key)) return { unsupported: true };
      }
      const centerX = Number(o.center_x ?? 0.5);
      const centerY = Number(o.center_y ?? 0.5);
      const radius = Number(o.radius ?? 0.3);
      const feather = Number(o.feather ?? 2);
      const invert = Number(o.invert ?? 0);
      if (![centerX, centerY, radius, feather, invert].every(Number.isFinite)
        || centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1
        || radius < 0 || radius > 1 || feather < 0 || feather > 200) {
        return { unsupported: true };
      }
      resolved.push({
        kind: 'shape-mask',
        shape: 'circle',
        centerX,
        centerY,
        radius,
        feather,
        invert: invert > 0.5,
      });
    } else if (CUBE_LUT_ASSETS[effect.assetId]) {
      for (const key of Object.keys(o)) {
        if (o[key] !== undefined && !LUT_OVERRIDE_KEYS.has(key)) return { unsupported: true };
      }
      const intensity = Number(o.intensity ?? 1);
      if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) return { unsupported: true };
      resolved.push({
        kind: 'lut3d',
        assetId: effect.assetId,
        cubeRelPath: CUBE_LUT_ASSETS[effect.assetId],
        intensity,
      });
    } else {
      return { unsupported: true };
    }
  }
  return resolved;
}

function resolveBaseClipMask(mask, width, height) {
  if (!mask || !hasOwnKeys(mask)) return null;
  if (typeof mask !== 'object' || Array.isArray(mask)) return { unsupported: true };
  for (const key of Object.keys(mask)) {
    if (mask[key] !== undefined && !CLIP_MASK_KEYS.has(key)) return { unsupported: true };
  }
  if (mask.type !== 'rectangle' && mask.type !== 'ellipse') return { unsupported: true };
  const rawX = Number(mask.x);
  const rawY = Number(mask.y);
  const rawW = Number(mask.width);
  const rawH = Number(mask.height);
  const rawFeather = Number(mask.feather ?? 0);
  if (![rawX, rawY, rawW, rawH, rawFeather].every(Number.isFinite)) return { unsupported: true };
  const x = clamp(rawX, 0, 0.999);
  const y = clamp(rawY, 0, 0.999);
  const w = clamp(rawW, 0.001, 1 - x);
  const h = clamp(rawH, 0.001, 1 - y);
  const featherNorm = clamp(rawFeather, 0, 0.5);
  if (mask.type === 'rectangle' && x === 0 && y === 0 && w === 1 && h === 1 && featherNorm === 0) {
    return null;
  }
  return {
    shape: mask.type,
    rw: width,
    rh: height,
    localCx: (x + w / 2) * width,
    localCy: (y + h / 2) * height,
    halfW: (w * width) / 2,
    halfH: (h * height) / 2,
    feather: featherNorm * Math.min(width, height),
  };
}

function resolveBaseVisualFade(item) {
  const clipFadeIn = Number(item.fadeInFrames ?? 0);
  const clipFadeOut = Number(item.fadeOutFrames ?? 0);
  if (!Number.isFinite(clipFadeIn) || clipFadeIn < 0 || !Number.isFinite(clipFadeOut) || clipFadeOut < 0) {
    return { unsupported: 'video-visual-fade' };
  }
  const hasPicAnim = !neutralPictureProps(item);
  if (hasPicAnim && !pictureOnlyProps(item.props)) return { unsupported: 'video-clip-effects' };
  const ent = item.props?.visualEntrance ?? 'none';
  const ex = item.props?.visualExit ?? 'none';
  if ((ent !== 'none' && ent !== 'fade') || (ex !== 'none' && ex !== 'fade')) {
    return { unsupported: 'video-clip-effects' };
  }
  const dur = item.durationInFrames;
  const timing = hasPicAnim ? pictureAnimationTiming(item) : { entrance: null, exit: null };
  const picIn = timing.entrance && timing.entrance.until > 0 && timing.entrance.from < dur
    ? { from: timing.entrance.from, until: timing.entrance.until }
    : null;
  const picOut = timing.exit && timing.exit.until > 0 && timing.exit.from < dur
    ? { from: timing.exit.from, until: timing.exit.until }
    : null;
  if ((clipFadeIn > 0 && picIn) || (clipFadeOut > 0 && picOut)) {
    return { unsupported: 'video-visual-fade' };
  }
  const fadeIn = picIn ?? (clipFadeIn > 0 ? { from: 0, until: Math.min(dur, Math.round(clipFadeIn)) } : null);
  const fadeOut = picOut ?? (clipFadeOut > 0 ? { from: Math.max(0, dur - Math.round(clipFadeOut)), until: dur } : null);
  return (fadeIn || fadeOut) ? { fadeIn, fadeOut } : null;
}

function resolveBaseTimelineState({ state, project, timelineId }) {
  if (project && timelineId) {
    const timeline = project.timelines?.find((entry) => entry.id === timelineId);
    if (!timeline) return null;
    return { ...timeline, assets: project.assets ?? timeline.assets };
  }
  return state;
}

function mergeCompatSpans(rawSpans, rangeStart, rangeEnd) {
  const clipped = [];
  for (const sp of rawSpans) {
    const from = Math.max(rangeStart, Math.floor(sp.from));
    const to = Math.min(rangeEnd, Math.ceil(sp.to));
    if (to <= from) continue;
    clipped.push({
      from,
      to,
      compatAudio: Boolean(sp.compatAudio),
      reasons: new Set(sp.reasons ? sp.reasons : sp.reason ? [sp.reason] : []),
    });
  }
  if (!clipped.length) return [];
  clipped.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const sp of clipped) {
    const prev = merged.at(-1);
    if (prev && sp.from <= prev.to) {
      prev.to = Math.max(prev.to, sp.to);
      prev.compatAudio = prev.compatAudio || sp.compatAudio;
      for (const r of sp.reasons) prev.reasons.add(r);
    } else {
      merged.push(sp);
    }
  }
  const coalesced = [];
  for (const sp of merged) {
    const prev = coalesced.at(-1);
    if (prev && sp.from - prev.to > 0 && sp.from - prev.to < COMPAT_MIN_FAST_GAP_FRAMES) {
      prev.to = sp.to;
      prev.compatAudio = prev.compatAudio || sp.compatAudio;
      for (const r of sp.reasons) prev.reasons.add(r);
    } else {
      coalesced.push(sp);
    }
  }
  return coalesced.map((sp) => ({
    from: sp.from,
    to: sp.to,
    compatAudio: sp.compatAudio,
    reasons: [...sp.reasons],
  }));
}

function complementFastSpans(rangeStart, rangeEnd, compatSpans) {
  const out = [];
  let cursor = rangeStart;
  for (const sp of compatSpans) {
    if (sp.from > cursor) out.push({ from: cursor, to: sp.from });
    cursor = Math.max(cursor, sp.to);
  }
  if (cursor < rangeEnd) out.push({ from: cursor, to: rangeEnd });
  return out;
}

function resolveAudioCrossfadePlans(audioItems, audioTransitions, assets) {
  const byId = new Map(audioItems.map((it) => [it.id, it]));
  const plansByItemId = new Map();
  const getPlan = (id) => {
    let rec = plansByItemId.get(id);
    if (!rec) {
      rec = { beforeFrames: 0, afterFrames: 0, curves: [] };
      plansByItemId.set(id, rec);
    }
    return rec;
  };
  const findAsset = (item) => (item.sourceAssetId
    ? assets.find((a) => a.id === item.sourceAssetId)
    : assets.find((a) => a.src === item.src));
  const availBefore = (item) => {
    const rate = Math.max(0.01, Number(item.playbackRate ?? 1) || 1);
    const start = Math.max(0, Number(item.srcInFrame ?? 0) || 0);
    return Math.max(0, Math.floor(start / rate));
  };
  const availAfter = (item) => {
    const asset = findAsset(item);
    if (!asset || !Number.isFinite(asset.durationInFrames)) return null;
    const rate = Math.max(0.01, Number(item.playbackRate ?? 1) || 1);
    const srcEnd = (item.srcInFrame ?? 0) + item.durationInFrames * rate;
    if (!Number.isFinite(srcEnd)) return 0;
    return Math.max(0, Math.floor((asset.durationInFrames - srcEnd) / rate));
  };
  for (const t of audioTransitions) {
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    if (!out || !inc) continue;
    const dur = Number.isFinite(t.durationInFrames) ? Math.max(1, Math.round(t.durationInFrames)) : 1;
    const reqBefore = Math.floor(dur / 2);
    const reqAfter = dur - reqBefore;
    const beforeFrames = Math.min(reqBefore, availBefore(inc));
    const tail = availAfter(out);
    const afterFrames = tail === null ? reqAfter : Math.min(reqAfter, tail);
    const hasFullHandles = beforeFrames === reqBefore && afterFrames === reqAfter;
    const seam = inc.startFrame;
    const overlapFrames = beforeFrames + afterFrames;
    const incPlan = getPlan(inc.id);
    const outPlan = getPlan(out.id);
    if (hasFullHandles) {
      incPlan.beforeFrames = Math.max(incPlan.beforeFrames, beforeFrames);
      incPlan.curves.push({ direction: 'in', startFrame: seam - beforeFrames, duration: overlapFrames });
      outPlan.afterFrames = Math.max(outPlan.afterFrames, afterFrames);
      outPlan.curves.push({ direction: 'out', startFrame: seam - beforeFrames, duration: overlapFrames });
    } else {
      if (reqAfter > 0) incPlan.curves.push({ direction: 'in', startFrame: seam, duration: reqAfter });
      if (reqBefore > 0) outPlan.curves.push({ direction: 'out', startFrame: seam - reqBefore, duration: reqBefore });
    }
  }
  return plansByItemId;
}

function finalizeSegmentedGeometry({
  rangeStart, rangeEnd, frames, plannedTransitions, rawCompatSpans, allowCompatSpans,
}) {
  if (!allowCompatSpans) {
    const fastSpans = [{ from: rangeStart, to: rangeEnd }];
    return { compatSpans: [], fastSpans, compatFrames: 0, compatReasons: [] };
  }
  let workingCompat = mergeCompatSpans(rawCompatSpans, rangeStart, rangeEnd);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const rec of plannedTransitions) {
      if (workingCompat.some((c) => c.from < rec.winEnd && c.to > rec.winStart)) {
        const alreadyCovered = workingCompat.some((c) => c.from <= rec.winStart && c.to >= rec.winEnd);
        if (!alreadyCovered) {
          workingCompat.push({ from: rec.winStart, to: rec.winEnd, compatAudio: false, reasons: ['transitions'] });
          workingCompat = mergeCompatSpans(workingCompat, rangeStart, rangeEnd);
          expanded = true;
        }
      }
    }
  }
  const fastSpans = complementFastSpans(rangeStart, rangeEnd, workingCompat);
  const compatFrames = workingCompat.reduce((sum, s) => sum + (s.to - s.from), 0);
  const reasonSet = new Set();
  for (const s of workingCompat) for (const r of s.reasons) reasonSet.add(r);
  void frames;
  return {
    compatSpans: workingCompat,
    fastSpans,
    compatFrames,
    compatReasons: [...reasonSet],
  };
}

function buildBaseSegmentsForSpans({
  fastSpans, sortedVideos, transitionByOutgoingId, transitionByIncomingId,
}) {
  const baseSegments = [];
  const makeVideoSegment = (entry, segStart, segEnd) => {
    const { item, rate, transform, filters, visualFade, localGaussianBlurs, clipMask } = entry;
    const isSolidBlack = transform?.opacity === 0 || filters?.brightness === 0;
    return isSolidBlack
      ? { kind: 'black', timelineFrame: segStart, frames: segEnd - segStart }
      : {
        kind: 'video',
        timelineFrame: segStart,
        frames: segEnd - segStart,
        sourceFrame: (item.srcInFrame ?? 0) + (segStart - item.startFrame) * rate,
        playbackRate: rate,
        clipLocalStart: segStart - item.startFrame,
        src: item.src,
        transform,
        filters,
        visualFade,
        ...(localGaussianBlurs?.length ? { localGaussianBlurs } : {}),
        ...(clipMask ? { clipMask } : {}),
      };
  };

  for (const fastSpan of fastSpans) {
    let cursor = fastSpan.from;
    const spanEnd = fastSpan.to;
    for (const entry of sortedVideos) {
      const { item } = entry;
      const itemStart = item.startFrame;
      const itemEnd = itemStart + item.durationInFrames;
      const inTr = transitionByIncomingId.get(item.id);
      const outTr = transitionByOutgoingId.get(item.id);
      const effectiveEnd = outTr ? outTr.winEnd : itemEnd;
      if (effectiveEnd <= cursor || itemStart >= spanEnd) continue;
      if (itemStart > cursor) {
        const gapEnd = Math.min(spanEnd, itemStart);
        if (gapEnd > cursor) {
          baseSegments.push({ kind: 'black', timelineFrame: cursor, frames: gapEnd - cursor });
          cursor = gapEnd;
        }
      }
      const inTrInside = inTr && inTr.winStart >= fastSpan.from && inTr.winEnd <= spanEnd;
      const outTrInside = outTr && outTr.winStart >= fastSpan.from && outTr.winEnd <= spanEnd;
      const bodyStart = inTrInside ? inTr.winEnd : itemStart;
      const bodyEnd = outTrInside ? outTr.winStart : itemEnd;
      const segStart = Math.max(cursor, bodyStart);
      const segEnd = Math.min(spanEnd, bodyEnd);
      if (segEnd > segStart) {
        baseSegments.push(makeVideoSegment(entry, segStart, segEnd));
        cursor = segEnd;
      }
      if (outTrInside && outTr.winEnd > cursor && outTr.winStart < spanEnd) {
        const { outEntry, incEntry, L, half, winStart, winEnd, t } = outTr;
        baseSegments.push({
          kind: 'transition',
          transitionType: t.type,
          timelineFrame: winStart,
          frames: L,
          outgoingSeg: {
            kind: 'video',
            timelineFrame: winStart,
            frames: L,
            sourceFrame: (outEntry.item.srcInFrame ?? 0) + (winStart - outEntry.item.startFrame) * outEntry.rate,
            playbackRate: outEntry.rate,
            clipLocalStart: winStart - outEntry.item.startFrame,
            src: outEntry.item.src,
            transform: outEntry.transform,
            filters: outEntry.filters,
            visualFade: null,
            ...(outEntry.localGaussianBlurs?.length ? { localGaussianBlurs: outEntry.localGaussianBlurs } : {}),
            ...(outEntry.clipMask ? { clipMask: outEntry.clipMask } : {}),
          },
          incomingSeg: {
            kind: 'video',
            timelineFrame: winStart,
            frames: L,
            sourceFrame: (incEntry.item.srcInFrame ?? 0) - half * incEntry.rate,
            playbackRate: incEntry.rate,
            clipLocalStart: -half,
            src: incEntry.item.src,
            transform: incEntry.transform,
            filters: incEntry.filters,
            visualFade: null,
            ...(incEntry.localGaussianBlurs?.length ? { localGaussianBlurs: incEntry.localGaussianBlurs } : {}),
            ...(incEntry.clipMask ? { clipMask: incEntry.clipMask } : {}),
          },
        });
        cursor = winEnd;
      }
    }
    if (cursor < spanEnd) {
      baseSegments.push({ kind: 'black', timelineFrame: cursor, frames: spanEnd - cursor });
    }
  }
  return baseSegments;
}

export function planOverlayHybridExport({
  state: rawState,
  project,
  timelineId,
  codec = 'h264',
  scale = 1,
  frameRange,
  separateAudioTo,
  allowCompatSpans = false,
} = {}) {
  const state = resolveBaseTimelineState({ state: rawState, project, timelineId });
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) return refusal('invalid-state');
  for (const key of Object.keys(state)) if (!STATE_KEYS.has(key)) return refusal(`state:${key}`);
  if (codec !== 'h264' || separateAudioTo || !Number.isFinite(scale) || scale <= 0 || scale > 16) return refusal('render-mode');
  if (!integer(state.fps, 1) || !integer(state.width, 2) || !integer(state.height, 2)
    || state.width % 2 !== 0 || state.height % 2 !== 0) {
    return refusal('composition-geometry');
  }
  const outputWidth = Math.round(state.width * scale);
  const outputHeight = Math.round(state.height * scale);
  if (!integer(outputWidth, 2) || !integer(outputHeight, 2) || outputWidth % 2 !== 0 || outputHeight % 2 !== 0) {
    return refusal('output-geometry');
  }

  const endFrame = Math.max(state.fps, state.items.reduce((max, item) => Math.max(max, (item.startFrame ?? 0) + (item.durationInFrames ?? 0)), 0));
  const [from, to] = frameRange ?? [0, endFrame - 1];
  if (!integer(from) || !integer(to, from) || to >= endFrame) return refusal('frame-range');
  const rangeStart = from;
  const rangeEnd = to + 1;
  const frames = rangeEnd - rangeStart;

  const trackIds = timelineTrackIds(state);
  const visualTrackIds = trackIds.filter((id) => trackKind(state, id) === 'video');
  const tracks = state.tracks ?? {};

  const visibleVideoItems = [];
  const allVisualVideoItems = [];
  const visibleOverlayItems = [];
  const visibleMosaicItems = [];
  const audioItems = [];
  const rawCompatSpans = [];
  const markCompat = (itemStart, itemDur, reason, compatAudio = false) => {
    const s = Math.max(rangeStart, itemStart);
    const e = Math.min(rangeEnd, itemStart + Math.max(1, itemDur));
    if (e > s) rawCompatSpans.push({ from: s, to: e, reason, compatAudio });
  };

  for (const item of state.items) {
    if (!item || typeof item !== 'object') return refusal('invalid-item');
    for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) {
      if (!allowCompatSpans) return refusal(`item:${key}`);
      if (integer(item.startFrame) && integer(item.durationInFrames, 1)) {
        markCompat(item.startFrame, item.durationInFrames, `item:${key}`, true);
        continue;
      }
      return refusal(`item:${key}`);
    }
    const track = tracks[item.track];
    if (track?.hidden) continue;
    if (!integer(item.startFrame) || !integer(item.durationInFrames, 1)) return refusal('item-timing');

    if (item.kind === 'sequence') {
      if (!allowCompatSpans) return refusal('nested-sequence');
      markCompat(item.startFrame, item.durationInFrames, 'nested-sequence', true);
      continue;
    }
    if (item.kind === 'gif') {
      if (!allowCompatSpans) return refusal(`unsupported-kind:${item.kind}`);
      markCompat(item.startFrame, item.durationInFrames, `unsupported-kind:${item.kind}`, false);
      continue;
    }
    if (item.kind !== 'mosaic' && item.mosaic) {
      if (!allowCompatSpans) return refusal('composition-mosaic');
      markCompat(item.startFrame, item.durationInFrames, 'composition-mosaic', false);
    }

    if (item.kind === 'mosaic') {
      const resolved = resolveStaticCompositionMosaic(item, state.width, state.height);
      if (!resolved) {
        if (!allowCompatSpans) return refusal('composition-mosaic');
        markCompat(item.startFrame, item.durationInFrames, 'composition-mosaic', false);
      } else {
        visibleMosaicItems.push(resolved);
      }
    } else if (item.kind === 'video') {
      if (!item.pictureDisabled) allVisualVideoItems.push(item);
      const rate = Number(item.playbackRate ?? 1);
      const speechEdited = Boolean(
        item.deletedWordIdx?.length || item.transcriptPlayOrder?.length || item.silenceFrames != null
        || item.cutPadFrames != null || item.gapCapsMs != null,
      );
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
        if (!allowCompatSpans) return refusal('item-retimed');
        markCompat(item.startFrame, item.durationInFrames, 'item-retimed', true);
        continue;
      }
      if (speechEdited) {
        if (!allowCompatSpans) return refusal('item-speech-edited');
        markCompat(item.startFrame, item.durationInFrames, 'item-speech-edited', true);
        continue;
      }
      if (!item.pictureDisabled) {
        let videoCompatReason = null;
        if (!item.src || !integer(item.srcInFrame ?? 0)) videoCompatReason = 'video-source';
        else if (hasAnyKeyframes(item.keyframes) || hasOwnKeys(item.zoom)
          || item.backgroundFill || item.mosaic) {
          videoCompatReason = 'video-clip-effects';
        }
        const clipMask = videoCompatReason ? null : resolveBaseClipMask(item.mask, state.width, state.height);
        if (!videoCompatReason && clipMask?.unsupported) videoCompatReason = 'video-clip-effects';
        const localGaussianBlurs = videoCompatReason ? null : resolveBaseClipEffects(item.effects);
        if (!videoCompatReason && localGaussianBlurs?.unsupported) videoCompatReason = 'video-clip-effects';
        const visualFade = videoCompatReason ? null : resolveBaseVisualFade(item);
        if (!videoCompatReason && visualFade?.unsupported) videoCompatReason = visualFade.unsupported;
        const transform = videoCompatReason ? null : resolveBaseTransform(item.transform, state.width, state.height);
        if (!videoCompatReason && transform?.unsupported) videoCompatReason = transform.unsupported;
        const filters = videoCompatReason ? null : resolveBaseFilters(item.filters);
        if (!videoCompatReason && filters?.unsupported) videoCompatReason = filters.unsupported;

        if (videoCompatReason) {
          if (!allowCompatSpans) return refusal(videoCompatReason);
          markCompat(item.startFrame, item.durationInFrames, videoCompatReason, false);
        } else {
          visibleVideoItems.push({ item, rate, transform, filters, visualFade, localGaussianBlurs, clipMask });
        }
      }
      if (!item.audioDetached && item.volume !== 0) {
        if (!item.src || !integer(item.srcInFrame ?? 0)) {
          if (!allowCompatSpans) return refusal('video-audio-source');
          markCompat(item.startFrame, item.durationInFrames, 'video-audio-source', true);
        } else {
          audioItems.push(item);
        }
      }
    } else if (item.kind === 'audio') {
      if (!item.src || !integer(item.srcInFrame ?? 0)) {
        if (!allowCompatSpans) return refusal('audio-source');
        markCompat(item.startFrame, item.durationInFrames, 'audio-source', true);
        continue;
      }
      const rate = Number(item.playbackRate ?? 1);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
        if (!allowCompatSpans) return refusal('audio-retimed');
        markCompat(item.startFrame, item.durationInFrames, 'audio-retimed', true);
        continue;
      }
      const volKeyframes = resolveAudioVolumeKeyframes(item.keyframes);
      const speechEdited = Boolean(
        item.deletedWordIdx?.length || item.transcriptPlayOrder?.length || item.silenceFrames != null
        || item.cutPadFrames != null || item.gapCapsMs != null,
      );
      if (speechEdited) {
        if (!allowCompatSpans) return refusal('item-speech-edited');
        markCompat(item.startFrame, item.durationInFrames, 'item-speech-edited', true);
        continue;
      }
      if (hasNonVolumeKeyframes(item.keyframes) || (item.effects?.length ?? 0) > 0 || volKeyframes?.unsupported) {
        if (!allowCompatSpans) return refusal('audio-processing');
        markCompat(item.startFrame, item.durationInFrames, 'audio-processing', true);
        continue;
      }
      audioItems.push({ ...item, _volumeKeyframes: Array.isArray(volKeyframes) ? volKeyframes : null });
    } else if (OVERLAY_KINDS.has(item.kind)) {
      visibleOverlayItems.push(item);
    } else {
      if (!allowCompatSpans) return refusal(`unsupported-kind:${item.kind}`);
      markCompat(item.startFrame, item.durationInFrames, `unsupported-kind:${item.kind}`, false);
    }
  }

  // Visual stacking check: overlays below visible video tracks.
  const minVideoTrackIdx = visibleVideoItems.length > 0
    ? Math.min(...visibleVideoItems.map(({ item }) => visualTrackIds.indexOf(item.track)))
    : Infinity;
  if (!allowCompatSpans && visibleVideoItems.length > 0) {
    for (const overlay of visibleOverlayItems) {
      const idx = visualTrackIds.indexOf(overlay.track);
      if (idx < 0 || idx >= minVideoTrackIdx) return refusal('overlay-below-video');
    }
  } else if (allowCompatSpans && allVisualVideoItems.length > 0) {
    for (const overlay of visibleOverlayItems) {
      const ovIdx = visualTrackIds.indexOf(overlay.track);
      const ovStart = overlay.startFrame;
      const ovEnd = ovStart + overlay.durationInFrames;
      if (ovIdx < 0) {
        markCompat(ovStart, overlay.durationInFrames, 'overlay-below-video', false);
        continue;
      }
      for (const vid of allVisualVideoItems) {
        const vIdx = visualTrackIds.indexOf(vid.track);
        if (vIdx >= 0 && vIdx <= ovIdx) {
          const s = Math.max(rangeStart, ovStart, vid.startFrame);
          const e = Math.min(rangeEnd, ovEnd, vid.startFrame + vid.durationInFrames);
          if (e > s) rawCompatSpans.push({ from: s, to: e, reason: 'overlay-below-video', compatAudio: false });
        }
      }
    }
  }

  const isTrackCaptionEnabled = (id) => state.captionsHidden !== true
    && trackKind(state, id) === 'caption'
    && !tracks[id]?.hidden
    && (tracks[id]?.captions?.enabled ?? (tracks[id]?.captions === undefined && id === 'C1' && state.captions?.enabled));
  const enabledCaptionTrackIndices = trackIds
    .map((id, idx) => (isTrackCaptionEnabled(id) ? idx : -1))
    .filter((idx) => idx >= 0);
  const maxCaptionTrackIdx = enabledCaptionTrackIndices.length > 0 ? Math.max(...enabledCaptionTrackIndices) : -1;
  const maxOverlayTrackIdx = visibleOverlayItems.length > 0
    ? Math.max(...visibleOverlayItems.map((it) => visualTrackIds.indexOf(it.track)))
    : -1;
  const eligibleMosaics = [];
  for (const mosaic of visibleMosaicItems) {
    const mVisIdx = visualTrackIds.indexOf(mosaic.track);
    const mTrackIdx = trackIds.indexOf(mosaic.track);
    let invalidZ = mVisIdx < 0 || (visibleVideoItems.length > 0 && mVisIdx >= minVideoTrackIdx);
    if (!invalidZ && visibleOverlayItems.length > 0 && (maxOverlayTrackIdx < 0 || mVisIdx <= maxOverlayTrackIdx)) {
      invalidZ = true;
    }
    if (!invalidZ && maxCaptionTrackIdx >= 0 && mTrackIdx <= maxCaptionTrackIdx) {
      invalidZ = true;
    }
    if (invalidZ) {
      if (!allowCompatSpans) return refusal('composition-mosaic');
      markCompat(mosaic.startFrame, mosaic.endFrame - mosaic.startFrame, 'composition-mosaic', false);
    } else {
      eligibleMosaics.push(mosaic);
    }
  }

  const sortedVideos = [...visibleVideoItems].sort((a, b) => a.item.startFrame - b.item.startFrame);
  if (!allowCompatSpans) {
    for (let i = 1; i < sortedVideos.length; i++) {
      const prev = sortedVideos[i - 1].item;
      if (sortedVideos[i].item.startFrame < prev.startFrame + prev.durationInFrames) {
        return refusal('overlapping-base-video');
      }
    }
  } else {
    const events = [];
    for (const v of allVisualVideoItems) {
      const s = Math.max(rangeStart, v.startFrame);
      const e = Math.min(rangeEnd, v.startFrame + v.durationInFrames);
      if (e > s) events.push([s, 1], [e, -1]);
    }
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let activeCount = 0;
    let overlapStart = null;
    for (let i = 0; i < events.length;) {
      const pos = events[i][0];
      while (i < events.length && events[i][0] === pos) {
        activeCount += events[i][1];
        i += 1;
      }
      if (activeCount >= 2 && overlapStart === null) overlapStart = pos;
      else if (activeCount < 2 && overlapStart !== null) {
        if (pos > overlapStart) rawCompatSpans.push({ from: overlapStart, to: pos, reason: 'overlapping-base-video', compatAudio: false });
        overlapStart = null;
      }
    }
  }

  const allItemsById = new Map((state.items ?? []).map((it) => [it.id, it]));
  const videoById = new Map(sortedVideos.map((entry) => [entry.item.id, entry]));
  const enabledTransitions = (state.transitions ?? []).filter((t) => t && t.enabled !== false);
  const visualTransitions = enabledTransitions.filter((t) => t.type !== 'audio-cross-fade');
  const audioTransitions = enabledTransitions.filter((t) => t.type === 'audio-cross-fade');

  const plannedTransitions = [];
  const transitionByOutgoingId = new Map();
  const transitionByIncomingId = new Map();
  const addTransitionCompatSpan = (t) => {
    const out = allItemsById.get(t.outgoingItemId);
    const inc = allItemsById.get(t.incomingItemId);
    if (out && inc && integer(out.startFrame) && integer(inc.startFrame)) {
      const L = integer(t.durationInFrames, 2) ? t.durationInFrames : 30;
      const half = Math.floor(L / 2);
      markCompat(inc.startFrame - half, L, 'transitions', false);
    } else if (out && integer(out.startFrame) && integer(out.durationInFrames, 1)) {
      markCompat(out.startFrame, out.durationInFrames, 'transitions', false);
    }
  };

  for (const t of visualTransitions) {
    if (!SUPPORTED_HYBRID_TRANSITIONS.has(t.type) || t.customFrag || !integer(t.durationInFrames, 2)) {
      if (!allowCompatSpans) return refusal('transitions');
      addTransitionCompatSpan(t);
      continue;
    }
    const outEntry = videoById.get(t.outgoingItemId);
    const incEntry = videoById.get(t.incomingItemId);
    if (!outEntry || !incEntry) {
      if (!allowCompatSpans) return refusal('transitions');
      addTransitionCompatSpan(t);
      continue;
    }
    const out = outEntry.item;
    const inc = incEntry.item;
    if (out.track !== inc.track || out.startFrame + out.durationInFrames !== inc.startFrame) {
      if (!allowCompatSpans) return refusal('transitions');
      addTransitionCompatSpan(t);
      continue;
    }
    const L = t.durationInFrames;
    const half = Math.floor(L / 2);
    const post = L - half;
    const seam = inc.startFrame;
    const winStart = seam - half;
    const winEnd = seam + post;
    if (winStart < out.startFrame || winEnd > inc.startFrame + inc.durationInFrames
      || winStart < rangeStart || winEnd > rangeEnd
      || outEntry.transform?.opacity === 0 || outEntry.filters?.brightness === 0
      || incEntry.transform?.opacity === 0 || incEntry.filters?.brightness === 0
      || (inc.srcInFrame ?? 0) < half * incEntry.rate
      || transitionByOutgoingId.has(out.id) || transitionByIncomingId.has(inc.id)) {
      if (!allowCompatSpans) return refusal('transitions');
      markCompat(winStart, L, 'transitions', false);
      continue;
    }
    const overlapsFade = (vf, clipStart) => {
      if (!vf) return false;
      for (const w of [vf.fadeIn, vf.fadeOut]) {
        if (w && clipStart + w.until > winStart && clipStart + w.from < winEnd) return true;
      }
      return false;
    };
    if (overlapsFade(outEntry.visualFade, out.startFrame) || overlapsFade(incEntry.visualFade, inc.startFrame)) {
      if (!allowCompatSpans) return refusal('transitions');
      markCompat(winStart, L, 'transitions', false);
      continue;
    }
    const rec = { t, outEntry, incEntry, L, half, post, winStart, winEnd };
    plannedTransitions.push(rec);
    transitionByOutgoingId.set(out.id, rec);
    transitionByIncomingId.set(inc.id, rec);
  }
  plannedTransitions.sort((a, b) => a.winStart - b.winStart);
  for (let i = 1; i < plannedTransitions.length; i++) {
    if (plannedTransitions[i].winStart < plannedTransitions[i - 1].winEnd) {
      if (!allowCompatSpans) return refusal('transitions');
      markCompat(plannedTransitions[i].winStart, plannedTransitions[i].L, 'transitions', false);
    }
  }

  const { compatSpans, fastSpans, compatFrames, compatReasons } = finalizeSegmentedGeometry({
    rangeStart,
    rangeEnd,
    frames,
    plannedTransitions,
    rawCompatSpans,
    allowCompatSpans,
  });

  if (compatFrames >= frames) {
    return refusal(compatReasons[0] ?? 'video-clip-effects');
  }

  const baseSegments = buildBaseSegmentsForSpans({
    fastSpans,
    sortedVideos,
    transitionByOutgoingId,
    transitionByIncomingId,
  });

  if (compatSpans.length > 0 && !baseSegments.some((s) => s.kind === 'video' || s.kind === 'transition')) {
    return refusal(compatReasons[0] ?? 'video-clip-effects');
  }

  const mosaics = eligibleMosaics
    .filter((m) => m.endFrame > rangeStart && m.startFrame < rangeEnd)
    .sort((a, b) => visualTrackIds.indexOf(b.track) - visualTrackIds.indexOf(a.track) || a.startFrame - b.startFrame);

  const audioTracksInUse = [...new Set(audioItems.map((it) => it.track))];
  const anySolo = audioTracksInUse.some((id) => tracks[id]?.soloed);
  const anchorRangesRaw = [];
  for (const it of audioItems) {
    const tr = tracks[it.track];
    const audibleTrack = !tr?.hidden && !tr?.muted && (!anySolo || Boolean(tr?.soloed));
    if (!audibleTrack) continue;
    if (tr?.role === 'anchor' && it.src) {
      anchorRangesRaw.push([it.startFrame, it.startFrame + it.durationInFrames]);
    }
  }
  const anchorRanges = mergeRanges(anchorRangesRaw, rangeStart, rangeEnd);
  const crossfadePlans = resolveAudioCrossfadePlans(audioItems, audioTransitions, state.assets ?? []);

  const audioSegments = [];
  for (const item of audioItems) {
    const tr = tracks[item.track];
    if (tr?.hidden || tr?.muted || (anySolo && !tr?.soloed)) continue;
    const volKeyframes = item._volumeKeyframes ?? null;
    const baseVolume = volKeyframes?.length === 1 ? volKeyframes[0].value : clamp(Number(item.volume ?? 1), 0, 2);
    const gainDb = Number(tr?.audioRouting?.gainDb ?? 0);
    const trackGain = Number.isFinite(gainDb) ? 10 ** (gainDb / 20) : 1;
    const rate = Number(item.playbackRate ?? 1);
    const cfPlan = crossfadePlans.get(item.id);
    const extBefore = cfPlan?.beforeFrames ?? 0;
    const extAfter = cfPlan?.afterFrames ?? 0;
    const itemStart = item.startFrame - extBefore;
    const itemEnd = item.startFrame + item.durationInFrames + extAfter;
    const overlapStart = Math.max(rangeStart, itemStart);
    const overlapEnd = Math.min(rangeEnd, itemEnd);
    if (overlapEnd <= overlapStart) continue;

    let duckIntervals = null;
    let duckFactor = 1;
    if (anchorRanges.length > 0 && tr?.role === 'follower') {
      duckFactor = clamp(10 ** ((tr?.audioRouting?.duckDepthDb ?? -12) / 20), 0, 2);
      if (duckFactor !== 1) {
        const intervals = [];
        for (const [a, b] of anchorRanges) {
          const is = Math.max(overlapStart, a);
          const ie = Math.min(overlapEnd, b);
          if (ie > is) intervals.push([(is - overlapStart) / state.fps, (ie - overlapStart) / state.fps]);
        }
        if (intervals.length) duckIntervals = intervals;
      }
    }

    const crossfades = cfPlan?.curves?.length
      ? cfPlan.curves
        .map((c) => ({
          direction: c.direction,
          startFrame: c.startFrame - overlapStart,
          durationFrames: c.duration,
        }))
        .filter((c) => c.durationFrames > 0 && c.startFrame + c.durationFrames > 0 && c.startFrame < overlapEnd - overlapStart)
      : null;

    const sourcesForItem = item.denoisedSrc
      ? (() => {
        const mix = voiceIsolationMix(item.denoiseStrength);
        const out = [];
        if (mix.dry > 0) out.push({ src: item.src, mixGain: mix.dry });
        if (mix.wet > 0) out.push({ src: item.denoisedSrc, mixGain: mix.wet });
        return out;
      })()
      : [{ src: item.src, mixGain: 1 }];

    for (const sEntry of sourcesForItem) {
      const gain = (volKeyframes?.length >= 2 ? 1 : baseVolume) * trackGain * sEntry.mixGain;
      if (gain <= 0) continue;
      audioSegments.push({
        src: sEntry.src,
        timelineStartFrame: overlapStart,
        frames: overlapEnd - overlapStart,
        sourceFrame: (item.srcInFrame ?? 0) + (overlapStart - item.startFrame) * rate,
        playbackRate: rate,
        itemDuration: item.durationInFrames,
        offsetInItem: overlapStart - item.startFrame,
        fadeInFrames: Math.max(0, Number(item.fadeInFrames ?? 0)),
        fadeOutFrames: Math.max(0, Number(item.fadeOutFrames ?? 0)),
        gain,
        fromVideo: item.kind === 'video',
        ...(duckIntervals ? { duckIntervals, duckFactor } : {}),
        ...(crossfades?.length ? { crossfades } : {}),
        ...(volKeyframes?.length >= 2 ? { volumeKeyframes: volKeyframes } : {}),
      });
    }
  }

  const captionsEnabled = enabledCaptionTrackIndices.length > 0;
  const hasLegacyCaptions = state.captionsHidden !== true
    && Boolean(state.captions?.enabled)
    && !trackIds.some((id) => trackKind(state, id) === 'caption');
  const watermarkEnabled = Boolean(state.watermark?.enabled && state.watermark.text?.trim());
  const visibleOverlayInRange = visibleOverlayItems.some(
    (it) => !(state.captionsHidden === true && it.kind === 'text')
      && it.startFrame < rangeEnd
      && it.startFrame + it.durationInFrames > rangeStart,
  );

  return {
    eligible: true,
    renderRoute: 'hybrid',
    hybridMode: compatSpans.length > 0 ? 'segmented-hybrid' : 'overlay-plates',
    fps: state.fps,
    width: state.width,
    height: state.height,
    outputWidth,
    outputHeight,
    fit: state.fit ?? 'contain',
    rangeStart,
    rangeEnd,
    frames,
    compatSpans,
    fastSpans,
    compatFrames,
    compatReasons,
    baseSegments,
    mosaics,
    audioSegments,
    hasCaptions: captionsEnabled || hasLegacyCaptions,
    hasWatermark: watermarkEnabled,
    hasOverlays: visibleOverlayInRange || captionsEnabled || hasLegacyCaptions || watermarkEnabled,
    state,
    _rebuildForExtraCompat: (extraRawCompatSpans) => {
      const merged = finalizeSegmentedGeometry({
        rangeStart,
        rangeEnd,
        frames,
        plannedTransitions,
        rawCompatSpans: [...rawCompatSpans, ...extraRawCompatSpans],
        allowCompatSpans: true,
      });
      if (merged.compatFrames >= frames) {
        return refusal(merged.compatReasons[0] ?? 'source-metadata');
      }
      const rebuiltBaseSegments = buildBaseSegmentsForSpans({
        fastSpans: merged.fastSpans,
        sortedVideos,
        transitionByOutgoingId,
        transitionByIncomingId,
      });
      if (merged.compatSpans.length > 0 && !rebuiltBaseSegments.some((s) => s.kind === 'video' || s.kind === 'transition')) {
        return refusal(merged.compatReasons[0] ?? 'source-metadata');
      }
      return {
        ...merged,
        baseSegments: rebuiltBaseSegments,
      };
    },
  };
}

/**
 * Create a derived state for rendering ONLY overlay plates (`captions`, `text`, `solid`, `image`, `svg`, `watermark`).
 * Moves stripped `video`, `audio`, and admitted `mosaic` items onto a hidden track instead of deleting them so caption items referencing
 * a video/audio item's `transcript` and `timelineDuration()` keep 100% identical timing!
 */
export function buildOverlayOnlyState(state) {
  const hiddenTrackId = '__cc_hidden_media__';
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
      item.kind === 'video' || item.kind === 'audio' || item.kind === 'mosaic'
        ? { ...item, track: hiddenTrackId }
        : item
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
  const tracks = state.tracks ?? {};
  const captionsHidden = state.captionsHidden === true;

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
    if (tracks[item.track]?.hidden) continue;
    if (captionsHidden && item.kind === 'text') continue;
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

    if (item.zoom || (item.effects?.length ?? 0) > 0) {
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

export function buildClipFilterChain(seg, segIdx, fps, width, height, options = {}) {
  const durationSec = (seg.frames / fps).toFixed(6);
  if (seg.kind === 'black') {
    return {
      usesInput: false,
      filter: `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSec},format=yuv420p,trim=end_frame=${seg.frames},setpts=PTS-STARTPTS,setsar=1[bv${segIdx}]`,
      outLabel: `[bv${segIdx}]`,
    };
  }
  const rate = seg.playbackRate ?? 1;
  const isRetimed = Math.abs(rate - 1) >= 1e-6;
  const vf = seg.visualFade;
  const loc0 = seg.clipLocalStart ?? 0;
  const loc1 = loc0 + seg.frames;
  const rawFadePre = vf ? Math.max(
    0,
    vf.fadeIn && vf.fadeIn.until > loc0 && vf.fadeIn.from < loc0 ? Math.round(loc0 - vf.fadeIn.from) : 0,
    vf.fadeOut && vf.fadeOut.until > loc0 && vf.fadeOut.from < loc0 ? Math.round(loc0 - vf.fadeOut.from) : 0,
  ) : 0;

  let fadePre = 0;
  let seekSec = 0;
  const steps = [];
  if (!isRetimed) {
    fadePre = Math.min(seg.sourceFrame, rawFadePre);
    const preroll = Math.min(seg.sourceFrame - fadePre, PREROLL_FRAMES);
    const localTrimStart = preroll;
    const localTrimEnd = localTrimStart + fadePre + seg.frames;
    const fpsPrefix = Number.isFinite(seg.sourceFps) && Math.abs(seg.sourceFps - fps) > 0.05 ? `fps=${fps},` : '';
    steps.push(`${fpsPrefix}trim=start_frame=${localTrimStart}:end_frame=${localTrimEnd}`, 'setpts=PTS-STARTPTS', 'setsar=1');
    seekSec = (seg.sourceFrame - fadePre - preroll) / fps;
  } else {
    fadePre = Math.min(Math.floor(seg.sourceFrame / rate), rawFadePre);
    const srcStartFrame = Math.max(0, seg.sourceFrame - fadePre * rate);
    const seekFrameInt = Math.max(0, Math.floor(srcStartFrame) - PREROLL_FRAMES);
    seekSec = seekFrameInt / fps;
    const relStartSec = Math.max(0, (srcStartFrame - seekFrameInt) / fps);
    const relDurSec = ((fadePre + seg.frames) * rate) / fps;
    steps.push(
      `trim=start=${relStartSec.toFixed(6)}:end=${(relStartSec + relDurSec + 0.1).toFixed(6)}`,
      `setpts=(PTS-STARTPTS)/${rate.toFixed(6)}`,
      `fps=${fps}`,
      'tpad=stop_mode=clone:stop_duration=0.1',
      `trim=end_frame=${fadePre + seg.frames}`,
      'setpts=PTS-STARTPTS',
      'setsar=1',
    );
  }
  if (seg.sourcePixFmt && seg.sourcePixFmt !== 'yuv420p') {
    const inRange = seg.sourceColorRange === 'pc' ? 'pc' : 'tv';
    steps.push(`scale=in_range=${inRange}:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int`, 'format=yuv420p');
  }

  const crop = seg.transform?.crop;
  const cx = crop ? crop.x : 0;
  const cy = crop ? crop.y : 0;
  const cw = crop ? crop.width : width;
  const ch = crop ? crop.height : height;
  if (cw <= 0 || ch <= 0) {
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
  if (visW <= 0 || visH <= 0) {
    return {
      usesInput: false,
      filter: `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSec},format=yuv420p,trim=end_frame=${seg.frames},setpts=PTS-STARTPTS,setsar=1[bv${segIdx}]`,
      outLabel: `[bv${segIdx}]`,
    };
  }

  const blurs = seg.localGaussianBlurs ?? [];
  const sourceWidth = Number(seg.sourceWidth ?? width);
  const sourceHeight = Number(seg.sourceHeight ?? height);
  let frameW = width;
  let frameH = height;
  let needsLetterboxPad = false;
  if (sourceWidth !== width || sourceHeight !== height) {
    if (seg.fit !== 'cover' && blurs.length > 0) {
      const ratio = Math.min(width / sourceWidth, height / sourceHeight);
      frameW = Math.max(2, Math.round(sourceWidth * ratio));
      frameH = Math.max(2, Math.round(sourceHeight * ratio));
      steps.push(`scale=${frameW}:${frameH}:flags=lanczos`);
      needsLetterboxPad = frameW !== width || frameH !== height;
    } else {
      const mode = seg.fit === 'cover' ? 'increase' : 'decrease';
      const scale = `scale=${width}:${height}:force_original_aspect_ratio=${mode}:flags=lanczos`;
      steps.push(seg.fit === 'cover'
        ? `${scale},crop=${width}:${height}`
        : `${scale},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
  }

  const rgbInSteps = ['scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int', 'format=rgb24'];
  const rgbOutSteps = ['scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuv420p'];

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

  const f = seg.filters;
  const opacity = seg.transform?.opacity ?? 1;
  if (f || opacity < 1) {
    activeSteps.push(...rgbInSteps);
    if (f && f.brightness !== 1) {
      const b = f.brightness;
      activeSteps.push(`lutrgb=r='clip(val*${b},0,255)':g='clip(val*${b},0,255)':b='clip(val*${b},0,255)'`);
    }
    if (f && f.contrast !== 1) {
      const c = f.contrast;
      activeSteps.push(`lutrgb=r='clip(127.5+${c}*(val-127.5),0,255)':g='clip(127.5+${c}*(val-127.5),0,255)':b='clip(127.5+${c}*(val-127.5),0,255)'`);
    }
    if (f && f.saturate !== 1) {
      const s = f.saturate;
      const rr = (0.2126 + 0.7874 * s).toFixed(6);
      const rg = (0.7152 - 0.7152 * s).toFixed(6);
      const rb = (0.0722 - 0.0722 * s).toFixed(6);
      const gr = (0.2126 - 0.2126 * s).toFixed(6);
      const gg = (0.7152 + 0.2848 * s).toFixed(6);
      const gb = (0.0722 - 0.0722 * s).toFixed(6);
      const br = (0.2126 - 0.2126 * s).toFixed(6);
      const bg = (0.7152 - 0.7152 * s).toFixed(6);
      const bb = (0.0722 + 0.9278 * s).toFixed(6);
      activeSteps.push(`colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`);
    }
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
    filter: fullFilter,
    outLabel: `[bv${segIdx}]`,
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

async function encodeChunk({
  chunk, chunkIdx, plan, sources, plateFiles, blankPngPath, temporary, blurMaskCache, ffmpegExecutable,
  h264Profile, videoBitrate, vaapiDevice, renderArgsOverride, onChunkFrame, checkResources, signal, run = directCutCommand,
}) {
  const { fps, width, height, outputWidth, outputHeight } = plan;
  const chunkFrames = chunk.to - chunk.from;
  const chunkSegs = sliceBaseSegments(plan.baseSegments, chunk.from, chunk.to);
  const chunkSpans = sliceOverlaySpans(chunk.spans, chunk.from, chunk.to);
  const hasAnyOverlay = chunkSpans.some((s) => s.sampleFrame !== null);

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
      resolveLutPath: (relPath) => defaultResolveLutPath(relPath, options.assetsDirectory),
    });
    if (chain.usesInput) {
      const file = sources.get(videoSeg.src).file;
      const videoInputIdx = inputIdx++;
      args.push('-ss', chain.seekSec.toFixed(6), '-i', file);
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

  const chunkMosaics = (plan.mosaics ?? []).filter((m) => m.endFrame > chunk.from && m.startFrame < chunk.to);
  for (let mi = 0; mi < chunkMosaics.length; mi++) {
    const m = chunkMosaics[mi];
    if ((m.opacity ?? 1) <= 0 || m.w < 2 || m.h < 2) continue;
    const localStart = Math.max(0, m.startFrame - chunk.from);
    const localEnd = Math.min(chunkFrames - 1, m.endFrame - 1 - chunk.from);
    if (localEnd < localStart) continue;
    const needsMask = m.shape === 'ellipse' || (m.feather ?? 0) > 0 || (m.opacity ?? 1) < 1;
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
      filters.push(
        `${baseOutLabel}split=2[mb${mi}][mr${mi}]`,
        `[mr${mi}]format=yuv444p,crop=${pw}:${ph}:${px0}:${py0},${blurStep},crop=${m.w}:${m.h}:${ix}:${iy},format=yuva444p[mblur${mi}]`,
        `[${maskIdx}:v]format=gray[mmask${mi}]`,
        `[mblur${mi}][mmask${mi}]alphamerge=eof_action=repeat[ma${mi}]`,
        `[mb${mi}][ma${mi}]overlay=${m.x0}:${m.y0}:enable='between(n,${localStart},${localEnd})':format=yuv420[mbase${mi}]`,
      );
    } else {
      filters.push(
        `${baseOutLabel}split=2[mb${mi}][mr${mi}]`,
        `[mr${mi}]format=yuv444p,crop=${pw}:${ph}:${px0}:${py0},${blurStep},crop=${m.w}:${m.h}:${ix}:${iy}[mblur${mi}]`,
        `[mb${mi}][mblur${mi}]overlay=${m.x0}:${m.y0}:enable='between(n,${localStart},${localEnd})':format=yuv420[mbase${mi}]`,
      );
    }
    baseOutLabel = `[mbase${mi}]`;
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
  const rawArgs = [
    ...args,
    '-filter_complex', filters.join(';'),
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

async function renderAudioTrack({ plan, sources, temporary, ffmpegExecutable, checkResources, signal, run = directCutCommand }) {
  if (!plan.audioSegments.length) return null;
  const { fps, rangeStart, frames } = plan;
  const sampleRate = 48000;
  const totalSamples = Math.round((frames / fps) * sampleRate);
  const lanes = packAudioLanes(plan.audioSegments);
  const laneWavs = [];

  for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
    const segs = lanes[laneIdx];
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    const filters = [];
    const concatLabels = [];
    let cursorFrame = rangeStart;
    let inputIdx = 0;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.timelineStartFrame > cursorFrame) {
        const gapSamples = Math.round(((seg.timelineStartFrame - cursorFrame) / fps) * sampleRate);
        if (gapSamples > 0) {
          filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${gapSamples},asetpts=PTS-STARTPTS[agap${i}]`);
          concatLabels.push(`[agap${i}]`);
        }
      }
      const file = sources.get(seg.src).file;
      const rate = seg.playbackRate ?? 1;
      const startSec = seg.sourceFrame / fps;
      const durSec = (seg.frames * rate) / fps;
      args.push('-ss', startSec.toFixed(6), '-t', (durSec + 0.1).toFixed(6), '-i', file);
      const targetSamples = Math.round((seg.frames / fps) * sampleRate);
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
      cursorFrame = seg.timelineStartFrame + seg.frames;
    }

    if (cursorFrame < plan.rangeEnd) {
      const tailSamples = Math.max(0, Math.round(((plan.rangeEnd - cursorFrame) / fps) * sampleRate));
      if (tailSamples > 0) {
        filters.push(`anullsrc=r=${sampleRate}:cl=stereo,atrim=end_sample=${tailSamples},asetpts=PTS-STARTPTS[atail]`);
        concatLabels.push('[atail]');
      }
    }

    const wavPath = path.join(temporary, `audio-lane-${laneIdx}.wav`);
    const combinedFilter = concatLabels.length === 1
      ? `${filters.join(';')};${concatLabels[0]}atrim=end_sample=${totalSamples}[aout]`
      : `${filters.join(';')};${concatLabels.join('')}concat=n=${concatLabels.length}:v=0:a=1,atrim=end_sample=${totalSamples}[aout]`;

    await run(ffmpegExecutable, [
      ...args,
      '-filter_complex', combinedFilter,
      '-map', '[aout]',
      '-c:a', 'pcm_f32le',
      '-ar', String(sampleRate),
      '-ac', '2',
      '-y', wavPath,
    ], { signal, timeoutMs: 300_000, collect: false, checkResources });
    laneWavs.push(wavPath);
  }

  if (laneWavs.length === 1) return laneWavs[0];
  const mixedWav = path.join(temporary, 'audio-mixed.wav');
  const mixArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  for (const wav of laneWavs) mixArgs.push('-i', wav);
  mixArgs.push(
    '-filter_complex', `amix=inputs=${laneWavs.length}:normalize=0:dropout_transition=0,atrim=end_sample=${totalSamples}[amixout]`,
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

function hybridVideoSourceSupported(metadata, plan, segments) {
  const streams = metadata?.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === 'video');
  const video = videos[0];
  const avgRate = probeRate(video?.avg_frame_rate);
  const realRate = probeRate(video?.r_frame_rate);
  if (videos.length !== 1 || !SUPPORTED_HYBRID_VIDEO_CODECS.has(video?.codec_name)
    || !OPAQUE_HYBRID_PIX_FMTS.test(video?.pix_fmt ?? '')
    || !integer(video.width, 2) || !integer(video.height, 2)
    || !(avgRate > 0 && avgRate <= 240) || !(realRate > 0 && realRate <= 240)
    || !['1:1', undefined].includes(video.sample_aspect_ratio)
    || !['progressive', 'unknown', undefined].includes(video.field_order)
    || Math.abs(Number(video.start_time ?? 0)) > 0.5
    || Math.abs(Number(metadata.format?.start_time ?? 0)) > 0.5) return false;
  const rawRot = video.tags?.rotate ?? video.side_data_list?.find((d) => Number.isFinite(Number(d.rotation)))?.rotation ?? 0;
  const normRot = ((Math.round(Number(rawRot) || 0) % 360) + 360) % 360;
  const swapped = normRot === 90 || normRot === 270;
  const dispW = swapped ? video.height : video.width;
  const dispH = swapped ? video.width : video.height;
  const sourceFrames = Number(video.nb_frames);
  const duration = Number(video.duration ?? metadata.format?.duration);
  const segConsumed = (s) => Math.ceil(s.frames * (s.playbackRate ?? 1));
  if (integer(sourceFrames, 1)) {
    if (segments.some((s) => s.sourceFrame + segConsumed(s) > sourceFrames)) return false;
  } else if (!(duration > 0) || segments.some((s) => (s.sourceFrame + segConsumed(s)) / plan.fps > duration + 0.1)) return false;
  for (const segment of segments) Object.assign(segment, {
    sourceWidth: dispW,
    sourceHeight: dispH,
    sourceFps: avgRate,
    sourcePixFmt: video.pix_fmt,
    sourceColorRange: video.color_range,
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

    // Resolve .cube LUT paths before probing.
    for (const seg of baseVideoLeafSegs) {
      for (const eff of seg.localGaussianBlurs ?? []) {
        if (eff.kind === 'lut3d') {
          const resolved = options.resolveLutPath?.(eff.cubeRelPath) ?? defaultResolveLutPath(eff.cubeRelPath, assetsDirectory);
          if (!resolved) {
            if (!allowCompatSpans) return { declineReason: 'video-clip-effects' };
            extraCompat.push({ from: seg.timelineFrame, to: seg.timelineFrame + seg.frames, compatAudio: false, reason: 'video-clip-effects' });
          } else {
            eff.cubePath = resolved;
          }
        }
      }
    }

    const allSrcs = new Set([
      ...baseVideoLeafSegs.map((s) => s.src),
      ...plan.audioSegments.map((s) => s.src),
    ]);

    for (const src of allSrcs) {
      const videoSegs = baseVideoLeafSegs.filter((s) => s.src === src);
      const audioSegs = plan.audioSegments.filter((s) => s.src === src);
      const markBadSrc = (reason, audioBad) => {
        for (const s of videoSegs) extraCompat.push({ from: s.timelineFrame, to: s.timelineFrame + s.frames, compatAudio: audioBad, reason });
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
        && [1, 2].includes(audioStream.channels)
        && Math.abs(Number(audioStream.start_time ?? 0)) <= 0.5
        && Math.abs(Number(metadata.format?.start_time ?? 0)) <= 0.5
        && Number(audioStream.sample_rate) > 0
        && remainingAudioSegs.every((s) => Number(audioStream.duration) >= (s.sourceFrame + s.frames * (s.playbackRate ?? 1)) / plan.fps - 0.1)
      );
      const videoOk = !videoSegs.length || hybridVideoSourceSupported(metadata, plan, videoSegs);
      if (!videoOk || !audioOk) {
        if (!allowCompatSpans) return { declineReason: 'source-metadata' };
        markBadSrc('source-metadata', !audioOk);
        continue;
      }
      const vStream = metadata.streams?.find((s) => s.codec_type === 'video');
      const firstSeg = videoSegs[0];
      sources.set(src, {
        file,
        hasAudio: Boolean(audioStream),
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

export function splitOutputChunks(totalStart, totalEnd, workerCount, baseSegments = []) {
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
    const overlayState = buildOverlayOnlyState(plan.state);
    const plateResult = await renderOverlayPlates({
      overlayState,
      originalState: plan.state,
      plan,
      platesDir,
      onPhaseProgress: (renderedCount, totalPlateCount) => {
        const plateWeight = totalPlateCount > 0 ? Math.min(0.45, Math.max(0.05, totalPlateCount / (totalPlateCount + plan.frames * 0.25))) : 0;
        const frac = totalPlateCount > 0 ? renderedCount / totalPlateCount : 1;
        onProgress?.(frac * plateWeight);
      },
      signal,
    });
    const platesMs = Date.now() - platesStart;

    signal.throwIfAborted();
    const { spans, plateFiles } = plateResult;
    const plateWeight = plateFiles.size > 0
      ? Math.min(0.45, Math.max(0.05, plateFiles.size / (plateFiles.size + plan.frames * 0.25)))
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
          for (const sub of splitOutputChunks(piece.from, piece.to, workerCount, pieceSegs)) {
            chunks.push({ kind: 'fast', from: sub.from, to: sub.to, spans });
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
        await run(ffmpegExecutable, [
          ...spliceArgs,
          '-filter_complex', spliceFilter,
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
      plateCount: plateFiles.size,
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
