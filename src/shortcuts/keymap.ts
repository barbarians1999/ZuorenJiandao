// User keymap overlay for the shortcut system: the default preset (SHORTCUT_CATALOG)
// with per-action user rebindings applied, persisted to localStorage. The dispatcher matches
// against effectiveCatalog(); the settings dialog rebinds via setBinding/resetBinding. Kept
// pure of React so both can share it (a tiny listener store drives re-renders).
import { SHORTCUT_CATALOG, type ShortcutAction } from './catalog';
import { parseBindingAlts, normalizeKey, type ParsedChord } from './match';

const LS_KEY = 'cc.keymap.v1';
const LS_PRESET_KEY = 'cc.keymap.preset.v1';
const LS_CUSTOM_BASE_KEY = 'cc.keymap.customBase.v1';
type UserKeymap = Record<string, string>; // actionId → override binding string

export type BuiltinShortcutPresetId = 'jianying' | 'premiere';
export type ShortcutPresetId = BuiltinShortcutPresetId | 'custom';

export const SHORTCUT_PRESETS: ReadonlyArray<{ id: ShortcutPresetId; label: string; summary: string }> = [
  { id: 'jianying', label: '剪映', summary: 'A 选择 · B 刀片 · Ctrl+B 切分 · V 停用画面' },
  { id: 'premiere', label: 'PR', summary: 'V 选择 · C 剃刀 · Ctrl+K 切分 · A/Shift+A 单轨全选' },
  { id: 'custom', label: '自定义', summary: '基于当前方案微调，切换预设会保留你的自定义键位' },
];

const PREMIERE_PRESET_OVERRIDES: Readonly<Record<string, string>> = {
  'interaction-mode-selection': 'V',
  'interaction-mode-blade': 'C',
  'split': 'Mod + K',
  'interaction-mode-trim': 'B',
  'interaction-mode-slip': 'Y',
  'toggle-picture': 'Shift + E',
  'select-track-after-playhead': 'A / Shift + ]',
  'select-track-before-playhead': 'Shift + A / Shift + [',
  'select-after': 'Alt + Y',
  'zoom-in': '= / Mod + =',
  'zoom-out': '- / Mod + -',
  'zoom-fit': '\\ / Shift + Z',
  'nudge-left': 'Alt + ←',
  'nudge-right': 'Alt + →',
};

function readLS(): UserKeymap {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    // keep only known action ids with string bindings
    const known = new Set(SHORTCUT_CATALOG.map((a) => a.id));
    const out: UserKeymap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (known.has(k) && typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeLS(m: UserKeymap): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { /* private mode / quota */ }
}

function readPresetLS(hasOverrides: boolean): ShortcutPresetId {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_PRESET_KEY) : null;
    if (raw === 'jianying' || raw === 'premiere' || raw === 'custom') return raw;
  } catch { /* private mode / quota */ }
  return hasOverrides ? 'custom' : 'jianying';
}

function writePresetLS(preset: ShortcutPresetId): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_PRESET_KEY, preset); } catch { /* private mode / quota */ }
}

function readCustomBaseLS(): BuiltinShortcutPresetId {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_CUSTOM_BASE_KEY) : null;
    if (raw === 'premiere' || raw === 'jianying') return raw;
  } catch { /* private mode / quota */ }
  return 'jianying';
}

function writeCustomBaseLS(base: BuiltinShortcutPresetId): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_CUSTOM_BASE_KEY, base); } catch { /* private mode / quota */ }
}

let userKeymap: UserKeymap = readLS();
let activePreset: ShortcutPresetId = readPresetLS(Object.keys(userKeymap).length > 0);
let customBase: BuiltinShortcutPresetId = readCustomBaseLS();
let cache: ShortcutAction[] | null = null;
const listeners = new Set<() => void>();

function invalidate(): void {
  cache = null;
  for (const fn of listeners) fn();
}

