import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildDisplayRollSourceEntries,
  buildDisplayTrimSourceEntries,
  canDisplayRoll,
  resizeDisplayCueSourceSpans,
  resolveDisplayRollSpans,
} from './useCaptionCueGestures';
import { projectCaptionSourceSpans } from './captionSourceSpans';
import type { TimelineState } from '../editor/types';

const source = {
  id: 'source', name: 'source', kind: 'video' as const, track: 'V1', startFrame: 0,
  durationInFrames: 120, src: '/source.mp4',
};
const spans = [{ wordRef: 'source-word', startMs: 1_000, endMs: 2_000, sourceText: 'word' }];

const startTrim = resizeDisplayCueSourceSpans(source, spans, 30, 'start', 6)!;
assert.equal(startTrim[0]?.startMs, 1_200, 'left trim maps timeline frames back to source time');
assert.equal(spans[0]?.startMs, 1_000, 'trimming leaves the stored source snapshot immutable');

const endTrim = resizeDisplayCueSourceSpans(source, spans, 30, 'end', -6)!;
assert.equal(endTrim[0]?.endMs, 1_800, 'right trim updates only the visible source boundary');

const minimum = resizeDisplayCueSourceSpans(source, spans, 30, 'start', 600)!;
assert.ok(Math.round((minimum[0]!.endMs - minimum[0]!.startMs) * 30 / 1_000) >= 15, 'trim keeps at least half a second');
const fastSource = { ...source, playbackRate: 2 };
const fastMinimum = resizeDisplayCueSourceSpans(fastSource, [
  { wordRef: 'source-word', startMs: 1_000, endMs: 3_000, sourceText: 'word' },
], 30, 'start', 600)!;
const fastProjection = projectCaptionSourceSpans(fastSource, fastMinimum, 30);
assert.ok(fastProjection[0]!.endFrame - fastProjection[0]!.startFrame >= 15, 'fast playback trim keeps half a second in timeline time');

const editedAudio = {
  ...source,
  kind: 'audio' as const,
  durationInFrames: 30,
  transcriptGenerationId: 'generation',
  transcript: [
    { id: 'first', text: 'first', start: 0, end: 1_000 },
    { id: 'deleted', text: 'deleted', start: 1_000, end: 2_000 },
    { id: 'last', text: 'last', start: 2_000, end: 3_000 },
  ],
};
assert.equal(resizeDisplayCueSourceSpans(editedAudio, [
  { wordRef: 'first', startMs: 0, endMs: 1_000, sourceText: 'first' },
  { wordRef: 'last', startMs: 2_000, endMs: 3_000, sourceText: 'last' },
], 30, 'start', 3), null, 'trim refuses to bridge separated playback runs');

const gestureSource = readFileSync(new URL('./useCaptionCueGestures.ts', import.meta.url), 'utf8');
const pointerMoves = [...gestureSource.matchAll(/const move = \(event: ReactPointerEvent, key: string\) => \{([\s\S]*?)\n  \};/g)];
assert.equal(pointerMoves.length, 3, 'manual trim, display trim, and roll handlers are covered');
for (const move of pointerMoves) {
  assert.doesNotMatch(move[1]!, /onLivePreview/, 'trim/roll pointermove only updates drag state');
}
assert.match(gestureSource, /onLivePreview\?\.\(null\);\s*if \(patch\) onUpdate\(patch\);/,
  'manual trim clears preview and commits once on pointerup');
assert.match(gestureSource, /onLivePreview\?\.\(null\);\s*if \(!deltaFrames\) return;\s*commit\(drag\.target, drag\.edge, deltaFrames\);/,
  'display trim clears preview and commits once on pointerup');
assert.match(gestureSource, /onLivePreview\?\.\(null\);\s*commit\(activePair, deltaFrames\);/,
  'roll trim clears preview and commits once on pointerup');
assert.match(gestureSource, /cancel: \(\) => \{ setDrag\(null\); onLivePreview\?\.\(null\); \}/,
  'cancel clears drag state and any previously published preview');

