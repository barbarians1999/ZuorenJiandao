import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { appendManualCue, newManualCaptions, updateManualCue } from '../captions/manualCaptions';
import { clipEdgeHandleLayout } from '../components/timeline/timelineUtil';
import { trackDisplayLabel, trackOrderForHeaderDrop } from '../components/timeline/trackHeaderReorder';
import { planClipPasteResult } from './clipPaste';
import { canDropMediaAsset } from '../media/drag';
import { canItemMoveToTrack } from './multiSelect';
import { historyReduce } from './reduce';
import { buildCommands } from './storeCommandBuilder';
import { applyLiveCaptionPreview } from './liveCaptionPreview';
import { planCompactTracks } from './trackConsolidate';
import {
  canTrackAcceptItemKind,
  defaultTrackId,
  itemTrackNature,
  trackNature,
  type ProjectDoc,
  type TimelineItem,
  type TimelineState,
} from './types';

function makeProject(timeline: TimelineState): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    activeTimelineId: 'tl-1',
    assets: [],
    mediaFolders: [],
    timelines: [{
      ...timeline,
      id: 'tl-1',
      name: 'Main',
      order: 0,
    }],
  };
}

// 1. Strict track separation across text, picture/video, audio, and caption tracks.
{
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    interaction: { mainTrackId: 'V1' },
    tracks: {
      C1: { kind: 'caption' },
      T1: { kind: 'video', visualRole: 'text' },
      V2: { kind: 'video' },
      V1: { kind: 'video' },
      A1: { kind: 'audio' },
    },
    trackOrder: ['C1', 'T1', 'V2', 'V1', 'A1'],
    items: [
      { id: 'v1', name: 'main', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 90, src: '/v.mp4' },
      { id: 't1', name: 'title', kind: 'text', track: 'T1', startFrame: 10, durationInFrames: 40 },
      { id: 'a1', name: 'bgm', kind: 'audio', track: 'A1', startFrame: 0, durationInFrames: 90, src: '/a.wav' },
    ],
  };

  assert.equal(trackNature(state, 'C1'), 'caption');
  assert.equal(trackNature(state, 'T1'), 'text');
  assert.equal(trackNature(state, 'V1'), 'video');
  assert.equal(trackNature(state, 'A1'), 'audio');

  assert.equal(itemTrackNature({ kind: 'text' }), 'text');
  assert.equal(itemTrackNature({ kind: 'video' }), 'video');
  assert.equal(itemTrackNature({ kind: 'image' }), 'video');
  assert.equal(itemTrackNature({ kind: 'motion-graphic' }), 'effect');
  assert.equal(itemTrackNature({ kind: 'solid' }), 'effect');
  assert.equal(itemTrackNature({ kind: 'mosaic' }), 'effect');
  assert.equal(itemTrackNature({ kind: 'audio' }), 'audio');

  assert.equal(canTrackAcceptItemKind(state, 'video', 'T1'), false);
  assert.equal(canTrackAcceptItemKind(state, 'image', 'T1'), false);
  assert.equal(canTrackAcceptItemKind(state, 'motion-graphic', 'T1'), false);
  assert.equal(canTrackAcceptItemKind(state, 'audio', 'T1'), false);
  assert.equal(canTrackAcceptItemKind(state, 'text', 'T1'), true);
  assert.equal(canTrackAcceptItemKind(state, 'text', 'V1'), false);
  assert.equal(canTrackAcceptItemKind(state, 'video', 'V2'), true);

  assert.equal(canDropMediaAsset({ kind: 'video' }, 'video', true), false);
  assert.equal(canDropMediaAsset({ kind: 'image' }, 'video', true), false);
  assert.equal(canDropMediaAsset({ kind: 'video' }, 'video', false), true);

  assert.equal(canItemMoveToTrack(state, state.items[0]!, 'T1'), false);
  assert.equal(canItemMoveToTrack(state, state.items[1]!, 'V2'), false);
  assert.equal(canItemMoveToTrack(state, state.items[1]!, 'T1'), true);
  assert.notEqual(trackOrderForHeaderDrop(state, 'T1', 'V2', 'after'), null);
  assert.notEqual(trackOrderForHeaderDrop(state, 'V2', 'T1', 'before'), null);
  assert.equal(defaultTrackId({ ...state, trackOrder: ['T1', 'V2', 'V1'] }, 'video'), 'V1');
}

