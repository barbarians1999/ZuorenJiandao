import assert from 'node:assert/strict';
import { timelineAttachmentFeedback } from './timelineAttachmentFeedback';
import type { TimelineState } from '../../editor/types';

const state: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: 'a',
  interaction: { mainTrackId: 'main', linkage: true },
  trackOrder: ['title', 'main', 'audio'], tracks: { title: { kind: 'video' }, main: { kind: 'video' }, audio: { kind: 'audio' } },
  items: [
    { id: 'a', name: 'A', kind: 'video', track: 'main', startFrame: 0, durationInFrames: 90 },
    { id: 'title', name: 'Title', kind: 'text', track: 'title', startFrame: 10, durationInFrames: 40, mainClipId: 'a' },
    { id: 'music', name: 'Music', kind: 'audio', track: 'audio', startFrame: 0, durationInFrames: 90, mainClipId: 'a' },
    { id: 'unbound', name: 'Unbound', kind: 'text', track: 'title', startFrame: 60, durationInFrames: 20 },
    { id: 'stale', name: 'Stale', kind: 'text', track: 'title', startFrame: 85, durationInFrames: 5, mainClipId: 'removed' },
  ],
};
const before = JSON.stringify(state);
const shown = timelineAttachmentFeedback(state);
assert.equal(shown.get('title')?.highlighted, true);
assert.equal(shown.get('music')?.active, false, 'audio is not a default directional follower');
assert.equal(shown.has('unbound'), false, 'overlap alone must not show an attachment');
assert.equal(shown.has('stale'), false);
assert.equal(JSON.stringify(state), before, 'feedback cannot alter the project');
assert.equal(timelineAttachmentFeedback({ ...state, interaction: { ...state.interaction, linkage: false } }).get('title')?.highlighted, false);
assert.equal(timelineAttachmentFeedback({ ...state, selectedId: 'title' }).get('title')?.highlighted, false, 'child selection does not imply reverse linkage');
assert.equal(timelineAttachmentFeedback({ ...state, tracks: { ...state.tracks, title: { kind: 'video', locked: true } } }).get('title')?.locked, true);
assert.equal(timelineAttachmentFeedback({ ...state, interaction: { ...state.interaction, linkedKinds: ['audio'] } }).get('music')?.highlighted, true);
console.log('timelineAttachmentFeedback.verify: explicit links, directional selection, disabled kinds, locks and read-only behavior passed');
