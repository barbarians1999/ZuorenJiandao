import assert from 'node:assert/strict';
import { animationFrames, animationProgress, pictureAnimationAt, PICTURE_ANIMATIONS, resolvePictureAnimation,
  rebasePictureAnimationAfterTiming } from './clipAnimation';
import { appearanceAt, clipOpacityAt } from './clipFade';
import { TITLE_ANIMATIONS, resolveTextStyle, titleAnimationStyle, titleGraphemes } from './textStyles';
import { sharedVisualFrame, shareableVisualItem } from './transitionAudio';
import type { TimelineItem, TimelineState } from './types';
import { applyOverwriteLaneAction, splitTimelineItem } from './reducerOverwrite';
import { reduce } from './reducerTimeline';
import { planMagneticTrim } from './magneticTimeline';
import { rateStretchItem } from './rateStretch';
import { neutralPictureProps, pictureAnimationWindows } from '../../shared/picture-animation-timing.mjs';

const item: TimelineItem = { id: 'clip', kind: 'video', name: 'clip', src: '/media/uploads/source.mp4', track: 'V1', startFrame: 60, srcInFrame: 15, durationInFrames: 61, volume: 0.7 };
assert.equal(animationFrames(Number.NaN), 12);
assert.equal(animationFrames(-1), 1);
assert.equal(animationFrames(500), 300);
assert.equal(resolvePictureAnimation({ visualEntrance: 'invalid' }).entrance, 'none');
assert.equal(resolveTextStyle({ entrance: 'invalid' }).entrance, 'none');
assert.deepEqual(animationProgress(0, 1, 30, 30), { entrance: 1, exit: 1 });
assert.deepEqual(animationProgress(0, 2, 30, 30), { entrance: 1, exit: 1 });
assert.deepEqual(animationProgress(1, 2, 30, 30), { entrance: 1, exit: 1 });
assert.deepEqual(animationProgress(2, 5, 30, 30), { entrance: 1, exit: 1 });
assert.deepEqual(animationProgress(0, 5, 30, 30), { entrance: 0, exit: 1 });
assert.deepEqual(animationProgress(4, 5, 30, 30), { entrance: 1, exit: 0 });
for (const { id } of PICTURE_ANIMATIONS) {
  const animated = { ...item, props: { visualEntrance: id, visualExit: id, visualEntranceFrames: 12, visualExitFrames: 18 } };
  const snapshot = JSON.stringify(animated);
  const start = pictureAnimationAt(animated, 0), mid = pictureAnimationAt(animated, 30), end = pictureAnimationAt(animated, 60);
  assert.equal(mid.opacity, 1, `${id}: holds at full opacity`);
  assert.equal(mid.transform, '', `${id}: returns to original layout`);
  assert.equal(mid.blur, 0, `${id}: no residual blur`);
  assert.equal(start.opacity, end.opacity, `${id}: independently reversed exit`);
  if (id !== 'none') assert.notDeepEqual(start, mid, `${id}: is a real effect, not only a catalog label`);
  for (let frame = -10; frame < 75; frame++) {
    const motion = pictureAnimationAt(animated, frame);
    assert.ok(motion.opacity >= 0 && motion.opacity <= 1);
    assert.ok(!/NaN|Infinity/.test(motion.transform));
  }
  assert.equal(JSON.stringify(animated), snapshot, 'no source/volume/state mutation');
  const audio = pictureAnimationAt({ ...animated, kind: 'audio' }, 0);
  for (const frame of [0, 1]) {
    const short = pictureAnimationAt({ ...animated, durationInFrames: 2 }, frame);
    assert.equal(short.opacity, 1, 'two-frame clip must not disappear');
    assert.equal(short.transform, '', 'two-frame clip keeps readable placement');
  }
  assert.equal(audio.opacity, 1); assert.equal(audio.transform, '', 'never animate audio');
  assert.equal(pictureAnimationAt({ ...animated, kind: 'text' }, 0).transform, '', 'text uses its own content motion');
}
assert.ok(PICTURE_ANIMATIONS.length >= 14, 'expanded local catalog');
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'zoom-out' } }, 0).surfaces[0].scale > 1);
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'spin-left' } }, 0).surfaces[0].rotation < 0);
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'spin-right' } }, 0).surfaces[0].rotation > 0);
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'pop', visualEntranceFrames: 12 } }, 7).surfaces[0].scale > 1, 'pop overshoots then settles');
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'blur' } }, 0).blur > 0);
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'whip-left' } }, 0).surfaces[0].x < 0);
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'whip-up' } }, 0).surfaces[0].y > 0);
assert.ok(pictureAnimationAt({ ...item, props: { visualEntrance: 'whip-down' } }, 0).surfaces[0].y < 0);
const original = { ...item, props: { visualEntrance: 'whip-up', visualExit: 'fade', visualEntranceFrames: 18, visualExitFrames: 12 } };
const [left, right] = splitTimelineItem({ fps: 30, items: [original] } as never, original, item.startFrame + 8, 'right');
for (let frame = 0; frame < original.durationInFrames; frame++) {
  assert.deepEqual(pictureAnimationAt(frame < 8 ? left : right, frame < 8 ? frame : frame - 8), pictureAnimationAt(original, frame), 'split inside entrance preserves every frame');
}
const [middle, tail] = splitTimelineItem({ fps: 30, items: [right] } as never, right, right.startFrame + 40, 'tail');
for (let frame = 0; frame < right.durationInFrames; frame++) {
  assert.deepEqual(pictureAnimationAt(frame < 40 ? middle : tail, frame < 40 ? frame : frame - 40), pictureAnimationAt(right, frame), 'repeated split preserves inherited windows');
}
assert.equal(neutralPictureProps({ ...item, props: { visualEntrance: 'none', visualEntranceFrames: 12 } }), true, 'none stays on fast export');
assert.deepEqual(pictureAnimationWindows(original), [[60, 78], [109, 121]]);
// Explicit timing edits reattach only motions actually present in a split fragment.
const hundred = { ...original, durationInFrames: 100 };
const [headFragment, tailFragment] = splitTimelineItem({ fps: 30, items: [hundred] } as never, hundred, hundred.startFrame + 40, 'tail-edit');
const fragmentState = (fragment: TimelineItem): TimelineState => ({ fps: 30, width: 1920, height: 1080,
  selectedId: fragment.id, items: [fragment], trackOrder: ['V1'], tracks: { V1: { kind: 'video' } } });
