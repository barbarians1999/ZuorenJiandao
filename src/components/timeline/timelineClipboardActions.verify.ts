import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import { activeTimeline, type ProjectDoc, type TimelineItem, type TimelineState } from '../../editor/types';
import { buildCommands } from '../../editor/storeCommandBuilder';
import { historyReduce } from '../../editor/reducerHistory';
import { applySelection, reduceSelection, selectionFromProject } from '../../editor/selectionState';
import { planClipPasteResult } from '../../editor/clipPaste';
import { createTimelineClipboardActions } from './timelineClipboardActions';
import type { ItemClipboard } from '../../shortcuts/timelineApi';

const video = (id: string, startFrame: number): TimelineItem => ({
  id, name: id, kind: 'video', src: `/${id}.mp4`, track: 'v', startFrame, durationInFrames: 100, srcInFrame: 20,
});
const title = (id: string, mainClipId: string, startFrame: number): TimelineItem => ({
  id, name: id, kind: 'text', props: { text: 'title' }, track: 'text', startFrame, durationInFrames: 30, mainClipId,
});
const initial: TimelineState = {
  fps: 30, width: 1920, height: 1080, items: [video('a', 0), video('b', 100), video('c', 200), title('b-title', 'b', 110)],
  tracks: { v: { kind: 'video' }, text: { kind: 'video' } }, trackOrder: ['text', 'v'],
  interaction: { mainTrackId: 'v', magnet: true, linkage: true }, selectedId: 'b-title', selectedIds: ['b', 'b-title'],
  linkGroups: [{ id: 'g', mode: 'group', anchorItemId: 'b', itemIds: ['b', 'b-title'] }],
};
let serial = 0;
const uid = (prefix: string) => `${prefix}_${++serial}`;
function harness(state: TimelineState) {
  const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main',
    timelines: [{ ...structuredClone(state), id: 'main', name: 'main', order: 0 }],
  };
  let history = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
  let selection = selectionFromProject(doc);
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present,
    (action) => { selection = reduceSelection(selection, history.present, action); });
  const clipboard: { current: ItemClipboard } = { current: null };
  const errors: string[] = [];
  const current = () => applySelection(activeTimeline(history.present), selection);
  const actions = (frame = 100) => createTimelineClipboardActions({
    state: current(), commands, clipboard, playhead: () => frame, uid, reportError: (error) => errors.push(error),
    copySelectedCaptions: () => false, pasteCaptionClipboard: () => false,
  });
  return { actions, current, commands, clipboard, errors, history: () => history, doc };
}

