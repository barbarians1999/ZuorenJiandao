export const SHUTTLE_SPEEDS = [1, 2, 4, 8] as const;

/** Timer-driven J/K/L shuttle cadence. One tick every 80 ms, scaled by rate. */
export function shuttleTick(rate: number): { stepFrames: number; intervalMs: number } {
  return { stepFrames: Math.sign(rate) * Math.abs(rate) * 2, intervalMs: 80 };
}

export function nextShuttleRate(currentRate: number, dir: -1 | 0 | 1, isPlayerPlaying = false): number {
  if (dir === 0) return 0;
  if (dir === 1) {
    if (currentRate > 0) {
      const index = SHUTTLE_SPEEDS.indexOf(currentRate as (typeof SHUTTLE_SPEEDS)[number]);
      return index >= 0 ? SHUTTLE_SPEEDS[(index + 1) % SHUTTLE_SPEEDS.length]! : 2;
    }
    return currentRate === 0 && isPlayerPlaying ? 2 : 1;
  }
  if (currentRate < 0) {
    const index = SHUTTLE_SPEEDS.indexOf(Math.abs(currentRate) as (typeof SHUTTLE_SPEEDS)[number]);
    return -(index >= 0 ? SHUTTLE_SPEEDS[(index + 1) % SHUTTLE_SPEEDS.length]! : 2);
  }
  return -1;
}

export function nextFastForwardRate(currentRate: number): number {
  if (currentRate === 2) return 4;
  if (currentRate === 4) return 8;
  if (currentRate === 8) return 1;
  return 2;
}

export type PlayPausePlan =
  | { action: 'pause' }
  | { action: 'play'; seekToFrame: number | null };

/** Resolve Play/Pause deterministically so UI clicks and Space match L's playback path. */
export function resolvePlayPausePlan(input: {
  isPlayerPlaying: boolean;
  shuttleRate: number;
  playerFrame: number | null;
  playheadFrame: number;
  totalFrames: number;
}): PlayPausePlan {
  if (input.shuttleRate !== 0 || input.isPlayerPlaying) {
    return { action: 'pause' };
  }
  const maxFrame = Math.max(0, input.totalFrames - 1);
  const desiredFrame = Math.max(0, Math.min(maxFrame, Math.round(input.playheadFrame)));
  const liveFrame = typeof input.playerFrame === 'number' && Number.isFinite(input.playerFrame)
    ? Math.round(input.playerFrame)
    : desiredFrame;
  if (input.totalFrames > 0 && desiredFrame >= maxFrame) {
    return { action: 'play', seekToFrame: 0 };
  }
  if (Math.abs(liveFrame - desiredFrame) >= 1) {
    return { action: 'play', seekToFrame: desiredFrame };
  }
  return { action: 'play', seekToFrame: null };
}

export const PLAYBACK_RATE_EVENT = 'openchatcut:playback-rate';
export const SHUTTLE_STATE_EVENT = 'openchatcut:shuttle-state';

export function setShuttlePlaybackRate(rate: number): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const normalized = Number.isFinite(rate) && rate > 0 ? Math.max(0.25, Math.min(8, rate)) : 1;
  window.dispatchEvent(new CustomEvent<{ rate: number }>(PLAYBACK_RATE_EVENT, { detail: { rate: normalized } }));
}

export function setShuttleState(rate: number): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<{ rate: number }>(SHUTTLE_STATE_EVENT, {
    detail: { rate: Number.isFinite(rate) ? rate : 0 },
  }));
}
