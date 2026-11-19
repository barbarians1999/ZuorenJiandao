// Real E2E pixel + audio parity and throughput benchmark for overlay-hybrid vs Remotion compositor.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
import { renderTimeline, setUploadsDirProvider } from '../remotion/render.mjs';
import { inspectOverlayHybridExport } from '../remotion/overlay-hybrid.mjs';
import { resolveH264EncoderProfile } from '../server/media-acceleration.ts';
import { createDirectCutFixture } from './direct-cut-fixture.mjs';

const exec = promisify(execFile);
const command = async (binary, args, buffer = false) => (await exec(binary, args, {
  windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 ** 2, encoding: buffer ? 'buffer' : 'utf8',
})).stdout;

const probe = async (file) => JSON.parse(await command(ffprobe.path, ['-v', 'error', '-show_streams', '-of', 'json', file]));
const picture = (file, frame) => command(ffmpeg, [
  '-v', 'error', '-i', file, '-an', '-vf', `select=eq(n\\,${frame}),scale=640:360,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
], true);
const samples = async (file) => {
  const data = await command(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'], true);
  return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
};
const meanError = (a, b) => {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};
const rmsDiff = (a, b) => {
  const len = Math.min(a.length, b.length);
  assert(len > 0);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / len);
};

const root = await mkdtemp(resolve('release/overlay-hybrid-e2e-'));
const uploadsDir = join(root, 'uploads');
await mkdir(uploadsDir, { recursive: true });
const source = join(uploadsDir, 'fixture.mp4');
const sourceUrl = '/media/uploads/fixture.mp4';

try {
  await createDirectCutFixture(source);
  setUploadsDirProvider(() => uploadsDir);

  const state = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['C1', 'T1', 'E1', 'V1', 'A1', 'A2'],
    tracks: {
      C1: {
        kind: 'caption',
        captions: {
          enabled: true,
          template: 'plain',
          pacing: 'phrase',
          sourceEntries: [{
            id: 'manual-1',
            itemId: 'manual:manual-1',
            words: [
              { id: 'c1', text: '第一段字幕测试', start: 0, end: 2200 },
              { id: 'c2', text: '第二段静止标题', start: 2300, end: 5200 },
              { id: 'c3', text: '第三段黑屏过渡', start: 6200, end: 9500 },
            ],
          }],
          style: { fontSize: 0.042, wholeLine: true, strokeWidth: 4, strokeColor: '#000000' },
        },
      },
      T1: { kind: 'video', visualRole: 'text' },
      E1: { kind: 'video', visualRole: 'effect' },
      V1: { kind: 'video' },
      A1: { kind: 'audio', audioRouting: { gainDb: -4 } },
      A2: { kind: 'audio' },
    },
    items: [
      { id: 'v1', name: 'v1', kind: 'video', track: 'V1', src: sourceUrl, startFrame: 15, srcInFrame: 15, durationInFrames: 180,
        width: 1920, height: 1080, volume: 0.5, transform: { x: -0.924, y: 0.252 },
        props: { visualEntrance: 'fade', visualExit: 'fade' } },
      { id: 'v2', name: 'v2', kind: 'video', track: 'V1', src: sourceUrl, startFrame: 210, srcInFrame: 30, durationInFrames: 90,
        width: 1920, height: 1080, volume: 0.4, filters: { brightness: 0 }, transform: { x: -2.3, y: 0.37 } },
      { id: 'solid1', name: 'solid1', kind: 'solid', track: 'E1', startFrame: 0, durationInFrames: 300,
        props: { color: '#182436' }, transform: { x: -25, y: 12, rotation: -35 },
        mask: { type: 'rectangle', x: 0.25, y: 0.25, width: 0.25, height: 0.2, feather: 0 } },
      { id: 'text1', name: 'text1', kind: 'text', track: 'T1', startFrame: 20, durationInFrames: 90,
        props: { text: '核心结论一', fontSize: 84, color: '#ffffff', entrance: 'fade', entranceFrames: 12, exit: 'fade', exitFrames: 12 } },
      { id: 'text2', name: 'text2', kind: 'text', track: 'T1', startFrame: 215, durationInFrames: 60,
        props: { text: '亮度归零测试', fontSize: 72, color: '#ffde59', entrance: 'fade', entranceFrames: 10, exit: 'fade', exitFrames: 10 } },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `aud-${i}`,
        name: `aud-${i}`,
        kind: 'audio',
        track: i % 2 === 0 ? 'A1' : 'A2',
        src: sourceUrl,
        startFrame: i * 28,
        srcInFrame: 5,
        durationInFrames: 26,
        volume: 0.35,
        fadeInFrames: 6,
        fadeOutFrames: 6,
      })),
    ],
  };

  process.env.CC_DIRECT_CUT_EXPORT = '1';
  const h264Profile = await resolveH264EncoderProfile(ffmpeg);
  const inspected = await inspectOverlayHybridExport({
    state,
    codec: 'h264',
    scale: 1,
    uploadsDirectory: uploadsDir,
    assetsDirectory: resolve('assets'),
    ffmpegExecutable: ffmpeg,
    ffprobeExecutable: ffprobe.path,
  });
  assert(inspected?.plan.eligible, 'expected complex fixture timeline to qualify for overlay-hybrid');

  const hybridOut = join(root, 'hybrid.mp4');
  const referenceOut = join(root, 'reference.mp4');

  const t0 = performance.now();
  const hybridRes = await renderTimeline({
    state,
    outputLocation: hybridOut,
    codec: 'h264',
    h264Profile,
    directMediaBinaries: { ffmpeg, ffprobe: ffprobe.path, profile: h264Profile },
    signal: AbortSignal.timeout(120_000),
  });
  const hybridMs = performance.now() - t0;

  assert.equal(hybridRes.renderRoute, 'hybrid');
  assert.equal(hybridRes.hybridMode, 'overlay-plates');
  console.log(`[e2e] hybrid export done in ${(hybridMs / 1000).toFixed(2)}s (${(300 / (hybridMs / 1000)).toFixed(1)} fps, plates=${hybridRes.plateCount}, encoder=${hybridRes.encoder?.id})`);

  const meta = await probe(hybridOut);
  const vStream = meta.streams.find((s) => s.codec_type === 'video');
  assert.equal(Number(vStream.nb_frames), 300);
  assert.equal(vStream.color_space, 'bt709');
  assert.equal(vStream.color_range, 'tv');
  const hashes = await command(ffmpeg, ['-v', 'error', '-xerror', '-i', hybridOut, '-map', '0:v:0', '-f', 'framehash', 'pipe:1']);
  assert.equal(hashes.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 300);

  // Reference full-compositor render (disableFastExport: true) for strict pixel + audio comparison
  const t1 = performance.now();
  await renderTimeline({
    state,
    outputLocation: referenceOut,
    codec: 'h264',
    disableFastExport: true,
    signal: AbortSignal.timeout(240_000),
  });
  const refMs = performance.now() - t1;
  console.log(`[e2e] baseline compositor done in ${(refMs / 1000).toFixed(2)}s (${(300 / (refMs / 1000)).toFixed(1)} fps), speedup=${(refMs / hybridMs).toFixed(2)}x`);

  // Check pixel MAE < 3.0 across gaps, video transform/fade-in/fade-out, fade text, static text hold, caption switches, brightness=0
  const checkFrames = [5, 18, 25, 60, 105, 145, 189, 200, 235, 290];
  for (const frame of checkFrames) {
    const mae = meanError(await picture(hybridOut, frame), await picture(referenceOut, frame));
    console.log(`[e2e] frame ${frame} pixel MAE=${mae.toFixed(3)}`);
    assert(mae < 3.0, `frame ${frame} pixel MAE ${mae.toFixed(3)} exceeded 3.0`);
  }

  // Check audio mix RMS difference against full compositor reference
  const hybridAudio = await samples(hybridOut);
  const refAudio = await samples(referenceOut);
  const audioRms = rmsDiff(hybridAudio, refAudio);
  console.log(`[e2e] audio RMS diff=${audioRms.toFixed(5)} (hybrid samples=${hybridAudio.length}, ref=${refAudio.length})`);
  assert(audioRms < 0.06, `audio RMS diff ${audioRms.toFixed(5)} exceeded 0.06`);

  console.log('[verify] overlay-hybrid E2E pixel & audio parity passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
