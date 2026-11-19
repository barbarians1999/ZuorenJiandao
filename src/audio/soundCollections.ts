import { SOUND_EFFECTS } from './soundLibrary';

export interface SoundCollections { favorites: string[]; recent: string[]; }
const STORAGE_KEY = 'cc.sound.collections';
export const SOUND_COLLECTIONS_EVENT = 'cc:sound-collections';
const validIds = new Set(SOUND_EFFECTS.map((sound) => sound.id));
const RECENT_LIMIT = 40;
let sessionCollections: SoundCollections = { favorites: [], recent: [] };
let sessionOnly = false;
type SoundStorage = Pick<Storage, 'getItem' | 'setItem'>;

function localSoundStorage(): SoundStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function normalizeSoundCollections(value: unknown): SoundCollections {
  const source = value && typeof value === 'object' ? value as Partial<SoundCollections> : {};
  const ids = (input: unknown) => Array.isArray(input)
    ? [...new Set(input.filter((id): id is string => typeof id === 'string' && validIds.has(id)))] : [];
  return { favorites: ids(source.favorites), recent: ids(source.recent).slice(0, RECENT_LIMIT) };
}

export function readSoundCollections(storage = localSoundStorage()): SoundCollections {
  if (sessionOnly) return normalizeSoundCollections(sessionCollections);
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? normalizeSoundCollections(JSON.parse(raw)) : normalizeSoundCollections(sessionCollections);
  } catch { return normalizeSoundCollections(sessionCollections); }
}

export function writeSoundCollections(value: SoundCollections, storage = localSoundStorage()): boolean {
  sessionCollections = normalizeSoundCollections(value);
  let persisted = false;
  try {
    if (storage) { storage.setItem(STORAGE_KEY, JSON.stringify(sessionCollections)); persisted = true; }
  } catch { /* Keep choices available during this app session. */ }
  sessionOnly = !persisted;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SOUND_COLLECTIONS_EVENT));
  return persisted;
}

/** Preferences are UI metadata, never project edits or undo records. */
export function rememberSoundUse(id: string): void {
  if (!validIds.has(id)) return;
  const value = readSoundCollections();
  writeSoundCollections({ ...value, recent: [id, ...value.recent.filter((entry) => entry !== id)] });
}
