import assert from 'node:assert/strict';
import {
  audioGainAt,
  hasSoloTrack,
  isTrackEffectivelyMuted,
  trackGainLinear,
} from './audioRouting';
import type { TimelineState } from './types';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['V1', 'A1', 'A2', 'C1'],
  tracks: {
    V1: { kind: 'video' },
    A1: { kind: 'audio', soloed: true, audioRouting: { gainDb: 6 } },
    A2: { kind: 'audio' },
    C1: { kind: 'caption', soloed: true },
  },
  items: [
    { id: 'v', track: 'V1', kind: 'video', name: 'video', src: '/v.mp4', startFrame: 0, durationInFrames: 60 },
    { id: 'a1', track: 'A1', kind: 'audio', name: 'a1', src: '/a1.mp3', startFrame: 0, durationInFrames: 60 },
    { id: 'a2', track: 'A2', kind: 'audio', name: 'a2', src: '/a2.mp3', startFrame: 0, durationInFrames: 60 },
  ],
};

assert.equal(hasSoloTrack(state), true);
assert.equal(isTrackEffectivelyMuted(state, 'A1'), false, 'solo track stays audible');
assert.equal(isTrackEffectivelyMuted(state, 'A2'), true, 'other audio tracks are muted');
assert.equal(isTrackEffectivelyMuted(state, 'V1'), true, 'video source audio follows solo mode');
assert.equal(isTrackEffectivelyMuted({ ...state, tracks: { ...state.tracks, A1: { ...state.tracks!.A1, muted: true } } }, 'A1'), true, 'explicit mute wins');
assert.equal(isTrackEffectivelyMuted(state, 'C1'), false, 'caption track is not solo-routed');
assert.ok(Math.abs(trackGainLinear(state, 'A1') - 10 ** (6 / 20)) < 1e-9);
assert.ok(Math.abs(audioGainAt(state, 'A1', 0.5) - 10 ** (6 / 20) * 0.5) < 1e-9);
assert.equal(trackGainLinear({ ...state, tracks: { ...state.tracks, A1: { kind: 'audio', audioRouting: { gainDb: 100 } } } }, 'A1'), 10 ** (12 / 20));
console.log('audio routing check passed');
