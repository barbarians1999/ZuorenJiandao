import type { TimelineState } from '../../editor/types';
import { captionTrackEntries } from '../../editor/types';
import { buildCaptionPages } from '../../captions/captionPages';
import { msToFrame } from '../../transcript/types';
import { createFrameCoalescer } from './frameCoalescer';

export interface TimelineSeekGeometry {
  contentLeft: number;
  headerWidth: number;
  pixelsPerFrame: number;
  totalFrames: number;
}

export interface TimelinePointerSeekPlayer {
  pause(): void;
  seekTo(frame: number): void;
}

/** Pointer seeking is an editing action: pause first so the chosen frame stays put. */
export function seekTimelineFromPointer(
  player: TimelinePointerSeekPlayer | null,
  frame: number,
  paintPlayhead: (frame: number) => void,
): void {
  player?.pause();
  player?.seekTo(frame);
  paintPlayhead(frame);
}

export function createTimelineScrubSeek(
  getPlayer: () => (TimelinePointerSeekPlayer & { getCurrentFrame(): number; isPlaying(): boolean }) | null,
  requestFrame: (callback: () => void) => number,
  cancelFrame: (id: number) => void,
) {
  const moves = createFrameCoalescer<number>(requestFrame, cancelFrame);
  const apply = (frame: number, paint: (frame: number) => void) => {
    const player = getPlayer();
    if (player?.isPlaying()) player.pause();
    if (player && player.getCurrentFrame() !== frame) player.seekTo(frame);
    paint(frame);
  };
  return {
    get pending() { return moves.pending; },
    move(frame: number, paint: (frame: number) => void) {
      const player = getPlayer();
      if (player?.isPlaying()) player.pause();
      moves.schedule(frame, (latest) => apply(latest, paint));
      paint(frame);
    },
    commit(frame: number, paint: (frame: number) => void) {
      moves.cancel();
      apply(frame, paint);
    },
    cancel(paint?: (frame: number) => void) {
      if (!moves.pending) return;
      moves.cancel();
      const player = getPlayer();
      if (player && paint) paint(player.getCurrentFrame());
    },
  };
}

/** Map a client coordinate to a real frame, excluding headers and empty tail space. */
export function timelineSeekContinuousFrameAtClientX(
  clientX: number,
  geometry: TimelineSeekGeometry,
): number | null {
  const { contentLeft, headerWidth, pixelsPerFrame, totalFrames } = geometry;
  if (totalFrames <= 0 || pixelsPerFrame <= 0) return null;
  const timelineX = clientX - contentLeft - headerWidth;
  if (timelineX < 0 || timelineX >= totalFrames * pixelsPerFrame) return null;
  return Math.max(0, timelineX / pixelsPerFrame);
}

export function timelineSeekFrameAtClientX(
  clientX: number,
  geometry: TimelineSeekGeometry,
): number | null {
  const continuous = timelineSeekContinuousFrameAtClientX(clientX, geometry);
  return continuous === null ? null : Math.min(geometry.totalFrames - 1, Math.round(continuous));
}

/** Collect sorted unique boundary frames across clips, caption cues, and markers. */
export function collectTimelineSeekBoundaries(state: TimelineState): number[] {
  const frames = new Set<number>();
  for (const item of state.items) {
    if (Number.isFinite(item.startFrame) && item.startFrame >= 0) frames.add(Math.round(item.startFrame));
    const end = item.startFrame + item.durationInFrames;
    if (Number.isFinite(end) && end >= 0) frames.add(Math.round(end));
  }
  for (const marker of state.markers ?? []) {
    if (Number.isFinite(marker.fromFrame) && marker.fromFrame >= 0) frames.add(Math.round(marker.fromFrame));
    if (marker.durationFrames > 0) frames.add(Math.round(marker.fromFrame + marker.durationFrames));
  }
  for (const entry of captionTrackEntries(state)) {
    if (!entry.captions?.enabled) continue;
    for (const identity of buildCaptionPages(entry.captions, state.items, state.fps)) {
      frames.add(Math.max(0, msToFrame(identity.page.start, state.fps)));
      frames.add(Math.max(0, msToFrame(identity.page.end, state.fps)));
    }
  }
  return [...frames].sort((a, b) => a - b);
}

/**
 * Snap continuous pointer seeks onto nearby clip/caption boundaries so clicking
 * or scrubbing the visual seam between two units lands squarely on the cut frame
 * (where the following unit begins).
 */
export function snapTimelineSeekFrame(
  rawFrame: number,
  boundaries: readonly number[],
  options: { pixelsPerFrame: number; totalFrames: number; snapping: boolean },
): number {
  const { pixelsPerFrame, totalFrames, snapping } = options;
  if (totalFrames <= 0) return 0;
  const clamped = Math.min(totalFrames - 1, Math.max(0, Math.round(rawFrame)));
  if (!boundaries.length || pixelsPerFrame <= 0) return clamped;

  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid]! < rawFrame) lo = mid + 1;
    else hi = mid;
  }

  let bestFrame: number | null = null;
  let bestDistPx = Infinity;
  const candidates = [lo - 1, lo];
  for (const idx of candidates) {
    if (idx < 0 || idx >= boundaries.length) continue;
    const candidate = boundaries[idx]!;
    if (candidate < 0 || candidate >= totalFrames) continue;
    const neighbor = candidate > rawFrame
      ? (idx > 0 ? boundaries[idx - 1]! : null)
      : candidate < rawFrame
        ? (idx + 1 < boundaries.length ? boundaries[idx + 1]! : null)
        : null;
    const spanPx = neighbor !== null ? Math.abs(candidate - neighbor) * pixelsPerFrame : Infinity;
    const maxRadiusPx = Math.min(
      snapping ? 4.5 : 1.0,
      Math.max(snapping ? 0.75 : 0.5, spanPx * 0.35),
    );
    const distPx = Math.abs(candidate - rawFrame) * pixelsPerFrame;
    if (distPx > maxRadiusPx) continue;
    if (distPx < bestDistPx - 1e-6 || (Math.abs(distPx - bestDistPx) <= 1e-6 && candidate > (bestFrame ?? -1))) {
      bestFrame = candidate;
      bestDistPx = distPx;
    }
  }
  return bestFrame ?? clamped;
}

export const TIMELINE_CLICK_SLOP_PX = 4;

export function timelineGestureHasDragged(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): boolean {
  return Math.max(Math.abs(clientX - startX), Math.abs(clientY - startY)) >= TIMELINE_CLICK_SLOP_PX;
}

export function timelinePointerShouldSeek(
  button: number,
  referencePickMode: boolean,
  hasDragged: boolean,
): boolean {
  return button === 0 && !referencePickMode && !hasDragged;
}

export function playheadScrubGrabOffsetPx(
  pointerClientX: number,
  playheadClientX: number,
  maxRadiusPx = 6,
): number {
  const raw = pointerClientX - playheadClientX;
  return Math.max(-maxRadiusPx, Math.min(maxRadiusPx, raw));
}

export function timelinePointerStartKind(input: {
  button: number;
  playheadGrip: boolean;
  ruler: boolean;
  trackLane: boolean;
  ownedControl: boolean;
}): 'blank' | 'scrub' | null {
  if (input.button !== 0) return null;
  if (input.playheadGrip || input.ruler && !input.ownedControl) return 'scrub';
  if (input.trackLane && !input.ownedControl) return 'blank';
  return null;
}
