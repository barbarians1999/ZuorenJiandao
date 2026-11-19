import assert from 'node:assert/strict';
import {
  CAPTION_SCALE_MAX,
  CAPTION_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  captionRatioToScale,
  captionScaleToRatio,
  formatFontSizeScale,
  textPxToScale,
  textScaleToPx,
} from './fontSizeScale';

// Standard subtitle ratio 0.04 maps cleanly to Jianying-style scale 8 (in 5~15 typical range)
assert.equal(captionRatioToScale(0.04), 8);
assert.equal(captionScaleToRatio(8), 0.04);
assert.equal(captionRatioToScale(0.05), 10);
assert.equal(captionRatioToScale(0.075), 15);
assert.equal(formatFontSizeScale(8), '8');
assert.equal(formatFontSizeScale(8.5), '8.5');
assert.equal(formatFontSizeScale(8.04), '8');

// Caption clamping & round-trip stability across 0.5 increments
assert.equal(captionRatioToScale(0.001), CAPTION_SCALE_MIN);
assert.equal(captionRatioToScale(0.5), CAPTION_SCALE_MAX);
for (let scale = CAPTION_SCALE_MIN; scale <= CAPTION_SCALE_MAX; scale += 0.5) {
  const ratio = captionScaleToRatio(scale);
  assert.equal(captionRatioToScale(ratio), scale, `caption round-trip drift at ${scale}`);
}

// Text clip calibration shares physical height (8 units = 43.2px @ 1080p, 96px ≈ 17.8)
assert.equal(textPxToScale(96), 17.8);
assert.equal(textPxToScale(10), 4.4);
assert.equal(textPxToScale(500), 55.6);
for (let scale = TEXT_SCALE_MIN; scale <= TEXT_SCALE_MAX; scale += 0.5) {
  const px = textScaleToPx(scale);
  assert.ok(px >= 24 && px <= 300, `text px out of bounds at ${scale}: ${px}`);
  assert.equal(textPxToScale(px), scale, `text round-trip drift at ${scale}`);
}

process.stdout.write('fontSizeScale.verify: ok\n');
