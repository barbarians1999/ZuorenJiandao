// Stage 3 guardrails: verify that visual foldGroups are strictly independent from
// linkGroups, support split/trim/move/copy/paste/delete in collapsed form, and
// round-trip cleanly through undo/redo and persistence normalization.
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { setLinkGroup, unlinkItems } from './linkGroups';
import {
  cloneFoldGroupsForCopiedItems,
  dissolveFoldGroupState,
  foldGroupForItem,
  isFoldGroupVisuallyCollapsed,
  maintainFoldGroups,
  resolveFoldGroupSpan,
  splitFoldGroupAtFrame,
  toggleFoldGroupState,
  trimFoldGroupEdge,
} from './foldGroups';
import { expandSelectionItemIds, groupMoveIds, moveItemsByDelta, removeItemsFromState } from './multiSelect';
import { planClipPasteResult } from './clipPaste';
import { historyReduce, reduce } from './reduce';
import { normalizeTimelineGroups } from '../persist/migrations/normalize';
import { compileTranscriptTrackEdit } from '../transcript/trackEditCompiler';
import type { ProjectDoc, Timeline, TimelineItem } from './types';

const makeAudio = (id: string, startFrame: number, durationInFrames: number, srcInFrame = 0): TimelineItem => ({
  id,
  name: `${id}.wav`,
  kind: 'audio',
  track: 'A1',
  startFrame,
  durationInFrames,
  srcInFrame,
  src: '/voice.wav',
  sourceAssetId: 'asset-voice',
});

const makeVideo = (id: string, startFrame: number, durationInFrames: number, srcInFrame = 0): TimelineItem => ({
  id,
  name: `${id}.mp4`,
  kind: 'video',
  track: 'V1',
  startFrame,
  durationInFrames,
  srcInFrame,
  src: '/video.mp4',
  sourceAssetId: 'asset-video',
});

const baseTimeline = (items: TimelineItem[]): Timeline => ({
  id: 'tl-main',
  name: 'Main',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  tracks: {
    V1: { kind: 'video' },
    A1: { kind: 'audio' },
    A2: { kind: 'audio' },
  },
  trackOrder: ['V1', 'A1', 'A2'],
  selectedId: null,
  selectedIds: [],
});

const docOf = (tl: Timeline): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION,
  transcriptTimingModel: 'track-ssot-v1',
  assets: [
    { id: 'asset-voice', name: 'voice.wav', kind: 'audio', src: '/voice.wav', durationInFrames: 600 },
    { id: 'asset-video', name: 'video.mp4', kind: 'video', src: '/video.mp4', durationInFrames: 600 },
  ],
  mediaFolders: [],
  timelines: [tl],
  activeTimelineId: tl.id,
});

// 1. Transcript compiler produces an independent collapsed foldGroup, separate from linkGroups.
const scriptedItem: TimelineItem = {
  ...makeAudio('a1', 0, 120, 0),
  transcript: [
    { id: 'w0', text: 'first', start: 0, end: 1000 },
    { id: 'w1', text: 'filler', start: 1000, end: 2000 },
    { id: 'w2', text: 'second', start: 2000, end: 3000 },
    { id: 'w3', text: 'third', start: 3000, end: 4000 },
  ],
  transcriptGenerationId: 'gen-1',
};
const pairedVideo = makeVideo('v1', 0, 120, 0);
const linkedSeed = setLinkGroup(
  { ...baseTimeline([pairedVideo, scriptedItem]), assets: docOf(baseTimeline([])).assets },
  { id: 'lg-av-1', itemIds: ['v1', 'a1'], mode: 'linked' },
);
const compiled = compileTranscriptTrackEdit(linkedSeed, { type: 'toggleWord', id: 'a1', idx: 1 });
assert.equal(compiled.foldGroups?.length, 2, 'deleting a middle word with linked A/V creates independent foldGroups on both A1 and V1');
const fg0 = compiled.foldGroups!.find((g) => g.track === 'A1')!;
assert.ok(fg0);
assert.equal(isFoldGroupVisuallyCollapsed(fg0), true);
assert.equal(fg0.itemIds.length, 2);
assert.equal(compiled.linkGroups?.some((g) => g.mode === 'linked'), true, 'linked A/V groups stay distinct from foldGroups');

