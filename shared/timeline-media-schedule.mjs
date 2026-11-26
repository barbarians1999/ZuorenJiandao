/**
 * Shared track-media timing and audio schedule kernel used by Preview, Direct-Cut,
 * Overlay-Hybrid, and FCPXML exporters. Pure track geometry only: zero transcript
 * imports or field reads.
 */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clamp01 = (value) => clamp(value, 0, 1);

export const AUDIO_RATIONAL_DENOMINATOR = 48000;
export const AUDIO_DEFAULT_SAMPLE_RATE = 48000;

export function normalizePlaybackRate(rawRate) {
  const rate = Number(rawRate ?? 1);
  return Number.isFinite(rate) && rate > 0 ? Math.max(0.01, rate) : 1;
}

export function normalizeSrcInFrame(rawSrcInFrame) {
  const srcIn = Number(rawSrcInFrame ?? 0);
  return Number.isFinite(srcIn) && srcIn >= 0 ? srcIn : 0;
}

/**
 * Resolve exact floating-point source timing for any timeline clip.
 * Audio callers preserve fractional frames/seconds without rounding to integer video frames.
 */
export function resolveClipSourceWindow(item, fps = 30, sampleRate = AUDIO_DEFAULT_SAMPLE_RATE) {
  const rate = normalizePlaybackRate(item?.playbackRate);
  const srcInFrameExact = normalizeSrcInFrame(item?.srcInFrame);
  const startFrame = Number(item?.startFrame ?? 0);
  const durationInFrames = Math.max(0, Number(item?.durationInFrames ?? 0));
  const sourceSpanFrames = durationInFrames * rate;
  const srcEndFrameExact = srcInFrameExact + sourceSpanFrames;
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  return {
    playbackRate: rate,
    srcInFrameExact,
    srcEndFrameExact,
    timelineStartFrame: startFrame,
    timelineEndFrame: startFrame + durationInFrames,
    timelineStartSec: startFrame / safeFps,
    timelineEndSec: (startFrame + durationInFrames) / safeFps,
    sourceStartSec: srcInFrameExact / safeFps,
    sourceDurationSec: sourceSpanFrames / safeFps,
    sourceStartSample: Math.round((srcInFrameExact / safeFps) * sampleRate),
    sourceDurationSamples: Math.round((sourceSpanFrames / safeFps) * sampleRate),
  };
}

/**
 * Sample-exact timeline boundaries using cumulative rounding so contiguous
 * sub-frame audio cuts never accumulate +/- 1 sample drift.
 */
export function computeAudioSampleWindow(
  timelineStartFrame,
  timelineEndFrame,
  rangeStart = 0,
  fps = 30,
  sampleRate = AUDIO_DEFAULT_SAMPLE_RATE,
) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const startSample = Math.round(((timelineStartFrame - rangeStart) / safeFps) * sampleRate);
  const endSample = Math.round(((timelineEndFrame - rangeStart) / safeFps) * sampleRate);
  return {
    startSample,
    endSample,
    durationSamples: Math.max(0, endSample - startSample),
  };
}

export function voiceIsolationMix(strength) {
  const wet = clamp(Number(strength ?? 100) / 100, 0, 1);
  if (wet === 0) return { dry: 1, wet: 0 };
  if (wet === 1) return { dry: 0, wet: 1 };
  return {
    dry: Math.cos((wet * Math.PI) / 2),
    wet: Math.sin((wet * Math.PI) / 2),
  };
}

export function mergeFrameRanges(ranges, boundStart = 0, boundEnd = Infinity) {
  const clipped = [];
  for (const [a, b] of ranges) {
    const s = Math.max(boundStart, a);
    const e = Math.min(boundEnd, b);
    if (e > s) clipped.push([s, e]);
  }
  if (!clipped.length) return [];
  clipped.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [clipped[0]];
  for (let i = 1; i < clipped.length; i += 1) {
    const cur = clipped[i];
    const last = merged[merged.length - 1];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else merged.push(cur);
  }
  return merged;
}

export function trackKindForSchedule(state, id) {
  const explicit = state?.tracks?.[id]?.kind;
  if (explicit) return explicit;
  const prefix = String(id).toUpperCase()[0];
  return prefix === 'A' ? 'audio' : prefix === 'C' ? 'caption' : 'video';
}

/**
 * Shared visibility predicate for visual overlay clips (`text`, `solid`, `image`, `svg`, `gif`).
 * Global `captionsHidden` hides caption tracks (`C1`/`C2`/`state.captions`), NEVER visual-track text clips.
 */
