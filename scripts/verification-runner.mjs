import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeVerificationReport } from './verification-report.mjs';
import { readInventory, projectFiles, validateInventory, selectItems, nodeArguments } from './verification-inventory.mjs';
import { runBoundedProcess } from './verification-process.mjs';
import { createTestArtifacts, finishTestArtifacts, assertArtifactSpace } from './test-artifacts.mjs';

export async function runVerification(argv = process.argv.slice(2), { signal } = {}) {
  const separator = argv.indexOf('--');
  const explicitForward = separator < 0 ? [] : argv.slice(separator + 1);
  argv = separator < 0 ? argv : argv.slice(0, separator);
  const option = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const forwarded = [...argv.filter(arg => !/^--(?:group|suite|item|files|output|item-timeout-ms)=/.test(arg) && arg !== '--list'), ...explicitForward];
  if (['group', 'suite', 'item', 'files'].filter(name => option(name)).length > 1) throw new Error('Select one group, suite, item, or file selection');
  const cwd = process.cwd(), manifest = readInventory(cwd);
  validateInventory(manifest, projectFiles(cwd));
  const items = option('files')
    ? [...new Set(option('files').split(','))].flatMap(item => selectItems(manifest, { item }))
    : selectItems(manifest, { group: option('group'), suite: option('suite'), item: option('item') });
  if (forwarded.length && items.length !== 1) throw new Error('Runtime arguments require a single selected verification item');
  if (argv.includes('--list')) {
    for (const item of items) console.log(`${item.group}\t${item.timeoutMs}ms\t${item.id}\t${item.command}`);
    return { status: 'listed', results: [] };
  }
  const override = option('item-timeout-ms') ?? process.env.VERIFY_ITEM_TIMEOUT_MS;
  if (override !== undefined && (!Number.isSafeInteger(Number(override)) || Number(override) <= 0)) throw new Error('Item deadline must be a positive integer');
  const output = resolve(option('output') ?? `release/verification-${Date.now()}`);
  assertArtifactSpace(output, 16 * 1024 ** 2, { env: { ...process.env, CC_TEST_MIN_FREE_BYTES: '134217728', CC_TEST_MAX_BYTES: '1073741824' } });
  await mkdir(output, { recursive: true });
  const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  const report = { version: pkg.version, startedAt: new Date().toISOString(), node: process.execPath,
    scope: 'Explicit manifest selection; serial; bounded items; no retries or reuse', selected: items.map(item => item.id),
    status: 'running', results: [] };
  const persist = () => writeVerificationReport(join(output, 'results.json'), report);
  await persist();
  console.log(`Running ${items.length} verification items serially (1 parallel).`);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason ?? new Error('Verification interrupted'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (const [index, item] of items.entries()) {
      if (controller.signal.aborted) break;
      const name = `${index}-${item.id.replace(/[^\w.-]+/g, '-').slice(0, 120)}.log`;
      report.inFlight = { id: item.id, startedAt: new Date().toISOString() }; await persist();
      let execution;
      let temporary;
      try {
        if (item.group !== 'logic') temporary = createTestArtifacts('verification-temp', { expectedBytes: 256 * 1024 ** 2 });
        execution = await runBoundedProcess({ args: [...nodeArguments(item.command), ...forwarded], cwd,
          timeoutMs: Number(override ?? item.timeoutMs), logPath: join(output, name), signal: controller.signal,
          ...(temporary ? { env: { TEMP: temporary, TMP: temporary, TMPDIR: temporary } } : {}) });
      } catch (error) {
        execution = { status: 'failed', reason: error.message, infrastructureError: true };
      }
      if (temporary) try {
        execution.artifacts = finishTestArtifacts(temporary, { status: execution.status,
          evidence: join(output, `${index}-temporary-evidence`) });
      } catch (error) { execution.cleanupError = error.message; execution.status = 'failed'; }
      const result = { id: item.id, command: item.command, group: item.group, log: name, ...execution };
      report.results.push(result); delete report.inFlight;
      await appendFile(join(output, 'completed-commands.jsonl'), `${JSON.stringify(result)}\n`, { flush: true });
      await persist();
      console.log(`[verification] ${index + 1}/${items.length} ${result.status}: ${item.id}`);
      if (result.status !== 'passed') console.log(await readFile(join(output, name), 'utf8')
        .catch(error => `[verification] item log unavailable: ${error.message}`));
      if (result.cleanupError || result.infrastructureError || result.status === 'cancelled') break;
    }
    report.passed = report.results.filter(item => item.status === 'passed').length;
    report.failed = report.results.length - report.passed;
    report.notRun = items.length - report.results.length;
    report.status = controller.signal.aborted ? 'cancelled' : report.failed || report.notRun ? 'failed' : 'passed';
    report.completedAt = new Date().toISOString(); await persist();
    console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed, notRun: report.notRun, evidence: output }));
    process.exitCode = report.status === 'passed' ? 0 : 1;
    return report;
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    signal?.removeEventListener('abort', cancel);
  }
}
