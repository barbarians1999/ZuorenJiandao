// Bounded, serial production-render regression; generated short media only.
import assert from 'node:assert/strict';
import { existsSync, statfsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareChapterBundle } from './chapter-render-bundle.mjs';
import { benchmarkCommand } from './long-video-command.mjs';
import { setMosaicRegion, DEFAULT_MOSAIC } from '../src/editor/mosaic.ts';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';

const base = resolve('release/mask-blur-20261014'); await mkdir(base, { recursive: true });
const root = createTestArtifacts('mask-blur-render');
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Six-minute short mask/blur deadline')), 360000);
const report = { status: 'running', root, startedAt: new Date().toISOString(), checks: [], cases: [],
  scope: 'Generated 640x360 short media; production Gaussian/mask stills and one 3-second export. Not full suite, long-video, packaged app or installation acceptance.' };
const save = () => writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
const disk = () => {
  for (const path of [root, ...(existsSync('D:/') ? ['D:/'] : [])]) {
    const space = statfsSync(path);
    assert(Number(space.bavail) * Number(space.bsize) > 2 * 1024 ** 3, `Low disk space: ${path}`);
  }
};
try {
  disk(); await save(); console.log(`REPORT ${join(root, 'results.json')}`);
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1';
  process.env.CC_RENDER_GL = 'swangle';
  process.env.CC_BROWSER_EXECUTABLE = resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe');
  assert(existsSync(process.env.CC_BROWSER_EXECUTABLE));
  const render = await import('../remotion/render.mjs');
  report.phase = 'fresh-bundle'; await save();
  report.bundle = await prepareChapterBundle({ output: join(root, 'serve'), reuse: process.env.CC_REMOTION_BUNDLE,
    build: render.prebuildServeBundle, signal: controller.signal });
  process.env.CC_REMOTION_BUNDLE = report.bundle.directory;
  render.setUploadsDirProvider(() => root);
  const { ffmpegBin, ffprobeBin } = await import('../server/media-binaries.ts');
  const cmd = (binary, args, encoding = 'utf8', maxBuffer = 8 * 1024 ** 2) => benchmarkCommand(binary, args,
    { encoding, maxBuffer, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
  const ff = (args, encoding, maxBuffer) => cmd(ffmpegBin(), ['-v', 'error', '-nostdin', ...args], encoding, maxBuffer);
  const width = 640, height = 360, pixels = width * height * 3;
  const sourcePixels = Buffer.alloc(pixels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = ((Math.floor(x / 6) + Math.floor(y / 6)) % 2) * 200 + 25;
    const at = (y * width + x) * 3;
    sourcePixels[at] = v; sourcePixels[at + 1] = y < 180 ? v / 2 : v; sourcePixels[at + 2] = y < 180 ? v : v / 2;
  }
  await writeFile(join(root, 'pattern.rgb'), sourcePixels);
  await ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '640x360', '-i', join(root, 'pattern.rgb'), '-frames:v', '1', join(root, 'pattern.png')]);
  await ff(['-loop', '1', '-i', join(root, 'pattern.png'), '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=3',
    '-t', '3', '-r', '30', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(root, 'source.mp4')]);
  const image = { id: 'image', kind: 'image', name: 'Pattern', track: 'V1', startFrame: 0, durationInFrames: 90,
    src: '/media/uploads/pattern.png', width, height };
  const state = (item) => ({ fps: 30, width, height, items: [item], selectedId: null, trackOrder: ['V1'], tracks: { V1: { kind: 'video' } } });
  const rgb = async (file, frame = 0) => ff(['-i', file, '-an', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], 'buffer', pixels * 2);
  const still = async (label, item, frame = 20) => {
    disk(); report.phase = label; await save();
    const result = await render.renderTimelineStills({ state: state(item), frames: [frame], fullResolution: true, signal: controller.signal });
    assert.equal(result.length, 1);
    const file = join(root, `${label}.jpg`); await writeFile(file, Buffer.from(result[0].base64, 'base64'));
    return rgb(file);
  };
  const baseline = await still('baseline', image);
  const localItem = { ...image, effects: setMosaicRegion([], { ...DEFAULT_MOSAIC, centerY: .25, width: .5, height: .4, strength: 70 }, 'gaussian') };
  const local = await still('local-gaussian', localItem);
  const meanSquared = (a, b, box) => {
    let sum = 0, count = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) for (let c = 0; c < 3; c++) {
      const at = (y * width + x) * 3 + c; sum += (a[at] - b[at]) ** 2; count++;
    }
    return sum / count;
  };
  const variation = (bytes, box) => {
    let sum = 0, count = 0;
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0] + 1; x < box[2]; x++) {
      const at = (y * width + x) * 3; sum += Math.abs(bytes[at] - bytes[at - 3]); count++;
    }
    return sum / count;
  };
  const inside = [240, 55, 400, 125], outside = [220, 235, 420, 305];
  report.regionAudit = { insideBefore: variation(baseline, inside), insideAfter: variation(local, inside),
    outsideMse: meanSquared(baseline, local, outside), outsideBefore: variation(baseline, outside), outsideAfter: variation(local, outside) };
  await save();
  assert(report.regionAudit.insideAfter < report.regionAudit.insideBefore * .15, 'High-frequency source must be smoothed, not merely recolored');
  assert(report.regionAudit.outsideMse < 15, 'Bottom region must remain unchanged: catches inverted vertical coordinates');
  assert(report.regionAudit.outsideAfter > report.regionAudit.outsideBefore * .9);
  report.checks.push('Local Gaussian really smooths high frequencies at top-down UI coordinates; outside remains original');
  const full = await still('full-gaussian', { ...image, effects: setMosaicRegion([], { ...DEFAULT_MOSAIC, width: 1, height: 1 }, 'full') });
  assert(variation(full, outside) < variation(baseline, outside) * .15);
  const feather = await still('feather-gaussian', { ...localItem, effects: setMosaicRegion(localItem.effects, { ...DEFAULT_MOSAIC, centerY: .25, width: .5, height: .4, feather: 25 }, 'unused') });
  assert(meanSquared(feather, local, [160, 20, 180, 155]) > 20, 'Feather changes only edge blending');
  report.checks.push('Full Gaussian and edge feather actual frames');
  const animated = { ...localItem, id: 'video', kind: 'video', src: '/media/uploads/source.mp4', volume: .8,
    mask: { type: 'ellipse', x: .1, y: .1, width: .8, height: .8, feather: .025 },
    keyframes: { maskX: [{ frame: 0, value: .05 }, { frame: 89, value: .15 }], scale: [{ frame: 0, value: .95 }, { frame: 89, value: 1.05 }] },
    transform: { crop: { left: .03 } }, props: { visualEntrance: 'slide', visualEntranceFrames: 9, visualExit: 'zoom', visualExitFrames: 9 } };
  await writeFile(join(root, 'animated-project.json'), JSON.stringify(state(animated), null, 2));
  const reference = await still('masked-animation-reference', animated, 45);
  const { planExport } = await import('../server/plugins/export-plan.ts');
  const rendering = await import('../server/plugins/export-rendering.ts'); rendering.setUploadsDirProvider(() => root);
  const output = join(root, 'masked-blur-animation.mp4');
  report.phase = 'three-second-production-export'; await save();
  const started = performance.now();
  report.encoder = await rendering.renderExportPlan(planExport({ state: state(animated), format: 'video', codec: 'h264', fps: 30 }), output, () => {}, controller.signal);
  report.elapsedMs = performance.now() - started;
  const hashes = await ff(['-xerror', '-i', output, '-map', '0:v:0', '-an', '-f', 'framehash', 'pipe:1']);
  assert.equal(hashes.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 90);
  await ff(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  const info = JSON.parse(await cmd(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output]));
  assert(Math.abs(Number(info.format.duration) - 3) < .12);
  const finalFrame = await rgb(output, 45);
  report.exportMse = meanSquared(reference, finalFrame, [0, 0, width, height]);
  assert(report.exportMse < 200, 'Gaussian/mask/animation/keyframe preview reference matches export');
  report.boundaryComparisons = [];
  for (const frame of [0, 8, 81, 89]) {
    const boundaryReference = await still(`animation-boundary-${frame}`, animated, frame);
    const boundaryOutput = await rgb(output, frame);
    const mse = meanSquared(boundaryReference, boundaryOutput, [0, 0, width, height]);
    assert(mse < 200, `Animation boundary ${frame} must match composition`);
    report.boundaryComparisons.push({ frame, mse });
  }
  const pcm = async (file) => {
    const bytes = await ff(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], 'buffer', 48000 * 4 * 4);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const sourceAudio = await pcm(join(root, 'source.mp4')), finalAudio = await pcm(output);
  const rms = (data) => Math.sqrt(data.slice(24000, 96000).reduce((sum, value) => sum + value * value, 0) / 72000);
  report.audioAudit = { duration: finalAudio.length / 48000, gainRatio: rms(finalAudio) / rms(sourceAudio) };
  assert(Math.abs(report.audioAudit.duration - 3) < .08);
  assert(Math.abs(report.audioAudit.gainRatio - .8) < .035, 'Mask/blur/animation must not change audio gain');
  report.checks.push('Production 3s export: all 90 frames and audio decode; duration; mask/crop/animation/keyframe mid-frame consistency');
  report.phase = 'negative-export-privacy-check'; await save();
  const broken = state(animated);
  broken.items[0] = { ...animated, effects: [{ id: 'broken', assetId: 'custom:mask-blur-broken' }, ...animated.effects] };
  broken.fxDefs = { 'custom:mask-blur-broken': { id: 'custom:mask-blur-broken', name: 'Intentional shader failure fixture', desc: '', frag: 'not valid GLSL', props: [] } };
  let rejected = false;
  try { await render.renderTimelineStills({ state: broken, frames: [45], fullResolution: true, signal: controller.signal }); }
  catch (error) {
    report.expectedShaderFailure = { error: error.stack ?? String(error) };
    assert(/shader|compile|GLSL|valid GLSL|syntax/i.test(String(error)), 'Rejection must be shader-related, not a generic unrelated setup failure');
    rejected = true;
  }
  assert(rejected, 'Broken effect before Gaussian must refuse export instead of showing unprocessed source');
  report.checks.push('Actual shader failure rejects render rather than exporting unprocessed source');
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
  console.log(`PASSED ${join(root, 'results.json')}`);
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); await save(); console.error(report.error); process.exitCode = 1;
} finally { clearTimeout(deadline); finishTestArtifacts(root, { status: report.status,
  evidence: join(base, `render-evidence-${Date.now()}`) }); }
