import { spawnSync } from 'node:child_process';
import { existsSync, cpSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createTestArtifacts, finishTestArtifacts, assertArtifactSpace, treeInventory, testArtifactRoot, ensureManagedTestRoot } from './test-artifacts.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TARGET = 'win32-x64';
const KINDS = ['nsis'];

export function windowsPackagePlan({
  node = process.execPath,
  cli = 'node_modules/electron-builder/cli.js',
  electronDist = process.env.CC_ELECTRON_DIST?.trim() || undefined,
  installedPnpm = existsSync(new URL('../node_modules/.modules.yaml', import.meta.url)),
} = {}) {
  return KINDS.map((kind) => ({
    kind,
    command: node,
    args: [
      cli,
      '--config', 'config/electron-builder.config.mjs',
      ...(electronDist ? [`--config.electronDist=${electronDist}`] : []),
      '--win', '--x64', '--publish', 'never',
    ],
    // Both locks may exist during the local fork's migration. Match the
    // installed tree; npm-based CI checkouts must keep using npm.
    env: { CC_EB_TARGET: TARGET, CC_EB_WIN_KIND: kind, ...(installedPnpm ? { npm_config_user_agent: 'pnpm' } : {}) },
  }));
}

export function windowsUpdateMetadata(version, name, bytes, releaseDate) {
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${releaseDate}'\n`;
}

export function verifyWindowsPackage({ node = process.execPath, output = resolve(process.env.CC_EB_OUTPUT?.trim() || 'release'),
  copy = cpSync, run = spawnSync, temporary = mkdtempSync } = {}) {
  const app = join(output, 'win-unpacked');
  if (!existsSync(join(app, 'ZuorenJiandao.exe'))) throw new Error(`Missing packaged executable: ${app}`);
  const isolatedRoot = createTestArtifacts('package-check', { expectedBytes: treeInventory(app).bytes * 2 });
  const destination = join(isolatedRoot, 'app');
  const evidence = join(output, 'logs', basename(isolatedRoot));
  let passed = false;
  let failure;
  try {
  copy(app, destination, { recursive: true, dereference: false });
  const result = run(node, [resolve('scripts/verify-packaged-isolated.mjs'), join(destination, 'ZuorenJiandao.exe')],
    { stdio: 'inherit', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Independent package check failed; evidence retained at ${evidence}`);
  passed = true;
  console.log(`[package] independent startup/MCP/render passed; evidence: ${evidence}`);
  return evidence;
  } catch (error) { failure = error; throw error;
  } finally {
    try { finishTestArtifacts(isolatedRoot, { status: passed ? 'passed' : 'failed', evidence,
      retain: passed ? [] : [join('app', 'resources', 'app.asar')] }); }
    catch (cleanup) { if (failure) throw new AggregateError([failure, cleanup], 'Package check and cleanup failed', { cause: failure }); throw cleanup; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = resolve(process.env.CC_EB_OUTPUT?.trim() || 'release');
  assertArtifactSpace(ensureManagedTestRoot(testArtifactRoot()), 4 * 1024 ** 3);
  assertArtifactSpace(output, 4 * 1024 ** 3);
  for (const step of windowsPackagePlan()) {
    const result = spawnSync(step.command, step.args, {
      stdio: 'inherit',
      env: { ...process.env, ...step.env },
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
  verifyWindowsPackage({ output });
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const name = `ZuorenJiandao-Setup-${version}-x64.exe`;
  writeFileSync(join(output, 'latest.yml'), windowsUpdateMetadata(version, name,
    readFileSync(join(output, name)), new Date().toISOString()));
}
