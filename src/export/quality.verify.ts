import assert from 'node:assert/strict';
import {
  assessExportQuality,
  captionLayoutQaIssues,
  exportQaExpectations,
  mergeExportQaIssues,
  parseExportQaLog,
  timelineCutTimesSeconds,
} from './quality';
import type { TimelineState } from '../editor/types';
import { qaRequest } from './exportQaOperation';

const parsed = parseExportQaLog(`
[blackdetect @ 0x1] black_start:1.2 black_end:1.7 black_duration:0.5
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 2.1
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 1.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 3.3
[silencedetect @ 0x3] silence_start: 1.8
[silencedetect @ 0x3] silence_end: 5.9 | silence_duration: 4.1
[Parsed_volumedetect_0 @ 0x4] mean_volume: -18.4 dB
[Parsed_volumedetect_0 @ 0x4] max_volume: -0.0 dB
`);
assert.deepEqual(parsed.blackFrames, [{ startSeconds: 1.2, endSeconds: 1.7, durationSeconds: 0.5 }]);
assert.deepEqual(parsed.frozenFrames, [{ startSeconds: 2.1, endSeconds: 3.3, durationSeconds: 1.2 }]);
assert.deepEqual(parsed.silence, [{ startSeconds: 1.8, endSeconds: 5.9, durationSeconds: 4.1 }]);
assert.equal(parsed.meanVolumeDb, -18.4);
assert.equal(parsed.maxVolumeDb, -0);

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['video-main', 'audio-main'],
  tracks: {
    'video-main': { kind: 'video' },
    'audio-main': { kind: 'audio' },
  },
  items: [
    { id: 'v1', track: 'video-main', startFrame: 0, durationInFrames: 90, name: 'one', kind: 'video', src: '/media/uploads/one.mp4' },
    { id: 'v2', track: 'video-main', startFrame: 90, durationInFrames: 60, name: 'two', kind: 'video', src: '/media/uploads/two.mp4' },
    { id: 'v3-gap', track: 'video-main', startFrame: 180, durationInFrames: 30, name: 'gap', kind: 'video', src: '/media/uploads/three.mp4' },
    { id: 'a1', track: 'audio-main', startFrame: 0, durationInFrames: 210, name: 'mix', kind: 'audio', src: '/media/uploads/mix.wav' },
  ],
};
assert.deepEqual(timelineCutTimesSeconds(state), [3]);
assert.deepEqual(exportQaExpectations(state), {
  durationSeconds: 7,
  width: 1920,
  height: 1080,
  fps: 30,
  expectsAudio: true,
  expectedBlackIntervals: [{ startSeconds: 5, endSeconds: 6, durationSeconds: 1 }],
  expectedSilenceIntervals: [],
});

const visualGap: TimelineState = {
  ...state,
  items: [
    { id: 'v-before', track: 'video-main', startFrame: 0, durationInFrames: 30, name: 'before', kind: 'video', src: '/media/uploads/before.mp4' },
    { id: 'v-after', track: 'video-main', startFrame: 60, durationInFrames: 30, name: 'after', kind: 'video', src: '/media/uploads/after.mp4' },
  ],
};
assert.deepEqual(exportQaExpectations(visualGap).expectedBlackIntervals,
  [{ startSeconds: 1, endSeconds: 2, durationSeconds: 1 }], 'an empty picture gap is intentional');
const filledGap: TimelineState = {
  ...visualGap,
  trackOrder: ['video-main', 'video-overlay'],
  tracks: { ...visualGap.tracks, 'video-overlay': { kind: 'video' } },
  items: [...visualGap.items, {
    id: 'overlay', track: 'video-overlay', startFrame: 30, durationInFrames: 30,
    name: 'fills gap', kind: 'video', src: '/media/uploads/overlay.mp4',
  }],
};
assert.deepEqual(exportQaExpectations(filledGap).expectedBlackIntervals, [],
  'a visible overlay prevents the underlying track gap from being exempted');

