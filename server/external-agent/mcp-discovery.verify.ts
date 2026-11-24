import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearMcpDiscovery,
  mcpDiscoveryPath,
  readMcpDiscovery,
  writeMcpDiscovery,
} from './mcp-discovery.ts';

const home = mkdtempSync(join(tmpdir(), 'occ-discovery-'));
try {
  const defaultPath = mcpDiscoveryPath({ home });
  assert.equal(defaultPath, join(home, '.openchatcut', 'discovery.json'));

  const isoPath = mcpDiscoveryPath({ home, profileId: 'prof-1' });
  assert.equal(isoPath, join(home, '.openchatcut', 'dev-profiles', 'prof-1', 'discovery.json'));

  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const autoVersionRes = writeMcpDiscovery({
    home,
    origin: 'http://127.0.0.1:5199/',
    pid: 4242,
  });
  assert.equal(autoVersionRes.written, true);
  assert.equal(readMcpDiscovery({ home })?.version, pkg.version);
  assert.notEqual(readMcpDiscovery({ home })?.version, '0.0.0');

  const writeRes = writeMcpDiscovery({
    home,
    origin: 'http://127.0.0.1:5199/',
    version: '0.3.3',
    pid: 4242,
  });
  assert.equal(writeRes.written, true);
  assert.equal(writeRes.path, defaultPath);

  const rawText = readFileSync(defaultPath, 'utf8');
  assert.ok(!rawText.includes('Bearer '), 'discovery file must never store raw bearer credentials');

  const readBack = readMcpDiscovery({ home });
  assert.ok(readBack);
  assert.equal(readBack!.app, 'ZuorenJiandao');
  assert.equal(readBack!.version, '0.3.3');
  assert.equal(readBack!.pid, 4242);
  assert.equal(readBack!.origin, 'http://127.0.0.1:5199');
  assert.equal(readBack!.mcpEndpoint, 'http://127.0.0.1:5199/api/external-mcp/mcp');
  assert.equal(readBack!.transport, 'streamable-http');
  assert.equal(readBack!.authScheme, 'bearer');
  assert.equal(readBack!.tokenPath, join(home, '.openchatcut', 'mcp-token'));
  assert.equal(readBack!.tokenEnvVar, 'OPENCHATCUT_MCP_TOKEN');

  assert.equal(clearMcpDiscovery({ home, pid: 9999 }), false, 'mismatched PID must not clear discovery file');
  assert.ok(readMcpDiscovery({ home }), 'discovery file stays intact for live PID');

  assert.equal(clearMcpDiscovery({ home, pid: 4242 }), true, 'matching PID clears discovery file');
  assert.equal(readMcpDiscovery({ home }), null);
  assert.equal(clearMcpDiscovery({ home, pid: 4242 }), false);

  console.log('✓ mcp-discovery: atomic write, profile isolation, no secret leak, PID-safe cleanup');
} finally {
  rmSync(home, { recursive: true, force: true });
}
