import assert from 'node:assert/strict';
import { clearMosaicTrack, GAUSSIAN_MOSAIC_ID, mosaicEffectsAt, mosaicRegionToStage,
  mosaicSourceIdentity, normalizeMosaicTrack, readMosaic, readMosaicAt, setMosaicRegion,
  setMosaicTrack } from '../editor/mosaic';
import { historyReduce, reduce } from '../editor/reduce';
import { docFromTimeline, migrateProjectDoc } from '../persist/projectStore';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { buildMosaicTrack, mosaicTrackingInputKey, trackingRunIsCurrent } from './mosaicTracking';

const assertNear = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const item: TimelineItem = {
  id: 'clip', name: 'checker.mp4', kind: 'video', track: 'v', src: '/media/uploads/checker.mp4',
  sourceAssetId: 'asset-checker', sourceRevision: 'revision-1', sourceContentHash: 'a'.repeat(64),
  startFrame: 10, durationInFrames: 60, srcInFrame: 12, playbackRate: 2, width: 640, height: 360,
  transform: { x: 7, y: -3, scale: 1.2 },
};
const baseEffects = setMosaicRegion([], { centerX: .5, centerY: .5, width: .35, height: .35, strength: 70, feather: 0 }, 'mosaic');
const state: TimelineState = { fps: 30, width: 320, height: 320, fit: 'cover', selectedId: item.id, items: [{ ...item, effects: baseEffects }] };
const result = {
  points: [
    { frame: 0, x: .25, y: .5, confidence: .95 },
    { frame: 30, x: .5, y: .5, confidence: .9 },
    { frame: 59, x: .75, y: .5, confidence: .88 },
  ], averageConfidence: .91, processedFrames: 3, totalFrames: 3, videoWidth: 640, videoHeight: 360, stoppedBecauseLost: false,
};
const track = buildMosaicTrack(item, result)!;
assert.ok(track);
assert.deepEqual(track.points.map((point) => point.sourceFrame), [12, 72, 130], 'tracking samples map to absolute source frames, including trim and speed');
assert.equal(normalizeMosaicTrack({ ...track, points: [...track.points].reverse() }), null, 'nonmonotonic source curves are rejected, not sorted');
assert.equal(normalizeMosaicTrack({ ...track, points: [{ ...track.points[0]! }, { ...track.points[0]! }] }), null, 'duplicate source-frame points are rejected');

const trackedEffects = setMosaicTrack(baseEffects, 'mosaic', track)!;
const trackedItem = { ...item, effects: trackedEffects };
assert.equal(readMosaicAt(trackedItem, 0).region.centerX, .25);
assertNear(readMosaicAt(trackedItem, 15).region.centerX, .375, 'linear interpolation uses source time');
assert.equal(readMosaicAt(trackedItem, 30).region.centerX, .5);
assert.equal(readMosaicAt(trackedItem, 60).region.centerX, .75, 'track holds its last sample');
assertNear(readMosaicAt({ ...trackedItem, srcInFrame: 52 }, 0).region.centerX,
  readMosaicAt(trackedItem, 20).region.centerX, 'left-trimmed item reuses the same source-frame curve');
assertNear(readMosaicAt({ ...trackedItem, playbackRate: 1 }, 30).region.centerX, .375, 'speed changes map time through sourceFrameAt');
const proxyItem = { ...trackedItem, src: '/media/proxies/checker.webm' };
assert.equal(mosaicSourceIdentity(proxyItem), mosaicSourceIdentity(trackedItem), 'proxy URL substitution keeps source identity');
assert.equal(readMosaicAt({ ...trackedItem, sourceRevision: 'revision-2' }, 15).region.centerX, .5, 'replaced media falls back to the static mosaic');
const requestKey = mosaicTrackingInputKey(state, trackedItem, { x: .1, y: .2, width: .2, height: .2 }, .68);
assert.ok(trackingRunIsCurrent(4, 4, requestKey, requestKey), 'the active matching run may publish its result');
assert.equal(trackingRunIsCurrent(5, 4, requestKey, requestKey), false, 'reset generation discards a late result');
assert.equal(trackingRunIsCurrent(4, 4, `${requestKey}:changed`, requestKey), false, 'changed request input discards a late result');
assert.notEqual(requestKey, mosaicTrackingInputKey(state, { ...trackedItem, srcInFrame: 13 }, { x: .1, y: .2, width: .2, height: .2 }, .68), 'source timing invalidates an analysis result');
assert.notEqual(requestKey, mosaicTrackingInputKey(state, { ...trackedItem, sourceRevision: 'revision-2' }, { x: .1, y: .2, width: .2, height: .2 }, .68), 'source changes invalidate an analysis result');
assert.notEqual(requestKey, mosaicTrackingInputKey(state, trackedItem, { x: .2, y: .2, width: .2, height: .2 }, .68), 'region changes invalidate an analysis result');
assert.equal(mosaicEffectsAt({ ...item, effects: baseEffects }, 0, 'cover', { width: 320, height: 320 }), baseEffects,
  'untracked legacy static overrides keep their existing renderer semantics');

const contain = mosaicRegionToStage({ centerX: .25, centerY: .5, width: .35, height: .35, strength: 70, feather: 0 },
  { width: 640, height: 360 }, { width: 320, height: 320 }, 'contain')!;
assertNear(contain.centerX, .25, 'contain source x'); assertNear(contain.centerY, .5, 'contain source y');
assertNear(contain.width, .35, 'contain source width'); assertNear(contain.height, .196875, 'contain source height');
const cover = mosaicRegionToStage({ centerX: .25, centerY: .5, width: .35, height: .35, strength: 70, feather: 0 },
  { width: 640, height: 360 }, { width: 320, height: 320 }, 'cover')!;
