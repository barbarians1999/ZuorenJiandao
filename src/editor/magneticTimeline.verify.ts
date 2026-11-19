import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce, type History } from './reducerHistory';
import type { ProjectDoc, TimelineItem, TimelineState } from './types';
import {
  attachToMainClip, mainTrackId, planDirectionalChange,
  planMagneticDelete, planMagneticInsert, planMagneticMove, planMagneticTrim,
} from './magneticTimeline';

const clip = (id: string, startFrame: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id, startFrame, track: 'V1', durationInFrames: 30, kind: 'video', name: id,
  src: `/${id}.mp4`, srcInFrame: 12.5, ...patch,
});
const base = (patch: Partial<TimelineState> = {}): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V2', 'V1', 'A1'], tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [clip('a', 0), clip('b', 30), clip('c', 60)],
  interaction: { mainTrackId: 'V1', magnet: true, linkage: true },
  ...patch,
});
const get = (state: TimelineState, id: string) => {
  const item = state.items.find((candidate) => candidate.id === id);
  assert.ok(item, `missing ${id}`);
  return item;
};
const order = (state: TimelineState) => state.items.filter((item) => item.track === mainTrackId(state))
  .toSorted((a, b) => a.startFrame - b.startFrame).map((item) => `${item.id}:${item.startFrame}`);

// Main identity follows the actual bottom lane, not an alias that is a stable id.
assert.equal(mainTrackId(base({ interaction: undefined, trackOrder: ['V1', 'V2', 'A1'] })), 'V2');
assert.equal(mainTrackId(base({ trackOrder: ['V1', 'V2', 'A1'] })), 'V1');
assert.equal(mainTrackId(base({ interaction: { mainTrackId: 'missing' } })), 'V1');
assert.equal(mainTrackId(base({ items: [], trackOrder: ['A1'], tracks: { A1: { kind: 'audio' } } })), null);
assert.equal(
  mainTrackId(base({
    interaction: undefined,
    trackOrder: ['V1', 'E1', 'T1', 'A1'],
    tracks: {
      V1: { kind: 'video' },
      E1: { kind: 'video', visualRole: 'effect' },
      T1: { kind: 'video', visualRole: 'text' },
      A1: { kind: 'audio' },
    },
  })),
  'V1',
);

// Reordering packs once, keeps every source window/effect and supports multi-select.
{
  const before = base();
  const moved = planMagneticMove(before, ['a'], 'a', 999);
  assert.equal(moved.error, undefined);
  assert.deepEqual(order(moved.state), ['b:0', 'c:30', 'a:60']);
  assert.equal(moved.insertionFrame, 60);
  for (const item of before.items) {
    assert.equal(get(moved.state, item.id).srcInFrame, item.srcInFrame);
    assert.equal(get(moved.state, item.id).durationInFrames, item.durationInFrames);
    assert.equal(get(moved.state, item.id).src, item.src);
  }
  assert.deepEqual(order(planMagneticMove(before, ['b'], 'b', 0).state), ['b:0', 'a:30', 'c:60']);
  assert.deepEqual(order(planMagneticMove(before, ['b', 'c'], 'c', 0).state), ['b:0', 'c:30', 'a:60']);
  assert.equal(planMagneticMove(before, ['b'], 'b', 30).state, before);
  assert.equal(planMagneticMove(before, ['b'], 'b', NaN).state, before);
  assert.equal(planMagneticMove(before, ['missing'], 'missing', 0).state, before);
  assert.deepEqual(order(before), ['a:0', 'b:30', 'c:60'], 'pure plan must not mutate the input');
}

// Insert at a shown boundary; no source overwrites; deletion closes the main gap.
{
  const before = base();
  const inserted = planMagneticInsert(before, [clip('x', 0), clip('y', 30)], 31);
  assert.equal(inserted.error, undefined);
  assert.equal(inserted.insertionFrame, 30);
  assert.deepEqual(order(inserted.state), ['a:0', 'x:30', 'y:60', 'b:90', 'c:120']);
  assert.deepEqual(inserted.state.selectedIds, ['x', 'y']);
  assert.deepEqual(order(planMagneticDelete(before, ['b']).state), ['a:0', 'c:30']);
  assert.deepEqual(order(planMagneticDelete(before, ['a', 'c']).state), ['b:0']);
  assert.equal(planMagneticDelete(before, ['missing']).state, before);
  assert.equal(planMagneticInsert(before, [clip('a', 0)], 0).state, before);
  assert.equal(planMagneticInsert(before, [clip('x', 0, { kind: 'audio' })], 0).state, before);
  assert.equal(planMagneticInsert(before, [clip('x', 0)], Infinity).state, before);
}

