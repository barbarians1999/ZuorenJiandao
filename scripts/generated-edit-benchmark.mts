// Synthetic repeatable workload; never substitutes for real-footage acceptance.
// Usage: tsx scripts/generated-edit-benchmark.mts [--prepare-only]
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile, readFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
import type { TimelineState } from '../src/editor/types';
import { readVerificationReport, writeVerificationReport } from './verification-report.mjs';
import { benchmarkCommand } from './long-video-command.mjs';
import { archiveBenchmarkAttempt } from './benchmark-result-identity.mjs';
import { testArtifactRoot, ensureManagedTestRoot, assertArtifactSpace, generatedMediaReady, recordGeneratedMedia } from './test-artifacts.mjs';

let managedRootForFailure: string | undefined;

async function main() {
const preparationStarted = performance.now();
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const managedRoot = ensureManagedTestRoot(testArtifactRoot());
managedRootForFailure = managedRoot;
const root = resolve(outputArg?.slice('--output='.length) ?? join(managedRoot, `benchmark-${version}`));
// Explicit legacy resume keeps its old paths; new runs share one content-checked fixture pair.
const legacyMedia = join(root, 'media');
const media = existsSync(join(legacyMedia, 'generated-long-gop-frame-id-12min.mp4'))
  ? legacyMedia : join(managedRoot, 'fixtures', 'frame-id-12min-v1');
const recipe = 'frame-id-1080p30-720s-sync-pulse/v1'; // Bump when the generated picture/audio recipe changes.
const names = ['generated-long-gop-frame-id-12min.mp4', 'generated-music.wav'];
const cachedMediaReady = media !== legacyMedia && generatedMediaReady(media, recipe, names);
assertArtifactSpace(root, 256 * 1024 ** 2);
assertArtifactSpace(managedRoot, existsSync(join(media, names[0]!)) ? 0 : 2 * 1024 ** 3);
const source = join(media, 'generated-long-gop-frame-id-12min.mp4');
const reportPath = join(root, 'results.json');
const fps = 30;
const seconds = 720;
const exportSeconds = seconds;
assert(ffmpeg, 'FFmpeg is installed');
await mkdir(media, { recursive: true });

const command = (executable: string, args: string[], signal?: AbortSignal): Promise<string> =>
  benchmarkCommand(executable, args, { signal });

async function probe(file: string, signal?: AbortSignal) {
  return JSON.parse(await command(ffprobe.path, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], signal));
}

