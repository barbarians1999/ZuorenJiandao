import { captionTrackEntries, CSS_TRANSITION_TYPES, GLSL_TRANSITION_TYPES, isAudioTransition, isRasterMediaKind, isVisualItemKind, timelineTrackIds, trackKind } from './types';
import type { AspectFit, CssTransitionType, GlslTransitionType, TimelineItem, TimelineState, TransitionDirection } from './types';
import { sourceFrameAt } from './sourceLimit';
import { previewTransitionType } from './transitionPreview';
import { isBackgroundFillActive } from './backgroundFill';
import { continuousVideoAudioGroups, shareableVisualItem } from './transitionAudio';
import { audioGainAt, hasSoloTrack, isTrackEffectivelyMuted } from './audioRouting';
import { selectTransitionPreviewAdapter, staticEffectPreviewStatus, staticPreviewFallbackStatus } from '../gl/previewAdapter';
import { hasPrivacyMosaic } from './mosaic';
import type { SelectedPreviewStatus } from '../gl/previewAdapter';

export interface PreviewLayerRange {
  key: string;
  from: number;
  to: number;
  selected?: boolean;
  decoderSource?: string;
}

/** The Player always renders active layers. Only the hidden neighbors have a budget. */
export function previewLayerWindow(
  ranges: readonly PreviewLayerRange[],
  frame: number,
  radius: number,
  neighborsPerDirection = 2,
): Set<string> {
  const active = new Set<string>();
  const before = [];
  const after = [];
  for (const range of ranges) {
    if (range.selected || (frame >= range.from && frame < range.to)) active.add(range.key);
    else if (range.to <= frame && frame - range.to < radius) before.push(range);
    else if (range.from > frame && range.from - frame <= radius) after.push(range);
  }
  before.sort((a, b) => b.to - a.to);
  after.sort((a, b) => a.from - b.from);
  for (const range of before.slice(0, neighborsPerDirection)) active.add(range.key);
  for (const range of after.slice(0, neighborsPerDirection)) active.add(range.key);
  return active;
}

/** Extend the lifetime of at most one already mounted video near a cut. */
export function previewVideoMounts(
  ranges: readonly PreviewLayerRange[],
  windowKeys: ReadonlySet<string>,
  frame: number,
  radius: number,
  retentionRadius: number,
  history?: { mounted: ReadonlySet<string>; visitedSources: ReadonlySet<string> },
) {
  const activeSources = ranges.flatMap(({ from, to, decoderSource }) =>
    decoderSource && frame >= from && frame < to ? [decoderSource] : []);
  const visited = history?.visitedSources ?? new Set<string>();
  const visitingNewSource = activeSources.some((src) => !visited.has(src));
  // A cold source gets the normal window without an extra decoder competing for its first reads.
  const previousKeys = activeSources.length && !visitingNewSource ? history?.mounted : undefined;
  const mounted = new Set<string>();
  let retained: string | undefined;
  let nearest = retentionRadius + 1;
  for (const { key, from, to, decoderSource } of ranges) {
    if (!decoderSource) continue;
    const distance = Math.max(0, from - frame, frame - to + 1);
    if (windowKeys.has(key)) {
      if (distance <= radius) mounted.add(key);
    } else if (distance > radius && distance < nearest && previousKeys?.has(key)) {
      retained = key;
      nearest = distance;
    }
  }
  if (retained !== undefined) mounted.add(retained);
  return {
    mounted,
    retained,
    visitedSources: visitingNewSource ? new Set([...visited, ...activeSources]) : visited,
  };
}

/**
 * Pure structural plan shared by the Player, WebCodecs and local renderer.
 * Inputs are immutable timeline data and an explicit shader-registry snapshot.
 * No media loading, React hooks, GPU, file, storage or network access happens here.
 * Frame-local animation/mask sampling remains in the existing render surfaces.
 */
