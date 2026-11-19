// Affected-only verify runner: runs the verifies that match files changed
// in the working tree (or an explicit file list). Full `npm test` stays for
// release gates; this covers the daily loop in seconds.
//
// Exact suites win, otherwise select the nearest directory with suites.
// This is a heuristic, not an import graph. Shared/configuration/assets and
// unmapped changes require the full gate instead of claiming affected coverage.
//
// Usage:
//   npm run verify:affected            — all working-tree changes vs HEAD
//   npm run verify:affected -- <file>… — explicit files
//   npm run verify:affected -- --list <file>… — inspect without executing tests
import { execFile } from 'node:child_process';
import { runVerification } from './verification-runner.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const SOURCE_EXTENSION = /\.(?:tsx|mts|cjs|mjs|ts|js|frag|vert|glsl)$/;
const VERIFY_EXTENSION = /\.verify\.(?:tsx|mts|cjs|mjs|ts|js)$/;
const FULL_GATE = /^(?:package(?:-lock)?\.json$|npm-shrinkwrap\.json$|tsconfig(?:\.[^/]+)?\.json$|config\/|shared\/|assets\/|public\/|\.github\/)/;
const DOCUMENTATION = /^(?:docs\/|README(?:_[A-Z]+)?\.md$|CHANGELOG\.md$|LICENSE$|AGENTS\.md$|CLAUDE\.md$)/;
const toPosix = (value) => value.split(sep).join('/');

export async function gitChanged(cwd = process.cwd()) {
  const run = promisify(execFile);
  const outputs = await Promise.all([
    run('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD'], { cwd }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd }),
  ]);
  return [...new Set(outputs.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))];
}

function directoryVerifies(dir, cwd) {
  try {
    return readdirSync(resolve(cwd, dir)).filter((name) => VERIFY_EXTENSION.test(name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function affectedSelection(changedFiles, cwd = process.cwd()) {
  const matches = new Set();
  const requiresFullGate = new Set();
  for (const changed of changedFiles) {
    const file = toPosix(relative(cwd, resolve(cwd, changed)));
    if (DOCUMENTATION.test(file)) continue;
    if (FULL_GATE.test(file) && !VERIFY_EXTENSION.test(file)) requiresFullGate.add(file);
    if (!SOURCE_EXTENSION.test(file) || file.startsWith('../')) {
      requiresFullGate.add(file);
      continue;
    }
    if (/^src\/gl\/.*\.(?:frag|vert|glsl)$/.test(file)) {
      for (const name of directoryVerifies('src/gl', cwd)) matches.add(toPosix(join('src/gl', name)));
    }
    let dir = dirname(file);
    let candidates = directoryVerifies(dir, cwd);
    const base = file.split('/').pop().replace(SOURCE_EXTENSION, '');
    const exact = candidates.filter((name) => name.replace(VERIFY_EXTENSION, '') === base
      || toPosix(join(dir, name)) === file);
    if (exact.length) candidates = exact;
    while (!candidates.length && dir !== '.') {
      dir = dirname(dir);
      candidates = directoryVerifies(dir, cwd);
    }
    if (!candidates.length) requiresFullGate.add(file);
    for (const name of candidates) matches.add(toPosix(join(dir, name)));
  }
  return { verifies: [...matches].sort(), requiresFullGate: [...requiresFullGate].sort() };
}

export function matchingVerifies(changedFiles) {
  return affectedSelection(changedFiles).verifies;
}

// Runtime-specific launchers come from the same explicit inventory as npm test.
const CANONICAL_COMMANDS = new Map(JSON.parse(
  readFileSync(new URL('./verification-manifest.json', import.meta.url), 'utf8'),
).items.filter(item => item.file).map(item => [item.file, item.command]));

/** The command the suite itself uses, falling back to the usual runner. */
export function verifyCommand(file) {
  return CANONICAL_COMMANDS.get(file)
    ?? (/\.(?:mjs|cjs|js)$/.test(file) ? `node ${file}` : `npx tsx ${file}`);
}

async function main() {
  const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const changed = explicit.length > 0 ? explicit : await gitChanged();
  const { verifies, requiresFullGate } = affectedSelection(changed);
  if (process.argv.includes('--list')) console.log(verifies.join('\n'));
  if (requiresFullGate.length) {
    console.error(`Affected selection cannot establish coverage for:\n  ${requiresFullGate.join('\n  ')}`);
    console.error('Run the broader gate: npm run lint && npm test && npm run build');
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes('--list')) return;
  if (verifies.length === 0) {
    console.log('✓ no affected verifies (no changes or documentation only)');
    console.log(`  changed: ${changed.slice(0, 6).join(', ') || '(none)'}`);
    return;
  }
  await runSelected(verifies);
}

async function runSelected(verifies) {
  if (verifies.length > 40) console.log('Large affected selection; every selected verify remains included.');
  await runVerification([`--files=${verifies.join(',')}`]);
}

// Only run when invoked directly, so the verify can import the matcher.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
