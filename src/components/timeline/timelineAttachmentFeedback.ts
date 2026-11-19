import { followsMain, mainTrackId } from '../../editor/magneticTimeline';
import { selectedIdsOf, type TimelineItem, type TimelineState } from '../../editor/types';

export interface TimelineAttachmentFeedback {
  owner: TimelineItem;
  active: boolean;
  highlighted: boolean;
  locked: boolean;
}

/** Read-only display of explicit directional links; overlapping in time never
 * creates a link, and a disabled media kind must not look like it will follow. */
export function timelineAttachmentFeedback(state: TimelineState): Map<string, TimelineAttachmentFeedback> {
  const main = mainTrackId(state);
  const selected = new Set(selectedIdsOf(state));
  const owners = new Map(state.items.filter((item) => item.track === main).map((item) => [item.id, item]));
  const feedback = new Map<string, TimelineAttachmentFeedback>();
  for (const item of state.items) {
    const owner = item.mainClipId ? owners.get(item.mainClipId) : undefined;
    if (!owner || item.track === main) continue;
    const active = followsMain(state, item);
    feedback.set(item.id, { owner, active, highlighted: active && selected.has(owner.id),
      locked: !!state.tracks?.[item.track]?.locked || !!state.tracks?.[owner.track]?.locked });
  }
  return feedback;
}
