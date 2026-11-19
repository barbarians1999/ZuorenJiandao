import type { CSSProperties } from 'react';
import { runtimeFontFamily } from '../../shared/desktop-fonts';

export const TITLE_ANIMATIONS = [
  { id: 'none', label: '无' }, { id: 'fade', label: '淡入／淡出' },
  { id: 'slide-up', label: '上滑' }, { id: 'slide-down', label: '下滑' },
  { id: 'slide-left', label: '左滑' }, { id: 'slide-right', label: '右滑' },
  { id: 'scale', label: '缩放' }, { id: 'typewriter', label: '打字显现／擦除' },
  { id: 'wipe', label: '遮罩擦入／擦出' }, { id: 'blur', label: '柔焦显现／消失' },
  { id: 'spring', label: '弹性落定／收起' }, { id: 'tracking', label: '字距展开／收拢' },
] as const;
export type TextEntrance = typeof TITLE_ANIMATIONS[number]['id'];

export interface ResolvedTextStyle {
  fontSize: number;
  fontWeight: number;
  color: string;
  text?: string;
  align?: 'left' | 'center' | 'right';
  fontFamily: 'sans-serif' | 'serif' | 'monospace' | string;
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline';
  letterSpacing: number;
  lineHeight: number;
  strokeColor: string;
  strokeWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundPadding: number;
  backgroundRadius: number;
  entrance: TextEntrance;
  entranceFrames: number;
  exit: TextEntrance;
  exitFrames: number;
}

export interface TextStylePreset {
  id: string;
  label: string;
  patch: Partial<ResolvedTextStyle>;
}

export const TEXT_STYLE_PRESETS: readonly TextStylePreset[] = [
  { id: 'clean', label: '简洁', patch: { fontFamily: 'sans-serif', fontStyle: 'normal', textDecoration: 'none', lineHeight: 1.2, strokeWidth: 0, shadowEnabled: true, shadowBlur: 16, shadowOffsetX: 0, shadowOffsetY: 3, backgroundOpacity: 0, backgroundPadding: 0, backgroundRadius: 0 } },
  { id: 'outlined', label: '描边标题', patch: { fontFamily: 'sans-serif', fontWeight: 800, strokeColor: '#111111', strokeWidth: 5, shadowEnabled: false, backgroundOpacity: 0, backgroundPadding: 0 } },
  { id: 'boxed', label: '色块标题', patch: { fontFamily: 'sans-serif', fontWeight: 800, strokeWidth: 0, shadowEnabled: false, backgroundColor: '#111111', backgroundOpacity: 86, backgroundPadding: 22, backgroundRadius: 14 } },
  { id: 'lower-third', label: '下三分之一', patch: { fontFamily: 'sans-serif', fontWeight: 700, strokeWidth: 0, shadowEnabled: false, backgroundColor: '#0b0b0b', backgroundOpacity: 82, backgroundPadding: 16, backgroundRadius: 6, entrance: 'slide-left', entranceFrames: 12, exit: 'fade', exitFrames: 8 } },
];

const presetById = new Map(TEXT_STYLE_PRESETS.map((preset) => [preset.id, preset]));

const number = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const string = (value: unknown, fallback: string): string => typeof value === 'string' && value ? value : fallback;

