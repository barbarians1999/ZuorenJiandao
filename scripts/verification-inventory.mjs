import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const verifyPattern = /\.verify\.(?:tsx|mts|cjs|mjs|ts|js)$/;
export const groups = ['logic', 'short-render', 'desktop', 'package', 'long'];

export function projectFiles(root) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2,
  }).split('\0').filter(Boolean))].filter(file => existsSync(join(root, file)));
}

export function readInventory(root) {
  return JSON.parse(readFileSync(join(root, 'scripts/verification-manifest.json'), 'utf8'));
}

export function validateInventory(manifest, files) {
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.groups).sort(), [...groups].sort());
  assert.deepEqual(manifest.defaultGroups, ['logic'], 'Heavy checks require explicit selection');
  const ids = new Set(), registered = new Set();
  for (const item of manifest.items) {
    assert.equal(typeof item.id, 'string');
    assert(!ids.has(item.id), `Duplicate verification id: ${item.id}`); ids.add(item.id);
    assert(groups.includes(item.group), `Unknown group for ${item.id}`);
    assert(Number.isSafeInteger(item.timeoutMs) && item.timeoutMs > 0, `Missing bounded deadline: ${item.id}`);
    assert.match(item.command, /^(?:node|tsx|npx tsx) /, `Unsupported command: ${item.id}`);
    if (item.file) {
      assert(verifyPattern.test(item.file), `Not a verify file: ${item.file}`);
      assert(!registered.has(item.file), `Duplicate verification file: ${item.file}`);
      registered.add(item.file);
      assert(item.command.includes(item.file), `Command does not run ${item.file}`);
      assert(files.includes(item.file), `Registered verify is missing: ${item.file}`);
    }
  }
  const missing = files.filter(file => verifyPattern.test(file) && !registered.has(file)).sort();
  assert.deepEqual(missing, [], `Unregistered verification files:\n${missing.join('\n')}`);
  for (const [suite, members] of Object.entries(manifest.suites)) {
    assert(members.length, `Empty suite: ${suite}`);
    for (const id of members) assert(ids.has(id), `Unknown item ${id} in ${suite}`);
  }
  for (const scenario of ['change', 'render-change', 'desktop-release', 'long-export-change']) {
    const required = manifest.scenarios[scenario];
    assert(required?.groups?.length && required?.evidence?.length, `Incomplete scenario: ${scenario}`);
    for (const group of required.groups) assert(groups.includes(group), `Unknown scenario group: ${group}`);
  }
  assert.deepEqual(manifest.scenarios['desktop-release'].groups, ['logic', 'short-render', 'desktop', 'package']);
  for (const group of groups) {
    assert(Object.values(manifest.scenarios).some(scenario => scenario.groups.includes(group)), `No required scenario for ${group}`);
    assert(manifest.items.some(item => item.group === group), `Empty verification group: ${group}`);
  }
  return { files: registered.size, items: ids.size };
}

export function selectItems(manifest, options = {}) {
  if (options.item) {
    const item = manifest.items.find(candidate => candidate.id === options.item || candidate.file === options.item);
    assert(item, `Unknown verification item: ${options.item}`); return [item];
  }
  if (options.suite) {
    const ids = manifest.suites[options.suite];
    assert(ids, `Unknown verification suite: ${options.suite}`);
    return [...new Set(ids)].map(id => manifest.items.find(item => item.id === id));
  }
  const selected = options.group ? options.group.split(',') : manifest.defaultGroups;
  for (const group of selected) assert(groups.includes(group), `Unknown verification group: ${group}`);
  return manifest.items.filter(item => selected.includes(item.group));
}

export function nodeArguments(command) {
  assert(!/[|<>`"']/.test(command), `Unsupported command syntax: ${command}`);
  const [tool, ...args] = command.replace(/^npx\s+/, '').split(/\s+/);
  if (tool === 'tsx') return ['node_modules/tsx/dist/cli.mjs', ...args];
  assert.equal(tool, 'node', `Unsupported verification runtime: ${tool}`); return args;
}
