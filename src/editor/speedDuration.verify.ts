// Runnable check: `npx tsx src/editor/speedDuration.verify.ts`.
import assert from 'node:assert/strict';
import { reduce } from './reduce';
import {
  MAX_SPEED_RATE,
  MIN_SPEED_RATE,
  canAdjustItemSpeed,
  planBatchFillToNextTrackClip,
  planFillToNextTrackClip,
  planSpeedForTargetSeconds,
  speedDurationBounds,
} from './speedDuration';
import type { TimelineItem, TimelineState } from './types';

const clip = (
  id: string,
  startFrame: number,
  durationInFrames = 60,
  track = 'V1',
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames,
  kind: 'video',
  name: id,
  src: '/m/a.mp4',
  ...extra,
} as TimelineItem);

const stateOf = (items: TimelineItem[], extra: Partial<TimelineState> = {}): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  trackOrder: ['V2', 'V1', 'A1'],
  items,
  ...extra,
});

// ── 1. Target duration planning & round-trip through reduce(setSpeed) ──
{
  const fastItem = clip('a', 0, 120); // 4s @ 30fps, 1x -> 2s => 2x
  const fastPlan = planSpeedForTargetSeconds(fastItem, 2, 30);
  assert.ok(fastPlan);
  assert.equal(fastPlan.rate, 2);
  assert.equal(fastPlan.resultingFrames, 60);
  assert.equal(fastPlan.clamped, null);
  const fastState = reduce(stateOf([fastItem]), { type: 'setSpeed', id: 'a', rate: fastPlan.rate });
  const fastAfter = fastState.items.find((it) => it.id === 'a')!;
  assert.equal(fastAfter.durationInFrames, 60);
  assert.equal(fastAfter.playbackRate, 2);

  // Slow down from 2s (60f @ 1x) to 5s (150f => 0.4x)
  const slowItem = clip('b', 0, 60);
  const slowPlan = planSpeedForTargetSeconds(slowItem, 5, 30);
  assert.ok(slowPlan);
  assert.equal(slowPlan.rate, 0.4);
  assert.equal(slowPlan.resultingFrames, 150);
  assert.equal(slowPlan.clamped, null);
  const slowState = reduce(stateOf([slowItem]), { type: 'setSpeed', id: 'b', rate: slowPlan.rate });
  assert.equal(slowState.items[0]!.durationInFrames, 150);

  // Already-retimed clip: 60f @ 2x = 120 source frames; target 4s (120f) => 1x
  const retimed = clip('c', 0, 60, 'V1', { playbackRate: 2 });
  const retimedPlan = planSpeedForTargetSeconds(retimed, 4, 30);
  assert.ok(retimedPlan);
  assert.equal(retimedPlan.rate, 1);
  assert.equal(retimedPlan.resultingFrames, 120);
  const retimedAfter = reduce(stateOf([retimed]), { type: 'setSpeed', id: 'c', rate: retimedPlan.rate }).items[0]!;
  assert.equal(retimedAfter.durationInFrames, 120);
  assert.equal(retimedAfter.playbackRate, 1);
}

// ── 2. Clamping at MIN_SPEED_RATE (0.1x) and MAX_SPEED_RATE (8x) & bounds ──
{
  const item = clip('a', 0, 60); // 2s @ 30fps -> bounds [0.25s..20s] (8f..600f)
  const bounds = speedDurationBounds(item, 30);
  assert.ok(bounds);
  assert.equal(bounds.minFrames, 8);
  assert.equal(bounds.maxFrames, 600);
  assert.equal(bounds.currentSeconds, 2);

  const tooSlow = planSpeedForTargetSeconds(item, 100, 30);
  assert.ok(tooSlow);
  assert.equal(tooSlow.rate, MIN_SPEED_RATE);
  assert.equal(tooSlow.clamped, 'min-rate');
  assert.equal(tooSlow.resultingFrames, 600);

  const tooFast = planSpeedForTargetSeconds(item, 0.05, 30);
  assert.ok(tooFast);
  assert.equal(tooFast.rate, MAX_SPEED_RATE);
  assert.equal(tooFast.clamped, 'max-rate');
  assert.equal(tooFast.resultingFrames, 8);
}

// ── 3. Fill to next track clip: exact fill & multi-track isolation ──
{
  const a = clip('a', 0, 60, 'V1');
  const v2 = clip('v2', 70, 30, 'V2'); // different track must be ignored
  const b = clip('b', 120, 60, 'V1'); // gap is 60f (60..120), target duration 120f => 0.5x
  const before = stateOf([a, v2, b]);
  const plan = planFillToNextTrackClip(before, 'a');
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.nextClip.id, 'b');
    assert.equal(plan.gapFrames, 60);
    assert.equal(plan.targetFrames, 120);
    assert.equal(plan.resultingFrames, 120);
    assert.equal(plan.rate, 0.5);
    assert.equal(plan.remainingGapFrames, 0);
    const after = reduce(before, { type: 'setSpeed', id: 'a', rate: plan.rate });
    const afterA = after.items.find((it) => it.id === 'a')!;
    const afterB = after.items.find((it) => it.id === 'b')!;
    const afterV2 = after.items.find((it) => it.id === 'v2')!;
    assert.equal(afterA.startFrame + afterA.durationInFrames, afterB.startFrame);
    assert.equal(afterB.startFrame, 120, 'next clip stays in place when filling exact gap');
    assert.equal(afterV2.startFrame, 70, 'other track stays untouched');
  }
}

