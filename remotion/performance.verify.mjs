import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  h264FfmpegOverride,
  hardwareEncoderFailureClass,
  isHardwareEncoderFailure,
  remotionHardwareAcceleration,
  resolveH264VideoBitrate,
  resolveOffthreadVideoThreads,
  resolveRenderConcurrency,
  resolveRenderMemorySettings,
  renderFfmpegOverride,
  withHardwareEncoderFallback,
  withEncoderProfileFallback,
} from './performance.mjs';

const abundantMemory = 64 * 1024 ** 3;
assert.equal(resolveRenderConcurrency({ cores: 10, memoryBytes: abundantMemory, freeMemoryBytes: abundantMemory }), 8);
assert.equal(resolveRenderConcurrency({ cores: 4, memoryBytes: abundantMemory, freeMemoryBytes: abundantMemory }), 3);
assert.equal(resolveRenderConcurrency({ cores: 2, memoryBytes: abundantMemory, freeMemoryBytes: abundantMemory }), 1);
assert.equal(resolveRenderConcurrency({ cores: 32, memoryBytes: abundantMemory, freeMemoryBytes: abundantMemory }), 24);
assert.equal(resolveRenderConcurrency({ cores: 32, memoryBytes: 16 * 1024 ** 3, freeMemoryBytes: abundantMemory }), 6);
assert.equal(resolveRenderConcurrency({ cores: 16, memoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 4 * 1024 ** 3 }), 1);
assert.equal(resolveRenderConcurrency({ cores: 16, memoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 1 * 1024 ** 3 }), 1);
assert.equal(resolveRenderConcurrency({ cores: 16, freeMemoryBytes: NaN }), 1);
assert.deepEqual(resolveRenderMemorySettings({ freeMemoryBytes: 4 * 1024 ** 3, cores: 16 }), {
  offthreadVideoCacheSizeInBytes: 64 * 1024 ** 2, mediaCacheSizeInBytes: 256 * 1024 ** 2, offthreadVideoThreads: 1,
});
assert.equal(resolveRenderMemorySettings({ freeMemoryBytes: 8 * 1024 ** 3, cores: 16 }).offthreadVideoThreads, 4);
assert.equal(resolveRenderMemorySettings({ freeMemoryBytes: NaN }).offthreadVideoCacheSizeInBytes, 64 * 1024 ** 2);
{
  const args = ['-r','30','-i','frames.jpg','-i','audio.wav','-c:v','libx264','-crf','18','out.mp4'];
  const small = renderFfmpegOverride({cores:16,freeMemoryBytes:3*1024**3})({type:'stitcher',args});
  assert.equal(small[small.indexOf('-threads:v')+1],'2');
  assert.equal(small.filter(value=>value==='-threads').length,2,'every input decoder is bounded');
  assert.equal(small[small.indexOf('-crf')+1],'18','quality does not change');
  assert(!args.includes('-threads'),'input arguments are immutable');
  const ample=renderFfmpegOverride({cores:16,freeMemoryBytes:8*1024**3})({args});
  assert.equal(ample[ample.indexOf('-threads:v')+1],'4');
  const copy=['-i','video.mp4','-c:v','copy','out.mp4'];
  assert.deepEqual(renderFfmpegOverride()({args:copy}),copy);
  const custom=h264FfmpegOverride('h264_amf');
  const hardware=renderFfmpegOverride({hardwareOverride:custom})({type:'stitcher',args});
  assert.equal(hardware[hardware.indexOf('-c:v')+1],'h264_amf');
  assert(!hardware.includes('-threads:v'),'hardware encoder retains its settings');
}
assert.equal(resolveRenderConcurrency({ cores: 10, override: '100%' }), 10);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '70%' }), 7);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '6' }), 6);
assert.equal(resolveRenderConcurrency({ cores: 10, override: '99' }), 10);
assert.equal(resolveRenderConcurrency({ cores: 10, memoryBytes: abundantMemory, freeMemoryBytes: abundantMemory, override: 'invalid' }), 8);

assert.equal(resolveOffthreadVideoThreads({ cores: 2 }), 1);
assert.equal(resolveOffthreadVideoThreads({ cores: 4 }), 2);
assert.equal(resolveOffthreadVideoThreads({ cores: 10 }), 3);
assert.equal(resolveOffthreadVideoThreads({ cores: 24 }), 4);

assert.equal(remotionHardwareAcceleration('h264', { platform: 'darwin', disabled: false }), 'required');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'win32', disabled: false }), 'required');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'linux', disabled: false }), 'required');
assert.equal(remotionHardwareAcceleration('vp8', { platform: 'darwin', disabled: false }), 'disable');
assert.equal(remotionHardwareAcceleration('h264', { platform: 'darwin', disabled: true }), 'disable');
assert.equal(remotionHardwareAcceleration('h264', {
  platform: 'linux', disabled: false, encoder: 'h264_nvenc',
}), 'required');
assert.equal(remotionHardwareAcceleration('h264', {
  platform: 'linux', disabled: false, encoder: 'h264_qsv',
}), 'disable');

