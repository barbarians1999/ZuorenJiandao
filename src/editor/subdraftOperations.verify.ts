import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { migrateProjectDoc } from '../persist/projectStore';
import { compositionPlan } from './compositionPlan';
import { appearanceAt } from './clipFade';
import { historyReduce, type History } from './reduce';
import { buildCommands } from './storeCommandBuilder';
import { planExpandSubdraft, planIndependentSubdraft, type SubdraftOperation } from './subdraftOperations';
import { sourceFrameAt } from './sourceLimit';
import { applySelection, reduceSelection, selectionFromProject } from './selectionState';
import { activeTimeline, type ProjectDoc, type Timeline, type TimelineItem } from './types';

const video = (id: string, track: string, startFrame = 0, durationInFrames = 90): TimelineItem => ({
  id, name: id, track, startFrame, durationInFrames, kind: 'video', src: '/media/shared.mp4',
  sourceAssetId: 'media', srcInFrame: 15,
});
const sequence = (id: string, timelineId: string, startFrame = 30, durationInFrames = 180): TimelineItem => ({
  id, name: id, kind: 'sequence', timelineId, track: 'v', startFrame, durationInFrames, srcInFrame: 0,
});
const timeline = (id: string, items: TimelineItem[], order = 0): Timeline => ({
  id, name: id, order, fps: 30, width: 1920, height: 1080, items, selectedId: null, selectedIds: [],
  trackOrder: ['top', 'v', 'a'], tracks: { top: { kind: 'video' }, v: { kind: 'video' }, a: { kind: 'audio' } },
  interaction: { mainTrackId: 'v', magnet: true, linkage: true },
});
const document = (...timelines: Timeline[]): ProjectDoc => ({ version: CURRENT_PROJECT_VERSION,
  activeTimelineId: timelines[0]!.id, timelines, mediaFolders: [],
  assets: [{ id: 'media', kind: 'video', name: 'shared', src: '/media/shared.mp4', durationInFrames: 900 }],
});
const factory = () => { let counter = 0; return (prefix: string) => `${prefix}-new-${++counter}`; };
const success = (result: SubdraftOperation) => { assert.ok(result.ok, result.ok ? '' : result.error); return result; };
const rejected = (result: SubdraftOperation, pattern: RegExp) => { assert.ok(!result.ok); assert.match(result.error, pattern); };

const leaf = timeline('leaf', [video('source', 'v')], 2);
leaf.items[0]!.props = { nested: { label: 'original' } };
leaf.markers = [{ id: 'mark', scope: 'item', itemId: 'source', fromFrame: 5, durationFrames: 0, note: 'keep', color: 'red' }];
const chapter = timeline('chapter', [sequence('one', 'leaf', 0, 90), sequence('two', 'leaf', 90, 90)], 1);
const root = timeline('main', [sequence('instance', 'chapter'), sequence('shared-instance', 'chapter', 210)]);
const doc = document(root, chapter, leaf);
const before = JSON.stringify(doc);
const independent = success(planIndependentSubdraft(doc, 'instance', factory()));
assert.equal(JSON.stringify(doc), before, 'planner never mutates original document');
assert.equal(independent.doc.assets, doc.assets, 'independent editing does not copy media');
assert.equal(independent.doc.timelines.length, 5, 'shared leaf copied only once');
const copiedChapter = independent.doc.timelines.find((entry) => entry.id === independent.timelineId)!;
assert.notEqual(copiedChapter.id, chapter.id);
assert.equal(copiedChapter.items[0]!.timelineId, copiedChapter.items[1]!.timelineId, 'copied DAG retains internal sharing');
assert.notEqual(copiedChapter.items[0]!.timelineId, leaf.id);
assert.equal(activeTimeline(independent.doc).items[1]!.timelineId, chapter.id, 'other instance is untouched');
const copiedLeaf = independent.doc.timelines.find((entry) => entry.id === copiedChapter.items[0]!.timelineId)!;
assert.equal(copiedLeaf.markers?.[0]?.itemId, copiedLeaf.items[0]?.id);
assert.equal(copiedLeaf.items[0]?.src, leaf.items[0]?.src);
assert.notEqual(copiedLeaf.items[0]?.props, leaf.items[0]?.props, 'mutable props do not alias original draft');

