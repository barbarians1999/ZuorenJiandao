import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SetStateAction } from 'react';
import { captionPages } from './exportCaptions';
import { buildCaptionPages } from './captionPages';
import { captionTrackEntries, captionsOnTrack, type TimelineState, type TrackId } from '../editor/types';
import { collectTimelineSnapPoints, snapDraggedEdges, sortTimelineSnapPoints, type SnapDraggedEdgesOptions, type SnapPoint } from '../editor/snap';
import { joinCaptionWords, type CaptionDisplayCueEdit, type CaptionPage, type CaptionSourceSpan, type CaptionsData } from './types';
import { newManualCueIdentity } from '../transcript/identity';
import type { TranscriptWord } from '../transcript/types';
import { isManualCaptionEntry, resizeManualCue, rollAdjacentManualCues, type ManualCueEdge } from './manualCaptions';
import { captionSourceSegmentBounds, projectCaptionSourceSpans } from './captionSourceSpans';
import type { CaptionSelectionRef } from './captionSelection';
import { captionDragMoveMode, clampTimelineSelectionDelta, displayCueMoveProblem, resolveCaptionDragSelection, type TimelineSelectionMovePreview } from './captionGroupMove';

const SNAP_PX = 8;

export interface ManualCueTarget {
  laneId: string;
  index: number;
  words: readonly TranscriptWord[];
}

export interface CaptionCueMove {
  laneId: string;
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  targetTrackId: TrackId;
}

export interface DisplayCueTrimTarget {
  laneId: string;
  editId?: string;
  partId?: string;
  key: string;
  text?: string;
  source: TimelineState['items'][number];
  sourceSpans: readonly CaptionSourceSpan[];
}

export function resizeDisplayCueSourceSpans(
  source: TimelineState['items'][number], spans: readonly CaptionSourceSpan[], fps: number,
  edge: ManualCueEdge, deltaFrames: number,
  options?: { minSourceMs?: number; maxSourceMs?: number },
): CaptionSourceSpan[] | null {
  const projected = projectCaptionSourceSpans(source, spans, fps);
  if (!projected.length || projected.length !== spans.length || new Set(projected.map((span) => span.segmentKey)).size !== 1) return null;
  const firstProj = projected[0]!;
  const lastProj = projected.at(-1)!;
  const firstSpan = spans[firstProj.spanIndex];
  const lastSpan = spans[lastProj.spanIndex];
  if (!firstSpan || !lastSpan) return null;
  const sourceFrames = lastProj.sourceEndFrame - firstProj.sourceStartFrame;
  const timelineFrames = lastProj.endFrame - firstProj.startFrame;
  if (sourceFrames < 1 || timelineFrames < 1) return null;
  const sourcePerTimeline = sourceFrames / timelineFrames;
  const minimumFrames = Math.max(6, Math.round(fps * 0.5));
  const minimumMs = Math.max(1, Math.ceil(sourcePerTimeline * minimumFrames)) * 1000 / fps;
  const segBounds = captionSourceSegmentBounds(source, firstProj.segmentKey, fps);
  const segMinMs = segBounds?.minSourceMs ?? 0;
  const segMaxMs = segBounds?.maxSourceMs ?? Number.POSITIVE_INFINITY;
  const cueStartMs = Math.max(segMinMs, firstSpan.startMs);
  const cueEndMs = Math.min(segMaxMs, lastSpan.endMs);
  const deltaMs = Math.round(deltaFrames * sourcePerTimeline) * 1000 / fps;
  if (!deltaMs) return null;

  if (edge === 'start') {
    if (deltaMs > 0) {
      if (cueEndMs - cueStartMs <= minimumMs) return null;
      const targetStartMs = Math.min(cueEndMs - minimumMs, cueStartMs + deltaMs);
      if (targetStartMs <= cueStartMs) return null;
      const nextSpans: CaptionSourceSpan[] = [];
      for (const [index, candidate] of spans.entries()) {
        if (index < firstProj.spanIndex || index > lastProj.spanIndex) {
          nextSpans.push(candidate);
          continue;
        }
        if (candidate.endMs <= targetStartMs) continue;
        nextSpans.push(candidate.startMs < targetStartMs ? { ...candidate, startMs: targetStartMs } : candidate);
      }
      return nextSpans.some((_, idx) => idx >= firstProj.spanIndex) ? nextSpans : null;
    }
    const lower = Math.max(segMinMs, options?.minSourceMs ?? 0);
    const targetStartMs = Math.max(lower, cueStartMs + deltaMs);
    if (targetStartMs >= cueStartMs) return null;
    return spans.map((candidate, index) => index === firstProj.spanIndex
      ? { ...candidate, startMs: targetStartMs }
      : candidate);
  }

  if (deltaMs < 0) {
    if (cueEndMs - cueStartMs <= minimumMs) return null;
    const targetEndMs = Math.max(cueStartMs + minimumMs, cueEndMs + deltaMs);
    if (targetEndMs >= cueEndMs) return null;
    const nextSpans: CaptionSourceSpan[] = [];
    for (const [index, candidate] of spans.entries()) {
      if (index < firstProj.spanIndex || index > lastProj.spanIndex) {
        nextSpans.push(candidate);
        continue;
      }
      if (candidate.startMs >= targetEndMs) continue;
      nextSpans.push(candidate.endMs > targetEndMs ? { ...candidate, endMs: targetEndMs } : candidate);
    }
    return nextSpans.some((_, idx) => idx >= firstProj.spanIndex) ? nextSpans : null;
  }
  const upper = Math.min(segMaxMs, options?.maxSourceMs ?? Number.POSITIVE_INFINITY);
  const targetEndMs = Math.min(upper, cueEndMs + deltaMs);
  if (targetEndMs <= cueEndMs) return null;
  return spans.map((candidate, index) => index === lastProj.spanIndex
    ? { ...candidate, endMs: targetEndMs }
    : candidate);
}

