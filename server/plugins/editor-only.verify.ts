import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../../desktop/mini-connect';
import { removedAiRoutesPlugin, REMOVED_AI_ROUTE_PREFIXES, isRemovedAiRoute } from './removed-ai-routes';
import { assertEditorSettingsPatch } from './settings';
import { externalToolSchemas } from '../../src/agent/external-tool-schemas';
import { preferredTranscriptionProvider, setPreferredTranscriptionProvider, transcribePath } from '../../src/transcript/provider';

assertEditorSettingsPatch({ UI_SCALE: '1', LOCAL_ASR_MODEL: 'whisper-small', AUTO_TRANSCRIBE_INGEST: 'off' });
for (const key of ['OPENAI_API_KEY', 'LLM_PROVIDER', 'CODEX_MODEL', 'PREFERRED_TRANSCRIPTION_PROVIDER']) {
  assert.throws(() => assertEditorSettingsPatch({ [key]: 'test' }), /Only local editor settings/);
}
const tools = new Set(externalToolSchemas().map((tool) => tool.name));
for (const name of ['read_timeline', 'begin_edit_session', 'review_edit_session', 'split_item', 'edit_captions', 'submit_export', 'submit_render_job', 'create_motion_graphic_from_code']) {
  assert(tools.has(name), `External control must retain ${name}`);
}
for (const name of ['submit_image', 'submit_voice', 'submit_video', 'submit_music', 'submit_sound', 'rerun_generation', 'submit_motion_graphic', 'create_motion_graphic', 'submit_shader', 'find_highlights', 'web_browser', 'run_code', 'search_stock_media']) {
  assert(!tools.has(name), `Retired tool must not be exposed: ${name}`);
}
assert.equal(preferredTranscriptionProvider(), 'local');
setPreferredTranscriptionProvider('assemblyai');
assert.equal(preferredTranscriptionProvider(), 'local', 'Legacy preferences must not restore cloud transcription');
await assert.rejects(() => transcribePath('/media/test.wav', undefined, {}, 'assemblyai'), /Cloud transcription was removed/);
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
assert(!Object.keys(pkg.dependencies).some((key) => key.startsWith('@ai-sdk/') || ['ai', '@github/copilot-sdk', '@e2b/code-interpreter'].includes(key)));
const npmLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
assert.equal(npmLock.version, pkg.version);
assert.deepEqual(npmLock.packages[''].dependencies, pkg.dependencies);
assert.deepEqual(npmLock.packages[''].devDependencies, pkg.devDependencies);
for (const [path, entry] of Object.entries(npmLock.packages)) {
  if (/node_modules\/(?:@ai-sdk\/|ai$|@github\/copilot-sdk$|@e2b\/code-interpreter$)/.test(path)) {
    assert.equal((entry as { dev?: boolean }).dev, true, `Legacy SDK must remain development-only: ${path}`);
  }
}

const app = createMiniConnect((error) => { throw error; });
const plugin = removedAiRoutesPlugin();
const hook = plugin.configureServer;
assert.equal(typeof hook, 'function');
if (typeof hook === 'function') await hook.call(plugin as never, { middlewares: app } as unknown as ViteDevServer);
app.use((_req, res) => { res.statusCode = 204; res.end(); });
const server = createServer((req, res) => app.handle(req, res));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
try {
  for (const prefix of REMOVED_AI_ROUTE_PREFIXES) {
    for (const method of ['GET', 'POST']) {
      const result = await fetch(`${origin}${prefix}/test?x=1`, { method });
      assert.equal(result.status, 410, prefix);
      assert.match((await result.json()).error, /removed/);
    }
  }
  for (const path of ['/api/external-agent/bootstrap', '/api/external-mcp/mcp', '/api/keys', '/export/job', '/api/asr-models', '/api/model-packs', '/generate-other']) {
    assert(!isRemovedAiRoute(path));
    assert.equal((await fetch(origin + path)).status, 204, path);
  }
} finally {
  server.close();
  await once(server, 'close');
}
console.log('editor-only.verify: local settings, local ASR, retired routes and external tool catalog passed');