assertNear(cover.centerX, .05555555555555555, 'cover source x offset'); assertNear(cover.centerY, .5, 'cover source y');
assertNear(cover.width, .6222222222222222, 'cover source width'); assertNear(cover.height, .35, 'cover source height');
const clipped = mosaicRegionToStage({ centerX: .1, centerY: .5, width: .35, height: .35, strength: 70, feather: 25 },
  { width: 640, height: 360 }, { width: 320, height: 320 }, 'cover')!;
assertNear(clipped.centerX, .05, 'partial crop center'); assertNear(clipped.width, .1, 'partial crop width');
assert.equal(clipped.feather, 0, 'the visible crop edge stays hard so feathering cannot expose a clipped target');
assert.equal(mosaicRegionToStage({ centerX: 0, centerY: .5, width: .1, height: .1, strength: 70, feather: 0 },
  { width: 640, height: 360 }, { width: 320, height: 320 }, 'cover'), null, 'fully cropped target is offstage, not clamped to an edge');
const offstageTrack = { ...track, points: track.points.map((point) => ({ ...point, x: 0 })) };
const offstageEffects = mosaicEffectsAt({ ...trackedItem, effects: setMosaicTrack(baseEffects, 'mosaic', offstageTrack)! }, 0, 'cover', { width: 320, height: 320 });
assert.ok(!offstageEffects?.some((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID), 'fully offstage tracked ROI is absent from the shader pass list');

const clearedEffects = clearMosaicTrack(trackedItem, 15, 'mosaic-clear', 'cover', { width: 320, height: 320 });
const cleared = readMosaic(clearedEffects);
assert.equal(clearedEffects[0]?.mosaicTrack, undefined);
assertNear(cleared.region.centerX, .2777777777777778, 'clear freezes the current stage center');
const strengthOnly = setMosaicRegion(trackedEffects, { ...readMosaicAt(trackedItem, 15).region, strength: 55 }, 'strength', true);
assert.ok(strengthOnly[0]?.mosaicTrack, 'strength edit retains tracking');
const sizeEdit = setMosaicRegion(trackedEffects, { ...readMosaicAt(trackedItem, 15).region, width: .5 }, 'size');
assert.equal(sizeEdit[0]?.mosaicTrack, undefined, 'position/size edit clears tracking');

const cutState = { ...state, items: [trackedItem] };
const retimed = reduce(cutState, { type: 'setSpeed', id: item.id, rate: 1 });
const retimedItem = retimed.items.find((entry) => entry.id === item.id)!;
assert.deepEqual(retimedItem.effects?.[0]?.mosaicTrack, track, 'speed action preserves the source-frame curve');
assertNear(readMosaicAt(retimedItem, 30).region.centerX, readMosaicAt(trackedItem, 15).region.centerX, 'speed action preserves source-time sampling');
const leftTrimmed = reduce(cutState, { type: 'retime', id: item.id, startFrame: item.startFrame + 20,
  durationInFrames: 40, srcInFrame: 52 }).items.find((entry) => entry.id === item.id)!;
assert.deepEqual(leftTrimmed.effects?.[0]?.mosaicTrack, track, 'left trim retains the source-frame curve');
assertNear(readMosaicAt(leftTrimmed, 0).region.centerX, readMosaicAt(trackedItem, 20).region.centerX, 'left trim preserves the visible source point');
const split = reduce(cutState, { type: 'split', id: item.id, atFrame: 30, newId: 'clip-right' });
const left = split.items.find((entry) => entry.id === item.id)!;
const right = split.items.find((entry) => entry.id === 'clip-right')!;
assert.deepEqual(right.effects?.[0]?.mosaicTrack, track, 'split copies the source-frame curve intact');
assertNear(readMosaicAt(left, 20).region.centerX, readMosaicAt(right, 0).region.centerX, 'split boundary is continuous');
assert.deepEqual(mosaicTrackingInputKey(state, item, { x: .1, y: .2, width: .2, height: .2 }, .68),
  mosaicTrackingInputKey({ ...state, items: [{ ...item, effects: baseEffects }] }, item, { x: .1, y: .2, width: .2, height: .2 }, .68));

const project = docFromTimeline({ ...state, items: [trackedItem] });
const reopened = migrateProjectDoc(JSON.parse(JSON.stringify(project)))!;
assert.deepEqual(reopened.timelines[0]?.items[0]?.effects?.[0]?.mosaicTrack, track, 'project migration/reload preserves the optional curve');
const originalEffect = project.timelines[0]!.items[0]!.effects![0]!;
const baseProject = docFromTimeline({ ...state, items: [{ ...item, effects: baseEffects }] });
let history = { past: [] as ProjectDoc[], present: baseProject, future: [] as ProjectDoc[] };
history = historyReduce(history, { type: 'batch', actions: [{ type: 'setEffects', id: item.id, effects: setMosaicTrack([originalEffect], 'mosaic', track)! }] });
assert.equal(history.past.length, 1, 'apply is one undo entry');
assert.deepEqual(historyReduce(history, { type: 'undo' }).present.timelines[0]?.items[0]?.effects?.[0]?.mosaicTrack, undefined);
assert.deepEqual(historyReduce(historyReduce(history, { type: 'undo' }), { type: 'redo' }).present.timelines[0]?.items[0]?.effects?.[0]?.mosaicTrack, track);
assert.deepEqual(history.present.timelines[0]?.items[0]?.transform, item.transform, 'tracking changes effects only, never clip transform');

console.log('mosaicTracking.verify: source curves, fit mapping, crop, proxy identity, retime, split, persistence, and history OK');
