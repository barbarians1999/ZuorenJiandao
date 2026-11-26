import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const timeline = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8');
const lane = readFileSync(new URL('./TrackLane.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

const filmstrip = readFileSync(new URL('./ClipMediaLayers.tsx', import.meta.url), 'utf8');

assert.match(timeline, /muted=\{config\.muted \?\? false\}/);
assert.match(lane, /muted:\s*boolean/);
assert.match(lane, /muted\s*&&\s*\(it\.kind === 'audio' \|\| it\.kind === 'video'\)/);
assert.match(lane, /is-audio-muted/);
assert.match(lane, /cc-clip-muted-indicator[\s\S]*?volumeOff/);
assert.match(css, /\.cc-timeline-clip\.is-audio-muted::after/);
assert.match(css, /\.cc-timeline-clip\[data-clip-kind="video"\]\.is-audio-muted::after\s*\{\s*display:\s*none;/);
assert.match(css, /\.cc-timeline-clip\[data-clip-kind="video"\]\.is-audio-muted\s+\.cc-clip-wave\.on-video/);
assert.match(css, /\.cc-clip-muted-indicator/);

assert.match(lane, /const pictureDisabled = it\.pictureDisabled === true;/);
assert.match(filmstrip, /className="cc-clip-filmstrip"/);
assert.match(css, /\.cc-timeline-clip\.is-picture-disabled \.cc-clip-surface\s*\{[^}]*grayscale\(1\)[^}]*brightness\(/);
assert.match(css, /\.cc-timeline-clip\.is-picture-disabled \.cc-clip-surface::after/);
assert.match(css, /\.cc-clip-picture-disabled-badge/);

console.log('track-mute-visual.verify: muted & disabled clips are visibly distinct');
