import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce } from './reduce';
import { buildCommands } from './storeCommandBuilder';
import { activeEditorState, type ProjectDoc } from './types';
import { applySelection, reduceSelection, selectionFromProject } from './selectionState';

function project(kind: 'audio' | 'video'): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    activeTimelineId: 'timeline',
    assets: [],
    mediaFolders: [],
    timelines: [{
      id: 'timeline', name: 'test', order: 0,
      fps: 30, width: 1920, height: 1080, items: [], selectedId: null,
      tracks: { existing: { kind } }, trackOrder: ['existing'],
    }],
  };
}

{
  const initial = project('video');
  let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const createdId = commands.createTimeline();
  const created = history.present.timelines.find((timeline) => timeline.id === createdId)!;
  assert.equal(created.interaction?.magnet, false);
  assert.equal(created.interaction?.linkage, false);
  assert.equal(created.interaction?.snapping, true);
  const historyAfterCreate = history.past.length;
  commands.setTimelineSnapping(false);
  assert.equal(history.present.timelines.find((timeline) => timeline.id === createdId)?.interaction?.snapping, false);
  assert.equal(history.past.length, historyAfterCreate, 'timeline snapping persists without an undo entry');
  commands.switchTimeline('timeline');
  commands.setTimelineSnapping(false);
  assert.equal(history.present.timelines[0]?.interaction?.snapping, false, 'legacy timelines can store a local override');
  const duplicateId = commands.duplicateTimeline('timeline');
  assert.equal(history.present.timelines.find((timeline) => timeline.id === duplicateId)?.interaction?.snapping, false,
    'duplicating a timeline preserves its explicit snapping choice');
}

{
  const initial = project('video');
  initial.timelines[0].interaction = { mainTrackId: 'existing', magnet: true, linkage: true };
  initial.timelines[0].items = [{ id: 'picture', kind: 'video', name: 'picture', track: 'existing', startFrame: 0, durationInFrames: 120 }];
  let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const id = commands.addTextClip({ text: 'chapter', startFrame: 30, durationInFrames: 30 });
  const result = history.present.timelines[0];
  const title = result.items.find((item) => item.id === id)!;
  assert.notEqual(title.track, 'existing', 'title creates an overlay instead of inserting into the main lane');
  assert.equal(result.tracks?.[title.track]?.visualRole, 'text', 'title creates a dedicated text track');
  assert.equal(result.trackOrder?.[0], title.track, 'dedicated text track is created at visual top above main track');
  assert.equal(title.startFrame, 30);
  assert.equal(title.mainClipId, 'picture');
  assert.equal(result.items.find((item) => item.id === 'picture')!.startFrame, 0);
  assert.equal(history.past.length, 1);
  commands.undo();
  assert.deepEqual(history.present, initial, 'one undo also removes the created title lane');
}

for (const shape of ['rectangle', 'ellipse'] as const) {
  const initial = project('video');
  initial.timelines[0]!.fps = 24;
  initial.timelines[0]!.width = 640;
  initial.timelines[0]!.height = 360;
  initial.timelines[0]!.interaction = { mainTrackId: 'existing', magnet: true, linkage: true };
  let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const id = commands.addShapeItem(shape, { startFrame: 48 });
  const timeline = history.present.timelines[0]!;
  const item = timeline.items.find((candidate) => candidate.id === id)!;
  assert.equal(item.kind, 'solid');
  assert.equal(item.mask?.type, shape);
  assert.deepEqual([item.mask?.x, item.mask?.y, item.mask?.width, item.mask?.height], [.35, .35, .3, .3]);
  assert.equal(item.track, timeline.trackOrder?.[0], 'a shape uses a real top overlay track, never the magnetic main lane');
  assert.equal(item.startFrame, 48);
  assert.equal(item.durationInFrames, 72);
  assert.deepEqual([item.width, item.height], [640, 360]);
  assert.equal(history.past.length, 1, 'a new shape lane and item are one undo step');
  commands.undo();
  assert.deepEqual(history.present, initial);
}

{
  const initial = project('video');
  initial.timelines[0]!.fps = 24;
  initial.timelines[0]!.width = 1280;
  initial.timelines[0]!.height = 720;
  initial.timelines[0]!.interaction = { mainTrackId: 'existing', magnet: true, linkage: true };
  let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const id = commands.addCompositionMosaic({ startFrame: 72 });
  const timeline = history.present.timelines[0]!;
  const item = timeline.items.find((candidate) => candidate.id === id)!;
  assert.equal(item.kind, 'mosaic');
  assert.equal(item.src, undefined, 'a composition mosaic is not a source media placeholder');
  assert.deepEqual([item.width, item.height], [1280, 720]);
  assert.equal(item.track, timeline.trackOrder?.[0], 'the dedicated mosaic video lane is inserted at visual top order');
  assert.equal(timeline.interaction?.mainTrackId, 'existing');
  assert.equal(timeline.compositingOrder, 'tracks');
  assert.equal(history.past.length, 1, 'the dedicated lane and mosaic are one undo step');
  commands.undo();
  assert.deepEqual(history.present, initial);
  commands.redo();
  assert.equal(history.present.timelines[0]?.items.some((candidate) => candidate.id === id), true);
}

for (const overwrite of [false, true]) {
  for (const kind of ['audio', 'video'] as const) {
    const initial = project(kind === 'audio' ? 'video' : 'audio');
    let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
    const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
    if (kind === 'audio') {
      commands.addAudio({ id: 'sound', name: 'sound', category: 'voice', src: '/media/uploads/sound.mp3', durationInFrames: 30 }, { overwrite });
      assert.equal(history.present.assets.length, 1, 'audio preparation retains its asset');
    } else {
      commands.addMotionGraphic({
        id: 'graphic', name: 'graphic', category: 'test', code: 'return null;', props: {}, fps: 30, propSchema: [], thumb: null,
        width: 1920, height: 1080, durationInFrames: 30,
      }, { overwrite });
    }
    const timeline = history.present.timelines[0];
    assert.equal(timeline.items.length, 1);
    const track = timeline.items[0].track;
    assert.equal(timeline.tracks?.[track]?.kind, kind, 'new clip references a real track');
    assert.deepEqual(timeline.trackOrder?.map((id) => timeline.tracks?.[id]?.kind), ['video', 'audio'],
      'overwrite must use the normal reducer track order');
    assert.equal(history.past.length, 1, 'preparation and placement are one undo step');
    assert.deepEqual(historyReduce(history, { type: 'undo' }).present, initial);
  }
}
{
  const initial = project('video');
  initial.timelines[0]!.items = [{ id: 'video', kind: 'video', name: 'video', track: 'existing', startFrame: 0, durationInFrames: 60 }];
  let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
  let selection = selectionFromProject(initial);
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present,
    (action) => { selection = reduceSelection(selection, history.present, action); },
    () => applySelection(activeEditorState(history.present), selection));
  commands.selectItem('video');
  assert.equal(commands.getState!().selectedId, 'video', 'async tracking sees the same transient selection as the live editor');
  assert.equal(history.present.timelines[0]!.selectedId, null, 'selection remains outside saved documents and history');
  assert.equal(history.past.length, 0);
  commands.selectItem(null);
  assert.equal(commands.getState!().selectedId, null, 'a changed selection still invalidates async tracking');
}
console.log('storeCommandBuilder.verify: overwrite and normal placement retain tracks, order, assets, and single-step undo');
