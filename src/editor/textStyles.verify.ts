import assert from 'node:assert/strict';
import { resolveTextStyle, textBackgroundColor, textShadowValue, titleAnimationStyle } from './textStyles';

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

assert.deepEqual(titleAnimationStyle('fade', 0), { opacity: 0 });
assert.deepEqual(titleAnimationStyle('slide-left', 0.5), { transform: 'translateX(50%)' });
assert.deepEqual(titleAnimationStyle('none', 0), {});
console.log('textStyles.verify: presets, typography, stroke/shadow/background, and animation helpers ok');
