import assert from 'node:assert/strict';
import {
  DEFAULT_COMPOSITION_MOSAIC, compositionMosaicShapeMarkup,
  compositionMosaicRect, compositionMosaicSigma, parseCompositionMosaic,
  compositionMosaicMatrix, compositionMosaicProtectionRect,
  compositionMosaicMaskAsset,
} from './compositionMosaic';

const initial = { ...DEFAULT_COMPOSITION_MOSAIC };
assert.deepEqual(parseCompositionMosaic(initial), initial);
for (const patch of [
  { centerX: NaN }, { height: 0 }, { width: 2 }, { strength: 0 }, { feather: -1 },
  { opacity: 1.1 }, { shape: 'unknown' }, { opacity: '1' },
]) assert.equal(parseCompositionMosaic({ ...initial, ...patch }), null);
assert.equal(parseCompositionMosaic(null), null);
assert.equal(parseCompositionMosaic({}), null);
assert.deepEqual(compositionMosaicRect({ ...initial, centerX: .25, centerY: .5, width: .2, height: .4 }, 1000, 500),
  { x: 150, y: 150, width: 200, height: 200 });
assert.equal(compositionMosaicSigma({ ...initial, strength: 1 }), 1);
assert.equal(compositionMosaicSigma({ ...initial, strength: 100 }), 24);
const move = compositionMosaicMatrix([{ x: 10, y: -10, rotation: 0, scaleX: 1, scaleY: 1 }], 1000, 500)!;
assert.deepEqual(move, [1, 0, 0, 1, 100, -50]);
assert.deepEqual(compositionMosaicProtectionRect({ ...initial, width: .2, height: .4 }, 1000, 500, move),
  { x: 500, y: 100, width: 200, height: 200 });
const rotate = compositionMosaicMatrix([{ x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 }], 1000, 500)!;
const rotated = compositionMosaicProtectionRect({ ...initial, width: .4, height: .2 }, 1000, 500, rotate);
assert.ok(Math.abs(rotated.width - 100) < 1e-8 && Math.abs(rotated.height - 400) < 1e-8);
assert.equal(compositionMosaicMatrix([{ x: NaN, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }], 1000, 500), null);
const baseAsset = compositionMosaicMaskAsset(initial, 1000, 500, [1, 0, 0, 1, 0, 0])!;
const movedAsset = compositionMosaicMaskAsset({ ...initial, opacity: .5 }, 1000, 500, [2, 0, 0, 2, 100, -50])!;
assert.equal(baseAsset.source, movedAsset.source, 'translation, uniform scaling and opacity do not reload the mask');
assert.equal(movedAsset.width, baseAsset.width * 2);
assert.equal(movedAsset.x, baseAsset.x * 2 + 100);
assert.throws(() => compositionMosaicShapeMarkup(initial, 0, 1080, 'test'));
assert.throws(() => compositionMosaicShapeMarkup(initial, 1920, NaN, 'test'));
assert.throws(() => compositionMosaicShapeMarkup(initial, 1920, 1080, '<invalid>'));
console.log('compositionMosaic.verify: invalid data, coordinates and blur bounds passed; masks require pixel validation');
