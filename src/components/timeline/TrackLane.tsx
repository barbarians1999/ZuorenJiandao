// Track clip band (translated verbatim from Timeline.tsx): the editable area of a track - clip box (drag/crop/
// Blade/pen/reference picking dispatched by editMode), audio waveform, effect marker, pen transparency keyframe
// Overlay, library asset drag and drop (fx/lut/zoom/transition drop clip, sound/template drop track), transition seam mark.
// The pointer machine (drag/penDrag, etc.) is provided by useTimelinePointer and is passed in through the pointer prop.
import { memo, type Dispatch, type RefObject, type SetStateAction, useMemo } from 'react';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';
import {
  TRANSITION_LABELS, isEffectTrack, isItemSelected, isTextTrack, timelineTrackIds, trackKind,
  type TimelineItem, type TimelineState, type TrackId, type TransitionType,
} from '../../editor/types';
import { mainTrackId } from '../../editor/magneticTimeline';
import { upsertKeyframe } from '../../editor/keyframes';
import { getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { rateStretchGeometry } from '../../editor/rateStretch';
import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import { planSlip } from '../../editor/slip';
import type { EditorCommands } from '../../editor/store';
import { hasLibraryDrag, parseLibraryDrag, type LibraryDragPayload } from '../../library/drag';
import { tData, useT } from '../../i18n/locale';
import { hasOperationalTranscript } from '../../transcript/types';
import {
  CLIP_COLOR, clipEdgeHandleLayout, fmt, intersectFrameRange, visibleTimelineItems, waveformPath,
  type EditMode, type TimelineFrameWindow, type TimelineIndexes,
} from './timelineUtil';
import { ClipMediaLayers } from './ClipMediaLayers';
import { ClipEffectBadges } from './ClipEffectBadges';
import { hasRealWavePreviewSource } from '../../media/clipPreview';
import { canDropMediaAsset, hasCompatibleMediaDrag, parseMediaAssetDrop } from '../../media/drag';
import { mediaPlacementVolume } from '../../media/placementPurpose';
import { parseEditorDrag, mediaAssetIds, mediaSourceRangeFor } from '../../editor/editorDrag';
import { placeMediaAssets } from '../../editor/mediaAssetPlacement';
import { canItemMoveToTrack } from '../../editor/multiSelect';
import { groupedItemIds } from '../../editor/linkGroups';
import type { useTimelinePointer } from './useTimelinePointer';
import { topClipOverlapSpans, type TimelineOverlapSpan } from './trackOverlap';
import {
  selectionMovePreviewDeltaForItem,
  type TimelineSelectionMovePreview,
} from '../../captions/captionGroupMove';
import { droppedFiles, hasExternalFiles } from '../../media/externalFileDrop';
import { timelineAttachmentFeedback } from './timelineAttachmentFeedback';
import { planRollingTrim } from '../../editor/rollingTrim';
import { showAppToast } from '../../ui/appToast';
import '../editorFeedback.css';


interface TrackLaneProps {
  trackId: TrackId;
  indexes: TimelineIndexes;
  state: TimelineState;
  commands: EditorCommands;
  pointer: ReturnType<typeof useTimelinePointer>;
  editMode: EditMode;
  pickMode: boolean;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  px: number;
  rowHeight: number;
  visibleWindow: TimelineFrameWindow;
  pinnedItemIds: ReadonlySet<string>;
  selectionMovePreview: TimelineSelectionMovePreview | null;
  libDropTarget: string | null;
  setLibDropTarget: Dispatch<SetStateAction<string | null>>;
  applyLibraryToClip: (payload: LibraryDragPayload, item: TimelineItem) => boolean;
  applyLibraryToTrack: (payload: LibraryDragPayload, trackId: TrackId, startFrame: number) => boolean;
  rippleOnDrop: boolean;
  overwriteOnDrop: boolean;
  frameFromClientX: (clientX: number) => number;
  onContextMenu: (menu: { id: string; x: number; y: number }) => void;
  onTransitionContextMenu: (menu: { id: string; x: number; y: number }) => void;
  onTrackContextMenu: (menu: { trackId: TrackId; x: number; y: number; frame: number }) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  onDropExternalFiles?: (files: File[], trackId: TrackId, startFrame: number) => void;
}

const EMPTY_OVERLAP_SPANS: TimelineOverlapSpan[] = [];

function topClipOverlapSpansInPrefix(
  startFrame: number,
  durationInFrames: number,
  items: readonly TimelineItem[],
  limit: number,
): TimelineOverlapSpan[] {
  const endFrame = startFrame + Math.max(1, durationInFrames);
  const covered: TimelineItem[] = [];
  for (let index = 0; index < limit; index += 1) {
    const prior = items[index]!;
    if (prior.startFrame < endFrame && prior.startFrame + Math.max(1, prior.durationInFrames) > startFrame) {
      covered.push(prior);
    }
  }
  return covered.length > 0 ? topClipOverlapSpans(startFrame, durationInFrames, covered) : EMPTY_OVERLAP_SPANS;
}

export const TrackLane = memo(function TrackLane({
  trackId, state, commands, pointer, editMode, pickMode, locked, hidden, muted, px, rowHeight,
  visibleWindow, pinnedItemIds, selectionMovePreview, indexes, libDropTarget, setLibDropTarget,
  applyLibraryToClip, applyLibraryToTrack, rippleOnDrop, overwriteOnDrop,
  frameFromClientX, onContextMenu, onTransitionContextMenu, onTrackContextMenu, scrollRef, onDropExternalFiles,
}: TrackLaneProps) {
  const t = useT();
  const { drag, penDrag, setPenDrag, startDrag, startRollDrag, startPick, startMarquee } = pointer;
  const attachmentFeedback = useMemo(() => timelineAttachmentFeedback(state), [state]);
  const plannedItems = useMemo(() => new Map(drag?.plannedState?.items.map((item) => [item.id, item]) ?? []), [drag?.plannedState]);
  const trackIds = timelineTrackIds(state);
  const items = indexes.itemsByTrack.get(trackId) ?? [];
  const previewPinnedItemIds = useMemo(() => {
    if (!selectionMovePreview?.itemIds.length && !plannedItems.size) return pinnedItemIds;
    return new Set([...pinnedItemIds, ...(selectionMovePreview?.itemIds ?? []),
      ...state.items.filter((item) => {
        const planned = plannedItems.get(item.id);
        return planned && (planned.startFrame !== item.startFrame || planned.durationInFrames !== item.durationInFrames
          || planned.track !== item.track || planned.srcInFrame !== item.srcInFrame);
      }).map((item) => item.id)]);
  }, [pinnedItemIds, selectionMovePreview, plannedItems, state.items]);
  const itemGeometryById = useMemo(() => {
    const indexById = new Map<string, number>();
    const staticOverlapById = new Map<string, TimelineOverlapSpan[]>();
    let maxEndBefore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      indexById.set(item.id, index);
      const start = item.startFrame;
      const end = start + Math.max(1, item.durationInFrames);
      staticOverlapById.set(
        item.id,
        start < maxEndBefore
          ? topClipOverlapSpansInPrefix(start, item.durationInFrames, items, index)
          : EMPTY_OVERLAP_SPANS,
      );
      if (end > maxEndBefore) maxEndBefore = end;
    }
    return { indexById, staticOverlapById };
  }, [items]);
  const adjacentItems = useMemo(() => {
    const previousById = new Map<string, TimelineItem>();
    const nextById = new Map<string, TimelineItem>();
    const ordered = [...items].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const left = ordered[index]!;
      const right = ordered[index + 1]!;
      if (left.startFrame + left.durationInFrames !== right.startFrame) continue;
      nextById.set(left.id, right);
      previousById.set(right.id, left);
    }
    return { previousById, nextById };
  }, [items]);
  const rollTrimState = useMemo<TimelineState>(() => ({
    ...state,
    fps: state.fps,
    items: state.items,
    tracks: state.tracks,
    assets: state.assets,
    linkGroups: state.linkGroups,
    multicamGroups: state.multicamGroups,
    transitions: state.transitions,
  }), [state.assets, state.fps, state.items, state.linkGroups, state.multicamGroups, state.tracks, state.transitions]);
  const rollPlansByLeft = useMemo(() => {
    const plans = new Map<string, { right: TimelineItem; plan: ReturnType<typeof planRollingTrim> }>();
    if (pickMode || editMode !== 'selection') return plans;
    for (const [leftId, right] of adjacentItems.nextById) {
      plans.set(leftId, { right, plan: planRollingTrim(rollTrimState, leftId, right.id, 0) });
    }
    return plans;
  }, [adjacentItems, editMode, pickMode, rollTrimState]);
  const renderedItems = useMemo(() => visibleTimelineItems(
    indexes.itemWindowsByTrack.get(trackId),
    visibleWindow,
    previewPinnedItemIds,
    indexes.itemById,
    indexes.itemOrderById,
    trackId,
  ), [indexes, previewPinnedItemIds, trackId, visibleWindow]);
  const transitions = useMemo(() => indexes.transitionsByTrack.get(trackId) ?? [], [indexes, trackId]);
  const visibleTransitions = useMemo(() => transitions.filter((transition) => {
    const incoming = indexes.itemById.get(transition.incomingItemId);
    if (!incoming) return false;
    const transitionStart = incoming.startFrame - Math.floor(transition.durationInFrames / 2);
    return previewPinnedItemIds.has(transition.incomingItemId)
      || previewPinnedItemIds.has(transition.outgoingItemId)
      || !!intersectFrameRange(transitionStart, transition.durationInFrames, visibleWindow);
  }), [indexes, previewPinnedItemIds, transitions, visibleWindow]);
  const laneKind = trackKind(state, trackId);
  const laneIsEffect = isEffectTrack(state, trackId, mainTrackId(state));
  const laneIsText = isTextTrack(state, trackId, mainTrackId(state));
  const dragItem = drag?.mode === 'move' ? state.items.find((candidate) => candidate.id === drag.id) : undefined;
  const dragOffsetY = drag?.mode === 'move'
    && !!dragItem
    && canItemMoveToTrack(state, dragItem, drag.targetTrack)
    ? (trackIds.indexOf(drag.targetTrack) - trackIds.indexOf(drag.baseTrack)) * rowHeight
    : 0;
  return (
    <div
      data-timeline-track-lane
      className="cc-track-lane"
      data-caption-selection-region="timeline"
      style={{
        // locked lane: slightly dimmed (the background color of the locked lane is dimmed; the lock icon is highlighted at the same time)
        flex: 1, position: 'relative', background: locked ? `color-mix(in srgb, ${theme.bg} 70%, ${themeAlpha.shadow(1)})` : undefined, opacity: hidden ? 0.4 : locked ? 0.75 : 1,
        outline: libDropTarget === `track:${trackId}` ? '0.5px dashed #6a9fd8' : undefined,
        outlineOffset: -2,
        cursor: pickMode ? 'crosshair' : undefined,
      }}
      onPointerDown={(e) => {
        if (pickMode) { startPick(e, 'lane'); return; }
        // selection mode: empty-lane drag → marquee multi-select
        if (editMode === 'selection' && !locked) startMarquee(e);
      }}
      onContextMenu={(e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest('[data-timeline-clip], .cc-transition-marker')) return;
        e.preventDefault();
        e.stopPropagation();
        onTrackContextMenu({ trackId, x: e.clientX, y: e.clientY, frame: frameFromClientX(e.clientX) });
      }}
      onDragOver={(e) => {
        if ((locked && !hasLibraryDrag(e)) || (!hasLibraryDrag(e)
          && !hasCompatibleMediaDrag(e, laneKind, laneIsText, laneIsEffect)
          && (laneIsText || laneIsEffect || !hasExternalFiles(e.dataTransfer)))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setLibDropTarget(`track:${trackId}`);
      }}
      onDragLeave={() => setLibDropTarget((t) => (t === `track:${trackId}` ? null : t))}
      onDrop={(e) => {
        const files = droppedFiles(e.dataTransfer);
        if (files.length) {
          setLibDropTarget(null);
          if (locked || !onDropExternalFiles) return;
          e.preventDefault();
          e.stopPropagation();
          onDropExternalFiles(files, trackId, frameFromClientX(e.clientX));
          return;
        }
        const mediaDrop = parseMediaAssetDrop(e);
        if (mediaDrop) {
          setLibDropTarget(null);
          e.preventDefault();
          e.stopPropagation();
          const payload = parseEditorDrag(e);
          if (!locked) {
            const assetIds = payload?.source === 'media' ? mediaAssetIds(payload) : [mediaDrop.assetId];
            const invalid = assetIds.some((id) => {
              const asset = state.assets?.find((candidate) => candidate.id === id);
              return !asset || !canDropMediaAsset(asset, laneKind, laneIsText, laneIsEffect);
            });
            if (invalid) {
              window.alert(t(laneIsText ? '文字轨道只能放文字片段，不能放置视频、图片或音频素材。' : '所选素材包含不适合这条轨道的类型，请拖到对应的视频或音频轨道。'));
              return;
            }
            commands.beginHistoryGesture();
            try { placeMediaAssets({
              assetIds,
              assets: (state.assets ?? []).filter((asset) => canDropMediaAsset(asset, laneKind, laneIsText, laneIsEffect)),
              startFrame: frameFromClientX(e.clientX),
              sourceRangeFor: (asset) => payload?.source === 'media'
                ? mediaSourceRangeFor(payload, asset.id) : mediaDrop.sourceRange,
              add: (asset, startFrame, range) => commands.addMediaItem(asset, {
              track: trackId,
              startFrame,
              ...range,
              ripple: rippleOnDrop,
              overwrite: overwriteOnDrop,
              volume: mediaPlacementVolume(asset.kind, mediaDrop.purpose),
              }),
              select: commands.selectItems,
            }); } catch (error) {
              window.alert(error instanceof Error ? error.message : t('素材选段无法加入这条轨道，请检查选段范围。'));
            } finally { commands.endHistoryGesture(); }
          }
          return;
        }
        const payload = parseLibraryDrag(e);
        setLibDropTarget(null);
        if (!payload || (locked && payload.kind !== 'sound')) return;
        e.preventDefault();
        e.stopPropagation();
        // Prefer clip under cursor if any (fx/lut/zoom/transition)
        const f = frameFromClientX(e.clientX);
        const hit = items.find((it) => f >= it.startFrame && f < it.startFrame + it.durationInFrames);
        if (hit && (payload.kind === 'fx' || payload.kind === 'lut' || payload.kind === 'zoom' || payload.kind === 'transition')) {
          applyLibraryToClip(payload, hit);
          return;
        }
        applyLibraryToTrack(payload, trackId, f);
      }}
    >
      {renderedItems.map((it) => {
        const planned = plannedItems.get(it.id);
        const selected = isItemSelected(state, it.id);
        const captionInitiatedDelta = selectionMovePreviewDeltaForItem(it.id, selectionMovePreview);
        const captionInitiatedMove = selectionMovePreview?.itemIds.includes(it.id) ?? false;
        // Group-move preview: every selected clip rides the same delta as the grab handle.
        const groupMove = captionInitiatedMove || (!!drag
          && drag.mode === 'move'
          && pointer.dragSelection.itemIds.includes(it.id));
        const dragging = drag?.id === it.id || groupMove;
        const stretchEdge = drag?.mode === 'trim-left' ? 'left' : drag?.mode === 'trim-right' ? 'right' : null;
        const stretch = editMode === 'rate-stretch' && drag?.id === it.id && stretchEdge
          ? rateStretchGeometry(it, stretchEdge, drag.deltaF) : null;
        const moveDelta = captionInitiatedMove
          ? captionInitiatedDelta
          : dragging && drag && (drag.mode === 'move' || drag.mode === 'trim-left') ? drag.deltaF : 0;
        const start = planned?.startFrame ?? stretch?.startFrame ?? (it.startFrame + moveDelta);
        const durTrim = drag?.id === it.id && drag.mode === 'trim-left' ? -drag.deltaF
          : drag?.id === it.id && drag.mode === 'trim-right' ? drag.deltaF : 0;
        const dur = planned?.durationInFrames ?? stretch?.durationInFrames ?? Math.max(1, it.durationInFrames + durTrim);
        const mediaIntersection = intersectFrameRange(start, dur, visibleWindow);
        const liveSlip = drag?.id === it.id && drag.mode === 'slip'
          ? planSlip(state, it.id, drag.deltaF)
          : null;
        const renderSrcIn = planned ? planned.srcInFrame ?? 0 : liveSlip?.ok
          ? liveSlip.srcInFrame
          : drag?.id === it.id && drag.mode === 'trim-left' && !stretch
            ? sourceWindowForTimelineRange(
                it.kind === 'audio' && hasOperationalTranscript(it) ? { ...it, playbackRate: 1 } : it,
                drag.deltaF,
                dur,
              ).startFrame
            : it.srcInFrame ?? 0;
        const renderPlaybackRate = stretch?.playbackRate ?? (it.playbackRate ?? 1);
        const canRateStretch = it.kind === 'video' || it.kind === 'audio';
        const canSlip = it.kind === 'video' || it.kind === 'audio';
        const audioMuted = muted && (it.kind === 'audio' || it.kind === 'video');
        const showHandles = !pickMode && editMode !== 'blade' && editMode !== 'pen' && editMode !== 'slip'
          && (editMode !== 'rate-stretch' || canRateStretch);
        const rollEntry = rollPlansByLeft.get(it.id);
        const rollRight = rollEntry?.right;
        const rollLeft = !pickMode && editMode === 'selection' ? adjacentItems.previousById.get(it.id) : undefined;
        const rollPlan = rollEntry?.plan ?? null;
        const rollBlocked = !!rollPlan?.error || !!(rollPlan?.limitMessage && rollPlan.deltaF === 0);
        const rawClipWidthPx = dur * px;
        const clipWidthPx = Math.max(2, rawClipWidthPx);
        const compactClip = clipWidthPx < 28;
        const narrowClip = clipWidthPx < 16;
        const handleLayout = clipEdgeHandleLayout(rawClipWidthPx, editMode, !!rollLeft, !!(rollRight && rollPlan), rollRight ? rollRight.durationInFrames * px : 0);
        const isLibOver = libDropTarget === it.id;
        const itemIndex = itemGeometryById.indexById.get(it.id) ?? 0;
        const overlapSpans = start === it.startFrame && dur === it.durationInFrames
          ? (itemGeometryById.staticOverlapById.get(it.id) ?? EMPTY_OVERLAP_SPANS)
          : topClipOverlapSpansInPrefix(start, dur, items, itemIndex);
        const attachment = attachmentFeedback.get(it.id);
        const attachmentHint = attachment
          ? `${t('依附主片段')}：${attachment.owner.name} · ${t(!attachment.active ? '联动已关闭或此类型未启用，当前不会跟随'
            : attachment.locked ? '关联轨道已锁定，请先解锁后再移动主片段' : '跟随主片段移动或删除；可右键解除依附')}`
          : undefined;
        const displayName = it.kind === 'audio' && it.src?.startsWith('/sound-effects/') ? tData(it.name) : it.name;
        let clipTitle = attachmentHint ? `${displayName} · ${attachmentHint}` : displayName;
        if (editMode === 'slip' && !canSlip) clipTitle = `${displayName} · ${t('此类型没有可滑移的源区间')}`;
        else if (audioMuted) clipTitle += ` · ${t('轨道已静音')}`;
        if (locked) clipTitle += ` · ${t('轨道已锁定，请先解锁')}`;
        return (
          <div
            key={it.id}
            className={`cc-timeline-clip${selected ? ' is-selected' : ''}${isLibOver ? ' is-library-over' : ''}${audioMuted ? ' is-audio-muted' : ''}${attachment?.highlighted ? ' is-linked-follower' : ''}${attachment?.locked ? ' is-link-blocked' : ''}`}
            data-timeline-clip
            data-compact-clip={compactClip ? 'true' : undefined}
            data-narrow-clip={narrowClip ? 'true' : undefined}
            data-main-clip-id={attachment?.owner.id}
            data-linkage-active={attachment ? attachment.active : undefined}
            title={clipTitle}
            data-clip-kind={it.kind}
            onDoubleClick={() => { if (it.kind === 'sequence' && it.timelineId) commands.switchTimeline(it.timelineId); }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if (pickMode) { // selection mode: click → item ref, drag → timerange (no editing)
                commands.selectItem(it.id);
                startPick(e, 'clip', it);
                return;
              }
              if (editMode === 'slip') {
                const availability = canSlip ? planSlip(state, it.id, 0) : null;
                if (availability?.ok) startDrag(e, it.id, 'slip', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0);
                else {
                  e.stopPropagation();
                  commands.selectItem(it.id);
                }
                return;
              }
              if (editMode === 'blade') { // blade mode: click cuts the clip here
                e.stopPropagation();
                const f = Math.round(frameFromClientX(e.clientX));
                if (f > it.startFrame && f < it.startFrame + it.durationInFrames) commands.splitItem(it.id, f);
                return;
              }
              if (editMode === 'pen') { // pen: 1st click selects, next clicks punch a kf (vertical = value; audio = volume, rest = transparency)
                e.stopPropagation();
                if (e.button !== 0) return;
                if (!isItemSelected(state, it.id)) { commands.selectItem(it.id); return; }
                if (locked) return;
                const prop = it.kind === 'audio' ? 'volume' as const : 'opacity' as const;
                const [lo, hi] = getKeyframePropertyDefinition(prop).editorRange;
                const rect = e.currentTarget.getBoundingClientRect();
                const f = Math.max(0, Math.min(it.durationInFrames - 1, Math.round(frameFromClientX(e.clientX)) - it.startFrame));
                const frac = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / Math.max(1, rect.height)));
                commands.setItemKeyframe(it.id, prop, f, Math.round((lo + frac * (hi - lo)) * 100) / 100);
                return;
              }
              startDrag(e, it.id, 'move', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              // Keep multi-select when right-clicking an already-selected clip
              // The context menu does not collapse the current selection set.
              if (!isItemSelected(state, it.id)) commands.selectItems(groupedItemIds(state, [it.id]));
              onContextMenu({ id: it.id, x: e.clientX, y: e.clientY });
            }}
            onDragOver={(e) => {
              if (!hasLibraryDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setLibDropTarget(it.id);
            }}
            onDragLeave={(e) => {
              e.stopPropagation();
              setLibDropTarget((t) => (t === it.id ? null : t));
            }}
            onDrop={(e) => {
              const payload = parseLibraryDrag(e);
              setLibDropTarget(null);
              if (!payload || (locked && payload.kind !== 'sound')) return;
              e.preventDefault();
              e.stopPropagation();
              if (!applyLibraryToClip(payload, it)) {
                // Audio follows the mouse's editorial moment, even over a clip.
                applyLibraryToTrack(payload, it.track,
                  payload.kind === 'sound' ? frameFromClientX(e.clientX) : it.startFrame);
              }
            }}
            style={{
              position: 'absolute', left: Math.max(0, start) * px, top: 4, height: rowHeight - 8, width: clipWidthPx,
              borderRadius: narrowClip ? 2 : compactClip ? 4 : undefined, overflow: 'visible',
              transform: planned ? (planned.track !== it.track ? `translate3d(0, ${(trackIds.indexOf(planned.track) - trackIds.indexOf(it.track)) * rowHeight}px, 0)` : undefined)
                : dragging && dragOffsetY ? `translate3d(0, ${dragOffsetY}px, 0)` : undefined,
              zIndex: dragging ? 10 : undefined,
              cursor: pickMode ? 'copy' : locked ? 'not-allowed' : editMode === 'slip' ? canSlip ? 'ew-resize' : 'not-allowed' : editMode === 'blade' || editMode === 'pen' ? 'crosshair' : 'grab', userSelect: 'none', touchAction: 'none',
            }}
          >
            <div className="cc-clip-surface" style={{
              background: CLIP_COLOR[it.kind] ?? theme.clipMg,
              // The video thumbnail frame bar is drawn by ClipMediaLayers (CSS background cannot load mp4); the image still uses itself as the background.
              backgroundImage: it.kind === 'image' && it.src ? `linear-gradient(90deg, transparent 0%, rgba(0,0,0,.4) 78%), url(${it.src})` : undefined,
              backgroundSize: 'auto 100%', backgroundRepeat: 'no-repeat',
            }}>
            {(it.kind === 'audio' || it.kind === 'video') && (
              <ClipMediaLayers
                item={it} px={px} fps={state.fps} height={rowHeight - 10}
                clipStartFrame={start} durationInFrames={dur}
                srcInFrame={renderSrcIn} playbackRate={renderPlaybackRate}
                visibleWindow={visibleWindow}
              />
            )}
            {overlapSpans.map((span) => (
              <span
                key={`${span.startFrame}:${span.endFrame}`}
                className="cc-clip-overlap-region"
                aria-hidden="true"
                style={{
                  left: (span.startFrame - start) * px,
                  width: (span.endFrame - span.startFrame) * px,
                }}
              />
            ))}
            {audioMuted && (
              <span className="cc-clip-muted-indicator" title={t('轨道已静音')} aria-label={t('轨道已静音')}>
                <Icon name="volumeOff" size={11} />
              </span>
            )}
            {attachment && <span className={`cc-clip-attachment${attachment.highlighted ? ' is-active' : ''}${attachment.locked ? ' is-blocked' : ''}`}
              title={attachmentHint} aria-label={attachmentHint}>
              <Icon name={attachment.locked ? 'lock' : 'paperclip'} size={11} />
              {dur * px >= 180 && <span>{t(attachment.highlighted ? attachment.locked ? '联动受锁定' : '将联动' : attachment.active ? '依附' : '依附暂停')}</span>}
            </span>}
            {it.kind === 'audio' && !hasRealWavePreviewSource(it.src, it.kind) && mediaIntersection && (() => {
              const left = (mediaIntersection.startFrame - start) * px + 3;
              const width = Math.max(1, (mediaIntersection.endFrame - mediaIntersection.startFrame) * px - 6);
              return (
                <svg className="cc-audio-waveform" viewBox={`0 0 ${width} 24`}
                  preserveAspectRatio="none" aria-hidden style={{ left, width }}>
                  <path d={waveformPath(`${it.id}:${it.name}:${mediaIntersection.startFrame}`, width)} />
                </svg>
              );
            })()}
            <span className="cc-clip-duration" data-cc-live-duration={dur}>{fmt(dur, state.fps)}</span>
            <ClipEffectBadges item={it} inTransition={indexes.transitionByIncomingId.get(it.id) ?? null} />
            {/* pen mode: keyframe rubber band on the selected clip (vertical = value; audio = volume 0..2, rest = transparency 0..1)*/}
            {editMode === 'pen' && selected && (() => {
              const prop = it.kind === 'audio' ? 'volume' as const : 'opacity' as const;
              const [lo, hi] = getKeyframePropertyDefinition(prop).editorRange;
              const raw = it.keyframes?.[prop] ?? [];
              const kfs = penDrag?.itemId === it.id
                ? upsertKeyframe(raw.filter((k) => k.frame !== penDrag.fromFrame), penDrag.frame, penDrag.value, penDrag.easing)
                : raw;
              if (!kfs.length) return null;
              const h = rowHeight - 10;
              const w = Math.max(1, dur * px - 2);
              const yOf = (v: number) => 3 + (1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) * (h - 6);
              const pts = kfs.map((k) => `${(k.frame * px).toFixed(1)},${yOf(k.value).toFixed(1)}`).join(' ');
              const band = `0,${yOf(kfs[0].value).toFixed(1)} ${pts} ${w.toFixed(1)},${yOf(kfs[kfs.length - 1].value).toFixed(1)}`;
              return (
                <>
                  {/* ponytail: segments draw as straight lines even when eased — the dots are the editing surface */}
                  <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-hidden>
                    <polyline points={band} fill="none" stroke="#ffd866" strokeWidth={1.2} opacity={0.9} />
                  </svg>
                  {kfs.map((k) => (
                    <div
                      key={k.frame}
                      title={t(prop === 'volume' ? '音量 {pct}% @ {sec}s — 拖动改帧/值 · 右键删除' : '透明度 {pct}% @ {sec}s — 拖动改帧/值 · 右键删除', { pct: Math.round(k.value * 100), sec: (k.frame / state.fps).toFixed(2) })}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.button !== 0 || locked) return;
                        // capture on the scroll container: the dot itself remounts as its
                        // frame (= React key) changes mid-drag, which would drop capture
                        scrollRef.current?.setPointerCapture?.(e.pointerId);
                        const lane = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                        setPenDrag({ itemId: it.id, prop, fromFrame: k.frame, frame: k.frame, value: k.value, easing: k.easing, laneTop: lane.top, laneHeight: lane.height });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!locked) commands.removeItemKeyframe(it.id, prop, k.frame);
                      }}
                      style={{ position: 'absolute', left: k.frame * px - 4, top: yOf(k.value) - 4, width: 8, height: 8,
                        background: '#ffd866', border: '0.5px solid rgba(0,0,0,0.85)', transform: 'rotate(45deg)', pointerEvents: 'auto',
                        cursor: 'grab', zIndex: 3, touchAction: 'none' }}
                    />
                  ))}
                </>
              );
            })()}
            {/* trim handles (hidden in blade / pen / selection-pick modes) */}
            <span className={`cc-clip-label${it.kind === 'audio' ? ' audio' : ''}`}>{displayName}</span>
            </div>
            {rollRight && rollPlan && handleLayout.showRollRight && <button type="button" data-roll-handle
              className="cc-roll-grip" aria-label={t('滚动裁剪左右片段')}
              aria-disabled={rollBlocked} aria-keyshortcuts="ArrowLeft ArrowRight"
              title={rollPlan.error ?? rollPlan.limitMessage ?? t('拖动接缝同时调整左右片段边界；箭头键逐帧调整')}
              style={{ position: 'absolute', right: -4, top: 0, bottom: 0 }}
              onPointerDown={(event) => { if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const livePlan = planRollingTrim(commands.getState?.() ?? state, it.id, rollRight.id, 0);
                const reason = livePlan.error ?? (livePlan.limitMessage && livePlan.deltaF === 0 ? livePlan.limitMessage : undefined);
                if (reason) { showAppToast(reason, { error: !!livePlan.error }); return; }
                startRollDrag(event, it.id, rollRight.id);
              }}
              onKeyDown={(event) => {
                const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
                if (!delta && event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                if (!delta) { showAppToast(t('拖动握柄连续调整；使用左右方向键逐帧滚动裁剪。')); return; }
                const liveState = commands.getState?.() ?? state;
                const next = planRollingTrim(liveState, it.id, rollRight.id, delta);
                if (next.error) showAppToast(next.error, { error: true });
                else {
                  if (next.state !== liveState) commands.applyRollingTrim(it.id, rollRight.id, delta);
                  if (next.limitMessage) showAppToast(next.limitMessage);
                }
              }}
            />}
            {showHandles && handleLayout.trimWidth > 0 && <div onPointerDown={(e) => { if (e.button !== 0) return; startDrag(e, it.id, 'trim-left', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0); }}
              style={{ position: 'absolute', left: handleLayout.leftOffset, top: 0, width: handleLayout.trimWidth, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' || editMode === 'rate-stretch' ? themeAlpha.accent(0.35) : 'transparent' }} />}
            {showHandles && handleLayout.trimWidth > 0 && <div onPointerDown={(e) => { if (e.button !== 0) return; startDrag(e, it.id, 'trim-right', it.startFrame, it.durationInFrames, it.track, it.srcInFrame ?? 0); }}
              style={{ position: 'absolute', right: handleLayout.rightOffset, top: 0, width: handleLayout.trimWidth, height: '100%', cursor: 'ew-resize', background: editMode === 'trim' || editMode === 'rate-stretch' ? themeAlpha.accent(0.35) : 'transparent' }} />}
          </div>
        );
      })}
      {/* transition badges at each cut on this track */}
      {visibleTransitions.map((tn) => {
        const inItem = indexes.itemById.get(tn.incomingItemId);
        if (!inItem) return null;
        const label = t(TRANSITION_LABELS[tn.type as TransitionType] ?? tn.type);
        return (
          <div key={tn.id} title={`${label} · ${(tn.durationInFrames / state.fps).toFixed(1)}s`}
            onClick={() => commands.selectItem(tn.incomingItemId)}
            // The badge is the transition's only handle on the timeline: without this
            // it could be selected but never edited or removed from where it is drawn.
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onTransitionContextMenu({ id: tn.id, x: event.clientX, y: event.clientY });
            }}
            className="cc-transition-marker"
            style={{ position: 'absolute', top: '50%', left: inItem.startFrame * px, transform: 'translate(-50%, -50%)', zIndex: 3 }}>
            <Icon name="swap" size={10} />
          </div>
        );
      })}
    </div>
  );
});