export function displayCueTrimRange(
  target: DisplayCueTrimTarget, fps: number, edge: ManualCueEdge, deltaFrames: number,
): { start: number; end: number } | null {
  const spans = resizeDisplayCueSourceSpans(target.source, target.sourceSpans, fps, edge, deltaFrames);
  if (!spans) return null;
  const projected = projectCaptionSourceSpans(target.source, spans, fps);
  if (!projected.length || new Set(projected.map((span) => span.segmentKey)).size !== 1) return null;
  return {
    start: Math.min(...projected.map((span) => span.startFrame)) * 1000 / fps,
    end: Math.max(...projected.map((span) => span.endFrame)) * 1000 / fps,
  };
}

function applyDisplaySpanUpdate(
  edits: readonly CaptionDisplayCueEdit[] | undefined,
  target: DisplayCueTrimTarget,
  spans: CaptionSourceSpan[],
): CaptionDisplayCueEdit[] {
  if (target.editId && target.partId) {
    return (edits ?? []).map((edit) => edit.id !== target.editId ? edit : ({
      ...edit,
      parts: edit.parts.map((part) => part.id === target.partId ? { ...part, sourceSpans: spans } : part),
    }));
  }
  const coveredWordRefs = [...new Set(target.sourceSpans.map((span) => span.wordRef).filter(Boolean))];
  const text = target.text?.trim() || joinCaptionWords(target.sourceSpans.map((span) => ({ text: span.sourceText })));
  return [...(edits ?? []), {
    id: newManualCueIdentity(),
    coveredWordRefs,
    parts: [{ id: newManualCueIdentity(), text, sourceSpans: spans }],
  }];
}

export function buildDisplayTrimSourceEntries(
  state: TimelineState, trackId: TrackId, target: DisplayCueTrimTarget, spans: CaptionSourceSpan[],
) {
  return (captionsOnTrack(state, trackId)?.sourceEntries ?? []).map((entry) => entry.id !== target.laneId ? entry : ({
    ...entry,
    displayCueEdits: applyDisplaySpanUpdate(entry.displayCueEdits, target, spans),
  }));
}

export function buildDisplayRollSourceEntries(
  state: TimelineState,
  trackId: TrackId,
  left: DisplayCueTrimTarget,
  right: DisplayCueTrimTarget,
  leftSpans: CaptionSourceSpan[],
  rightSpans: CaptionSourceSpan[],
) {
  return (captionsOnTrack(state, trackId)?.sourceEntries ?? []).map((entry) => {
    if (entry.id !== left.laneId && entry.id !== right.laneId) return entry;
    let edits = entry.displayCueEdits;
    if (entry.id === left.laneId) edits = applyDisplaySpanUpdate(edits, left, leftSpans);
    if (entry.id === right.laneId) edits = applyDisplaySpanUpdate(edits, right, rightSpans);
    return { ...entry, displayCueEdits: edits };
  });
}

function clampDisplayTrimDelta(
  state: TimelineState, trackId: TrackId, target: DisplayCueTrimTarget, edge: ManualCueEdge, requested: number,
): number {
  const captions = captionsOnTrack(state, trackId);
  if (!captions) return requested;
  const pages = buildCaptionPages(captions, state.items, state.fps)
    .filter((identity) => identity.laneId === target.laneId)
    .sort((left, right) => left.page.start - right.page.start || left.page.end - right.page.end);
  const index = pages.findIndex((identity) => (
    target.editId && target.partId
      ? identity.displayCueEditId === target.editId && identity.displayCuePartId === target.partId
      : identity.id === target.key
  ));
  if (index < 0) return requested;
  const page = pages[index]!.page;
  const start = Math.round(page.start * state.fps / 1000);
  const end = Math.round(page.end * state.fps / 1000);
  const minimum = Math.max(6, Math.round(state.fps * 0.5));
  if (edge === 'start') {
    const previousEnd = index > 0 ? Math.round(pages[index - 1]!.page.end * state.fps / 1000) : 0;
    const maxDelta = end - start < minimum ? 0 : end - start - minimum;
    return Math.max(previousEnd - start, Math.min(maxDelta, requested));
  }
  const nextStart = index + 1 < pages.length
    ? Math.round(pages[index + 1]!.page.start * state.fps / 1000) : Number.POSITIVE_INFINITY;
  const minDelta = end - start < minimum ? 0 : minimum - (end - start);
  return Math.max(minDelta, Math.min(nextStart - end, requested));
}

