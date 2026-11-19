import { hasOperationalTranscript } from '../transcript/types.js';
import type { TimelineItem, TimelineState, TrackId } from './types.js';
import { fitItemToDuration } from './clipFit.js';
import { linkedItemIds, retimeItemWithGroups } from './linkGroups.js';
import { introducesTrackOverlap } from './trackCollision.js';
import { timelineFramesToSourceFrames } from './sourceLimit.js';
import { reconcileTransitions } from './transitionReconcile.js';

export interface RollingTrimPlan {
  state: TimelineState;
  deltaF: number;
  error?: string;
  limitMessage?: string;
}

interface SourceBounds {
  item: TimelineItem;
  start: number;
  end: number;
  length: number;
  rate: number;
}

const fail = (state: TimelineState, error: string): RollingTrimPlan => ({ state, deltaF: 0, error });

function sourceBounds(state: TimelineState, item: TimelineItem): SourceBounds | null {
  if ((item.kind !== 'video' && item.kind !== 'audio') || !item.src
    || (item.kind === 'audio' && hasOperationalTranscript(item))
    || item.multicamGroupId) return null;
  const asset = item.sourceAssetId
    ? state.assets?.find((candidate) => candidate.id === item.sourceAssetId)
    : state.assets?.find((candidate) => candidate.src === item.src);
  const length = asset?.durationInFrames;
  if (!Number.isFinite(length) || (length ?? 0) < 1) return null;
  const rate = item.playbackRate ?? 1;
  const start = item.srcInFrame ?? 0;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(start) || start < 0
    || !Number.isInteger(item.durationInFrames) || item.durationInFrames < 1) return null;
  const end = start + timelineFramesToSourceFrames(item, item.durationInFrames);
  if (!Number.isFinite(end) || end > length! + 1e-7) return null;
  return { item, start, end, length: length!, rate: Math.max(0.01, rate) };
}

