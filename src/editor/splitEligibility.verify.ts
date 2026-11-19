import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TimelineItem, TimelineState } from './types';
import { canSplitSelectedTimelineItem, canSplitTimelineItemAtFrame } from './splitEligibility';

const item: TimelineItem = {
  id: 'clip-1',
  name: 'Clip 1',
  kind: 'video',
  track: 'V1',
  startFrame: 10,
  durationInFrames: 20,
};

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  fit: 'contain',
  items: [item],
  selectedId: 'clip-1',
  selectedIds: ['clip-1'],
  tracks: { V1: {} },
};

assert.equal(canSplitSelectedTimelineItem({ ...state, selectedId: null, selectedIds: [] }, 20), false);
assert.equal(canSplitSelectedTimelineItem(state, 10), false, 'clip start is not a valid split point');
assert.equal(canSplitSelectedTimelineItem(state, 30), false, 'clip end is not a valid split point');
assert.equal(canSplitSelectedTimelineItem(state, 9), false, 'frame before the clip is not valid');
assert.equal(canSplitSelectedTimelineItem(state, 31), false, 'frame after the clip is not valid');
assert.equal(canSplitSelectedTimelineItem(state, 20), true, 'interior frame is valid');
assert.equal(canSplitSelectedTimelineItem({ ...state, tracks: { V1: { locked: true } } }, 20), false);
assert.equal(canSplitTimelineItemAtFrame(item, 10.6), true, 'eligibility matches reducer frame rounding');
assert.equal(canSplitTimelineItemAtFrame(item, Number.NaN), false);

const toolbarSource = readFileSync(new URL('../components/timeline/TimelineToolbar.tsx', import.meta.url), 'utf8');
assert.match(toolbarSource, /disabled=\{!canSplitSelected\}/, 'toolbar scissors must expose eligibility as disabled state');

console.log('splitEligibility.verify: selection, range, rounding, and lock guards OK');
