/**
 * Shared pure H.264 hybrid/route capability planner used identically by:
 * - Browser export preflight UI (`src/export/exportPreflight.ts`)
 * - Server export capability & preflight API (`remotion/render.mjs` -> `POST /export/capabilities`)
 * - Native FFmpeg segmented-hybrid executor (`remotion/overlay-hybrid.mjs`)
 *
 * Pure track-geometry planner: ZERO Node builtins, ZERO filesystem calls, ZERO React hooks.
 */
import {
  neutralPictureProps,
  pictureAnimationTiming,
  pictureOnlyProps,
} from './picture-animation-timing.mjs';
import {
  compileAudioSchedule,
  hasPotentialClipAudio,
  isVisualOverlayItemVisible,
  resolveAudioCrossfadePlans,
  resolveTrackRouting,
  trackKindForSchedule,
} from './timeline-media-schedule.mjs';

export const OVERLAY_KINDS = new Set(['text', 'solid', 'image', 'svg', 'gif']);
export const SUPPORTED_HYBRID_TRANSITIONS = new Set(['cross-dissolve', 'dip-to-black']);
export const BASE_FILTER_KEYS = new Set(['brightness', 'contrast', 'saturate', 'blur']);
export const LOCAL_GAUSSIAN_BLUR_ASSET_ID = 'builtin:fx-local-gaussian-blur';
export const LOCAL_MOSAIC_ASSET_ID = 'builtin:fx-local-mosaic';
export const PIXELATE_ASSET_ID = 'builtin:fx-pixelate';
export const RECT_MASK_ASSET_ID = 'builtin:fx-rect-mask';
export const CIRCLE_MASK_ASSET_ID = 'builtin:fx-circle-mask';
export const CUBE_LUT_ASSETS = {
  'builtin:slog3-s709': 'luts/Sony_Slog3_s709.cube',
  'builtin:canon-log3-709': 'luts/CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube',
};
export const CLIP_EFFECT_KEYS = new Set(['id', 'assetId', 'overrides', 'mosaicTrack']);
export const LOCAL_GAUSSIAN_BLUR_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'width_ratio', 'height_ratio', 'strength', 'feather']);
export const LOCAL_MOSAIC_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'width_ratio', 'height_ratio', 'block_size', 'feather']);
export const PIXELATE_OVERRIDE_KEYS = new Set(['blockSize']);
export const RECT_MASK_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'width', 'height', 'corner_radius', 'feather', 'invert']);
export const CIRCLE_MASK_OVERRIDE_KEYS = new Set(['center_x', 'center_y', 'radius', 'feather', 'invert']);
export const LUT_OVERRIDE_KEYS = new Set(['intensity']);
export const CLIP_MASK_KEYS = new Set(['type', 'x', 'y', 'width', 'height', 'feather']);
export const TRACK_ORDER_DEFAULT = ['V2', 'V1', 'A1', 'A2'];
export const MAX_SIMULTANEOUS_VIDEO_LAYERS = 4;
export const COMPAT_MIN_FAST_GAP_FRAMES = 15;

const integer = (value, min = 0) => Number.isInteger(value) && value >= min;
const finiteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hasOwnKeys = (value) => value != null && typeof value === 'object' && Object.keys(value).some((k) => value[k] !== undefined);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const refusal = (reason, extra = undefined) => ({
  eligible: false,
  reason,
  renderRoute: null,
  ...(extra ?? {}),
});

export function trackKind(state, id) {
  return trackKindForSchedule(state, id);
}

export function timelineTrackIds(state) {
  const ids = Array.isArray(state.trackOrder) ? [...state.trackOrder] : [...TRACK_ORDER_DEFAULT];
  for (const id of Object.keys(state.tracks ?? {})) if (!ids.includes(id)) ids.push(id);
  for (const item of state.items ?? []) if (!ids.includes(item.track)) ids.push(item.track);
  return ids;
}

export function defaultVideoTrackId(state) {
  const ids = timelineTrackIds(state);
  const explicitMain = state.interaction?.mainTrackId;
  const resolvedMain = explicitMain && ids.includes(explicitMain) && trackKind(state, explicitMain) === 'video'
    ? explicitMain
    : ids.toReversed().find((candidate) => trackKind(state, candidate) === 'video') ?? null;
  const isTextOrEffect = (id) => {
    if (trackKind(state, id) !== 'video') return false;
    if (resolvedMain && id === resolvedMain) return false;
    const role = state.tracks?.[id]?.visualRole;
    if (role === 'text' || role === 'effect') return true;
    const onTrack = (state.items ?? []).filter((it) => it.track === id);
    return onTrack.length > 0 && onTrack.every((it) => it.kind === 'text');
  };
  const pictureIds = ids.filter((id) => trackKind(state, id) === 'video' && !isTextOrEffect(id));
  const candidates = ids.filter((id) => trackKind(state, id) === 'video');
  const v1 = candidates.find((id) => {
    const idx = candidates.indexOf(id);
    return `V${candidates.length - idx}` === 'V1' || id === 'V1';
  });
  if (v1 && !isTextOrEffect(v1)) return v1;
  return pictureIds.at(-1) ?? null;
}

