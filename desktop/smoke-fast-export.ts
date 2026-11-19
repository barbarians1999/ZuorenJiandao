import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { uploadDir } from '../server/media-dir.ts';
import { ffmpegBin, ffprobeBin } from '../server/media-binaries.ts';
import { planExport } from '../server/plugins/export-plan.ts';
import { renderExportPlan } from '../server/plugins/export-rendering.ts';
import type { TimelineState } from '../src/editor/types.ts';

/** Exercise the shipped renderer/binaries, never the checkout's Node runtime. */
export async function runFastExportSmoke(origin: string): Promise<void> {
  assert(process.env.CC_SMOKE === '1' && process.env.OPENCHATCUT_DATA_DIR, 'Only isolated smoke profiles');
  const directory = uploadDir();
  await mkdir(directory, { recursive: true });
  const run = promisify(execFile);
  const options = { windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 ** 2 };
  const source = join(directory, 'packaged-fast-source.mp4');
  await run(ffmpegBin(), ['-v', 'error', '-nostdin', '-y', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-threads:v', '2', '-preset', 'ultrafast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_range', 'tv',
    '-color_trc', 'bt709', '-color_primaries', 'bt709', '-c:a', 'aac', '-ac', '2', source], options);
  const base: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } }, trackOrder: ['V2', 'V1'],
    items: [{ id: 'v', name: 'Packaged video', kind: 'video', track: 'V1',
      src: '/media/uploads/packaged-fast-source.mp4', startFrame: 0, srcInFrame: 7,
      durationInFrames: 90, width: 1920, height: 1080, volume: 0.7 }] };
  const results = [];
  for (const route of ['direct-cut', 'hybrid']) {
    const state = structuredClone(base);
    if (route === 'hybrid') state.items.push({ id: 't', name: 'Chapter', kind: 'text', track: 'V2',
      startFrame: 30, durationInFrames: 15, width: 1920, height: 1080,
      props: { text: 'CHAPTER ONE', fontSize: 80, entrance: 'wipe', entranceFrames: 5 } });
    const body = { state, format: 'video' as const, codec: 'h264' as const, resolution: '1080p' as const, fps: 30 };
    const response = await fetch(`${origin}/export/capabilities`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    const capability = await response.json() as { directCut?: { renderRoute?: string } };
    assert.equal(capability.directCut?.renderRoute, route, 'Shipped UI preflight selects fast route');
    const output = join(directory, `packaged-${route}.mp4`), start = performance.now();
    const result = await renderExportPlan(planExport(body), output, async () => {}, AbortSignal.timeout(90000));
    const elapsedMs = performance.now() - start;
    assert.equal(result?.encoder.renderRoute, route);
    const metadata = JSON.parse((await run(ffprobeBin(), ['-v', 'error', '-show_streams', '-of', 'json', output], options)).stdout);
    const video = metadata.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    assert.equal(Number(video.nb_frames), 90); assert(Math.abs(Number(video.duration) - 3) < 0.001);
    const decoded = (await run(ffmpegBin(), ['-v', 'error', '-threads', '2', '-xerror', '-i', output,
      '-map', '0:v:0', '-f', 'framehash', 'pipe:1'], options)).stdout;
    assert.equal(decoded.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 90);
    await run(ffmpegBin(), ['-v', 'error', '-xerror', '-i', output, '-map', '0:a:0', '-f', 'null', '-'], options);
    results.push({ route, elapsedMs, encoder: result?.encoder, frames: 90, completeDecode: true });
    console.log(`[smoke] packaged ${route} export ok, ${result?.encoder.id}, ${Math.round(elapsedMs)}ms`);
  }
  await writeFile(join(directory, 'packaged-fast-export-results.json'), JSON.stringify(results, null, 2));
}