const retimedTail = reduce(fragmentState(tailFragment), { type: 'retime', id: tailFragment.id, durationInFrames: 40 }).items[0]!;
assert.equal(retimedTail.props!.visualEntrance, 'none', 'a completed inherited entrance does not restart on trim');
assert.equal(retimedTail.props!.visualExit, 'fade');
assert.equal(retimedTail.props!.visualExitWindow, undefined);
assert.equal(pictureAnimationAt(retimedTail, 39).opacity, 0, 'the visible exit follows the new right edge');
assert.equal(pictureAnimationAt(retimedTail, 0).opacity, 1);
const extendedHead = reduce(fragmentState(headFragment), { type: 'retime', id: headFragment.id, durationInFrames: 80 }).items[0]!;
assert.equal(extendedHead.props!.visualExit, 'none', 'extending a fragment does not resurrect an exit outside its old visible range');
assert.equal(pictureAnimationAt(extendedHead, 79).opacity, 1);
const slowedTail = reduce(fragmentState(tailFragment), { type: 'setSpeed', id: tailFragment.id, rate: .5 }).items[0]!;
assert.equal(slowedTail.props!.visualEntrance, 'none');
assert.equal(pictureAnimationAt(slowedTail, slowedTail.durationInFrames - 1).opacity, 0);
const slowedHead = reduce(fragmentState(headFragment), { type: 'setSpeed', id: headFragment.id, rate: .5 }).items[0]!;
assert.equal(slowedHead.props!.visualExit, 'none');
assert.equal(pictureAnimationAt(slowedHead, slowedHead.durationInFrames - 1).opacity, 1);
const stretched = rateStretchItem(fragmentState(tailFragment), tailFragment.id, 'right', 20).items[0]!;
assert.equal(stretched.props!.visualEntrance, 'none');
assert.equal(pictureAnimationAt(stretched, stretched.durationInFrames - 1).opacity, 0);
const magnetic = planMagneticTrim({ ...fragmentState(tailFragment), interaction: { mainTrackId: 'V1', magnet: true } },
  tailFragment.id, { durationInFrames: 40 }).state.items[0]!;
