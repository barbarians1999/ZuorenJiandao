import type { TimelineItem, TimelineState, TrackKind } from './types';
import { timelineFramesToSourceFrames } from './sourceLimit';
import { trackKind } from './timelineTypes';
import { hasOperationalTranscript } from '../transcript/types';

export const MIN_SPEED_RATE = 0.1;
export const MAX_SPEED_RATE = 8;

export type SpeedClampReason = 'min-rate' | 'max-rate' | null;

export interface SpeedDurationBounds {
  minFrames: number;
  maxFrames: number;
  minSeconds: number;
  maxSeconds: number;
  currentSeconds: number;
}

export interface SpeedTargetPlan {
  requestedFrames: number;
  resultingFrames: number;
  rate: number;
  clamped: SpeedClampReason;
}

export type FillToNextFailureReason =
  | 'missing'
  | 'locked'
  | 'unsupported'
  | 'no-next-clip'
  | 'already-adjacent'
  | 'min-rate-reached';

export type FillToNextPlan =
  | {
      ok: true;
      item: TimelineItem;
      nextClip: TimelineItem;
      trackKind: TrackKind;
      gapFrames: number;
      targetFrames: number;
      resultingFrames: number;
      rate: number;
      clamped: SpeedClampReason;
      remainingGapFrames: number;
    }
  | {
      ok: false;
      reason: FillToNextFailureReason;
      trackKind?: TrackKind;
      nextClip?: TimelineItem;
    };

export interface BatchFillToNextPlan {
  plans: FillToNextPlan[];
  eligible: Extract<FillToNextPlan, { ok: true }>[];
  total: number;
  primaryTrackKind: TrackKind;
}

/** True when a timeline item can be retimed via `setSpeed`. */
export function canAdjustItemSpeed(item: TimelineItem): boolean {
  if (item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'sequence') return false;
  if (item.kind === 'audio' && hasOperationalTranscript(item)) return false;
  return true;
}

export function formatSpeedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0.00';
  return seconds.toFixed(2);
}

export function fillToNextFailureMessage(
  reason: FillToNextFailureReason | undefined,
  trackKind: TrackKind | undefined,
): string {
  const isVideo = trackKind !== 'audio';
  switch (reason) {
    case 'no-next-clip':
      return isVideo ? '当前轨道后方没有视频单元' : '当前轨道后方没有片段';
    case 'already-adjacent':
      return isVideo ? '已紧贴后一视频单元，无需填充' : '已紧贴后一片段，无需填充';
    case 'min-rate-reached':
      return '已达最慢 0.10× 上限，无法继续拉长';
    case 'locked':
      return '当前轨道已锁定';
    case 'unsupported':
    default:
      return '当前片段不支持变速';
  }
}

export function speedDurationBounds(item: TimelineItem, fps: number): SpeedDurationBounds | null {
  if (!canAdjustItemSpeed(item) || !Number.isFinite(fps) || fps <= 0) return null;
  const sourceSpanFrames = timelineFramesToSourceFrames(item, item.durationInFrames);
  if (!(sourceSpanFrames > 0)) return null;
  const minFrames = Math.max(1, Math.round(sourceSpanFrames / MAX_SPEED_RATE));
  const maxFrames = Math.max(minFrames, Math.round(sourceSpanFrames / MIN_SPEED_RATE));
  return {
    minFrames,
    maxFrames,
    minSeconds: minFrames / fps,
    maxSeconds: maxFrames / fps,
    currentSeconds: item.durationInFrames / fps,
  };
}

export function planSpeedForTargetFrames(item: TimelineItem, targetFrames: number): SpeedTargetPlan | null {
  if (!canAdjustItemSpeed(item) || !Number.isFinite(targetFrames) || targetFrames <= 0) return null;
  const requestedFrames = Math.max(1, Math.round(targetFrames));
  const sourceSpan = timelineFramesToSourceFrames(item, item.durationInFrames);
  if (!(sourceSpan > 0)) return null;
  const rawRate = sourceSpan / requestedFrames;
  let rate = rawRate;
  let clamped: SpeedClampReason = null;
  if (rawRate < MIN_SPEED_RATE) {
    rate = MIN_SPEED_RATE;
    clamped = 'min-rate';
  } else if (rawRate > MAX_SPEED_RATE) {
    rate = MAX_SPEED_RATE;
    clamped = 'max-rate';
  }
  const resultingFrames = Math.max(1, Math.round(sourceSpan / rate));
  return { requestedFrames, resultingFrames, rate, clamped };
}

export function planSpeedForTargetSeconds(
  item: TimelineItem,
  targetSeconds: number,
  fps: number,
): SpeedTargetPlan | null {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) return null;
  return planSpeedForTargetFrames(item, Math.max(1, Math.round(targetSeconds * fps)));
}

export function planFillToNextTrackClip(state: TimelineState, itemId: string): FillToNextPlan {
  const item = state.items.find((it) => it.id === itemId);
  if (!item) return { ok: false, reason: 'missing' };
  const kind = trackKind(state, item.track);
  if (state.tracks?.[item.track]?.locked) return { ok: false, reason: 'locked', trackKind: kind };
  if (!canAdjustItemSpeed(item)) return { ok: false, reason: 'unsupported', trackKind: kind };

  const itemEnd = item.startFrame + item.durationInFrames;
  const nextClip = state.items
    .filter((other) => other.id !== item.id && other.track === item.track && other.startFrame >= itemEnd)
    .toSorted((a, b) => a.startFrame - b.startFrame)[0];
  if (!nextClip) return { ok: false, reason: 'no-next-clip', trackKind: kind };

  const gapFrames = nextClip.startFrame - itemEnd;
  if (gapFrames <= 0) return { ok: false, reason: 'already-adjacent', trackKind: kind, nextClip };

  const targetFrames = nextClip.startFrame - item.startFrame;
  const speedPlan = planSpeedForTargetFrames(item, targetFrames);
  if (!speedPlan) return { ok: false, reason: 'unsupported', trackKind: kind };
  if (speedPlan.resultingFrames <= item.durationInFrames) {
    return { ok: false, reason: 'min-rate-reached', trackKind: kind, nextClip };
  }

  return {
    ok: true,
    item,
    nextClip,
    trackKind: kind,
    gapFrames,
    targetFrames,
    resultingFrames: speedPlan.resultingFrames,
    rate: speedPlan.rate,
    clamped: speedPlan.clamped,
    remainingGapFrames: Math.max(0, targetFrames - speedPlan.resultingFrames),
  };
}

export function planBatchFillToNextTrackClip(
  state: TimelineState,
  itemIds: readonly string[],
): BatchFillToNextPlan {
  const plans = itemIds.map((id) => planFillToNextTrackClip(state, id));
  const eligible = plans.filter((plan): plan is Extract<FillToNextPlan, { ok: true }> => plan.ok);
  const primaryTrackKind = plans.find((plan) => plan.trackKind !== undefined)?.trackKind ?? 'video';
  return { plans, eligible, total: itemIds.length, primaryTrackKind };
}