const faded: TimelineState = {
  ...state,
  items: [{ id: 'fade', track: 'video-main', startFrame: 0, durationInFrames: 90,
    fadeInFrames: 30, fadeOutFrames: 30, name: 'fade', kind: 'video', src: '/media/uploads/fade.mp4' }],
};
assert.deepEqual(exportQaExpectations(faded).expectedBlackIntervals, [
  { startSeconds: 0, endSeconds: 1, durationSeconds: 1 },
  { startSeconds: 2, endSeconds: 3, durationSeconds: 1 },
], 'clip fades are expected only where no other layer covers them');
const fadedWithOverlay: TimelineState = {
  ...faded,
  trackOrder: ['video-main', 'video-overlay'],
  tracks: { ...faded.tracks, 'video-overlay': { kind: 'video' } },
  items: [...faded.items, { id: 'cover', track: 'video-overlay', startFrame: 0, durationInFrames: 90,
    name: 'cover', kind: 'video', src: '/media/uploads/cover.mp4' }],
};
assert.deepEqual(exportQaExpectations(fadedWithOverlay).expectedBlackIntervals, [],
  'fading under a visible overlay does not create an expected black span');
assert.deepEqual(exportQaExpectations(faded, { startFrame: 15, endFrameExclusive: 75 }).expectedBlackIntervals, [
  { startSeconds: 0, endSeconds: 0.5, durationSeconds: 0.5 },
  { startSeconds: 1.5, endSeconds: 2, durationSeconds: 0.5 },
], 'cropped QA windows are relative to output time and intersect original fades');
const croppedRequest = qaRequest(faded, { path: '/media/uploads/cropped.mp4', durationSeconds: 2 }, 30, [15, 75]);
assert.deepEqual(croppedRequest.expectedBlackIntervals, exportQaExpectations(faded, {
  startFrame: 15, endFrameExclusive: 75,
}).expectedBlackIntervals, 'the submitted QA request carries cropped timeline intent windows');
const animatedFade: TimelineState = {
  ...state,
  items: [{ id: 'animated-fade', track: 'video-main', startFrame: 0, durationInFrames: 90,
    props: { visualEntrance: 'fade', visualEntranceFrames: 30, visualExit: 'push-left', visualExitFrames: 30 },
    name: 'animation', kind: 'video', src: '/media/uploads/animation.mp4' }],
};
assert.deepEqual(exportQaExpectations(animatedFade).expectedBlackIntervals,
  [{ startSeconds: 0, endSeconds: 1, durationSeconds: 1 }], 'only the explicit fade animation is an expected black window');

const dipToBlack: TimelineState = {
  ...visualGap,
  items: visualGap.items.map((item) => ({ ...item, startFrame: item.id === 'v-after' ? 30 : 0 })),
  transitions: [{ id: 'dip', type: 'dip-to-black', durationInFrames: 30,
    outgoingItemId: 'v-before', incomingItemId: 'v-after', trackId: 'video-main' }],
};
assert.deepEqual(exportQaExpectations(dipToBlack).expectedBlackIntervals,
  [{ startSeconds: 0.9666666666666667, endSeconds: 1.0666666666666667, durationSeconds: 0.1 }],
  'dip-to-black expects only the transition frames that render the near-full black overlay');
const dipCovered: TimelineState = {
  ...dipToBlack,
  trackOrder: ['video-main', 'video-overlay'],
  tracks: { ...dipToBlack.tracks, 'video-overlay': { kind: 'video' } },
  items: [...dipToBlack.items, { id: 'top', track: 'video-overlay', startFrame: 0, durationInFrames: 90,
    name: 'top', kind: 'video', src: '/media/uploads/top.mp4' }],
};
assert.deepEqual(exportQaExpectations(dipCovered).expectedBlackIntervals, [],
  'an upper visible layer prevents a dip-to-black exemption');

const oneTrackGap: TimelineState = {
  ...state,
  tracks: { ...state.tracks, 'audio-muted': { kind: 'audio', muted: true } },
  items: [
    { id: 'a1', track: 'audio-main', startFrame: 0, durationInFrames: 30, name: 'one', kind: 'audio', src: '/media/uploads/one.wav' },
    { id: 'muted-audio', track: 'audio-muted', startFrame: 0, durationInFrames: 90, name: 'muted', kind: 'audio', src: '/media/uploads/muted.wav', volume: 0 },
  ],
};
assert.deepEqual(exportQaExpectations(oneTrackGap).expectedSilenceIntervals,
  [{ startSeconds: 1, endSeconds: 3, durationSeconds: 2 }], 'an empty audio span is intentional');
const audibleOverlay: TimelineState = {
  ...oneTrackGap,
  trackOrder: ['video-main', 'audio-main', 'audio-overlay'],
  tracks: { ...oneTrackGap.tracks, 'audio-overlay': { kind: 'audio' } },
  items: [...oneTrackGap.items, { id: 'a2', track: 'audio-overlay', startFrame: 0, durationInFrames: 90,
    name: 'continuous', kind: 'audio', src: '/media/uploads/music.wav' }],
};
assert.deepEqual(exportQaExpectations(audibleOverlay).expectedSilenceIntervals, [],
  'a continuously audible second track prevents a silence exemption');

