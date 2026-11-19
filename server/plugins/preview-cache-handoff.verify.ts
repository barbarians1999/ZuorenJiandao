import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../../desktop/mini-connect';

const root = await mkdtemp(join(tmpdir(), 'zuoren-preview-handoff-'));
process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
process.env.OPENCHATCUT_DATA_DIR = root;
process.env.MEDIA_PREVIEW_MAX_BYTES = '1';
const { mediaPreviewPlugin, runDerivative, deleteMediaPreviewDerivatives } = await import('./media-preview');
const { DerivativeQueue } = await import('../derivative-queue');
const { uploadDir } = await import('../media-dir');
const { ffmpegBin } = await import('../media-binaries');
const app = createMiniConnect((error) => { throw error; });
const server = createServer((req, res) => app.handle(req, res));
const plugin = mediaPreviewPlugin();
const configure = plugin.configureServer;
assert.equal(typeof configure, 'function');
try {
  await mkdir(uploadDir(), { recursive: true });
  {
    const queue = new DerivativeQueue(1);
    let finishCancelledWork!: () => void;
    let finishReplacement!: () => void;
    let startCancelledWork!: () => void;
    let startReplacement!: () => void;
    const cancelledStarted = new Promise<void>((resolve) => { startCancelledWork = resolve; });
    const replacementStarted = new Promise<void>((resolve) => { startReplacement = resolve; });
    const first = queue.acquire('same-frame', async (signal) => {
      startCancelledWork();
      await new Promise<void>((resolve) => { finishCancelledWork = resolve; });
      assert.equal(signal.aborted, true, 'closing the last lease aborts the old derivative work');
      return 'cancelled-result';
    });
    await cancelledStarted;
    first.release();
    const replacement = queue.acquire('same-frame', async (signal) => {
      startReplacement();
      await new Promise<void>((resolve) => { finishReplacement = resolve; });
      assert.equal(signal.aborted, false);
      return 'fresh-result';
    });
    finishCancelledWork();
    assert.equal(await first.promise, 'cancelled-result');
    await replacementStarted;
    const shared = queue.acquire('same-frame', async () => {
      throw new Error('a live same-key job must be shared');
    });
    finishReplacement();
    assert.equal(await replacement.promise, 'fresh-result');
    assert.equal(await shared.promise, 'fresh-result', 'another consumer shares the replacement job');
    replacement.release();
    shared.release();
  }
  {
    const response = new EventEmitter() as ServerResponse;
    let finishWork!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const key = join(uploadDir(), 'retained-proxy');
    const pending = runDerivative({} as IncomingMessage, response, key, async (signal) => {
      started();
      await new Promise<void>((resolve) => { finishWork = resolve; });
      assert.equal(signal.aborted, false, 'proxy build must survive the requesting view closing');
      return 'ready';
    }, undefined, true);
    await ready;
    response.emit('close');
    const reconnect = runDerivative({} as IncomingMessage, new EventEmitter() as ServerResponse, key,
      async () => { throw new Error('reconnecting view must reuse the running proxy build'); }, undefined, true);
    finishWork();
    assert.equal(await pending, 'ready');
    assert.equal(await reconnect, 'ready');
  }
  {
    const response = new EventEmitter() as ServerResponse;
    let started!: () => void;
    let finishWork!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = runDerivative({} as IncomingMessage, response, join(uploadDir(), 'transient-frame'), async (signal) => {
      started();
      await new Promise<void>((resolve) => { finishWork = resolve; });
      assert.equal(signal.aborted, true, 'short frame jobs still cancel when unused');
    });
    await ready;
    response.emit('close');
    finishWork();
    await pending;
  }
  execFileSync(ffmpegBin(), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=0.5',
    '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(uploadDir(), 'fixture.mp4')],
  { windowsHide: true, timeout: 15000 });
  if (typeof configure === 'function') await configure.call(plugin as never, {
    middlewares: app, httpServer: server, config: { logger: { error: () => {} } },
  } as unknown as ViteDevServer);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = () => fetch(`${origin}/api/preview-proxy?src=${encodeURIComponent('/media/uploads/fixture.mp4')}&force=1`);
  const response = await request();
  assert.equal(response.status, 200);
  const ready = await response.json();
  assert.equal(ready.proxy.status, 'ready');
  const file = await fetch(origin + ready.proxy.previewSrc);
  assert.equal(file.status, 200, 'ready proxy above budget must actually be readable');
  const bytes = await file.arrayBuffer();
  assert(bytes.byteLength > 1, 'fixture exceeds the configured cache budget');
  const again = await request();
  assert.equal((await again.json()).proxy.previewSrc, ready.proxy.previewSrc, 'reading never changes decoder revision');
  const range = await fetch(origin + ready.proxy.previewSrc, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  const peakPaths = ['peaks.json', 'peaks-v2.json', 'peaks-v12.json']
    .map((kind) => join(uploadDir(), '.preview', `fixture.mp4.preview-v3-test.${kind}`));
  await Promise.all(peakPaths.map((path) => writeFile(path, 'peak-cache')));
  assert((await deleteMediaPreviewDerivatives('fixture.mp4')) > 0, 'versioned proxies remain eligible for explicit derivative cleanup');
  for (const path of peakPaths) await assert.rejects(stat(path), { code: 'ENOENT' }, `${path} is removed with source derivatives`);
  assert.equal((await fetch(origin + ready.proxy.previewSrc)).status, 404);
  assert.equal((await stat(join(uploadDir(), 'fixture.mp4'))).isFile(), true, 'master preserved');
  console.log('preview-cache-handoff: real ready -> GET -> cached ready -> ranged GET passed above byte budget');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
