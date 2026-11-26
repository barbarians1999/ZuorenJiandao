// Skinning engine: design-language tokens and family metadata live here and are injected before first paint.
// Persistent cc.skin values are validated and migrated so removed legacy IDs resolve cleanly.

export type SkinFamilyId = 'liquid-glass' | 'constructivism' | 'material' | 'minimalism';
export type SkinMode = 'dark' | 'light';

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
  trackVideoInk: string;
  trackAudioInk: string;
  trackCaptionInk: string;
  clipVideo: string;
  clipAudio: string;
  clipMg: string;
  clipText: string;
  clipInk: string;
}

export interface SkinFamilyDef {
  id: SkinFamilyId;
  nameZh: string;
  taglineZh: string;
}

export interface SkinDef {
  id: string;
  family: SkinFamilyId;
  mode: SkinMode;
  nameZh: string;
  taglineZh: string;
  tokens: SkinTokens;
}

export const SKIN_FAMILIES: readonly SkinFamilyDef[] = [
  { id: 'liquid-glass', nameZh: '液态玻璃', taglineZh: '克制石墨/银白工作台 · 悬浮通透胶囊' },
  { id: 'constructivism', nameZh: '构成主义', taglineZh: '零圆角几何平面 · 朱红秩序标尺' },
  { id: 'material', nameZh: 'Material', taglineZh: '鼠尾草色阶层级 · 圆润胶囊与竖杠滑块' },
  { id: 'minimalism', nameZh: '极简主义', taglineZh: '哑光低噪画布 · 极细分隔与博朗橙点' },
];

const LIQUID_GLASS_DARK: SkinTokens = {
  bg: '#101114', inset: '#141519', panel: '#191a1e', panelAlt: '#24262c', hover: '#2e3139',
  border: '#2c2e36', borderLight: '#3c3f4a',
  text: '#f2f2f7', textMuted: '#b8b8be', textDim: '#929299', textStrong: '#ffffff',
  headingBg: '#006be6', headingInk: '#ffffff', headingEdge: '#5cb0ff',
  accent: '#3b9eff', accentDeep: '#006be6', accentRgb: '59,158,255', onAccent: '#071426',
  inkRgb: '242,242,247', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e6b84c', select: '#3b9eff', success: '#30d158', danger: '#ff453a',
  tlTrack: '#141518', tlSidePanel: '#191a1e',
  trackVideo: '#5ac8fa', trackAudioA1: '#30d158', trackAudioA2: '#64d2ff', trackCaption: '#bf5af2',
  trackVideoInk: '#071426', trackAudioInk: '#061f0d', trackCaptionInk: '#12061c',
  clipVideo: '#2a4c6b', clipAudio: '#245746', clipMg: '#6e3a50', clipText: '#563f73',
  clipInk: '#ffffff',
};

const LIQUID_GLASS_LIGHT: SkinTokens = {
  bg: '#e8ecf0', inset: '#eff1f5', panel: '#ffffff', panelAlt: '#f2f4f7', hover: '#e6e9ef',
  border: '#dcdfe5', borderLight: '#c4c9d2',
  text: '#1d1d1f', textMuted: '#515154', textDim: '#68686d', textStrong: '#000000',
  headingBg: '#006be6', headingInk: '#ffffff', headingEdge: '#4da3ff',
  accent: '#006be6', accentDeep: '#0055bd', accentRgb: '0,107,230', onAccent: '#ffffff',
  inkRgb: '29,29,31', shadowRgb: '15,23,36', colorScheme: 'light',
  gold: '#b88214', select: '#006be6', success: '#248a3d', danger: '#d70015',
  tlTrack: '#f5f6f8', tlSidePanel: '#ffffff',
  trackVideo: '#35699e', trackAudioA1: '#1f7a35', trackAudioA2: '#0b7ea8', trackCaption: '#7e48a6',
  trackVideoInk: '#ffffff', trackAudioInk: '#ffffff', trackCaptionInk: '#ffffff',
  clipVideo: '#3b6a94', clipAudio: '#2e755c', clipMg: '#8c4b65', clipText: '#684e8a',
  clipInk: '#ffffff',
};

