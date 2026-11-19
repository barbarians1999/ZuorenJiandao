// Lightweight lifecycle/sampling checks; never sends a render job.
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { productionWorkerExecArgv, retainSuccessfulPhase, recordedProcessQuery } from './production-acceptance-contract.mjs';

assert.deepEqual(productionWorkerExecArgv(), ['--import', 'tsx'], 'Full worker must not use a small diagnostic heap cap');
const original = { name: 'typecheck', status: 'passed', exit: { code: 0 }, log: 'original.log' };
const previous = { phases: [original] };
const first = retainSuccessfulPhase(previous, 'typecheck', 'first');
const next = retainSuccessfulPhase({ phases: [first] }, 'typecheck', 'next');
assert.equal(next.status, 'retained-pass'); assert.equal(next.originalPassFrom, 'first');
assert.equal(next.retainedFrom, 'next'); assert.equal(original.status, 'passed', 'Never mutate prior failure/pass reports');
for (const invalid of [{ ...original, status: 'failed' }, { ...original, exit: { code: 1 } }, { ...original, log: null }]) {
  assert.throws(() => retainSuccessfulPhase({ phases: [invalid] }, 'typecheck', 'next'));
}
assert.throws(() => retainSuccessfulPhase({ phases: [] }, 'typecheck', 'next'));

const timeoutError = Object.assign(new Error('exec timed out'), { killed: true, signal: 'SIGTERM', code: null, stderr: 'timeout diagnostic' });
let attempts = 0;
const failures = [];
const recovered = await recordedProcessQuery(async options => {
  assert.equal(options.timeout, 30000);
  attempts++;
  if (attempts === 1) throw timeoutError;
  assert.equal(failures.length, 1, 'Record failed sample before retry');
  return { stdout: '[]' };
}, async failure => failures.push(failure));
assert.equal(recovered.attempts, 2); assert.equal(attempts, 2);
assert.equal(failures[0].willRetry, true); assert.equal(failures[0].stderr, 'timeout diagnostic');
attempts = 0;
await assert.rejects(recordedProcessQuery(async () => { attempts++; throw timeoutError; }), /timed out/);
assert.equal(attempts, 2, 'Persistent timeout stops, no infinite retries');
attempts = 0;
await assert.rejects(recordedProcessQuery(async () => { attempts++; throw new Error('identity changed'); }), /identity changed/);
assert.equal(attempts, 1, 'Never retry an ownership failure');
attempts = 0;
await assert.rejects(recordedProcessQuery(async () => { attempts++; throw timeoutError; }, async () => { throw new Error('report unavailable'); }), /report unavailable/);
assert.equal(attempts, 1, 'No recovery without preserved evidence');

const workerFile = resolve('scripts/production-long-export-acceptance.mjs');
const source = await readFile(workerFile, 'utf8');
const start = source.indexOf('async function ownedMemorySample(');
const end = source.indexOf('async function serverDigest()', start);
assert.ok(start >= 0 && end > start);
const helper = source.slice(start, end);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const ps = (script, options = {}) => promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, ...options });
const sample = Function('ps', 'quote', 'workerFile', 'recordedProcessQuery', `${helper}\nreturn ownedMemorySample;`)(ps, quote, workerFile, recordedProcessQuery);
assert.deepEqual(await sample(undefined), { processes: [], scope: 'No production render worker active' });

let captured;
const mocked = Function('ps', 'quote', 'workerFile', 'recordedProcessQuery', `${helper}\nreturn ownedMemorySample;`)(async script => {
  captured = script;
  return { stdout: '[{"pid":123,"parent":456,"name":"node.exe","workingSetBytes":1024}]' };
}, quote, "C:\\a'b\\worker.mjs", recordedProcessQuery);
assert.equal((await mocked({ pid: 123, launchedAt: 5000 })).processes[0].workingSetBytes, 1024);
assert.ok(captured.includes("C:\\a''b\\worker.mjs"), 'Literal path quotes must be escaped');
assert.ok(captured.includes('ParentProcessId') && captured.includes('CreationDate') && captured.includes('--worker'));
for (const stdout of ['{', '{}', '[{"pid":123,"workingSetBytes":-1}]']) {
  let calls = 0;
  const invalid = Function('ps', 'quote', 'workerFile', 'recordedProcessQuery', `${helper}\nreturn ownedMemorySample;`)(
    async () => { calls++; return { stdout }; }, quote, workerFile, recordedProcessQuery);
  await assert.rejects(invalid({ pid: 123, launchedAt: 5000 }));
  assert.equal(calls, 1, 'Invalid samples must fail, not retry or become an empty success');
}

