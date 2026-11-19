import assert from 'node:assert/strict';
import { auditChapterTransition } from './chapter-transition-audit.mjs';
import { validateChapterBundle } from './chapter-render-bundle.mjs';
import { chapterComparisonStills } from './chapter-render-frames.mjs';

const requestedFrames = Array.from({ length: 21 }, (_, frame) => frame);
const batches = [];
const stills = await chapterComparisonStills(async ({ frames }) => {
  batches.push(frames.length); return frames.map((frame) => ({ frame }));
}, { frames: requestedFrames });
assert.deepEqual(batches, [8, 8, 5]);
assert.deepEqual(stills.map(({ frame }) => frame), requestedFrames);
await assert.rejects(() => chapterComparisonStills(async ({ frames }) => frames.slice(0, 3).map((frame) => ({ frame })),
  { frames: requestedFrames }), /all comparison frames/);
const aborted = new AbortController(); aborted.abort(new Error('cancelled'));
await assert.rejects(() => chapterComparisonStills(async () => assert.fail('must not render after cancellation'),
  { frames: requestedFrames, signal: aborted.signal }), /cancelled/);

validateChapterBundle({ version: 1, sourceDigest: 'current' }, 'current');
assert.throws(() => validateChapterBundle({}, 'current'), /source provenance/);
assert.throws(() => validateChapterBundle({ version: 1, sourceDigest: 'old' }, 'current'), /sources changed/);

const width = 160, height = 100;
const source = (rgb) => Buffer.from(Array.from({ length: width * height }, () => rgb).flat());
const a = source([220, 40, 30]), b = source([20, 70, 210]);
const blend = source([120, 55, 120]);
for (const type of ['mosaic-reveal', 'blinds-reveal', 'split-slide']) {
  assert.throws(() => auditChapterTransition(type, blend, a, b, width, height), /uniform dissolve/);
  assert.throws(() => auditChapterTransition(type, a, a, b, width, height));
}
for (const vertical of [false, true]) for (const type of ['blinds-reveal', 'split-slide']) {
  const frame = Buffer.from(a);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const position = vertical ? (y + .5) / height : (x + .5) / width;
    const reveal = type === 'split-slide' ? position > .3 && position < .7 : Math.abs((position * 10 % 1) - .5) < .2;
    if (reveal) b.copy(frame, (y * width + x) * 3, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  assert.equal(auditChapterTransition(type, frame, a, b, width, height, vertical).spatialPattern, 'passed');
}
console.log('chapter-transition-audit: spatial patterns pass; plain dissolve and unchanged frames are rejected');
