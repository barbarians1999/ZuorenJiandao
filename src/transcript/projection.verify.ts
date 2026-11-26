import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { projectMediaWindowWords } from './edit';
import type { TranscriptWord } from './types';
import { wordSegmentLookup } from './wordSegments';

// Segment-level lookup handles ordered and reordered/touching/zero-width intervals cleanly.
for (const ranges of [[[0, 2], [2, 4]], [[0, 0], [0, 3]], [[5, 9], [0, 4]], [[0, 5], [2, 8]]]) {
  const segments = ranges.map(([start, end], index) => ({ srcStartFrame: start, srcEndFrame: end, fromFrame: index * 10, durFrames: end - start }));
  const lookup = wordSegmentLookup(segments);
  for (let start = -1; start < 10; start++) for (let end = start; end < 11; end++) {
    const expected = segments.find((s) => start >= s.srcStartFrame && start < s.srcEndFrame)
      ?? segments.find((s) => start <= s.srcEndFrame && end >= s.srcStartFrame);
    assert.equal(lookup(start, end), expected);
  }
}

const large: TranscriptWord[] = Array.from({ length: 9000 }, (_, index) => ({ text: `word-${index}`, start: index * 350, end: index * 350 + 200 }));
const clipWindow = { startFrame: 0, durationInFrames: 9000 * 15, srcInFrame: 0 };
const start = performance.now();
const projected = projectMediaWindowWords(large, 30, clipWindow);
const elapsedMs = performance.now() - start;
assert.equal(projected.words.length, 9000);
console.log(`projection.verify: segment lookup edge cases + 9000 words projected in ${elapsedMs.toFixed(2)}ms`);
