import assert from 'node:assert/strict';
import { shareableVisualItem, sharedVisualFrame, continuousVideoAudioGroups, sharedAudioVolume } from './transitionAudio';
import { appearanceAt } from './clipFade';
import { zoomAt } from './zoom';
import type { TimelineItem } from './types';

const base: TimelineItem = {
  id: 'i1',
  track: 'track_v1',
  kind: 'video',
  src: '/media/uploads/x.mp4',
  srcInFrame: 0,
  startFrame: 0,
  durationInFrames: 60,
  name: 'clip',
  volume: 1,
  effects: [],
} as TimelineItem;

const clean = (over: Partial<TimelineItem> = {}, flags: Partial<Parameters<typeof shareableVisualItem>[0]> = {}) => (
  shareableVisualItem({
    item: { ...base, ...over } as TimelineItem,
    hasGlEffect: false,
    hasBackgroundFill: false,
    hasExtendBefore: false,
    hasExtendAfter: false,
    hasEntrance: false,
    ...flags,
  })
);
assert.equal(sharedAudioVolume([{...base,volume:0}], false, () => 1), 0,
  'silent detached-video audio must use numeric volume, avoiding full-timeline callback evaluation');

assert.equal(clean(), true, 'plain consecutive video clip shares');
assert.equal(clean({ kind: 'image' }), false, 'image never shares');
assert.equal(clean({ kind: 'audio' }), false, 'audio never shares');
assert.equal(clean({ src: '' }), false, 'missing src never shares');
assert.equal(clean({ denoisedSrc: '/media/x-denoised.wav' }), false, 'denoised clip keeps its own element');
assert.equal(clean({}, { hasGlEffect: true }), false, 'GL effect clips stay independent');
assert.equal(clean({}, { hasBackgroundFill: true }), false, 'background-fill clips stay independent');
assert.equal(clean({}, { hasExtendBefore: true }), false, 'transition-extended clips stay independent');
assert.equal(clean({}, { hasExtendAfter: true }), false, 'transition-extended clips stay independent');
assert.equal(clean({}, { hasEntrance: true }), false, 'entrance-animated clips stay independent');
assert.equal(clean({ zoom: { magnification: 2, focalPointX: 0.5, focalPointY: 0.5 } }), true, 'zoomed clips still share (zoom applies in the shared layer)');
assert.equal(clean({ transform: { x: 10 } }), false, 'transformed clips stay independent');
assert.equal(clean({ keyframes: { opacity: [{ frame: 0, value: 0.5 }] } }), false, 'keyframed clips stay independent');
assert.equal(clean({ filters: { brightness: 0.8 } }), false, 'filtered clips stay independent');

console.log('shared-visual predicate check passed');

const clips: TimelineItem[] = [
  { ...base, id: 'a', startFrame: 60, durationInFrames: 60, fadeInFrames: 10, fadeOutFrames: 15 },
  { ...base, id: 'b', startFrame: 120, srcInFrame: 60, durationInFrames: 60,
    zoom: { magnification: 2, focalPointX: 0.5, focalPointY: 0.5 } },
];
assert.equal(sharedAudioVolume(clips, true, () => 1), 0, 'track mute overrides clip volume and keyframes');
const audibleVolume = sharedAudioVolume(clips, false, () => .5);
assert.equal(typeof audibleVolume, 'function');
if (typeof audibleVolume !== 'function') throw new Error('audible group must retain its envelope');
assert.equal(audibleVolume(5), .25, 'shared audio preserves the incoming fade and track gain');
assert.equal(audibleVolume(55), 1 / 6, 'shared audio preserves the outgoing fade');
assert.equal(audibleVolume(60), .5, 'clip-boundary volume maps to the next clip');
assert.equal(audibleVolume(120), 0, 'outside the shared group stays silent');
const keyedVolume = sharedAudioVolume([{...base,volume:0,keyframes:{volume:[{frame:0,value:0},{frame:10,value:1}]}}],false,()=>1);
assert.equal(typeof keyedVolume, 'function', 'zero base gain must not suppress animated volume');
if (typeof keyedVolume !== 'function') throw new Error('animated volume callback missing');
assert.equal(keyedVolume(10),1);
assert.equal(continuousVideoAudioGroups(clips).length, 1, 'decoder sharing is preserved');
for (const [frame, id, local, opacity] of [[60, 'a', 0, 0], [65, 'a', 5, 0.5],
  [115, 'a', 55, 1 / 3], [120, 'b', 0, 1], [130, 'b', 10, 1], [179, 'b', 59, 1]] as const) {
  const selected = sharedVisualFrame(clips, frame)!;
  assert.equal(selected.item.id, id);
  assert.equal(selected.localFrame, local);
  assert.equal(appearanceAt(selected.item, selected.localFrame, false).opacity, opacity);
}
assert.equal(sharedVisualFrame([], 0), null);
const selected = sharedVisualFrame(clips, 130)!;
assert.deepEqual(zoomAt(selected.item.zoom!, selected.localFrame, 60), zoomAt(clips[1].zoom!, 10, 60));
const masked = { ...clips[1], mask: { type: 'ellipse' as const, x: 0, y: 0, width: 1, height: 1 },
  keyframes: { maskFeather: [{ frame: 0, value: 0 }, { frame: 20, value: 0.2 }] } };
const maskSample = sharedVisualFrame([clips[0], masked], 130)!;
assert.deepEqual(appearanceAt(maskSample.item, maskSample.localFrame, false, { width: 1920, height: 1080 }),
  appearanceAt(masked, 10, false, { width: 1920, height: 1080 }));
console.log('shared-visual nonzero-start timing checks passed');

for (const rate of [1.005, 0.995, 1.01]) {
  const differentSpeed = [{ ...base, id: 'rate-a', durationInFrames: 60 },
    { ...base, id: 'rate-b', startFrame: 60, srcInFrame: 60, playbackRate: rate }];
  assert.equal(continuousVideoAudioGroups(differentSpeed).length, 0,
    `adjacent rates 1 and ${rate} need independent audio/video decoders`);
}
assert.equal(continuousVideoAudioGroups([{ ...base },
  { ...base, id: 'default-rate', startFrame: 60, srcInFrame: 60, playbackRate: 1 }]).length, 1,
  'missing rate and explicit rate 1 remain equivalent');
