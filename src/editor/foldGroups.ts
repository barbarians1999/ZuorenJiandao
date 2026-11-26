import type { TimelineFoldGroup, TimelineItem, TimelineState, TrackId } from './types.js';
import { fitItemToDuration } from './clipFit.js';
import { remainingSourceFrames, sourceWindowForTimelineRange } from './sourceLimit.js';
import { clampMoveDeltaToTrackGaps } from './trackCollision.js';
import { remapSplitTransitionEndpoints, splitTimelineItem } from './reducerOverwrite.js';
import { remapSplitTimelineCaptionReferences } from '../captions/reconcileSources.js';
import { applyRippleShifts } from './linkGroups.js';

// Independent visual folding groups for transcript-cut or multi-segment clips.
// Strictly decoupled from `linkGroups` (linked / sync-lock / ordinary group):
// unlinking or changing sync-locks never alters foldGroups, and dissolving a
// foldGroup never alters linkGroups or playback timing.

const uniqueIds = (ids: readonly string[]): string[] => [...new Set(ids)];

export function foldGroupForItem(
  state: Pick<TimelineState, 'foldGroups'>,
  itemId: string,
): TimelineFoldGroup | undefined {
  return state.foldGroups?.find((group) => group.itemIds.includes(itemId));
}

export function isFoldGroupVisuallyCollapsed(group: TimelineFoldGroup | undefined): boolean {
  return Boolean(group && group.collapsed && group.itemIds.length >= 2);
}

/** Expand any item belonging to a collapsed foldGroup to all of its sub-clip ids. */
export function foldMoveItemIds(
  state: Pick<TimelineState, 'foldGroups'>,
  seeds: readonly string[],
): string[] {
  const out = new Set(seeds);
  for (const group of state.foldGroups ?? []) {
    if (!isFoldGroupVisuallyCollapsed(group)) continue;
    if (group.itemIds.some((id) => out.has(id))) {
      for (const id of group.itemIds) out.add(id);
    }
  }
  return [...out];
}

export interface ResolvedFoldGroupSpan {
  group: TimelineFoldGroup;
  items: TimelineItem[];
  firstItem: TimelineItem;
  lastItem: TimelineItem;
  startFrame: number;
  endFrame: number;
  durationInFrames: number;
}

export function resolveFoldGroupSpan(
  state: Pick<TimelineState, 'items'>,
  group: TimelineFoldGroup,
): ResolvedFoldGroupSpan | null {
  const idSet = new Set(group.itemIds);
  const items = state.items
    .filter((item) => idSet.has(item.id))
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  if (!items.length) return null;
  const firstItem = items[0]!;
  const lastItem = items.reduce((best, cur) =>
    cur.startFrame + cur.durationInFrames > best.startFrame + best.durationInFrames ? cur : best,
  items[0]!);
  const startFrame = firstItem.startFrame;
  const endFrame = lastItem.startFrame + lastItem.durationInFrames;
  return {
    group,
    items,
    firstItem,
    lastItem,
    startFrame,
    endFrame,
    durationInFrames: Math.max(1, endFrame - startFrame),
  };
}

/**
 * Maintain `foldGroups` after arbitrary item deletions, splits, or track moves
 * without touching `linkGroups`.
 */
export function maintainFoldGroups(
  prevState: TimelineState,
  nextState: TimelineState,
  splitMeta?: { splitId: string; newId: string },
): TimelineFoldGroup[] | undefined {
  const existing = nextState.foldGroups ?? prevState.foldGroups;
  if (!existing?.length) return undefined;

  const byId = new Map(nextState.items.map((item) => [item.id, item]));
  const updated: TimelineFoldGroup[] = [];

  for (const group of existing) {
    let ids = uniqueIds(group.itemIds);
    if (splitMeta && ids.includes(splitMeta.splitId) && !ids.includes(splitMeta.newId) && byId.has(splitMeta.newId)) {
      const idx = ids.indexOf(splitMeta.splitId);
      ids = [...ids.slice(0, idx + 1), splitMeta.newId, ...ids.slice(idx + 1)];
    }
    const members = ids
      .map((id) => byId.get(id))
      .filter((item): item is TimelineItem => Boolean(item))
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    if (!members.length) continue;

    // Keep 1-item groups only if they carry sourceTranscript metadata (e.g. edge words deleted & restorable).
    if (members.length < 2 && !group.sourceTranscript?.length) continue;

    const primaryTrack = members[0]!.track;
    const sameTrackMembers = members.filter((m) => m.track === primaryTrack);
    if (sameTrackMembers.length < 2 && !group.sourceTranscript?.length) continue;

    updated.push({
      ...group,
      track: primaryTrack,
      itemIds: sameTrackMembers.map((m) => m.id),
      collapsed: sameTrackMembers.length >= 2 ? group.collapsed : false,
    });
  }

  return updated.length ? updated : undefined;
}