// 2. Plan & execute track compaction while preserving mainTrackId, locked tracks, transitions, and audio routing groups.
{
  const vC: TimelineItem = { id: 'vc', name: 'vc', kind: 'video', track: 'V2', startFrame: 10, durationInFrames: 15, src: '/c.mp4' };
  const vA: TimelineItem = { id: 'va', name: 'va', kind: 'video', track: 'V3', startFrame: 0, durationInFrames: 30, src: '/a.mp4' };
  const vB: TimelineItem = { id: 'vb', name: 'vb', kind: 'video', track: 'V3', startFrame: 30, durationInFrames: 30, src: '/b.mp4' };
  const vMove: TimelineItem = { id: 'vmove', name: 'vmove', kind: 'video', track: 'V3', startFrame: 70, durationInFrames: 20, src: '/mv.mp4' };
  const mainClip: TimelineItem = { id: 'm1', name: 'main', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 120, src: '/m.mp4' };
  const textA: TimelineItem = { id: 'ta', name: 't1', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 20 };
  const textB: TimelineItem = { id: 'tb', name: 't2', kind: 'text', track: 'T2', startFrame: 40, durationInFrames: 20 };
  const lockedClip: TimelineItem = { id: 'lk', name: 'lock', kind: 'video', track: 'VL', startFrame: 200, durationInFrames: 20, src: '/l.mp4' };
  const voiceClip: TimelineItem = { id: 'au1', name: 'voice', kind: 'audio', track: 'A1', startFrame: 0, durationInFrames: 30, src: '/v.wav' };
  const bgmClip: TimelineItem = { id: 'au2', name: 'bgm', kind: 'audio', track: 'A2', startFrame: 50, durationInFrames: 30, src: '/bgm.wav' };
  const fxClip: TimelineItem = { id: 'au3', name: 'fx', kind: 'audio', track: 'A3', startFrame: 50, durationInFrames: 20, src: '/fx.wav' };

  const initial: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    interaction: { mainTrackId: 'V1' },
    tracks: {
      T2: { kind: 'video', visualRole: 'text' },
      T1: { kind: 'video', visualRole: 'text' },
      V3: { kind: 'video' },
      V2: { kind: 'video' },
      VL: { kind: 'video', locked: true },
      V1: { kind: 'video' },
      VE: { kind: 'video' },
      A1: { kind: 'audio', role: 'anchor' },
      A2: { kind: 'audio', role: 'follower' },
      A3: { kind: 'audio', role: 'anchor' },
      C1: { kind: 'caption' },
    },
    trackOrder: ['C1', 'T2', 'T1', 'VE', 'V3', 'V2', 'VL', 'V1', 'A1', 'A2', 'A3'],
    items: [vA, vB, vC, vMove, mainClip, textA, textB, lockedClip, voiceClip, bgmClip, fxClip],
    transitions: [{
      id: 'tr1',
      trackId: 'V3',
      type: 'cross-dissolve',
      durationInFrames: 10,
      outgoingItemId: 'va',
      incomingItemId: 'vb',
    }],
  };

  const planned = planCompactTracks(initial);
  const byId = new Map(planned.state.items.map((item) => [item.id, item]));
  assert.equal(byId.get('m1')?.track, 'V1', 'mainTrackId keeps its clips untouched');
  assert.equal(byId.get('lk')?.track, 'VL', 'locked track keeps its clips untouched');
  assert.equal(byId.get('tb')?.track, 'T1', 'text clip merges onto earlier non-overlapping text track');
  assert.equal(byId.get('tb')?.startFrame, 40, 'compaction never changes startFrame');
  assert.equal(byId.get('va')?.track, byId.get('vb')?.track, 'transition-linked clips stay on the same track');
  assert.equal(planned.state.transitions?.[0]?.trackId, byId.get('va')?.track, 'transition trackId updates with moved clips');
  assert.equal(byId.get('vmove')?.track, 'V2', 'non-overlapping clip on V3 fills gap on lower track V2');
  assert.equal(byId.get('au3')?.track, 'A1', 'voice audio clip merges into matching voice track');
  assert.equal(byId.get('au2')?.track, 'A2', 'bgm track stays separated from voice track');
  assert.equal(byId.get('vc')?.track, 'V3', 'overlapping clip stays on second overlay track');
  assert.ok(!planned.state.tracks?.T2 && !planned.state.tracks?.VE && !planned.state.tracks?.A3,
    'newly emptied redundant tracks are removed');
  assert.ok(planned.state.tracks?.V1 && planned.state.tracks?.VL && planned.state.tracks?.C1,
    'main, locked, and caption tracks remain');

  // Verify single-step command + undo restores exact state.
  let history = { past: [] as ProjectDoc[], present: makeProject(initial), future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const res = commands.compactTracks();
  assert.ok(res.movedItemCount > 0 || res.removedTrackIds.length > 0);
  assert.equal(history.past.length, 1);
  commands.undo();
  assert.deepEqual(history.present.timelines[0]?.items, initial.items);
  assert.deepEqual(history.present.timelines[0]?.trackOrder, initial.trackOrder);
}

