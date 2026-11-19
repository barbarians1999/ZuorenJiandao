import type { ClipEffectMosaicTrack, TimelineItem, TimelineState } from '../editor/types';
import { mosaicSourceIdentity, normalizeMosaicTrack } from '../editor/mosaic';
import { sourceFrameAt } from '../editor/sourceLimit';
import type { TrackingRegion, TrackingResult } from './types';

export function trackingRunIsCurrent(currentGeneration: number, runGeneration: number, currentKey: string, runKey: string): boolean {
  return currentGeneration === runGeneration && currentKey === runKey;
}

export function mosaicTrackingInputKey(
  state: TimelineState,
  item: TimelineItem,
  region: TrackingRegion,
  minConfidence: number,
): string {
  return JSON.stringify([
    state.selectedId, state.fps, item.id, mosaicSourceIdentity(item), item.srcInFrame ?? 0,
    item.playbackRate ?? 1, item.durationInFrames,
    (item.effects ?? []).filter((effect) => effect.assetId === 'builtin:fx-local-gaussian-blur'),
    region, minConfidence,
  ]);
}

export function buildMosaicTrack(item: TimelineItem, result: TrackingResult): ClipEffectMosaicTrack | null {
  const sourceIdentity = mosaicSourceIdentity(item);
  if (item.kind !== 'video' || !sourceIdentity || !Number.isFinite(result.videoWidth) || result.videoWidth <= 0
    || !Number.isFinite(result.videoHeight) || result.videoHeight <= 0 || result.points.length < 2
    || !Number.isFinite(item.playbackRate ?? 1) || (item.playbackRate ?? 1) <= 0) return null;
  return normalizeMosaicTrack({
    sourceIdentity, sourceWidth: result.videoWidth, sourceHeight: result.videoHeight,
    points: result.points.map((point) => ({ sourceFrame: sourceFrameAt(item, point.frame), x: point.x, y: point.y })),
  });
}
