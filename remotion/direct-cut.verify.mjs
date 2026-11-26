import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planDirectCutExport, planNativeExport, directCutSourceSupported, tryDirectCutExport, directCutCommand, checkDirectCutDisk } from './direct-cut.mjs';

const makeState = () => ({ fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { V1: { kind: 'video' }, C1: { kind: 'caption' } },
  items: [0, 1].map((n) => ({ id: String(n), kind: 'video', name: 'cut', track: 'V1',
    startFrame: 15 + n * 60, srcInFrame: 60 + n * 60, durationInFrames: 60,
    src: '/media/uploads/source.mp4', width: 1920, height: 1080, volume: 0.7 })) });
const metadata = () => ({ streams: [
  { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080,
    avg_frame_rate: '30/1', r_frame_rate: '30/1', nb_frames: '240', duration: '8', start_time: '0', sample_aspect_ratio: '1:1' },
  { codec_type: 'audio', channels: 2, sample_rate: '48000', start_time: '0', duration: '8' },
], format: { start_time: '0', duration: '8' } });
const state = makeState(), snapshot = JSON.stringify(state);
const adjustment = { id: 'mosaic', kind: 'mosaic', name: 'Mosaic', track: 'V2', startFrame: 0, durationInFrames: 135,
  mosaic: { shape: 'rectangle', centerX: .5, centerY: .5, width: .35, height: .35, strength: 70, feather: 0, opacity: 1 } };
const adjustmentState = { ...makeState(), items: [...makeState().items, adjustment] };
for (const planner of [planDirectCutExport, planNativeExport]) {
  assert.equal(planner({ state: adjustmentState, allowTextWindows: true }).reason, 'composition-mosaic');
  const nestedState = { ...makeState(), items: [{ id: 'nested', kind: 'sequence', name: 'Nested', track: 'V1',
    startFrame: 0, durationInFrames: 135, timelineId: 'child' }] };
  assert.equal(planner({ state: nestedState, project: { timelines: [{ ...adjustmentState, id: 'child' }] },
    allowTextWindows: true }).reason, 'composition-mosaic', 'nested adjustment cannot enter a partial fast render');
}
const plan = planDirectCutExport({ state });
assert.equal(plan.eligible, true);
assert.equal(plan.frames, 135);
assert.deepEqual(plan.segments, [{ frames: 15, src: null, volume: 0 },
  { frames: 120, src: '/media/uploads/source.mp4', sourceFrame: 60, volume: 0.7 }]);
assert.deepEqual(planDirectCutExport({ state, frameRange: [70, 89] }).segments,
  [{ frames: 20, src: '/media/uploads/source.mp4', sourceFrame: 115, volume: 0.7 }]);
assert.equal(JSON.stringify(state), snapshot, 'never mutate state/undo/project');
const ordinaryEditor = makeState();
ordinaryEditor.id = 'timeline'; ordinaryEditor.name = 'ordinary'; ordinaryEditor.order = 0;
ordinaryEditor.interaction = { mainTrackId: 'V1', magnet: true, linkage: true, linkedKinds: ['video', 'text'] };
ordinaryEditor.items[1].mainClipId = ordinaryEditor.items[0].id;
assert.equal(planDirectCutExport({ state: ordinaryEditor }).eligible, true,
  'normal editor interaction and follower anchors are metadata, not rendering effects');
ordinaryEditor.items[0].props = { visualEntrance: 'whip', visualEntranceFrames: 12 };
assert.equal(planNativeExport({ state: ordinaryEditor, allowTextWindows: true }).renderRoute, 'hybrid',
  'a real editor timeline can use local animation windows');
ordinaryEditor.items[0].unknownPixelProcessing = true;
assert.equal(planNativeExport({ state: ordinaryEditor, allowTextWindows: true }).eligible, false,
  'adding safe editing metadata does not permit unknown pixel processing');
const music = makeState();
music.tracks.A1 = { kind: 'audio', audioRouting: { gainDb: -6 } };
music.items.push({ id: 'music', kind: 'audio', track: 'A1', src: '/media/uploads/music.wav',
  startFrame: 30, srcInFrame: 15, durationInFrames: 150, volume: 0.5 });
