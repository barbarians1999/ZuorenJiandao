// Bounded native export acceptance. No browser, long export or background job.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
import { tryDirectCutExport, planDirectCutExport } from '../remotion/direct-cut.mjs';
import { createDirectCutFixture } from './direct-cut-fixture.mjs';
const exec = promisify(execFile);
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const reference = arg('reference');
const hardware = process.argv.includes('--hardware');
const root = await mkdtemp(resolve('release/direct-cut-acceptance-'));
const source = arg('source') ? resolve(arg('source')) : join(root, 'source.mp4');
const report = { status: 'running', scope: 'Short generated-media native acceptance, not full/UI/installation acceptance',
  startedAt: new Date().toISOString(), source, cases: [] };
const save = () => writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
const command = async (binary, args, buffer = false) => (await exec(binary, args, {
  windowsHide: true, timeout: 60000, maxBuffer: 12 * 1024 ** 2, encoding: buffer ? 'buffer' : 'utf8',
})).stdout;
const probe = async (file) => JSON.parse(await command(ffprobe.path, ['-v', 'error', '-show_streams', '-of', 'json', file]));
const picture = (file, frame, sourceColor = false) => command(ffmpeg, ['-v', 'error', '-i', file, '-an', '-vf',
  `select=eq(n\\,${frame}),scale=320:180${sourceColor ? ':in_color_matrix=bt709:in_range=tv' : ''},format=rgb24`,
  '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], true);
const samples = async (file) => {
  const data = await command(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'], true);
  return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
};
const meanError = (a, b) => {
  assert.equal(a.length, b.length); assert(a.length > 0);
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
};
const sourceUrl = '/media/uploads/' + source.split(/[\\/]/).at(-1);
const clip = (id, startFrame, srcInFrame, durationInFrames) => ({ id, name: id, kind: 'video', track: 'V1',
  src: sourceUrl, startFrame, srcInFrame, durationInFrames, width: 1920, height: 1080, volume: 0.7 });
const basic = { fps: 30, width: 1920, height: 1080, selectedId: null, tracks: { V1: { kind: 'video' } },
  items: [clip('a', 15, 60, 60), clip('b', 75, 120, 60)] };
const cutMusic = { ...basic, tracks: { V1: { kind: 'video' }, A1: { kind: 'audio', audioRouting: { gainDb: -6 } } },
  items: [clip('a', 7, 90, 29), clip('b', 36, 30, 31), clip('c', 72, 160, 43),
    { id: 'music', kind: 'audio', track: 'A1', src: sourceUrl, startFrame: 23, srcInFrame: 10, durationInFrames: 100, volume: 0.4 }] };
const solo = structuredClone(cutMusic); solo.tracks.A1.soloed = true;
process.env.CC_DIRECT_CUT_EXPORT = '1';
try {
  if (!arg('source')) await createDirectCutFixture(source);
  report.sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
  report.implementationHash = createHash('sha256').update(await readFile(resolve('remotion/direct-cut.mjs'))).digest('hex');
  const sourcePcm = await samples(source);
  const hardwareProfile = hardware ? await (await import('../server/media-acceleration.ts')).resolveH264EncoderProfile(ffmpeg) : undefined;
  report.requestedHardware = hardware; report.detectedEncoder = hardwareProfile;
  const zeroMusic = structuredClone(cutMusic); zeroMusic.items.at(-1).srcInFrame = 0;
  for (const [name, state, frameRange] of [['plain', basic], ['cuts-music', cutMusic], ['solo-range', solo, [30, 113]], ['music-source-zero', zeroMusic]]) {
    const row = { name, status: 'running', frameRange }; report.cases.push(row); await save();
    const output = join(root, `${name}.mp4`), plan = planDirectCutExport({ state, frameRange });
    assert(plan.eligible); const started = performance.now();
    const result = await tryDirectCutExport({ state, frameRange, outputLocation: output,
      uploadsDirectory: resolve(source, '..'), assetsDirectory: resolve('assets'),
      h264Profile: hardwareProfile,
      ffmpegExecutable: ffmpeg, ffprobeExecutable: ffprobe.path, signal: AbortSignal.timeout(60000) });
    assert.equal(result.renderRoute, 'direct-cut');
    row.elapsedMs = performance.now() - started; row.encoder = result.encoder; row.frames = plan.frames;
    const metadata = await probe(output), video = metadata.streams.find((s) => s.codec_type === 'video');
    assert.equal(video.color_space, 'bt709'); assert.equal(video.color_range, 'tv');
    assert.equal(Number(video.nb_frames), plan.frames);
    assert(Math.abs(Number(video.duration) - plan.frames / state.fps) < 0.001);
    const decoded = await command(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-f', 'framehash', 'pipe:1']);
    assert.equal(decoded.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, plan.frames);
    row.pictures = [];
    const start = frameRange?.[0] ?? 0;
    const positions = new Set([0, plan.frames - 1]);
    for (const item of state.items.filter((item) => item.kind === 'video')) {
      for (const offset of [-1, 0, 1, item.durationInFrames - 1]) {
        const frame = item.startFrame + offset - start;
        if (frame >= 0 && frame < plan.frames) positions.add(frame);
      }
    }
    for (const frame of positions) {
      const actual = await picture(output, frame);
      const item = state.items.find((item) => item.kind === 'video' && frame + start >= item.startFrame
        && frame + start < item.startFrame + item.durationInFrames);
      const error = item ? meanError(actual, await picture(source, item.srcInFrame + frame + start - item.startFrame, true))
        : actual.reduce((sum, v) => sum + v, 0) / actual.length;
      assert(error < 3, `${name} frame ${frame}: source/black MAE ${error}`);
      row.pictures.push({ frame, meanAbsoluteError: error });
    }
    if (name === 'plain' && reference) {
      row.cachedReference = resolve(reference); row.referencePixels = [];
      for (const frame of [15, 45, 74, 75, 105, 134]) {
        const error = meanError(await picture(output, frame), await picture(resolve(reference), frame));
        assert(error < 3, `existing compositor reference frame ${frame}: ${error}`);
        row.referencePixels.push({ frame, meanAbsoluteError: error });
      }
    }
    // An independent sample-clock reference, not byte equality between two
    // lossy AAC encoders. Check gain/silence and synchronization separately.
    const expected = new Float32Array(plan.frames * 1600), actual = await samples(output);
    for (const item of state.items) {
      const track = state.tracks[item.track];
      if (track?.muted || track?.hidden || state.tracks.A1?.soloed && item.track !== 'A1') continue;
      const volume = item.volume * 10 ** ((track?.audioRouting?.gainDb ?? 0) / 20);
      for (let i = Math.max(0, (item.startFrame - start) * 1600); i < Math.min(expected.length, (item.startFrame + item.durationInFrames - start) * 1600); i++) {
        expected[i] += sourcePcm[item.srcInFrame * 1600 + i - (item.startFrame - start) * 1600] * volume;
      }
    }
    assert(actual.length >= expected.length && actual.length - expected.length < 1024, 'only final AAC padding allowed');
    let energy = 0, difference = 0, silentError = 0, silentCount = 0;
    for (let i = 1024; i < expected.length - 1024; i++) {
      energy += expected[i] ** 2; difference += (actual[i] - expected[i]) ** 2;
      if (Math.abs(expected[i]) < 1e-6) { silentError += actual[i] ** 2; silentCount++; }
    }
    const relativeRmsError = Math.sqrt(difference / energy);
    assert(relativeRmsError < 0.06, `${name} audio gain/sync error ${relativeRmsError}`);
    row.audio = { effectiveSamples: expected.length, decodedSamples: actual.length, relativeRmsError,
      silentRms: Math.sqrt(silentError / Math.max(1, silentCount)) };
    row.status = 'passed'; await save();
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally { report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ root, status: report.status, cases: report.cases.map(({ name, elapsedMs, status }) => ({ name, elapsedMs, status })), error: report.error?.message })); }
