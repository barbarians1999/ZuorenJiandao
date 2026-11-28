import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import {
  checkMultiWindowConflict,
  editorCallBinding,
  editorEvictionInfo,
  touchEditor,
  editorRegistrationMatches,
  nextEditorCall,
  nextEditorCancellation,
  registerEditor,
  settleEditorCall,
  settleEditorCallWithRevision,
  unregisterEditor,
} from '../external-agent/broker.ts';
import { handleMcpRequest, mcpTools } from '../external-agent/mcp.ts';
import { exportJianyingDraft } from '../external-agent/jianying-export.ts';
import { CONNECT_CLIENTS, connectExternalClient, inspectExternalClients } from '../external-agent/client-connect.ts';
import { clearMcpDiscovery, mcpDiscoveryPath, writeMcpDiscovery } from '../external-agent/mcp-discovery.ts';
import { claimBrowserProjectOwnership } from '../external-agent/project-edit-ownership.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import {
  EDITOR_BOOTSTRAP_HEADER,
  configuredEditorOrigin,
  editorBootstrapPayload,
  editorCredentialAuthorized,
  externalMcpAuthorized,
  externalMcpToken,
  headerValue,
  trustedEditorRequest,
} from '../editor-auth.ts';
import {
  readBridgeJson,
  routeExternalAgentBridge,
  sendBridgeJson,
  type BridgeOperations,
} from './external-agent-bridge-routes.ts';

export type { BridgeOperations } from './external-agent-bridge-routes.ts';


const bridgeOperations: BridgeOperations = {
  claimBrowserOwnership: claimBrowserProjectOwnership,
  editorRegistrationMatches,
  registerEditor,
  unregisterEditor,
  nextEditorCall,
  nextEditorCancellation,
  settleEditorCall,
  settleEditorCallWithRevision,
  editorCallBinding,
  touchEditor,
  mcpTools,
  checkMultiWindowConflict,
  editorEvictionInfo,
};







function requestBaseUrl(req: IncomingMessage): string {
  const configured = configuredEditorOrigin();
  if (configured) return configured;
  const protocol = req.socket instanceof TLSSocket ? 'https:' : 'http:';
  return `${protocol}//${headerValue(req, 'host') ?? '127.0.0.1:5199'}`;
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = headerValue(req, 'content-type');
  return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function handleEditorBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!trustedEditorRequest(req, true)) {
    sendBridgeJson(res, 403, { error: 'untrusted editor origin' });
    return;
  }
  if (!isJsonRequest(req) || headerValue(req, EDITOR_BOOTSTRAP_HEADER) !== '1') {
    sendBridgeJson(res, 415, { error: 'editor bootstrap requires JSON and bootstrap header' });
    return;
  }
  if (!editorCredentialAuthorized(req, true)) {
    sendBridgeJson(res, 401, { error: 'invalid editor launch credential' });
    return;
  }
  await readBridgeJson(req);
  sendBridgeJson(res, 200, editorBootstrapPayload());
}

export async function handleExternalAgentBridge(
  req: IncomingMessage,
  res: ServerResponse,
  operations: BridgeOperations = bridgeOperations,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/bootstrap') {
    await handleEditorBootstrap(req, res);
    return;
  }
  const write = req.method === 'POST';
  if (!trustedEditorRequest(req, write)) {
    sendBridgeJson(res, 403, { error: 'untrusted editor origin' });
    return;
  }
  if (!editorCredentialAuthorized(req, write)) {
    sendBridgeJson(res, 401, { error: 'invalid editor bridge credential' });
    return;
  }
  if (write && !isJsonRequest(req)) {
    sendBridgeJson(res, 415, { error: 'editor bridge writes require JSON' });
    return;
  }
  if (write && url.pathname === '/jianying-export') {
    const body = await readBridgeJson(req);
    const result = await exportJianyingDraft(body);
    sendBridgeJson(res, result.ok ? 200 : 400, result);
    return;
  }
  if (write && url.pathname === '/connect-client') {
    const body = await readBridgeJson(req);
    const client = body.client;
    const token = externalMcpToken();
    if (typeof client !== 'string' || !CONNECT_CLIENTS.includes(client as (typeof CONNECT_CLIENTS)[number])) {
      sendBridgeJson(res, 400, { ok: false, error: 'invalid-client' });
      return;
    }
    const result = await connectExternalClient(client, `${requestBaseUrl(req)}/api/external-mcp/mcp`, token);
    sendBridgeJson(res, result.ok ? 200 : 500, result);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/client-status') {
    const endpoint = `${requestBaseUrl(req)}/api/external-mcp/mcp`;
    const clients = await inspectExternalClients(endpoint, externalMcpToken());
    const profile = runtimeProfile();
    const profileId = profile.mode === 'isolated-dev' ? profile.id : undefined;
    const rawDiscoveryPath = mcpDiscoveryPath({ profileId });
    const home = homedir();
    const rel = path.relative(home, rawDiscoveryPath);
    const discoveryPath = rel.startsWith('..') ? rawDiscoveryPath : `~/${rel.split(path.sep).join('/')}`;
    sendBridgeJson(res, 200, { ok: true, endpoint, discoveryPath, clients });
    return;
  }
  await routeExternalAgentBridge(req, res, url, operations);
}

export function externalAgentPlugin(): Plugin {
  return {
    name: 'openchatcut-external-agent',
    configureServer(server) {
      const profile = runtimeProfile();
      const profileId = profile.mode === 'isolated-dev' ? profile.id : undefined;
      const httpServer = server.httpServer;
      const publishDiscovery = () => {
        const configured = configuredEditorOrigin();
        const addr = httpServer?.address();
        const origin = configured
          ?? (addr && typeof addr === 'object'
            ? `http://${addr.address === '0.0.0.0' || addr.address === '::' || addr.address === '::1' ? '127.0.0.1' : addr.address}:${addr.port}`
            : null);
        if (origin) writeMcpDiscovery({ origin, profileId });
      };
      if (httpServer) {
        if (httpServer.listening) publishDiscovery();
        else httpServer.once('listening', publishDiscovery);
        httpServer.once('close', () => { clearMcpDiscovery({ profileId }); });
      }
      server.middlewares.use('/api/external-agent', (req, res) => {
        void handleExternalAgentBridge(req, res).catch((error) => {
          if (!res.headersSent) sendBridgeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      server.middlewares.use('/api/external-mcp/mcp', (req, res) => {
        if (!externalMcpAuthorized(req)) {
          sendBridgeJson(res, 401, { error: 'invalid OpenChatCut MCP token' });
          return;
        }
        void handleMcpRequest(req, res, requestBaseUrl(req)).catch((error) => {
          server.config.logger.error(`[external-mcp] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) sendBridgeJson(res, 500, { error: 'MCP request failed' });
        });
      });
    },
  };
}
