import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seekSchedule, latencySummary, pulseStarts, dissolveBarcode, barcodeMatches, matchDissolveFrames } from './long-video-metrics.mjs';
import { withResourceGuard, renderFailureStopReason } from './long-video-resource-guard.mjs';
import { frameRanges, renderTimelineInSegments, joinVideoAndPcmSegments } from './long-video-segmented-export.mjs';
import { EventEmitter } from 'node:events';
import { isolatedTimelineRender, isIsolatedRenderWorker } from './long-video-isolated-render.mjs';
import { benchmarkCommand } from './long-video-command.mjs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { prepareSegmentRecovery, recoverCompletedSegment } from './long-video-segment-recovery.mjs';
import { archiveBenchmarkAttempt } from './benchmark-result-identity.mjs';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';

const verifierRoot=createTestArtifacts('benchmark-verifier',{expectedBytes:64*1024**2});
let verifierFailure;
try {

const isolatedWorker = fileURLToPath(new URL('./long-video-isolated-render.mjs', import.meta.url));
assert.equal(isIsolatedRenderWorker(['node', isolatedWorker, '--worker']), true);
assert.equal(isIsolatedRenderWorker(['node', isolatedWorker]), false);
assert.equal(isIsolatedRenderWorker(['node', fileURLToPath(new URL('./production-long-export-acceptance.mjs', import.meta.url)), '--worker']), false,
  'Imported isolated helper must not start a second render or disable production hardware encoding');

assert.equal(renderFailureStopReason('Could not take a screenshot because Google Chrome ran out of memory or disk space. Decrease the concurrency to use less RAM.'), 'renderer-resource-or-graphics');
assert.equal(renderFailureStopReason('Protocol error (Page.captureScreenshot): Unable to capture screenshot'), 'renderer-resource-or-graphics');
assert.equal(renderFailureStopReason('JavaScript heap out of memory'), 'renderer-resource-or-graphics');
assert.equal(renderFailureStopReason('GPU process crashed'), 'renderer-resource-or-graphics');
assert.equal(renderFailureStopReason('WebGL context was lost'), 'renderer-resource-or-graphics');
assert.equal(renderFailureStopReason('Benchmark resource guard stopped rendering'), 'guard-cancel-timeout');
assert.equal(renderFailureStopReason('Render worker cleanup did not finish'), 'guard-cancel-timeout');
assert.equal(renderFailureStopReason('User cancelled export'), 'guard-cancel-timeout');
assert.equal(renderFailureStopReason('NVENC encoder unavailable'), null);
assert.equal(renderFailureStopReason('Unsupported feathered SVG mask'), null);

{
  const root = await mkdtemp(join(verifierRoot, 'zuoren-recovery-test-'));
  const directory = join(root, 'server-attempt-18-simple-segments');
  await mkdir(directory);
  const state = { fps: 30, width: 1920, height: 1080, items: [] };
  const configuration = { compatibilitySegmentFrames: 300, compatibilityRenderConcurrency: 1, compatibilityRenderCache: { bounded: true }, compatibilityRenderGl: 'angle' };
  const sources = [];
  for (const folder of ['media', 'profile/media/uploads']) {
    await mkdir(join(root, folder), { recursive: true });
    for (const name of ['generated-long-gop-frame-id-12min.mp4', 'generated-music.wav']) {
      const file = join(root, folder, name);
      await writeFile(file, 'source fixture');
      const info = await stat(file);
      sources.push({ file, bytes: info.size, mtimeMs: info.mtimeMs, sha256: createHash('sha256').update('source fixture').digest('hex') });
    }
  }
  const snapshot = { benchmark: { inFlight: { name: 'simple', route: 'server', completedSegments: 1, segmentDirectory: directory },
    rendererBundleReuse: { sourceDigest: 'current' }, configuration }, timelines: { simple: state }, sources, scope: 'unit fixture' };
  const options = { snapshot, root, name: 'simple', state, sourceDigest: 'current', configuration };
  const recovery = await prepareSegmentRecovery(options);
  assert.equal(await prepareSegmentRecovery({ ...options, name: 'layered' }), null);
  await assert.rejects(prepareSegmentRecovery({ ...options, sourceDigest: 'stale' }), /digest changed/);
  await assert.rejects(prepareSegmentRecovery({ ...options, state: { ...state, width: 1280 } }), /timeline changed/);
  await assert.rejects(prepareSegmentRecovery({ ...options, configuration: { ...configuration, compatibilitySegmentFrames: 600 } }), /configuration changed/);
  await assert.rejects(prepareSegmentRecovery({ ...options, configuration: { ...configuration, compatibilityRenderGl: 'swangle' } }), /configuration changed: compatibilityRenderGl/);
  await assert.rejects(prepareSegmentRecovery({ ...options, snapshot: { ...snapshot, benchmark: { ...snapshot.benchmark,
    configuration: { ...configuration, compatibilityRenderGl: undefined } } } }), /configuration changed: compatibilityRenderGl/);
  await assert.rejects(prepareSegmentRecovery({ ...options, snapshot: { ...snapshot, sources: [] } }), /source fingerprints/);
  await assert.rejects(prepareSegmentRecovery({ ...options, snapshot: { ...snapshot, sources: sources.map(s => ({ ...s, sha256: 'bad' })) } }), /media changed/);
  await assert.rejects(prepareSegmentRecovery({ ...options, snapshot: { ...snapshot, benchmark: { ...snapshot.benchmark,
    inFlight: { ...snapshot.benchmark.inFlight, segmentDirectory: root } } } }), /immediate benchmark child/);
  const old = join(directory, 'segment-001.mp4'), audio = old.replace(/\.mp4$/, '.wav');
  await writeFile(old, 'video fixture'); await writeFile(audio, 'pcm fixture');
  const fresh = join(root, 'fresh'); await mkdir(fresh);
  const output = join(fresh, 'segment-001.mp4');
  const metadata = async file => file.endsWith('.wav')
    ? { streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2, duration: '10' }] }
    : { streams: [{ codec_type: 'video', duration: '10', nb_frames: '300', width: 1920, height: 1080, avg_frame_rate: '30/1' }] };
  const decoded = [], evidence = [];
  const inputs = { recovery, index: 0, range: [0,299], output, fps: 30, width: 1920, height: 1080,
    probe: metadata, command: async (_exe, args) => decoded.push(args), ffmpegPath: 'fixture-ffmpeg',
    onEvidence: async sample => evidence.push(sample) };
  assert.equal(await recoverCompletedSegment({ ...inputs, index: 1 }), false, 'Uncommitted segment must render again');
  await assert.rejects(recoverCompletedSegment({ ...inputs, range: [300,599] }), /frame range changed/);
  await assert.rejects(recoverCompletedSegment({ ...inputs, width: 1280 }), /1280/);
  await assert.rejects(recoverCompletedSegment({ ...inputs, command: async () => { throw new Error('corrupt video'); } }), /corrupt video/);
  assert.equal(evidence.length, 0, 'Decode failure is not a completed recovery');
  const abort = new AbortController(); abort.abort(new Error('recovery cancelled'));
  await assert.rejects(recoverCompletedSegment({ ...inputs, signal: abort.signal }), /recovery cancelled/);
  decoded.length = 0;
  assert.equal(await recoverCompletedSegment(inputs), true);
  assert.equal(decoded.length, 2, 'Decode picture and PCM in full');
  assert.equal(evidence.length, 1);
  assert.equal(await readFile(output, 'utf8'), 'video fixture');
  assert.equal(await readFile(output.replace(/\.mp4$/, '.wav'), 'utf8'), 'pcm fixture');
  assert.equal(await readFile(old, 'utf8'), 'video fixture', 'Old evidence is unchanged');
  await assert.rejects(recoverCompletedSegment(inputs), /EEXIST/, 'Never overwrite existing output');
  const rendered = [], completed = [];
  await renderTimelineInSegments({ durationFrames: 600, segmentFrames: 300, temporaryDirectory: join(root, 'order-test'), outputPath: join(root, 'joined.mp4'),
    recoverSegment: async ({ index }) => index === 0,
    renderSegment: async ({ index }) => rendered.push(index),
    onSegment: async sample => completed.push(sample.recovered), joinSegments: async () => {} });
  assert.deepEqual(rendered, [1]); assert.deepEqual(completed, [true,false]);
}

