import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import { activeEditorState, type ProjectDoc, type TimelineItem, type TimelineState } from '../../editor/types';
import { buildCommands } from '../../editor/storeCommandBuilder';
import { historyReduce, type History } from '../../editor/reducerHistory';
import { sourceFrameAt } from '../../editor/sourceLimit';
import { commitTimelineDragGesture, planTimelineMagneticTrim } from './timelineDragCommit';
import { moveSelectionToNewTrack } from './newTrackMove';
import type { Drag } from './timelineUtil';

const clip = (id: string, startFrame: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id, name: id, kind: 'video', track: 'V1', src: `/${id}.mp4`, startFrame,
  durationInFrames: 30, srcInFrame: 10, ...patch,
});
const initial = (): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: 'a', selectedIds: ['a'],
  interaction: { mainTrackId: 'V1', magnet: true, linkage: true },
  trackOrder: ['V2', 'V1', 'A1'], tracks: { V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [clip('a', 0), clip('b', 30), clip('c', 60),
    clip('title', 35, { kind: 'text', track: 'V2', durationInFrames: 10, mainClipId: 'b' }),
    clip('music', 0, { kind: 'audio', track: 'A1', durationInFrames: 200 })],
});
const get = (state: TimelineState, id: string) => {
  const item = state.items.find((candidate) => candidate.id === id);
  assert.ok(item, `missing ${id}`);
  return item;
};
function store(state = initial()) {
  const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main',
    timelines: [{ ...state, id: 'main', name: 'Main', order: 0 }] };
  let history: History = { past: [], present: doc, future: [] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  return { commands, state: () => activeEditorState(history.present), history: () => history };
}
const drag = (state: TimelineState, id: string, mode: 'trim-left' | 'trim-right', deltaF: number): Drag => {
  const item = get(state, id);
  return { id, mode, baseStart: item.startFrame, baseDur: item.durationInFrames, baseSrcIn: item.srcInFrame ?? 0,
    baseTrack: item.track, targetTrack: item.track, startX: 0, deltaF, snapAt: null };
};
const content = (state: TimelineState) => ({ items: state.items, tracks: state.tracks, trackOrder: state.trackOrder,
  transitions: state.transitions, captions: state.captions, interaction: state.interaction });

// Right-edge preview shows downstream movement immediately; release uses that
// exact plan through the production commands/reducer and one history entry.
{
  const editor = store();
  const before = editor.state();
  const gesture = drag(before, 'a', 'trim-right', 15);
  const preview = planTimelineMagneticTrim(before, gesture, 'selection');
  assert.ok(preview);
  assert.equal(preview.error, undefined);
  assert.equal(get(preview.state, 'a').durationInFrames, 45);
  assert.equal(get(preview.state, 'b').startFrame, 45);
  assert.equal(get(preview.state, 'c').startFrame, 75);
  assert.equal(get(preview.state, 'title').startFrame, 50);
  commitTimelineDragGesture(before, editor.commands, gesture, 'selection');
  assert.deepEqual(content(editor.state()), content(preview.state));
  assert.equal(editor.history().past.length, 1);
  assert.equal(get(editor.state(), 'music').startFrame, 0);
  editor.commands.undo();
  assert.deepEqual(content(editor.state()), content(before));
  editor.commands.redo();
  assert.deepEqual(content(editor.state()), content(preview.state));
}

