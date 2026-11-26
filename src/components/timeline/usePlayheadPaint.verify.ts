import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  audioMediaTimeToTimelineFrame,
  shouldPaintPlayheadTimecode,
  type AudibleAudioItem,
} from './usePlayheadPaint';

// Media time -> timeline frame mapping (marking-mode audio clock).
// The audible media element reports SOURCE seconds; the timeline frame of the
// audible content is item.startFrame + (mediaSeconds*fps - srcInFrame) / rate.

const base: AudibleAudioItem = { startFrame: 0, playbackRate: 1, srcInFrame: 0, src: '/media/uploads/x.mp3' };

// Plain rate-1, srcIn 0: frame == media seconds * fps (the marking workflow:
// 0.5x-processed export played back at 1.0). The caller rounds to whole
// frames, so assert through the same rounding.
assert.equal(audioMediaTimeToTimelineFrame(1.0, base, 30), 30);
assert.equal(Math.round(audioMediaTimeToTimelineFrame(11 / 30, base, 30)), 11);
assert.equal(audioMediaTimeToTimelineFrame(0, base, 30), 0);

// Item starting mid-timeline: the playhead offset shifts with the item start.
assert.equal(audioMediaTimeToTimelineFrame(1.0, { ...base, startFrame: 820 }, 30), 850);

// Source in-point: media time is measured from the trimmed-in source region.
// srcInFrame 30 == 1s of leading source cut; media t=1s is then the window start.
assert.equal(
  audioMediaTimeToTimelineFrame(1.0, { ...base, srcInFrame: 30 }, 30),
  0,
  'srcInFrame shifts the mapping so media t=1s maps back to frame 0',
);
assert.equal(
  audioMediaTimeToTimelineFrame(3.0, { ...base, srcInFrame: 30 }, 30),
  60,
);

// Rate-stretched audio item: 0.5x means one source second covers two timeline
// seconds worth of frames.
assert.equal(
  audioMediaTimeToTimelineFrame(2.0, { ...base, playbackRate: 0.5 }, 30),
  120,
  '0.5x: 2 media seconds == 120 timeline frames at 30fps',
);

// Negative / sub-frame results round naturally at the caller; the pure mapping
// stays exact.
assert.equal(audioMediaTimeToTimelineFrame(0.5, { ...base, srcInFrame: 30 }, 30), -15);

// Wiring assertions: the controller must expose the audible audio item and the
// paint hook must actually run the audio-clock loop while playing.
const controllerSource = readFileSync(new URL('./useTimelineController.ts', import.meta.url), 'utf8');
assert.match(
  controllerSource,
  /getAudibleItem = useCallback\(\(playheadFrame: number\): AudibleAudioItem \| null =>/,
  'controller must expose the audible audio item for marking mode',
);
assert.match(
  controllerSource,
  /it\.kind === 'audio' && !!it\.src/,
  'only audio items qualify for the audio clock',
);

const paintSource = readFileSync(new URL('./usePlayheadPaint.ts', import.meta.url), 'utf8');
// Pause paints the old head immediately. A manual seek immediately afterward
// must also update the label, even when React's frame effect is inside 80ms.
assert.equal(shouldPaintPlayheadTimecode(false, true, 1000, 990), true);
assert.equal(shouldPaintPlayheadTimecode(false, false, 1001, 1000), true, 'paused manual seek cannot wait for a nonexistent playback tick');
assert.equal(shouldPaintPlayheadTimecode(true, false, 1001, 1000), false, 'playing label updates remain throttled');
assert.equal(shouldPaintPlayheadTimecode(true, false, 1081, 1000), true);
assert.equal(shouldPaintPlayheadTimecode(true, true, 1001, 1000), true, 'explicit force overrides playback throttle');
assert.match(paintSource, /shouldPaintPlayheadTimecode\(Boolean\(playerRef\.current\?\.isPlaying\(\)\), forceTc, now, lastTcPaintRef\.current\)/,
  'actual playhead painter must use the paused-aware decision');
assert.match(
  paintSource,
  /if \(lastAudioFrameRef\.current !== null\) return;/,
  'wall-clock frameupdate must yield to the audio clock while marking mode is active',
);
assert.match(
  paintSource,
  /audioMediaTimeToTimelineFrame\(mediaSec, item, fpsRef\.current\)/,
  'the audio-clock loop must map media time through the item geometry',
);
assert.match(
  paintSource,
  /lastAudioFrameRef\.current = null;/,
  'the audio lock must release when no audible media element is available',
);

assert.match(
  paintSource,
  /onPlaybackFrameRef\.current\?\.\(/,
  'usePlayheadPaint must notify playback follow listeners during playback',
);
assert.match(
  controllerSource,
  /playbackPageScrollLeft\(/,
  'timeline controller must compute playback page-turn scroll via playbackPageScrollLeft',
);
assert.match(
  controllerSource,
  /if \(el\.scrollLeft !== prevScrollLeft\) syncVisibleWindowRef\.current\(\);/,
  'timeline controller must sync visibleWindow immediately after playback page-turn scroll',
);
assert.match(
  paintSource,
  /Math\.abs\(clamped - playerFrame\) > maxDivergence/,
  'audio clock must yield back to player clock when diverged by >1s',
);
assert.match(
  controllerSource,
  /\|\| seekGestureRef\.current !== null/,
  'playback auto-scroll must yield during any active seek gesture',
);
assert.match(
  controllerSource,
  /startFrame:\s*frameAtClientX\(event\.clientX\)/,
  'blank-lane click must freeze its target frame at pointerDown',
);
assert.match(
  controllerSource,
  /commands\.splitFoldGroup\(group\.id, frame\)/,
  'Ctrl+B split must support collapsed fold groups',
);
const monitorBarSource = readFileSync(new URL('../preview/PreviewMonitorBar.tsx', import.meta.url), 'utf8');
assert.match(
  monitorBarSource,
  /const renderedFrame = hasItems \? currentFrameRef\.current : 0;/,
  'PreviewMonitorBar must render from currentFrameRef so React re-renders never revert playback timecode',
);

console.log('usePlayheadPaint.verify: marking-mode audio clock & playback page-turn wiring passed');
