import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attachPlayheadMediaSync,
} from './usePlayheadPaint';
import {
  createTimelineScrubSeek,
  playheadScrubGrabOffsetPx,
  seekTimelineFromPointer,
  timelinePointerStartKind,
  timelineGestureHasDragged,
  timelinePointerShouldSeek,
  timelineSeekFrameAtClientX,
  collectTimelineSeekBoundaries,
  snapTimelineSeekFrame,
} from './timelineSeek';
import { playheadAnchoredTimelineScrollLeft } from '../../editor/timelineZoom';
import { createFrameCoalescer } from './frameCoalescer';

const geometry = {
  contentLeft: 100,
  headerWidth: 112,
  pixelsPerFrame: 2,
  totalFrames: 120,
};

assert.equal(timelineSeekFrameAtClientX(212, geometry), 0);
assert.equal(timelineSeekFrameAtClientX(312, geometry), 50);
assert.equal(timelineSeekFrameAtClientX(451, geometry), 119);
assert.equal(timelineSeekFrameAtClientX(452, geometry), null);
assert.equal(timelineSeekFrameAtClientX(211, geometry), null);
assert.equal(timelineSeekFrameAtClientX(312, { ...geometry, totalFrames: 0 }), null);

assert.equal(timelinePointerShouldSeek(0, false, false), true);
assert.equal(timelinePointerShouldSeek(2, false, false), false);
assert.equal(timelinePointerShouldSeek(0, true, false), false);
assert.equal(timelinePointerShouldSeek(0, false, true), false);
assert.equal(timelinePointerStartKind({ button: 0, playheadGrip: true, ruler: false, trackLane: false, ownedControl: true }), 'scrub');
assert.equal(timelinePointerStartKind({ button: 0, playheadGrip: false, ruler: true, trackLane: false, ownedControl: false }), 'scrub');
assert.equal(timelinePointerStartKind({ button: 0, playheadGrip: false, ruler: true, trackLane: false, ownedControl: true }), null,
  'ruler marker controls own their pointer gesture');
assert.equal(timelinePointerStartKind({ button: 0, playheadGrip: false, ruler: false, trackLane: true, ownedControl: false }), 'blank');
assert.equal(timelinePointerStartKind({ button: 0, playheadGrip: false, ruler: false, trackLane: true, ownedControl: true }), null,
  'clip, caption, trim, roll, and track controls do not receive container click-seek');
assert.equal(timelinePointerStartKind({ button: 0, playheadGrip: true, ruler: false, trackLane: true, ownedControl: false }), 'scrub',
  'playhead line grip scrubs even when positioned over a track lane');
assert.equal(timelinePointerStartKind({ button: 2, playheadGrip: false, ruler: true, trackLane: false, ownedControl: false }), null);

assert.equal(playheadScrubGrabOffsetPx(203, 200), 3);
assert.equal(playheadScrubGrabOffsetPx(180, 200), -6);
assert.equal(playheadScrubGrabOffsetPx(220, 200), 6);

assert.equal(timelineGestureHasDragged(10, 10, 13, 13), false);
assert.equal(timelineGestureHasDragged(10, 10, 14, 10), true);
assert.equal(timelineGestureHasDragged(10, 10, 10, 14), true);

const pointerSeekCalls: string[] = [];
seekTimelineFromPointer({
  pause: () => pointerSeekCalls.push('pause'),
  seekTo: (frame) => pointerSeekCalls.push(`seek:${frame}`),
}, 42, (frame) => pointerSeekCalls.push(`paint:${frame}`));
assert.deepEqual(
  pointerSeekCalls,
  ['pause', 'seek:42', 'paint:42'],
  'pointer seeking must pause before moving and painting the playhead',
);

const detachedPointerPaints: number[] = [];
seekTimelineFromPointer(null, 17, (frame) => detachedPointerPaints.push(frame));
assert.deepEqual(
  detachedPointerPaints,
  [17],
  'pointer seeking must still paint when the preview player is not mounted',
);

