import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clipEdgeHandleLayout } from './timelineUtil';

for (const width of [2, 5, 9, 17]) {
  const layout = clipEdgeHandleLayout(width, 'selection', false, false);
  assert.ok(layout.trimWidth > 0, `${width}px clip exposes trim handles`);
  assert.ok(layout.leftOffset < 0 && layout.rightOffset < 0, 'narrow clip handles extend outside the edge');
  assert.ok(layout.trimWidth < width, 'middle remains available for move gestures');
}
for (const width of [2, 5, 9]) {
  const layout = clipEdgeHandleLayout(width, 'trim', false, false);
  assert.ok(layout.trimWidth > 0, `explicit trim mode exposes handles at ${width}px`);
  assert.ok(layout.trimWidth < width, 'explicit trim keeps a central move region');
}

const trackLaneSource = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
assert.match(trackLaneSource, /\{rollGrips\.map\(/, 'TrackLane renders roll grips at lane level outside clip isolation');
assert.match(trackLaneSource, /activeRollLeftId === left\.id/, 'active roll grip stays mounted during drag');
assert.ok(
  trackLaneSource.indexOf('renderedItems.map') < trackLaneSource.indexOf('rollGrips.map'),
  'roll grips paint above clip bodies so right clip never obscures the seam',
);

console.log('clipEdgeHandleLayout.verify: narrow edge handles remain reachable');
