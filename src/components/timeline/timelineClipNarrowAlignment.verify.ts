import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const trackLaneSource = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
const captionLaneSource = readFileSync(new URL('../../captions/CaptionTrackLane.tsx', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const polishCss = readFileSync(new URL('../../editor/editor-ui-polish.css', import.meta.url), 'utf8');

// 1. Regular timeline clips keep border: 0 and box-sizing: border-box so .cc-clip-surface fills [start, end] cleanly,
//    while narrow clips (< 16px) collapse padding/labels so the surface never bleeds past endFrame.
assert.match(trackLaneSource, /const clipWidthPx = Math\.max\(2, rawClipWidthPx\);/);
assert.match(trackLaneSource, /data-narrow-clip=\{narrowClip \? 'true' : undefined\}/);
assert.match(indexCss, /\.cc-timeline-clip\s*\{[^}]*box-sizing:\s*border-box;[^}]*border:\s*0;/s);
assert.match(indexCss, /\.cc-clip-surface\s*\{[^}]*box-sizing:\s*border-box;\s*width:\s*100%;\s*height:\s*100%;/s);
assert.match(indexCss, /\.cc-timeline-clip\[data-narrow-clip="true"\]\s+\.cc-clip-surface\s*\{[^}]*padding:\s*0;/s);
assert.match(polishCss, /\.cc-timeline-clip\[data-narrow-clip="true"\][\s\S]*border-radius:\s*2px;/);

// 2. Caption cues use exact frame-derived width down to 2px instead of forcing a 18px pill + 15px horizontal padding.
assert.match(captionLaneSource, /const cueWidthPx = Math\.max\(2, durationFrames \* px\);/);
assert.doesNotMatch(captionLaneSource, /Math\.max\(18,\s*durationFrames \* px\)/);
assert.match(indexCss, /\.cc-caption-track-cue\[data-narrow="true"\]\s*\{[^}]*padding:\s*0;[^}]*border-inline-width:\s*0;/s);

// 3. Playhead (2px in editor-ui-polish.css) is centered on HEADER_W + frame * px.
assert.match(polishCss, /\.cc-editor-shell\s+\.cc-playhead\s*\{[^}]*width:\s*2px;[^}]*margin-left:\s*-1px;/s);

console.log('timelineClipNarrowAlignment.verify: narrow clips, caption cues, and playhead centering contracts OK');
