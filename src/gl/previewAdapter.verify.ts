import assert from 'node:assert/strict';
import { GLSL_TRANSITION_TYPES, type TransitionItem } from '../editor/types';
import { selectTransitionPreviewAdapter } from './previewAdapter';

const type = ([...GLSL_TRANSITION_TYPES][0] ?? 'cross-dissolve') as TransitionItem['type'];
const base = { mode: 'player' as const, type, texturable: true, hasShader: true };
assert.deepEqual(selectTransitionPreviewAdapter({ ...base, selected: false }), {
  adapter: 'css-transition', fidelity: 'approximate', fallbackAdapter: 'css-transition',
});
assert.deepEqual(selectTransitionPreviewAdapter({ ...base, selected: true }), {
  adapter: 'gl-transition', fidelity: 'exact', fallbackAdapter: 'css-transition',
});
assert.equal(selectTransitionPreviewAdapter({ ...base, selected: false, texturable: false }).adapter, 'css-transition');
console.log('previewAdapter.verify OK');
