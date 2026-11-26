import assert from 'node:assert/strict';
import { shortcutAllowedForSurface } from './shortcutScope';
import { normalizeKey } from './match';
import { isShortcutBlockedByModalOrMenu } from './useShortcutDispatcher';
import { resolveMacNativeEditAction } from '../hooks/useMacNativeEditFallback';
import { resolveUiScaleShortcut } from '../hooks/useUiScaleShortcuts';

for (const surface of ['media-pool', 'agent-chat', 'agent-input'] as const) {
  for (const action of ['select-all', 'copy', 'cut', 'paste', 'delete', 'split', 'play-pause', 'zoom-fit', 'zoom-in', 'zoom-out', 'fullscreen']) {
    assert.equal(
      shortcutAllowedForSurface(action, surface),
      false,
      `${surface} must not dispatch timeline-only action ${action}`,
    );
  }
}
for (const surface of ['inspector', 'other'] as const) {
  for (const action of ['select-all', 'copy', 'cut', 'paste', 'delete']) {
    assert.equal(
      shortcutAllowedForSurface(action, surface),
      false,
      `${surface} must not dispatch timeline-only action ${action}`,
    );
  }
  assert.equal(shortcutAllowedForSurface('split', surface), true, `split must work from ${surface}`);
  assert.equal(shortcutAllowedForSurface('play-pause', surface), true, `play-pause must work from ${surface}`);
  assert.equal(shortcutAllowedForSurface('shuttle-back', surface), true, `shuttle-back must work from ${surface}`);
}
assert.equal(shortcutAllowedForSurface('zoom-fit', 'inspector'), false);
for (const action of ['zoom-fit', 'zoom-in', 'zoom-out', 'fullscreen']) {
  assert.equal(shortcutAllowedForSurface(action, 'other'), true, `${action} must work from top-level other surface`);
}

for (const action of ['undo', 'redo', 'save-version', 'keyboard-shortcuts', 'ask-ai', 'open-settings']) {
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
for (const action of ['play-pause', 'seek-back', 'seek-fwd', 'prev-edit', 'next-edit', 'fullscreen']) {
  assert.equal(shortcutAllowedForSurface(action, 'preview'), true, `${action} must work from preview`);
}
assert.equal(shortcutAllowedForSurface('delete', 'preview'), false, 'preview must not run timeline edits');
assert.equal(normalizeKey('【'), '[');
assert.equal(normalizeKey('】'), ']');
assert.equal(normalizeKey('，'), ',');
assert.equal(normalizeKey('·'), '`');

assert.equal(isShortcutBlockedByModalOrMenu(null, true), true);
assert.equal(isShortcutBlockedByModalOrMenu(null, false), false);
assert.equal(
  isShortcutBlockedByModalOrMenu({ closest: (sel: string) => (sel.includes('[role="dialog"]') ? {} : null) } as unknown as Element, false),
  false,
  'non-Element mock is ignored unless instanceof Element',
);

const makeMacEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'c',
  code: 'KeyC',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  ...overrides,
});
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'z', code: 'KeyZ' }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'undo');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'z', code: 'KeyZ', shiftKey: true }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'redo');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'x', code: 'KeyX' }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'cut');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'c', code: 'KeyC' }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'copy');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'v', code: 'KeyV' }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'paste');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'a', code: 'KeyA' }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'selectAll');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'c', code: 'KeyC' }), { isMacDesktop: true, isTypingTarget: false, hasTextSelection: true }), 'copy');
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'c', code: 'KeyC' }), { isMacDesktop: true, isTypingTarget: false, hasTextSelection: false }), null);
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'v', code: 'KeyV', defaultPrevented: true }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), null);
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'c', code: 'KeyC' }), { isMacDesktop: false, isTypingTarget: true, hasTextSelection: false }), null);
assert.equal(resolveMacNativeEditAction(makeMacEvent({ key: 'Process', code: 'KeyC' }), { isMacDesktop: true, isTypingTarget: true, hasTextSelection: false }), 'copy');

assert.equal(resolveUiScaleShortcut({ key: '=', code: 'Equal', metaKey: true, ctrlKey: false, altKey: false, defaultPrevented: false }, { inEditor: true, isMac: true }), null);
assert.equal(resolveUiScaleShortcut({ key: '-', code: 'Minus', metaKey: true, ctrlKey: false, altKey: false, defaultPrevented: false }, { inEditor: true, isMac: true }), null);
assert.equal(resolveUiScaleShortcut({ key: '≠', code: 'Equal', metaKey: true, ctrlKey: false, altKey: true, defaultPrevented: false }, { inEditor: true, isMac: true }), 0.05);
assert.equal(resolveUiScaleShortcut({ key: '–', code: 'Minus', metaKey: true, ctrlKey: false, altKey: true, defaultPrevented: false }, { inEditor: true, isMac: true }), -0.05);
assert.equal(resolveUiScaleShortcut({ key: '0', code: 'Digit0', metaKey: true, ctrlKey: false, altKey: false, defaultPrevented: false }, { inEditor: true, isMac: true }), 'reset');
assert.equal(resolveUiScaleShortcut({ key: '=', code: 'Equal', metaKey: true, ctrlKey: false, altKey: false, defaultPrevented: false }, { inEditor: false, isMac: true }), 0.05);
assert.equal(resolveUiScaleShortcut({ key: '-', code: 'Minus', metaKey: false, ctrlKey: true, altKey: false, defaultPrevented: false }, { inEditor: false, isMac: false }), -0.05);

console.log('shortcutScope.verify: surface routing OK');
