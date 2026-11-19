import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attachPlayheadMediaSync,
} from './usePlayheadPaint';
import {
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
let desiredFirstFrame = 150;
const detachFirstSync = attachPlayheadMediaSync(
  firstPlayer,
  () => desiredFirstFrame,
  (event) => { desiredFirstFrame = event.detail.frame; },
);
firstContainer.dispatchFromDescendant();
assert.equal(firstContainer.captureEnabled, true, 'descendant media metadata must use capture');
assert.deepEqual(firstPlayer.seeks, [150], 'media metadata must reassert the restored preview frame');
firstPlayer.emitFrame(210);
firstContainer.dispatchFromDescendant();
assert.deepEqual(firstPlayer.seeks, [150, 210], 'late metadata must preserve a newer frameupdate');

detachFirstSync();
firstPlayer.emitFrame(225);
firstContainer.dispatchFromDescendant();
assert.deepEqual(firstPlayer.seeks, [150, 210], 'detached players must be inert');

const secondContainer = new MetadataContainer();
const secondPlayer = new SyncPlayer(secondContainer);
let desiredSecondFrame = 240;
const detachSecondSync = attachPlayheadMediaSync(
  secondPlayer,
  () => desiredSecondFrame,
  (event) => { desiredSecondFrame = event.detail.frame; },
);
secondContainer.dispatchFromDescendant();
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