const musicPlan = planDirectCutExport({ state: music, frameRange: [45, 149] });
assert.equal(musicPlan.eligible, true, 'music must not force browser video compositing');
assert.deepEqual(musicPlan.audio, [{ src: '/media/uploads/music.wav', startFrame: 0, frames: 105,
  sourceFrame: 30, volume: 0.5 * 10 ** (-6 / 20) }]);
music.tracks.A1.soloed = true;
assert.equal(planDirectCutExport({ state: music }).segments[1].volume, 0, 'solo music mutes source video');
music.tracks.A1.hidden = true;
assert.deepEqual(planDirectCutExport({ state: music }).audio, [], 'hidden track has no audio');
assert.throws(() => checkDirectCutDisk('unused', 1, () => ({ bavail: 2 * 1024 ** 3, bsize: 1 })), /disk/);
checkDirectCutDisk('unused', 0, () => ({ bavail: 3 * 1024 ** 3, bsize: 1 }));
const titled = makeState();
const animatedVideo = makeState();
animatedVideo.items[0].props = { visualEntrance: 'whip-up', visualEntranceFrames: 12, visualExit: 'fade', visualExitFrames: 18 };
const videoSnapshot = JSON.stringify(animatedVideo);
const animatedPlan = planNativeExport({ state: animatedVideo, allowTextWindows: true });
assert.equal(animatedPlan.renderRoute, 'hybrid');
assert.deepEqual(animatedPlan.segments.filter((s) => s.compositionRange).map((s) => s.compositionRange), [[15, 26], [57, 74]]);
assert.equal(animatedPlan.segments.filter((s) => !s.compositionRange).reduce((n, s) => n + s.frames, 0), 105, 'ordinary middle remains native');
assert.equal(JSON.stringify(animatedVideo), videoSnapshot);
animatedVideo.items[0].props.visualEntrance = 'none'; animatedVideo.items[0].props.visualExit = 'none';
assert.equal(planDirectCutExport({ state: animatedVideo }).eligible, true, 'reset animation retains native route');
animatedVideo.items[0].props.unsupportedEffect = 1;
assert.equal(planNativeExport({ state: animatedVideo, allowTextWindows: true }).eligible, false, 'unknown props cannot disappear in a fast route');
titled.items.push({ id: 'heading', kind: 'text', track: 'V2', startFrame: 30, durationInFrames: 30,
  props: { text: 'Chapter', entrance: 'wipe', entranceFrames: 6 } });
