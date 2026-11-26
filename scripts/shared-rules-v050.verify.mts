/**
 * Content-level real-media verification for the v0.5.0 shared rules convergence:
 * 1. `captionsHidden: true` hides captions while keeping visual `text` chapter titles.
 * 2. Animated GIFs stay locked to timeline frame clock across play/pause/seek/trim (`srcInFrame`) in BOTH preview stills (`<SyncedGif>`) and `overlay-hybrid` fast export.
 * 3. `1.5x` video razor-split invariance (`srcInFrame: 22.5`), unified `ffprobe`-backed preflight agreement via HTTP `/export/capabilities`, and visual/audio compat decoupling.
 * 4. Cross-FPS (`24fps` / `60fps`) & variable-frame-rate (VFR) tail validation.
 * 5. Zero static volume (`volume: 0`) overridden by positive linear `keyframes.volume` in both preview `volumeAtFrame` and `overlay-hybrid` audio output.
 *
 * Run: `npx.cmd tsx scripts/shared-rules-v050.verify.mts`
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const ffmpegExe = ffmpegStatic!;
const ffprobeExe = ffprobeInstaller.path;

const prebuiltBundle = resolve('desktop-dist/remotion-bundle');
process.env.CC_REMOTION_BUNDLE = prebuiltBundle;
const root = await mkdtemp(join(tmpdir(), 'zuoren-shared-v050-'));
process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
process.env.OPENCHATCUT_DATA_DIR = join(root, 'profile');
process.env.OPENCHATCUT_MEDIA_DIR = join(root, 'media');
delete process.env.CC_DIRECT_CUT_EXPORT;

const runFfmpeg = (args: string[]) => execFileSync(ffmpegExe, ['-v', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
const probeJson = (file: string) => JSON.parse(
  execFileSync(ffprobeExe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }),
);
const decodeRgbFrames = (mp4: string, width: number, height: number): { count: number; data: Buffer } => {
  const data = execFileSync(ffmpegExe, ['-v', 'error', '-i', mp4, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 128 * 1024 * 1024,
  });
  const frameBytes = width * height * 3;
  assert.equal(data.length % frameBytes, 0, 'decoded rgb24 byte length is a clean multiple of frame size');
  return { count: data.length / frameBytes, data };
};
const sampleRgbPixel = (buf: Buffer, width: number, height: number, frameIdx: number, x: number, y: number): [number, number, number] => {
  const off = frameIdx * (width * height * 3) + (y * width + x) * 3;
  return [buf[off]!, buf[off + 1]!, buf[off + 2]!];
};
const decodeJpegBase64Buffer = (base64: string): Buffer => execFileSync(ffmpegExe, [
  '-v', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
], {
  input: Buffer.from(base64, 'base64'),
  maxBuffer: 16 * 1024 * 1024,
});
const decodeJpegBase64Pixel = (base64: string, width: number, height: number, x: number, y: number): [number, number, number] => {
  const rgb = decodeJpegBase64Buffer(base64);
  return sampleRgbPixel(rgb, width, height, 0, x, y);
};
const countMatchingPixels = (
  buf: Buffer,
  width: number,
  height: number,
  frameIdx: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  pred: (rgb: [number, number, number]) => boolean,
): number => {
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pred(sampleRgbPixel(buf, width, height, frameIdx, x, y))) count += 1;
    }
  }
  return count;
};
const decodePcmMono48k = (mp4: string): Int16Array => {
  const raw = execFileSync(ffmpegExe, ['-v', 'error', '-i', mp4, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
};
const audioStatsWindow = (pcm: Int16Array, fromSec: number, toSec: number) => {
  const s0 = Math.max(0, Math.round(fromSec * 48000));
  const s1 = Math.min(pcm.length, Math.round(toSec * 48000));
  let sumSq = 0;
  let peak = 0;
  let zc = 0;
  let prev = pcm[s0] ?? 0;
  for (let i = s0; i < s1; i++) {
    const v = pcm[i]!;
    sumSq += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    if (i > s0 && ((prev < 0 && v >= 0) || (prev >= 0 && v < 0))) zc += 1;
    prev = v;
  }
  const n = Math.max(1, s1 - s0);
  return {
    rms: Math.sqrt(sumSq / n),
    peak,
    hz: (zc / 2) / (n / 48000),
  };
};

let http: ReturnType<typeof createServer> | undefined;

try {
  const { uploadDir } = await import('../server/media-dir.ts');
  const upDir = uploadDir();
  await mkdir(upDir, { recursive: true });

  const renderMod = await import('../remotion/render.mjs');
  const {
    inspectOverlayHybridExport,
    planOverlayHybridExport,
    tryOverlayHybridExport,
  } = await import('../remotion/overlay-hybrid.mjs');
  const { setUploadsDirProvider } = renderMod;
  setUploadsDirProvider(() => upDir);
  const { registerExportRoute } = await import('../server/plugins/export-job-routes.ts');
  const { analyzeExportRoutePreflight } = await import('../src/export/exportPreflight.ts');
  const { splitTimelineItem } = await import('../src/editor/reducerOverwrite.ts');
  const { volumeAtFrame } = await import('../src/editor/keyframes.ts');
  const { parseGifTiming, gifFrameIndexAtTimeMs } = await import('../shared/gif-timing.mjs');
  const { hasPotentialClipAudio, isVisualOverlayItemVisible } = await import('../shared/timeline-media-schedule.mjs');

  let routeHandler: (req: any, res: any) => void;
  registerExportRoute({ middlewares: { use: (_path: string, cb: any) => { routeHandler = cb; } } } as any);
  http = createServer((req, res) => routeHandler(req, res));
  await new Promise<void>((accept) => http!.listen(0, '127.0.0.1', accept));
  const capEndpoint = `http://127.0.0.1:${(http.address() as any).port}/export/capabilities`;

  const postCapabilities = async (body: unknown) => {
    const res = await fetch(capEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return res.json() as Promise<any>;
  };

  // Reuse renderOverlayPlates & renderTimelineStills from remotion/render.mjs
  const { renderTimelineStills, renderOverlayPlatesForHybridTest } = await (async () => {
    // Dynamically capture renderTimelineStills; overlay plates work via renderTimeline(..., renderOverlayPlates)
    return {
      renderTimelineStills: renderMod.renderTimelineStills,
      renderOverlayPlatesForHybridTest: async (opts: any) => {
        // Call renderTimeline on a temporary output path? Better: import @remotion/renderer? We can pass a local renderOverlayPlates using renderTimelineStills!
        void opts;
      },
    };
  })();

  // Helper to render transparent overlay plates in headless Chrome via renderTimelineStills (or renderMedia)!
  const { openBrowser, renderFrames, selectComposition } = await import('@remotion/renderer');
  const { browserExecutable, resolveRenderGlBackend } = await import('../remotion/render-browser.mjs');
  const { binariesDirectory } = await import('../remotion/render-runtime.mjs');
  const { existsSync, symlinkSync, rmSync } = await import('node:fs');
  let serveUrl: string | undefined;
  let sharedBrowser: any;

  const ensureServeAndBrowser = async () => {
    if (!serveUrl) {
      if (existsSync(join(prebuiltBundle, 'index.html'))) {
        serveUrl = prebuiltBundle;
        const linkPath = join(serveUrl, 'media', 'uploads');
        try { rmSync(linkPath, { recursive: true, force: true }); } catch {}
        await mkdir(join(serveUrl, 'media'), { recursive: true });
        symlinkSync(upDir, linkPath, 'junction');
      } else {
        throw new Error('desktop-dist/remotion-bundle missing; build bundle first');
      }
    }
    if (!sharedBrowser) {
      sharedBrowser = await openBrowser('chrome', {
        browserExecutable: browserExecutable(),
        chromiumOptions: { gl: resolveRenderGlBackend() },
      });
    }
    return { serveUrl, browser: sharedBrowser };
  };

  const makeRenderOverlayPlates = () => async ({ overlayState, plan, platesDir }: any) => {
    if (!plan.hasOverlays) {
      return { spans: [{ from: plan.rangeStart, to: plan.rangeEnd, sampleFrame: null }], plateFiles: new Map() };
    }
    const { buildSparseOverlayPlan } = await import('../remotion/overlay-hybrid.mjs');
    const { serveUrl: sUrl, browser } = await ensureServeAndBrowser();
    const inputProps = { state: overlayState, transparent: true, _nativeOpaqueVideoSources: [] };
    const comp = await selectComposition({
      serveUrl: sUrl,
      id: 'timeline',
      inputProps: plan.hasCaptions ? { ...inputProps, __collectOverlaySpans: { rangeStart: plan.rangeStart, rangeEnd: plan.rangeEnd } } : inputProps,
      binariesDirectory: binariesDirectory(),
      browserExecutable: browserExecutable(),
      puppeteerInstance: browser,
    });
    const captionSummary = plan.hasCaptions ? (comp.props as any)?.__overlayCaptionInfo ?? null : null;
    const excludeRanges = (plan.compatSpans ?? []).map((s: any) => [s.from, s.to]);
    const { spans, framesToRender } = buildSparseOverlayPlan(overlayState, plan.rangeStart, plan.rangeEnd, captionSummary, excludeRanges);
    const plateFiles = new Map<number, string>();
    if (!framesToRender.length) return { spans, plateFiles };
    await mkdir(platesDir, { recursive: true });
    await renderFrames({
      serveUrl: sUrl,
      composition: comp,
      inputProps,
      frames: framesToRender,
      outputDir: platesDir,
      imageFormat: 'png',
      imageSequencePattern: 'plate-[frame].[ext]',
      muted: true,
      concurrency: 2,
      chromiumOptions: { gl: resolveRenderGlBackend() },
      browserExecutable: browserExecutable(),
      puppeteerInstance: browser,
      binariesDirectory: binariesDirectory(),
      onStart: () => {},
      onFrameUpdate: () => {},
    });
    for (const name of await readdir(platesDir)) {
      const match = /^plate-(\d+)\.png$/i.exec(name);
      if (match) plateFiles.set(Number(match[1]), join(platesDir, name));
    }
    return { spans, plateFiles };
  };

  try {
    // ── Test 1: captionsHidden: true keeps visual `text` chapter title while hiding C1 captions ──
    {
      console.log('[v0.50 verify] 1/5 Testing captionsHidden vs kind=text chapter title...');
      const bgFile = join(upDir, 't1_blue.mp4');
      runFfmpeg(['-f', 'lavfi', '-i', 'color=c=#001050:s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', bgFile]);
      const st1: any = {
        fps: 30, width: 320, height: 180, selectedId: null,
        captionsHidden: true,
        trackOrder: ['C1', 'T1', 'V1'],
        tracks: {
          C1: { kind: 'caption', captions: { enabled: true, template: 'black-bar', pacing: 'phrase', words: [{ text: 'HIDDEN_CAP', start: 0, end: 1000 }] } },
          T1: { kind: 'video', visualRole: 'text' },
          V1: { kind: 'video' },
        },
        items: [
          { id: 'bg1', name: 'bg1', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 30, srcInFrame: 0, src: '/media/uploads/t1_blue.mp4', width: 320, height: 180 },
          {
            id: 'title1', name: '第一章', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 30,
            props: {
              text: '████████', fontSize: 180, color: '#ffff00',
              backgroundColor: '#ffff00', backgroundOpacity: 100, backgroundPadding: 36, shadowEnabled: false,
            },
          },
        ],
      };
      assert.equal(isVisualOverlayItemVisible(st1, st1.items[1]), true);
      const isYellow = ([r, g, b]: [number, number, number]) => r > 180 && g > 180 && b < 80;
      const isNotDarkBlue = ([r, g, b]: [number, number, number]) => !(r < 25 && g < 35 && b > 50 && b < 115);

      const { browser } = await ensureServeAndBrowser();
      // Control check: captionsHidden = false shows BOTH center yellow title AND bottom caption
      const controlStills = await renderTimelineStills({
        state: { ...st1, captionsHidden: false }, frames: [15], fullResolution: true, puppeteerInstance: browser,
      });
      const controlBuf = decodeJpegBase64Buffer(controlStills[0].base64);
      const controlYellow = countMatchingPixels(controlBuf, 320, 180, 0, 80, 240, 70, 110, isYellow);
      const controlCap = countMatchingPixels(controlBuf, 320, 180, 0, 40, 280, 132, 176, isNotDarkBlue);
      assert.ok(controlYellow > 100, `Control preview preserves yellow title pixels (${controlYellow})`);
      assert.ok(controlCap > 20, `Control preview renders bottom caption when captionsHidden=false (${controlCap})`);

      // Target check: captionsHidden = true hides bottom caption while keeping center yellow title
      const stills1 = await renderTimelineStills({ state: st1, frames: [15], fullResolution: true, puppeteerInstance: browser });
      const previewBuf = decodeJpegBase64Buffer(stills1[0].base64);
      const previewYellow = countMatchingPixels(previewBuf, 320, 180, 0, 80, 240, 70, 110, isYellow);
      const previewCap = countMatchingPixels(previewBuf, 320, 180, 0, 40, 280, 132, 176, isNotDarkBlue);

      const out1 = join(root, 't1_out.mp4');
      const res1 = await tryOverlayHybridExport({
        state: st1,
        outputLocation: out1,
        codec: 'h264',
        allowCompatSpans: true,
        ffmpegExecutable: ffmpegExe,
        ffprobeExecutable: ffprobeExe,
        uploadsDirectory: upDir,
        assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.ok(res1, 'Test 1 must stay on overlay-hybrid fast path');
      const { data: fastBuf } = decodeRgbFrames(out1, 320, 180);
      const fastYellow = countMatchingPixels(fastBuf, 320, 180, 15, 80, 240, 70, 110, isYellow);
      const fastCap = countMatchingPixels(fastBuf, 320, 180, 15, 40, 280, 132, 176, isNotDarkBlue);
      assert.ok(previewYellow > 100, `Preview still preserves yellow text when captionsHidden=true (${previewYellow})`);
      assert.equal(previewCap, 0, `Preview still hides bottom caption when captionsHidden=true (${previewCap})`);
      assert.ok(fastYellow > 100, `Fast export preserves yellow text even when captionsHidden=true (${fastYellow})`);
      assert.equal(fastCap, 0, `Bottom caption region stays dark blue (hidden) in fast export (${fastCap})`);
    }

    // ── Test 2: Animated GIF frame sync (play, pause/still, seek, srcInFrame trim, fast export) ──
    {
      console.log('[v0.50 verify] 2/5 Testing animated GIF frame sync in preview stills & fast export...');
      const gifFile = join(upDir, 't2_rgb.gif');
      runFfmpeg([
        '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=5:d=0.25',
        '-f', 'lavfi', '-i', 'color=c=lime:s=320x180:r=5:d=0.25',
        '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=5:d=0.25',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,fps=5,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop', '0', gifFile,
      ]);
      const gifTiming = parseGifTiming(await readFile(gifFile));
      assert.equal(gifTiming.frameCount, 6, 'GIF timing parser sees all 6 frames (400ms each R/G/B)');
      assert.equal(gifTiming.totalDurationMs, 1200, 'GIF loop duration is 1200ms');
      assert.equal(gifTiming.loopCount, 0, 'GIF is infinite loop');
      assert.equal(gifFrameIndexAtTimeMs(gifTiming, 50), 0);
      assert.equal(gifFrameIndexAtTimeMs(gifTiming, 450), 2);
      assert.equal(gifFrameIndexAtTimeMs(gifTiming, 850), 4);
      assert.equal(gifFrameIndexAtTimeMs(gifTiming, 1250), 0);

      // Trim 400ms off front -> srcInFrame = 12 at 30fps!
      // Timeline frame 3 (+400ms = 500ms) = Green; frame 15 (+400ms = 900ms) = Blue; frame 27 (+400ms = 1300ms) = Red!
      const st2: any = {
        fps: 30, width: 320, height: 180, selectedId: null,
        trackOrder: ['V1'],
        tracks: { V1: { kind: 'video' } },
        items: [
          {
            id: 'gif1', name: 'RGB GIF', kind: 'gif', track: 'V1',
            startFrame: 0, durationInFrames: 30, srcInFrame: 12, playbackRate: 1,
            src: '/media/uploads/t2_rgb.gif', width: 320, height: 180,
          },
        ],
      };
      const { browser } = await ensureServeAndBrowser();
      const stills2 = await renderTimelineStills({ state: st2, frames: [3, 15, 27], fullResolution: true, puppeteerInstance: browser });
      const prev2 = decodeJpegBase64Pixel(stills2[0].base64, 320, 180, 160, 90);
      const prev8 = decodeJpegBase64Pixel(stills2[1].base64, 320, 180, 160, 90);
      const prev14 = decodeJpegBase64Pixel(stills2[2].base64, 320, 180, 160, 90);
      assert.ok(prev2[1] > 180 && prev2[0] < 60 && prev2[2] < 60, `SyncedGif frame 3 (trimmed 400ms) shows Green, got ${prev2}`);
      assert.ok(prev8[2] > 180 && prev8[0] < 60 && prev8[1] < 60, `SyncedGif frame 15 shows Blue, got ${prev8}`);
      assert.ok(prev14[0] > 180 && prev14[1] < 60 && prev14[2] < 60, `SyncedGif frame 27 loops to Red, got ${prev14}`);

      const out2 = join(root, 't2_out.mp4');
      const res2 = await tryOverlayHybridExport({
        state: st2,
        outputLocation: out2,
        codec: 'h264',
        allowCompatSpans: true,
        ffmpegExecutable: ffmpegExe,
        ffprobeExecutable: ffprobeExe,
        uploadsDirectory: upDir,
        assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.ok(res2, 'GIF timeline exports via overlay-hybrid');
      assert.equal(res2.compatFrames ?? 0, 0);
      const { data: fast2 } = decodeRgbFrames(out2, 320, 180);
      const exp2 = sampleRgbPixel(fast2, 320, 180, 3, 160, 90);
      const exp8 = sampleRgbPixel(fast2, 320, 180, 15, 160, 90);
      const exp14 = sampleRgbPixel(fast2, 320, 180, 27, 160, 90);
      assert.ok(exp2[1] > 180 && exp2[0] < 60 && exp2[2] < 60, `Fast export frame 3 shows Green matching SyncedGif, got ${exp2}`);
      assert.ok(exp8[2] > 180 && exp8[0] < 60 && exp8[1] < 60, `Fast export frame 15 shows Blue matching SyncedGif, got ${exp8}`);
      assert.ok(exp14[0] > 180 && exp14[1] < 60 && exp14[2] < 60, `Fast export frame 27 loops to Red matching SyncedGif, got ${exp14}`);
    }

    // ── Test 3: 1.5x split invariance + HTTP ffprobe-backed preflight match + visual/audio compat decoupling ──
    {
      console.log('[v0.50 verify] 3/5 Testing 1.5x video split invariance, /export/capabilities preflight & audio decoupling...');
      const src3 = join(upDir, 't3_15x.mp4');
      // 4s source @ 30fps: continuous RGB color changes + continuous 440Hz -> 880Hz audio sweep
      runFfmpeg([
        '-f', 'lavfi', '-i', 'nullsrc=s=320x180:r=30:d=4,format=rgb24,geq=r=clip(255*(1-T/4)\\,0\\,255):g=clip(255*abs(sin(T*2))\\,0\\,255):b=clip(255*(T/4)\\,0\\,255),format=yuv420p',
        '-f', 'lavfi', '-i', "aevalsrc='0.7*sin(2*PI*(440*t+55*t*t))':s=48000:d=4",
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', src3,
      ]);

      const unsplitState: any = {
        fps: 30, width: 320, height: 180, selectedId: null,
        trackOrder: ['V1'],
        tracks: { V1: { kind: 'video' } },
        items: [{
          id: 'v15', name: 'Speed15', kind: 'video', track: 'V1',
          startFrame: 0, durationInFrames: 30, srcInFrame: 0, playbackRate: 1.5,
          src: '/media/uploads/t3_15x.mp4', width: 320, height: 180, volume: 1,
        }],
      };
      const [left, right] = splitTimelineItem(unsplitState, unsplitState.items[0], 15, 'v15_r');
      assert.equal(right.srcInFrame, 22.5, '1.5x split at frame 15 yields fractional srcInFrame 22.5');
      const splitState: any = { ...unsplitState, items: [left, right] };

      const syncPre = analyzeExportRoutePreflight(splitState, 'h264', 30);
      assert.equal(syncPre.mode, 'fast');
      assert.equal(syncPre.compatFrames, 0);

      const httpCaps = await postCapabilities({ state: splitState, format: 'video', codec: 'h264', resolution: '1080p', fps: 30 });
      assert.equal(httpCaps.preflight.mode, 'fast');
      assert.equal(httpCaps.preflight.compatFrames, 0);
      assert.equal(httpCaps.preflight.probeStatus, 'probed');

      const outUnsplit = join(root, 't3_unsplit.mp4');
      const outSplit = join(root, 't3_split.mp4');
      const rA = await tryOverlayHybridExport({
        state: unsplitState, outputLocation: outUnsplit, codec: 'h264', allowCompatSpans: true,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      const rB = await tryOverlayHybridExport({
        state: splitState, outputLocation: outSplit, codec: 'h264', allowCompatSpans: true,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.equal(rA?.compatFrames ?? 0, 0);
      assert.equal(rB?.compatFrames ?? 0, 0);

      const rgbA = decodeRgbFrames(outUnsplit, 320, 180);
      const rgbB = decodeRgbFrames(outSplit, 320, 180);
      assert.equal(rgbA.count, 30);
      assert.equal(rgbB.count, 30);
      for (const f of [0, 5, 13, 14, 15, 16, 17, 25, 29]) {
        const pA = sampleRgbPixel(rgbA.data, 320, 180, f, 160, 90);
        const pB = sampleRgbPixel(rgbB.data, 320, 180, f, 160, 90);
        const diff = Math.max(Math.abs(pA[0] - pB[0]), Math.abs(pA[1] - pB[1]), Math.abs(pA[2] - pB[2]));
        assert.ok(diff <= 6, `Split video frame ${f} matches unsplit frame (${pA} vs ${pB})`);
      }

      const pcmA = decodePcmMono48k(outUnsplit);
      const pcmB = decodePcmMono48k(outSplit);
      for (const [t0, t1] of [[0.2, 0.45], [0.46, 0.54], [0.55, 0.85]] as const) {
        const sA = audioStatsWindow(pcmA, t0, t1);
        const sB = audioStatsWindow(pcmB, t0, t1);
        assert.ok(sB.peak > 4000, `Split audio active at ${t0}..${t1}s`);
        assert.ok(Math.abs(sA.hz - sB.hz) < 12, `Split audio frequency matches unsplit around cut ${t0}..${t1}s (${sA.hz.toFixed(1)}Hz vs ${sB.hz.toFixed(1)}Hz)`);
      }

      // Probe mismatch preflight check: timeline claims 240 frames (8s) on a 4s file!
      const overlongState = {
        ...unsplitState,
        items: [{ ...unsplitState.items[0], durationInFrames: 240, playbackRate: 1 }],
      };
      const overCaps = await postCapabilities({ state: overlongState, format: 'video', codec: 'h264', resolution: '1080p', fps: 30 });
      assert.equal(overCaps.preflight.mode, 'compat', 'ffprobe-backed preflight catches overflowing source duration');
      assert.ok(overCaps.preflight.reasons.includes('source-metadata'), `got reasons=${overCaps.preflight.reasons}`);

      // Visual-only compat audio decoupling check:
      const zoomState = {
        ...unsplitState,
        items: [{ ...unsplitState.items[0], playbackRate: 1, zoom: { magnification: 1.3 } }],
      };
      const zoomPlan = planOverlayHybridExport({ state: zoomState, allowCompatSpans: true });
      assert.equal(zoomPlan.eligible, false, 'single all-zoom clip uses compat');
      const twoClipZoom = {
        ...unsplitState,
        items: [
          { ...unsplitState.items[0], id: 'z1', durationInFrames: 30, playbackRate: 1, zoom: { magnification: 1.3 } },
          { ...unsplitState.items[0], id: 'v2', startFrame: 30, durationInFrames: 30, playbackRate: 1 },
        ],
      };
      const decoupledPlan = planOverlayHybridExport({ state: twoClipZoom, allowCompatSpans: true });
      assert.equal(decoupledPlan.eligible, true);
      assert.equal(decoupledPlan.compatSpans?.length, 1);
      assert.equal(decoupledPlan.compatSpans?.[0]?.compatAudio, false, 'visual zoom compat leaves companion audio on continuous 48kHz track');
      assert.equal(decoupledPlan.audioSegments?.length, 2);
    }

    // ── Test 4: Cross-FPS (24fps / 60fps) + VFR tail checks ──
    {
      console.log('[v0.50 verify] 4/5 Testing 24fps, 60fps, and VFR tail boundary handling...');
      const v24 = join(upDir, 't4_24fps.mp4');
      const v60 = join(upDir, 't4_60fps.mp4');
      const vfrP1 = join(root, 'vfr_15.mp4');
      const vfrP2 = join(root, 'vfr_60.mp4');
      const vVfr = join(upDir, 't4_vfr.mp4');
      runFfmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v24]);
      runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=60:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v60]);
      runFfmpeg(['-f', 'lavfi', '-i', 'color=c=orange:s=320x180:r=15:d=1', '-video_track_timescale', '90000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfrP1]);
      runFfmpeg(['-f', 'lavfi', '-i', 'color=c=purple:s=320x180:r=60:d=1', '-video_track_timescale', '90000', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vfrP2]);
      const vfrConcat = join(root, 'vfr_list.txt');
      await writeFile(vfrConcat, `file '${vfrP1.replace(/\\/g, '/')}'\nfile '${vfrP2.replace(/\\/g, '/')}'\n`, 'utf8');
      runFfmpeg(['-f', 'concat', '-safe', '0', '-i', vfrConcat, '-c', 'copy', vVfr]);

      // 24fps 2.0s clip -> 60 frames @ 30fps must SUCCEED natively!
      const st24: any = {
        fps: 30, width: 320, height: 180, selectedId: null,
        trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
        items: [{ id: 'c24', name: '24p', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 60, srcInFrame: 0, src: '/media/uploads/t4_24fps.mp4', width: 320, height: 180 }],
      };
      const out24 = join(root, 't4_out24.mp4');
      const res24 = await tryOverlayHybridExport({
        state: st24, outputLocation: out24, codec: 'h264', allowCompatSpans: false,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.ok(res24, '24fps 2.0s source fits cleanly in 60f@30fps timeline');
      assert.equal(decodeRgbFrames(out24, 320, 180).count, 60);

      // 60fps 2.0s clip (`nb_frames=120`) trimmed to 75 frames @ 30fps (2.5s > 2.0s) must be REJECTED cleanly!
      const st60Bad: any = {
        ...st24,
        items: [{ id: 'c60', name: '60p', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 75, srcInFrame: 0, src: '/media/uploads/t4_60fps.mp4', width: 320, height: 180 }],
      };
      let declined60: string | undefined;
      const insp60 = await inspectOverlayHybridExport({
        state: st60Bad, allowCompatSpans: false,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
      }, { onDecline: (r: string) => { declined60 = r; } });
      assert.equal(insp60, null, '60fps source tail overflow beyond real duration is caught');
      assert.equal(declined60, 'source-metadata');

      // VFR 2.0s clip -> 60 CFR frames @ 30fps must export cleanly and show orange -> purple!
      const vfrMeta = probeJson(vVfr);
      const vfrStream = vfrMeta.streams?.find((s: any) => s.codec_type === 'video');
      assert.notEqual(vfrStream?.avg_frame_rate, vfrStream?.r_frame_rate, 'VFR fixture truly has avg_frame_rate != r_frame_rate');
      const stVfr: any = {
        ...st24,
        items: [{ id: 'cvfr', name: 'vfr', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 60, srcInFrame: 0, src: '/media/uploads/t4_vfr.mp4', width: 320, height: 180 }],
      };
      const outVfr = join(root, 't4_outVfr.mp4');
      const resVfr = await tryOverlayHybridExport({
        state: stVfr, outputLocation: outVfr, codec: 'h264', allowCompatSpans: false,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.ok(resVfr, 'VFR source exports cleanly on hybrid CFR resample path');
      const vfrRgb = decodeRgbFrames(outVfr, 320, 180);
      assert.equal(vfrRgb.count, 60);
      const pxEarly = sampleRgbPixel(vfrRgb.data, 320, 180, 10, 160, 90);
      const pxLate = sampleRgbPixel(vfrRgb.data, 320, 180, 45, 160, 90);
      assert.ok(pxEarly[0] > 180 && pxEarly[1] > 100 && pxEarly[2] < 40, `VFR early half is orange, got ${pxEarly}`);
      assert.ok(pxLate[0] > 80 && pxLate[2] > 80 && pxLate[1] < 40, `VFR second half is purple, got ${pxLate}`);
    }

    // ── Test 5: volume: 0 + linear positive keyframes.volume ──
    {
      console.log('[v0.50 verify] 5/5 Testing volume=0 + positive keyframes.volume...');
      const vAudio = join(upDir, 't5_sine.mp4');
      runFfmpeg([
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', vAudio,
      ]);
      const st5: any = {
        fps: 30, width: 320, height: 180, selectedId: null,
        trackOrder: ['V1'], tracks: { V1: { kind: 'video' } },
        items: [{
          id: 'va', name: 'Vol0Kf', kind: 'video', track: 'V1',
          startFrame: 0, durationInFrames: 30, srcInFrame: 0,
          src: '/media/uploads/t5_sine.mp4', width: 320, height: 180,
          volume: 0,
          keyframes: {
            volume: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 30, value: 1, easing: 'linear' },
            ],
          },
        }],
      };
      assert.equal(volumeAtFrame(st5.items[0], 0), 0);
      assert.equal(volumeAtFrame(st5.items[0], 30), 1);
      assert.equal(hasPotentialClipAudio(st5.items[0]), true);

      const out5 = join(root, 't5_out.mp4');
      const res5 = await tryOverlayHybridExport({
        state: st5, outputLocation: out5, codec: 'h264', allowCompatSpans: true,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.ok(res5);
      const out5Ref = join(root, 't5_ref.mp4');
      const refState: any = {
        ...st5,
        items: [{
          id: 'va_ref', name: 'Vol1Ref', kind: 'video', track: 'V1',
          startFrame: 0, durationInFrames: 30, srcInFrame: 0,
          src: '/media/uploads/t5_sine.mp4', width: 320, height: 180,
          volume: 1,
        }],
      };
      const res5Ref = await tryOverlayHybridExport({
        state: refState, outputLocation: out5Ref, codec: 'h264', allowCompatSpans: true,
        ffmpegExecutable: ffmpegExe, ffprobeExecutable: ffprobeExe, uploadsDirectory: upDir, assetsDirectory: resolve('assets'),
        renderOverlayPlates: makeRenderOverlayPlates(),
      });
      assert.ok(res5Ref);

      const pcm5 = decodePcmMono48k(out5);
      const pcm5Ref = decodePcmMono48k(out5Ref);
      const early = audioStatsWindow(pcm5, 0.0, 0.12);
      const late = audioStatsWindow(pcm5, 0.8, 0.98);
      const refLate = audioStatsWindow(pcm5Ref, 0.8, 0.98);
      assert.ok(early.rms < late.rms * 0.25, `Early volume=0 keyframe start is quiet (early=${early.rms.toFixed(0)}, late=${late.rms.toFixed(0)})`);
      assert.ok(
        late.rms > 1200 && late.rms > refLate.rms * 0.78 && late.rms < refLate.rms * 1.05 && Math.abs(late.hz - 440) < 25,
        `Late keyframe ramp reaches full ~440Hz audio (${JSON.stringify(late)}, ref=${JSON.stringify(refLate)})`,
      );
    }

    console.log('[verify] ALL 5 shared-rules v0.5.0 real-content tests PASSED');
  } finally {
    if (sharedBrowser) await (sharedBrowser as any).close({ silent: true }).catch(() => {});
  }
} finally {
  if (http) http.close();
  try {
    const bundleUploads = join(prebuiltBundle, 'media', 'uploads');
    const defaultUploads = resolve('public/media/uploads');
    await mkdir(defaultUploads, { recursive: true });
    await rm(bundleUploads, { recursive: true, force: true });
    await symlink(defaultUploads, bundleUploads, 'junction');
  } catch {}
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
