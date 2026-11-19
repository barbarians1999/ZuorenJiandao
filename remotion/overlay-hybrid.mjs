import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  checkDirectCutDisk,
  directCutCommand,
} from './direct-cut.mjs';
import { localVideoPath, opaqueNativeVideo } from './native-video.mjs';
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
const BASE_TRANSFORM_KEYS = new Set(['scale', 'scaleX', 'scaleY', 'x', 'y', 'rotation', 'opacity', 'borderRadius', 'crop']);
const BASE_FILTER_KEYS = new Set(['brightness', 'contrast', 'saturate', 'blur']);
const TRACK_ORDER_DEFAULT = ['V2', 'V1', 'A1', 'A2'];
const PREROLL_FRAMES = 60;
const CHUNK_TIMEOUT_MS = 600_000;
const FINALIZATION_TIMEOUT_MIN_MS = 180_000;
const FINALIZATION_TIMEOUT_MAX_MS = 45 * 60_000;
const GIB_BYTES = 1024 ** 3;

const integer = (value, min = 0) => Number.isInteger(value) && value >= min;
const refusal = (reason) => ({ eligible: false, reason, renderRoute: null });
const hasOwnKeys = (value) => value != null && typeof value === 'object' && Object.keys(value).some((k) => value[k] !== undefined);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function exportFinalizationTimeoutMs({ frames, fps, inputBytes = 0 } = {}) {
  const durationMs = Number.isFinite(frames) && frames > 0 && Number.isFinite(fps) && fps > 0
    ? frames / fps * 1000 : 0;
  const sizeGiB = Number.isFinite(inputBytes) && inputBytes > 0 ? inputBytes / GIB_BYTES : 0;
  return Math.min(FINALIZATION_TIMEOUT_MAX_MS, Math.max(FINALIZATION_TIMEOUT_MIN_MS,
    Math.ceil(FINALIZATION_TIMEOUT_MIN_MS + durationMs * 0.35 + sizeGiB * 180_000)));
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

function hasCompositionMosaic(state) {
  return (state.items ?? []).some((item) => {
    const track = state.tracks?.[item.track];
    if (track?.hidden) return false;
    return item.kind === 'mosaic' || Boolean(item.mosaic);
  });
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

function resolveBaseVisualFade(item) {
  if (neutralPictureProps(item)) return null;
  if (!pictureOnlyProps(item.props)) return { unsupported: true };
  const ent = item.props?.visualEntrance ?? 'none';
  const ex = item.props?.visualExit ?? 'none';
  if ((ent !== 'none' && ent !== 'fade') || (ex !== 'none' && ex !== 'fade')) {
    return { unsupported: true };
  }
  const timing = pictureAnimationTiming(item);
  const dur = item.durationInFrames;
  const fadeIn = timing.entrance && timing.entrance.until > 0 && timing.entrance.from < dur
    ? { from: timing.entrance.from, until: timing.entrance.until }
    : null;
  const fadeOut = timing.exit && timing.exit.until > 0 && timing.exit.from < dur
    ? { from: timing.exit.from, until: timing.exit.until }
    : null;
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

/**
 * Pure preflight planner for the Jianying-style decoupled export pipeline:
 * FFmpeg decodes/transforms/overlays base video + fades arbitrary audio lanes in parallel chunks,
 * while Chromium `renderFrames` renders transparent PNG plates ONLY on unique overlay sample frames.
 */
export function planOverlayHybridExport({
  state: rawState,
  project,
  timelineId,
  codec = 'h264',
  scale = 1,
  frameRange,
  separateAudioTo,
} = {}) {
  const state = resolveBaseTimelineState({ state: rawState, project, timelineId });
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) return refusal('invalid-state');
  for (const key of Object.keys(state)) if (!STATE_KEYS.has(key)) return refusal(`state:${key}`);
  if (codec !== 'h264' || scale !== 1 || separateAudioTo) return refusal('render-mode');
  if (!integer(state.fps, 1) || !integer(state.width, 2) || !integer(state.height, 2)
    || state.width % 2 !== 0 || state.height % 2 !== 0) {
    return refusal('composition-geometry');
  }
  if ((state.transitions?.length ?? 0) > 0) return refusal('transitions');
  if (hasCompositionMosaic(state)) return refusal('composition-mosaic');

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
  const visibleOverlayItems = [];
  const audioItems = [];
  let hasAnchorAudio = false;
  let hasActiveFollowerDucking = false;

  for (const item of state.items) {
    if (!item || typeof item !== 'object') return refusal('invalid-item');
    for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) return refusal(`item:${key}`);
    if (item.kind === 'sequence') return refusal('nested-sequence');
    if (item.kind === 'gif' || item.kind === 'mosaic') return refusal(`unsupported-kind:${item.kind}`);

    const track = tracks[item.track];
    if (track?.hidden) continue;
    if (!integer(item.startFrame) || !integer(item.durationInFrames, 1)) return refusal('item-timing');

    if (item.kind === 'video') {
      if ((item.playbackRate ?? 1) !== 1) return refusal('item-retimed');
      if (item.deletedWordIdx?.length || item.transcriptPlayOrder?.length || item.silenceFrames != null
        || item.cutPadFrames != null || item.gapCapsMs != null || item.denoisedSrc) {
        return refusal('item-speech-edited');
      }
      if (!item.pictureDisabled) {
        if (!item.src || !integer(item.srcInFrame ?? 0)) return refusal('video-source');
        if (item.fadeInFrames || item.fadeOutFrames) return refusal('video-visual-fade');
        if (hasAnyKeyframes(item.keyframes) || hasOwnKeys(item.zoom) || (item.effects?.length ?? 0) > 0
          || item.backgroundFill || hasOwnKeys(item.mask) || item.mosaic) {
          return refusal('video-clip-effects');
        }
        const visualFade = resolveBaseVisualFade(item);
        if (visualFade?.unsupported) return refusal('video-clip-effects');
        const transform = resolveBaseTransform(item.transform, state.width, state.height);
        if (transform?.unsupported) return refusal(transform.unsupported);
        const filters = resolveBaseFilters(item.filters);
        if (filters?.unsupported) return refusal(filters.unsupported);
        visibleVideoItems.push({ item, transform, filters, visualFade });
      }
      if (!item.audioDetached && item.volume !== 0) {
        if (!item.src || !integer(item.srcInFrame ?? 0)) return refusal('video-audio-source');
        audioItems.push(item);
      }
    } else if (item.kind === 'audio') {
      if (!item.src || !integer(item.srcInFrame ?? 0)) return refusal('audio-source');
      if ((item.playbackRate ?? 1) !== 1) return refusal('audio-retimed');
      if (hasAnyKeyframes(item.keyframes) || (item.effects?.length ?? 0) > 0
        || item.deletedWordIdx?.length || item.transcriptPlayOrder?.length || item.silenceFrames != null
        || item.cutPadFrames != null || item.gapCapsMs != null || item.denoisedSrc) {
        return refusal('audio-processing');
      }
      audioItems.push(item);
    } else if (OVERLAY_KINDS.has(item.kind)) {
      visibleOverlayItems.push(item);
    } else {
      return refusal(`unsupported-kind:${item.kind}`);
    }
  }

  // Visual stacking check: every overlay item's track must sit STRICTLY ABOVE all visible video tracks.
  // In trackOrder, smaller index = higher layer.
  if (visibleVideoItems.length > 0) {
    const minVideoTrackIdx = Math.min(...visibleVideoItems.map(({ item }) => visualTrackIds.indexOf(item.track)));
    for (const overlay of visibleOverlayItems) {
      const idx = visualTrackIds.indexOf(overlay.track);
      if (idx < 0 || idx >= minVideoTrackIdx) return refusal('overlay-below-video');
    }
  }

  // Sort visible base video clips & ensure no two base video clips overlap on the same frame.
  const sortedVideos = [...visibleVideoItems].sort((a, b) => a.item.startFrame - b.item.startFrame);
  for (let i = 1; i < sortedVideos.length; i++) {
    const prev = sortedVideos[i - 1].item;
    if (sortedVideos[i].item.startFrame < prev.startFrame + prev.durationInFrames) {
      return refusal('overlapping-base-video');
    }
  }

  // Build disjoint base segments covering [rangeStart, rangeEnd).
  const baseSegments = [];
  let cursor = rangeStart;
  for (const { item, transform, filters, visualFade } of sortedVideos) {
    const itemStart = item.startFrame;
    const itemEnd = itemStart + item.durationInFrames;
    if (itemEnd <= cursor || itemStart >= rangeEnd) continue;
    if (itemStart > cursor) {
      baseSegments.push({ kind: 'black', timelineFrame: cursor, frames: itemStart - cursor });
      cursor = itemStart;
    }
    const segStart = Math.max(cursor, itemStart);
    const segEnd = Math.min(rangeEnd, itemEnd);
    const isSolidBlack = transform?.opacity === 0 || filters?.brightness === 0;
    baseSegments.push(isSolidBlack
      ? { kind: 'black', timelineFrame: segStart, frames: segEnd - segStart }
      : {
        kind: 'video',
        timelineFrame: segStart,
        frames: segEnd - segStart,
        sourceFrame: (item.srcInFrame ?? 0) + (segStart - itemStart),
        clipLocalStart: segStart - itemStart,
        src: item.src,
        transform,
        filters,
        visualFade,
      });
    cursor = segEnd;
  }
  if (cursor < rangeEnd) {
    baseSegments.push({ kind: 'black', timelineFrame: cursor, frames: rangeEnd - cursor });
  }

  // Audio track routing (supports arbitrary clip count + fadeInFrames / fadeOutFrames).
  const audioTracksInUse = [...new Set(audioItems.map((it) => it.track))];
  const anySolo = audioTracksInUse.some((id) => tracks[id]?.soloed);
  for (const id of audioTracksInUse) {
    const tr = tracks[id];
    const audibleTrack = !tr?.hidden && !tr?.muted && (!anySolo || Boolean(tr?.soloed));
    if (!audibleTrack) continue;
    if (tr?.role === 'anchor') hasAnchorAudio = true;
    if (tr?.role === 'follower' && Number(tr?.audioRouting?.duckDepthDb ?? 0) > 0) hasActiveFollowerDucking = true;
  }
  if (hasAnchorAudio && hasActiveFollowerDucking) return refusal('audio-ducking');

  const audioSegments = [];
  for (const item of audioItems) {
    const tr = tracks[item.track];
    if (tr?.hidden || tr?.muted || (anySolo && !tr?.soloed)) continue;
    const baseVolume = clamp(Number(item.volume ?? 1), 0, 2);
    const gainDb = Number(tr?.audioRouting?.gainDb ?? 0);
    const gain = baseVolume * (Number.isFinite(gainDb) ? 10 ** (gainDb / 20) : 1);
    if (gain <= 0) continue;
    const itemStart = item.startFrame;
    const itemEnd = itemStart + item.durationInFrames;
    const overlapStart = Math.max(rangeStart, itemStart);
    const overlapEnd = Math.min(rangeEnd, itemEnd);
    if (overlapEnd <= overlapStart) continue;
    audioSegments.push({
      src: item.src,
      timelineStartFrame: overlapStart,
      frames: overlapEnd - overlapStart,
      sourceFrame: (item.srcInFrame ?? 0) + (overlapStart - itemStart),
      itemDuration: item.durationInFrames,
      offsetInItem: overlapStart - itemStart,
      fadeInFrames: Math.max(0, Number(item.fadeInFrames ?? 0)),
      fadeOutFrames: Math.max(0, Number(item.fadeOutFrames ?? 0)),
      gain,
      fromVideo: item.kind === 'video',
    });
  }

  // Check if timeline actually has overlays above base video (captions, text/solid/image/svg, watermark).
  const captionsEnabled = state.captionsHidden !== true
    && trackIds.some((id) => trackKind(state, id) === 'caption' && !tracks[id]?.hidden
      && (tracks[id]?.captions?.enabled ?? (tracks[id]?.captions === undefined && id === 'C1' && state.captions?.enabled)));
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
    hybridMode: 'overlay-plates',
    fps: state.fps,
    width: state.width,
    height: state.height,
    fit: state.fit ?? 'contain',
    rangeStart,
    rangeEnd,
    frames,
    baseSegments,
    audioSegments,
    hasCaptions: captionsEnabled || hasLegacyCaptions,
    hasWatermark: watermarkEnabled,
    hasOverlays: visibleOverlayInRange || captionsEnabled || hasLegacyCaptions || watermarkEnabled,
    state,
  };
}