assert.equal(resolveH264VideoBitrate({ width: 854, height: 480, fps: 30 }), '4000k');
assert.equal(resolveH264VideoBitrate({ width: 1920, height: 1080, fps: 30 }), '10000k');
assert.equal(resolveH264VideoBitrate({ width: 1920, height: 1080, fps: 60 }), '20000k');
assert.equal(resolveH264VideoBitrate({ width: 3840, height: 2160, fps: 60 }), '30000k');

assert.equal(isHardwareEncoderFailure(new Error('No NVENC capable devices found')), true);
assert.equal(isHardwareEncoderFailure(new Error('VideoToolbox encoder failed')), true);
assert.equal(isHardwareEncoderFailure(new Error('asset returned HTTP 404')), false);
assert.equal(hardwareEncoderFailureClass(new Error('/secret/device: No device')), 'device-unavailable');

const baseArgs = [
  '-r', '30', '-i', 'frames.png',
  '-c:v', 'libx264',
  '-vf', 'zscale=matrix=709',
  '-pix_fmt', 'yuv420p',
  'out.mp4',
];
const qsvArgs = h264FfmpegOverride('h264_qsv')({ type: 'pre-stitcher', args: baseArgs });
assert.equal(qsvArgs[qsvArgs.indexOf('-c:v') + 1], 'h264_qsv');
assert.equal(qsvArgs[qsvArgs.indexOf('-pix_fmt') + 1], 'nv12');
assert.equal(baseArgs[baseArgs.indexOf('-c:v') + 1], 'libx264', 'override must not mutate input');
const amfArgs = h264FfmpegOverride('h264_amf')({ type: 'pre-stitcher', args: baseArgs });
assert.equal(amfArgs[amfArgs.indexOf('-c:v') + 1], 'h264_amf');
assert.equal(amfArgs[amfArgs.indexOf('-pix_fmt') + 1], 'nv12');

const vaapiArgs = h264FfmpegOverride('h264_vaapi', {
  vaapiDevice: '/dev/dri/renderD129',
})({ type: 'stitcher', args: baseArgs });
assert.ok(vaapiArgs.indexOf('-vaapi_device') < vaapiArgs.indexOf('-i'));
assert.equal(vaapiArgs[vaapiArgs.indexOf('-vaapi_device') + 1], '/dev/dri/renderD129');
assert.equal(vaapiArgs[vaapiArgs.indexOf('-pix_fmt') + 1], 'vaapi');
assert.equal(
  vaapiArgs[vaapiArgs.indexOf('-vf') + 1],
  'zscale=matrix=709,format=nv12,hwupload',
);
const copyArgs = ['-i', 'chunk.mp4', '-c:v', 'copy', 'out.mp4'];
assert.deepEqual(
  h264FfmpegOverride('h264_amf')({ type: 'stitcher', args: copyArgs }),
  copyArgs,
);
const vp9OverlayArgs = [
  '-ss', '0', '-c:v', 'libvpx-vp9', '-i', 'overlay.webm',
  '-i', 'bg.mp4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'out.mp4',
];
const overriddenVp9 = h264FfmpegOverride('h264_amf')({ type: 'chunk', args: vp9OverlayArgs });
assert.equal(overriddenVp9[overriddenVp9.indexOf('-c:v') + 1], 'libvpx-vp9', 'input decoder before -i must stay untouched');
assert.equal(overriddenVp9[overriddenVp9.lastIndexOf('-c:v') + 1], 'h264_amf', 'output encoder after last -i becomes h264_amf');
assert.equal(overriddenVp9[overriddenVp9.lastIndexOf('-pix_fmt') + 1], 'nv12', 'output pix_fmt becomes nv12');

{
  const result = await withEncoderProfileFallback({
    render: async (options) => {
      if (options.mode === 'hardware') throw new Error('No NVENC capable devices found');
      return 'ok';
    },
    hardwareOptions: { mode: 'hardware' },
    softwareOptions: { mode: 'software' },
    hardwareProfile: {
      id: 'h264_nvenc',
      label: 'NVIDIA NVENC',
      hardware: true,
      transport: 'server',
    },
  });
  assert.equal(result.result, 'ok');
  assert.deepEqual(result.encoder, {
    id: 'libx264',
    label: 'Software (libx264)',
    hardware: false,
    transport: 'server',
  });
  assert.equal(result.encoderFallbackReason, 'h264_nvenc: device-unavailable');
}
{
  let attempts = 0;
  const assetError = new Error('asset returned HTTP 404');
  await assert.rejects(
    withEncoderProfileFallback({
      render: async () => { attempts += 1; throw assetError; },
      hardwareOptions: { mode: 'hardware' },
      softwareOptions: { mode: 'software' },
      hardwareProfile: {
        id: 'h264_nvenc',
        label: 'NVIDIA NVENC',
        hardware: true,
        transport: 'server',
      },
    }),
    (error) => error === assetError,
  );
  assert.equal(attempts, 1);
}

