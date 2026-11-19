import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

// Fail closed: retired API paths must not fall through to the SPA or a proxy.
export const REMOVED_AI_ROUTE_PREFIXES = [
  '/llm', '/assemblyai', '/api/agent-runs', '/api/codex', '/api/copilot',
  '/api/xai-oauth', '/generate', '/api/stock-search', '/api/web-browser',
  '/api/firecrawl', '/e2b', '/api/transcribe', '/api/assemblyai-upload',
  '/api/keys/test',
] as const;

export function isRemovedAiRoute(url: string): boolean {
  const pathname = url.split('?', 1)[0];
  return REMOVED_AI_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname?.startsWith(`${prefix}/`));
}

export function removedAiRoutesPlugin(): Plugin {
  return {
    name: 'zuoren-removed-ai-routes',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next) => {
        if (!isRemovedAiRoute(req.url ?? '/')) { next(); return; }
        req.resume();
        res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Embedded AI services were removed. Use an external MCP client to control the editor.' }));
      });
    },
  };
}