export function useDisplayCueTrim(options: {
  state: TimelineState; trackId: TrackId; playheadFrame: number; px: number; snapping: boolean; locked: boolean;
  onUpdate: (patch: Partial<CaptionsData>) => void; onLivePreview?: (patch: Partial<CaptionsData> | null) => void; onProblem: (message: string) => void;
}) {
  const { state, trackId, playheadFrame, px, snapping, locked, onUpdate, onLivePreview, onProblem } = options;
  type DisplayTrimState = (CueTimingDrag & { target: DisplayCueTrimTarget; edge: ManualCueEdge }) | null;
  const [drag, setDragState] = useState<DisplayTrimState>(null);
  const dragRef = useRef<DisplayTrimState>(null);
  const setDrag = (next: SetStateAction<DisplayTrimState>) => {
    const resolved = typeof next === 'function' ? next(dragRef.current) : next;
    dragRef.current = resolved;
    setDragState(resolved);
  };
  const commit = (target: DisplayCueTrimTarget, edge: ManualCueEdge, deltaFrames: number) => {
    const boundedDelta = clampDisplayTrimDelta(state, trackId, target, edge, deltaFrames);
    const spans = resizeDisplayCueSourceSpans(target.source, target.sourceSpans, state.fps, edge, boundedDelta);
    if (!spans) { onProblem('这句字幕跨越多个剪辑区间或没有可裁范围，未修改。'); return; }
    onUpdate({ sourceEntries: buildDisplayTrimSourceEntries(state, trackId, target, spans) });
  };
  const start = (event: ReactPointerEvent, key: string, target: DisplayCueTrimTarget, edge: ManualCueEdge) => {
    if (locked || event.button !== 0) return;
    const canMoveDirection = (dir: number) => {
      const clamped = clampDisplayTrimDelta(state, trackId, target, edge, dir);
      return clamped !== 0 && Boolean(displayCueTrimRange(target, state.fps, edge, clamped));
    };
    if (!canMoveDirection(edge === 'start' ? 1 : -1) && !canMoveDirection(edge === 'start' ? -1 : 1)) {
      event.preventDefault();
      event.stopPropagation();
      onProblem('这句字幕跨越多个剪辑区间或没有可裁范围，未修改。');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const projection = projectCaptionSourceSpans(target.source, target.sourceSpans, state.fps);
    const startMs = Math.min(...projection.map((span) => span.startFrame)) * 1000 / state.fps;
    const endMs = Math.max(...projection.map((span) => span.endFrame)) * 1000 / state.fps;
    setDrag({ key, target, edge, startX: event.clientX, baseStartMs: startMs, baseEndMs: endMs,
      deltaFrames: 0, snapPoints: captionSnapPoints(state, trackId) });
  };
  const move = (event: ReactPointerEvent, key: string) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== key) return;
    const requested = cueDeltaFrames(drag, event.clientX, drag.edge === 'start' ? 'trim-left' : 'trim-right', state, playheadFrame, px, snapping);
    const deltaFrames = clampDisplayTrimDelta(state, trackId, drag.target, drag.edge, requested);
    setDrag((current) => current?.key === key ? { ...current, deltaFrames } : current);
  };
  const finish = (event: ReactPointerEvent, key: string) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== key) return;
    const requested = cueDeltaFrames(drag, event.clientX, drag.edge === 'start' ? 'trim-left' : 'trim-right', state, playheadFrame, px, snapping);
    const deltaFrames = clampDisplayTrimDelta(state, trackId, drag.target, drag.edge, requested);
    setDrag(null);
    onLivePreview?.(null);
    if (!deltaFrames) return;
    commit(drag.target, drag.edge, deltaFrames);
  };
  const nudge = (target: DisplayCueTrimTarget, edge: ManualCueEdge, frames: number) => {
    if (!locked) commit(target, edge, frames);
  };
  return { drag, start, move, finish, nudge, cancel: () => { setDrag(null); onLivePreview?.(null); } };
}

interface CueTimingDrag {
  key: string;
  startX: number;
  baseStartMs: number;
  baseEndMs: number;
  deltaFrames: number;
  snapPoints: SnapPoint[];
}

interface CueDrag extends CueTimingDrag {
  target: ManualCueTarget;
}

interface TrimDrag extends CueDrag {
  edge: ManualCueEdge;
}

interface MoveDrag extends CueDrag {
  selection: CaptionSelectionRef;
  targetTrackId: TrackId;
}

