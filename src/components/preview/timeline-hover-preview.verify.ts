import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearHoverPreviewForActivity, type TimelineHoverPreviewActivity } from '../timeline/timelineHoverPreview';

const preview = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(preview, /acknowledgeRemotionLicense/, 'the preview Player acknowledges the Remotion license');
assert.match(preview, /hoverPreviewFrame\?: number \| null/, 'hover preview remains separate from the main playhead');
assert.match(preview, /className="cc-preview-hover-frame"/, 'the hovered frame renders inside the preview canvas');
assert.match(preview, /frameToDisplay=\{hoverPreviewFrame\}/, 'the thumbnail renders the exact hovered frame');

const idle: TimelineHoverPreviewActivity = {
  hoverPreviewEnabled: true,
  playing: false,
  drag: false,
  marquee: false,
  pickDrag: false,
  pointerButtons: 0,
};
const activeCases: Array<[string, Partial<TimelineHoverPreviewActivity>]> = [
  ['playback', { playing: true }],
  ['clip drag', { drag: true }],
  ['marquee selection', { marquee: true }],
  ['pick drag', { pickDrag: true }],
  ['disabled hover preview', { hoverPreviewEnabled: false }],
  ['pressed pointer', { pointerButtons: 1 }],
];
for (const [name, changes] of activeCases) {
  let hoverFrame: number | null = 42;
  let clearCalls = 0;
  const didClear = clearHoverPreviewForActivity({ ...idle, ...changes }, () => {
    clearCalls += 1;
    hoverFrame = null;
  });
  assert.equal(didClear, true, `${name} requests preview cleanup`);
  assert.equal(clearCalls, 1, `${name} invokes the cleanup callback exactly once`);
  assert.equal(hoverFrame, null, `${name} removes the existing preview frame`);
}

let idleClearCalls = 0;
assert.equal(clearHoverPreviewForActivity(idle, () => { idleClearCalls += 1; }), false);
assert.equal(idleClearCalls, 0, 'idle enabled preview is retained');

console.log('timeline-hover-preview.verify: playback, gesture, pointer, and preference cleanup passed');