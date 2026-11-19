import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { reduce } from './reducerTimeline';
import { historyReduce, type History } from './reducerHistory';
import { buildCommands } from './storeCommandBuilder';
import { activeTimeline, type ProjectDoc, type TimelineItem, type TimelineState } from './types';
import { planDirectionalChange, planMagneticMove } from './magneticTimeline';
import { normalizeTimelineTracks } from '../persist/migrations/normalize';

const clip = (id: string, startFrame: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id, name: id, kind: 'video', src: `/${id}.mp4`, track: 'V1', startFrame, durationInFrames: 30, srcInFrame: 10, ...patch,
});
const initial = (): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V2', 'V1', 'A1'], tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  interaction: { mainTrackId: 'V1', magnet: true, linkage: true },
  items: [clip('a', 0), clip('b', 30), clip('c', 60),
    clip('title', 35, { kind: 'text', track: 'V2', mainClipId: 'b', durationInFrames: 10 }),
    clip('music', 0, { kind: 'audio', track: 'A1', durationInFrames: 200 })],
});
const get = (state: TimelineState, id: string) => {
  const result = state.items.find((item) => item.id === id);
  assert.ok(result, `missing ${id}`);
  return result;
};
const mainOrder = (state: TimelineState) => state.items.filter((item) => item.track === 'V1')
  .toSorted((a, b) => a.startFrame - b.startFrame).map((item) => `${item.id}:${item.startFrame}`);
const docFor = (state: TimelineState): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main',
  timelines: [{ ...state, id: 'main', name: 'Main', order: 0 }],
});

// Real reducer includes its final global linkage check: absolute before/after
// projection is idempotent, not an extra delta applied a second time.
{
  const before = initial();
  const planned = planMagneticMove(before, ['a'], 'a', 100);
  assert.deepEqual(planDirectionalChange(before, planned.state).state, planned.state);
  const moved = reduce(before, { type: 'move', id: 'a', startFrame: 100 });
  assert.deepEqual(mainOrder(moved), ['b:0', 'c:30', 'a:60']);
  assert.equal(get(moved, 'title').startFrame, 5, 'title shifts once, not twice');
  assert.equal(get(moved, 'music').startFrame, 0);
  assert.deepEqual(reduce(before, { type: 'setFullState', state: planned.state }), planned.state);
  const deleted = reduce(before, { type: 'remove', id: 'b' });
  assert.deepEqual(mainOrder(deleted), ['a:0', 'c:30']);
  assert.ok(!deleted.items.some((item) => item.id === 'title'));
  const inserted = reduce(before, { type: 'add', item: clip('new', 0), startFrame: 31 });
  assert.deepEqual(mainOrder(inserted), ['a:0', 'new:30', 'b:60', 'c:90']);
  assert.equal(get(inserted, 'title').startFrame, 65);
  const trimmed = reduce(before, { type: 'retime', id: 'a', durationInFrames: 15 });
  assert.deepEqual(mainOrder(trimmed), ['a:0', 'b:15', 'c:45']);
  assert.equal(get(trimmed, 'title').startFrame, 20);
  assert.equal(get(trimmed, 'a').srcInFrame, 10);
  const childOnly = reduce(before, { type: 'move', id: 'title', startFrame: 40 });
  assert.deepEqual(mainOrder(childOnly), mainOrder(before));
  assert.equal(get(childOnly, 'title').startFrame, 40);
}

// New titles attach once. Split retargets only followers starting in the right
// fragment; subsequent right-fragment movement keeps that binding after reload.
{
  const before = initial();
  const text = reduce(before, { type: 'add', item: clip('new-title', 0, { kind: 'text', track: 'V2', durationInFrames: 5 }), startFrame: 50 });
  assert.equal(get(text, 'new-title').mainClipId, 'b');
  const split = reduce(text, { type: 'split', id: 'b', atFrame: 45, newId: 'b-right' });
  assert.equal(get(split, 'title').mainClipId, 'b');
  assert.equal(get(split, 'new-title').mainClipId, 'b-right');
  const reopened = JSON.parse(JSON.stringify(split)) as TimelineState;
  const moved = reduce(reopened, { type: 'move', id: 'b-right', startFrame: 200 });
  assert.equal(get(moved, 'new-title').startFrame, 80);
  assert.equal(get(moved, 'title').startFrame, 35);
  assert.equal(get(moved, 'b-right').srcInFrame, 25);
}