const CONSTRUCTIVISM_DARK: SkinTokens = {
  bg: '#080807', inset: '#10100e', panel: '#161614', panelAlt: '#21201c', hover: '#2c2b25',
  border: '#3e3b33', borderLight: '#6a6558',
  text: '#f2ece0', textMuted: '#cfc8b8', textDim: '#a19988', textStrong: '#ffffff',
  headingBg: '#c8281c', headingInk: '#ffffff', headingEdge: '#e04235',
  accent: '#df3426', accentDeep: '#b82217', accentRgb: '223,52,38', onAccent: '#ffffff',
  inkRgb: '242,236,224', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#d49a2a', select: '#df3426', success: '#3c9673', danger: '#e84133',
  tlTrack: '#121210', tlSidePanel: '#181815',
  trackVideo: '#35699e', trackAudioA1: '#c88d22', trackAudioA2: '#55b592', trackCaption: '#d62f22',
  trackVideoInk: '#ffffff', trackAudioInk: '#141008', trackCaptionInk: '#ffffff',
  clipVideo: '#204664', clipAudio: '#245745', clipMg: '#8d5b0c', clipText: '#b8251a',
  clipInk: '#ffffff',
};

const CONSTRUCTIVISM_LIGHT: SkinTokens = {
  bg: '#e5dcc8', inset: '#ece4d2', panel: '#f5efe1', panelAlt: '#e9e0ce', hover: '#dfd3bc',
  border: '#141412', borderLight: '#3a3730',
  text: '#141412', textMuted: '#3a3730', textDim: '#524d43', textStrong: '#0a0a08',
  headingBg: '#c8281c', headingInk: '#ffffff', headingEdge: '#141412',
  accent: '#c8281c', accentDeep: '#a11e14', accentRgb: '200,40,28', onAccent: '#ffffff',
  inkRgb: '20,20,18', shadowRgb: '10,10,8', colorScheme: 'light',
  gold: '#a67012', select: '#c8281c', success: '#22664d', danger: '#c8281c',
  tlTrack: '#efe8d8', tlSidePanel: '#e8dfcc',
  trackVideo: '#204664', trackAudioA1: '#8f5e0c', trackAudioA2: '#245745', trackCaption: '#c8281c',
  trackVideoInk: '#ffffff', trackAudioInk: '#ffffff', trackCaptionInk: '#ffffff',
  clipVideo: '#204664', clipAudio: '#245745', clipMg: '#8d5b0c', clipText: '#b8251a',
  clipInk: '#ffffff',
};

const MATERIAL_DARK: SkinTokens = {
  bg: '#101412', inset: '#141a17', panel: '#19201c', panelAlt: '#232b26', hover: '#2c3731',
  border: '#2a352f', borderLight: '#3e4d44',
  text: '#e2eae4', textMuted: '#b6c5bb', textDim: '#92a69a', textStrong: '#f4faf6',
  headingBg: '#7fd1b2', headingInk: '#003828', headingEdge: '#c7e8d6',
  accent: '#7fd1b2', accentDeep: '#5ab896', accentRgb: '127,209,178', onAccent: '#003828',
  inkRgb: '226,234,228', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#e0b46a', select: '#7fd1b2', success: '#7fd1b2', danger: '#ff897d',
  tlTrack: '#141a17', tlSidePanel: '#19201c',
  trackVideo: '#5a9ec9', trackAudioA1: '#7fd1b2', trackAudioA2: '#d49a6a', trackCaption: '#b58ecc',
  trackVideoInk: '#091822', trackAudioInk: '#003828', trackCaptionInk: '#180b21',
  clipVideo: '#244f67', clipAudio: '#1b5440', clipMg: '#6f3a2c', clipText: '#563869',
  clipInk: '#ffffff',
};

