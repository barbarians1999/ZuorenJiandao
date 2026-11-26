import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDirectCutExport } from './direct-cut.mjs';
import {
  buildAtempoChain,
  buildOverlayOnlyState,
  buildClipFilterChain,
  buildSparseOverlayPlan,
  encodeChunk,
  exportFinalizationTimeoutMs,
  inspectOverlayHybridExport,
  inspectPngIhdr,
  normalizeOverlayPlatesToRgba,
  planOverlayHybridExport,
  renderAudioTrack,
  resolveHybridWorkerCount,
  splitOutputChunks,
  tryOverlayHybridExport,
} from './overlay-hybrid.mjs';

const finalizationBudget = exportFinalizationTimeoutMs({ frames: 45 * 60 * 30, fps: 30,
  inputBytes: Math.round(3.3 * 1024 ** 3) });
assert.ok(finalizationBudget > 180_000, '45-minute, 3.3-GiB finalization receives more than the old 180-second timeout');
assert.ok(finalizationBudget < 45 * 60_000, 'large finalization budgets remain capped');
assert.equal(exportFinalizationTimeoutMs({ frames: 0, fps: 30, inputBytes: 0 }), 180_000,
  'small/unknown jobs retain a bounded minimum budget');
assert.equal(exportFinalizationTimeoutMs({ frames: 24 * 60 * 60 * 30, fps: 30, inputBytes: 100 * 1024 ** 3 }), 45 * 60_000,
  'extreme inputs hit the reasonable timeout cap');

const video = (id, track, startFrame, durationInFrames, extra = {}) => ({
  id,
  name: id,
  kind: 'video',
  track,
  src: '/media/uploads/sample.mp4',
  startFrame,
  srcInFrame: 0,
  durationInFrames,
  width: 1920,
  height: 1080,
  ...extra,
});

const audio = (id, track, startFrame, durationInFrames, extra = {}) => ({
  id,
  name: id,
  kind: 'audio',
  track,
  src: '/media/uploads/sample.mp4',
  startFrame,
  srcInFrame: 0,
  durationInFrames,
  volume: 0.8,
  ...extra,
});

const complexState = () => ({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['C1', 'T1', 'E1', 'V1', 'A1', 'A2'],
  tracks: {
    C1: { kind: 'caption', captions: { enabled: true, template: 'plain', pacing: 'phrase', words: [] } },
    T1: { kind: 'video', visualRole: 'text' },
    E1: { kind: 'video', visualRole: 'effect' },
    V1: { kind: 'video' },
    A1: { kind: 'audio', audioRouting: { gainDb: -3 } },
    A2: { kind: 'audio' },
  },
  items: [
    video('v1', 'V1', 0, 120, {
      transform: { x: -0.92, y: 0.25 },
      props: { visualEntrance: 'fade', visualEntranceWindow: { from: 0, until: 12 }, visualExit: 'fade' },
    }),
    video('v2', 'V1', 120, 60, { filters: { brightness: 0 }, transform: { x: -2.3, y: 0.37 } }),
    { id: 's1', name: 'mask-solid', kind: 'solid', track: 'E1', startFrame: 0, durationInFrames: 180,
      props: { color: '#000000' }, transform: { x: -49.8, y: 21.6, rotation: -91 },
      mask: { type: 'rectangle', x: 0.35, y: 0.35, width: 0.3, height: 0.3, feather: 0 } },
    { id: 't1', name: 'title', kind: 'text', track: 'T1', startFrame: 20, durationInFrames: 100,
      props: { text: '章节一', entrance: 'fade', entranceFrames: 12, exit: 'fade', exitFrames: 12 } },
    ...Array.from({ length: 10 }, (_, i) => audio(`a${i}`, i % 2 === 0 ? 'A1' : 'A2', i * 16, 20, {
      fadeInFrames: 4, fadeOutFrames: 4,
    })),
  ],
});

// 1. Direct-cut stays strict for direct-cut unit contracts, while overlay-hybrid admits real project timelines.
{
  const state = complexState();
  assert.equal(planDirectCutExport({ state }).eligible, false);
  const plan = planOverlayHybridExport({ state });
  assert.equal(plan.eligible, true);
  assert.equal(plan.renderRoute, 'hybrid');
  assert.equal(plan.frames, 180);
  assert.equal(plan.baseSegments.length, 2);
  assert.equal(plan.baseSegments[0].kind, 'video');
  assert.deepEqual(plan.baseSegments[0].transform.x, -0.92);
  assert.equal(plan.baseSegments[1].kind, 'black', 'brightness: 0 video collapses to pure black segment');
  assert.equal(plan.audioSegments.length, 12, '10 audio clips + 2 video audio tracks admitted (>8 supported)');
  assert.equal(plan.hasCaptions, true);
  assert.equal(plan.hasOverlays, true);
  const scaled = planOverlayHybridExport({ state, scale: 2 / 3 });
  assert.equal(scaled.eligible, true, '720p remains eligible for a 1080p composition');
  assert.deepEqual([scaled.width, scaled.height, scaled.outputWidth, scaled.outputHeight], [1920, 1080, 1280, 720]);
  assert.equal(planOverlayHybridExport({ state, scale: 0.5 }).eligible, true);
  assert.equal(planOverlayHybridExport({ state, scale: -1 }).eligible, false);
  assert.equal(planOverlayHybridExport({ state, scale: 0.701 }).eligible, false, 'H.264 requires even output dimensions');
}

