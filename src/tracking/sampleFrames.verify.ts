import assert from 'node:assert/strict';
import { sampleFrames } from './analyzeMotion';

for (const duration of [1, 2, 59, 60, 299, 300, 450, 720, 21600, 36000]) {
  const frames = sampleFrames(duration);
  assert.equal(frames[0], 0);
  assert.equal(frames.at(-1), duration - 1);
  assert(frames.length <= 150, `${duration} frames must respect the complete 150-point storage budget`);
  assert(frames.every((frame, index) => Number.isInteger(frame) && frame >= 0 && frame < duration
    && (index === 0 || frame > frames[index - 1]!)), 'Samples must be finite, ordered source positions');
}
assert.deepEqual(sampleFrames(6), [0, 2, 4, 5]);
console.log('sampleFrames.verify: bounded sampling retains both endpoints without a 151st point');
