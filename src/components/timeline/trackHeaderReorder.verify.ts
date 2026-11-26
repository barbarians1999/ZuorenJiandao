import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TrackKind, TimelineState } from '../../editor/types';
import { applyTrackAction } from '../../editor/reducerTrackActions';
import { placeTrack } from '../../editor/reducerTimelineHelpers';
import { trackKind } from '../../editor/types';
import { planTrackStepReorder, resolveTrackHeaderDrop, trackDisplayLabel, trackOrderForHeaderDrop } from './trackHeaderReorder';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['C1', 'C2', 'V3', 'V2', 'V1', 'A1', 'A2'],
  tracks: {
    C1: { kind: 'caption' }, C2: { kind: 'caption' },
    V1: { kind: 'video' }, V2: { kind: 'video' }, V3: { kind: 'video' },
    A1: { kind: 'audio' }, A2: { kind: 'audio' },
  },
  items: [],
};

function lane(order: string[], kind: TrackKind): string[] {
  return order.filter((id) => trackKind(state, id) === kind);
}

function applyDrop(source: string, target: string, side: 'before' | 'after'): string[] | null {
  const order = trackOrderForHeaderDrop(state, source, target, side);
  return order === null ? null : placeTrack(state, source, trackKind(state, source), order);
}

assert.equal(trackOrderForHeaderDrop(state, 'V1', 'V3', 'before'), 2,
  'video top/bottom display order is converted to placeTrack order');
assert.deepEqual(lane(applyDrop('V1', 'V3', 'before')!, 'video'), ['V1', 'V3', 'V2'],
  'dropping a lower video above a higher one moves it visually forward');
assert.equal(trackOrderForHeaderDrop(state, 'V3', 'V1', 'after'), 0);
assert.deepEqual(lane(applyDrop('V3', 'V1', 'after')!, 'video'), ['V2', 'V1', 'V3'],
  'dropping the top video below a lower one moves it visually backward');
assert.equal(trackOrderForHeaderDrop(state, 'A1', 'A2', 'after'), 1);
assert.deepEqual(lane(applyDrop('A1', 'A2', 'after')!, 'audio'), ['A2', 'A1'],
  'audio order follows top-to-bottom header order');
assert.equal(trackOrderForHeaderDrop(state, 'C2', 'C1', 'before'), 0);
assert.deepEqual(lane(applyDrop('C2', 'C1', 'before')!, 'caption'), ['C2', 'C1'],
  'caption order follows top-to-bottom header order');
assert.equal(trackOrderForHeaderDrop(state, 'V1', 'V1', 'before'), null, 'dropping onto itself is a no-op');
assert.equal(trackOrderForHeaderDrop(state, 'V2', 'V3', 'after'), null, 'same resulting position is a no-op');
assert.equal(trackOrderForHeaderDrop(state, 'A1', 'V1', 'before'), null, 'cross-kind drops are rejected');

const captions1 = { enabled: true, template: 'plain' as const, pacing: 'phrase' as const, sourceEntries: [] };
const captions2 = { ...captions1, enabled: false };
const captionState: TimelineState = {
  ...state,
  tracks: {
    ...state.tracks,
    C1: { kind: 'caption', captions: captions1 },
    C2: { kind: 'caption', captions: captions2 },
  },
};
const captionOrder = trackOrderForHeaderDrop(captionState, 'C2', 'C1', 'before')!;
const reorderedCaptions = applyTrackAction(captionState,
  { type: 'track.update', track: 'C2', patch: { order: captionOrder } },
  (current) => current);
assert.ok(reorderedCaptions);
assert.deepEqual(reorderedCaptions.tracks?.C1?.captions, captions1);
assert.deepEqual(reorderedCaptions.tracks?.C2?.captions, captions2,
  'track.update reorders caption rows without moving or clearing their payloads');

const labeledState: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  interaction: { mainTrackId: 'V1' },
  trackOrder: ['C1', 'T1', 'V2', 'V1', 'A1'],
  tracks: {
    C1: { kind: 'caption' },
    T1: { kind: 'video', visualRole: 'text' },
    V2: { kind: 'video' },
    V1: { kind: 'video' },
    A1: { kind: 'audio' },
  },
  items: [],
};
assert.equal(trackDisplayLabel(labeledState, 'V1'), '主轨');
assert.equal(trackDisplayLabel(labeledState, 'T1'), '文字1');
assert.equal(trackDisplayLabel(labeledState, 'V2'), '视频2');
assert.equal(trackDisplayLabel(labeledState, 'C1'), '字幕1');
assert.equal(trackDisplayLabel(labeledState, 'A1'), '音乐1');