// Source dimensions/FPS may differ from the composition; inspect validates duration when frame counts are absent.
{
  const dir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-source-'));
  try {
    const sourcePath = join(dir, 'sample.mp4');
    await writeFile(sourcePath, 'dummy');
    const state = complexState();
    state.fit = 'contain';
    state.items = state.items.filter((item) => item.kind === 'video' || item.kind === 'solid' || item.kind === 'text');
    const metadata = { format: { start_time: '0', duration: '5' }, streams: [
      { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 480,
        avg_frame_rate: '24/1', r_frame_rate: '24/1', start_time: '0', nb_frames: 'N/A',
        color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv' },
    ] };
    const inspected = await inspectOverlayHybridExport({ state, ffmpegExecutable: 'ffmpeg', ffprobeExecutable: 'ffprobe',
      uploadsDirectory: dir, assetsDirectory: dir, resolveMediaSource: () => sourcePath }, { probe: async () => metadata });
    assert.ok(inspected, 'missing nb_frames falls back to metadata duration');
    assert.equal(inspected.plan.audioSegments.length, 0, 'video derived audio is dropped if source has no audio stream');
    assert.equal(inspected.plan.baseSegments[0].sourceWidth, 640);
    assert.equal(inspected.plan.baseSegments[0].sourceHeight, 480);
    assert.equal(inspected.sources.get('/media/uploads/sample.mp4').hasAudio, false);
    const contain = buildClipFilterChain({ ...inspected.plan.baseSegments[0], sourceFps: 24, fit: 'contain' }, 0, 30, 1920, 1080).filter;
    assert.match(contain, /^fps=30,trim=/, 'fps normalization runs before frame trimming');
    assert.match(contain, /scale=1920:1080:force_original_aspect_ratio=decrease/);
    assert.match(contain, /pad=1920:1080/);
    const cover = buildClipFilterChain({ ...inspected.plan.baseSegments[0], sourceFps: 30, fit: 'cover' }, 1, 30, 1920, 1080).filter;
    assert.match(cover, /force_original_aspect_ratio=increase/);
    assert.match(cover, /crop=1920:1080/);

    const tooShort = { ...metadata, format: { ...metadata.format, duration: '3' } };
    const rejected = await inspectOverlayHybridExport({ state, ffmpegExecutable: 'ffmpeg', ffprobeExecutable: 'ffprobe',
      uploadsDirectory: dir, assetsDirectory: dir, resolveMediaSource: () => sourcePath }, { probe: async () => tooShort });
    assert.equal(rejected, null, 'duration fallback rejects out of range segments');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 2. Refusal guards for unsupported edge cases.
{
  const withUnsupportedTransition = complexState();
  withUnsupportedTransition.transitions = [{
    id: 'tr', type: 'page-curl', durationInFrames: 16, outgoingItemId: 'v1', incomingItemId: 'v2', trackId: 'V1',
  }];
  assert.equal(planOverlayHybridExport({ state: withUnsupportedTransition }).reason, 'transitions');

  const withShortHandleTransition = complexState();
  withShortHandleTransition.items[1] = video('v2', 'V1', 120, 60, { srcInFrame: 2 });
  withShortHandleTransition.transitions = [{
    id: 'tr', type: 'cross-dissolve', durationInFrames: 16, outgoingItemId: 'v1', incomingItemId: 'v2', trackId: 'V1',
  }];
  assert.equal(planOverlayHybridExport({ state: withShortHandleTransition }).reason, 'transitions');

  const withFeatheredMosaic = complexState();
  withFeatheredMosaic.trackOrder = ['C1', 'T1', 'E1', 'M1', 'V1', 'A1', 'A2'];
  withFeatheredMosaic.tracks.M1 = { kind: 'video', visualRole: 'effect' };
  withFeatheredMosaic.items.push({
    id: 'm', name: 'm', kind: 'mosaic', track: 'M1', startFrame: 0, durationInFrames: 30,
    mosaic: { shape: 'ellipse', centerX: 0.5, centerY: 0.5, width: 0.2, height: 0.2, strength: 60, feather: 8, opacity: 0.75 },
  });
  const featheredMosaicPlan = planOverlayHybridExport({ state: withFeatheredMosaic });
  assert.equal(featheredMosaicPlan.eligible, true);
  assert.equal(featheredMosaicPlan.mosaics?.length, 1);
  assert.equal(featheredMosaicPlan.mosaics?.[0]?.shape, 'ellipse');
  assert.equal(featheredMosaicPlan.mosaics?.[0]?.feather, 8);
  assert.equal(featheredMosaicPlan.mosaics?.[0]?.opacity, 0.75);

  const withMosaicAboveOverlay = complexState();
  withMosaicAboveOverlay.trackOrder = ['C1', 'M1', 'T1', 'E1', 'V1', 'A1', 'A2'];
  withMosaicAboveOverlay.tracks.M1 = { kind: 'video', visualRole: 'effect' };
  withMosaicAboveOverlay.items.push({
    id: 'm', name: 'm', kind: 'mosaic', track: 'M1', startFrame: 0, durationInFrames: 30,
    mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.2, height: 0.2, strength: 60, feather: 0, opacity: 1 },
  });
  assert.equal(planOverlayHybridExport({ state: withMosaicAboveOverlay }).reason, 'composition-mosaic');

  const underlayState = complexState();
  underlayState.trackOrder = ['C1', 'V1', 'T1', 'E1', 'A1', 'A2'];
  const underlayPlan = planOverlayHybridExport({ state: underlayState });
  assert.equal(underlayPlan.eligible, true, 'clean bottom underlay routes natively via underlay pass');
  assert.equal(underlayPlan.hasUnderlays, true);
  assert.equal(underlayPlan.overlayVideos?.length, 2);

  const sandwichedState = complexState();
  sandwichedState.trackOrder = ['C1', 'V2', 'T1', 'E1', 'V1', 'A1', 'A2'];
  sandwichedState.tracks.V2 = { kind: 'video' };
  sandwichedState.items.push(video('topv', 'V2', 0, 120));
  assert.equal(planOverlayHybridExport({ state: sandwichedState }).reason, 'overlay-below-video');

  const rotatedRoundedVideo = complexState();
  rotatedRoundedVideo.items[0].transform.rotation = 15;
  rotatedRoundedVideo.items[0].transform.borderRadius = 24;
  rotatedRoundedVideo.items[0].backgroundFill = true;
  const rrPlan = planOverlayHybridExport({ state: rotatedRoundedVideo });
  assert.equal(rrPlan.eligible, true, 'rotation, borderRadius, and backgroundFill route natively');
  assert.equal(rrPlan.baseSegments[0].transform.rotation, 15);
  assert.equal(rrPlan.baseSegments[0].transform.borderRadius, 24);
  assert.ok(rrPlan.baseSegments[0].backgroundFill, 'backgroundFill appearance attached on default video track');

  const overlappingVideo = complexState();
  overlappingVideo.trackOrder = ['C1', 'T1', 'E1', 'V2', 'V1', 'A1', 'A2'];
  overlappingVideo.tracks.V2 = { kind: 'video' };
  overlappingVideo.items.push(video('pip', 'V2', 10, 30));
  const pipPlan = planOverlayHybridExport({ state: overlappingVideo });
  assert.equal(pipPlan.eligible, true, '2-layer PiP video uses native FFmpeg overlay');
  assert.equal(pipPlan.overlayVideos?.length, 1);

  const tooManyVideos = complexState();
  tooManyVideos.trackOrder = ['C1', 'T1', 'E1', 'V5', 'V4', 'V3', 'V2', 'V1', 'A1', 'A2'];
  for (const tid of ['V2', 'V3', 'V4', 'V5']) {
    tooManyVideos.tracks[tid] = { kind: 'video' };
    tooManyVideos.items.push(video(`pip_${tid}`, tid, 10, 30));
  }
  assert.equal(planOverlayHybridExport({ state: tooManyVideos }).reason, 'overlapping-base-video');

  // Transformed static mosaic + non-overlapping text/solid track above/below mosaic stays native
  const transformedMosaic = complexState();
  transformedMosaic.trackOrder = ['C1', 'M1', 'T1', 'E1', 'V1', 'A1', 'A2'];
  transformedMosaic.tracks.M1 = { kind: 'video', visualRole: 'effect' };
  const s1Item = transformedMosaic.items.find((it) => it.id === 's1');
  if (s1Item) s1Item.durationInFrames = 120;
  transformedMosaic.items.push({
    id: 'm_tr', name: 'm_tr', kind: 'mosaic', track: 'M1', startFrame: 130, durationInFrames: 30,
    transform: { x: 25, y: -25, scaleX: 0.5, scaleY: 0.5 },
    mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4, strength: 60, feather: 4, opacity: 1 },
  });
  const trMosaicPlan = planOverlayHybridExport({ state: transformedMosaic });
  assert.equal(trMosaicPlan.eligible, true, 'non-overlapping transformed static mosaic stays native even above text track');
  assert.equal(trMosaicPlan.mosaics?.length, 1);
  assert.equal(trMosaicPlan.mosaics?.[0]?.w, 384);
  assert.equal(trMosaicPlan.mosaics?.[0]?.h, 216);

  const ducked = complexState();
  ducked.tracks.A1.role = 'anchor';
  ducked.tracks.A2.role = 'follower';
  ducked.tracks.A2.audioRouting = { duckDepthDb: -12 };
  const duckedPlan = planOverlayHybridExport({ state: ducked });
  assert.equal(duckedPlan.eligible, true, 'anchor/follower audio ducking uses native FFmpeg mix');
  const followerAudio = duckedPlan.audioSegments.find((s) => s.duckIntervals?.length);
  assert.ok(followerAudio, 'follower audio segment receives ducking intervals');
  assert.ok(followerAudio.duckFactor < 0.3 && followerAudio.duckFactor > 0.2);

  const unknownState = complexState();
  unknownState.futureFeature = true;
  assert.equal(planOverlayHybridExport({ state: unknownState }).eligible, true, 'unknown state metadata stays fast under blacklist mode');

  const unknownItem = complexState();
  unknownItem.items[0].futureProp = 42;
  assert.equal(planOverlayHybridExport({ state: unknownItem }).eligible, true, 'unknown item metadata stays fast under blacklist mode');

  const zoomVideo = complexState();
  zoomVideo.items[0].props = { visualEntrance: 'zoom' };
  assert.equal(planOverlayHybridExport({ state: zoomVideo }).reason, 'video-clip-effects');
}

// 3. Sparse overlay span partitioning & overlay-only state derivation.
{
  const state = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    tracks: { T1: { kind: 'video', visualRole: 'text' }, V1: { kind: 'video' } },
    items: [
      video('v1', 'V1', 0, 300, { transcript: [{ id: 'w1', text: '测试', start: 500, end: 1000 }] }),
      { id: 't1', name: 'fadeTitle', kind: 'text', track: 'T1', startFrame: 50, durationInFrames: 100,
        props: { text: '标题', entrance: 'fade', entranceFrames: 12, exit: 'fade', exitFrames: 12 } },
      { id: 's1', name: 'staticSolid', kind: 'solid', track: 'T1', startFrame: 200, durationInFrames: 50,
        props: { color: '#ff0000' } },
    ],
  };

  const overlayState = buildOverlayOnlyState(state);
  assert.equal(overlayState.tracks.__cc_hidden_media__.hidden, true);
  assert.equal(overlayState.items[0].track, '__cc_hidden_media__');
  assert.equal(overlayState.items[0].transcript[0].text, '测试', 'caption transcript data preserved on hidden track');
  assert.equal(overlayState.items[1].track, 'T1');

  const { spans, framesToRender } = buildSparseOverlayPlan(overlayState, 0, 300, null);
  // [0,50) empty -> 0 plates
  // [50,62) fade in -> 12 plates
  // [62,138) static title hold -> 1 plate!
  // [138,150) fade out -> 12 plates
  // [150,200) empty -> 0 plates
  // [200,250) static solid -> 1 plate!
  // [250,300) empty -> 0 plates
  assert.equal(framesToRender.length, 26, 'only 26 unique frames rendered out of 300 total frames');
  assert.equal(spans[0].sampleFrame, null);
  assert.deepEqual([spans[0].from, spans[0].to], [0, 50]);
  const midTitleSpan = spans.find((s) => s.from === 62);
  assert.deepEqual(midTitleSpan, { from: 62, to: 138, sampleFrame: 62 });
  const solidSpan = spans.find((s) => s.from === 200);
  assert.deepEqual(solidSpan, { from: 200, to: 250, sampleFrame: 200 });

  // Captions summary integration (static caption cue + word break)
  const capResult = buildSparseOverlayPlan(overlayState, 0, 300, {
    cutFrames: [0, 15, 45, 300],
    animatedRanges: [],
    activeRanges: [[15, 45]],
  });
  assert.equal(capResult.framesToRender.includes(15), true);
}

