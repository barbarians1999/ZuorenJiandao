// Small, serial, hidden-renderer regression. Never opens the user's browser.
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { createWriteStream, existsSync, statfsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { auditChapterTransition } from './chapter-transition-audit.mjs';
import { prepareChapterBundle } from './chapter-render-bundle.mjs';
import { chapterComparisonStills } from './chapter-render-frames.mjs';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';

const minimumFreeMemory = 2 * 1024 ** 3;
const enforceMemoryLimit = process.env.CC_BENCHMARK_IGNORE_MEMORY_LIMIT !== '1';
const runFile = promisify(execFile);
const allCases = ['chapters-landscape', 'chapters-portrait', 'title-actions', 'two-frame-titles',
  'short-overlap', 'picture-actions', 'chapter-transitions', 'transition-placement'];
// A manual continuation can run just the missing cases with the same guarded
// source-checked bundle. Default standard verification still runs every case.
const selectedCases = process.env.CC_CHAPTER_CASES ? process.env.CC_CHAPTER_CASES.split(',') : allCases;
assert.ok(selectedCases.length && selectedCases.every((label) => allCases.includes(label)), 'Unknown chapter case selection');
assert.equal(new Set(selectedCases).size, selectedCases.length, 'Duplicate chapter case selection');

if (!process.argv.includes('--worker')) {
  // A fresh webpack build was cancelled after a 2.8 GiB launch. Reserve more
  // headroom for that phase; cached rendering keeps the existing 2.5 GiB gate.
  const launchMemory = process.env.CC_REMOTION_BUNDLE ? minimumFreeMemory + 512 * 1024 ** 2 : 4 * 1024 ** 3;
  if (enforceMemoryLimit) assert.ok(freemem() >= launchMemory, `Not enough free RAM for ${process.env.CC_REMOTION_BUNDLE ? 'cached rendering (2.5 GiB)' : 'fresh bundling (4 GiB)'}; do not retry automatically`);
  await mkdir(resolve('release'), { recursive: true });
  const root = createTestArtifacts('chapter-animation');
  const log = createWriteStream(join(root, 'render.log'));
  const samples = [];
  let phase = 'starting', stopped = false;
  const child = fork(fileURLToPath(import.meta.url), ['--worker', root], {
    execPath: process.execPath, execArgv: ['--max-old-space-size=768', '--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child.stdout.on('data', (data) => { log.write(data); process.stdout.write(data); });
  child.stderr.on('data', (data) => { log.write(data); process.stderr.write(data); });
  child.on('message', (message) => { if (message.phase) phase = message.phase; });
  const sample = () => {
    const freeMemoryBytes = freemem();
    const disk = statfsSync(root);
    const freeDiskBytes = Number(disk.bavail) * Number(disk.bsize);
    samples.push({ at: new Date().toISOString(), phase, freeMemoryBytes, freeDiskBytes });
    if (!stopped && ((enforceMemoryLimit && freeMemoryBytes < minimumFreeMemory) || freeDiskBytes < minimumFreeMemory)) {
      stopped = true;
      log.write('Resource protection stopped this check. No automatic retry.\n');
      if (phase === 'bundle' || phase === 'starting') child.kill();
      else if (child.connected) child.send({ abort: true });
    }
  };
  sample();
  const timer = setInterval(sample, 1000);
  let exit;
  try {
    exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
  } finally {
    clearInterval(timer);
    await writeFile(join(root, 'resource-samples.json'), JSON.stringify({ enforceMemoryLimit, stopped, exit, samples, note: 'Available RAM samples, not process peak memory.' }, null, 2));
    // A worker cancelled while bundling never reaches its cases/report writer.
    // Preserve that outcome separately instead of leaving an apparent running test.
    await writeFile(join(root, 'run-summary.json'), JSON.stringify({
      status: stopped ? 'resource-cancelled' : exit?.code === 0 ? 'passed' : 'failed',
      phase, exit, finishedAt: new Date().toISOString(), automaticRetry: false,
      enforceMemoryLimit,
      selectedCases, fullSuite: selectedCases.length === allCases.length,
    }, null, 2));
    await new Promise(accept => log.end(accept));
    finishTestArtifacts(root, { status: !stopped && exit?.code === 0 ? 'passed' : 'failed',
      evidence: resolve('release/logs', `chapter-animation-${Date.now()}`) });
  }
  assert.ok(!stopped && exit.code === 0, `Short render check did not pass; evidence retained in ${root}`);
  console.log(`chapter animation actual render/export regression passed; evidence: ${root}`);
} else {
  const root = resolve(process.argv.at(-1));
  const controller = new AbortController();
  process.on('message', (message) => { if (message.abort) controller.abort(new Error('Resource protection cancelled short rendering')); });
  const report = { startedAt: new Date().toISOString(), configuration: { concurrency: 1, resolution: '480x270 / 270x480', duration: 'under 8 seconds per case', encoder: 'libx264', selectedCases, fullSuite: selectedCases.length === allCases.length }, cases: [] };
  const reportPath = join(root, 'results.json');
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
  try {
    const [{ default: ffmpeg }, render, { CHAPTER_TEMPLATES }, { PICTURE_ANIMATIONS }] = await Promise.all([
      import('ffmpeg-static'), import('../remotion/render.mjs'), import('../src/library/chapterTemplates.ts'), import('../src/editor/clipAnimation.ts'),
    ]);
    assert.ok(ffmpeg);
    process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1';
    process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING = '1';
    const stagedBrowser = resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe');
    if (!process.env.CC_BROWSER_EXECUTABLE && existsSync(stagedBrowser)) process.env.CC_BROWSER_EXECUTABLE = stagedBrowser;
    process.send?.({ phase: 'bundle' });
    report.bundle = await prepareChapterBundle({ output: join(root, 'serve'), reuse: process.env.CC_REMOTION_BUNDLE,
      build: render.prebuildServeBundle, signal: controller.signal });
    process.env.CC_REMOTION_BUNDLE = report.bundle.directory;
    controller.signal.throwIfAborted();
    process.send?.({ phase: 'render' });
    render.setUploadsDirProvider(() => root);
    const exec = (args, extra = {}) => runFile(ffmpeg, ['-v', 'error', ...args], { windowsHide: true, signal: controller.signal, ...extra });
    await exec(['-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=8', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-pix_fmt', 'yuv420p', join(root, 'source.mp4')]);
    const state = (items, width = 480, height = 270, transitions = []) => ({ fps: 30, width, height, fit: 'contain', items, transitions, selectedId: null, tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'] });
    // The preview checkerboard must not affect visibility audits. Keep a real
    // black underlay so these tests also stay independent of composition-level
    // background changes and cannot mistake padding for a prolonged animation.
    const onBlack = (items) => ({ ...state([{ id: 'audit-background', kind: 'solid', name: 'Black audit underlay',
      track: 'V0', startFrame: 0, durationInFrames: 30, props: { color: '#000000' } }, ...items]),
      tracks: { V0: { kind: 'video' }, V1: { kind: 'video' } }, trackOrder: ['V1', 'V0'] });
    const mse = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2; return sum / a.length; };
    async function verify(label, timeline, frames, expectedFrameCount, checks) {
      if (!selectedCases.includes(label)) return;
      const entry = { label, startedAt: new Date().toISOString(), status: 'running', checks: [] };
      report.cases.push(entry); await save();
      const output = join(root, `${label}.mp4`);
      await writeFile(join(root, `${label}-project.json`), JSON.stringify(timeline));
      const started = performance.now();
      await render.renderTimeline({ state: timeline, outputLocation: output, codec: 'h264', h264Profile: { id: 'libx264', label: 'Software', hardware: false, transport: 'server' },
        offthreadVideoCacheSizeInBytes: 256 * 1024 ** 2, mediaCacheSizeInBytes: 256 * 1024 ** 2, offthreadVideoThreads: 1,
        signal: controller.signal });
      // Decode every frame, not only the contact sheet, and compare selected
      // stills to the final movie (same app composition, separate render calls).
      const pixels = timeline.width * timeline.height * 3;
      const { stdout: hashes } = await exec(['-i', output, '-map', '0:v:0', '-an', '-f', 'framehash', '-hash', 'md5', 'pipe:1'], { encoding: 'utf8', maxBuffer: 256 * 1024 });
      const decodedCount = hashes.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length;
      assert.equal(decodedCount, expectedFrameCount, `${label}: entire file/frame count`);
      entry.checks.push('complete decode and exact frame count');
      // Stream the full audit to small hashes, then retain only comparison
      // frames. Keeping the whole raw movie alive during another browser
      // export needlessly consumed RAM on the low-memory test host.
      const capturedFrames = [...new Set(frames.flatMap((f) => [f - 1, f, f + 1]).filter((f) => f >= 0 && f < expectedFrameCount))].sort((a, b) => a - b);
      const selector = "select='" + capturedFrames.map((f) => `eq(n,${f})`).join('+') + "'";
      const { stdout } = await exec(['-i', output, '-an', '-vf', selector, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: pixels * (capturedFrames.length + 3) });
      assert.equal(stdout.length, pixels * capturedFrames.length);
      const frameAt = (f) => { const index = capturedFrames.indexOf(f); assert.ok(index >= 0, `uncaptured comparison frame ${f}`); return stdout.subarray(index * pixels, (index + 1) * pixels); };
      const stills = await chapterComparisonStills(render.renderTimelineStills, { state: timeline, frames, signal: controller.signal });
      entry.stillComparison = [];
      for (const still of stills) {
        const filename = join(root, `${label}-${still.frame}.jpg`);
        await writeFile(filename, Buffer.from(still.base64, 'base64'));
        const { stdout: rgb } = await exec(['-i', filename, '-vf', `scale=${timeline.width}:${timeline.height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: pixels * 2 });
        const error = mse(rgb, frameAt(still.frame));
        assert.ok(error < 600, `${label}: still/export frame ${still.frame} diverged (MSE ${error})`);
        entry.stillComparison.push({ frame: still.frame, mse: error });
      }
      if (checks) await checks(frameAt, entry);
      entry.status = 'passed'; entry.elapsedMs = performance.now() - started; await save();
      console.log(`${label}: full short export, decode and ${stills.length} key-frame comparisons passed`);
      return output;
    }
    for (const portrait of [false, true]) {
      const cards = CHAPTER_TEMPLATES.filter((card) => (card.height > card.width) === portrait);
      const items = cards.map((card, i) => ({ id: `card-${i}`, kind: 'motion-graphic', track: 'V1', name: card.name, startFrame: i * 45, durationInFrames: 45, width: card.width, height: card.height, templateId: card.id, code: card.code, props: card.props }));
      await verify(portrait ? 'chapters-portrait' : 'chapters-landscape', state(items, portrait ? 270 : 480, portrait ? 480 : 270), items.flatMap((item) => [item.startFrame, item.startFrame + 22, item.startFrame + 44]), 180);
    }
    const titles = ['typewriter', 'wipe', 'blur', 'spring', 'tracking'].map((kind, i) => ({ id: `title-${i}`, kind: 'text', track: 'V1', name: kind, startFrame: 6 + i * 32, durationInFrames: 32, width: 1920, height: 1080,
      props: { text: '进入下一章节\nChapter 02', fontSize: 108, color: '#f6edda', entrance: kind, exit: kind, entranceFrames: 8, exitFrames: 8, letterSpacing: 4 },
      transform: { x: 3, scale: .85, rotation: 2, crop: { left: .04 } }, mask: { type: 'rectangle', x: .03, y: .03, width: .94, height: .94 },
      keyframes: { x: [{ frame: 0, value: 3 }, { frame: 31, value: 5 }] },
    }));
    await verify('title-actions', state(titles), titles.flatMap((item) => [item.startFrame + 4, item.startFrame + 16, item.startFrame + 27]), 166);
    const shortTitles = titles.map((item, i) => ({ ...item, id: `short-${item.id}`, startFrame: i * 3, durationInFrames: 2,
      transform: undefined, mask: undefined, keyframes: undefined }));
    const shortCard = CHAPTER_TEMPLATES.find((card) => card.id === 'zuoren-chapter-index-landscape');
    assert.ok(shortCard);
    const shortTextItems = [...shortTitles, { id: 'short-card', kind: 'motion-graphic', name: shortCard.name, track: 'V1',
      startFrame: 15, durationInFrames: 2, width: shortCard.width, height: shortCard.height, code: shortCard.code, props: shortCard.props }];
    // The production timeline has a one-second minimum; clip visibility still
    // uses each item's real two-frame span, not the padded composition length.
    await verify('two-frame-titles', onBlack(shortTextItems), [...shortTextItems.flatMap((item) => [item.startFrame, item.startFrame + 1]), 29], 30,
      (frameAt, entry) => {
        for (const item of shortTextItems) {
          const first = frameAt(item.startFrame), second = frameAt(item.startFrame + 1);
          assert.ok(first.reduce((sum, channel) => sum + channel, 0) / first.length > 1, `${item.name}: two-frame text stays visible`);
          assert.ok(mse(first, second) < 20, `${item.name}: short clip holds readable placement`);
        }
        assert.ok(frameAt(29).every((channel) => channel < 5), 'timeline padding must not prolong the short titles');
        entry.checks.push('five title motions and a chapter card stay readable at two frames');
      });
    const shortPictures = [
      { id: 'overlap', kind: 'solid', name: 'overlapping long motions', track: 'V1', startFrame: 0, durationInFrames: 5,
        props: { color: '#ffffff', visualEntrance: 'fade', visualExit: 'fade', visualEntranceFrames: 30, visualExitFrames: 30 } },
      { id: 'one-frame', kind: 'solid', name: 'one-frame clip stays visible', track: 'V1', startFrame: 6, durationInFrames: 1,
        props: { color: '#ffffff', visualEntrance: 'zoom', visualExit: 'whip', visualEntranceFrames: 30, visualExitFrames: 30 } },
      { id: 'two-frame', kind: 'solid', name: 'two-frame clip stays visible', track: 'V1', startFrame: 8, durationInFrames: 2,
        props: { color: '#ffffff', visualEntrance: 'fade', visualExit: 'fade', visualEntranceFrames: 30, visualExitFrames: 30 } },
    ];
    await verify('short-overlap', onBlack(shortPictures), [0, 2, 4, 6, 8, 9, 29], 30, (frameAt, entry) => {
      const mean = (frame) => frame.reduce((sum, channel) => sum + channel, 0) / frame.length;
      assert.ok(mean(frameAt(0)) < 5 && mean(frameAt(4)) < 5, 'overlapping fades retain their endpoints');
      assert.ok(mean(frameAt(2)) > 245 && mean(frameAt(6)) > 245, 'short overlap settles, and one-frame clip remains visible');
      assert.ok(mean(frameAt(8)) > 245 && mean(frameAt(9)) > 245, 'two-frame clip must not be entirely hidden by fades');
      assert.ok(mean(frameAt(29)) < 5, 'timeline padding must not prolong the short pictures');
      entry.checks.push('actual short/overlap endpoints and one/two-frame visibility');
    });
    const pictures = PICTURE_ANIMATIONS.filter((kind) => kind.id !== 'none').map(({ id }, i) => ({ id: `picture-${i}`, kind: 'video', track: 'V1', src: '/media/uploads/source.mp4', srcInFrame: i * 32, name: id, startFrame: i * 32, durationInFrames: 32, width: 480, height: 270, volume: .6,
      props: { visualEntrance: id, visualExit: id, visualEntranceFrames: 8, visualExitFrames: 8 },
      ...(i === 5 ? { transform: { x: 4, scale: .8, rotation: 3, crop: { left: .05 } }, mask: { type: 'ellipse', x: .1, y: .1, width: .8, height: .8 }, keyframes: { maskFeather: [{ frame: 0, value: .02 }, { frame: 31, value: .04 }] }, zoom: { magnification: 1.1, focalPointX: .4, focalPointY: .4 } } : {}),
    }));
    await verify('picture-actions', state(pictures), pictures.flatMap((item) => [item.startFrame + 4, item.startFrame + 16, item.startFrame + 27]), pictures.length * 32, async (_frameAt, entry) => {
      const baseline = state(pictures.map((item) => ({ ...item, props: {} })));
      await render.renderTimeline({ state: baseline, outputLocation: join(root, 'picture-baseline.mp4'), codec: 'h264',
        h264Profile: { id: 'libx264', label: 'Software', hardware: false, transport: 'server' },
        offthreadVideoCacheSizeInBytes: 256 * 1024 ** 2, mediaCacheSizeInBytes: 256 * 1024 ** 2, offthreadVideoThreads: 1, signal: controller.signal });
      const decodeAudio = async (name) => {
        const { stdout } = await exec(['-i', join(root, name + '.mp4'), '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { encoding: 'buffer', maxBuffer: 48000 * 4 * 10 });
        return new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
      };
      const audio = await decodeAudio('picture-actions'), original = await decodeAudio('picture-baseline');
      assert.equal(audio.length, original.length, 'motion must not change audio length');
      let total = 0, max = 0;
      for (let i = 0; i < audio.length; i++) { const diff = Math.abs(audio[i] - original[i]); total += diff ** 2; max = Math.max(max, diff); }
      const rmsDifference = Math.sqrt(total / audio.length);
      assert.ok(rmsDifference < 1e-5 && max < 1e-3, 'motion must not change any audio sample');
      entry.audioComparison = { samples: audio.length, rmsDifference, maxDifference: max };
      entry.checks.push('all decoded audio samples match no-animation baseline, including initial encoder silence');
    });
    const colors = ['0xdc281e', '0x1446d2', '0x1eaa46', '0xe6b928'];
    for (let i = 0; i < colors.length; i++) await exec(['-f', 'lavfi', '-i', `color=c=${colors[i]}:s=480x270`, '-frames:v', '1', '-threads', '1', join(root, `color-${i}.png`)]);
    const media = colors.map((_, i) => ({ id: `shot-${i}`, kind: 'image', name: `shot-${i}`, track: 'V1', src: `/media/uploads/color-${i}.png`, startFrame: i * 20, durationInFrames: 20, width: 480, height: 270 }));
    const effects = ['mosaic-reveal', 'blinds-reveal', 'split-slide'];
    const transitions = effects.map((type, i) => ({ id: `transition-${i}`, type, outgoingItemId: media[i].id, incomingItemId: media[i + 1].id, trackId: 'V1', durationInFrames: 12 }));
    await verify('chapter-transitions', state(media, 480, 270, transitions), transitions.flatMap((_, i) => [14 + i * 20, 19 + i * 20, 25 + i * 20]), 80, (frameAt, entry) => {
      for (let i = 0; i < transitions.length; i++) {
        assert.ok(mse(frameAt(13 + i * 20), frameAt(14 + i * 20)) < 20, `${effects[i]} start must be outgoing`);
        assert.ok(mse(frameAt(25 + i * 20), frameAt(26 + i * 20)) < 20, `${effects[i]} end must be incoming`);
        assert.ok(mse(frameAt(19 + i * 20), frameAt(14 + i * 20)) > 500 && mse(frameAt(19 + i * 20), frameAt(25 + i * 20)) > 500, `${effects[i]} middle must differ from both endpoints`);
        entry.checks.push({ type: effects[i], ...auditChapterTransition(effects[i], frameAt(19 + i * 20), frameAt(14 + i * 20), frameAt(25 + i * 20), 480, 270) });
      }
      entry.checks.push('all three real GLSL transitions: exact boundaries and distinct middle frames');
    });
    const placedMedia = media.map((item) => ({ ...item,
      props: { visualEntrance: 'whip', visualExit: 'zoom', visualEntranceFrames: 8, visualExitFrames: 8 },
      transform: { x: 6, scaleX: .8, scaleY: .7, rotation: 3, opacity: .75, crop: { left: .12 } },
      mask: { type: 'ellipse', x: .1, y: .1, width: .8, height: .8 },
      keyframes: { x: [{ frame: 0, value: 6 }, { frame: 19, value: 12 }],
        maskFeather: [{ frame: 0, value: .01 }, { frame: 19, value: .02 }] },
      zoom: { magnification: 1.1, focalPointX: .35, focalPointY: .4, easeInFrames: 0, easeOutFrames: 0 },
    }));
    const boundaryFrames = transitions.flatMap((_, i) => [14 + i * 20, 25 + i * 20]);
    await verify('transition-placement', state(placedMedia, 480, 270, transitions), boundaryFrames, 80, async (frameAt, entry) => {
      // The endpoints must match the ordinary clip at that exact frame, not a
      // still of the same possibly-wrong GL staging implementation.
      const baseline = join(root, 'transition-placement-baseline.mp4');
      await render.renderTimeline({ state: state(placedMedia), outputLocation: baseline, codec: 'h264',
        h264Profile: { id: 'libx264', label: 'Software', hardware: false, transport: 'server' },
        offthreadVideoCacheSizeInBytes: 256 * 1024 ** 2, mediaCacheSizeInBytes: 256 * 1024 ** 2, offthreadVideoThreads: 1, signal: controller.signal });
      const selector = "select='" + boundaryFrames.map((frame) => `eq(n,${frame})`).join('+') + "'";
      const pixels = 480 * 270 * 3;
      const { stdout } = await exec(['-i', baseline, '-an', '-vf', selector, '-fps_mode', 'passthrough',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: pixels * (boundaryFrames.length + 1) });
      assert.equal(stdout.length, pixels * boundaryFrames.length);
      entry.baselineComparison = boundaryFrames.map((frame, i) => ({ frame, mse: mse(frameAt(frame), stdout.subarray(i * pixels, (i + 1) * pixels)) }));
      for (const comparison of entry.baselineComparison) assert.ok(comparison.mse < 120, `transition source lost placement/mask/opacity at ${comparison.frame} (MSE ${comparison.mse})`);
      entry.checks.push('all three transitions preserve ordinary-source placement, zoom, crop, mask keyframes and opacity at exact boundaries');
    });
    // Compose local previews without loading or downloading external assets.
    if (selectedCases.includes('chapters-landscape')) await exec(['-i', join(root, 'chapters-landscape.mp4'), '-vf', "select='eq(n,22)+eq(n,67)+eq(n,112)+eq(n,157)',tile=2x2", '-frames:v', '1', join(root, 'chapter-contact-sheet.png')]);
    assert.deepEqual(report.cases.map((entry) => entry.label).sort(), [...selectedCases].sort(), 'Every selected case must actually run');
    report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
  } catch (error) {
    const pending = report.cases.find((entry) => entry.status === 'running');
    if (pending) { pending.status = 'failed'; pending.error = error instanceof Error ? error.message : String(error); }
    report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error); await save();
    console.error(report.error); process.exitCode = 1;
  } finally { process.disconnect?.(); }
}