export function isVisualOverlayItemVisible(state, item) {
  if (!item || typeof item !== 'object') return false;
  return !state?.tracks?.[item.track]?.hidden;
}

/**
 * Shared audio-presence predicate honoring OpenChatCut's override rule:
 * non-empty `keyframes.volume` overrides static `item.volume` (so `volume: 0` + positive keyframes IS audible).
 */
export function hasPotentialClipAudio(item) {
  if (!item || typeof item !== 'object' || !item.src) return false;
  if (item.kind !== 'audio' && item.kind !== 'video') return false;
  if (item.kind === 'video' && item.audioDetached) return false;
  const volKfs = item.keyframes?.volume;
  if (Array.isArray(volKfs) && volKfs.length > 0) {
    return volKfs.some((kf) => Number(kf?.value) > 0);
  }
  return Number(item.volume ?? 1) > 0;
}

/**
 * Unified track mute / solo / hidden / linear gain / ducking resolution.
 */
export function resolveTrackRouting(state, {
  forceMuted = false,
  anchorItems,
  rangeStart = 0,
  rangeEnd = Infinity,
} = {}) {
  const tracks = state?.tracks ?? {};
  const items = state?.items ?? [];
  const trackIdsInOrder = Array.isArray(state?.trackOrder) ? [...state.trackOrder] : [];
  for (const id of Object.keys(tracks)) if (!trackIdsInOrder.includes(id)) trackIdsInOrder.push(id);
  for (const it of items) if (!trackIdsInOrder.includes(it.track)) trackIdsInOrder.push(it.track);

  const audioTrackIds = trackIdsInOrder.filter((id) => trackKindForSchedule(state, id) === 'audio');
  const anyAudioSolo = audioTrackIds.some((id) => tracks[id]?.soloed)
    || Object.entries(tracks).some(([id, cfg]) => cfg?.soloed && (cfg.kind === 'audio' || (cfg.kind !== 'caption' && items.some((it) => it.track === id && (it.kind === 'video' || it.kind === 'audio')))));

  const isTrackHidden = (trackId) => Boolean(tracks[trackId]?.hidden);
  const isTrackMuted = (trackId) => Boolean(
    forceMuted
    || tracks[trackId]?.muted
    || (anyAudioSolo && !tracks[trackId]?.soloed),
  );
  const isTrackAudible = (trackId) => !isTrackHidden(trackId) && !isTrackMuted(trackId);

  const trackLinearGain = (trackId) => {
    const gainDb = Number(tracks[trackId]?.audioRouting?.gainDb ?? 0);
    return Number.isFinite(gainDb) ? 10 ** (clamp(gainDb, -60, 12) / 20) : 1;
  };

  const duckFactorForTrack = (trackId) => {
    const tr = tracks[trackId];
    if (tr?.role !== 'follower') return 1;
    return clamp(10 ** ((tr?.audioRouting?.duckDepthDb ?? -12) / 20), 0, 2);
  };

  const anchorCandidates = anchorItems ?? items;
  const anchorRaw = [];
  for (const it of anchorCandidates) {
    if (!it?.src) continue;
    const tr = tracks[it.track];
    if (tr?.role !== 'anchor' || !isTrackAudible(it.track)) continue;
    anchorRaw.push([it.startFrame, it.startFrame + it.durationInFrames]);
  }
  const anchorRanges = mergeFrameRanges(anchorRaw, rangeStart, rangeEnd);

  const gainAt = (trackId, frame) => {
    if (isTrackMuted(trackId)) return 0;
    let gain = trackLinearGain(trackId);
    if (anchorRanges.length > 0 && tracks[trackId]?.role === 'follower') {
      if (anchorRanges.some(([from, to]) => frame >= from && frame < to)) {
        gain *= duckFactorForTrack(trackId);
      }
    }
    return gain;
  };

  return {
    trackIdsInOrder,
    audioTrackIds,
    anyAudioSolo,
    anchorRanges,
    isTrackHidden,
    isTrackMuted,
    isTrackAudible,
    trackLinearGain,
    duckFactorForTrack,
    gainAt,
  };
}

export function buildAssetIndex(assets = []) {
  const byId = new Map();
  const bySrc = new Map();
  for (const asset of assets) {
    if (!asset) continue;
    if (asset.id && !byId.has(asset.id)) byId.set(asset.id, asset);
    if (asset.src && !bySrc.has(asset.src)) bySrc.set(asset.src, asset);
  }
  return { byId, bySrc };
}

