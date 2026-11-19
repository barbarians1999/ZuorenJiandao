import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const name of ['@remotion/bundler', '@remotion/google-fonts', '@babel/standalone', '@mediapipe/tasks-vision']) {
  assert.equal(pkg.dependencies[name], undefined, `${name} must not be collected as an installed Node runtime dependency`);
  assert.ok(pkg.devDependencies[name], `${name} remains available for browser/prebundle builds`);
}
for (const name of ['@remotion/renderer', '@modelcontextprotocol/sdk', 'ffmpeg-static', '@huggingface/transformers', 'onnxruntime-node', 'undici']) {
  assert.ok(pkg.dependencies[name], `${name} still supports installed rendering, external control and local recognition`);
}
const renderer = await readFile(new URL('../remotion/render.mjs', import.meta.url), 'utf8');
assert.doesNotMatch(renderer, /^import .*from ['"]@remotion\/bundler['"]/m);
assert.match(renderer, /async function buildBundle\(outDir\)\s*\{[\s\S]*?await import\('@remotion\/bundler'\)/);
const previousTarget = process.env.CC_EB_TARGET;
try {
  process.env.CC_EB_TARGET = 'win32-x64';
  const { default: config } = await import(`${new URL('../config/electron-builder.config.mjs', import.meta.url).href}?buildOnlyCheck`);
  for (const foreign of ['darwin/arm64', 'darwin/x64', 'win32/arm64', 'linux/arm64', 'linux/x64']) {
    assert.ok(config.files.includes(`!node_modules/**/node_modules/onnxruntime-node/bin/napi-v6/${foreign}/**`), `nested ${foreign} binaries must be excluded`);
  }
  assert.equal(config.files.some((filter: string) => filter.startsWith('!') && filter.includes('/napi-v6/win32/x64/')), false, 'both installed ONNX versions retain Windows x64 support');
} finally {
  if (previousTarget === undefined) delete process.env.CC_EB_TARGET;
  else process.env.CC_EB_TARGET = previousTarget;
}
console.log('build-only libraries excluded from installed runtime dependencies');