/**
 * Create a derived state for rendering ONLY overlay plates (`captions`, `text`, `solid`, `image`, `svg`, `watermark`).
 * Moves stripped `video` and `audio` items onto a hidden track instead of deleting them so caption items referencing
 * a video/audio item's `transcript` and `timelineDuration()` keep 100% identical timing!
 */
export function buildOverlayOnlyState(state) {
  const hiddenTrackId = '__cc_hidden_media__';
  const trackOrder = Array.isArray(state.trackOrder)
    ? [...state.trackOrder.filter((id) => id !== hiddenTrackId), hiddenTrackId]
    : [...TRACK_ORDER_DEFAULT, hiddenTrackId];
  return {
    ...state,
    trackOrder,
    tracks: {
      ...(state.tracks ?? {}),
      [hiddenTrackId]: { kind: 'video', hidden: true, muted: true },
    },
    items: (state.items ?? []).map((item) => (
      item.kind === 'video' || item.kind === 'audio'
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
export function buildSparseOverlayPlan(state, rangeStart, rangeEnd, captionSummary = null) {
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
        animated.push([
          itemStart + Math.max(0, Math.floor(kfList[0].frame)),
          itemStart + Math.min(item.durationInFrames, Math.ceil(kfList[kfList.length - 1].frame) + 1),
        ]);
      }
    }
  }

  const mergedAnimated = mergeRanges(animated, rangeStart, rangeEnd);
  const mergedActive = mergeRanges(active, rangeStart, rangeEnd);
  for (const [a, b] of mergedAnimated) { cuts.add(a); cuts.add(b); }
  for (const [a, b] of mergedActive) { cuts.add(a); cuts.add(b); }

  const sortedCuts = [...cuts].sort((a, b) => a - b);
  const spans = [];
  const sampleSet = new Set();

  for (let i = 0; i + 1 < sortedCuts.length; i++) {
    const from = sortedCuts[i];
    const to = sortedCuts[i + 1];
    if (to <= from) continue;
    if (pointInMergedRanges(mergedAnimated, from)) {
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

/** Generate a minimal valid fully transparent RGBA PNG image of given dimensions (pure Node zlib). */
function createBlankTransparentPng(width, height) {
  const rowBytes = 1 + width * 4; // filter byte (0) + RGBA zeros
  const raw = Buffer.alloc(rowBytes * height, 0);
  const idatData = zlib.deflateSync(raw, { level: 1 });

  const crcTable = createBlankTransparentPng.crcTable ??= (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  const chunk = (type, payload) => {
    const buf = Buffer.alloc(12 + payload.length);
    buf.writeUInt32BE(payload.length, 0);
    buf.write(type, 4, 4, 'ascii');
    payload.copy(buf, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < 8 + payload.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    buf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length);
    return buf;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
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

export function buildClipFilterChain(seg, segIdx, fps, width, height) {
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
  const rawFadePre = vf ? Math.max(
    0,
    vf.fadeIn && vf.fadeIn.until > loc0 && vf.fadeIn.from < loc0 ? Math.round(loc0 - vf.fadeIn.from) : 0,
    vf.fadeOut && vf.fadeOut.until > loc0 && vf.fadeOut.from < loc0 ? Math.round(loc0 - vf.fadeOut.from) : 0,
  ) : 0;
  const fadePre = Math.min(seg.sourceFrame, rawFadePre);
  const preroll = Math.min(seg.sourceFrame - fadePre, PREROLL_FRAMES);
  const localTrimStart = preroll;
  const localTrimEnd = localTrimStart + fadePre + seg.frames;
  const fpsPrefix = Number.isFinite(seg.sourceFps) && Math.abs(seg.sourceFps - fps) > 0.05 ? `fps=${fps},` : '';
  const steps = [`${fpsPrefix}trim=start_frame=${localTrimStart}:end_frame=${localTrimEnd}`, 'setpts=PTS-STARTPTS', 'setsar=1'];

  const sourceWidth = Number(seg.sourceWidth ?? width);
  const sourceHeight = Number(seg.sourceHeight ?? height);
  if (sourceWidth !== width || sourceHeight !== height) {
    const mode = seg.fit === 'cover' ? 'increase' : 'decrease';
    const scale = `scale=${width}:${height}:force_original_aspect_ratio=${mode}:flags=lanczos`;
    steps.push(seg.fit === 'cover'
      ? `${scale},crop=${width}:${height}`
      : `${scale},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
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
  if (crop) steps.push(`crop=${cw}:${ch}:${cx}:${cy}`);

  const rgbInSteps = ['scale=in_color_matrix=bt709:in_range=tv:flags=accurate_rnd+full_chroma_int', 'format=rgb24'];
  const rgbOutSteps = ['scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int', 'format=yuv420p'];

  const f = seg.filters;
  const opacity = seg.transform?.opacity ?? 1;
  if (f || opacity < 1) {
    steps.push(...rgbInSteps);
    if (f && f.brightness !== 1) {
      const b = f.brightness;
      steps.push(`lutrgb=r='clip(val*${b},0,255)':g='clip(val*${b},0,255)':b='clip(val*${b},0,255)'`);
    }
    if (f && f.contrast !== 1) {
      const c = f.contrast;
      steps.push(`lutrgb=r='clip(127.5+${c}*(val-127.5),0,255)':g='clip(127.5+${c}*(val-127.5),0,255)':b='clip(127.5+${c}*(val-127.5),0,255)'`);
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
      steps.push(`colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`);
    }
    if (f && f.blur > 0) steps.push(`gblur=sigma=${f.blur}`);
    if (opacity < 1) steps.push(`lutrgb=r='val*${opacity}':g='val*${opacity}':b='val*${opacity}'`);
    steps.push(...rgbOutSteps);
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
        prefixFilter = `${steps.join(',')},split=${parts.length}${splitLabels};${subChains.join(';')};${parts.map((p) => `[${p.label}]`).join('')}concat=n=${parts.length}:v=1:a=0`;
      }
    }
    if (!prefixFilter) {
      steps.push(...rgbInSteps);
      if (hasIn) {
        const s = Math.max(0, Math.round(vf.fadeIn.from - decodeLoc0));
        const n = Math.max(1, Math.round(vf.fadeIn.until - vf.fadeIn.from));
        steps.push(`fade=t=in:s=${s}:n=${n}:c=black`);
      }
      if (hasOut) {
        const s = Math.max(0, Math.round(vf.fadeOut.from - decodeLoc0));
        const n = Math.max(1, Math.round(vf.fadeOut.until - vf.fadeOut.from));
        steps.push(`fade=t=out:s=${s}:n=${n}:c=black`);
      }
      if (fadePre > 0) steps.push(`trim=start_frame=${fadePre}:end_frame=${fadePre + seg.frames}`, 'setpts=PTS-STARTPTS');
      steps.push(...rgbOutSteps);
    }
  }
  const posSteps = prefixFilter ? tailSteps : steps;

  const sx = seg.transform?.scaleX ?? 1;
  const sy = seg.transform?.scaleY ?? 1;
  const x = seg.transform?.x ?? 0;
  const y = seg.transform?.y ?? 0;
  const scaledW = Math.max(2, Math.round(cw * sx));
  const scaledH = Math.max(2, Math.round(ch * sy));
  const dx = Math.round((width - width * sx) / 2 + cx * sx + (x / 100) * width);
  const dy = Math.round((height - height * sy) / 2 + cy * sy + (y / 100) * height);

  if (scaledW !== cw || scaledH !== ch) posSteps.push(`scale=${scaledW}:${scaledH}:flags=bilinear`);

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

  const fullFilter = prefixFilter
    ? (posSteps.length ? `${prefixFilter},${posSteps.join(',')}[bv${segIdx}]` : `${prefixFilter}[bv${segIdx}]`)
    : `${posSteps.join(',')}[bv${segIdx}]`;

  return {
    usesInput: true,
    seekSec: (seg.sourceFrame - fadePre - preroll) / fps,
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
    } else {
      out.push({
        ...seg,
        timelineFrame: a,
        frames: b - a,
        sourceFrame: seg.sourceFrame + (a - seg.timelineFrame),
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
  chunk, chunkIdx, plan, sources, plateFiles, blankPngPath, temporary, ffmpegExecutable,
  h264Profile, videoBitrate, vaapiDevice, renderArgsOverride, onChunkFrame, checkResources, signal, run = directCutCommand,
}) {
  const { fps, width, height } = plan;
  const chunkFrames = chunk.to - chunk.from;
  const chunkSegs = sliceBaseSegments(plan.baseSegments, chunk.from, chunk.to);
  const chunkSpans = sliceOverlaySpans(chunk.spans, chunk.from, chunk.to);
  const hasAnyOverlay = chunkSpans.some((s) => s.sampleFrame !== null);

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const filters = [];
  let inputIdx = 0;
  const concatInputs = [];

  for (let i = 0; i < chunkSegs.length; i++) {
    const seg = chunkSegs[i];
    const chain = buildClipFilterChain(seg, i, fps, width, height);
    if (chain.usesInput) {
      const file = sources.get(seg.src).file;
      args.push('-ss', chain.seekSec.toFixed(6), '-i', file);
      filters.push(`[${inputIdx}:v]${chain.filter}`);
      inputIdx += 1;
    } else {
      filters.push(chain.filter);
    }
    concatInputs.push(chain.outLabel);
  }

  let baseOutLabel = concatInputs[0];
  if (concatInputs.length > 1) {
    filters.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=1:a=0[basev]`);
    baseOutLabel = '[basev]';
  }

  if (hasAnyOverlay) {
    const ffconcatLines = ['ffconcat version 1.0'];
    let lastPath = blankPngPath;
    for (const span of chunkSpans) {
      const pngPath = span.sampleFrame === null ? blankPngPath : plateFiles.get(span.sampleFrame);
      if (!pngPath || !existsSync(pngPath)) {
        throw new Error(`Missing overlay plate for frame ${span.sampleFrame}`);
      }
      const escaped = pngPath.replace(/\\/g, '/').replace(/'/g, "'\\''");
      ffconcatLines.push(`file '${escaped}'`, `duration ${((span.to - span.from) / fps).toFixed(6)}`);
      lastPath = escaped;
    }
    ffconcatLines.push(`file '${lastPath}'`);
    const concatPath = path.join(temporary, `overlay-${chunkIdx}.ffconcat`);
    await writeFile(concatPath, ffconcatLines.join('\n') + '\n', 'utf8');
    args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
    const ovIdx = inputIdx++;
    // Convert each sparse PNG decode once BEFORE `fps` duplicates frame references across static spans.
    filters.push(
      `[${ovIdx}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,fps=${fps},trim=end_frame=${chunkFrames},setpts=PTS-STARTPTS[ov]`,
      `${baseOutLabel}[ov]overlay=0:0:shortest=1:format=yuv420[vout]`,
    );
    baseOutLabel = '[vout]';
  }

  const outFile = path.join(temporary, `chunk-${chunkIdx}.mp4`);
  const effectiveBitrate = videoBitrate ?? resolveH264VideoBitrate({ width, height, fps });
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
      const startSec = seg.sourceFrame / fps;
      const durSec = seg.frames / fps;
      args.push('-ss', startSec.toFixed(6), '-t', (durSec + 0.05).toFixed(6), '-i', file);
      const targetSamples = Math.round((seg.frames / fps) * sampleRate);
      const chain = [`aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`, `atrim=end_sample=${targetSamples}`, 'asetpts=PTS-STARTPTS'];

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
  if (videos.length !== 1 || !opaqueNativeVideo(video) || video.pix_fmt !== 'yuv420p'
    || !integer(video.width, 2) || !integer(video.height, 2)
    || !(avgRate > 0 && avgRate <= 240) || !(realRate > 0 && realRate <= 240)
    || !['1:1', undefined].includes(video.sample_aspect_ratio)
    || !['progressive', 'unknown', undefined].includes(video.field_order)
    || Math.abs(Number(video.start_time ?? 0)) > 0.1
    || Math.abs(Number(metadata.format?.start_time ?? 0)) > 0.1
    || (video.tags?.rotate && Number(video.tags.rotate) !== 0)
    || video.side_data_list?.some((data) => Number(data.rotation ?? 0) !== 0)
    || !['bt709', 'unknown', undefined].includes(video.color_space)
    || !['bt709', 'unknown', undefined].includes(video.color_transfer)
    || !['bt709', 'unknown', undefined].includes(video.color_primaries)
    || !['tv', 'unknown', undefined].includes(video.color_range)) return false;
  if (video.color_space !== 'bt709' && video.height < 720) return false;
  const sourceFrames = Number(video.nb_frames);
  const duration = Number(video.duration ?? metadata.format?.duration);
  if (integer(sourceFrames, 1)) {
    if (segments.some((s) => s.sourceFrame + s.frames > sourceFrames)) return false;
  } else if (!(duration > 0) || segments.some((s) => (s.sourceFrame + s.frames) / plan.fps > duration + 0.1)) return false;
  for (const segment of segments) Object.assign(segment, {
    sourceWidth: video.width, sourceHeight: video.height, sourceFps: avgRate, fit: plan.fit,
  });
  return true;
}

/** Probe source files & decide eligibility for overlay-hybrid export (null if Remotion should handle). */
export async function inspectOverlayHybridExport(options, { run = directCutCommand, probe } = {}) {
  const { signal, uploadsDirectory, assetsDirectory, ffmpegExecutable, ffprobeExecutable } = options;
  signal?.throwIfAborted();
  if (process.env.CC_DIRECT_CUT_EXPORT === '0') return null;
  const plan = planOverlayHybridExport(options);
  if (!plan.eligible) {
    console.info(`[render] overlay hybrid declined: ${plan.reason}`);
    return null;
  }
  // If there are NO overlays at all (no captions, no text/solid/image/svg, no watermark) AND
  // no transforms/filters/fades, let direct-cut handle pure stream-cuts!
  if (!ffmpegExecutable || !ffprobeExecutable) {
    console.info('[render] overlay hybrid declined: full-media-binaries');
    return null;
  }

  const sources = new Map();
  const allSrcs = new Set([
    ...plan.baseSegments.filter((s) => s.kind === 'video').map((s) => s.src),
    ...plan.audioSegments.map((s) => s.src),
  ]);

  for (const src of allSrcs) {
    const local = localVideoPath(src, uploadsDirectory, assetsDirectory);
    if (!local) { console.info('[render] overlay hybrid declined: nonlocal source'); return null; }
    const file = options.resolveMediaSource?.(src) ?? local;
    let metadata;
    try {
      metadata = probe
        ? await probe(file)
        : JSON.parse(await run(ffprobeExecutable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 5000 }));
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(`[render] overlay hybrid source probe failed; retaining compositor: ${error.message}`);
      return null;
    }
    signal?.throwIfAborted();

    const videoSegs = plan.baseSegments.filter((s) => s.kind === 'video' && s.src === src);
    const audioStream = metadata.streams?.find((s) => s.codec_type === 'audio');
    const audioSegs = plan.audioSegments.filter((s) => s.src === src);
    const videoOnlyAudioSegs = audioSegs.length > 0 && audioSegs.every((s) => s.fromVideo);
    if (!audioStream && videoOnlyAudioSegs) {
      plan.audioSegments = plan.audioSegments.filter((s) => s.src !== src);
    }
    const remainingAudioSegs = plan.audioSegments.filter((s) => s.src === src);
    const audioOk = !remainingAudioSegs.length || (
      audioStream
      && [1, 2].includes(audioStream.channels)
      && Math.abs(Number(audioStream.start_time ?? 0)) <= 0.1
      && Math.abs(Number(metadata.format?.start_time ?? 0)) <= 0.1
      && Number(audioStream.sample_rate) > 0
      && remainingAudioSegs.every((s) => Number(audioStream.duration) >= (s.sourceFrame + s.frames) / plan.fps - 0.1)
    );
    if ((videoSegs.length && !hybridVideoSourceSupported(metadata, plan, videoSegs)) || !audioOk) {
      console.info('[render] overlay hybrid declined: source metadata');
      return null;
    }
    sources.set(src, { file, hasAudio: Boolean(audioStream), width: metadata.streams?.find((s) => s.codec_type === 'video')?.width,
      height: metadata.streams?.find((s) => s.codec_type === 'video')?.height });
  }
  return { plan, sources };
}

function splitOutputChunks(totalStart, totalEnd, workerCount, baseSegments = []) {
  const total = totalEnd - totalStart;
  const minChunkFrames = 150;
  const count = Math.max(1, Math.min(workerCount, Math.floor(total / minChunkFrames) || 1));
  const avoidRanges = [];
  for (const seg of baseSegments) {
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
  const chunks = [];
  let cursor = totalStart;
  for (let i = 0; i < count; i++) {
    const rawTo = i === count - 1 ? totalEnd : totalStart + Math.floor(((i + 1) * total) / count);
    const to = i === count - 1 ? totalEnd : nudgeOutsideFade(rawTo, cursor + 30, totalEnd - 30);
    if (to > cursor) {
      chunks.push({ from: cursor, to });
      cursor = to;
    }
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
  const inspected = await inspectOverlayHybridExport(options, dependencies);
  if (!inspected) return null;
  const { plan, sources } = inspected;
  const { renderOverlayPlates } = options;
  if (typeof renderOverlayPlates !== 'function') return null;

  const { checkDisk = checkDirectCutDisk, run = directCutCommand } = dependencies;
  const { outputLocation, onProgress, onProgressStage, h264Profile, videoBitrate, vaapiDevice, signal: ownerSignal, ffmpegExecutable } = options;
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

  try {
    const platesDir = path.join(temporary, 'plates');
    await mkdir(platesDir, { recursive: true });
    const blankPngPath = path.join(temporary, 'blank.png');
    await writeFile(blankPngPath, createBlankTransparentPng(plan.width, plan.height));

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

    signal.throwIfAborted();
    const { spans, plateFiles } = plateResult;
    const plateWeight = plateFiles.size > 0
      ? Math.min(0.45, Math.max(0.05, plateFiles.size / (plateFiles.size + plan.frames * 0.25)))
      : 0;
    onProgress?.(plateWeight);

    const cores = availableParallelism();
    const desiredWorkers = profile?.hardware
      ? (cores >= 8 && plan.frames >= 1200 ? Math.min(4, Math.floor(cores / 4)) : Math.min(2, cores >= 4 ? 2 : 1))
      : Math.min(3, Math.max(1, Math.floor(cores / 2)));
    const chunks = splitOutputChunks(plan.rangeStart, plan.rangeEnd, desiredWorkers, plan.baseSegments)
      .map((range) => ({ ...range, spans }));

    const runEncodingAttempt = async (activeProfile) => {
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

      const chunkFiles = await Promise.all(chunks.map((chunk, chunkIdx) => encodeChunk({
        chunk,
        chunkIdx,
        plan,
        sources,
        plateFiles,
        blankPngPath,
        temporary,
        ffmpegExecutable,
        h264Profile: activeProfile,
        videoBitrate,
        vaapiDevice,
        renderArgsOverride: override,
        onChunkFrame: reportChunkFrame,
        checkResources,
        signal,
        run,
      })));

      signal.throwIfAborted();
      onProgressStage?.('finalizing');
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

      const audioWav = await renderAudioTrack({ plan, sources, temporary, ffmpegExecutable, checkResources, signal, run });
      const muxArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', videoOnlyFile];
      if (audioWav) muxArgs.push('-i', audioWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest');
      else muxArgs.push('-map', '0:v:0', '-c:v', 'copy', '-an');
      muxArgs.push('-movflags', '+faststart', '-y', stagingOut);
      const timeoutMs = exportFinalizationTimeoutMs({
        frames: plan.frames, fps: plan.fps, inputBytes: await totalFileBytes([videoOnlyFile, audioWav]),
      });
      await run(ffmpegExecutable, muxArgs, { signal, timeoutMs, collect: false, checkResources });
      return stagingOut;
    };

    const cleanupPartial = async () => {
      await rm(stagingOut, { force: true }).catch(() => {});
    };

    const softwareProfile = { id: 'libx264', label: 'Software (libx264)', hardware: false, transport: 'server' };
    const encoded = profile
      ? await withEncoderProfileFallback({
        render: runEncodingAttempt,
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
      hybridMode: 'overlay-plates',
      ...(encoded.encoder ? { encoder: encoded.encoder } : {}),
      ...(encoded.encoderFallbackReason ? { encoderFallbackReason: encoded.encoderFallbackReason } : {}),
      plateCount: plateFiles.size,
      totalFrames: plan.frames,
    };
  } finally {
    clearInterval(guard);
    ownerSignal?.removeEventListener('abort', onOwnerAbort);
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
