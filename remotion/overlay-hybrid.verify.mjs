import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDirectCutExport } from './direct-cut.mjs';
import {
  buildOverlayOnlyState,
  buildClipFilterChain,
  buildSparseOverlayPlan,
  exportFinalizationTimeoutMs,
  inspectOverlayHybridExport,
  planOverlayHybridExport,
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
  const withTransition = complexState();
  withTransition.transitions = [{ id: 'tr', type: 'cross-dissolve', durationInFrames: 15, fromId: 'v1', toId: 'v2' }];
  assert.equal(planOverlayHybridExport({ state: withTransition }).reason, 'transitions');

  const withMosaic = complexState();
  withMosaic.items.push({ id: 'm', name: 'm', kind: 'mosaic', track: 'E1', startFrame: 0, durationInFrames: 30, mosaic: { shape: 'rect', x: 0.2, y: 0.2, width: 0.2, height: 0.2, blockSize: 16 } });
  assert.equal(planOverlayHybridExport({ state: withMosaic }).reason, 'composition-mosaic');

  const overlayBelowVideo = complexState();
  overlayBelowVideo.trackOrder = ['V1', 'T1', 'E1', 'C1', 'A1', 'A2'];
  assert.equal(planOverlayHybridExport({ state: overlayBelowVideo }).reason, 'overlay-below-video');

  const rotatedVideo = complexState();
  rotatedVideo.items[0].transform.rotation = 15;
  assert.equal(planOverlayHybridExport({ state: rotatedVideo }).reason, 'transform-rotation-or-radius');

  const overlappingVideo = complexState();
  overlappingVideo.trackOrder = ['C1', 'T1', 'E1', 'V2', 'V1', 'A1', 'A2'];
  overlappingVideo.tracks.V2 = { kind: 'video' };
  overlappingVideo.items.push(video('pip', 'V2', 10, 30));
  assert.equal(planOverlayHybridExport({ state: overlappingVideo }).reason, 'overlapping-base-video');

  const ducked = complexState();
  ducked.tracks.A1.role = 'anchor';
  ducked.tracks.A2.role = 'follower';
  ducked.tracks.A2.audioRouting = { duckDepthDb: 6 };
  assert.equal(planOverlayHybridExport({ state: ducked }).reason, 'audio-ducking');

  const unknownState = complexState();
  unknownState.futureFeature = true;
  assert.equal(planOverlayHybridExport({ state: unknownState }).reason, 'state:futureFeature');

  const unknownItem = complexState();
  unknownItem.items[0].futureProp = 42;
  assert.equal(planOverlayHybridExport({ state: unknownItem }).reason, 'item:futureProp');

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

console.log('[verify] overlay-hybrid unit checks passed');
