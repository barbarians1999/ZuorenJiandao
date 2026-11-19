// Tiny actual-composition export: complements the full chapter/title checks
// without restarting the video-decoder or long-video stress scenarios.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, statfs, writeFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { renderTimeline, renderTimelineStills, setUploadsDirProvider } from '../remotion/render.mjs';
import { withResourceGuard } from './long-video-resource-guard.mjs';
import { auditChapterTransition } from './chapter-transition-audit.mjs';
import { prepareChapterBundle } from './chapter-render-bundle.mjs';
import { chapterComparisonStills } from './chapter-render-frames.mjs';

assert.ok(ffmpeg);
const enforceMemoryLimit = process.env.CC_BENCHMARK_IGNORE_MEMORY_LIMIT !== '1';
if (enforceMemoryLimit) assert.ok(freemem() > 2.5 * 1024 ** 3, 'Insufficient free RAM; do not automatically retry');
await mkdir(resolve('release'), { recursive: true });
const root = await mkdtemp(resolve('release/chapter-transitions-'));
const report = { startedAt: new Date().toISOString(), width: 160, height: 90, frames: 80, concurrency: 1,
  enforceMemoryLimit,
  bundle: process.env.CC_REMOTION_BUNDLE ?? 'fresh source bundle', status: 'running', samples: [], comparisons: [] };
process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1';
process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING = '1';
setUploadsDirProvider(() => process.env.CC_CHAPTER_FIXTURE_ROOT ?? root);
const runFile = promisify(execFile);
try {
  await withResourceGuard({
    enforceMemoryLimit,
    sample: async () => { const disk = await statfs(root); return { freeMemoryBytes: freemem(), freeDiskBytes: Number(disk.bavail) * Number(disk.bsize) }; },
    intervalMs: 1000, onSample: (sample) => { report.samples.push(sample); },
    run: async (signal) => {
      report.bundle = await prepareChapterBundle({ reuse: process.env.CC_REMOTION_BUNDLE, existingOnly: true, signal });
      process.env.CC_REMOTION_BUNDLE = report.bundle.directory;
      const exec = (args, extra = {}) => runFile(ffmpeg, ['-v', 'error', ...args], { windowsHide: true, signal, ...extra });
      const items = [];
      for (const [i, color] of ['0xdc281e', '0x1446d2', '0x1eaa46', '0xe6b928'].entries()) {
        const file = join(root, `color-${i}.png`);
        await exec(['-f', 'lavfi', '-i', `color=c=${color}:s=160x90`, '-frames:v', '1', '-threads', '1', file]);
        items.push({ id: `shot-${i}`, kind: 'image', track: 'V1', name: `shot-${i}`, src: 'data:image/png;base64,' + (await readFile(file)).toString('base64'), width: 160, height: 90, startFrame: i * 20, durationInFrames: 20 });
      }
      const types = ['mosaic-reveal', 'blinds-reveal', 'split-slide'];
      const transitions = types.map((type, i) => ({ id: `tr-${i}`, type, outgoingItemId: items[i].id, incomingItemId: items[i + 1].id, trackId: 'V1', durationInFrames: 12 }));
      const state = { fps: 30, width: 160, height: 90, fit: 'contain', items, transitions, selectedId: null, tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'] };
      const output = join(root, 'transitions.mp4');
      await renderTimeline({ state, outputLocation: output, codec: 'h264', h264Profile: { id: 'libx264', label: 'Software', hardware: false, transport: 'server' },
        signal, offthreadVideoCacheSizeInBytes: 256 * 1024 ** 2, mediaCacheSizeInBytes: 256 * 1024 ** 2, offthreadVideoThreads: 1 });
      const bytes = 160 * 90 * 3;
      const { stdout } = await exec(['-i', output, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: bytes * 82 });
      assert.equal(stdout.length, bytes * 80, 'decode the entire exported file');
      const frame = (f) => stdout.subarray(f * bytes, (f + 1) * bytes);
      const mse = (a, b) => { let sum = 0; for (let i = 0; i < bytes; i++) sum += (a[i] - b[i]) ** 2; return sum / bytes; };
      for (let i = 0; i < 3; i++) {
        const start = 14 + i * 20, end = 25 + i * 20, middle = 19 + i * 20;
        const observed = { type: types[i], startMse: mse(frame(start - 1), frame(start)), endMse: mse(frame(end), frame(end + 1)), middleToStartMse: mse(frame(middle), frame(start)), middleToEndMse: mse(frame(middle), frame(end)) };
        report.comparisons.push(observed);
        assert.ok(observed.startMse < 20 && observed.endMse < 20, `${types[i]} exact endpoints`);
        assert.ok(observed.middleToStartMse > 500 && observed.middleToEndMse > 500, `${types[i]} visible middle state`);
        Object.assign(observed, auditChapterTransition(types[i], frame(middle), frame(start), frame(end), 160, 90));
      }
      const stills = await chapterComparisonStills(renderTimelineStills, { state, frames: [14, 19, 25, 34, 39, 45, 54, 59, 65], signal });
      for (const still of stills) await writeFile(join(root, `frame-${still.frame}.jpg`), Buffer.from(still.base64, 'base64'));
    },
  });
  report.status = 'passed'; report.finishedAt = new Date().toISOString();
  console.log(`chapter transitions: actual short export, all 80 decoded frames, GLSL endpoints and middle states passed; ${root}`);
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error); throw error; }
finally { await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2)); }
