import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resizeDisplayCueSourceSpans } from './useCaptionCueGestures';
import { projectCaptionSourceSpans } from './captionSourceSpans';

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
  durationInFrames: 90,
  transcriptGenerationId: 'generation',
  transcript: [
    { id: 'first', text: 'first', start: 0, end: 1_000 },
    { id: 'deleted', text: 'deleted', start: 1_000, end: 2_000 },
    { id: 'last', text: 'last', start: 2_000, end: 3_000 },
  ],
  deletedWordIdx: [1],
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

console.log('displayCueTrim.verify: source time mapping, immutability and minimum duration OK');
