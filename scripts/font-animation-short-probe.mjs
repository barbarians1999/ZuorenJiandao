// Windows hardware acceptance: two serial six-second real font/animation exports.
// no visible browser, no long acceptance chain, and a three-minute total deadline.
import assert from 'node:assert/strict';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, statfsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { freemem } from 'node:os';
import { benchmarkCommand } from './long-video-command.mjs';
import { prepareChapterBundle } from './chapter-render-bundle.mjs';

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert(argument('bundle'), 'Pass a freshly source-fingerprinted --bundle=<absolute directory>');
assert.equal(process.platform, 'win32', 'This acceptance specifically exercises Windows-installed fonts');
const releaseRoot = resolve('release/jianying-workflow-20261013');
await mkdir(releaseRoot, { recursive: true });
const root = createTestArtifacts('font-animation');
process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
process.env.OPENCHATCUT_DATA_DIR = join(root, 'profile');
process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1';
process.env.CC_RENDER_GL = 'swangle';
delete process.env.CC_DIRECT_CUT_EXPORT;
delete process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Three-minute font/animation acceptance deadline exceeded')), 180_000);
const report = { status: 'running', root, startedAt: new Date().toISOString(),
  configuration: { seconds: 6, fps: 30, resolution: '640x360', concurrency: 1, deadlineMs: 180000, fixedRAMGate: false },
  scope: 'Real Windows TTC/TTF bytes, production six-second exports, composition preview references and independent browser font rasters. Not an installation, full-suite, long-video, or visible UI acceptance.',
  checks: [], samples: [], cases: [] };
let pendingSave = Promise.resolve(), browser, server;
const save = () => {
  const snapshot = JSON.stringify(report, null, 2);
  pendingSave = pendingSave.then(() => writeFile(join(root, 'results.json'), snapshot));
  return pendingSave;
};
const disk = () => {
  const spaces = {};
  for (const path of [root, ...(existsSync('D:/') ? ['D:/'] : [])]) {
    const value = statfsSync(path), freeBytes = Number(value.bavail) * Number(value.bsize);
    assert(freeBytes >= 2 * 1024 ** 3, `Low disk space at ${path}`); spaces[path] = freeBytes;
  }
  return spaces;
};
const sampler = setInterval(() => {
  try { report.samples.push({ at: new Date().toISOString(), phase: report.phase, freeMemoryBytes: freemem(), disk: disk() }); }
  catch (error) { controller.abort(error); }
}, 5000);
const mse = (left, right) => {
  assert.equal(left.length, right.length); assert(left.length);
  let sum = 0; for (let i = 0; i < left.length; i++) sum += (left[i] - right[i]) ** 2;
  return sum / left.length;
};
const changedPixels = (left, right, yFrom = 0, yUntil = 360) => {
  assert.equal(left.length, right.length);
  let changed = 0;
  for (let pixel = yFrom * 640; pixel < yUntil * 640; pixel++) {
    const at = pixel * 3;
    if (Math.max(Math.abs(left[at] - right[at]), Math.abs(left[at + 1] - right[at + 1]), Math.abs(left[at + 2] - right[at + 2])) > 25) changed++;
  }
  return changed;
};

