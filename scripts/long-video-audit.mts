import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { pulseStarts, matchDissolveFrames } from './long-video-metrics.mjs';
import { compositionPlan } from '../src/editor/compositionPlan';
import type { TimelineState } from '../src/editor/types';
import { benchmarkCommand } from './long-video-command.mjs';

const binary = async (args: string[], signal?: AbortSignal, maxBuffer = 8 * 1024 * 1024) => {
  return await benchmarkCommand(ffmpeg!, args, { encoding: 'buffer', maxBuffer, signal }) as Buffer;
};
type RenderStills = (args: { state: TimelineState; frames: number[]; fullResolution?: boolean; signal?: AbortSignal }) => Promise<Array<{ frame: number; base64: string }>>;

async function auditCaptionPictures(file: string, state: TimelineState, renderStills: RenderStills,
  probe: (file: string, signal?: AbortSignal) => Promise<{ streams: Array<{ width: number; height: number }> }>, signal?: AbortSignal) {
  const frames = [15, 84, 105, 375, 21270];
  const reference = await renderStills({ state, frames, fullResolution: true, signal });
  const without = await renderStills({ state: { ...state, captions: { ...state.captions!, enabled: false } }, frames, fullResolution: true, signal });
  const root = `${file}.caption-refs`;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  const roi = 'crop=1920:270:0:810,format=rgb24';
  const results = [];
  for (const [index, frame] of frames.entries()) {
    const paths = [join(root, `${frame}-caption.jpg`), join(root, `${frame}-source.jpg`)];
    await writeFile(paths[0], Buffer.from(reference[index].base64, 'base64'));
    await writeFile(paths[1], Buffer.from(without[index].base64, 'base64'));
    for (const referencePath of paths) {
      const picture = (await probe(referencePath, signal)).streams[0];
      assert.equal(picture?.width, 1920, 'Caption reference must contain native composition pixels');
      assert.equal(picture?.height, 1080, 'Caption reference must not be an enlarged thumbnail');
    }
    const withPixels = await binary(['-v', 'error', '-i', paths[0], '-vf', roi, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], signal);
    const withoutPixels = await binary(['-v', 'error', '-i', paths[1], '-vf', roi, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], signal);
    const actual = await binary(['-v', 'error', '-i', file, '-vf', `select='eq(n,${frame})',${roi}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], signal);
    assert.equal(actual.length, withPixels.length);
    let count = 0, withError = 0, withoutError = 0;
    for (let offset = 0; offset < actual.length; offset++) {
      if (Math.abs(withPixels[offset] - withoutPixels[offset]) < 32) continue;
      count++;
      withError += Math.abs(actual[offset] - withPixels[offset]);
      withoutError += Math.abs(actual[offset] - withoutPixels[offset]);
    }
    const expectedCaption = frame !== 84;
    if (expectedCaption) {
      assert(count > 100, `caption reference visible at frame ${frame}`);
      assert(withError / count < withoutError / count * 0.65,
        `caption picture at frame ${frame} must match caption-on reference, not caption-off`);
    } else {
      assert(count < 100, `caption gap reference at frame ${frame}`);
      let error = 0;
      for (let offset = 0; offset < actual.length; offset++) error += Math.abs(actual[offset] - withoutPixels[offset]);
      assert(error / actual.length < 12, `caption gap picture must match source at frame ${frame}`);
    }
    results.push({ frame, expectedCaption, comparedChannels: count,
      captionReferenceError: count ? withError / count : null,
      captionOffReferenceError: count ? withoutError / count : null });
  }
  return { samples: results, scope: 'five synthetic caption-on/gap ROI comparisons against decoded composition references; not exhaustive typography QA' };
}

export async function auditExport(file: string, probe: (file: string, signal?: AbortSignal) => Promise<{ streams: Array<{
  codec_type: string; width: number; height: number; duration: string }>; format: { size: string; duration: string } }>,
  command: (file: string, args: string[], signal?: AbortSignal) => Promise<string>, state?: TimelineState, renderStills?: RenderStills, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const info = await probe(file, signal);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  const audio = info.streams.find((stream) => stream.codec_type === 'audio');
  assert(video && audio, 'picture and sound required');
  assert.equal(video.width, 1920); assert.equal(video.height, 1080);
  assert(Math.abs(Number(video.duration) - 720) <= 0.1, 'full 12-minute video required');
  assert(Math.abs(Number(audio.duration) - Number(video.duration)) <= 0.1, 'stream durations agree');
  await command(ffmpeg!, ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], signal);
  const pictures = await binary(['-v', 'error', '-i', file, '-an', '-vf', 'crop=16:16:8:8,scale=1:1,format=gray',
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], signal);
  const pcm = await binary(['-v', 'error', '-i', file, '-vn', '-af', 'bandpass=f=1000:width_type=h:w=200,aeval=abs(val(0))',
    '-ac', '1', '-ar', '1000', '-f', 'f32le', 'pipe:1'], signal);
  const energy = Array.from({ length: pcm.length / 4 }, (_, index) => Math.abs(pcm.readFloatLE(index * 4)));
  const videoPulses = pulseStarts([...pictures], 190, 30) as number[];
  const audioPulses = pulseStarts(energy, 0.025, 1000) as number[];
  const samples = [5, 125, 365, 605, 715].map((second) => {
    const v = videoPulses.find((time) => Math.abs(time - second) < 0.2);
    const a = audioPulses.find((time) => Math.abs(time - second) < 0.2);
    assert(v !== undefined && a !== undefined, `sync marker present at ${second}s`);
    const offsetMs = (a - v) * 1000;
    assert(Math.abs(offsetMs) <= 2 * 1000 / 30, `sync marker within two frames at ${second}s: ${offsetMs}ms`);
    return { second, videoPulse: v, audioPulse: a, offsetMs };
  });
  const keySeconds = [5, 125, 365, 605, 715];
  const rows = await binary(['-v', 'error', '-i', file, '-an', '-vf',
    `select='${keySeconds.map((second) => `eq(n,${second * 30})`).join('+')}',crop=304:2:0:148,scale=304:1,format=gray`,
    '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], signal);
  assert.equal(rows.length, keySeconds.length * 304, 'all requested key pictures decoded');
  const keyPictures = keySeconds.map((second, index) => {
    const row = rows.subarray(index * 304, (index + 1) * 304);
    assert(row[280] > 200 && row[264] < 40, `frame barcode guards at ${second}s`);
    let actualSourceFrame = 0;
    for (let bit = 0; bit < 16; bit++) if (row[bit * 16 + 8] > 128) actualSourceFrame |= 1 << bit;
    const expectedSourceFrame = ((Math.floor(second / 10) * 137) % 700 + second % 10) * 30;
    const frameDelta = actualSourceFrame - expectedSourceFrame;
    assert(Math.abs(frameDelta) <= 1, `key picture source-frame mismatch at ${second}s: ${frameDelta}`);
    return { second, actualSourceFrame, expectedSourceFrame, frameDelta, exact: frameDelta === 0 };
  });
  const transitionPictures = [];
  if (state?.transitions?.length) {
    const windows = compositionPlan(state).glWindows.filter((window) => window.type === 'cross-dissolve');
    const selected = [windows[0], windows[Math.floor(windows.length / 2)], windows.at(-1)].filter(Boolean);
    const samples = selected.flatMap((window) => [0, Math.floor(window!.L / 2), window!.L - 1]
      .map((local) => ({ window: window!, local, frame: window!.from + local })));
    const rows = await binary(['-v', 'error', '-i', file, '-an', '-vf',
      `select='${samples.map(({ frame }) => `eq(n,${frame})`).join('+')}',crop=304:2:0:148,scale=304:1,format=gray`,
      '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], signal);
    assert.equal(rows.length, samples.length * 304, 'all transition boundary pictures decoded');
    for (const [index, sample] of samples.entries()) {
      const row = rows.subarray(index * 304, (index + 1) * 304);
      const black = row[264], range = row[280] - black;
      assert(range > 160, `transition barcode guards at frame ${sample.frame}`);
      const bits = Array.from({ length: 16 }, (_, bit) => (row[bit * 16 + 8] - black) / range);
      const outgoing = compositionPlan(state).sourceFrameFor(sample.window.outgoing.id, sample.frame)!;
      const incoming = compositionPlan(state).sourceFrameFor(sample.window.incoming.id, sample.frame)!;
      const match = matchDissolveFrames(bits, outgoing, incoming, sample.local / Math.max(1, sample.window.L - 1));
      assert(match, `transition frame ${sample.frame} must match planned source frames and blend`);
      transitionPictures.push({ frame: sample.frame, transition: sample.window.key, outgoing, incoming, ...match });
    }
  }
  let captionPictures = null;
  if (state?.captions?.enabled) {
    assert(renderStills, 'captioned export requires visual reference validation');
    captionPictures = await auditCaptionPictures(file, state, renderStills, probe, signal);
  }
  return { outputBytes: Number(info.format.size), videoSeconds: Number(video.duration), audioSeconds: Number(audio.duration),
    decodeErrors: 0, keyPictures, keyPictureToleranceFrames: 1,
    transitionPictures, captionPictures,
    syncSamples: samples, syncScope: 'synthetic marker samples, not perceptual listening QA' };
}

export async function auditSharedVisual(root: string, source: string,
  renderStills: (args: { state: TimelineState; frames: number[] }) => Promise<Array<{ frame: number; base64: string }>>) {
  const state: TimelineState = { fps: 30, width: 320, height: 180, fit: 'contain', selectedId: null,
    tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'], items: [
      { id: 'a', kind: 'video', name: 'a', src: source, track: 'V1', startFrame: 60, durationInFrames: 60,
        srcInFrame: 0, fadeInFrames: 10, fadeOutFrames: 15, width: 1920, height: 1080 },
      { id: 'b', kind: 'video', name: 'b', src: source, track: 'V1', startFrame: 120, durationInFrames: 60,
        srcInFrame: 60, width: 1920, height: 1080,
        mask: { type: 'ellipse', x: 0.05, y: 0.05, width: 0.9, height: 0.9, feather: 0.02 },
        zoom: { magnification: 1.2, focalPointX: 0.5, focalPointY: 0.5 } },
    ] };
  const frames = [60, 65, 115, 120, 130, 179];
  const shared = await renderStills({ state, frames });
  const independent = await renderStills({ state: { ...state,
    items: state.items.map((item) => ({ ...item, transform: {} })) }, frames });
  // Animated masks intentionally stay on independent layers; check their local
  // keyframe sampling against an equivalent static appearance at the same frame.
  const animated: TimelineState = { ...state, items: [state.items[0], { ...state.items[1],
    keyframes: { maskFeather: [{ frame: 0, value: 0.02 }, { frame: 20, value: 0.12 }] } }] };
  const sampled: TimelineState = { ...state, items: [state.items[0], { ...state.items[1],
    mask: { ...state.items[1].mask!, feather: 0.07 } }] };
  shared.push((await renderStills({ state: animated, frames: [130] }))[0]);
  independent.push((await renderStills({ state: sampled, frames: [130] }))[0]);
  frames.push(130);
  const results = [];
  for (let index = 0; index < frames.length; index++) {
    const images = [shared[index], independent[index]];
    const pixels: Buffer[] = [];
    for (const [variant, image] of images.entries()) {
      const path = join(root, `shared-visual-${index}-${frames[index]}-${variant}.jpg`);
      await writeFile(path, Buffer.from(image.base64, 'base64'));
      pixels.push(await binary(['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']));
    }
    if (frames[index] !== 60) for (const pixelBuffer of pixels) {
      let colored = 0;
      for (let byte = 0; byte < pixelBuffer.length; byte += 3) {
        if (Math.max(pixelBuffer[byte], pixelBuffer[byte + 1], pixelBuffer[byte + 2])
          - Math.min(pixelBuffer[byte], pixelBuffer[byte + 1], pixelBuffer[byte + 2]) > 8) colored++;
      }
      assert(colored > pixelBuffer.length / 3 * 0.05,
        `frame ${frames[index]} must contain the colored fixture, not two matching blank/checkerboard pictures`);
    }
    assert.equal(pixels[0].length, pixels[1].length);
    let difference = 0;
    for (let byte = 0; byte < pixels[0].length; byte++) difference += Math.abs(pixels[0][byte] - pixels[1][byte]);
    const meanAbsoluteError = difference / pixels[0].length;
    assert(meanAbsoluteError <= 3, `shared/independent frame ${frames[index]} mismatch: ${meanAbsoluteError}`);
    results.push({ frame: frames[index], scenario: index === 6 ? 'mask-keyframe-local-time' : 'shared-vs-independent', meanAbsoluteError });
  }
  return results;
}
