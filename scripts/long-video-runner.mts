import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, stat, statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { openBrowser, RenderInternals } from '@remotion/renderer';
import type { TimelineState } from '../src/editor/types';
import { seekSchedule, latencySummary } from './long-video-metrics.mjs';
import { auditExport, auditSharedVisual } from './long-video-audit.mts';
import { withResourceGuard, renderFailureStopReason } from './long-video-resource-guard.mjs';
import { renderTimelineInSegments, joinVideoAndPcmSegments } from './long-video-segmented-export.mjs';
import { isolatedTimelineRender } from './long-video-isolated-render.mjs';
import { prepareChapterBundle, chapterSourceDigest } from './chapter-render-bundle.mjs';
import { prepareSegmentRecovery, recoverCompletedSegment } from './long-video-segment-recovery.mjs';
import { resolveRenderGlBackend } from '../remotion/render-browser.mjs';
import { auditBenchmarkArtifact, benchmarkSourceDigest, createBenchmarkIdentity, fileContentIdentity,
  restoreBenchmarkResults, reusableBenchmarkResult, sameBenchmarkIdentity, syncBenchmarkMedia } from './benchmark-result-identity.mjs';

interface BenchmarkInput {
  root: string; media: string; states: Record<string, TimelineState>; report: Record<string, unknown>;
  previousReport?: Record<string, unknown>;
  ffmpegPath: string; ffprobePath: string;
  command: (file: string, args: string[], signal?: AbortSignal) => Promise<string>;
  probe: Parameters<typeof auditExport>[1]; persist: () => Promise<void>;
}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
async function processMemory(command: BenchmarkInput['command']) {
  if (process.platform !== 'win32') return { status: 'unmeasured', reason: 'Windows process-tree sampler only' };
  try {
    const script = `$all = Get-CimInstance Win32_Process; $ids = @(${process.pid}); $cursor = 0; `
      + 'while ($cursor -lt $ids.Count) { $parent = $ids[$cursor++]; $ids += @($all | Where-Object ParentProcessId -eq $parent | ForEach-Object ProcessId) }; '
      + '@(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress';
    return { status: 'sampled', processes: JSON.parse(await command('powershell.exe', ['-NoProfile', '-Command', script])),
      scope: 'isolated Vite/Node/Chromium full-editor child tree after playback; sampled, not peak; working sets may share pages; excludes GPU VRAM and Electron shell' };
  } catch (error) { return { status: 'unmeasured', reason: reason(error) }; }
}
async function proxyCacheFiles(directory: string): Promise<Array<{ file: string; bytes: number }>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return proxyCacheFiles(file);
    return /proxy.*\.mp4$/.test(entry.name) ? [{ file, bytes: (await stat(file)).size }] : [];
  }));
  return nested.flat();
}
export async function runLongVideoBenchmark({ root, media, states, report, previousReport, ffmpegPath, ffprobePath, command, probe, persist }: BenchmarkInput) {
  const timeoutMs = 60 * 60 * 1000;
  const concurrencyArg = process.argv.find((arg) => arg.startsWith('--render-concurrency='));
  const renderConcurrency = Number(concurrencyArg?.slice('--render-concurrency='.length) ?? 2);
  if (![1, 2, 3, 4].includes(renderConcurrency)) throw new Error('Benchmark render concurrency must be 1, 2, 3 or 4');
  const serverOnly = process.argv.includes('--server-only');
  const enforceMemoryLimit = process.env.CC_BENCHMARK_IGNORE_MEMORY_LIMIT !== '1';
  if (serverOnly && (!process.argv.includes('--resume') || !process.argv.includes('--exports-only'))) {
    throw new Error('--server-only requires --resume --exports-only');
  }
  const recoveryFile = process.env.CC_BENCHMARK_RECOVERY_SNAPSHOT;
  if (recoveryFile && !serverOnly) throw new Error('Segment recovery requires explicit server-only resume');
  const recoverySnapshot = recoveryFile ? JSON.parse(await readFile(recoveryFile, 'utf8')) : null;
  // Remotion requires at least 240 MiB for the browser media cache.
  const cacheOptions = { offthreadVideoCacheSizeInBytes: 64 * 1024 ** 2,
    mediaCacheSizeInBytes: 256 * 1024 ** 2, offthreadVideoThreads: 1 };
  const segmentFrames = 10 * 30;
  report.configuration = { timeoutMs, seeksPerCase: seekSchedule(21600, 30).length, playbackSeconds: 30,
    timelineZoom: 'maximum (6), changed through native range keyboard End; subpixel fit-view clicks cannot request individual frames',
    compatibilityRenderConcurrency: renderConcurrency,
    compatibilityRenderCache: cacheOptions,
    compatibilityRenderGl: resolveRenderGlBackend(),
    compatibilitySegmentFrames: segmentFrames,
    compatibilityWorkerMode: 'one fresh Node worker per segment; await native cleanup and process exit before the next',
    resourceGuard: { enforceMemoryLimit, memoryOptOut: !enforceMemoryLimit ? 'explicit test-host override; sampling and disk protection retained' : null,
      minimumFreeMemoryBytes: 2.5 * 1024 ** 3, minimumFreeDiskBytes: 2 * 1024 ** 3, intervalMs: 1000 },
    presentationToleranceFrames: 1, exactFrameMatchReportedSeparately: true,
    previewHost: 'complete App/editor routing, persistence, timeline, inspector and Player in isolated Chromium; not installed Electron shell',
    browserGl: 'angle', serverCodec: 'h264', serverHardwareEncoding: false, webCodecsSettings: 'production benchmark host defaults',
    runtime: report.machine, environment: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(CC_|OPENCHATCUT_|REMOTION_|VITE_)/.test(key) && !['CC_REMOTION_BUNDLE', 'CC_BROWSER_EXECUTABLE',
        'CC_BENCHMARK_RECOVERY_SNAPSHOT', 'OPENCHATCUT_DATA_DIR', 'OPENCHATCUT_DEV_PROFILE_ID',
        'OPENCHATCUT_RENDER_CONCURRENCY', 'VITE_CONFIG_NATIVE_IGNORE_WARNING'].includes(key))) };
  process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
  process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';
  process.env.OPENCHATCUT_DATA_DIR = join(root, 'profile');
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = String(renderConcurrency);
  const browserCandidates = [process.env.CC_BROWSER_EXECUTABLE,
    resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe'),
    resolve('node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe')];
  const executable = browserCandidates.find((file): file is string => !!file && existsSync(file));
  if (!executable) throw new Error('Benchmark requires an existing Chromium runtime; no implicit download');
  process.env.CC_BROWSER_EXECUTABLE = executable;
  const profileMedia = join(root, 'profile', 'media', 'uploads');
  await mkdir(profileMedia, { recursive: true });
  const materials = [];
  for (const name of ['generated-long-gop-frame-id-12min.mp4', 'generated-music.wav']) {
    const target = join(profileMedia, name), source = join(media, name);
    await syncBenchmarkMedia(source, target);
    materials.push({ name: `original/${name}`, file: source }, { name: `render-input/${name}`, file: target });
  }
  console.log('[benchmark] hashing actual inputs and effective runtime before result reuse');
  const runtimes = [{ name: 'browser', file: executable }, { name: 'ffmpeg', file: ffmpegPath },
    { name: 'ffprobe', file: ffprobePath }, { name: 'node', file: process.execPath }];
  const nativeFfmpeg = RenderInternals.getExecutablePath({ type: 'ffmpeg', indent: false, logLevel: 'error',
    binariesDirectory: process.env.CC_REMOTION_BINARIES_DIR || null });
  for (const [name, directory] of [['native', dirname(nativeFfmpeg)], ['browser-sidecars', dirname(executable)]]) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isFile() && /\.(exe|dll|so|dylib|pak)$/.test(entry.name)) runtimes.push({ name: `${name}/${entry.name}`, file: join(directory, entry.name) });
    }
  }
  const resultIdentity = await createBenchmarkIdentity({ states, materials, configuration: report.configuration,
    sourceDigest: await benchmarkSourceDigest(), runtimes });
  await restoreBenchmarkResults(report, previousReport, resultIdentity, { retainPreviewFailures: process.argv.includes('--exports-only') });
  const previews = report.previews as unknown[], exports = report.exports as unknown[], failures = report.failures as unknown[];
  const canReuse = async (kind: string, name: string, route?: string, mode?: string) => {
    for (const entry of kind === 'preview' ? previews : exports) if (await reusableBenchmarkResult(entry,
      resultIdentity, { kind, name, route, mode })) return true;
    return false;
  };
  const checkInputs = async () => {
    const current = await createBenchmarkIdentity({ states, materials, configuration: report.configuration,
      sourceDigest: await benchmarkSourceDigest() });
    if (['source', 'project', 'materials'].some((key) => current[key] !== resultIdentity[key])) {
      throw new Error('Benchmark source/project/media changed during this attempt; result cannot be accepted');
    }
  };
  await persist();
  let nativeRenderer: Promise<typeof import('../remotion/render.mjs')> | undefined;
  let renderSourceDigest: string | undefined;
  const loadNativeRenderer = () => nativeRenderer ??= (async () => {
    const renderer = await import('../remotion/render.mjs');
    const prepared = await prepareChapterBundle({ reuse: process.env.CC_REMOTION_BUNDLE, existingOnly: true,
      signal: AbortSignal.timeout(120000) });
    process.env.CC_REMOTION_BUNDLE = prepared.directory;
    renderSourceDigest = prepared.sourceDigest;
    report.rendererBundleReuse = { ...prepared,
      reason: 'source-checked prebuilt bundle only; a missing/stale bundle requires a separate protected build, never implicit webpack' };
    renderer.setUploadsDirProvider(() => profileMedia);
    return renderer;
  })();
  if (!serverOnly) {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: resolve('config/vite.config.ts'),
    // Multiple isolated dev/test servers must not replace each other's
    // optimized dependencies while the full editor lazily loads captions.
    cacheDir: join(root, 'vite-cache'),
    // The development config defaults to open: '/'. Tests own a headless
    // browser; never open another tab in the user's everyday browser.
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false, watch: null, warmup: { clientFiles: [] } },
    plugins: [{ name: 'isolated-benchmark-output', configureServer(vite) {
      vite.middlewares.use('/__benchmark/output/', (req, res) => {
        const name = req.url?.replace(/^\//, '');
        if (req.method !== 'POST' || !name || !/^(simple|layered)-webcodecs\.mp4$/.test(name)
          || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
          || req.headers.origin !== `http://${req.headers.host}`) {
          res.statusCode = 403; res.end(); return;
        }
        void pipeline(req, createWriteStream(join(root, name))).then(() => res.end('ok')).catch((error) => {
          res.statusCode = 500; res.end(reason(error));
        });
      });
    } }],
  });
  if (server.config.server.open !== false) {
    await server.close();
    throw new Error('Benchmark must not automatically open the user browser');
  }
  report.browserLaunch = { automaticUserBrowserOpening: server.config.server.open,
    scope: 'effective merged Vite config checked before listen; controlled headless runtime only' };
  await persist();
  await server.listen();
  const origin = server.resolvedUrls!.local[0];
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    browser = await openBrowser('chrome', { browserExecutable: executable,
      chromiumOptions: { gl: 'angle' }, logLevel: 'error' });
    const page = await browser.newPage({ context: () => null,
      logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: (entry) => {
        if (entry.text.startsWith('[benchmark-export]')) console.log(entry.text);
        if (entry.type === 'error') console.log(`[benchmark browser] ${entry.text.slice(0, 600)}`);
      }, onLog: () => {} });
    const previewUrl = `${origin}scripts/long-video-app.html?long-video-benchmark=1`;
    page._client().on('Page.javascriptDialogOpening', (event: { type: string }) => {
      // The benchmark owns this isolated project. Record and accept its
      // navigation prompt rather than hanging the headless browser forever.
      if (event.type !== 'beforeunload') return;
      const prompts = (report.navigationPrompts ??= []) as unknown[];
      prompts.push({ type: event.type, at: new Date().toISOString() });
      void page._client().send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined);
    });
    const navigateEditor = async () => {
      const client = page._client();
      let ready!: () => void;
      let timer: ReturnType<typeof setTimeout>;
      const domReady = new Promise<void>((done, fail) => {
        ready = done;
        timer = setTimeout(() => fail(new Error('editor DOM navigation timeout')), 120000);
        client.once('Page.domContentEventFired', ready);
      });
      try {
        const [result] = await Promise.all([client.send('Page.navigate', { url: previewUrl }), domReady]);
        if (result.value.errorText) throw new Error(result.value.errorText);
      } finally {
        clearTimeout(timer!);
        client.off('Page.domContentEventFired', ready);
      }
    };
    // Readiness is the editor probe, not completion of optional font/network
    // requests. Keep a real navigation and bounded DOM initialization wait.
    await navigateEditor();
    const deadline = Date.now() + 120000;
    while (!await page.evaluate(() => Boolean(window.longVideoBench))) {
      if (Date.now() > deadline) throw new Error('benchmark browser host failed to initialize');
      await new Promise((done) => setTimeout(done, 100));
    }
    report.browser = await page.evaluate(() => ({ userAgent: navigator.userAgent,
      videoFrameCallbacks: 'requestVideoFrameCallback' in HTMLVideoElement.prototype }));
    const pointerSeek = async (frame: number, dragging: boolean) => {
      const point = await page.evaluate((target) => window.longVideoBench.pointerAt!(target), frame);
      await page.evaluate((target) => {
        window.longVideoBench.pendingSeek = window.longVideoBench.seek(target, true);
      }, frame);
      if (!dragging) await page._client().send('Input.dispatchMouseEvent', {
        type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point,
      });
      else await page._client().send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', button: 'left', buttons: 1, ...point,
      });
      const result = await page.evaluate(() => window.longVideoBench.pendingSeek!);
      if (!dragging) await page._client().send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point,
      });
      return { ...(result as Record<string, unknown>), input: dragging ? 'trusted-timeline-drag' : 'trusted-timeline-click' };
    };
    const maximizeTimelineZoom = async () => {
      await page.evaluate(() => {
        const slider = document.querySelector<HTMLInputElement>('.cc-timeline input[type="range"]');
        if (!slider) throw new Error('Timeline zoom slider missing');
        slider.focus();
      });
      await page._client().send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
      await page._client().send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    };
    if (!process.argv.includes('--exports-only')) {
      for (const [name, state] of Object.entries(states)) for (const mode of ['original', 'proxy'] as const) {
        if (await canReuse('preview', name, undefined, mode)) continue;
        console.log(`[benchmark] preview ${name}/${mode}`);
        const started = performance.now();
        try {
          await page.evaluate((next, sourceMode) => window.longVideoBench.load(next, sourceMode), state, mode);
          // Measure one real explicit rebuild, not only a cached readiness lookup.
          const rebuilding = mode === 'proxy' && !report.proxyGeneration;
          if (rebuilding) await page.evaluate((src) => window.longVideoBench.retrySource(src), state.items.find((item) => item.kind === 'video')!.src!);
          const prepareDeadline = Date.now() + 30 * 60 * 1000;
          let status;
          do {
            status = await page.evaluate(() => window.longVideoBench.status()) as { items: number; mode: string; proxies: Array<{ proxy: { status: string } }>; originalUnchanged: boolean };
            if (status.items === state.items.length && status.mode === mode
              && (mode === 'original' || status.proxies.length > 0 && status.proxies.every(({ proxy }) => proxy.status === 'ready'))) break;
            if (status.proxies.some(({ proxy }) => proxy.status === 'failed')) throw new Error('proxy preparation failed');
            if (Date.now() > prepareDeadline) throw new Error('proxy preparation timeout');
            await new Promise((done) => setTimeout(done, 200));
          } while (true);
          const prepareMs = performance.now() - started;
          if (!status.originalUnchanged) throw new Error('preview mutated original document source addresses');
          await maximizeTimelineZoom();
          const proxyFiles = mode === 'proxy' ? await proxyCacheFiles(join(root, 'profile')) : [];
          if (rebuilding) report.proxyGeneration = { elapsedMs: prepareMs, files: proxyFiles,
            totalBytes: proxyFiles.reduce((sum, entry) => sum + entry.bytes, 0), confirmedRebuild: true,
            scope: 'awaited explicit single-source retry/rebuild through production proxy API, including readiness lookup' };
          const results = [];
          const schedule = seekSchedule(21600, 30);
          for (const frame of schedule.slice(0, -11)) {
            const result = await pointerSeek(frame, false);
            results.push(result);
            console.log(`[benchmark] seek ${name}/${mode} ${JSON.stringify(result)}`);
            report.inFlight = { name, mode, results };
            await persist();
          }
          // Hold the real ruler pointer capture across the fixed cut sequence.
          const firstPoint = await page.evaluate(() => window.longVideoBench.pointerAt!(594));
          await page._client().send('Input.dispatchMouseEvent', {
            type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...firstPoint,
          });
          try {
            for (const frame of schedule.slice(-11)) {
              const result = await pointerSeek(frame, true);
              results.push(result);
              report.inFlight = { name, mode, results };
              await persist();
            }
          } finally {
            const point = await page.evaluate(() => window.longVideoBench.pointerAt!(605));
            await page._client().send('Input.dispatchMouseEvent', {
              type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point,
            });
          }
          const playback = await page.evaluate(() => window.longVideoBench.playback(30));
          const nativeMemory = await processMemory(command);
          const proxyArtifacts = [];
          for (const entry of proxyFiles) proxyArtifacts.push({ file: entry.file, identity: await fileContentIdentity(entry.file) });
          await checkInputs();
          previews.push({ name, mode, status: results.every((sample) => sample.status === 'presented') ? 'passed' : 'failed', resultIdentity,
            prepareMs, proxyFiles, proxyArtifacts, proxyBytes: proxyFiles.reduce((sum, entry) => sum + entry.bytes, 0),
            preparationScope: 'includes cache lookup; retained resume cases keep their original preparation measurement', originalUnchanged: status.originalUnchanged,
            latency: latencySummary(results), results, playback, nativeMemory });
          console.log(`[benchmark] preview ${name}/${mode}: ${JSON.stringify(latencySummary(results))}`);
          delete report.inFlight;
        } catch (error) {
          const failure = { stage: 'preview', name, mode, reason: reason(error) };
          failures.push(failure);
          previews.push({ ...failure, status: 'failed', results: (report.inFlight as { results?: unknown[] })?.results ?? [] });
          delete report.inFlight;
        }
        await persist();
      }
      await page.evaluate((next) => window.longVideoBench.load(next, 'original'), states.layered);
      // Resuming can reuse all four preview cases, so their zoom setup never
      // runs. Exact selected-cut probes still require one-frame pointer spacing.
      await maximizeTimelineZoom();
      await page.evaluate(() => window.longVideoBench.select!('cut-1'));
      const exactSamples = [];
      for (const frame of [299, 300, 301]) exactSamples.push(await pointerSeek(frame, false));
      report.selectedExactPreview = { samples: exactSamples,
        scope: 'selected incoming clip, real editor pointer seek, GL blended fixture barcode, compared with the same planned source/blend as export audit' };
      if (exactSamples.some((entry) => entry.status !== 'presented' || entry.compositeMatched !== true)) {
        failures.push({ stage: 'selected-exact-preview', reason: 'selected transition did not present a matching GL fixture frame' });
      }
      await persist();
      // Retain the source choice actually used by the last preview case, so
      // the reload check does not accidentally only prove the default original.
      await page.evaluate((next) => window.longVideoBench.load(next, 'proxy'), states.layered);
      const beforeReload = await page.evaluate(() => window.longVideoBench.status()) as { mode: string };
      report.previewSavedSources = await page.evaluate(() => window.longVideoBench.flush!());
      if (!(report.previewSavedSources as { originalUnchanged: boolean }).originalUnchanged) {
        throw new Error('Committed project contains proxy addresses');
      }
      await navigateEditor();
      const reloadDeadline = Date.now() + 120000;
      while (!await page.evaluate(() => Boolean(window.longVideoBench))) {
        if (Date.now() > reloadDeadline) throw new Error('preview settings reload host timeout');
        await new Promise((done) => setTimeout(done, 100));
      }
      const afterReload = await page.evaluate(() => window.longVideoBench.status()) as { mode: string };
      report.previewSettingsPersistence = { beforeReload: beforeReload.mode, afterReload: afterReload.mode,
        passed: beforeReload.mode === afterReload.mode, scope: 'real browser page/module reload with localStorage; not OS application restart' };
      if (beforeReload.mode !== afterReload.mode) failures.push({ stage: 'preview-settings-persistence', reason: 'mode changed after page reload' });
      await persist();
    }
    if (!process.argv.includes('--preview-only')) {
      for (const [name, state] of Object.entries(states)) {
        if (await canReuse('export', name, 'webcodecs')) continue;
        console.log(`[benchmark] complete WebCodecs export ${name}`);
        report.inFlight = { stage: 'complete-export', name, route: 'webcodecs', startedAt: new Date().toISOString() };
        await persist();
        const attemptStarted = performance.now();
        try {
          await page.evaluate((next) => window.longVideoBench.load(next, 'original'), state);
          await new Promise((done) => setTimeout(done, 250));
          const result = await page.evaluate((label, timeout) => window.longVideoBench.export(label, timeout), name, timeoutMs) as { status: string; elapsedMs?: number; reason?: string };
          if (result.status === 'rendered') {
            const output = join(root, `${name}-webcodecs.mp4`);
            const reference = state.captions?.enabled ? (await loadNativeRenderer()).renderTimelineStills : undefined;
            const audit = await auditBenchmarkArtifact(output, () => auditExport(output, probe, command, state, reference));
            await checkInputs();
            exports.push({ name, route: 'webcodecs', ...result, ...audit, status: 'passed', output, resultIdentity,
              attemptElapsedMs: performance.now() - attemptStarted });
          } else exports.push({ name, route: 'webcodecs', ...result, passed: false,
            attemptElapsedMs: performance.now() - attemptStarted });
        } catch (error) { exports.push({ name, route: 'webcodecs', status: 'failed', reason: reason(error),
          attemptElapsedMs: performance.now() - attemptStarted }); }
        delete report.inFlight;
        await persist();
      }
    }
  } finally { await browser?.close({ silent: true }); await server.close(); }
  } else {
    report.browserPhaseSkipped = { reason: 'explicit server-only resume; only identity-validated prior successes retained, other browser cases remain untested', at: new Date().toISOString() };
    await persist();
  }
  if (!process.argv.includes('--preview-only')) {
    const { renderTimelineStills } = await loadNativeRenderer();
    if (!serverOnly || !Array.isArray(report.sharedVisualRender) || report.sharedVisualRender.length < 7) try {
      report.sharedVisualRender = await auditSharedVisual(root, states.simple.items[0].src!, renderTimelineStills);
    } catch (error) { failures.push({ stage: 'shared-visual-render', reason: reason(error) }); }
    await persist();
    for (const [name, state] of Object.entries(states)) {
      if (await canReuse('export', name, 'server')) continue;
      const attemptNumber = (report.attemptHistory as unknown[] | undefined)?.length ?? 0;
      const output = join(root, `${name}-server-attempt-${attemptNumber}.mp4`);
      const segmentDirectory = join(root, `server-attempt-${attemptNumber}-${name}-segments`);
      console.log(`[benchmark] complete compatibility export ${name} to ${output}`);
      report.inFlight = { stage: 'complete-export', name, route: 'server', output, segmentDirectory,
        segmentFrames, completedSegments: 0, startedAt: new Date().toISOString() };
      await persist();
      const started = performance.now();
      const samples: unknown[] = [];
      const attempt = { name, route: 'server', scope: 'free system RAM/disk samples, not process-memory peak', samples };
      ((report.resourceSamples ??= []) as unknown[]).push(attempt);
      try {
        let last = -1;
        const guarded = <T>(run: (signal: AbortSignal) => Promise<T>) => withResourceGuard({
          signal: AbortSignal.timeout(timeoutMs),
          sample: async () => { const disk = await statfs(root); return { freeMemoryBytes: freemem(), freeDiskBytes: disk.bavail * disk.bsize }; },
          onSample: async (sample: unknown) => { samples.push(sample); await persist(); },
          minimumFreeMemoryBytes: 2.5 * 1024 ** 3,
          enforceMemoryLimit,
          intervalMs: 1000,
          run,
        });
        if (recoverySnapshot && !sameBenchmarkIdentity(recoverySnapshot.benchmark?.resultIdentity, resultIdentity)) {
          throw new Error('Segment checkpoint source/project/media/configuration identity is missing or changed');
        }
        const recovery = recoverySnapshot ? await guarded((signal) => prepareSegmentRecovery({ snapshot: recoverySnapshot,
          root, name, state, sourceDigest: renderSourceDigest, configuration: report.configuration, signal })) : null;
        if (recovery) {
          report.segmentRecovery = { snapshot: recoveryFile, from: recovery.directory,
            committedPrefix: recovery.completed, samples: [], scope: recovery.scope,
            timing: 'This attempt elapsed time excludes original segment rendering; not an uninterrupted export speed sample' };
          await persist();
        }
        const segmented = await renderTimelineInSegments({
          durationFrames: 720 * state.fps, segmentFrames, temporaryDirectory: segmentDirectory, outputPath: output,
          recoverSegment: (part) => guarded((signal) => recoverCompletedSegment({ ...part, recovery,
            fps: state.fps, width: state.width, height: state.height, probe, command, ffmpegPath, signal,
            onEvidence: async (sample) => {
              ((report.segmentRecovery as { samples: unknown[] }).samples).push(sample); await persist();
              console.log(`[benchmark] ${name}/server recovered verified segment ${part.index + 1}`);
            } })),
          renderSegment: async ({ index, range, output: segmentOutput }) => {
            (report.inFlight as Record<string, unknown>).currentSegment = index + 1;
            (report.inFlight as Record<string, unknown>).currentFrameRange = range;
            await persist();
            await guarded((signal) => isolatedTimelineRender({
              bundle: process.env.CC_REMOTION_BUNDLE!, media: profileMedia, browser: executable,
              options: { state, outputLocation: segmentOutput,
              separateAudioTo: segmentOutput.replace(/\.mp4$/, '.wav'),
              codec: 'h264', frameRange: range as [number, number], ...cacheOptions } }, { signal,
              onLog: (line) => process.stdout.write(line),
              onProgress: (progress: number) => {
                const percent = Math.floor(((index + progress) / Math.ceil((720 * state.fps) / segmentFrames)) * 100);
                if (percent > last) { last = percent; console.log(`[benchmark] ${name}/server ${percent}% (${index + 1}/${Math.ceil((720 * state.fps) / segmentFrames)} segments)`); }
              } }));
          },
          onSegment: async ({ index }) => {
            (report.inFlight as Record<string, unknown>).completedSegments = index;
            await persist();
          },
          joinSegments: (parts) => guarded((signal) => joinVideoAndPcmSegments({ ...parts, fps: state.fps, command, probe, ffmpegPath, signal })),
        });
        const elapsedMs = performance.now() - started;
        const audit = await guarded((signal) => auditBenchmarkArtifact(output,
          () => auditExport(output, probe, command, state, renderTimelineStills, signal)));
        if (await chapterSourceDigest() !== renderSourceDigest) throw new Error('Render source changed during benchmark; do not accept this export');
        await checkInputs();
        exports.push({ name, route: 'server', output, resultIdentity, segmentDirectory, segmentFrames, sourceDigest: renderSourceDigest,
          segmentCount: segmented.segments.length, status: 'passed', elapsedMs, ...audit,
          recoveredSegments: recovery?.completed ?? 0,
          timingScope: recovery ? 'continuation elapsed time, excludes prior rendering; not uninterrupted export speed' : 'uninterrupted attempt',
          attemptElapsedMs: performance.now() - started });
      } catch (error) { exports.push({ name, route: 'server', output, status: 'failed', reason: reason(error),
        attemptElapsedMs: performance.now() - started });
        const stopReason = renderFailureStopReason(reason(error));
        if (stopReason) {
          failures.push({ stage: stopReason === 'guard-cancel-timeout' ? 'host-resource-guard' : 'renderer-resource-or-graphics', reason: reason(error) });
          report.heavyRouteHalt = { name, route: 'server', reason: stopReason, at: new Date().toISOString(),
            scope: 'Stop further heavy routes for investigation; generic capture errors do not prove system OOM' };
          delete report.inFlight;
          await persist();
          break; // Do not start another heavy route after a host-resource failure.
        }
      }
      delete report.inFlight;
      await persist();
    }
  }
  await checkInputs();
  report.status = Object.keys(states).every((name) => ['original', 'proxy'].every((mode) => previews.some(
    (entry) => (entry as { name: string; mode: string }).name === name && (entry as { mode: string }).mode === mode))
    && ['webcodecs', 'server'].every((route) => exports.some((entry) => (entry as { name: string; route: string }).name === name
      && (entry as { route: string }).route === route))) ? 'completed-with-results' : 'partial-run';
  report.completedAt = new Date().toISOString();
  await persist();
  await writeFile(join(root, 'README.txt'), 'Synthetic benchmark only. Read results.json for failures/unsupported routes. Not real-footage or installed-upgrade acceptance.\n');
  if ((!process.argv.includes('--preview-only') && report.status === 'partial-run') || failures.length || exports.some((entry) => (entry as { status: string }).status !== 'passed')
    || previews.some((entry) => (entry as { status?: string; latency?: { failed: number } }).status === 'failed'
      || ((entry as { latency?: { failed: number } }).latency?.failed ?? 0) > 0)) process.exitCode = 1;
}
