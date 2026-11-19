import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname, delimiter, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Select only this spawned child's descendants. A reused root PID fails closed.
async function stopOwnedTree(child, launchedAt) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const lowerBound = launchedAt - 2000;
    const upperBound = launchedAt + 2000;
    const code = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); `
      + `$root=$all|Where-Object ProcessId -eq ${child.pid}; `
      + `if($root -and ($root.ParentProcessId -ne ${process.pid} -or ([DateTimeOffset]$root.CreationDate).ToUnixTimeMilliseconds() -lt ${lowerBound} -or ([DateTimeOffset]$root.CreationDate).ToUnixTimeMilliseconds() -gt ${upperBound}${child.exitCode !== null ? ' -or $true' : ''})){throw 'PID identity changed'}; `
      + `$ids=@(${child.pid}); do{$more=@($all|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() -ge ${lowerBound}}|ForEach-Object ProcessId); $ids+= $more}while($more.Count); `
      + `$targets=@($all|Where-Object {$_.ProcessId -in $ids}|Sort-Object CreationDate -Descending); `
      + `foreach($p in $targets){$live=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ProcessId); if($live -and $live.CreationDate -eq $p.CreationDate){Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop}}`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 ** 2,
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export async function runBoundedProcess({ args, cwd, timeoutMs, logPath, signal, onLaunch, env = {} }) {
  if (signal?.aborted) return { status: 'cancelled', reason: 'Cancelled before launch', elapsedMs: 0 };
  const launchedAt = Date.now(), started = performance.now();
  const log = createWriteStream(logPath);
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, ...env, PATH: [dirname(process.execPath), resolve(cwd, 'node_modules/.bin'), process.env.PATH ?? ''].join(delimiter) } });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  onLaunch?.(child.pid);
  let launchError, stopReason, cleanupError, stopped;
  const stop = reason => {
    if (stopped) return stopped;
    stopReason = reason;
    stopped = stopOwnedTree(child, launchedAt).catch(error => { cleanupError = error.message; })
      .then(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); });
    return stopped;
  };
  const cancel = () => { void stop('cancelled'); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { void stop('timed-out'); }, timeoutMs);
  const closed = new Promise(done => {
    child.once('error', error => { launchError = error.message; });
    child.once('close', (code, signal) => done({ exitCode: code, signal }));
  });
  let poll;
  const stoppedEvent = new Promise(done => {
    poll = setInterval(() => { if (stopped) stopped.then(() => done({ exitCode: child.exitCode, signal: child.signalCode })); }, 25);
  });
  const result = await Promise.race([closed, stoppedEvent]);
  clearTimeout(timer); clearInterval(poll); signal?.removeEventListener('abort', cancel);
  if (stopped) await stopped;
  await new Promise(done => log.end(done));
  return { ...result, pid: child.pid, launchedAt, timeoutMs, elapsedMs: performance.now() - started,
    status: stopReason ?? (result.exitCode === 0 && !launchError ? 'passed' : 'failed'),
    ...(launchError ? { reason: launchError } : {}), ...(cleanupError ? { cleanupError } : {}) };
}
