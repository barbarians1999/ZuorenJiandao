import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, mkdtempSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const media = resolve(process.argv.find((arg) => arg.startsWith('--media='))?.slice(8) ?? 'release/subdraft-render-Z3tXrf/source.mp4');
if (!statSync(media).isFile()) throw new Error('short fixture source must be a real local video file');
const root = resolve(process.argv.find((arg) => arg.startsWith('--root='))?.slice(7) ?? 'release/jianying-daily-workflow-20261013'); mkdirSync(root, { recursive: true });
const fixture = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice(10) ?? 'scripts/fixtures/jianying-workflow-ui.html';
if (!resolve(fixture).startsWith(resolve('scripts/fixtures') + sep) || !statSync(fixture).isFile()) throw new Error('Fixture must be an existing local regression entry');
const outDir = mkdtempSync(join(root, 'desktop-fixture-'));
const profile = join(outDir, 'profile');
process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
process.env.OPENCHATCUT_DATA_DIR = profile;
const { registerMediaReference } = await import('../server/media-references.ts');
const { runtimeProfile } = await import('../server/runtime-profile.ts');
const { sceneDetectionPlugin } = await import('../server/plugins/scene-detection.ts');
const mediaDir = runtimeProfile().mediaDir;
await registerMediaReference(mediaDir, 'jianying-fixture.mp4', media);
const assets = resolve('assets');
const mockAsr = process.argv.includes('--mock-asr');
let model = 'ready';
const mime = { '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.svg': 'image/svg+xml', '.css': 'text/css' };
function streamFile(req, res, file) {
  const info = statSync(file);
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
  if (start >= info.size || start > end) { res.statusCode = 416; res.end(); return; }
  const extension = /\.[^.]+$/.exec(file)?.[0]?.toLowerCase();
  res.setHeader('Content-Type', mime[extension] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
  if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`); }
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
const resources = (server) => { server.middlewares.use((req, res, next) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (mockAsr && url.pathname === '/qa/model') {
    model = url.searchParams.get('state') === 'missing' ? 'missing' : 'ready';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model, simulated: true })); return;
  }
  if (url.pathname === '/api/asr-models') {
    res.setHeader('Content-Type', 'application/json');
    if (mockAsr) res.end(JSON.stringify({ models: [{ modelId: 'onnx-community/whisper-base_timestamped', downloaded: model === 'ready' }], simulated: true }));
    else { res.statusCode = 503; res.end(JSON.stringify({ error: 'ASR model catalogue not mounted in the UI fixture; native font/scene paths are real' })); }
    return;
  }
  if (url.pathname === '/qa/fixture') {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ media, outDir, profile, mediaDir, mockAsr,
      profileId: process.env.OPENCHATCUT_DEV_PROFILE_ID, sourceCopied: false })); return;
  }
  if (url.pathname === '/media/uploads/jianying-fixture.mp4' || url.pathname === '/fixture.mp4') { streamFile(req, res, media); return; }
  let target;
  if (url.pathname.startsWith('/sound-effects/') || url.pathname.startsWith('/fonts/')) {
    target = resolve(assets, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(`${assets}${sep}`)) { res.statusCode = 400; res.end(); return; }
    if (!existsSync(target) && url.pathname.startsWith('/fonts/')) {
      const publicFonts = resolve('public/fonts');
      target = resolve(publicFonts, decodeURIComponent(url.pathname.slice('/fonts/'.length)));
      if (!target.startsWith(`${publicFonts}${sep}`)) { res.statusCode = 400; res.end(); return; }
    }
  } else if (url.pathname.startsWith('/media/uploads/')) {
    const name = decodeURIComponent(url.pathname.slice('/media/uploads/'.length));
    if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) { res.statusCode = 400; res.end(); return; }
    target = join(mediaDir, name);
  }
  if (!target) return next();
  if (!existsSync(target) || !statSync(target).isFile()) { res.statusCode = 404; res.end(); return; }
  streamFile(req, res, target);
}); };
const scene = sceneDetectionPlugin();
const sceneMiddleware = (server) => scene.configureServer.call(scene, server);
const plugins = [react(), { name: 'jianying-ui-resources', configurePreviewServer: resources },
  { name: 'jianying-real-scene-detection', configurePreviewServer: sceneMiddleware }];
await build({ configFile: false, publicDir: false, plugins, logLevel: 'warn', build: { outDir, emptyOutDir: false,
  copyPublicDir: false, minify: false, rolldownOptions: { input: fixture } } });
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7) ?? '39791');
const server = await preview({ configFile: false, plugins, build: { outDir }, preview: { host: '127.0.0.1', port, strictPort: true, open: false } });
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}/${fixture}${mockAsr ? '?mockAsr=1' : ''}`, outDir,
  desktopHostEnvironment: { OPENCHATCUT_DEV_PROFILE_ID: process.env.OPENCHATCUT_DEV_PROFILE_ID, OPENCHATCUT_DATA_DIR: profile },
  nativeSceneDetection: true, soundFiles: '39 original assets; no copy', nativeFontsRequired: true, mockAsr }));
const stop = () => new Promise((done) => server.httpServer.close(done)).then(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
setTimeout(stop, 25 * 60_000).unref();
