import assert from 'node:assert/strict';
import { clipMaskPath, normalizeClipMask, resolveMaskAt } from './clipMask';
import { reduce } from './reduce';
import type { TimelineItem, TimelineState } from './types';

const item = (id: string): TimelineItem => ({
  id,
  track: 'V1',
  kind: 'video',
  name: id,
  src: `/media/uploads/${id}.mp4`,
  startFrame: 0,
  durationInFrames: 90,
  width: 1920,
  height: 1080,
});

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: 'clip',
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
  items: [item('clip')],
};

const rectangle = { type: 'rectangle' as const, x: 0.1, y: 0.2, width: 0.6, height: 0.5 };
const ellipse = { type: 'ellipse' as const, x: 0.25, y: 0.1, width: 0.5, height: 0.8 };

assert.deepEqual(normalizeClipMask({ type: 'rectangle', x: -1, y: 0.2, width: 2, height: 2 }), {
  type: 'rectangle', x: 0, y: 0.2, width: 1, height: 0.8,
}, 'mask geometry is clamped inside the canvas');
assert.equal(normalizeClipMask({ type: 'rectangle', x: Number.NaN, y: 0, width: 1, height: 1 }), null);
assert.equal(clipMaskPath(rectangle), 'inset(20% 30% 30% 10%)');
assert.equal(clipMaskPath(ellipse), 'ellipse(25% 40% at 50% 50%)');
assert.equal(normalizeClipMask({ ...rectangle, feather: 2 })?.feather, 0.5, 'feather is clamped to half the short edge');
assert.equal(clipMaskPath({ ...rectangle, feather: 0.1 }), undefined, 'feathered masks skip hard clip-path fast path');

const animated = {
  ...item('animated'),
  mask: { ...rectangle, feather: 0.05 },
  keyframes: {
    maskX: [{ frame: 0, value: 0.1 }, { frame: 20, value: 0.3 }],
    maskFeather: [{ frame: 0, value: 0 }, { frame: 20, value: 0.1 }],
  },
};
const resolved = resolveMaskAt(animated, 10, { width: 1920, height: 1080 });
assert.equal(resolved?.x, 0.2, 'maskX keyframe resolves at the local frame');
assert.equal(resolved?.feather, 0.05, 'mask feather keyframe resolves at the local frame');
assert.equal(resolved?.featherPx, 54, 'feather converts from short-edge normalization to pixels');

const masked = reduce(state, { type: 'setMask', id: 'clip', mask: rectangle });
assert.deepEqual(masked.items[0]?.mask, rectangle);
assert.notEqual(masked, state, 'mask update is immutable');
assert.deepEqual(reduce(state, { type: 'setMask', id: 'missing', mask: rectangle }), state);
assert.equal(reduce(masked, { type: 'setMask', id: 'clip', mask: { ...rectangle, width: 0 } }).items[0]?.mask?.width, 0.001);

const split = reduce(masked, { type: 'split', id: 'clip', atFrame: 45, newId: 'clip-right' });
assert.deepEqual(split.items.map((entry) => entry.mask), [rectangle, rectangle], 'split keeps the static mask');
const duplicated = reduce(masked, { type: 'duplicate', id: 'clip', newId: 'clip-copy' });
assert.deepEqual(duplicated.items.find((entry) => entry.id === 'clip-copy')?.mask, rectangle, 'duplicate keeps the static mask');

const cleared = reduce(masked, { type: 'setMask', id: 'clip', mask: null });
assert.equal(cleared.items[0]?.mask, undefined);
const animatedState = {
  ...masked,
  items: [{ ...masked.items[0]!, keyframes: { maskX: [{ frame: 0, value: 0.2 }], opacity: [{ frame: 0, value: 1 }] } }],
};
const clearedAnimated = reduce(animatedState, { type: 'setMask', id: 'clip', mask: null }).items[0]!;
assert.equal(clearedAnimated.keyframes?.maskX, undefined, '清除遮罩同一事务清理五条遮罩关键帧');
assert.ok(clearedAnimated.keyframes?.opacity, '清除遮罩不影响其他关键帧');

console.log('clipMask.verify OK');
