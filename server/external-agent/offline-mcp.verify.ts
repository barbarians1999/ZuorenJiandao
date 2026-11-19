import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';

function projectDoc(width = 1920, height = 1080, fit?: 'cover' | 'contain'): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline-1',
    timelines: [{
      id: 'timeline-1',
      name: 'Timeline 1',
      order: 0,
      fps: 30,
      width,
      height,
      items: [],
      selectedId: null,
      selectedIds: [],
      trackOrder: ['track-v1'],
      tracks: { 'track-v1': { kind: 'video' } },
      ...(fit ? { fit } : {}),
    }],
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

function resultField(result: CallToolResult, key: string): unknown {
  const content = result.structuredContent;
  assert(content && key in content);
  return content[key];
}

function sessionId(result: CallToolResult): string {
  const value = resultField(result, 'editSessionId');
  assert.equal(typeof value, 'string');
  return value;
}

const root = await mkdtemp(join(tmpdir(), 'occ-offline-mcp-'));
const previousDataDir = process.env.OPENCHATCUT_DATA_DIR;
process.env.OPENCHATCUT_DATA_DIR = root;

// Windows os.homedir() ignores HOME. Pin the exact test storage root before
// importing the store, so this check never reads existing user/test fixtures.
const { runtimeProfile } = await import('../runtime-profile.ts');
assert.equal(runtimeProfile().rootDir, root);
const { getStoredEntry, setStoredEntry } = await import('../plugins/project-store.ts');
const { createExternalProject } = await import('./projects.ts');
const {
  registerEditor,
  resetExternalAgentBrokerForTest,
  unregisterEditor,
} = await import('./broker.ts');
const {
  handleMcpRequest,
  mcpSessionsForTest,
  resetMcpSessionsForTest,
} = await import('./mcp.ts');

const projectId = 'offline-mcp-project';
const createdProject = await createExternalProject({ name: 'Created defaults', compositionWidth: 1280, compositionHeight: 720 });
const createdProjectDoc = (await getStoredEntry(`project:${createdProject.id}`)).value as ProjectDoc;
assert.equal(createdProjectDoc.timelines[0]!.width, 1280);
assert.equal(createdProjectDoc.timelines[0]!.height, 720);
assert.equal(createdProjectDoc.timelines[0]!.interaction?.magnet, false);
assert.equal(createdProjectDoc.timelines[0]!.interaction?.linkage, false);
assert.equal(createdProjectDoc.timelines[0]!.interaction?.snapping, true);
await setStoredEntry(`project:${projectId}`, projectDoc());
await setStoredEntry('projects', [{ id: projectId, name: 'Offline MCP', updatedAt: 1 }]);
await resetMcpSessionsForTest();
resetExternalAgentBrokerForTest();

const server = createServer((req, res) => {
  void handleMcpRequest(req, res, 'http://127.0.0.1').catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(error instanceof Error ? error.message : String(error));
  });
});
const port = await listen(server);
const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
const clients: Client[] = [];

async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl));
  clients.push(client);
  return client;
}