function commitAndUndo(original: ProjectDoc, planned: Extract<SubdraftOperation, { ok: true }>) {
  let history: History = { past: [], present: original, future: [] };
  let selection = selectionFromProject(original);
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present,
    (action) => { selection = reduceSelection(selection, history.present, action); });
  commands.applyDoc(planned.doc);
  commands.selectItems(planned.itemIds);
  assert.deepEqual(applySelection(activeTimeline(history.present), selection).selectedIds, planned.itemIds);
  assert.equal(history.past.length, 1, 'one menu operation is one history entry');
  const changed = history.present;
  commands.undo();
  assert.equal(history.present, original, 'undo restores all tracks and nested references');
  commands.redo();
  assert.equal(history.present, changed);
  const reopened = migrateProjectDoc(JSON.parse(JSON.stringify(history.present)));
  assert.ok(reopened);
  assert.deepEqual(reopened.timelines.map((entry) => entry.items.map((clip) => clip.timelineId)),
    history.present.timelines.map((entry) => entry.items.map((clip) => clip.timelineId)));
}
commitAndUndo(doc, independent);

const title: TimelineItem = { id: 'title', name: 'title', kind: 'text', track: 'top', startFrame: 20, durationInFrames: 50,
  props: { text: 'chapter', entrance: 'none', exit: 'none' }, mainClipId: 'first' };
const music = { ...video('music', 'a', 0, 180), kind: 'audio' as const, volume: 0.3 };
const child = timeline('draft', [video('first', 'v'), video('second', 'v', 90), title, music], 1);
child.items[0] = { ...child.items[0]!, transform: { scale: 1.1, crop: { left: 0.04 } },
  mask: { type: 'rectangle', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.02 },
  keyframes: { x: [{ frame: 0, value: -2 }, { frame: 89, value: 3 }] },
  props: { visualEntrance: 'push-left', visualEntranceFrames: 12 }, fadeOutFrames: 5 };
child.linkGroups = [{ id: 'inner-group', mode: 'group', itemIds: ['first', 'title'], anchorItemId: 'first' }];
child.transitions = [{ id: 'dissolve', type: 'cross-dissolve', durationInFrames: 12,
  outgoingItemId: 'first', incomingItemId: 'second', trackId: 'v' }];
child.markers = [{ id: 'inner-note', scope: 'item', itemId: 'title', fromFrame: 30, durationFrames: 0, note: 'text', color: 'red' }];
const parent = timeline('main', [sequence('instance', 'draft'), { ...video('outer', 'top', 40, 20), mainClipId: 'instance' }]);
parent.linkGroups = [{ id: 'outer-group', mode: 'group', itemIds: ['instance', 'outer'], anchorItemId: 'instance' }];
const wholeDoc = document(parent, child);
const expanded = success(planExpandSubdraft(wholeDoc, 'instance', factory()));
const flat = activeTimeline(expanded.doc);
const named = (name: string) => flat.items.find((entry) => entry.name === name)!;
assert.equal(expanded.doc.timelines[1], child, 'source draft remains reusable');
assert.equal(flat.items.length, 5);
assert.equal(named('first').track, 'v');
assert.equal(named('first').startFrame, 30);
assert.equal(named('second').startFrame, 120);
assert.equal(named('title').startFrame, 50);
assert.equal(named('title').mainClipId, named('first').id);
assert.equal(named('outer').mainClipId, named('first').id);
assert.equal(named('music').volume, 0.3);
for (const frame of [0, 10, 45, 89]) assert.deepEqual(
  appearanceAt(named('first'), frame, false, { width: 1920, height: 1080 }),
  appearanceAt(child.items[0]!, frame, false, { width: 1920, height: 1080 }),
  'whole internal clip keeps animation, fade, transform, crop and mask at the same local frame');
assert.equal(flat.interaction?.magnet, true, 'expand does not repack authored timing');
assert.deepEqual(compositionPlan(flat).ordered.map((entry) => entry.name), ['first', 'second', 'title', 'outer'], 'nested layers stay between bottom content and outer overlay');
assert.equal(flat.transitions?.[0]?.incomingItemId, named('second').id);
assert.equal(flat.transitions?.[0]?.outgoingItemId, named('first').id);
assert.equal(flat.markers?.[0]?.itemId, named('title').id);
assert.equal(flat.markers?.[0]?.fromFrame, 60, 'item marker frames are timeline-absolute, not item-local');
assert.ok(flat.linkGroups?.some((group) => group.itemIds.includes(named('title').id) && group.itemIds.includes(named('first').id)));
commitAndUndo(wholeDoc, expanded);

