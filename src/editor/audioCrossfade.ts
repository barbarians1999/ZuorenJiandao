import type { MediaAsset, TimelineItem, TransitionItem } from './types';
import { isAudioTransition } from './types';
import {
  buildAssetIndex,
  evaluateCrossfadeGainAt,
  planAudioCrossfadeFromIndex,
  resolveAudioCrossfadePlans,
  type ItemCrossfadePlan,
} from '../../shared/timeline-media-schedule.mjs';

export interface AudioCrossfadePlan {
  beforeFrames: number;
  afterFrames: number;
  requestedBeforeFrames: number;
  requestedAfterFrames: number;
  hasFullHandles: boolean;
}

export function planAudioCrossfade(
  outgoing: TimelineItem,
  incoming: TimelineItem,
  transition: TransitionItem,
  assets: readonly MediaAsset[] = [],
): AudioCrossfadePlan {
  return planAudioCrossfadeFromIndex(outgoing, incoming, transition, buildAssetIndex(assets));
}

export interface AudioCrossfadeAutomation {
  extensions: { beforeFrames: number; afterFrames: number };
  gainAt: (absoluteFrame: number) => number;
}

const EMPTY_PLAN: ItemCrossfadePlan = { beforeFrames: 0, afterFrames: 0, curves: [] };

/**
 * O(N + T) timeline-level precomputation of crossfade plans indexed by item id.
 */
export function buildAudioCrossfadePlanMap(
  timelineItems: readonly TimelineItem[],
  transitions: readonly TransitionItem[] = [],
  assets: readonly MediaAsset[] = [],
): Map<string, AudioCrossfadeAutomation> {
  const audioTransitions = transitions.filter((t) => t.enabled !== false && isAudioTransition(t.type));
  const rawPlans = resolveAudioCrossfadePlans(timelineItems, audioTransitions, assets);
  const out = new Map<string, AudioCrossfadeAutomation>();
  for (const [id, rec] of rawPlans) {
    out.set(id, {
      extensions: { beforeFrames: rec.beforeFrames, afterFrames: rec.afterFrames },
      gainAt: (absoluteFrame) => evaluateCrossfadeGainAt(rec.curves, absoluteFrame),
    });
  }
  return out;
}

/** Precomputes the per-clip transition envelopes shared by preview and render. */
export function audioCrossfadeAutomation(
  item: TimelineItem,
  timelineItems: readonly TimelineItem[],
  transitions: readonly TransitionItem[] = [],
  assets: readonly MediaAsset[] = [],
): AudioCrossfadeAutomation {
  const relevant = transitions.filter((t) => t.enabled !== false && isAudioTransition(t.type)
    && (t.outgoingItemId === item.id || t.incomingItemId === item.id));
  if (!relevant.length) {
    return { extensions: { beforeFrames: EMPTY_PLAN.beforeFrames, afterFrames: EMPTY_PLAN.afterFrames }, gainAt: () => 1 };
  }
  const byId = new Map(timelineItems.map((c) => [c.id, c]));
  const subset: TimelineItem[] = [item];
  for (const t of relevant) {
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    if (out && out.id !== item.id) subset.push(out);
    if (inc && inc.id !== item.id) subset.push(inc);
  }
  const plan = resolveAudioCrossfadePlans(subset, relevant, assets).get(item.id) ?? EMPTY_PLAN;
  return {
    extensions: { beforeFrames: plan.beforeFrames, afterFrames: plan.afterFrames },
    gainAt: (absoluteFrame) => evaluateCrossfadeGainAt(plan.curves, absoluteFrame),
  };
}