const sourceExists = (await readdir(media)).includes('generated-long-gop-frame-id-12min.mp4');
if (!sourceExists) {
  console.log('[benchmark] generating full 12-minute moving source, unique frame numbers, one-second sync pulses');
  const font = process.platform === 'win32' ? 'C:/Windows/Fonts/consola.ttf'
    : process.platform === 'darwin' ? '/System/Library/Fonts/Menlo.ttc' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  assert(existsSync(font), `Frame-number fixture requires font: ${font}`);
  const escapedFont = font.replace(':', '\\:');
  const barcode = ['drawbox=x=0:y=140:w=304:h=16:color=black:t=fill',
    ...Array.from({ length: 16 }, (_, bit) => `drawbox=x=${bit * 16}:y=140:w=16:h=16:color=white:t=fill:enable='mod(floor(n/${2 ** bit}),2)'`),
    'drawbox=x=272:y=140:w=16:h=16:color=white:t=fill'].join(',');
  const fixtureFilter = `drawbox=x=0:y=0:w=128:h=128:color=black:t=fill,drawbox=x=0:y=0:w=128:h=128:color=white:t=fill:enable='lt(mod(t,1),0.04)',drawtext=fontfile='${escapedFont}':text='FRAME %{n}':x=150:y=20:fontsize=48:fontcolor=white:box=1:boxcolor=black,${barcode}`;
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,1)\\,0.04)\\,0.65*sin(2*PI*1000*t)\\,0):s=48000',
    '-vf', fixtureFilter, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-threads', '4',
    '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', source]);
}
if (!(await readdir(media)).includes('generated-music.wav')) {
  await command(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi',
    '-i', 'sine=frequency=220:sample_rate=48000', '-t', String(seconds), join(media, 'generated-music.wav')]);
}
const sourceInfo = await probe(source);
const video = sourceInfo.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
assert.equal(video.width, 1920);
assert.equal(video.height, 1080);
assert(Math.abs(Number(sourceInfo.format.duration) - seconds) < 0.1);
if (media !== legacyMedia && !cachedMediaReady) recordGeneratedMedia(media, recipe, names);
const base: TimelineState = {
  fps, width: 1920, height: 1080, selectedId: null, fit: 'contain',
  trackOrder: ['C1', 'V2', 'V1', 'A1'],
  tracks: { C1: { kind: 'caption' }, V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items: Array.from({ length: seconds / 10 }, (_, index) => ({
    id: `cut-${index}`, name: `Generated cut ${index + 1}`, track: 'V1', kind: 'video' as const,
    startFrame: index * 10 * fps, durationInFrames: 10 * fps,
    src: '/media/uploads/generated-long-gop-frame-id-12min.mp4', srcInFrame: ((index * 137) % 700) * fps,
    sourceDurationFrames: seconds * fps, width: 1920, height: 1080, volume: 0.7,
  })),
};
const layered: TimelineState = {
  ...base,
  items: [...base.items,
    ...Array.from({ length: seconds / 30 }, (_, index) => ({
      id: `pip-${index}`, name: `Masked overlay ${index + 1}`, track: 'V2', kind: 'video' as const,
      startFrame: index * 30 * fps + 2 * fps, durationInFrames: 6 * fps,
      src: '/media/uploads/generated-long-gop-frame-id-12min.mp4', srcInFrame: ((index * 83 + 450) % 700) * fps,
      width: 1920, height: 1080, volume: 0,
      transform: { scale: 0.4, x: 25, y: -20 },
      mask: { type: 'ellipse' as const, x: 0.05, y: 0.05, width: 0.9, height: 0.9, feather: 0.02 },
      keyframes: { maskFeather: [{ frame: 0, value: 0.02 }, { frame: 6 * fps - 1, value: 0.04 }] },
      fadeInFrames: 8, fadeOutFrames: 8,
    })),
    { id: 'music', name: 'Generated music', track: 'A1', kind: 'audio', startFrame: 0,
      durationInFrames: seconds * fps, src: '/media/uploads/generated-music.wav', volume: 0.15,
      fadeInFrames: fps, fadeOutFrames: fps },
  ],
  transitions: Array.from({ length: base.items.length - 1 }, (_, index) => ({
    id: `transition-${index}`, trackId: 'V1', type: 'cross-dissolve' as const,
    outgoingItemId: `cut-${index}`, incomingItemId: `cut-${index + 1}`, durationInFrames: 15,
  })),
  captions: { enabled: true, template: 'bold-outline', pacing: 'phrase', motionPreset: 'fade-up',
    words: Array.from({ length: seconds / 3 }, (_, index) => ({
      text: `Synthetic caption ${index + 1}`, start: index * 3000, end: index * 3000 + 2500,
    })),
  },
};
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(), attemptHistory: [],
  version, source: { type: 'full synthetic moving pattern, unique frame number and one-second audiovisual pulse',
    durationSeconds: seconds, width: video.width, height: video.height, fps, gopFrames: 300, bytes: Number(sourceInfo.format.size) },
  machine: { cpu: cpus()[0]?.model, logicalCores: cpus().length, ramBytes: totalmem(),
    os: platform(), osRelease: release(), arch: arch(), node: process.version,
    gpu: process.platform === 'win32' ? JSON.parse(await command('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress']).catch(() => 'null')) : null },
  scope: { timelineSeconds: seconds, simpleClips: base.items.length, layeredClips: layered.items.length,
    exportedSeconds: exportSeconds, notMeasured: ['real camera footage', 'installed application interaction'] },
  preparation: { elapsedMs: performance.now() - preparationStarted, generatedVideo: !sourceExists },
  exports: [], previews: [], failures: [], status: 'prepared',
};
let previousReport: Record<string, unknown> | undefined;
if (process.argv.includes('--resume') && existsSync(reportPath)) {
  previousReport = await readVerificationReport(reportPath);
  report.attemptHistory = archiveBenchmarkAttempt(previousReport);
  // Do not carry active results forward here: the runner has not identified
  // the real media copies, renderer/runtime or effective configuration yet.
  report.resumedAt = new Date().toISOString();
  report.resumeScope = 'all prior evidence archived; active reuse deferred until source/project/material/configuration and export artifacts are validated';
}
await writeFile(join(root, 'timeline-simple.json'), JSON.stringify(base, null, 2));
await writeFile(join(root, 'timeline-layered.json'), JSON.stringify(layered, null, 2));
await writeVerificationReport(reportPath, report);
console.log(`[benchmark] prepared ${seconds}s source and two project timelines at ${root}`);
if (!process.argv.includes('--prepare-only')) {
  const { runLongVideoBenchmark } = await import('./long-video-runner.mts');
  try {
    await runLongVideoBenchmark({ root, media, states: { simple: base, layered }, report, previousReport, ffmpegPath: ffmpeg!, ffprobePath: ffprobe.path, command, probe,
      persist: () => writeVerificationReport(reportPath, report) });
  } catch (error) {
    (report.failures as unknown[]).push({ stage: 'benchmark-harness', reason: error instanceof Error ? error.message : String(error) });
    report.status = 'failed';
    await writeVerificationReport(reportPath, report);
    process.exitCode = 1;
  }
}
console.log(`[benchmark] results: ${reportPath}`);
}

await main().catch(async (error: unknown) => {
  const version = JSON.parse(await readFile('package.json', 'utf8').catch(() => '{"version":"unknown"}')).version;
  const output = process.argv.find((arg) => arg.startsWith('--output='));
  const directory = !managedRootForFailure ? undefined : output ? resolve(output.slice('--output='.length))
    : resolve(managedRootForFailure, `benchmark-${version}`);
  const previous = directory ? await readVerificationReport(join(directory, 'results.json')).catch(() => ({})) : {};
  const failure = { ...previous, status: 'failed', version, completedAt: new Date().toISOString(),
    machine: previous.machine ?? { cpu: cpus()[0]?.model, logicalCores: cpus().length, ramBytes: totalmem(), os: platform(), node: process.version },
    configuration: { ...previous.configuration, durationSeconds: 720, width: 1920, height: 1080, fps: 30 },
    failures: [...(Array.isArray(previous.failures) ? previous.failures : []),
      { stage: 'script-fatal-or-preparation', reason: error instanceof Error ? error.message : String(error) }] };
  if (directory) await mkdir(directory, { recursive: true }).then(() => writeVerificationReport(join(directory, 'results.json'), failure)).catch(() => {});
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
});