const BG_FILL_STOPS = [
  { strength: 0, blurRatio: 0, minBlurPx: 0, maxBlurPx: 0, brightness: 1, saturate: 1 },
  { strength: 25, blurRatio: 0.02, minBlurPx: 14, maxBlurPx: 40, brightness: 0.82, saturate: 0.96 },
  { strength: 50, blurRatio: 0.035, minBlurPx: 24, maxBlurPx: 64, brightness: 0.72, saturate: 0.9 },
  { strength: 75, blurRatio: 0.05, minBlurPx: 34, maxBlurPx: 84, brightness: 0.68, saturate: 0.88 },
  { strength: 100, blurRatio: 0.065, minBlurPx: 44, maxBlurPx: 108, brightness: 0.64, saturate: 0.84 },
];

export function resolveBackgroundFillAppearance(item, width, height) {
  const rawStrength = item?.backgroundFillStrength;
  const strength = typeof rawStrength === 'number' && Number.isInteger(rawStrength) && rawStrength >= 0 && rawStrength <= 100
    ? rawStrength
    : 50;
  const foundIdx = BG_FILL_STOPS.findIndex((s) => strength <= s.strength);
  const upperIdx = foundIdx < 0 ? BG_FILL_STOPS.length - 1 : foundIdx;
  const upper = BG_FILL_STOPS[upperIdx];
  let def = upper;
  if (upperIdx > 0) {
    const lower = BG_FILL_STOPS[upperIdx - 1];
    const p = (strength - lower.strength) / (upper.strength - lower.strength);
    const lerp = (a, b) => a + (b - a) * p;
    def = {
      blurRatio: lerp(lower.blurRatio, upper.blurRatio),
      minBlurPx: lerp(lower.minBlurPx, upper.minBlurPx),
      maxBlurPx: lerp(lower.maxBlurPx, upper.maxBlurPx),
      brightness: lerp(lower.brightness, upper.brightness),
      saturate: lerp(lower.saturate, upper.saturate),
    };
  }
  const shortSide = Math.max(1, Math.min(width, height));
  const blurPx = Math.max(def.minBlurPx, Math.min(def.maxBlurPx, Math.round(shortSide * def.blurRatio)));
  return {
    blurPx,
    brightness: def.brightness,
    saturate: def.saturate,
    overscanScale: 1 + (blurPx * 4) / shortSide,
  };
}

export function hasNonVolumeKeyframes(keyframes) {
  if (!keyframes || typeof keyframes !== 'object') return false;
  return Object.entries(keyframes).some(([prop, frames]) => prop !== 'volume' && Array.isArray(frames) && frames.length > 0);
}