// Existing gaps are untouched just by enabling the feature; an intentional main
// edit compacts the entire main lane. Editing a secondary lane never compacts it.
{
  const before = base({ items: [clip('a', 30), clip('b', 90), clip('t', 180, { track: 'V2', kind: 'text' })] });
  assert.equal(planMagneticMove(before, ['b'], 'b', 90).state, before, 'click without movement never closes legacy gaps');
  const secondary = planMagneticMove(before, ['t'], 't', 190);
  assert.deepEqual(order(secondary.state), ['a:30', 'b:90']);
  assert.deepEqual(order(planMagneticDelete(before, ['a']).state), ['b:0']);
  const exiting = planMagneticMove(base(), ['b'], 'b', 100, 'V2');
  assert.equal(exiting.error, undefined);
  assert.deepEqual(order(exiting.state), ['a:0', 'c:30']);
  assert.equal(get(exiting.state, 'b').track, 'V2');
  assert.equal(get(exiting.state, 'b').startFrame, 100);
}

// Directional linkage is explicit. A title follows the main clip; moving the
// title doesn't move the video. Music is excluded unless the user opts it in.
{
  const title = clip('title', 35, { track: 'V2', kind: 'text', durationInFrames: 10, mainClipId: 'b' });
  const music = clip('music', 0, { track: 'A1', kind: 'audio', durationInFrames: 200, mainClipId: 'b' });
  const unbound = clip('unbound', 100, { track: 'V2', kind: 'text', durationInFrames: 10 });
  const before = base({ items: [...base().items, title, music, unbound] });
  const moved = planMagneticMove(before, ['a'], 'a', 999);
  assert.equal(moved.error, undefined);
  assert.equal(get(moved.state, 'title').startFrame, 5);
  assert.equal(get(moved.state, 'music').startFrame, 0);
  assert.equal(get(moved.state, 'unbound').startFrame, 100);
  const childMoved = planMagneticMove(before, ['title'], 'title', 45);
  assert.equal(childMoved.error, undefined);
  assert.equal(get(childMoved.state, 'title').startFrame, 45);
  assert.deepEqual(order(childMoved.state), order(before));
  const removed = planMagneticDelete(before, ['b']);
  assert.equal(removed.error, undefined);
  assert.ok(!removed.state.items.some((item) => item.id === 'title'));
  assert.equal(get(removed.state, 'music').startFrame, 0);
  assert.equal(get(removed.state, 'music').mainClipId, undefined, 'excluded music detaches when parent is deleted');
  assert.deepEqual(order(planMagneticDelete(before, ['title']).state), order(before));
  assert.equal(attachToMainClip(before, clip('new', 31, { track: 'V2', kind: 'text' })).mainClipId, 'b');
  assert.equal(attachToMainClip(before, clip('new', 30, { track: 'V2', kind: 'text' })).mainClipId, 'b', 'cut uses right-open ownership');
  assert.equal(attachToMainClip(before, clip('new', 95, { track: 'V2', kind: 'text' })).mainClipId, undefined);
  assert.equal(attachToMainClip(before, clip('new', 31, { track: 'A1', kind: 'audio' })).mainClipId, undefined);
  const audioOn = { ...before, interaction: { ...before.interaction, linkedKinds: ['audio' as const] } };
  const audioPlan = planMagneticMove(audioOn, ['a'], 'a', 999);
  assert.equal(audioPlan.state, audioOn, 'audio extending before zero rejects, not clipped');
  assert.match(audioPlan.error!, /移出时间线/);
}

