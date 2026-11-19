import { spawn } from 'node:child_process';

// FFmpeg/ffprobe own no shell. Abort only this subprocess, then await close
// before releasing the resource guard or starting the next serial operation.
export function benchmarkCommand(executable, args, { signal, spawnImpl = spawn, encoding = 'utf8', maxBuffer = 8 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { windowsHide: true });
    let stderr = '', failure, bytes = 0;
    const chunks = [];
    const abort = () => { child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBuffer) { failure = new Error(`${executable} exceeded stdout limit`); child.kill(); }
      else chunks.push(buffer);
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) { const output = Buffer.concat(chunks); resolve(encoding === 'buffer' ? output : output.toString(encoding)); }
      else reject(new Error(`${executable} exited ${code}: ${stderr}`));
    });
    if (signal?.aborted) abort();
  });
}
