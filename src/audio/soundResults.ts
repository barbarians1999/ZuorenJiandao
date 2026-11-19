import { SOUND_GROUPS, type SoundEffect } from './soundLibrary';
import type { SoundCollections } from './soundCollections';

export const SOUND_FILTERS = { all: '__all__', popular: '__popular__', favorites: '__favorites__', recent: '__recent__' } as const;

export function matchesSoundQuery(sound: SoundEffect, query: string, displayName = sound.name): boolean {
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const tokens = normalize(query).split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean);
  if (!tokens.length) return true;
  const group = SOUND_GROUPS.find((entry) => entry.id === sound.group);
  const haystack = normalize([sound.name, displayName, sound.desc, sound.group,
    ...sound.keywords, group?.name ?? '', group?.nameEn ?? ''].join(' '));
  return tokens.every((token) => haystack.includes(token));
}

/** Apply an explicit browse filter after the caller's localized text search. */
export function filterSoundResults(matches: readonly SoundEffect[], filter: string, collections: SoundCollections): SoundEffect[] {
  const chosen = matches.filter((sound) => filter === SOUND_FILTERS.all
    || (filter === SOUND_FILTERS.popular ? sound.popular
      : filter === SOUND_FILTERS.favorites ? collections.favorites.includes(sound.id)
        : filter === SOUND_FILTERS.recent ? collections.recent.includes(sound.id) : sound.group === filter));
  return [...chosen].sort(filter === SOUND_FILTERS.recent
    ? (left, right) => collections.recent.indexOf(left.id) - collections.recent.indexOf(right.id)
    : (left, right) => left.order - right.order);
}
