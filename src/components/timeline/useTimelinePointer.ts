// Timeline pointer state machine (translated verbatim from Timeline.tsx): four mutually exclusive gestures - fragment drag/crop (drag),
// Marquee selection in blank space (marquee), pen keyframe point drag (penDrag), selection mode reference picking (pickDrag).
// move/up are hung on the scroll container; each gesture setsPointerCapture to the appropriate target.
// The applySnap and multi-select click semantics are also here - they are only used by this machine.
import { useCallback, useEffect, useRef, useState, type RefObject, type SetStateAction } from 'react';
import {
  isItemSelected, selectedIdsOf, trackKind,
  type KeyframeEasing, type KeyframeProp, type TimelineItem, type TimelineState, type TrackId,
} from '../../editor/types';
import { upsertKeyframe } from '../../editor/keyframes';
import { getKeyframePropertyDefinition } from '../../editor/keyframeRegistry';
import { remainingSourceFrames, sourceFramesToTimelineFrames } from '../../editor/sourceLimit';
import {
  collectTimelineSnapPoints, snapDraggedEdges, sortTimelineSnapPoints,
  type SnapHold, type SnapPoint,
} from '../../editor/snap';
import type { EditorCommands } from '../../editor/store';
import type { CaptionSelectionRef } from '../../captions/captionSelection';
import {
  clampTimelineSelectionDelta,
  moveTimelineSelectionByDelta,
  resolveItemDragSelection,
} from '../../captions/captionGroupMove';
import { emitSelectionRef, resolveTimelinePick, type TimelinePickDrag } from '../../agent/selection-refs';
import { SNAP_PX, type Drag, type DragMode, type EditMode } from './timelineUtil';
import { commitTimelineDragGesture, predecessorRightEdge, planTimelineMagneticTrim } from './timelineDragCommit';
import { linkedItemIds } from '../../editor/linkGroups';
import { mainTrackId, planDirectionalChange, planMagneticMove } from '../../editor/magneticTimeline';
import { canItemMoveToTrack, expandSelectionItemIds } from '../../editor/multiSelect';
import { trimFoldGroupEdge } from '../../editor/foldGroups';
import { planRollingTrim } from '../../editor/rollingTrim';
import { incrementalTimelineDragFrames } from './timelineAutoScroll';
export { commitTimelineDragGesture } from './timelineDragCommit';

export interface PenDrag {
  itemId: string; prop: KeyframeProp; fromFrame: number; frame: number; value: number; easing?: KeyframeEasing;
  laneTop: number; laneHeight: number;
}
export interface Marquee { x0: number; y0: number; x1: number; y1: number; additive: boolean }
export interface TimelineMarqueeSelection {
  itemIds: string[];
  captionSelections: CaptionSelectionRef[];
}

type PointerStateSetter<T> = (next: SetStateAction<T>, publish?: boolean) => void;

function usePointerState<T>(initial: T) {
  const [value, publishValue] = useState(initial);
  const ref = useRef(value);
  const setValue: PointerStateSetter<T> = useCallback((next, publish = true) => {
    const resolved = typeof next === 'function'
      ? (next as (current: T) => T)(ref.current)
      : next;
    ref.current = resolved;
    if (publish) publishValue(resolved);
  }, [publishValue]);
  return [value, setValue, ref] as const;
}

interface PointerDeps {
  state: TimelineState;
  commands: EditorCommands;
  editMode: EditMode;
  snapping: boolean;
  pickMode: boolean;
  px: number;
  playheadRef: RefObject<number>;
  scrollRef: RefObject<HTMLDivElement | null>;
  frameFromClientX: (clientX: number) => number;
  trackFromClientY: (clientY: number) => TrackId;
  /** clips and caption cues intersecting a client-space marquee rect */
  selectionInMarquee: (left: number, top: number, right: number, bottom: number) => TimelineMarqueeSelection;
  onMarqueeCaptionSelect: (
    selections: CaptionSelectionRef[],
    options: { additive: boolean; preserveWithItems: boolean },
  ) => void;
  selectedCaptions: CaptionSelectionRef[];
  /** True when a timeline drag is released over the Agent composer. */
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  /** Add the frozen mixed selection to chat instead of committing a timeline move. */
  onDropSelectionToChat?: (selection: TimelineMarqueeSelection) => void;
  onGestureStart?: (pointerId: number, clientX: number, clientY: number) => void;
  onGestureEnd?: () => void;
}

