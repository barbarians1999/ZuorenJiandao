// Skinning engine: design tokens live here and are injected before the app renders.
// The persistent cc.skin value is validated against the registry so stale IDs safely migrate.

export interface SkinTokens {
  bg: string;
  inset: string;
  panel: string;
  panelAlt: string;
  hover: string;
  border: string;
  borderLight: string;
  text: string;
  textMuted: string;
  textDim: string;
  textStrong: string;
  headingBg: string;
  headingInk: string;
  headingEdge: string;
  accent: string;
  accentDeep: string;
  accentRgb: string;
  onAccent: string;
  inkRgb: string;
  shadowRgb: string;
  colorScheme: 'dark' | 'light';
  gold: string;
  select: string;
  success: string;
  danger: string;
  tlTrack: string;
  tlSidePanel: string;
  trackVideo: string;
  trackAudioA1: string;
  trackAudioA2: string;
  trackCaption: string;
  clipVideo: string;
  clipAudio: string;
  clipMg: string;
  clipText: string;
}

export interface SkinDef {
  id: string;
  nameZh: string;
  tokens: SkinTokens;
}

// Timeline media colors stay balanced for darkroom and editorial clarity.
const MEDIA_COLORS = {
  trackVideo: '#35699e', trackAudioA1: '#d48b3b', trackAudioA2: '#429972', trackCaption: '#8b47a6',
  clipVideo: '#256c85', clipAudio: '#2b6b50', clipMg: '#a8466f', clipText: '#825711',
} as const;

const CONSTRUCTIVIST: SkinTokens = {
  bg: '#f4f1e8', inset: '#ece8dd', panel: '#fffdf8', panelAlt: '#f7f3e8', hover: '#eee9dc',
  border: '#c9c1b0', borderLight: '#9b927f',
  text: '#28241d', textMuted: '#4d463a', textDim: '#666052', textStrong: '#17140f',
  headingBg: '#b92c2b', headingInk: '#fffaf2', headingEdge: '#e2b52c',
  accent: '#e2b52c', accentDeep: '#be951d', accentRgb: '226,181,44', onAccent: '#191300',
  inkRgb: '25,19,0', shadowRgb: '54,45,26', colorScheme: 'light',
  gold: '#c39925', select: '#d5a900', success: '#277844', danger: '#c82020',
  tlTrack: '#f2eddf', tlSidePanel: '#f8f4e8', ...MEDIA_COLORS,
};

const GRAPHITE_CHAMPAGNE: SkinTokens = {
  bg: '#111214', inset: '#16171b', panel: '#1a1b1f', panelAlt: '#23252b', hover: '#2c2f37',
  border: '#272930', borderLight: '#363943',
  text: '#efeff2', textMuted: '#b5b8c2', textDim: '#8e929e', textStrong: '#ffffff',
  headingBg: '#e2b659', headingInk: '#181306', headingEdge: '#f2ce78',
  accent: '#e2b659', accentDeep: '#c89838', accentRgb: '226,182,89', onAccent: '#181306',
  inkRgb: '239,239,242', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e2b659', select: '#e2b659', success: '#4fbe84', danger: '#e85d56',
  tlTrack: '#151619', tlSidePanel: '#191a1e', ...MEDIA_COLORS,
};

const TEAL_OBSIDIAN: SkinTokens = {
  bg: '#111214', inset: '#16171b', panel: '#1a1b1f', panelAlt: '#23252b', hover: '#2c2f37',
  border: '#272930', borderLight: '#363943',
  text: '#efeff2', textMuted: '#b5b8c2', textDim: '#8e929e', textStrong: '#ffffff',
  headingBg: '#00c8d7', headingInk: '#061619', headingEdge: '#54e4ef',
  accent: '#00c8d7', accentDeep: '#00a3b3', accentRgb: '0,200,215', onAccent: '#061619',
  inkRgb: '239,239,242', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e2b659', select: '#00c8d7', success: '#4fbe84', danger: '#e85d56',
  tlTrack: '#151619', tlSidePanel: '#191a1e', ...MEDIA_COLORS,
};