// ── 4. Fill to next track clip: gap exceeding 0.1x limit clamps safely ──
{
  const a = clip('a', 0, 60, 'V1');
  const b = clip('b', 1000, 60, 'V1');
  const before = stateOf([a, b]);
  const plan = planFillToNextTrackClip(before, 'a');
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.rate, MIN_SPEED_RATE);
    assert.equal(plan.resultingFrames, 600);
    assert.equal(plan.remainingGapFrames, 400);
    assert.equal(plan.clamped, 'min-rate');
    const after = reduce(before, { type: 'setSpeed', id: 'a', rate: plan.rate });
    const afterA = after.items.find((it) => it.id === 'a')!;
    const afterB = after.items.find((it) => it.id === 'b')!;
    assert.equal(afterA.durationInFrames, 600);
    assert.ok(afterA.startFrame + afterA.durationInFrames < afterB.startFrame);
    assert.equal(afterB.startFrame, 1000);
  }
}

// ── 5. Fill to next track clip: ineligible cases ──
{
  const atMinRate = clip('min', 0, 600, 'V1', { playbackRate: MIN_SPEED_RATE });
  const minPlan = planFillToNextTrackClip(stateOf([atMinRate, clip('b', 700, 30, 'V1')]), 'min');
  assert.deepEqual(minPlan.ok ? null : minPlan.reason, 'min-rate-reached');

  const adjacent = planFillToNextTrackClip(stateOf([clip('a', 0, 60, 'V1'), clip('b', 60, 60, 'V1')]), 'a');
  assert.deepEqual(adjacent.ok ? null : adjacent.reason, 'already-adjacent');

  const lastClip = planFillToNextTrackClip(stateOf([clip('a', 0, 60, 'V1')]), 'a');
  assert.deepEqual(lastClip.ok ? null : lastClip.reason, 'no-next-clip');

  const locked = planFillToNextTrackClip(
    stateOf([clip('a', 0, 60, 'V1'), clip('b', 120, 60, 'V1')], {
      tracks: { V1: { kind: 'video', locked: true } },
    }),
    'a',
  );
  assert.deepEqual(locked.ok ? null : locked.reason, 'locked');

  const wordAudio = clip('aud', 0, 60, 'A1', {
    kind: 'audio',
    transcript: [{ text: 'hi', start: 0, end: 1000 }],
  });
  assert.equal(canAdjustItemSpeed(wordAudio), false);
  const wordPlan = planFillToNextTrackClip(stateOf([wordAudio, clip('aud2', 120, 60, 'A1', { kind: 'audio' })]), 'aud');
  assert.deepEqual(wordPlan.ok ? null : wordPlan.reason, 'unsupported');
}

// ── 6. Slowing down past a gap pushes only collided followers (never silently rejected) ──
{
  const a = clip('a', 0, 60, 'V1');
  const b = clip('b', 90, 30, 'V1'); // 30f gap before b
  const c = clip('c', 120, 30, 'V1'); // contiguous with b
  const far = clip('far', 300, 30, 'V1'); // separated by big gap
  const before = stateOf([a, b, c, far]);
  // Target 5s (150f => 0.4x): a expands 0..150, pushes b to 150..180 and c to 180..210; far stays at 300.
  const targetPlan = planSpeedForTargetSeconds(a, 5, 30)!;
  const after = reduce(before, { type: 'setSpeed', id: 'a', rate: targetPlan.rate });
  const byId = Object.fromEntries(after.items.map((it) => [it.id, it]));
  assert.equal(byId.a!.durationInFrames, 150);
  assert.equal(byId.b!.startFrame, 150);
  assert.equal(byId.c!.startFrame, 180);
  assert.equal(byId.far!.startFrame, 300, 'far clip after later gap stays unmoved');
}

// ── 7. Batch fill across multiple clips on the same track ──
{
  const c1 = clip('c1', 0, 60, 'V1');
  const c2 = clip('c2', 120, 60, 'V1');
  const c3 = clip('c3', 240, 60, 'V1');
  const before = stateOf([c1, c2, c3]);
  const batch = planBatchFillToNextTrackClip(before, ['c1', 'c2', 'c3']);
  assert.equal(batch.eligible.length, 2);
  let cur = before;
  for (const entry of batch.eligible) {
    cur = reduce(cur, { type: 'setSpeed', id: entry.item.id, rate: entry.rate });
  }
  const byId = Object.fromEntries(cur.items.map((it) => [it.id, it]));
  assert.equal(byId.c1!.durationInFrames, 120);
  assert.equal(byId.c2!.startFrame, 120);
  assert.equal(byId.c2!.durationInFrames, 120);
  assert.equal(byId.c3!.startFrame, 240);
}

console.log('speedDuration.verify: ok (目标秒数变速/边界钳位/填充至后一单元/跨空隙碰撞推开/批量填充)');
