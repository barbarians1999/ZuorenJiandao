import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { activeTimeline, type ProjectDoc, type TimelineItem, type TimelineState } from './types';
import { buildCommands } from './storeCommandBuilder';
import { historyReduce } from './reduce';
import { planSubdraft } from './subdraft';
import { planClipPaste } from './clipPaste';
import { moveSelectionToNewTrack } from '../components/timeline/newTrackMove';
import { resolveTimelineRenderPlan } from './sequenceGraph';
import { sourceFrameAt } from './sourceLimit';

const video: TimelineItem = { id: 'v', name: '视频', kind: 'video', src: '/media/uploads/voice.mp4', track: 'v1', startFrame: 120, srcInFrame: 90, durationInFrames: 600,
  props: { visualEntrance: 'whip' }, mask: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: .1 } };
const audio: TimelineItem = { id: 'a', name: '口播', kind: 'audio', track: 'a1', startFrame: 150, durationInFrames: 540, src: '/media/uploads/voice.wav', volume: .6 };
const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [{
  id: 'main', name: '主时间线', order: 0, fps: 30, width: 1920, height: 1080,
  items: [video, audio], selectedId: null, tracks: { v1: { kind: 'video' }, a1: { kind: 'audio' } }, trackOrder: ['v1', 'a1'],
}] };
let serial = 0; const uid = (prefix: string) => `${prefix}_${++serial}`;
const original = structuredClone(doc);
const plan = planSubdraft(doc, ['v', 'a'], uid);
assert.equal(plan.ok, true);
if (!plan.ok) throw Error('Subdraft planning failed');
assert.deepEqual(doc, original, 'planning leaves original untouched');
const child = plan.doc.timelines.find((timeline) => timeline.id === plan.timelineId)!;
assert.deepEqual(child.items, original.timelines[0].items, 'full selection preserves gaps, trims, animation, mask and audio');
const instance = activeTimeline(plan.doc).items[0];
assert.equal(instance.durationInFrames, 720);
assert.equal(instance.kind, 'sequence');
assert.equal(resolveTimelineRenderPlan(plan.doc, 'main').durationInFrames, 720);
assert.equal(sourceFrameAt(child.items[0], 300), sourceFrameAt(video, 300));
let history = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
assert.equal(commands.createSubdraft(['v', 'a']).ok, true);
assert.equal(history.past.length, 1, 'one-step undo');
commands.undo(); assert.deepEqual(history.present, doc);
commands.redo(); assert.equal(history.present.timelines.length, 2);
const partial = planSubdraft(doc, ['v'], uid);
assert.equal(partial.ok, true);
if (partial.ok) {
  assert.equal(activeTimeline(partial.doc).items.find((item) => item.kind === 'sequence')?.startFrame, 120);
  assert.equal(partial.doc.timelines.at(-1)?.items[0].startFrame, 0);
  assert.equal(partial.doc.timelines.at(-1)?.items[0].srcInFrame, 90);
}
assert.equal(planSubdraft({ ...doc, timelines: [{ ...doc.timelines[0], tracks: { v1: { kind: 'video', locked: true } } }] }, ['v'], uid).ok, false);
const empty: TimelineState = { fps: 30, width: 1920, height: 1080, items: [], selectedId: null, trackOrder: ['mainv'], tracks: { mainv: { kind: 'video' } } };
const pasted = planClipPaste(empty, [video, audio], doc.timelines[0].tracks, 900, uid);
assert.equal(pasted.items[0].startFrame, 900); assert.equal(pasted.items[1].startFrame, 930);
assert.equal(pasted.tracks?.[pasted.items[1].track]?.kind, 'audio', 'missing source audio lanes remain audio');
const single = planClipPaste(empty, [video], doc.timelines[0].tracks, 900, uid);
assert.equal(single.items[0].track, 'mainv', 'single clip pastes to main video track');
const collision = planClipPaste(single, [video], doc.timelines[0].tracks, 900, uid);
assert.notEqual(collision.items[1].track, 'mainv', 'overlap gets its own lane');
const moved = moveSelectionToNewTrack(doc.timelines[0], ['v'], 60, 'newv');
assert.equal(moved.items.find((item) => item.id === 'v')?.track, 'newv');
assert.equal(moved.items.find((item) => item.id === 'v')?.startFrame, 180);
assert.equal(moved.trackOrder?.[0], 'newv');
assert.deepEqual(moved.items.find((item) => item.id === 'a'), audio);
const movedBottom = moveSelectionToNewTrack(
  { ...doc.timelines[0], interaction: { mainTrackId: 'v1' } },
  ['v'],
  60,
  'subv',
  'bottom',
);
assert.deepEqual(movedBottom.trackOrder, ['v1', 'subv', 'a1'], 'dragging downwards creates a video track below main track');
assert.equal(movedBottom.interaction?.mainTrackId, 'v1', 'dragging off main track preserves mainTrackId');
const textMovedTop = moveSelectionToNewTrack(
  {
    ...doc.timelines[0],
    interaction: { mainTrackId: 'v1' },
    items: [{ id: 'txt', kind: 'text', name: '文字', props: { text: 'hi' }, track: 'v1', startFrame: 0, durationInFrames: 60 }],
  },
  ['txt'],
  60,
  't1',
  'top',
);
assert.equal(textMovedTop.tracks?.t1?.visualRole, 'text', 'moving text clip to a new lane creates a text track');
assert.deepEqual(textMovedTop.trackOrder, ['t1', 'v1', 'a1'], 'text track is created at top above main track');
assert.equal(JSON.parse(JSON.stringify(plan.doc)).timelines.at(-1).items[0].srcInFrame, 90, 'source trim survives save/reopen serialization');
console.log('editingUsability.verify: subdraft timing/undo, paste lanes/collision, and drag-to-new-track passed');
