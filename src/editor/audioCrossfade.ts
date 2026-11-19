import { hasOperationalTranscript } from '../transcript/types';
import type { MediaAsset, TimelineItem, TransitionItem } from './types';
import { sourceFrameAt } from './sourceLimit';
import { isAudioTransition } from './types';

export interface AudioCrossfadePlan {
  beforeFrames: number;
  afterFrames: number;
  requestedBeforeFrames: number;
  requestedAfterFrames: number;
  hasFullHandles: boolean;
}

function sourceAsset(item: TimelineItem, assets: readonly MediaAsset[]): MediaAsset | undefined {
  return item.sourceAssetId
    ? assets.find((asset) => asset.id === item.sourceAssetId)
    : assets.find((asset) => asset.src === item.src);
}

function availableBefore(item: TimelineItem): number {
  if (hasOperationalTranscript(item)) return 0;
  const rawRate = item.playbackRate ?? 1;
  const rate = Number.isFinite(rawRate) ? Math.max(0.01, rawRate) : 1;
  const rawStart = item.srcInFrame ?? 0;
  const sourceStart = Number.isFinite(rawStart) ? Math.max(0, rawStart) : 0;
  return Math.max(0, Math.floor(sourceStart / rate));
}

function availableAfter(item: TimelineItem, assets: readonly MediaAsset[]): number | null {
  if (hasOperationalTranscript(item)) return 0;
  const asset = sourceAsset(item, assets);
  if (!asset || !Number.isFinite(asset.durationInFrames)) return null;
  const rawRate = item.playbackRate ?? 1;
  const rate = Number.isFinite(rawRate) ? Math.max(0.01, rawRate) : 1;
  const sourceEnd = sourceFrameAt(item, item.durationInFrames);
  if (!Number.isFinite(sourceEnd)) return 0;
  return Math.max(0, Math.floor((asset.durationInFrames - sourceEnd) / rate));
}

export function planAudioCrossfade(
  outgoing: TimelineItem,
  incoming: TimelineItem,
  transition: TransitionItem,
  assets: readonly MediaAsset[] = [],
): AudioCrossfadePlan {
  const duration = Number.isFinite(transition.durationInFrames)
    ? Math.max(1, Math.round(transition.durationInFrames))
    : 1;
  const requestedBeforeFrames = Math.floor(duration / 2);
  const requestedAfterFrames = duration - requestedBeforeFrames;
  const beforeFrames = Math.min(requestedBeforeFrames, availableBefore(incoming));
  const tail = availableAfter(outgoing, assets);
  const afterFrames = tail === null ? requestedAfterFrames : Math.min(requestedAfterFrames, tail);
  return {
    beforeFrames,
    afterFrames,
    requestedBeforeFrames,
    requestedAfterFrames,
    hasFullHandles: beforeFrames === requestedBeforeFrames && afterFrames === requestedAfterFrames,
  };
}

export interface AudioCrossfadeAutomation {
  extensions: { beforeFrames: number; afterFrames: number };
  gainAt: (absoluteFrame: number) => number;
}

/** Precomputes the per-clip transition envelopes shared by preview and render. */
export function audioCrossfadeAutomation(
  item: TimelineItem,
  timelineItems: readonly TimelineItem[],
  transitions: readonly TransitionItem[] = [],
  assets: readonly MediaAsset[] = [],
): AudioCrossfadeAutomation {
  let beforeFrames = 0;
  let afterFrames = 0;
  const curves: Array<{ direction: 'in' | 'out'; startFrame: number; duration: number }> = [];
  for (const transition of transitions) {
    if (transition.enabled === false || !isAudioTransition(transition.type)) continue;
    if (transition.outgoingItemId !== item.id && transition.incomingItemId !== item.id) continue;
    const outgoing = timelineItems.find((candidate) => candidate.id === transition.outgoingItemId);
    const incoming = timelineItems.find((candidate) => candidate.id === transition.incomingItemId);
    if (!outgoing || !incoming) continue;
    const plan = planAudioCrossfade(outgoing, incoming, transition, assets);
    const seam = incoming.startFrame;
    const overlapFrames = plan.beforeFrames + plan.afterFrames;
    if (item.id === incoming.id) {
      if (plan.hasFullHandles) {
        beforeFrames = Math.max(beforeFrames, plan.beforeFrames);
        curves.push({ direction: 'in', startFrame: seam - plan.beforeFrames, duration: overlapFrames });
      } else if (plan.requestedAfterFrames > 0) {
        curves.push({ direction: 'in', startFrame: seam, duration: plan.requestedAfterFrames });
      }
    }
    if (item.id === outgoing.id) {
      if (plan.hasFullHandles) {
        afterFrames = Math.max(afterFrames, plan.afterFrames);
        curves.push({ direction: 'out', startFrame: seam - plan.beforeFrames, duration: overlapFrames });
      } else if (plan.requestedBeforeFrames > 0) {
        curves.push({ direction: 'out', startFrame: seam - plan.requestedBeforeFrames, duration: plan.requestedBeforeFrames });
      }
    }
  }
  return {
    extensions: { beforeFrames, afterFrames },
    gainAt: (absoluteFrame) => curves.reduce((gain, curve) => {
      const p = clamp01((absoluteFrame - curve.startFrame) / curve.duration);
      return gain * (curve.direction === 'out' ? Math.cos(p * Math.PI / 2) : Math.sin(p * Math.PI / 2));
    }, 1),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