function validateSidePairs(
  state: TimelineState,
  leftIds: readonly string[],
  rightIds: readonly string[],
): { pairs: Array<{ left: TimelineItem; right: TimelineItem }>; error?: string } {
  const items = new Map(state.items.map((item) => [item.id, item]));
  const leftByTrack = new Map<TrackId, TimelineItem>();
  const rightByTrack = new Map<TrackId, TimelineItem>();
  for (const id of leftIds) {
    const item = items.get(id);
    if (!item || leftByTrack.has(item.track)) return { pairs: [], error: '联动左侧片段的轨道关系不明确，无法滚动裁剪。' };
    leftByTrack.set(item.track, item);
  }
  for (const id of rightIds) {
    const item = items.get(id);
    if (!item || rightByTrack.has(item.track)) return { pairs: [], error: '联动右侧片段的轨道关系不明确，无法滚动裁剪。' };
    rightByTrack.set(item.track, item);
  }
  if (leftByTrack.size !== rightByTrack.size
    || [...leftByTrack.keys()].some((track) => !rightByTrack.has(track))) {
    return { pairs: [], error: '左右联动片段没有对应的同轨交界，无法滚动裁剪。' };
  }
  const pairs = [...leftByTrack].map(([track, left]) => ({ left, right: rightByTrack.get(track)! }));
  for (const { left, right } of pairs) {
    const lane = state.items.filter((item) => item.track === left.track)
      .toSorted((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    const leftIndex = lane.findIndex((item) => item.id === left.id);
    if (left.startFrame + left.durationInFrames !== right.startFrame
      || leftIndex < 0 || lane[leftIndex + 1]?.id !== right.id) {
      return { pairs: [], error: '左右片段必须在每条关联轨道上精确相邻，间隙或重叠无法滚动裁剪。' };
    }
    if (lane.some((item) => item.id !== left.id && item.id !== right.id
      && ((item.startFrame < left.startFrame + left.durationInFrames
        && item.startFrame + item.durationInFrames > left.startFrame)
        || (item.startFrame < right.startFrame + right.durationInFrames
          && item.startFrame + item.durationInFrames > right.startFrame)))) {
      return { pairs: [], error: '关联轨道上有重叠片段，无法确定滚动裁剪的共同边界。' };
    }
  }
  return { pairs };
}

/** Plan one atomic roll at an exact cut. Unknown source lengths are never treated as spare media. */
export function planRollingTrim(
  state: TimelineState,
  leftId: string,
  rightId: string,
  requestedDeltaF: number,
): RollingTrimPlan {
  const left = state.items.find((item) => item.id === leftId);
  const right = state.items.find((item) => item.id === rightId);
  if (!left || !right || left.id === right.id) return fail(state, '找不到滚动裁剪的片段。');
  if (!Number.isFinite(requestedDeltaF)) return fail(state, '滚动裁剪位置无效。');
  if (left.track !== right.track) return fail(state, '滚动裁剪只能作用于同一轨道的相邻片段。');
  if (state.tracks?.[left.track]?.locked) return fail(state, '轨道已锁定，无法滚动裁剪。');
  if (left.startFrame + left.durationInFrames !== right.startFrame) {
    return fail(state, '左右片段必须精确相邻，间隙或重叠无法滚动裁剪。');
  }

  const leftIds = linkedItemIds(state, [leftId]);
  const rightIds = linkedItemIds(state, [rightId]);
  const leftSet = new Set(leftIds);
  const rightSet = new Set(rightIds);
  if (leftIds.some((id) => rightSet.has(id))) return fail(state, '左右片段属于同一联动组，无法滚动裁剪。');
  if (state.items.some((item) => [...leftSet, ...rightSet].includes(item.id)
    && state.tracks?.[item.track]?.locked)) return fail(state, '关联片段所在轨道已锁定，无法滚动裁剪。');
  if ((state.multicamGroups ?? []).some((group) => group.angles.some((angle) =>
    leftSet.has(angle.itemId) || rightSet.has(angle.itemId)
    || leftSet.has(angle.source.id) || rightSet.has(angle.source.id)))) {
    return fail(state, '多机位片段暂不支持滚动裁剪。');
  }
  if ((state.linkGroups ?? []).some((group) => group.mode === 'sync-lock'
    && group.itemIds.some((id) => rightSet.has(id))
    && group.itemIds.some((id) => !rightSet.has(id)))) {
    return fail(state, '右侧片段受同步锁定；请先解除同步锁定再滚动裁剪。');
  }

  const paired = validateSidePairs(state, leftIds, rightIds);
  if (paired.error) return fail(state, paired.error);
  if ((state.transitions ?? []).some((transition) => paired.pairs.some(({ left, right }) =>
    transition.trackId === left.track && transition.outgoingItemId === left.id && transition.incomingItemId === right.id))) {
    return fail(state, '滚动裁剪的共同边界带有转场，先移除转场再操作。');
  }
  const leftBounds: SourceBounds[] = [];
  const rightBounds: SourceBounds[] = [];
  for (const id of leftIds) {
    const item = state.items.find((candidate) => candidate.id === id)!;
    const bounds = sourceBounds(state, item);
    if (!bounds) return fail(state, `${item.name} 的源长度未知或剪辑方式不受支持，无法安全滚动裁剪。`);
    leftBounds.push(bounds);
  }
  for (const id of rightIds) {
    const item = state.items.find((candidate) => candidate.id === id)!;
    const bounds = sourceBounds(state, item);
    if (!bounds) return fail(state, `${item.name} 的源长度未知或剪辑方式不受支持，无法安全滚动裁剪。`);
    rightBounds.push(bounds);
  }

  let minDelta = Number.NEGATIVE_INFINITY;
  let maxDelta = Number.POSITIVE_INFINITY;
  const minReasons = new Set<string>();
  const maxReasons = new Set<string>();
  const setMin = (value: number, reason: string) => {
    if (value > minDelta) { minDelta = value; minReasons.clear(); minReasons.add(reason); }
    else if (value === minDelta) minReasons.add(reason);
  };
  const setMax = (value: number, reason: string) => {
    if (value < maxDelta) { maxDelta = value; maxReasons.clear(); maxReasons.add(reason); }
    else if (value === maxDelta) maxReasons.add(reason);
  };
  for (const { item, end, length, rate } of leftBounds) {
    const minimumDuration = Math.max(6, Math.round(state.fps * 0.5));
    setMin(item.durationInFrames < minimumDuration ? 0 : -(item.durationInFrames - minimumDuration),
      item.durationInFrames < minimumDuration ? '短片段只能向延长方向滚动。' : '左侧片段需至少保留半秒。');
    setMax(Math.floor((length - end) / rate + 1e-7), '左侧素材没有更多源画面。');
  }
  for (const { item, start, rate } of rightBounds) {
    const minimumDuration = Math.max(6, Math.round(state.fps * 0.5));
    setMin(Math.ceil(-start / rate - 1e-7), '右侧素材已到源入点。');
    setMin(-item.startFrame, '已到时间线起点。');
    setMax(item.durationInFrames < minimumDuration ? 0 : item.durationInFrames - minimumDuration,
      item.durationInFrames < minimumDuration ? '短片段只能向延长方向滚动。' : '右侧片段需至少保留半秒。');
  }
  if (minDelta > maxDelta) return fail(state, '左右片段没有共同可滚动范围。');
  if (minDelta === 0 && maxDelta === 0) {
    return { state, deltaF: 0, limitMessage: [...minReasons, ...maxReasons].join(' ') };
  }
  const requested = Math.round(requestedDeltaF);
  const clampedDelta = Math.min(maxDelta, Math.max(minDelta, requested));
  const deltaF = clampedDelta === 0 ? 0 : clampedDelta;
  const limitMessage = requested > deltaF ? [...maxReasons].join(' ')
    : requested < deltaF ? [...minReasons].join(' ') : undefined;
  if (deltaF === 0) {
    if (state.transitions?.length && reconcileTransitions(state.items, state.transitions) !== state.transitions) {
      return fail(state, '现有转场与片段位置不匹配，先修复转场再滚动裁剪。');
    }
    return { state, deltaF, limitMessage };
  }

  let planned = state;
  const leftTarget = state.items.find((item) => item.id === leftId)!;
  const leftRetime = retimeItemWithGroups(planned, leftId, {
    startFrame: leftTarget.startFrame,
    durationInFrames: leftTarget.durationInFrames + deltaF,
    srcInFrame: leftTarget.srcInFrame,
  });
  if (!leftRetime) return fail(state, '左侧联动片段无法保持源时间，操作未执行。');
  planned = leftRetime;
  const rightTarget = planned.items.find((item) => item.id === rightId)!;
  const rightRetime = retimeItemWithGroups(planned, rightId, {
    startFrame: rightTarget.startFrame + deltaF,
    durationInFrames: rightTarget.durationInFrames - deltaF,
    srcInFrame: (rightTarget.srcInFrame ?? 0) + timelineFramesToSourceFrames(rightTarget, deltaF),
  });
  if (!rightRetime) return fail(state, '右侧联动片段无法保持源时间，操作未执行。');
  const affectedIds = new Set([...leftIds, ...rightIds]);
  planned = { ...rightRetime, items: rightRetime.items.map((item) =>
    affectedIds.has(item.id) ? fitItemToDuration(item) : item) };
  const transitions = state.transitions;
  if (transitions?.length && reconcileTransitions(planned.items, transitions) !== transitions) {
    return fail(state, '滚动裁剪会删除或改变现有转场，请先调整或移除转场。');
  }
  if (introducesTrackOverlap(state, planned)) return fail(state, '滚动裁剪会与同轨素材重叠，操作未执行。');
  return { state: planned, deltaF, limitMessage };
}
