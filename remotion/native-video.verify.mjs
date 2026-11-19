import assert from 'node:assert/strict';
import path from 'node:path';
import { nativeOpaqueVideoSources, localVideoPath, opaqueNativeVideo, nativeVideoExperimentEnabled } from './native-video.mjs';

assert.equal(nativeVideoExperimentEnabled({}), false, 'slower native candidate is disabled by default');
for (const value of ['0', 'true', 'yes', '']) assert.equal(nativeVideoExperimentEnabled({ CC_EXPERIMENT_NATIVE_VIDEO: value }), false);
assert.equal(nativeVideoExperimentEnabled({ CC_EXPERIMENT_NATIVE_VIDEO: '1' }), true);

for (const pix_fmt of ['yuv420p', 'yuvj422p', 'yuv444p', 'nv12', 'gbrp']) {
  assert.equal(opaqueNativeVideo({ codec_name: 'h264', pix_fmt }), true);
}
for (const stream of [{}, { codec_name: 'h264', pix_fmt: 'rgba' }, { codec_name: 'h264', pix_fmt: 'yuva420p' },
  { codec_name: 'h264', pix_fmt: 'yuv420p10le' }, { codec_name: 'vp9', pix_fmt: 'yuv420p' },
  { codec_name: 'hevc', pix_fmt: 'yuv420p' }]) assert.equal(opaqueNativeVideo(stream), false);
const uploads = path.resolve('probe-media-root'), assets = path.resolve('assets');
assert.equal(localVideoPath('/media/uploads/x%20y.mp4', uploads, assets), path.join(uploads, 'x y.mp4'));
for (const source of ['/media/uploads/%2e%2e/%2e%2e/private.mp4', '/media/uploads/..%5cprivate.mp4',
  '/media/uploads/%00x.mp4', '/media/uploads/%ff.mp4', 'https://example.org/video.mp4', '//example.org/video.mp4']) {
  assert.equal(localVideoPath(source, uploads, assets), null);
}
const opaque = { kind: 'video', src: '/media/uploads/opaque.mp4' };
const unknown = { kind: 'video', src: '/media/uploads/unknown.webm' };
const nested = { kind: 'video', src: '/media/uploads/nested.mp4' };
const state = { items: [opaque, opaque, unknown, { kind: 'audio', src: '/media/uploads/music.wav' }] };
const before = JSON.stringify(state), calls = [];
assert.deepEqual(await nativeOpaqueVideoSources(state, { timelines: [{ items: [nested, opaque] }] }, {
  uploadsDirectory: uploads, assetsDirectory: assets, probe: async (file) => {
    calls.push(file); if (file.endsWith('unknown.webm')) throw Object.assign(new Error('probe failed'), { code: 'ENOENT' });
    return { codec_name: 'h264', pix_fmt: 'yuv420p' };
  },
}), [opaque.src, nested.src]);
assert.equal(calls.length, 3, 'one local probe per unique video, including nested sequences');
assert.equal(JSON.stringify(state), before, 'no timeline/project mutation');
const controller = new AbortController();
await assert.rejects(nativeOpaqueVideoSources(state, undefined, {
  uploadsDirectory: uploads, assetsDirectory: assets, signal: controller.signal,
  probe: async () => { controller.abort(new Error('user cancelled')); throw new Error('probe interrupted'); },
}), /user cancelled/);
console.log('native opaque-video metadata, alpha/HDR fallback, nesting, paths and cancellation checks passed');
