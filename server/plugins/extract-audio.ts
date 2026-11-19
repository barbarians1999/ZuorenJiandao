// POST /api/extract-audio — pull a low-bitrate audio track from a local
// /media/uploads video (or large audio) for ASR. Avoids fetching a multi-GB
// master into the browser just to re-upload it to AssemblyAI.
//
// Extracts a compact 64k Opus track before processing the main media bytes.
// Runs on demand at transcription time; caches `<stem>.asr.ogg` (or .mp3).
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';
import { randomUUID } from 'node:crypto';

const MAX_JSON = 8 * 1024;
const ASR_BITRATE = '64k';
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
const FFPROBE_TIMEOUT_MS = 10_000;
type MediaSpawner = typeof spawnMediaProcess;

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Client disconnected', 'AbortError');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max = MAX_JSON): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** `/media/uploads/foo.mp4` → `foo.mp4` or null if unsafe. */
function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}

function asrStem(sourceName: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, '') || sourceName;
  return stem.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]+/g, '_').slice(0, 80) || 'media';
}

function probeHasAudio(inputPath: string, signal: AbortSignal, spawn: MediaSpawner): Promise<boolean> {
  // Probe failures are not evidence that the source is silent. Keep the
  // existing extraction path as the fallback so a missing/broken ffprobe or a
  // slow network-mounted file cannot silently skip a valid transcription.
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    const finish = (hasAudio: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new DOMException('Client disconnected', 'AbortError'));
      else resolve(hasAudio);
    };
    const probe = spawn(ffprobeBin(), [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', inputPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const abort = () => { probe.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    probe.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
      if (stdout.length > 4096) stdout = stdout.slice(-2048);
    });
    const timer = setTimeout(() => {
      probe.kill('SIGKILL');
    }, FFPROBE_TIMEOUT_MS);
    probe.once('error', () => finish(true));
    probe.once('close', (code) => {
      if (code !== 0) {
        finish(true);
        return;
      }
      finish(stdout.split(/\r?\n/).some((line) => line.trim() === 'audio'));
    });
  });
}

function runFfmpeg(args: string[], timeoutMs: number, signal: AbortSignal, spawn: MediaSpawner): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new DOMException('Client disconnected', 'AbortError'));
      else if (timedOut) reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
      else if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      finish(err);
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Concurrent requests encode into private files. Only final cache publication
// is serialized. Keep both valid formats: a consumer may still be fetching a
// previously returned URL when another request successfully publishes fallback.
const cacheCommits = new Map<string, Promise<void>>();
async function publishCache(partPath: string, finalPath: string, signal: AbortSignal): Promise<void> {
  const key = finalPath.replace(/\.(ogg|mp3)$/i, '');
  const previous = cacheCommits.get(key) ?? Promise.resolve();
  const commit = previous.catch(() => {}).then(async () => {
    throwIfCancelled(signal);
    await rename(partPath, finalPath);
  });
  cacheCommits.set(key, commit);
  try { await commit; } finally { if (cacheCommits.get(key) === commit) cacheCommits.delete(key); }
}

async function tryEncode(
  inputPath: string,
  finalPath: string,
  codecArgs: string[],
  signal: AbortSignal,
  spawn: MediaSpawner,
): Promise<number> {
  // Keep a real media extension on the temp file — ffmpeg picks muxer from
  // suffix (`*.ogg.tmp` / `*.ogg.part` would be treated as unknown).
  const partPath = finalPath.replace(/(\.(ogg|mp3))$/i, `.${randomUUID()}.tmp$1`);
  try {
    await runFfmpeg(
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputPath,
        '-vn',
        '-map', '0:a:0?',
        ...codecArgs,
        partPath,
      ],
      FFMPEG_TIMEOUT_MS,
      signal,
      spawn,
    );
    throwIfCancelled(signal);
    const bytes = (await stat(partPath)).size;
    if (bytes <= 0) throw new Error('extracted audio is empty (source may have no audio track)');
    await publishCache(partPath, finalPath, signal);
    return bytes;
  } finally {
    // The process has closed before cleanup: never remove a shared final cache
    // or another request's legacy .part/.tmp file.
    await unlink(partPath).catch(() => {});
  }
}

