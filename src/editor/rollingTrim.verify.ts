import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { activeEditorState, type MediaAsset, type ProjectDoc, type Timeline, type TimelineItem, type TimelineState } from './types';
import { historyReduce } from './reduce';
import { buildCommands } from './storeCommandBuilder';
import { runProjectMigrations } from '../persist/migrations/index';
import { planRollingTrim } from './rollingTrim';

const asset = (id: string, kind: 'video' | 'audio', frames: number): MediaAsset => ({
  id, name: id, kind, src: `/media/uploads/${id}.mp4`, durationInFrames: frames,
});
const clip = (id: string, kind: 'video' | 'audio' | 'text', track: string, startFrame: number,
  durationInFrames: number, options: Partial<TimelineItem> = {}): TimelineItem => ({
  id, kind, track, name: id, startFrame, durationInFrames,
  ...(kind === 'video' || kind === 'audio' ? { src: `/media/uploads/${id}.mp4`, sourceAssetId: id } : {}),
  ...options,
} as TimelineItem);

function baseState(linked = false): TimelineState {
  const items = [
    clip('left-video', 'video', 'V1', 20, 40, { srcInFrame: 10, playbackRate: 1 }),
    clip('right-video', 'video', 'V1', 60, 30, { srcInFrame: 20, playbackRate: 1 }),
    clip('left-audio', 'audio', 'A1', 20, 40, { srcInFrame: 20, playbackRate: 2 }),
    clip('right-audio', 'audio', 'A1', 60, 30, { srcInFrame: 40, playbackRate: 0.5 }),
    clip('unrelated-title', 'text', 'V2', 31, 12, {
      fadeInFrames: 8, fadeOutFrames: 8, keyframes: { opacity: [{ frame: 20, value: 0.5 }] },
    }),
    clip('attached-title', 'text', 'V2', 60, 10, { mainClipId: 'right-video' }),
  ];
  return {
    fps: 30, width: 1920, height: 1080,
    items: items.filter((item) => linked || item.kind !== 'audio'),
    selectedId: null, trackOrder: ['V1', 'V2', 'A1'],
    tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
    interaction: { mainTrackId: 'V1', magnet: false, linkage: true, snapping: true },
    assets: [asset('left-video', 'video', 240), asset('right-video', 'video', 240),
      asset('left-audio', 'audio', 300), asset('right-audio', 'audio', 300)],
    ...(linked ? { linkGroups: [
      { id: 'left-av', mode: 'linked' as const, anchorItemId: 'left-video', itemIds: ['left-video', 'left-audio'] },
      { id: 'right-av', mode: 'linked' as const, anchorItemId: 'right-video', itemIds: ['right-video', 'right-audio'] },
    ] } : {}),
  };
}

function documentFor(state: TimelineState): ProjectDoc {
  const { assets = [], ...timeline } = state;
  return {
    version: CURRENT_PROJECT_VERSION,
    assets,
    mediaFolders: [],
    activeTimelineId: 'timeline',
    timelines: [{ ...timeline, id: 'timeline', name: 'Timeline', order: 0 } as Timeline],
  };
}

const get = (state: TimelineState, id: string) => state.items.find((item) => item.id === id)!;

