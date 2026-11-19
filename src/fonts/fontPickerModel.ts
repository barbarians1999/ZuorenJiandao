import type { DesktopFontFace } from '../../shared/desktop-fonts';
import { fontAssetMetadata } from '../../shared/desktop-fonts';
import type { MediaAsset } from '../editor/mediaTypes';
import { FONT_CATALOG } from './googleFontCatalog';
import { normalizeFontKey } from './localFonts';

export type FontPickerTab = 'bundled' | 'system' | 'imported' | 'favorite' | 'recent' | 'more';
export type FontPickerEntry = {
  key: string;
  label: string;
  family: string;
  aliases: string[];
  source: 'bundled' | 'google' | 'generic' | 'system' | 'imported';
  asset?: MediaAsset;
  face?: DesktopFontFace;
};

export function desktopFontKey(face: DesktopFontFace): string {
  return `${face.source}:${face.postscriptName}:${face.fullName}:${face.filename}:${face.faceIndex}`;
}

export function fontPickerEntries(assets: readonly MediaAsset[], faces: readonly DesktopFontFace[]): FontPickerEntry[] {
  const entries: FontPickerEntry[] = [
    ...FONT_CATALOG.map((font): FontPickerEntry => ({ key: `family:${font.family}`, family: font.family,
      label: font.aliases[0] ?? font.family, aliases: font.aliases, source: font.source })),
    ...(['sans-serif', 'serif', 'monospace'] as const).map((family, index): FontPickerEntry => ({
      key: `family:${family}`, family, label: ['默认黑体', '默认宋体', '默认等宽'][index]!, aliases: [], source: 'generic',
    })),
  ];
  for (const asset of assets) {
    const metadata = fontAssetMetadata(asset);
    if (!metadata) continue;
    entries.push({ key: `asset:${asset.id}`, family: metadata.family, label: metadata.fullName,
      aliases: [metadata.postscriptName, asset.sourceFilename ?? ''], source: 'imported', asset });
  }
  entries.push(...faces.map((face): FontPickerEntry => ({
    key: desktopFontKey(face), family: face.family, label: face.fullName,
    aliases: [face.postscriptName, face.filename], source: face.source, face,
  })));
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()];
}

export function filterFontEntries(entries: readonly FontPickerEntry[], tab: FontPickerTab, query: string,
  favorites: readonly string[], recent: readonly string[]): FontPickerEntry[] {
  const q = normalizeFontKey(query);
  const filtered = entries.filter((entry) => {
    const visible = tab === 'bundled' ? entry.source === 'bundled' || entry.source === 'generic'
      : tab === 'system' ? entry.source === 'system'
      : tab === 'imported' ? entry.source === 'imported'
      : tab === 'more' ? entry.source === 'google'
      : tab === 'favorite' ? favorites.includes(entry.key) : recent.includes(entry.key);
    return visible && (!q || [entry.label, entry.family, ...entry.aliases].some((name) => normalizeFontKey(name).includes(q)));
  });
  return tab === 'recent' ? filtered.sort((a, b) => recent.indexOf(a.key) - recent.indexOf(b.key)) : filtered;
}

export function nextFontRecent(current: readonly string[], key: string): string[] {
  return [key, ...current.filter((entry) => entry !== key)].slice(0, 20);
}

const PREFERENCE_KEYS = { favorite: 'cc.fonts.favorite.v1', recent: 'cc.fonts.recent.v1' } as const;
export function readFontPreference(kind: keyof typeof PREFERENCE_KEYS): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFERENCE_KEYS[kind]) ?? '[]');
    return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string').slice(0, 200) : [];
  } catch { return []; }
}
export function writeFontPreference(kind: keyof typeof PREFERENCE_KEYS, keys: readonly string[]): void {
  try { localStorage.setItem(PREFERENCE_KEYS[kind], JSON.stringify(keys)); } catch { /* session choices remain usable */ }
}