// Linkage is independently useful with magnet OFF; old projects preserve gaps.
{
  const before = base({ interaction: { linkage: true, magnet: false }, items: [
    clip('a', 10), clip('b', 100), clip('t', 15, { track: 'V2', kind: 'text', mainClipId: 'a' }),
  ] });
  const moved = planMagneticMove(before, ['a'], 'a', 30);
  assert.equal(moved.error, undefined);
  assert.equal(get(moved.state, 't').startFrame, 35);
  assert.equal(get(moved.state, 'b').startFrame, 100);
  assert.equal(get(planMagneticDelete(before, ['a']).state, 'b').startFrame, 100);
  const legacy = { ...before, interaction: undefined };
  assert.equal(get(planMagneticMove(legacy, ['a'], 'a', 30).state, 't').startFrame, 15);
  assert.equal(get(planMagneticInsert(legacy, [clip('new', 0)], 50).state, 'new').startFrame, 50);
}

// Locked main/followers and overlap failures are atomic and actionable.
{
  const lockedMain = base({ tracks: { ...base().tracks, V1: { kind: 'video', locked: true } } });
  for (const plan of [planMagneticMove(lockedMain, ['a'], 'a', 99), planMagneticDelete(lockedMain, ['b']),
    planMagneticInsert(lockedMain, [clip('x', 0)], 30), planMagneticTrim(lockedMain, 'a', { durationInFrames: 15 })]) {
    assert.equal(plan.state, lockedMain);
    assert.ok(plan.error);
  }
  const follower = clip('t', 35, { track: 'V2', kind: 'text', durationInFrames: 10, mainClipId: 'b' });
  const lockedChild = base({ items: [...base().items, follower], tracks: { ...base().tracks, V2: { locked: true } } });
  assert.equal(planMagneticMove(lockedChild, ['a'], 'a', 99).state, lockedChild);
  assert.equal(planMagneticDelete(lockedChild, ['b']).state, lockedChild);
  const overlapping = base({ items: [...base().items, follower, clip('obstacle', 0, { track: 'V2', durationInFrames: 10 })] });
  const plan = planMagneticMove(overlapping, ['a'], 'a', 99);
  assert.equal(plan.state, overlapping);
  assert.match(plan.error!, /重叠/);
}

// Existing linked and sync-lock rules survive, conflicting main constraints reject.
{
  const audio = clip('voice', 30, { track: 'A1', kind: 'audio' });
  const before = base({ items: [...base().items, audio], linkGroups: [{ id: 'av', mode: 'linked', anchorItemId: 'b', itemIds: ['b', 'voice'] }] });
  assert.equal(get(planMagneticMove(before, ['b'], 'b', 0).state, 'voice').startFrame, 0);
  assert.ok(!planMagneticDelete(before, ['b']).state.items.some((item) => item.id === 'voice'));
  const sync = { ...before, linkGroups: [{ id: 'sync', mode: 'sync-lock' as const, anchorItemId: 'a', itemIds: ['a', 'b'] }] };
  assert.deepEqual(order(planMagneticMove(sync, ['a'], 'a', 99).state), ['c:0', 'a:30', 'b:60']);
  assert.equal(planMagneticInsert(sync, [clip('x', 0)], 30).state, sync, 'inserting within sync-locked main clips rejects a differential shift');
  const synchronizedAudio = { ...before, linkGroups: [{ ...before.linkGroups![0]!, mode: 'sync-lock' as const }] };
  assert.equal(get(planMagneticDelete(synchronizedAudio, ['a']).state, 'voice').startFrame, 0);
  const grouped = { ...before, linkGroups: [{ ...before.linkGroups![0]!, mode: 'group' as const }] };
  assert.equal(get(planMagneticMove(grouped, ['b'], 'b', 0).state, 'voice').startFrame, 0, 'explicit group drag moves together');
  assert.equal(get(planMagneticDelete(grouped, ['a']).state, 'voice').startFrame, 30, 'ordinary group is not an implicit ripple/sync lock');
  assert.equal(get(planMagneticTrim(grouped, 'b', { durationInFrames: 15 }).state, 'voice').durationInFrames, 30, 'ordinary group does not couple source trims');
  const spacedGroup = base({ linkGroups: [{ id: 'g', mode: 'group', anchorItemId: 'a', itemIds: ['a', 'c'] }] });
  assert.equal(planMagneticMove(spacedGroup, ['a'], 'a', 90).state, spacedGroup, 'direct group move never silently crushes group spacing');
  const titleHandle = base({ items: [...base().items, clip('handle', 5, { kind: 'text', track: 'V2', durationInFrames: 10, mainClipId: 'a' })],
    linkGroups: [{ id: 'g', mode: 'group', anchorItemId: 'a', itemIds: ['a', 'handle'] }] });
  const fromTitle = planMagneticMove(titleHandle, ['handle'], 'handle', 105);
  assert.equal(fromTitle.error, undefined);
  assert.deepEqual(order(fromTitle.state), ['b:0', 'c:30', 'a:60']);
  assert.equal(get(fromTitle.state, 'handle').startFrame, 65, 'grab offset follows actual main insertion, not raw pointer');
  assert.equal(fromTitle.insertionFrame, 65);
  const multiLane = { ...titleHandle, linkGroups: undefined };
  const fromExplicitTitle = planMagneticMove(multiLane, ['a', 'handle'], 'handle', 105);
  assert.equal(fromExplicitTitle.error, undefined);
  assert.deepEqual(order(fromExplicitTitle.state), ['b:0', 'c:30', 'a:60']);
  assert.equal(get(fromExplicitTitle.state, 'handle').startFrame, 65);
}

