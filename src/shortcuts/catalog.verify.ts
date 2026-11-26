// Stable regression for the shortcut catalog (count, chord parsing, matcher routing).
// Wired into verify:shortcuts (npm pretest).
import assert from 'node:assert';
import { SHORTCUT_CATALOG, SHORTCUT_BY_ID } from './catalog';
import { isShortcutImeComposing, matchShortcut, parseBindingAlts, parseChord, shouldIgnoreShortcutRepeat } from './match';
import { effectiveMatchingCatalog, resetBinding, setBinding } from './keymap';

assert.strictEqual(SHORTCUT_CATALOG.length, 67);
assert.strictEqual(new Set(SHORTCUT_CATALOG.map((entry) => entry.id)).size, 67);
assert.ok(SHORTCUT_BY_ID['play-pause']);
assert.ok(SHORTCUT_BY_ID['shuttle-back']);
assert.ok(SHORTCUT_BY_ID['toggle-picture']);
assert.strictEqual(SHORTCUT_BY_ID['select-before-playhead']?.keys, '[');
assert.strictEqual(SHORTCUT_BY_ID['select-after-playhead']?.keys, ']');
assert.strictEqual(SHORTCUT_BY_ID['select-track-before-playhead']?.keys, 'Shift + [');
assert.strictEqual(SHORTCUT_BY_ID['select-track-after-playhead']?.keys, 'Shift + ]');
assert.strictEqual(SHORTCUT_BY_ID['select-after']?.keys, 'Y');

const space = parseChord('Space');
assert.ok(space);
assert.strictEqual(space!.key, 'space');

const chord = parseChord('Mod + Alt + V');
assert.ok(chord);
assert.strictEqual(chord!.mod, true);
assert.strictEqual(chord!.alt, true);
assert.strictEqual(chord!.key, 'v');

const alts = parseBindingAlts('E / Shift + E');
assert.strictEqual(alts.length, 2);
assert.strictEqual(alts[1]!.shift, true);

// Node has no document — mock target
const fakeTarget = { tagName: 'DIV', isContentEditable: false, closest: () => null } as unknown as HTMLElement;

function keyN(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? '',
    shiftKey: !!init.shiftKey,
    altKey: !!init.altKey,
    metaKey: !!init.metaKey,
    ctrlKey: !!init.ctrlKey,
    repeat: false,
    target: fakeTarget,
    preventDefault() {},
  } as unknown as KeyboardEvent;
}

const catalog = SHORTCUT_CATALOG.map((a) => ({ id: a.id, keys: a.keys, disabledWhenTyping: a.disabledWhenTyping }));
const typingTarget = { tagName: 'INPUT', isContentEditable: false, closest: () => null } as unknown as HTMLElement;
for (const [event, action] of [
  [keyN({ key: 'a' }), 'interaction-mode-selection'],
  [keyN({ key: 'v' }), 'toggle-picture'],
  [keyN({ key: 'b', ctrlKey: true }), 'split'],
  [keyN({ key: 'g', altKey: true }), 'create-subdraft'],
  [keyN({ key: 'g', ctrlKey: true }), 'group'],
  [keyN({ key: 'g', ctrlKey: true, shiftKey: true }), 'ungroup'],
  [keyN({ key: 'Delete', shiftKey: true }), 'ripple-delete'],
] as const) assert.strictEqual(matchShortcut(event, catalog, { held: new Set(), isMac: false }), action);

assert.strictEqual(matchShortcut(keyN({ key: 'v' }), catalog, { held: new Set(), isMac: false }), 'toggle-picture');
assert.strictEqual(matchShortcut(keyN({ key: 'v', shiftKey: true }), catalog, { held: new Set(), isMac: false }), null);
setBinding('interaction-mode-selection', 'V');
assert.strictEqual(matchShortcut(keyN({ key: 'v' }), effectiveMatchingCatalog(), { held: new Set(), isMac: false }),
  'interaction-mode-selection', 'existing custom bindings retain priority over new defaults');
resetBinding('interaction-mode-selection');
assert.strictEqual(
  matchShortcut(keyN({ key: 'v', shiftKey: true }), catalog, { held: new Set(), isMac: false }),
  null,
  'Shift+V is no longer a default picture toggle binding',
);
assert.strictEqual(matchShortcut({ ...keyN({ key: 'v', shiftKey: true }), target: typingTarget }, catalog, { held: new Set(), isMac: false }),
  null, 'Shift+V remains available for text editing');
