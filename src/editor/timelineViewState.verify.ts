import assert from 'node:assert/strict';
import {
  clearTimelineViewStates,
  loadTimelineViewState,
  saveTimelineViewState,
  type TimelineViewStorage,
} from './timelineViewState';
import { fitTimelineZoom, minimumTimelineZoomForFit, MIN_TIMELINE_ZOOM_FLOOR } from './timelineZoom';

class MemoryStorage implements TimelineViewStorage {
  private readonly values: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.values[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.values[key] = value;
  }

  removeItem(key: string): void {
    delete this.values[key];
  }
}

const storage = new MemoryStorage();
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-a'), null, '无记录的 timeline 必须走 fit/default，而不是继承别的 timeline');

const viewportWidth = 1440;
const headerWidth = 212;
const fitPadding = 48;
const pixelsPerFrame = 1.2;
const longProjectFrames = 78_964;
const longMinimum = minimumTimelineZoomForFit(
  viewportWidth, headerWidth, fitPadding, longProjectFrames, pixelsPerFrame, 0.02,
);
assert.ok(longMinimum < 0.02 && longMinimum >= MIN_TIMELINE_ZOOM_FLOOR,
  'long projects lower the minimum zoom while respecting the persisted-state floor');
assert.equal(
  fitTimelineZoom(viewportWidth, headerWidth, fitPadding, longProjectFrames, pixelsPerFrame, { min: longMinimum, max: 6 }),
  longMinimum,
  '78,964 frames fit at the duration- and viewport-derived minimum',
);
assert.equal(
  minimumTimelineZoomForFit(viewportWidth, headerWidth, fitPadding, 3_600, pixelsPerFrame, 0.02),
  0.02,
  'short projects keep the existing minimum zoom',
);
assert.ok(
  minimumTimelineZoomForFit(1280, headerWidth, fitPadding, longProjectFrames, pixelsPerFrame, 0.02) < longMinimum,
  'a narrower viewport can lower the long-project minimum further',
);
for (const width of [1_162, 772]) {
  const minimum = minimumTimelineZoomForFit(width, headerWidth, fitPadding, longProjectFrames, pixelsPerFrame, 0.02);
  assert.ok(minimum < 0.01 && minimum >= MIN_TIMELINE_ZOOM_FLOOR, `${width} CSS px uses a sub-0.01 fitting minimum`);
  const fitted = fitTimelineZoom(width, headerWidth, fitPadding, longProjectFrames, pixelsPerFrame, { min: minimum, max: 6 });
  assert.equal(fitted, minimum);
  assert.ok(Math.abs(fitted * longProjectFrames * pixelsPerFrame - (width - headerWidth - fitPadding)) < 1e-8,
    `${width} CSS px fits all 78,964 frames`);
}

saveTimelineViewState(storage, 'project-a', 'timeline-a', {
  playhead: 120,
  zoom: 2.25,
  scrollLeft: 640,
  trackScale: 1.4,
});
saveTimelineViewState(storage, 'project-a', 'timeline-b', {
  playhead: 8,
  zoom: 0.75,
  scrollLeft: 24,
  trackScale: 0.8,
});

assert.deepEqual(loadTimelineViewState(storage, 'project-a', 'timeline-a'), {
  playhead: 120,
  zoom: 2.25,
  scrollLeft: 640,
  trackScale: 1.4,
});
assert.deepEqual(loadTimelineViewState(storage, 'project-a', 'timeline-b'), {
  playhead: 8,
  zoom: 0.75,
  scrollLeft: 24,
  trackScale: 0.8,
});

// Simulate A → B → A switching. A's exact view returns; B never leaks its frame or zoom into A.
const switchedToB = loadTimelineViewState(storage, 'project-a', 'timeline-b');
const switchedBackToA = loadTimelineViewState(storage, 'project-a', 'timeline-a');
assert.equal(switchedToB?.playhead, 8);
assert.equal(switchedBackToA?.playhead, 120);
assert.equal(switchedBackToA?.zoom, 2.25);
assert.equal(switchedBackToA?.scrollLeft, 640);
assert.equal(switchedBackToA?.trackScale, 1.4);

// Independent writers (playhead paint and zoom/scroll controller) merge without flattening the other fields.
saveTimelineViewState(storage, 'project-a', 'timeline-a', { playhead: 144 });
assert.deepEqual(loadTimelineViewState(storage, 'project-a', 'timeline-a'), {
  playhead: 144,
  zoom: 2.25,
  scrollLeft: 640,
  trackScale: 1.4,
});
assert.equal(loadTimelineViewState(storage, 'project-b', 'timeline-a'), null, 'project id is also part of the persistence boundary');

saveTimelineViewState(storage, 'project-a', 'timeline-low-zoom', { zoom: 0.0054 });
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-low-zoom')?.zoom, 0.0054,
  'sub-0.01 long-project zoom survives session persistence');

clearTimelineViewStates(storage, 'project-a');
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-a'), null);
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-b'), null);
assert.equal(loadTimelineViewState(storage, 'project-a', 'timeline-low-zoom'), null);

console.log('timelineViewState.verify: ok (timelineId 隔离/切换恢复/partial merge/项目清理)');
