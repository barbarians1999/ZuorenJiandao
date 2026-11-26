import { mainTrackId } from '../../editor/magneticTimeline';
import { isEffectTrack, isTextTrack, timelineTrackIds, trackAlias, trackKind, type TimelineState, type TrackId } from '../../editor/types';

export type TrackDropSide = 'before' | 'after';
export const TRACK_REORDER_DRAG_TYPE = 'application/x-openchatcut-track-order';

/** Convert a visual header drop into the existing track.update order value. */
export function trackOrderForHeaderDrop(
  state: TimelineState,
  source: TrackId,
  target: TrackId,
  side: TrackDropSide,
): number | null {
  if (source === target) return null;
  const kind = trackKind(state, source);
  if (trackKind(state, target) !== kind) return null;
  const original = timelineTrackIds(state).filter((id) => trackKind(state, id) === kind);
  const reordered = original.filter((id) => id !== source);
  const targetIndex = reordered.indexOf(target);
  if (targetIndex < 0 || !original.includes(source)) return null;
  reordered.splice(targetIndex + (side === 'after' ? 1 : 0), 0, source);
  if (reordered.every((id, index) => id === original[index])) return null;

  const visualIndex = reordered.indexOf(source);
  return kind === 'video' ? reordered.length - 1 - visualIndex : visualIndex;
}

export interface TrackRowBounds {
  id: TrackId;
  top: number;
  bottom: number;
}

export interface ResolvedTrackHeaderDrop {
  targetId: TrackId;
  side: TrackDropSide;
  order: number;
}

export interface TrackStepReorderPlan {
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveUpOrder: number | null;
  moveDownOrder: number | null;
  moveTopOrder: number | null;
  moveBottomOrder: number | null;
  sameKindCount: number;
  visualIndex: number;
}

/** Plan single-step and edge vertical track moves within the track's own kind group. */
export function planTrackStepReorder(
  state: TimelineState,
  trackId: TrackId,
): TrackStepReorderPlan {
  const kind = trackKind(state, trackId);
  const sameKind = timelineTrackIds(state).filter((id) => trackKind(state, id) === kind);
  const visualIndex = sameKind.indexOf(trackId);
  if (visualIndex < 0 || sameKind.length < 2) {
    return {
      canMoveUp: false,
      canMoveDown: false,
      moveUpOrder: null,
      moveDownOrder: null,
      moveTopOrder: null,
      moveBottomOrder: null,
      sameKindCount: sameKind.length,
      visualIndex,
    };
  }
  const moveUpOrder = visualIndex > 0 ? trackOrderForHeaderDrop(state, trackId, sameKind[visualIndex - 1]!, 'before') : null;
  const moveDownOrder = visualIndex < sameKind.length - 1 ? trackOrderForHeaderDrop(state, trackId, sameKind[visualIndex + 1]!, 'after') : null;
  const moveTopOrder = visualIndex > 0 ? trackOrderForHeaderDrop(state, trackId, sameKind[0]!, 'before') : null;
  const moveBottomOrder = visualIndex < sameKind.length - 1 ? trackOrderForHeaderDrop(state, trackId, sameKind[sameKind.length - 1]!, 'after') : null;
  return {
    canMoveUp: moveUpOrder !== null,
    canMoveDown: moveDownOrder !== null,
    moveUpOrder,
    moveDownOrder,
    moveTopOrder,
    moveBottomOrder,
    sameKindCount: sameKind.length,
    visualIndex,
  };
}

/** Resolve pointer Y against same-kind track rows, flipping no-op adjacent
 *  halves so dragging onto an immediate neighbor always targets a real swap. */
export function resolveTrackHeaderDrop(
  state: TimelineState,
  sourceId: TrackId,
  rows: readonly TrackRowBounds[],
  clientY: number,
): ResolvedTrackHeaderDrop | null {
  if (rows.length < 2) return null;
  let chosen = rows[0]!;
  for (const row of rows) {
    chosen = row;
    if (clientY <= row.bottom) break;
  }
  if (chosen.id === sourceId) return null;
  const side: TrackDropSide = clientY < (chosen.top + chosen.bottom) / 2 ? 'before' : 'after';
  const order = trackOrderForHeaderDrop(state, sourceId, chosen.id, side);
  if (order !== null) return { targetId: chosen.id, side, order };
  const flipped: TrackDropSide = side === 'before' ? 'after' : 'before';
  const flippedOrder = trackOrderForHeaderDrop(state, sourceId, chosen.id, flipped);
  return flippedOrder !== null ? { targetId: chosen.id, side: flipped, order: flippedOrder } : null;
}

/** Human-readable lane name distinguishing main, dedicated text, video, audio, and caption tracks. */
export function trackDisplayLabel(
  state: TimelineState,
  trackId: TrackId,
  t: (text: string) => string = (text) => text,
): string {
  const main = mainTrackId(state);
  if (trackId === main) return t('主轨');
  const kind = trackKind(state, trackId);
  if (kind === 'caption') return `${t('字幕')}${trackAlias(state, trackId).slice(1)}`;
  if (kind === 'audio') return `${t('音乐')}${trackAlias(state, trackId).slice(1)}`;
  const ids = timelineTrackIds(state);
  if (isTextTrack(state, trackId, main)) {
    const textTracks = ids.filter((id) => isTextTrack(state, id, main));
    const idx = textTracks.indexOf(trackId);
    const number = idx >= 0 ? textTracks.length - idx : 1;
    return `${t('文字')}${number}`;
  }
  if (isEffectTrack(state, trackId, main)) {
    const effectTracks = ids.filter((id) => isEffectTrack(state, id, main));
    const idx = effectTracks.indexOf(trackId);
    const number = idx >= 0 ? effectTracks.length - idx : 1;
    return `${t('特效')}${number}`;
  }
  const pictureTracks = ids.filter((id) => trackKind(state, id) === 'video' && !isTextTrack(state, id, main) && !isEffectTrack(state, id, main));
  const idx = pictureTracks.indexOf(trackId);
  const number = idx >= 0 ? pictureTracks.length - idx : 1;
  return `${t('视频')}${number}`;
}
