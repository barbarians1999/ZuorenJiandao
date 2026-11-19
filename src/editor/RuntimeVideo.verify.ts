import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeVideoRendering, usesSeparatePlainMediaAudio } from './RuntimeVideo';

for (const isRendering of [false, true]) {
  for (const isClientSideRendering of [false, true]) {
    for (const browserRenderer of [false, true]) {
      assert.equal(nativeVideoRendering(browserRenderer, { isRendering, isClientSideRendering }, true),
        isRendering && !isClientSideRendering && !browserRenderer,
        'native video must never enter the Player or WebCodecs route');
      assert.equal(nativeVideoRendering(browserRenderer, { isRendering, isClientSideRendering }), false,
        'unknown or alpha-bearing media never loses transparency');
    }
  }
}
const runtime = readFileSync(new URL('./RuntimeVideo.tsx', import.meta.url), 'utf8');
assert.match(runtime, /<OffthreadVideo \{\.\.\.props\} style=\{style\} \/>/,
  'native extraction keeps trim/rate/volume/style without PNG compression for proven opaque sources');
assert.match(runtime, /sources\.includes\(props.src\)/, 'native source must be explicitly server-probed');
assert.match(runtime, /<BrowserVideo \{\.\.\.props\} style=\{browserStyle\} objectFit=/,
  'browser video retains its separate objectFit prop');
const media = readFileSync(new URL('./TimelineMediaLayer.tsx', import.meta.url), 'utf8');
const shared = media.slice(media.indexOf('export function SharedVideoVisualGroup'), media.indexOf('export function BackgroundFillLayer'));
assert.match(shared, /volume=\{0\} muted style=\{style\}/,
  'shared pictures never decode duplicate audio; ContinuousVideoAudio remains audible');
assert.match(media, /export function ContinuousVideoAudio[\s\S]*<MixedRuntimeAudio/);
for (const kind of ['image', 'gif', 'svg'] as const) {
  assert.equal(usesSeparatePlainMediaAudio(kind, undefined, true), false, `${kind} stills have no separate audio`);
}
assert.equal(usesSeparatePlainMediaAudio('video', undefined, true), true,
  'Player video preview separates audio so <Html5Audio preservePitch> prevents speed pitch shift');
assert.equal(usesSeparatePlainMediaAudio('video', undefined, false), false,
  'export render video keeps native RuntimeVideo audio when not denoised');
assert.equal(usesSeparatePlainMediaAudio('video', '/denoised.wav', false), true,
  'denoised video always uses separate MixedRuntimeAudio');
const plain = media.slice(media.indexOf('function PlainMediaFill'), media.indexOf('export function MediaFill'));
assert.match(plain, /volume=\{0\} muted style=\{style\}/,
  'PlainMediaFill mutes video element when separate Player audio is active');
assert.match(plain, /!groupedAudio && !muted && <MixedRuntimeAudio/,
  'PlainMediaFill routes unmuted live Player audio through MixedRuntimeAudio');
console.log('RuntimeVideo native/browser routing and visual-only audio checks passed');