// Unlinking all linkGroups MUST NOT touch foldGroups, and toggling/dissolving foldGroups MUST NOT touch linkGroups.
const unlinked = unlinkItems(compiled, ['a1']);
assert.equal(unlinked.foldGroups?.length, 2, 'unlinking A/V never dissolves foldGroups');
const expanded = toggleFoldGroupState(compiled, fg0.id);
assert.equal(expanded.foldGroups?.find((g) => g.id === fg0.id)?.collapsed, false);
assert.deepEqual(expanded.linkGroups, compiled.linkGroups, 'toggling foldGroup never alters linkGroups');
const collapsedAgain = reduce(expanded, { type: 'toggleFoldGroup', groupId: fg0.id });
assert.equal(collapsedAgain.foldGroups?.find((g) => g.id === fg0.id)?.collapsed, true);
const dissolved = dissolveFoldGroupState(compiled, fg0.id);
assert.equal(dissolved.foldGroups?.some((g) => g.id === fg0.id), false);
assert.equal(dissolved.foldGroups?.length, 1);
assert.deepEqual(dissolved.linkGroups, compiled.linkGroups, 'dissolving foldGroup never alters linkGroups');
assert.deepEqual(
  dissolved.items.map((it) => ({ id: it.id, startFrame: it.startFrame, durationInFrames: it.durationInFrames, srcInFrame: it.srcInFrame })),
  compiled.items.map((it) => ({ id: it.id, startFrame: it.startFrame, durationInFrames: it.durationInFrames, srcInFrame: it.srcInFrame })),
  'dissolving foldGroup never changes playback timing',
);

// 2. Collapsed razor split: both mid-subclip and seam split into independent groups cleanly.
const threeSegState: Timeline = {
  ...baseTimeline([
    makeAudio('s1', 30, 30, 10),   // 30..60
    makeAudio('s2', 60, 30, 50),   // 60..90
    makeAudio('s3', 90, 30, 90),   // 90..120
    makeAudio('tail', 140, 20, 0), // 140..160
  ]),
  assets: docOf(baseTimeline([])).assets,
  foldGroups: [{
    id: 'fg-tri',
    track: 'A1',
    itemIds: ['s1', 's2', 's3'],
    collapsed: true,
    label: 'Tri-Segment Fold',
  }],
};

// Split mid-way through s2 (at frame 75): left has [s1, s2_left], right has [s2_right, s3].
const splitMid = splitFoldGroupAtFrame(threeSegState, 'fg-tri', 75);
assert.equal(splitMid.foldGroups?.length, 2, 'mid-subclip razor split creates left and right foldGroups');
const leftSpanMid = resolveFoldGroupSpan(splitMid, splitMid.foldGroups![0]!);
const rightSpanMid = resolveFoldGroupSpan(splitMid, splitMid.foldGroups![1]!);
assert.equal(leftSpanMid?.startFrame, 30);
assert.equal(leftSpanMid?.endFrame, 75);
assert.equal(rightSpanMid?.startFrame, 75);
assert.equal(rightSpanMid?.endFrame, 120);

// Split right on seam between s1 and s2 (at frame 60): left has 1 clip (auto-dissolves foldGroup), right keeps [s2, s3].
const splitSeam = reduce(threeSegState, { type: 'splitFoldGroup', groupId: 'fg-tri', atFrame: 60 });
assert.equal(splitSeam.foldGroups?.length, 1, '1-clip left side auto-dissolves while 2-clip right stays folded');
assert.deepEqual(splitSeam.foldGroups![0]!.itemIds, ['s2', 's3']);

// 3. Collapsed left and right edge trims (with sub-clip consumption, source restore, and ripple).
// Inward left trim +40 moves start from 30 -> 70 (drops s1 completely and trims s2 to 70..90, srcIn 50 -> 60).
const trimmedLeftIn = reduce(threeSegState, { type: 'trimFoldGroup', groupId: 'fg-tri', edge: 'left', deltaFrames: 40 });
assert.equal(trimmedLeftIn.items.some((it) => it.id === 's1'), false, 'consumed leading sub-clip dropped cleanly');
const trimmedS2 = trimmedLeftIn.items.find((it) => it.id === 's2')!;
assert.equal(trimmedS2.startFrame, 70);
assert.equal(trimmedS2.durationInFrames, 20);
assert.equal(trimmedS2.srcInFrame, 60);
assert.deepEqual(foldGroupForItem(trimmedLeftIn, 's2')?.itemIds, ['s2', 's3']);

// Outward left trim -10 extends s1 head back toward 20 (srcIn 10 -> 0).
const trimmedLeftOut = trimFoldGroupEdge(threeSegState, 'fg-tri', 'left', -10);
const extS1 = trimmedLeftOut.items.find((it) => it.id === 's1')!;
assert.equal(extS1.startFrame, 20);
assert.equal(extS1.durationInFrames, 40);
assert.equal(extS1.srcInFrame, 0);

