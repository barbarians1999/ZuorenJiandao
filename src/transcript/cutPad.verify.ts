// Runnable check: `npx tsx src/transcript/cutPad.verify.ts`.
// Verify track-compiled breathing pads on deletion/reordering incisions and leading-handle preservation.
import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { compileTranscriptTrackEdit, type TranscriptMutationAction } from './trackEditCompiler';
import type { TranscriptWord } from './types';

const fps = 100; // 10ms per frame so ms map 10:1 to frames
// 100ms per word, 200ms silence between words: w0 [0,100], w1 [300,400], w2 [600,700], w3 [900,1000]
const words: TranscriptWord[] = [0, 1, 2, 3].map((i) => ({
  text: `w${i}`, start: i * 300, end: i * 300 + 100,
}));

const makeState = (): TimelineState => ({
  fps,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['A1'],
  tracks: { A1: { kind: 'audio' } },
  items: [{
    id: 'vo', track: 'A1', startFrame: 500, durationInFrames: 100, srcInFrame: 0,
    kind: 'audio', name: 'vo', src: '/vo.wav', transcript: words,
  }],
});

const runClean = (action: TranscriptMutationAction) =>
  compileTranscriptTrackEdit(makeState(), action).items
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((clip) => ({
      startFrame: clip.startFrame,
      dur: clip.durationInFrames,
      srcStart: Math.round(clip.srcInFrame ?? 0),
      srcEnd: Math.round((clip.srcInFrame ?? 0) + clip.durationInFrames),
    }));

// Exact word boundaries with cutPadFrames = 0 (preserving leading/trailing source handle)
{
  const spans = runClean({ type: 'deleteWords', id: 'vo', idxs: [1] });
  assert.deepEqual(spans.map((s) => [s.srcStart, s.srcEnd]), [[0, 10], [60, 100]], '不设呼吸口时切点分毫不差且保留首尾句柄');
}

// Borrow half on each side: 60f budget → 30f/side, bounded by 20f live silence
{
  const midDeleted = compileTranscriptTrackEdit(
    compileTranscriptTrackEdit(makeState(), { type: 'deleteWords', id: 'vo', idxs: [1] }),
    { type: 'cleanScript', id: 'vo', removeFillers: false, cutPadFrames: 60 },
  ).items.sort((a, b) => a.startFrame - b.startFrame);
  assert.deepEqual(
    midDeleted.map((c) => [Math.round(c.srcInFrame ?? 0), Math.round((c.srcInFrame ?? 0) + c.durationInFrames)]),
    [[0, 30], [40, 100]],
    '第一段尾巴与第二段头各向现场静音借入 20 帧',
  );
  // Timeline spans stay contiguous end-to-end starting at 500
  let cursor = 500;
  for (const clip of midDeleted) {
    assert.equal(clip.startFrame, cursor, '每段在轨道上紧接上一段');
    cursor += clip.durationInFrames;
  }
}

// Budget 20f → 10f per side
{
  const smallPad = compileTranscriptTrackEdit(
    compileTranscriptTrackEdit(makeState(), { type: 'deleteWords', id: 'vo', idxs: [1] }),
    { type: 'cleanScript', id: 'vo', removeFillers: false, cutPadFrames: 20 },
  ).items.sort((a, b) => a.startFrame - b.startFrame);
  assert.deepEqual(
    smallPad.map((c) => [Math.round(c.srcInFrame ?? 0), Math.round((c.srcInFrame ?? 0) + c.durationInFrames)]),
    [[0, 20], [50, 100]],
    '每侧各借 10 帧',
  );
}

// Compressed silence boundary does not borrow extra cutPad; reordered cuts do borrow
{
  const capped = compileTranscriptTrackEdit(
    makeState(),
    { type: 'cleanScript', id: 'vo', removeFillers: false, cutPadFrames: 60, gapCapsMs: { 1: 50 }, replaceGapCaps: true },
  ).items.sort((a, b) => a.startFrame - b.startFrame);
  assert.deepEqual(
    capped.map((c) => [Math.round(c.srcInFrame ?? 0), Math.round((c.srcInFrame ?? 0) + c.durationInFrames)]),
    [[0, 15], [30, 100]],
    '被规则压缩的气口不再额外借呼吸口',
  );
}

console.log('cutPad.verify: ok (Track-SSOT 呼吸口/首尾句柄保留/气口规则/轨道连续拼接)');