const videoRows = [
  { id: 'V3', top: 100, bottom: 160 },
  { id: 'V2', top: 160, bottom: 220 },
  { id: 'V1', top: 220, bottom: 280 },
];
assert.deepEqual(
  resolveTrackHeaderDrop(state, 'V2', videoRows, 230),
  { targetId: 'V1', side: 'after', order: 0 },
  'dragging V2 into the upper half of adjacent V1 flips to a valid swap below V1',
);
assert.deepEqual(
  resolveTrackHeaderDrop(state, 'V1', videoRows, 210),
  { targetId: 'V2', side: 'before', order: 1 },
  'dragging V1 into the lower half of adjacent V2 flips to a valid swap above V2',
);
assert.equal(
  resolveTrackHeaderDrop(state, 'V2', videoRows, 190),
  null,
  'hovering over the dragged track itself is ignored cleanly',
);
assert.deepEqual(
  resolveTrackHeaderDrop(state, 'V3', videoRows, 230),
  { targetId: 'V1', side: 'before', order: 1 },
  'non-adjacent drop into upper half of V1 places V3 above V1',
);
assert.deepEqual(
  resolveTrackHeaderDrop(state, 'V3', videoRows, 270),
  { targetId: 'V1', side: 'after', order: 0 },
  'non-adjacent drop into lower half of V1 places V3 below V1',
);

const timelineSource = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
assert.match(timelineSource, /startTrackHeaderReorder[\s\S]*?event\.preventDefault\(\)/);
assert.match(timelineSource, /startTrackHeaderReorder[\s\S]*?setPointerCapture/);

const mediaGridSource = readFileSync(new URL('../../media/MediaPoolGrid.tsx', import.meta.url), 'utf8');
assert.match(mediaGridSource, /event\.currentTarget\.clientWidth/);
assert.match(mediaGridSource, /event\.currentTarget\.clientHeight/);
assert.match(mediaGridSource, /onLostPointerCapture=\{finishMarquee\}/);

// planTrackStepReorder: video/audio/caption step and edge moves plus single-track bounds.
assert.deepEqual(planTrackStepReorder(state, 'V3'), {
  canMoveUp: false, canMoveDown: true,
  moveUpOrder: null, moveDownOrder: 1, moveTopOrder: null, moveBottomOrder: 0,
  sameKindCount: 3, visualIndex: 0,
});
assert.deepEqual(planTrackStepReorder(state, 'V2'), {
  canMoveUp: true, canMoveDown: true,
  moveUpOrder: 2, moveDownOrder: 0, moveTopOrder: 2, moveBottomOrder: 0,
  sameKindCount: 3, visualIndex: 1,
});
assert.deepEqual(planTrackStepReorder(state, 'V1'), {
  canMoveUp: true, canMoveDown: false,
  moveUpOrder: 1, moveDownOrder: null, moveTopOrder: 2, moveBottomOrder: null,
  sameKindCount: 3, visualIndex: 2,
});
assert.deepEqual(planTrackStepReorder(state, 'A1'), {
  canMoveUp: false, canMoveDown: true,
  moveUpOrder: null, moveDownOrder: 1, moveTopOrder: null, moveBottomOrder: 1,
  sameKindCount: 2, visualIndex: 0,
});
assert.deepEqual(planTrackStepReorder(state, 'C2'), {
  canMoveUp: true, canMoveDown: false,
  moveUpOrder: 0, moveDownOrder: null, moveTopOrder: 0, moveBottomOrder: null,
  sameKindCount: 2, visualIndex: 1,
});
assert.deepEqual(planTrackStepReorder(labeledState, 'A1'), {
  canMoveUp: false, canMoveDown: false,
  moveUpOrder: null, moveDownOrder: null, moveTopOrder: null, moveBottomOrder: null,
  sameKindCount: 1, visualIndex: 0,
});

console.log('trackHeaderReorder.verify: ok');
