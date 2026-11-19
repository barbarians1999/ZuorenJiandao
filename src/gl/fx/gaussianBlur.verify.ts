import assert from 'node:assert/strict';
import { gaussianBlurDefinition, gaussianFragment, gaussianKernel } from './gaussianBlur';
import { fxPasses } from './uniforms';

for (const strength of [NaN, -10, 1, 30, 70, 100, Infinity]) {
  const kernel = gaussianKernel(strength);
  assert(Math.abs(kernel.center + 2 * kernel.pairs.reduce((sum, pair) => sum + pair.weight, 0) - 1) < 1e-12);
  assert(kernel.sigma >= 1 && kernel.sigma <= 24);
  assert.equal(kernel.radius, 3 * kernel.sigma);
  assert(kernel.weights.every((weight, index) => weight > 0 && (!index || weight < kernel.weights[index - 1]!)));
  for (let index = 0; index < kernel.pairs.length; index++) {
    const pair = kernel.pairs[index]!, at = 1 + 2 * index;
    const fraction = pair.offset - at;
    assert(Math.abs(pair.weight * (1 - fraction) - kernel.weights[at]!) < 1e-12);
    assert(Math.abs(pair.weight * fraction - (kernel.weights[at + 1] ?? 0)) < 1e-12);
  }
  assert(gaussianFragment(strength).includes('#version 300 es'));
}
const variants = new Set(Array.from({ length: 100 }, (_, index) => gaussianFragment(index + 1)));
assert.equal(variants.size, 24, 'Slider does not produce an unbounded shader cache');
const definition = gaussianBlurDefinition('copy', 'composite');
const passes = fxPasses([{ def: { id: 'before', name: '', desc: '', props: [], frag: 'before' } },
  { def: definition, overrides: { strength: 70 } }, { def: definition, overrides: { strength: 90 } }], 1);
assert.equal(passes.length, 9);
assert.deepEqual(passes[2]?.uniforms, { u_direction: [1, 0] });
assert.deepEqual(passes[3]?.uniforms, { u_direction: [0, 1] });
assert.equal(passes[4]?.inputFrom, 1);
assert.deepEqual(passes[4]?.samplers, { u_blurred: 3 });
assert.equal(passes[8]?.inputFrom, 5);
assert.deepEqual(passes[8]?.samplers, { u_blurred: 7 });
console.log('gaussianBlur.verify: normalized Gaussian, bilinear pairs, bounded cache and stacked pipelines passed');
