// Track-SSOT media-window & transcript track-edit compiler verification.
import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { mediaWindowKeptIndices, mediaWindowWords, projectMediaWindowWords, wordTimelineFrame } from './edit';
import { compileTranscriptTrackEdit, resolveTranscriptUnit } from './trackEditCompiler';
import type { TranscriptWord } from './types';

const FPS = 10;

// ── 1) Unified continuous media window projection (audio & video) ────────
{
  const s = (sec: number): number => sec * 1000;
  const words: TranscriptWord[] = [
    { text: 'a', start: s(0), end: s(1) },
    { text: 'b', start: s(7), end: s(8) },
    { text: 'c', start: s(12), end: s(13) },
    { text: 'd', start: s(20), end: s(21) },
  ];
  const item = { startFrame: 10, durationInFrames: 12 * FPS, srcInFrame: 6 * FPS };
  const out = mediaWindowWords(words, FPS, item);
  assert.deepEqual(out.map((w) => w.text), ['b', 'c']);
  assert.equal(Math.round(out[0].start), Math.round(((10 + 1 * FPS) / FPS) * 1000));
  assert.equal(Math.round(out[1].start), Math.round(((10 + 6 * FPS) / FPS) * 1000));
  assert.deepEqual(mediaWindowKeptIndices(words, FPS, item), [1, 2]);
  const fast = { startFrame: 0, durationInFrames: 12 * FPS, srcInFrame: 6 * FPS, playbackRate: 2 };
  const outFast = mediaWindowWords(words, FPS, fast);
  assert.deepEqual(outFast.map((w) => w.text), ['b', 'c', 'd']);
  assert.equal(Math.round(outFast[2].start), Math.round(((20 - 6) / 2) * 1000));
  assert.equal(projectMediaWindowWords(words, FPS, item).words.length, 2);
  assert.equal(wordTimelineFrame({ ...item, kind: 'audio' }, words[1]!, FPS), 20);
  assert.equal(wordTimelineFrame({ ...item, kind: 'video' }, words[0]!, FPS), null);
}

// ── 2) Track edit compiler: leading handle preservation, delete + restore, linked A/V & locked track ──
{
  const leadingWords: TranscriptWord[] = [
    { text: 'lead', start: 200, end: 1000 }, // 200ms natural leading silence from srcInFrame=0
    { text: 'del', start: 1000, end: 2000 },
    { text: 'tail', start: 3000, end: 4000 },
  ];
  const baseState: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: 'a1',
    trackOrder: ['V1', 'A1'],
    tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } },
    linkGroups: [{ id: 'lg_av', mode: 'linked', itemIds: ['a1', 'v1'], anchorItemId: 'v1' }],
    items: [
      { id: 'v1', track: 'V1', startFrame: 0, durationInFrames: 120, srcInFrame: 0, kind: 'video', name: 'cam', src: '/cam.mp4' },
      { id: 'a1', track: 'A1', startFrame: 0, durationInFrames: 120, srcInFrame: 0, kind: 'audio', name: 'vo', src: '/vo.wav', transcript: leadingWords },
      { id: 'v2', track: 'V1', startFrame: 120, durationInFrames: 30, srcInFrame: 0, kind: 'video', name: 'next', src: '/next.mp4' },
    ],
  };

  // Delete middle word -> splits both audio & linked video, preserves 0ms leading breath on first sub-clip, ripples v2!
  const deleted = compileTranscriptTrackEdit(baseState, { type: 'deleteWords', id: 'a1', idxs: [1] });
  const aClips = deleted.items.filter((it) => it.track === 'A1').sort((a, b) => a.startFrame - b.startFrame);
  const vClips = deleted.items.filter((it) => it.track === 'V1' && it.id !== 'v2').sort((a, b) => a.startFrame - b.startFrame);
  assert.equal(aClips.length, 2, 'deleted middle word splits audio into 2 real track clips');
  assert.equal(vClips.length, 2, 'linked video synchronously splits into 2 track clips');
  assert.equal(aClips[0]!.srcInFrame, 0, 'leading silence before first word is never stripped');
  assert.equal(aClips[1]!.srcInFrame, 90, 'second sub-clip starts cleanly at 3000ms (frame 90)');
  assert.equal(deleted.items.find((it) => it.id === 'v2')!.startFrame, 60, 'downstream clips ripple earlier by removed 60f');
  assert.equal(deleted.foldGroups?.length, 2, 'independent foldGroups created for audio & linked video');

  // Toggle deleted word back -> restores original single span cleanly
  const restored = compileTranscriptTrackEdit(deleted, { type: 'toggleWord', id: 'a1', idx: 1 });
  const restoredUnit = resolveTranscriptUnit(restored, 'a1')!;
  assert.deepEqual(restoredUnit.deletedWordIdx, []);
  assert.equal(restoredUnit.clips.length, 1);

  // Gap compress then widen/restore via setGapCap
  const unit0 = resolveTranscriptUnit(baseState, 'a1')!;
  assert.deepEqual(unit0.gapCapsMs, {});
  const capped = compileTranscriptTrackEdit(baseState, { type: 'setGapCap', id: 'a1', afterWordIndex: 2, maxMs: 200 });
  assert.equal(resolveTranscriptUnit(capped, 'a1')?.gapCapsMs['2'] !== undefined, true, '1000ms gap compressed to 200ms');
  const widened = compileTranscriptTrackEdit(capped, { type: 'setGapCap', id: 'a1', afterWordIndex: 2, maxMs: null });
  assert.deepEqual(resolveTranscriptUnit(widened, 'a1')?.gapCapsMs, {}, 'pause restored to natural gap');

  // Locked track rejects transcript track edit
  const locked: TimelineState = { ...baseState, tracks: { ...baseState.tracks, V1: { kind: 'video', locked: true } } };
  assert.strictEqual(compileTranscriptTrackEdit(locked, { type: 'toggleWord', id: 'a1', idx: 1 }), locked);
}

console.log('edit.check: ok (媒体窗投影/Track-SSOT编译器/首尾句柄保留/气口伸缩/AV联动切割/锁定保护)');
