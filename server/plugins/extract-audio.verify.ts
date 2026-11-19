import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { seedKeystore } from '../keystore.ts';
import { extractAudioPlugin } from './extract-audio.ts';
import { spawnMediaProcess } from '../media-process.ts';

const source = await readFile(new URL('./extract-audio.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /from ['"]node:child_process['"]/, 'the route must not directly spawn high-priority processes');
assert.match(source, /const spawn = options\.spawnMediaProcess \?\? spawnMediaProcess/, 'ffprobe/ffmpeg default to the shared low-priority launcher');

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-extract-audio-'));
const previousProbe = process.env.OPENCHATCUT_FFPROBE;
let server: ViteDevServer | undefined;
const children: ChildProcess[] = [];

try {
  // A 1x1 PNG is a valid media file with no audio stream.
  await writeFile(
    join(directory, 'silent.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  // A cached ASR artifact lets the probe-failure case complete without
  // depending on a codec implementation in this focused route test.
  await writeFile(join(directory, 'broken-probe.asr.ogg'), Buffer.from('cached-asr'));
  await writeFile(join(directory, 'broken-probe.wav'), Buffer.from('not-used'));
  seedKeystore({ MEDIA_DIR: directory });

  server = await createServer({
    root: directory,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [extractAudioPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('extract-audio verification server has no TCP address');
  const origin = `http://127.0.0.1:${address.port}`;

  let response = await fetch(`${origin}/api/extract-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/silent.png' }),
  });
  const silentBody = await response.text();
  assert.equal(response.status, 422);
  assert.deepEqual(JSON.parse(silentBody), {
    ok: false,
    noAudio: true,
    error: 'source has no audio track: silent.png',
  });

  process.env.OPENCHATCUT_FFPROBE = join(directory, 'missing-ffprobe');
  response = await fetch(`${origin}/api/extract-audio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ src: '/media/uploads/broken-probe.wav' }),
  });
  assert.equal(response.status, 200, 'probe failures must fall back to extraction/cache instead of no-audio');
  assert.deepEqual(await response.json(), {
    ok: true,
    path: '/media/uploads/broken-probe.asr.ogg',
    bytes: 'cached-asr'.length,
    cached: true,
    source: '/media/uploads/broken-probe.wav',
  });

  await server.close(); server = undefined;
  type Attempt = { child: ChildProcess; probe: boolean; args: string[]; output: string; killed: boolean; finish: (code?: number) => void };
  const attempts: Attempt[] = [];
  let probeWaits = false;
  let opusFails = false;
  let finishEncodes = false;
  const simulatedSpawn = ((_command: string, args: string[]) => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const probe = args.includes('-select_streams');
    const output = probe ? '' : args.at(-1)!;
    const attempt: Attempt = { child, probe, args, output, killed: false, finish: (code = 0) => {
      if (attempt.killed) return;
      if (probe) stdout.write('audio\n');
      else if (code === 0) writeFileSync(output, 'new-asr-cache');
      child.emit('close', code, null);
    } };
    Object.assign(child, { stdout, stderr, kill: () => { attempt.killed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; } });
    attempts.push(attempt);
    if (!probe) writeFileSync(output, 'private-partial');
    if (probe && !probeWaits) queueMicrotask(() => attempt.finish());
    else if (!probe && opusFails && args.includes('libopus')) queueMicrotask(() => attempt.finish(1));
    else if (!probe && finishEncodes) queueMicrotask(() => attempt.finish());
    return child;
  }) as typeof spawnMediaProcess;
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 250; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 4)); }
    assert.fail('bounded extract-audio request check timed out');
  };
  server = await createServer({
    root: directory, configFile: false, appType: 'custom', logLevel: 'silent',
    plugins: [extractAudioPlugin({ spawnMediaProcess: simulatedSpawn }), {
      name: 'extract-audio-verification-reads',
      configureServer(testServer) {
        // Serve only the generated test cache names, so a delayed HTTP consumer
        // can verify the actual returned path remains available after fallback.
        testServer.middlewares.use('/media/uploads', (req, res, next) => {
          const name = req.url?.slice(1);
          if (!name || !/^[a-z-]+\.asr\.(ogg|mp3)$/.test(name)) { next(); return; }
          void readFile(join(directory, name)).then(
            (bytes) => { res.statusCode = 200; res.end(bytes); },
            () => { res.statusCode = 404; res.end(); },
          );
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const testAddress = server.httpServer?.address();
  if (!testAddress || typeof testAddress === 'string') throw new Error('cancel verification has no address');
  const testOrigin = `http://127.0.0.1:${testAddress.port}`;
  const request = (name: string, signal?: AbortSignal, force = true) => fetch(`${testOrigin}/api/extract-audio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ src: `/media/uploads/${name}`, force }), signal });

  await writeFile(join(directory, 'cancel.wav'), 'source');
  await writeFile(join(directory, 'cancel.asr.ogg'), 'previous-cache');
  await writeFile(join(directory, 'cancel.asr.ogg.part'), 'other-request-part');
  await writeFile(join(directory, 'cancel.asr.tmp.ogg'), 'other-legacy-temp');
  const firstToken = new AbortController();
  const first = request('cancel.wav', firstToken.signal);
  void first.catch(() => {});
  await waitFor(() => attempts.filter((attempt) => !attempt.probe).length === 1);
  const second = request('cancel.wav');
  await waitFor(() => attempts.filter((attempt) => !attempt.probe).length === 2);
  const encodes = attempts.filter((attempt) => !attempt.probe);
  assert.notEqual(encodes[0].output, encodes[1].output, 'concurrent same-stem requests need private temporary outputs');
  firstToken.abort();
  await assert.rejects(first, { name: 'AbortError' });
  await waitFor(() => encodes[0].killed && !existsSync(encodes[0].output));
  assert.equal(encodes[1].killed, false, 'only cancelled request process may be killed');
  assert.equal(existsSync(encodes[1].output), true, 'other request partial is preserved');
  assert.equal(await readFile(join(directory, 'cancel.asr.ogg'), 'utf8'), 'previous-cache', 'cancelled force request cannot delete the prior cache');
  assert.equal(await readFile(join(directory, 'cancel.asr.ogg.part'), 'utf8'), 'other-request-part');
  assert.equal(await readFile(join(directory, 'cancel.asr.tmp.ogg'), 'utf8'), 'other-legacy-temp');
  assert.equal(attempts.some((attempt) => attempt.args.includes('libmp3lame')), false, 'cancellation is not an Opus codec failure');
  encodes[1].finish();
  response = await second;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cached, false);
  assert.equal(await readFile(join(directory, 'cancel.asr.ogg'), 'utf8'), 'new-asr-cache');
  assert.equal(existsSync(encodes[1].output), false);
  const beforeCacheRequest = attempts.filter((attempt) => !attempt.probe).length;
  response = await request('cancel.wav', undefined, false);
  assert.equal((await response.json()).cached, true);
  assert.equal(attempts.filter((attempt) => !attempt.probe).length, beforeCacheRequest, 'nonforce still reuses final cache');

  probeWaits = true;
  const probeToken = new AbortController();
  const probeCount = attempts.filter((attempt) => attempt.probe).length;
  const probeRequest = request('cancel.wav', probeToken.signal);
  void probeRequest.catch(() => {});
  await waitFor(() => attempts.filter((attempt) => attempt.probe).length > probeCount);
  const probe = attempts.at(-1)!;
  probeToken.abort(); await assert.rejects(probeRequest, { name: 'AbortError' });
  await waitFor(() => probe.killed);
  assert.equal(attempts.filter((attempt) => !attempt.probe).length, beforeCacheRequest, 'cancelled probe must not enter extraction');
  probeWaits = false;

  const olderCacheTime = (Date.now() - 10_000) / 1000;
  await utimes(join(directory, 'cancel.asr.ogg'), olderCacheTime, olderCacheTime);
  opusFails = true; finishEncodes = true;
  response = await request('cancel.wav');
  const fallbackBody = await response.json();
  assert.equal(response.status, 200);
  assert.equal(fallbackBody.path, '/media/uploads/cancel.asr.mp3', 'genuine codec failure still has one MP3 fallback');
  assert.equal(await readFile(join(directory, 'cancel.asr.ogg'), 'utf8'), 'new-asr-cache', 'successful force fallback preserves an already published other-format URL');
  assert.equal(await readFile(join(directory, 'cancel.asr.mp3'), 'utf8'), 'new-asr-cache');
  const beforeFallbackCacheRequest = attempts.filter((attempt) => !attempt.probe).length;
  response = await request('cancel.wav', undefined, false);
  assert.deepEqual(await response.json(), {
    ok: true, path: '/media/uploads/cancel.asr.mp3', bytes: 'new-asr-cache'.length,
    cached: true, source: '/media/uploads/cancel.wav',
  }, 'nonforce reuses the newest successful fallback even when an older Ogg remains');
  assert.equal(attempts.filter((attempt) => !attempt.probe).length, beforeFallbackCacheRequest);

  // Two simultaneous requests finish in different formats. Request A has
  // received its Ogg URL, but does not fetch it until B publishes MP3 fallback.
  opusFails = false; finishEncodes = false;
  await writeFile(join(directory, 'publication.wav'), 'source');
  const beforePublication = attempts.filter((attempt) => !attempt.probe).length;
  const firstPublication = request('publication.wav');
  await waitFor(() => attempts.filter((attempt) => !attempt.probe).length === beforePublication + 1);
  const secondPublication = request('publication.wav');
  await waitFor(() => attempts.filter((attempt) => !attempt.probe).length === beforePublication + 2);
  const publicationEncodes = attempts.filter((attempt) => !attempt.probe).slice(beforePublication);
  publicationEncodes[0].finish();
  const firstPublicationResponse = await firstPublication;
  assert.equal(firstPublicationResponse.status, 200);
  const firstPublicationBody = await firstPublicationResponse.json();
  assert.equal(firstPublicationBody.path, '/media/uploads/publication.asr.ogg');
  publicationEncodes[1].finish(1);
  await waitFor(() => attempts.filter((attempt) => !attempt.probe).length === beforePublication + 3);
  const fallbackEncode = attempts.filter((attempt) => !attempt.probe).at(-1)!;
  assert.equal(fallbackEncode.args.includes('libmp3lame'), true);
  fallbackEncode.finish();
  const secondPublicationResponse = await secondPublication;
  assert.equal(secondPublicationResponse.status, 200);
  assert.equal((await secondPublicationResponse.json()).path, '/media/uploads/publication.asr.mp3');
  const delayedConsumer = await fetch(`${testOrigin}${firstPublicationBody.path}`);
  assert.equal(delayedConsumer.status, 200, 'successful concurrent fallback must not invalidate an issued Ogg URL');
  assert.equal(await delayedConsumer.text(), 'new-asr-cache');

  // Use explicit timestamps rather than sleeps or filesystem clock precision.
  const cacheTime = Date.now() / 1000;
  const publicationOgg = join(directory, 'publication.asr.ogg');
  const publicationMp3 = join(directory, 'publication.asr.mp3');
  await utimes(publicationOgg, cacheTime - 20, cacheTime - 20);
  await utimes(publicationMp3, cacheTime - 10, cacheTime - 10);
  const beforeLatestRequests = attempts.filter((attempt) => !attempt.probe).length;
  response = await request('publication.wav', undefined, false);
  assert.equal((await response.json()).path, '/media/uploads/publication.asr.mp3', 'cache selection is not fixed to Ogg-first');
  await utimes(publicationOgg, cacheTime, cacheTime);
  response = await request('publication.wav', undefined, false);
  assert.equal((await response.json()).path, '/media/uploads/publication.asr.ogg', 'a newer successful Ogg supersedes MP3 for subsequent cache reads');
  assert.equal(attempts.filter((attempt) => !attempt.probe).length, beforeLatestRequests, 'latest-cache reads do not re-encode');
  assert.equal(existsSync(publicationMp3), true, 'newer Ogg must also preserve the already issued MP3 URL');
  await server.close(); server = undefined;

  // A real, short-lived bundled-Node child proves client disconnect actually
  // exits the owned OS process, not merely an ignored Promise in the renderer.
  let actualClosed = false;
  const actualSpawn = ((_command: string, _args: string[], options: Parameters<typeof spawnMediaProcess>[2]) => {
    const child = spawnMediaProcess(process.execPath, ['-e', "process.stdout.write('started\\n');setInterval(()=>{},1000)"], options);
    children.push(child); child.once('close', () => { actualClosed = true; });
    return child;
  }) as typeof spawnMediaProcess;
  server = await createServer({ root: directory, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [extractAudioPlugin({ spawnMediaProcess: actualSpawn })], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const realAddress = server.httpServer?.address();
  if (!realAddress || typeof realAddress === 'string') throw new Error('real process verification has no address');
  const actualToken = new AbortController();
  const actual = fetch(`http://127.0.0.1:${realAddress.port}/api/extract-audio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ src: '/media/uploads/cancel.wav', force: true }), signal: actualToken.signal });
  void actual.catch(() => {});
  await waitFor(() => children[0]?.pid !== undefined);
  actualToken.abort(); await assert.rejects(actual, { name: 'AbortError' });
  await waitFor(() => actualClosed);
  assert.equal(children.length, 1, 'real cancellation must not spawn a fallback');
} finally {
  if (server) {
    await server.close();
  }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (previousProbe === undefined) delete process.env.OPENCHATCUT_FFPROBE;
  else process.env.OPENCHATCUT_FFPROBE = previousProbe;
  await rm(directory, { recursive: true, force: true });
}

console.log('extract-audio.verify: no-audio/probe-failure compatibility, HTTP cancel/no fallback, private concurrent outputs/cache preservation, genuine fallback, published URL lifetime/newest-cache selection and real owned-process exit passed');