export function resolveAudioVolumeKeyframes(keyframes) {
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

export function hasAnyKeyframes(keyframes) {
  if (!keyframes || typeof keyframes !== 'object') return false;
  return Object.values(keyframes).some((frames) => Array.isArray(frames) && frames.length > 0);
}

export function resolveFlexCrop(crop, width, height) {
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

export function resolveStaticCompositionMosaic(item, width, height) {
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
  const fadeInFrames = Number(item.fadeInFrames ?? 0);
  const fadeOutFrames = Number(item.fadeOutFrames ?? 0);
  if (!Number.isFinite(fadeInFrames) || fadeInFrames < 0 || !Number.isFinite(fadeOutFrames) || fadeOutFrames < 0) {
    return null;
  }
  if (hasAnyKeyframes(item.keyframes) || hasOwnKeys(item.zoom) || (item.effects?.length ?? 0) > 0
    || item.backgroundFill || hasOwnKeys(item.mask) || item.filters) {
    return null;
  }
  if (!neutralPictureProps(item)) return null;
  let sx = 1;
  let sy = 1;
  let tx = 0;
  let ty = 0;
  let trOpacity = 1;
  if (item.transform && typeof item.transform === 'object') {
    const tr = item.transform;
    sx = Number(tr.scaleX ?? tr.scale ?? 1);
    sy = Number(tr.scaleY ?? tr.scale ?? 1);
    tx = Number(tr.x ?? 0);
    ty = Number(tr.y ?? 0);
    trOpacity = Number(tr.opacity ?? 1);
    if (Number(tr.rotation ?? 0) !== 0 || Number(tr.borderRadius ?? 0) !== 0
      || !Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0
      || !Number.isFinite(tx) || !Number.isFinite(ty)
      || !Number.isFinite(trOpacity) || trOpacity < 0 || trOpacity > 1
      || resolveFlexCrop(tr.crop, width, height)) {
      return null;
    }
    if (m.feather > 0 && Math.abs(sx - sy) > 1e-4) return null;
  }
  const effCx = width / 2 + (tx * width) / 100 + (m.centerX - 0.5) * width * sx;
  const effCy = height / 2 + (ty * height) / 100 + (m.centerY - 0.5) * height * sy;
  const rawW = m.width * width * sx;
  const rawH = m.height * height * sy;
  const rawX = effCx - rawW / 2;
  const rawY = effCy - rawH / 2;
  const x0 = Math.max(0, Math.round(rawX));
  const y0 = Math.max(0, Math.round(rawY));
  const x1 = Math.min(width, Math.round(rawX + rawW));
  const y1 = Math.min(height, Math.round(rawY + rawH));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return null;
  const sigma = Math.max(1, Math.round(clamp(m.strength, 1, 100) * 0.24));
  const effFeather = m.feather > 0 ? m.feather * sx : 0;
  const effOpacity = m.opacity * trOpacity;
  return {
    kind: 'mosaic',
    shape: m.shape,
    x0,
    y0,
    w,
    h,
    localCx: effCx - x0,
    localCy: effCy - y0,
    halfW: rawW / 2,
    halfH: rawH / 2,
    sigma,
    feather: effFeather,
    opacity: effOpacity,
    fadeInFrames: Math.round(fadeInFrames),
    fadeOutFrames: Math.round(fadeOutFrames),
    startFrame: item.startFrame,
    endFrame: item.startFrame + item.durationInFrames,
    track: item.track,
  };
}

export function resolveBaseTransform(transform, canvasW, canvasH) {
  if (!transform || typeof transform !== 'object') return null;
  const rotation = Number(transform.rotation ?? 0);
  const borderRadius = Math.max(0, Number(transform.borderRadius ?? 0));
  const scaleX = Number(transform.scaleX ?? transform.scale ?? 1);
  const scaleY = Number(transform.scaleY ?? transform.scale ?? 1);
  const x = Number(transform.x ?? 0);
  const y = Number(transform.y ?? 0);
  const opacity = clamp(Number(transform.opacity ?? 1), 0, 1);
  const crop = resolveFlexCrop(transform.crop, canvasW, canvasH);
  if (![rotation, borderRadius, scaleX, scaleY, x, y, opacity].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) {
    return { unsupported: 'transform-invalid' };
  }
  return { scaleX, scaleY, x, y, rotation, borderRadius, opacity, crop };
}

export function resolveBaseFilters(filters) {
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

export function resolveBaseClipEffects(effects) {
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

export function resolveBaseClipMask(mask, width, height) {
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

const hasActiveVideoStyling = (props) => {
  if (!props || typeof props !== 'object') return false;
  return Number(props.bottomFade) > 0
    || Number(props.singleSideFade) > 0
    || Number(props.edgeFade) > 0
    || props.dropShadow === true
    || props.archivalCard === true;
};

export function resolveBaseVisualFade(item) {
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

export function resolveBaseTimelineState({ state, project, timelineId }) {
  if (project && timelineId) {
    const timeline = project.timelines?.find((entry) => entry.id === timelineId);
    if (!timeline) return null;
    return { ...timeline, assets: project.assets ?? timeline.assets };
  }
  return state;
}

export function mergeCompatSpans(rawSpans, rangeStart, rangeEnd) {
  const clipped = [];
  const collectNames = (sp) => {
    const names = [];
    if (Array.isArray(sp.itemNames)) {
      for (const n of sp.itemNames) if (typeof n === 'string' && n.trim() && !names.includes(n.trim())) names.push(n.trim());
    }
    if (typeof sp.itemName === 'string' && sp.itemName.trim() && !names.includes(sp.itemName.trim())) {
      names.push(sp.itemName.trim());
    }
    return names;
  };
  for (const sp of rawSpans) {
    const from = Math.max(rangeStart, Math.floor(sp.from));
    const to = Math.min(rangeEnd, Math.ceil(sp.to));
    if (to <= from) continue;
    clipped.push({
      from,
      to,
      compatAudio: Boolean(sp.compatAudio),
      reasons: new Set(sp.reasons ? sp.reasons : sp.reason ? [sp.reason] : []),
      itemNames: new Set(collectNames(sp)),
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
      for (const n of sp.itemNames) prev.itemNames.add(n);
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
      for (const n of sp.itemNames) prev.itemNames.add(n);
    } else {
      coalesced.push(sp);
    }
  }
  return coalesced.map((sp) => ({
    from: sp.from,
    to: sp.to,
    compatAudio: sp.compatAudio,
    reasons: [...sp.reasons],
    itemNames: [...sp.itemNames],
  }));
}

export function complementFastSpans(rangeStart, rangeEnd, compatSpans) {
  const out = [];
  let cursor = rangeStart;
  for (const sp of compatSpans) {
    if (sp.from > cursor) out.push({ from: cursor, to: sp.from });
    cursor = Math.max(cursor, sp.to);
  }
  if (cursor < rangeEnd) out.push({ from: cursor, to: rangeEnd });
  return out;
}

export function finalizeSegmentedGeometry({
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
          workingCompat.push({
            from: rec.winStart,
            to: rec.winEnd,
            compatAudio: false,
            reasons: ['transitions'],
            itemNames: [rec.incEntry?.item?.name || rec.outEntry?.item?.name].filter(Boolean),
          });
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

export function buildBaseSegmentsForSpans({
  fastSpans, sortedVideos, transitionByOutgoingId, transitionByIncomingId,
}) {
  const baseSegments = [];
  const makeVideoSegment = (entry, segStart, segEnd) => {
    const { item, rate, transform, filters, visualFade, backgroundFill, localGaussianBlurs, clipMask } = entry;
    const isSolidBlack = !backgroundFill && (transform?.opacity === 0 || filters?.brightness === 0);
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
        ...(backgroundFill ? { backgroundFill } : {}),
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
            ...(outEntry.backgroundFill ? { backgroundFill: outEntry.backgroundFill } : {}),
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
            ...(incEntry.backgroundFill ? { backgroundFill: incEntry.backgroundFill } : {}),
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
  const mainVideoTrackId = defaultVideoTrackId(state);
  const tracks = state.tracks ?? {};

  const visibleVideoItems = [];
  const allVisualVideoItems = [];
  const visibleOverlayItems = [];
  const visibleMosaicItems = [];
  const audioItems = [];
  const rawCompatSpans = [];
  const markCompat = (itemStart, itemDur, reason, compatAudio = false, itemName = undefined) => {
    const s = Math.max(rangeStart, itemStart);
    const e = Math.min(rangeEnd, itemStart + Math.max(1, itemDur));
    if (e > s) {
      rawCompatSpans.push({
        from: s,
        to: e,
        reason,
        compatAudio,
        ...(itemName ? { itemName } : {}),
      });
    }
  };

  for (const item of state.items) {
    if (!item || typeof item !== 'object') return refusal('invalid-item');
    const track = tracks[item.track];
    if (track?.hidden) continue;
    if (item.pictureDisabled === true) continue;
    if (!integer(item.startFrame) || !integer(item.durationInFrames, 1)) return refusal('item-timing');

    if (item.kind === 'sequence') {
      if (!allowCompatSpans) return refusal('nested-sequence');
      markCompat(item.startFrame, item.durationInFrames, 'nested-sequence', true, item.name);
      continue;
    }
    if (item.kind !== 'mosaic' && item.mosaic) {
      if (!allowCompatSpans) return refusal('composition-mosaic');
      markCompat(item.startFrame, item.durationInFrames, 'composition-mosaic', false, item.name);
    }

    if (item.kind === 'mosaic') {
      const resolved = resolveStaticCompositionMosaic(item, state.width, state.height);
      const cutInFadeIn = resolved && resolved.fadeInFrames > 0
        && resolved.startFrame < rangeStart && resolved.startFrame + resolved.fadeInFrames > rangeStart;
      const cutInFadeOut = resolved && resolved.fadeOutFrames > 0
        && resolved.endFrame - resolved.fadeOutFrames < rangeEnd && resolved.endFrame > rangeEnd;
      if (!resolved || cutInFadeIn || cutInFadeOut) {
        if (!allowCompatSpans) return refusal('composition-mosaic');
        markCompat(item.startFrame, item.durationInFrames, 'composition-mosaic', false, item.name);
      } else {
        visibleMosaicItems.push({ ...resolved, itemName: item.name });
      }
    } else if (item.kind === 'video') {
      if (!item.pictureDisabled) allVisualVideoItems.push(item);
      const rate = Number(item.playbackRate ?? 1);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
        if (!allowCompatSpans) return refusal('item-retimed');
        markCompat(item.startFrame, item.durationInFrames, 'item-retimed', hasPotentialClipAudio(item), item.name);
        continue;
      }
      const volKeyframes = resolveAudioVolumeKeyframes(item.keyframes);
      if (!item.pictureDisabled) {
        let videoCompatReason = null;
        const hasBgFill = item.backgroundFill === true && Boolean(item.src) && item.track === mainVideoTrackId;
        if (!item.src || !finiteNonNegative(item.srcInFrame ?? 0)) videoCompatReason = 'video-source';
        else if (hasNonVolumeKeyframes(item.keyframes) || hasOwnKeys(item.zoom)
          || (hasBgFill && (item.effects?.length ?? 0) > 0) || item.mosaic || hasActiveVideoStyling(item.props)) {
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
        const backgroundFill = (!videoCompatReason && hasBgFill)
          ? resolveBackgroundFillAppearance(item, state.width, state.height)
          : null;

        if (videoCompatReason) {
          if (!allowCompatSpans) return refusal(videoCompatReason);
          markCompat(item.startFrame, item.durationInFrames, videoCompatReason, false, item.name);
        } else {
          visibleVideoItems.push({ item, rate, transform, filters, visualFade, backgroundFill, localGaussianBlurs, clipMask });
        }
      }
      if (hasPotentialClipAudio(item)) {
        if (!item.src || !finiteNonNegative(item.srcInFrame ?? 0)) {
          if (!allowCompatSpans) return refusal('video-audio-source');
          markCompat(item.startFrame, item.durationInFrames, 'video-audio-source', true, item.name);
        } else if (volKeyframes?.unsupported) {
          if (!allowCompatSpans) return refusal('audio-processing');
          markCompat(item.startFrame, item.durationInFrames, 'audio-processing', true, item.name);
        } else {
          audioItems.push(Array.isArray(volKeyframes) ? { ...item, _volumeKeyframes: volKeyframes } : item);
        }
      }
    } else if (item.kind === 'audio') {
      if (!item.src || !finiteNonNegative(item.srcInFrame ?? 0)) {
        if (!allowCompatSpans) return refusal('audio-source');
        markCompat(item.startFrame, item.durationInFrames, 'audio-source', true, item.name);
        continue;
      }
      const rate = Number(item.playbackRate ?? 1);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
        if (!allowCompatSpans) return refusal('audio-retimed');
        markCompat(item.startFrame, item.durationInFrames, 'audio-retimed', true, item.name);
        continue;
      }
      const volKeyframes = resolveAudioVolumeKeyframes(item.keyframes);
      if (hasNonVolumeKeyframes(item.keyframes) || (item.effects?.length ?? 0) > 0 || volKeyframes?.unsupported) {
        if (!allowCompatSpans) return refusal('audio-processing');
        markCompat(item.startFrame, item.durationInFrames, 'audio-processing', true, item.name);
        continue;
      }
      audioItems.push({ ...item, _volumeKeyframes: Array.isArray(volKeyframes) ? volKeyframes : null });
    } else if (OVERLAY_KINDS.has(item.kind)) {
      visibleOverlayItems.push(item);
    } else {
      if (!allowCompatSpans) return refusal(`unsupported-kind:${item.kind}`);
      markCompat(item.startFrame, item.durationInFrames, `unsupported-kind:${item.kind}`, false, item.name);
    }
  }

  // Visual stacking check: classify overlays into top overlays, clean bottom underlays, or sandwiched compat.
  const underlayOverlayItems = [];
  const underlayItemIdSet = new Set();
  const topOverlayItems = [];
  for (const overlay of visibleOverlayItems) {
    const ovIdx = visualTrackIds.indexOf(overlay.track);
    const ovStart = overlay.startFrame;
    const ovEnd = ovStart + overlay.durationInFrames;
    if (ovIdx < 0) {
      if (!allowCompatSpans) return refusal('overlay-below-video');
      markCompat(ovStart, overlay.durationInFrames, 'overlay-below-video', false, overlay.name);
      continue;
    }
    const overlappingVideos = allVisualVideoItems.filter(
      (v) => v.startFrame < ovEnd && v.startFrame + v.durationInFrames > ovStart,
    );
    const videosBelowOrSame = overlappingVideos.filter((v) => {
      const vIdx = visualTrackIds.indexOf(v.track);
      return vIdx >= 0 && vIdx <= ovIdx;
    });
    if (videosBelowOrSame.length === 0) {
      topOverlayItems.push(overlay);
      continue;
    }
    const videoStrictlyBelow = overlappingVideos.some((v) => {
      const vIdx = visualTrackIds.indexOf(v.track);
      return vIdx > ovIdx;
    });
    const mosaicBelowOrSame = visibleMosaicItems.some((m) => {
      if (m.startFrame >= ovEnd || m.endFrame <= ovStart) return false;
      const mIdx = visualTrackIds.indexOf(m.track);
      return mIdx < 0 || mIdx >= ovIdx;
    });
    if (!videoStrictlyBelow && !mosaicBelowOrSame) {
      underlayOverlayItems.push(overlay);
      underlayItemIdSet.add(overlay.id);
    } else {
      if (!allowCompatSpans) return refusal('overlay-below-video');
      for (const vid of videosBelowOrSame) {
        const s = Math.max(rangeStart, ovStart, vid.startFrame);
        const e = Math.min(rangeEnd, ovEnd, vid.startFrame + vid.durationInFrames);
        if (e > s) {
          rawCompatSpans.push({
            from: s,
            to: e,
            reason: 'overlay-below-video',
            compatAudio: false,
            ...(overlay.name ? { itemName: overlay.name } : {}),
          });
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
  const candidateMosaics = [];
  for (const mosaic of visibleMosaicItems) {
    const mVisIdx = visualTrackIds.indexOf(mosaic.track);
    const mTrackIdx = trackIds.indexOf(mosaic.track);
    let invalidZ = mVisIdx < 0 || (maxCaptionTrackIdx >= 0 && mTrackIdx <= maxCaptionTrackIdx);
    if (!invalidZ) {
      for (const ov of visibleOverlayItems) {
        if (underlayItemIdSet.has(ov.id)) continue;
        if (ov.startFrame < mosaic.endFrame && ov.startFrame + ov.durationInFrames > mosaic.startFrame) {
          const ovVisIdx = visualTrackIds.indexOf(ov.track);
          if (ovVisIdx < 0 || ovVisIdx >= mVisIdx) {
            invalidZ = true;
            break;
          }
        }
      }
    }
    if (invalidZ) {
      if (!allowCompatSpans) return refusal('composition-mosaic');
      markCompat(mosaic.startFrame, mosaic.endFrame - mosaic.startFrame, 'composition-mosaic', false, mosaic.itemName);
    } else {
      candidateMosaics.push(mosaic);
    }
  }

  const bottomToTopVideos = [...visibleVideoItems].sort(
    (a, b) => visualTrackIds.indexOf(b.item.track) - visualTrackIds.indexOf(a.item.track) || a.item.startFrame - b.item.startFrame,
  );
  const baseVideoItems = [];
  const overlayVideoItems = [];
  for (const entry of bottomToTopVideos) {
    const it = entry.item;
    const itEnd = it.startFrame + it.durationInFrames;
    const vIdx = visualTrackIds.indexOf(it.track);
    const sameTrackOverlap = baseVideoItems.some(
      (b) => b.item.track === it.track && b.item.startFrame < itEnd && b.item.startFrame + b.item.durationInFrames > it.startFrame,
    );
    if (sameTrackOverlap) {
      if (!allowCompatSpans) return refusal('overlapping-base-video');
      markCompat(it.startFrame, it.durationInFrames, 'overlapping-base-video', false, it.name);
      continue;
    }
    const overlapsBase = baseVideoItems.some(
      (b) => b.item.startFrame < itEnd && b.item.startFrame + b.item.durationInFrames > it.startFrame,
    );
    const mosaicStrictlyBelow = candidateMosaics.some((m) => {
      const mIdx = visualTrackIds.indexOf(m.track);
      return mIdx > vIdx && m.startFrame < itEnd && m.endFrame > it.startFrame;
    });
    const overlapsUnderlay = underlayOverlayItems.some(
      (u) => u.startFrame < itEnd && u.startFrame + u.durationInFrames > it.startFrame,
    );
    if (!overlapsBase && !mosaicStrictlyBelow && !overlapsUnderlay) baseVideoItems.push(entry);
    else overlayVideoItems.push(entry);
  }

  const eligibleMosaics = [];
  for (const mosaic of candidateMosaics) {
    const mVisIdx = visualTrackIds.indexOf(mosaic.track);
    const baseAbove = baseVideoItems.some((b) => {
      const bIdx = visualTrackIds.indexOf(b.item.track);
      return bIdx >= 0 && bIdx < mVisIdx && b.item.startFrame < mosaic.endFrame && b.item.startFrame + b.item.durationInFrames > mosaic.startFrame;
    });
    if (baseAbove) {
      if (!allowCompatSpans) return refusal('composition-mosaic');
      markCompat(mosaic.startFrame, mosaic.endFrame - mosaic.startFrame, 'composition-mosaic', false, mosaic.itemName);
    } else {
      eligibleMosaics.push(mosaic);
    }
  }

  // Sweep line across all visual videos: native FFmpeg compositing supports up to MAX_SIMULTANEOUS_VIDEO_LAYERS.
  {
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
      if (activeCount > MAX_SIMULTANEOUS_VIDEO_LAYERS && overlapStart === null) overlapStart = pos;
      else if (activeCount <= MAX_SIMULTANEOUS_VIDEO_LAYERS && overlapStart !== null) {
        if (!allowCompatSpans) return refusal('overlapping-base-video');
        if (pos > overlapStart) {
          rawCompatSpans.push({ from: overlapStart, to: pos, reason: 'overlapping-base-video', compatAudio: false });
        }
        overlapStart = null;
      }
    }
  }

  const sortedVideos = [...baseVideoItems].sort((a, b) => a.item.startFrame - b.item.startFrame);
  const allOverlayVideos = overlayVideoItems
    .map((entry) => ({
      kind: 'overlay-video',
      id: entry.item.id,
      track: entry.item.track,
      startFrame: entry.item.startFrame,
      endFrame: entry.item.startFrame + entry.item.durationInFrames,
      srcInFrame: entry.item.srcInFrame ?? 0,
      rate: entry.rate,
      playbackRate: entry.rate,
      src: entry.item.src,
      transform: entry.transform,
      filters: entry.filters,
      visualFade: entry.visualFade,
      ...(entry.backgroundFill ? { backgroundFill: entry.backgroundFill } : {}),
      localGaussianBlurs: entry.localGaussianBlurs,
      clipMask: entry.clipMask,
    }))
    .sort((a, b) => visualTrackIds.indexOf(b.track) - visualTrackIds.indexOf(a.track) || a.startFrame - b.startFrame);

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
    const label = inc?.name || out?.name;
    if (out && inc && integer(out.startFrame) && integer(inc.startFrame)) {
      const L = integer(t.durationInFrames, 2) ? t.durationInFrames : 30;
      const half = Math.floor(L / 2);
      markCompat(inc.startFrame - half, L, 'transitions', false, label);
    } else if (out && integer(out.startFrame) && integer(out.durationInFrames, 1)) {
      markCompat(out.startFrame, out.durationInFrames, 'transitions', false, label);
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
      || (inc.srcInFrame ?? 0) < half * incEntry.rate - 1e-6
      || transitionByOutgoingId.has(out.id) || transitionByIncomingId.has(inc.id)) {
      if (!allowCompatSpans) return refusal('transitions');
      markCompat(winStart, L, 'transitions', false, inc.name || out.name);
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
      markCompat(winStart, L, 'transitions', false, inc.name || out.name);
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
      markCompat(plannedTransitions[i].winStart, plannedTransitions[i].L, 'transitions', false, plannedTransitions[i].incEntry?.item?.name);
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
    return refusal(compatReasons[0] ?? 'video-clip-effects', { compatSpans, compatReasons });
  }

  const baseSegments = buildBaseSegmentsForSpans({
    fastSpans,
    sortedVideos,
    transitionByOutgoingId,
    transitionByIncomingId,
  });

  const filterFastOverlayVideos = (spans) => allOverlayVideos.filter((ov) => (
    ov.endFrame > rangeStart
    && ov.startFrame < rangeEnd
    && spans.some((sp) => ov.endFrame > sp.from && ov.startFrame < sp.to)
  ));
  const filterFastMosaics = (spans) => eligibleMosaics
    .filter((m) => (
      m.endFrame > rangeStart
      && m.startFrame < rangeEnd
      && spans.some((sp) => m.endFrame > sp.from && m.startFrame < sp.to)
    ))
    .sort((a, b) => visualTrackIds.indexOf(b.track) - visualTrackIds.indexOf(a.track) || a.startFrame - b.startFrame);

  const overlayVideos = filterFastOverlayVideos(fastSpans);
  if (compatSpans.length > 0 && !baseSegments.some((s) => s.kind === 'video' || s.kind === 'transition') && overlayVideos.length === 0) {
    return refusal(compatReasons[0] ?? 'video-clip-effects', { compatSpans, compatReasons });
  }

  const mosaics = filterFastMosaics(fastSpans);

  const audioRouting = resolveTrackRouting(state, {
    anchorItems: audioItems,
    rangeStart,
    rangeEnd,
  });
  const crossfadePlans = resolveAudioCrossfadePlans(audioItems, audioTransitions, state.assets ?? []);
  const { audioSegments } = compileAudioSchedule(state, {
    audioItems,
    audioTransitions,
    rangeStart,
    rangeEnd,
    crossfadePlans,
    routing: audioRouting,
  });

  const captionsEnabled = enabledCaptionTrackIndices.length > 0;
  const hasLegacyCaptions = state.captionsHidden !== true
    && Boolean(state.captions?.enabled)
    && !trackIds.some((id) => trackKind(state, id) === 'caption');
  const watermarkEnabled = Boolean(state.watermark?.enabled && state.watermark.text?.trim());
  const visibleTopOverlayInRange = topOverlayItems.some(
    (it) => isVisualOverlayItemVisible(state, it)
      && it.startFrame < rangeEnd
      && it.startFrame + it.durationInFrames > rangeStart,
  );
  const visibleUnderlayInRange = underlayOverlayItems.some(
    (it) => isVisualOverlayItemVisible(state, it)
      && it.startFrame < rangeEnd
      && it.startFrame + it.durationInFrames > rangeStart,
  );
  const underlayItemIds = visibleUnderlayInRange ? underlayOverlayItems.map((it) => it.id) : [];

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
    overlayVideos,
    mosaics,
    visualTrackIds,
    audioSegments,
    hasCaptions: captionsEnabled || hasLegacyCaptions,
    hasWatermark: watermarkEnabled,
    hasOverlays: visibleTopOverlayInRange || captionsEnabled || hasLegacyCaptions || watermarkEnabled,
    hasUnderlays: visibleUnderlayInRange,
    underlayItemIds,
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
        return refusal(merged.compatReasons[0] ?? 'source-metadata', {
          compatSpans: merged.compatSpans,
          compatReasons: merged.compatReasons,
        });
      }
      const rebuiltBaseSegments = buildBaseSegmentsForSpans({
        fastSpans: merged.fastSpans,
        sortedVideos,
        transitionByOutgoingId,
        transitionByIncomingId,
      });
      const rebuiltOverlayVideos = filterFastOverlayVideos(merged.fastSpans);
      if (merged.compatSpans.length > 0 && !rebuiltBaseSegments.some((s) => s.kind === 'video' || s.kind === 'transition') && rebuiltOverlayVideos.length === 0) {
        return refusal(merged.compatReasons[0] ?? 'source-metadata', {
          compatSpans: merged.compatSpans,
          compatReasons: merged.compatReasons,
        });
      }
      return {
        ...merged,
        baseSegments: rebuiltBaseSegments,
        overlayVideos: rebuiltOverlayVideos,
        mosaics: filterFastMosaics(merged.fastSpans),
      };
    },
  };
}

export function formatCompatSpanDetails(compatSpans = [], fps = 30) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return compatSpans.map((sp) => ({
    fromFrame: sp.from,
    toFrame: sp.to,
    fromSeconds: Number((sp.from / safeFps).toFixed(1)),
    toSeconds: Number((sp.to / safeFps).toFixed(1)),
    reasons: [...(sp.reasons ?? [])],
    itemNames: [...(sp.itemNames ?? [])],
  }));
}

function hasAnimatedCaptionPreset(state, timelineFps, totalFrames) {
  if (state?.captionsHidden === true || totalFrames <= timelineFps * 60) return false;
  const trackEntries = [];
  for (const [id, tr] of Object.entries(state?.tracks ?? {})) {
    if (trackKind(state, id) === 'caption' && tr?.captions) {
      trackEntries.push({ id, captions: tr.captions, hidden: Boolean(tr.hidden) });
    }
  }
  if (!trackEntries.length && state?.captions) {
    trackEntries.push({ id: 'C1', captions: state.captions, hidden: Boolean(state?.tracks?.C1?.hidden) });
  }
  return trackEntries.some(({ captions, hidden }) => (
    captions?.enabled
    && !hidden
    && (captions.motionPreset === 'word-pop' || captions.motionPreset === 'karaoke-pulse')
  ));
}

/**
 * Derive unified preflight summary from a planned `planOverlayHybridExport` (and optional probe result).
 * Guarantees identical route classification and compat span details between UI preflight and actual export.
 */
export function summarizeExportPreflight({
  state: rawState,
  project,
  timelineId,
  codec = 'h264',
  fps = 30,
  frameRange,
  scale = 1,
  hybridPlan,
  fallbackReason,
  probeStatus,
} = {}) {
  const state = resolveBaseTimelineState({ state: rawState, project, timelineId }) ?? rawState;
  const timelineFps = Math.max(1, Number(state?.fps || fps || 30));
  const rawEnd = Math.max(
    timelineFps,
    (state?.items ?? []).reduce((max, it) => Math.max(max, (it?.startFrame ?? 0) + (it?.durationInFrames ?? 0)), 0),
  );
  const [from, to] = Array.isArray(frameRange) && frameRange.length === 2
    ? [Math.max(0, Math.floor(frameRange[0])), Math.min(rawEnd - 1, Math.floor(frameRange[1]))]
    : [0, rawEnd - 1];
  const totalFrames = Math.max(1, to >= from ? (to - from + 1) : rawEnd);
  const animatedCaptionWarning = hasAnimatedCaptionPreset(state, timelineFps, totalFrames);

  if (codec !== 'h264') {
    return {
      mode: 'compat',
      totalFrames,
      compatFrames: totalFrames,
      compatSeconds: Number((totalFrames / timelineFps).toFixed(1)),
      reasons: ['render-mode'],
      spanDetails: [],
      animatedCaptionWarning: false,
      ...(probeStatus ? { probeStatus } : {}),
    };
  }

  const plan = hybridPlan !== undefined
    ? hybridPlan
    : fallbackReason
      ? null
      : planOverlayHybridExport({
          state,
          codec,
          scale,
          frameRange,
          allowCompatSpans: true,
        });

  if (!plan?.eligible) {
    const reasons = plan?.compatReasons?.length
      ? [...plan.compatReasons]
      : fallbackReason
        ? [fallbackReason]
        : plan?.reason
          ? [plan.reason]
          : ['render-mode'];
    return {
      mode: 'compat',
      totalFrames,
      compatFrames: totalFrames,
      compatSeconds: Number((totalFrames / timelineFps).toFixed(1)),
      reasons,
      spanDetails: plan?.compatSpans?.length ? formatCompatSpanDetails(plan.compatSpans, timelineFps) : [],
      animatedCaptionWarning,
      ...(probeStatus ? { probeStatus } : {}),
    };
  }

  const compatFrames = plan.compatFrames ?? 0;
  const spanDetails = formatCompatSpanDetails(plan.compatSpans ?? [], timelineFps);
  const reasons = [...(plan.compatReasons ?? [])];
  const mode = compatFrames === 0 ? 'fast' : 'segmented';
  return {
    mode,
    totalFrames: plan.frames ?? totalFrames,
    compatFrames,
    compatSeconds: Number((compatFrames / timelineFps).toFixed(1)),
    reasons,
    spanDetails,
    animatedCaptionWarning,
    ...(probeStatus ? { probeStatus } : {}),
  };
}