const titledSnapshot = JSON.stringify(titled);
const mixed = planNativeExport({ state: titled, allowTextWindows: true });
assert.equal(mixed.renderRoute, 'hybrid');
assert.deepEqual(mixed.segments.map(({ frames, compositionRange }) => ({ frames, compositionRange })), [
  { frames: 15, compositionRange: undefined }, { frames: 15, compositionRange: undefined },
  { frames: 30, compositionRange: [30, 59] }, { frames: 75, compositionRange: undefined },
]);
assert.equal(JSON.stringify(titled), titledSnapshot, 'hybrid never rewrites the saved project');
assert.equal(planNativeExport({ state: titled, allowTextWindows: false }).eligible, false);
assert.equal(planNativeExport({ state: titled, frameRange: [20, 99], allowTextWindows: true }).segments.find((s) => s.compositionRange).sourceFrame, 75);
titled.items.at(-1).durationInFrames = 105;
assert.equal(planNativeExport({ state: titled, allowTextWindows: true }).eligible, false, 'dense titles do not promise fast hybrid export');
const gap = makeState(); gap.items[1].startFrame += 10;
assert.deepEqual(planDirectCutExport({ state: gap }).segments.map((s) => s.frames), [15, 60, 10, 60]);
const muted = makeState(); muted.tracks.V1.muted = true;
assert.equal(planDirectCutExport({ state: muted }).segments[1].volume, 0);
const hidden = makeState(); hidden.tracks.V1.hidden = true;
assert.deepEqual(planDirectCutExport({ state: hidden }).segments, [{ frames: 135, src: null, volume: 0 }]);
const gain = makeState(); gain.tracks.V1.audioRouting = { gainDb: -6 };
assert.ok(Math.abs(planDirectCutExport({ state: gain }).segments[1].volume - 0.7 * 10 ** (-6 / 20)) < 1e-12);
for (const change of [
  (s) => s.items.push({ ...s.items[0], kind: 'text', track: 'V2' }),
  (s) => s.items[1].startFrame = 30,
  (s) => s.items[0].mask = { type: 'ellipse' },
  (s) => s.items[0].props = { visualEntrance: 'slide' },
  (s) => s.items[0].transform = { scale: 0.9 },
  (s) => s.items[0].transform = { crop: { left: 0 } },
  (s) => s.items[0].effects = [{ assetId: 'fx' }],
  (s) => s.items[0].filters = { blur: 2 },
  (s) => s.items[0].keyframes = { volume: [{ frame: 0, value: 1 }] },
  (s) => s.items[0].playbackRate = 1.25,
  (s) => s.items[0].fadeInFrames = 2,
  (s) => s.items[0].srcInFrame = -1,
  (s) => s.items[0].durationInFrames = 2.5,
  (s) => s.items[0].backgroundFill = true,
  (s) => s.items[0].newFutureEffect = true,
  (s) => s.newFutureOverlay = true,
  (s) => s.transitions = [{ type: 'cross-dissolve' }],
  (s) => s.captions = { enabled: true },
  (s) => s.tracks.C1.captions = { enabled: true },
  (s) => s.watermark = { enabled: true },
  (s) => s.tracks.V1.role = 'follower',
  (s) => s.tracks.V1.kind = 'audio',
]) { const candidate = makeState(); change(candidate); assert.equal(planDirectCutExport({ state: candidate }).eligible, false); }
{
  const withTranscript = makeState();
  withTranscript.items[0].transcript = [{ text: 'hello' }];
  assert.equal(planDirectCutExport({ state: withTranscript }).eligible, true, 'inert transcript metadata must not disqualify direct-cut under track-ssot-v1');
}
for (const options of [{ codec: 'prores' }, { scale: 0.5 }, { frameRange: [0, 999] }, { frameRange: [20, 10] }, { separateAudioTo: 'x.wav' }]) {
  assert.equal(planDirectCutExport({ state, ...options }).eligible, false);
}
const root = { ...state, id: 'main', name: 'Main', order: 0 };
assert.equal(planDirectCutExport({ state: root, project: { timelines: [root] }, timelineId: 'main' }).eligible, true);
assert.equal(planDirectCutExport({ state, project: { timelines: [root] }, timelineId: 'main' }).eligible, false);
const sourceSegments = plan.segments.filter((s) => s.src);
assert.equal(directCutSourceSupported(metadata(), plan, sourceSegments), true);
for (const change of [
  (m) => m.streams[0].pix_fmt = 'yuva420p',
  (m) => m.streams[0].codec_name = 'hevc',
  (m) => m.streams[0].width = 1280,
  (m) => m.streams[0].avg_frame_rate = '30000/1001',
  (m) => m.streams[0].r_frame_rate = '60/1',
  (m) => m.streams[0].nb_frames = '179',
  (m) => m.streams[0].color_transfer = 'smpte2084',
  (m) => m.streams[0].color_range = 'pc',
  (m) => m.streams[0].sample_aspect_ratio = '2:1',
  (m) => m.streams[0].tags = { rotate: '90' },
  (m) => m.streams[0].side_data_list = [{ rotation: -90 }],
  (m) => m.streams[0].start_time = '0.1',
  (m) => m.format.start_time = '0.1',
  (m) => m.streams[1].channels = 6,
  (m) => m.streams[1].start_time = '0.03',
  (m) => m.streams[1].duration = '5',
]) { const candidate = metadata(); change(candidate); assert.equal(directCutSourceSupported(candidate, plan, sourceSegments), false); }
const directory = await mkdtemp(path.join(tmpdir(), 'zuoren-direct-unit-'));
const oldSetting = process.env.CC_DIRECT_CUT_EXPORT;
try {
  const options = { state, outputLocation: path.join(directory, 'output.mp4'), uploadsDirectory: directory, assetsDirectory: directory,
    ffmpegExecutable: 'injected-ffmpeg', ffprobeExecutable: 'injected-ffprobe' };
  let calls = 0;
  process.env.CC_DIRECT_CUT_EXPORT = '0';
  assert.equal(await tryDirectCutExport(options, { probe: async () => { calls++; return metadata(); } }), null);
  assert.equal(calls, 0, 'escape hatch creates no work');
  process.env.CC_DIRECT_CUT_EXPORT = '1';
  const probes = [], runs = [], progress = [];
  const result = await tryDirectCutExport({ ...options, onProgress: (p) => progress.push(p) }, {
    probe: async (file) => { probes.push(file); return metadata(); },
    run: async (_, args, control) => { runs.push(args); control.onFrame?.(120); await writeFile(args.at(-1), 'fake-codec-output'); return ''; },
  });
  assert.equal(result.renderRoute, 'direct-cut'); assert.equal(result.encoder.id, 'libx264');
  assert.equal(probes.length, 1, 'continuous source probed once');
  assert.equal(runs.length, 3, 'black then merged media then single final mux');
  assert.equal(runs[1][runs[1].indexOf('-ss') + 1], '1.9', 'source seek includes bounded decoder preroll');
  assert.match(runs[1][runs[1].indexOf('-vf') + 1], /start_frame=3:end_frame=123/);
  assert.equal(runs[1][runs[1].indexOf('-colorspace') + 1], 'bt709');
  assert.match(runs[0][runs[0].indexOf('-c:a') + 1], /pcm_f32le/);
  assert.ok(runs[2].includes('aac')); assert.equal(progress.at(-1), 1);
  assert.equal(await readFile(options.outputLocation, 'utf8'), 'fake-codec-output');
  assert.deepEqual(await readdir(directory), ['output.mp4'], 'owned temporaries cleaned, caller output retained');
  for (const phase of ['probe', 'render']) {
    const controller = new AbortController(), original = new Error(`user cancelled ${phase}`);
    let renders = 0;
    await assert.rejects(tryDirectCutExport({ ...options, signal: controller.signal }, {
      probe: async () => { if (phase === 'probe') { controller.abort(original); throw original; } return metadata(); },
      run: async () => { renders++; controller.abort(original); throw original; },
    }), (error) => error === original);
    assert.equal(renders, phase === 'probe' ? 0 : 1, 'cancel never retries');
  }
  assert.deepEqual(await readdir(directory), ['output.mp4']);
  const fallback = [], failures = [];
  const outcome = await tryDirectCutExport({ ...options, h264Profile: { id: 'h264_amf' } }, {
    probe: async () => metadata(), run: async (_, args) => {
      fallback.push(args);
      if (args.includes('h264_amf')) { const error = new Error('AMF no device hardware encoder'); failures.push(error); throw error; }
      await writeFile(args.at(-1), 'software-after-hardware-failure'); return '';
    },
  });
  assert.equal(failures.length, 1); assert.equal(fallback.length, 4);
  assert.equal(outcome.encoder.id, 'libx264'); assert.match(outcome.encoderFallbackReason, /h264_amf/);
  await assert.rejects(tryDirectCutExport(options, { probe: async () => metadata(), run: async () => { throw new Error('non-encoder render failure'); } }), /non-encoder render failure/);
  assert.deepEqual(await readdir(directory), ['output.mp4'], 'failure cleans only owned temporaries');
  // Exercise actual Windows spawn cancellation and timeout WITHOUT video/browser.
  await assert.rejects(directCutCommand(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 50 }), /timeout/);
  const abort = new AbortController();
  const idle = directCutCommand(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { signal: abort.signal });
  abort.abort(new Error('real subprocess cancelled'));
  await assert.rejects(idle, /real subprocess cancelled/);
  let checks = 0;
  await assert.rejects(directCutCommand(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    checkResources: () => { if (++checks > 1) throw new Error('disk guard stopped export'); },
  }), /disk guard/);
} finally {
  if (oldSetting === undefined) delete process.env.CC_DIRECT_CUT_EXPORT; else process.env.CC_DIRECT_CUT_EXPORT = oldSetting;
  await rm(directory, { recursive: true, force: true });
}
console.log('direct-cut planner, metadata, merge/range/gaps/mute/gain, immutable snapshots, fallback, cancellation and cleanup passed');
