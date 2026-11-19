import assert from 'node:assert/strict';
import { compositionPlan } from './compositionPlan';
import type { TimelineItem, TimelineState } from './types';
import { sharedVisualFrame } from './transitionAudio';
import { appendManualCue, newManualCaptions } from '../captions/manualCaptions';

const clip = (id: string, startFrame: number, srcInFrame: number, track = 'V1'): TimelineItem => ({
  id, name: id, kind: 'video', track, startFrame, srcInFrame,
  durationInFrames: 60, src: '/original.mp4', width: 1920, height: 1080,
});
const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V2', 'V1', 'V3', 'A1'],
  tracks: { V2: { kind: 'video' }, V1: { kind: 'video', role: 'anchor' },
    V3: { kind: 'video', hidden: true }, A1: { kind: 'audio', role: 'follower' } },
  items: [clip('a', 90, 300), clip('b', 150, 360), clip('top', 100, 600, 'V2'),
    clip('hidden', 0, 0, 'V3'),
    { ...clip('music', 0, 0, 'A1'), kind: 'audio', durationInFrames: 900 }],
};
const before = JSON.stringify(state);
// Shared decoders must occupy their track's paint slot, not a global underlay.
const layering = compositionPlan({ ...state, items: [
  clip('lower-single', 90, 0, 'V1'),
  clip('upper-a', 90, 0, 'V2'), clip('upper-b', 150, 60, 'V2'),
] });
const paintLayers = layering.pictureLayers.flatMap(layer => layer.kind === 'visual' ? [layer.items] : []);
assert.deepEqual(paintLayers.map((layer) => layer[0].id), ['lower-single', 'upper-a'],
  'shared upper track must paint after the lower independent clip');
assert.equal(layering.sharedVisualGroups.length, 1, 'preserve continuous decoder reuse');
assert.deepEqual(paintLayers.flatMap(group => group.map(item => item.id)), ['lower-single', 'upper-a', 'upper-b'],
  'the rendered picture plan contains each surface once in its track position');
const bothShared = compositionPlan({ ...state, trackOrder: ['V1', 'V2'], items: [
  clip('top-a', 0, 0), clip('top-b', 60, 60),
  clip('bottom-a', 0, 0, 'V2'), clip('bottom-b', 60, 60, 'V2'),
] });
assert.deepEqual(bothShared.visualLayers.map((layer) => layer.map((item) => item.id)),
  [['bottom-a', 'bottom-b'], ['top-a', 'top-b']], 'shared groups follow track order, not lexical track id');
const plan = compositionPlan(state);
assert.deepEqual(plan.ordered.map((item) => item.id), ['a', 'b', 'top']);
assert.deepEqual(plan.audio.map((item) => item.id), ['music']);
assert.deepEqual(plan.sharedVisualGroups.map((group) => group.map((item) => item.id)), [['a', 'b']]);
assert.equal(plan.sourceFrameFor('a', 90), 300);
assert.equal(plan.sourceFrameFor('b', 150), 360);
assert.equal(plan.sourceFrameFor('missing', 90), null);
assert.equal(sharedVisualFrame(plan.sharedVisualGroups[0]!, 150)?.localFrame, 0,
  'group start is not added a second time at nonzero cuts');
assert.equal(plan.gainAt('A1', 89), 1);
assert(Math.abs(plan.gainAt('A1', 90) - 10 ** (-12 / 20)) < 1e-10);
assert.equal(compositionPlan(state, { forceMuted: true }).isMuted('V1'), true);
assert.equal(compositionPlan(state, { forceMuted: true }).gainAt('A1', 90), 1);

const transitionState: TimelineState = { ...state, transitions: [{
  id: 'dissolve', outgoingItemId: 'a', incomingItemId: 'b', trackId: 'V1',
  type: 'cross-dissolve', durationInFrames: 15,
}] };
const exact = compositionPlan(transitionState);
const selected = compositionPlan(transitionState, { mode: 'player', selectedItemId: 'b' });
const light = compositionPlan(transitionState, { mode: 'player' });
const window = exact.glWindows[0]!;
assert.equal(window.from, 143);
assert.equal(window.trimOut, 353);
assert.equal(window.trimIn, 353);
const pixelsOnly = (windows: typeof exact.glWindows) => windows.map(({ previewTargetId: _ignored, ...rest }) => rest);
assert.deepEqual(pixelsOnly(selected.glWindows), pixelsOnly(exact.glWindows));
assert.equal(light.glWindows.length, 0);
assert.deepEqual(light.extendBefore, exact.extendBefore);
assert.deepEqual(light.extendAfter, exact.extendAfter);
assert.deepEqual(light.ordered, exact.ordered);
assert.equal(exact.sharedVisualGroups.length, 0, 'transition clips keep separate decoder surfaces');

const animated: TimelineState = { ...state, items: state.items.map((item) => item.id === 'a'
  ? { ...item, mask: { type: 'ellipse', x: 0, y: 0, width: 1, height: 1, feather: 0.02 },
      keyframes: { maskFeather: [{ frame: 0, value: 0.02 }, { frame: 59, value: 0.1 }] } }
  : item) };
assert.equal(compositionPlan(animated).sharedVisualGroups.length, 0);
const nested: TimelineState = { ...state, items: [{ ...clip('nested', 90, 30), kind: 'sequence', timelineId: 'child' }] };
assert.equal(compositionPlan(nested).sourceFrameFor('nested', 100), 40);
assert.equal(JSON.stringify(state), before, 'planning never mutates engineering/source data');
// Effect/mosaic layers and visual clips always sit strictly below caption tracks in pictureLayers.
{
  const baseCaptions = newManualCaptions();
  const laneId = baseCaptions.sourceEntries![0]!.id;
  const captionsData = { ...baseCaptions, ...appendManualCue(baseCaptions, laneId, '上方字幕', 0, 1000) };
  const mosaicAndCaptions: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    compositingOrder: 'tracks',
    trackOrder: ['C1', 'V2', 'V1'],
    tracks: {
      C1: { kind: 'caption', captions: captionsData },
      V2: { kind: 'video' },
      V1: { kind: 'video' },
    },
    captions: captionsData,
    items: [
      clip('base-v1', 0, 0, 'V1'),
      {
        id: 'fx-mosaic-v2',
        name: '局部模糊',
        kind: 'mosaic',
        track: 'V2',
        startFrame: 0,
        durationInFrames: 60,
        mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.3, height: 0.2, strength: 70, feather: 0, opacity: 1 },
      },
    ],
  };
  const layered = compositionPlan(mosaicAndCaptions);
  const kinds = layered.pictureLayers.map((layer) => layer.kind);
  const mosaicIdx = kinds.indexOf('mosaic');
  const captionIdx = kinds.indexOf('captions');
  assert.ok(mosaicIdx >= 0 && captionIdx >= 0, '马赛克层与字幕层都必须进入合成队列');
  assert.ok(mosaicIdx < captionIdx, '特效/马赛克层必须严格排在字幕层下方，不能遮挡上方字幕');
}

console.log('compositionPlan.verify: ordering, source frames, reuse, transitions, mask, nesting and sound passed');