{
  const state = baseState();
  const forward = planRollingTrim(state, 'left-video', 'right-video', 7);
  assert.equal(forward.error, undefined);
  assert.equal(forward.deltaF, 7);
  assert.equal(get(forward.state, 'left-video').startFrame, 20, 'left outer start is fixed');
  assert.equal(get(forward.state, 'left-video').durationInFrames, 47);
  assert.equal(get(forward.state, 'right-video').startFrame, 67);
  assert.equal(get(forward.state, 'right-video').durationInFrames, 23);
  assert.equal(get(forward.state, 'right-video').srcInFrame, 27);
  assert.equal(get(forward.state, 'right-video').startFrame + get(forward.state, 'right-video').durationInFrames, 90,
    'right outer end is fixed');
  assert.deepEqual(get(forward.state, 'unrelated-title'), get(state, 'unrelated-title'), 'unrelated tracks never move');
  assert.equal(get(forward.state, 'unrelated-title'), get(state, 'unrelated-title'),
    'unrelated fade/keyframe data is not repaired as a side effect');
  const grouped = { ...state, linkGroups: [{ id: 'ordinary', mode: 'group' as const,
    anchorItemId: 'left-video', itemIds: ['left-video', 'unrelated-title'] }] };
  const groupPlan = planRollingTrim(grouped, 'left-video', 'right-video', 3);
  assert.equal(groupPlan.error, undefined);
  assert.deepEqual(get(groupPlan.state, 'unrelated-title'), get(grouped, 'unrelated-title'),
    'ordinary groups do not couple rolling timing');
  const backward = planRollingTrim(state, 'left-video', 'right-video', -5);
  assert.equal(backward.deltaF, -5);
  assert.equal(get(backward.state, 'left-video').durationInFrames, 35);
  assert.equal(get(backward.state, 'right-video').startFrame, 55);
  assert.equal(get(backward.state, 'right-video').srcInFrame, 15);
}

{
  const state = baseState(true);
  const plan = planRollingTrim(state, 'left-video', 'right-video', 5);
  assert.equal(plan.error, undefined);
  assert.equal(get(plan.state, 'left-video').durationInFrames, 45);
  assert.equal(get(plan.state, 'right-video').startFrame, 65);
  assert.equal(get(plan.state, 'left-audio').durationInFrames, 45, 'linked audio follows the left boundary');
  assert.equal(get(plan.state, 'right-audio').startFrame, 65);
  assert.equal(get(plan.state, 'right-audio').durationInFrames, 25);
  assert.equal(get(plan.state, 'right-audio').srcInFrame, 42.5, 'source delta follows the audio playback rate');
  assert.equal(get(plan.state, 'right-audio').srcInFrame! + get(plan.state, 'right-audio').durationInFrames * 0.5, 55,
    'right source out-point remains fixed');
  assert.deepEqual(get(plan.state, 'unrelated-title'), get(state, 'unrelated-title'));
  assert.equal(get(plan.state, 'attached-title').startFrame, 60,
    'a mainClipId title follower is not displaced by rolling the clip boundary');
  assert.equal(get(plan.state, 'attached-title'), get(state, 'attached-title'),
    'the attached title item remains the exact same object');
}

