import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildPreviewProxy,
  handlePreviewProxy,
  handlePreviewProxyFile,
  hasAlphaChannel,
  PREVIEW_ALPHA_PROXY_KIND,
  PREVIEW_PROXY_KIND,
  previewAlphaProxyEncodeArgs,
  previewProxyEncodeArgs,
  previewProxyReason,
  probePreviewSource,
  type PreviewSourceProbe,
} from './preview-proxy';
import { ffmpegBin, ffprobeBin } from './media-binaries';

const ordinaryHd: PreviewSourceProbe = {
  durationMs: 180_000, width: 1920, height: 1080, codec: 'h264',
  longGop: false, unstableCodec: false, bitrate: 5_000_000, hasBFrames: true, maxKeyframeGapSeconds: 1, frameRate: 30,
  hasAlpha: false,
};
assert.equal(previewProxyReason(ordinaryHd, false), null);
assert.equal(previewProxyReason({ ...ordinaryHd, width: 1080, height: 1920 }, false), null);
assert.equal(previewProxyReason({ ...ordinaryHd, bitrate: 14_000_000 }, false), 'high-hd-bitrate');
assert.equal(previewProxyReason({ ...ordinaryHd, durationMs: 8_000, bitrate: 14_000_000 }, false), null);
assert.equal(previewProxyReason({ ...ordinaryHd, maxKeyframeGapSeconds: 2.5 }, false), 'long-hd-gop');
assert.equal(previewProxyReason({ ...ordinaryHd, maxKeyframeGapSeconds: 2.5, hasBFrames: false }, false), null);
assert.equal(previewProxyReason({ ...ordinaryHd, maxKeyframeGapSeconds: 2.5, durationMs: 10_000 }, false), null);
assert.equal(previewProxyReason({ ...ordinaryHd, maxKeyframeGapSeconds: 2.5, durationMs: 60_000 }, false), 'long-hd-gop');
assert.equal(previewProxyReason({ ...ordinaryHd, frameRate: 60 }, false), 'high-framerate-hd');
assert.equal(previewProxyReason({ ...ordinaryHd, pixFmt: 'yuv420p10le' }, false), 'high-bit-depth');
assert.equal(previewProxyReason({ ...ordinaryHd, width: 3840, height: 2160 }, false), 'high-resolution');
assert.equal(previewProxyReason({ ...ordinaryHd, longGop: true }, false), 'long-gop');
assert.equal(previewProxyReason(ordinaryHd, true), 'direct-preview-failed');

assert.equal(hasAlphaChannel('yuv420p'), false);
assert.equal(hasAlphaChannel('yuv420p', { alpha_mode: '1' }), true);
assert.equal(hasAlphaChannel('yuv420p', { ALPHA_MODE: 'true' }), true);
assert.equal(hasAlphaChannel('yuva444p10le'), true);
assert.equal(hasAlphaChannel('rgba'), true);

assert.equal(
  previewProxyReason({ ...ordinaryHd, codec: 'vp9', width: 1280, height: 720, hasAlpha: true }, true),
  null,
  'lightweight <=720p short-GOP transparent video keeps original stream without extra proxy',
);
assert.equal(
  previewProxyReason({ ...ordinaryHd, codec: 'vp9', width: 1920, height: 1080, hasAlpha: true }, false),
  'high-resolution-alpha',
  '1080p transparent overlays generate a 720p alpha proxy',
);
assert.equal(
  previewProxyReason({ ...ordinaryHd, codec: 'vp9', width: 1280, height: 720, longGop: true, hasAlpha: true }, false),
  'long-gop-alpha',
  'long-GOP transparent overlays generate a short-GOP alpha proxy',
);
assert.equal(
  previewProxyReason({ ...ordinaryHd, codec: 'prores', unstableCodec: true, hasAlpha: true }, true),
  'unstable-codec',
  'non-browser transparent video requires an alpha-preserving WebM proxy',
);
const vp9AlphaArgs = previewAlphaProxyEncodeArgs('in.webm', 'out.webm', 30, 'vp9');
assert.equal(vp9AlphaArgs[vp9AlphaArgs.indexOf('-i') - 2], '-c:v');
assert.equal(vp9AlphaArgs[vp9AlphaArgs.indexOf('-i') - 1], 'libvpx-vp9', 'VP9 alpha inputs explicitly select libvpx-vp9 decoder before -i');
assert.deepEqual(
  vp9AlphaArgs.slice(vp9AlphaArgs.indexOf('-tile-columns'), vp9AlphaArgs.indexOf('-tile-columns') + 4),
  ['-tile-columns', '2', '-frame-parallel', '1'],
  'VP9 alpha proxy enables tile-columns and frame-parallel for multi-threaded Chromium decoding',
);

