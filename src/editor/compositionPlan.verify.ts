import assert from 'node:assert/strict';
import { compositionPlan, previewLayerWindow, previewVideoMounts } from './compositionPlan';
import type { TimelineItem, TimelineState } from './types';
import { sharedVisualFrame } from './transitionAudio';
import { appearanceAt } from './clipFade';
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
const previewWindows = [
  { key: 'past-outside', from: 0, to: 69 },
  { key: 'past-third', from: 69, to: 70 },
  { key: 'past-second', from: 70, to: 80 },
  { key: 'past-nearest', from: 80, to: 95 },
  { key: 'playing-a', from: 95, to: 110 },
  { key: 'playing-b', from: 0, to: 180 },
  { key: 'future-nearest', from: 110, to: 118 },
  { key: 'future-second', from: 118, to: 122 },
  { key: 'future-third', from: 122, to: 130 },
  { key: 'future-outside', from: 131, to: 170 },
  { key: 'selected', from: 200, to: 220, selected: true },
];
assert.deepEqual(previewLayerWindow(previewWindows, 100, 30), new Set([
  'playing-a', 'playing-b', 'selected', 'past-nearest', 'past-second', 'future-nearest', 'future-second',
]), 'keep two nearby layers per direction, plus every active or selected layer');
assert.deepEqual(previewLayerWindow(previewWindows, 100, 30, 1), new Set([
  'playing-a', 'playing-b', 'selected', 'past-nearest', 'future-nearest',
]), 'limit expensive offscreen transitions to the nearest one per direction');
assert.deepEqual(previewLayerWindow(previewWindows, 180, 30), new Set([
  'playing-b', 'future-outside', 'selected',
]), 'keep the recently exited layers at an exclusive cut even when seeking backward');
const videoWindows = [
  { key: 'past', from: 0, to: 69, decoderSource: '/a.mp4' },
  { key: 'current', from: 80, to: 150, decoderSource: '/b.mp4' },
  { key: 'future', from: 145, to: 170, decoderSource: '/c.mp4' },
  { key: 'effect', from: 68, to: 69 },
];
const playingWindow = previewLayerWindow(videoWindows, 107, 30);
assert.deepEqual(previewVideoMounts(videoWindows, playingWindow, 107, 30, 120), {
  mounted: new Set(['current']), retained: undefined, visitedSources: new Set(['/b.mp4']),
}, 'a fresh seek never opens additional video');
const mountedHistory = { mounted: new Set(['past', 'future', 'effect']), visitedSources: new Set(['/a.mp4']) };
assert.equal(previewVideoMounts(videoWindows, playingWindow, 107, 30, 120, mountedHistory).retained, undefined,
  'the first visit to a source frees extra video');
const visitedHistory = { ...mountedHistory, visitedSources: new Set(['/a.mp4', '/b.mp4']) };
assert.deepEqual(previewVideoMounts(videoWindows, playingWindow, 107, 30, 120, visitedHistory), {
  mounted: new Set(['current', 'future']), retained: 'future', visitedSources: visitedHistory.visitedSources,
}, 'keep only the closest eligible mounted source when seeking out of its normal window');
assert.deepEqual(previewVideoMounts(videoWindows, playingWindow, 107, 30, 120, {
  ...visitedHistory, mounted: new Set(['past', 'effect']),
}), {
  mounted: new Set(['current', 'past']), retained: 'past', visitedSources: visitedHistory.visitedSources,
}, 'never retain effect layers, even when they were mounted');
assert.equal(previewVideoMounts(videoWindows, new Set(['current', 'future']), 144, 30, 75, visitedHistory).retained, undefined,
  'release the decoder outside the retention window');
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
const previewRun: TimelineState = { ...state, items: [
  { ...clip('edge-off', 30, 240), pictureDisabled: true },
  { ...clip('a', 90, 300), transform: { x: 6 } },
  { ...clip('audio-only', 150, 360), pictureDisabled: true },
  { ...clip('b', 210, 420), filters: { brightness: 0.5 } },
] };
const previewPlan = compositionPlan(previewRun, { mode: 'player' });
assert.deepEqual(previewPlan.ordered.map((item) => item.id), ['a', 'b']);
assert.deepEqual(previewPlan.visualLayers.map((group) => group.map((item) => item.id)), [['a', 'audio-only', 'b']]);
assert.deepEqual(compositionPlan(previewRun).visualLayers.map((group) => group.map((item) => item.id)), [['a'], ['b']]);
const [run] = previewPlan.sharedVisualGroups;
const audioOnly = sharedVisualFrame(run!, 179)!;
assert.equal(appearanceAt(audioOnly.item, audioOnly.localFrame, audioOnly.item.pictureDisabled === true).opacity, 0);
const nextPicture = sharedVisualFrame(run!, 210)!;
assert.match(appearanceAt(nextPicture.item, nextPicture.localFrame, false).foregroundStyle.filter!, /brightness\(0\.5\)/);
const interveningLayer: TimelineItem = { ...clip('overlay', 170, 0), kind: 'image', src: '/overlay.png' };
assert.deepEqual(compositionPlan({ ...previewRun, items: [...previewRun.items, interveningLayer] }, { mode: 'player' })
  .visualLayers.map((group) => group[0]!.id), ['a', 'overlay', 'b']);
const differentClock = previewRun.items.map((item) => item.id === 'b' ? { ...item, srcInFrame: 421 } : item);
assert.equal(compositionPlan({ ...previewRun, items: differentClock }, { mode: 'player' }).sharedVisualGroups.length, 0);
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

// Standalone mosaics only force exact GL transitions when overlapping in time above the transition window.
{
  const mosaicTimeline: TimelineState = {
    ...state,
    compositingOrder: 'tracks',
    trackOrder: ['M1', 'V1', 'A1'],
    tracks: { M1: { kind: 'video', visualRole: 'effect' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
    items: [
      { ...clip('d1', 0, 0, 'V1'), denoisedSrc: '/clean.wav', keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 30, value: 0.5 }] }, zoom: { magnification: 1.2 }, mask: { type: 'rectangle', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0 } },
      { ...clip('d2', 60, 60, 'V1'), denoisedSrc: '/clean.wav' },
      { ...clip('t1', 200, 0, 'V1') },
      { ...clip('t2', 260, 60, 'V1') },
      {
        id: 'far-mosaic', name: 'far-mosaic', kind: 'mosaic', track: 'M1', startFrame: 0, durationInFrames: 40,
        mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.2, height: 0.2, strength: 60, feather: 0, opacity: 1 },
      },
    ],
    transitions: [{
      id: 'far-tr', outgoingItemId: 't1', incomingItemId: 't2', trackId: 'V1',
      type: 'cross-dissolve', durationInFrames: 16,
    }],
  };
  const p = compositionPlan(mosaicTimeline, { mode: 'player' });
  assert.equal(p.glWindows.length, 0, 'non-overlapping mosaic does not force unselected transitions into dual-decoder WebGL');
  assert.deepEqual(
    p.sharedVisualGroups.map((group) => group.map((c) => c.id)),
    [['d1', 'd2']],
    'denoised/volume-keyframed/zoom/masked adjacent clips share visual decoders in Player mode',
  );
}

console.log('compositionPlan.verify: ordering, source frames, reuse, transitions, mask, nesting and sound passed');