// 3. Narrow clip edge handles stay unobtrusive in selection mode and appear when wide or in explicit trim mode.
{
  const narrow = clipEdgeHandleLayout(12, 'selection', true, true, 12);
  assert.equal(narrow.trimWidth, 0);
  assert.equal(narrow.showRollRight, false);

  const compact = clipEdgeHandleLayout(24, 'selection', true, true, 24);
  assert.ok(compact.trimWidth > 0 && compact.trimWidth <= 5);
  assert.equal(compact.showRollRight, false);

  const wide = clipEdgeHandleLayout(90, 'selection', true, true, 90);
  assert.equal(wide.trimWidth, 5);
  assert.equal(wide.showRollRight, true);

  const narrowTrimMode = clipEdgeHandleLayout(12, 'trim', true, true, 12);
  assert.ok(narrowTrimMode.trimWidth > 0);
}

// 4. Synchronous non-history caption live preview patches captions cleanly without mutating original state.
{
  let captions = newManualCaptions();
  const laneId = captions.sourceEntries![0]!.id;
  captions = { ...captions, ...appendManualCue(captions, laneId, '原标题', 1_000, 2_000) };
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['C1', 'V1'],
    tracks: { C1: { kind: 'caption', captions }, V1: { kind: 'video' } },
    items: [],
    captions,
  };
  const livePatch = updateManualCue(captions, laneId, 0, '同步更新', 1_000, 2_000)!;
  const previewState = applyLiveCaptionPreview(state, 'tl-1', {
    kind: 'patch',
    source: 'preview',
    timelineId: 'tl-1',
    trackId: 'C1',
    patch: livePatch,
  });
  assert.equal(previewState.tracks?.C1?.captions?.sourceEntries?.[0]?.words?.[0]?.text, '同步更新');
  assert.equal(state.tracks?.C1?.captions?.sourceEntries?.[0]?.words?.[0]?.text, '原标题',
    'original committed state stays untouched until confirmed');
  assert.equal(applyLiveCaptionPreview(state, 'tl-other', {
    kind: 'patch',
    source: 'preview',
    timelineId: 'tl-1',
    trackId: 'C1',
    patch: livePatch,
  }), state, 'preview scoped to another timeline is ignored');
}