export function resolveTextStyle(props: Record<string, unknown> = {}): ResolvedTextStyle & { fontSize: number; fontWeight: number; color: string; text: string; align: 'left' | 'center' | 'right' } {
  const preset = typeof props.textStylePreset === 'string' ? presetById.get(props.textStylePreset) : undefined;
  const merged = { ...preset?.patch, ...props };
  const fontFamily = runtimeFontFamily(string(merged.fontFamily, 'Geist, system-ui, -apple-system, sans-serif'),
    typeof props.fontAssetId === 'string' ? props.fontAssetId : undefined);
  const entrance = TITLE_ANIMATIONS.find((option) => option.id === merged.entrance)?.id ?? 'none';
  const exit = TITLE_ANIMATIONS.find((option) => option.id === merged.exit)?.id ?? 'none';
  return {
    fontFamily,
    fontStyle: merged.fontStyle === 'italic' ? 'italic' : 'normal',
    textDecoration: merged.textDecoration === 'underline' ? 'underline' : 'none',
    letterSpacing: number(merged.letterSpacing, 0, -10, 40),
    lineHeight: number(merged.lineHeight, 1.2, 0.6, 3),
    strokeColor: string(merged.strokeColor, '#111111'),
    strokeWidth: number(merged.strokeWidth, 0, 0, 30),
    shadowEnabled: merged.shadowEnabled !== false,
    shadowColor: string(merged.shadowColor, 'rgba(0,0,0,0.55)'),
    shadowBlur: number(merged.shadowBlur, 16, 0, 80),
    shadowOffsetX: number(merged.shadowOffsetX, 0, -80, 80),
    shadowOffsetY: number(merged.shadowOffsetY, 3, -80, 80),
    backgroundColor: string(merged.backgroundColor, '#111111'),
    backgroundOpacity: number(merged.backgroundOpacity, 0, 0, 100),
    backgroundPadding: number(merged.backgroundPadding, 0, 0, 120),
    backgroundRadius: number(merged.backgroundRadius, 0, 0, 120),
    entrance,
    entranceFrames: Math.round(number(merged.entranceFrames, 12, 1, 300)),
    exit,
    exitFrames: Math.round(number(merged.exitFrames, 12, 1, 300)),
    fontSize: number(merged.fontSize, 96, 24, 300),
    fontWeight: number(merged.fontWeight, 700, 100, 900),
    color: string(merged.color, '#ffffff'),
    text: String(merged.text ?? '文字'),
    align: merged.align === 'left' || merged.align === 'right' ? merged.align : 'center',
  };
}

export function textShadowValue(style: Pick<ResolvedTextStyle, 'shadowEnabled' | 'shadowColor' | 'shadowBlur' | 'shadowOffsetX' | 'shadowOffsetY'>): string | undefined {
  if (!style.shadowEnabled || style.shadowBlur === 0 && style.shadowOffsetX === 0 && style.shadowOffsetY === 0) return undefined;
  return `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlur}px ${style.shadowColor}`;
}

export function textBackgroundColor(style: Pick<ResolvedTextStyle, 'backgroundColor' | 'backgroundOpacity'>): string | undefined {
  if (style.backgroundOpacity <= 0) return undefined;
  const hex = style.backgroundColor.trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return `${hex}${Math.round(style.backgroundOpacity * 2.55).toString(16).padStart(2, '0')}`;
  return hex;
}

export function titleAnimationStyle(kind: TextEntrance, progress: number, letterSpacing = 0): CSSProperties {
  const p = Math.max(0, Math.min(1, progress));
  if (kind === 'wipe') return { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` };
  if (kind === 'blur') return { opacity: p, filter: `blur(${(1 - p) * 16}px)` };
  if (kind === 'tracking') return { opacity: p, letterSpacing: letterSpacing + (1 - p) * 24 };
  if (kind === 'spring') {
    const settle = p === 1 ? 1 : 1 - Math.pow(1 - p, 3) * Math.cos(p * Math.PI * 3);
    return { opacity: p, transform: `translateY(${(1 - settle) * 28}px) scale(${0.85 + settle * 0.15})` };
  }
  if (kind === 'fade') return { opacity: p };
  if (kind === 'scale') return { transform: `scale(${0.82 + p * 0.18})` };
  if (kind === 'slide-up') return { transform: `translateY(${(1 - p) * 100}%)` };
  if (kind === 'slide-down') return { transform: `translateY(${(p - 1) * 100}%)` };
  if (kind === 'slide-left') return { transform: `translateX(${(1 - p) * 100}%)` };
  if (kind === 'slide-right') return { transform: `translateX(${(p - 1) * 100}%)` };
  return {};
}

/** Keep grapheme clusters intact and the full text in layout while revealing. */
export function titleGraphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (entry) => entry.segment);
}

export function textStylePreset(id: string): Partial<ResolvedTextStyle> | undefined {
  return presetById.get(id)?.patch;
}
