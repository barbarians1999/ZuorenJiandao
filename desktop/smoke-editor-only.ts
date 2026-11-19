import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { externalMcpToken } from '../server/editor-auth';
import { editorStatuses, isProjectConnected } from '../server/external-agent/broker';
import { setStoredEntry } from '../server/plugins/project-store';
import { runtimeProfile } from '../server/runtime-profile';
import { docFromTimeline } from '../src/persist/projectStore';

function content(result: unknown): Record<string, unknown> {
  assert(result && typeof result === 'object' && 'structuredContent' in result);
  const value = result.structuredContent;
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Tests the shipped UI and its external bridge without an embedded chat. */
export async function runEditorOnlySmoke(origin: string, win: BrowserWindow): Promise<void> {
  assert(process.env.OPENCHATCUT_DATA_DIR, 'Smoke storage must be explicitly isolated');
  assert.equal(runtimeProfile().rootDir, resolve(process.env.OPENCHATCUT_DATA_DIR));
  const settings = await (await fetch(`${origin}/api/keys`)).json();
  assert.deepEqual(settings.keys, {});
  assert(Object.values(settings.caps).every((cap) => cap === false));
  for (const path of ['/llm', '/api/codex/status', '/api/copilot/status', '/generate/image', '/assemblyai/v2/transcript']) {
    assert.equal((await fetch(origin + path)).status, 410, path);
  }
  const id = `smoke-editor-only-${randomUUID()}`;
  const doc = docFromTimeline({
    fps: 30, width: 1280, height: 720, selectedId: null,
    trackOrder: ['video'], tracks: { video: { kind: 'video' } },
    items: [{ id: 'smoke-title', name: 'Codex external control', kind: 'text', track: 'video', startFrame: 0, durationInFrames: 150, props: { text: '左人剪刀 · 本地剪辑', fontSize: 72 } }],
  });
  await setStoredEntry(`project:${id}`, doc);
  await setStoredEntry('projects', [{ id, name: '精简版验证工程', createdAt: Date.now(), updatedAt: Date.now() }]);
  await win.webContents.executeJavaScript("localStorage.setItem('cc.locale', 'zh')");
  const bridgeResponses: Array<{ path: string; status: number }> = [];
  win.webContents.session.webRequest.onCompleted({ urls: [`${origin}/api/external-agent/*`] }, (details) => {
    bridgeResponses.push({ path: new URL(details.url).pathname, status: details.statusCode });
  });
  // A hash-only loadURL keeps the dashboard's already-loaded project index.
  // Force a full navigation after injecting the isolated fixture.
  await win.loadURL(`${origin}/?editorOnlySmoke=${id}#/editor/${id}`);
  const deadline = Date.now() + 25_000;
  while (!isProjectConnected(id)) {
    if (Date.now() > deadline) {
      console.log('[smoke] editor UI:', await win.webContents.executeJavaScript('document.body.innerText.slice(0, 2000)'));
      console.log('[smoke] bridge responses:', bridgeResponses.slice(-12), 'registrations:', editorStatuses());
      if (process.env.CC_SMOKE_SCREENSHOT) await writeFile(process.env.CC_SMOKE_SCREENSHOT, (await win.capturePage()).toPNG());
      throw new Error('Editor bridge did not connect without ChatPanel');
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-cc-chat-composer]"))'), false);
  assert.equal(await win.webContents.executeJavaScript('document.body.innerText.includes("AI 编辑")'), false);
  const client = new Client({ name: 'editor-only-smoke', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/external-mcp/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${externalMcpToken()}` } },
  });
  try {
    await client.connect(transport);
    const target = await client.callTool({ name: 'target_project', arguments: { projectId: id } });
    assert.notEqual(target.isError, true);
    assert.equal(content(target).bindingMode, 'browser');
    const begin = await client.callTool({ name: 'begin_edit_session', arguments: { approvalMode: 'auto' } });
    const editSessionId = content(begin).editSessionId;
    assert.equal(typeof editSessionId, 'string');
    const split = await client.callTool({ name: 'split_item', arguments: { editSessionId, itemId: 'smoke-title', atFrame: 75 } });
    assert.notEqual(split.isError, true, JSON.stringify(split.structuredContent));
    const review = await client.callTool({ name: 'review_edit_session', arguments: { editSessionId, summary: 'Split title from external Codex' } });
    assert.equal(content(review).status, 'applied');
    console.log('[smoke] editor-only UI and browser MCP split/apply ok');
  } finally { await client.close(); }
  const screenshot = process.env.CC_SMOKE_SCREENSHOT;
  if (screenshot) await writeFile(screenshot, (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript('document.querySelector("button[aria-label=设置]")?.click()');
  const settingsDeadline = Date.now() + 10_000;
  while (!await win.webContents.executeJavaScript('Boolean(document.querySelector("section[aria-label=设置]"))')) {
    if (Date.now() > settingsDeadline) throw new Error('Local settings did not open');
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("section[aria-label=设置]"))'), true);
  assert.equal(await win.webContents.executeJavaScript('document.body.innerText.includes("配置模型")'), false);
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.querySelector("input[type=password]"))'), false);
  if (screenshot) await writeFile(`${screenshot}.settings.png`, (await win.capturePage()).toPNG());
  console.log('[smoke] local-only settings UI ok');
}