try {
  disk(); await save(); console.log(`REPORT ${join(root, 'results.json')}`);
  report.phase = 'fresh-bundle';
  const sourceBundle = resolve(argument('bundle'));
  report.sourceBundle = await prepareChapterBundle({ reuse: sourceBundle, signal: controller.signal });
  const serve = join(root, 'serve');
  await cp(sourceBundle, serve, { recursive: true, dereference: false,
    filter: (path) => resolve(path) !== join(sourceBundle, 'media', 'uploads') });
  report.bundle = await prepareChapterBundle({ reuse: serve, signal: controller.signal });
  process.env.CC_REMOTION_BUNDLE = serve;
  const browserExecutable = argument('browser') ?? resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe');
  assert(existsSync(browserExecutable), 'Use the bundled hidden Chrome executable; do not download another browser');
  process.env.CC_BROWSER_EXECUTABLE = browserExecutable;
  const [{ createDesktopFontLibrary }, { uploadDir, serveDiskFile }, { ffmpegBin, ffprobeBin }, rendering,
    { planExport }, { planNativeExport }, { docFromTimeline, migrateProjectDoc }, { activeEditorState },
    { captionFontPatch }, { findCaptionPreviewTarget }, { assetFontFamily }, { openBrowser }] = await Promise.all([
    import('../desktop/font-library.ts'), import('../server/media-dir.ts'), import('../server/media-binaries.ts'),
    import('../server/plugins/export-rendering.ts'), import('../server/plugins/export-plan.ts'), import('../remotion/direct-cut.mjs'),
    import('../src/persist/projectStore.ts'), import('../src/editor/types.ts'), import('../src/fonts/captionFontScope.ts'),
    import('../src/captions/captionPreviewTarget.ts'), import('../shared/desktop-fonts.ts'), import('@remotion/renderer'),
  ]);
  const uploads = uploadDir(); await mkdir(uploads, { recursive: true });
  rendering.setUploadsDirProvider(uploadDir);
  const command = (binary, args, encoding = 'utf8', maxBuffer = 12 * 1024 ** 2) => benchmarkCommand(binary, args,
    { encoding, maxBuffer, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]) });
  const ff = (args, encoding = 'utf8', maxBuffer) => command(ffmpegBin(), ['-v', 'error', '-nostdin', ...args], encoding, maxBuffer);
  const rgb = async (file, frame = 0) => ff(['-i', file, '-an', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], 'buffer', 640 * 360 * 3 * 2);
  const pcm = async (file) => {
    const bytes = await ff(['-i', file, '-vn', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', 'pipe:1'], 'buffer', 48000 * 4 * 10);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  report.phase = 'real-font-import'; await save();
  const windowsFonts = join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
  const ttcPath = resolve(argument('ttc') ?? join(windowsFonts, 'msyh.ttc'));
  const ttfPath = resolve(argument('ttf') ?? join(windowsFonts, 'consola.ttf'));
  assert(existsSync(ttcPath) && existsSync(ttfPath), 'Real msyh.ttc/consola.ttf required; explicit --ttc and --ttf replacements allowed');
  const fontLibrary = createDesktopFontLibrary({ directory: () => uploads });
  const ttcFaces = await fontLibrary.inspect(ttcPath, 'system');
  assert(ttcFaces.length > 1, 'The real TTC must contain multiple faces to validate explicit collection choice');
  const ttcFace = ttcFaces.find((face) => face.weight === 400 && face.style === 'normal') ?? ttcFaces[0];
  const ttfFaces = await fontLibrary.inspect(ttfPath, 'imported');
  const ttfFace = ttfFaces.find((face) => face.style === 'normal') ?? ttfFaces[0];
  const ttcAsset = await fontLibrary.materializeFont(ttcFace.faceId), ttfAsset = await fontLibrary.materializeFont(ttfFace.faceId);
  assert.equal((await fontLibrary.materializeFont(ttcFace.faceId)).id, ttcAsset.id);
  const storedTtc = await readFile(join(uploads, basename(ttcAsset.src)));
  assert.notEqual(storedTtc.subarray(0, 4).toString('ascii'), 'ttcf', 'persist the chosen standalone face, never the original collection');
  report.fonts = [{ path: ttcPath, chosen: ttcFace, asset: ttcAsset }, { path: ttfPath, chosen: ttfFace, asset: ttfAsset }];
  report.checks.push('real multi-face TTC choice and local TTF use the product copy/hash/dedup importer');

  // The labels are deliberately unavailable to the OS: only fontAssetId can
  // reproduce these glyphs. This exposes CSS-name fallback masquerading as success.
  const nonce = randomUUID().replaceAll('-', ''), ttcLabel = `FileOnlyCjk${nonce}`, ttfLabel = `FileOnlyMono${nonce}`;
  const ttcChoice = { fontFamily: ttcLabel, fontAssetId: ttcAsset.id }, ttfChoice = { fontFamily: ttfLabel, fontAssetId: ttfAsset.id };
  const source = join(uploads, 'font-animation-source.mp4');
  await ff(['-y', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=7',
    '-f', 'lavfi', '-i', 'aevalsrc=0.15*sin(2*PI*(400*t+60*t*t))|0.15*sin(2*PI*(400*t+60*t*t)):s=48000:d=7',
    '-c:v', 'libx264', '-threads:v', '1', '-preset', 'ultrafast', '-crf', '18', '-g', '30', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_range', 'tv', '-color_trc', 'bt709', '-color_primaries', 'bt709',
    '-c:a', 'aac', '-b:a', '192k', source]);
  let captions = { enabled: true, template: 'plain', pacing: 'phrase', sourceMode: 'item', motionPreset: 'none',
    styleOverride: { fontFamily: 'Noto Sans SC', fontSize: .075, fontWeight: 400, color: '#ffffff', highlightColor: '#ffffff',
      strokeColor: '#000000', strokeWidth: 2, wholeLine: true, background: 'transparent', textShadow: 'none' },
    sourceEntries: [{ id: 'font-caption-lane', itemId: 'manual:font-caption-lane', words: [
      { id: 'font-cue-one', text: '章节字体 ABC 01', start: 1500, end: 2500 },
      { id: 'font-cue-two', text: 'FONT TWO MW 02', start: 3500, end: 4500 },
    ] }] };
  captions = { ...captions, ...captionFontPatch(captions, ttfChoice, 'track') };
  const firstCueTarget = findCaptionPreviewTarget(captions, [], 30, 1800);
  captions = { ...captions, ...captionFontPatch(captions, ttcChoice, 'selected', firstCueTarget) };
  assert.equal(findCaptionPreviewTarget(captions, [], 30, 1800).preset.fontAssetId, ttcAsset.id);
  assert.equal(findCaptionPreviewTarget(captions, [], 30, 3800).preset.fontAssetId, ttfAsset.id);
  const clip = { id: 'animated-video', name: 'Actual picture entry and exit', kind: 'video', track: 'V1',
    startFrame: 15, durationInFrames: 150, srcInFrame: 30, width: 640, height: 360,
    src: '/media/uploads/font-animation-source.mp4', volume: .7,
    props: { visualEntrance: 'whip', visualExit: 'fade', visualEntranceFrames: 12, visualExitFrames: 12 } };
  const title = (id, startFrame, choice, text) => ({ id, name: id, kind: 'text', track: 'V2', startFrame,
    durationInFrames: 24, width: 1920, height: 1080, props: { text, ...choice, fontSize: 108, fontWeight: 400,
      color: '#ffffff', shadowEnabled: false, entrance: 'none', exit: 'none' } });
  const state = { fps: 30, width: 640, height: 360, fit: 'contain', selectedId: null, assets: [ttcAsset, ttfAsset],
    trackOrder: ['V2', 'V1', 'A1', 'C1'], tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' }, C1: { kind: 'caption', captions } },
    items: [clip, title('cjk-title', 42, ttcChoice, '章节字体测试 01'), title('mono-title', 96, ttfChoice, 'FONT 02 MW@'),
      { id: 'silent-clock', name: 'Six-second duration', kind: 'audio', track: 'A1', startFrame: 0, durationInFrames: 180,
        srcInFrame: 0, src: clip.src, volume: 0 }] };
  const originalDoc = docFromTimeline(state);
  await writeFile(join(root, 'project-before-reopen.json'), JSON.stringify(originalDoc, null, 2));
  const doc = migrateProjectDoc(JSON.parse(await readFile(join(root, 'project-before-reopen.json'), 'utf8')));
  assert(doc, 'saved project must reopen');
  assert.deepEqual(doc.assets.map((asset) => asset.sourceContentHash), originalDoc.assets.map((asset) => asset.sourceContentHash));
  const fullState = activeEditorState(doc);
  const captionTrackId = doc.timelines[0].trackOrder.find((id) => doc.timelines[0].tracks[id]?.kind === 'caption');
  assert(captionTrackId, 'the saved/reopened project retains its caption track');
  assert.equal(findCaptionPreviewTarget(fullState.tracks[captionTrackId].captions, fullState.items, 30, 1800).preset.fontAssetId, ttcAsset.id);
  report.checks.push('ordinary text and selected/all-track subtitle font identities survive save/reopen');

  report.phase = 'independent-font-raster'; await save();
  const fontAssets = [ttcAsset, ttfAsset];
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><html><body>Actual font bytes</body></html>'); return; }
    const font = fontAssets.find((asset) => asset.src === url.pathname);
    if (font) void serveDiskFile(req, res, join(uploads, basename(font.src))).catch((error) => { res.writeHead(500); res.end(String(error)); });
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await openBrowser('chrome', { browserExecutable, chromiumOptions: { gl: 'swangle' }, logLevel: 'error' });
  const page = await browser.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => undefined });
  await page.goto({ url: origin, timeout: 30000 });
  const fontSpecs = fontAssets.map((asset) => ({ family: assetFontFamily(asset.id), src: asset.src, weight: asset.props.font.weight,
    sample: asset.id === ttcAsset.id ? '章节字体测试 01' : 'FONT 02 MW@' }));
  const fontObservation = await page.evaluate(`(async () => {
    const specs = ${JSON.stringify(fontSpecs)}; const observations = [];
    for (const spec of specs) {
      const bytes = await (await fetch(spec.src)).arrayBuffer();
      const face = new FontFace(spec.family, bytes, {weight:String(spec.weight)}); await face.load(); document.fonts.add(face);
      const canvas = document.createElement('canvas'); canvas.width=600; canvas.height=90;
      const ctx = canvas.getContext('2d');
      const paint = (family) => { ctx.clearRect(0,0,600,90); ctx.fillStyle='#000'; ctx.font='400 44px "'+family+'"'; ctx.fillText(spec.sample,8,60); return canvas.toDataURL('image/png'); };
      observations.push({family:spec.family,status:face.status,loaded:document.fonts.check('400 44px "'+spec.family+'"',spec.sample),
        actual:paint(spec.family),fallback:paint('FileOnlyMissingFont${nonce}')});
    }
    return observations;
  })()`);
  report.fontRasters = [];
  for (const [index, observation] of fontObservation.entries()) {
    assert.equal(observation.status, 'loaded'); assert.equal(observation.loaded, true);
    assert.notEqual(observation.actual, observation.fallback, 'actual face bytes must differ from CSS-name fallback');
    await writeFile(join(root, `independent-font-${index}.png`), Buffer.from(observation.actual.split(',')[1], 'base64'));
    await writeFile(join(root, `independent-fallback-${index}.png`), Buffer.from(observation.fallback.split(',')[1], 'base64'));
    report.fontRasters.push({ index, family: observation.family, status: observation.status, loaded: observation.loaded, differsFromFallback: true });
  }
  await page.close();
  report.checks.push('independent Chromium FontFace loads copied TTC/TTF bytes and glyph rasters differ from unavailable-family fallback');

  const frameList = [15, 21, 26, 54, 74, 105, 134, 158, 164];
  const references = new Map();
  for (let start = 0; start < frameList.length; start += 8) {
    const stills = await rendering.renderTimelineStills({ state: doc.timelines[0], project: doc, timelineId: doc.activeTimelineId,
      frames: frameList.slice(start, start + 8), fullResolution: true, puppeteerInstance: browser, signal: controller.signal });
    assert.deepEqual(stills.map((still) => still.frame), frameList.slice(start, start + 8));
    for (const still of stills) { const file = join(root, `preview-reference-${still.frame}.jpg`); await writeFile(file, Buffer.from(still.base64, 'base64')); references.set(still.frame, await rgb(file)); }
  }
  const fallbackDoc = structuredClone(doc);
  for (const item of fallbackDoc.timelines[0].items) if (item.kind === 'text') item.props.fontAssetId = undefined;
  fallbackDoc.timelines[0].tracks[captionTrackId].captions.styleOverride.fontAssetId = null;
  for (const font of Object.values(fallbackDoc.timelines[0].tracks[captionTrackId].captions.cueFonts)) font.fontAssetId = null;
  const fallbackStills = await rendering.renderTimelineStills({ state: fallbackDoc.timelines[0], project: fallbackDoc,
    timelineId: fallbackDoc.activeTimelineId, frames: [54, 105], fullResolution: true, puppeteerInstance: browser, signal: controller.signal });
  report.fallbackControls = [];
  for (const still of fallbackStills) {
    const file = join(root, `fallback-control-${still.frame}.jpg`); await writeFile(file, Buffer.from(still.base64, 'base64'));
    const fallback = await rgb(file), reference = references.get(still.frame);
    const titlePixels = changedPixels(reference, fallback, 130, 230), captionPixels = changedPixels(reference, fallback, 250, 360);
    assert(titlePixels > 50, `actual ${still.frame} title must differ when only fontAssetId is cleared`);
    assert(captionPixels > 30, `actual ${still.frame} subtitle must differ when only fontAssetId is cleared`);
    report.fallbackControls.push({ frame: still.frame, titleChangedPixels: titlePixels, captionChangedPixels: captionPixels });
  }
  await browser.close({ silent: true }); browser = undefined;
  report.checks.push('real composition references prove title/selected-cue/all-track glyphs depend on fontAssetId, not OS-name fallback');

  const expectedSourcePcm = await pcm(source);
  async function auditCase(label, project, requireHybrid) {
    disk(); report.phase = label;
    const item = { label, status: 'running', startedAt: new Date().toISOString(), progress: [], checks: [] };
    report.cases.push(item); await save();
    const output = join(root, `${label}.mp4`);
    const native = planNativeExport({ state: project.timelines[0], project, timelineId: project.activeTimelineId, allowTextWindows: true });
    item.nativePreflight = { eligible: native.eligible, reason: native.reason, renderRoute: native.renderRoute,
      composedRanges: native.segments?.filter((segment) => segment.compositionRange).map((segment) => segment.compositionRange) };
    if (requireHybrid) { assert(native.eligible, native.reason); assert.equal(native.renderRoute, 'hybrid'); }
    else assert.equal(native.eligible, false, 'caption case must honestly retain the compatibility compositor');
    await writeFile(join(root, `${label}-project.json`), JSON.stringify(project, null, 2));
    const started = performance.now();
    item.encoder = await rendering.renderExportPlan(planExport({ state: project.timelines[0], project, timelineId: project.activeTimelineId,
      format: 'video', codec: 'h264', fps: 30 }), output, (progress) => { item.progress.push(progress); }, controller.signal);
    item.elapsedMs = performance.now() - started;
    if (requireHybrid) assert.equal(item.encoder?.encoder?.renderRoute, 'hybrid', 'actual production encoder must confirm the fast hybrid route');
    const hashes = await ff(['-xerror', '-i', output, '-map', '0:v:0', '-an', '-f', 'framehash', 'pipe:1']);
    assert.equal(hashes.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 180);
    await ff(['-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    const probe = JSON.parse(await command(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output]));
    assert(Math.abs(Number(probe.format.duration) - 6) < .05); assert(probe.streams.some((stream) => stream.width === 640 && stream.height === 360));
    item.checks.push('entire 180 frames and all audio fully decode; six-second duration and 640x360 resolution');
    let stills;
    if (requireHybrid) stills = await rendering.renderTimelineStills({ state: project.timelines[0], project, timelineId: project.activeTimelineId,
      frames: frameList, fullResolution: true, signal: controller.signal });
    item.frames = [];
    for (const [index, frame] of frameList.entries()) {
      let reference = references.get(frame);
      if (requireHybrid) { const file = join(root, `${label}-reference-${frame}.jpg`); await writeFile(file, Buffer.from(stills[index].base64, 'base64')); reference = await rgb(file); }
      const actual = await rgb(output, frame), error = mse(actual, reference);
      assert(error < 650, `${label}/${frame}: real preview/export divergence MSE ${error}`);
      item.frames.push({ frame, mse: error });
    }
    // With no title/subtitle/animation active, independently compare the exact
    // original source frame, not another invocation of the composition mapper.
    for (const frame of [84, 141]) {
      const actual = await rgb(output, frame), sourceFrame = frame - clip.startFrame + clip.srcInFrame;
      const error = mse(actual, await rgb(source, sourceFrame));
      assert(error < 650, `${label}/${frame}: wrong independent source frame ${sourceFrame}`);
      item.frames.push({ frame, sourceFrame, independentSourceMse: error });
    }
    const actualAudio = await pcm(output), expected = new Float32Array(180 * 1600);
    for (let sample = clip.startFrame * 1600; sample < (clip.startFrame + clip.durationInFrames) * 1600; sample++) {
      expected[sample] = expectedSourcePcm[clip.srcInFrame * 1600 + sample - clip.startFrame * 1600] * clip.volume;
    }
    assert(actualAudio.length >= expected.length && actualAudio.length - expected.length < 1024);
    let squared = 0, energy = 0;
    for (let sample = 1024; sample < expected.length - 1024; sample++) { squared += (actualAudio[sample] - expected[sample]) ** 2; energy += expected[sample] ** 2; }
    const relativeRmsError = Math.sqrt(squared / energy);
    assert(energy > .01 && relativeRmsError < .065, `${label}: audio timing/gain differs from the time-coded source (${relativeRmsError})`);
    item.audio = { samples: actualAudio.length, expectedSamples: expected.length, relativeRmsError,
      note: 'independent chirp sample-clock reference; visual animations do not alter sound' };
    item.checks.push('entry/settle/exit, title and subtitle preview/export key frames agree; independent source/audio timing agrees');
    item.status = 'passed'; item.finishedAt = new Date().toISOString(); await save();
  }
  await auditCase('captions-fonts-animation-compatibility', doc, false);
  const hybridDoc = structuredClone(doc); hybridDoc.timelines[0].tracks[captionTrackId].captions.enabled = false;
  await auditCase('title-fonts-animation-hybrid', hybridDoc, true);
  report.checks.push('caption compositor case and genuinely fast title/animation hybrid case are separately tested and separately reported');
  await prepareChapterBundle({ reuse: serve, signal: controller.signal });
  report.status = 'passed';
} catch (error) {
  report.status = controller.signal.aborted ? 'cancelled' : 'failed';
  report.error = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  clearInterval(sampler); clearTimeout(deadline);
  if (browser) await browser.close({ silent: true }).catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise((accept) => server.close(accept)); }
  report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  await save(); console.log(JSON.stringify({ root, status: report.status, cases: report.cases.map(({ label, status, elapsedMs }) => ({ label, status, elapsedMs })), error: report.error }));
  finishTestArtifacts(root, { status: report.status, evidence: join(releaseRoot, `font-animation-evidence-${Date.now()}`) });
}
