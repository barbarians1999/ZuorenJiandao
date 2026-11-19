import assert from 'node:assert/strict';
import { actionPolicyFor } from './reducerActionPolicy';
import { historyReduce, type History } from './reduce';
import type { ProjectDoc, Timeline, TimelineItem } from './types';

const audioItem = (volume = 1): TimelineItem => ({
  id: 'audio-1',
  track: 'A1',
  startFrame: 0,
  durationInFrames: 60,
  kind: 'audio',
  name: 'audio',
  src: '/media/audio.wav',
  volume,
} as TimelineItem);

const timeline = (id: string, order: number): Timeline => ({
  id,
  name: id,
  order,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  tracks: { A1: { kind: 'audio' } },
  trackOrder: ['A1'],
  items: [audioItem()],
} as Timeline);

const project = (): ProjectDoc => ({
  version: 3,
  assets: [],
  mediaFolders: [],
  timelines: [timeline('tl1', 0), timeline('tl2', 1)],
  activeTimelineId: 'tl1',
} as unknown as ProjectDoc);

const start = (): History => ({ past: [], present: project(), future: [] });
const volumeOf = (history: History) => history.present.timelines
  .find((entry) => entry.id === history.present.activeTimelineId)!
  .items[0]!.volume;

{
  assert.deepEqual(actionPolicyFor('move'), {
    recordsHistory: true,
    reconcileTransitions: true,
    guardOverlaps: true,
  });
  assert.deepEqual(actionPolicyFor('setMask'), {
    recordsHistory: true,
    reconcileTransitions: false,
    guardOverlaps: false,
  });
  assert.deepEqual(actionPolicyFor('setTransition'), {
    recordsHistory: true,
    reconcileTransitions: true,
    guardOverlaps: false,
  });
  assert.deepEqual(actionPolicyFor('select'), {
    recordsHistory: false,
    reconcileTransitions: false,
    guardOverlaps: false,
  });
  assert.deepEqual(actionPolicyFor('tl.switch'), {
    recordsHistory: false,
    reconcileTransitions: false,
    guardOverlaps: false,
  });
  assert.deepEqual(actionPolicyFor('tl.setSnapping'), {
    recordsHistory: false,
    reconcileTransitions: false,
    guardOverlaps: false,
  });
  assert.deepEqual(actionPolicyFor('roll'), {
    recordsHistory: true,
    reconcileTransitions: false,
    guardOverlaps: false,
  });
}

{
  const edited = historyReduce(start(), { type: 'setVolume', id: 'audio-1', volume: 0.4 });
  assert.equal(edited.past.length, 1, 'a changed media property creates one undo record');
  assert.equal(volumeOf(edited), 0.4);
  assert.equal(volumeOf(historyReduce(edited, { type: 'undo' })), 1, 'undo restores the prior project');
}

{
  const selected = historyReduce(start(), { type: 'select', id: 'audio-1' });
  assert.equal(selected.past.length, 0, 'selection changes do not create undo history');

  const switched = historyReduce(start(), { type: 'tl.switch', id: 'tl2' });
  assert.equal(switched.present.activeTimelineId, 'tl2');
  assert.equal(switched.past.length, 0, 'timeline navigation does not create undo history');
}

{
  const edited = historyReduce(start(), { type: 'tl.rename', id: 'tl1', name: 'edited' });
  const undone = historyReduce(edited, { type: 'undo' });
  const toggled = historyReduce(undone, { type: 'tl.setSnapping', id: 'tl1', snapping: false });
  const redone = historyReduce(toggled, { type: 'redo' });
  assert.equal(redone.present.timelines[0]!.interaction?.snapping, false,
    'a per-timeline snapping preference survives redo without an undo step');
  assert.equal(redone.future.length, 0);
  const undoneAgain = historyReduce(redone, { type: 'undo' });
  assert.equal(undoneAgain.present.timelines[0]!.interaction?.snapping, false,
    'a per-timeline snapping preference survives undo');
}

{
  const batched = historyReduce(start(), {
    type: 'batch',
    actions: [
      { type: 'setVolume', id: 'audio-1', volume: 0.5 },
      { type: 'setVolume', id: 'audio-1', volume: 0.25 },
    ],
  });
  assert.equal(batched.past.length, 1, 'a mutating batch produces one history record');
  assert.equal(volumeOf(batched), 0.25);
  assert.equal(volumeOf(historyReduce(batched, { type: 'undo' })), 1, 'one undo reverts the whole batch');
}

console.log('reducerActionPolicy.verify: exhaustive classifications and reducer/history behavior OK');
