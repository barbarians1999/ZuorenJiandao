import assert from 'node:assert/strict';
import {
  DEFAULT_MOSAIC,
  FULL_MOSAIC_ID,
  GAUSSIAN_MOSAIC_ID,
  LOCAL_MOSAIC_ID,
  addClipMosaic,
  hasPrivacyMosaic,
  listClipMosaics,
  mosaicPresentation,
  normalizeMosaic,
  readMosaic,
  removeClipMosaicById,
  setMosaicMode,
  setMosaicRegion,
  updateClipMosaicById,
} from './mosaic';
import { reduce, historyReduce, type History } from './reduce';
import { compositionPlan } from './compositionPlan';
import { docFromTimeline, migrateProjectDoc } from '../persist/projectStore';
import type { ClipEffect, TimelineState } from './types';

const other: ClipEffect = { id: 'other', assetId: 'builtin:fx-invert', overrides: { strength: .5 } };
const legacy: ClipEffect = { id: 'old', assetId: 'builtin:fx-local-mosaic', overrides: { block_size: 20 } };
assert.deepEqual(normalizeMosaic({ centerX: -1, centerY: 3, width: 0, height: 3, strength: NaN, feather: Infinity }),
  { centerX: 0, centerY: 1, width: .01, height: 1, strength: 70, feather: 0 });
assert.equal(hasPrivacyMosaic({ effects: [legacy] }), true);
assert.equal(readMosaic([legacy]).legacyCount, 1);
assert.equal(readMosaic([legacy]).mode, 'none', 'Old pixel parameters are not reinterpreted as Gaussian');
const effects = setMosaicMode([other, legacy], 'local', 'blur');
assert.deepEqual(effects.slice(0, 2), [other, legacy], 'Adding Gaussian preserves existing effects');
assert.equal(effects[2]?.assetId, GAUSSIAN_MOSAIC_ID);
assert.deepEqual(readMosaic(effects).region, DEFAULT_MOSAIC);
const changed = setMosaicRegion(effects, { ...DEFAULT_MOSAIC, centerY: .2, strength: 93 }, 'ignored');
assert.equal(changed[2]?.id, 'blur', 'Changing parameters preserves effect identity');
const additional = [...changed, { ...changed[2]!, id: 'second' }];
assert.deepEqual(setMosaicRegion(additional, DEFAULT_MOSAIC, 'ignored')[3], additional[3], 'Other redactions are retained');
assert.deepEqual(setMosaicMode(additional, 'none', 'unused'), [other]);
assert.equal(readMosaic(setMosaicMode(changed, 'full', 'unused')).mode, 'full');
assert.equal(readMosaic(setMosaicMode(changed, 'full', 'unused')).region.strength, 93);
for (const protectedSource of [false, true]) for (const readyForCurrentFrame of [false, true]) {
  const result = mosaicPresentation({ protectedSource, readyForCurrentFrame });
  assert.equal(result.showSource, !protectedSource && !readyForCurrentFrame);
  assert.equal(result.showCanvas, readyForCurrentFrame);
  assert.equal(result.showProtection, protectedSource && !readyForCurrentFrame);
  assert.equal(Number(result.showSource) + Number(result.showCanvas) + Number(result.showProtection), 1);
}
const state: TimelineState = { fps: 30, width: 640, height: 360, selectedId: 'a', tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'],
  items: [{ id: 'a', name: 'a', track: 'V1', kind: 'video', startFrame: 15, srcInFrame: 60, durationInFrames: 60,
    src: '/original.mp4', width: 640, height: 360, volume: .8 },
  { id: 'b', name: 'b', track: 'V1', kind: 'video', startFrame: 75, srcInFrame: 120, durationInFrames: 60,
    src: '/original.mp4', width: 640, height: 360 }] };
