import type { TimelineItem, TimelineState } from './types';
import { selectedIdsOf, timelineTrackIds, trackKind } from './types';
import { fitItemToDuration } from './clipFit';
import { linkedItemIds, maintainLinkGroups, moveLockedItemIds, retimeItemWithGroups } from './linkGroups';
import { introducesTrackOverlap } from './trackCollision';
import { retimePatchForItem } from './reducerTimelineHelpers';
import { remainingSourceFrames } from './sourceLimit';
import { reconcileTransitions } from './transitionReconcile';
import { reconcileTimelineCaptionReferences } from '../captions/reconcileSources';

export interface MagneticPlan {
  state: TimelineState;
  /** Actual final (packed, when enabled) placement, not the mouse coordinate. */
  insertionFrame?: number;
  error?: string;
}

const fail = (state: TimelineState, error: string): MagneticPlan => ({ state, error });
const ordered = (items: readonly TimelineItem[]) => items.toSorted((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
const magnetic = (state: TimelineState) => state.interaction?.magnet === true;

/** Stable identity wins; legacy fallback is the actual bottom picture lane,
 * not the literal id V1 (which can now refer to a reordered upper lane). */
export function mainTrackId(state: TimelineState): string | null {
  const tracks = timelineTrackIds(state);
  const explicit = state.interaction?.mainTrackId;
  if (explicit && tracks.includes(explicit) && trackKind(state, explicit) === 'video') {
    return explicit;
  }
  const reversed = tracks.toReversed();
  return reversed.find((id) => trackKind(state, id) === 'video' && !state.tracks?.[id]?.visualRole)
    ?? reversed.find((id) => trackKind(state, id) === 'video')
    ?? null;
}

function linkedKind(item: TimelineItem): 'text' | 'video' | 'image' | 'audio' | 'other' {
  if (item.kind === 'text' || item.kind === 'video' || item.kind === 'audio') return item.kind;
  if (item.kind === 'image' || item.kind === 'gif' || item.kind === 'svg') return 'image';
  return 'other';
}

export function followsMain(state: TimelineState, item: TimelineItem): boolean {
  return state.interaction?.linkage === true
    && (state.interaction.linkedKinds ?? ['text', 'video', 'image', 'other']).includes(linkedKind(item));
}

/** Call only for a NEW clip (or explicit user attach action). Existing overlaps
 * never create a relationship merely because linkage was switched on. */
export function attachToMainClip(state: TimelineState, item: TimelineItem): TimelineItem {
  const main = mainTrackId(state);
  if (!main || item.track === main || !followsMain(state, item)) return item;
  const candidates = state.items.filter((clip) => clip.track === main && clip.id !== item.id);
  const existing = candidates.find((clip) => clip.id === item.mainClipId);
  const owners = candidates.filter((clip) => item.startFrame >= clip.startFrame
    && item.startFrame < clip.startFrame + clip.durationInFrames);
  const parent = existing ?? (owners.length === 1 ? owners[0] : undefined);
  return parent && item.mainClipId !== parent.id ? { ...item, mainClipId: parent.id } : item;
}

function packed(items: readonly TimelineItem[]): TimelineItem[] {
  let at = 0;
  return items.map((item) => {
    const next = item.startFrame === at ? item : { ...item, startFrame: at };
    at += item.durationInFrames;
    return next;
  });
}

/** Choose among the visible pre-edit clip boundaries, then pack once. */
function insertAtNearestBoundary(lane: readonly TimelineItem[], adding: readonly TimelineItem[], frame: number): TimelineItem[] {
  // A removed clip leaves a visible gap. Both edges of that gap denote the
  // SAME insertion slot, so dropping back at its original start is a no-op.
  const positions = Array.from({ length: lane.length + 1 }, (_, index) => {
    const previous = lane[index - 1];
    const next = lane[index];
    const left = previous ? previous.startFrame + previous.durationInFrames : next?.startFrame ?? 0;
    const right = next?.startFrame ?? left;
    return Math.max(Math.min(left, right), Math.min(Math.max(left, right), frame));
  });
  let index = 0;
  for (let i = 1; i < positions.length; i += 1) {
    if (Math.abs(positions[i]! - frame) < Math.abs(positions[index]! - frame)) index = i;
  }
  return packed([...lane.slice(0, index), ...adding, ...lane.slice(index)]);
}

function replaceItems(state: TimelineState, replacements: readonly TimelineItem[]): TimelineState {
  const map = new Map(replacements.map((item) => [item.id, item]));
  const items = state.items.map((item) => map.get(item.id) ?? item);
  return items.every((item, i) => item === state.items[i]) ? state : { ...state, items };
}

function sameGeometry(a: TimelineItem, b: TimelineItem): boolean {
  return a.track === b.track && a.startFrame === b.startFrame
    && a.durationInFrames === b.durationInFrames && a.srcInFrame === b.srcInFrame;
}

/** Finalize one atomic change: directional followers, linked/sync-locked
 * geometry, locks, source bounds, overlaps and dependent references. This is
 * also usable by existing planners; it deliberately never packs a lane. */
export function planDirectionalChange(before: TimelineState, proposed: TimelineState): MagneticPlan {
  if (before === proposed) return { state: before };
  const old = new Map(before.items.map((item) => [item.id, item]));
  const replacements = new Map(proposed.items.map((item) => [item.id, item]));
  const deleted = new Set(before.items.filter((item) => !replacements.has(item.id)).map((item) => item.id));
  const main = mainTrackId(before);
  // Removing a main clip removes only its explicitly attached, enabled followers.
  // Generic linked A/V removal still follows the pre-existing linked policy.
  let grew = true;
  while (grew) {
    grew = false;
    const ids = new Set(linkedItemIds(before, [...deleted]));
    for (const item of before.items) {
      const parent = item.mainClipId ? old.get(item.mainClipId) : undefined;
      if (parent?.track === main && deleted.has(parent.id) && followsMain(before, item)) ids.add(item.id);
    }
    for (const id of ids) if (!deleted.has(id)) { deleted.add(id); grew = true; }
  }
  for (const id of deleted) replacements.delete(id);

  const shifts = new Map<string, number>();
  for (const item of replacements.values()) {
    const previous = old.get(item.id);
    // Unchanged main positions are constraints too: linked clips cannot silently
    // pull a second main clip out of the packed ordering.
    if (previous && (item.startFrame !== previous.startFrame || previous.track === main)) {
      shifts.set(item.id, item.startFrame - previous.startFrame);
    }
  }
  let conflict = false;
  const assign = (id: string, delta: number): boolean => {
    if (!replacements.has(id) || !old.has(id)) return false;
    const existing = shifts.get(id);
    if (existing !== undefined) { if (existing !== delta) conflict = true; return false; }
    shifts.set(id, delta);
    return true;
  };
  grew = true;
  while (grew && !conflict) {
    grew = false;
    for (const group of before.linkGroups ?? []) {
      // Ordinary groups follow direct selection in the move planner, not every
      // ripple edit. Only structural linked/sync-lock constraints propagate here.
      if (group.mode !== 'linked' && group.mode !== 'sync-lock') continue;
      const delta = group.itemIds.flatMap((id) => shifts.has(id) ? [shifts.get(id)!] : [])[0];
      if (delta === undefined) continue;
      for (const id of group.itemIds) grew = assign(id, delta) || grew;
    }
    for (const item of before.items) {
      const parent = item.mainClipId ? old.get(item.mainClipId) : undefined;
      // A child is free to move on its own. A stationary parent (zero delta)
      // must not impose its position on that direct child edit.
      if (parent?.track !== main || !followsMain(before, item) || !shifts.get(parent.id)) continue;
      grew = assign(item.id, shifts.get(parent.id)!) || grew;
    }
  }
  if (conflict) return fail(before, '主轨磁吸与片段链接的位置冲突，请先解除链接或关闭主轨磁吸。');

  for (const [id, delta] of shifts) {
    const item = replacements.get(id)!;
    const startFrame = old.get(id)!.startFrame + delta;
    if (item.startFrame !== startFrame) replacements.set(id, { ...item, startFrame });
  }
  for (const item of before.items) {
    const next = replacements.get(item.id);
    if ((!next || !sameGeometry(item, next)) && before.tracks?.[item.track]?.locked) {
      return fail(before, '这次操作会改变已锁定轨道上的片段，请先解锁该轨道。');
    }
  }
  for (const item of replacements.values()) {
    const previous = old.get(item.id);
    if ((!previous || !sameGeometry(previous, item)) && proposed.tracks?.[item.track]?.locked) {
      return fail(before, '目标轨道已锁定，请先解锁。');
    }
    if (!Number.isInteger(item.startFrame) || item.startFrame < 0
      || !Number.isInteger(item.durationInFrames) || item.durationInFrames < 1
      || (item.srcInFrame !== undefined && (!Number.isFinite(item.srcInFrame) || item.srcInFrame < 0))) {
      return fail(before, '这次联动会把片段移出时间线，操作未执行。');
    }
    if (previous && item.durationInFrames === previous.durationInFrames && item.srcInFrame === previous.srcInFrame) continue;
    const limit = remainingSourceFrames(item, item.srcInFrame ?? 0, before.assets);
    if (limit !== null && item.durationInFrames > limit) return fail(before, '裁切超出原素材长度，操作未执行。');
  }
  const nextMain = mainTrackId(proposed);
  const liveMain = new Set([...replacements.values()].filter((item) => item.track === nextMain).map((item) => item.id));
  const items = [...replacements.values()].map((item) => {
    const detached = item.mainClipId && (!liveMain.has(item.mainClipId) || item.track === nextMain)
      ? { ...item, mainClipId: undefined } : item;
    const previous = old.get(item.id);
    return previous && detached.durationInFrames === previous.durationInFrames ? detached : fitItemToDuration(detached);
  });
  if (introducesTrackOverlap(before, { ...proposed, items })) {
    return fail(before, '联动后的片段会与同轨素材重叠，请移动到空轨道或关闭联动后再试。');
  }
  const live = new Set(items.map((item) => item.id));
  const selectedIds = selectedIdsOf(proposed).filter((id) => live.has(id));
  const selectionChanged = selectedIds.length !== selectedIdsOf(proposed).length;
  let state: TimelineState = { ...proposed, items,
    ...(deleted.size ? { linkGroups: maintainLinkGroups(proposed.linkGroups, live) } : {}),
    ...(selectionChanged ? { selectedIds, selectedId: selectedIds[selectedIds.length - 1] ?? null } : {}),
  };
  state = reconcileTimelineCaptionReferences(state);
  if (state.transitions?.length) state = { ...state, transitions: reconcileTransitions(state.items, state.transitions) };
  return { state };
}

export function planMagneticInsert(state: TimelineState, items: TimelineItem[], requestedFrame: number): MagneticPlan {
  if (!items.length) return { state };
  const main = mainTrackId(state);
  if (!main || !Number.isFinite(requestedFrame)) return fail(state, '没有可用的主轨或插入位置无效。');
  const ids = new Set(state.items.map((item) => item.id));
  for (const item of items) {
    if (ids.has(item.id) || !item.id || item.track !== main || item.kind === 'audio') return fail(state, '插入素材的轨道或编号无效。');
    ids.add(item.id);
  }
  const requested = Math.max(0, Math.round(requestedFrame));
  const adding = items.map((item) => item.mainClipId ? { ...item, mainClipId: undefined } : item);
  let lane: TimelineItem[];
  if (magnetic(state)) lane = insertAtNearestBoundary(ordered(state.items.filter((item) => item.track === main)), adding, requested);
  else {
    const first = Math.min(...adding.map((item) => item.startFrame));
    lane = adding.map((item) => ({ ...item, startFrame: item.startFrame + requested - first }));
  }
  const existing = replaceItems(state, lane);
  const newIds = new Set(items.map((item) => item.id));
  const next = { ...existing, items: [...existing.items, ...lane.filter((item) => newIds.has(item.id))],
    selectedIds: items.map((item) => item.id), selectedId: items[items.length - 1]!.id };
  const result = planDirectionalChange(state, next);
  return result.error ? result : { ...result, insertionFrame: result.state.items.find((item) => item.id === items[0]!.id)!.startFrame };
}

export function planMagneticMove(
  state: TimelineState, ids: readonly string[], anchorId: string, requestedStartFrame: number, targetTrack?: string,
): MagneticPlan {
  const anchor = state.items.find((item) => item.id === anchorId);
  if (!anchor || !ids.includes(anchorId) || !Number.isFinite(requestedStartFrame)) return fail(state, '移动的片段或位置无效。');
  const destination = targetTrack ?? anchor.track;
  if (!timelineTrackIds(state).includes(destination) || trackKind(state, destination) !== trackKind(state, anchor.track)) {
    return fail(state, '请把素材拖到同类型轨道。');
  }
  const selected = new Set(moveLockedItemIds(state, ids));
  if (ids.some((id) => !state.items.some((item) => item.id === id))) return fail(state, '选中的片段已发生变化，请重新选择。');
  const main = mainTrackId(state);
  const requested = Math.max(0, Math.round(requestedStartFrame));
  if (requested === anchor.startFrame && destination === anchor.track) return { state, insertionFrame: anchor.startFrame };
  const delta = requested - anchor.startFrame;
  const explicit = new Set(ids);
  const moved = state.items.filter((item) => selected.has(item.id)).map((item) => ({ ...item,
    startFrame: item.startFrame + delta,
    // Mixed-lane selections keep their other lanes, just like linked A/V.
    track: explicit.has(item.id) && item.track === anchor.track ? destination : item.track,
  }));
  let next = replaceItems(state, moved);
  const movesMainSelection = state.items.some((item) => selected.has(item.id) && item.track === main);
  if (magnetic(state) && (movesMainSelection || destination === main)) {
    const movingMain = ordered(next.items.filter((item) => selected.has(item.id) && item.track === main));
    const stationary = ordered(state.items.filter((item) => item.track === main && !selected.has(item.id)));
    // A group can be grabbed by its title/audio rather than by its main clip.
    // The main member is then the insertion reference; the off-main grab handle
    // keeps its original offset from that member after the magnetic placement.
    const mainReference = movingMain.find((item) => state.items.some((original) => original.id === item.id && original.track === main));
    if (movingMain.length) {
      if (movingMain.some((item) => item.kind === 'audio')) return fail(state, '主轨只能放置画面素材。');
      const anchorOffset = movingMain.findIndex((item) => item.id === anchorId);
      const beforeAnchor = anchorOffset < 0 ? 0 : movingMain.slice(0, anchorOffset).reduce((sum, item) => sum + item.durationInFrames, 0);
      const insertionRequest = anchorOffset >= 0 ? requested - beforeAnchor : movingMain[0]!.startFrame;
      next = replaceItems(next, insertAtNearestBoundary(stationary, movingMain, insertionRequest));
    } else next = replaceItems(next, packed(stationary));
    // Explicit off-main selection follows the actual magnetic drag delta, not
    // the raw pointer target; independent followers of other main clips keep
    // their own parent's delta in planDirectionalChange.
    const referenceId = anchor.track !== main && mainReference ? mainReference.id : anchorId;
    const finalReference = next.items.find((item) => item.id === referenceId)!;
    const originalReference = state.items.find((item) => item.id === referenceId)!;
    const finalDelta = finalReference.startFrame - originalReference.startFrame;
    next = replaceItems(next, next.items.filter((item) => selected.has(item.id) && item.track !== main).map((item) => {
      const previous = state.items.find((candidate) => candidate.id === item.id)!;
      return { ...item, startFrame: previous.startFrame + finalDelta };
    }));
  }
  // No-op drag does not normalize gaps or manufacture a history entry.
  if (next.items.every((item, i) => sameGeometry(item, state.items[i]!))) return { state, insertionFrame: anchor.startFrame };
  for (const group of state.linkGroups ?? []) {
    if (group.mode !== 'group' || !group.itemIds.some((id) => selected.has(id))) continue;
    const deltas = group.itemIds.flatMap((id) => {
      const previous = state.items.find((item) => item.id === id);
      const movedItem = next.items.find((item) => item.id === id);
      return previous && movedItem ? [movedItem.startFrame - previous.startFrame] : [];
    });
    if (new Set(deltas).size > 1) return fail(state, '这个组合跨越了其他主轨片段，磁吸无法保持组合间距；请先取消组合或关闭主轨磁吸。');
  }
  const result = planDirectionalChange(state, next);
  return result.error ? result : { ...result, insertionFrame: result.state.items.find((item) => item.id === anchorId)!.startFrame };
}

export function planMagneticDelete(state: TimelineState, ids: readonly string[]): MagneticPlan {
  const remove = new Set(linkedItemIds(state, ids));
  if (!state.items.some((item) => remove.has(item.id))) return { state };
  // Expand followers before packing so a linked follower that itself belongs to
  // the main lane cannot be removed after the packing plan was calculated.
  const preliminary = planDirectionalChange(state, { ...state, items: state.items.filter((item) => !remove.has(item.id)) });
  if (preliminary.error) return preliminary;
  const main = mainTrackId(state);
  if (!magnetic(state) || !state.items.some((item) => item.track === main && !preliminary.state.items.some((next) => next.id === item.id))) return preliminary;
  const next = replaceItems(preliminary.state, packed(ordered(preliminary.state.items.filter((item) => item.track === main))));
  return planDirectionalChange(state, next);
}

export function planMagneticTrim(
  state: TimelineState, id: string,
  timing: { startFrame?: number; durationInFrames?: number; srcInFrame?: number },
): MagneticPlan {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item || [timing.startFrame, timing.durationInFrames, timing.srcInFrame]
    .some((value) => value !== undefined && !Number.isFinite(value))) return fail(state, '裁切的片段或时间无效。');
  const patch = retimePatchForItem(state, item, { type: 'retime', id, ...timing });
  if (item.startFrame === patch.startFrame && item.durationInFrames === patch.durationInFrames && item.srcInFrame === patch.srcInFrame) return { state };
  let next = retimeItemWithGroups(state, id, patch);
  if (!next || next === state) return fail(state, '裁切会改变锁定或无效的链接片段，操作未执行。');
  const main = mainTrackId(state);
  if (magnetic(state) && item.track === main) {
    // Keep editorial order while trimming the left edge; it is not a reorder.
    const oldOrder = ordered(state.items.filter((candidate) => candidate.track === main));
    const newItems = new Map(next.items.map((candidate) => [candidate.id, candidate]));
    const lane = packed(oldOrder.map((candidate) => newItems.get(candidate.id)!));
    const finalStart = lane.find((candidate) => candidate.id === id)!.startFrame;
    const compensation = finalStart - patch.startFrame;
    const linked = new Set(linkedItemIds(state, [id]));
    next = replaceItems(next, [
      ...lane,
      ...next.items.filter((candidate) => linked.has(candidate.id) && candidate.track !== main)
        .map((candidate) => ({ ...candidate, startFrame: candidate.startFrame + compensation })),
    ]);
  }
  return planDirectionalChange(state, next);
}