const MATERIAL_LIGHT: SkinTokens = {
  bg: '#eaefe9', inset: '#e2eae3', panel: '#ffffff', panelAlt: '#edf3ee', hover: '#dde8df',
  border: '#d4dfd6', borderLight: '#b8c7ba',
  text: '#1a241e', textMuted: '#45564c', textDim: '#56685d', textStrong: '#0d1611',
  headingBg: '#196b52', headingInk: '#ffffff', headingEdge: '#c7e8d6',
  accent: '#196b52', accentDeep: '#12523e', accentRgb: '25,107,82', onAccent: '#ffffff',
  inkRgb: '26,36,30', shadowRgb: '14,34,22', colorScheme: 'light',
  gold: '#8a5300', select: '#196b52', success: '#196b52', danger: '#ba1a1a',
  tlTrack: '#f2f6f2', tlSidePanel: '#f8fbf8',
  trackVideo: '#2a628f', trackAudioA1: '#196b52', trackAudioA2: '#8a5300', trackCaption: '#76448a',
  trackVideoInk: '#ffffff', trackAudioInk: '#ffffff', trackCaptionInk: '#ffffff',
  clipVideo: '#2c5e7a', clipAudio: '#1d6b52', clipMg: '#8b4a39', clipText: '#6b4480',
  clipInk: '#ffffff',
};

const MINIMALISM_DARK: SkinTokens = {
  bg: '#0e0e0d', inset: '#1a1a18', panel: '#151514', panelAlt: '#1e1e1b', hover: '#272723',
  border: '#2a2a26', borderLight: '#3d3d37',
  text: '#ecece7', textMuted: '#b6b6ae', textDim: '#8e8e86', textStrong: '#ffffff',
  headingBg: '#ecece7', headingInk: '#141413', headingEdge: '#f25c22',
  accent: '#f25c22', accentDeep: '#d44812', accentRgb: '242,92,34', onAccent: '#141413',
  inkRgb: '236,236,231', shadowRgb: '0,0,0', colorScheme: 'dark',
  gold: '#f25c22', select: '#f25c22', success: '#4ca673', danger: '#f25c22',
  tlTrack: '#121211', tlSidePanel: '#151514',
  trackVideo: '#7b8794', trackAudioA1: '#658a76', trackAudioA2: '#8f8470', trackCaption: '#9b7b8c',
  trackVideoInk: '#111316', trackAudioInk: '#0e1712', trackCaptionInk: '#161013',
  clipVideo: '#2f353d', clipAudio: '#293830', clipMg: '#42352f', clipText: '#3a3340',
  clipInk: '#ffffff',
};

const MINIMALISM_LIGHT: SkinTokens = {
  bg: '#f1f1ec', inset: '#e9e9e3', panel: '#fafafa', panelAlt: '#f1f1ec', hover: '#e5e5de',
  border: '#dcdcd4', borderLight: '#c4c4bc',
  text: '#181816', textMuted: '#4e4e4a', textDim: '#686862', textStrong: '#0d0d0c',
  headingBg: '#181816', headingInk: '#fafafa', headingEdge: '#d9480f',
  accent: '#d9480f', accentDeep: '#b83a09', accentRgb: '217,72,15', onAccent: '#ffffff',
  inkRgb: '24,24,22', shadowRgb: '20,20,18', colorScheme: 'light',
  gold: '#c24614', select: '#d9480f', success: '#2c8a56', danger: '#d9480f',
  tlTrack: '#f5f5f1', tlSidePanel: '#fafafa',
  trackVideo: '#5a6470', trackAudioA1: '#4e6b5c', trackAudioA2: '#7a6c55', trackCaption: '#7d5868',
  trackVideoInk: '#ffffff', trackAudioInk: '#ffffff', trackCaptionInk: '#ffffff',
  clipVideo: '#525c68', clipAudio: '#486355', clipMg: '#755c52', clipText: '#665870',
  clipInk: '#ffffff',
};