interface SelectionMoveDrag extends CueTimingDrag {
  itemIds: string[];
  captionSelections: CaptionSelectionRef[];
  selection: CaptionSelectionRef;
  pointerMoved: boolean;
  hadGroupSelection: boolean;
}

export function manualCueTargets(captions: CaptionsData | null): Map<string, ManualCueTarget> {
  const targets = new Map<string, ManualCueTarget>();
  captions?.sourceEntries?.forEach((entry) => {
    if (!isManualCaptionEntry(entry)) return;
    const words = entry.words ?? [];
    words.forEach((word, index) => { if (word.id) targets.set(word.id, { laneId: entry.id, index, words }); });
  });
  return targets;
}

function captionSnapPoints(
  state: TimelineState,
  sourceTrackId: TrackId,
  excludeItemIds?: readonly string[],
): SnapPoint[] {
  const points = collectTimelineSnapPoints(state, { excludeItemIds });
  for (const entry of captionTrackEntries(state)) {
    if (entry.id === sourceTrackId || !entry.captions) continue;
    for (const page of captionPages(entry.captions, state.items, state.fps)) {
      points.push({ frame: Math.round(page.start * state.fps / 1000), type: 'item-start' });
      points.push({ frame: Math.round(page.end * state.fps / 1000), type: 'item-end' });
    }
  }
  return sortTimelineSnapPoints(points);
}

function cueDeltaFrames(
  drag: CueTimingDrag,
  clientX: number,
  mode: SnapDraggedEdgesOptions['mode'],
  state: TimelineState,
  playheadFrame: number,
  px: number,
  snapping: boolean,
): number {
  const rawDelta = Math.round((clientX - drag.startX) / px);
  const baseStart = Math.round(drag.baseStartMs * state.fps / 1000);
  if (!snapping) return Math.max(-baseStart, rawDelta);
  const baseDuration = Math.max(1, Math.round((drag.baseEndMs - drag.baseStartMs) * state.fps / 1000));
  const snapped = snapDraggedEdges({
    mode, baseStart, baseDuration, rawDelta,
    points: drag.snapPoints,
    thresholdFrames: SNAP_PX / px,
    dynamicPlayheadFrame: playheadFrame,
  });
  return Math.max(-baseStart, snapped.deltaF);
}

export function useCaptionTrim(options: {
  state: TimelineState; captions: CaptionsData | null; trackId: TrackId; playheadFrame: number;
  px: number; snapping: boolean; locked: boolean; onUpdate: (patch: Partial<CaptionsData>) => void; onLivePreview?: (patch: Partial<CaptionsData> | null) => void;
}) {
  const { state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate, onLivePreview } = options;
  const [drag, setDragState] = useState<TrimDrag | null>(null);
  const dragRef = useRef<TrimDrag | null>(null);
  const setDrag = (next: SetStateAction<TrimDrag | null>) => {
    const resolved = typeof next === 'function' ? next(dragRef.current) : next;
    dragRef.current = resolved;
    setDragState(resolved);
  };
  const delta = (current: TrimDrag, clientX: number) => cueDeltaFrames(
    current, clientX, current.edge === 'start' ? 'trim-left' : 'trim-right', state, playheadFrame, px, snapping,
  );
  const start = (event: ReactPointerEvent, key: string, target: ManualCueTarget, edge: ManualCueEdge) => {
    const cue = target.words[target.index];
    if (!cue || locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      key, target, edge, startX: event.clientX, baseStartMs: cue.start, baseEndMs: cue.end,
      deltaFrames: 0, snapPoints: captionSnapPoints(state, trackId),
    });
  };
  const move = (event: ReactPointerEvent, key: string) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== key) return;
    const deltaFrames = delta(drag, event.clientX);
    setDrag((current) => current?.key === key ? { ...current, deltaFrames } : current);
  };
  const finish = (event: ReactPointerEvent, key: string) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== key || !captions) return;
    const deltaMs = delta(drag, event.clientX) * 1000 / state.fps;
    const patch = deltaMs ? resizeManualCue(captions, drag.target.laneId, drag.target.index, drag.edge, deltaMs, state.fps) : null;
    setDrag(null);
    onLivePreview?.(null);
    if (patch) onUpdate(patch);
  };
  const nudge = (target: ManualCueTarget, edge: ManualCueEdge, frames: number) => {
    if (!captions || locked) return;
    const patch = resizeManualCue(captions, target.laneId, target.index, edge, frames * 1000 / state.fps, state.fps);
    if (patch) onUpdate(patch);
  };
  return { drag, start, move, finish, cancel: () => { setDrag(null); onLivePreview?.(null); }, nudge };
}

export type CaptionRollPair =
  | { key: string; kind: 'manual'; leftKey: string; rightKey: string; left: ManualCueTarget; right: ManualCueTarget }
  | { key: string; kind: 'display'; leftKey: string; rightKey: string; left: DisplayCueTrimTarget; right: DisplayCueTrimTarget };

