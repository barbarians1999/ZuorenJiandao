// Shared server-side render pipeline: bundle → selectComposition → renderMedia.
// Used by the server export endpoint and Electron packaging.
// Headless Lambda-style render: templates are compiled
// at render time in headless Chrome exactly as the Player does, so audio muxes
// natively and no template porting is needed.
import { openBrowser, RenderInternals, selectComposition, renderFrames, renderMedia, renderStill } from '@remotion/renderer';
import path from 'node:path';
import { cp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  h264FfmpegOverride,
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveRenderMemorySettings,
  renderFfmpegOverride,
  withEncoderProfileFallback,
} from './performance.mjs';
import { renderDirectHardware } from './direct-hardware.mjs';
import { assertMaterializedRenderSnapshot, normalizeH264Profile, timelineStillOptions } from './render-contract.mjs';
import { resolveRenderTimeout } from './render-timeout.mjs';
import { browserExecutable, resolveRenderGlBackend, withAbortableCompositionSelection } from './render-browser.mjs';
import { nativeOpaqueVideoSources, nativeVideoExperimentEnabled } from './native-video.mjs';
import { tryDirectCutExport, inspectDirectCutExport } from './direct-cut.mjs';
import { buildSparseOverlayPlan, inspectOverlayHybridExport, tryOverlayHybridExport } from './overlay-hybrid.mjs';
import { localVideoPath } from './native-video.mjs';
import { summarizeExportPreflight } from '../shared/export-route-plan.mjs';
import { binariesDirectory, currentRenderConcurrency, remotionFfmpegPath, remotionCancelSignal } from './render-runtime.mjs';

export { assertMaterializedRenderSnapshot } from './render-contract.mjs';
export { withAbortableCompositionSelection } from './render-browser.mjs';
export { currentRenderConcurrency, remotionFfmpegPath };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINT = path.join(REPO_ROOT, 'remotion', 'index.ts');
/** Product-bundled static files (fonts, thumbs, SFX, …) — NOT user uploads. */
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
/** User/runtime media root (only media/uploads under public/). */
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'media', 'uploads');
const COMPOSITION_ID = 'timeline';
const renderTimeoutInMilliseconds = () => resolveRenderTimeout();

// Bundling is expensive (webpack over the whole app + @babel/standalone), so we
// build the serve bundle once and reuse the serveUrl across every render.
let bundlePromise;

// Desktop packaging version: There is no src/ source code and webpack at runtime, and the serve bundle is pre-packaged during the packaging period.
function directHardwareRenderer(directBinaries, abortSignal) {
  // Both hardware and software H.264 need the same PCM clock: a software retry
  // must not bring back compressed-audio priming shifts. Other codecs are unchanged.
  const muxBinaries = directBinaries ?? path.dirname(remotionFfmpegPath());
  return (attempt) => attempt.codec === 'h264'
    ? renderDirectHardware({ render: renderMedia, options: attempt, binariesDirectory: muxBinaries, signal: abortSignal })
    : renderMedia(attempt);
}