// Left trim keeps the magnetic timeline anchor at zero, advancing only its
// source in-point and closing the gap. Preview must not show a displaced A.
{
  const editor = store();
  const before = editor.state();
  const gesture = drag(before, 'a', 'trim-left', 10);
  const preview = planTimelineMagneticTrim(before, gesture, 'selection');
  assert.ok(preview);
  assert.equal(preview.error, undefined);
  assert.equal(get(preview.state, 'a').startFrame, 0);
  assert.equal(get(preview.state, 'a').durationInFrames, 20);
  assert.equal(get(preview.state, 'a').srcInFrame, 20);
  assert.equal(get(preview.state, 'b').startFrame, 20);
  assert.equal(get(preview.state, 'title').startFrame, 25);
  assert.equal(sourceFrameAt(get(preview.state, 'a'), 0), sourceFrameAt(get(before, 'a'), 10));
  commitTimelineDragGesture(before, editor.commands, gesture, 'selection');
  assert.deepEqual(content(editor.state()), content(preview.state));
  assert.equal(editor.history().past.length, 1);
  assert.equal(planTimelineMagneticTrim(before, gesture, 'rate-stretch'), undefined);
  assert.equal(planTimelineMagneticTrim({ ...before, interaction: { magnet: false } }, gesture, 'selection'), undefined);
}

// Source limits and zero movement are the same in preview and commit. A
// stationary handle adds no undo entry or new structural state.
{
  const editor = store();
  const before = editor.state();
  const gesture = drag(before, 'a', 'trim-right', 0);
  assert.equal(planTimelineMagneticTrim(before, gesture, 'selection')?.state, before);
  commitTimelineDragGesture(before, editor.commands, gesture, 'selection');
  assert.equal(editor.history().past.length, 0);
  const bounded: TimelineState = { ...before,
    assets: [{ id: 'a-source', name: 'a', kind: 'video', src: '/a.mp4', durationInFrames: 50 }] };
  const maxPreview = planTimelineMagneticTrim(bounded, drag(bounded, 'a', 'trim-right', 500), 'selection');
  assert.equal(get(maxPreview!.state, 'a').durationInFrames, 40);
  assert.equal(get(maxPreview!.state, 'b').startFrame, 40);
}

// A refused non-magnetic move must not leave behind the prepared empty lane.
// The directly grabbed video is unlocked, but its linked audio is locked.
{
  const state = initial();
  state.interaction = { mainTrackId: 'V1', magnet: false, linkage: true };
  state.items.push(clip('voice', 0, { kind: 'audio', track: 'A2' }));
  state.trackOrder!.push('A2');
  state.tracks!.A2 = { kind: 'audio', locked: true };
  state.linkGroups = [{ id: 'av', mode: 'linked', anchorItemId: 'a', itemIds: ['a', 'voice'] }];
  const moved = moveSelectionToNewTrack(state, ['a'], 10, 'new-lane');
  assert.equal(moved, state);
  assert.ok(!moved.trackOrder?.includes('new-lane'));
  assert.equal(moved.tracks?.['new-lane'], undefined);
  assert.equal(get(moved, 'a').startFrame, 0);
}

// Moving a main clip into a new lane closes the original main gap. Its explicit
// title follows this move once, then detaches because the parent is no longer a
// main clip. Committing the resulting state must not apply the delta again.
{
  const before = initial();
  before.items = before.items.map((item) => item.id === 'title'
    ? { ...item, startFrame: 5, mainClipId: 'a' } : item);
  const planned = moveSelectionToNewTrack(before, ['a'], 90, 'new-video');
  assert.notEqual(planned, before);
  assert.equal(get(planned, 'a').track, 'new-video');
  assert.equal(get(planned, 'a').startFrame, 90);
  assert.equal(get(planned, 'a').srcInFrame, 10);
  assert.equal(get(planned, 'b').startFrame, 0);
  assert.equal(get(planned, 'c').startFrame, 30);
  assert.equal(get(planned, 'title').startFrame, 95);
  assert.equal(get(planned, 'title').mainClipId, undefined);
  assert.equal(get(planned, 'music').startFrame, 0);
  assert.equal(planned.trackOrder?.[0], 'new-video');
  const editor = store(before);
  editor.commands.applyState(planned);
  assert.deepEqual(content(editor.state()), content(planned));
  assert.equal(editor.history().past.length, 1);
  editor.commands.undo();
  assert.deepEqual(content(editor.state()), content(before));
}

console.log('timeline magnetic drag: real preview/commit equivalence, source trims, no-op history and safe new-track moves OK');