const directory = await mkdtemp(join(tmpdir(), 'zuoren-proxy-retry-'));
try {
  const original = join(directory, 'original.mp4');
  execFileSync(ffmpegBin(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:d=0.3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', original], { windowsHide: true });
  const before = await readFile(original);
  const status = join(directory, `${PREVIEW_PROXY_KIND}-status.json`);
  await writeFile(status, JSON.stringify({ reason: 'disk-full', error: 'fixture failure' }));
  let payload: { proxy: { status: string; previewSrc?: string } } | undefined;
  const dependencies: Parameters<typeof handlePreviewProxy>[2] = {
    resolve: async () => ({ name: 'original.mp4', file: original, source: { size: before.length, mtimeMs: 1 } }),
    cachePath: (_name, _source, kind, ext) => join(directory, `${kind}.${ext}`),
    atomicBuild: async (path, build) => { const temp = `${path}.tmp.mp4`; await build(temp); await rename(temp, path); },
    runDerivative: async (_req, _res, _key, work, _protected, retained) => {
      assert.equal(retained, true, 'proxy route retains its queue lease across client disconnects');
      return work(new AbortController().signal);
    },
    serveCached: async () => {}, sendJson: (_res, _code, body) => { payload = body as typeof payload; },
    handleError: (_res, _label, error) => { throw error; }, logError: () => {},
  };
  const request = (suffix: string) => handlePreviewProxy(
    { url: `/api/preview-proxy?src=original.mp4&force=1${suffix}` } as IncomingMessage,
    { destroyed: false } as ServerResponse, dependencies);
  await request('');
  assert.equal(payload?.proxy.status, 'failed', 'ordinary requests respect cached failure');
  await request('&retry=1');
  assert.equal(payload?.proxy.status, 'ready', 'explicit retry clears failure and builds a real proxy');
  const readySource = payload?.proxy.previewSrc;
  assert.match(readySource!, /revision=\d+/);
  await request('');
  assert.equal(payload?.proxy.previewSrc, readySource, 'cache lookup retains the same decoder identity');
  await request('&retry=1');
  assert.notEqual(payload?.proxy.previewSrc, readySource, 'actual rebuild invalidates stale browser/decoder state');
  assert.deepEqual(await readFile(original), before, 'master bytes untouched');
  assert((await readFile(join(directory, `${PREVIEW_PROXY_KIND}.mp4`))).length > 0);
  const probe = JSON.parse(execFileSync(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', join(directory, `${PREVIEW_PROXY_KIND}.mp4`)], {encoding:'utf8',windowsHide:true}));
  assert.equal(probe.streams[0].width, 1280, 'smooth preview uses a bounded 720p derivative');
  assert.equal(probe.streams[0].height, 720);
  const pidFile = join(directory, 'proxy-child.pid');
  const parentCode = `
    import { existsSync, writeFileSync } from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const marker = process.argv[1];
    const originalSpawn=childProcess.spawn;
    childProcess.spawn=(...args)=>{const child=originalSpawn(...args);writeFileSync(marker,String(child.pid));return child;};
    syncBuiltinESMExports();
    const { runPreviewProcess } = await import(${JSON.stringify(new URL('./preview-proxy.ts', import.meta.url).href)});
    void runPreviewProcess(${JSON.stringify(ffmpegBin())}, ['-v','error','-re','-f','lavfi','-i','color=s=64x64:r=1:d=1000','-f','null','-'], new AbortController().signal, 10000).catch(()=>{});
    const timer=setInterval(()=>{if(existsSync(marker))process.exit(0)},25);
    setTimeout(()=>{clearInterval(timer);process.exit(1)},5000);
  `;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', parentCode, pidFile],
    { windowsHide: true, timeout: 10000 });
  const childPid = Number(await readFile(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  let childStillRunning = true;
  try { process.kill(childPid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') childStillRunning = false; else throw error; }
  if (childStillRunning) process.kill(childPid, 'SIGKILL');
  assert.equal(childStillRunning, false, 'application exit must terminate a retained proxy subprocess');
  await assert.rejects(readFile(status), { code: 'ENOENT' });
  assert.equal(PREVIEW_PROXY_KIND, 'proxy-720-v2', 'fast-decode proxy bumps derivative kind');
  const encodeArgs = previewProxyEncodeArgs(original, 'out.mp4');
  assert.ok(encodeArgs.includes('ultrafast'), 'proxy uses ultrafast preset');
  assert.ok(encodeArgs.includes('fastdecode'), 'proxy uses fastdecode tune');
  assert.ok(encodeArgs.includes('baseline'), 'proxy uses baseline profile without B-frames for instant seeking');
  assert.ok(encodeArgs.includes('expr:gte(t,n_forced*0.5)'), 'proxy inserts 0.5s keyframe cadence');
  const inputIndex = encodeArgs.indexOf('-i');
  assert(encodeArgs.slice(0, inputIndex).includes('-filter_threads'));
  const codecThreadCaps = encodeArgs.flatMap((arg, index) => arg === '-threads' ? [Number(encodeArgs[index + 1])] : []);
  assert.equal(codecThreadCaps.length, 2, 'cap the decoder and both software/hardware encode routes independently');
  assert(codecThreadCaps.every(cap => cap >= 1 && cap <= 4));
  const amf = previewProxyEncodeArgs(original, 'amf.mp4', 'h264_amf', 25);
  assert(amf.includes('h264_amf') && amf.includes('nv12') && amf.includes('-maxrate'));
  assert.equal(amf[amf.indexOf('-profile:v') + 1], 'constrained_baseline');
  assert.equal(amf[amf.indexOf('-g') + 1], '12', 'hardware GOP follows the source frame rate');
  assert.deepEqual(amf.slice(amf.indexOf('-bf'), amf.indexOf('-bf') + 2), ['-bf', '0']);
  assert(!amf.includes('ultrafast'), 'do not send software-only options to a hardware encoder');
  const unavailable = process.platform === 'darwin' ? 'h264_amf' : 'h264_videotoolbox';
  const fallbackOutput = join(directory, 'fallback.mp4');
  await buildPreviewProxy(original, fallbackOutput, new AbortController().signal, { preferred: unavailable });
  assert((await readFile(fallbackOutput)).length > 0, 'a failed hardware encode retries in software');
  await assert.rejects(buildPreviewProxy(original, join(directory, 'cancelled.mp4'), AbortSignal.abort(), { preferred: unavailable }), { name: 'AbortError' });
  await assert.rejects(readFile(join(directory, 'cancelled.mp4')), { code: 'ENOENT' });
  const proxySourceProbe = await probePreviewSource(join(directory, `${PREVIEW_PROXY_KIND}.mp4`), new AbortController().signal);
  assert.equal(proxySourceProbe.hasBFrames, false);
  assert(proxySourceProbe.maxKeyframeGapSeconds !== null && proxySourceProbe.maxKeyframeGapSeconds < 0.56);

  // Lightweight 320x180 transparent VP9 WebM: probe detects alpha_mode=1 and hasAudio=false,
  // and keeps original stream without creating an unnecessary proxy.
  const alphaWebm = join(directory, 'alpha-overlay.webm');
  execFileSync(ffmpegBin(), [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00@0.5:s=320x180:d=0.3,format=yuva420p',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
    '-deadline', 'realtime', '-cpu-used', '6', alphaWebm,
  ], { windowsHide: true });
  const alphaWebmProbe = await probePreviewSource(alphaWebm, new AbortController().signal);
  assert.equal(alphaWebmProbe.hasAlpha, true, 'WebM alpha_mode=1 is detected as transparent');
  assert.equal(alphaWebmProbe.hasAudio, false, 'silent transparent WebM reports hasAudio=false');
  await writeFile(join(directory, 'alpha-overlay.webm.proxy-720-v2.mp4'), 'stale opaque cache');
  let alphaWebmPayload: { source: { hasAlpha?: boolean; hasAudio?: boolean }; proxy: { status: string; reason: string } } | undefined;
  await handlePreviewProxy(
    { url: '/api/preview-proxy?src=alpha-overlay.webm&force=1' } as IncomingMessage,
    { destroyed: false } as ServerResponse,
    {
      ...dependencies,
      resolve: async () => ({ name: 'alpha-overlay.webm', file: alphaWebm, source: { size: 1, mtimeMs: 1 } }),
      cachePath: (name, _source, kind, ext) => join(directory, `${name}.${kind}.${ext}`),
      sendJson: (_res, _code, body) => { alphaWebmPayload = body as typeof alphaWebmPayload; },
    },
  );
  assert.equal(alphaWebmPayload?.source.hasAlpha, true);
  assert.equal(alphaWebmPayload?.source.hasAudio, false);
  assert.equal(alphaWebmPayload?.proxy.status, 'not-needed');
  assert.equal(alphaWebmPayload?.proxy.reason, 'alpha-channel-preserved');

  // 1080p transparent VP9 WebM: builds a 720p fast-seek alpha-preserving VP9 WebM proxy.
  const hdAlphaWebm = join(directory, 'alpha-1080p.webm');
  execFileSync(ffmpegBin(), [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00@0.5:s=1920x1080:d=0.6:r=30,format=yuva420p',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
    '-deadline', 'realtime', '-cpu-used', '8', hdAlphaWebm,
  ], { windowsHide: true });
  let hdAlphaPayload: { source: { hasAlpha?: boolean; hasAudio?: boolean }; proxy: { status: string; reason?: string; previewSrc?: string } } | undefined;
  await handlePreviewProxy(
    { url: '/api/preview-proxy?src=alpha-1080p.webm' } as IncomingMessage,
    { destroyed: false } as ServerResponse,
    {
      ...dependencies,
      resolve: async () => ({ name: 'alpha-1080p.webm', file: hdAlphaWebm, source: { size: 2, mtimeMs: 2 } }),
      cachePath: (name, _source, kind, ext) => join(directory, `${name}.${kind}.${ext}`),
      atomicBuild: async (path, build) => { const temp = `${path}.tmp.${path.endsWith('.webm') ? 'webm' : 'mp4'}`; await build(temp); await rename(temp, path); },
      sendJson: (_res, _code, body) => { hdAlphaPayload = body as typeof hdAlphaPayload; },
    },
  );
  assert.equal(hdAlphaPayload?.proxy.status, 'ready');
  assert.equal(hdAlphaPayload?.proxy.reason, 'high-resolution-alpha');
  assert.match(hdAlphaPayload?.proxy.previewSrc ?? '', /&format=webm&revision=\d+/);
  const builtHdAlpha = join(directory, `alpha-1080p.webm.${PREVIEW_ALPHA_PROXY_KIND}.webm`);
  const builtHdAlphaProbe = await probePreviewSource(builtHdAlpha, new AbortController().signal);
  assert.equal(builtHdAlphaProbe.width, 1280);
  assert.equal(builtHdAlphaProbe.height, 720);
  assert.equal(builtHdAlphaProbe.hasAlpha, true);
  assert.equal(builtHdAlphaProbe.hasAudio, false);
  assert(builtHdAlphaProbe.maxKeyframeGapSeconds !== null && builtHdAlphaProbe.maxKeyframeGapSeconds < 0.6);

  // Non-browser transparent MOV (RGBA PNG codec): builds an alpha-preserving VP9 WebM proxy and serves it.
  const alphaMov = join(directory, 'alpha-prores-like.mov');
  execFileSync(ffmpegBin(), [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff0000@0.5:s=320x180:d=0.3,format=rgba',
    '-c:v', 'png', '-pix_fmt', 'rgba', alphaMov,
  ], { windowsHide: true });
  const alphaMovProbe = await probePreviewSource(alphaMov, new AbortController().signal);
  assert.equal(alphaMovProbe.hasAlpha, true);
  assert.equal(alphaMovProbe.unstableCodec, true);
  let alphaMovPayload: { proxy: { status: string; previewSrc?: string } } | undefined;
  let servedPath = '';
  const alphaMovDeps: Parameters<typeof handlePreviewProxy>[2] = {
    ...dependencies,
    resolve: async () => ({ name: 'alpha-prores-like.mov', file: alphaMov, source: { size: 1, mtimeMs: 1 } }),
    cachePath: (name, _source, kind, ext) => join(directory, `${name}.${kind}.${ext}`),
    atomicBuild: async (path, build) => { const temp = `${path}.tmp.${path.endsWith('.webm') ? 'webm' : 'mp4'}`; await build(temp); await rename(temp, path); },
    serveCached: async (_req, _res, path) => { servedPath = path; },
    sendJson: (_res, _code, body) => { alphaMovPayload = body as typeof alphaMovPayload; },
  };
  await handlePreviewProxy(
    { url: '/api/preview-proxy?src=alpha-prores-like.mov&force=1' } as IncomingMessage,
    { destroyed: false } as ServerResponse,
    alphaMovDeps,
  );
  assert.equal(alphaMovPayload?.proxy.status, 'ready');
  assert.match(alphaMovPayload?.proxy.previewSrc ?? '', /&format=webm&revision=\d+/);
  const builtAlphaWebm = join(directory, `alpha-prores-like.mov.${PREVIEW_ALPHA_PROXY_KIND}.webm`);
  const builtAlphaProbe = await probePreviewSource(builtAlphaWebm, new AbortController().signal);
  assert.equal(builtAlphaProbe.codec, 'vp9');
  assert.equal(builtAlphaProbe.hasAlpha, true, 'generated WebM proxy preserves alpha channel');
  await handlePreviewProxyFile(
    { url: alphaMovPayload!.proxy.previewSrc! } as IncomingMessage,
    { setHeader: () => {}, destroyed: false } as unknown as ServerResponse,
    alphaMovDeps,
  );
  assert.equal(servedPath, builtAlphaWebm, 'format=webm serves the alpha-preserving WebM proxy');

  console.log('preview-proxy.verify: explicit retry, alpha preservation, 720p alpha proxy, and master isolation passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
