import {
  captionTrackEntries,
  timelineDuration,
  timelineTrackIds,
  trackKind,
  type Keyframe,
  type TimelineItem,
  type TimelineState,
} from '../editor/types';
import type { ExportVideoCodec } from './useExportDialogModel';

export interface ExportRoutePreflight {
  mode: 'fast' | 'segmented' | 'compat';
  totalFrames: number;
  compatFrames: number;
  compatSeconds: number;
  reasons: string[];
  animatedCaptionWarning: boolean;
}

const OVERLAY_KINDS = new Set(['text', 'solid', 'image', 'svg']);
const NATIVE_EFFECT_IDS = new Set([
  'builtin:fx-local-gaussian-blur',
  'builtin:fx-local-mosaic',
  'builtin:fx-pixelate',
  'builtin:fx-rect-mask',
  'builtin:fx-circle-mask',
  'builtin:slog3-s709',
  'builtin:canon-log3-709',
]);
const NATIVE_TRANSITION_TYPES = new Set(['cross-dissolve', 'dip-to-black']);
const COMPAT_MIN_FAST_GAP_FRAMES = 15;

interface RawSpan {
  from: number;
  to: number;
  reason: string;
}

function hasAnyKeyframes(keyframes: TimelineItem['keyframes']): boolean {
  if (!keyframes) return false;
  return Object.values(keyframes).some((list) => Array.isArray(list) && list.length > 0);
}

function hasNonVolumeKeyframes(keyframes: TimelineItem['keyframes']): boolean {
  if (!keyframes) return false;
  return Object.entries(keyframes).some(([prop, list]) => prop !== 'volume' && Array.isArray(list) && list.length > 0);
}

function isAudioVolumeKeyframeSupported(keyframes: TimelineItem['keyframes']): boolean {
  const list = keyframes?.volume as Keyframe[] | undefined;
  if (!list?.length) return true;
  if (list.length > 24) return false;
  return list.every((kf) => Number.isFinite(kf.frame) && Number.isFinite(kf.value) && (!kf.easing || kf.easing === 'linear'));
}

function isSpeechEdited(item: TimelineItem): boolean {
  return Boolean(
    item.deletedWordIdx?.length
    || item.transcriptPlayOrder?.length
    || item.silenceFrames != null
    || item.cutPadFrames != null
    || item.gapCapsMs != null,
  );
}

function mergeCompatSpans(rawSpans: RawSpan[], totalFrames: number): {
  spans: Array<{ from: number; to: number }>;
  reasons: string[];
} {
  const valid = rawSpans
    .map((s) => ({ from: Math.max(0, Math.floor(s.from)), to: Math.min(totalFrames, Math.ceil(s.to)), reason: s.reason }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  if (!valid.length) return { spans: [], reasons: [] };

  const reasons: string[] = [];
  const addReason = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  const merged: Array<{ from: number; to: number }> = [];
  for (const s of valid) {
    addReason(s.reason);
    const prev = merged[merged.length - 1];
    if (prev && s.from <= prev.to) prev.to = Math.max(prev.to, s.to);
    else merged.push({ from: s.from, to: s.to });
  }

  const coalesced: Array<{ from: number; to: number }> = [];
  for (const s of merged) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && s.from - prev.to > 0 && s.from - prev.to < COMPAT_MIN_FAST_GAP_FRAMES) {
      prev.to = s.to;
    } else {
      coalesced.push({ ...s });
    }
  }
  return { spans: coalesced, reasons };
}

/**
 * Predict how the current timeline will be routed during H.264 export:
 * all-fast FFmpeg hybrid, segmented FFmpeg+Remotion hybrid, or full Remotion compat.
 */
