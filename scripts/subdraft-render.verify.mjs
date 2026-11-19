// Bounded, serial still/export comparison, never a long-video benchmark.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, statfsSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import * as render from '../remotion/render.mjs';
import { prepareChapterBundle } from './chapter-render-bundle.mjs';
import { planExpandSubdraft } from '../src/editor/subdraftOperations.ts';
import { CURRENT_PROJECT_VERSION } from '../shared/project-version.ts';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';

const source = process.argv.find((arg) => arg.startsWith('--source='))?.slice(9);
const reuse = process.argv.find((arg) => arg.startsWith('--bundle='))?.slice(9);
assert.ok(source && existsSync(resolve(source)), 'Pass a local eight-second 1080p30 fixture with --source=');
assert.ok(freemem() > 4 * 1024 ** 3, 'Insufficient memory for this one short fresh render bundle');
await mkdir(resolve('release'), { recursive: true });
const root = createTestArtifacts('subdraft-render');
const disk = statfsSync(root);
assert.ok(Number(disk.bavail) * Number(disk.bsize) > 2 * 1024 ** 3, 'Insufficient disk space');
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Short render deadline (4 minutes)')), 240_000);
const run = promisify(execFile);
const exec = (args, options = {}) => run(ffmpeg, ['-v', 'error', ...args],
  { windowsHide: true, signal: controller.signal, timeout: 60_000, ...options });
const report = { startedAt: new Date().toISOString(), status: 'running', cases: [],
  scope: '480x270 paired nested/expanded stills and one 5-second generated-media export; not long-video, hardware or installation acceptance.' };
const save = () => writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
const timeline = (id, items, order = 0) => ({ id, name: id, order, fps: 30, width: 480, height: 270,
  selectedId: null, items, trackOrder: ['top', 'v', 'under'], tracks: {
    top: { kind: 'video' }, v: { kind: 'video' }, under: { kind: 'video' } } });
const video = (id, startFrame, srcInFrame) => ({ id, name: id, kind: 'video', track: 'v',
  startFrame, srcInFrame, durationInFrames: 60, src: '/media/uploads/source.mp4' });
const pixels = 480 * 270 * 3;
const rgb = async (file) => (await exec(['-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: pixels * 2 })).stdout;
const mse = (a, b) => { assert.equal(a.length, b.length); let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] - b[i]) ** 2; return total / a.length; };
try {
  await save();
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1';
  process.env.CC_RENDER_GL = 'swangle';
  const browser = resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe');
  if (existsSync(browser)) process.env.CC_BROWSER_EXECUTABLE = browser;
  report.bundle = await prepareChapterBundle({ output: join(root, 'serve'), reuse, build: render.prebuildServeBundle,
    signal: controller.signal });
  process.env.CC_REMOTION_BUNDLE = report.bundle.directory;
  await cp(resolve(source), join(root, 'source.mp4'));
  render.setUploadsDirProvider(() => root);
  for (const cropped of [false, true]) {
    const child = timeline('child', [video('first', 0, 30), video('second', 60, 120), {
      id: 'text', name: 'chapter', kind: 'text', track: 'top', startFrame: 35, durationInFrames: 15,
      props: { text: 'CHAPTER', fontFamily: 'Arial', fontSize: 32, entrance: 'none', exit: 'none' },
    }], 1);
    if (!cropped) child.items[0] = { ...child.items[0], fadeInFrames: 5,
      transform: { scale: 1.1 }, mask: { type: 'rectangle', x: .05, y: .05, width: .9, height: .9 } };
    const parent = timeline('main', [{ id: 'nested', name: 'nested', kind: 'sequence', track: 'v',
      timelineId: 'child', startFrame: 15, srcInFrame: cropped ? 30 : 0, durationInFrames: cropped ? 60 : 120 },
    { id: 'black', name: 'black', kind: 'solid', track: 'under', startFrame: 0, durationInFrames: 150,
      props: { color: '#000000' } }]);
    const doc = { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', timelines: [parent, child], assets: [], mediaFolders: [] };
    let id = 0;
    const expanded = planExpandSubdraft(doc, 'nested', (prefix) => `${prefix}-${++id}`);
    assert.ok(expanded.ok, expanded.error);
    const flat = expanded.doc.timelines[0];
    const label = cropped ? 'trimmed' : 'whole';
    const frames = cropped ? [15, 25, 44, 45, 74] : [15, 44, 55, 74, 75, 104, 134];
    const before = await render.renderTimelineStills({ state: parent, project: doc, timelineId: 'main', frames,
      fullResolution: true, signal: controller.signal });
    const after = await render.renderTimelineStills({ state: flat, project: expanded.doc, timelineId: 'main', frames,
      fullResolution: true, signal: controller.signal });
    const entry = { label, frames, comparisons: [] };
    for (let index = 0; index < frames.length; index++) {
      const files = [join(root, `${label}-${frames[index]}-nested.jpg`), join(root, `${label}-${frames[index]}-expanded.jpg`)];
      await writeFile(files[0], Buffer.from(before[index].base64, 'base64'));
      await writeFile(files[1], Buffer.from(after[index].base64, 'base64'));
      const error = mse(await rgb(files[0]), await rgb(files[1]));
      assert.ok(error < 20, `${label} frame ${frames[index]} changed after expansion: MSE ${error}`);
      entry.comparisons.push({ frame: frames[index], mse: error });
    }
    if (!cropped) {
      const output = join(root, 'expanded.mp4');
      await render.renderTimeline({ state: flat, project: expanded.doc, timelineId: 'main', outputLocation: output,
        codec: 'h264', h264Profile: { id: 'libx264', hardware: false }, disableFastExport: true,
        offthreadVideoCacheSizeInBytes: 256 * 1024 ** 2, mediaCacheSizeInBytes: 256 * 1024 ** 2,
        offthreadVideoThreads: 1, signal: controller.signal });
      const decoded = await exec(['-i', output, '-map', '0:v:0', '-an', '-f', 'framehash', 'pipe:1']);
      const count = decoded.stdout.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length;
      assert.equal(count, 150);
      await exec(['-i', output, '-map', '0:a:0', '-f', 'null', '-']);
      entry.export = { frames: count, fullVideoAndAudioDecode: 'passed', seconds: 5 };
    }
    report.cases.push(entry); await save();
  }
  report.status = 'passed';
  console.log(`Subdraft paired stills and short export passed: ${root}`);
} catch (error) { report.status = 'failed'; report.error = String(error.stack ?? error); throw error; }
finally { clearTimeout(deadline); report.finishedAt = new Date().toISOString(); await save();
  finishTestArtifacts(root, { status: report.status, evidence: resolve('release/logs', `subdraft-${Date.now()}`) }); }
