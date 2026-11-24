// Pure-logic regression for the user keymap overlay. localStorage/navigator are absent
// under node — the module guards them (falls back to defaults / non-mac).
// Wired into verify:shortcuts (npm pretest).
import assert from 'node:assert';
import { SHORTCUT_CATALOG } from './catalog';
import {
  effectiveCatalog, effectiveMatchingCatalog, setBinding, resetBinding, resetAllBindings, isCustomized, customizedCount,
  chordFromEvent, findConflicts, getShortcutPreset, setShortcutPreset, presetCatalog, getCustomPresetBase,
} from './keymap';
import { matchShortcut } from './match';

const keysOf = (id: string): string => effectiveCatalog().find((a) => a.id === id)!.keys;

resetAllBindings();

// ── default overlay == catalog ──
assert.equal(customizedCount(), 0, 'no overrides initially');
assert.equal(keysOf('undo'), SHORTCUT_CATALOG.find((a) => a.id === 'undo')!.keys, 'undo default');

// ── override + persistence-shape + reset ──
setBinding('undo', 'Mod + Y');
assert.equal(keysOf('undo'), 'Mod + Y', 'override applied');
assert.equal(isCustomized('undo'), true, 'marked customized');
assert.equal(customizedCount(), 1, 'one override');
// unrelated action untouched
assert.equal(keysOf('play-pause'), 'Space', 'others unchanged');
resetBinding('undo');
assert.equal(keysOf('undo'), SHORTCUT_CATALOG.find((a) => a.id === 'undo')!.keys, 'reset restores default');
assert.equal(customizedCount(), 0, 'override cleared');

// ── chordFromEvent — inject the platform so the same contracts run on every CI host. ──
const ev = (o: Partial<KeyboardEvent>) => ({ key: 'a', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;
const macChord = (o: Partial<KeyboardEvent>) => chordFromEvent(ev(o), true);
assert.equal(macChord({ key: 'z', metaKey: true }), 'Mod + Z', 'mac: cmd+z → Mod + Z');
assert.equal(macChord({ key: 'z', metaKey: true, shiftKey: true }), 'Mod + Shift + Z', 'mac: cmd+shift+z');
assert.equal(macChord({ key: 'z', ctrlKey: true }), 'Ctrl + Z', 'mac: ctrl is distinct from Mod');
assert.equal(chordFromEvent(ev({ key: 'z', ctrlKey: true }), false), 'Mod + Z', 'non-mac: ctrl+z → Mod + Z');
assert.equal(chordFromEvent(ev({ key: 'z', metaKey: true }), false), 'Z', 'non-mac: meta is not Mod');
assert.equal(macChord({ key: 'k', altKey: true }), 'Alt + K', 'alt+k');
assert.equal(macChord({ key: ' ' }), 'Space', 'space');
assert.equal(macChord({ key: 'ArrowLeft' }), '←', 'arrow');
assert.equal(macChord({ key: 'Shift', shiftKey: true }), null, 'bare modifier → null');
assert.equal(macChord({ key: 'Escape' }), null, 'escape → null');

// ── conflict detection: another action bound to undo's chord conflicts with undo ──
const conflicts = findConflicts(SHORTCUT_CATALOG, 'play-pause', SHORTCUT_CATALOG.find((a) => a.id === 'undo')!.keys);
assert.ok(conflicts.some((c) => c.id === 'undo'), 'Mod+Z conflicts with undo');
// self is never a conflict
assert.ok(!findConflicts(SHORTCUT_CATALOG, 'undo', 'Mod + Z').some((c) => c.id === 'undo'), 'self excluded');
// a free chord has no conflicts
assert.equal(findConflicts(SHORTCUT_CATALOG, 'undo', 'Mod + Alt + Shift + Y').length, 0, 'free chord clean');

// A newly added group default may overlap an old explicit user binding.
// Real dispatch must keep that user binding, while settings retain catalog order.
const originalOrder = effectiveCatalog().map((entry) => entry.id);
const target = { tagName: 'DIV', isContentEditable: false, closest: () => null } as unknown as HTMLElement;
const groupKey = { ...ev({ key: 'g', ctrlKey: true }), target, repeat: false } as KeyboardEvent;
const context = { held: new Set<string>(), isMac: false };
setBinding('select-all', 'Mod + G');
assert.equal(matchShortcut(groupKey, effectiveMatchingCatalog(), context), 'select-all');
assert.deepEqual(effectiveCatalog().map((entry) => entry.id), originalOrder);
resetBinding('select-all');
assert.equal(matchShortcut(groupKey, effectiveMatchingCatalog(), context), 'group');
setBinding('group', 'Mod + Alt + G');
assert.equal(matchShortcut(groupKey, effectiveMatchingCatalog(), context), null);
assert.equal(matchShortcut({ ...groupKey, altKey: true }, effectiveMatchingCatalog(), context), 'group');

resetAllBindings();
assert.equal(getShortcutPreset(), 'jianying', 'default preset is jianying');
assert.equal(keysOf('interaction-mode-selection'), 'A', 'jianying selection mode is A');
assert.equal(keysOf('split'), 'Mod + B / C / Enter', 'jianying split default');

// ── Premiere Pro preset switch + conflict-free catalog ──
const premiereCat = presetCatalog('premiere');
for (const action of premiereCat) {
  assert.deepEqual(
    findConflicts(premiereCat, action.id, action.keys).map((c) => c.id),
    [],
    `premiere preset must stay conflict-free for ${action.id} (${action.keys})`,
  );
}
setShortcutPreset('premiere');
assert.equal(getShortcutPreset(), 'premiere');
assert.equal(keysOf('interaction-mode-selection'), 'V', 'premiere selection mode is V');
assert.equal(keysOf('interaction-mode-blade'), 'C', 'premiere razor blade is C');
assert.equal(keysOf('split'), 'Mod + K', 'premiere split is Mod + K');
assert.equal(keysOf('toggle-picture'), 'Shift + E', 'premiere toggle-picture is Shift + E');
assert.equal(keysOf('select-track-after-playhead'), 'A / Shift + ]', 'premiere track-select-right is A');
assert.equal(keysOf('select-track-before-playhead'), 'Shift + A / Shift + [', 'premiere track-select-left is Shift+A');
assert.equal(keysOf('interaction-mode-trim'), 'B', 'premiere ripple edit is B');
assert.equal(keysOf('interaction-mode-slip'), 'Y', 'premiere slip tool is Y');

setShortcutPreset('custom');
assert.equal(getCustomPresetBase(), 'premiere', 'first custom profile starts from the currently active preset');
assert.equal(keysOf('interaction-mode-selection'), 'V');
setShortcutPreset('premiere');

// Editing a binding while in Premiere switches into custom based on Premiere and preserves PR keys + custom overrides across preset switches.
setBinding('undo', 'Mod + Shift + U');
assert.equal(getShortcutPreset(), 'custom');
assert.equal(getCustomPresetBase(), 'premiere');
assert.equal(keysOf('undo'), 'Mod + Shift + U');
assert.equal(keysOf('interaction-mode-selection'), 'V');
setShortcutPreset('jianying');
assert.equal(keysOf('interaction-mode-selection'), 'A');
assert.equal(keysOf('undo'), 'Mod + Z');
setShortcutPreset('custom');
assert.equal(keysOf('undo'), 'Mod + Shift + U');
assert.equal(keysOf('interaction-mode-selection'), 'V');

resetAllBindings();
assert.equal(getShortcutPreset(), 'jianying');
assert.equal(customizedCount(), 0);
console.log('keymap.verify.ts OK');