interface CaptionRollDrag extends CueTimingDrag {
  pair: CaptionRollPair;
}

export function resolveDisplayRollSpans(
  left: DisplayCueTrimTarget,
  right: DisplayCueTrimTarget,
  fps: number,
  requestedDeltaFrames: number,
): {
  deltaFrames: number;
  leftSpans: CaptionSourceSpan[];
  rightSpans: CaptionSourceSpan[];
  leftRange: { start: number; end: number };
  rightRange: { start: number; end: number };
} | null {
  if (!requestedDeltaFrames) return null;
  const lpOrig = projectCaptionSourceSpans(left.source, left.sourceSpans, fps);
  const rpOrig = projectCaptionSourceSpans(right.source, right.sourceSpans, fps);
  if (!lpOrig.length || !rpOrig.length) return null;
  const leftKeys = new Set(lpOrig.map((span) => span.segmentKey));
  const rightKeys = new Set(rpOrig.map((span) => span.segmentKey));
  if (leftKeys.size !== 1 || rightKeys.size !== 1) return null;
  const leftSegKey = lpOrig[0]!.segmentKey;
  const rightSegKey = rpOrig[0]!.segmentKey;
  const sameSegment = left.source.id === right.source.id && leftSegKey === rightSegKey;
  const lOrigEnd = Math.max(...lpOrig.map((span) => span.endFrame));
  const rOrigStart = Math.min(...rpOrig.map((span) => span.startFrame));
  const leftBounds = captionSourceSegmentBounds(left.source, leftSegKey, fps);
  const rightBounds = captionSourceSegmentBounds(right.source, rightSegKey, fps);
  const leftLastIdx = lpOrig.at(-1)!.spanIndex;
  const rightFirstIdx = rpOrig[0]!.spanIndex;

  const tryAt = (delta: number) => {
    if (!delta) return null;
    let leftSpans: CaptionSourceSpan[] | null = null;
    let rightSpans: CaptionSourceSpan[] | null = null;
    if (sameSegment) {
      if (delta > 0) {
        rightSpans = resizeDisplayCueSourceSpans(right.source, right.sourceSpans, fps, 'start', delta);
        if (!rightSpans) return null;
        const rpNew = projectCaptionSourceSpans(right.source, rightSpans, fps);
        if (!rpNew.length) return null;
        const boundaryMs = rightSpans[rpNew[0]!.spanIndex]!.startMs;
        const leftTail = left.sourceSpans[leftLastIdx]!;
        if (boundaryMs > leftTail.endMs && boundaryMs <= (leftBounds?.maxSourceMs ?? Number.POSITIVE_INFINITY)) {
          leftSpans = left.sourceSpans.map((candidate, index) => index === leftLastIdx
            ? { ...candidate, endMs: boundaryMs }
            : candidate);
        } else {
          leftSpans = resizeDisplayCueSourceSpans(left.source, left.sourceSpans, fps, 'end', delta, { maxSourceMs: boundaryMs });
        }
      } else {
        leftSpans = resizeDisplayCueSourceSpans(left.source, left.sourceSpans, fps, 'end', delta);
        if (!leftSpans) return null;
        const lpNew = projectCaptionSourceSpans(left.source, leftSpans, fps);
        if (!lpNew.length) return null;
        const boundaryMs = leftSpans[lpNew.at(-1)!.spanIndex]!.endMs;
        const rightHead = right.sourceSpans[rightFirstIdx]!;
        if (boundaryMs < rightHead.startMs && boundaryMs >= (rightBounds?.minSourceMs ?? 0)) {
          rightSpans = right.sourceSpans.map((candidate, index) => index === rightFirstIdx
            ? { ...candidate, startMs: boundaryMs }
            : candidate);
        } else {
          rightSpans = resizeDisplayCueSourceSpans(right.source, right.sourceSpans, fps, 'start', delta, { minSourceMs: boundaryMs });
        }
      }
    } else {
      leftSpans = resizeDisplayCueSourceSpans(left.source, left.sourceSpans, fps, 'end', delta);
      rightSpans = resizeDisplayCueSourceSpans(right.source, right.sourceSpans, fps, 'start', delta);
    }
    if (!leftSpans || !rightSpans) return null;
    const lp = projectCaptionSourceSpans(left.source, leftSpans, fps);
    const rp = projectCaptionSourceSpans(right.source, rightSpans, fps);
    if (!lp.length || !rp.length) return null;
    const lStart = Math.min(...lp.map((s) => s.startFrame));
    const lEnd = Math.max(...lp.map((s) => s.endFrame));
    const rStart = Math.min(...rp.map((s) => s.startFrame));
    const rEnd = Math.max(...rp.map((s) => s.endFrame));
    if (lEnd <= lStart || rEnd <= rStart || lEnd > rStart + 1) return null;
    const actualDelta = delta > 0 ? lEnd - lOrigEnd : rStart - rOrigStart;
    if ((delta > 0 && actualDelta <= 0) || (delta < 0 && actualDelta >= 0)) return null;
    return {
      deltaFrames: actualDelta,
      leftSpans,
      rightSpans,
      leftRange: { start: lStart * 1000 / fps, end: lEnd * 1000 / fps },
      rightRange: { start: rStart * 1000 / fps, end: rEnd * 1000 / fps },
    };
  };
  const direct = tryAt(requestedDeltaFrames);
  if (direct) return direct;
  const sign = requestedDeltaFrames > 0 ? 1 : -1;
  let lo = 0;
  let hi = Math.abs(requestedDeltaFrames);
  let best: ReturnType<typeof tryAt> = null;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    const probe = tryAt(mid * sign);
    if (probe) { best = probe; lo = mid; }
    else hi = mid;
  }
  return best;
}

