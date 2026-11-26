import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const monitorBarSource = readFileSync(new URL('./PreviewMonitorBar.tsx', import.meta.url), 'utf8');
assert.match(
  monitorBarSource,
  /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/,
  'PreviewMonitorBar transport buttons must prevent mouse focus-capture so Space never double-toggles',
);
assert.match(
  monitorBarSource,
  /playerRef\.current\?\.pause\(\)[\s\S]*scrubAtClientX\(event\.clientX\)/,
  'PreviewMonitorBar scrub track must pause playback before seeking so Remotion Player cannot resume-fight',
);

const previewPanelSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(
  previewPanelSource,
  /moveToBeginningWhenEnded=\{false\}/,
  'PreviewPanel Player must stop on the final frame instead of jumping back to 0 when ended',
);

const shortcutsSource = readFileSync(new URL('../timeline/useTimelineShortcuts.ts', import.meta.url), 'utf8');
assert.match(
  shortcutsSource,
  /resolvePlayPausePlan\(/,
  'playPause must plan playback transitions deterministically before starting playback',
);
assert.match(
  shortcutsSource,
  /player\?\.play\(\)/,
  'playPause must start playback via explicit play() instead of Player.toggle()',
);
assert.doesNotMatch(
  shortcutsSource,
  /playerRef\.current\?\.toggle\(\)/,
  'playPause must not rely on Player.toggle()',
);
assert.match(
  shortcutsSource,
  /window\.setInterval\(syncPlayer,\s*150\)/,
  'useTimelineShortcuts must track remounted Player instances via watchdog',
);

console.log('previewMonitorBar.verify: timecode, scrub mapping, zone span, and playback guards passed');