export const SKINS: readonly SkinDef[] = [
  { id: 'liquid-glass-dark', family: 'liquid-glass', mode: 'dark', nameZh: '液态玻璃 · 夜间', taglineZh: '深石墨工作台 · 悬浮折射玻璃胶囊', tokens: LIQUID_GLASS_DARK },
  { id: 'liquid-glass-light', family: 'liquid-glass', mode: 'light', nameZh: '液态玻璃 · 日间', taglineZh: '银白工作台 · 通透微光胶囊', tokens: LIQUID_GLASS_LIGHT },
  { id: 'constructivism-dark', family: 'constructivism', mode: 'dark', nameZh: '构成主义 · 夜间', taglineZh: '玄黑红棱暗房 · 零圆角几何平面', tokens: CONSTRUCTIVISM_DARK },
  { id: 'constructivism-light', family: 'constructivism', mode: 'light', nameZh: '构成主义 · 日间', taglineZh: '米白纸张 · 朱红秩序标尺', tokens: CONSTRUCTIVISM_LIGHT },
  { id: 'material-dark', family: 'material', mode: 'dark', nameZh: 'Material · 夜间', taglineZh: '深林鼠尾草色阶 · 圆润胶囊推子', tokens: MATERIAL_DARK },
  { id: 'material-light', family: 'material', mode: 'light', nameZh: 'Material · 日间', taglineZh: '鼠尾草浅绿阶梯 · 竖杠表现滑块', tokens: MATERIAL_LIGHT },
  { id: 'minimalism-dark', family: 'minimalism', mode: 'dark', nameZh: '极简主义 · 夜间', taglineZh: '博朗哑光黑铝 · 细线分隔橙点', tokens: MINIMALISM_DARK },
  { id: 'minimalism-light', family: 'minimalism', mode: 'light', nameZh: '极简主义 · 日间', taglineZh: '哑光白画布 · 瑞士极细线条秩序', tokens: MINIMALISM_LIGHT },
];

const STORAGE_KEY = 'cc.skin';
export const DEFAULT_SKIN = 'liquid-glass-dark';

const LEGACY_MIGRATION: Record<string, string> = {
  'constructivist': 'constructivism-light',
  'constructivist-night': DEFAULT_SKIN,
  'graphite-champagne': DEFAULT_SKIN,
  'teal-obsidian': DEFAULT_SKIN,
  'obsidian-blue': DEFAULT_SKIN,
  'aurora-purple': DEFAULT_SKIN,
};

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function skinBlock(tokens: SkinTokens): string {
  const vars = (Object.entries(tokens) as [string, string][])
    .map(([name, value]) => `  --cc-${kebab(name)}: ${value};`);
  vars.push(`  --cc-accent-soft: rgba(${tokens.accentRgb}, 0.14);`);
  return vars.join('\n');
}

export function resolveSkinId(id: string | null | undefined): string {
  if (!id) return DEFAULT_SKIN;
  if (SKINS.some((s) => s.id === id)) return id;
  return LEGACY_MIGRATION[id] ?? DEFAULT_SKIN;
}

export function getSkinDef(id?: string): SkinDef {
  const resolved = resolveSkinId(id ?? getSkin());
  return SKINS.find((s) => s.id === resolved) ?? SKINS[0]!;
}

export function findSkinByFamilyAndMode(family: SkinFamilyId, mode: SkinMode): SkinDef {
  return SKINS.find((s) => s.family === family && s.mode === mode) ?? SKINS[0]!;
}

export function buildSkinsCss(): string {
  const base = SKINS.find((s) => s.id === DEFAULT_SKIN) ?? SKINS[0]!;
  const overrides = SKINS.filter((s) => s.id !== base.id)
    .map((s) => `html[data-cc-skin='${s.id}'] {\n${skinBlock(s.tokens)}\n}`)
    .join('\n');
  return `:root {\n${skinBlock(base.tokens)}\n}\n${overrides}\n` +
    'html, body { color-scheme: var(--cc-color-scheme); }\n' +
    'body { background: var(--cc-bg); }\n';
}

export function getSkin(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return resolveSkinId(saved);
  } catch { /* Storage may be unavailable. */ }
  return DEFAULT_SKIN;
}

export function applySkin(id: string): void {
  const skin = resolveSkinId(id);
  const def = getSkinDef(skin);
  if (skin === DEFAULT_SKIN) delete document.documentElement.dataset.ccSkin;
  else document.documentElement.dataset.ccSkin = skin;
  document.documentElement.dataset.ccSkinFamily = def.family;
  document.documentElement.dataset.ccSkinMode = def.mode;
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