assert.strictEqual(
  matchShortcut(keyN({ key: 'v', shiftKey: true, ctrlKey: true }), catalog, { held: new Set(), isMac: false }),
  null,
  'Ctrl+Shift+V does not trigger the picture toggle',
);
assert.strictEqual(isShortcutImeComposing({ isComposing: true, keyCode: 86 }), true);
assert.strictEqual(isShortcutImeComposing({ isComposing: false, keyCode: 229 }), true);
assert.strictEqual(isShortcutImeComposing({ isComposing: false, keyCode: 86 }), false);
assert.strictEqual(shouldIgnoreShortcutRepeat('toggle-picture', { repeat: true }), true);
assert.strictEqual(matchShortcut(keyN({ key: 'm' }), catalog, { held: new Set(), isMac: false }), 'marker-add');
assert.strictEqual(matchShortcut({ ...keyN({ key: 'm' }), target: typingTarget }, catalog, { held: new Set(), isMac: false }), null);
assert.strictEqual(shouldIgnoreShortcutRepeat('marker-add', { repeat: true }), true);
assert.strictEqual(shouldIgnoreShortcutRepeat('play-pause', { repeat: true }), true);
assert.strictEqual(shouldIgnoreShortcutRepeat('shuttle-fwd', { repeat: true }), false, 'J/K/L repeats remain available');
assert.strictEqual(
  matchShortcut(keyN({ key: ' ' }), catalog, { held: new Set(), isMac: true }),
  'play-pause',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'ArrowLeft' }), catalog, { held: new Set(), isMac: true }),
  'seek-back',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'ArrowLeft', shiftKey: true }), catalog, { held: new Set(), isMac: true }),
  'seek-back-sec',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'e', shiftKey: true }), catalog, { held: new Set(), isMac: true }),
  'nudge-left',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'j' }), catalog, { held: new Set(), isMac: true }),
  'shuttle-back',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'i' }), catalog, { held: new Set(), isMac: true }),
  'zone-in',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'i', shiftKey: true }), catalog, { held: new Set(), isMac: false }),
  'zone-clear-in',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'o', shiftKey: true }), catalog, { held: new Set(), isMac: false }),
  'zone-clear-out',
);
assert.strictEqual(matchShortcut(keyN({ key: '[' }), catalog, { held: new Set(), isMac: false }), 'select-before-playhead');
assert.strictEqual(matchShortcut(keyN({ key: ']' }), catalog, { held: new Set(), isMac: false }), 'select-after-playhead');
assert.strictEqual(matchShortcut(keyN({ key: '[', shiftKey: true }), catalog, { held: new Set(), isMac: false }), 'select-track-before-playhead');
assert.strictEqual(matchShortcut(keyN({ key: '{', shiftKey: true }), catalog, { held: new Set(), isMac: false }), 'select-track-before-playhead');
assert.strictEqual(matchShortcut(keyN({ key: ']', shiftKey: true }), catalog, { held: new Set(), isMac: false }), 'select-track-after-playhead');
assert.strictEqual(matchShortcut(keyN({ key: '}', shiftKey: true }), catalog, { held: new Set(), isMac: false }), 'select-track-after-playhead');
assert.strictEqual(matchShortcut(keyN({ key: 'y' }), catalog, { held: new Set(), isMac: false }), 'select-after');
assert.strictEqual(
  matchShortcut(keyN({ key: 'k', metaKey: true, altKey: true }), catalog, { held: new Set(), isMac: true }),
  'keyboard-shortcuts',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'v', metaKey: true, altKey: true }), catalog, { held: new Set(), isMac: true }),
  'paste-effects',
);
// combo K+J
assert.strictEqual(
  matchShortcut(keyN({ key: 'j' }), catalog, { held: new Set(['k']), isMac: true }),
  'shuttle-jog-back',
);
// Windows IME key/code fallback for Ctrl+B
assert.strictEqual(
  matchShortcut(keyN({ key: 'Process', code: 'KeyB', ctrlKey: true }), catalog, { held: new Set(), isMac: false }),
  'split',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'Unidentified', code: 'KeyB', ctrlKey: true }), catalog, { held: new Set(), isMac: false }),
  'split',
);
assert.strictEqual(
  matchShortcut(keyN({ key: 'β', code: 'KeyB', ctrlKey: true }), catalog, { held: new Set(), isMac: false }),
  'split',
);

console.log('shortcuts catalog.verify: ok');