{
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const runFrame = () => {
    const scheduled = [...callbacks.values()];
    callbacks.clear();
    for (const callback of scheduled) callback();
  };
  let frame = 0;
  let playing = true;
  let pauses = 0;
  const seeks: number[] = [];
  let painted = 0;
  const paint = (next: number) => { painted = next; };
  const scrub = createTimelineScrubSeek(() => ({
    getCurrentFrame: () => frame,
    isPlaying: () => playing,
    pause: () => { playing = false; pauses += 1; },
    seekTo: (next) => { frame = next; seeks.push(next); },
  }), (callback) => { callbacks.set(++nextId, callback); return nextId; }, (id) => callbacks.delete(id));

  for (let i = 0; i < 80; i++) scrub.move(Math.round(10 + i / 25), paint);
  assert.equal(painted, 13, 'the timeline paints the latest target before the Player moves');
  assert.equal(pauses, 1);
  assert.equal(callbacks.size, 1);
  assert.deepEqual(seeks, []);
  runFrame();
  assert.deepEqual(seeks, [13], 'only the newest target reaches the Player on refresh');
  scrub.move(13, paint);
  runFrame();
  assert.deepEqual(seeks, [13], 'the same frame does not send another seek');
  scrub.move(15, paint);
  scrub.commit(16, paint);
  runFrame();
  assert.deepEqual(seeks, [13, 16], 'release commits the exact frame and discards the queued move');
  scrub.move(19, paint);
  scrub.cancel(paint);
  runFrame();
  assert.equal(painted, 16, 'a cancelled gesture restores the last Player frame');
  assert.deepEqual(seeks, [13, 16]);
}

{
  // Decoder backpressure: do not flood seekTo while a video element is still decoding.
  class ScrubVideoContainer extends EventTarget {
    readonly videos: Array<{ seeking: boolean; readyState: number }> = [{ seeking: false, readyState: 4 }];
    private readonly settleListeners = new Set<EventListenerOrEventListenerObject>();

    override addEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean,
    ): void {
      super.addEventListener(type, callback, options);
      if (type === 'seeked' && callback) this.settleListeners.add(callback);
    }

    override removeEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: EventListenerOptions | boolean,
    ): void {
      super.removeEventListener(type, callback, options);
      if (type === 'seeked' && callback) this.settleListeners.delete(callback);
    }

    querySelectorAll(selector: string) {
      return selector === 'video' ? this.videos : [];
    }

    get seekedListenerCount() {
      return this.settleListeners.size;
    }
  }

  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const runFrame = () => {
    const scheduled = [...callbacks.values()];
    callbacks.clear();
    for (const callback of scheduled) callback();
  };
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const container = new ScrubVideoContainer();
  let nowMs = 1000;
  let frame = 0;
  const seeks: number[] = [];
  let painted = 0;
  const paint = (next: number) => { painted = next; };

  const scrub = createTimelineScrubSeek(
    () => ({
      getCurrentFrame: () => frame,
      isPlaying: () => false,
      pause: () => {},
      seekTo: (next) => {
        frame = next;
        seeks.push(next);
        container.videos[0]!.seeking = true;
      },
      getContainerNode: () => container,
    }),
    (callback) => { callbacks.set(++nextId, callback); return nextId; },
    (id) => callbacks.delete(id),
    {
      maxDecodeWaitMs: 180,
      now: () => nowMs,
      setTimer: (callback) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (id) => { timers.delete(id as unknown as number); },
    },
  );

  scrub.move(10, paint);
  runFrame();
  assert.deepEqual(seeks, [10], 'first move seeks immediately');

  nowMs = 1030;
  scrub.move(20, paint);
  runFrame();
  scrub.move(30, paint);
  runFrame();
  assert.equal(painted, 30, 'playhead paints immediately even while video is seeking');
  assert.deepEqual(seeks, [10], 'in-flight video seek is not aborted by rapid scrubbing');
  assert.equal(scrub.pending, true);
  assert.equal(container.seekedListenerCount, 1);

  container.videos[0]!.seeking = false;
  container.dispatchEvent(new Event('seeked'));
  runFrame();
  assert.deepEqual(seeks, [10, 30], 'settling flushes only the newest target frame');
  assert.equal(container.seekedListenerCount, 0);

  // Watchdog fallback forces a seek if a video stays stuck in seeking past maxDecodeWaitMs.
  nowMs = 1050;
  scrub.move(40, paint);
  runFrame();
  assert.deepEqual(seeks, [10, 30], 'still waiting before watchdog threshold');
  const [watchdogId, watchdogFn] = [...timers.entries()][0]!;
  assert.ok(watchdogId > 0 && watchdogFn);
  nowMs = 1230;
  watchdogFn();
  runFrame();
  assert.deepEqual(seeks, [10, 30, 40], 'watchdog expiration forces deferred seek');

  // Commit immediately cancels wait and seeks to exact frame.
  nowMs = 1240;
  scrub.move(42, paint);
  runFrame();
  assert.equal(scrub.pending, true);
  scrub.commit(45, paint);
  assert.deepEqual(seeks, [10, 30, 40, 45]);
  assert.equal(scrub.pending, false);
  assert.equal(container.seekedListenerCount, 0);

  // Cancel detaches listeners and restores player frame.
  nowMs = 1250;
  scrub.move(50, paint);
  runFrame();
  assert.equal(painted, 50);
  scrub.cancel(paint);
  assert.equal(painted, 45);
  assert.equal(scrub.pending, false);
  assert.equal(container.seekedListenerCount, 0);
}

