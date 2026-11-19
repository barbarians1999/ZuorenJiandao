import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRANSITION_ORDER, TRANSITION_LABELS, GLSL_TRANSITION_TYPES } from '../editor/transitionTypes';
import { previewTransitionType } from '../editor/transitionPreview';
import { buildTransitionShaderFrame } from './shaderFrame';

for (const type of ['mosaic-reveal', 'blinds-reveal', 'split-slide'] as const) {
  assert.equal(TRANSITION_ORDER.filter((id) => id === type).length, 1);
  assert.ok(GLSL_TRANSITION_TYPES.has(type));
  assert.ok(TRANSITION_LABELS[type]);
  const frag = readFileSync(new URL(`./shaders/${type}.frag`, import.meta.url), 'utf8');
  assert.ok(frag.startsWith('#version 300 es'));
  assert.ok(frag.includes('u_outgoing') && frag.includes('u_incoming'));
  assert.ok(frag.includes('u_progress <= 0.0') && frag.includes('u_progress >= 1.0'), 'endpoints must be exact');
  const frame = (sequenceFrame: number) => buildTransitionShaderFrame({ frag, uniforms: () => ({}) }, {
    sequenceFrame, durationInFrames: 13, windowStartFrame: 60, fps: 30, width: 1080, height: 1920, direction: 'up',
  });
  assert.equal(frame(0).progress, 0); assert.equal(frame(6).progress, .5); assert.equal(frame(12).progress, 1);
}
assert.equal(previewTransitionType('mosaic-reveal'), 'cross-dissolve');
assert.equal(previewTransitionType('blinds-reveal'), 'soft-wipe');
assert.equal(previewTransitionType('split-slide'), 'whip-pan');
console.log('chapterTransitions.verify: registration, exact endpoints and declared lightweight fallbacks OK');