export function canDisplayRoll(
  left: DisplayCueTrimTarget,
  right: DisplayCueTrimTarget,
  fps: number,
): boolean {
  return Boolean(resolveDisplayRollSpans(left, right, fps, 1) || resolveDisplayRollSpans(left, right, fps, -1));
}

export function useCaptionRollTrim(options: {
  state: TimelineState; captions: CaptionsData | null; trackId: TrackId; playheadFrame: number;
  px: number; snapping: boolean; locked: boolean; onUpdate: (patch: Partial<CaptionsData>) => void; onLivePreview?: (patch: Partial<CaptionsData> | null) => void; onProblem: (message: string) => void;
}) {
  const { state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate, onLivePreview, onProblem } = options;
  const [drag, setDragState] = useState<CaptionRollDrag | null>(null);
  const dragRef = useRef<CaptionRollDrag | null>(null);
  const setDrag = (next: SetStateAction<CaptionRollDrag | null>) => {
    const resolved = typeof next === 'function' ? next(dragRef.current) : next;
    dragRef.current = resolved;
    setDragState(resolved);
  };
  const delta = (current: CaptionRollDrag, clientX: number) => cueDeltaFrames(
    current, clientX, 'trim-left', state, playheadFrame, px, snapping,
  );
  const rollPatch = (pair: CaptionRollPair, deltaFrames: number): Partial<CaptionsData> | null => {
    if (!captions || !deltaFrames) return null;
    if (pair.kind === 'manual') {
      return rollAdjacentManualCues(captions, pair.left.laneId, pair.left.index, pair.right.index,
        deltaFrames * 1000 / state.fps, state.fps);
    }
    const resolved = resolveDisplayRollSpans(pair.left, pair.right, state.fps, deltaFrames);
    if (!resolved) return null;
    return {
      sourceEntries: buildDisplayRollSourceEntries(
        state,
        trackId,
        pair.left,
        pair.right,
        resolved.leftSpans,
        resolved.rightSpans,
      ),
    };
  };
  const commit = (pair: CaptionRollPair, deltaFrames: number) => {
    if (!captions || !deltaFrames) return;
    const patch = rollPatch(pair, deltaFrames);
    if (!patch && pair.kind === 'display') {
      onProblem('相邻字幕已到达可调边界，未修改。');
      return;
    }
    if (patch) onUpdate(patch);
  };
  const start = (event: ReactPointerEvent, pair: CaptionRollPair, boundaryMs: number) => {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      key: pair.key,
      pair,
      startX: event.clientX,
      baseStartMs: boundaryMs,
      baseEndMs: boundaryMs,
      deltaFrames: 0,
      snapPoints: captionSnapPoints(state, trackId),
    });
  };
  const move = (event: ReactPointerEvent, key: string) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== key) return;
    const deltaFrames = delta(drag, event.clientX);
    setDrag((current) => current?.key === key ? { ...current, deltaFrames } : current);
  };
  const finish = (event: ReactPointerEvent, key: string) => {
    const drag = dragRef.current;
    if (!drag || drag.key !== key) return;
    const deltaFrames = delta(drag, event.clientX);
    const activePair = drag.pair;
    setDrag(null);
    onLivePreview?.(null);
    commit(activePair, deltaFrames);
  };
  const nudge = (pair: CaptionRollPair, frames: number) => {
    if (!locked) commit(pair, frames);
  };
  return { drag, start, move, finish, nudge, cancel: () => { setDrag(null); onLivePreview?.(null); } };
}