// 5. Effect tracks stay isolated from text and plain video tracks, shapes never land on text tracks,
// and stranded non-text clips on a text track can move out cleanly.
{
  const stateWithEffect: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    interaction: { mainTrackId: 'V1' },
    tracks: {
      T1: { kind: 'video', visualRole: 'text' },
      E1: { kind: 'video', visualRole: 'effect' },
      V2: { kind: 'video' },
      V1: { kind: 'video' },
    },
    trackOrder: ['T1', 'E1', 'V2', 'V1'],
    items: [
      { id: 'v1', name: 'main', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 90, src: '/v.mp4' },
      { id: 's-ok', name: 'rect', kind: 'solid', track: 'E1', startFrame: 0, durationInFrames: 30, props: { color: '#fff' } },
      { id: 't1', name: 'txt', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 30 },
      { id: 's-stranded', name: 'stranded', kind: 'solid', track: 'T1', startFrame: 40, durationInFrames: 30, props: { color: '#fff' } },
    ],
  };

  assert.equal(trackNature(stateWithEffect, 'E1'), 'effect');
  assert.equal(trackDisplayLabel(stateWithEffect, 'E1'), '特效1');
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'solid', 'E1'), true);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'mosaic', 'E1'), true);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'motion-graphic', 'E1'), true);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'video', 'E1'), false);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'image', 'E1'), false);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'text', 'E1'), false);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'solid', 'T1'), false);
  assert.equal(canTrackAcceptItemKind(stateWithEffect, 'solid', 'V2'), true);

  assert.equal(canDropMediaAsset({ kind: 'video' }, 'video', false, true), false);
  assert.equal(canDropMediaAsset({ kind: 'image' }, 'video', false, true), false);
  assert.equal(canDropMediaAsset({ kind: 'gif' }, 'video', false, true), true);
  assert.equal(canDropMediaAsset({ kind: 'motion-graphic' }, 'video', false, true), true);

  assert.equal(canItemMoveToTrack(stateWithEffect, stateWithEffect.items[0]!, 'E1'), false, 'video cannot move onto effect track');
  assert.equal(canItemMoveToTrack(stateWithEffect, stateWithEffect.items[2]!, 'E1'), false, 'text cannot move onto effect track');
  assert.equal(canItemMoveToTrack(stateWithEffect, stateWithEffect.items[3]!, 'E1'), true, 'stranded solid on text track can move to effect track');
  assert.equal(canItemMoveToTrack(stateWithEffect, stateWithEffect.items[3]!, 'V2'), true, 'stranded solid on text track can move to video track');
  assert.notEqual(trackOrderForHeaderDrop(stateWithEffect, 'E1', 'V2', 'after'), null, 'effect track can reorder below video track');
  assert.notEqual(trackOrderForHeaderDrop(stateWithEffect, 'E1', 'T1', 'before'), null, 'effect track can reorder above text track');
  const effectAnywhereInVisualState: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['C1', 'E1', 'T1', 'V2', 'V1', 'A1'],
    tracks: {
      C1: { kind: 'caption' },
      E1: { kind: 'video', visualRole: 'effect' },
      T1: { kind: 'video', visualRole: 'text' },
      V2: { kind: 'video' },
      V1: { kind: 'video' },
      A1: { kind: 'audio' },
    },
    items: [],
    interaction: { mainTrackId: 'V1', magnet: true, linkage: true },
  };
  assert.notEqual(trackOrderForHeaderDrop(effectAnywhereInVisualState, 'E1', 'T1', 'after'), null, 'effect track can be dragged below text track');
  assert.notEqual(trackOrderForHeaderDrop(effectAnywhereInVisualState, 'E1', 'V1', 'after'), null, 'effect track can be dragged below main/video tracks as long as above audio');
  assert.equal(trackOrderForHeaderDrop(effectAnywhereInVisualState, 'E1', 'A1', 'after'), null, 'effect track still cannot cross below audio tracks');
  assert.equal(trackOrderForHeaderDrop(effectAnywhereInVisualState, 'E1', 'C1', 'before'), null, 'effect track still cannot cross above caption tracks');

  // Adding a shape with an empty text track above main must create an explicit effect track instead of using T1.
  const startState: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    interaction: { mainTrackId: 'V1' },
    tracks: {
      T1: { kind: 'video', visualRole: 'text' },
      V1: { kind: 'video' },
    },
    trackOrder: ['T1', 'V1'],
    items: [
      { id: 'v1', name: 'main', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 120, src: '/v.mp4' },
    ],
  };
  let doc = makeProject(startState);
  let history = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const rectId = commands.addShapeItem('rectangle', { startFrame: 0, durationInFrames: 30 });
  const rect = history.present.timelines[0]!.items.find((item) => item.id === rectId)!;
  assert.notEqual(rect.track, 'T1');
  assert.equal(history.present.timelines[0]!.tracks?.[rect.track]?.visualRole, 'effect');

  // Non-overlapping ellipse reuses the free effect track; overlapping mosaic opens a second effect track.
  const ellipseId = commands.addShapeItem('ellipse', { startFrame: 60, durationInFrames: 30 });
  const ellipse = history.present.timelines[0]!.items.find((item) => item.id === ellipseId)!;
  assert.equal(ellipse.track, rect.track);

  const mosaicId = commands.addCompositionMosaic({ startFrame: 0, durationInFrames: 30 });
  const mosaic = history.present.timelines[0]!.items.find((item) => item.id === mosaicId)!;
  assert.notEqual(mosaic.track, rect.track);
  assert.notEqual(mosaic.track, 'T1');
  assert.equal(history.present.timelines[0]!.tracks?.[mosaic.track]?.visualRole, 'effect');

  // Compaction keeps effect clips separated from video/text tracks, and clip paste preserves effect role.
  const afterMosaic = history.present.timelines[0]!;
  const compacted = planCompactTracks(afterMosaic);
  const cRect = compacted.state.items.find((item) => item.id === rectId)!;
  const cEllipse = compacted.state.items.find((item) => item.id === ellipseId)!;
  const cMosaic = compacted.state.items.find((item) => item.id === mosaicId)!;
  assert.equal(compacted.state.tracks?.[cRect.track]?.visualRole, 'effect');
  assert.equal(compacted.state.tracks?.[cEllipse.track]?.visualRole, 'effect');
  assert.equal(compacted.state.tracks?.[cMosaic.track]?.visualRole, 'effect');

  const pasted = planClipPasteResult(
    compacted.state,
    [cRect],
    { [cRect.track]: { kind: 'video', visualRole: 'effect' } },
    cRect.startFrame,
    (prefix) => `${prefix}-paste`,
  );
  const pastedRect = pasted.state.items.find((item) => item.id === 'item-paste')!;
  assert.equal(pasted.state.tracks?.[pastedRect.track]?.visualRole, 'effect');
}

console.log('trackConsolidationAndSeparation.verify: ALL PASSED');