export function useTimelinePointer(deps: PointerDeps) {
  const {
    state, commands, editMode, snapping, pickMode, px,
    playheadRef, scrollRef, frameFromClientX, trackFromClientY, selectionInMarquee,
    onMarqueeCaptionSelect, selectedCaptions, isOverChatComposer, onDropSelectionToChat,
    onGestureStart, onGestureEnd,
  } = deps;
  const [drag, setDrag, dragRef] = usePointerState<Drag | null>(null);
  // pen mode: one opacity keyframe dot being dragged (live preview, atomic commit on release)
  const [penDrag, setPenDrag, penDragRef] = usePointerState<PenDrag | null>(null);
  /** Rubber-band multi-select on empty lane (selection mode). Client coords. */
  const [marquee, setMarquee, marqueeRef] = usePointerState<Marquee | null>(null);
  const [pickDrag, setPickDrag, pickDragRef] = usePointerState<TimelinePickDrag | null>(null);
  /** Complete mixed selection frozen at pointer-down. */
  const dragSelectionRef = useRef<TimelineMarqueeSelection>({ itemIds: [], captionSelections: [] });
  /** Plain click (no drag) on one already-selected clip collapses batch selection on release. */
  const collapseDragClickRef = useRef<{ id: string; startX: number; startY: number } | null>(null);
  /** The currently sucked target is held (hysteresis) across pointermove within one drag, and cleared when released. */
  const snapHold = useRef<SnapHold | null>(null);
  const gestureSnapPoints = useRef<SnapPoint[]>([]);
  const pendingSnapExcludeRef = useRef<readonly string[] | null>(null);
  const pendingMove = useRef<{ clientX: number; clientY: number } | null>(null);
  const pointerMoveRaf = useRef(0);

  const startPick = (e: React.PointerEvent, origin: TimelinePickDrag['origin'], item?: TimelineItem) => {
    e.stopPropagation();
    if (e.button !== 0) return; // left button only; right-click keeps the context menu
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const f = frameFromClientX(e.clientX);
    const trackId = origin === 'clip' ? item?.track : origin === 'lane' ? trackFromClientY(e.clientY) : undefined;
    setPickDrag({ origin, startFrame: f, endFrame: f, trackId, item });
    onGestureStart?.(e.pointerId, e.clientX, e.clientY);
  };
  /** Start rubber-band on empty track body (clips stopPropagation so they never hit this). */
  const startMarquee = (e: React.PointerEvent) => {
    if (pickMode || editMode !== 'selection' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (!additive) {
      commands.selectItem(null);
      onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
    }
    // Capture on the scroll container so move/up keep firing (same target as handlers).
    scrollRef.current?.setPointerCapture?.(e.pointerId);
    setMarquee({
      x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY,
      additive,
    });
    onGestureStart?.(e.pointerId, e.clientX, e.clientY);
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: DragMode, baseStart: number, baseDur: number, baseTrack: TrackId, baseSrcIn = 0, foldGroupId?: string) => {
    if (e.button !== 0) return;
    if (state.tracks?.[baseTrack]?.locked) return;
    const wasSelected = isItemSelected(state, id);
    const additive = e.metaKey || e.ctrlKey;
    const resolvedSelection = resolveItemDragSelection(
      id,
      selectedIdsOf(state),
      selectedCaptions,
      { shiftKey: e.shiftKey, anchorItemId: state.selectedId, items: state.items },
    );
    const singleUnitIds = mode === 'move' ? expandSelectionItemIds(state, [id]) : [id];
    const unit = new Set(singleUnitIds);
    dragSelectionRef.current = mode === 'move'
      ? additive
        ? {
            itemIds: wasSelected
              ? selectedIdsOf(state).filter((candidate) => !unit.has(candidate))
              : expandSelectionItemIds(state, [...new Set([...selectedIdsOf(state), id])]),
            captionSelections: [...selectedCaptions],
          }
        : {
            itemIds: expandSelectionItemIds(state, resolvedSelection.itemIds),
            captionSelections: resolvedSelection.captionSelections,
          }
      : { itemIds: [id], captionSelections: [] };
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!wasSelected && !additive && !e.shiftKey) {
      onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
    }
    // Multi-select: ⌘/Ctrl toggle, ⇧ range on same track; plain click replaces.
    if (additive) {
      onMarqueeCaptionSelect([], { additive: true, preserveWithItems: true });
      if (singleUnitIds.length > 1) {
        commands.selectItems(dragSelectionRef.current.itemIds);
      } else {
        commands.selectItem(id, { mode: 'toggle' });
      }
    } else if (e.shiftKey && state.selectedId) {
      if (dragSelectionRef.current.captionSelections.length > 0) {
        onMarqueeCaptionSelect(dragSelectionRef.current.captionSelections, { additive: false, preserveWithItems: true });
      }
      if (dragSelectionRef.current.itemIds.length > 1) commands.selectItems(dragSelectionRef.current.itemIds);
      else commands.selectItem(id);
    } else if (!wasSelected) {
      if (singleUnitIds.length > 1) {
        commands.selectItems(dragSelectionRef.current.itemIds);
      } else {
        commands.selectItem(id);
      }
    }
    const hasBatchSelection = selectedIdsOf(state).length > singleUnitIds.length || selectedCaptions.length > 0;
    collapseDragClickRef.current = mode === 'move' && !additive && !e.shiftKey && wasSelected && hasBatchSelection
      ? { id, startX: e.clientX, startY: e.clientY }
      : null;
    // Only start move drag when not pure multi-toggle without drag intent — still allow drag
    snapHold.current = null;
    const excluded = mode === 'move' && dragSelectionRef.current.itemIds.includes(id)
      ? dragSelectionRef.current.itemIds
      : [id];
    if (mode === 'move') {
      gestureSnapPoints.current = [];
      pendingSnapExcludeRef.current = excluded;
    } else {
      pendingSnapExcludeRef.current = null;
      gestureSnapPoints.current = sortTimelineSnapPoints(
        collectTimelineSnapPoints(state, { excludeItemIds: excluded }),
      );
    }
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    setDrag({ id, mode, baseStart, baseDur, baseTrack, baseSrcIn, startX: e.clientX, startY: e.clientY, activated: mode !== 'move', deltaF: 0,
      rawDeltaF: 0, lastClientX: e.clientX, lastScrollLeft: scrollLeft, lastPx: px,
      targetTrack: baseTrack, snapAt: null, ...(foldGroupId ? { foldGroupId } : {}) });
    onGestureStart?.(e.pointerId, e.clientX, e.clientY);
  };
  const startRollDrag = (e: React.PointerEvent, leftId: string, rightId: string) => {
    const liveState = commands.getState?.() ?? state;
    const eligibility = planRollingTrim(liveState, leftId, rightId, 0);
    if (e.button !== 0 || pickMode || eligibility.error
      || eligibility.limitMessage && eligibility.deltaF === 0) return;
    const left = liveState.items.find((item) => item.id === leftId);
    if (!left || liveState.tracks?.[left.track]?.locked) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragSelectionRef.current = { itemIds: [], captionSelections: [] };
    snapHold.current = null;
    gestureSnapPoints.current = sortTimelineSnapPoints(
      collectTimelineSnapPoints(liveState, { excludeItemIds: linkedItemIds(liveState, [leftId, rightId]) }),
    );
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
    setDrag({ id: leftId, rightId, mode: 'roll', baseStart: left.startFrame,
      baseDur: left.durationInFrames, baseTrack: left.track, baseSrcIn: left.srcInFrame ?? 0,
      startX: e.clientX, deltaF: 0, rawDeltaF: 0, lastClientX: e.clientX,
      lastScrollLeft: scrollLeft, lastPx: px, targetTrack: left.track, snapAt: null, plannedState: liveState });
    onGestureStart?.(e.pointerId, e.clientX, e.clientY);
  };
  // All snap targets come from the editor snap registry. Group moves exclude
  // every selected clip so members never snap to each other.
  const applySnap = (mode: DragMode, baseStart: number, baseDur: number, rawDelta: number): { deltaF: number; snapAt: number | null } => {
    if (mode === 'slip') return { deltaF: rawDelta, snapAt: null };
    if (!snapping) return { deltaF: rawDelta, snapAt: null };
    const points = gestureSnapPoints.current;
    const snapMode = mode === 'move' || mode === 'trim-left' ? mode : 'trim-right';
    const result = snapDraggedEdges({
      mode: snapMode,
      baseStart, baseDuration: baseDur, rawDelta, points,
      thresholdFrames: SNAP_PX / px, hold: snapHold.current,
      dynamicPlayheadFrame: playheadRef.current,
    });
    snapHold.current = result.hold;
    return result;
  };
  /**
   * The maximum number of frames the right handle can be dragged to the right: the remaining length of the source asset minus the current duration. Unable to determine (picture/MG/
   * Word Driven Audio) Return to Infinity. Variable speed stretching does not consume additional source frames, so there is no limit to that mode.
   */
  const trimRightCap = (id: string, baseDur: number): number => {
    if (editMode === 'rate-stretch') return Infinity;
    const it = state.items.find((x) => x.id === id);
    if (!it) return Infinity;
    const limit = remainingSourceFrames(it, it.srcInFrame ?? 0, state.assets);
    return limit === null ? Infinity : limit - baseDur;
  };
  /**
   * The minimum (most-negative) delta the left handle may reach: it cannot extend
   * past the nearest preceding same-track clip's right edge (or timeline zero).
   * Mirrors commitTrimGesture so the preview does not show an overlap the commit
   * would clamp away.
   */
  const trimLeftFloor = (id: string, baseStart: number): number => {
    const it = state.items.find((x) => x.id === id);
    if (!it) return -baseStart;
    let floor = -baseStart;
    if (it.kind === 'video' || it.kind === 'audio' || it.kind === 'sequence') {
      const sourceBacktrack = sourceFramesToTimelineFrames(it, it.srcInFrame ?? 0);
      floor = Math.max(floor, -Math.floor(sourceBacktrack));
    }
    if (state.interaction?.magnet && it.track === mainTrackId(state)) return floor;
    return Math.max(
      floor,
      predecessorRightEdge(state, id, it.track, baseStart) - baseStart,
    );
  };
  const applyPointerMove = (clientX: number, clientY: number, publish = true) => {
    const currentMarquee = marqueeRef.current;
    if (currentMarquee) {
      setMarquee({ ...currentMarquee, x1: clientX, y1: clientY }, publish);
      return;
    }
    const currentPick = pickDragRef.current;
    if (currentPick) {
      setPickDrag({ ...currentPick, endFrame: frameFromClientX(clientX) }, publish);
      return;
    }
    const currentPen = penDragRef.current;
    if (currentPen) {
      const it = state.items.find((item) => item.id === currentPen.itemId);
      if (!it) return;
      const frame = Math.max(0, Math.min(
        it.durationInFrames - 1,
        frameFromClientX(clientX) - it.startFrame,
      ));
      const [lo, hi] = getKeyframePropertyDefinition(currentPen.prop).editorRange;
      const frac = Math.max(0, Math.min(
        1,
        1 - (clientY - currentPen.laneTop) / Math.max(1, currentPen.laneHeight),
      ));
      const value = Math.round((lo + frac * (hi - lo)) * 100) / 100;
      setPenDrag({ ...currentPen, frame, value }, publish);
      return;
    }
    const currentDrag = dragRef.current;
    if (!currentDrag) return;
    if (currentDrag.mode === 'move' && currentDrag.activated === false) {
      if (Math.hypot(clientX - currentDrag.startX, clientY - (currentDrag.startY ?? clientY)) < 6) {
        return;
      }
    }
    if (pendingSnapExcludeRef.current !== null) {
      gestureSnapPoints.current = sortTimelineSnapPoints(
        collectTimelineSnapPoints(state, { excludeItemIds: pendingSnapExcludeRef.current }),
      );
      pendingSnapExcludeRef.current = null;
    }
    if (collapseDragClickRef.current && (
      Math.abs(clientX - collapseDragClickRef.current.startX) >= 3
      || Math.abs(clientY - collapseDragClickRef.current.startY) >= 3
    )) {
      collapseDragClickRef.current = null;
    }
    const scrollLeft = scrollRef.current?.scrollLeft ?? currentDrag.lastScrollLeft ?? 0;
    const rawDeltaF = incrementalTimelineDragFrames({
      rawDeltaF: currentDrag.rawDeltaF ?? currentDrag.deltaF,
      clientX, lastClientX: currentDrag.lastClientX ?? currentDrag.startX,
      scrollLeft, lastScrollLeft: currentDrag.lastScrollLeft ?? scrollLeft,
      pixelsPerFrame: px, lastPixelsPerFrame: currentDrag.lastPx ?? px,
    });
    const rawDelta = Math.round(rawDeltaF);
    const updatedDrag = { ...currentDrag, activated: true, rawDeltaF, lastClientX: clientX, lastScrollLeft: scrollLeft, lastPx: px };
    if (currentDrag.mode === 'slip') {
      setDrag({ ...updatedDrag, deltaF: rawDelta, targetTrack: currentDrag.baseTrack, snapAt: null }, publish);
      return;
    }
    const snapped = applySnap(currentDrag.mode, currentDrag.baseStart, currentDrag.baseDur, rawDelta);
    if (currentDrag.mode === 'roll') {
      const liveState = commands.getState?.() ?? state;
      const plan = currentDrag.rightId
        ? planRollingTrim(liveState, currentDrag.id, currentDrag.rightId, snapped.deltaF)
        : { state: liveState, deltaF: 0, error: '滚动裁剪缺少右侧片段。' };
      setDrag({ ...updatedDrag, deltaF: plan.deltaF, targetTrack: currentDrag.baseTrack,
        snapAt: plan.deltaF === snapped.deltaF ? snapped.snapAt : null,
        plannedState: plan.state, planError: plan.error, limitMessage: plan.limitMessage }, publish);
      return;
    }
    const targetTrack = currentDrag.mode === 'move' ? trackFromClientY(clientY) : currentDrag.baseTrack;
    const draggedPrimary = state.items.find((item) => item.id === currentDrag.id);
    const validTargetTrack = currentDrag.mode !== 'move' || targetTrack === currentDrag.baseTrack
      || !draggedPrimary || canItemMoveToTrack(state, draggedPrimary, targetTrack);
    const safeTrack = validTargetTrack ? targetTrack : currentDrag.baseTrack;
    const newLanePlacement: 'top' | 'bottom' | null = null;
    const newLaneDrop = false;
    const magneticMove = currentDrag.mode === 'move' && state.interaction?.magnet
      && (currentDrag.baseTrack === mainTrackId(state) || safeTrack === mainTrackId(state)
        || state.items.some((item) => item.track === mainTrackId(state) && dragSelectionRef.current.itemIds.includes(item.id)))
      && !newLaneDrop;
    if (magneticMove) {
      if (dragSelectionRef.current.captionSelections.length) {
        setDrag({ ...updatedDrag, deltaF: 0, targetTrack, snapAt: null, plannedState: state,
          newTrackDrop: false,
          planError: '主轨磁吸时请单独移动画面片段。若要同时移动手工字幕，请先关闭主轨磁吸。' }, publish);
        return;
      }
      const plan = planMagneticMove(state, dragSelectionRef.current.itemIds, currentDrag.id,
        currentDrag.baseStart + snapped.deltaF, safeTrack);
      setDrag({ ...updatedDrag, targetTrack,
        newTrackDrop: false,
        deltaF: (plan.insertionFrame ?? currentDrag.baseStart) - currentDrag.baseStart,
        snapAt: plan.insertionFrame ?? null, plannedState: plan.state, planError: plan.error }, publish);
      return;
    }
    const minimumDuration = Math.max(6, Math.round(state.fps * 0.5));
    const cap = currentDrag.mode === 'trim-right'
      ? trimRightCap(currentDrag.id, currentDrag.baseDur)
      : currentDrag.mode === 'trim-left'
        ? Math.max(0, currentDrag.baseDur - minimumDuration)
      : Infinity;
    const floor = currentDrag.mode === 'trim-left' ? trimLeftFloor(currentDrag.id, currentDrag.baseStart)
      : currentDrag.mode === 'trim-right'
        ? currentDrag.baseDur < minimumDuration ? 0 : minimumDuration - currentDrag.baseDur
        : -Infinity;
    const trackShift = currentDrag.mode === 'move' && !newLaneDrop && safeTrack !== currentDrag.baseTrack
      ? { from: currentDrag.baseTrack, to: safeTrack }
      : null;
    const selectionDelta = currentDrag.mode === 'move' && !newLaneDrop
      ? clampTimelineSelectionDelta(
        state,
        dragSelectionRef.current.itemIds,
        dragSelectionRef.current.captionSelections,
        snapped.deltaF,
        trackShift,
      )
      : snapped.deltaF;
    const deltaF = Math.min(Math.max(selectionDelta, floor), cap);
    const snapAt = deltaF === snapped.deltaF ? snapped.snapAt : null;
    const nextDrag = { ...updatedDrag, deltaF, targetTrack, snapAt, plannedState: undefined,
      planError: undefined, limitMessage: undefined, newTrackDrop: newLaneDrop, newTrackPlacement: newLanePlacement ?? undefined };
    if (currentDrag.mode === 'move' && !newLaneDrop) {
      const moved = moveTimelineSelectionByDelta(state, dragSelectionRef.current.itemIds,
        dragSelectionRef.current.captionSelections, deltaF, trackShift);
      const plan = state.interaction?.linkage ? planDirectionalChange(state, moved) : { state: moved };
      setDrag({ ...nextDrag, plannedState: plan.state, planError: plan.error }, publish);
      return;
    }
    if (currentDrag.foldGroupId && (currentDrag.mode === 'trim-left' || currentDrag.mode === 'trim-right') && editMode !== 'rate-stretch') {
      const trimmedState = trimFoldGroupEdge(
        state,
        currentDrag.foldGroupId,
        currentDrag.mode === 'trim-left' ? 'left' : 'right',
        deltaF,
        { ripple: editMode === 'trim' },
      );
      setDrag({ ...nextDrag, plannedState: trimmedState }, publish);
      return;
    }
    const trimPlan = planTimelineMagneticTrim(state, nextDrag, editMode);
    setDrag(trimPlan ? { ...nextDrag, plannedState: trimPlan.state, planError: trimPlan.error } : nextDrag, publish);
  };
  const flushPointerMove = (publish: boolean) => {
    if (pointerMoveRaf.current) cancelAnimationFrame(pointerMoveRaf.current);
    pointerMoveRaf.current = 0;
    const move = pendingMove.current;
    pendingMove.current = null;
    if (move) applyPointerMove(move.clientX, move.clientY, publish);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!marqueeRef.current && !pickDragRef.current && !penDragRef.current && !dragRef.current) return;
    if (e.pointerType === 'mouse' && e.nativeEvent.isTrusted && (e.buttons & 1) === 0) {
      cancelPointerGesture();
      return;
    }
    pendingMove.current = { clientX: e.clientX, clientY: e.clientY };
    if (pointerMoveRaf.current) return;
    pointerMoveRaf.current = requestAnimationFrame(() => flushPointerMove(true));
  };
  const cancelPointerGesture = useCallback(() => {
    if (pointerMoveRaf.current) cancelAnimationFrame(pointerMoveRaf.current);
    pointerMoveRaf.current = 0;
    pendingMove.current = null;
    snapHold.current = null;
    gestureSnapPoints.current = [];
    pendingSnapExcludeRef.current = null;
    dragSelectionRef.current = { itemIds: [], captionSelections: [] };
    collapseDragClickRef.current = null;
    setDrag(null);
    setPenDrag(null);
    setMarquee(null);
    setPickDrag(null);
    onGestureEnd?.();
  }, [onGestureEnd, setDrag, setMarquee, setPenDrag, setPickDrag]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (
        !dragRef.current && !penDragRef.current && !marqueeRef.current && !pickDragRef.current
      )) return;
      event.preventDefault();
      event.stopPropagation();
      cancelPointerGesture();
    };
    const onBlur = () => cancelPointerGesture();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      if (pointerMoveRaf.current) cancelAnimationFrame(pointerMoveRaf.current);
      pointerMoveRaf.current = 0;
      pendingMove.current = null;
    };
  }, [cancelPointerGesture, dragRef, marqueeRef, penDragRef, pickDragRef]);
  const onPointerUp = (event: React.PointerEvent) => {
    if (marqueeRef.current || pickDragRef.current || penDragRef.current
      || (dragRef.current && (dragRef.current.mode !== 'move' || dragRef.current.activated !== false))) {
      pendingMove.current = { clientX: event.clientX, clientY: event.clientY };
    }
    flushPointerMove(false);
    onGestureEnd?.();
    const currentMarquee = marqueeRef.current;
    if (currentMarquee) {
      setMarquee(null);
      const dx = Math.abs(currentMarquee.x1 - currentMarquee.x0);
      const dy = Math.abs(currentMarquee.y1 - currentMarquee.y0);
      if (dx < 4 && dy < 4) {
        return;
      }
      const selection = selectionInMarquee(
        Math.min(currentMarquee.x0, currentMarquee.x1),
        Math.min(currentMarquee.y0, currentMarquee.y1),
        Math.max(currentMarquee.x0, currentMarquee.x1),
        Math.max(currentMarquee.y0, currentMarquee.y1),
      );
      onMarqueeCaptionSelect(selection.captionSelections, {
        additive: currentMarquee.additive,
        preserveWithItems: selection.itemIds.length > 0 || (currentMarquee.additive && selectedIdsOf(state).length > 0),
      });
      if (currentMarquee.additive) {
        commands.selectItems(expandSelectionItemIds(state, [...new Set([...selectedIdsOf(state), ...selection.itemIds])]));
      } else {
        commands.selectItems(expandSelectionItemIds(state, selection.itemIds));
      }
      return;
    }
    const currentPick = pickDragRef.current;
    if (currentPick) {
      const ref = resolveTimelinePick(currentPick, Math.max(1, Math.round(4 / px)), state);
      if (ref) emitSelectionRef(ref);
      setPickDrag(null);
      return;
    }
    const currentPen = penDragRef.current;
    if (currentPen) {
      const item = state.items.find((candidate) => candidate.id === currentPen.itemId);
      const original = item?.keyframes?.[currentPen.prop]?.find(
        (keyframe) => keyframe.frame === currentPen.fromFrame,
      );
      if (item && original && (
        original.frame !== currentPen.frame || original.value !== currentPen.value
      )) {
        const moved = upsertKeyframe(
          (item.keyframes?.[currentPen.prop] ?? []).filter(
            (keyframe) => keyframe.frame !== currentPen.fromFrame,
          ),
          currentPen.frame,
          currentPen.value,
          currentPen.easing,
        );
        commands.applyState({
          ...state,
          items: state.items.map((candidate) => candidate.id === item.id
            ? { ...candidate, keyframes: { ...candidate.keyframes, [currentPen.prop]: moved } }
            : candidate),
        });
      }
      setPenDrag(null);
      return;
    }
    const currentDrag = dragRef.current;
    if (!currentDrag) return;
    const collapseClick = collapseDragClickRef.current;
    collapseDragClickRef.current = null;
    if (currentDrag.mode === 'move') {
      if (onDropSelectionToChat && isOverChatComposer?.(event.clientX, event.clientY)) {
        onDropSelectionToChat(dragSelectionRef.current);
        snapHold.current = null;
        gestureSnapPoints.current = [];
        dragSelectionRef.current = { itemIds: [], captionSelections: [] };
        setDrag(null);
        return;
      }
      if (collapseClick && currentDrag.deltaF === 0) {
        commands.selectItems(expandSelectionItemIds(state, [collapseClick.id]));
        onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
        snapHold.current = null;
        gestureSnapPoints.current = [];
        dragSelectionRef.current = { itemIds: [], captionSelections: [] };
        setDrag(null);
        return;
      }
      if (currentDrag.activated === false) {
        snapHold.current = null;
        gestureSnapPoints.current = [];
        dragSelectionRef.current = { itemIds: [], captionSelections: [] };
        setDrag(null);
        return;
      }
      const draggedPrimary = state.items.find((item) => item.id === currentDrag.id);
      const validTrack = !!currentDrag.targetTrack
        && (!draggedPrimary || canItemMoveToTrack(state, draggedPrimary, currentDrag.targetTrack))
        && trackKind(state, currentDrag.targetTrack) === trackKind(state, currentDrag.baseTrack)
        && !state.tracks?.[currentDrag.targetTrack]?.locked;
      const track = validTrack ? currentDrag.targetTrack : currentDrag.baseTrack;
      const next = currentDrag.plannedState ?? moveTimelineSelectionByDelta(
        state,
        dragSelectionRef.current.itemIds,
        dragSelectionRef.current.captionSelections,
        currentDrag.deltaF,
        track !== currentDrag.baseTrack ? { from: currentDrag.baseTrack, to: track } : null,
      );
      if (currentDrag.planError) window.alert(currentDrag.planError);
      else if (next !== state) {
        const planned = state.interaction?.linkage ? planDirectionalChange(state, next) : { state: next };
        if (planned.error) window.alert(planned.error);
        else commands.applyState(planned.state);
      }
    } else {
      commitTimelineDragGesture(state, commands, currentDrag, editMode);
    }
    snapHold.current = null;
    gestureSnapPoints.current = [];
    pendingSnapExcludeRef.current = null;
    dragSelectionRef.current = { itemIds: [], captionSelections: [] };
    collapseDragClickRef.current = null;
    setDrag(null);
  };
  const onPointerCancel = () => cancelPointerGesture();

  return {
    drag,
    dragSelection: dragSelectionRef.current,
    penDrag,
    setPenDrag,
    marquee,
    pickDrag,
    startDrag,
    startRollDrag,
    startPick,
    startMarquee,
    refreshAt: (clientX: number, clientY: number) => applyPointerMove(clientX, clientY),
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}
