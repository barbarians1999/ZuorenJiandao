import type { TimelineItem } from '../editor/types';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { msToFrame } from '../transcript/types';
import type { CaptionSourceSpan } from './types';

export interface ProjectedCaptionSourceSpan {
  spanIndex: number;
  segmentKey: string;
  sourceStartFrame: number;
  sourceEndFrame: number;
  startFrame: number;
  endFrame: number;
}

/** Project saved source-media spans through the clip's real media window. */
export function projectCaptionSourceSpans(
  item: TimelineItem,
  spans: readonly CaptionSourceSpan[],
  fps: number,
): ProjectedCaptionSourceSpan[] {
  if (!spans.length) return [];
  const mediaWindow = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const result: ProjectedCaptionSourceSpan[] = [];
  for (const [spanIndex, span] of spans.entries()) {
    if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.endMs <= span.startMs) continue;
    const sourceStart = msToFrame(span.startMs, fps);
    const sourceEnd = msToFrame(span.endMs, fps);
    const offset = (span.timingOffsetMs ?? 0) * fps / 1000;
    const start = Math.max(sourceStart, mediaWindow.startFrame);
    const end = Math.min(sourceEnd, mediaWindow.endFrame);
    if (end <= start) continue;
    result.push({
      spanIndex,
      segmentKey: `media:${offset}`,
      sourceStartFrame: start,
      sourceEndFrame: end,
      startFrame: item.startFrame + sourceFramesToTimelineFrames(item, start - mediaWindow.startFrame) + offset,
      endFrame: item.startFrame + sourceFramesToTimelineFrames(item, end - mediaWindow.startFrame) + offset,
    });
  }
  return result.sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
}

/** Return the playable source [minSourceMs, maxSourceMs] bounds for one projected segment key. */
export function captionSourceSegmentBounds(
  item: TimelineItem,
  _segmentKey: string,
  fps: number,
): { minSourceMs: number; maxSourceMs: number } | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const mediaWindow = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  return {
    minSourceMs: mediaWindow.startFrame * 1000 / fps,
    maxSourceMs: mediaWindow.endFrame * 1000 / fps,
  };
}