const laneSource = readFileSync(new URL('./CaptionTrackLane.tsx', import.meta.url), 'utf8');
assert.match(laneSource, /trim\.drag\?\.key === key/);
assert.match(laneSource, /displayTrim\.drag\?\.key === key/);
assert.match(laneSource, /rollTimingByKey\.set\(pair\.leftKey/);
assert.match(laneSource, /canDisplayRoll\(left\.displayTarget, right\.displayTarget/);

// Expanding start left and end right within playable segment bounds works, including multi-word cues with short boundary words.
const expandStart = resizeDisplayCueSourceSpans(source, spans, 30, 'start', -6)!;
assert.equal(expandStart[0]?.startMs, 800, 'start edge can expand earlier into playable media');
const expandEnd = resizeDisplayCueSourceSpans(source, spans, 30, 'end', 6)!;
assert.equal(expandEnd[0]?.endMs, 2_200, 'end edge can expand later into playable media');

const multiWordLeft = [
  { wordRef: 'w1', startMs: 1_000, endMs: 1_800, sourceText: 'hello' },
  { wordRef: 'w2', startMs: 1_800, endMs: 2_000, sourceText: 'world' },
];
const multiWordRight = [
  { wordRef: 'w3', startMs: 2_000, endMs: 2_150, sourceText: 'next' },
  { wordRef: 'w4', startMs: 2_150, endMs: 3_000, sourceText: 'line' },
];
const multiWordTrim = resizeDisplayCueSourceSpans(source, multiWordLeft, 30, 'end', -3)!;
assert.equal(multiWordTrim.at(-1)?.endMs, 1_900, 'short tail word does not block trimming a long multi-word cue');

const leftTarget = { laneId: 'lane', editId: 'e1', partId: 'p1', key: 'k1', source, sourceSpans: multiWordLeft };
const rightTarget = { laneId: 'lane', editId: 'e2', partId: 'p2', key: 'k2', source, sourceSpans: multiWordRight };
assert.equal(canDisplayRoll(leftTarget, rightTarget, 30), true, 'adjacent display cues can roll');

const rolledForward = resolveDisplayRollSpans(leftTarget, rightTarget, 30, 9)!;
assert.ok(rolledForward && rolledForward.deltaFrames === 9, 'display cues roll forward across multi-word seam');
assert.equal(rolledForward.leftRange.end, rolledForward.rightRange.start, 'forward roll leaves zero gap');
assert.equal(rolledForward.leftSpans.at(-1)?.endMs, rolledForward.rightSpans[0]?.startMs);

const rolledBackward = resolveDisplayRollSpans(leftTarget, rightTarget, 30, -9)!;
assert.ok(rolledBackward && rolledBackward.deltaFrames === -9, 'display cues roll backward across multi-word seam');
assert.equal(rolledBackward.leftRange.end, rolledBackward.rightRange.start, 'backward roll leaves zero gap');
assert.equal(rolledBackward.leftSpans.at(-1)?.endMs, rolledBackward.rightSpans[0]?.startMs);

const clampedForward = resolveDisplayRollSpans(leftTarget, rightTarget, 30, 300)!;
assert.ok(clampedForward && clampedForward.deltaFrames > 0 && clampedForward.deltaFrames < 300, 'excessive roll clamps to 0.5s minimum');
assert.ok(clampedForward.rightRange.end - clampedForward.rightRange.start >= 500);

const segLeft = {
  laneId: 'lane', editId: 'se1', partId: 'sp1', key: 'sk1', source: editedAudio,
  sourceSpans: [{ wordRef: 'first', startMs: 0, endMs: 1_000, sourceText: 'first' }],
};
const segRight = {
  laneId: 'lane', editId: 'se2', partId: 'sp2', key: 'sk2', source: editedAudio,
  sourceSpans: [{ wordRef: 'last', startMs: 2_000, endMs: 3_000, sourceText: 'last' }],
};
assert.equal(canDisplayRoll(segLeft, segRight, 30), false, 'deleted-word segment seam cannot roll');
assert.equal(resolveDisplayRollSpans(segLeft, segRight, 30, 3), null);
assert.equal(resolveDisplayRollSpans(segLeft, segRight, 30, -3), null);

// Unedited automatic ASR cues (no displayCueEditId/partId yet) get display targets & promote cleanly on trim/roll.
assert.match(laneSource, /!identity\.manual && identity\.entry && identity\.sourceSpans\?\.length && source/);
const autoState: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  trackOrder: ['V1', 'C1'],
  tracks: {
    V1: { kind: 'video' },
    C1: {
      kind: 'caption',
      captions: {
        enabled: true, template: 'plain', pacing: 'phrase',
        sourceEntries: [{
          id: 'asr-lane', itemId: source.id,
          displayCueEdits: [{
            id: 'existing-edit', coveredWordRefs: ['e1'],
            parts: [{ id: 'existing-part', text: '旧句', sourceSpans: [{ wordRef: 'e1', startMs: 0, endMs: 1_000, sourceText: '旧句' }] }],
          }],
        }],
      },
    },
  },
  items: [source],
};
const autoLeft = {
  laneId: 'asr-lane', key: 'auto-1', text: '中文第一句', source,
  sourceSpans: [
    { wordRef: 'a1', startMs: 1_000, endMs: 1_500, sourceText: '中文' },
    { wordRef: 'a2', startMs: 1_500, endMs: 2_000, sourceText: '第一句' },
  ],
};
const autoRight = {
  laneId: 'asr-lane', key: 'auto-2', text: '第二句', source,
  sourceSpans: [{ wordRef: 'a3', startMs: 2_000, endMs: 3_000, sourceText: '第二句' }],
};
const autoTrimmed = buildDisplayTrimSourceEntries(
  autoState, 'C1', autoLeft, resizeDisplayCueSourceSpans(source, autoLeft.sourceSpans, 30, 'end', -3)!,
);
assert.equal(autoTrimmed[0]?.displayCueEdits?.length, 2, 'trimming an unedited ASR cue promotes it into displayCueEdits');
assert.deepEqual(autoTrimmed[0]?.displayCueEdits?.[1]?.coveredWordRefs, ['a1', 'a2']);
assert.equal(autoTrimmed[0]?.displayCueEdits?.[1]?.parts[0]?.text, '中文第一句', 'promoted Chinese text keeps no extra spaces');

const autoRolledBoth = resolveDisplayRollSpans(autoLeft, autoRight, 30, 6)!;
const rolledEntriesBoth = buildDisplayRollSourceEntries(
  autoState, 'C1', autoLeft, autoRight, autoRolledBoth.leftSpans, autoRolledBoth.rightSpans,
);
assert.equal(rolledEntriesBoth[0]?.displayCueEdits?.length, 3, 'rolling two unedited ASR cues promotes both in one update');

const mixedLeft = {
  laneId: 'asr-lane', editId: 'existing-edit', partId: 'existing-part', key: 'existing', source,
  sourceSpans: [{ wordRef: 'e1', startMs: 0, endMs: 1_000, sourceText: '旧句' }],
};
const mixedRight = {
  laneId: 'asr-lane', key: 'auto-1', text: '中文第一句', source,
  sourceSpans: autoLeft.sourceSpans,
};
const mixedRolled = resolveDisplayRollSpans(mixedLeft, mixedRight, 30, 6)!;
const rolledEntriesMixed = buildDisplayRollSourceEntries(
  autoState, 'C1', mixedLeft, mixedRight, mixedRolled.leftSpans, mixedRolled.rightSpans,
);
assert.equal(rolledEntriesMixed[0]?.displayCueEdits?.length, 2, 'mixed roll updates edited cue in place and promotes unedited cue');
assert.equal(rolledEntriesMixed[0]?.displayCueEdits?.[0]?.parts[0]?.sourceSpans[0]?.endMs, 1_200);
assert.equal(rolledEntriesMixed[0]?.displayCueEdits?.[1]?.parts[0]?.sourceSpans[0]?.startMs, 1_200);

console.log('displayCueTrim.verify: source time mapping, immutability and minimum duration OK');