assert.equal(pictureAnimationAt(magnetic, magnetic.durationInFrames - 1).opacity, 0, 'magnetic trims use the same rebase');
const overwriteTrim = applyOverwriteLaneAction(fragmentState(tailFragment), 'V1',
  { type: 'retime', id: tailFragment.id, durationInFrames: 40 })!.items[0]!;
assert.equal(pictureAnimationAt(overwriteTrim, 39).opacity, 0, 'overwrite trims retain the shared timing rule');
const movedOnly = rebasePictureAnimationAfterTiming(tailFragment, { ...tailFragment, startFrame: 500 });
assert.equal(movedOnly.props, tailFragment.props, 'pure movement preserves inherited samples');
assert.equal(rebasePictureAnimationAfterTiming(tailFragment, { ...tailFragment }).props, tailFragment.props);
const [noMotionFragment] = splitTimelineItem(fragmentState(tailFragment), tailFragment, tailFragment.startFrame + 30, 'end-fragment');
const grownMiddle = reduce(fragmentState(noMotionFragment), { type: 'retime', id: noMotionFragment.id, durationInFrames: 100 }).items[0]!;
assert.equal(neutralPictureProps(grownMiddle), true, 'neutral middle fragments remain native after a timing edit');
for (const { id } of TITLE_ANIMATIONS) {
  assert.equal(resolveTextStyle({ entrance: id, exit: id }).entrance, id);
  assert.ok(!JSON.stringify(titleAnimationStyle(id, .5)).includes('NaN'));
  if (['wipe', 'blur', 'spring', 'tracking'].includes(id)) {
    const end = titleAnimationStyle(id, 1, 6);
    if (end.opacity !== undefined) assert.equal(end.opacity, 1);
    if (end.letterSpacing !== undefined) assert.equal(end.letterSpacing, 6);
  }
}
assert.deepEqual(titleGraphemes('章👨‍👩‍👧‍👦e\u0301'), ['章', '👨‍👩‍👧‍👦', 'e\u0301']);
assert.equal(resolveTextStyle({}).entrance, 'none');
assert.equal(resolveTextStyle({}).exit, 'none');
assert.equal(clipOpacityAt(item, 30), 1, 'old clips stay unchanged');
const combined = { ...item, props: { visualEntrance: 'whip', visualEntranceFrames: 20 },
  transform: { x: 7, scale: .8, rotation: 4, crop: { left: .1 } }, filters: { blur: 2 },
  mask: { type: 'ellipse' as const, x: .1, y: .1, width: .8, height: .8 },
  keyframes: { x: [{ frame: 0, value: 7 }, { frame: 20, value: 17 }], maskFeather: [{ frame: 0, value: 0 }, { frame: 20, value: .1 }] } };
const result = appearanceAt(combined, 10, false, { width: 1920, height: 1080 });
assert.ok(result.foregroundStyle.transform?.includes('translate(12%, 0%) rotate(4deg) scale(0.8, 0.8)'), 'motion retains sampled base transform');
assert.equal(result.foregroundStyle.filter, 'brightness(1) contrast(1) saturate(1) blur(3.5px)');
assert.ok(result.foregroundStyle.clipPath); assert.ok(result.mask); assert.ok(result.mask!.featherPx > 0);
assert.equal(result.opacity, .5);
assert.equal(appearanceAt(combined, 10, true).opacity, 0, 'caption hiding still wins');
const group = [item, { ...item, id: 'second', startFrame: 121, srcInFrame: 76, props: { visualEntrance: 'zoom', visualEntranceFrames: 10 } }];
assert.equal(shareableVisualItem({ item: group[1], hasBackgroundFill: false, hasExtendBefore: false, hasExtendAfter: false, hasEntrance: false, hasGlEffect: false }), true, 'picture motion keeps continuous decoder reuse');
const selected = sharedVisualFrame(group, 126)!;
assert.equal(selected.localFrame, 5);
assert.deepEqual(appearanceAt(selected.item, selected.localFrame, false), appearanceAt(group[1], 5, false));
console.log('clipAnimation.verify: all title/picture motions, endpoints, short clips, transforms, masks, audio and shared timing OK');