let h: History = { past: [], present: docFromTimeline(state), future: [] };
h = historyReduce(h, { type: 'setEffects', id: 'a', effects });
assert.equal(h.past.length, 1);
const saved = migrateProjectDoc(JSON.parse(JSON.stringify(h.present)))!;
assert.deepEqual(saved.timelines[0]?.items[0]?.effects, effects);
assert.equal(saved.timelines[0]?.items[0]?.volume, .8);
assert.equal(saved.timelines[0]?.items[0]?.src, '/original.mp4');
assert.equal(historyReduce(h, { type: 'undo' }).present.timelines[0]?.items[0]?.effects, undefined);
const blurred = h.present.timelines[0]!;
const split = reduce(blurred, { type: 'split', id: 'a', atFrame: 45, newId: 'right' });
assert.deepEqual(split.items.find((item) => item.id === 'right')?.effects, effects);
const duplicate = reduce(blurred, { type: 'duplicate', id: 'a', newId: 'copy' });
assert.deepEqual(duplicate.items.find((item) => item.id === 'copy')?.effects, effects);
const transitionState = { ...blurred, transitions: [{ id: 't', outgoingItemId: 'a', incomingItemId: 'b', trackId: 'V1',
  type: 'cross-dissolve' as const, durationInFrames: 16 }] };
const exact = compositionPlan(transitionState, { registeredEffects: { [GAUSSIAN_MOSAIC_ID]: {} } });
assert.equal(exact.glWindows.length, 0);
assert.equal(exact.entranceOf.get('b')?.type, 'cross-dissolve');
assert.equal(exact.sharedVisualGroups.length, 0);
const light = compositionPlan(transitionState, { mode: 'player', selectedItemId: 'b' });
assert.equal(light.staticPreviewStatuses[0]?.fallbackReason, 'privacy-transition');
const clear = { ...transitionState, items: state.items };
assert.equal(compositionPlan(clear).glWindows.length, 1, 'Unprotected transition behavior stays unchanged');

// Multi-mosaic unified operations (list / add / switch style & mode / Y-axis conversion / remove)
let multiEffects = addClipMosaic([], 'm1');
multiEffects = addClipMosaic(multiEffects, 'm2');
const list = listClipMosaics(multiEffects);
assert.equal(list.length, 2);
assert.equal(list[0]?.id, 'm1');
assert.equal(list[1]?.id, 'm2');
assert.notDeepEqual(
  [list[0]?.region.centerX, list[0]?.region.centerY],
  [list[1]?.region.centerX, list[1]?.region.centerY],
  '新增第二个马赛克时默认位置应略微错开以便区分',
);

// Switching m2 to pixel local mosaic must map top-down UI centerY (e.g. 0.2) <-> bottom-up shader center_y (0.8)
multiEffects = updateClipMosaicById(multiEffects, 'm2', {
  style: 'pixel',
  mode: 'local',
  region: { centerX: 0.4, centerY: 0.2, width: 0.25, height: 0.2 },
  blockSize: 28,
});
const rawM2 = multiEffects.find((fx) => fx.id === 'm2')!;
assert.equal(rawM2.assetId, LOCAL_MOSAIC_ID);
assert.equal(rawM2.overrides?.center_y, 0.8, 'local-mosaic shader uses bottom-up UV center_y');
assert.equal(rawM2.overrides?.block_size, 28);
const listedM2 = listClipMosaics(multiEffects).find((m) => m.id === 'm2')!;
assert.ok(Math.abs(listedM2.region.centerY - 0.2) < 1e-4, 'UI readback restores top-down centerY');
assert.equal(listedM2.style, 'pixel');
assert.equal(listedM2.mode, 'local');

// Switching m2 to pixel full-screen uses builtin:fx-pixelate
multiEffects = updateClipMosaicById(multiEffects, 'm2', { mode: 'full', blockSize: 16 });
assert.equal(multiEffects.find((fx) => fx.id === 'm2')?.assetId, FULL_MOSAIC_ID);
assert.equal(listClipMosaics(multiEffects).find((m) => m.id === 'm2')?.mode, 'full');

// Removing m1 leaves m2 intact as index 1
multiEffects = removeClipMosaicById(multiEffects, 'm1');
const afterRemove = listClipMosaics(multiEffects);
assert.equal(afterRemove.length, 1);
assert.equal(afterRemove[0]?.id, 'm2');
assert.equal(afterRemove[0]?.index, 1);

console.log('mosaic.verify: Gaussian controls, multi-mosaic, legacy compatibility, privacy states, history, split, persistence and composition passed');