/** Render with the selected probed engine, then make a truthful software retry. */
async function renderMediaOptimized(options) {
  const { abortSignal, h264Profile, vaapiDevice, offthreadVideoThreads: configuredOffthreadVideoThreads, ...renderOptions } = options;
  const profile = normalizeH264Profile(renderOptions.codec, h264Profile);
  const hardwareAcceleration = remotionHardwareAcceleration(renderOptions.codec, { encoder: profile?.id });
  const customOverride = profile?.hardware && hardwareAcceleration === 'disable'
    ? h264FfmpegOverride(profile.id, { vaapiDevice })
    : undefined;
  const directBinaries = customOverride ? binariesDirectory() : null;
  const automaticBitrate = profile?.hardware && !renderOptions.videoBitrate
    ? resolveH264VideoBitrate({
      width: renderOptions.composition.width,
      height: renderOptions.composition.height,
      fps: renderOptions.composition.fps,
      scale: renderOptions.scale ?? 1,
    })
    : null;
  const memorySettings = resolveRenderMemorySettings();
  const hardwareOverride = renderFfmpegOverride({ hardwareOverride: customOverride });
  const softwareOverride = renderFfmpegOverride();
  const hardwareOptions = {
    ...renderOptions,
    concurrency: currentRenderConcurrency(),
    offthreadVideoCacheSizeInBytes: renderOptions.offthreadVideoCacheSizeInBytes ?? memorySettings.offthreadVideoCacheSizeInBytes,
    mediaCacheSizeInBytes: renderOptions.mediaCacheSizeInBytes ?? memorySettings.mediaCacheSizeInBytes,
    offthreadVideoThreads: configuredOffthreadVideoThreads ?? memorySettings.offthreadVideoThreads,
    hardwareAcceleration,
    ffmpegOverride: hardwareOverride,
    // The packaged app cannot chmod or spawn the compositor inside app.asar, so every
    // attempt renders from the mirrored directory (CC_REMOTION_BINARIES_DIR); dev keeps null.
    binariesDirectory: binariesDirectory(),
    ...(automaticBitrate ? { videoBitrate: automaticBitrate } : {}),
  };
  const render = directHardwareRenderer(directBinaries, abortSignal);
  if (!profile) return { result: await render(hardwareOptions), encoder: undefined };
  return withEncoderProfileFallback({
    render,
    signal: abortSignal,
    hardwareOptions,
    softwareOptions: {
      ...hardwareOptions,
      hardwareAcceleration: 'disable',
      ffmpegOverride: softwareOverride,
      ...(automaticBitrate ? { videoBitrate: null } : {}),
    },
    hardwareProfile: profile,
    cleanup: async () => {
      if (renderOptions.outputLocation) {
        await rm(renderOptions.outputLocation, { force: true }).catch(() => {});
      }
    },
    onFallback: (error) => {
      console.warn(`[render] ${profile.label} failed; retrying ${renderOptions.codec} with software encoding; original error: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
}

// The asset directory defaults to public/media/uploads; the dev server side can be customized by MEDIA_DIR——
// server/plugins/export injects provider (read keystore). The standalone script remains the default.
let uploadsDirProvider = () => UPLOAD_DIR;
let linkedDir = null; // <serveUrl>/media/uploads symlink currently points to; reconnect when the directory changes

async function nativeVideoInput(state, project, signal) {
  if (!nativeVideoExperimentEnabled()) return { _nativeOpaqueVideoSources: [] };
  const ffprobeExecutable = RenderInternals.getExecutablePath({ type: 'ffprobe', indent: false,
    logLevel: 'error', binariesDirectory: binariesDirectory() });
  return { _nativeOpaqueVideoSources: await nativeOpaqueVideoSources(state, project, {
    uploadsDirectory: uploadsDirProvider(), assetsDirectory: ASSETS_DIR, ffprobeExecutable, signal,
  }) };
}

/** @param {() => string} fn returns the absolute path of the current asset directory*/
export function setUploadsDirProvider(fn) { uploadsDirProvider = fn; }

/** Read-only eligibility + ffprobe-backed preflight summary for UI route selection. */
export async function inspectTimelineExportCapabilities(options) {
  const uploadsDirectory = uploadsDirProvider();
  const allowDirectCut = options.allowDirectCut !== false;
  let hasUnresolvedMedia = false;
  for (const item of options.state?.items ?? []) {
    if (!item || options.state?.tracks?.[item.track]?.hidden || item.pictureDisabled === true) continue;
    if ((item.kind === 'video' || item.kind === 'audio' || item.kind === 'gif') && typeof item.src === 'string' && item.src) {
      if (!localVideoPath(item.src, uploadsDirectory, ASSETS_DIR) && !options.resolveMediaSource?.(item.src)) {
        hasUnresolvedMedia = true;
      }
    }
  }
  const direct = allowDirectCut ? await inspectDirectCutExport({
    ...options,
    allowTextWindows: true,
    uploadsDirectory,
    assetsDirectory: ASSETS_DIR,
  }) : null;
  let hybridDeclineReason;
  const hybrid = !direct && options.codec === 'h264'
    ? await inspectOverlayHybridExport({
      ...options,
      scale: options.scale ?? 1,
      allowCompatSpans: true,
      uploadsDirectory,
      assetsDirectory: ASSETS_DIR,
    }, { onDecline: (reason) => { hybridDeclineReason = reason; } })
    : null;
  const renderRoute = direct
    ? (direct.plan.renderRoute ?? 'direct-cut')
    : hybrid
      ? (hybrid.plan.renderRoute ?? 'hybrid')
      : null;
  const preflight = summarizeExportPreflight({
    state: options.state,
    project: options.project,
    timelineId: options.timelineId,
    codec: options.codec,
    fps: options.fps ?? options.state?.fps ?? 30,
    frameRange: options.frameRange,
    scale: options.scale ?? 1,
    ...(direct
      ? {
        hybridPlan: {
          eligible: true,
          compatFrames: 0,
          compatSpans: [],
          compatReasons: [],
          frames: direct.plan.totalFrames,
        },
      }
      : hybrid
        ? { hybridPlan: hybrid.plan }
        : { hybridPlan: null, fallbackReason: hybridDeclineReason }),
    probeStatus: hasUnresolvedMedia ? 'pending-media' : 'probed',
  });
  return { renderRoute, preflight };
}

/** Read-only eligibility for UI route selection; render rechecks the snapshot. */
export async function inspectTimelineDirectExport(options) {
  const { renderRoute } = await inspectTimelineExportCapabilities(options);
  return renderRoute;
}

async function buildServeUrl() {
  const serveUrl = await buildBundle(undefined);
  // Live-link runtime uploads: push_asset / upload / paste / image-gen write files
  // AFTER this one-time snapshot, and a stale snapshot makes the headless renderer
  // 404 them (stills come out blank; <video> decodes the 404 page as
  // MEDIA_ELEMENT_ERROR). Replace the snapshot dir with a symlink to the real
  // uploads dir so every render sees the live files — no per-render copying.
  await relinkUploads(serveUrl);
  return serveUrl;
}

/** webpack hits the serve bundle + public override (not relink - that's a runtime responsibility).*/
async function buildBundle(outDir) {
  // Installed builds use the prebuilt bundle; webpack is a development dependency.
  const { bundle } = await import('@remotion/bundler');
  const serveUrl = await bundle({
    entryPoint: ENTRY_POINT,
    // Product static at assets/ (same URL paths as before when under public/).
    publicDir: ASSETS_DIR,
    ...(outDir ? { outDir } : {}),
    // GLSL shaders are imported as strings via Vite's `?raw`; teach the export
    // bundle's webpack the same trick (asset/source = raw text module).
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: {
          ...config.resolve?.extensionAlias,
          '.js': ['.js', '.ts', '.tsx'],
        },
      },
      module: {
        ...config.module,
        rules: [...(config.module?.rules ?? []), { test: /\.frag$/, type: 'asset/source' }],
      },
    }),
  });
  // Remotion copies publicDir under serveUrl/public; app uses root-absolute
  // paths (/fonts, /audio, …) like Vite — overlay product assets at serve root.
  await cp(ASSETS_DIR, serveUrl, { recursive: true });
  // User uploads live separately under public/media/uploads (or MEDIA_DIR);
  // relinkUploads() points serveUrl/media/uploads at the live upload dir.
  return serveUrl;
}

/** During the packaging period, pre-load serve bundle to outDir (desktop/prebuild-remotion.mts).*/
export async function prebuildServeBundle(outDir) {
  await rm(outDir, { recursive: true, force: true });
  return buildBundle(outDir);
}

// Point <serveUrl>/media/uploads to the current asset directory (default or MEDIA_DIR custom).
async function relinkUploads(serveUrl) {
  const dir = uploadsDirProvider();
  await mkdir(dir, { recursive: true });
  const linkPath = path.join(serveUrl, 'media', 'uploads');
  try {
    await rm(linkPath, { recursive: true, force: true });
    // Win32 uses junction: the directory soft link requires administrator/developer mode, junction is privilege-free (requires absolute path, dir is always absolute)
    await symlink(dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    uploadsLive = true;
    linkedDir = dir;
  } catch {
    uploadsLive = false; // symlink unavailable → getServeUrl falls back to per-call copy
  }
}

// True when <serveUrl>/media/uploads is a symlink to the live uploads dir.
let uploadsLive = false;

// Return the cached serve bundle. Normal path: uploads are symlinked (live), nothing to
// sync. Fallback (no symlink support): re-copy the uploads dir on each call so runtime
// uploads still render, at the old per-render copy cost.
async function getServeUrl() {
  if (!bundlePromise) {
    const prebuilt = process.env.CC_REMOTION_BUNDLE;
    bundlePromise = prebuilt
      ? relinkUploads(prebuilt).then(() => prebuilt)  // Pre-bundle: skip webpack and only take over uploads
      : buildServeUrl();
  }
  const serveUrl = await bundlePromise;
  const dir = uploadsDirProvider();
  if (uploadsLive && dir !== linkedDir) {
    await relinkUploads(serveUrl); // MEDIA_DIR changes during runtime (the normal path is.env change→machine restart)
  }
  if (!uploadsLive) {
    await mkdir(dir, { recursive: true }); // ensure exists: cp must never ENOENT-race
    await cp(dir, path.join(serveUrl, 'media', 'uploads'), { recursive: true });
  }
  return serveUrl;
}

/**
 * Render a timeline state to video or audio at outputLocation.
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {import('../src/editor/types').ProjectDoc} [args.project]
 * @param {string} [args.timelineId]
 * @param {string} args.outputLocation  absolute output path
 * @param {'h264'|'vp8'|'prores'|'mp3'|'wav'} [args.codec]
 * @param {[number, number]} [args.frameRange] inclusive Remotion frame range
 * @param {number} [args.videoBitrate] video bitrate in bits per second
 * @param {{id:string,label:string,hardware:boolean,transport:'server'}} [args.h264Profile]
 * @param {string} [args.vaapiDevice]
 * @param {(progress: number) => void} [args.onProgress]  0..1
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.offthreadVideoCacheSizeInBytes] Optional bounded render cache.
 * @param {number} [args.mediaCacheSizeInBytes] Optional browser media cache.
 * @param {number} [args.offthreadVideoThreads] Optional OffthreadVideo decoder limit.
 * @param {string} [args.separateAudioTo] Internal diagnostic PCM sidecar; normal exports keep muxed audio.
 */
async function renderOverlayPlates({ overlayState, plan, platesDir, onPhaseProgress, signal }) {
  if (!plan.hasOverlays) {
    return {
      spans: [{ from: plan.rangeStart, to: plan.rangeEnd, sampleFrame: null }],
      plateFiles: new Map(),
    };
  }
  const excludeRanges = (plan.compatSpans ?? []).map((s) => [s.from, s.to]);
  if (!plan.hasCaptions) {
    const precomputed = buildSparseOverlayPlan(overlayState, plan.rangeStart, plan.rangeEnd, null, excludeRanges);
    if (!precomputed.framesToRender.length) {
      return { spans: precomputed.spans, plateFiles: new Map() };
    }
  }
  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const baseInputProps = { state: overlayState, transparent: true, ...await nativeVideoInput(overlayState, undefined, signal) };
  const selectionInputProps = plan.hasCaptions
    ? { ...baseInputProps, __collectOverlaySpans: { rangeStart: plan.rangeStart, rangeEnd: plan.rangeEnd } }
    : baseInputProps;
  const cancelSignal = remotionCancelSignal(signal);
  return withAbortableCompositionSelection({
    signal,
    selectionOptions: {
      serveUrl,
      id: COMPOSITION_ID,
      inputProps: selectionInputProps,
      ...resolveRenderMemorySettings(),
      binariesDirectory: binariesDirectory(),
      browserExecutable: browserExecutable(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    },
    run: async (composition, browser) => {
      const captionSummary = plan.hasCaptions ? composition.props?.__overlayCaptionInfo ?? null : null;
      const { spans, framesToRender } = buildSparseOverlayPlan(overlayState, plan.rangeStart, plan.rangeEnd, captionSummary, excludeRanges);
      const plateFiles = new Map();
      if (!framesToRender.length) return { spans, plateFiles };

      const overlayConcurrency = framesToRender.length >= 20
        ? Math.max(currentRenderConcurrency(), 6)
        : currentRenderConcurrency();
      await renderFrames({
        serveUrl,
        composition,
        inputProps: baseInputProps,
        frames: framesToRender,
        outputDir: platesDir,
        imageFormat: 'png',
        imageSequencePattern: 'plate-[frame].[ext]',
        muted: true,
        concurrency: overlayConcurrency,
        chromiumOptions: { gl: resolveRenderGlBackend() },
        browserExecutable: browserExecutable(),
        puppeteerInstance: browser,
        binariesDirectory: binariesDirectory(),
        cancelSignal,
        timeoutInMilliseconds: renderTimeoutInMilliseconds(),
        onStart: () => {},
        onFrameUpdate: (rendered) => onPhaseProgress?.(rendered, framesToRender.length),
      });
      signal?.throwIfAborted();
      for (const name of await readdir(platesDir)) {
        const match = /^plate-(\d+)\.png$/i.exec(name);
        if (match) plateFiles.set(Number(match[1]), path.join(platesDir, name));
      }
      return { spans, plateFiles };
    },
  });
}

export async function renderTimeline({
  state,
  project,
  timelineId,
  outputLocation,
  onProgress,
  onProgressStage,
  codec = 'h264',
  frameRange,
  scale,
  videoBitrate,
  h264Profile,
  vaapiDevice,
  signal,
  offthreadVideoCacheSizeInBytes,
  mediaCacheSizeInBytes,
  offthreadVideoThreads,
  separateAudioTo,
  directMediaBinaries,
  disableFastExport = false,
  muted = false,
}) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.items)) {
    throw new Error('renderTimeline: a valid TimelineState (with items[]) is required');
  }
  if (!outputLocation) throw new Error('renderTimeline: outputLocation is required');
  if (offthreadVideoThreads !== undefined
    && (!Number.isInteger(offthreadVideoThreads) || offthreadVideoThreads < 1 || offthreadVideoThreads > 8)) {
    throw new Error('renderTimeline: offthreadVideoThreads must be an integer from 1 to 8');
  }
  signal?.throwIfAborted();
  assertMaterializedRenderSnapshot(state, 'renderTimeline');
  if (project) assertMaterializedRenderSnapshot(project, 'renderTimeline', timelineId);
  const startedAt = Date.now();
  let directCutDeclined;
  let hybridDeclined;
  const logExportSummary = (diagnostics, encoder) => {
    const t = diagnostics.timingsMs ?? {};
    const parts = [`route=${diagnostics.route}`, `encoder=${encoder?.id ?? 'default'}`, `totalMs=${t.total ?? 0}`];
    if (t.plates !== undefined) parts.push(`platesMs=${t.plates}`);
    if (t.encode !== undefined) parts.push(`encodeMs=${t.encode}`);
    if (t.audio !== undefined) parts.push(`audioMs=${t.audio}`);
    if (t.mux !== undefined) parts.push(`muxMs=${t.mux}`);
    if (diagnostics.workers !== undefined) parts.push(`workers=${diagnostics.workers}${diagnostics.concurrencyFallback ? '(fallback)' : ''}`);
    if (diagnostics.fallbackReasons?.directCut) parts.push(`directDeclined=${diagnostics.fallbackReasons.directCut}`);
    if (diagnostics.fallbackReasons?.hybrid) parts.push(`hybridDeclined=${diagnostics.fallbackReasons.hybrid}`);
    console.info(`[render] export summary: ${parts.join(' ')}`);
  };

  const direct = !disableFastExport && await tryDirectCutExport({
    state, project, timelineId, outputLocation, onProgress, codec, frameRange, scale,
    videoBitrate, h264Profile: directMediaBinaries?.profile ?? h264Profile, vaapiDevice, signal, separateAudioTo,
    uploadsDirectory: uploadsDirProvider(), assetsDirectory: ASSETS_DIR,
    allowTextWindows: true,
    renderVisualRange: (range, file, guardedSignal) => renderTimeline({ state, project, timelineId,
      outputLocation: file, codec: 'h264', frameRange: range, scale, videoBitrate,
      h264Profile, vaapiDevice, signal: guardedSignal, offthreadVideoCacheSizeInBytes, mediaCacheSizeInBytes,
      offthreadVideoThreads, disableFastExport: true }),
    ffmpegExecutable: directMediaBinaries?.ffmpeg,
    resolveMediaSource: directMediaBinaries?.resolveSource,
    ffprobeExecutable: directMediaBinaries?.ffprobe ?? RenderInternals.getExecutablePath({ type: 'ffprobe', indent: false,
      logLevel: 'error', binariesDirectory: binariesDirectory() }),
  }, { onDecline: (reason) => { directCutDeclined = reason; } });
  if (direct) {
    const diagnostics = {
      route: direct.renderRoute ?? 'direct-cut',
      timingsMs: direct.timingsMs ?? { total: Date.now() - startedAt },
      ...(direct.totalFrames !== undefined ? { totalFrames: direct.totalFrames } : {}),
    };
    logExportSummary(diagnostics, direct.encoder);
    return { ...direct, diagnostics };
  }
  const hybridOverlay = !disableFastExport && await tryOverlayHybridExport({
    state,
    project,
    timelineId,
    outputLocation,
    onProgress,
    onProgressStage,
    codec,
    frameRange,
    scale: scale ?? 1,
    allowCompatSpans: true,
    videoBitrate,
    h264Profile: directMediaBinaries?.profile ?? h264Profile,
    vaapiDevice,
    signal,
    separateAudioTo,
    uploadsDirectory: uploadsDirProvider(),
    assetsDirectory: ASSETS_DIR,
    renderOverlayPlates,
    renderCompatRange: async ({
      frameRange: compatRange,
      outputPath: compatOut,
      includeAudio,
      h264Profile: compatProfile,
      signal: compatSignal,
    }) => {
      await renderTimeline({
        state,
        project,
        timelineId,
        outputLocation: compatOut,
        codec: 'h264',
        frameRange: compatRange,
        scale: scale ?? 1,
        videoBitrate,
        h264Profile: compatProfile ?? directMediaBinaries?.profile ?? h264Profile,
        vaapiDevice,
        signal: compatSignal,
        muted: !includeAudio,
        offthreadVideoCacheSizeInBytes,
        mediaCacheSizeInBytes,
        offthreadVideoThreads,
        disableFastExport: true,
      });
    },
    ffmpegExecutable: directMediaBinaries?.ffmpeg,
    resolveMediaSource: directMediaBinaries?.resolveSource,
    ffprobeExecutable: directMediaBinaries?.ffprobe ?? RenderInternals.getExecutablePath({ type: 'ffprobe', indent: false,
      logLevel: 'error', binariesDirectory: binariesDirectory() }),
  }, { onDecline: (reason) => { hybridDeclined = reason; } });
  if (hybridOverlay) {
    const diagnostics = {
      route: 'hybrid',
      ...(hybridOverlay.hybridMode ? { hybridMode: hybridOverlay.hybridMode } : {}),
      ...(hybridOverlay.compatFrames ? { compatFrames: hybridOverlay.compatFrames } : {}),
      ...(hybridOverlay.compatReasons?.length ? { compatReasons: hybridOverlay.compatReasons } : {}),
      ...(directCutDeclined ? { fallbackReasons: { directCut: directCutDeclined } } : {}),
      timingsMs: hybridOverlay.timingsMs ?? { total: Date.now() - startedAt },
      ...(hybridOverlay.workers !== undefined ? { workers: hybridOverlay.workers } : {}),
      ...(hybridOverlay.concurrencyFallback !== undefined ? { concurrencyFallback: hybridOverlay.concurrencyFallback } : {}),
      ...(hybridOverlay.plateCount !== undefined ? { plateCount: hybridOverlay.plateCount } : {}),
      ...(hybridOverlay.totalFrames !== undefined ? { totalFrames: hybridOverlay.totalFrames } : {}),
    };
    logExportSummary(diagnostics, hybridOverlay.encoder);
    return { ...hybridOverlay, diagnostics };
  }
  const cancelSignal = remotionCancelSignal(signal);

  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const inputProps = { state, project, timelineId, ...await nativeVideoInput(state, project, signal) };
  // Full-timeline mezzanine: ProRes 422 HQ (not 4444 alpha — that is clip/MG only).
  const proresOptions = codec === 'prores'
    ? { proResProfile: 'hq', imageFormat: 'png' }
    : {};
  const rendered = await withAbortableCompositionSelection({
    signal,
    selectionOptions: {
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      binariesDirectory: binariesDirectory(),
      browserExecutable: browserExecutable(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    },
    run: (composition, browser) => renderMediaOptimized({
      serveUrl,
      composition,
      codec,
      frameRange,
      inputProps,
      outputLocation,
      h264Profile,
      vaapiDevice,
      offthreadVideoCacheSizeInBytes,
      mediaCacheSizeInBytes,
      offthreadVideoThreads,
      separateAudioTo,
      ...(muted ? { muted: true } : {}),
      scale: scale && Number.isFinite(scale) && scale > 0 ? scale : 1,
      videoBitrate: codec === 'prores'
        ? undefined
        : Number.isFinite(videoBitrate) && videoBitrate > 0
          ? `${Math.round(videoBitrate / 1000)}k`
          : undefined,
      ...proresOptions,
      chromiumOptions: { gl: resolveRenderGlBackend() },
      browserExecutable: browserExecutable(),
      puppeteerInstance: browser,
      onProgress: onProgress ? ({ progress }) => onProgress(progress) : undefined,
      cancelSignal,
      abortSignal: signal,
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    }),
  });
  signal?.throwIfAborted();
  const fallbackReasons = {
    ...(directCutDeclined ? { directCut: directCutDeclined } : {}),
    ...(hybridDeclined ? { hybrid: hybridDeclined } : {}),
  };
  const diagnostics = {
    route: 'remotion',
    ...(Object.keys(fallbackReasons).length ? { fallbackReasons } : {}),
    timingsMs: { total: Date.now() - startedAt },
  };
  logExportSummary(diagnostics, rendered.encoder);
  return {
    outputLocation,
    ...(rendered.encoder ? { encoder: rendered.encoder } : {}),
    ...(rendered.encoderFallbackReason
      ? { encoderFallbackReason: rendered.encoderFallbackReason }
      : {}),
    diagnostics,
  };
}

/**
 * Render a single-clip sub-timeline to a video, optionally with alpha over a
 * transparent background (export MG animation = ProRes 4444 alpha; convert to video =
 * bake to an alpha webm). `state` should be a one-item timeline (item at frame 0).
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {string} args.outputLocation
 * @param {'prores'|'vp8'|'h264'} [args.codec]
 * @param {boolean} [args.transparent]  render over transparency + carry alpha
 */
export async function renderClip({
  state,
  outputLocation,
  codec = 'vp8',
  transparent = true,
  h264Profile,
  vaapiDevice,
  signal,
}) {
  if (!state || !Array.isArray(state.items) || !state.items.length) {
    throw new Error('renderClip: a single-item TimelineState is required');
  }
  if (!outputLocation) throw new Error('renderClip: outputLocation is required');
  signal?.throwIfAborted();
  assertMaterializedRenderSnapshot(state, 'renderClip');
  const cancelSignal = remotionCancelSignal(signal);
  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const inputProps = { state, transparent, ...await nativeVideoInput(state, undefined, signal) };
  await withAbortableCompositionSelection({
    signal,
    selectionOptions: {
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
      binariesDirectory: binariesDirectory(),
      browserExecutable: browserExecutable(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    },
    run: (composition, browser) => renderMediaOptimized({
      serveUrl,
      composition,
      codec,
      inputProps,
      outputLocation,
      h264Profile,
      vaapiDevice,
      ...(transparent && codec === 'prores'
        ? { proResProfile: '4444', imageFormat: 'png', pixelFormat: 'yuva444p10le' }
        : {}),
      chromiumOptions: { gl: resolveRenderGlBackend() },
      browserExecutable: browserExecutable(),
      puppeteerInstance: browser,
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
      cancelSignal,
      abortSignal: signal,
    }),
  });
  signal?.throwIfAborted();
  return outputLocation;
}

/**
 * Render still frames of a timeline as small JPEGs (backs view_timeline_frames
 * — the agent "sees" its own draft edits). Returns [{frame, base64}].
 * Internal visual audits may request fullResolution without changing MCP defaults.
 * @param {object} args
 * @param {import('../src/editor/types').TimelineState} args.state
 * @param {number[]} args.frames  frame numbers to render
 * @param {boolean} [args.fullResolution] Render native composition pixels for visual audits.
 * @param {unknown} [args.puppeteerInstance] Reused headless browser (when rendering thumbnails in batches
 *   Every cold start of Chrome is too slow); the caller passes in openBrowser once and closes it after use.
 * @param {AbortSignal} [args.signal]
 */
/** Cap stills per call (contact-sheet path further compresses into one image). */
const STILL_MAX_FRAMES = 16;

export async function renderTimelineStills({
  state,
  project,
  timelineId,
  frames,
  puppeteerInstance,
  signal,
  fullResolution = false,
}) {
  if (!state || !Array.isArray(state.items)) throw new Error('renderTimelineStills: state.items required');
  if (!Array.isArray(frames) || !frames.length) throw new Error('renderTimelineStills: frames[] required');
  if (typeof fullResolution !== 'boolean') throw new TypeError('fullResolution must be a boolean');
  signal?.throwIfAborted();
  assertMaterializedRenderSnapshot(state, 'renderTimelineStills');
  if (project) assertMaterializedRenderSnapshot(project, 'renderTimelineStills', timelineId);
  const serveUrl = await getServeUrl();
  signal?.throwIfAborted();
  const inputProps = { state, project, timelineId, ...await nativeVideoInput(state, project, signal) };
  // Reuse one browser for the batch when caller doesn't pass one — opening Chrome
  // per frame was the dominant cost of view_*_frames.
  const ownBrowser = !puppeteerInstance;
  const browser = puppeteerInstance ?? await openBrowser('chrome', {
    browserExecutable: browserExecutable(),
    chromiumOptions: { gl: resolveRenderGlBackend() },
  });
  const closeOnAbort = () => {
    if (ownBrowser) void browser.close({ silent: true }).catch(() => undefined);
  };
  signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const composition = await selectComposition({
      serveUrl, id: COMPOSITION_ID, inputProps,
      ...resolveRenderMemorySettings(),
      puppeteerInstance: browser,
      browserExecutable: browserExecutable(),
      binariesDirectory: binariesDirectory(),
      timeoutInMilliseconds: renderTimeoutInMilliseconds(),
    });
    signal?.throwIfAborted();
    const out = [];
    const list = frames.slice(0, STILL_MAX_FRAMES);
    for (const frame of list) {
      signal?.throwIfAborted();
      const f = Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(frame)));
      const { buffer } = await renderStill({
        serveUrl, composition, inputProps, frame: f,
        imageFormat: 'jpeg',
        ...timelineStillOptions({ width: composition.width, frameCount: list.length, fullResolution }),
        chromiumOptions: { gl: resolveRenderGlBackend() },
        browserExecutable: browserExecutable(),
        binariesDirectory: binariesDirectory(),
        ...resolveRenderMemorySettings(),
        output: null,
        puppeteerInstance: browser,
        timeoutInMilliseconds: renderTimeoutInMilliseconds(),
      });
      signal?.throwIfAborted();
      out.push({ frame: f, base64: buffer.toString('base64') });
    }
    return out;
  } finally {
    signal?.removeEventListener('abort', closeOnAbort);
    if (ownBrowser) {
      try { await browser.close({ silent: true }); } catch { /* ignore */ }
    }
  }
}
