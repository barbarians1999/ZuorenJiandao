// Tiny child processes only. No renderer, browser, application profile or long export.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { validateInventory, projectFiles, selectItems } from './verification-inventory.mjs';
import { runVerification } from './verification-runner.mjs';
import { createTestArtifacts, finishTestArtifacts } from './test-artifacts.mjs';

const originalCwd = process.cwd();
const root = createTestArtifacts('verification-contract',{expectedBytes:64*1024**2});
const evidencePath=resolve(originalCwd,'release/logs',basename(root));
let verifierFailure;
try {
mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src'));
for (const name of ['run-tests.mjs', 'run-standard-verification.mjs', 'verification-runner.mjs',
  'verification-inventory.mjs', 'verification-process.mjs', 'verification-report.mjs', 'test-artifacts.mjs']) {
  copyFileSync(join(originalCwd, 'scripts', name), join(root, 'scripts', name));
}
execFileSync('git', ['init', '-q', root]);
const groups = ['logic', 'short-render', 'desktop', 'package', 'long'];
const manifest = {
  version: 1, defaultGroups: ['logic'], groups: Object.fromEntries(groups.map(group => [group, group])),
  scenarios: Object.fromEntries(['change', 'render-change', 'desktop-release', 'long-export-change'].map(name => [name,
    { groups: name === 'desktop-release' ? groups.filter(group => group !== 'long') : groups, evidence: ['fixture-report'] }])),
  suites: {}, items: groups.map(group => ({ id: group, command: 'node src/hang.verify.cjs', group, timeoutMs: 1500,
    ...(group === 'logic' ? { file: 'src/hang.verify.cjs' } : {}) })),
};
writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 'fixture', scripts: { test: 'node scripts/run-tests.mjs' } }));
writeFileSync(join(root, 'scripts/verification-manifest.json'), JSON.stringify(manifest));
writeFileSync(join(root, 'src/hang.verify.cjs'), `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
fs.appendFileSync('pids.jsonl', JSON.stringify({pid:process.pid,parent:process.ppid})+'\\n');
if (!process.argv.includes('--grandchild')) spawn(process.execPath, [__filename, '--grandchild'], {stdio:'inherit',windowsHide:true});
setInterval(()=>{}, 1000);
`);
validateInventory(manifest, projectFiles(root));
assert.equal(selectItems(manifest).length, 1, 'Default runs logic only');

// Both cached Git files and nonignored new files participate, including files
// never mentioned in package scripts. Ignored scratch files do not participate.
writeFileSync(join(root, '.gitignore'), 'ignored.verify.mjs\n');
writeFileSync(join(root, 'ignored.verify.mjs'), '');
writeFileSync(join(root, 'src/new.verify.mjs'), '');
let registrationFailure;
try { validateInventory(manifest, projectFiles(root)); }
catch (error) { registrationFailure = error.message; }
assert.match(registrationFailure, /Unregistered verification files:[\s\S]*src\/new\.verify\.mjs/);
for (const runner of ['run-tests.mjs', 'run-standard-verification.mjs']) {
  const rejected = spawnSync(process.execPath, [join(root, 'scripts', runner), '--list'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /Unregistered verification files/);
}
manifest.items.push({ id: 'new', file: 'src/new.verify.mjs', command: 'node src/new.verify.mjs', group: 'long', timeoutMs: 1500 });
writeFileSync(join(root, 'scripts/verification-manifest.json'), JSON.stringify(manifest));
const allPids = () => readFileSync(join(root, 'pids.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).pid);
const assertDead = pids => { for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `Owned process ${pid} survived cleanup`); };
const evidence = { registrationFailure, timeout: [], cancelled: null };

// The default entry's own deadline applies without an outer harness option.
for (const runner of ['run-tests.mjs', 'run-standard-verification.mjs']) {
  const output = join(root, runner.replace('.mjs', '-evidence'));
  const result = spawnSync(process.execPath, [join(root, 'scripts', runner), `--output=${output}`], {
    cwd: root, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 1, `${runner}: ${result.stderr}`);
  const report = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8'));
  assert.equal(report.status, 'failed'); assert.equal(report.results[0].status, 'timed-out');
  assert.equal(report.results[0].timeoutMs, 1500); assert.equal(report.results[0].cleanupError, undefined);
  assert.equal(report.notRun, 0); assert.match(readFileSync(join(output, 'completed-commands.jsonl'), 'utf8'), /timed-out/);
  assert(allPids().length >= 2, 'Fixture really starts a grandchild'); assertDead(allPids());
  evidence.timeout.push({ runner, result: report.results[0], output });
}

// Abort propagates into the running item and closes its descendants; it must
// not launch the next selected item or turn cancellation into a passing report.
process.chdir(root);
try {
  const controller = new AbortController();
  const before = allPids().length;
  const watcher = setInterval(() => {
    if (allPids().length >= before + 2) { clearInterval(watcher); controller.abort(new Error('fixture cancellation')); }
  }, 25);
  const report = await runVerification(['--group=logic,long', '--item-timeout-ms=15000', `--output=${join(root, 'cancelled-evidence')}`], { signal: controller.signal });
  clearInterval(watcher);
  assert.equal(report.status, 'cancelled'); assert.equal(report.results[0].status, 'cancelled');
  assert.equal(report.results[0].cleanupError, undefined); assert(report.notRun > 0);
  assertDead(allPids()); evidence.cancelled = report;
} finally { process.chdir(originalCwd); process.exitCode = 0; }
// A scratch preflight failure happens before the child can create its log.
process.chdir(root);
const savedArtifactRoot=process.env.CC_TEST_ARTIFACT_ROOT;
try {
  process.env.CC_TEST_ARTIFACT_ROOT='relative-not-allowed';
  const report=await runVerification(['--group=short-render',`--output=${join(root,'preflight-evidence')}`]);
  assert.equal(report.status,'failed');assert.equal(report.results[0].infrastructureError,true);
  assert.match(report.results[0].reason,/must be absolute/);
} finally {
  if(savedArtifactRoot===undefined)delete process.env.CC_TEST_ARTIFACT_ROOT;
  else process.env.CC_TEST_ARTIFACT_ROOT=savedArtifactRoot;
  process.chdir(originalCwd);process.exitCode=0;
}
writeFileSync(join(root, 'reproduction.json'), JSON.stringify(evidence, null, 2));
console.log(`verification-contract: registration, both bounded entries, descendant cleanup and abort passed; evidence ${evidencePath}`);
} catch(error) {
  verifierFailure=error;throw error;
} finally {
  process.chdir(originalCwd);
  try {finishTestArtifacts(root,{status:verifierFailure?'failed':'passed',
    evidence:evidencePath,
    retain:verifierFailure?['src/hang.verify.cjs','scripts/verification-manifest.json','package.json','.gitignore']:[]});}
  catch(cleanupError){if(verifierFailure)throw new AggregateError([verifierFailure,cleanupError],'Verifier and cleanup failed');throw cleanupError;}
}
