import assert from 'node:assert/strict';
import type { PlayerRef, CallbackListener, EventTypes as PlayerEventTypes } from '@remotion/player';
import type { TimelineItem } from './types';
import { attachPlayheadMediaSync, shouldPaintPlayheadTimecode } from '../components/timeline/usePlayheadPaint';
import { createFrameCoalescer } from '../components/timeline/frameCoalescer';
import { animationAuditionWindow, animationPreviewSavedFrame, releaseAnimationPreviewPosition,
  startAnimationAudition, type AuditionPlayer, type AuditionResult } from './animationAudition';

const item: TimelineItem = { id: 'v', name: 'test', kind: 'video', track: 'V1', startFrame: 90, durationInFrames: 90,
  props: { visualEntrance: 'whip', visualEntranceFrames: 12, visualExit: 'zoom', visualExitFrames: 18 } };
assert.deepEqual(animationAuditionWindow(item, 'entrance', 30), { from: 90, until: 111 });
assert.deepEqual(animationAuditionWindow(item, 'exit', 30), { from: 153, until: 180 });
assert.equal(animationAuditionWindow({ ...item, props: {} }, 'entrance', 30), null);
assert.equal(animationAuditionWindow({ ...item, kind: 'audio' }, 'entrance', 30), null);
assert.deepEqual(animationAuditionWindow({ ...item, durationInFrames: 5 }, 'exit', 30), { from: 90, until: 95 });
assert.deepEqual(animationAuditionWindow({ ...item, durationInFrames: 1 }, 'entrance', 30), { from: 90, until: 91 });
assert.deepEqual(animationAuditionWindow({ ...item, kind: 'text', props: { entrance: 'wipe', entranceFrames: 9 } }, 'entrance', 30), { from: 90, until: 108 });
assert.equal(animationAuditionWindow(item, 'entrance', 0), null);

