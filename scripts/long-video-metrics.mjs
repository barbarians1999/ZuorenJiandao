// Small deterministic helpers shared by the benchmark browser and Node runner.
export function seekSchedule(durationFrames, fps) {
  let seed = 0x5eeda11;
  const frames = [1, fps * 10 - 1, fps * 10, fps * 10 + 1,
    Math.floor(durationFrames / 2), durationFrames - 2];
  for (let index = 0; index < 24; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    frames.push(1 + seed % (durationFrames - 2));
  }
  for (let index = -5; index <= 5; index++) frames.push(fps * 20 + index);
  return frames;
}

export function latencySummary(results) {
  const successful = results.filter((result) => result.status === 'presented').map((result) => result.elapsedMs).sort((a, b) => a - b);
  const percentile = (fraction) => successful.length ? successful[Math.ceil(successful.length * fraction) - 1] : null;
  return { requests: results.length, correctlyPresented: successful.length,
    exactFrameMatches: results.filter((result) => result.status === 'presented' && result.exactSourceFrames === true).length,
    exactFrameMatchScope: 'only samples instrumented with exactSourceFrames; earlier retained samples have no exact-frame claim',
    failed: results.length - successful.length, medianMs: percentile(0.5), p95Ms: percentile(0.95),
    population: 'presented within declared frame tolerance; timeouts and exact-frame matches reported separately' };
}

export function pulseStarts(samples, threshold, sampleRate) {
  const starts = [];
  let previous = false;
  for (let index = 0; index < samples.length; index++) {
    const active = samples[index] >= threshold;
    if (active && !previous && (!starts.length || index / sampleRate - starts.at(-1) > 0.4)) starts.push(index / sampleRate);
    previous = active;
  }
  return starts;
}

// cross-dissolve.frag blends sRGB bytes with smoothstep easing (amount=1).
export function dissolveBarcode(outgoingFrame, incomingFrame, progress) {
  const p = progress * progress * (3 - 2 * progress);
  return Array.from({ length: 16 }, (_, bit) =>
    ((outgoingFrame >> bit) & 1) * (1 - p) + ((incomingFrame >> bit) & 1) * p);
}

export function barcodeMatches(actual, expected, tolerance = 0.07) {
  return actual.length === 16 && expected.length === 16
    && actual.every((value, bit) => Math.abs(value - expected[bit]) <= tolerance);
}

export function matchDissolveFrames(actual, outgoingFrame, incomingFrame, progress) {
  // HTML5 transition texture seeks may present the adjacent decoded frame.
  // Report that deviation, never silently call it pixel-exact presentation.
  for (const outgoingDelta of [0, -1, 1]) for (const incomingDelta of [0, -1, 1]) {
    if (barcodeMatches(actual, dissolveBarcode(outgoingFrame + outgoingDelta, incomingFrame + incomingDelta, progress))) {
      return { outgoingDelta, incomingDelta, exact: outgoingDelta === 0 && incomingDelta === 0 };
    }
  }
  return null;
}
