import { placeTrack } from '../../editor/reducerTimelineHelpers';
import { timelineTrackIds, trackKind, type TimelineState } from '../../editor/types';
import { moveTimelineSelectionByDelta } from '../../captions/captionGroupMove';
import { mainTrackId, planMagneticMove } from '../../editor/magneticTimeline';

/** A same-lane selection dragged into blank space creates a real lane atomically. */
export type NewTrackPlacement = 'top' | 'bottom';

export function moveSelectionToNewTrack(state: TimelineState, ids: readonly string[], delta: number, trackId: string, placement: NewTrackPlacement = 'top'): TimelineState {
  const clips = state.items.filter((item) => ids.includes(item.id));
  if (!clips.length || new Set(clips.map((item) => item.track)).size !== 1 || clips.some((item) => state.tracks?.[item.track]?.locked)) return state;
  const base = clips[0].track;
  const kind = trackKind(state, base);
  if (kind === 'caption') return state;
  const allText = kind === 'video' && clips.every((item) => item.kind === 'text');
  const existingMain = mainTrackId(state);
  const videoCount = timelineTrackIds(state).filter((id) => trackKind(state, id) === 'video').length;
  const targetOrder = kind === 'video' ? (placement === 'bottom' ? 0 : videoCount) : (placement === 'top' ? 0 : undefined);
  const order = placeTrack(state, trackId, kind, targetOrder);
  const interaction = existingMain && !state.interaction?.mainTrackId ? { ...state.interaction, mainTrackId: existingMain } : state.interaction;
  const prepared = { ...state, ...(interaction ? { interaction } : {}), tracks: { ...state.tracks, [trackId]: { kind, ...(allText ? { visualRole: 'text' as const } : {}) } }, trackOrder: order };
  if (state.interaction?.magnet && base === mainTrackId(state)) {
    const plan = planMagneticMove(prepared, ids, clips[0].id, clips[0].startFrame + delta, trackId);
    return plan.error ? state : plan.state;
  }
  const next = moveTimelineSelectionByDelta(prepared, [...ids], [], delta, { from: base, to: trackId });
  return next.items.some((item) => item.track === trackId) ? next : state;
}
