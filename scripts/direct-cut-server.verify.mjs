// Short real HTTP preflight + production-export check in an isolated profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { createDirectCutFixture } from './direct-cut-fixture.mjs';
const root = await mkdtemp(resolve('release/direct-cut-server-'));
process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
process.env.OPENCHATCUT_DATA_DIR = join(root, 'profile');
delete process.env.CC_DIRECT_CUT_EXPORT; // verify the actual default, not opt-in
const report = { status: 'running', root, scope: 'HTTP preflight and production server export; not actual UI/install acceptance', checks: [] };
let http;
try {
  const { uploadDir } = await import('../server/media-dir.ts');
  await mkdir(uploadDir(), { recursive: true });
  const sourceArgument = process.argv.find((value) => value.startsWith('--source='))?.slice(9);
  if (sourceArgument) await copyFile(resolve(sourceArgument), join(uploadDir(), 'native-fixture.mp4'));
  else await createDirectCutFixture(join(uploadDir(), 'native-fixture.mp4'));
  const { setUploadsDirProvider, renderExportPlan } = await import('../server/plugins/export-rendering.ts');
  const { planExport } = await import('../server/plugins/export-plan.ts');
  const { registerExportRoute } = await import('../server/plugins/export-job-routes.ts');
  const { chooseSupportedRoute } = await import('../src/export/exportRoutePlanner.ts');
  setUploadsDirProvider(uploadDir);
  let handler;
  registerExportRoute({ middlewares: { use: (_, callback) => { handler = callback; } } });
  http = createServer((req, res) => { void handler(req, res); });
  await new Promise((accept) => http.listen(0, '127.0.0.1', accept));
  const endpoint = `http://127.0.0.1:${http.address().port}/export/capabilities`;
  const state = { fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { V1: { kind: 'video' } }, items: [{ id: 'v', name: 'Source', track: 'V1', kind: 'video',
      startFrame: 15, srcInFrame: 60, durationInFrames: 120, width: 1920, height: 1080,
      src: '/media/uploads/native-fixture.mp4', volume: 0.7 }] };
  const body = { state, format: 'video', codec: 'h264', resolution: '1080p', fps: 30 };
  const post = (body) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const response = await post(body); assert.equal(response.status, 200);
  const caps = await response.json(); assert.equal(caps.directCut.renderRoute, 'direct-cut');
  const chosen = chooseSupportedRoute({ status: 'supported', issues: [], powerEfficient: true }, caps.h264, caps.directCut);
  assert.equal(chosen.route, 'server'); assert.equal(chosen.engine.renderRoute, 'direct-cut');
  report.checks.push('real HTTP capability used by UI planner selects native even when WebCodecs is efficient');
  const titled = structuredClone(body);
  titled.state.tracks.V2 = { kind: 'video' };
  titled.state.items.push({ id: 't', name: 'Chapter', kind: 'text', track: 'V2', startFrame: 45,
    durationInFrames: 15, props: { text: 'Chapter', entrance: 'wipe', entranceFrames: 5 } });
  const titleCaps = await (await post(titled)).json(); assert.equal(titleCaps.directCut.renderRoute, 'hybrid');
  report.checks.push('chapter preflight selects local-window hybrid');
  const unsupported = structuredClone(body); unsupported.state.items[0].mask = { type: 'ellipse' };
  assert.equal((await (await post(unsupported)).json()).directCut, undefined);
  assert.equal((await post({ state: {} })).status, 400);
  process.env.CC_DIRECT_CUT_EXPORT = '0';
  assert.equal((await (await post(body)).json()).directCut, undefined);
  delete process.env.CC_DIRECT_CUT_EXPORT;
  report.checks.push('unsupported effects/invalid input/explicit opt-out do not claim native eligibility');
  const output = join(root, 'production.mp4'), progress = [];
  const started = performance.now();
  const result = await renderExportPlan(planExport(body), output, (value) => progress.push(value), AbortSignal.timeout(60000));
  report.elapsedMs = performance.now() - started; report.encoder = result.encoder;
  assert.equal(result.encoder.renderRoute, 'direct-cut');
  assert(progress.some((p) => p.phase === 'finalizing'));
  const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-xerror', '-i', output,
    '-map', '0:v:0', '-f', 'framehash', 'pipe:1'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 });
  assert.equal(stdout.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 135);
  report.checks.push('default production entry returns actual native encoder and complete 135-frame file');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  if (http) { http.closeAllConnections(); await new Promise((accept) => http.close(accept)); }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