export function useCaptionMove(options: {
  state: TimelineState; captions?: CaptionsData | null; trackId: TrackId; playheadFrame: number; px: number; snapping: boolean; locked: boolean;
  trackFromClientY: (clientY: number) => TrackId; onMove: (move: CaptionCueMove) => void;
  onLivePreview?: (patch: Partial<CaptionsData> | null) => void;
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  onDropSelectionToChat?: (selection: { itemIds: string[]; captionSelections: CaptionSelectionRef[] }) => void;
}) {
  const {
    state, captions = null, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove, onLivePreview,
    isOverChatComposer, onDropSelectionToChat,
  } = options;
  const [drag, setDrag] = useState<MoveDrag | null>(null);
  const dragRef = useRef<MoveDrag | null>(null);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const updateDrag = useCallback((next: MoveDrag | null) => { dragRef.current = next; setDrag(next); }, []);
  const delta = useCallback((current: CueDrag, clientX: number) => cueDeltaFrames(
    current, clientX, 'move', state, playheadFrame, px, snapping,
  ), [state, playheadFrame, px, snapping]);
  const handlersRef = useRef({
    state, captions, trackId, delta, trackFromClientY, onMove, onLivePreview,
    isOverChatComposer, onDropSelectionToChat,
  });
  useEffect(() => {
    handlersRef.current = {
      state, captions, trackId, delta, trackFromClientY, onMove, onLivePreview,
      isOverChatComposer, onDropSelectionToChat,
    };
  });
  const cancel = useCallback(() => {
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    handlersRef.current.onLivePreview?.(null);
    if (dragRef.current) updateDrag(null);
  }, [updateDrag]);
  const start = (
    event: ReactPointerEvent,
    key: string,
    target: ManualCueTarget,
    selection: CaptionSelectionRef,
  ) => {
    const cue = target.words[target.index];
    if (!cue || locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupListenersRef.current?.();
    const initial: MoveDrag = {
      key, target, selection, startX: event.clientX, baseStartMs: cue.start, baseEndMs: cue.end,
      deltaFrames: 0, targetTrackId: trackId, snapPoints: captionSnapPoints(state, trackId),
    };
    updateDrag(initial);
    const move = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const h = handlersRef.current;
      const nextDeltaFrames = h.delta(current, moveEvent.clientX);
      const nextTargetTrackId = h.trackFromClientY(moveEvent.clientY);
      updateDrag({
        ...current,
        deltaFrames: nextDeltaFrames,
        targetTrackId: nextTargetTrackId,
      });
      // Movement is painted from drag state; do not write/re-sort the caption model during pointer movement.
      h.onLivePreview?.(null);
    };
    const finish = (upEvent: PointerEvent) => {
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      const current = dragRef.current;
      if (!current) return;
      const h = handlersRef.current;
      h.onLivePreview?.(null);
      if (h.onDropSelectionToChat && h.isOverChatComposer?.(upEvent.clientX, upEvent.clientY)) {
        updateDrag(null);
        h.onDropSelectionToChat({ itemIds: [], captionSelections: [current.selection] });
        return;
      }
      const deltaMs = h.delta(current, upEvent.clientX) * 1000 / h.state.fps;
      const cueId = current.target.words[current.target.index]?.id;
      const currentWords = h.captions?.sourceEntries?.find((entry) => entry.id === current.target.laneId
        && isManualCaptionEntry(entry))?.words;
      const currentIndex = cueId ? currentWords?.findIndex((word) => word.id === cueId) ?? -1 : -1;
      const currentCue = currentIndex >= 0 ? currentWords?.[currentIndex] : undefined;
      const targetTrackId = h.trackFromClientY(upEvent.clientY);
      updateDrag(null);
      if (!currentCue || (!deltaMs && targetTrackId === h.trackId)) return;
      const durationMs = Math.max(20, current.baseEndMs - current.baseStartMs);
      let nextStartMs = Math.max(0, current.baseStartMs + deltaMs);
      if (targetTrackId === h.trackId && currentWords) {
        const otherWords = currentWords.filter((word) => word.id !== cueId);
        const previousEnd = Math.max(0, ...otherWords.filter((word) => word.end <= current.baseStartMs).map((word) => word.end));
        const nextStart = Math.min(Number.POSITIVE_INFINITY, ...otherWords.filter((word) => word.start >= current.baseEndMs).map((word) => word.start));
        nextStartMs = Math.max(previousEnd, Math.min(nextStart - durationMs, nextStartMs));
      }
      h.onMove({
        laneId: current.target.laneId,
        index: currentIndex,
        text: currentCue.text,
        startMs: nextStartMs,
        endMs: nextStartMs + durationMs,
        targetTrackId,
      });
    };
    const onCancel = () => cancel();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
    cleanupListenersRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', onCancel);
    };
  };
  useEffect(() => () => {
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    if (dragRef.current) handlersRef.current.onLivePreview?.(null);
  }, []);
  return { drag, start, cancel };
}

