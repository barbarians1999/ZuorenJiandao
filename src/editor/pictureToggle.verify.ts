import assert from 'node:assert/strict';
import { compositionPlan } from './compositionPlan';
import { detachAudio } from './detachAudio';
import { historyReduce } from './reduce';
import { reduce } from './reducerTimeline';
import { runProjectMigrations } from '../persist/migrations';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { ProjectDoc, Timeline, TimelineItem, TimelineState } from './types';

const clip = (id: string, kind: TimelineItem['kind'], track = 'V1', patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id, name: id, kind, track, src: kind === 'video' || kind === 'audio' ? '/source.mp4' : undefined,
  startFrame: 0, durationInFrames: 60, ...patch,
});
const timeline: Timeline = {
  id: 'main', name: 'main', order: 0, fps: 30, width: 1920, height: 1080,
  trackOrder: ['V1', 'V2', 'V3', 'A1'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, V3: { kind: 'video', locked: true }, A1: { kind: 'audio' } },
  selectedId: 'v1', selectedIds: ['v1', 'v2', 'locked', 'audio', 'nested'],
  items: [
    clip('v1', 'video'), clip('v2', 'video', 'V2', { pictureDisabled: true }),
    clip('locked', 'video', 'V3'), clip('audio', 'audio', 'A1'),
    clip('nested', 'sequence', 'V1', { timelineId: 'child' }),
  ],
};
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: timeline.id, timelines: [timeline, {
    id: 'child', name: 'child', order: 1, fps: 30, width: 1920, height: 1080,
    trackOrder: ['child-video'], tracks: { 'child-video': { kind: 'video' } }, selectedId: null, items: [],
  }],
};
const history = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
const selectedIds = timeline.selectedIds ?? [];
const toggled = historyReduce(history, { type: 'togglePicture', ids: selectedIds });
const next = toggled.present.timelines[0]!;
assert.equal(next.items.find((item) => item.id === 'v1')?.pictureDisabled, true, 'enabled selected picture turns off');
assert.equal(next.items.find((item) => item.id === 'v2')?.pictureDisabled, true, 'mixed selection normalizes to off');
assert.equal(next.items.find((item) => item.id === 'locked')?.pictureDisabled, undefined, 'locked track is skipped');
assert.equal(next.items.find((item) => item.id === 'audio')?.pictureDisabled, undefined, 'pure audio is skipped');
assert.equal(next.items.find((item) => item.id === 'nested')?.pictureDisabled, undefined, 'nested sequences are skipped');
assert.equal(historyReduce(toggled, { type: 'undo' }).present, doc, 'undo restores exact prior document');
assert.equal(historyReduce(historyReduce(toggled, { type: 'undo' }), { type: 'redo' }).present.timelines[0]!.items[0]!.pictureDisabled, true);

const allDisabled: TimelineState = { ...timeline, selectedId: 'v1', selectedIds: ['v1', 'v2'],
  items: timeline.items.map((item) => item.id === 'v1' ? { ...item, pictureDisabled: true } : item) };
const allEnabled = reduce(allDisabled, { type: 'togglePicture', ids: allDisabled.selectedIds ?? [] });
assert.equal(allEnabled.items.find((item) => item.id === 'v1')?.pictureDisabled, false, 'all-disabled eligible selection toggles on');
assert.equal(allEnabled.items.find((item) => item.id === 'v2')?.pictureDisabled, false);
const cloneState: TimelineState = { ...timeline, trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
  selectedId: 'source', selectedIds: ['source'], items: [clip('source', 'video', 'V1', { pictureDisabled: true })] };
assert.equal(reduce(cloneState, { type: 'duplicate', id: 'source', newId: 'copy' }).items.find((item) => item.id === 'copy')?.pictureDisabled,
  true, 'duplicate inherits picture state');