// 4. End-to-end mocked orchestration (ffconcat plates + parallel chunks + audio mix + HW fallback + cleanup).
{
  const dir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-verify-'));
  try {
    const state = complexState();
    const outPath = join(dir, 'out.mp4');
    const sourcePath = join(dir, 'sample.mp4');
    await writeFile(sourcePath, 'dummy');
    const mockMeta = {
      format: { start_time: '0.025057' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080,
          avg_frame_rate: '1212887040/40429567', r_frame_rate: '30/1', start_time: '0',
          color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv', nb_frames: '300' },
        { codec_type: 'audio', start_time: '0.025057', channels: 2, sample_rate: '44100', duration: '10.0' },
      ],
    };

    const runs = [];
    const progress = [];
    const progressStages = [];
    const res = await tryOverlayHybridExport({
      state,
      scale: 2 / 3,
      outputLocation: outPath,
      ffmpegExecutable: 'ffmpeg',
      ffprobeExecutable: 'ffprobe',
      uploadsDirectory: dir,
      assetsDirectory: dir,
      h264Profile: { id: 'h264_amf', label: 'AMD AMF', hardware: true },
      onProgress: (p) => progress.push(p),
      onProgressStage: (phase) => progressStages.push(phase),
      renderOverlayPlates: async ({ platesDir }) => {
        const p20 = join(platesDir, 'plate-20.png');
        await writeFile(p20, Buffer.from([137, 80, 78, 71]));
        return { spans: [{ from: 0, to: 20, sampleFrame: null }, { from: 20, to: 180, sampleFrame: 20 }], plateFiles: new Map([[20, p20]]) };
      },
    }, {
      probe: async () => mockMeta,
      checkDisk: () => {},
      run: async (_, args, control) => {
        runs.push(args);
        const playlist = args.find((arg) => /overlay-\d+\.ffconcat$/.test(arg));
        if (playlist) {
          const contents = await readFile(playlist, 'utf8');
          assert.equal(contents.match(/^file /gm)?.length, contents.match(/^option framerate 30$/gm)?.length);
        }
        if (args.includes('h264_amf')) throw new Error('AMF device unavailable');
        control?.onFrame?.(180);
        await writeFile(args.at(-1), 'encoded');
        return '';
      },
    });

    assert.equal(res.renderRoute, 'hybrid');
    assert.equal(res.hybridMode, 'overlay-plates');
    assert.equal(res.encoder.id, 'libx264');
    assert.match(res.encoderFallbackReason, /h264_amf/);
    assert.equal(progress.at(-1), 1);
    assert.equal(progressStages.at(-1), 'finalizing', 'completed chunk output enters finalizing for join/mux');
    assert.ok(progressStages.includes('rendering'), 'encoding attempts report their stage');
    assert.equal(await readFile(outPath, 'utf8'), 'encoded');
    assert.deepEqual(await readdir(dir), ['out.mp4', 'sample.mp4'], 'temporaries cleaned up');
    // Verify at least one ffconcat overlay + afade command was emitted
    const joinedRuns = runs.map((r) => r.join(' ')).join('\n');
    assert.match(joinedRuns, /overlay-\d+\.ffconcat/);
    assert.match(joinedRuns, /format=yuva420p,fps=30/);
    assert.match(joinedRuns, /overlay=0:0:eof_action=repeat/);
    assert.match(joinedRuns, /scale=1280:720:flags=lanczos,setsar=1\[scaledv\]/);
    assert.match(joinedRuns, /fade=t=in:s=0:n=12:c=black/);
    assert.match(joinedRuns, /afade=t=in/);

    // Cancellation stops cleanly with caller AbortSignal
    const abortCtrl = new AbortController();
    const cancelErr = new Error('user aborted');
    await assert.rejects(tryOverlayHybridExport({
      state,
      outputLocation: outPath,
      ffmpegExecutable: 'ffmpeg',
      ffprobeExecutable: 'ffprobe',
      uploadsDirectory: dir,
      assetsDirectory: dir,
      signal: abortCtrl.signal,
      renderOverlayPlates: async () => { abortCtrl.abort(cancelErr); throw cancelErr; },
    }, { probe: async () => mockMeta, checkDisk: () => {} }), (e) => e === cancelErr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 3. Hardware worker count respects 4K+ VRAM cap, free-memory budget, and env overrides.
{
  const gib = 1024 ** 3;
  assert.equal(resolveHybridWorkerCount({ cores: 16, frames: 3000, width: 1920, height: 1080, freeMemBytes: 16 * gib, hardware: true, envMaxWorkers: '' }), 4);
  assert.equal(resolveHybridWorkerCount({ cores: 16, frames: 3000, width: 3840, height: 2160, freeMemBytes: 16 * gib, hardware: true, envMaxWorkers: '' }), 2, '4K+ caps hardware concurrency at 2');
  assert.equal(resolveHybridWorkerCount({ cores: 16, frames: 3000, width: 1920, height: 1080, freeMemBytes: 3 * gib, hardware: true, envMaxWorkers: '' }), 1, 'low free memory caps at 1');
  assert.equal(resolveHybridWorkerCount({ cores: 16, frames: 3000, width: 1920, height: 1080, freeMemBytes: 6 * gib, hardware: true, envMaxWorkers: '' }), 2, 'moderate free memory caps at 2');
  assert.equal(resolveHybridWorkerCount({ cores: 16, frames: 3000, width: 1920, height: 1080, freeMemBytes: 16 * gib, hardware: true, envMaxWorkers: '1' }), 1, 'env override caps worker count');
}

// 5. Phase 3 admissions: playbackRate (0.25x..4x), adjacent cross-dissolve/dip-to-black transitions, static rect mosaic.
{
  assert.deepEqual(buildAtempoChain(1), []);
  assert.deepEqual(buildAtempoChain(1.5), ['atempo=1.5']);
  assert.deepEqual(buildAtempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(buildAtempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);

  const retimedState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['C1', 'T1', 'M1', 'V1', 'A1'],
    tracks: {
      C1: { kind: 'caption', captions: { enabled: false, template: 'plain', pacing: 'phrase', words: [] } },
      T1: { kind: 'video', visualRole: 'text' },
      M1: { kind: 'video', visualRole: 'effect' },
      V1: { kind: 'video' },
      A1: { kind: 'audio' },
    },
    items: [
      video('v1', 'V1', 0, 60, { playbackRate: 1.5, srcInFrame: 0 }),
      video('v2', 'V1', 60, 60, { srcInFrame: 12 }),
      video('v3', 'V1', 120, 60, { srcInFrame: 12 }),
      {
        id: 'mos1', name: 'mos1', kind: 'mosaic', track: 'M1', startFrame: 10, durationInFrames: 80,
        mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.3, height: 0.2, strength: 60, feather: 0, opacity: 1 },
      },
      {
        id: 'txt1', name: 'txt1', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 100,
        props: { text: 'Phase 3' },
      },
      audio('aud1', 'A1', 0, 40, { playbackRate: 2.0 }),
    ],
    transitions: [
      { id: 't1', type: 'cross-dissolve', durationInFrames: 16, outgoingItemId: 'v1', incomingItemId: 'v2', trackId: 'V1' },
      { id: 't2', type: 'dip-to-black', durationInFrames: 16, outgoingItemId: 'v2', incomingItemId: 'v3', trackId: 'V1' },
    ],
  };

  const plan = planOverlayHybridExport({ state: retimedState });
  assert.equal(plan.eligible, true, `expected eligibility, got ${plan.reason}`);
  assert.equal(plan.baseSegments.filter((s) => s.kind === 'transition').length, 2);
  assert.equal(plan.baseSegments[0].playbackRate, 1.5);
  assert.equal(plan.mosaics.length, 1);
  assert.equal(plan.mosaics[0].sigma, 14);
  assert.deepEqual(
    { x0: plan.mosaics[0].x0, y0: plan.mosaics[0].y0, w: plan.mosaics[0].w, h: plan.mosaics[0].h },
    { x0: 672, y0: 432, w: 576, h: 216 },
  );
  assert.equal(plan.audioSegments.find((s) => !s.fromVideo)?.playbackRate, 2.0);

  const retimedChain = buildClipFilterChain(plan.baseSegments[0], 0, 30, 1920, 1080);
  assert.match(retimedChain.filter, /setpts=\(PTS-STARTPTS\)\/1\.500000,fps=30/);

  const ovState = buildOverlayOnlyState(retimedState);
  assert.deepEqual(ovState.transitions, []);
  assert.equal(ovState.items.find((it) => it.id === 'mos1').track, '__cc_hidden_media__');
  assert.equal(ovState.items.find((it) => it.id === 'txt1').track, 'T1');

  const outOfRangeSpeed = { ...retimedState, items: [video('fast', 'V1', 0, 30, { playbackRate: 5.0 })], transitions: [] };
  assert.equal(planOverlayHybridExport({ state: outOfRangeSpeed }).reason, 'item-retimed');
}

// 6. Static builtin:fx-local-gaussian-blur admission, refusals, filtergraph, sparse overlay cuts, and chunk subdivision.
{
  const blurEffect = (id, overrides) => ({ id, assetId: 'builtin:fx-local-gaussian-blur', overrides });
  const blurState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['T1', 'V1'],
    tracks: { T1: { kind: 'video', visualRole: 'text' }, V1: { kind: 'video' } },
    items: [
      video('v1', 'V1', 0, 120, {
        effects: [
          blurEffect('fx1', { center_x: 0.88, center_y: 0.06, width_ratio: 0.22, height_ratio: 0.11, strength: 100, feather: 0 }),
          blurEffect('fx2', { center_x: 0.2, center_y: 0.15, width_ratio: 0.3, height_ratio: 0.16, strength: 100, feather: 10 }),
        ],
      }),
      { id: 't1', name: 'sub1', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 60, props: { text: '第一句' } },
      { id: 't2', name: 'sub2', kind: 'text', track: 'T1', startFrame: 60, durationInFrames: 60, props: { text: '第二句' } },
    ],
  };
  const plan = planOverlayHybridExport({ state: blurState });
  assert.equal(plan.eligible, true, `expected static local gaussian blur to be eligible, got ${plan.reason}`);
  assert.equal(plan.baseSegments[0].localGaussianBlurs.length, 2);
  assert.equal(plan.baseSegments[0].localGaussianBlurs[0].sigma, 24);
  assert.equal(plan.baseSegments[0].localGaussianBlurs[1].feather, 10);

  // Refusals: mosaicTrack, non-blur effect, unknown override, out-of-range override
  const trackedBlur = structuredClone(blurState);
  trackedBlur.items[0].effects[0].mosaicTrack = { sourceIdentity: 'x', sourceWidth: 1920, sourceHeight: 1080, points: [{ sourceFrame: 0, x: 0.5, y: 0.5 }, { sourceFrame: 10, x: 0.6, y: 0.6 }] };
  assert.equal(planOverlayHybridExport({ state: trackedBlur }).reason, 'video-clip-effects');

  const invertFx = structuredClone(blurState);
  invertFx.items[0].effects = [{ id: 'fx-inv', assetId: 'builtin:fx-invert' }];
  assert.equal(planOverlayHybridExport({ state: invertFx }).reason, 'video-clip-effects');

  const unknownOverride = structuredClone(blurState);
  unknownOverride.items[0].effects[0].overrides.unknownParam = 1;
  assert.equal(planOverlayHybridExport({ state: unknownOverride }).reason, 'video-clip-effects');

  const outOfRangeOverride = structuredClone(blurState);
  outOfRangeOverride.items[0].effects[0].overrides.strength = 200;
  assert.equal(planOverlayHybridExport({ state: outOfRangeOverride }).reason, 'video-clip-effects');

  // Filter chain with feathered + unfeathered blurs + contain source scale + filters/transform
  const containBlurSeg = {
    ...plan.baseSegments[0],
    sourceWidth: 1280,
    sourceHeight: 960,
    fit: 'contain',
    filters: { brightness: 1.1, contrast: 1, saturate: 1, blur: 0 },
    transform: { scaleX: 1, scaleY: 1, x: 0, y: 0, opacity: 0.9 },
  };
  const blurChain = buildClipFilterChain(containBlurSeg, 0, 30, 1920, 1080);
  assert.match(blurChain.filter, /scale=1440:1080:flags=lanczos/);
  assert.match(blurChain.filter, /gblur=sigma=24:steps=2/);
  assert.match(blurChain.filter, /alphamerge=eof_action=repeat/);
  assert.match(blurChain.filter, /pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/);

  // Adjacent static text items produce distinct cut spans (never merged into frozen first caption)
  const backToBack = buildSparseOverlayPlan(buildOverlayOnlyState(blurState), 0, 120, null);
  assert.deepEqual(backToBack.framesToRender, [0, 60], 'touching static text items render separate plates at 0 and 60');
  assert.equal(backToBack.spans.length, 2);

  // Overlapping static text items produce 3 spans
  const overlappingTextState = buildOverlayOnlyState({
    ...blurState,
    items: [
      { id: 't1', name: 't1', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 80, props: { text: 'A' } },
      { id: 't2', name: 't2', kind: 'text', track: 'T1', startFrame: 40, durationInFrames: 80, props: { text: 'B' } },
    ],
  });
  const overlapPlan = buildSparseOverlayPlan(overlappingTextState, 0, 120, null);
  assert.deepEqual(overlapPlan.spans, [
    { from: 0, to: 40, sampleFrame: 0 },
    { from: 40, to: 80, sampleFrame: 40 },
    { from: 80, to: 120, sampleFrame: 80 },
  ]);

  // Flat keyframe plateau skips middle static frames
  const solidPlateauState = {
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: { T1: { kind: 'video', visualRole: 'text' } },
    items: [{
      id: 's1',
      name: 'black-card',
      kind: 'solid',
      track: 'T1',
      startFrame: 0,
      durationInFrames: 89,
      props: { color: '#000000' },
      keyframes: {
        opacity: [
          { frame: 0, value: 0 },
          { frame: 15, value: 1 },
          { frame: 74, value: 1 },
          { frame: 88, value: 0 },
        ],
      },
    }],
  };
  const plateauPlan = buildSparseOverlayPlan(solidPlateauState, 0, 89, null);
  assert.equal(plateauPlan.framesToRender.length, 32, 'flat [15, 74] opacity=1 plateau collapses into 1 unique plate');
  assert.ok(plateauPlan.spans.some((s) => s.from === 16 && s.to === 74 && s.sampleFrame === 16));

  // Chunk subdivision caps overlapping base video segments at <= 8 without splitting transitions
  const manySegs = Array.from({ length: 60 }, (_, idx) => ({
    kind: idx === 16 ? 'transition' : 'video',
    timelineFrame: idx * 30,
    frames: 30,
  }));
  const subChunks = splitOutputChunks(0, 1800, 1, manySegs);
  assert.ok(subChunks.length >= 8, `expected 60 segments to subdivide into >=8 chunks, got ${subChunks.length}`);
  for (const ch of subChunks) {
    const segsInChunk = manySegs.filter((s) => s.timelineFrame < ch.to && s.timelineFrame + s.frames > ch.from);
    assert.ok(segsInChunk.length <= 8, `chunk [${ch.from}, ${ch.to}) had ${segsInChunk.length} segments (>8)`);
    assert.ok(!(510 > ch.from && 510 < ch.to && (ch.from > 480 || ch.to < 510)), 'transition kept atomic');
  }

  // Mocked end-to-end feathered blur run creates mask PNGs, passes alphamerge/gblur, and cleans up temp dir
  const blurDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-blur-e2e-'));
  try {
    const srcPath = join(blurDir, 'sample.mp4');
    const outPath = join(blurDir, 'blur-out.mp4');
    await writeFile(srcPath, 'dummy');
    const mockMeta = {
      format: { start_time: '0' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0',
          color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv', nb_frames: '300' },
      ],
    };
    const capturedArgs = [];
    const e2eRes = await tryOverlayHybridExport({
      state: blurState,
      outputLocation: outPath,
      ffmpegExecutable: 'ffmpeg',
      ffprobeExecutable: 'ffprobe',
      uploadsDirectory: blurDir,
      assetsDirectory: blurDir,
      renderOverlayPlates: async ({ platesDir }) => {
        const p0 = join(platesDir, 'plate-0.png');
        const p60 = join(platesDir, 'plate-60.png');
        await writeFile(p0, Buffer.from([137, 80, 78, 71]));
        await writeFile(p60, Buffer.from([137, 80, 78, 71]));
        return {
          spans: [{ from: 0, to: 60, sampleFrame: 0 }, { from: 60, to: 120, sampleFrame: 60 }],
          plateFiles: new Map([[0, p0], [60, p60]]),
        };
      },
    }, {
      probe: async () => mockMeta,
      checkDisk: () => {},
      run: async (_, args, control) => {
        capturedArgs.push(args);
        const maskArg = args.find((arg) => typeof arg === 'string' && /mask-\d+\.png$/.test(arg));
        if (maskArg) {
          const pngHeader = await readFile(maskArg);
          assert.equal(pngHeader[0], 137);
          assert.equal(pngHeader[9 + 16], 0, 'blur mask PNG is 8-bit grayscale (colorType 0)');
        }
        control?.onFrame?.(120);
        await writeFile(args.at(-1), 'encoded-blur');
        return '';
      },
    });
    assert.equal(e2eRes.renderRoute, 'hybrid');
    const joined = capturedArgs.map((r) => r.join(' ')).join('\n');
    assert.match(joined, /mask-\d+\.png/);
    assert.match(joined, /gblur=sigma=24:steps=2/);
    assert.match(joined, /alphamerge=eof_action=repeat/);
    assert.deepEqual(await readdir(blurDir), ['blur-out.mp4', 'sample.mp4'], 'blur temp files cleaned up');
  } finally {
    await rm(blurDir, { recursive: true, force: true });
  }

  // 7. Holistic fast-path: local-mosaic, pixelate, static clip masks, and clip fadeInFrames/fadeOutFrames.
  const fxAndMaskState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [
      video('vm1', 'V1', 0, 60, {
        fadeInFrames: 8,
        fadeOutFrames: 10,
        mask: { type: 'ellipse', x: 0.1, y: 0.15, width: 0.8, height: 0.7, feather: 0.05 },
        effects: [
          {
            id: 'lm1',
            assetId: 'builtin:fx-local-mosaic',
            overrides: { center_x: 0.5, center_y: 0.3, width_ratio: 0.25, height_ratio: 0.25, block_size: 24, feather: 6 },
          },
          {
            id: 'px1',
            assetId: 'builtin:fx-pixelate',
            overrides: { blockSize: 16 },
          },
        ],
      }),
    ],
  };
  const fxMaskPlan = planOverlayHybridExport({ state: fxAndMaskState });
  assert.equal(fxMaskPlan.eligible, true, 'local-mosaic, pixelate, clip mask, and clip fades use hybrid fast path');
  const fxMaskChain = buildClipFilterChain(fxMaskPlan.baseSegments[0], 0, 30, 1920, 1080);
  assert.match(fxMaskChain.filter, /flags=neighbor/, 'local-mosaic / pixelate use nearest-neighbor pixel scaling');
  assert.match(fxMaskChain.filter, /alphamerge=eof_action=repeat/, 'feathered ellipse mask uses alphamerge');
  assert.match(fxMaskChain.filter, /color=c=black:s=1920x1080/, 'clip mask composites over black canvas');
  assert.match(fxMaskChain.filter, /overlay=0:0:shortest=1:format=yuv420/);
  assert.match(fxMaskChain.filter, /fade=t=in:s=0:n=8:c=black/);
  assert.match(fxMaskChain.filter, /fade=t=out:s=.*n=10:c=black/);

  // Full-frame unfeathered rect mask is a clean no-op
  const fullRectMaskState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [video('vr1', 'V1', 0, 30, { mask: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: 0 } })],
  };
  assert.equal(planOverlayHybridExport({ state: fullRectMaskState }).baseSegments[0].clipMask, undefined);

  // Conflict between clip fadeInFrames and picture visualEntrance='fade' refuses cleanly
  const conflictingFadeState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [video('vf1', 'V1', 0, 60, {
      fadeInFrames: 10,
      props: { visualEntrance: 'fade', visualEntranceFrames: 12 },
    })],
  };
  assert.equal(planOverlayHybridExport({ state: conflictingFadeState }).reason, 'video-visual-fade');

  // Invalid mask shape refuses cleanly
  const badMaskState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [video('vbm1', 'V1', 0, 30, { mask: { type: 'polygon', x: 0.1, y: 0.1, width: 0.5, height: 0.5 } })],
  };
  assert.equal(planOverlayHybridExport({ state: badMaskState }).reason, 'video-clip-effects');

  // Real FFmpeg filtergraph smoke run when ffmpeg-static binary is present
  let bundledFfmpeg = null;
  try {
    const mod = await import('ffmpeg-static');
    if (typeof mod.default === 'string' && existsSync(mod.default)) bundledFfmpeg = mod.default;
  } catch {}
  if (bundledFfmpeg) {
    const { execFileSync } = await import('node:child_process');
    const realDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-ffmpeg-smoke-'));
    try {
      const srcMp4 = join(realDir, 'clip.mp4');
      const outMp4 = join(realDir, 'out.mp4');
      execFileSync(bundledFfmpeg, [
        '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:d=1',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', srcMp4,
      ], { stdio: 'ignore' });
      const realState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['M1', 'V1'],
        tracks: { M1: { kind: 'video', visualRole: 'effect' }, V1: { kind: 'video' } },
        items: [
          {
            id: 'vm_real',
            name: 'vm_real',
            kind: 'video',
            track: 'V1',
            src: '/media/uploads/clip.mp4',
            startFrame: 0,
            srcInFrame: 0,
            durationInFrames: 30,
            width: 320,
            height: 180,
            fadeInFrames: 5,
            fadeOutFrames: 5,
            mask: { type: 'ellipse', x: 0.1, y: 0.1, width: 0.8, height: 0.8, feather: 0.08 },
            effects: [
              {
                id: 'lm_real',
                assetId: 'builtin:fx-local-mosaic',
                overrides: { center_x: 0.5, center_y: 0.5, width_ratio: 0.4, height_ratio: 0.4, block_size: 12, feather: 6 },
              },
            ],
          },
          {
            id: 'cm_real',
            name: 'cm_real',
            kind: 'mosaic',
            track: 'M1',
            startFrame: 5,
            durationInFrames: 20,
            mosaic: { shape: 'ellipse', centerX: 0.3, centerY: 0.5, width: 0.25, height: 0.3, strength: 50, feather: 6, opacity: 0.8 },
          },
        ],
      };
      const realProbe = async () => ({
        format: { start_time: '0' },
        streams: [{
          codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0',
          color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv', nb_frames: '30',
        }],
      });
      const realRes = await tryOverlayHybridExport({
        state: realState,
        outputLocation: outMp4,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: realDir,
        assetsDirectory: realDir,
        renderOverlayPlates: async () => ({ spans: [{ from: 0, to: 30, sampleFrame: null }], plateFiles: new Map() }),
      }, { probe: realProbe, checkDisk: () => {} });
      assert.equal(realRes.renderRoute, 'hybrid');
      assert.ok((await stat(outMp4)).size > 1000, 'real FFmpeg smoke output MP4 is non-empty');
    } finally {
      await rm(realDir, { recursive: true, force: true });
    }
  }

  // 8. Holistic upgrades: rect/circle mask FX, 3D LUT, denoisedSrc, audio-cross-fade, volume keyframes, & segmented hybrid E2E.
  const fullFeatureState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1', 'A1'],
    tracks: { V1: { kind: 'video' }, A1: { kind: 'audio', role: 'follower', audioRouting: { duckDepthDb: -12 } } },
    items: [
      video('v1', 'V1', 0, 60, {
        denoisedSrc: '/media/uploads/clean.wav',
        denoiseStrength: 50,
        effects: [
          { id: 'rm', assetId: 'builtin:fx-rect-mask', overrides: { center_x: 0.5, center_y: 0.5, width: 0.6, height: 0.6, corner_radius: 20, feather: 8, invert: 1 } },
          { id: 'cm', assetId: 'builtin:fx-circle-mask', overrides: { center_x: 0.5, center_y: 0.5, radius: 0.3, feather: 4, invert: 0 } },
          { id: 'lut', assetId: 'builtin:slog3-s709', overrides: { intensity: 0.8 } },
        ],
      }),
      video('v2', 'V1', 60, 60, { srcInFrame: 30 }),
      audio('a1', 'A1', 0, 120, {
        keyframes: { volume: [{ frame: 0, value: 0.2 }, { frame: 60, value: 1.0 }, { frame: 120, value: 0.5 }] },
      }),
    ],
    transitions: [
      { id: 'tr_acf', type: 'audio-cross-fade', durationInFrames: 12, outgoingItemId: 'v1', incomingItemId: 'v2', trackId: 'V1' },
    ],
  };
  const ffPlan = planOverlayHybridExport({ state: fullFeatureState });
  assert.equal(ffPlan.eligible, true, 'rect/circle mask, LUT, denoise, audio crossfade, & volume keyframes are native');
  const ffChain = buildClipFilterChain(ffPlan.baseSegments[0], 0, 30, 1920, 1080, {
    resolveLutPath: () => 'C:\\Users\\Test\\Sony_Slog3_s709.cube',
  });
  assert.match(ffChain.filter, /lut3d=file='C\\:\/Users\/Test\/Sony_Slog3_s709\.cube':interp=tetrahedral/);
  assert.match(ffChain.filter, /alphamerge=eof_action=repeat/);
  assert.ok(ffPlan.audioSegments.some((s) => s.src === '/media/uploads/clean.wav'));
  assert.ok(ffPlan.audioSegments.some((s) => s.crossfades?.length));
  assert.ok(ffPlan.audioSegments.some((s) => s.volumeKeyframes?.length === 3));

  // Segmented hybrid planning: 5-layer video + unsupported transition + sequence only mark their sub-intervals as compat
  const segmentedState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['C1', 'V5', 'V4', 'V3', 'V2', 'V1', 'A1'],
    tracks: {
      C1: { kind: 'caption', captions: { enabled: false } },
      V5: { kind: 'video' },
      V4: { kind: 'video' },
      V3: { kind: 'video' },
      V2: { kind: 'video' },
      V1: { kind: 'video' },
      A1: { kind: 'audio' },
    },
    items: [
      video('va', 'V1', 0, 120),
      video('vb', 'V1', 120, 120, { srcInFrame: 30 }),
      video('vc', 'V1', 240, 120, { zoom: { startScale: 1, endScale: 1.4 } }),
      video('vd', 'V1', 360, 120),
      video('pip2', 'V2', 40, 30),
      video('pip3', 'V3', 40, 30),
      video('pip4', 'V4', 40, 30),
      video('pip5', 'V5', 40, 30),
      { id: 'seq', name: 'seq', kind: 'sequence', track: 'V2', startFrame: 420, durationInFrames: 30 },
    ],
    transitions: [
      { id: 't_curl', type: 'page-curl', durationInFrames: 20, outgoingItemId: 'va', incomingItemId: 'vb', trackId: 'V1' },
    ],
  };
  assert.equal(planOverlayHybridExport({ state: segmentedState, allowCompatSpans: false }).eligible, false);
  const segPlan = planOverlayHybridExport({ state: segmentedState, allowCompatSpans: true });
  assert.equal(segPlan.eligible, true);
  assert.equal(segPlan.hybridMode, 'segmented-hybrid');
  assert.ok(segPlan.compatSpans.length >= 3);
  assert.ok(segPlan.compatSpans.some((s) => s.from === 40 && s.to === 70));
  assert.ok(segPlan.compatSpans.some((s) => s.from === 110 && s.to === 130));
  assert.ok(segPlan.compatSpans.some((s) => s.compatAudio === true && s.from >= 420));
  assert.ok(segPlan.fastSpans.length >= 2);
  assert.ok(segPlan.compatFrames < segPlan.frames);

  // GIF overlay routes natively; 100% compat zoom clip falls back cleanly to full Remotion (eligible: false)
  const gifOverlayState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['E1', 'V1'],
    tracks: { E1: { kind: 'video', visualRole: 'effect' }, V1: { kind: 'video' } },
    items: [
      video('base', 'V1', 0, 60),
      { id: 'g', name: 'g', kind: 'gif', track: 'E1', startFrame: 0, durationInFrames: 60, src: '/media/uploads/x.gif' },
    ],
  };
  const gifPlan = planOverlayHybridExport({ state: gifOverlayState, allowCompatSpans: true });
  assert.equal(gifPlan.eligible, true);
  assert.equal(gifPlan.compatFrames, 0);

  const zoomOnly = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [video('z1', 'V1', 0, 60, { zoom: { startScale: 1, endScale: 1.3 } })],
  };
  assert.equal(planOverlayHybridExport({ state: zoomOnly, allowCompatSpans: true }).eligible, false);

  // buildSparseOverlayPlan skips excluded compat spans
  const sparseExcl = buildSparseOverlayPlan(
    {
      tracks: { T1: { kind: 'video', visualRole: 'text' } },
      items: [{ id: 't', name: 't', kind: 'text', track: 'T1', startFrame: 0, durationInFrames: 90, props: { text: '一直显示' } }],
    },
    0,
    90,
    null,
    [[30, 60]],
  );
  assert.ok(sparseExcl.spans.some((s) => s.from === 30 && s.to === 60 && s.sampleFrame === null));
  assert.deepEqual(sparseExcl.framesToRender, [0, 60]);

  // Real FFmpeg E2E segmented-hybrid + LUT3D + 10-bit/rotated source check
  if (bundledFfmpeg) {
    const { execFileSync } = await import('node:child_process');
    const segDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-seg-e2e-'));
    try {
      const srcMp4 = join(segDir, 'clip90.mp4');
      const outMp4 = join(segDir, 'seg-out.mp4');
      execFileSync(bundledFfmpeg, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:d=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', srcMp4,
      ], { stdio: 'ignore' });
      const segE2eState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['V1'],
        tracks: { V1: { kind: 'video' } },
        items: [
          video('s1', 'V1', 0, 45, {
            src: '/media/uploads/clip90.mp4',
            width: 320,
            height: 180,
            effects: [{ id: 'l1', assetId: 'builtin:slog3-s709', overrides: { intensity: 0.7 } }],
          }),
          video('s2', 'V1', 45, 45, {
            src: '/media/uploads/clip90.mp4',
            srcInFrame: 45,
            width: 320,
            height: 180,
          }),
        ],
        transitions: [
          { id: 't1', type: 'page-curl', durationInFrames: 20, outgoingItemId: 's1', incomingItemId: 's2', trackId: 'V1' },
        ],
      };
      const meta90 = {
        format: { start_time: '0', duration: '3.0' },
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180,
            avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', nb_frames: '90',
          },
          { codec_type: 'audio', codec_name: 'aac', channels: 1, sample_rate: '48000', start_time: '0', duration: '3.0' },
        ],
      };
      const compatRenderedRanges = [];
      const segRes = await tryOverlayHybridExport({
        state: segE2eState,
        outputLocation: outMp4,
        allowCompatSpans: true,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: segDir,
        assetsDirectory: join(process.cwd(), 'assets'),
        renderOverlayPlates: async () => ({ spans: [{ from: 0, to: 90, sampleFrame: null }], plateFiles: new Map() }),
        renderCompatRange: async ({ frameRange, outputPath }) => {
          compatRenderedRanges.push(frameRange);
          const cf = frameRange[1] - frameRange[0] + 1;
          execFileSync(bundledFfmpeg, [
            '-y', '-f', 'lavfi', '-i', `color=c=blue:s=320x180:rate=30:d=${(cf / 30).toFixed(6)}`,
            '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-frames:v', String(cf), outputPath,
          ], { stdio: 'ignore' });
        },
      }, { probe: async () => meta90, checkDisk: () => {} });
      assert.equal(segRes.renderRoute, 'hybrid');
      assert.equal(segRes.hybridMode, 'segmented-hybrid');
      assert.equal(segRes.compatFrames, 20);
      assert.deepEqual(compatRenderedRanges, [[35, 54]]);
      assert.ok((await stat(outMp4)).size > 2000, 'segmented hybrid MP4 created');
      assert.deepEqual(await readdir(segDir), ['clip90.mp4', 'seg-out.mp4'], 'segmented temp dir cleaned up');
    } finally {
      await rm(segDir, { recursive: true, force: true });
    }

    // Real FFmpeg E2E: VP9+Alpha WebM overlay over opaque H.264 base + transformed static mosaics below & above
    const alphaDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-alpha-e2e-'));
    try {
      const baseMp4 = join(alphaDir, 'base.mp4');
      const alphaWebm = join(alphaDir, 'alpha.webm');
      const outMp4 = join(alphaDir, 'alpha-mosaic-out.mp4');
      execFileSync(bundledFfmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=320x180:r=30:d=1',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', baseMp4,
      ], { stdio: 'ignore' });
      // Half-screen green with alpha=1 on left (x<160) and alpha=0 on right (x>=160)
      execFileSync(bundledFfmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=30:d=1,format=yuva420p,geq=r=0:g=255:b=0:a=if(lt(X\\,160)\\,255\\,0)',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
        '-deadline', 'realtime', '-cpu-used', '6', alphaWebm,
      ], { stdio: 'ignore' });

      const alphaMeta = {
        format: { start_time: '0', duration: '1.0' },
        streams: [{
          codec_type: 'video', codec_name: 'vp9', pix_fmt: 'yuva420p', width: 320, height: 180,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', nb_frames: '30',
          tags: { alpha_mode: '1' },
        }],
      };
      const baseMeta = {
        format: { start_time: '0', duration: '1.0' },
        streams: [{
          codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', nb_frames: '30',
        }],
      };
      const alphaState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['M2', 'V2', 'M1', 'V1'],
        tracks: {
          M2: { kind: 'video', visualRole: 'effect' },
          V2: { kind: 'video' },
          M1: { kind: 'video', visualRole: 'effect' },
          V1: { kind: 'video' },
        },
        items: [
          video('base', 'V1', 0, 30, { src: '/media/uploads/base.mp4', width: 320, height: 180 }),
          {
            id: 'm1', name: 'm1', kind: 'mosaic', track: 'M1', startFrame: 5, durationInFrames: 20,
            transform: { x: 25, y: 0, scaleX: 0.5, scaleY: 0.5 },
            mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4, strength: 60, feather: 0, opacity: 1 },
          },
          video('ov', 'V2', 5, 20, { src: '/media/uploads/alpha.webm', width: 320, height: 180 }),
          {
            id: 'm2', name: 'm2', kind: 'mosaic', track: 'M2', startFrame: 5, durationInFrames: 20,
            transform: { x: -25, y: 0, scaleX: 0.5, scaleY: 0.5 },
            mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.4, height: 0.4, strength: 60, feather: 0, opacity: 1 },
          },
        ],
      };
      const alphaRes = await tryOverlayHybridExport({
        state: alphaState,
        outputLocation: outMp4,
        allowCompatSpans: true,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: alphaDir,
        assetsDirectory: alphaDir,
        renderOverlayPlates: async () => ({ spans: [{ from: 0, to: 30, sampleFrame: null }], plateFiles: new Map() }),
      }, {
        probe: async (file) => (file.endsWith('alpha.webm') ? alphaMeta : baseMeta),
        checkDisk: () => {},
      });
      assert.equal(alphaRes.renderRoute, 'hybrid');
      assert.equal(alphaRes.hybridMode, 'overlay-plates');
      assert.equal(alphaRes.compatFrames ?? 0, 0);
      const samplePixel = (videoPath, frameIdx, x, y) => {
        const buf = execFileSync(bundledFfmpeg, [
          '-v', 'error', '-i', videoPath, '-vf', `select=eq(n\\,${frameIdx})`, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
        ], { encoding: 'buffer' });
        const idx = (y * 320 + x) * 3;
        return [buf[idx], buf[idx + 1], buf[idx + 2]];
      };
      // Sample frame 5 (exact localStart=5) & frame 10 (overlay active): left must be green, right must be red!
      for (const activeFrame of [5, 10]) {
        const leftPx = samplePixel(outMp4, activeFrame, 60, 90);
        const rightPx = samplePixel(outMp4, activeFrame, 260, 90);
        assert.ok(leftPx[1] > 180 && leftPx[0] < 60, `frame ${activeFrame} alpha=1 side must show green overlay, got ${leftPx}`);
        assert.ok(rightPx[0] > 180 && rightPx[1] < 60, `frame ${activeFrame} alpha=0 side must show red base video, got ${rightPx}`);
      }
      // Sample frame 2 (before overlay starts at 5): left pixel (60,90) must be red!
      const earlyLeft = samplePixel(outMp4, 2, 60, 90);
      assert.ok(earlyLeft[0] > 180 && earlyLeft[1] < 60, `before overlay starts must show red base, got ${earlyLeft}`);

      // Regression: late-offset alpha overlay where localStart (35) > overlay duration (10).
      // Previously `enable='between(n,35,44)'` evaluated `n` starting at 0 when the overlay began,
      // dropping the entire transparent overlay clip.
      const lateBaseMp4 = join(alphaDir, 'late-base.mp4');
      const lateAlphaWebm = join(alphaDir, 'late-alpha.webm');
      const lateOutMp4 = join(alphaDir, 'late-alpha-out.mp4');
      execFileSync(bundledFfmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=320x180:r=30:d=2',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', lateBaseMp4,
      ], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=30:d=0.333334,format=yuva420p,geq=r=0:g=255:b=0:a=if(lt(X\\,160)\\,255\\,0)',
        '-frames:v', '10',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
        '-deadline', 'realtime', '-cpu-used', '6', lateAlphaWebm,
      ], { stdio: 'ignore' });
      const lateBaseMeta = {
        format: { start_time: '0', duration: '2.0' },
        streams: [{
          codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', nb_frames: '60',
        }],
      };
      const lateAlphaMeta = {
        format: { start_time: '0', duration: '0.333334' },
        streams: [{
          codec_type: 'video', codec_name: 'vp9', pix_fmt: 'yuva420p', width: 320, height: 180,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', nb_frames: '10',
          tags: { alpha_mode: '1' },
        }],
      };
      const lateAlphaState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['V2', 'V1'],
        tracks: { V2: { kind: 'video' }, V1: { kind: 'video' } },
        items: [
          video('base', 'V1', 0, 60, { src: '/media/uploads/late-base.mp4', width: 320, height: 180 }),
          video('ov', 'V2', 35, 10, { src: '/media/uploads/late-alpha.webm', width: 320, height: 180 }),
        ],
      };
      const lateRes = await tryOverlayHybridExport({
        state: lateAlphaState,
        outputLocation: lateOutMp4,
        allowCompatSpans: true,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: alphaDir,
        assetsDirectory: alphaDir,
        renderOverlayPlates: async () => ({ spans: [{ from: 0, to: 60, sampleFrame: null }], plateFiles: new Map() }),
      }, {
        probe: async (file) => (file.endsWith('late-alpha.webm') ? lateAlphaMeta : lateBaseMeta),
        checkDisk: () => {},
      });
      assert.equal(lateRes.renderRoute, 'hybrid');
      for (const inactiveFrame of [34, 45]) {
        const leftPx = samplePixel(lateOutMp4, inactiveFrame, 60, 90);
        const rightPx = samplePixel(lateOutMp4, inactiveFrame, 260, 90);
        assert.ok(leftPx[0] > 180 && leftPx[1] < 60, `late frame ${inactiveFrame} left must show red base, got ${leftPx}`);
        assert.ok(rightPx[0] > 180 && rightPx[1] < 60, `late frame ${inactiveFrame} right must show red base, got ${rightPx}`);
      }
      for (const activeFrame of [35, 40, 44]) {
        const leftPx = samplePixel(lateOutMp4, activeFrame, 60, 90);
        const rightPx = samplePixel(lateOutMp4, activeFrame, 260, 90);
        assert.ok(leftPx[1] > 180 && leftPx[0] < 60, `late frame ${activeFrame} alpha=1 side must show green overlay, got ${leftPx}`);
        assert.ok(rightPx[0] > 180 && rightPx[1] < 60, `late frame ${activeFrame} alpha=0 side must show red base, got ${rightPx}`);
      }

      // Plan A E2E: bottom underlay + scaled/rotated/rounded foreground + faded mosaic + 6ch/offset audio
      const advOutMp4 = join(alphaDir, 'adv-plan-a-out.mp4');
      const portraitMp4 = join(alphaDir, 'portrait-6ch.mp4');
      const underlayPng = join(alphaDir, 'underlay-blue.png');
      execFileSync(bundledFfmpeg, [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0xff0000:s=180x320:r=30:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.5',
        '-filter_complex', '[1:a]pan=5.1(side)|FL=c0|FR=c0|FC=c0|LFE=c0|SL=c0|SR=c0[aout]',
        '-map', '0:v:0', '-map', '[aout]',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', portraitMp4,
      ], { stdio: 'ignore' });
      // Solid pure blue 320x180 PNG for mocked underlay plate render
      execFileSync(bundledFfmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180:r=1:d=1', '-frames:v', '1', underlayPng,
      ], { stdio: 'ignore' });
      const portraitMeta = {
        format: { start_time: '1.2', duration: '3.0' },
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 180, height: 320,
            avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '1.2', nb_frames: '30',
          },
          { codec_type: 'audio', codec_name: 'aac', channels: 6, sample_rate: '48000', start_time: '1.2', duration: '3.0' },
        ],
      };
      const advState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['M1', 'V1', 'BG'],
        tracks: {
          M1: { kind: 'video', visualRole: 'effect' },
          V1: { kind: 'video' },
          BG: { kind: 'video', visualRole: 'effect' },
        },
        items: [
          video('main_v', 'V1', 0, 30, {
            src: '/media/uploads/portrait-6ch.mp4',
            width: 180,
            height: 320,
            transform: { scale: 0.6, rotation: 20, borderRadius: 20 },
          }),
          { id: 'bg_solid', name: 'bg', kind: 'solid', track: 'BG', startFrame: 0, durationInFrames: 30, props: { color: '#0000ff' } },
          {
            id: 'm_fade', name: 'm_fade', kind: 'mosaic', track: 'M1', startFrame: 5, durationInFrames: 20,
            fadeInFrames: 5, fadeOutFrames: 5,
            mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.5, width: 0.25, height: 0.25, strength: 50, feather: 2, opacity: 1 },
          },
        ],
      };
      let plateRenderCalls = 0;
      const advRes = await tryOverlayHybridExport({
        state: advState,
        outputLocation: advOutMp4,
        allowCompatSpans: true,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: alphaDir,
        assetsDirectory: alphaDir,
        renderOverlayPlates: async ({ plan }) => {
          plateRenderCalls += 1;
          if (!plan.hasOverlays) return { spans: [{ from: 0, to: 30, sampleFrame: null }], plateFiles: new Map() };
          return { spans: [{ from: 0, to: 30, sampleFrame: 0 }], plateFiles: new Map([[0, underlayPng]]) };
        },
      }, { probe: async () => portraitMeta, checkDisk: () => {} });
      assert.equal(advRes.renderRoute, 'hybrid');
      assert.equal(advRes.compatFrames ?? 0, 0);
      assert.equal(plateRenderCalls, 2, 'underlay pass renders bottom solid plate separately');
      const advRgb = execFileSync(bundledFfmpeg, [
        '-v', 'error', '-i', advOutMp4, '-vf', 'select=eq(n\\,15)', '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { encoding: 'buffer' });
      const cornerPx = [advRgb[(10 * 320 + 10) * 3], advRgb[(10 * 320 + 10) * 3 + 1], advRgb[(10 * 320 + 10) * 3 + 2]];
      const centerPx = [advRgb[(90 * 320 + 160) * 3], advRgb[(90 * 320 + 160) * 3 + 1], advRgb[(90 * 320 + 160) * 3 + 2]];
      assert.ok(cornerPx[2] > 180 && cornerPx[0] < 60, `corner shows blue underlay behind rotated video, got ${cornerPx}`);
      assert.ok(centerPx[0] > 180 && centerPx[2] < 60, `center shows red foreground video over underlay, got ${centerPx}`);

      // Real backgroundFill E2E check
      const bgFillOut = join(alphaDir, 'bgfill-out.mp4');
      const bgFillState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['V1'],
        tracks: { V1: { kind: 'video' } },
        items: [
          video('main_v', 'V1', 0, 30, {
            src: '/media/uploads/portrait-6ch.mp4',
            width: 180,
            height: 320,
            backgroundFill: true,
            backgroundFillStrength: 50,
            transform: { borderRadius: 16 },
          }),
        ],
      };
      const bgRes = await tryOverlayHybridExport({
        state: bgFillState,
        outputLocation: bgFillOut,
        allowCompatSpans: true,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: alphaDir,
        assetsDirectory: alphaDir,
        renderOverlayPlates: async () => ({ spans: [{ from: 0, to: 30, sampleFrame: null }], plateFiles: new Map() }),
      }, { probe: async () => portraitMeta, checkDisk: () => {} });
      assert.equal(bgRes.renderRoute, 'hybrid');
      assert.equal(bgRes.compatFrames ?? 0, 0);
      const bgRgb = execFileSync(bundledFfmpeg, [
        '-v', 'error', '-i', bgFillOut, '-vf', 'select=eq(n\\,10)', '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { encoding: 'buffer' });
      const bgSidePx = [bgRgb[(90 * 320 + 20) * 3], bgRgb[(90 * 320 + 20) * 3 + 1], bgRgb[(90 * 320 + 20) * 3 + 2]];
      assert.ok(bgSidePx[0] > 100 && bgSidePx[1] < 40, `backgroundFill fills pillarbox area with dimmed blurred red, got ${bgSidePx}`);
    } finally {
      await rm(alphaDir, { recursive: true, force: true });
    }
  }
}