{
  const noSpare = baseState();
  noSpare.assets = noSpare.assets?.map((entry) => entry.id === 'left-video' ? { ...entry, durationInFrames: 50 } : entry);
  const clamped = planRollingTrim(noSpare, 'left-video', 'right-video', 4);
  assert.equal(clamped.error, undefined);
  assert.equal(clamped.deltaF, 0);
  assert.ok(clamped.limitMessage?.includes('左侧素材'));
  assert.equal(clamped.state, noSpare, 'source limit keeps the preview at the same plan as release');

  const linkedNoSpare = baseState(true);
  linkedNoSpare.assets = linkedNoSpare.assets?.map((entry) => entry.id === 'left-audio'
    ? { ...entry, durationInFrames: 100 } : entry);
  const linkedClamp = planRollingTrim(linkedNoSpare, 'left-video', 'right-video', 4);
  assert.equal(linkedClamp.deltaF, 0, 'every linked left member contributes its source bound');
  assert.ok(linkedClamp.limitMessage?.includes('左侧素材'));

  const noRange = baseState();
  noRange.assets = noRange.assets?.map((entry) => entry.id === 'left-video' ? { ...entry, durationInFrames: 50 } : entry);
  noRange.items = noRange.items.map((item) => item.id === 'right-video' ? { ...item, srcInFrame: 0 } : item);
  const unavailable = planRollingTrim(noRange, 'left-video', 'right-video', 0);
  assert.equal(unavailable.deltaF, 0);
  assert.ok(unavailable.limitMessage?.includes('素材'), 'a boundary with no range explains why its grip is unavailable');

  const unknown = baseState();
  unknown.assets = unknown.assets?.map((entry) => entry.id === 'left-video' ? { ...entry, durationInFrames: 0 } : entry);
  assert.match(planRollingTrim(unknown, 'left-video', 'right-video', 1).error ?? '', /源长度未知/);

  const oneFrame = baseState();
  oneFrame.items = oneFrame.items.map((item) => item.id === 'left-video' ? { ...item, durationInFrames: 1 } : item);
  oneFrame.items = oneFrame.items.map((item) => item.id === 'right-video' ? { ...item, startFrame: 21 } : item);
  const minimum = planRollingTrim(oneFrame, 'left-video', 'right-video', -1);
  assert.equal(minimum.deltaF, 0);
  assert.ok(minimum.limitMessage?.includes('延长'));
  const rightMinimum = baseState();
  rightMinimum.items = rightMinimum.items.map((item) => item.id === 'right-video'
    ? { ...item, startFrame: 60, durationInFrames: 1 } : item);
  assert.equal(planRollingTrim(rightMinimum, 'left-video', 'right-video', 1).deltaF, 0,
    'a short right clip can only move in the lengthening direction');
  const sourceInFloor = baseState();
  sourceInFloor.items = sourceInFloor.items.map((item) => item.id === 'right-video'
    ? { ...item, srcInFrame: 0 } : item);
  assert.equal(planRollingTrim(sourceInFloor, 'left-video', 'right-video', -2).deltaF, 0,
    'the right source in-point never becomes negative');
  const linkedSourceInFloor = baseState(true);
  linkedSourceInFloor.items = linkedSourceInFloor.items.map((item) => item.id === 'right-audio'
    ? { ...item, srcInFrame: 0 } : item);
  assert.equal(planRollingTrim(linkedSourceInFloor, 'left-video', 'right-video', -2).deltaF, 0,
    'every linked right member constrains backwards extension');
}

