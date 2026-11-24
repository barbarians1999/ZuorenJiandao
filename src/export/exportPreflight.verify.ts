import assert from 'node:assert/strict';
import { analyzeExportRoutePreflight } from './exportPreflight';
import type { TimelineState } from '../editor/types';

const baseState = (): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['C1', 'T1', 'M1', 'V2', 'V1', 'A1'],
  tracks: {
    C1: { kind: 'caption', captions: { enabled: true, template: 'plain', pacing: 'phrase', words: [] } },
    T1: { kind: 'video', visualRole: 'text' },
    M1: { kind: 'video', visualRole: 'effect' },
    V2: { kind: 'video' },
    V1: { kind: 'video' },
    A1: { kind: 'audio', role: 'anchor' },
  },
  items: [
    {
      id: 'v1', name: 'v1', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 150,
      src: '/media/uploads/a.mp4', srcInFrame: 0, fadeInFrames: 8,
      mask: { type: 'ellipse', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.05 },
      effects: [
        { id: 'gb', assetId: 'builtin:fx-local-gaussian-blur', overrides: { strength: 80 } },
        { id: 'lm', assetId: 'builtin:fx-local-mosaic', overrides: { block_size: 20 } },
        { id: 'lut', assetId: 'builtin:slog3-s709', overrides: { intensity: 1 } },
      ],
    },
    {
      id: 'v2', name: 'v2', kind: 'video', track: 'V1', startFrame: 150, durationInFrames: 150,
      src: '/media/uploads/b.mp4', srcInFrame: 30,
    },
  ],
  transitions: [
    { id: 'tr_audio', type: 'audio-cross-fade', durationInFrames: 16, outgoingItemId: 'v1', incomingItemId: 'v2', trackId: 'V1' },
  ],
});

// 1. All native features (blur, local mosaic, ellipse mask, LUT, fadeInFrames, audio crossfade) -> fast
{
  const pre = analyzeExportRoutePreflight(baseState(), 'h264', 30);
  assert.equal(pre.mode, 'fast');
  assert.equal(pre.compatFrames, 0);
  assert.deepEqual(pre.reasons, []);
}

// 2. Adding a 20-frame page-curl transition -> segmented hybrid (only transition is compat)
{
  const st = baseState();
  st.transitions = [
    { id: 'tr_curl', type: 'page-curl', durationInFrames: 20, outgoingItemId: 'v1', incomingItemId: 'v2', trackId: 'V1' },
  ];
  const pre = analyzeExportRoutePreflight(st, 'h264', 30);
  assert.equal(pre.mode, 'segmented');
  assert.equal(pre.compatFrames, 20);
  assert.deepEqual(pre.reasons, ['transitions']);
}

// 3. Adding a 30-frame PiP overlay on V2 -> segmented hybrid
{
  const st = baseState();
  st.items.push({
    id: 'pip', name: 'pip', kind: 'video', track: 'V2', startFrame: 180, durationInFrames: 30,
    src: '/media/uploads/c.mp4', srcInFrame: 0,
  });
  const pre = analyzeExportRoutePreflight(st, 'h264', 30);
  assert.equal(pre.mode, 'segmented');
  assert.equal(pre.compatFrames, 30);
  assert.deepEqual(pre.reasons, ['overlapping-base-video']);
}

// 4. Non-H.264 codec -> full compat
{
  const pre = analyzeExportRoutePreflight(baseState(), 'prores', 30);
  assert.equal(pre.mode, 'compat');
  assert.deepEqual(pre.reasons, ['render-mode']);
}

// 5. Long timeline with word-pop captions triggers animatedCaptionWarning
{
  const st = baseState();
  st.items[1].durationInFrames = 2100;
  st.tracks!.C1!.captions!.motionPreset = 'word-pop';
  const pre = analyzeExportRoutePreflight(st, 'h264', 30);
  assert.equal(pre.animatedCaptionWarning, true);
}

// 6. Video clip with linear volume-only keyframes stays fast; non-volume keyframes trigger compat
{
  const st = baseState();
  st.items[0].keyframes = {
    volume: [
      { frame: 0, value: 1, easing: 'linear' },
      { frame: 30, value: 0.3, easing: 'linear' },
    ],
  };
  const preFast = analyzeExportRoutePreflight(st, 'h264', 30);
  assert.equal(preFast.mode, 'fast');

  st.items[0].keyframes.scale = [
    { frame: 0, value: 1, easing: 'linear' },
    { frame: 30, value: 1.2, easing: 'linear' },
  ];
  const preCompat = analyzeExportRoutePreflight(st, 'h264', 30);
  assert.equal(preCompat.mode, 'segmented');
  assert.ok(preCompat.reasons.includes('video-clip-effects'));
}

console.log('[verify] exportPreflight passed');
