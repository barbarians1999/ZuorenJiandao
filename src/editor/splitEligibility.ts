import type { TimelineItem, TimelineState } from './types';

export function canSplitTimelineItemAtFrame(
  item: Pick<TimelineItem, 'startFrame' | 'durationInFrames'> | null | undefined,
  frame: number,
  locked = false,
): boolean {
  if (!item || locked || !Number.isFinite(frame)) return false;
  const atFrame = Math.round(frame);
  return atFrame > item.startFrame
    && atFrame < item.startFrame + item.durationInFrames;
}

export function canSplitSelectedTimelineItem(state: TimelineState, frame: number): boolean {
  const item = state.items.find((candidate) => candidate.id === state.selectedId);
  return canSplitTimelineItemAtFrame(item, frame, item ? !!state.tracks?.[item.track]?.locked : false);
}