// 9. Regression: split transcribed audio clips follow explicit track srcInFrame geometry cleanly.
{
  const wordDrivenSplitState = {
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['V1', 'A1', 'A2'],
    tracks: {
      V1: { kind: 'video' },
      A1: { kind: 'audio', role: 'anchor' },
      A2: { kind: 'audio', role: 'follower', audioRouting: { duckDepthDb: -12 } },
    },
    items: [
      video('v_main', 'V1', 0, 320, { audioDetached: true }),
      audio('aud_ch0', 'A1', 0, 87, {
        src: '/media/uploads/narration.wav',
        srcInFrame: 3,
        transcript: [{ id: 'w0', text: '第零章', start: 100, end: 3000 }],
      }),
      audio('aud_ch1', 'A1', 100, 90, {
        src: '/media/uploads/narration.wav',
        srcInFrame: 120,
        transcript: [{ id: 'w1', text: '第一章', start: 4000, end: 7000 }],
      }),
      audio('aud_ch2', 'A1', 200, 90, {
        src: '/media/uploads/narration.wav',
        srcInFrame: 240,
        transcript: [{ id: 'w2', text: '第二章', start: 8000, end: 11000 }],
      }),
      audio('aud_del_a', 'A1', 290, 15, {
        src: '/media/uploads/narration.wav',
        srcInFrame: 360,
        transcript: [{ id: 'd0', text: '前', start: 12000, end: 12500 }],
      }),
      audio('aud_del_b', 'A1', 305, 15, {
        src: '/media/uploads/narration.wav',
        srcInFrame: 405,
        transcript: [{ id: 'd2', text: '后', start: 13500, end: 14000 }],
      }),
      audio('bgm', 'A2', 0, 320, { src: '/media/uploads/bgm.wav', volume: 0.3 }),
    ],
    transitions: [
      { id: 'tr_wd', type: 'audio-cross-fade', durationInFrames: 10, outgoingItemId: 'aud_ch0', incomingItemId: 'aud_ch1' },
    ],
  };

  const wdPlan = planOverlayHybridExport({ state: wordDrivenSplitState, allowCompatSpans: true });
  assert.equal(wdPlan.eligible, true, 'split audio uses native FFmpeg audio mix');
  assert.equal(wdPlan.hybridMode, 'overlay-plates');
  assert.equal(wdPlan.compatFrames, 0);

  const narrationSegs = wdPlan.audioSegments
    .filter((s) => s.src.endsWith('/narration.wav'))
    .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
  assert.equal(narrationSegs.length, 5, '3 single-run chapters + 2 runs around deleted word');
  assert.deepEqual(
    narrationSegs.map((s) => [s.timelineStartFrame, s.frames, s.sourceFrame]),
    [
      [0, 92, 3],
      [95, 95, 115],
      [200, 90, 240],
      [290, 15, 360],
      [305, 15, 405],
    ],
    'split transcribed clips resolve exact track srcInFrame geometry + real audio crossfade handles',
  );
  assert.equal(narrationSegs[0].timelineStartFrame, 0);
  assert.equal(narrationSegs[1].timelineStartFrame, 95);
}