export function toggleFoldGroupState(state: TimelineState, groupId: string): TimelineState {
  const target = state.foldGroups?.find((g) => g.id === groupId);
  if (!target || target.itemIds.length < 2) return state;
  return {
    ...state,
    foldGroups: state.foldGroups!.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
  };
}

export function dissolveFoldGroupState(state: TimelineState, groupId: string): TimelineState {
  const target = state.foldGroups?.find((g) => g.id === groupId);
  if (!target) return state;
  if (target.itemIds.some((id) => {
    const item = state.items.find((it) => it.id === id);
    return item && state.tracks?.[item.track]?.locked;
  })) {
    return state;
  }
  const next = state.foldGroups!.filter((g) => g.id !== groupId);
  return { ...state, foldGroups: next.length ? next : undefined };
}

function makeUniqueGroupId(base: string, existing: Set<string>): string {
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }
  let n = 1;
  while (existing.has(`${base}_${n}`)) n += 1;
  const id = `${base}_${n}`;
  existing.add(id);
  return id;
}

/**
 * Split a folded (or expanded) foldGroup at `atFrame` (either on a seam between
 * sub-clips or inside one sub-clip) into two independent `TimelineFoldGroup`s.
 */
export function splitFoldGroupAtFrame(
  state: TimelineState,
  groupId: string,
  atFrameInput: number,
  options: { leftGroupId?: string; rightGroupId?: string; newClipId?: string } = {},
): TimelineState {
  const group = state.foldGroups?.find((g) => g.id === groupId);
  if (!group || !Number.isFinite(atFrameInput)) return state;
  const resolved = resolveFoldGroupSpan(state, group);
  if (!resolved) return state;
  const { items, startFrame, endFrame } = resolved;
  if (items.some((item) => state.tracks?.[item.track]?.locked)) return state;

  const atFrame = Math.round(atFrameInput);
  if (atFrame <= startFrame || atFrame >= endFrame) return state;

  const takenClipIds = new Set(state.items.map((item) => item.id));
  const takenGroupIds = new Set((state.foldGroups ?? []).filter((g) => g.id !== group.id).map((g) => g.id));
  const leftGroupId = options.leftGroupId ?? makeUniqueGroupId(`${group.id}_l`, takenGroupIds);
  const rightGroupId = options.rightGroupId ?? makeUniqueGroupId(`${group.id}_r`, takenGroupIds);

  const covering = items.find((item) => atFrame > item.startFrame && atFrame < item.startFrame + item.durationInFrames);
  let nextState: TimelineState = state;
  let leftItems: TimelineItem[] = [];
  let rightItems: TimelineItem[] = [];

  if (covering) {
    const newClipId = options.newClipId && !takenClipIds.has(options.newClipId)
      ? options.newClipId
      : makeUniqueGroupId(`${covering.id}_split`, takenClipIds);
    const [leftHalf, rightHalf] = splitTimelineItem(state, covering, atFrame, newClipId);
    const nextItems = state.items.flatMap((candidate) => (
      candidate.id === covering.id
        ? [leftHalf, rightHalf]
        : [candidate.mainClipId === covering.id && candidate.startFrame >= atFrame
            ? { ...candidate, mainClipId: rightHalf.id }
            : candidate]
    ));
    nextState = remapSplitTimelineCaptionReferences({
      ...state,
      items: nextItems,
      transitions: remapSplitTransitionEndpoints(state.transitions, covering.id, rightHalf.id),
    }, covering.id, rightHalf.id);
    leftItems = items.filter((item) => item.startFrame < covering.startFrame).concat(leftHalf);
    rightItems = [rightHalf].concat(items.filter((item) => item.startFrame >= covering.startFrame + covering.durationInFrames));
  } else {
    leftItems = items.filter((item) => item.startFrame + item.durationInFrames <= atFrame);
    rightItems = items.filter((item) => item.startFrame >= atFrame);
    if (!leftItems.length || !rightItems.length) return state;
  }

  const others = (nextState.foldGroups ?? []).filter((g) => g.id !== group.id);
  const newGroups: TimelineFoldGroup[] = [...others];
  const makeHalfGroup = (id: string, subset: TimelineItem[]): TimelineFoldGroup | null => {
    if (subset.length < 2 && !group.sourceTranscript?.length) return null;
    const minSrc = Math.min(...subset.map((c) => sourceWindowForTimelineRange(c, 0, c.durationInFrames).startFrame));
    const maxSrc = Math.max(...subset.map((c) => sourceWindowForTimelineRange(c, 0, c.durationInFrames).endFrame));
    return {
      id,
      track: subset[0]!.track,
      itemIds: subset.map((c) => c.id),
      collapsed: subset.length >= 2 ? group.collapsed : false,
      label: group.label,
      ...(group.sourceTranscript?.length ? {
        sourceTranscript: subset.flatMap((c) => c.transcript ?? []),
        transcriptGenerationId: group.transcriptGenerationId,
        sourceSpan: { srcStartFrame: minSrc, srcEndFrame: maxSrc },
      } : {}),
    };
  };

  const leftHalfGroup = makeHalfGroup(leftGroupId, leftItems);
  const rightHalfGroup = makeHalfGroup(rightGroupId, rightItems);
  if (leftHalfGroup) newGroups.push(leftHalfGroup);
  if (rightHalfGroup) newGroups.push(rightHalfGroup);

  const selected = rightItems[0]?.id ?? leftItems[0]?.id ?? null;
  return {
    ...nextState,
    foldGroups: newGroups.length ? newGroups : undefined,
    ...(selected ? { selectedIds: [selected], selectedId: selected } : {}),
  };
}