const intersectingOuter = { ...video('outer', 'top', 114, 12), mainClipId: undefined };
const glChild = { ...child, transitions: [{ ...child.transitions![0]!, type: 'mosaic-reveal' as const }] };
rejected(planExpandSubdraft(document({ ...parent, items: [parent.items[0]!, intersectingOuter] }, glChild),
  'instance', factory()), /遮挡/);
rejected(planExpandSubdraft(document({ ...parent, tracks: { ...parent.tracks, v: { kind: 'video', hidden: true } } }, glChild),
  'instance', factory()), /隐藏/);
const reuseChild = timeline('reused', [video('run-a', 'v', 0, 90),
  { ...video('run-b', 'v', 90, 90), srcInFrame: 105 }], 1);
const lowerParent = timeline('main', [{ ...sequence('instance', 'reused'), track: 'top' },
  { ...video('lower-picture', 'v', 40, 30), mainClipId: undefined }]);
rejected(planExpandSubdraft(document(lowerParent, reuseChild), 'instance', factory()), /叠放/);

const croppedChild = timeline('draft', [
  { ...video('fast', 'v', 0, 100), playbackRate: 2 }, video('next', 'v', 100, 100),
  { ...music, durationInFrames: 200 },
], 1);
const croppedParent = timeline('main', [{ ...sequence('instance', 'draft', 50, 80), srcInFrame: 60 }]);
const croppedDoc = document(croppedParent, croppedChild);
const cropped = success(planExpandSubdraft(croppedDoc, 'instance', factory()));
const croppedItems = activeTimeline(cropped.doc).items;
assert.deepEqual(croppedItems.filter((entry) => entry.kind === 'video').map((entry) => [entry.startFrame, entry.durationInFrames, entry.srcInFrame]),
  [[50, 40, 135], [90, 40, 15]], 'cropped source window respects internal speed and cut point');
for (const frame of [0, 39, 40, 79]) {
  const old = croppedChild.items.find((entry) => entry.track === 'v' && 60 + frame >= entry.startFrame && 60 + frame < entry.startFrame + entry.durationInFrames)!;
  const current = croppedItems.find((entry) => entry.track === 'v' && 50 + frame >= entry.startFrame && 50 + frame < entry.startFrame + entry.durationInFrames)!;
  assert.equal(sourceFrameAt(current, 50 + frame - current.startFrame), sourceFrameAt(old, 60 + frame - old.startFrame));
}
commitAndUndo(croppedDoc, cropped);
assert.equal(JSON.stringify(doc), before);

const changeInstance = (patch: Partial<TimelineItem>) => document({ ...croppedParent, items: [{ ...croppedParent.items[0]!, ...patch }] }, croppedChild);
rejected(planExpandSubdraft(changeInstance({ playbackRate: 2 }), 'instance', factory()), /速度/);
rejected(planExpandSubdraft(changeInstance({ transform: { scale: 1.2 } }), 'instance', factory()), /整体/);
rejected(planExpandSubdraft(changeInstance({ srcInFrame: 150 }), 'instance', factory()), /越界/);
rejected(planExpandSubdraft(document(croppedParent, { ...croppedChild, items: croppedChild.items.map((entry) => ({ ...entry, fadeInFrames: 5 })) }), 'instance', factory()), /动画/);
rejected(planExpandSubdraft(document(croppedParent, { ...croppedChild, transitions: [{ ...child.transitions![0]!, outgoingItemId: 'fast', incomingItemId: 'next' }] }), 'instance', factory()), /转场/);
rejected(planExpandSubdraft(document({ ...parent, items: parent.items.map((entry) => entry.name === 'outer' ? { ...entry, durationInFrames: 100 } : entry) }, child), 'instance', factory()), /跟随/);
const locked = document({ ...root, tracks: { ...root.tracks, v: { kind: 'video', locked: true } } }, chapter, leaf);
rejected(planIndependentSubdraft(locked, 'instance', factory()), /解锁/);
rejected(planExpandSubdraft(locked, 'instance', factory()), /解锁/);
const muted = success(planExpandSubdraft(document({ ...parent, tracks: { ...parent.tracks, v: { kind: 'video', muted: true } } }, child), 'instance', factory()));
assert.ok(activeTimeline(muted.doc).tracks?.[activeTimeline(muted.doc).items.find((entry) => entry.name === 'music')!.track]?.muted);
console.log('subdraftOperations.verify: ok (deep independent DAG, full/cropped expansion, source frames, stacking, sound, links, saved data and one-step undo)');
