import type { CallbackListener, PlayerRef } from '@remotion/player';
import type { TimelineItem } from './types';
import { resolvePictureAnimation } from './clipAnimation';
import { resolveTextStyle } from './textStyles';
import { pictureAnimationTiming } from '../../shared/picture-animation-timing.mjs';

export type AnimationSide = 'entrance' | 'exit';
export interface AnimationPreviewScope { projectId: string; timelineId: string }
export type AuditionPlayer = Pick<PlayerRef, 'getCurrentFrame' | 'isPlaying' | 'pause' | 'play' | 'addEventListener' | 'removeEventListener'>;

const returnPositions = new WeakMap<object, { scope: AnimationPreviewScope; frame: number }>();
const internalSeeks = new WeakMap<object, (seek: () => void) => void>();
const housekeepingSeeks = new WeakSet<object>();
const sameScope = (a: AnimationPreviewScope, b: AnimationPreviewScope) => a.projectId === b.projectId && a.timelineId === b.timelineId;

/** A trial is transient: draft-switch/unmount persistence must remember the
 * original position, not a frame visited just to inspect an animation. */
export function animationPreviewSavedFrame(player: object | null, projectId: string, timelineId: string, frame: number): number {
  const entry = player && returnPositions.get(player);
  return entry && sameScope(entry.scope, { projectId, timelineId }) ? entry.frame : frame;
}

export function releaseAnimationPreviewPosition(player: object, projectId: string, timelineId: string): void {
  const entry = returnPositions.get(player);
  if (entry && sameScope(entry.scope, { projectId, timelineId })) returnPositions.delete(player);
}

/** Metadata re-sync is player housekeeping, not a user stopping a trial. */
export function withAnimationPreviewInternalSeek(player: object, seek: () => void): void {
  const run = internalSeeks.get(player);
  housekeepingSeeks.add(player);
  try { if (run) run(seek); else seek(); }
  finally { housekeepingSeeks.delete(player); }
}
export const isAnimationPreviewInternalSeek = (player: object) => housekeepingSeeks.has(player);

/** Timeline time, not media source time. Match the renderer's proportional
 * compression when both animations exceed a short clip's available span. */
export function animationAuditionWindow(item: TimelineItem, side: AnimationSide, fps: number): { from: number; until: number } | null {
  if (item.kind === 'audio' || !Number.isFinite(fps) || fps <= 0
    || !Number.isInteger(item.startFrame) || item.startFrame < 0
    || !Number.isInteger(item.durationInFrames) || item.durationInFrames < 1) return null;
  const motion = item.kind === 'text' ? resolveTextStyle(item.props) : resolvePictureAnimation(item.props);
  if (motion[side] === 'none') return null;
  if (item.kind !== 'text' && (item.props?.visualEntranceWindow || item.props?.visualExitWindow)) {
    const timing = pictureAnimationTiming(item)[side];
    if (!timing) return null;
    const context = Math.max(1, Math.round(fps / 4));
    const from = side === 'entrance' ? 0 : Math.max(0, Math.floor(timing.from) - context);
    const until = side === 'entrance' ? Math.min(item.durationInFrames, Math.ceil(timing.until) + context + 1) : item.durationInFrames;
    if (side === 'entrance' && timing.until <= 0 || side === 'exit' && timing.from >= item.durationInFrames - 1) return null;
    return until > from ? { from: item.startFrame + from, until: item.startFrame + until } : null;
  }
  const entrance = motion.entrance === 'none' ? 0 : motion.entranceFrames;
  const exit = motion.exit === 'none' ? 0 : motion.exitFrames;
  const span = Math.max(0, item.durationInFrames - 1);
  const factor = entrance + exit > span ? span / (entrance + exit) : 1;
  const context = Math.max(1, Math.round(fps / 4));
  const size = Math.min(item.durationInFrames, Math.ceil((side === 'entrance' ? entrance : exit) * factor) + context + 1);
  return side === 'entrance'
    ? { from: item.startFrame, until: item.startFrame + size }
    : { from: item.startFrame + item.durationInFrames - size, until: item.startFrame + item.durationInFrames };
}

