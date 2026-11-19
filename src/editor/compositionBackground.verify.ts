import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compositionBackground } from './compositionBackground';

assert.match(compositionBackground(false, false)!, /^repeating-conic-gradient/);
assert.equal(compositionBackground(false, true), '#000000');
assert.equal(compositionBackground(true, false), undefined);
assert.equal(compositionBackground(true, true), undefined);
const composition = readFileSync(new URL('./TimelineComposition.tsx', import.meta.url), 'utf8');
assert.match(composition, /compositionBackground\(!!transparent, environment\.isRendering \|\| browserRenderer\)/);
console.log('compositionBackground: preview grid, both opaque export routes and nested/alpha transparency OK');