if (process.platform === 'win32') {
  const launchedAt = Date.now();
  const child = fork(workerFile, ['--worker', '--inspect-worker'], { execPath: process.execPath, execArgv: productionWorkerExecArgv(), windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(done => child.once('exit', done));
  const inspected = new Promise((done, fail) => { child.once('message', done); child.once('error', fail); });
  // Do not kill the idle fixture before the bounded30s query/recovery budget.
  // It still has a fixed lifetime and is always cleaned up in finally.
  const timer = setTimeout(() => child.kill(), 120000);
  try {
    await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
    const ready = await inspected;
    assert.equal(ready.workerListeners, 1, 'Exactly one production IPC handler; imported helper must not start a duplicate render');
    assert.deepEqual(ready.runtime.execArgv, productionWorkerExecArgv());
    assert.equal(ready.runtime.pid, child.pid);
    // Normal test invocation and its child use the same runtime default.
    // Explicit test launcher heap settings are not propagated by the fork.
    if (!process.execArgv.some(arg => arg.startsWith('--max-old-space-size'))) {
      assert.equal(ready.runtime.heapLimitBytes, getHeapStatistics().heap_size_limit);
    }
    assert.ok(ready.runtime.heapLimitBytes > 1024 ** 3, 'Actual full-export worker must not retain the old 512MiB cap');
    assert.ok(ready.runtime.memory.heapUsed > 0 && ready.runtime.memory.external >= 0);
    assert.equal(ready.inheritedHardwareDisable, process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? null,
      'Imported test helper must not force production software encoding');
    const live = await sample({ pid: child.pid, launchedAt });
    assert.ok(live.processes.some(entry => entry.pid === child.pid && entry.parent === process.pid && entry.workingSetBytes > 0));
    assert.ok(live.processes.every(entry => entry.name !== 'chrome-headless-shell.exe' && entry.name !== 'ffmpeg.exe'), 'No renderer/media job may start');
    assert.equal(live.workerRuntime, null);
    const withRuntime = await sample({ pid: child.pid, launchedAt, runtime: ready.runtime });
    assert.deepEqual(withRuntime.workerRuntime, ready.runtime, 'Resource snapshots must include actual worker heap evidence');
    assert.match(live.scope, /not peak/);
    await assert.rejects(sample({ pid: process.pid, launchedAt }), /identity changed/);
    let actualAttempts = 0;
    const actualFailures = [];
    const realTimeoutSample = Function('ps', 'quote', 'workerFile', 'recordedProcessQuery', `${helper}\nreturn ownedMemorySample;`)(
      (script, options) => ps(script, { ...options, ...(actualAttempts++ === 0 ? { timeout: 1 } : {}) }), quote, workerFile, recordedProcessQuery);
    const recoveredSample = await realTimeoutSample({ pid: child.pid, launchedAt, onSamplingFailure: async failure => actualFailures.push(failure) });
    assert.equal(recoveredSample.samplingAttempts, 2);
    assert.equal(actualFailures.length, 1); assert.equal(actualFailures[0].timeout, true);
    assert.ok(actualFailures[0].killed && actualFailures[0].signal === 'SIGTERM', 'Actual exec timeout metadata retained');
    assert.ok(recoveredSample.processes.some(entry => entry.pid === child.pid));
  } finally { clearTimeout(timer); child.kill(); await exited; }
}
console.log('Production acceptance memory sampling: verified; no render job started');