export type AuditionResult = 'complete' | 'stopped' | 'interrupted' | 'unavailable' | 'error' | 'timeout';
export interface AnimationAuditionOptions {
  player: AuditionPlayer;
  scope: AnimationPreviewScope;
  getScope: () => AnimationPreviewScope;
  isCurrentPlayer: () => boolean;
  seek: (frame: number) => void;
  window: { from: number; until: number };
  fps: number;
  onFinish: (result: AuditionResult) => void;
  schedule?: (callback: () => void, ms: number) => () => void;
}

/** Owns only a bounded playback trial; never dispatches edits or history. */
export function startAnimationAudition(options: AnimationAuditionOptions): { stop: () => void; isActive: () => boolean } {
  const { player, scope, window, fps } = options;
  const originalFrame = player.getCurrentFrame();
  const wasPlaying = player.isPlaying();
  let active = true;
  let internal = true;
  let cancelDeadline = () => undefined as void;
  const schedule = options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });
  const current = () => options.isCurrentPlayer() && sameScope(scope, options.getScope());
  const finish = (result: AuditionResult, restore = true, resume = wasPlaying) => {
    if (!active) return;
    active = false;
    cancelDeadline();
    detach();
    if (current()) {
      // Remove the override only after restoring: pause/frame callbacks from
      // the existing playhead owner should persist the original position.
      try {
        if (!restore) returnPositions.delete(player);
        player.pause();
        if (restore) options.seek(originalFrame);
      } catch { result = 'error'; }
      returnPositions.delete(player);
      if (restore && resume && result !== 'error') {
        try { player.play(); } catch { result = 'error'; }
      }
    }
    // On a draft/player switch leave the scoped original position for the
    // old playhead owner's cleanup. Never seek into the destination draft.
    options.onFinish(result);
  };
  const onFrame: CallbackListener<'frameupdate'> = ({ detail }) => {
    if (!internal && detail.frame >= window.until) queueMicrotask(() => {
      // A user seek emits a frame update too. Let its seeked event take
      // priority before completing the playback window.
      if (active && player.getCurrentFrame() >= window.until) finish('complete');
    });
  };
  const onEnded: CallbackListener<'ended'> = () => { if (!internal) finish('complete'); };
  const onPause: CallbackListener<'pause'> = () => {
    if (internal) return;
    // The real Player pauses before either ended or seeked. Those events
    // decide completion/navigation first; a plain user pause stops the trial.
    queueMicrotask(() => { if (active) finish('stopped', true, false); });
  };
  // Explicit user navigation takes priority over returning to the old head.
  const onSeek: CallbackListener<'seeked'> = () => { if (!internal) finish('interrupted', false, false); };
  const onError: CallbackListener<'error'> = () => finish('error', true, false);
  const detach = () => {
    internalSeeks.delete(player);
    player.removeEventListener('frameupdate', onFrame);
    player.removeEventListener('ended', onEnded);
    player.removeEventListener('pause', onPause);
    player.removeEventListener('seeked', onSeek);
    player.removeEventListener('error', onError);
  };
  returnPositions.set(player, { scope, frame: originalFrame });
  internalSeeks.set(player, (seek) => {
    if (!active || !current()) { seek(); return; }
    const before = internal;
    const resume = player.isPlaying();
    internal = true;
    try { seek(); if (resume) player.play(); }
    catch { finish('error', true, false); }
    finally { internal = before; }
  });
  try {
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('ended', onEnded);
    player.addEventListener('pause', onPause);
    player.addEventListener('seeked', onSeek);
    player.addEventListener('error', onError);
    player.pause();
    options.seek(window.from);
    if (window.until - window.from === 1) {
      // Player.play at the last frame resets to frame zero. A one-frame
      // clip has no motion to play: show its actual still briefly instead.
      internal = false;
      if (active) cancelDeadline = schedule(() => finish('complete'), Math.max(250, 1000 / fps));
      return { stop: () => finish('stopped'), isActive: () => active };
    }
    player.play();
    internal = false;
    if (active) cancelDeadline = schedule(() => finish('timeout', true, false), Math.max(6000, (window.until - window.from) / fps * 3000 + 3000));
  } catch { internal = false; finish('error', true, false); }
  return { stop: () => finish('stopped'), isActive: () => active };
}
