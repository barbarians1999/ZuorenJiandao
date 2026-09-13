import { sampleKeyframes } from '../../editor/keyframes';
import type { TimelineItem } from '../../editor/types';
import { effectivePreviewTransform } from './previewTransform';

export interface MotionPathPoint { frame: number; x: number; y: number }
export interface MotionPathDelta { x: number; y: number }

export function motionPathKeyframeFrames(item: Pick<TimelineItem, 'keyframes'>): number[] {
  const frames = new Set<number>();
  for (const prop of ['x', 'y'] as const) {
    for (const keyframe of item.keyframes?.[prop] ?? []) {
      if (Number.isFinite(keyframe.frame)) frames.add(Math.round(keyframe.frame));
    }
  }
  return [...frames].sort((a, b) => a - b);
}

export function motionPathDelta(
  deltaClient: { x: number; y: number },
  canvasRect: Pick<DOMRect, 'width' | 'height'>,
): MotionPathDelta {
  return {
    x: canvasRect.width > 0 ? deltaClient.x / canvasRect.width * 100 : 0,
    y: canvasRect.height > 0 ? deltaClient.y / canvasRect.height * 100 : 0,
  };
}

export function sampleMotionPath(item: TimelineItem, maxSamples = 1024): MotionPathPoint[] {
  const frames = motionPathKeyframeFrames(item);
  if (!frames.length) return [];
  const limit = Math.max(frames.length, Math.floor(maxSamples));
  const sample = (frame: number): MotionPathPoint => ({
    frame,
    x: item.keyframes?.x?.length ? sampleKeyframes(item.keyframes.x, frame) : item.transform?.x ?? 0,
    y: item.keyframes?.y?.length ? sampleKeyframes(item.keyframes.y, frame) : item.transform?.y ?? 0,
  });
  if (frames.length === 1) return [sample(frames[0]!)];
  const outFrames = new Set<number>(frames);
  const span = frames[frames.length - 1]! - frames[0]!;
  const count = Math.max(2, limit);
  for (let index = 0; index < count && outFrames.size < limit; index++) {
    outFrames.add(Math.round(frames[0]! + span * index / (count - 1)));
  }
  return [...outFrames].sort((a, b) => a - b).map(sample);
}

export function motionPathPosition(item: TimelineItem, localFrame: number): MotionPathDelta {
  const transform = effectivePreviewTransform(item, item.startFrame + localFrame);
  return { x: transform.x, y: transform.y };
}
