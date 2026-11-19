/** Timer-driven J/K/L shuttle cadence. One tick every 80 ms, scaled by rate. */
export function shuttleTick(rate: number): { stepFrames: number; intervalMs: number } {
  return { stepFrames: Math.sign(rate) * Math.abs(rate) * 2, intervalMs: 80 };
}

export const PLAYBACK_RATE_EVENT = 'openchatcut:playback-rate';

export function setShuttlePlaybackRate(rate: number): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const normalized = Number.isFinite(rate) && rate > 0 ? Math.max(0.25, Math.min(4, rate)) : 1;
  window.dispatchEvent(new CustomEvent<{ rate: number }>(PLAYBACK_RATE_EVENT, { detail: { rate: normalized } }));
}
