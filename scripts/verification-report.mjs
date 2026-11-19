// Durable test evidence. Writes to the same report are serialized here; readers see a
// complete JSON snapshot, and a validated previous snapshot survives a crash.
import { open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const pendingWrites = new Map();

async function replace(file, text) {
  const pending = `${file}.next-${randomUUID()}`;
  const handle = await open(pending, 'wx');
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  // On failure retain the pending evidence and the existing destination.
  await rename(pending, file);
}

async function commitReport(file, text) {
  try {
    const previous = await readFile(file, 'utf8');
    JSON.parse(previous);
    await replace(`${file}.previous`, previous);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  await replace(file, text);
}

export async function writeVerificationReport(file, value) {
  // Capture at invocation, not when the queued write runs: mutable reports may
  // change during an earlier fsync. Every intermediate failure must survive.
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new Error('Report is not JSON serializable');
  const absolute = resolve(file);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => commitReport(absolute, text));
  pendingWrites.set(key, operation);
  const release = () => { if (pendingWrites.get(key) === operation) pendingWrites.delete(key); };
  // A failed write is returned to its caller, but cannot poison subsequent
  // writes. Keep its pending file as evidence and release only our own queue.
  void operation.then(release, release);
  return operation;
}

export async function readVerificationReport(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    // Do not modify the damaged report or claim the fallback is up-to-date.
    const previous = JSON.parse(await readFile(`${file}.previous`, 'utf8'));
    return { ...previous, recoveredPreviousSnapshot: true };
  }
}
