import type { TimelineState, TrackId } from './types';

/** Tracks that can carry an audible source through the current Remotion path. */
export function isAudioCapableTrack(state: TimelineState, trackId: TrackId): boolean {
  const kind = state.tracks?.[trackId]?.kind;
  if (kind === 'audio') return true;
  if (kind === 'caption') return false;
  return state.items.some((item) => item.track === trackId
    && (item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence')
    && !!item.src);
}

export function hasSoloTrack(state: TimelineState): boolean {
  return Object.entries(state.tracks ?? {}).some(([trackId, flags]) =>
    flags?.soloed === true && isAudioCapableTrack(state, trackId));
}

export function isTrackEffectivelyMuted(
  state: TimelineState,
  trackId: TrackId,
  forceMuted = false,
  anySolo = hasSoloTrack(state),
): boolean {
  const flags = state.tracks?.[trackId];
  return forceMuted || !!flags?.muted || (anySolo && isAudioCapableTrack(state, trackId) && !flags?.soloed);
}

export function trackGainLinear(state: TimelineState, trackId: TrackId): number {
  const gainDb = state.tracks?.[trackId]?.audioRouting?.gainDb ?? 0;
  const bounded = Math.max(-60, Math.min(12, Number.isFinite(gainDb) ? gainDb : 0));
  return 10 ** (bounded / 20);
}

export function audioGainAt(state: TimelineState, trackId: TrackId, duckGain: number): number {
  return trackGainLinear(state, trackId) * duckGain;
}
