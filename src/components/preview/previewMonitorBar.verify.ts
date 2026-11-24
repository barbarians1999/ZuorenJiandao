import assert from 'node:assert/strict';
import {
  formatPreviewTimecode,
  frameFromTrackRatio,
  percentOfTimelineFrame,
  resolvePreviewZoneSpan,
} from './exportStillFrame';

assert.equal(formatPreviewTimecode(0, 30), '00:00:00:00');
assert.equal(formatPreviewTimecode(-10, 30), '00:00:00:00');
assert.equal(formatPreviewTimecode(45, 30), '00:00:01:15');
assert.equal(formatPreviewTimecode(3665 * 30 + 7, 30), '01:01:05:07');

assert.equal(frameFromTrackRatio(-0.2, 600), 0);
assert.equal(frameFromTrackRatio(0.5, 600), 300);
assert.equal(frameFromTrackRatio(1.4, 600), 600);
assert.equal(frameFromTrackRatio(0.5, 0), 0);

assert.equal(percentOfTimelineFrame(0, 300), 0);
assert.equal(percentOfTimelineFrame(150, 300), 50);
assert.equal(percentOfTimelineFrame(500, 300), 100);
assert.equal(percentOfTimelineFrame(10, 0), 0);

assert.equal(resolvePreviewZoneSpan(null, 100, 300), null);
assert.equal(resolvePreviewZoneSpan(100, 100, 300), null);
assert.equal(resolvePreviewZoneSpan(150, 90, 300), null);
assert.deepEqual(resolvePreviewZoneSpan(60, 180, 300), { leftPct: 20, widthPct: 40 });

console.log('previewMonitorBar.verify: timecode, scrub mapping, and zone span math passed');
