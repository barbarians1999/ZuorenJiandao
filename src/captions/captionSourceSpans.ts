import type { TimelineItem } from '../editor/types';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
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

/** Project saved source-media spans through the same media window/audio edit map as the clip. */
export function projectCaptionSourceSpans(
  item: TimelineItem,
  spans: readonly CaptionSourceSpan[],
  fps: number,
): ProjectedCaptionSourceSpan[] {
  const result: ProjectedCaptionSourceSpan[] = [];
  for (const [spanIndex, span] of spans.entries()) {
    if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.endMs <= span.startMs) continue;
    const sourceStart = msToFrame(span.startMs, fps);
    const sourceEnd = msToFrame(span.endMs, fps);
    const offset = (span.timingOffsetMs ?? 0) * fps / 1000;
    if (item.kind === 'audio') {
      const segments = keptSegments(item.transcript ?? [], new Set(item.deletedWordIdx ?? []), fps,
        item.startFrame, { ...itemEditOpts(item), window: itemWindow(item) });
      segments.forEach((segment, segmentIndex) => {
        const start = Math.max(sourceStart, segment.srcStartFrame);
        const end = Math.min(sourceEnd, segment.srcEndFrame);
        if (end <= start) return;
        result.push({ spanIndex, segmentKey: `audio:${segmentIndex}:${offset}`,
          sourceStartFrame: start, sourceEndFrame: end,
          startFrame: segment.fromFrame + start - segment.srcStartFrame + offset,
          endFrame: segment.fromFrame + end - segment.srcStartFrame + offset });
      });
    } else {
      const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
      const start = Math.max(sourceStart, window.startFrame);
      const end = Math.min(sourceEnd, window.endFrame);
      if (end <= start) continue;
      result.push({ spanIndex, segmentKey: `media:${offset}`, sourceStartFrame: start, sourceEndFrame: end,
        startFrame: item.startFrame + sourceFramesToTimelineFrames(item, start - window.startFrame) + offset,
        endFrame: item.startFrame + sourceFramesToTimelineFrames(item, end - window.startFrame) + offset });
    }
  }
  return result.sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
}
