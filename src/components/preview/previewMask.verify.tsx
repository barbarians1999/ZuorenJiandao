import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerRef } from '@remotion/player';
import { historyReduce, type History } from '../../editor/reduce';
import { docFromTimeline, migrateProjectDoc } from '../../persist/projectStore';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { resolveMaskAt } from '../../editor/clipMask';
import { PreviewMaskOverlay } from './PreviewMaskOverlay';
import { MASK_HANDLES, dragPreviewMask, previewMaskDelta, previewMaskGeometry, previewMaskPoint,
  previewMaskTarget, previewMaskWrites } from './previewMask';

const item: TimelineItem = { id: 'v', kind: 'video', name: 'Mask', src: '/media/v.mp4', track: 'V1',
  startFrame: 30, durationInFrames: 90,
  mask: { type: 'rectangle', x: .2, y: .2, width: .4, height: .4, feather: .03 },
  transform: { x: 7, y: -3, scaleX: .8, scaleY: .6, rotation: 25, crop: { left: .1 } },
  zoom: { magnification: 1.6, focalPointX: .4, focalPointY: .3 } };
const state: TimelineState = { width: 1920, height: 1080, fps: 30, selectedId: 'v', selectedIds: ['v'],
  items: [item], tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'] };
const near = (a: number, b: number) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const moved = dragPreviewMask(item.mask!, 'move', { x: .1, y: -.1 });
near(moved.x, .3); near(moved.y, .1); near(moved.width, .4); near(moved.feather!, .03);
const bounded = dragPreviewMask(item.mask!, 'move', { x: 5, y: -5 });
near(bounded.x, .6); near(bounded.y, 0); near(bounded.width, .4);
for (const handle of MASK_HANDLES) {
  for (const delta of [{ x: .1, y: .1 }, { x: -5, y: -5 }, { x: 5, y: 5 }]) {
    const next = dragPreviewMask(item.mask!, handle, delta);
    assert(next.x >= 0 && next.y >= 0 && next.width >= .001 - 1e-10 && next.height >= .001 - 1e-10);
    assert(next.x + next.width <= 1 + 1e-10 && next.y + next.height <= 1 + 1e-10);
    if (handle.includes('w')) near(next.x + next.width, .6);
    else near(next.x, .2);
    if (handle.includes('n')) near(next.y + next.height, .6);
    else near(next.y, .2);
  }
}
const animated: TimelineItem = { ...item, props: { visualEntrance: 'whip-up', visualEntranceFrames: 20 },
  keyframes: { x: [{ frame: 0, value: -3, easing: 'linear' }, { frame: 80, value: 8, easing: 'linear' }],
    maskX: [{ frame: 0, value: .2, easing: 'linear' }, { frame: 80, value: .4, easing: 'linear' }] } };
// Numerical round trips also include the animation transform before the base transform.
for (const target of [item, animated, { ...item, transform: { scaleX: -1.2, scaleY: .7, rotation: -65 } }]) {
  for (const frame of [0, 5, 20, 40, 89]) {
    for (const p of [{ x: 0, y: 0 }, { x: 1920, y: 1080 }, { x: 670, y: 840 }]) {
      const displayed = previewMaskPoint(state, target, frame, p)!;
      const back = previewMaskPoint(state, target, frame, displayed, true)!;
      near(back.x, p.x); near(back.y, p.y);
    }
  }
}
const origin = previewMaskPoint(state, item, 20, { x: 0, y: 0 })!;
const end = previewMaskPoint(state, item, 20, { x: 192, y: 108 })!;
const delta = previewMaskDelta(state, item, 20, { x: (end.x - origin.x) / 3, y: (end.y - origin.y) / 3 }, { width: 640, height: 360 })!;
near(delta.x, .1); near(delta.y, .1);
assert.equal(previewMaskPoint(state, { ...item, transform: { scaleX: 0 } }, 20, { x: 0, y: 0 }), null);
assert.equal(previewMaskDelta(state, item, 20, { x: 1, y: 1 }, { width: 0, height: 0 }), null);
const ellipse = previewMaskGeometry(state, { ...item, mask: { ...item.mask!, type: 'ellipse' } }, 20)!;
assert.equal(ellipse.outline.length, 64); near(ellipse.handles.e.x, ellipse.outline[0]!.x);
assert.deepEqual(previewMaskGeometry(state, { ...item, zoom: undefined, transform: { ...item.transform, crop: undefined } }, 20),
  previewMaskGeometry(state, item, 20), 'zoom/crop do not relocate the mask surface');
assert.equal(previewMaskTarget(state, 29), null); assert.equal(previewMaskTarget(state, 120), null);
for (const flags of [{ locked: true }, { hidden: true }]) assert.equal(previewMaskTarget({ ...state, tracks: { V1: { kind: 'video', ...flags } } }, 40), null);
assert.equal(previewMaskTarget({ ...state, selectedIds: ['v', 'other'] }, 40), null);

let h: History = { past: [], present: docFromTimeline(state), future: [] };
h = historyReduce(h, { type: 'history.beginGesture' });
for (const dx of [.02, .07, .12]) {
  const next = dragPreviewMask(item.mask!, 'nw', { x: dx, y: -.05 });
  const writes = previewMaskWrites(item, 20, item.mask!, next);
  assert.equal(writes.keyframes.length, 0);
  h = historyReduce(h, { type: 'setMask', id: 'v', mask: writes.mask });
}
h = historyReduce(h, { type: 'history.endGesture' });
assert.equal(h.past.length, 1);
assert.deepEqual(historyReduce(h, { type: 'undo' }).present.timelines[0]!.items[0]!.mask, item.mask);
assert.deepEqual(migrateProjectDoc(JSON.parse(JSON.stringify(h.present)))!.timelines[0]!.items[0]!.mask,
  h.present.timelines[0]!.items[0]!.mask);
const resolved = resolveMaskAt(animated, 40, state)!;
const writes = previewMaskWrites(animated, 40, resolved, dragPreviewMask(resolved, 'move', { x: .05, y: .05 }));
assert.deepEqual(writes.keyframes, [{ prop: 'maskX', frame: 40, value: resolved.x + .05 }]);
near(writes.mask!.x, item.mask!.x); near(writes.mask!.y, .25);
assert.equal(writes.mask!.feather, .03);
// Dragging away then back must actually restore the start, not leave the last RAF value.
const back = previewMaskWrites({ ...item, mask: moved }, 20, item.mask!, item.mask!, new Set(['x', 'y']));
assert.deepEqual(back.mask, item.mask);

const props = { state, playerRef: { current: { getCurrentFrame: () => 40 } as PlayerRef },
  onSetItemMask: () => {}, onSetItemKeyframe: () => {}, onRemoveItemKeyframe: () => {},
  onBeginHistoryGesture: () => {}, onEndHistoryGesture: () => {} };
const markup = renderToStaticMarkup(<PreviewMaskOverlay {...props} />);
assert.equal((markup.match(/data-mask-handle=/g) ?? []).length, 9);
assert(markup.includes('data-mask-selection="v"') && markup.includes('Esc'));
assert(!markup.includes('data-preview-handle='), 'mask mode must not expose clip-transform handles');
for (const patch of [{ selectedIds: ['v', 'other'] }, { tracks: { V1: { kind: 'video' as const, locked: true } } }, { selectedId: null }]) {
  assert(!renderToStaticMarkup(<PreviewMaskOverlay {...props} state={{ ...state, ...patch }} />).includes('data-mask-handle='));
}
console.log('previewMask.verify: geometry, animation/rotation/crop, bounds, keyframe/static writes, one undo, roundtrip and control isolation passed');
