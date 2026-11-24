import assert from 'node:assert/strict';
import type { TimelineState } from '../../editor/types';
import { selectableItemIdsOnTrackSide } from '../../editor/multiSelect';
import { closeCaptionTrackGaps, trackClearPlan, trackContextMenuLabels } from './trackContextOperations';

assert.deepEqual(trackContextMenuLabels('video').slice(0, 2), ['插入素材', '闭合缝隙']);
assert.ok(trackContextMenuLabels('video').includes('向左全选'));
assert.ok(trackContextMenuLabels('video').includes('向右全选'));
assert.ok(trackContextMenuLabels('audio').includes('人声与配乐'));
assert.ok(trackContextMenuLabels('caption').includes('字幕样式'));
assert.ok(!trackContextMenuLabels('caption').includes('静音轨道'));

const state: TimelineState = {
  fps: 30, width: 1080, height: 1920, items: [], selectedId: null,
  trackOrder: ['C1'], tracks: { C1: { kind: 'caption', captions: {
    enabled: true, template: 'plain', pacing: 'phrase', sourceEntries: [{
      id: 'lane-1', itemId: 'manual:lane-1', words: [
        { text: '一', start: 1_000, end: 2_000 },
        { text: '二', start: 4_000, end: 5_500 },
        { text: '三', start: 5_200, end: 6_000 },
      ],
    }],
  } } },
};
const captions = state.tracks!.C1!.captions!;
const tightened = closeCaptionTrackGaps(captions);
assert.equal(tightened.changed, true);
assert.deepEqual(tightened.captions.sourceEntries?.[0]?.words?.map(({ start, end }) => [start, end]), [
  [1_000, 2_000], [2_000, 3_500], [5_200, 6_000],
]);
assert.equal(trackClearPlan(state, 'C1').hasContents, true);
assert.deepEqual(trackClearPlan(state, 'C1').actions, [{ type: 'setCaptions', captions: null, track: 'C1' }]);

const trackSelectState: Pick<TimelineState, 'items' | 'tracks'> = {
  tracks: {
    V1: { kind: 'video' },
    V2: { kind: 'video' },
    A1: { kind: 'audio', locked: true },
  },
  items: [
    { id: 'v1-a', track: 'V1', kind: 'video', name: 'a', startFrame: 0, durationInFrames: 30 },
    { id: 'v1-b', track: 'V1', kind: 'video', name: 'b', startFrame: 30, durationInFrames: 30 },
    { id: 'v1-c', track: 'V1', kind: 'video', name: 'c', startFrame: 60, durationInFrames: 30 },
    { id: 'v2-a', track: 'V2', kind: 'video', name: 'd', startFrame: 0, durationInFrames: 90 },
    { id: 'a1-a', track: 'A1', kind: 'audio', name: 'e', startFrame: 0, durationInFrames: 90 },
  ],
};
assert.deepEqual(selectableItemIdsOnTrackSide(trackSelectState, 'V1', 60, 'left'), ['v1-a', 'v1-b']);
assert.deepEqual(selectableItemIdsOnTrackSide(trackSelectState, 'V1', 30, 'right'), ['v1-b', 'v1-c']);
assert.deepEqual(selectableItemIdsOnTrackSide(trackSelectState, 'V1', 0, 'left', { anchorItemId: 'v1-b' }), ['v1-a', 'v1-b']);
assert.deepEqual(selectableItemIdsOnTrackSide(trackSelectState, 'V1', 0, 'right', { anchorItemId: 'v1-b' }), ['v1-b', 'v1-c']);
assert.deepEqual(selectableItemIdsOnTrackSide(trackSelectState, 'A1', 30, 'right'), []);

console.log('track context operations verify passed');