/** Subscribe to keymap changes (returns an unsubscribe). Used by the settings dialog. */
export function subscribeKeymap(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getShortcutPreset(): ShortcutPresetId {
  return activePreset;
}

export function getCustomPresetBase(): BuiltinShortcutPresetId {
  return customBase;
}

export function setShortcutPreset(preset: ShortcutPresetId): void {
  if (activePreset === preset) return;
  if (preset === 'custom' && activePreset !== 'custom' && !Object.keys(userKeymap).length) {
    customBase = activePreset;
    writeCustomBaseLS(customBase);
  }
  activePreset = preset;
  writePresetLS(activePreset);
  invalidate();
}

export function presetCatalog(preset: BuiltinShortcutPresetId): ShortcutAction[] {
  if (preset === 'jianying') return SHORTCUT_CATALOG;
  return SHORTCUT_CATALOG.map((a) => (
    a.id in PREMIERE_PRESET_OVERRIDES ? { ...a, keys: PREMIERE_PRESET_OVERRIDES[a.id]! } : a
  ));
}

/** The catalog with active preset and user overrides applied (memoized until a binding changes). */
export function effectiveCatalog(): ShortcutAction[] {
  if (!cache) {
    if (activePreset === 'jianying') {
      cache = SHORTCUT_CATALOG;
    } else if (activePreset === 'premiere') {
      cache = presetCatalog('premiere');
    } else {
      cache = presetCatalog(customBase).map((a) => (a.id in userKeymap ? { ...a, keys: userKeymap[a.id]! } : a));
    }
  }
  return cache;
}

/** New default shortcuts must not shadow a user's existing explicit binding. */
export function effectiveMatchingCatalog(): ShortcutAction[] {
  if (activePreset !== 'custom') return [...effectiveCatalog()];
  return [...effectiveCatalog()].sort((a, b) => Number(b.id in userKeymap) - Number(a.id in userKeymap));
}

export function isCustomized(id: string): boolean { return activePreset === 'custom' && id in userKeymap; }
export function customizedCount(): number { return activePreset === 'custom' ? Object.keys(userKeymap).length : 0; }

export function setBinding(id: string, keys: string): void {
  const trimmed = keys.trim();
  if (!trimmed) return;
  if (activePreset !== 'custom') {
    userKeymap = customBase === activePreset ? { ...userKeymap, [id]: trimmed } : { [id]: trimmed };
    customBase = activePreset;
    activePreset = 'custom';
    writePresetLS(activePreset);
    writeCustomBaseLS(customBase);
  } else {
    userKeymap = { ...userKeymap, [id]: trimmed };
  }
  writeLS(userKeymap);
  invalidate();
}

export function resetBinding(id: string): void {
  if (activePreset !== 'custom' || !(id in userKeymap)) return;
  const next = { ...userKeymap };
  delete next[id];
  userKeymap = next;
  writeLS(userKeymap);
  invalidate();
}

export function resetAllBindings(): void {
  if (activePreset === 'jianying' && customBase === 'jianying' && !Object.keys(userKeymap).length) return;
  userKeymap = {};
  activePreset = 'jianying';
  customBase = 'jianying';
  writeLS(userKeymap);
  writePresetLS(activePreset);
  writeCustomBaseLS(customBase);
  invalidate();
}

const DISPLAY: Record<string, string> = {
  space: 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  backspace: 'Backspace', delete: 'Delete', enter: 'Enter', tab: 'Tab',
};

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function formatShortcutKeys(keys: string): string {
  return keys.replace(/\bMod\b/g, isMacPlatform() ? '⌘' : 'Ctrl');
}

/** Serialize a captured keydown → a canonical binding string ("Mod + Shift + Z"), or null
 *  for a bare modifier / Escape (not a usable single-key binding). Uses the same "Mod"
 *  convention the catalog + matcher use (⌘ on Mac, Ctrl elsewhere). `isMac` is injectable so
 *  verifies stay deterministic regardless of the host platform (navigator is absent under
 *  CI/node); callers that omit it keep the runtime platform probe. */
export function chordFromEvent(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, isMac?: boolean): string | null {
  const key = normalizeKey(e.key);
  if (['shift', 'control', 'alt', 'meta', 'escape', 'unidentified'].includes(key)) return null;
  const mac = isMac ?? isMacPlatform();
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key in DISPLAY ? DISPLAY[key]! : (key.length === 1 ? key.toUpperCase() : key));
  return parts.join(' + ');
}

// Signature that uniquely identifies a chord regardless of formatting, for conflict checks.
function chordSig(c: ParsedChord): string {
  return `${c.mod ? 'M' : ''}${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}:${c.key}${c.withKey ? '+' + c.withKey : ''}`;
}

/** Other actions in `catalog` whose binding collides with `keys` (any shared chord). */
export function findConflicts(catalog: ShortcutAction[], id: string, keys: string): ShortcutAction[] {
  const target = new Set(parseBindingAlts(keys).map(chordSig));
  if (!target.size) return [];
  return catalog.filter((a) => a.id !== id && parseBindingAlts(a.keys).some((c) => target.has(chordSig(c))));
}