// 10. Regression: PNG RGBA normalization & chunk frame-count verification guard.
{
  const fakePngDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-png-guard-'));
  try {
    const stubPath = join(fakePngDir, 'stub.png');
    await writeFile(stubPath, Buffer.from([137, 80, 78, 71]));
    const stubChanged = await normalizeOverlayPlatesToRgba({
      plateFiles: new Map([[0, stubPath]]),
      width: 320,
      height: 180,
      ffmpegExecutable: null,
    });
    assert.equal(stubChanged, 0, '4-byte test stub is skipped safely');

    // Frame-count guard rejects truncated chunk output.
    const guardPlan = planOverlayHybridExport({
      state: {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['V1'],
        tracks: { V1: { kind: 'video' } },
        items: [video('gv', 'V1', 0, 60, { width: 320, height: 180 })],
      },
      allowCompatSpans: true,
    });
    const guardSources = new Map([['/media/uploads/sample.mp4', { file: join(fakePngDir, 'sample.mp4') }]]);
    await assert.rejects(
      () => encodeChunk({
        chunk: { from: 0, to: 60, spans: [{ from: 0, to: 60, sampleFrame: null }], underlaySpans: [] },
        chunkIdx: 0,
        plan: guardPlan,
        sources: guardSources,
        plateFiles: new Map(),
        underlayPlateFiles: new Map(),
        blankPngPath: stubPath,
        temporary: fakePngDir,
        blurMaskCache: new Map(),
        ffmpegExecutable: 'ffmpeg',
        onChunkFrame: () => {},
        checkResources: () => {},
        run: async () => '',
        verifyChunkFrames: async () => 45,
      }),
      /produced 45 frames, expected 60/,
      'encodeChunk rejects mismatched output frame count',
    );
  } finally {
    await rm(fakePngDir, { recursive: true, force: true });
  }
}

