// Multi-select ops: move / remove a set of clips as one undoable step.
// Used by timeline pointer (group drag), shortcuts (⌫), and clip context menu.
import {
  canTrackAcceptItemKind, selectedIdsOf, timelineTrackIds, trackKind,
  type TimelineItem, type TimelineState, type TrackId,
} from './types';
import { moveLockedItemIds, groupedItemIds, removeItemsWithGroups } from './linkGroups';
import { foldMoveItemIds } from './foldGroups';
import { clampMoveDeltaToTrackGaps } from './trackCollision';

/** Expand any collapsed foldGroup members plus ordinary group/link locks for selection & move. */
export function expandSelectionItemIds(state: TimelineState, seeds: readonly string[]): string[] {
  return groupedItemIds(state, foldMoveItemIds(state, seeds));
}

/** Ids that should move together when dragging `primaryId` (the grab handle). */
export function groupMoveIds(state: TimelineState, primaryId: string): string[] {
  const ids = selectedIdsOf(state);
  const seeds = ids.includes(primaryId) && ids.length > 1 ? ids : [primaryId];
  return moveLockedItemIds(state, foldMoveItemIds(state, seeds));
}

export function selectableItemIdsAtPlayheadSide(
  state: Pick<TimelineState, 'items' | 'tracks'>,
  playheadFrame: number,
  side: 'before' | 'after',
): string[] {
  const frame = Math.max(0, Math.round(playheadFrame));
  return state.items
    .filter((item) => !state.tracks?.[item.track]?.locked
      && (side === 'before'
        ? item.startFrame + item.durationInFrames <= frame
        : item.startFrame >= frame))
    .map((item) => item.id);
}

/** Select all items on `trackId` to the left or right of `referenceFrame` (or inclusive of `anchorItemId`). */
export function selectableItemIdsOnTrackSide(
  state: Pick<TimelineState, 'items' | 'tracks'>,
  trackId: TrackId,
  referenceFrame: number,
  side: 'left' | 'right',
  options: { anchorItemId?: string } = {},
): string[] {
  if (state.tracks?.[trackId]?.locked) return [];
  const trackItems = state.items.filter((item) => item.track === trackId);
  const anchor = options.anchorItemId
    ? trackItems.find((item) => item.id === options.anchorItemId)
    : undefined;
  const frame = Math.max(0, Math.round(referenceFrame));
  return trackItems
    .filter((item) => {
      if (anchor) {
        return side === 'left'
          ? item.startFrame <= anchor.startFrame
          : item.startFrame >= anchor.startFrame;
      }
      return side === 'left'
        ? item.startFrame + item.durationInFrames <= frame
        : item.startFrame >= frame;
    })
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

interface PreparedItemMove {
  ids: Set<string>;
  moving: TimelineItem[];
}

function trackDelta(state: TimelineState, shift: { from: TrackId; to: TrackId } | null): number {
  if (!shift) return 0;
  const order = timelineTrackIds(state);
  const from = order.indexOf(shift.from);
  const to = order.indexOf(shift.to);
  return from >= 0 && to >= 0 ? to - from : 0;
}

/** Dedicated text and effect tracks only accept compatible item kinds across same-kind lanes. */
export function canItemMoveToTrack(state: TimelineState, item: TimelineItem, targetTrack: TrackId): boolean {
  if (targetTrack === item.track) return !state.tracks?.[targetTrack]?.locked;
  if (trackKind(state, targetTrack) !== trackKind(state, item.track)) return false;
  return canTrackAcceptItemKind(state, item.kind, targetTrack);
}

function shiftedTrack(state: TimelineState, item: TimelineItem, delta: number): TrackId {
  if (delta === 0) return item.track;
  const order = timelineTrackIds(state);
  const sourceIndex = order.indexOf(item.track);
  if (sourceIndex < 0) return item.track;
  const candidate = order[sourceIndex + delta];
  return candidate && canItemMoveToTrack(state, item, candidate) ? candidate : item.track;
}

function prepareItemMove(
  state: TimelineState,
  ids: readonly string[],
  trackShift: { from: TrackId; to: TrackId } | null,
): PreparedItemMove | null {
  const expanded = new Set(moveLockedItemIds(state, foldMoveItemIds(state, ids)));
  const sourceItems = state.items.filter((item) => expanded.has(item.id));
  if (!sourceItems.length || sourceItems.some((item) => state.tracks?.[item.track]?.locked)) return null;
  const delta = trackDelta(state, trackShift);
  const moving = sourceItems.map((item) => ({
    ...item,
    track: shiftedTrack(state, item, delta),
  }));
  return { ids: expanded, moving };
}

export function clampItemsMoveDelta(
  state: TimelineState,
  ids: readonly string[],
  requestedDelta: number,
  trackShift: { from: TrackId; to: TrackId } | null,
  bounds: { min?: number; max?: number } = {},
): number | null {
  const prepared = prepareItemMove(state, ids, trackShift);
  return prepared
    ? clampMoveDeltaToTrackGaps(state, prepared.moving, prepared.ids, requestedDelta, bounds)
    : null;
}

/**
 * Shift a set of clips by one non-overlapping frame delta; optional track index
 * shift follows same-kind, unlocked lanes.
 */
export function moveItemsByDelta(
  state: TimelineState,
  ids: string[],
  deltaF: number,
  trackShift: { from: TrackId; to: TrackId } | null,
): TimelineState {
  const prepared = prepareItemMove(state, ids, trackShift);
  if (!prepared) return state;
  const sharedDelta = clampMoveDeltaToTrackGaps(
    state,
    prepared.moving,
    prepared.ids,
    deltaF,
  );
  if (sharedDelta === null) return state;
  const replacements = new Map(prepared.moving.map((item) => [
    item.id,
    { ...item, startFrame: item.startFrame + sharedDelta },
  ]));
  if ([...replacements.values()].every((item) => {
    const current = state.items.find((candidate) => candidate.id === item.id);
    return current?.track === item.track && current.startFrame === item.startFrame;
  })) return state;
  return {
    ...state,
    items: state.items.map((item) => replacements.get(item.id) ?? item),
  };
}

/** Remove many clips; optional ripple close-gap per clip (reverse chrono so indices stay valid). */
export function removeItemsFromState(
  state: TimelineState,
  ids: string[],
  ripple = false,
): TimelineState {
  return ids.length ? removeItemsWithGroups(state, ids, ripple) : state;
}
