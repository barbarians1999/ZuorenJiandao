import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_ERROR_OUTPUT = 32_768;

function ffmpegPath(binariesDirectory) {
  return path.join(binariesDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export function remuxHardwareOutputToAac({ input, audio, output, binariesDirectory, signal,
  samples, sampleRate = 48000, audioBitrate = '320k' }) {
  const args = [
    '-hide_banner', '-y', '-i', input,
    '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', audioBitrate,
    '-ar', String(sampleRate),
    '-af', `apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB`,
    '-movflags', '+faststart', output,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(binariesDirectory), args, { stdio: ['ignore', 'ignore', 'pipe'], signal, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_ERROR_OUTPUT); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hardware encoder finalization failed (${code ?? 'unknown'}): ${stderr}`));
    });
  });
}

/** Keep the chosen video encoder; mux the sample-aligned PCM mix once as AAC.
 * Compressed intermediate audio can lose priming metadata in the video mux.
 * Explicit audio sidecars and muted exports retain Remotion's existing API. */
export async function renderDirectHardware({ render, options, binariesDirectory, signal }) {
  const output = options.outputLocation;
  if (!output || options.muted || options.separateAudioTo) return render(options);
  const frames = options.frameRange
    ? options.frameRange[1] - options.frameRange[0] + 1 : options.composition?.durationInFrames;
  const sampleRate = options.sampleRate ?? 48000;
  const samples = Math.round(frames / options.composition?.fps * sampleRate);
  if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error('PCM audio mux requires a valid composition/frame range');
  const intermediate = `${output}.direct-hardware.mp4`;
  const audio = `${output}.direct-hardware.wav`;
  try {
    const result = await render({
      ...options,
      outputLocation: intermediate,
      binariesDirectory,
      audioCodec: 'pcm-16',
      separateAudioTo: audio,
      enforceAudioTrack: true,
    });
    await remuxHardwareOutputToAac({ input: intermediate, audio, output, binariesDirectory, signal,
      samples, sampleRate, audioBitrate: options.audioBitrate ?? '320k' });
    return result;
  } finally {
    await rm(intermediate, { force: true }).catch(() => {});
    await rm(audio, { force: true }).catch(() => {});
  }
}
