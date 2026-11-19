import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { uploadDir } from '../server/media-dir';
import { ffmpegBin } from '../server/media-binaries';
import { renderExportPlan, renderTimelineStills } from '../server/plugins/export-rendering';
import { planExport } from '../server/plugins/export-plan';
import { DEFAULT_MOSAIC, setMosaicRegion } from '../src/editor/mosaic';
import type { TimelineItem, TimelineState } from '../src/editor/types';

/** Shipped GL program and binaries must work without any checkout assets. */
export async function runMaskBlurSmoke(): Promise<void> {
  assert(process.env.CC_SMOKE === '1' && process.env.OPENCHATCUT_DATA_DIR);
  const directory = uploadDir(); await mkdir(directory, { recursive: true });
  const width = 640, height = 360, pixels = width * height * 3;
  const source = Buffer.alloc(pixels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3;
    const value = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 ? 225 : 25;
    source[at] = value; source[at + 1] = y < 180 ? value / 2 : value; source[at + 2] = y < 180 ? value : value / 2;
  }
  const run = promisify(execFile);
  const options = { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 ** 2 };
  const raw = join(directory, 'packaged-blur.rgb'), image = join(directory, 'packaged-blur.png');
  await writeFile(raw, source);
  await run(ffmpegBin(), ['-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '640x360',
    '-i', raw, '-frames:v', '1', image], options);
  const item: TimelineItem = { id: 'blur', name: 'Packaged Gaussian', kind: 'image', track: 'V1', width, height,
    src: '/media/uploads/packaged-blur.png', startFrame: 0, durationInFrames: 90 };
  const state = (entry: TimelineItem): TimelineState => ({ fps: 30, width, height, selectedId: null,
    items: [entry], tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'] });
  const rgb = async (file: string, frame = 0): Promise<Buffer> => (await run(ffmpegBin(), ['-v', 'error', '-i', file, '-an',
    '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { ...options, encoding: 'buffer' })).stdout;
  const still = async (label: string, entry: TimelineItem) => {
    const frames = await renderTimelineStills({ state: state(entry), frames: [45], fullResolution: true, signal: AbortSignal.timeout(45000) });
    assert.equal(frames.length, 1);
    const file = join(directory, `${label}.jpg`); await writeFile(file, Buffer.from(frames[0]!.base64, 'base64')); return rgb(file);
  };
  const baseline = await still('packaged-blur-baseline', item);
  const localItem = { ...item, effects: setMosaicRegion([], { ...DEFAULT_MOSAIC, centerY: .25, width: .5, height: .4 }, 'gaussian') };
  const local = await still('packaged-blur-local', localItem);
  const variation = (bytes: Buffer, x1: number, y1: number, x2: number, y2: number) => {
    let sum = 0, count = 0;
    for (let y = y1; y < y2; y++) for (let x = x1 + 1; x < x2; x++) {
      const at = (y * width + x) * 3; sum += Math.abs(bytes[at] - bytes[at - 3]); count++;
    }
    return sum / count;
  };
  const inside = variation(local, 240, 55, 400, 125), insideOriginal = variation(baseline, 240, 55, 400, 125);
  const outside = variation(local, 220, 235, 420, 305), outsideOriginal = variation(baseline, 220, 235, 420, 305);
  assert(inside < insideOriginal * .15, 'Packaged Gaussian must smooth actual source frequencies');
  assert(Math.abs(outside - outsideOriginal) < .1, 'Packaged Gaussian must not move/repaint outside region');
  const masked: TimelineItem = { ...localItem, mask: { type: 'ellipse', x: .1, y: .1, width: .8, height: .8, feather: .025 },
    keyframes: { maskX: [{ frame: 0, value: .05 }, { frame: 89, value: .15 }] } };
  const reference = await still('packaged-blur-mask', masked);
  const output = join(directory, 'packaged-mask-blur.mp4');
  const encoder = await renderExportPlan(planExport({ state: state(masked), format: 'video', codec: 'h264', fps: 30 }),
    output, async () => {}, AbortSignal.timeout(90000));
  const decoded = (await run(ffmpegBin(), ['-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-an', '-f', 'framehash', 'pipe:1'], options)).stdout;
  assert.equal(decoded.split('\n').filter((line) => /^\s*\d+\s*,/.test(line)).length, 90);
  const actual = await rgb(output, 45); assert.equal(actual.length, reference.length);
  let error = 0; for (let i = 0; i < actual.length; i++) error += (actual[i]! - reference[i]!) ** 2;
  const mse = error / actual.length; assert(mse < 200);
  await writeFile(join(directory, 'packaged-mask-blur-results.json'), JSON.stringify({ status: 'passed', inside, insideOriginal,
    outside, outsideOriginal, mse, encoder, frames: 90, resolution: '640x360', scope: 'Packaged GL, region/mask/feather/keyframe and short complete video decode; not long performance or installation.' }, null, 2));
  console.log('[smoke] packaged mask/gaussian export ok');
}