export function useCaptionSelectionMove(options: {
  state: TimelineState;
  trackId: TrackId;
  playheadFrame: number;
  px: number;
  snapping: boolean;
  locked: boolean;
  selectedCaptions: readonly CaptionSelectionRef[];
  selectedItemIds: readonly string[];
  onPreview: (preview: TimelineSelectionMovePreview | null) => void;
  onCommit: (
    itemIds: readonly string[],
    captionSelections: readonly CaptionSelectionRef[],
    deltaFrames: number,
  ) => void;
  onClickWithoutDrag?: (selection: CaptionSelectionRef) => void;
  onBlocked?: (message: string) => void;
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  onDropSelectionToChat?: (selection: { itemIds: string[]; captionSelections: CaptionSelectionRef[] }) => void;
}) {
  const {
    state, trackId, playheadFrame, px, snapping, locked, selectedCaptions, selectedItemIds, onBlocked,
    onPreview, onCommit, onClickWithoutDrag, isOverChatComposer, onDropSelectionToChat,
  } = options;
  const [drag, setDrag] = useState<SelectionMoveDrag | null>(null);
  const dragRef = useRef<SelectionMoveDrag | null>(null);
  const cleanupListenersRef = useRef<(() => void) | null>(null);
  const updateDrag = useCallback((next: SelectionMoveDrag | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const preview = useCallback((next: SelectionMoveDrag) => {
    onPreview({
      itemIds: next.itemIds,
      captionSelections: next.captionSelections,
      deltaFrames: next.deltaFrames,
    });
  }, [onPreview]);
  const delta = useCallback((current: SelectionMoveDrag, clientX: number) => {
    const requested = cueDeltaFrames(
      current, clientX, 'move', state, playheadFrame, px, snapping,
    );
    return clampTimelineSelectionDelta(
      state,
      current.itemIds,
      current.captionSelections,
      requested,
    );
  }, [state, playheadFrame, px, snapping]);
  const handlersRef = useRef({
    delta,
    preview,
    onPreview,
    onCommit,
    onClickWithoutDrag,
    isOverChatComposer,
    onDropSelectionToChat,
    onBlocked,
    state,
  });
  useEffect(() => {
    handlersRef.current = {
      delta,
      preview,
      onPreview,
      onCommit,
      onClickWithoutDrag,
      isOverChatComposer,
      onDropSelectionToChat,
      onBlocked,
      state,
    };
  });
  const cancel = useCallback(() => {
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    if (!dragRef.current) return;
    updateDrag(null);
    handlersRef.current.onPreview(null);
  }, [updateDrag]);
  const start = (
    event: ReactPointerEvent,
    key: string,
    page: CaptionPage,
    selection: CaptionSelectionRef,
    overrideSelectedCaptions?: readonly CaptionSelectionRef[],
  ): boolean => {
    if (locked || event.button !== 0) return false;
    const resolved = resolveCaptionDragSelection(
      selection,
      overrideSelectedCaptions ?? selectedCaptions,
      selectedItemIds,
    );
    const usesTimelineSelectionMove = captionDragMoveMode(selection, resolved) === 'timeline-selection';
    if (!usesTimelineSelectionMove) return false;
    event.preventDefault();
    event.stopPropagation();
    cleanupListenersRef.current?.();
    const next: SelectionMoveDrag = {
      key,
      startX: event.clientX,
      baseStartMs: page.start,
      baseEndMs: page.end,
      deltaFrames: 0,
      snapPoints: captionSnapPoints(state, trackId, resolved.itemIds),
      itemIds: resolved.itemIds,
      captionSelections: resolved.captionSelections,
      selection,
      pointerMoved: false,
      hadGroupSelection: !overrideSelectedCaptions && (resolved.itemIds.length > 0 || resolved.captionSelections.length > 1),
    };
    updateDrag(next);
    preview(next);
    const move = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const pointerMoved = current.pointerMoved || Math.abs(moveEvent.clientX - current.startX) >= 3;
      const nextDrag = {
        ...current,
        pointerMoved,
        deltaFrames: handlersRef.current.delta(current, moveEvent.clientX),
      };
      updateDrag(nextDrag);
      handlersRef.current.preview(nextDrag);
    };
    const finish = (upEvent: PointerEvent) => {
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      const current = dragRef.current;
      if (!current) return;
      const h = handlersRef.current;
      if (h.onDropSelectionToChat && h.isOverChatComposer?.(upEvent.clientX, upEvent.clientY)) {
        updateDrag(null);
        h.onPreview(null);
        h.onDropSelectionToChat({
          itemIds: current.itemIds,
          captionSelections: current.captionSelections,
        });
        return;
      }
      const deltaFrames = h.delta(current, upEvent.clientX);
      const pointerMoved = current.pointerMoved || Math.abs(upEvent.clientX - current.startX) >= 3;
      updateDrag(null);
      h.onPreview(null);
      if (deltaFrames) {
        const problem = displayCueMoveProblem(h.state, current.captionSelections);
        if (problem) h.onBlocked?.(problem);
        else h.onCommit(current.itemIds, current.captionSelections, deltaFrames);
      } else if (!pointerMoved && current.hadGroupSelection) {
        h.onClickWithoutDrag?.(current.selection);
      }
    };
    const onCancel = () => cancel();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
    cleanupListenersRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', onCancel);
    };
    return true;
  };
  useEffect(() => () => {
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    if (dragRef.current) handlersRef.current.onPreview(null);
  }, []);
  return { drag, start, cancel };
}
