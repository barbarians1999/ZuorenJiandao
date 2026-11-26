import assert from 'node:assert/strict';
import { shortcutAllowedForSurface } from './shortcutScope';
import { normalizeKey } from './match';

for (const surface of ['media-pool', 'agent-chat', 'agent-input'] as const) {
  for (const action of ['select-all', 'copy', 'cut', 'paste', 'delete', 'split', 'play-pause', 'zoom-fit']) {
    assert.equal(
      shortcutAllowedForSurface(action, surface),
      false,
      `${surface} must not dispatch timeline-only action ${action}`,
    );
  }
}
for (const surface of ['inspector', 'other'] as const) {
  for (const action of ['select-all', 'copy', 'cut', 'paste', 'delete', 'play-pause', 'zoom-fit']) {
    assert.equal(
      shortcutAllowedForSurface(action, surface),
      false,
      `${surface} must not dispatch timeline-only action ${action}`,
    );
  }
  assert.equal(shortcutAllowedForSurface('split', surface), true, `split must work from ${surface}`);
}

for (const action of ['undo', 'redo', 'save-version', 'keyboard-shortcuts', 'ask-ai']) {
  assert.equal(shortcutAllowedForSurface(action, 'agent-chat'), true);
}

assert.equal(shortcutAllowedForSurface('split', 'timeline'), true);
assert.equal(shortcutAllowedForSurface('split', 'preview'), true);
assert.equal(shortcutAllowedForSurface('copy', 'timeline'), true);
for (const surface of ['timeline', 'preview', 'other'] as const) {
  assert.equal(shortcutAllowedForSurface('marker-add', surface), true);
}
for (const surface of ['media-pool', 'agent-chat', 'agent-input', 'inspector'] as const) {
  assert.equal(shortcutAllowedForSurface('marker-add', surface), false);
}
assert.equal(shortcutAllowedForSurface('select-before-playhead', 'other'), true);
assert.equal(shortcutAllowedForSurface('select-after-playhead', 'inspector'), true);
for (const action of ['seek-back', 'seek-fwd', 'prev-edit', 'next-edit']) {
  assert.equal(shortcutAllowedForSurface(action, 'preview'), true, `${action} must work from preview`);
  assert.equal(shortcutAllowedForSurface('delete', 'preview'), false, 'preview must not run timeline edits');
}
assert.equal(normalizeKey('【'), '[');
assert.equal(normalizeKey('】'), ']');

console.log('shortcutScope.verify: surface routing OK');
