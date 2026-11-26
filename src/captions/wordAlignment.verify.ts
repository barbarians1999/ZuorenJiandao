// Word ↔ index ↔ ref positional alignment under transcriptPlayOrder (speech
// reorder): resolveCaptionWords sorts by timeline start while indices/refs used
// to enumerate in source order — hiding/overriding word N then hit a DIFFERENT
// word. Also covers wordTimelineFrame (word-click seek projection).
// npx tsx src/captions/wordAlignment.verify.ts
import assert from 'node:assert/strict';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { projectMediaWindowWords, wordTimelineFrame } from '../transcript/edit';
import { resolveCaptionWordIndices, resolveCaptionWordRefs, resolveCaptionWords } from './resolve';

const fps = 30;
// 4 words, 1s each, back to back: A[0-1s] B[1-2s] C[2-3s] D[3-4s]
const W: TranscriptWord[] = [
  { id: 'w0', text: 'A', start: 0, end: 1000 },
  { id: 'w1', text: 'B', start: 1000, end: 2000 },
  { id: 'w2', text: 'C', start: 2000, end: 3000 },
  { id: 'w3', text: 'D', start: 3000, end: 4000 },
];
const encodeWordRef = (scope: readonly string[], generationId: string, wordId: string): string =>
  `cw2.${encodeURIComponent(JSON.stringify([...scope, generationId, wordId]))}`;

// ── Track-SSOT: reordered audio clips project via continuous media windows ──
{
  const partCD: TimelineItem = {
    id: 'clip1', track: 'A1', startFrame: 0, durationInFrames: 60, srcInFrame: 60, kind: 'audio',
    name: 'vo', src: '/a.mp3', transcript: W, transcriptGenerationId: 'gen1',
  };
  const partAB: TimelineItem = {
    id: 'clip1_b', track: 'A1', startFrame: 60, durationInFrames: 60, srcInFrame: 0, kind: 'audio',
    name: 'vo', src: '/a.mp3', transcript: W, transcriptGenerationId: 'gen1',
  };
  const captions = { template: 'plain', sources: ['clip1', 'clip1_b'] } as never;
  const words = resolveCaptionWords(captions, [partCD, partAB], fps);
  const indices = resolveCaptionWordIndices(captions, [partCD, partAB], fps);
  const refs = resolveCaptionWordRefs(captions, [partCD, partAB], fps);
  assert.deepEqual(words.map((w) => w.text), ['C', 'D', 'A', 'B']);
  assert.deepEqual(indices, [0, 1, 2, 3]);
  assert.equal(refs[0], encodeWordRef(['item', 'clip1'], 'gen1', 'w2'));
  assert.equal(refs[2], encodeWordRef(['item', 'clip1_b'], 'gen1', 'w0'));
  console.log('resolveCaptionWords/Indices/Refs track-window alignment: OK');
}

// ── wordTimelineFrame: audio clip uses unified continuous media window ───────
{
  const segA: TimelineItem = {
    id: 'clip1', track: 'A1', startFrame: 100, durationInFrames: 30, srcInFrame: 0, kind: 'audio',
    name: 'vo', src: '/a.mp3', transcript: W.slice(0, 3),
  };
  const segC: TimelineItem = {
    id: 'clip1_c', track: 'A1', startFrame: 130, durationInFrames: 30, srcInFrame: 60, kind: 'audio',
    name: 'vo', src: '/a.mp3', transcript: W.slice(0, 3),
  };
  assert.equal(wordTimelineFrame(segA, W[0]!, fps), 100, 'first word seeks to clip head');
  assert.equal(wordTimelineFrame(segC, W[2]!, fps), 130, 'C plays on second sub-clip at timeline frame 130');
  assert.equal(wordTimelineFrame(segA, W[1]!, fps), null, 'deleted word outside media window returns null');
  const projected = projectMediaWindowWords(W.slice(0, 3), fps, segC);
  assert.equal(Math.round((projected.words[0]!.start / 1000) * fps), 130, 'seek matches render projection');
  console.log('wordTimelineFrame audio: OK');
}

// ── wordTimelineFrame:视频窗口 + 变速投影 ─────────────────────────────────
{
  const base = {
    id: 'v1', track: 'V1', startFrame: 10, durationInFrames: 100, kind: 'video',
    name: 'v', src: '/v.mp4', transcript: W, srcInFrame: 50,
  } as unknown as TimelineItem;
  // word C: src 60 frames → 10 + (60-50) = 20
  assert.equal(wordTimelineFrame(base, W[2]!, fps), 20, 'video window offset honored');
  // word A: [0,30) entirely before srcIn window → null
  assert.equal(wordTimelineFrame(base, W[0]!, fps), null, 'word before the trim window is not audible');
  const fast = { ...base, playbackRate: 2 } as TimelineItem;
  // 2×: src 110 frames → local (110-50)/2 = 30 → 10+30 = 40
  assert.equal(wordTimelineFrame(fast, { id: 'x', text: 'X', start: (110 / fps) * 1000, end: (140 / fps) * 1000 }, fps), 40,
    'playbackRate compresses the seek target');
  console.log('wordTimelineFrame video: OK');
}

console.log('\nwordAlignment.verify: ALL PASSED');
