// Diagnostic ownership boundary: wait for the worker to EXIT, not merely for
// renderMedia to resolve while its asynchronous native cleanup is still running.
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const workerFile = fileURLToPath(import.meta.url);
const exec = promisify(execFile);

async function terminateOwnedWorker(child, launchedAt) {
  if (!child.pid) return;
  if (process.platform !== 'win32') { child.kill(); return; }
  // Only our still-owned fork may be terminated. Recheck its parent, command
  // and creation time before taskkill can include its native descendants.
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter ${quote(`ProcessId=${child.pid}`)}; `
    + `if (!$p) { exit 0 }; if ($p.ParentProcessId -ne ${process.pid} -or !$p.CommandLine.Contains(${quote(workerFile)}) `
    + `-or !$p.CommandLine.Contains('--worker') -or ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -lt ${launchedAt - 2000}) `
    + `{ throw 'Worker identity changed; refusing process-tree termination' }; `
    + `& "$env:SystemRoot/System32/taskkill.exe" /PID ${child.pid} /T /F; if ($LASTEXITCODE -ne 0) { throw 'Owned worker cleanup failed' }`;
  await exec('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000 });
}

export async function isolatedTimelineRender(job, { signal, onProgress = () => {}, onLog = () => {}, forkImpl = fork,
  cleanupTimeoutMs = 30000, terminateImpl = terminateOwnedWorker } = {}) {
  signal?.throwIfAborted();
  const launchedAt = Date.now();
  const child = forkImpl(workerFile, ['--worker'], { execPath: process.execPath,
    // This worker imports only .mjs/CJS. A TypeScript loader creates extra
    // loader/compiler workers for no benefit during native rendering.
    execArgv: ['--max-old-space-size=256'], windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let result, failure, cleanupTimer, cleanupPromise, exited = false, rejectExit;
  const scheduleCleanup = () => {
    cleanupTimer ??= setTimeout(() => {
      failure = `${failure ? failure + '\n' : ''}Render worker cleanup did not finish`;
      cleanupPromise = Promise.resolve().then(() => terminateImpl(child, launchedAt));
      cleanupPromise.catch((error) => rejectExit(new Error(`Render worker cleanup failed: ${error}`, { cause: error })));
    }, cleanupTimeoutMs);
  };
  const send = (message) => {
    try { child.send(message, (error) => {
      if (error && !exited) { failure ??= `Worker IPC failed: ${error.message}`; scheduleCleanup(); }
    }); } catch (error) { failure ??= `Worker IPC failed: ${error}`; scheduleCleanup(); }
  };
  const abort = () => {
    if (child.connected) send({ abort: true });
    scheduleCleanup();
  };
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (data) => onLog(String(data)));
  child.stderr.on('data', (data) => onLog(String(data)));
  child.on('message', (message) => {
    if (typeof message.progress === 'number') onProgress(message.progress);
    if (message.result || message.error) {
      result = message.result;
      failure ??= message.error;
      // Natural exit waits for the compositor's cleanup. If it hangs, report
      // failure rather than starting another heavy worker on top of it.
      scheduleCleanup();
    }
  });
  try {
    const exit = new Promise((resolve, reject) => {
      rejectExit = reject;
      child.once('error', (error) => {
        if (!child.pid) reject(error);
        else { failure ??= `Worker failed: ${error.message}`; abort(); }
      });
      child.once('exit', (code, exitSignal) => { exited = true; clearTimeout(cleanupTimer); resolve({ code, exitSignal }); });
    });
    send({ job });
    if (signal?.aborted) abort();
    const { code, exitSignal } = await exit;
    await cleanupPromise;
    signal?.throwIfAborted();
    if (code !== 0 || !result || failure) throw new Error(failure ?? `Render worker failed: ${code}/${exitSignal}`);
    return result;
  } finally { clearTimeout(cleanupTimer); signal?.removeEventListener('abort', abort); }
}

// An imported lifecycle helper must not install another worker's IPC handler.
// The production acceptance worker also uses --worker but owns a different job.
export function isIsolatedRenderWorker(argv = process.argv) {
  if (!argv.includes('--worker') || !argv[1]) return false;
  const invoked = resolve(argv[1]);
  return process.platform === 'win32'
    ? invoked.toLowerCase() === workerFile.toLowerCase()
    : invoked === workerFile;
}

if (isIsolatedRenderWorker()) {
  const controller = new AbortController();
  let started = false;
  process.on('disconnect', () => controller.abort(new Error('Render worker parent disconnected')));
  const reply = (message) => new Promise((resolve, reject) => {
    if (!process.connected) { reject(new Error('Render worker IPC disconnected')); return; }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
  process.on('message', async (message) => {
    if (message.abort) { controller.abort(new Error('Isolated render cancelled')); return; }
    if (!message.job || started) return;
    started = true;
    try {
      const { bundle, media, browser, options } = message.job;
      process.env.CC_REMOTION_BUNDLE = bundle;
      process.env.CC_BROWSER_EXECUTABLE = browser;
      process.env.OPENCHATCUT_RENDER_CONCURRENCY = '1';
      process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING = '1';
      const renderer = await import('../remotion/render.mjs');
      renderer.setUploadsDirProvider(() => media);
      const result = await renderer.renderTimeline({ ...options, signal: controller.signal,
        onProgress: (progress) => { void reply({ progress }).catch(() => controller.abort(new Error('Progress IPC failed'))); } });
      await reply({ result });
    } catch (error) { process.exitCode = 1; await reply({ error: error instanceof Error ? error.stack : String(error) }).catch(() => {}); }
    finally { if (process.connected) process.disconnect(); }
  });
}