type FrameListener = (event: { detail: { frame: number } }) => void;

class MetadataContainer extends EventTarget {
  captureEnabled = false;
  private readonly metadataListeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type !== 'loadedmetadata') return super.addEventListener(type, callback, options);
    this.captureEnabled = typeof options === 'boolean' ? options : options?.capture === true;
    if (callback && this.captureEnabled) this.metadataListeners.add(callback);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null): void {
    if (type !== 'loadedmetadata') return super.removeEventListener(type, callback);
    if (callback) this.metadataListeners.delete(callback);
  }

  dispatchFromDescendant(): void {
    const event = {
      type: 'loadedmetadata',
      bubbles: false,
      target: { tagName: 'VIDEO' },
      currentTarget: this,
    } as unknown as Event;
    for (const listener of this.metadataListeners) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

class SyncPlayer {
  readonly seeks: number[] = [];
  private readonly frameListeners = new Set<FrameListener>();
  private readonly container: EventTarget | null;

  constructor(container: EventTarget | null) {
    this.container = container;
  }

  getContainerNode(): EventTarget | null { return this.container; }
  seekTo(frame: number): void { this.seeks.push(frame); }
  addEventListener(_type: 'frameupdate', listener: FrameListener): void { this.frameListeners.add(listener); }
  removeEventListener(_type: 'frameupdate', listener: FrameListener): void { this.frameListeners.delete(listener); }
  emitFrame(frame: number): void {
    for (const listener of this.frameListeners) listener({ detail: { frame } });
  }
}

const firstContainer = new MetadataContainer();
const firstPlayer = new SyncPlayer(firstContainer);
let flushMetadata = () => {};
const metadataFrame = () => createFrameCoalescer<void>((callback) => {
  flushMetadata = callback;
  return 1;
}, () => { flushMetadata = () => {}; });
let desiredFirstFrame = 150;
const detachFirstSync = attachPlayheadMediaSync(
  firstPlayer,
  () => desiredFirstFrame,
  (event) => { desiredFirstFrame = event.detail.frame; },
  metadataFrame(),
);
firstContainer.dispatchFromDescendant();
firstContainer.dispatchFromDescendant();
assert.deepEqual(firstPlayer.seeks, [], 'a metadata burst waits for the next paint');
flushMetadata();
assert.equal(firstContainer.captureEnabled, true, 'descendant media metadata must use capture');
assert.deepEqual(firstPlayer.seeks, [150], 'one seek reasserts the restored frame for the whole metadata burst');
firstContainer.dispatchFromDescendant();
firstPlayer.emitFrame(210);
flushMetadata();
assert.deepEqual(firstPlayer.seeks, [150, 210], 'late metadata must preserve a newer frameupdate');

firstContainer.dispatchFromDescendant();
detachFirstSync();
firstPlayer.emitFrame(225);
firstContainer.dispatchFromDescendant();
flushMetadata();
assert.deepEqual(firstPlayer.seeks, [150, 210], 'detached players must be inert');

const secondContainer = new MetadataContainer();
const secondPlayer = new SyncPlayer(secondContainer);
let desiredSecondFrame = 240;
const detachSecondSync = attachPlayheadMediaSync(
  secondPlayer,
  () => desiredSecondFrame,
  (event) => { desiredSecondFrame = event.detail.frame; },
  metadataFrame(),
);
secondContainer.dispatchFromDescendant();
flushMetadata();
assert.deepEqual(secondPlayer.seeks, [240], 'replacement players must synchronize independently');
detachSecondSync();
assert.doesNotThrow(() => attachPlayheadMediaSync(
  new SyncPlayer(null),
  () => 0,
  () => undefined,
)());

const timelineSource = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
assert.match(timelineSource, /onPointerDownCapture=\{startSeekGesture\}/);
assert.match(timelineSource, /className="cc-playhead-line-grip"/);
assert.match(timelineSource, /pointerEvents:\s*editMode === 'blade' \? 'none' : 'auto'/);
const controllerSource = readFileSync(new URL('./useTimelineController.ts', import.meta.url), 'utf8');
assert.match(controllerSource, /\.cc-playhead-grip,\s*\.cc-playhead-line-grip/);
assert.match(controllerSource, /onScrubActiveChangeRef\.current\?\./);
assert.match(controllerSource, /\},\s*\[projectId,\s*timelineId,\s*scrubSeek\]\);/);
assert.match(controllerSource, /onHoverPreviewFrameChange\?\.\(frame\)/);
assert.match(timelineSource, /className="cc-timeline-hover-guide"/);

const previewSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(previewSource, /hoverPreviewFrame !== null/);
assert.match(previewSource, /<Thumbnail[\s\S]*?frameToDisplay=\{hoverPreviewFrame\}/);

const seekBoundaries = collectTimelineSeekBoundaries({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['C1', 'V1'],
  tracks: {
    V1: { kind: 'video' },
    C1: {
      kind: 'caption',
      captions: {
        enabled: true,
        template: 'plain',
        pacing: 'phrase',
        sourceEntries: [{
          id: 'lane1',
          itemId: 'manual:lane1',
          words: [
            { id: 'c1', text: '第一句', start: 0, end: 1000 },
            { id: 'c2', text: '第二句', start: 1000, end: 2000 },
          ],
        }],
      },
    },
  },
  items: [
    { id: 'v1', kind: 'video', name: 'A', track: 'V1', startFrame: 0, durationInFrames: 30 },
    { id: 'v2', kind: 'video', name: 'B', track: 'V1', startFrame: 30, durationInFrames: 60 },
  ],
});
assert.ok(seekBoundaries.includes(30) && seekBoundaries.includes(60) && seekBoundaries.includes(90));
assert.equal(
  snapTimelineSeekFrame(29.8, seekBoundaries, { pixelsPerFrame: 2, totalFrames: 120, snapping: true }),
  30,
  'seam clicks snap cleanly onto the following clip/caption cut frame',
);
assert.equal(
  snapTimelineSeekFrame(29.7, seekBoundaries, { pixelsPerFrame: 2, totalFrames: 120, snapping: false }),
  30,
  'tight seam snap biases exact cut clicks even with snapping toggled off',
);
assert.equal(
  snapTimelineSeekFrame(25, [24, 26], { pixelsPerFrame: 0.5, totalFrames: 120, snapping: true }),
  26,
  'equidistant boundary tie breaks toward the following unit',
);

// Playhead-anchored zoom keeps a visible playhead stationary and centers an off-screen playhead.
assert.equal(
  playheadAnchoredTimelineScrollLeft(2600, 1000, 212, 3000, 1, 2),
  5600,
  'visible playhead stays at the exact same viewport x when zooming in',
);
assert.equal(
  playheadAnchoredTimelineScrollLeft(0, 1000, 212, 3000, 1, 2),
  5606,
  'off-screen playhead is brought to the horizontal center of the track viewport on zoom',
);
assert.equal(
  playheadAnchoredTimelineScrollLeft(0, 1000, 212, 0, 1, 2),
  0,
  'playhead at frame 0 keeps scrollLeft at 0',
);

console.log('timelineSeek.verify: frame mapping, drag-safe seeking, and playhead-anchored zoom passed');
