import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ffmpegStatic = require('ffmpeg-static') as string | null;
const ffprobeInstaller = require('@ffprobe-installer/ffprobe') as { path?: string };

const ASAR_SEGMENT = /[\\/]app\.asar[\\/]/;

/**
 * The on-disk twin of a path inside the packaged app archive.
 *
 * Electron's fs shim reads files inside app.asar transparently, but nothing can be
 * executed or dlopen'ed from there: spawn needs a real file. electron-builder keeps the
 * modules listed in asarUnpack as real files under app.asar.unpacked with the same
 * layout, so a resolved archive path is always rewritten to that twin. Callers can then
 * report a missing packaged binary at its real disk location. Dev builds and paths
 * outside the archive come back unchanged.
 */
export function unpackedPath(path: string): string {
  const match = ASAR_SEGMENT.exec(path);
  if (!match || match.index === undefined) return path;
  const segment = match[0].replace('app.asar', 'app.asar.unpacked');
  // Return the on-disk twin even when it is missing.  Callers use the same
  // resolved path for preflight and spawn, so a missing file is reported at
  // the location electron-builder promised to create rather than attempting
  // to execute a path inside the read-only archive.
  return `${path.slice(0, match.index)}${segment}${path.slice(match.index + match[0].length)}`;
}

/**
 * Prefer explicit overrides for developers who need a custom FFmpeg build.
 * Packaged desktop builds fall back to the platform binaries shipped through
 * production dependencies, so media import does not depend on the user's PATH.
 */
export function ffmpegBin(): string {
  return process.env.OPENCHATCUT_FFMPEG
    ?? process.env.FFMPEG_PATH
    ?? (ffmpegStatic ? unpackedPath(ffmpegStatic) : null)
    ?? 'ffmpeg';
}

export function ffprobeBin(): string {
  return process.env.OPENCHATCUT_FFPROBE
    ?? process.env.FFPROBE_PATH
    ?? (ffprobeInstaller.path ? unpackedPath(ffprobeInstaller.path) : null)
    ?? 'ffprobe';
}

/**
 * whisper.cpp CLI used by the desktop native-ASR worker (Metal/CPU). Dev and
 * packaged builds resolve from public/whisper-cli/<platform>/ (provisioned by
 * scripts/sync-whisper-cli.mjs and shipped through extraResources); an
 * explicit override wins for locally compiled binaries.
 */
export function whisperCliBin(): string {
  const override = process.env.OPENCHATCUT_WHISPER_CLI;
  if (override) return override;
  const platformKey = `${process.platform}-${process.arch}`;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const relative = join('whisper-cli', platformKey, `whisper-cli${suffix}`);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
  const candidates = [
    join(import.meta.dirname, '..', 'public', relative),
    join(resourcesPath, 'dist', relative),
    join(resourcesPath, relative),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return join(candidates[0]!);
}
