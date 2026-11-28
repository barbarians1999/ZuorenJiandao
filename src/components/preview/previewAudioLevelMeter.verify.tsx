import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectDoc, TimelineState } from '../../editor/types';
import { PreviewAudioLevelMeter } from './PreviewAudioLevelMeter';
import {
  AUDIO_METER_TICKS,
  buildAudioLevelReading,
  decibelsToMeterPercent,
  formatAudioMeterDb,
  linearToDecibels,
  measureTimelineAudioLevelAtFrame,
  type AudioStereoEnvelope,
} from './previewAudioLevelMeterState';

// 1. Decibel and meter percentage mapping
assert.equal(linearToDecibels(0), Number.NEGATIVE_INFINITY);
assert.ok(Math.abs(linearToDecibels(1) - 0) < 1e-6);
assert.ok(Math.abs(linearToDecibels(0.5) - (-6.0206)) < 1e-3);
assert.equal(decibelsToMeterPercent(Number.NEGATIVE_INFINITY), 0);
assert.equal(decibelsToMeterPercent(-48), 0);
assert.equal(decibelsToMeterPercent(-24), 50);
assert.equal(decibelsToMeterPercent(-12), 75);
assert.equal(decibelsToMeterPercent(-6), 87.5);
assert.equal(decibelsToMeterPercent(0), 100);
assert.equal(decibelsToMeterPercent(3), 100);
assert.equal(formatAudioMeterDb(Number.NEGATIVE_INFINITY), '-∞');
assert.equal(formatAudioMeterDb(-12.34), '-12.3');
assert.equal(formatAudioMeterDb(0), '0.0');
assert.equal(formatAudioMeterDb(1.4), '+1.4');

// 2. Instantaneous clipping indicator: turns on at >= 0 dB, turns off immediately below 0 dB (no sticky hold)
const quietReading = buildAudioLevelReading(0.25, 0.5);
assert.equal(quietReading.clippingLeft, false);
assert.equal(quietReading.clippingRight, false);
assert.equal(quietReading.clipping, false);

const leftClipReading = buildAudioLevelReading(1.0, 0.4);
assert.equal(leftClipReading.clippingLeft, true);
assert.equal(leftClipReading.clippingRight, false);
assert.equal(leftClipReading.clipping, true);

const afterClipReading = buildAudioLevelReading(0.3, 0.3);
assert.equal(afterClipReading.clippingLeft, false);
assert.equal(afterClipReading.clippingRight, false);
assert.equal(afterClipReading.clipping, false, 'overload red light must clear immediately once level drops below 0 dB');

// 3. Timeline stereo mix evaluation with clip volume, fades, mute, and ducking
const stereoEnvelope: AudioStereoEnvelope = {
  leftPeaks: new Float32Array(100).fill(0.8),
  rightPeaks: new Float32Array(100).fill(0.4),
  peaksPerSecond: 100,
  durationMs: 1000,
};

const baseState: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['V1', 'A1', 'A2'],
  tracks: {
    V1: { kind: 'video' },
    A1: { kind: 'audio', role: 'anchor' },
    A2: { kind: 'audio', role: 'follower', audioRouting: { duckDepthDb: -12 } },
  },
  items: [
    {
      id: 'clip-a1',
      name: 'Voiceover',
      kind: 'audio',
      track: 'A1',
      startFrame: 0,
      durationInFrames: 30,
      src: '/media/uploads/vo.wav',
      volume: 1,
    },
  ],
};

const activeFrameReading = measureTimelineAudioLevelAtFrame({
  state: baseState,
  frame: 10,
  resolveEnvelope: () => stereoEnvelope,
});
assert.ok(Math.abs(activeFrameReading.leftLinear - 0.8) < 1e-5);
assert.ok(Math.abs(activeFrameReading.rightLinear - 0.4) < 1e-5);
assert.equal(activeFrameReading.clipping, false);

// Boosted clip volume triggers clipping on Left channel (>= 1.0) while Right stays unclipped
const boostedState: TimelineState = {
  ...baseState,
  items: [{ ...baseState.items[0]!, volume: 1.5 }],
};
const boostedReading = measureTimelineAudioLevelAtFrame({
  state: boostedState,
  frame: 10,
  resolveEnvelope: () => stereoEnvelope,
});
assert.ok(Math.abs(boostedReading.leftLinear - 1.2) < 1e-5);
assert.equal(boostedReading.clippingLeft, true);
assert.equal(boostedReading.clippingRight, false);

// Muted track yields silence
const mutedState: TimelineState = {
  ...baseState,
  tracks: {
    ...baseState.tracks,
    A1: { kind: 'audio', muted: true },
  },
};
const mutedReading = measureTimelineAudioLevelAtFrame({
  state: mutedState,
  frame: 10,
  resolveEnvelope: () => stereoEnvelope,
});
assert.equal(mutedReading.peakLinear, 0);
assert.equal(mutedReading.clipping, false);

// 4. Component markup & PreviewPanel / PreviewMonitorBar integration
const emptyProject: ProjectDoc = {
  version: 3,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'main',
  timelines: [{ id: 'main', name: 'Main', order: 0, ...baseState, items: [] }],
};
const html = renderToStaticMarkup(
  <PreviewAudioLevelMeter
    state={{ ...baseState, items: [] }}
    project={emptyProject}
    timelineId="main"
    playerRef={{ current: null }}
  />,
);
assert.match(html, /aria-label="音量电平"/);
assert.match(html, /aria-label="左声道电平"/);
assert.match(html, /aria-label="右声道电平"/);
assert.match(html, /aria-label="左声道爆音指示"/);
assert.match(html, /aria-label="右声道爆音指示"/);
for (const tick of AUDIO_METER_TICKS) {
  assert.match(html, new RegExp(`>${tick}<`), `meter scale must display ${tick} dB tick`);
}

const previewPanelSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(
  previewPanelSource,
  /const \[audioMeterOpen, setAudioMeterOpen\] = useState\(false\);/,
  'audio level meter must default to collapsed (false) on every startup without persisting open state',
);
assert.match(
  previewPanelSource,
  /<PreviewAudioLevelMeter[\s\S]*?\/>/,
  'PreviewPanel mounts PreviewAudioLevelMeter when toggled open',
);

const monitorBarSource = readFileSync(new URL('./PreviewMonitorBar.tsx', import.meta.url), 'utf8');
assert.match(
  monitorBarSource,
  /cc-preview-audio-meter-toggle/,
  'PreviewMonitorBar exposes the right-side toggle button for the audio level meter',
);

console.log('previewAudioLevelMeter.verify: dB scale, stereo mix, instant clip indicator, and UI toggle passed');
