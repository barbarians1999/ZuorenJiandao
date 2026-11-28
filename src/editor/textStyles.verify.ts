import assert from 'node:assert/strict';
import {
  prepareTextPropPatch,
  resolveTextStyle,
  resolveTextTransformForTarget,
  textBackgroundColor,
  textShadowValue,
  titleAnimationStyle,
  toColorPickerHex,
} from './textStyles';

const boxed = resolveTextStyle({ textStylePreset: 'boxed', text: '标题' });
assert.equal(boxed.backgroundOpacity, 86);
assert.equal(boxed.backgroundRadius, 14);
assert.equal(boxed.text, '标题');
assert.equal(textBackgroundColor(boxed), '#111111db');

const custom = resolveTextStyle({ lineHeight: 1.7, letterSpacing: 6, strokeWidth: 4, shadowOffsetX: -3, shadowBlur: 20 });
assert.equal(custom.lineHeight, 1.7);
assert.equal(custom.letterSpacing, 6);
assert.equal(custom.strokeWidth, 4);
assert.equal(textShadowValue(custom), '-3px 3px 20px rgba(0,0,0,0.55)');

// Text card background + top/left accent bar: omitted backgroundOpacity auto-reveals backgroundColor, 0..1 scales to %
const cardWithoutOpacity = resolveTextStyle({ backgroundColor: '#f4ecda', accentBarPosition: 'top', accentBarColor: '#a62121' });
assert.equal(cardWithoutOpacity.backgroundOpacity, 100);
assert.equal(textBackgroundColor(cardWithoutOpacity), '#f4ecdaff');

const cardFractionalOpacity = resolveTextStyle({ backgroundColor: '#1c1816', backgroundOpacity: 0.88, accentBarPosition: 'left' });
assert.equal(cardFractionalOpacity.backgroundOpacity, 88);
assert.equal(textBackgroundColor(cardFractionalOpacity), '#1c1816e0');

const cardShortHex = resolveTextStyle({ backgroundColor: '#111', backgroundOpacity: 80 });
assert.equal(textBackgroundColor(cardShortHex), '#111111cc');

const cardRgb = resolveTextStyle({ backgroundColor: 'rgba(28, 24, 22, 0.85)' });
assert.equal(cardRgb.backgroundOpacity, 85);
assert.equal(textBackgroundColor(cardRgb), 'rgba(28,24,22,0.85)');
assert.equal(toColorPickerHex('rgba(28, 24, 22, 0.85)'), '#1c1816');

const explicitOff = resolveTextStyle({ backgroundColor: '#f4ecda', backgroundOpacity: 0, accentBarPosition: 'top' });
assert.equal(explicitOff.backgroundOpacity, 0);
assert.equal(textBackgroundColor(explicitOff), undefined);

// Switching from clean (stale backgroundOpacity: 0) -> archival-top-tag / custom card bg restores visible background
const switchedPreset = prepareTextPropPatch(
  { textStylePreset: 'clean', backgroundOpacity: 0, accentBarPosition: 'none' },
  { textStylePreset: 'archival-top-tag' },
);
assert.equal(switchedPreset.backgroundOpacity, 94);
assert.equal(switchedPreset.accentBarPosition, 'top');

const colorOnlyPatch = prepareTextPropPatch(
  { textStylePreset: 'clean', backgroundOpacity: 0, backgroundColor: '#111111' },
  { backgroundColor: '#f4ecda', accentBarPosition: 'top' },
);
assert.equal(colorOnlyPatch.backgroundOpacity, 100);

// Coordinate origin formula consistency
assert.deepEqual(resolveTextTransformForTarget('center', { xRatio: 0.3, yRatio: 0.7 }), { x: -20, y: 20 });
assert.deepEqual(resolveTextTransformForTarget('top-left', { xRatio: 0.05, yRatio: 96 / 1080 }), { x: 0, y: 0 });
assert.deepEqual(resolveTextTransformForTarget('middle-left', { xRatio: 0.25, yRatio: 0.5 }), { x: 20, y: 0 });

assert.deepEqual(titleAnimationStyle('fade', 0), { opacity: 0 });
assert.deepEqual(titleAnimationStyle('slide-left', 0.5), { transform: 'translateX(50%)' });
assert.deepEqual(titleAnimationStyle('none', 0), {});
console.log('textStyles.verify: presets, card bg + accent bar, coordinate helpers, and animation helpers ok');
