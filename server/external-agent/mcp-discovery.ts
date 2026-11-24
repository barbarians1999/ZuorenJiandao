import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpTokenPath, type McpTokenLocation } from '../mcp-token.ts';

export interface McpDiscoveryRecord {
  readonly app: 'ZuorenJiandao';
  readonly version: string;
  readonly pid: number;
  readonly origin: string;
  readonly mcpEndpoint: string;
  readonly transport: 'streamable-http';
  readonly authScheme: 'bearer';
  readonly tokenPath: string;
  readonly tokenEnvVar: 'OPENCHATCUT_MCP_TOKEN';
  readonly updatedAt: string;
}

export interface WriteMcpDiscoveryOptions extends McpTokenLocation {
  readonly origin: string;
  readonly version?: string;
  readonly pid?: number;
}

function resolvePackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'package.json'),
    join(here, '..', 'package.json'),
    join(here, 'package.json'),
  ];
  for (const pkgPath of candidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

/** Resolve the runtime MCP discovery manifest path (~/.openchatcut/discovery.json or isolated profile path). */
export function mcpDiscoveryPath({ home = homedir(), profileId }: McpTokenLocation = {}): string {
  const root = profileId
    ? join(home, '.openchatcut', 'dev-profiles', profileId)
    : join(home, '.openchatcut');
  return join(root, 'discovery.json');
}

/**
 * Publish the active MCP endpoint and token file pointer for external tools (never embeds raw token secrets).
 */
export function writeMcpDiscovery(options: WriteMcpDiscoveryOptions): { path: string; written: boolean } {
  const path = mcpDiscoveryPath(options);
  const cleanOrigin = options.origin.replace(/\/+$/, '');
  const record: McpDiscoveryRecord = {
    app: 'ZuorenJiandao',
    version: options.version?.trim() || resolvePackageVersion(),
    pid: options.pid ?? process.pid,
    origin: cleanOrigin,
    mcpEndpoint: `${cleanOrigin}/api/external-mcp/mcp`,
    transport: 'streamable-http',
    authScheme: 'bearer',
    tokenPath: mcpTokenPath(options),
    tokenEnvVar: 'OPENCHATCUT_MCP_TOKEN',
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
    renameSync(tmp, path);
    return { path, written: true };
  } catch {
    return { path, written: false };
  }
}

export function readMcpDiscovery(location: McpTokenLocation = {}): McpDiscoveryRecord | null {
  const path = mcpDiscoveryPath(location);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpDiscoveryRecord>;
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof parsed.origin !== 'string'
      || typeof parsed.mcpEndpoint !== 'string'
      || !Number.isInteger(parsed.pid)
      || parsed.pid! <= 0
    ) {
      return null;
    }
    return parsed as McpDiscoveryRecord;
  } catch {
    return null;
  }
}

/** Remove discovery.json on server shutdown only when its recorded PID matches this process. */
export function clearMcpDiscovery(options: McpTokenLocation & { readonly pid?: number } = {}): boolean {
  const expectedPid = options.pid ?? process.pid;
  const existing = readMcpDiscovery(options);
  if (!existing || existing.pid !== expectedPid) return false;
  try {
    unlinkSync(mcpDiscoveryPath(options));
    return true;
  } catch {
    return false;
  }
}
