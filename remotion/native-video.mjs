import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
// Both short experiments regressed. Keep this decoder candidate diagnostic-only
// until a separately measured workload justifies enabling it in production.
export function nativeVideoExperimentEnabled(env = process.env) {
  return env.CC_EXPERIMENT_NATIVE_VIDEO === '1';
}
// H.264 with a known 8-bit opaque pixel layout cannot carry a hidden VP9 or
// HEVC alpha plane. Unknown/alpha/HDR codecs retain the existing browser path.
export function opaqueNativeVideo(stream) {
  return stream?.codec_name === 'h264'
    && /^(?:yuvj?(?:420|422|444)p|nv12|rgb24|gbrp)$/.test(stream.pix_fmt ?? '');
}

export function localVideoPath(source, uploadsDirectory, assetsDirectory) {
  if (typeof source !== 'string' || !source.startsWith('/') || source.startsWith('//')) return null;
  let decoded;
  try { decoded = decodeURIComponent(source); } catch { return null; }
  if (/[?#\x00\\]/.test(decoded)) return null;
  const upload = decoded.startsWith('/media/uploads/');
  const root = path.resolve(upload ? uploadsDirectory : assetsDirectory);
  const relative = upload ? decoded.slice('/media/uploads/'.length) : decoded.slice(1);
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

/** Render-only metadata, never written to timeline items or saved projects.
 * One bounded local probe per unique source, serial; cancellation never falls
 * through to a new browser job. Failed/unknown probes simply keep old decoding.
 */
export async function nativeOpaqueVideoSources(state, project, {
  uploadsDirectory, assetsDirectory, ffprobeExecutable, signal,
  probe = async (file) => {
    const { stdout } = await runFile(ffprobeExecutable, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'json', file], {
      windowsHide: true, signal, timeout: 5000, maxBuffer: 65536,
    });
    return JSON.parse(stdout).streams?.[0];
  },
} = {}) {
  const timelines = [state, ...(project?.timelines ?? [])];
  const sources = new Set(timelines.flatMap((timeline) => (timeline?.items ?? [])
    .filter((item) => item.kind === 'video' && item.src).map((item) => item.src)));
  const opaque = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    const file = localVideoPath(source, uploadsDirectory, assetsDirectory);
    if (!file) continue;
    try {
      if (opaqueNativeVideo(await probe(file))) opaque.push(source);
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code === 'ENOENT') continue;
      console.warn(`[render] native video metadata unavailable; retaining browser decoder: ${error.message}`);
    }
  }
  signal?.throwIfAborted();
  return opaque;
}