/**
 * Trim the outer edge of a collapsed `foldGroup` (`'left'` or `'right'`),
 * dropping sub-clips consumed by inward trims and clamping outward extension
 * against available source handles and same-track neighbours.
 */
export function trimFoldGroupEdge(
  state: TimelineState,
  groupId: string,
  edge: 'left' | 'right',
  requestedDeltaFrames: number,
  options: { ripple?: boolean } = {},
): TimelineState {
  const group = state.foldGroups?.find((g) => g.id === groupId);
  if (!group || !Number.isFinite(requestedDeltaFrames) || Math.round(requestedDeltaFrames) === 0) return state;
  const resolved = resolveFoldGroupSpan(state, group);
  if (!resolved) return state;
  const { items, startFrame, endFrame, durationInFrames } = resolved;
  const track = items[0]!.track;
  if (items.some((item) => state.tracks?.[item.track]?.locked) || state.tracks?.[track]?.locked) return state;

  const delta = Math.round(requestedDeltaFrames);
  const groupIdSet = new Set(items.map((item) => item.id));
  const minTotalFrames = 1;

  let nextItemsMap = new Map<string, TimelineItem>();
  let removedIds = new Set<string>();
  let rippleShiftEndDelta = 0;

  if (edge === 'left') {
    const earliestByZero = -startFrame;
    let earliestByTrack = earliestByZero;
    for (const candidate of state.items) {
      if (candidate.track !== track || groupIdSet.has(candidate.id)) continue;
      const cEnd = candidate.startFrame + candidate.durationInFrames;
      if (cEnd <= startFrame) earliestByTrack = Math.max(earliestByTrack, cEnd - startFrame);
    }
    const first = items[0]!;
    const sourceBacktrack = first.kind === 'audio' || first.kind === 'video' || first.kind === 'sequence'
      ? -Math.floor((first.srcInFrame ?? 0) / Math.max(0.01, first.playbackRate ?? 1))
      : earliestByTrack;
    const minDelta = Math.max(earliestByZero, earliestByTrack, sourceBacktrack);
    const maxDelta = Math.max(0, durationInFrames - minTotalFrames);
    const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
    if (clampedDelta === 0) return state;

    if (clampedDelta < 0) {
      const nextSrcIn = first.kind === 'video' || first.kind === 'audio' || first.kind === 'sequence'
        ? sourceWindowForTimelineRange(first, clampedDelta, first.durationInFrames - clampedDelta).startFrame
        : first.srcInFrame;
      nextItemsMap.set(first.id, fitItemToDuration({
        ...first,
        startFrame: first.startFrame + clampedDelta,
        durationInFrames: first.durationInFrames - clampedDelta,
        ...(nextSrcIn !== undefined ? { srcInFrame: nextSrcIn } : {}),
      }));
    } else {
      const targetStart = startFrame + clampedDelta;
      for (const item of items) {
        const iEnd = item.startFrame + item.durationInFrames;
        if (iEnd <= targetStart) {
          removedIds.add(item.id);
          continue;
        }
        if (item.startFrame < targetStart) {
          const trimFrames = targetStart - item.startFrame;
          const nextSrcIn = item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence'
            ? sourceWindowForTimelineRange(item, trimFrames, item.durationInFrames - trimFrames).startFrame
            : item.srcInFrame;
          nextItemsMap.set(item.id, fitItemToDuration({
            ...item,
            startFrame: targetStart,
            durationInFrames: iEnd - targetStart,
            ...(nextSrcIn !== undefined ? { srcInFrame: nextSrcIn } : {}),
          }));
        }
      }
    }
  } else {
    let latestByTrack = Infinity;
    if (!options.ripple) {
      for (const candidate of state.items) {
        if (candidate.track !== track || groupIdSet.has(candidate.id)) continue;
        if (candidate.startFrame >= endFrame) {
          latestByTrack = Math.min(latestByTrack, candidate.startFrame - endFrame);
        }
      }
    }
    const last = items[items.length - 1]!;
    const remainingSrc = remainingSourceFrames(last, last.srcInFrame ?? 0, state.assets);
    const maxExtendBySrc = remainingSrc !== null ? Math.max(0, remainingSrc - last.durationInFrames) : Infinity;
    const minDelta = -(durationInFrames - minTotalFrames);
    const maxDelta = Math.min(latestByTrack, maxExtendBySrc);
    const clampedDelta = Math.max(minDelta, Math.min(maxDelta, delta));
    if (clampedDelta === 0) return state;

    rippleShiftEndDelta = clampedDelta;
    if (clampedDelta > 0) {
      nextItemsMap.set(last.id, fitItemToDuration({
        ...last,
        durationInFrames: last.durationInFrames + clampedDelta,
      }));
    } else {
      const targetEnd = endFrame + clampedDelta;
      for (const item of items) {
        const iEnd = item.startFrame + item.durationInFrames;
        if (item.startFrame >= targetEnd) {
          removedIds.add(item.id);
          continue;
        }
        if (iEnd > targetEnd) {
          nextItemsMap.set(item.id, fitItemToDuration({
            ...item,
            durationInFrames: targetEnd - item.startFrame,
          }));
        }
      }
    }
  }

  let nextItems = state.items
    .filter((item) => !removedIds.has(item.id))
    .map((item) => nextItemsMap.get(item.id) ?? item);

  // Verify no overlap introduced and optional ripple shift.
  const replacedSet = new Set([...nextItemsMap.keys()]);
  const clampedCheck = clampMoveDeltaToTrackGaps(
    state,
    nextItems.filter((item) => replacedSet.has(item.id)),
    groupIdSet,
    0,
  );
  if (clampedCheck === null) return state;

  let nextState: TimelineState = { ...state, items: nextItems };
  if (edge === 'right' && options.ripple && rippleShiftEndDelta !== 0) {
    const baseShifts = new Map<string, number>();
    for (const item of state.items) {
      if (item.track === track && item.startFrame >= endFrame && !groupIdSet.has(item.id)) {
        baseShifts.set(item.id, rippleShiftEndDelta);
      }
    }
    if (baseShifts.size > 0) {
      const shifted = applyRippleShifts(nextState, baseShifts, replacedSet);
      if (!shifted) return state;
      nextState = shifted;
    }
  }

  const nextFoldGroups = maintainFoldGroups(state, { ...nextState, foldGroups: state.foldGroups });
  return { ...nextState, foldGroups: nextFoldGroups };
}

export function cloneFoldGroupsForCopiedItems(
  sourceGroups: readonly TimelineFoldGroup[] | undefined,
  idMap: ReadonlyMap<string, string>,
  copiedItems: readonly TimelineItem[],
  uid: (prefix: string) => string,
): TimelineFoldGroup[] {
  if (!sourceGroups?.length) return [];
  const trackById = new Map<string, TrackId>(copiedItems.map((item) => [item.id, item.track]));
  const out: TimelineFoldGroup[] = [];
  for (const group of sourceGroups) {
    if (!group.itemIds.every((id) => idMap.has(id))) continue;
    const mappedIds = group.itemIds.map((id) => idMap.get(id)!);
    const track = trackById.get(mappedIds[0]!) ?? group.track;
    out.push({
      ...group,
      id: uid('fg'),
      track,
      itemIds: mappedIds,
    });
  }
  return out;
}
