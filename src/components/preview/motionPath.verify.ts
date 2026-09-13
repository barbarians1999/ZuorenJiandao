import assert from 'node:assert/strict';
import { motionPathDelta, motionPathKeyframeFrames, sampleMotionPath } from './motionPath';
import { historyReduce, type History } from '../../editor/reduce';
import type { ProjectDoc, TimelineItem } from '../../editor/types';

const item = {
  id: 'path', track: 'V1', startFrame: 10, durationInFrames: 100, kind: 'video', name: 'path',
  transform: { x: 3, y: -2 }, keyframes: {
    x: [{ frame: 0, value: 0 }, { frame: 40, value: 40, easing: 'easeIn' }],
    y: [{ frame: 20, value: 10 }, { frame: 80, value: 30 }],
  },
} as TimelineItem;

assert.deepEqual(motionPathKeyframeFrames(item), [0, 20, 40, 80]);
assert.deepEqual(motionPathDelta({ x: 20, y: -10 }, { width: 200, height: 100 }), { x: 10, y: -10 });
const samples = sampleMotionPath(item, 8);
assert.ok(samples.length <= 8);
for (const frame of [0, 20, 40, 80]) assert.ok(samples.some((sample) => sample.frame === frame));
assert.equal(sampleMotionPath({ ...item, keyframes: { x: [{ frame: 12, value: 4 }] } } as TimelineItem).length, 1, '单节点只显示节点，不伪造路径线');
const many = { ...item, keyframes: { x: Array.from({ length: 1100 }, (_, frame) => ({ frame, value: frame })) } } as TimelineItem;
assert.equal(sampleMotionPath(many, 32).length, 1100, 'union nodes are never dropped by the sample cap');

const historyItem = {
  ...item,
  id: 'history-path',
  keyframes: { x: [{ frame: 20, value: 1 }], y: [{ frame: 20, value: 2 }] },
} as TimelineItem;
const doc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'tl1',
  timelines: [{
    id: 'tl1',
    name: 'main',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: historyItem.id,
    tracks: { V1: { kind: 'video' } },
    trackOrder: ['V1'],
    items: [historyItem],
  }],
} as unknown as ProjectDoc;
let history: History = { past: [], present: doc, future: [] };
history = historyReduce(history, { type: 'history.beginGesture' });
history = historyReduce(history, { type: 'setKeyframe', id: historyItem.id, prop: 'x', frame: 20, value: 11 });
history = historyReduce(history, { type: 'setKeyframe', id: historyItem.id, prop: 'y', frame: 20, value: 22 });
history = historyReduce(history, { type: 'history.endGesture' });
assert.equal(history.past.length, 1, '拖动一个位置节点只产生一次撤销');
const values = (value: History) => value.present.timelines[0]!.items[0]!.keyframes;
const undone = historyReduce(history, { type: 'undo' });
assert.deepEqual([values(undone)?.x?.[0]?.value, values(undone)?.y?.[0]?.value], [1, 2], '一次撤销同时恢复 x/y');
const redone = historyReduce(undone, { type: 'redo' });
assert.deepEqual([values(redone)?.x?.[0]?.value, values(redone)?.y?.[0]?.value], [11, 22], '一次重做同时恢复 x/y');

console.log('motionPath.verify: ok (union/sample/delta/cap/paired undo-redo)');
