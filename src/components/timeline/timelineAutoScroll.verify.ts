import assert from 'node:assert/strict';
import { createTimelineAutoScrollController, edgeScrollDelta, incrementalTimelineDragFrames } from './timelineAutoScroll';

const viewport = { viewportLeft: 100, viewportRight: 500, headerInset: 212, scrollLeft: 100, maxScrollLeft: 300 };
assert.ok(edgeScrollDelta({ ...viewport, clientX: 270, elapsedMs: 16 }) < 0,
  'an already-owned drag may overshoot into the sticky track-head area');
assert.equal(edgeScrollDelta({ ...viewport, clientX: 270, elapsedMs: 16, active: false }), 0,
  'controls do not start an edge-scroll gesture');
assert.equal(edgeScrollDelta({ ...viewport, clientX: 360, elapsedMs: 16 }), 0, 'the inner edge-zone boundary has no jump');
assert.equal(edgeScrollDelta({ ...viewport, viewportRight: 340, clientX: 326, elapsedMs: 16 }), 0,
  'narrow viewports cap each edge zone to half the timeline area');
assert.ok(edgeScrollDelta({ ...viewport, clientX: 312, elapsedMs: 16 }) < 0, 'the timeline-side left edge scrolls left');
assert.ok(edgeScrollDelta({ ...viewport, clientX: 500, elapsedMs: 16 }) > 0, 'the viewport right edge scrolls right');
assert.equal(edgeScrollDelta({ ...viewport, clientX: 500, elapsedMs: 10_000 }), 24, 'long frame gaps are capped per frame');
assert.equal(edgeScrollDelta({ ...viewport, scrollLeft: 0, clientX: 312, elapsedMs: 16 }), 0, 'the left scroll limit stops motion');
assert.equal(edgeScrollDelta({ ...viewport, scrollLeft: 300, clientX: 500, elapsedMs: 16 }), 0, 'the right scroll limit stops motion');
assert.equal(edgeScrollDelta({ ...viewport, active: false, clientX: 500, elapsedMs: 16 }), 0, 'inactive gestures cannot scroll');
assert.equal(incrementalTimelineDragFrames({ rawDeltaF: 5, clientX: 300, lastClientX: 300,
  scrollLeft: 120, lastScrollLeft: 80, pixelsPerFrame: 2, lastPixelsPerFrame: 1 }), 5,
'zoom re-bases without changing a stationary drag');
assert.equal(incrementalTimelineDragFrames({ rawDeltaF: 5, clientX: 310, lastClientX: 300,
  scrollLeft: 100, lastScrollLeft: 80, pixelsPerFrame: 2, lastPixelsPerFrame: 2 }), 20,
'pointer and edge-scroll deltas use the current frame scale');

let nextId = 0;
const frames = new Map<number, (timestamp: number) => void>();
const scheduler = {
  request(callback: (timestamp: number) => void) { const id = ++nextId; frames.set(id, callback); return id; },
  cancel(id: number) { frames.delete(id); },
};
const tick = (timestamp: number) => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(timestamp));
};
let currentViewport = { ...viewport };
let rescans = 0;
const autoScroll = createTimelineAutoScrollController({
  scheduler,
  getViewport: () => currentViewport,
  setScrollLeft: (scrollLeft) => { currentViewport = { ...currentViewport, scrollLeft }; },
  onScrolled: (gesture) => { assert.equal(gesture.pointerId, 7); rescans += 1; },
});
autoScroll.start(7, 350, 20);
assert.equal(frames.size, 0, 'pointer-down alone does not scroll');
autoScroll.update(8, 200, 20);
assert.equal(frames.size, 0, 'other pointer ids cannot start the loop');
autoScroll.update(7, 330, 20);
tick(16);
const firstScroll = currentViewport.scrollLeft;
assert.ok(firstScroll < viewport.scrollLeft && rescans === 1);
tick(32);
assert.ok(currentViewport.scrollLeft < firstScroll && Number(rescans) === 2,
  'a stationary edge pointer continues recomputing after scroll');
autoScroll.stop(8);
tick(48);
assert.ok(currentViewport.scrollLeft < firstScroll, 'mismatched stop leaves the active gesture alone');
autoScroll.stop(7);
const stoppedAt = currentViewport.scrollLeft;
tick(64);
assert.equal(currentViewport.scrollLeft, stoppedAt);
assert.equal(frames.size, 0, 'stop cancels the scheduled frame');
assert.equal(autoScroll.getActivePointerId(), null);

console.log('timelineAutoScroll.verify: header inset, elapsed-time cap, stationary refresh, bounds, and cancellation passed');
