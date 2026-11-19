import assert from 'node:assert/strict';
import { appearanceAt } from '../editor/clipFade';
import { pictureAnimationAt } from '../editor/clipAnimation';
import type { TimelineItem } from '../editor/types';
import { paintTransitionPlacement, transitionPlacementRequired } from './transitionPlacement';

const item: TimelineItem = { id: 'clip', name: 'clip', kind: 'image', track: 'V1', startFrame: 60, durationInFrames: 61,
  props: { visualEntrance: 'whip', visualEntranceFrames: 20 },
  transform: { x: 7, scaleX: .8, scaleY: .6, rotation: 4, crop: { left: .1 }, opacity: .7 },
  mask: { type: 'ellipse', x: .1, y: .1, width: .8, height: .8 },
  keyframes: { x: [{ frame: 0, value: 7 }, { frame: 20, value: 17 }], maskFeather: [{ frame: 0, value: 0 }, { frame: 20, value: .1 }] },
};
const source = { width: 1920, height: 1080 } as HTMLCanvasElement;
const appearance = appearanceAt(item, 10, false, source), motion = pictureAnimationAt(item, 10);
assert.deepEqual(appearance.transformSurfaces, [
  { x: 12.5, y: 0, rotation: 1.5, scaleX: 1, scaleY: 1 },
  { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  { x: 12, y: 0, rotation: 4, scaleX: .8, scaleY: .6 },
]);
assert.deepEqual(appearance.cropRect, { x: 192, y: 0, width: 1728, height: 1080 });
assert.ok(appearance.mask && appearance.mask.featherPx > 0, 'resolved feather stays with the source');
assert.equal(appearance.opacity, .35, 'opacity belongs to the later GL pass');
assert.equal(transitionPlacementRequired(appearance, motion.blur), true);
assert.equal(transitionPlacementRequired(appearanceAt({ ...item, transform: undefined, keyframes: undefined, props: {} }, 10, false, source), 0), false, 'unchanged clips do not allocate a placement canvas');

const calls: Array<{ name: string; args: unknown[] }> = [];
const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
const ctx = { clearRect: record('clear'), save: record('save'), restore: record('restore'),
  translate: record('translate'), rotate: record('rotate'), scale: record('scale'), beginPath: record('begin'),
  rect: record('rect'), clip: record('clip'), drawImage: record('draw'), filter: 'none', globalAlpha: 1 };
paintTransitionPlacement(ctx as unknown as CanvasRenderingContext2D, source, appearance, motion.blur);
const scales = calls.filter(({ name }) => name === 'scale');
assert.deepEqual(scales.map(({ args }) => args), [[1, 1], [1, 1], [.8, .6]], 'animation precedes independent base X/Y scaling');
assert.ok(calls.some(({ name, args }) => name === 'translate' && args[0] === 230.4 && args[1] === 0), 'sampled base position reaches the canvas');
assert.deepEqual(calls.find(({ name }) => name === 'rect')!.args, [192, 0, 1728, 1080]);
assert.ok(calls.findIndex(({ name }) => name === 'rect') > calls.findIndex(({ name }) => name === 'scale'), 'crop is in transformed local coordinates');
assert.equal(ctx.filter, 'blur(1.5px)');
assert.equal(ctx.globalAlpha, 1, 'do not apply appearance opacity twice');
assert.equal(calls.at(-1)!.name, 'restore');
const previousRestore = calls.filter(({ name }) => name === 'restore').length;
ctx.drawImage = () => { throw new Error('paint failed'); };
assert.throws(() => paintTransitionPlacement(ctx as unknown as CanvasRenderingContext2D, source, appearance, 0), /paint failed/);
assert.equal(calls.filter(({ name }) => name === 'restore').length, previousRestore + 1, 'restore after a paint failure');
console.log('transitionPlacement: shared sampled transforms, crop, mask, blur, opacity and canvas cleanup passed');