export function findSourceAsset(item, assetIndex) {
  if (!item) return undefined;
  if (item.sourceAssetId && assetIndex.byId.has(item.sourceAssetId)) {
    return assetIndex.byId.get(item.sourceAssetId);
  }
  return item.src ? assetIndex.bySrc.get(item.src) : undefined;
}

function availableBefore(item, hasZeroHandles) {
  if (hasZeroHandles?.(item)) return 0;
  const rate = normalizePlaybackRate(item.playbackRate);
  const sourceStart = normalizeSrcInFrame(item.srcInFrame);
  return Math.max(0, Math.floor(sourceStart / rate));
}

function availableAfter(item, assetIndex, hasZeroHandles) {
  if (hasZeroHandles?.(item)) return 0;
  const asset = findSourceAsset(item, assetIndex);
  if (!asset || !Number.isFinite(asset.durationInFrames)) return null;
  const rate = normalizePlaybackRate(item.playbackRate);
  const sourceEnd = normalizeSrcInFrame(item.srcInFrame) + item.durationInFrames * rate;
  if (!Number.isFinite(sourceEnd)) return 0;
  return Math.max(0, Math.floor((asset.durationInFrames - sourceEnd) / rate));
}

export function planAudioCrossfadeFromIndex(outgoing, incoming, transition, assetIndex, options = {}) {
  const hasZeroHandles = options.hasZeroHandles;
  const duration = Number.isFinite(transition?.durationInFrames)
    ? Math.max(1, Math.round(transition.durationInFrames))
    : 1;
  const requestedBeforeFrames = Math.floor(duration / 2);
  const requestedAfterFrames = duration - requestedBeforeFrames;
  const beforeFrames = Math.min(requestedBeforeFrames, availableBefore(incoming, hasZeroHandles));
  const tail = availableAfter(outgoing, assetIndex, hasZeroHandles);
  const afterFrames = tail === null ? requestedAfterFrames : Math.min(requestedAfterFrames, tail);
  return {
    beforeFrames,
    afterFrames,
    requestedBeforeFrames,
    requestedAfterFrames,
    hasFullHandles: beforeFrames === requestedBeforeFrames && afterFrames === requestedAfterFrames,
  };
}

function isAudioTransitionType(type) {
  return type === 'audio-cross-fade';
}

/**
 * O(N + T) audio crossfade planner indexed by item ID and asset map.
 */
export function resolveAudioCrossfadePlans(audioItems, audioTransitions = [], assets = [], options = {}) {
  const byId = new Map(audioItems.map((it) => [it.id, it]));
  const assetIndex = buildAssetIndex(assets);
  const plansByItemId = new Map();
  const getPlan = (id) => {
    let rec = plansByItemId.get(id);
    if (!rec) {
      rec = { beforeFrames: 0, afterFrames: 0, curves: [] };
      plansByItemId.set(id, rec);
    }
    return rec;
  };
  for (const t of audioTransitions) {
    if (!t || t.enabled === false) continue;
    if (t.type !== undefined && !isAudioTransitionType(t.type)) continue;
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    if (!out || !inc) continue;
    const plan = planAudioCrossfadeFromIndex(out, inc, t, assetIndex, options);
    const seam = inc.startFrame;
    const overlapFrames = plan.beforeFrames + plan.afterFrames;
    const incPlan = getPlan(inc.id);
    const outPlan = getPlan(out.id);
    if (plan.hasFullHandles) {
      incPlan.beforeFrames = Math.max(incPlan.beforeFrames, plan.beforeFrames);
      incPlan.curves.push({ direction: 'in', startFrame: seam - plan.beforeFrames, duration: overlapFrames });
      outPlan.afterFrames = Math.max(outPlan.afterFrames, plan.afterFrames);
      outPlan.curves.push({ direction: 'out', startFrame: seam - plan.beforeFrames, duration: overlapFrames });
    } else {
      if (plan.requestedAfterFrames > 0) incPlan.curves.push({ direction: 'in', startFrame: seam, duration: plan.requestedAfterFrames });
      if (plan.requestedBeforeFrames > 0) outPlan.curves.push({ direction: 'out', startFrame: seam - plan.requestedBeforeFrames, duration: plan.requestedBeforeFrames });
    }
  }
  return plansByItemId;
}

export function evaluateCrossfadeGainAt(curves, absoluteFrame) {
  if (!curves?.length) return 1;
  let gain = 1;
  for (const curve of curves) {
    const p = clamp01((absoluteFrame - curve.startFrame) / curve.duration);
    gain *= curve.direction === 'out' ? Math.cos((p * Math.PI) / 2) : Math.sin((p * Math.PI) / 2);
  }
  return gain;
}

