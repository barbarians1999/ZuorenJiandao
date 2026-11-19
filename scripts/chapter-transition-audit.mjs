import assert from 'node:assert/strict';

// Reject a CSS approximation that merely has plausible endpoints and a
// different middle frame. Solid-colour fixtures expose each shader's geometry.
export function auditChapterTransition(type, frame, outgoing, incoming, width, height, vertical = false) {
  const bytes = width * height * 3;
  for (const pixels of [frame, outgoing, incoming]) assert.equal(pixels.length, bytes);
  const at = (pixels, x, y) => pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3);
  const distance = (a, b) => a.reduce((sum, channel, i) => sum + (channel - b[i]) ** 2, 0) / 3;
  const matches = (x, y, reference) => distance(at(frame, x, y), at(reference, x, y)) < 100;
  let outgoingCount = 0, incomingCount = 0;
  // Stay away from codec/chroma boundaries while sampling the whole geometry.
  for (let y = 2; y < height - 2; y += 3) for (let x = 2; x < width - 2; x += 3) {
    outgoingCount += Number(matches(x, y, outgoing));
    incomingCount += Number(matches(x, y, incoming));
  }
  const count = Math.ceil((height - 4) / 3) * Math.ceil((width - 4) / 3);
  assert.ok(outgoingCount / count > .15 && incomingCount / count > .15,
    `${type}: must contain separate source regions, not a uniform dissolve`);
  const point = (position) => vertical
    ? [Math.floor(width / 2), Math.floor(height * position)]
    : [Math.floor(width * position), Math.floor(height / 2)];
  if (type === 'blinds-reveal') {
    for (let band = 0; band < 10; band++) {
      assert.ok(matches(...point((band + .12) / 10), outgoing), 'blinds: original at each band edge');
      assert.ok(matches(...point((band + .5) / 10), incoming), 'blinds: revealed at each band centre');
    }
  } else if (type === 'split-slide') {
    assert.ok(matches(...point(.1), outgoing) && matches(...point(.9), outgoing), 'split: both outer regions remain');
    assert.ok(matches(...point(.5), incoming), 'split: middle reveals the incoming source');
  } else assert.equal(type, 'mosaic-reveal');
  return { outgoingFraction: outgoingCount / count, incomingFraction: incomingCount / count, spatialPattern: 'passed' };
}