{
  const worker = () => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), connected: true,
    messages: [], send(message) { this.messages.push(message); }, kill() {},
  });
  const child = worker(); let finished = false;
  const pending = isolatedTimelineRender({ fixture: true }, { forkImpl: (_file, args, options) => {
    assert.deepEqual(args, ['--worker']); assert.equal(options.execPath, process.execPath);
    assert.deepEqual(options.execArgv,['--max-old-space-size=256'],'plain-JS render worker needs no compiler loader');return child;
  } }).then((result) => { finished = true; return result; });
  child.emit('message', { result: { outputLocation: 'test.mp4' } });
  await Promise.resolve();
  assert.equal(finished, false, 'native cleanup must finish via child exit before next segment');
  child.emit('exit', 0, null);
  assert.deepEqual(await pending, { outputLocation: 'test.mp4' });
  const cancelled = new AbortController(); cancelled.abort(new Error('before spawn'));
  await assert.rejects(isolatedTimelineRender({}, { signal: cancelled.signal,
    forkImpl: () => { throw new Error('must not spawn'); } }), /before spawn/);
  const failedChild = worker();
  const failure = isolatedTimelineRender({}, { forkImpl: () => failedChild });
  failedChild.emit('message', { error: 'original render failure' });
  failedChild.emit('exit', 1, null);
  await assert.rejects(failure, /original render failure/);
  const abortedChild = worker(), controller = new AbortController();
  const aborted = isolatedTimelineRender({}, { signal: controller.signal, forkImpl: () => abortedChild });
  controller.abort(new Error('user cancellation'));
  assert.equal(abortedChild.messages.at(-1).abort, true);
  abortedChild.emit('exit', 1, null);
  await assert.rejects(aborted, /user cancellation/);
  const ipcChild = worker(); ipcChild.send = () => { throw new Error('channel closed'); };
  const ipcFailure = isolatedTimelineRender({}, { forkImpl: () => ipcChild, cleanupTimeoutMs: 5,
    terminateImpl: async (owned) => { assert.equal(owned, ipcChild); owned.emit('exit', 1, null); } });
  await assert.rejects(ipcFailure, /Worker IPC failed.*channel closed/s);
  const hung = worker();
  const cleanup = isolatedTimelineRender({}, { forkImpl: () => hung, cleanupTimeoutMs: 5,
    terminateImpl: async (owned) => { assert.equal(owned, hung); owned.emit('exit', 1, null); } });
  hung.emit('message', { result: { outputLocation: 'incomplete.mp4' } });
  await assert.rejects(cleanup, /worker cleanup/);
}