// Real shortcut operations -> production commands -> history reducer.
{
  const h = harness(initial);
  h.actions().copySelected();
  h.actions().pasteClipboard();
  assert.deepEqual(h.errors, []);
  assert.equal(h.history().past.length, 1);
  const added = h.current().items.filter((item) => !initial.items.some((old) => old.id === item.id));
  const parent = added.find((item) => item.kind === 'video')!;
  const child = added.find((item) => item.kind === 'text')!;
  assert.equal(parent.track, 'v', 'magnetic paste inserts on main, not a new conflict lane');
  assert.equal(parent.startFrame, 100);
  assert.equal(child.startFrame, 110);
  assert.equal(child.mainClipId, parent.id, 'copied child belongs to copied parent');
  assert.equal(h.current().items.find((item) => item.id === 'b')?.startFrame, 200);
  assert.equal(h.current().items.find((item) => item.id === 'b-title')?.startFrame, 210);
  assert.ok(h.current().linkGroups?.some((group) => group.id !== 'g' && group.itemIds.includes(parent.id) && group.itemIds.includes(child.id)));
  h.commands.undo();
  assert.deepEqual(h.history().present, h.doc, 'whole insert and directional followers undo together');
  h.commands.redo();
  assert.equal(h.current().items.length, 6);
}
{
  const h = harness(initial);
  h.actions().duplicateSelected();
  assert.deepEqual(h.errors, []);
  assert.equal(h.history().past.length, 1);
  const added = h.current().items.filter((item) => !initial.items.some((old) => old.id === item.id));
  const parent = added.find((item) => item.kind === 'video')!;
  const child = added.find((item) => item.kind === 'text')!;
  assert.equal(parent.startFrame, 200);
  assert.equal(child.startFrame - parent.startFrame, 10, 'duplicate preserves cross-track offsets');
  assert.equal(child.mainClipId, parent.id);
  assert.equal(h.current().items.find((item) => item.id === 'c')?.startFrame, 300);
}
for (const operation of ['cutSelected', 'deleteSelected'] as const) {
  const h = harness(initial);
  h.actions()[operation](false);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.current().items.map((item) => [item.id, item.startFrame]), [['a', 0], ['c', 100]]);
  assert.equal(h.history().past.length, 1, `${operation} has one atomic history entry`);
  h.commands.undo();
  assert.deepEqual(h.history().present, h.doc);
}
{
  const voice: TimelineItem = { id: 'voice', name: 'voice', kind: 'audio', src: '/voice.wav', track: 'audio', startFrame: 100, durationInFrames: 100 };
  const h = harness({ ...initial, items: [...initial.items, voice],
    tracks: { ...initial.tracks, audio: { kind: 'audio' } }, trackOrder: [...initial.trackOrder!, 'audio'],
    selectedId: 'b', selectedIds: ['b'],
    linkGroups: [{ id: 'av', mode: 'linked', itemIds: ['b', 'voice'], anchorItemId: 'b' }],
  });
  h.actions().cutSelected();
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.clipboard.current?.multi?.map((item) => item.id), ['b', 'b-title', 'voice'], 'single-main cut copies every removed title and linked audio');
  assert.equal(h.current().items.length, 2);
  h.actions(100).pasteClipboard();
  assert.deepEqual(h.errors, []);
  assert.equal(h.current().items.length, 5, 'cut/paste does not lose indirectly removed clips');
  const copiedParent = h.current().items.find((item) => item.name === 'b')!;
  const copiedTitle = h.current().items.find((item) => item.name === 'b-title')!;
  const copiedVoice = h.current().items.find((item) => item.name === 'voice')!;
  assert.equal(copiedTitle.mainClipId, copiedParent.id);
  assert.equal(copiedTitle.startFrame - copiedParent.startFrame, 10);
  assert.ok(h.current().linkGroups?.some((group) => group.mode === 'linked' && group.itemIds.includes(copiedParent.id) && group.itemIds.includes(copiedVoice.id)));
  assert.equal(h.history().past.length, 2, 'one cut plus one paste, not multiple follower edits');
}
{
  const h = harness({ ...initial, interaction: { ...initial.interaction, magnet: false } });
  h.actions().deleteSelected(true);
  assert.equal(h.current().items.find((item) => item.id === 'c')?.startFrame, 100, 'nonmagnetic explicit ripple still closes the gap');
}
{
  const h = harness({ ...initial, tracks: { ...initial.tracks, text: { kind: 'video', locked: true } } });
  h.actions().cutSelected();
  assert.equal(h.history().past.length, 0);
  assert.equal(h.clipboard.current, null, 'rejected cut does not replace clipboard');
  assert.equal(h.errors.length, 1);
  h.actions().copySelected();
  h.actions(0).pasteClipboard();
  assert.equal(h.history().past.length, 0, 'paste that would shift locked follower is rejected atomically');
}
{
  const sourceChild = title('orphan', 'b', 10);
  const target: TimelineState = { ...initial, selectedId: 'b-title', selectedIds: ['b-title'], interaction: { ...initial.interaction, linkage: false } };
  const result = planClipPasteResult(target, [sourceChild], target.tracks, 10, uid);
  assert.equal(result.error, undefined);
  assert.equal(result.state.items.at(-1)?.mainClipId, undefined, 'single child never retains the source draft parent id');
  const linked = planClipPasteResult({ ...target, interaction: { ...target.interaction, linkage: true } }, [sourceChild], target.tracks, 10, uid);
  assert.equal(linked.state.items.at(-1)?.mainClipId, 'a', 'new child may attach only under current creation rules');
  const noSelection = planClipPasteResult({ ...target, selectedId: null, selectedIds: [] }, [sourceChild], target.tracks, 10, uid);
  assert.equal(noSelection.error, undefined);
  assert.notEqual(noSelection.state.items.at(-1)?.track, 'v', 'a title never displaces main video merely because selection is empty');
}
{
  const source = [video('source', 0), title('source-title', 'source', 10)];
  const target = { ...initial, tracks: { main: { kind: 'video' as const } }, trackOrder: ['main'], items: [{ ...video('existing', 0), track: 'main' }],
    interaction: { ...initial.interaction, mainTrackId: 'main' }, selectedId: null, selectedIds: [], linkGroups: undefined };
  const result = planClipPasteResult(target, source, initial.tracks, 100, uid, { sourceMainTrackId: 'v' });
  assert.equal(result.error, undefined);
  const parent = result.state.items.find((item) => item.id !== 'existing' && item.kind === 'video')!;
  assert.equal(parent.track, 'main', 'source main track maps to target main across subdrafts');
  assert.equal(result.state.items.find((item) => item.kind === 'text')?.mainClipId, parent.id);
}
{
  const source = initial.items.filter((item) => item.id === 'b' || item.id === 'b-title');
  const result = planClipPasteResult({ ...initial, interaction: { ...initial.interaction, magnet: false } }, source, initial.tracks, 100, uid);
  assert.equal(result.error, undefined);
  const copiedParent = result.state.items.find((item) => item.name === 'b' && item.id !== 'b')!;
  const copiedTitle = result.state.items.find((item) => item.name === 'b-title' && item.id !== 'b-title')!;
  assert.notEqual(copiedParent.track, 'v', 'without magnet, an overlapping copy uses a new lane');
  assert.equal(copiedTitle.mainClipId, undefined, 'a copied overlay parent must not cause reattachment to unrelated main footage');
}
{
  const h = harness({ ...initial, linkGroups: undefined, selectedId: 'b-title', selectedIds: ['b-title'],
    items: [...initial.items, { ...title('next-title', 'c', 150), mainClipId: undefined }] });
  h.actions().deleteSelected(true);
  assert.equal(h.current().items.find((item) => item.id === 'next-title')?.startFrame, 120, 'explicit ripple on a side lane still closes its own gap with main magnet enabled');
  assert.equal(h.current().items.find((item) => item.id === 'b')?.startFrame, 100, 'title deletion never shifts its parent');
}
console.log('timelineClipboardActions.verify: ok (magnetic paste, atomic cut/delete/duplicate, cloned linkage and cross-draft safety)');
