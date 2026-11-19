import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnMediaProcess } from '../media-process.ts';
import { ffmpegBin } from '../media-binaries.ts';
import { buildFilmstrip, filmstripSpec, probe } from './media-preview-transforms.ts';

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-3000); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg fixture failed (${code}): ${stderr}`)));
  });
}

const landscape = filmstripSpec({ durationMs: 720_000, width: 1920, height: 1080, hasAudio: true });
assert.equal(landscape.cellHeight, 96, 'filmstrip frames are generated at enough vertical resolution for timeline display');
assert.equal(landscape.frameCount, 32, 'long media keeps the bounded frame sample count');
assert.ok(landscape.cellWidth > 80, 'landscape cells retain their source aspect at the higher resolution');
assert.ok(landscape.cellWidth * landscape.frameCount <= 6144, 'the sprite stays within its bounded cache width');

const portrait = filmstripSpec({ durationMs: 20_000, width: 1080, height: 1920, hasAudio: false });
assert.equal(portrait.frameCount, 12, 'short portrait media keeps enough samples');
assert.ok(portrait.cellWidth < portrait.cellHeight, 'portrait frames remain portrait instead of being stretched wide');
assert.ok(portrait.cellWidth * portrait.frameCount <= 6144, 'portrait sprites stay within the same width budget');

const extremeAspect = filmstripSpec({ durationMs: 3_600_000, width: 7680, height: 720, hasAudio: false });
assert.ok(extremeAspect.frameCount >= 1, 'extreme aspect ratios still produce a usable strip');
assert.ok(extremeAspect.cellWidth * extremeAspect.frameCount <= 6144, 'extreme aspect ratio cannot exceed the strip width budget');

const work = await mkdtemp(join(tmpdir(), 'cc-filmstrip-verify-'));
try {
  const source = join(work, 'moving-pattern.mp4');
  const strip = join(work, 'filmstrip.jpg');
  await runFfmpeg([
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-an', '-threads', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1',
    '-pix_fmt', 'yuv420p', source,
  ]);
  const controller = new AbortController();
  const sourceProbe = await probe(source, controller.signal);
  const generatedSpec = filmstripSpec(sourceProbe);
  await buildFilmstrip(source, sourceProbe, strip, controller.signal, generatedSpec);
  const stripProbe = await probe(strip, controller.signal);
  assert.equal(stripProbe.height, generatedSpec.cellHeight, 'real FFmpeg output uses the expected high-resolution strip height');
  assert.equal(stripProbe.width, generatedSpec.cellWidth * generatedSpec.frameCount, 'real FFmpeg output matches its sprite geometry');
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('Filmstrip transform checks passed.');