/**
 * Compile normalized audio segments from pure timeline track geometry.
 * Shared by overlay-hybrid and schedule consumers without reading transcript state.
 */
export function compileAudioSchedule(state, {
  audioItems,
  audioTransitions,
  rangeStart = 0,
  rangeEnd = Infinity,
  sampleRate = AUDIO_DEFAULT_SAMPLE_RATE,
  crossfadePlans,
  routing,
} = {}) {
  const resolvedAudioItems = audioItems ?? (state?.items ?? []).filter((it) => hasPotentialClipAudio(it));
  const resolvedTransitions = audioTransitions ?? (state?.transitions ?? []).filter((t) => t.enabled !== false && isAudioTransitionType(t.type));
  const effectiveRouting = routing ?? resolveTrackRouting(state, {
    anchorItems: resolvedAudioItems,
    rangeStart,
    rangeEnd,
  });
  const effectiveCrossfades = crossfadePlans ?? resolveAudioCrossfadePlans(
    resolvedAudioItems,
    resolvedTransitions,
    state?.assets ?? [],
  );
  const fps = Number.isFinite(state?.fps) && state.fps > 0 ? state.fps : 30;
  const anchorRanges = effectiveRouting.anchorRanges;
  const audioSegments = [];

  const pushSegment = (
    item,
    volKeyframes,
    baseVolume,
    trackGain,
    cfPlan,
    sourcesForItem,
    overlapStart,
    overlapEnd,
    sourceFrame,
    rate,
  ) => {
    if (overlapEnd <= overlapStart) return;
    let duckIntervals = null;
    let duckFactor = 1;
    if (anchorRanges.length > 0 && state?.tracks?.[item.track]?.role === 'follower') {
      duckFactor = effectiveRouting.duckFactorForTrack(item.track);
      if (duckFactor !== 1) {
        const intervals = [];
        for (const [a, b] of anchorRanges) {
          const is = Math.max(overlapStart, a);
          const ie = Math.min(overlapEnd, b);
          if (ie > is) intervals.push([(is - overlapStart) / fps, (ie - overlapStart) / fps]);
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

    const sampleWin = computeAudioSampleWindow(overlapStart, overlapEnd, rangeStart, fps, sampleRate);

    for (const sEntry of sourcesForItem) {
      const gain = (volKeyframes?.length >= 2 ? 1 : baseVolume) * trackGain * sEntry.mixGain;
      if (gain <= 0) continue;
      audioSegments.push({
        itemId: item.id,
        src: sEntry.src,
        timelineStartFrame: overlapStart,
        frames: overlapEnd - overlapStart,
        timelineStartSample: sampleWin.startSample,
        timelineEndSample: sampleWin.endSample,
        durationSamples: sampleWin.durationSamples,
        sourceFrame,
        sourceStartSec: sourceFrame / fps,
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
  };

  for (const item of resolvedAudioItems) {
    if (!effectiveRouting.isTrackAudible(item.track)) continue;
    const volKeyframes = item._volumeKeyframes ?? null;
    const baseVolume = volKeyframes?.length === 1 ? volKeyframes[0].value : clamp(Number(item.volume ?? 1), 0, 2);
    const trackGain = effectiveRouting.trackLinearGain(item.track);
    const rate = normalizePlaybackRate(item.playbackRate);
    const cfPlan = effectiveCrossfades.get(item.id);
    const sourcesForItem = item.denoisedSrc
      ? (() => {
        const mix = voiceIsolationMix(item.denoiseStrength);
        const out = [];
        if (mix.dry > 0) out.push({ src: item.src, mixGain: mix.dry });
        if (mix.wet > 0) out.push({ src: item.denoisedSrc, mixGain: mix.wet });
        return out;
      })()
      : [{ src: item.src, mixGain: 1 }];

    const extBefore = cfPlan?.beforeFrames ?? 0;
    const extAfter = cfPlan?.afterFrames ?? 0;
    const itemStart = item.startFrame - extBefore;
    const itemEnd = item.startFrame + item.durationInFrames + extAfter;
    const overlapStart = Math.max(rangeStart, itemStart);
    const overlapEnd = Math.min(rangeEnd, itemEnd);
    const sourceFrame = normalizeSrcInFrame(item.srcInFrame) + (overlapStart - item.startFrame) * rate;
    pushSegment(item, volKeyframes, baseVolume, trackGain, cfPlan, sourcesForItem, overlapStart, overlapEnd, sourceFrame, rate);
  }

  return {
    routing: effectiveRouting,
    crossfadePlans: effectiveCrossfades,
    audioSegments,
  };
}