{
  const attempts = [];
  let cleaned = 0;
  const result = await withHardwareEncoderFallback({
    render: async (options) => {
      attempts.push(options);
      if (attempts.length === 1) throw new Error('No NVENC capable devices found');
      return 'ok';
    },
    hardwareOptions: { hardwareAcceleration: 'required', videoBitrate: '10000k' },
    softwareOptions: { hardwareAcceleration: 'disable', videoBitrate: null },
    cleanup: async () => { cleaned += 1; },
  });
  assert.equal(result, 'ok');
  assert.equal(cleaned, 1);
  assert.deepEqual(attempts, [
    { hardwareAcceleration: 'required', videoBitrate: '10000k' },
    { hardwareAcceleration: 'disable', videoBitrate: null },
  ]);
}

await assert.rejects(
  withHardwareEncoderFallback({
    render: async () => { throw new Error('asset returned HTTP 404'); },
    hardwareOptions: { hardwareAcceleration: 'required' },
    softwareOptions: { hardwareAcceleration: 'disable' },
  }),
  /HTTP 404/,
);

{
  const hardwareProfile = { id: 'h264_nvenc', hardware: true, label: 'NVENC', transport: 'server' };
  for (const cancelStage of ['render', 'cleanup', 'notice', 'abort-error']) {
    const controller = new AbortController();
    let attempts = 0;
    const cancellation = new DOMException('No NVENC capable devices found', 'AbortError');
    await assert.rejects(withEncoderProfileFallback({
      hardwareProfile, hardwareOptions: {}, softwareOptions: {}, signal: controller.signal,
      render: async () => {
        attempts++;
        if (cancelStage === 'render') controller.abort(cancellation);
        throw cancelStage === 'abort-error' ? cancellation : new Error('No NVENC capable devices found');
      },
      cleanup: async () => { if (cancelStage === 'cleanup') controller.abort(cancellation); },
      onFallback: () => { if (cancelStage === 'notice') controller.abort(cancellation); },
    }), (error) => error === cancellation);
    assert.equal(attempts, 1, `${cancelStage} cancellation never starts software rendering`);
  }
  const first = new Error('No NVENC capable devices found');
  const second = new Error('software failed');
  let attempts = 0;
  await assert.rejects(withEncoderProfileFallback({
    hardwareProfile, hardwareOptions: {}, softwareOptions: {},
    render: async () => { throw ++attempts === 1 ? first : second; },
  }), (error) => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second);
  assert.equal(attempts, 2, 'one software fallback, with both failures retained');
  const renderSource = await readFile(new URL('./render.mjs', import.meta.url), 'utf8');
  assert.match(renderSource, /withEncoderProfileFallback\(\{\s*render,\s*signal: abortSignal/);
}
// GL backend selection: angle on desktop platforms, angle-egl on Linux
// (headless renderers without X11), CC_RENDER_GL override for diagnosis.
{
  const render = await readFile(new URL('./render.mjs', import.meta.url), 'utf8');
  const browser = await readFile(new URL('./render-browser.mjs', import.meta.url), 'utf8');
  // Browser configuration/cancellation behaviour is covered at its interface
  // by render-browser.verify.mjs, not by matching a function's source location.
  assert.match(render, /from '\.\/render-browser\.mjs'/, 'render uses the shared browser module');
  assert.ok(((render + browser).match(/gl: resolveRenderGlBackend\(\)/g) ?? []).length >= 5, 'every render/still path uses the resolver');
  assert.match(render, /CC_REMOTION_BINARIES_DIR/, 'the packaged app supplies the mirrored compositor directory');
  // The packaged app ships as an asar archive: the compositor inside it can be neither
  // chmod'ed nor spawned, so every selectComposition / renderMedia / renderStill call must
  // render from the mirrored directory (null in dev, where the package path is a real file).
  assert.ok((render.match(/binariesDirectory: binariesDirectory\(\)/g) ?? []).length >= 5,
    'every composition selection, media render and still render passes the binaries directory');
  assert.doesNotMatch(render, /binariesDirectory: undefined/, 'the software retry keeps the binaries directory');
  assert.match(render, /attempt\.codec === 'h264'\s*\?\s*renderDirectHardware/,
    'hardware and software H.264 share the PCM mux clock; the encoder fallback keeps its own bounded override');
}
console.log('remotion performance verification passed');
