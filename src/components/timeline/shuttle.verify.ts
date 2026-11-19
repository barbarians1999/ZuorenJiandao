import assert from 'node:assert/strict';
import { shuttleTick } from './shuttle';

assert.deepEqual(shuttleTick(-1), { stepFrames: -2, intervalMs: 80 });
assert.deepEqual(shuttleTick(1), { stepFrames: 2, intervalMs: 80 });
assert.deepEqual(shuttleTick(2), { stepFrames: 4, intervalMs: 80 });
assert.deepEqual(shuttleTick(4), { stepFrames: 8, intervalMs: 80 });
assert.deepEqual(shuttleTick(0), { stepFrames: 0, intervalMs: 80 });
console.log('shuttle.verify: passed');
