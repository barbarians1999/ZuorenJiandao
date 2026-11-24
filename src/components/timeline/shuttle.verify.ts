import assert from 'node:assert/strict';
import { nextFastForwardRate, nextShuttleRate, shuttleTick } from './shuttle';

assert.deepEqual(shuttleTick(-1), { stepFrames: -2, intervalMs: 80 });
assert.deepEqual(shuttleTick(1), { stepFrames: 2, intervalMs: 80 });
assert.deepEqual(shuttleTick(2), { stepFrames: 4, intervalMs: 80 });
assert.deepEqual(shuttleTick(4), { stepFrames: 8, intervalMs: 80 });
assert.deepEqual(shuttleTick(8), { stepFrames: 16, intervalMs: 80 });
assert.deepEqual(shuttleTick(-8), { stepFrames: -16, intervalMs: 80 });
assert.deepEqual(shuttleTick(0), { stepFrames: 0, intervalMs: 80 });

// L cycle: stopped -> 1x -> 2x -> 4x -> 8x -> 1x
assert.equal(nextShuttleRate(0, 1, false), 1);
assert.equal(nextShuttleRate(0, 1, true), 2);
assert.equal(nextShuttleRate(1, 1), 2);
assert.equal(nextShuttleRate(2, 1), 4);
assert.equal(nextShuttleRate(4, 1), 8);
assert.equal(nextShuttleRate(8, 1), 1);

// J cycle: stopped -> -1x -> -2x -> -4x -> -8x -> -1x
assert.equal(nextShuttleRate(0, -1), -1);
assert.equal(nextShuttleRate(-1, -1), -2);
assert.equal(nextShuttleRate(-2, -1), -4);
assert.equal(nextShuttleRate(-4, -1), -8);
assert.equal(nextShuttleRate(-8, -1), -1);

// Interrupting forward/reverse with K (pause) or opposite direction resets to 1x/-1x
for (const rate of [1, 2, 4, 8]) {
  assert.equal(nextShuttleRate(rate, 0), 0);
  assert.equal(nextShuttleRate(rate, -1), -1);
}
for (const rate of [-1, -2, -4, -8]) {
  assert.equal(nextShuttleRate(rate, 0), 0);
  assert.equal(nextShuttleRate(rate, 1), 1);
}

// Fast-forward button cycles 2x -> 4x -> 8x -> 1x -> 2x
assert.equal(nextFastForwardRate(0), 2);
assert.equal(nextFastForwardRate(1), 2);
assert.equal(nextFastForwardRate(2), 4);
assert.equal(nextFastForwardRate(4), 8);
assert.equal(nextFastForwardRate(8), 1);

console.log('shuttle.verify: passed');