class Player {
  frame = 45; playing = false; failPlay = false;
  listeners = new Map<string, Set<(...args: never[]) => void>>();
  getCurrentFrame = () => this.frame;
  isPlaying = () => this.playing;
  pause = () => { this.playing = false; this.emit('pause', undefined); };
  play = () => { if (this.failPlay) throw new Error('decoder'); this.playing = true; };
  container = new EventTarget();
  getContainerNode = () => this.container;
  seekTo = (frame: number) => { if (this.playing) this.pause(); this.frame = frame; this.emit('seeked', { frame }); this.emit('frameupdate', { frame }); };
  addEventListener<Q extends PlayerEventTypes>(name: Q, cb: CallbackListener<Q>) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(cb as (...args: never[]) => void);
  }
  removeEventListener<Q extends PlayerEventTypes>(name: Q, cb: CallbackListener<Q>) {
    this.listeners.get(name)?.delete(cb as (...args: never[]) => void);
  }
  emit(name: string, detail: unknown) {
    for (const cb of [...(this.listeners.get(name) ?? [])]) (cb as (event: { detail: unknown }) => void)({ detail });
  }
  advance(frame: number) { this.frame = frame; this.emit('frameupdate', { frame }); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
const scope = { projectId: 'project', timelineId: 'main' };
function setup(playing = false) {
  const player = new Player(); player.playing = playing;
  let liveScope = scope; let current = true; let deadline = () => undefined as void;
  let deadlineCancelled = false;
  const results: AuditionResult[] = [];
  const trial = () => startAnimationAudition({ player: player as AuditionPlayer, scope,
    getScope: () => liveScope, isCurrentPlayer: () => current, seek: player.seekTo,
    window: animationAuditionWindow(item, 'exit', 30)!, fps: 30,
    onFinish: (result) => results.push(result),
    schedule: (cb) => { deadline = cb; return () => { deadlineCancelled = true; }; },
  });
  return { player, results, trial, timeout: () => deadline(), wasCancelled: () => deadlineCancelled,
    switchDraft: () => { liveScope = { ...scope, timelineId: 'child' }; },
    replacePlayer: () => { current = false; } };
}
{
  const p = setup(); const trial = p.trial();
  assert.equal(p.player.frame, 153); assert.equal(p.player.playing, true);
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'main', 160), 45);
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'child', 160), 160);
  p.player.advance(179); assert.equal(trial.isActive(), true);
  p.player.advance(180);
  await Promise.resolve();
  assert.equal(p.player.frame, 45); assert.equal(p.player.playing, false);
  assert.deepEqual(p.results, ['complete']); assert.equal(p.player.count(), 0);
  assert.equal(p.wasCancelled(), true);
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'main', 82), 82);
  trial.stop(); p.timeout(); assert.deepEqual(p.results, ['complete']);
}
{
  const p = setup(true); p.trial(); p.player.emit('ended', undefined);
  assert.equal(p.player.frame, 45); assert.equal(p.player.playing, true);
}
{
  const p = setup(true); p.trial(); p.player.frame = 179; p.player.pause(); p.player.emit('ended', undefined);
  assert.equal(p.player.frame, 45); assert.equal(p.player.playing, true);
  assert.deepEqual(p.results, ['complete'], 'real end-of-timeline pause-before-ended preserves prior playback state');
}
{
  const p = setup(); const trial = p.trial();
  let desired = 153;
  let flushMetadata = () => {};
  const frames = createFrameCoalescer<void>((callback) => { flushMetadata = callback; return 1; }, () => {});
  const detach = attachPlayheadMediaSync(p.player, () => desired, () => {}, frames);
  p.player.container.dispatchEvent(new Event('loadedmetadata'));
  flushMetadata();
  assert.equal(trial.isActive(), true); assert.equal(p.player.playing, true);
  desired = 160; p.player.container.dispatchEvent(new Event('loadedmetadata'));
  flushMetadata();
  assert.equal(trial.isActive(), true); assert.equal(p.player.frame, 160);
  p.player.advance(180); await Promise.resolve(); detach();
  assert.equal(p.player.frame, 45); assert.equal(p.player.count(), 0);
  assert.deepEqual(p.results, ['complete'], 'automatic media sync must not cancel actual playback');
}
{
  const p = setup(); let finishStill = () => undefined as void;
  const trial = startAnimationAudition({ player: p.player, scope, getScope: () => scope, isCurrentPlayer: () => true,
    seek: p.player.seekTo, window: { from: 179, until: 180 }, fps: 30,
    onFinish: (result) => p.results.push(result), schedule: (callback) => { finishStill = callback; return () => {}; } });
  assert.equal(p.player.frame, 179); assert.equal(p.player.playing, false); assert.equal(trial.isActive(), true);
  finishStill(); assert.equal(p.player.frame, 45); assert.deepEqual(p.results, ['complete']);
}
{
  const p = setup(true); p.trial(); p.player.pause(); await Promise.resolve();
  assert.equal(p.player.frame, 45); assert.equal(p.player.playing, false);
  assert.deepEqual(p.results, ['stopped']);
}
{
  const p = setup(); const trial = p.trial(); p.switchDraft(); p.player.frame = 3; trial.stop();
  assert.equal(p.player.frame, 3, 'do not seek the old position into another draft');
  assert.equal(p.player.count(), 0);
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'main', 179), 45);
  releaseAnimationPreviewPosition(p.player, 'project', 'child');
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'main', 179), 45);
  releaseAnimationPreviewPosition(p.player, 'project', 'main');
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'main', 179), 179);
}
{
  const p = setup(); const trial = p.trial(); p.replacePlayer(); trial.stop();
  assert.equal(p.player.frame, 153); assert.equal(p.player.count(), 0);
}
{
  const p = setup(true); p.trial(); p.player.seekTo(20);
  assert.equal(p.player.frame, 20, 'explicit user navigation supersedes trial return');
  assert.equal(p.player.playing, false); assert.deepEqual(p.results, ['interrupted']);
  assert.equal(animationPreviewSavedFrame(p.player, 'project', 'main', 20), 20);
}
{
  const p = setup(); p.trial(); p.player.seekTo(300); await Promise.resolve();
  assert.equal(p.player.frame, 300, 'a seek beyond the trial window must not be mistaken for playback completion');
  assert.deepEqual(p.results, ['interrupted']);
}
{
  const p = setup(); p.trial(); p.timeout();
  assert.equal(p.player.frame, 45); assert.equal(p.player.count(), 0);
  assert.deepEqual(p.results, ['timeout']);
}
{
  const p = setup(); p.player.failPlay = true; const trial = p.trial();
  assert.equal(trial.isActive(), false); assert.equal(p.player.frame, 45);
  assert.equal(p.player.count(), 0); assert.deepEqual(p.results, ['error']);
}
{
  // Remotion pause emits synchronously; the restore seek then emits seeked,
  // while frameupdate is a later React effect. The forced pause label used to
  // consume the throttle interval, leaving the restored paused head showing
  // the last audition frame forever despite getCurrentFrame() already being 0.
  const player = new Player(); player.frame = 0;
  let now = 1000, lastPaint = 0, timecodeFrame = 0;
  let frameEffect = () => {};
  const paint = (frame: number, force = false) => {
    if (shouldPaintPlayheadTimecode(player.isPlaying(), force, now, lastPaint)) {
      lastPaint = now; timecodeFrame = frame;
    }
  };
  player.seekTo = (frame: number) => {
    if (player.isPlaying()) player.pause();
    player.frame = frame;
    player.emit('seeked', { frame });
    frameEffect = () => { player.emit('frameupdate', { frame }); paint(frame); };
  };
  player.addEventListener('pause', () => paint(player.getCurrentFrame(), true));
  const outcomes: AuditionResult[] = [];
  startAnimationAudition({ player, scope, getScope: () => scope, isCurrentPlayer: () => true,
    seek: (frame) => { player.seekTo(frame); paint(frame); }, window: { from: 0, until: 21 }, fps: 30,
    onFinish: (result) => outcomes.push(result), schedule: () => () => {} });
  now = 1700; player.advance(21); paint(21);
  await Promise.resolve();
  now = 1701; frameEffect();
  assert.deepEqual(outcomes, ['complete']);
  assert.equal(player.getCurrentFrame(), 0, 'actual head restores without a timer');
  assert.equal(timecodeFrame, 0, 'paused restoration label must not stay at audition frame21');
  assert.equal(shouldPaintPlayheadTimecode(true, false, now, lastPaint), false, 'active playback keeps its existing throttle');
}
// PlayerRef remains structurally accepted without an app-specific player wrapper.
const acceptPlayer = (_player: AuditionPlayer) => undefined;
if (false) acceptPlayer({} as PlayerRef);
console.log('animationAudition.verify: bounded windows, playback return, scoped persistence, stop/seek/error/timeout and cleanup passed');
