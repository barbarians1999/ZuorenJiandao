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