/** Returns absolute path of written ASR audio. */
async function extractAsrAudio(inputPath: string, dir: string, stem: string, signal: AbortSignal, spawn: MediaSpawner): Promise<{ file: string; bytes: number }> {
  const oggPath = join(dir, `${stem}.asr.ogg`);
  try {
    const bytes = await tryEncode(inputPath, oggPath, [
      '-c:a', 'libopus', '-b:a', ASR_BITRATE, '-ac', '1', '-ar', '16000',
    ], signal, spawn);
    return { file: oggPath, bytes };
  } catch (opusErr) {
    throwIfCancelled(signal);
    const mp3Path = join(dir, `${stem}.asr.mp3`);
    try {
      const bytes = await tryEncode(inputPath, mp3Path, [
        '-c:a', 'libmp3lame', '-b:a', ASR_BITRATE, '-ac', '1', '-ar', '16000',
      ], signal, spawn);
      return { file: mp3Path, bytes };
    } catch {
      throwIfCancelled(signal);
      throw opusErr;
    }
  }
}

export function extractAudioPlugin(options: { spawnMediaProcess?: MediaSpawner } = {}): Plugin {
  const spawn = options.spawnMediaProcess ?? spawnMediaProcess;
  return {
    name: 'openchatcut-extract-audio',
    configureServer(server) {
      server.middlewares.use('/api/extract-audio', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        const controller = new AbortController();
        const abort = () => { if (!res.writableFinished) controller.abort(); };
        req.once('aborted', abort);
        res.once('close', abort);
        if (req.aborted) abort();
        const signal = controller.signal;
        try {
          throwIfCancelled(signal);
          const body = (await readJson(req)) as { src?: string; force?: boolean };
          throwIfCancelled(signal);
          const src = String(body.src ?? '').trim();
          const name = uploadNameFromSrc(src);
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const inputPath = resolveUploadFile(name);
          if (!inputPath) {
            sendJson(res, 404, { error: `media not found: ${name}` });
            return;
          }
          // Fast-fail sources without an audio track instead of letting ffmpeg
          // emit an opaque "output file does not contain any stream" error.
          const hasAudio = await probeHasAudio(inputPath, signal, spawn);
          if (!hasAudio) {
            sendJson(res, 422, { ok: false, noAudio: true, error: `source has no audio track: ${name}` });
            return;
          }

          const stem = asrStem(name);
          const dir = uploadDir();
          const force = body.force === true;
          if (!force) {
            const caches: { name: string; bytes: number; mtimeMs: number }[] = [];
            for (const candidate of [`${stem}.asr.ogg`, `${stem}.asr.mp3`]) {
              const full = join(dir, candidate);
              try {
                const info = await stat(full);
                if (info.isFile() && info.size > 0) {
                  caches.push({ name: candidate, bytes: info.size, mtimeMs: info.mtimeMs });
                }
              } catch { /* continue */ }
              throwIfCancelled(signal);
            }
            // A forced rebuild may switch codecs; reuse its newest successful
            // result without invalidating URLs issued to other consumers.
            const cached = caches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
            if (cached) {
              sendJson(res, 200, {
                ok: true,
                path: `/media/uploads/${cached.name}`,
                bytes: cached.bytes,
                cached: true,
                source: src,
              });
              return;
            }
          }

          const { file, bytes } = await extractAsrAudio(inputPath, dir, stem, signal, spawn);
          throwIfCancelled(signal);
          if (bytes <= 0) {
            sendJson(res, 422, { error: 'extracted audio is empty (source may have no audio track)' });
            return;
          }
          const outName = basename(file);
          server.config.logger.info(`[extract-audio] ${name} → ${outName} (${bytes} bytes)`);
          sendJson(res, 200, {
            ok: true,
            path: `/media/uploads/${outName}`,
            bytes,
            cached: false,
            source: src,
          });
        } catch (err) {
          if (signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[extract-audio] ${message}`);
          const status = /ENOENT|spawn ffmpeg/i.test(message) ? 503
            : /no audio|empty|exit/i.test(message) ? 422
              : 500;
          sendJson(res, status, { error: message });
        } finally {
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
        }
      });
    },
  };
}
