import assert from 'node:assert/strict';
import { detachAudio, detachAudioUnavailable } from './detachAudio';
import { volumeAtFrame } from './keyframes';
import type { TimelineState } from './types';
import { historyReduce } from './reduce';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';

const state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: 'v', trackOrder: ['V1', 'A1'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [{ id: 'v', track: 'V1', kind: 'video', name: 'clip', src: '/clip.mp4', pictureDisabled: true, startFrame: 30,
    durationInFrames: 60, srcInFrame: 45, playbackRate: 2, fadeInFrames: 5,
    volume: 0.8, keyframes: { volume: [{ frame: 0, value: 0.4 }, { frame: 30, value: 0.7 }], opacity: [{ frame: 0, value: 0.5 }] } }],
};
let n = 0;
const uid = (prefix: string) => `${prefix}_${++n}`;
const result = detachAudio(state, 'v', uid);
const video = result.items[0]!;
const audio = result.items[1]!;
assert.equal(audio.track, 'A1');
assert.equal(audio.kind, 'audio');
assert.equal(audio.src, '/clip.mp4');
assert.equal(audio.startFrame, 30);
assert.equal(audio.durationInFrames, 60);
assert.equal(audio.srcInFrame, 45);
assert.equal(audio.playbackRate, 2);
assert.equal(audio.audioDetached, true, 'detached audio retains its renderer identity');
assert.equal(audio.pictureDisabled, undefined, 'detached audio has no picture-only state');
assert.equal(audio.fadeInFrames, 5);
assert.equal(volumeAtFrame(video, 10), 0);
assert.equal(video.pictureDisabled, true, 'detaching preserves the video picture state');
assert.equal(volumeAtFrame(audio, 30), 0.7);
assert.ok(video.keyframes?.opacity);
assert.equal(result.selectedId, audio.id);
assert.equal(detachAudio(result, 'v', uid), result);
assert.equal(detachAudio({ ...state, tracks: { V1: { locked: true } } }, 'v', uid).items.length, 1);
const occupied = { ...state, items: [...state.items, { ...audio, id: 'occupied' }] };
const withNewTrack = detachAudio(occupied, 'v', uid);
assert.notEqual(withNewTrack.items.at(-1)!.track, 'A1');
assert.equal(withNewTrack.tracks?.[withNewTrack.items.at(-1)!.track]?.kind, 'audio');
const doc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main',
  timelines: [{ ...state, id: 'main', name: 'main', order: 0 }] };
const history = historyReduce({ past: [], present: doc, future: [] }, { type: 'setFullState', state: result });
assert.equal(history.present.timelines[0]!.items.length, 2);
assert.equal(historyReduce(history, { type: 'undo' }).present, doc);
assert.equal(historyReduce(historyReduce(history, { type: 'undo' }), { type: 'redo' }).present.timelines[0]!.items.length, 2);
const transitioned: TimelineState = { ...state, transitions: [{ id: 'tr', type: 'audio-cross-fade', trackId: 'V1', outgoingItemId: 'v', incomingItemId: 'next', durationInFrames: 10 }] };
assert.equal(detachAudio(transitioned, 'v', uid), transitioned);

const nextVideo = { ...state.items[0]!, id: 'v2', startFrame: 90, srcInFrame: 300, playbackRate: .5, volume: .6 };
const image = { id: 'image', kind: 'image' as const, name: 'image', track: 'V2', startFrame: 0, durationInFrames: 90, src: '/still.png' };
const multi: TimelineState = { ...state, selectedIds: ['v', 'v2', 'image'], items: [...state.items, nextVideo, image] };
const before = JSON.stringify(multi);
const batch = detachAudio(multi, ['v', 'v2', 'v', 'image', 'missing'], uid);
const batchAudio = batch.items.filter(item => item.kind === 'audio');
assert.equal(batchAudio.length, 2, 'duplicates and non-video selections do not change the video batch');
assert.equal(batchAudio[0]!.track, batchAudio[1]!.track, 'adjacent nonoverlapping clips reuse one audio track');
assert.equal(batchAudio[1]!.srcInFrame, nextVideo.srcInFrame);
assert.equal(batchAudio[1]!.playbackRate, nextVideo.playbackRate);
assert.equal(volumeAtFrame(batch.items.find(item => item.id === 'v')!, 30), 0);
assert.equal(volumeAtFrame(batch.items.find(item => item.id === 'v2')!, 30), 0);
assert.deepEqual(batch.selectedIds, batchAudio.map(item => item.id));
assert.equal(batch.items.find(item => item.id === image.id), image);
assert.equal(JSON.stringify(multi), before, 'batch detachment never mutates the original project');
assert.equal(detachAudio(batch, ['v', 'v2'], uid), batch, 'already detached clips do not generate duplicate audio');
const partiallyDetached = { ...result, items: [...result.items, nextVideo] };
assert.equal(detachAudio(partiallyDetached, ['v', 'v2'], uid).items.filter(item => item.kind === 'audio').length, 2);
const overlapping = detachAudio({ ...multi, items: [multi.items[0]!, { ...nextVideo, startFrame: 40 }] }, ['v', 'v2'], uid);
const overlapAudio = overlapping.items.filter(item => item.kind === 'audio');
assert.notEqual(overlapAudio[0]!.track, overlapAudio[1]!.track, 'overlapping new sounds cannot occupy one track');
const secondLocked: TimelineState = { ...multi, tracks: { ...multi.tracks, V2: { kind: 'video', locked: true } },
  items: multi.items.map(item => item.id === 'v2' ? { ...item, track: 'V2' } : item) };
assert.match(detachAudioUnavailable(secondLocked, ['v', 'v2'])!, /解锁/);
assert.equal(detachAudio(secondLocked, ['v', 'v2'], uid), secondLocked, 'a blocked member prevents a silent partial batch');
const secondTransitioned: TimelineState = { ...multi, transitions: [{ id: 'audio-t', type: 'audio-cross-fade', trackId: 'V1',
  outgoingItemId: 'v2', incomingItemId: 'other', durationInFrames: 8 }] };
assert.match(detachAudioUnavailable(secondTransitioned, ['v', 'v2'])!, /转场/);
assert.equal(detachAudio(secondTransitioned, ['v', 'v2'], uid), secondTransitioned);
const missingSource = { ...multi, items: multi.items.map(item => item.id === 'v2' ? { ...item, src: undefined } : item) };
assert.match(detachAudioUnavailable(missingSource, ['v', 'v2'])!, /素材/);
assert.equal(detachAudio(missingSource, ['v', 'v2'], uid), missingSource);
assert.equal(detachAudio(multi, ['image'], uid), multi);
const batchHistory = historyReduce({ past: [], present: { ...doc, timelines: [{ ...multi, id: 'main', name: 'main', order: 0 }] }, future: [] },
  { type: 'setFullState', state: batch });
assert.equal(batchHistory.past.length, 1);
assert.equal(historyReduce(batchHistory, { type: 'undo' }).present.timelines[0]!.items.filter(item => item.kind === 'audio').length, 0);
assert.equal(historyReduce(historyReduce(batchHistory, { type: 'undo' }), { type: 'redo' }).present.timelines[0]!.items.filter(item => item.kind === 'audio').length, 2);
console.log('detachAudio.verify: passed');
