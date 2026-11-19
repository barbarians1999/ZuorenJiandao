import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { migrateProjectDoc } from '../persist/projectStore';
import { groupTimelineItems, groupedItemIds, ungroupTimelineItems } from './linkGroups';
import { removeItemsFromState } from './multiSelect';
import { historyReduce, reduce } from './reduce';
import { projectReduce } from './reducerProject';
import { hasSharedNestedDrafts, timelineNavigationPath } from './timelineNavigation';
import type { ProjectDoc, Timeline, TimelineItem } from './types';

const item = (id: string, track: string, startFrame = 30): TimelineItem => ({
  id, name: id, kind: 'video', src: `/${id}.mp4`, track, startFrame,
  srcInFrame: 0, durationInFrames: 60,
});
const timeline = (id: string, items: TimelineItem[] = [], order = 0): Timeline => ({
  id, name: id, order, fps: 30, width: 1920, height: 1080, items,
  tracks: { v: { kind: 'video' }, overlay: { kind: 'video' } },
  trackOrder: ['overlay', 'v'], selectedId: null, selectedIds: [],
});
const document = (timelines: Timeline[], activeTimelineId = timelines[0]!.id): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], timelines, activeTimelineId,
});

const base = timeline('main', [item('video', 'v'), item('title', 'overlay', 40)]);
const grouped = groupTimelineItems(base, ['video', 'title'], 'group-1');
assert.equal(grouped.linkGroups?.[0]?.mode, 'group');
assert.deepEqual(groupedItemIds(grouped, ['title']), ['title', 'video']);
assert.equal(groupTimelineItems(grouped, ['video', 'title'], 'another-id'), grouped);
assert.equal(groupTimelineItems(base, ['video'], 'invalid'), base);
const locked = { ...base, tracks: { ...base.tracks, overlay: { kind: 'video' as const, locked: true } } };
assert.equal(groupTimelineItems(locked, ['video', 'title'], 'locked'), locked);

const moved = reduce(grouped, { type: 'move', id: 'video', startFrame: 50 });
assert.deepEqual(moved.items.map((clip) => clip.startFrame), [50, 60]);
const trimmed = reduce(grouped, { type: 'retime', id: 'video', startFrame: 35, durationInFrames: 55, srcInFrame: 5 });
assert.equal(trimmed.items.find((clip) => clip.id === 'title'), base.items[1], 'trim never retimes another ordinary group member');
const removedOne = reduce(grouped, { type: 'remove', id: 'video' });
assert.deepEqual(removedOne.items.map((clip) => clip.id), ['title'], 'ordinary groups do not become linked A/V deletion');
assert.equal(removeItemsFromState(grouped, groupedItemIds(grouped, ['video'])).items.length, 0, 'UI-selected group deletes as a unit');

const rippleBase = { ...grouped, items: [
  { ...item('preceding', 'v', 0), durationInFrames: 30 }, ...grouped.items,
] };
const ripple = reduce(rippleBase, { type: 'remove', id: 'preceding', ripple: true });
assert.equal(ripple.items.find((clip) => clip.id === 'video')?.startFrame, 0);
assert.equal(ripple.items.find((clip) => clip.id === 'title')?.startFrame, 40, 'ordinary group does not add sync-lock ripple propagation');

const doc = document([base]);
let history = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
history = historyReduce(history, { type: 'setFullState', state: grouped });
assert.equal(history.past.length, 1);
assert.equal(historyReduce(history, { type: 'undo' }).present, doc);
const ungrouped = ungroupTimelineItems(grouped, ['video']);
assert.equal(ungrouped.linkGroups, undefined);
assert.equal(ungroupTimelineItems(ungrouped, ['video']), ungrouped);
history = historyReduce(history, { type: 'setFullState', state: ungrouped });
assert.equal(history.past.length, 2);
assert.equal(historyReduce(history, { type: 'undo' }).present.timelines[0]?.linkGroups?.[0]?.mode, 'group');

const withLegacy = { ...grouped, linkGroups: [...grouped.linkGroups!, {
  id: 'legacy-linked', mode: 'linked' as const, itemIds: ['video', 'title'], anchorItemId: 'video',
}] };
assert.equal(ungroupTimelineItems(withLegacy, ['video']).linkGroups?.[0]?.mode, 'linked');
const reopened = migrateProjectDoc(JSON.parse(JSON.stringify(document([{ ...base, ...grouped }]))));
assert.ok(reopened);
assert.equal(reopened.timelines[0]?.linkGroups?.[0]?.mode, 'group', 'save/reopen preserves group mode');

const ref = (id: string, target: string): TimelineItem => ({
  id, name: id, kind: 'sequence', timelineId: target, track: 'v', startFrame: 0, durationInFrames: 90,
});
const root = timeline('root', [ref('nested', 'chapter')], 5);
const chapter = timeline('chapter', [ref('deep', 'detail')], 0);
const detail = timeline('detail', [item('content', 'v')], 1);
const other = timeline('other', [], 2);
const nestedDoc = document([chapter, detail, other, root], 'detail');
assert.deepEqual(timelineNavigationPath(nestedDoc, []), ['root', 'chapter', 'detail'], 'parent navigation follows edges, not array/order');
assert.deepEqual(timelineNavigationPath({ ...nestedDoc, activeTimelineId: 'chapter' }, ['root', 'chapter', 'detail']), ['root', 'chapter']);
assert.deepEqual(timelineNavigationPath({ ...nestedDoc, activeTimelineId: 'other' }, ['root', 'chapter']), ['other']);
const sharedDoc = { ...nestedDoc, timelines: [...nestedDoc.timelines, timeline('other-parent', [ref('shared', 'detail')])] };
assert.deepEqual(timelineNavigationPath(sharedDoc, []), ['detail'], 'shared child direct-open must not invent its parent');
assert.deepEqual(timelineNavigationPath(sharedDoc, ['root', 'chapter']), ['root', 'chapter', 'detail']);
assert.deepEqual(timelineNavigationPath({ ...nestedDoc, timelines: [detail, other] }, ['root', 'chapter']), ['detail'], 'deleted parent does not remain in session breadcrumb');

assert.ok(hasSharedNestedDrafts(nestedDoc, 'root'));
assert.ok(!hasSharedNestedDrafts(nestedDoc, 'detail'));
const duplicated = projectReduce(nestedDoc, { type: 'tl.duplicate', id: 'root', newId: 'copy', name: 'copy' });
assert.equal(duplicated.timelines.find((entry) => entry.id === 'copy')?.items[0]?.timelineId, 'chapter', 'copy wording must disclose shared nested drafts');
console.log('groupWorkflow.verify: ok (ordinary move groups, independent trim, undo/reopen and actual parent navigation)');