const OBSIDIAN_BLUE: SkinTokens = {
  bg: '#0f1218', inset: '#141821', panel: '#181d27', panelAlt: '#212734', hover: '#2a3242',
  border: '#252c3b', borderLight: '#353e52',
  text: '#eef2f9', textMuted: '#b3bdd0', textDim: '#8b96ab', textStrong: '#ffffff',
  headingBg: '#63a4ff', headingInk: '#081224', headingEdge: '#96c2ff',
  accent: '#63a4ff', accentDeep: '#4283e0', accentRgb: '99,164,255', onAccent: '#081224',
  inkRgb: '238,242,249', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e2b659', select: '#63a4ff', success: '#4fbe84', danger: '#e85d56',
  tlTrack: '#131720', tlSidePanel: '#171b25', ...MEDIA_COLORS,
};

const AURORA_PURPLE: SkinTokens = {
  bg: '#121018', inset: '#16141f', panel: '#1b1825', panelAlt: '#252132', hover: '#302b40',
  border: '#2b2638', borderLight: '#3b354d',
  text: '#f1eef8', textMuted: '#bcb6cf', textDim: '#968fad', textStrong: '#ffffff',
  headingBg: '#b494ff', headingInk: '#130b26', headingEdge: '#d2beff',
  accent: '#b494ff', accentDeep: '#936ee8', accentRgb: '180,148,255', onAccent: '#130b26',
  inkRgb: '241,238,248', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e2b659', select: '#b494ff', success: '#4fbe84', danger: '#e85d56',
  tlTrack: '#15131d', tlSidePanel: '#191723', ...MEDIA_COLORS,
};

export const SKINS: readonly SkinDef[] = [
  { id: 'graphite-champagne', nameZh: '石墨香槟金', tokens: GRAPHITE_CHAMPAGNE },
  { id: 'teal-obsidian', nameZh: '青绿暗夜', tokens: TEAL_OBSIDIAN },
  { id: 'obsidian-blue', nameZh: '曜石深蓝', tokens: OBSIDIAN_BLUE },
  { id: 'aurora-purple', nameZh: '极光紫韵', tokens: AURORA_PURPLE },
  { id: 'constructivist', nameZh: '构成主义日间', tokens: CONSTRUCTIVIST },
];

const STORAGE_KEY = 'cc.skin';
export const DEFAULT_SKIN = 'graphite-champagne';

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function skinBlock(tokens: SkinTokens): string {
  return (Object.entries(tokens) as [string, string][])
    .map(([name, value]) => `  --cc-${kebab(name)}: ${value};`)
    .join('\n');
}

export function buildSkinsCss(): string {
  const base = SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0];
  const overrides = SKINS.filter((s) => s.id !== base.id)
    .map((s) => `html[data-cc-skin='${s.id}'] {\n${skinBlock(s.tokens)}\n}`)
    .join('\n');
  return `:root {\n${skinBlock(base.tokens)}\n}\n${overrides}\n` +
    'body { background: var(--cc-bg); color-scheme: var(--cc-color-scheme); }\n';
}

export function getSkin(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SKINS.some((s) => s.id === saved)) return saved;
  } catch { /* Storage may be unavailable. */ }
  return DEFAULT_SKIN;
}

export function applySkin(id: string): void {
  const skin = SKINS.some((s) => s.id === id) ? id : DEFAULT_SKIN;
  if (skin === DEFAULT_SKIN) delete document.documentElement.dataset.ccSkin;
  else document.documentElement.dataset.ccSkin = skin;
  try { localStorage.setItem(STORAGE_KEY, skin); } catch { /* Storage may be unavailable. */ }
}

export function initSkins(): void {
  if (!document.getElementById('cc-skins')) {
    const style = document.createElement('style');
    style.id = 'cc-skins';
    style.textContent = buildSkinsCss();
    document.head.appendChild(style);
  }
  applySkin(getSkin());
}
