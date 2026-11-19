import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderDirectHardware } from './direct-hardware.mjs';
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('@ffprobe-installer/ffprobe').path;
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'openchatcut-direct-hardware-'));
const binaries = join(root, 'binaries');
const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const input = join(root, 'hardware.mp4');
const audio = join(root, 'clock.wav');
const output = join(root, 'final.mp4');
try {
  await mkdir(binaries);
  await copyFile(ffmpeg, join(binaries, executable));
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=0.75',
    '-t', '0.75', '-c:v', 'libx264', '-an', '-y', input,
  ]);
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
    'aevalsrc=0.2*sin(2*PI*(400*t+60*t*t)):s=48000:d=0.5', '-c:a', 'pcm_s16le', '-y', audio]);
  let renderOptions;
  const result = await renderDirectHardware({
    render: async (options) => {
      renderOptions = options;
      await copyFile(input, options.outputLocation);
      await copyFile(audio, options.separateAudioTo);
      return 'rendered';
    },
    options: { outputLocation: output, composition: { durationInFrames: 18, fps: 24 } },
    binariesDirectory: binaries,
  });
  assert.equal(result, 'rendered');
  assert.equal(renderOptions.audioCodec, 'pcm-16');
  assert.equal(renderOptions.enforceAudioTrack, true);
  assert.equal(renderOptions.separateAudioTo, `${output}.direct-hardware.wav`);
  assert.equal(renderOptions.binariesDirectory, binaries);
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', output,
  ]);
  const streams = JSON.parse(stdout).streams;
  assert.ok(streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'));
  assert.ok(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  const pcm = async (file) => {
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-af', 'pan=mono|c0=c0',
      '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 500000 });
    return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength));
  };
  const actual = await pcm(output), source = await pcm(audio);
  assert(actual.length >= 36000 && actual.length < 37024, 'pad intentional silence to the exact video duration');
  let energy = 0, error = 0;
  for (let i = 1024; i < 36000 - 1024; i++) {
    const expected = source[i] ?? 0;
    energy += expected ** 2; error += (actual[i] - expected) ** 2;
  }
  assert(Math.sqrt(error / energy) < .06, 'single AAC mux preserves the exact PCM sample clock and gain');
  await assert.rejects(access(renderOptions.separateAudioTo), { code: 'ENOENT' });
  await assert.rejects(access(renderOptions.outputLocation), { code: 'ENOENT' });
  for (const bypass of [{ muted: true }, { separateAudioTo: join(root, 'explicit.wav') }, {}]) {
    const options = { ...bypass, ...(Object.keys(bypass).length ? { outputLocation: output } : {}) };
    assert.equal(await renderDirectHardware({ render: async (received) => { assert.equal(received, options); return 'delegated'; },
      options, binariesDirectory: binaries }), 'delegated', 'caller-owned audio and muted semantics are delegated unchanged');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('direct hardware AAC finalization verification passed');