export function analyzeExportRoutePreflight(
  state: TimelineState,
  codec: ExportVideoCodec,
  fps: number,
): ExportRoutePreflight {
  const timelineFps = Math.max(1, state.fps || fps || 30);
  const totalFrames = Math.max(timelineFps, timelineDuration(state));

  const animatedCaptionWarning = state.captionsHidden !== true
    && totalFrames > timelineFps * 60
    && captionTrackEntries(state).some(({ id, captions }) => (
      captions?.enabled
      && !state.tracks?.[id]?.hidden
      && (captions.motionPreset === 'word-pop' || captions.motionPreset === 'karaoke-pulse')
    ));

  if (codec !== 'h264') {
    return {
      mode: 'compat',
      totalFrames,
      compatFrames: totalFrames,
      compatSeconds: Number((totalFrames / timelineFps).toFixed(1)),
      reasons: ['render-mode'],
      animatedCaptionWarning: false,
    };
  }

  const tracks = state.tracks ?? {};
  const trackIds = timelineTrackIds(state);
  const visualTrackIds = trackIds.filter((id) => trackKind(state, id) === 'video');
  const rawSpans: RawSpan[] = [];
  const pushSpan = (from: number, duration: number, reason: string) => {
    rawSpans.push({ from, to: from + Math.max(1, duration), reason });
  };

  const visualVideos: TimelineItem[] = [];
  const eligibleVideoIds = new Set<string>();
  const overlays: TimelineItem[] = [];
  const mosaics: TimelineItem[] = [];

  for (const item of state.items ?? []) {
    if (tracks[item.track]?.hidden) continue;
    const dur = Math.max(1, item.durationInFrames ?? 1);
    if (item.kind === 'sequence') {
      pushSpan(item.startFrame, dur, 'nested-sequence');
      continue;
    }
    if (item.kind === 'gif') {
      pushSpan(item.startFrame, dur, 'unsupported-kind:gif');
      continue;
    }
    if (item.kind !== 'mosaic' && item.mosaic) {
      pushSpan(item.startFrame, dur, 'composition-mosaic');
    }
    if (item.kind === 'mosaic') {
      const m = item.mosaic;
      const validShape = m && (m.shape === 'rectangle' || m.shape === 'ellipse');
      const staticOnly = !hasAnyKeyframes(item.keyframes) && !item.zoom && !(item.effects?.length)
        && !item.backgroundFill && !item.mask && !item.filters
        && (item.transform?.rotation ?? 0) === 0 && (item.transform?.borderRadius ?? 0) === 0;
      if (!validShape || !staticOnly) pushSpan(item.startFrame, dur, 'composition-mosaic');
      else mosaics.push(item);
      continue;
    }
    if (item.kind === 'video') {
      if (!item.pictureDisabled) visualVideos.push(item);
      const rate = Number(item.playbackRate ?? 1);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
        pushSpan(item.startFrame, dur, 'item-retimed');
        continue;
      }
      if (isSpeechEdited(item)) {
        pushSpan(item.startFrame, dur, 'item-speech-edited');
        continue;
      }
      if (!item.pictureDisabled) {
        let reason: string | null = null;
        if (!item.src) reason = 'video-source';
        else if (hasNonVolumeKeyframes(item.keyframes) || !isAudioVolumeKeyframeSupported(item.keyframes) || item.zoom || item.backgroundFill || item.mosaic) {
          reason = 'video-clip-effects';
        } else if (item.mask && item.mask.type !== 'rectangle' && item.mask.type !== 'ellipse') {
          reason = 'video-clip-effects';
        } else if (item.effects?.some((fx) => fx.mosaicTrack || !NATIVE_EFFECT_IDS.has(fx.assetId))) {
          reason = 'video-clip-effects';
        } else if ((item.transform?.rotation ?? 0) !== 0 || (item.transform?.borderRadius ?? 0) !== 0) {
          reason = 'transform-rotation-or-radius';
        } else {
          const ent = (item.props?.visualEntrance as string | undefined) ?? 'none';
          const ex = (item.props?.visualExit as string | undefined) ?? 'none';
          if ((ent !== 'none' && ent !== 'fade') || (ex !== 'none' && ex !== 'fade')) {
            reason = 'video-clip-effects';
          } else if (((item.fadeInFrames ?? 0) > 0 && ent === 'fade') || ((item.fadeOutFrames ?? 0) > 0 && ex === 'fade')) {
            reason = 'video-visual-fade';
          }
        }
        if (reason) pushSpan(item.startFrame, dur, reason);
        else eligibleVideoIds.add(item.id);
      }
      continue;
    }
    if (item.kind === 'audio') {
      const rate = Number(item.playbackRate ?? 1);
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 4.0) {
        pushSpan(item.startFrame, dur, 'audio-retimed');
      } else if (isSpeechEdited(item)) {
        pushSpan(item.startFrame, dur, 'item-speech-edited');
      } else if (hasNonVolumeKeyframes(item.keyframes) || (item.effects?.length ?? 0) > 0 || !isAudioVolumeKeyframeSupported(item.keyframes)) {
        pushSpan(item.startFrame, dur, 'audio-processing');
      }
      continue;
    }
    if (OVERLAY_KINDS.has(item.kind)) {
      overlays.push(item);
      continue;
    }
    pushSpan(item.startFrame, dur, `unsupported-kind:${item.kind}`);
  }

  // Video track overlap sweep line
  const events: Array<[number, number]> = [];
  for (const v of visualVideos) {
    events.push([v.startFrame, 1], [v.startFrame + Math.max(1, v.durationInFrames), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let overlapStart: number | null = null;
  for (let i = 0; i < events.length;) {
    const pos = events[i][0];
    while (i < events.length && events[i][0] === pos) {
      active += events[i][1];
      i += 1;
    }
    if (active >= 2 && overlapStart === null) overlapStart = pos;
    else if (active < 2 && overlapStart !== null) {
      if (pos > overlapStart) rawSpans.push({ from: overlapStart, to: pos, reason: 'overlapping-base-video' });
      overlapStart = null;
    }
  }

  // Overlays below visible video
  for (const ov of overlays) {
    const ovIdx = visualTrackIds.indexOf(ov.track);
    for (const v of visualVideos) {
      const vIdx = visualTrackIds.indexOf(v.track);
      if (ovIdx < 0 || (vIdx >= 0 && vIdx <= ovIdx)) {
        const s = Math.max(ov.startFrame, v.startFrame);
        const e = Math.min(ov.startFrame + ov.durationInFrames, v.startFrame + v.durationInFrames);
        if (e > s) rawSpans.push({ from: s, to: e, reason: 'overlay-below-video' });
      }
    }
  }

  // Mosaics z-order
  const minVideoIdx = visualVideos.length ? Math.min(...visualVideos.map((v) => visualTrackIds.indexOf(v.track))) : Infinity;
  const maxOverlayIdx = overlays.length ? Math.max(...overlays.map((o) => visualTrackIds.indexOf(o.track))) : -1;
  const maxCaptionIdx = trackIds.reduce((best, id, idx) => (
    state.captionsHidden !== true && trackKind(state, id) === 'caption' && !tracks[id]?.hidden && tracks[id]?.captions?.enabled
      ? Math.max(best, idx)
      : best
  ), -1);
  for (const m of mosaics) {
    const mv = visualTrackIds.indexOf(m.track);
    const mt = trackIds.indexOf(m.track);
    const bad = mv < 0 || (visualVideos.length > 0 && mv >= minVideoIdx)
      || (overlays.length > 0 && (maxOverlayIdx < 0 || mv <= maxOverlayIdx))
      || (maxCaptionIdx >= 0 && mt <= maxCaptionIdx);
    if (bad) pushSpan(m.startFrame, m.durationInFrames, 'composition-mosaic');
  }

  // Unsupported visual transitions
  const byId = new Map((state.items ?? []).map((it) => [it.id, it]));
  for (const t of state.transitions ?? []) {
    if (!t || t.enabled === false || t.type === 'audio-cross-fade') continue;
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    const isNative = NATIVE_TRANSITION_TYPES.has(t.type)
      && !t.customFrag
      && Boolean(out && inc && eligibleVideoIds.has(out.id) && eligibleVideoIds.has(inc.id))
      && out!.track === inc!.track
      && out!.startFrame + out!.durationInFrames === inc!.startFrame
      && (inc!.srcInFrame ?? 0) >= Math.floor(t.durationInFrames / 2) * (inc!.playbackRate ?? 1);
    if (!isNative && inc) {
      const half = Math.floor(Math.max(2, t.durationInFrames) / 2);
      pushSpan(inc.startFrame - half, Math.max(2, t.durationInFrames), 'transitions');
    } else if (!isNative && out) {
      pushSpan(out.startFrame, out.durationInFrames, 'transitions');
    }
  }

  const { spans, reasons } = mergeCompatSpans(rawSpans, totalFrames);
  const compatFramesRaw = spans.reduce((sum, s) => sum + (s.to - s.from), 0);
  const hasAnyFastVideoFrame = [...eligibleVideoIds].some((id) => {
    const it = byId.get(id);
    if (!it) return false;
    const s = Math.max(0, it.startFrame);
    const e = Math.min(totalFrames, it.startFrame + Math.max(1, it.durationInFrames));
    let uncovered = e - s;
    for (const sp of spans) {
      const ov = Math.min(e, sp.to) - Math.max(s, sp.from);
      if (ov > 0) uncovered -= ov;
    }
    return uncovered > 0;
  });
  const allCompat = compatFramesRaw >= totalFrames || (spans.length > 0 && !hasAnyFastVideoFrame);
  const compatFrames = allCompat ? totalFrames : compatFramesRaw;
  const compatSeconds = Number((compatFrames / timelineFps).toFixed(1));
  const mode = compatFrames === 0 ? 'fast' : allCompat ? 'compat' : 'segmented';
  return {
    mode,
    totalFrames,
    compatFrames,
    compatSeconds,
    reasons,
    animatedCaptionWarning,
  };
}