try {
  const client = await connect('offline-flow');
  const initialTools = new Set((await client.listTools()).tools.map((tool) => tool.name));
  assert.equal(initialTools.has('target_project'), true);
  assert.equal(initialTools.has('set_aspect_ratio'), true);
  assert.equal(initialTools.has('submit_render_job'), false);

  const target = await client.callTool({ name: 'target_project', arguments: { projectId } });
  assert.notEqual(target.isError, true);
  assert.equal(resultField(target, 'bindingMode'), 'offline');
  assert.equal(mcpSessionsForTest()[0].bindingMode, 'offline');

  const manual = await client.callTool({ name: 'begin_edit_session', arguments: { approvalMode: 'manual' } });
  assert.equal(manual.isError, true);
  assert.equal(resultField(manual, 'outcome'), 'rejected');

  const begin = await client.callTool({ name: 'begin_edit_session', arguments: { approvalMode: 'auto' } });
  const editSessionId = sessionId(begin);
  const edit = await client.callTool({
    name: 'set_aspect_ratio',
    arguments: { editSessionId, ratio: '9:16', fit: 'contain' },
  });
  assert.notEqual(edit.isError, true);
  const review = await client.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId, summary: 'Vertical edit' },
  });
  assert.equal(resultField(review, 'status'), 'applied');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, projectDoc(1080, 1920, 'contain'));
  const versions = (await getStoredEntry(`versions:${projectId}`)).value;
  assert(Array.isArray(versions) && versions.length === 1, `Expected one edit checkpoint: ${JSON.stringify(versions)}`);
  assert(versions[0] && typeof versions[0] === 'object' && 'doc' in versions[0]);
  assert.deepEqual(versions[0].doc, projectDoc());

  const staleClient = await connect('offline-stale');
  await staleClient.callTool({ name: 'target_project', arguments: { projectId } });
  const staleId = sessionId(await staleClient.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'auto' },
  }));
  await staleClient.callTool({
    name: 'set_aspect_ratio',
    arguments: { editSessionId: staleId, ratio: '16:9' },
  });
  const concurrent = projectDoc(1280, 720);
  await setStoredEntry(`project:${projectId}`, concurrent);
  const staleReview = await staleClient.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId: staleId },
  });
  assert.equal(staleReview.isError, true);
  assert.equal(resultField(staleReview, 'outcome'), 'stale');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, concurrent);
  await delayImmediate();
  assert.ok((await staleClient.listTools()).tools.some((tool) => tool.name === 'target_project'));
  for (const name of ['openchatcut_status', 'set_aspect_ratio', 'get_edit_session']) {
    const result = await staleClient.callTool({ name, arguments: { editSessionId: staleId, ratio: '16:9' } });
    assert.equal(result.isError, true);
    assert.equal(resultField(result, 'outcome'), 'stale');
    assert.equal(resultField(result, 'message'), resultField(staleReview, 'message'));
  }

  const takeoverClient = await connect('offline-takeover');
  await takeoverClient.callTool({ name: 'target_project', arguments: { projectId } });
  const takeoverId = sessionId(await takeoverClient.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'auto' },
  }));
  await takeoverClient.callTool({
    name: 'set_aspect_ratio',
    arguments: { editSessionId: takeoverId, ratio: '9:16' },
  });
  registerEditor(projectId, 'browser-owner', 'browser-revision', []);
  const takeoverReview = await takeoverClient.callTool({
    name: 'review_edit_session',
    arguments: { editSessionId: takeoverId },
  });
  assert.equal(takeoverReview.isError, true);
  assert.equal(resultField(takeoverReview, 'outcome'), 'stale');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, concurrent);
  await unregisterEditor(projectId, 'browser-owner');

  const ownershipClient = await connect('offline-stale-ownership');
  await ownershipClient.callTool({ name: 'target_project', arguments: { projectId } });
  await setStoredEntry(`project:${projectId}`, projectDoc(640, 360));
  const ownershipStale = await ownershipClient.callTool({ name: 'openchatcut_status', arguments: {} });
  assert.equal(resultField(ownershipStale, 'outcome'), 'stale');
  await delayImmediate();
  assert.ok((await ownershipClient.listTools()).tools.some((tool) => tool.name === 'target_project'));
  const freshOfflineClient = await connect('offline-after-stale-ownership');
  assert.notEqual((await freshOfflineClient.callTool({
    name: 'target_project', arguments: { projectId },
  })).isError, true, 'a stale offline binding releases ownership without closing its MCP transport');
} finally {
  await resetMcpSessionsForTest();
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  resetExternalAgentBrokerForTest();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getStoredEntry('projects');
  if (previousDataDir === undefined) delete process.env.OPENCHATCUT_DATA_DIR;
  else process.env.OPENCHATCUT_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
}

console.log('offline-mcp.verify: ok');
