export type PaperPresetId =
  | 'none'
  | 'custom'
  | 'crimson-archive'
  | 'warm-xuan'
  | 'charcoal-dossier'
  | 'ink-blueprint';

export interface PaperBackgroundPreset {
  id: Exclude<PaperPresetId, 'none' | 'custom'>;
  label: string;
  colors: readonly [string, string, string];
  lineColor: string;
  defaultGrain: number;
  defaultVignette: number;
  defaultAccentLine: boolean;
}

export const PAPER_BACKGROUND_PRESETS: readonly PaperBackgroundPreset[] = [
  {
    id: 'crimson-archive',
    label: '深红档案底',
    colors: ['#7f1418', '#5e0a0e', '#360507'],
    lineColor: '#d4af37',
    defaultGrain: 22,
    defaultVignette: 35,
    defaultAccentLine: true,
  },
  {
    id: 'warm-xuan',
    label: '暖黄宣纸底',
    colors: ['#f4ecda', '#eadec5', '#dbc8a8'],
    lineColor: '#a62121',
    defaultGrain: 20,
    defaultVignette: 28,
    defaultAccentLine: true,
  },
  {
    id: 'charcoal-dossier',
    label: '暗灰卷宗底',
    colors: ['#2e2b29', '#1d1b1a', '#111010'],
    lineColor: '#c7a454',
    defaultGrain: 22,
    defaultVignette: 35,
    defaultAccentLine: false,
  },
  {
    id: 'ink-blueprint',
    label: '靛青图纸底',
    colors: ['#20354a', '#152433', '#0c1620'],
    lineColor: '#d4af37',
    defaultGrain: 18,
    defaultVignette: 32,
    defaultAccentLine: true,
  },
];

const PRESET_MAP = new Map(PAPER_BACKGROUND_PRESETS.map((preset) => [preset.id, preset]));

export interface ResolvedPaperBackground {
  presetId: PaperPresetId;
  preset: PaperBackgroundPreset | null;
  isTextured: boolean;
  color: string;
  colors: readonly [string, string, string];
  lineColor: string;
  paperGrain: number;
  paperVignette: number;
  paperAccentLine: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const num = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
};

const pickHex = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.trim() ? value.trim() : fallback
);

export function resolvePaperBackground(props?: Record<string, unknown>): ResolvedPaperBackground {
  const p = props ?? {};
  const rawPreset = typeof p.paperPreset === 'string' ? p.paperPreset : 'none';
  const preset = rawPreset !== 'none' && rawPreset !== 'custom'
    ? PRESET_MAP.get(rawPreset as Exclude<PaperPresetId, 'none' | 'custom'>) ?? null
    : null;
  const hasCustomStops = typeof p.paperCenterColor === 'string' || typeof p.paperEdgeColor === 'string';
  const isCustom = rawPreset === 'custom' || (!preset && rawPreset !== 'none' && hasCustomStops);
  const presetId: PaperPresetId = preset ? preset.id : isCustom ? 'custom' : 'none';
  const midColor = pickHex(p.paperMidColor, pickHex(p.color, preset?.colors[1] ?? '#1a1a1a'));
  const centerColor = pickHex(p.paperCenterColor, preset?.colors[0] ?? midColor);
  const edgeColor = pickHex(p.paperEdgeColor, preset?.colors[2] ?? midColor);
  return {
    presetId,
    preset,
    isTextured: preset !== null || isCustom,
    color: midColor,
    colors: [centerColor, midColor, edgeColor],
    lineColor: pickHex(p.paperLineColor, preset?.lineColor ?? '#d4af37'),
    paperGrain: num(p.paperGrain, preset?.defaultGrain ?? 20, 0, 100),
    paperVignette: num(p.paperVignette, preset?.defaultVignette ?? 30, 0, 100),
    paperAccentLine: typeof p.paperAccentLine === 'boolean'
      ? p.paperAccentLine
      : (preset?.defaultAccentLine ?? false),
  };
}
