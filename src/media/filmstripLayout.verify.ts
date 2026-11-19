import assert from 'node:assert/strict';
import { filmstripDrawPlan } from './filmstripLayout.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const long = filmstripDrawPlan({
  durationMs: 600_000,
  frameCount: 32,
  cellWidth: 172,
  cellHeight: 96,
  fps: 30,
  px: 0.5,
  srcInFrame: 0,
  durationInFrames: 18_000,
  playbackRate: 1,
  widthPx: 9_000,
  heightPx: 40,
});
assert.ok(long.length > 32, 'long source intervals repeat crisp thumbnail tiles at timeline scale');
assert.equal(long[0]?.x, 0, 'the visible filmstrip starts at the clip edge');
assert.ok(
  Math.abs(long.at(-1)!.x + long.at(-1)!.width - 9_000) < 0.01,
  'the visible filmstrip covers the full timeline clip width',
);
for (const tile of long) {
  const sourceAspect = tile.sourceWidth / 96;
  const displayAspect = tile.width / tile.height;
  assert.ok(Math.abs(sourceAspect - displayAspect) < 0.0001, 'thumbnail crops preserve source aspect ratio');
}

const zoomedOut = filmstripDrawPlan({
  durationMs: 8_000,
  frameCount: 12,
  cellWidth: 172,
  cellHeight: 96,
  fps: 30,
  px: 0.02,
  srcInFrame: 0,
  durationInFrames: 240,
  playbackRate: 1,
  widthPx: 4.8,
  heightPx: 36,
});
assert.equal(zoomedOut.length, 1, 'zoomed-out short clips coalesce redundant samples instead of drawing blurred slivers');

const trimmedAndRetimed = filmstripDrawPlan({
  durationMs: 60_000,
  frameCount: 12,
  cellWidth: 172,
  cellHeight: 96,
  fps: 30,
  px: 1,
  srcInFrame: 400,
  durationInFrames: 100,
  playbackRate: 2,
  widthPx: 100,
  heightPx: 36,
});
assert.ok(trimmedAndRetimed.length > 0, 'trimmed and retimed clips still show source frames');
assert.ok(trimmedAndRetimed.every((tile) => tile.x >= 0 && tile.x + tile.width <= 100.001), 'tiles stay inside the visible clip');
assert.ok(trimmedAndRetimed.every((tile) => tile.frameIndex >= 2 && tile.frameIndex <= 5), 'crop maps to the correct source-time region');
assert.ok(trimmedAndRetimed.some((tile) => tile.frameIndex !== trimmedAndRetimed[0]?.frameIndex), 'a crop crossing a sample boundary shows both neighboring source frames');

const frozenTail = filmstripDrawPlan({
  durationMs: 1_000,
  frameCount: 12,
  cellWidth: 172,
  cellHeight: 96,
  fps: 30,
  px: 1,
  srcInFrame: 30,
  durationInFrames: 20,
  playbackRate: 1,
  widthPx: 20,
  heightPx: 36,
});
assert.ok(frozenTail.some((tile) => tile.x + tile.width > 0), 'frozen tail remains represented after source duration');
assert.ok(frozenTail.every((tile) => tile.frameIndex === 11), 'frozen tail reuses the last sampled source frame');

console.log('Filmstrip layout checks passed.');

// Video and detached audio share a src-keyed preview cache, including stripUrl.
// Mock only that data hook; render the actual component and waveform functions.
const sharedPreview = {
  peaks: [0.2, 0.6, 0.4, 0.8], peaksPerSecond: 1, durationMs: 4_000,
  stripUrl: '/fixture-strip.jpg',
  stripMetadata: { frameCount: 4, cellWidth: 172, cellHeight: 96, durationMs: 4_000 },
  waveformStatus: 'ready', filmstripStatus: 'ready',
};
const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null }, plugins: [{
    name: 'filmstrip-shared-preview-fixture', enforce: 'pre',
    resolveId(source, importer) {
      if (source === '../../media/clipPreview' && importer?.replace(/\\/g, '/').endsWith('/ClipMediaLayers.tsx'))
        return '\0filmstrip-shared-preview-fixture';
    },
    load(id) {
      if (id === '\0filmstrip-shared-preview-fixture') return `
        export { filmstripBackground, peaksPath } from '/src/media/clipPreview.ts';
        export const useClipPreview = () => (${JSON.stringify(sharedPreview)});
      `;
    },
  }] });
try {
  const { ClipMediaLayers } = await vite.ssrLoadModule('/src/components/timeline/ClipMediaLayers.tsx');
  const props = { px: 1, fps: 30, height: 48, clipStartFrame: 0, durationInFrames: 120,
    srcInFrame: 0, playbackRate: 1, visibleWindow: { startFrame: 0, endFrame: 120 } };
  const item = { id: 'video', kind: 'video', name: 'Source', track: 'V1', src: '/media/uploads/source.mp4',
    startFrame: 0, durationInFrames: 120 };
  const videoMarkup = renderToStaticMarkup(createElement(ClipMediaLayers, { ...props, item }));
  const audioMarkup = renderToStaticMarkup(createElement(ClipMediaLayers, {
    ...props, item: { ...item, id: 'audio', kind: 'audio', track: 'A1', audioDetached: true },
  }));
  assert.match(videoMarkup, /<canvas\b/, 'video clips retain their thumbnail filmstrip');
  assert.match(videoMarkup, /cc-clip-wave on-video/, 'video clips retain the audio waveform');
  assert.doesNotMatch(audioMarkup, /<canvas\b/, 'same-source detached audio must not mount a video filmstrip');
  assert.match(audioMarkup, /cc-clip-wave/, 'same-source detached audio keeps its waveform');
  assert.doesNotMatch(audioMarkup, /on-video/, 'audio waveform keeps its full-height audio layout');
  console.log('Filmstrip shared video/audio cache rendering checks passed.');

  const { resolvePeaksPerSecond, peaksPath, soundEffectPreview } = await vite.ssrLoadModule('/src/media/clipPreview.ts');
  // Long media cached with stale peaksPerSecond=100 must recover real sample rate (~4.56/s for 44m) so waveforms past 2:00 stay active.
  const longPeaks = Array.from({ length: 12_005 }, (_, i) => (i > 6_000 ? 0.55 : 0.25));
  const recoveredRate = resolvePeaksPerSecond(longPeaks, 100, 2_632_133);
  assert.ok(recoveredRate > 4 && recoveredRate < 5, `recovered rate expected ~4.56, got ${recoveredRate}`);
  const latePath = peaksPath(
    { peaks: longPeaks, peaksPerSecond: 100, durationMs: 2_632_133, stripUrl: null, waveformStatus: 'ready', filmstripStatus: 'not-requested' },
    { widthPx: 240, height: 32, fps: 30, srcInFrame: 50_000, durationInFrames: 1800, playbackRate: 1 },
  );
  assert.ok(latePath.startsWith('M') && latePath.endsWith('Z'), 'peaksPath builds closed filled waveform ribbon');
  const ys = [...latePath.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ys.length >= 4 && Math.max(...ys) - Math.min(...ys) > 8, 'waveforms past 2:00 preserve real amplitude instead of flat baseline');

  const sfxPreview = soundEffectPreview('/sound-effects/simple-whoosh.mp3');
  assert.ok(sfxPreview && sfxPreview.peaks.length > 0 && sfxPreview.peaksPerSecond > 10, 'built-in sound effects expose real peaks without fake hash textures');
  console.log('Long-media waveform recovery & built-in sound-effect peak checks passed.');
} finally {
  await vite.close();
}
