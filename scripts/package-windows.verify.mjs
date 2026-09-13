import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { windowsPackagePlan } from './package-windows.mjs';

const plan = windowsPackagePlan({ node: 'node.exe' });
assert.deepEqual(plan.map(({ kind }) => kind), ['nsis', 'portable']);
for (const step of plan) {
  assert.equal(step.env.CC_EB_TARGET, 'win32-x64');
  assert.equal(step.env.CC_EB_WIN_KIND, step.kind);
  assert.deepEqual(step.args, [
    'node_modules/electron-builder/cli.js', '--config', 'config/electron-builder.config.mjs',
    '--win', '--x64', '--publish', 'never',
  ]);
}

const configSource = await readFile(new URL('../config/electron-builder.config.mjs', import.meta.url), 'utf8');
assert.match(configSource, /appId:\s*'org\.zuoren\.jiandao'/);
assert.match(configSource, /productName:\s*isWindowsTarget \? '左人剪刀' : 'OpenChatCut'/);
assert.match(configSource, /ZuorenJiandao-Setup-\$\{version\}-\$\{arch\}/);
assert.match(configSource, /ZuorenJiandao-Portable-\$\{version\}-\$\{arch\}/);
assert.doesNotMatch(configSource, /provider:\s*'github'/, 'internal packages must not carry upstream publish metadata');

console.log('package-windows.verify: deterministic NSIS + portable plan and branding config OK');