// Real commands + history: one visible gesture is one entry; rejected and
// stationary actions retain redo history and selection-only actions add none.
{
  const original = docFor(initial());
  let h: History = { past: [], present: original, future: [] };
  const commands = buildCommands((action) => { h = historyReduce(h, action); }, () => h.present);
  commands.moveItem('a', { startFrame: 100 });
  assert.equal(h.past.length, 1);
  assert.equal(get(activeTimeline(h.present), 'title').startFrame, 5);
  commands.undo();
  assert.deepEqual(h.present, original);
  const hWithRedo = h;
  commands.moveItem('a', { startFrame: 0 });
  commands.moveItem('missing', { startFrame: 0 });
  commands.setItemTiming('b', { durationInFrames: 30 });
  assert.equal(h, hWithRedo, 'no-op commands do not clear redo');
  commands.redo();
  assert.equal(h.past.length, 1);
  commands.removeItem('b');
  assert.equal(h.past.length, 2);
  assert.ok(!activeTimeline(h.present).items.some((item) => item.id === 'title'));
  commands.undo();
  assert.equal(get(activeTimeline(h.present), 'title').startFrame, 5);
  commands.undo();
  assert.deepEqual(h.present, original);
  commands.setItemTiming('a', { durationInFrames: 15 });
  assert.equal(h.past.length, 1);
  assert.equal(get(activeTimeline(h.present), 'b').startFrame, 15);
  commands.undo();
  const newId = commands.addTextClip({ track: 'V2', startFrame: 70, durationInFrames: 10, text: 'Chapter' });
  assert.equal(get(activeTimeline(h.present), newId).mainClipId, 'c');
  assert.equal(h.past.length, 1);
}

// Main/follower lock, invalid source range, and overlay collisions reject before
// a new history entry can be recorded; old project settings remain opt-in.
{
  const before = initial();
  before.tracks!.V2 = { kind: 'video', locked: true };
  const doc = docFor(before);
  let h: History = { past: [], present: doc, future: [] };
  const commands = buildCommands((action) => { h = historyReduce(h, action); }, () => h.present);
  commands.moveItem('a', { startFrame: 100 });
  commands.removeItem('b');
  commands.setItemTiming('a', { durationInFrames: 15 });
  assert.equal(h.present, doc);
  assert.equal(h.past.length, 0);
  const legacy = { ...initial(), interaction: undefined };
  const removed = reduce(legacy, { type: 'remove', id: 'b' });
  assert.equal(get(removed, 'c').startFrame, 60);
  assert.ok(removed.items.some((item) => item.id === 'title'));
  const noMagnet = { ...initial(), interaction: { mainTrackId: 'V1', magnet: false, linkage: true } };
  const noMagnetRemoved = reduce(noMagnet, { type: 'remove', id: 'b' });
  assert.equal(get(noMagnetRemoved, 'c').startFrame, 60);
  assert.ok(!noMagnetRemoved.items.some((item) => item.id === 'title'));
}

// The same magnetic group move must work through the public command API even
// when the dragged handle is the upper title, not the main video member.
{
  const state = initial();
  const title = get(state, 'title');
  title.startFrame = 5;
  title.mainClipId = 'a';
  state.linkGroups = [{ id: 'chapter', mode: 'group', anchorItemId: 'a', itemIds: ['a', 'title'] }];
  const original = docFor(state);
  let history: History = { past: [], present: original, future: [] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  commands.moveItem('title', { startFrame: 105 });
  assert.deepEqual(mainOrder(activeTimeline(history.present)), ['b:0', 'c:30', 'a:60']);
  assert.equal(get(activeTimeline(history.present), 'title').startFrame, 65);
  assert.equal(get(activeTimeline(history.present), 'music').startFrame, 0);
  assert.equal(history.past.length, 1);
  commands.undo();
  assert.deepEqual(history.present, original);
}

{
  const old = { ...initial(), id: 'migration', name: 'migration', order: 0 };
  old.items = old.items.map((item) => ({ ...item, startFrame: item.startFrame + 15 }));
  const reopened = normalizeTimelineTracks(old);
  assert.equal(reopened.interaction?.mainTrackId, reopened.items.find((item) => item.id === 'a')!.track, 'stable-track migration preserves explicit main identity');
  assert.equal(get(reopened, 'a').startFrame, 15, 'opening a magnetic document never packs it');
  assert.equal(get(reopened, 'title').mainClipId, 'b');
  assert.deepEqual(normalizeTimelineTracks(reopened), reopened);
  assert.equal(normalizeTimelineTracks({ ...old, interaction: undefined }).interaction, undefined, 'legacy preferences stay absent');
}
console.log('magnetic workflow: real reducer/commands, single linkage projection, split/reopen, locks and one-step history OK');
