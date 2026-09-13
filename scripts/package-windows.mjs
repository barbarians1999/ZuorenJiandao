import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TARGET = 'win32-x64';
const KINDS = ['nsis', 'portable'];

export function windowsPackagePlan({ node = process.execPath, cli = 'node_modules/electron-builder/cli.js' } = {}) {
  return KINDS.map((kind) => ({
    kind,
    command: node,
    args: [cli, '--config', 'config/electron-builder.config.mjs', '--win', '--x64', '--publish', 'never'],
    env: { CC_EB_TARGET: TARGET, CC_EB_WIN_KIND: kind },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const step of windowsPackagePlan()) {
    const result = spawnSync(step.command, step.args, {
      stdio: 'inherit',
      env: { ...process.env, ...step.env },
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
}
