import { clampItemsMoveDelta, moveItemsByDelta } from '../editor/multiSelect';
import { moveLockedItemIds } from '../editor/linkGroups';
import {
  captionsOnTrack,
  defaultTrackId,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import type { CaptionsData, CaptionSourceEntry } from './types';
import { isManualCaptionEntry } from './manualCaptions';
import {
  captionSelectionKey,
  resolveOrderedCaptionSelections,
  type CaptionSelectionRef,
} from './captionSelection';
import { resolveCaptionWordIndices, resolveEntryWords } from './resolve';
import { captionWordOverride, setCaptionWordOverride } from './wordOverrides';
import { orderedCaptionSourceEntries } from './sourceOrder';
import { projectCaptionSourceSpans } from './captionSourceSpans';

interface ManualCueLocation {
  trackId: TrackId;
  laneId: string;
  cueIndex: number;
  startMs: number;
  endMs: number;
}

interface AutomaticCueLocation {
  trackId: TrackId;
  startMs: number;
  srcIdxs: number[];
  wordRefs: string[];
  displayCueEditId?: string;
  displayCuePartId?: string;
  displayCueLaneId?: string;
  sourceItemId?: string;
}

export function displayCueMoveProblem(state: TimelineState, selections: readonly CaptionSelectionRef[]): string | null {
  for (const resolved of resolveOrderedCaptionSelections(state, selections)) {
    if (resolved.target.kind !== 'single') continue;
    const cue = resolved.target.rows[resolved.target.cueIndex];
    if (!cue?.displayCueEditId || !cue.displayCuePartId || !cue.entry || !cue.sourceSpans?.length) continue;
    const source = state.items.find((item) => item.id === cue.entry!.itemId);
    if (!source || new Set(projectCaptionSourceSpans(source, cue.sourceSpans, state.fps).map((span) => span.segmentKey)).size > 1) {
      return '这句字幕跨越多个剪辑区间，无法安全移动；请先拆开字幕。';
    }
  }
  return null;
}

export interface TimelineSelectionMovePreview {
  itemIds: readonly string[];
  captionSelections: readonly CaptionSelectionRef[];
  deltaFrames: number;
}


export function selectionMovePreviewDeltaForItem(
  itemId: string,
  preview: TimelineSelectionMovePreview | null,
): number {
  return preview?.itemIds.includes(itemId) ? preview.deltaFrames : 0;
}

export function selectionMovePreviewDeltaForCaption(
  selection: CaptionSelectionRef | null,
  preview: TimelineSelectionMovePreview | null,
): number {
  if (!selection || !preview) return 0;
  const key = captionSelectionKey(selection);
  return preview.captionSelections.some(
    (candidate) => captionSelectionKey(candidate) === key,
  ) ? preview.deltaFrames : 0;
}

export function resolveCaptionDragSelection(
  primary: CaptionSelectionRef,
  captionSelections: readonly CaptionSelectionRef[],
  itemIds: readonly string[],
): { captionSelections: CaptionSelectionRef[]; itemIds: string[] } {
  const primaryKey = captionSelectionKey(primary);
  const insideSelection = captionSelections.some(
    (selection) => captionSelectionKey(selection) === primaryKey,
  );
  return insideSelection
    ? { captionSelections: [...captionSelections], itemIds: [...itemIds] }
    : { captionSelections: [primary], itemIds: [] };
}

export function captionDragMoveMode(
  primary: CaptionSelectionRef,
  selection: { captionSelections: readonly CaptionSelectionRef[]; itemIds: readonly string[] },
): 'timeline-selection' | 'manual-cue' {
  return primary.kind === 'single'
    || selection.captionSelections.length > 1
    || selection.itemIds.length > 0
    ? 'timeline-selection'
    : 'manual-cue';
}

export function captionSelectionsForItemDrag(
  itemWasSelected: boolean,
  captionSelections: readonly CaptionSelectionRef[],
): CaptionSelectionRef[] {
  return itemWasSelected ? [...captionSelections] : [];
}

export function resolveItemDragSelection(
  primaryItemId: string,
  selectedItemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  options?: {
    shiftKey: boolean;
    anchorItemId: string | null;
    items: TimelineState['items'];
  },
): { captionSelections: CaptionSelectionRef[]; itemIds: string[] } {
  if (options?.shiftKey && options.anchorItemId) {
    const anchor = options.items.find((item) => item.id === options.anchorItemId);
    const target = options.items.find((item) => item.id === primaryItemId);
    if (anchor && target && anchor.track === target.track) {
      const lo = Math.min(anchor.startFrame, target.startFrame);
      const hi = Math.max(anchor.startFrame, target.startFrame);
      return {
        captionSelections: [...captionSelections],
        itemIds: options.items
          .filter((item) => item.track === anchor.track && item.startFrame >= lo && item.startFrame <= hi)
          .map((item) => item.id),
      };
    }
  }
  return selectedItemIds.includes(primaryItemId)
    ? { captionSelections: [...captionSelections], itemIds: [...selectedItemIds] }
    : { captionSelections: [], itemIds: [primaryItemId] };
}

function selectedCueLocations(
  state: TimelineState,
  selections: readonly CaptionSelectionRef[],
): { manual: ManualCueLocation[]; automatic: AutomaticCueLocation[] } {
  const manual: ManualCueLocation[] = [];
  const automatic: AutomaticCueLocation[] = [];
  for (const resolved of resolveOrderedCaptionSelections(state, selections)) {
    if (state.tracks?.[resolved.trackId]?.locked) continue;
    if (resolved.target.kind === 'manual') {
      manual.push({
        trackId: resolved.trackId,
        laneId: resolved.target.laneId,
        cueIndex: resolved.target.cueIndex,
        startMs: resolved.target.cue.start,
        endMs: resolved.target.cue.end,
      });
    } else {
      const cue = resolved.target.rows[resolved.target.cueIndex];
      if (!cue) continue;
      if (cue.displayCueEditId && cue.displayCuePartId) {
        automatic.push({
          trackId: resolved.trackId,
          startMs: resolved.target.cue.start,
          srcIdxs: [],
          wordRefs: [],
          displayCueEditId: cue.displayCueEditId,
          displayCuePartId: cue.displayCuePartId,
          displayCueLaneId: cue.laneId,
          sourceItemId: cue.entry?.itemId,
        });
        continue;
      }
      if (!cue.srcIdxs.length) continue;
      automatic.push({
        trackId: resolved.trackId,
        startMs: resolved.target.cue.start,
        srcIdxs: [...cue.srcIdxs],
        wordRefs: [...cue.wordRefs],
      });
    }
  }
  return { manual, automatic };
}

function selectedCueIndexesByLane(locations: readonly ManualCueLocation[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const location of locations) {
    const key = `${location.trackId}\u0000${location.laneId}`;
    const indexes = result.get(key) ?? new Set<number>();
    indexes.add(location.cueIndex);
    result.set(key, indexes);
  }
  return result;
}

function automaticCaptionSourceByOverrideIndex(
  captions: CaptionsData,
  state: TimelineState,
): Map<number, string> {
  if (captions.sourceEntries?.length) {
    const words = orderedCaptionSourceEntries(captions.sourceEntries)
      .filter((entry) => entry.visible !== false)
      .flatMap((entry) => resolveEntryWords(entry, state.items, state.fps)
        .map((word) => ({ word, itemId: entry.itemId })))
      .sort((a, b) => a.word.start - b.word.start || a.word.end - b.word.end);
    return new Map(words.map((word, index) => [index, word.itemId]));
  }

  if (captions.sourceItemId) {
    const source = state.items.find((item) => item.id === captions.sourceItemId);
    return new Map((source?.transcript ?? []).map((_, index) => [index, captions.sourceItemId!]));
  }

  let sourceItems: TimelineState['items'] = [];
  if (captions.sourceMode === 'timeline') {
    sourceItems = state.items
      .filter((item) => item.transcript?.length)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  } else if (captions.sources?.length) {
    sourceItems = captions.sources
      .map((id) => state.items.find((item) => item.id === id))
      .filter((item): item is TimelineState['items'][number] => !!item?.transcript?.length);
  }

  const words = sourceItems
    .flatMap((item) => resolveEntryWords(
      { id: `source:${item.id}`, itemId: item.id },
      state.items,
      state.fps,
    ).map((word) => ({ word, itemId: item.id })))
    .sort((a, b) => a.word.start - b.word.start);
  return new Map(words.map((word, index) => [index, word.itemId]));
}

function earliestPersistableDeltaFrames(startMs: number, fps: number): number {
  let deltaFrames = -Math.ceil(Math.max(0, startMs) * fps / 1000);
  while (startMs + Math.round(deltaFrames * 1000 / fps) < 0) deltaFrames += 1;
  while (startMs + Math.round((deltaFrames - 1) * 1000 / fps) >= 0) deltaFrames -= 1;
  return deltaFrames;
}

function earliestDeltaForBoundaryMs(boundaryMs: number, fps: number): number {
  let frames = Math.floor(boundaryMs * fps / 1000);
  while (Math.round(frames * 1000 / fps) < boundaryMs) frames += 1;
  while (Math.round((frames - 1) * 1000 / fps) >= boundaryMs) frames -= 1;
  return frames;
}

function latestDeltaForBoundaryMs(boundaryMs: number, fps: number): number {
  let frames = Math.ceil(boundaryMs * fps / 1000);
  while (Math.round(frames * 1000 / fps) > boundaryMs) frames -= 1;
  while (Math.round((frames + 1) * 1000 / fps) <= boundaryMs) frames += 1;
  return frames;
}

/** Clamp a mixed selection at frame zero and same-track clips without locking manual captions against adjacent cues. */
export function clampTimelineSelectionDelta(
  state: TimelineState,
  itemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  requestedDeltaFrames: number,
  itemTrackShift: { from: TrackId; to: TrackId } | null = null,
): number {
  const expandedItemIds = moveLockedItemIds(state, itemIds);
  const ids = new Set(expandedItemIds);
  if (expandedItemIds.some((id) => {
    const item = state.items.find((candidate) => candidate.id === id);
    return item ? state.tracks?.[item.track]?.locked : false;
  })) return 0;
  const locations = selectedCueLocations(state, captionSelections);
  const cueLocations = [...locations.manual, ...locations.automatic];
  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;
  let hasMovableItems = false;

  for (const item of state.items) {
    if (!ids.has(item.id) || state.tracks?.[item.track]?.locked) continue;
    hasMovableItems = true;
    minDelta = Math.max(minDelta, -item.startFrame);
  }
  for (const location of cueLocations) {
    minDelta = Math.max(minDelta, earliestPersistableDeltaFrames(location.startMs, state.fps));
  }
  const manualByLane = new Map<string, Set<number>>();
  for (const location of locations.manual) {
    const key = `${location.trackId}\u0000${location.laneId}`;
    const selected = manualByLane.get(key) ?? new Set<number>();
    selected.add(location.cueIndex);
    manualByLane.set(key, selected);
  }
  for (const [key, selected] of manualByLane) {
    const separator = key.indexOf('\u0000');
    const trackId = key.slice(0, separator);
    const laneId = key.slice(separator + 1);
    const words = captionsOnTrack(state, trackId)?.sourceEntries?.find((entry) => entry.id === laneId
      && isManualCaptionEntry(entry))?.words ?? [];
    for (const cueIndex of selected) {
      const cue = words[cueIndex];
      if (!cue) continue;
      for (const [index, other] of words.entries()) {
        if (selected.has(index) || other.start < cue.end && other.end > cue.start) continue;
        if (other.end <= cue.start) {
          minDelta = Math.max(minDelta, earliestDeltaForBoundaryMs(other.end - cue.start, state.fps));
        } else if (other.start >= cue.end) {
          maxDelta = Math.min(maxDelta, latestDeltaForBoundaryMs(other.start - cue.end, state.fps));
        }
      }
    }
  }
  if (!hasMovableItems && cueLocations.length === 0) return 0;
  const bounded = Math.min(maxDelta, Math.max(minDelta, Math.round(requestedDeltaFrames)));
  if (!hasMovableItems) return bounded;
  return clampItemsMoveDelta(
    state,
    expandedItemIds,
    bounded,
    itemTrackShift,
    { min: minDelta, max: maxDelta },
  ) ?? 0;
}

function moveAutomaticCaptionSelections(
  state: TimelineState,
  locations: readonly AutomaticCueLocation[],
  itemIds: readonly string[],
  deltaFrames: number,
): TimelineState {
  if (!locations.length || deltaFrames === 0) return state;
  const deltaMs = Math.round(deltaFrames * 1000 / state.fps);
  const selectedItemIds = new Set(itemIds);
  let next = state;
  for (const trackId of new Set(locations.map((location) => location.trackId))) {
    const captions = captionsOnTrack(next, trackId);
    if (!captions) continue;
    const sourceByOverrideIndex = automaticCaptionSourceByOverrideIndex(captions, state);
    const indices = resolveCaptionWordIndices(captions, state.items, state.fps);
    let wordOverrides = { ...(captions.wordOverrides ?? {}) };
    const targets = locations
      .filter((location) => location.trackId === trackId)
      .flatMap((location) => location.srcIdxs.map((index, position) => ({
        index,
        wordRef: location.wordRefs[position]!,
      })));
    const uniqueTargets = new Map(targets.map((target) => [target.wordRef, target]));
    for (const { index, wordRef } of uniqueTargets.values()) {
      const sourceItemId = sourceByOverrideIndex.get(index);
      if (sourceItemId && selectedItemIds.has(sourceItemId)) continue;
      const current = captionWordOverride(wordOverrides, index, wordRef);
      wordOverrides = setCaptionWordOverride(wordOverrides, indices, index, wordRef, {
        timingOffsetMs: (current?.timingOffsetMs ?? 0) + deltaMs,
      });
    }
    const movedParts = new Set<string>();
    const sourceEntries = captions.sourceEntries?.map((entry) => ({
      ...entry,
      displayCueEdits: entry.displayCueEdits?.map((edit) => ({
        ...edit,
        parts: edit.parts.map((part) => {
          const key = `${entry.id}:${edit.id}:${part.id}`;
          if (movedParts.has(key) || !locations.some((location) => location.trackId === trackId
            && location.displayCueLaneId === entry.id
            && !selectedItemIds.has(location.sourceItemId ?? '')
            && location.displayCueEditId === edit.id && location.displayCuePartId === part.id)) return part;
          movedParts.add(key);
          return { ...part, sourceSpans: part.sourceSpans.map((span) => ({
            ...span, timingOffsetMs: (span.timingOffsetMs ?? 0) + deltaMs,
          })) };
        }),
      })),
    }));
    next = withCaptionTrack(next, trackId, {
      ...captions,
      wordOverrides,
      ...(sourceEntries ? { sourceEntries } : {}),
    });
  }
  return next;
}

function moveManualCaptionSelections(
  state: TimelineState,
  locations: readonly ManualCueLocation[],
  deltaFrames: number,
): TimelineState {
  if (!locations.length || deltaFrames === 0) return state;
  const deltaMs = Math.round(deltaFrames * 1000 / state.fps);
  const byTrackLane = selectedCueIndexesByLane(locations);
  let next = state;

  for (const trackId of new Set(locations.map((location) => location.trackId))) {
    const captions = captionsOnTrack(next, trackId);
    if (!captions) continue;
    const sourceEntries = (captions.sourceEntries ?? []).map((entry): CaptionSourceEntry => {
      if (!isManualCaptionEntry(entry)) return entry;
      const indexes = byTrackLane.get(`${trackId}\u0000${entry.id}`);
      if (!indexes?.size) return entry;
      return {
        ...entry,
        words: (entry.words ?? [])
          .map((word, index) => indexes.has(index)
            ? { ...word, start: Math.max(0, word.start + deltaMs), end: Math.max(0, word.end + deltaMs) }
            : word)
          .sort((a, b) => a.start - b.start || a.end - b.end),
      };
    });
    next = withCaptionTrack(next, trackId, { ...captions, sourceEntries });
  }
  return next;
}

function withCaptionTrack(state: TimelineState, trackId: TrackId, captions: CaptionsData): TimelineState {
  const current = state.tracks?.[trackId] ?? { kind: 'caption' as const };
  const next = { ...state, tracks: { ...state.tracks, [trackId]: { ...current, captions } } };
  return trackId === defaultTrackId(state, 'caption') ? { ...next, captions } : next;
}

/** Move selected clips and caption cues as one immutable timeline state change. */
export function moveTimelineSelectionByDelta(
  state: TimelineState,
  itemIds: readonly string[],
  captionSelections: readonly CaptionSelectionRef[],
  requestedDeltaFrames: number,
  itemTrackShift: { from: TrackId; to: TrackId } | null = null,
): TimelineState {
  if (displayCueMoveProblem(state, captionSelections)) return state;
  const expandedItemIds = moveLockedItemIds(state, itemIds);
  const locations = selectedCueLocations(state, captionSelections);
  const deltaFrames = clampTimelineSelectionDelta(
    state,
    expandedItemIds,
    captionSelections,
    requestedDeltaFrames,
    itemTrackShift,
  );
  const itemsMoved = moveItemsByDelta(state, expandedItemIds, deltaFrames, itemTrackShift);
  const manualMoved = moveManualCaptionSelections(
    itemsMoved,
    locations.manual,
    deltaFrames,
  );
  return moveAutomaticCaptionSelections(
    manualMoved,
    locations.automatic,
    expandedItemIds,
    deltaFrames,
  );
}
