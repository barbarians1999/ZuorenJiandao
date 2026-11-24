import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatSourcePreviewTime, isPreviewableSourceAsset, resolveSourceSwapPlan } from './sourceAssetPreviewState';

assert.equal(isPreviewableSourceAsset(null), false);
assert.equal(isPreviewableSourceAsset(undefined), false);
assert.equal(isPreviewableSourceAsset({ kind: 'video', src: '/media/v.mp4' }), true);
assert.equal(isPreviewableSourceAsset({ kind: 'audio', src: '/media/a.mp3' }), true);
assert.equal(isPreviewableSourceAsset({ kind: 'image', src: '/media/i.png' }), true);
assert.equal(isPreviewableSourceAsset({ kind: 'gif', src: '/media/g.gif' }), true);
assert.equal(isPreviewableSourceAsset({ kind: 'svg', src: '/media/s.svg' }), true);
assert.equal(isPreviewableSourceAsset({ kind: 'motion-graphic', src: '' }), true);
assert.equal(isPreviewableSourceAsset({ kind: 'video', src: '' }), false);
assert.equal(isPreviewableSourceAsset({ kind: 'document', src: '/doc.md' }), false);
assert.equal(isPreviewableSourceAsset({ kind: 'file', src: '/file.bin' }), false);

assert.equal(formatSourcePreviewTime(0), '00:00');
assert.equal(formatSourcePreviewTime(-3), '00:00');
assert.equal(formatSourcePreviewTime(Number.NaN), '00:00');
assert.equal(formatSourcePreviewTime(65), '01:05');
assert.equal(formatSourcePreviewTime(3661), '1:01:01');

const [sourcePreviewCode, cardCode, previewPanelCode] = await Promise.all([
  readFile(new URL('./SourceAssetPreview.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../media/MediaPoolCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8'),
]);

assert.match(sourcePreviewCode, /removeAttribute\('src'\)/, 'closing source preview must release media decoders');
assert.match(cardCode, /draggedRef\.current/, 'dragging an asset must not trigger single-click source preview');
assert.match(cardCode, /props\.onPreview\(/, 'plain single-click invokes source preview');
assert.match(previewPanelCode, /playerRef\.current\?\.pause\(\)/, 'opening source preview pauses timeline playback');
assert.match(previewPanelCode, /cc-preview-stage"[\s\S]*previewAsset \? \{ display: 'none' \} : undefined[\s\S]*<Player\b/, 'timeline Player stays mounted when previewing a source asset');

assert.deepEqual(
  resolveSourceSwapPlan({ prevAssetId: null, nextAssetId: 'a1', currentTime: 12.5, playing: false, muted: true }),
  { isSameAsset: false, resumeTime: 0, shouldPlay: true, muted: false },
);
assert.deepEqual(
  resolveSourceSwapPlan({ prevAssetId: 'a1', nextAssetId: 'a1', currentTime: 18.4, playing: false, muted: true }),
  { isSameAsset: true, resumeTime: 18.4, shouldPlay: false, muted: true },
);

console.log('sourceAssetPreview.verify: passed');