{
  const controller = new AbortController(); let kills = 0, settled = false;
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { kills++; } });
  const work = benchmarkCommand('owned-ffmpeg', [], { signal: controller.signal, spawnImpl: () => child })
    .catch((error) => { settled = true; throw error; });
  controller.abort(new Error('guard cancellation'));
  assert.equal(kills, 1);
  await Promise.resolve(); assert.equal(settled, false, 'abort must await subprocess close before serial work continues');
  child.emit('close', null);
  await assert.rejects(work, /guard cancellation/);
  await assert.rejects(async () => benchmarkCommand('never-spawn', [], { signal: controller.signal,
    spawnImpl: () => { throw new Error('must not spawn'); } }), /guard cancellation/);
}

const frames = seekSchedule(21600, 30);
assert.deepEqual(frames, seekSchedule(21600, 30));
assert(frames.every((frame) => frame > 0 && frame < 21600));
assert(frames.includes(299) && frames.includes(300) && frames.includes(301));
assert.equal(latencySummary([]).p95Ms, null);
assert.equal(latencySummary([{ status: 'timeout', elapsedMs: 15000 }]).failed, 1);
assert.equal(latencySummary([{ status: 'presented', elapsedMs: 40 }, { status: 'presented', elapsedMs: 10 }]).medianMs, 10);
assert.deepEqual(pulseStarts([0, 1, 1, 0, 0, 1], 0.5, 5), [0.2, 1]);
assert(barcodeMatches(dissolveBarcode(299, 4102, 0), dissolveBarcode(299, 4102, 0)));
assert.equal(dissolveBarcode(0, 65535, 0.5)[0], 0.5);
assert(!barcodeMatches(dissolveBarcode(0, 65535, 0.5), dissolveBarcode(0, 65535, 0.7)));
assert.deepEqual(matchDissolveFrames(dissolveBarcode(298, 4108, 0.4), 299, 4109, 0.4),
  { outgoingDelta: -1, incomingDelta: -1, exact: false });