// 11. Real FFmpeg E2E: word-driven split audio timing + mixed rgba/rgb24/gray/pal8 PNG normalization.
{
  let bundledFfmpeg = null;
  try {
    const mod = await import('ffmpeg-static');
    if (typeof mod.default === 'string' && existsSync(mod.default)) bundledFfmpeg = mod.default;
  } catch {}
  if (bundledFfmpeg) {
    const { execFileSync } = await import('node:child_process');
    const regDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-reg-e2e-'));
    try {
      // 11a. PNG format normalization unit + E2E check over multi-segment concat.
      const rgb24Png = join(regDir, 'plate-rgb24.png');
      const grayPng = join(regDir, 'plate-gray.png');
      const pal8Png = join(regDir, 'plate-pal8.png');
      const rgbaPng = join(regDir, 'plate-rgba.png');
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x000000:s=320x180:d=0.04', '-pix_fmt', 'rgb24', '-frames:v', '1', rgb24Png], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x000000:s=320x180:d=0.04', '-pix_fmt', 'gray', '-frames:v', '1', grayPng], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x000000:s=320x180:d=0.04', '-pix_fmt', 'pal8', '-frames:v', '1', pal8Png], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x000000@0.0:s=320x180:d=0.04', '-pix_fmt', 'rgba', '-frames:v', '1', rgbaPng], { stdio: 'ignore' });

      assert.equal(inspectPngIhdr(await readFile(rgb24Png)).colorType, 2);
      assert.equal(inspectPngIhdr(await readFile(grayPng)).colorType, 0);
      assert.equal(inspectPngIhdr(await readFile(pal8Png)).colorType, 3);
      assert.equal(inspectPngIhdr(await readFile(rgbaPng)).colorType, 6);

      const converted = await normalizeOverlayPlatesToRgba({
        plateFiles: new Map([[0, rgbaPng], [30, rgb24Png], [60, grayPng], [90, pal8Png]]),
        width: 320,
        height: 180,
        ffmpegExecutable: bundledFfmpeg,
      });
      assert.equal(converted, 3, 'converted rgb24, gray, and pal8 plates to uniform 8-bit RGBA while skipping existing RGBA');
      for (const p of [rgbaPng, rgb24Png, grayPng, pal8Png]) {
        const hdr = inspectPngIhdr(await readFile(p));
        assert.equal(hdr.colorType, 6, `${p} normalized to RGBA (colorType 6)`);
        assert.equal(hdr.bitDepth, 8);
        assert.equal(hdr.interlace, 0);
      }

      // 11b. Real FFmpeg E2E: 3 video segments (red, green, blue = 180 frames) + mixed rgba/rgb24/gray/pal8 plates + split word-driven audio.
      const vRed = join(regDir, 'red.mp4');
      const vGreen = join(regDir, 'green.mp4');
      const vBlue = join(regDir, 'blue.mp4');
      const splitWav = join(regDir, 'tones.wav');
      const outRegMp4 = join(regDir, 'reg-out.mp4');
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=320x180:r=30:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', vRed], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x180:r=30:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', vGreen], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x180:r=30:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', vBlue], { stdio: 'ignore' });
      // Synthesize 6s WAV: 0..2s = 440Hz, 2..4s = silence, 4..6s = 1760Hz
      execFileSync(bundledFfmpeg, [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=1760:sample_rate=48000:duration=2',
        '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]',
        '-map', '[a]', '-c:a', 'pcm_s16le', splitWav,
      ], { stdio: 'ignore' });

      // Recreate raw opaque rgb24 plate fresh so tryOverlayHybridExport's own normalization step converts it before ffconcat.
      const rawOpaquePlate = join(regDir, 'plate-60.png');
      const rawTransPlate = join(regDir, 'plate-90.png');
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x000000:s=320x180:d=0.04', '-pix_fmt', 'rgb24', '-frames:v', '1', rawOpaquePlate], { stdio: 'ignore' });
      execFileSync(bundledFfmpeg, ['-y', '-f', 'lavfi', '-i', 'nullsrc=s=320x180:d=0.04,format=rgba,geq=r=0:g=0:b=0:a=0', '-pix_fmt', 'rgba', '-frames:v', '1', rawTransPlate], { stdio: 'ignore' });

      const regState = {
        fps: 30,
        width: 320,
        height: 180,
        trackOrder: ['S1', 'V1', 'A1'],
        tracks: { S1: { kind: 'video', visualRole: 'effect' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
        items: [
          video('r1', 'V1', 0, 60, { src: '/media/uploads/red.mp4', width: 320, height: 180 }),
          video('r2', 'V1', 60, 60, { src: '/media/uploads/green.mp4', width: 320, height: 180 }),
          video('r3', 'V1', 120, 60, { src: '/media/uploads/blue.mp4', width: 320, height: 180 }),
          { id: 'blk', name: 'blk', kind: 'solid', track: 'S1', startFrame: 60, durationInFrames: 30, props: { color: '#000000' } },
          audio('a_p1', 'A1', 0, 60, {
            src: '/media/uploads/tones.wav',
            srcInFrame: 0,
            transcript: [{ id: 't1', text: '低音', start: 0, end: 2000 }],
          }),
          audio('a_p2', 'A1', 90, 60, {
            src: '/media/uploads/tones.wav',
            srcInFrame: 120,
            transcript: [{ id: 't2', text: '高音', start: 4000, end: 6000 }],
          }),
        ],
      };

      const vMeta = {
        format: { start_time: '0', duration: '2.0' },
        streams: [{
          codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180,
          avg_frame_rate: '30/1', r_frame_rate: '30/1', start_time: '0', nb_frames: '60',
        }],
      };
      const wavMeta = {
        format: { start_time: '0', duration: '6.0' },
        streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', channels: 1, sample_rate: '48000', start_time: '0', duration: '6.0' }],
      };

      const regRes = await tryOverlayHybridExport({
        state: regState,
        outputLocation: outRegMp4,
        allowCompatSpans: true,
        ffmpegExecutable: bundledFfmpeg,
        ffprobeExecutable: 'ffprobe',
        uploadsDirectory: regDir,
        assetsDirectory: regDir,
        renderOverlayPlates: async () => ({
          spans: [
            { from: 0, to: 60, sampleFrame: null },
            { from: 60, to: 90, sampleFrame: 60 },
            { from: 90, to: 180, sampleFrame: 90 },
          ],
          plateFiles: new Map([[60, rawOpaquePlate], [90, rawTransPlate]]),
        }),
      }, {
        probe: async (file) => (file.endsWith('.wav') ? wavMeta : vMeta),
        checkDisk: () => {},
      });
      assert.equal(regRes.renderRoute, 'hybrid');
      assert.equal(regRes.compatFrames ?? 0, 0);

      // Verify exact decoded frame count (180 frames, ZERO dropped frames!) and exact per-segment colors.
      const allRgb = execFileSync(bundledFfmpeg, [
        '-v', 'error', '-i', outRegMp4, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      const frameBytes = 320 * 180 * 3;
      assert.equal(allRgb.length, 180 * frameBytes, 'exact 180 video frames exported without drop/reconfig');
      const pxAt = (frameIdx) => {
        const off = frameIdx * frameBytes + (90 * 320 + 160) * 3;
        return [allRgb[off], allRgb[off + 1], allRgb[off + 2]];
      };
      const c15 = pxAt(15);
      const c75 = pxAt(75);
      const c105 = pxAt(105);
      const c150 = pxAt(150);
      assert.ok(c15[0] > 180 && c15[1] < 40 && c15[2] < 40, `frame 15 is red, got ${c15}`);
      assert.ok(c75[0] < 20 && c75[1] < 20 && c75[2] < 20, `frame 75 is opaque black solid, got ${c75}`);
      assert.ok(c105[1] > 180 && c105[0] < 40 && c105[2] < 40, `frame 105 resumes green without jump/drop, got ${c105}`);
      assert.ok(c150[2] > 180 && c150[0] < 40 && c150[1] < 40, `frame 150 is blue, got ${c150}`);

      // Verify exported audio frequencies: 0.5..1.0s ~440Hz, 2.2..2.7s silence, 3.5..4.0s ~1760Hz.
      const pcmOut = execFileSync(bundledFfmpeg, [
        '-v', 'error', '-i', outRegMp4, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-',
      ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
      const zeroCrossFreq = (startSec, durSec) => {
        const s0 = Math.round(startSec * 48000);
        const s1 = Math.min(Math.floor(pcmOut.length / 2), s0 + Math.round(durSec * 48000));
        let prev = pcmOut.readInt16LE(s0 * 2);
        let zc = 0;
        let peak = 0;
        for (let i = s0 + 1; i < s1; i++) {
          const cur = pcmOut.readInt16LE(i * 2);
          if (Math.abs(cur) > peak) peak = Math.abs(cur);
          if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) zc += 1;
          prev = cur;
        }
        return { peak, hz: (zc / 2) / ((s1 - s0) / 48000) };
      };
      const seg1Tone = zeroCrossFreq(0.5, 0.5);
      const gapTone = zeroCrossFreq(2.2, 0.5);
      const seg2Tone = zeroCrossFreq(3.5, 0.5);
      assert.ok(seg1Tone.peak > 1000 && Math.abs(seg1Tone.hz - 440) < 40, `first audio segment plays ~440Hz, got ${JSON.stringify(seg1Tone)}`);
      assert.ok(gapTone.peak < 200, `gap between split clips is silent, got ${JSON.stringify(gapTone)}`);
      assert.ok(seg2Tone.peak > 1000 && Math.abs(seg2Tone.hz - 1760) < 80, `second split audio segment seeks to 4.0s (~1760Hz) instead of repeating 0.0s (440Hz), got ${JSON.stringify(seg2Tone)}`);
    } finally {
      await rm(regDir, { recursive: true, force: true });
    }
  }
}

// 12. High-clip-count (>48 inputs) batched audio lane rendering + fractional audio srcInFrame + filter_complex_script
{
  const ffmpegExe = (await import('ffmpeg-static')).default;
  if (ffmpegExe && existsSync(ffmpegExe)) {
    const batchDir = await mkdtemp(join(tmpdir(), 'overlay-hybrid-batch-audio-'));
    try {
      const wavSrc = join(batchDir, 'voice.wav');
      const { execFileSync } = await import('node:child_process');
      execFileSync(ffmpegExe, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', wavSrc]);
      const denseItems = Array.from({ length: 120 }, (_, i) => ({
        id: `seg_${i}`,
        name: `seg_${i}`,
        kind: 'audio',
        track: 'A1',
        src: '/media/uploads/voice.wav',
        startFrame: i * 2,
        durationInFrames: 2,
        srcInFrame: i * 1.25,
        volume: 1,
      }));
      const denseState = {
        fps: 30,
        width: 320,
        height: 180,
        tracks: { A1: { kind: 'audio' } },
        trackOrder: ['A1'],
        items: denseItems,
      };
      const densePlan = planOverlayHybridExport({ state: denseState });
      assert.equal(densePlan.eligible, true, '120 fractional-srcIn audio clips stay on overlay-hybrid');
      assert.equal(densePlan.audioSegments.length, 120);
      assert.ok(Math.abs(densePlan.audioSegments[1].sourceFrame - 1.25) < 1e-9, 'sub-frame audio srcInFrame preserved');
      const outWav = await renderAudioTrack({
        plan: densePlan,
        sources: new Map([['/media/uploads/voice.wav', { file: wavSrc }]]),
        temporary: batchDir,
        ffmpegExecutable: ffmpegExe,
      });
      assert.ok(outWav && existsSync(outWav), 'batched audio WAV produced');
      const wavBytes = (await stat(outWav)).size;
      const expectedSamples = 240 / 30 * 48000;
      const expectedPcmBytes = expectedSamples * 2 * 4;
      assert.ok(Math.abs((wavBytes - 44) - expectedPcmBytes) <= 1024, `expected sample-exact ~${expectedPcmBytes} PCM bytes, got ${wavBytes - 44}`);
    } finally {
      await rm(batchDir, { recursive: true, force: true });
    }
  }
}

console.log('[verify] overlay-hybrid unit checks passed');