// Trims preserve source-domain values/rates and compensate linked A/V left edges.
{
  const before = base({ items: [clip('a', 0, { srcInFrame: 10, playbackRate: 2 }), clip('b', 30), clip('c', 60),
    clip('voice', 0, { track: 'A1', kind: 'audio', srcInFrame: 20, playbackRate: 1 }),
    clip('t', 3, { track: 'V2', kind: 'text', durationInFrames: 5, mainClipId: 'a' })],
  linkGroups: [{ id: 'av', mode: 'linked', anchorItemId: 'a', itemIds: ['a', 'voice'] }] });
  const trimmed = planMagneticTrim(before, 'a', { startFrame: 10, durationInFrames: 20, srcInFrame: 30 });
  assert.equal(trimmed.error, undefined);
  assert.deepEqual(order(trimmed.state), ['a:0', 'b:20', 'c:50']);
  assert.equal(get(trimmed.state, 'a').srcInFrame, 30);
  assert.equal(get(trimmed.state, 'voice').srcInFrame, 30);
  assert.equal(get(trimmed.state, 'voice').startFrame, 0);
  assert.equal(get(trimmed.state, 't').startFrame, 3);
  assert.equal(planMagneticTrim(before, 'a', { durationInFrames: 30 }).state, before);
  assert.equal(planMagneticTrim(before, 'a', { durationInFrames: Infinity }).state, before);
  const bounded = base({ assets: [{ id: 'source', kind: 'video', name: 'a', src: '/a.mp4', durationInFrames: 50 }] });
  assert.equal(get(planMagneticTrim(bounded, 'a', { durationInFrames: 100 }).state, 'a').durationInFrames, 37);
}

// References clean up without moving manual caption cues; one commit = one undo.
{
  const before = base({ transitions: [
    { id: 'ab', type: 'cross-dissolve', durationInFrames: 8, outgoingItemId: 'a', incomingItemId: 'b', trackId: 'V1' },
  ], captions: { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: 'b', sources: ['b', 'c'] } });
  const removed = planMagneticDelete(before, ['b']).state;
  assert.equal(removed.transitions?.length, 0);
  assert.deepEqual(removed.captions?.sources, ['c']);
  assert.equal(removed.captions?.sourceItemId, undefined);
  const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main',
    timelines: [{ ...before, id: 'main', name: 'Main', order: 0 }] };
  const initial: History = { past: [], present: doc, future: [] };
  const saved = historyReduce(initial, { type: 'setFullState', state: removed });
  assert.equal(saved.past.length, 1);
  assert.deepEqual(historyReduce(saved, { type: 'undo' }).present, doc);
  assert.deepEqual(historyReduce(historyReduce(saved, { type: 'undo' }), { type: 'redo' }).present, saved.present);
  const reopened = JSON.parse(JSON.stringify(saved.present)) as ProjectDoc;
  assert.deepEqual(order(reopened.timelines[0]!), ['a:0', 'c:30']);
  assert.equal(reopened.timelines[0]!.interaction?.magnet, true);
  assert.equal(planDirectionalChange(before, before).state, before);
}

console.log('magnetic timeline: main reorder/insert/delete/trim, directional linkage, locks, source limits, references and atomic history OK');