const unexpectedOnEitherSide = assessExportQuality({
  durationSeconds: 3, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true,
  blackFrames: [{ startSeconds: 0, endSeconds: 3, durationSeconds: 3 }],
  frozenFrames: [], silence: [{ startSeconds: 0, endSeconds: 3, durationSeconds: 3 }],
}, { ...exportQaExpectations(visualGap), durationSeconds: 3 });
assert.ok(unexpectedOnEitherSide.issues.some((issue) => issue.code === 'black_frames'
  && issue.startSeconds === 0 && issue.endSeconds! > 1 && issue.endSeconds! < 1.05), 'black before the expected gap remains reportable');
assert.ok(unexpectedOnEitherSide.issues.some((issue) => issue.code === 'black_frames'
  && issue.startSeconds! > 1.95 && issue.startSeconds! < 2 && issue.endSeconds === 3), 'black after the expected gap remains reportable');
const unexpectedSilence = assessExportQuality({
  durationSeconds: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true,
  blackFrames: [], frozenFrames: [], silence: [{ startSeconds: 1, endSeconds: 9, durationSeconds: 8 }],
}, {
  durationSeconds: 10, width: 1920, height: 1080, fps: 30, expectsAudio: true,
  expectedSilenceIntervals: [{ startSeconds: 4, endSeconds: 5, durationSeconds: 1 }],
});
assert.equal(unexpectedSilence.issues.filter((issue) => issue.code === 'long_silence').length, 2,
  'silence outside an intentional gap remains reportable on both sides');

const plannedBlackFreeze = assessExportQuality({
  durationSeconds: 7, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false,
  blackFrames: [{ startSeconds: 2, endSeconds: 5, durationSeconds: 3 }],
  frozenFrames: [{ startSeconds: 2, endSeconds: 5, durationSeconds: 3 }], silence: [],
}, { durationSeconds: 7, width: 1920, height: 1080, fps: 30, expectsAudio: false,
  expectedBlackIntervals: [{ startSeconds: 2, endSeconds: 5, durationSeconds: 3 }] });
assert.deepEqual(plannedBlackFreeze.issues, [], 'a planned chapter gap must not reappear as a frozen-frame error');
const detachedOnly = exportQaExpectations({ ...state, items: state.items.filter((item) => item.kind === 'video')
  .map((item) => ({ ...item, audioDetached: true })) });
assert.equal(detachedOnly.expectsAudio, false, 'detached video has no audible original track');

assert.deepEqual(captionLayoutQaIssues({
  ...state,
  captions: { enabled: true, layout: { anchor: 'bottom-center', offsetYRatio: 0 } },
}), [], '默认字幕位置处于安全区');
const captionIssues = captionLayoutQaIssues({
  ...state,
  captions: { enabled: true, layout: { anchor: 'bottom-right', offsetXRatio: 0.08, offsetYRatio: -0.05 } },
});
assert.deepEqual(captionIssues.map((issue) => issue.code), [
  'caption_safe_area_horizontal',
  'caption_safe_area_vertical',
]);

const report = assessExportQuality({
  durationSeconds: 7.6,
  width: 1280,
  height: 720,
  fps: 25,
  hasVideo: true,
  hasAudio: true,
  ...parsed,
}, exportQaExpectations(state));
assert.equal(report.ok, false);
assert.ok(report.issues.some((issue) => issue.code === 'duration_mismatch' && issue.severity === 'error'));
assert.ok(report.issues.some((issue) => issue.code === 'resolution_mismatch'));
assert.ok(report.issues.some((issue) => issue.code === 'fps_mismatch'));
assert.ok(report.issues.some((issue) => issue.code === 'black_frames'));
assert.ok(report.issues.some((issue) => issue.code === 'frozen_frames'));
assert.ok(report.issues.some((issue) => issue.code === 'long_silence'));
assert.ok(report.issues.some((issue) => issue.code === 'audio_peak'));
const merged = mergeExportQaIssues(report, [...captionIssues, captionIssues[0]]);
assert.equal(merged.issues.filter((issue) => issue.code === 'caption_safe_area_horizontal').length, 1, '附加问题去重');
assert.equal(merged.summary.warnings, report.summary.warnings + 2);

console.log('export quality checks passed');