{
  const base = baseState();
  const gap = { ...base, items: base.items.map((item) => item.id === 'right-video' ? { ...item, startFrame: 61 } : item) };
  const gapPlan = planRollingTrim(gap, 'left-video', 'right-video', 1);
  assert.match(gapPlan.error ?? '', /精确相邻/);
  assert.equal(gapPlan.state, gap, 'a rejected planner result never partially edits clips');
  const otherTrack = { ...base, items: base.items.map((item) => item.id === 'right-video' ? { ...item, track: 'V2' } : item) };
  assert.match(planRollingTrim(otherTrack, 'left-video', 'right-video', 1).error ?? '', /同一轨道/);
  const locked = { ...base, tracks: { ...base.tracks, V1: { kind: 'video' as const, locked: true } } };
  assert.match(planRollingTrim(locked, 'left-video', 'right-video', 1).error ?? '', /锁定/);
  const lockedFollower = { ...baseState(true), tracks: { ...baseState(true).tracks, A1: { kind: 'audio' as const, locked: true } } };
  assert.match(planRollingTrim(lockedFollower, 'left-video', 'right-video', 1).error ?? '', /关联片段所在轨道已锁定/);
  const withCutTransition = { ...base, transitions: [{ id: 'cut', type: 'cross-dissolve' as const, durationInFrames: 10,
    outgoingItemId: 'left-video', incomingItemId: 'right-video', trackId: 'V1' }] };
  assert.match(planRollingTrim(withCutTransition, 'left-video', 'right-video', 0).error ?? '', /共同边界带有转场/,
    'a cut transition makes the roll grip unavailable at zero delta');
  assert.match(planRollingTrim(withCutTransition, 'left-video', 'right-video', 1).error ?? '', /共同边界带有转场/);
  const exteriorTransitions = { ...base,
    items: [...base.items,
      clip('previous-video', 'video', 'V1', 0, 20), clip('next-video', 'video', 'V1', 90, 20)],
    assets: [...(base.assets ?? []), asset('previous-video', 'video', 100), asset('next-video', 'video', 100)],
    transitions: [
      { id: 'before', type: 'cross-dissolve' as const, durationInFrames: 10,
        outgoingItemId: 'previous-video', incomingItemId: 'left-video', trackId: 'V1' },
      { id: 'after', type: 'cross-dissolve' as const, durationInFrames: 10,
        outgoingItemId: 'right-video', incomingItemId: 'next-video', trackId: 'V1' },
    ],
  };
  const intactExterior = planRollingTrim(exteriorTransitions, 'left-video', 'right-video', 5);
  assert.equal(intactExterior.error, undefined, 'unaffected exterior transitions remain available');
  assert.deepEqual(intactExterior.state.transitions, exteriorTransitions.transitions);
  const transitionLimit = planRollingTrim(exteriorTransitions, 'left-video', 'right-video', 27);
  assert.equal(transitionLimit.error, undefined);
  assert.equal(transitionLimit.deltaF, 15, 'roll is capped at the half-second minimum before affecting exterior transitions');
  assert.deepEqual(transitionLimit.state.transitions, exteriorTransitions.transitions);
  const wordDriven = baseState(true);
  wordDriven.items = wordDriven.items.map((item) => item.id === 'right-audio'
    ? { ...item, transcript: [{ text: 'word', start: 0, end: 100 }] } : item);
  assert.match(planRollingTrim(wordDriven, 'left-video', 'right-video', 1).error ?? '', /源长度未知或剪辑方式不受支持/);
  const mosaic = baseState();
  mosaic.items = mosaic.items.map((item) => item.id === 'right-video' ? { ...item, kind: 'mosaic' as const } : item);
  assert.match(planRollingTrim(mosaic, 'left-video', 'right-video', 1).error ?? '', /源长度未知或剪辑方式不受支持/);
  const multicam = { ...base, multicamGroups: [{ id: 'mc', referenceAngleId: 'angle', masterAngleId: 'angle',
    syncMethod: 'audio' as const, evidence: [], angles: [{ id: 'angle', itemId: 'left-video',
      source: get(base, 'left-video'), label: 'Angle A', offsetFrames: 0, confidence: 1 }] }] };
  assert.match(planRollingTrim(multicam, 'left-video', 'right-video', 1).error ?? '', /多机位/);
  const syncLocked = { ...base, items: [...base.items, clip('sync-peer', 'video', 'V2', 80, 10)],
    linkGroups: [{ id: 'sync', mode: 'sync-lock' as const, anchorItemId: 'right-video', itemIds: ['right-video', 'sync-peer'] }] };
  assert.match(planRollingTrim(syncLocked, 'left-video', 'right-video', 1).error ?? '', /同步锁定/);
}

