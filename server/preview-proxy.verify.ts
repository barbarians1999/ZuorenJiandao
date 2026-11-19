import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePreviewProxy, PREVIEW_PROXY_KIND } from './preview-proxy';
import { ffmpegBin, ffprobeBin } from './media-binaries';

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
  console.log('preview-proxy.verify: explicit retry and master isolation passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