assert.equal(reduce(cloneState, { type: 'split', id: 'source', atFrame: 30, newId: 'right' }).items.find((item) => item.id === 'right')?.pictureDisabled,
  true, 'split inherits picture state');
for (const ids of [['audio'], ['nested']]) {
  const noOp = { ...timeline, selectedId: ids[0]!, selectedIds: ids };
  assert.equal(reduce(noOp, { type: 'togglePicture', ids }), noOp, 'no eligible selection creates no mutation');
}

const detachedState: TimelineState = {
  ...timeline, selectedId: null, selectedIds: [], trackOrder: ['V1', 'A1'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [clip('detached-source', 'video', 'V1', { pictureDisabled: true, volume: 0 })],
};
const detached = detachAudio(detachedState, 'detached-source', (prefix) => `${prefix}-audio`);
assert.equal(detached.items[0]?.pictureDisabled, true, 'audio separation preserves source picture state');
assert.equal(detached.items[1]?.pictureDisabled, undefined, 'new audio clip does not inherit picture state');
assert.equal(detached.items[1]?.kind, 'audio');
assert.equal(compositionPlan(detached).audio.length, 1, 'separated audio remains in composition plan');

const plan = compositionPlan(detachedState);
assert.deepEqual(plan.ordered.map((item) => item.id), [], 'disabled picture is not rendered');
assert.deepEqual(plan.videoAudioGroups.map((group) => group.map((item) => item.id)), [['detached-source']],
  'picture-disabled single video gets an explicit embedded-audio renderer');
assert.equal(plan.groupedVideoIds.has('detached-source'), true);
assert.equal(detachedState.items[0]?.durationInFrames, 60, 'picture toggle does not alter clip duration');
const audioBearingPictureDisabled: TimelineState = { ...detachedState, items: [clip('picture-off', 'video', 'V1', { pictureDisabled: true })] };
const audioBearingPlan = compositionPlan(audioBearingPictureDisabled);
assert.deepEqual(audioBearingPlan.videoAudioGroups.map((group) => group.map((item) => item.id)), [['picture-off']],
  'picture-disabled video retains its embedded audio renderer');
assert.equal(audioBearingPlan.groupedVideoIds.has('picture-off'), true);
const legacyVisible = compositionPlan({ ...detachedState, items: [clip('legacy', 'video')] });
assert.deepEqual(legacyVisible.ordered.map((item) => item.id), ['legacy'], 'legacy clips remain visible when the field is absent');

const hiddenTrack = { ...detachedState, tracks: { V1: { kind: 'video' as const, hidden: true } } };
assert.equal(compositionPlan(hiddenTrack).videoAudioGroups.length, 0, 'whole-track hidden keeps its old picture+audio behavior');

const transitionState: TimelineState = {
  ...detachedState,
  selectedId: null,
  items: [clip('out', 'video', 'V1', { durationInFrames: 60 }),
    clip('in', 'video', 'V1', { startFrame: 60, pictureDisabled: true })],
  transitions: [{ id: 'tr', type: 'cross-dissolve', outgoingItemId: 'out', incomingItemId: 'in', trackId: 'V1', durationInFrames: 12 }],
};
const transitionPlan = compositionPlan(transitionState);
assert.equal(transitionPlan.glWindows.length, 0, 'visual transition cannot reveal a disabled endpoint');
assert.equal(transitionPlan.entranceOf.has('in'), false);

const persisted = JSON.parse(JSON.stringify({ ...doc, timelines: [{ ...timeline, items: [clip('saved', 'video', 'V1', { pictureDisabled: true })] }] })) as ProjectDoc;
assert.equal(persisted.timelines[0]?.items[0]?.pictureDisabled, true, 'project JSON preserves the optional state');
const reopened = runProjectMigrations(persisted);
assert.equal(reopened?.doc.timelines[0]?.items[0]?.pictureDisabled, true, 'project normalization preserves the optional state');

console.log('pictureToggle.verify: state, history, persistence, composition audio, transitions and detach passed');