{
  const initial = documentFor(baseState(true));
  let history = { past: [] as ProjectDoc[], present: initial, future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const plan = planRollingTrim(activeEditorState(initial), 'left-video', 'right-video', 3);
  assert.equal(plan.error, undefined);
  commands.addMarker(5, { note: 'concurrent unrelated edit' });
  const historyBeforeRoll = history.past.length;
  const currentBeforeRoll = activeEditorState(history.present);
  const unrelatedBeforeRoll = get(currentBeforeRoll, 'unrelated-title');
  commands.applyRollingTrim('left-video', 'right-video', 3);
  assert.equal(history.past.length, historyBeforeRoll + 1, 'a roll adds exactly one editor history step');
  const released = activeEditorState(history.present);
  assert.equal(get(released, 'left-video').durationInFrames, get(plan.state, 'left-video').durationInFrames,
    'an unrelated edit after preview planning does not change the roll geometry');
  assert.equal(get(released, 'right-video').startFrame, get(plan.state, 'right-video').startFrame);
  assert.equal(get(released, 'unrelated-title'), unrelatedBeforeRoll,
    'the reducer roll action does not repair or replace unrelated item data');
  assert.equal(history.present.timelines[0]!.markers?.[0]?.note, 'concurrent unrelated edit',
    'the reducer plans against live state and preserves edits made after preview planning');
  const saved = runProjectMigrations(history.present);
  assert(saved, 'the committed plan remains readable after persistence normalization');
  assert.equal(get(activeEditorState(saved.doc), 'right-video').startFrame, 63);
  commands.undo();
  assert.equal(get(activeEditorState(history.present), 'right-video').startFrame, 60);
  assert.equal(history.present.timelines[0]!.markers?.[0]?.note, 'concurrent unrelated edit');
  commands.redo();
  assert.equal(get(activeEditorState(history.present), 'right-video').startFrame, 63);
}

{
  const gap = { ...baseState(), items: baseState().items.map((item) => item.id === 'right-video'
    ? { ...item, startFrame: 61 } : item) };
  let invalidHistory = { past: [] as ProjectDoc[], present: documentFor(gap), future: [] as ProjectDoc[] };
  const invalidCommands = buildCommands((action) => { invalidHistory = historyReduce(invalidHistory, action); }, () => invalidHistory.present);
  invalidCommands.applyRollingTrim('left-video', 'right-video', 1);
  assert.equal(invalidHistory.past.length, 0, 'invalid rolls produce no history entry');

  const limitedState = baseState();
  limitedState.assets = limitedState.assets?.map((entry) => entry.id === 'left-video'
    ? { ...entry, durationInFrames: 52 } : entry);
  let limitedHistory = { past: [] as ProjectDoc[], present: documentFor(limitedState), future: [] as ProjectDoc[] };
  const limitedCommands = buildCommands((action) => { limitedHistory = historyReduce(limitedHistory, action); }, () => limitedHistory.present);
  limitedCommands.applyRollingTrim('left-video', 'right-video', 5);
  assert.equal(limitedHistory.past.length, 1, 'a clamped roll remains one atomic history step');
  assert.equal(get(activeEditorState(limitedHistory.present), 'left-video').durationInFrames, 42);
  assert.equal(get(activeEditorState(limitedHistory.present), 'right-video').startFrame, 62);
}

for (const kind of ['text', 'image', 'motion-graphic', 'solid'] as const) {
  const sfState: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    trackOrder: ['T1'],
    tracks: { T1: { kind: kind === 'text' ? 'video' : 'video' } },
    items: [
      { id: `l-${kind}`, kind, track: 'T1', name: `L ${kind}`, startFrame: 0, durationInFrames: 45 } as TimelineItem,
      { id: `r-${kind}`, kind, track: 'T1', name: `R ${kind}`, startFrame: 45, durationInFrames: 45 } as TimelineItem,
    ],
  };
  const forward = planRollingTrim(sfState, `l-${kind}`, `r-${kind}`, 10);
  assert.equal(forward.error, undefined, `${kind} rolls forward without finite media asset`);
  assert.equal(forward.deltaF, 10);
  assert.equal(get(forward.state, `l-${kind}`).durationInFrames, 55);
  assert.equal(get(forward.state, `r-${kind}`).startFrame, 55);
  assert.equal(get(forward.state, `r-${kind}`).durationInFrames, 35);
  assert.equal(get(forward.state, `r-${kind}`).srcInFrame, undefined, `${kind} never fabricates srcInFrame`);

  const backward = planRollingTrim(sfState, `l-${kind}`, `r-${kind}`, -10);
  assert.equal(backward.error, undefined, `${kind} rolls backward without finite media asset`);
  assert.equal(backward.deltaF, -10);
  assert.equal(get(backward.state, `l-${kind}`).durationInFrames, 35);
  assert.equal(get(backward.state, `r-${kind}`).startFrame, 35);
  assert.equal(get(backward.state, `r-${kind}`).durationInFrames, 55);
}

console.log('rollingTrim.verify: exact adjacency, linked source-rate bounds, safe rejection, normalization, and atomic history passed');
