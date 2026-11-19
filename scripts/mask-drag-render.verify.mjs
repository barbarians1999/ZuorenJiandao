import assert from 'node:assert/strict';
import { existsSync, statfsSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { prepareChapterBundle, chapterSourceDigest } from './chapter-render-bundle.mjs';
import { benchmarkCommand } from './long-video-command.mjs';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';

const saved = resolve(process.argv.find((arg) => arg.startsWith('--project='))?.slice(10) ?? '');
assert(saved.endsWith('saved-project.json') && saved.includes('mask-drag-20261014'), 'Use the actual drag UI saved project');
const uiReport = JSON.parse(await readFile(join(dirname(saved), 'results.json'), 'utf8'));
assert.equal(uiReport.status, 'passed');
const base = resolve('release/mask-drag-20261014'); await mkdir(base, { recursive: true });
const root = createTestArtifacts('mask-drag-render');
const signal = AbortSignal.timeout(360000);
const report = { status: 'running', root, saved, startedAt: new Date().toISOString(), checks: [], frames: [],
  scope: 'Actual mouse-edited and reopened mask geometry/curves, generated3s640x360 video. Fresh composition stills and90-frame production export. Not full-suite, installer or long-video acceptance.' };
const save = () => writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
try {
  for (const path of [root, ...(existsSync('D:/') ? ['D:/'] : [])]) {
    const s = statfsSync(path); assert(Number(s.bavail) * Number(s.bsize) > 2 * 1024 ** 3, `Low disk space: ${path}`);
  }
  const project = JSON.parse(await readFile(saved, 'utf8'));
  const timeline = project.timelines.find((entry) => entry.id === project.activeTimelineId);
  assert.equal(timeline.items.length, 1); assert.equal(timeline.items[0].durationInFrames, 90);
  assert(timeline.items[0].mask && timeline.items[0].keyframes.maskX.length === 2);
  // Only the temporary local media alias changes; real saved mask/curve/transform bytes are retained.
  timeline.items[0].src = '/media/uploads/source.mp4';
  await writeFile(join(root, 'export-project.json'), JSON.stringify(project, null, 2));
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1'; process.env.CC_RENDER_GL = 'swangle';
  process.env.CC_BROWSER_EXECUTABLE = resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe');
  const render = await import('../remotion/render.mjs');
  report.phase = 'fresh-bundle'; await save();
  report.bundle = await prepareChapterBundle({ output: join(root, 'serve'), build: render.prebuildServeBundle, signal });
  process.env.CC_REMOTION_BUNDLE = report.bundle.directory;
  const rendering = await import('../server/plugins/export-rendering.ts');
  rendering.setUploadsDirProvider(() => resolve('release/mask-blur-20261014/render-waByLJ'));
  const { planExport } = await import('../server/plugins/export-plan.ts');
  const { ffmpegBin, ffprobeBin } = await import('../server/media-binaries.ts');
  const cmd = (binary, args, encoding = 'utf8') => benchmarkCommand(binary, args,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), encoding, maxBuffer: 8 * 1024 ** 2 });
  const ff = (args, encoding) => cmd(ffmpegBin(), ['-v', 'error', '-nostdin', ...args], encoding);
  const output = join(root, 'mouse-edited-mask.mp4');
  report.phase = 'production-export'; await save();
  const started = performance.now();
  report.encoder = await rendering.renderExportPlan(planExport({ state: timeline, project,
    timelineId: project.activeTimelineId, format: 'video', codec: 'h264', fps: 30 }), output, () => {}, signal);
  report.exportMs = performance.now() - started;
  const hashes = await ff(['-xerror', '-i', output, '-map', '0:v:0', '-an', '-f', 'framehash', 'pipe:1']);
  assert.equal(hashes.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 90);
  await ff(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);
  const info = JSON.parse(await cmd(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output]));
  report.duration = Number(info.format.duration); assert(Math.abs(report.duration - 3) < .12);
  report.checks.push('All90 frames decode; whole audio/video decode and3-second duration');
  const rgb = (file, frame) => ff(['-i', file, '-an', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], 'buffer');
  for (const frame of [0, 45, 89]) {
    report.phase = `reference-${frame}`; await save();
    const [still] = await rendering.renderTimelineStills({ state: timeline, project, timelineId: project.activeTimelineId,
      frames: [frame], fullResolution: true, signal });
    const path = join(root, `reference-${frame}.jpg`); await writeFile(path, Buffer.from(still.base64, 'base64'));
    const a = await rgb(path, 0), b = await rgb(output, frame);
    assert.equal(a.length, 640 * 360 * 3); assert.equal(b.length, a.length);
    let sum = 0; for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    const mse = sum / a.length; assert(mse < 200, `Mask/crop/rotation/keyframe frame${frame} differs: ${mse}`);
    report.frames.push({ frame, mse }); await save();
  }
  assert.equal(await chapterSourceDigest(), report.bundle.sourceDigest);
  report.checks.push('First/playhead/last actual saved ellipse, crop/scale/rotation/keyframe composition frames match export');
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save(); console.log(`PASSED ${join(root, 'results.json')}`);
} catch (error) { report.status = 'failed'; report.error = error.stack ?? String(error); await save(); console.error(report.error); process.exitCode = 1; }
finally { finishTestArtifacts(root, { status: report.status, evidence: join(base, `render-evidence-${Date.now()}`) }); }