// Right trim with ripple: shrink right edge by -45 (end 120 -> 75, dropping s3 and trimming s2 -> 60..75),
// shifting downstream 'tail' (140 -> 95).
const trimmedRightRipple = trimFoldGroupEdge(threeSegState, 'fg-tri', 'right', -45, { ripple: true });
assert.equal(trimmedRightRipple.items.some((it) => it.id === 's3'), false);
assert.equal(trimmedRightRipple.items.find((it) => it.id === 's2')?.durationInFrames, 15);
assert.equal(trimmedRightRipple.items.find((it) => it.id === 'tail')?.startFrame, 95);
assert.equal(trimmedRightRipple.foldGroups?.[0]?.itemIds.length, 2);

// 4. Collapsed move (same-track & cross-track) moves all members together and updates foldGroup.track.
assert.deepEqual(expandSelectionItemIds(threeSegState, ['s1']), ['s1', 's2', 's3']);
assert.deepEqual([...groupMoveIds(threeSegState, 's2')].sort(), ['s1', 's2', 's3']);
const movedDelta = moveItemsByDelta(threeSegState, ['s1'], 20, { from: 'A1', to: 'A2' });
const crossMoved = reduce(threeSegState, { type: 'setFullState', state: movedDelta });
assert.equal(crossMoved.foldGroups?.[0]?.track, 'A2', 'cross-track move updates foldGroup.track');
assert.deepEqual(crossMoved.foldGroups?.[0]?.itemIds, ['s1', 's2', 's3']);
assert.deepEqual(crossMoved.items.filter((it) => ['s1', 's2', 's3'].includes(it.id)).map((it) => it.startFrame), [50, 80, 110]);

// 5. Copy / paste / duplicate clones foldGroups with remapped IDs; delete shrinks/dissolves; undo restores bit-for-bit.
let uidN = 0;
const uid = (prefix: string) => `${prefix}_copy_${++uidN}`;
const pasted = planClipPasteResult(
  threeSegState,
  threeSegState.items.filter((it) => ['s1', 's2', 's3'].includes(it.id)),
  threeSegState.tracks,
  200,
  uid,
  { foldGroups: threeSegState.foldGroups },
);
assert.equal(pasted.state.foldGroups?.length, 2, 'paste creates an independent cloned foldGroup');
assert.notEqual(pasted.state.foldGroups![1]!.id, 'fg-tri');
assert.deepEqual(
  cloneFoldGroupsForCopiedItems(
    threeSegState.foldGroups,
    new Map([['s1', 'c1'], ['s2', 'c2'], ['s3', 'c3']]),
    [makeAudio('c1', 0, 30), makeAudio('c2', 30, 30), makeAudio('c3', 60, 30)],
    uid,
  )[0]?.itemIds,
  ['c1', 'c2', 'c3'],
);

const afterDeleteMiddle = reduce(threeSegState, { type: 'remove', id: 's2' });
assert.deepEqual(afterDeleteMiddle.foldGroups?.[0]?.itemIds, ['s1', 's3']);
const afterDeleteAll = maintainFoldGroups(afterDeleteMiddle, removeItemsFromState(afterDeleteMiddle, ['s3']));
assert.equal(afterDeleteAll, undefined, 'foldGroup dissolves automatically when <2 items remain');

let hist = { past: [] as ProjectDoc[], present: docOf(threeSegState), future: [] as ProjectDoc[] };
hist = historyReduce(hist, { type: 'toggleFoldGroup', groupId: 'fg-tri' });
assert.equal(hist.present.timelines[0]!.foldGroups![0]!.collapsed, false);
hist = historyReduce(hist, { type: 'trimFoldGroup', groupId: 'fg-tri', edge: 'right', deltaFrames: -35 });
assert.equal(hist.present.timelines[0]!.foldGroups![0]!.itemIds.length, 2);
hist = historyReduce(hist, { type: 'undo' });
assert.deepEqual(hist.present.timelines[0]!.foldGroups![0]!.itemIds, ['s1', 's2', 's3']);
hist = historyReduce(hist, { type: 'undo' });
assert.equal(hist.present.timelines[0]!.foldGroups![0]!.collapsed, true);

// 6. normalizeTimelineGroups preserves valid foldGroups and drops orphan/singleton groups.
const normalized = normalizeTimelineGroups({
  ...threeSegState,
  foldGroups: [
    ...threeSegState.foldGroups!,
    { id: 'fg-orphan', track: 'A1', itemIds: ['s1', 'missing-id'], collapsed: true },
  ],
});
assert.equal(normalized.foldGroups?.length, 1);
assert.equal(normalized.foldGroups![0]!.id, 'fg-tri');

console.log('foldGroups.verify: all Stage 3 fold-group checks passed');