export function compositionPlan(state: TimelineState, {
  mode = 'render', selectedItemId, forceMuted = false, registeredEffects = {},
}: {
  mode?: 'player' | 'render';
  selectedItemId?: string | null;
  forceMuted?: boolean;
  registeredEffects?: Readonly<Record<string, unknown>>;
} = {}) {
  const isHidden = (t: TimelineItem['track']) => state.tracks?.[t]?.hidden ?? false;
  const anySolo = hasSoloTrack(state);
  const isMuted = (t: TimelineItem['track']) => isTrackEffectivelyMuted(state, t, forceMuted, anySolo);
  const trackIds = timelineTrackIds(state);
  const visualTracks = trackIds.filter((id) => trackKind(state, id) === 'video');
  // hidden track = fully disabled (no picture, no sound)
  const visualCandidates = state.items.filter((it) => isVisualItemKind(it.kind) && visualTracks.includes(it.track) && !isHidden(it.track));
  // A picture-disabled nested sequence is unsupported: its child picture and sound share one renderer.
  const visual = visualCandidates.filter((it) => it.kind === 'sequence' || it.pictureDisabled !== true);
  // Paint visual bottom-to-top. Timeline rows are stored top-to-bottom.
  const paintOrder = (a: TimelineItem, b: TimelineItem) => a.track === b.track
    ? a.startFrame - b.startFrame
    : visualTracks.indexOf(b.track) - visualTracks.indexOf(a.track);
  const ordered = visual.sort(paintOrder);
  const player = mode === 'player';
  // Existing projects retain their established paint order until they use an adjustment layer.
  const usesTrackCompositing = state.compositingOrder === 'tracks' || state.items.some((item) => item.kind === 'mosaic');
  const audio = state.items.filter((it) => it.kind === 'audio' && it.src && !isHidden(it.track));
  const captionEntries = captionTrackEntries(state);
  const anchorRanges = state.items.filter((item) => state.tracks?.[item.track]?.role === 'anchor'
    && !isHidden(item.track) && !isMuted(item.track) && !!item.src)
    .map((item) => [item.startFrame, item.startFrame + item.durationInFrames] as const);
  const duckGain = (track: TimelineItem['track'], frame: number): number => {
    const config = state.tracks?.[track];
    if (config?.role !== 'follower' || !anchorRanges.some(([from, to]) => frame >= from && frame < to)) return 1;
    return 10 ** ((config.audioRouting?.duckDepthDb ?? -12) / 20);
  };
  const gainAt = (track: TimelineItem['track'], frame: number): number =>
    audioGainAt(state, track, duckGain(track, frame));
  const fit: AspectFit = state.fit ?? 'contain';
  // Build embedded-video audio from pre-picture-filter candidates so hiding a clip's picture
  // does not remove its sound. Disabled singletons need an explicit audio renderer too.
  const videoAudioGroups = continuousVideoAudioGroups(visualCandidates.filter((item) => item.kind === 'video'), state.transitions);
  const groupedVideoIds = new Set(videoAudioGroups.flatMap((group) => group.map((item) => item.id)));
  const visualVideoGroups = player ? videoAudioGroups : continuousVideoAudioGroups(ordered, state.transitions);
  const playerPaintPositions = player
    ? new Map(visualCandidates.toSorted(paintOrder).map((item, index) => [item.id, index]))
    : undefined;

  // In the Player, only the transition into the selected clip pays the dual
  // decoder + WebGL cost. It uses the same GlTransition component as export.
  // Other transitions keep the existing CSS approximation. Non-texturable
  // sources and missing custom shaders are explicit fallback states.
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const sourceFrameFor = (itemId: string, timelineFrame: number): number | null => {
    const item = byId.get(itemId);
    return item ? sourceFrameAt(item, timelineFrame - item.startFrame) : null;
  };
  const texturable = (it?: TimelineItem) => !!it && isRasterMediaKind(it.kind) && it.kind !== 'svg' && it.kind !== 'gif';
  const enabledTransitions = (state.transitions ?? []).filter((t) => t.enabled !== false);
  const pictureDisabledIds = new Set(visualCandidates
    .filter((item) => item.kind !== 'sequence' && item.pictureDisabled === true)
    .map((item) => item.id));
  const visualTransitions = enabledTransitions.filter((t) => !isAudioTransition(t.type)
    && !pictureDisabledIds.has(t.outgoingItemId) && !pictureDisabledIds.has(t.incomingItemId));
  type PreviewEdge = { type: CssTransitionType; frames: number; dir: TransitionDirection; line?: boolean; isolated: boolean };
  const entranceOf = new Map<string, PreviewEdge>();
  const extendBefore = new Map<string, number>();
  const extendAfter = new Map<string, number>();
  interface GlWindow { key: string; type: GlslTransitionType | 'custom-shader'; direction: TransitionDirection; from: number; L: number; outgoing: TimelineItem; incoming: TimelineItem; trimOut: number; trimIn: number; customFrag?: string; customUniforms?: Record<string, number>; previewTargetId?: string }
  const glWindows: GlWindow[] = [];
  const staticPreviewStatuses: SelectedPreviewStatus[] = [];
  const selectedEffectItem = mode === 'player'
    ? state.items.find((item) => item.id === selectedItemId)
    : undefined;
  const selectedEffectStaticStatus = selectedEffectItem
    ? staticEffectPreviewStatus({
        targetId: selectedEffectItem.id,
        effects: selectedEffectItem.effects ?? [],
        registeredEffects,
        texturable: texturable(selectedEffectItem),
      })
    : null;
  if (selectedEffectStaticStatus) staticPreviewStatuses.push(selectedEffectStaticStatus);
  for (const t of visualTransitions) {
    const half = Math.floor(t.durationInFrames / 2);
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    extendBefore.set(t.incomingItemId, half);
    extendAfter.set(t.outgoingItemId, t.durationInFrames - half);
    const selected = mode === 'player' && t.incomingItemId === selectedItemId;
    const privacyTransition = GLSL_TRANSITION_TYPES.has(t.type) && (hasPrivacyMosaic(out) || hasPrivacyMosaic(inc));
    const adapter = selectTransitionPreviewAdapter({
      mode: mode === 'player' ? 'player' : 'render',
      selected: selected || usesTrackCompositing,
      type: t.type,
      texturable: texturable(out) && texturable(inc) && !privacyTransition,
      hasShader: t.type !== 'custom-shader' || !!t.customFrag,
    });
    if (adapter.adapter === 'gl-transition') {
      const from = inc!.startFrame - half; // R = incoming.from - floor(L/2)
      const fallbackType = previewTransitionType(t.type);
      entranceOf.set(t.incomingItemId, {
        type: fallbackType,
        frames: t.durationInFrames,
        dir: t.direction ?? 'left',
        line: t.type === 'clean-line-wipe',
        isolated: false,
      });
      glWindows.push({
        key: t.id,
        type: t.type as GlslTransitionType | 'custom-shader',
        direction: t.direction ?? 'left',
        from,
        L: t.durationInFrames,
        outgoing: out!,
        incoming: inc!,
        trimOut: sourceFrameAt(out!, from - out!.startFrame),
        trimIn: sourceFrameAt(inc!, from - inc!.startFrame),
        previewTargetId: selected ? t.id : undefined,
        // custom-shader carries its GLSL + uniforms from the item to GlTransition
        ...(t.type === 'custom-shader' ? { customFrag: t.customFrag, customUniforms: t.customUniforms } : {}),
      });
      continue;
    }
    const cssType = privacyTransition ? 'cross-dissolve' : mode === 'player'
      ? previewTransitionType(t.type)
      : CSS_TRANSITION_TYPES.has(t.type) ? t.type as CssTransitionType : 'cross-dissolve';
    entranceOf.set(t.incomingItemId, {
      type: cssType,
      frames: t.durationInFrames,
      dir: t.direction ?? 'left',
      line: t.type === 'clean-line-wipe',
      isolated: false,
    });
    if (selected) {
      const status = staticPreviewFallbackStatus({
        kind: 'transition',
        targetId: t.id,
        adapter: adapter.adapter,
        fallbackReason: privacyTransition ? 'privacy-transition' : adapter.fallbackReason,
      });
      if (status) staticPreviewStatuses.push(status);
    }
  }
  const glVisibilityWindows = glWindows.map((window) => ({
    key: window.key,
    from: window.from,
    durationInFrames: window.L,
    itemIds: [window.outgoing.id, window.incoming.id],
  }));
  const isShareableVideo = (item: TimelineItem) => shareableVisualItem({
    item,
    player,
    hasGlEffect: (player && hasPrivacyMosaic(item))
      || (item.effects ?? []).some((effect) => Object.prototype.hasOwnProperty.call(registeredEffects, effect.assetId)),
    hasBackgroundFill: isBackgroundFillActive(state, item),
    hasExtendBefore: !!extendBefore.get(item.id),
    hasExtendAfter: !!extendAfter.get(item.id),
    hasEntrance: !!entranceOf.get(item.id),
  });

  // Keep one preview decoder for a continuous source clock, including
  // picture-disabled clips between visible ones. The paint positions prevent
  // grouping across a layer that needs its own slot on the same track.
  const sharedVisualGroups = visualVideoGroups.flatMap((group) => {
    const runs: TimelineItem[][] = [];
    for (const item of group) {
      if (isShareableVideo(item)) {
        const run = runs.at(-1);
        const first = run?.[0];
        const previous = run?.at(-1);
        const samePlayerSurface = !playerPaintPositions || (first && previous
          && playerPaintPositions.get(item.id) === playerPaintPositions.get(previous.id)! + 1
          && Math.abs(sourceFrameAt(item, 0) - sourceFrameAt(first, item.startFrame - first.startFrame)) < 1e-6);
        if (run && samePlayerSurface) run.push(item);
        else runs.push([item]);
      } else {
        runs.push([]);
      }
    }
    return runs.map((run) => {
      if (!player) return run;
      const first = run.findIndex((item) => item.pictureDisabled !== true);
      const last = run.findLastIndex((item) => item.pictureDisabled !== true);
      return first === -1 ? [] : run.slice(first, last + 1);
    }).filter((run) => run.length > 1);
  });
  const sharedVisualIds = new Set(sharedVisualGroups.flatMap((group) => group.map((item) => item.id)));
  const sharedAt = new Map(sharedVisualGroups.map((group) => [group[0]!.id, group]));
  // Decoder sharing must not move a surface out of its bottom-to-top paint slot.
  const visualLayers = ordered.flatMap((item) => {
    const group = sharedAt.get(item.id);
    return group ? [group] : sharedVisualIds.has(item.id) ? [] : [[item]];
  });
  const visualNode = (items: TimelineItem[]) => ({
    kind: 'visual' as const,
    items,
    retainDecoder: player && Boolean(items[0]?.src?.startsWith('/media/uploads/')) && items.every(isShareableVideo),
  });
  const transitionNode = (window: GlWindow) => ({ kind: 'transition' as const, window });
  const captionNode = (entry: typeof captionEntries[number]) => ({ kind: 'captions' as const, entry });
  const pictureLayers = usesTrackCompositing ? [
    ...trackIds.toReversed().flatMap((trackId) => [
      // Adjustments affect lower tracks; pictures sharing their row remain above them.
      ...ordered.filter((item) => item.track === trackId && item.kind === 'mosaic')
        .map((item) => ({ kind: 'mosaic' as const, item })),
      ...visualLayers.filter((items) => items[0]!.track === trackId && items[0]!.kind !== 'mosaic').map(visualNode),
      ...glWindows.filter((window) => window.incoming.track === trackId && !isHidden(trackId)).map(transitionNode),
      ...captionEntries.filter((entry) => entry.id === trackId && !isHidden(trackId)).map(captionNode),
    ]),
    ...captionEntries.filter((entry) => !trackIds.includes(entry.id)).map(captionNode),
  ] : [
    ...visualLayers.map(visualNode), ...glWindows.map(transitionNode), ...captionEntries.map(captionNode),
  ];
  return {
    ordered, audio, captionEntries, fit, isMuted, gainAt, sourceFrameFor,
    videoAudioGroups, groupedVideoIds, entranceOf, extendBefore, extendAfter,
    glWindows, glVisibilityWindows, staticPreviewStatuses, selectedEffectStaticStatus,
    sharedVisualGroups, sharedVisualIds, visualLayers, pictureLayers, usesTrackCompositing,
  };
}

