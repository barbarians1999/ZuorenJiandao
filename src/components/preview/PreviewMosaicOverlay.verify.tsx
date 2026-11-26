import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerRef } from '@remotion/player';
import { GAUSSIAN_MOSAIC_ID, LOCAL_MOSAIC_ID } from '../../editor/mosaic';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { PreviewMosaicOverlay } from './PreviewMosaicOverlay';

const item: TimelineItem = { id: 'video', kind: 'video', name: 'video', src: '/video.mp4', track: 'V1',
  startFrame: 10, durationInFrames: 90, width: 640, height: 360,
  effects: [{ id: 'mosaic', assetId: GAUSSIAN_MOSAIC_ID, overrides: {
    center_x: .55, center_y: .4, width_ratio: .3, height_ratio: .2, strength: 70, feather: 0,
  } }] };
const state: TimelineState = { fps: 30, width: 640, height: 360, selectedId: item.id, selectedIds: [item.id],
  items: [item], tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'] };
const props = { state, playerRef: { current: { getCurrentFrame: () => 20 } as PlayerRef },
  onSetItemEffects: () => {}, onBeginHistoryGesture: () => {}, onEndHistoryGesture: () => {} };
const markup = renderToStaticMarkup(<PreviewMosaicOverlay {...props} />);
assert.equal((markup.match(/data-mosaic-handle=/g) ?? []).length, 9);
assert(markup.includes('拖动马赛克范围移动') && markup.includes('data-mosaic-selection="video"'));
for (const patch of [
  { selectedIds: ['video', 'other'] },
  { tracks: { V1: { kind: 'video' as const, locked: true } } },
  { selectedId: null },
]) assert(!renderToStaticMarkup(<PreviewMosaicOverlay {...props} state={{ ...state, ...patch }} />).includes('data-mosaic-handle='));
const full = { ...item, effects: [{ id: 'full', assetId: GAUSSIAN_MOSAIC_ID, overrides: {
  center_x: .5, center_y: .5, width_ratio: 1, height_ratio: 1,
} }] };
assert(!renderToStaticMarkup(<PreviewMosaicOverlay {...props} state={{ ...state, items: [full] }} />).includes('data-mosaic-handle='));

// Pixel local mosaic & multi-mosaic selection switching
const multiItem: TimelineItem = {
  ...item,
  effects: [
    ...item.effects!,
    { id: 'pixel-2', assetId: LOCAL_MOSAIC_ID, overrides: { center_x: .25, center_y: .75, width_ratio: .2, height_ratio: .2, block_size: 20, feather: 4 } },
  ],
};
const multiState: TimelineState = { ...state, items: [multiItem] };
const firstSelected = renderToStaticMarkup(<PreviewMosaicOverlay {...props} state={multiState} selectedEffectId="mosaic" />);
assert.equal((firstSelected.match(/data-mosaic-handle=/g) ?? []).length, 9);
assert(firstSelected.includes('data-mosaic-effect-id="mosaic"'));
assert(firstSelected.includes('data-mosaic-select="pixel-2"'));

const secondSelected = renderToStaticMarkup(<PreviewMosaicOverlay {...props} state={multiState} selectedEffectId="pixel-2" />);
assert.equal((secondSelected.match(/data-mosaic-handle=/g) ?? []).length, 9);
assert(secondSelected.includes('data-mosaic-effect-id="pixel-2"'));
assert(secondSelected.includes('data-mosaic-select="mosaic"'));

console.log('PreviewMosaicOverlay.verify: local target, pixel mosaic, multi-mosaic handles, and ineligible states passed');
