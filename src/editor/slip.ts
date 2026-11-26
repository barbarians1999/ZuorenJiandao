import {
  sourceFramesToTimelineFrames,
  sourceWindowForTimelineRange,
  timelineFramesToSourceFrames,
  type SourceFrameWindow,
} from './sourceLimit';
import type { TimelineState } from './types';

export type SlipFailureCode =
  | 'unknown-item'
  | 'unsupported-kind'
  | 'locked-track'
  | 'source-unavailable'
  | 'invalid-delta'
  | 'no-source-handles';

export interface SlipFailure {
  ok: false;
  code: SlipFailureCode;
  itemId: string;
  error: string;
}

export interface SlipPlan {
  ok: true;
  itemId: string;
  requestedDeltaInFrames: number;
  appliedDeltaInFrames: number;
  srcInFrame: number;
  sourceDomain: 'media';
  sourceWindow: SourceFrameWindow;
  minDeltaInFrames: number;
  maxDeltaInFrames: number;
  clamped: boolean;
}

export type SlipResult = SlipFailure | SlipPlan;

export interface SlipPreview {
  itemId: string;
  itemName: string;
  kind: 'video' | 'audio';
  src: string;
  fps: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  plan: SlipPlan;
}

const EPSILON = 1e-6;

function failure(itemId: string, code: SlipFailureCode, error: string): SlipFailure {
  return { ok: false, code, itemId, error };
}

/**
 * Plan a slip without mutating the timeline. The returned delta is expressed in
 * timeline frames. For continuous media, srcIn/sourceWindow are source-media
 * frames and playbackRate converts between domains. For word-driven audio they
 * are edited-stream frames and move 1:1 with timeline frames. Preview, reducer,
 * inspector, and agent commits all consume this one planner.
 */
export function planSlip(
  state: TimelineState,
  itemId: string,
  requestedDeltaInFrames: number,
): SlipResult {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) return failure(itemId, 'unknown-item', `item not found: ${itemId}`);
  if (item.kind !== 'video' && item.kind !== 'audio') {
    return failure(itemId, 'unsupported-kind', `slip is not supported on a ${item.kind} clip`);
  }
  if (state.tracks?.[item.track]?.locked) {
    return failure(itemId, 'locked-track', `track ${item.track} is locked`);
  }
  if (!item.src) {
    return failure(itemId, 'source-unavailable', 'clip has no source media');
  }
  const asset = state.assets?.find((candidate) => candidate.src === item.src);
  if (!asset || !(asset.durationInFrames > 0)) {
    return failure(itemId, 'source-unavailable', 'source duration is unavailable');
  }
  const totalSourceFrames = asset.durationInFrames;
  const zeroBasedWindow = sourceWindowForTimelineRange(
    { ...item, srcInFrame: 0 },
    0,
    item.durationInFrames,
  );
  const sourceSpan = zeroBasedWindow.endFrame - zeroBasedWindow.startFrame;

  const maxSrcInFrame = Math.max(0, totalSourceFrames - sourceSpan);
  const currentSrcInFrame = Math.max(0, item.srcInFrame ?? 0);
  if (maxSrcInFrame <= EPSILON || currentSrcInFrame > maxSrcInFrame + EPSILON) {
    return failure(itemId, 'no-source-handles', 'clip has no valid source handles available to slip');
  }

  if (!Number.isFinite(requestedDeltaInFrames)) {
    return failure(itemId, 'invalid-delta', 'slip needs a finite deltaInFrames');
  }
  const requested = requestedDeltaInFrames;
  const requestedSourceDelta = timelineFramesToSourceFrames(item, requested);
  const srcInFrame = Math.max(0, Math.min(maxSrcInFrame, currentSrcInFrame + requestedSourceDelta));
  const appliedSourceDelta = srcInFrame - currentSrcInFrame;
  const appliedDeltaInFrames = sourceFramesToTimelineFrames(item, appliedSourceDelta);
  const sourceWindow = sourceWindowForTimelineRange(
    { ...item, srcInFrame },
    0,
    item.durationInFrames,
  );
  const minDeltaInFrames = sourceFramesToTimelineFrames(item, -currentSrcInFrame);
  const maxSourceDelta = maxSrcInFrame - currentSrcInFrame;
  const maxDeltaInFrames = sourceFramesToTimelineFrames(item, maxSourceDelta);

  return {
    ok: true,
    itemId: item.id,
    requestedDeltaInFrames: requested,
    appliedDeltaInFrames,
    srcInFrame,
    sourceDomain: 'media',
    sourceWindow,
    minDeltaInFrames,
    maxDeltaInFrames,
    clamped: Math.abs(appliedDeltaInFrames - requested) > EPSILON,
  };
}

export function slipPreview(
  state: TimelineState,
  itemId: string,
  requestedDeltaInFrames: number,
): SlipPreview | null {
  const plan = planSlip(state, itemId, requestedDeltaInFrames);
  if (!plan.ok) return null;
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item?.src || (item.kind !== 'video' && item.kind !== 'audio')) return null;
  const visibleWindow = sourceWindowForTimelineRange(
    { ...item, srcInFrame: plan.srcInFrame },
    0,
    Math.max(0, item.durationInFrames - 1),
  );
  return {
    itemId: item.id,
    itemName: item.name,
    kind: item.kind,
    src: item.src,
    fps: state.fps,
    sourceInFrame: plan.sourceWindow.startFrame,
    sourceOutFrame: visibleWindow.endFrame,
    plan,
  };
}