assert.equal(matchDissolveFrames(dissolveBarcode(15000, 25000, 0.4), 299, 4109, 0.4), null);
const source = await readFile(new URL('./generated-edit-benchmark.mts', import.meta.url), 'utf8');
assert.match(source, /const exportSeconds = seconds/);
assert.doesNotMatch(source, /stream_loop/);
assert.match(source, /FRAME %\{n\}/);
const browser = await readFile(new URL('./long-video-presentation.ts', import.meta.url), 'utf8');
assert.match(browser, /requestVideoFrameCallback/);
assert.match(browser, /mediaTime/);
assert.match(browser, /renderTimelineInBrowser/);
const runner = await readFile(new URL('./long-video-runner.mts', import.meta.url), 'utf8');
assert.match(runner, /compatibilityRenderConcurrency: renderConcurrency/);
assert.match(runner, /\[1, 2, 3, 4\]\.includes\(renderConcurrency\)/);
assert.match(runner, /OPENCHATCUT_RENDER_CONCURRENCY = String\(renderConcurrency\)/);
assert.match(runner, /offthreadVideoCacheSizeInBytes: 64 \* 1024 \*\* 2/);
assert.match(runner, /mediaCacheSizeInBytes: 256 \* 1024 \*\* 2/);
assert.match(runner, /offthreadVideoThreads: 1/);
assert.match(runner, /if \(!serverOnly\) \{\s*const \{ createServer \}/,
  'server-only continuation does not create another Vite/browser/editor project');
const oldAttempt = { exports: [{ name: 'layered', route: 'webcodecs', status: 'unsupported' }],
  previews: [{ name: 'simple', status: 'failed' }], failures: [{ stage: 'preview', reason: 'old failure' }],
  inFlight: { route: 'server' } };
const archived = archiveBenchmarkAttempt(oldAttempt).at(-1);
assert.deepEqual(archived.exports, oldAttempt.exports, 'unsupported and failed browser-route evidence is retained in history');
assert.equal(archived.interruption.status, 'interrupted');
assert.match(runner, /host-resource-guard/);
assert.match(runner, /server-attempt-.*?\.mp4/,
  'resumed server exports write fresh output instead of overwriting an interrupted render');
assert.match(runner, /inFlight = \{ stage: 'complete-export', name, route: 'server', output,/);
assert.match(runner, /compatibilitySegmentFrames: segmentFrames/);
assert.match(runner, /guarded\(\(signal\) => isolatedTimelineRender/,
  'serial segment benchmark waits for an isolated worker exit, not only render completion');
assert.match(runner, /joinSegments: \(parts\) => guarded\(\(signal\) => joinVideoAndPcmSegments/);
assert.match(runner, /separateAudioTo: segmentOutput\.replace/);
assert.match(runner, /prepareChapterBundle\(\{ reuse: process\.env\.CC_REMOTION_BUNDLE, existingOnly: true/,
  'resumed exports use source-checked bundles and never silently reuse an old bundle.js');
assert.doesNotMatch(runner, /prebuildServeBundle\(/, 'long render does not start an unguarded webpack build');
const renderSource = await readFile(new URL('../remotion/render.mjs', import.meta.url), 'utf8');
assert.match(renderSource, /vaapiDevice,\s*signal,\s*offthreadVideoCacheSizeInBytes,\s*mediaCacheSizeInBytes,\s*offthreadVideoThreads/);
assert.match(renderSource, /vaapiDevice,\s*offthreadVideoCacheSizeInBytes,\s*mediaCacheSizeInBytes/,
  'bounded cache values reach the real renderer, not only the benchmark report');
assert.match(renderSource, /offthreadVideoThreads: configuredOffthreadVideoThreads \?\? memorySettings\.offthreadVideoThreads/,
  'short-run render can bound decoder workers without changing normal exports');
{
  assert.deepEqual(frameRanges(720, 300), [[0, 299], [300, 599], [600, 719]]);
  assert.deepEqual(frameRanges(21600, 300), Array.from({ length: 72 }, (_, i) => [i * 300, (i + 1) * 300 - 1]));
  assert.throws(() => frameRanges(0, 300), /positive safe integers/);
  const segmentDir = await mkdtemp(join(verifierRoot, 'zuoren-segment-test-'));
  const rangesSeen = [], joins = [];
  const joined = await renderTimelineInSegments({ durationFrames: 720, segmentFrames: 300,
    temporaryDirectory: join(segmentDir, 'attempt-1'), outputPath: join(segmentDir, 'complete.mp4'),
    renderSegment: async ({ range, output }) => rangesSeen.push({ range, output }),
    joinSegments: async (args) => joins.push(args),
  });
  assert.deepEqual(rangesSeen.map(({ range }) => range), [[0, 299], [300, 599], [600, 719]]);
  assert.equal(joins.length, 1);
  assert.deepEqual(joins[0].ranges, [[0, 299], [300, 599], [600, 719]]);
  assert.equal(joined.segments.length, 3);
  assert.match(await readFile(joined.playlist, 'utf8'), /ffconcat version 1\.0/);
  assert.equal((await readFile(joined.playlist, 'utf8')).match(/^file /gm).length, 3);
  await assert.rejects(renderTimelineInSegments({ durationFrames: 300, segmentFrames: 300,
    temporaryDirectory: join(segmentDir, 'failed-attempt'), outputPath: join(segmentDir, 'should-not-exist.mp4'),
    renderSegment: async () => { throw new Error('synthetic segment failure'); },
    joinSegments: async () => { throw new Error('join must not run after a failed segment'); },
  }), /synthetic segment failure/);
}
{
  const directory = await mkdtemp(join(verifierRoot, 'zuoren-pcm-join-test-'));
  const options = { playlist: join(directory, 'video.ffconcat'), segments: [join(directory, 'part.mp4')], ranges: [[0,299]],
    outputPath: join(directory, 'complete.mp4'), fps: 30, ffmpegPath: 'test-ffmpeg' };
  const metadata = (duration) => ({ streams: [{codec_type:'audio',codec_name:'pcm_s16le',sample_rate:'48000',channels:2,duration:String(duration)}],format:{duration:String(duration)} });
  const videoMetadata = { streams: [{codec_type:'video',duration:'10',nb_frames:'300'}] };
  const metadataProbe = (duration) => async (file) => file.endsWith('.wav') ? metadata(duration) : videoMetadata;
  let calls = 0;
  await assert.rejects(joinVideoAndPcmSegments({ ...options, probe: metadataProbe(10.048),
    command: async () => { calls++; } }), /exactly its frame duration/);
  assert.equal(calls, 0, 'reject padded audio instead of silently concatenating drift');
  await joinVideoAndPcmSegments({ ...options, probe: metadataProbe(10), command: async (_file, args) => {
    calls++; assert.equal(args[args.indexOf('-c:v') + 1], 'copy'); assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.ok(!args.includes('-shortest'), 'do not hide a duration defect by truncating');
  } });
  assert.equal(calls, 1, 'one audio encode at final join');
  await assert.rejects(joinVideoAndPcmSegments({ ...options, probe: metadataProbe(NaN), command: async () => { calls++; } }), /exactly its frame duration/);
  await assert.rejects(joinVideoAndPcmSegments({ ...options, probe: async () => ({ streams: [...videoMetadata.streams, ...metadata(10).streams] }),
    command: async () => { calls++; } }), /video-only/);
  assert.equal(calls, 1, 'bad or muxed audio cannot be hidden by successful encoding');
  const stop = new AbortController();
  await assert.rejects(joinVideoAndPcmSegments({ ...options, signal: stop.signal,
    probe: async (_file, signal) => { assert.equal(signal, stop.signal); stop.abort(new Error('join stopped')); return metadata(10); },
    command: async () => { throw new Error('must not encode after cancellation'); } }), /join stopped/);
}
{
  const healthy = { freeMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 8 * 1024 ** 3 };
  let runs = 0;
  assert.equal(await withResourceGuard({ sample: async () => healthy, run: async () => ++runs }), 1);
  for (const key of ['freeMemoryBytes', 'freeDiskBytes']) {
    await assert.rejects(withResourceGuard({ sample: async () => ({ ...healthy, [key]: 1 }),
      run: async () => ++runs }), /resource guard stopped/);
  }
  assert.equal(runs, 1, 'low-resource preflight never starts a render');
  await assert.rejects(withResourceGuard({ sample: async () => ({ ...healthy, freeMemoryBytes: NaN }),
    run: async () => ++runs }), /Invalid freeMemoryBytes sample/);
  await assert.rejects(withResourceGuard({ sample: async () => { throw new Error('disk unavailable'); },
    run: async () => ++runs }), /disk unavailable/);
  let polls = 0, aborted = 0;
  await assert.rejects(withResourceGuard({ intervalMs: 5,
    sample: async () => ++polls === 1 ? healthy : { ...healthy, freeMemoryBytes: 1 },
    run: (signal) => new Promise((done, fail) => signal.addEventListener('abort', () => {
      aborted++; fail(signal.reason);
    }, { once: true })),
  }), /resource guard stopped/);
  assert.equal(aborted, 1, 'low RAM aborts the active render exactly once');
  const stoppedPolls = polls;
  await new Promise((done) => setTimeout(done, 15));
  assert.equal(polls, stoppedPolls, 'no resource polling survives a completed attempt');
  const cancellation = new AbortController(); cancellation.abort(new Error('user cancelled'));
  await assert.rejects(withResourceGuard({ signal: cancellation.signal,
    sample: async () => healthy, run: async () => ++runs }), /user cancelled/);
  assert.equal(runs, 1, 'already cancelled work never starts');
  const samples = [];
  assert.equal(await withResourceGuard({ enforceMemoryLimit: false,
    sample: async () => ({ ...healthy, freeMemoryBytes: 1 }),
    onSample: measured => samples.push(measured), run: async () => 'continued' }), 'continued');
  assert.equal(samples[0].freeMemoryBytes, 1, 'explicit opt-out still records available RAM');
  let optOutPolls = 0;
  await withResourceGuard({ enforceMemoryLimit: false, intervalMs: 5,
    sample: async () => { optOutPolls++; return { ...healthy, freeMemoryBytes: 1 }; },
    run: async signal => { await new Promise(done => setTimeout(done, 25)); signal.throwIfAborted(); } });
  assert.ok(optOutPolls > 1, 'low RAM during work does not cancel an opted-out attempt');
  await assert.rejects(withResourceGuard({ enforceMemoryLimit: false,
    sample: async () => ({ freeMemoryBytes: 1, freeDiskBytes: 1 }),
    run: async () => { throw new Error('must not run on low disk'); } }), /resource guard stopped/);
  await assert.rejects(withResourceGuard({ enforceMemoryLimit: 'false',
    sample: async () => healthy, run: async () => 1 }), /Invalid memory protection/);
}
assert.equal((runner.match(/await maximizeTimelineZoom\(\)/g) ?? []).length, 2,
  'selected-cut probes initialize frame-level zoom even when resumed preview cases are reused');
assert.match(runner, /server: \{[^\n]*open: false/,
  'isolated tests must override the development server automatic browser opening');
assert(runner.indexOf('server.config.server.open !== false') < runner.indexOf('await server.listen()'),
  'effective config is checked before Vite can open an everyday-browser tab');
assert.match(runner, /attemptElapsedMs: performance\.now\(\) - attemptStarted/);
assert.deepEqual(archived.previews, oldAttempt.previews, 'all preview results including failed samples retained');
assert.match(source, /report\.attemptHistory = archiveBenchmarkAttempt\(previousReport\)/,
  'resume retains failed and interrupted evidence before selecting active results');
assert.deepEqual(archived.failures, oldAttempt.failures, 'failed evidence is retained without pretending it is a current run');
assert.match(source, /stage: 'script-fatal-or-preparation'/);
// A corrupt cached fixture must emit structured failure and keep prior evidence,
// not silently start a new 12-minute encode or erase the previous attempts.
const negativeFixture = await mkdtemp(join(verifierRoot, 'zuoren-benchmark-negative-'));
await mkdir(join(negativeFixture, 'media'));
await writeFile(join(negativeFixture, 'media', 'generated-long-gop-frame-id-12min.mp4'), 'invalid test fixture');
await writeFile(join(negativeFixture, 'media', 'generated-music.wav'), 'invalid test fixture');
await writeFile(join(negativeFixture, 'results.json'), JSON.stringify({
  evidence: 'negative fixture only, not measured media', exports: [{ name: 'retained-negative-fixture-evidence' }], failures: [],
}));
let failed = false;
try {
  execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./generated-edit-benchmark.mts', import.meta.url)),
    '--prepare-only', `--output=${negativeFixture}`], { timeout: 15000, stdio: 'pipe', windowsHide: true,
      env: { ...process.env, CC_TEST_ARTIFACT_ROOT: join(negativeFixture, 'managed'), CC_TEST_MIN_FREE_BYTES: '0' } });
} catch (error) {
  assert.equal(error.status, 1, 'corrupt fixture must exit with failure');
  failed = true;
}
assert(failed, 'corrupt fixture cannot pass preparation');
const negativeReport = JSON.parse(await readFile(join(negativeFixture, 'results.json'), 'utf8'));
assert.equal(negativeReport.status, 'failed');
assert.equal(negativeReport.failures.at(-1).stage, 'script-fatal-or-preparation');
assert.match(negativeReport.failures.at(-1).reason, /ffprobe/i);
assert.equal(negativeReport.exports[0].name, 'retained-negative-fixture-evidence');
const protectedRoot=join(negativeFixture,'user-media');
const protectedOutput=join(negativeFixture,'user-output');
await mkdir(protectedRoot);await mkdir(protectedOutput);
await writeFile(join(protectedRoot,'original.mp4'),'original media');
await writeFile(join(protectedOutput,'results.json'),'user file');
assert.throws(()=>execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./generated-edit-benchmark.mts',import.meta.url)),
  '--prepare-only',`--output=${protectedOutput}`],{timeout:15000,stdio:'pipe',windowsHide:true,
  env:{...process.env,CC_TEST_ARTIFACT_ROOT:protectedRoot,CC_TEST_MIN_FREE_BYTES:'0'}}));
assert.equal(await readFile(join(protectedRoot,'original.mp4'),'utf8'),'original media');
assert.equal(await readFile(join(protectedOutput,'results.json'),'utf8'),'user file');
// Keep the actual Windows IPC-listener/ownership regression reachable from
// verify:long-video-stability, not only from a one-off acceptance pipeline.
await import('./production-long-export-acceptance.verify.mjs');
console.log('generated-edit-benchmark.verify: seeks, metrics, full export contract and structured preparation failure passed');
} catch(error) {
  verifierFailure=error;throw error;
} finally {
  try {finishTestArtifacts(verifierRoot,{status:verifierFailure?'failed':'passed',
    evidence:resolve('release/logs',basename(verifierRoot))});}
  catch(cleanupError){if(verifierFailure)throw new AggregateError([verifierFailure,cleanupError],'Verifier and cleanup failed');throw cleanupError;}
}
