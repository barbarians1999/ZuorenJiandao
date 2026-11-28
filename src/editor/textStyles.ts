import type { CSSProperties } from 'react';
import { runtimeFontFamily } from '../../shared/desktop-fonts';
import { isLoadableFontFamily, resolveCanonicalFamily } from '../fonts/googleFontCatalog';

export const TITLE_ANIMATIONS = [
  { id: 'none', label: '无' }, { id: 'fade', label: '淡入／淡出' },
  { id: 'slide-up', label: '上滑' }, { id: 'slide-down', label: '下滑' },
  { id: 'slide-left', label: '左滑' }, { id: 'slide-right', label: '右滑' },
  { id: 'scale', label: '缩放' }, { id: 'typewriter', label: '打字显现／擦除' },
  { id: 'wipe', label: '遮罩擦入／擦出' }, { id: 'blur', label: '柔焦显现／消失' },
  { id: 'spring', label: '弹性落定／收起' }, { id: 'tracking', label: '字距展开／收拢' },
] as const;
export type TextEntrance = typeof TITLE_ANIMATIONS[number]['id'];
export type TextAnchor = 'center' | 'top-left' | 'middle-left';
export type AccentBarPosition = 'none' | 'left' | 'top';

export interface ResolvedTextStyle {
  fontSize: number;
  fontWeight: number;
  color: string;
  text?: string;
  align?: 'left' | 'center' | 'right';
  anchor: TextAnchor;
  fontFamily: 'sans-serif' | 'serif' | 'monospace' | string;
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline';
  letterSpacing: number;
  lineHeight: number;
  strokeColor: string;
  strokeWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundPadding: number;
  backgroundPaddingX: number;
  backgroundPaddingY: number;
  backgroundRadius: number;
  accentBarPosition: AccentBarPosition;
  accentBarColor: string;
  accentBarWidth: number;
  entrance: TextEntrance;
  entranceFrames: number;
  exit: TextEntrance;
  exitFrames: number;
  strikeAnimated: boolean;
  strikeColor: string;
  strikeThickness: number;
  strikeStartSec: number;
  strikeDurationSec: number;
}

export interface TextStylePreset {
  id: string;
  label: string;
  patch: Partial<ResolvedTextStyle>;
}

export const TEXT_STYLE_PRESETS: readonly TextStylePreset[] = [
  { id: 'clean', label: '简洁', patch: { fontFamily: 'sans-serif', fontStyle: 'normal', textDecoration: 'none', lineHeight: 1.2, strokeWidth: 0, shadowEnabled: true, shadowColor: 'rgba(0,0,0,0.55)', shadowOpacity: 55, shadowBlur: 16, shadowOffsetX: 0, shadowOffsetY: 3, backgroundOpacity: 0, backgroundPadding: 0, backgroundPaddingX: 0, backgroundPaddingY: 0, backgroundRadius: 0, accentBarPosition: 'none' } },
  { id: 'outlined', label: '描边标题', patch: { fontFamily: 'sans-serif', fontWeight: 800, strokeColor: '#111111', strokeWidth: 5, shadowEnabled: false, backgroundOpacity: 0, backgroundPadding: 0, backgroundPaddingX: 0, backgroundPaddingY: 0, accentBarPosition: 'none' } },
  { id: 'boxed', label: '色块标题', patch: { fontFamily: 'sans-serif', fontWeight: 800, strokeWidth: 0, shadowEnabled: false, backgroundColor: '#111111', backgroundOpacity: 86, backgroundPadding: 22, backgroundPaddingX: 22, backgroundPaddingY: 22, backgroundRadius: 14, accentBarPosition: 'none' } },
  { id: 'lower-third', label: '下三分之一', patch: { fontFamily: 'sans-serif', fontWeight: 700, strokeWidth: 0, shadowEnabled: false, backgroundColor: '#0b0b0b', backgroundOpacity: 82, backgroundPadding: 16, backgroundPaddingX: 18, backgroundPaddingY: 12, backgroundRadius: 6, accentBarPosition: 'left', accentBarColor: '#d4af37', accentBarWidth: 4, entrance: 'slide-left', entranceFrames: 12, exit: 'fade', exitFrames: 8 } },
  { id: 'archival-tag', label: '深色词条卡', patch: { fontFamily: 'sans-serif', fontWeight: 700, color: '#fff8ee', strokeWidth: 0, shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 42, shadowBlur: 20, shadowOffsetX: 0, shadowOffsetY: 8, backgroundColor: '#1c1816', backgroundOpacity: 88, backgroundPadding: 16, backgroundPaddingX: 22, backgroundPaddingY: 12, backgroundRadius: 6, accentBarPosition: 'left', accentBarColor: '#d4af37', accentBarWidth: 4 } },
  { id: 'archival-top-tag', label: '顶部色条卡', patch: { fontFamily: 'sans-serif', fontWeight: 700, color: '#1c1816', strokeWidth: 0, shadowEnabled: true, shadowColor: '#000000', shadowOpacity: 30, shadowBlur: 18, shadowOffsetX: 0, shadowOffsetY: 6, backgroundColor: '#f4ecda', backgroundOpacity: 94, backgroundPadding: 18, backgroundPaddingX: 24, backgroundPaddingY: 14, backgroundRadius: 8, accentBarPosition: 'top', accentBarColor: '#a62121', accentBarWidth: 4 } },
  { id: 'refute-strike', label: '动态划线批驳', patch: { fontWeight: 800, strikeAnimated: true, strikeColor: '#c83228', strikeThickness: 7, strikeStartSec: 0.4, strikeDurationSec: 0.35 } },
];

const presetById = new Map(TEXT_STYLE_PRESETS.map((preset) => [preset.id, preset]));

const number = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const string = (value: unknown, fallback: string): string => typeof value === 'string' && value ? value : fallback;

const HEX_COLOR_RE = /^#([\da-f]{3}|[\da-f]{6})$/i;

function resolveCanonicalOrRawFont(raw: string): string {
  const canonical = resolveCanonicalFamily(raw);
  return canonical ?? raw;
}

function normalizeOpacityPercent(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const pct = n > 0 && n < 1 ? Math.round(n * 1000) / 10 : n;
  return Math.max(0, Math.min(100, pct));
}

function extractColorAlphaPercent(color: string): number {
  const trimmed = color.trim();
  if (!trimmed || trimmed.toLowerCase() === 'transparent') return 0;
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) {
    return Math.round((Number.parseInt(trimmed.slice(7, 9), 16) / 255) * 1000) / 10;
  }
  if (/^#[0-9a-f]{4}$/i.test(trimmed)) {
    return Math.round((Number.parseInt(trimmed[4]! + trimmed[4]!, 16) / 255) * 1000) / 10;
  }
  const rgbaMatch = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i.exec(trimmed);
  if (rgbaMatch) {
    const a = Number(rgbaMatch[1]);
    if (Number.isFinite(a)) return Math.max(0, Math.min(100, Math.round(a * 1000) / 10));
  }
  return 100;
}

export function toColorPickerHex(color: string, fallback = '#111111'): string {
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(trimmed)) return trimmed.slice(0, 7).toLowerCase();
  if (/^#[0-9a-f]{3,4}$/i.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
  }
  const rgbMatch = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(trimmed);
  if (rgbMatch) {
    const hexByte = (raw: string) => Math.max(0, Math.min(255, Math.round(Number(raw)))).toString(16).padStart(2, '0');
    return `#${hexByte(rgbMatch[1]!)}${hexByte(rgbMatch[2]!)}${hexByte(rgbMatch[3]!)}`;
  }
  return fallback;
}

export function resolveTextStyle(props: Record<string, unknown> = {}): ResolvedTextStyle & { fontSize: number; fontWeight: number; color: string; text: string; align: 'left' | 'center' | 'right' } {
  const preset = typeof props.textStylePreset === 'string' ? presetById.get(props.textStylePreset) : undefined;
  const merged = { ...preset?.patch, ...props };
  const rawFamily = string(merged.fontFamily, 'Geist, system-ui, -apple-system, sans-serif');
  const resolvedFamily = typeof props.fontAssetId === 'string' && props.fontAssetId
    ? rawFamily
    : resolveCanonicalOrRawFont(rawFamily);
  const fontFamily = runtimeFontFamily(resolvedFamily,
    typeof props.fontAssetId === 'string' ? props.fontAssetId : undefined);
  const anchor: TextAnchor = merged.anchor === 'top-left' || merged.anchor === 'middle-left' ? merged.anchor : 'center';
  const defaultAlign: 'left' | 'center' | 'right' = anchor === 'center' ? 'center' : 'left';
  const align = merged.align === 'left' || merged.align === 'right' || merged.align === 'center'
    ? merged.align
    : defaultAlign;
  const backgroundPadding = number(merged.backgroundPadding, 0, 0, 160);
  const backgroundPaddingX = merged.backgroundPaddingX !== undefined
    ? number(merged.backgroundPaddingX, backgroundPadding, 0, 160)
    : backgroundPadding;
  const backgroundPaddingY = merged.backgroundPaddingY !== undefined
    ? number(merged.backgroundPaddingY, backgroundPadding, 0, 120)
    : backgroundPadding;
  const accentBarPosition: AccentBarPosition =
    merged.accentBarPosition === 'left' || merged.accentBarPosition === 'top'
      ? merged.accentBarPosition
      : 'none';
  const shadowColor = string(merged.shadowColor, 'rgba(0,0,0,0.55)');
  const shadowOpacity = merged.shadowOpacity !== undefined
    ? normalizeOpacityPercent(merged.shadowOpacity, 55)
    : (HEX_COLOR_RE.test(shadowColor.trim()) ? 55 : 100);
  const hasExplicitBgColor = typeof merged.backgroundColor === 'string'
    && merged.backgroundColor.trim().length > 0
    && merged.backgroundColor.trim().toLowerCase() !== 'transparent';
  const backgroundOpacity = merged.backgroundOpacity !== undefined
    ? normalizeOpacityPercent(merged.backgroundOpacity, 0)
    : (hasExplicitBgColor ? extractColorAlphaPercent(String(merged.backgroundColor)) : 0);
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
    shadowColor,
    shadowOpacity,
    shadowBlur: number(merged.shadowBlur, 16, 0, 80),
    shadowOffsetX: number(merged.shadowOffsetX, 0, -80, 80),
    shadowOffsetY: number(merged.shadowOffsetY, 3, -80, 80),
    backgroundColor: string(merged.backgroundColor, '#111111'),
    backgroundOpacity,
    backgroundPadding,
    backgroundPaddingX,
    backgroundPaddingY,
    backgroundRadius: number(merged.backgroundRadius, 0, 0, 120),
    accentBarPosition,
    accentBarColor: string(merged.accentBarColor, '#d4af37'),
    accentBarWidth: number(merged.accentBarWidth, 4, 1, 24),
    entrance,
    entranceFrames: Math.round(number(merged.entranceFrames, 12, 1, 300)),
    exit,
    exitFrames: Math.round(number(merged.exitFrames, 12, 1, 300)),
    strikeAnimated: merged.strikeAnimated === true,
    strikeColor: string(merged.strikeColor, '#c83228'),
    strikeThickness: number(merged.strikeThickness, 6, 2, 24),
    strikeStartSec: number(merged.strikeStartSec, 0.4, 0, 60),
    strikeDurationSec: number(merged.strikeDurationSec, 0.35, 0.08, 5),
    fontSize: number(merged.fontSize, 96, 24, 300),
    fontWeight: number(merged.fontWeight, 700, 100, 900),
    color: string(merged.color, '#ffffff'),
    text: String(merged.text ?? '文字'),
    align,
    anchor,
  };
}

/** Normalize a text prop patch (expand textStylePreset, auto-scale 0..1 opacity, reveal card bg when color is chosen). */
export function prepareTextPropPatch(
  currentProps: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const presetId = typeof patch.textStylePreset === 'string' ? patch.textStylePreset : undefined;
  const presetPatch = presetId ? presetById.get(presetId)?.patch : undefined;
  const next: Record<string, unknown> = presetPatch ? { ...presetPatch, ...patch } : { ...patch };
  if (typeof next.backgroundOpacity === 'number' && Number.isFinite(next.backgroundOpacity) && next.backgroundOpacity > 0 && next.backgroundOpacity < 1) {
    next.backgroundOpacity = normalizeOpacityPercent(next.backgroundOpacity, 0);
  }
  if (typeof next.shadowOpacity === 'number' && Number.isFinite(next.shadowOpacity) && next.shadowOpacity > 0 && next.shadowOpacity < 1) {
    next.shadowOpacity = normalizeOpacityPercent(next.shadowOpacity, 55);
  }
  if (typeof next.backgroundColor === 'string' && next.backgroundOpacity === undefined) {
    const trimmed = next.backgroundColor.trim();
    if (trimmed && trimmed.toLowerCase() !== 'transparent') {
      const currentOpacity = currentProps ? resolveTextStyle(currentProps).backgroundOpacity : 0;
      if (currentOpacity <= 0) {
        next.backgroundOpacity = extractColorAlphaPercent(trimmed);
      }
    }
  }
  return next;
}

function colorWithOpacity(color: string, opacityPercent: number): string {
  const trimmed = color.trim();
  const alpha = Math.max(0, Math.min(1, opacityPercent / 100));
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    const r = Number.parseInt(trimmed.slice(1, 3), 16);
    const g = Number.parseInt(trimmed.slice(3, 5), 16);
    const b = Number.parseInt(trimmed.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${Number(alpha.toFixed(3))})`;
  }
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const r = Number.parseInt(trimmed[1]! + trimmed[1]!, 16);
    const g = Number.parseInt(trimmed[2]! + trimmed[2]!, 16);
    const b = Number.parseInt(trimmed[3]! + trimmed[3]!, 16);
    return `rgba(${r},${g},${b},${Number(alpha.toFixed(3))})`;
  }
  return trimmed;
}

export function textShadowValue(style: Pick<ResolvedTextStyle, 'shadowEnabled' | 'shadowColor' | 'shadowOpacity' | 'shadowBlur' | 'shadowOffsetX' | 'shadowOffsetY'>): string | undefined {
  if (!style.shadowEnabled || (style.shadowBlur === 0 && style.shadowOffsetX === 0 && style.shadowOffsetY === 0)) return undefined;
  return `${style.shadowOffsetX}px ${style.shadowOffsetY}px ${style.shadowBlur}px ${colorWithOpacity(style.shadowColor, style.shadowOpacity)}`;
}

export function textBackgroundColor(style: Pick<ResolvedTextStyle, 'backgroundColor' | 'backgroundOpacity'>): string | undefined {
  if (style.backgroundOpacity <= 0) return undefined;
  const raw = style.backgroundColor.trim();
  if (!raw || raw.toLowerCase() === 'transparent') return undefined;
  const alphaPct = Math.max(0, Math.min(100, style.backgroundOpacity));
  const alphaHex = Math.round(alphaPct * 2.55).toString(16).padStart(2, '0');
  if (/^#[0-9a-f]{6}$/i.test(raw)) return `${raw}${alphaHex}`;
  if (/^#[0-9a-f]{3}$/i.test(raw)) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}${alphaHex}`;
  if (/^#[0-9a-f]{8}$/i.test(raw)) return `${raw.slice(0, 7)}${alphaHex}`;
  const rgbMatch = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(raw);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]},${rgbMatch[2]},${rgbMatch[3]},${Number((alphaPct / 100).toFixed(3))})`;
  }
  return raw;
}

export const TEXT_ANCHOR_MARGIN_X = 96;
export const TEXT_ANCHOR_MARGIN_Y = 96;

/** Design-space origin point for anchor-locked text scaling/rotation. */
export function resolveTextAnchorDesignOrigin(
  dw: number,
  dh: number,
  anchor: TextAnchor,
): { x: number; y: number } {
  if (anchor === 'top-left') return { x: TEXT_ANCHOR_MARGIN_X, y: TEXT_ANCHOR_MARGIN_Y };
  if (anchor === 'middle-left') return { x: TEXT_ANCHOR_MARGIN_X, y: dh / 2 };
  return { x: dw / 2, y: dh / 2 };
}

/**
 * Compute `transform.x` / `transform.y` (% of canvas) needed to place a text
 * anchor point at a desired normalized canvas coordinate `(xRatio, yRatio)` in 0..1.
 */
export function resolveTextTransformForTarget(
  anchor: TextAnchor,
  target: { xRatio: number; yRatio: number },
  designSize?: { width?: number; height?: number },
): { x: number; y: number } {
  const dw = designSize?.width && designSize.width > 0 ? designSize.width : 1920;
  const dh = designSize?.height && designSize.height > 0 ? designSize.height : 1080;
  const origin = resolveTextAnchorDesignOrigin(dw, dh, anchor);
  return {
    x: Number(((target.xRatio - origin.x / dw) * 100).toFixed(4)),
    y: Number(((target.yRatio - origin.y / dh) * 100).toFixed(4)),
  };
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

export const ALLOWED_TEXT_PROP_KEYS = new Set<string>([
  'text',
  'fontFamily',
  'fontAssetId',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'color',
  'align',
  'anchor',
  'textDecoration',
  'letterSpacing',
  'lineHeight',
  'textStylePreset',
  'strokeColor',
  'strokeWidth',
  'shadowEnabled',
  'shadowColor',
  'shadowOpacity',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
  'backgroundColor',
  'backgroundOpacity',
  'backgroundPadding',
  'backgroundPaddingX',
  'backgroundPaddingY',
  'backgroundRadius',
  'accentBarPosition',
  'accentBarColor',
  'accentBarWidth',
  'entrance',
  'entranceFrames',
  'exit',
  'exitFrames',
  'visualEntrance',
  'visualExit',
  'visualEntranceFrames',
  'visualExitFrames',
  'visualEntranceWindow',
  'visualExitWindow',
  'strikeAnimated',
  'strikeColor',
  'strikeThickness',
  'strikeStartSec',
  'strikeDurationSec',
]);

const TEXT_FIELD_HINTS: Record<string, string> = {
  padding: 'Use backgroundPadding (or backgroundPaddingX / backgroundPaddingY) together with backgroundOpacity > 0.',
  paddingX: 'Use backgroundPaddingX together with backgroundOpacity > 0.',
  paddingY: 'Use backgroundPaddingY together with backgroundOpacity > 0.',
  bgColor: 'Use backgroundColor (defaults to visible opacity when backgroundOpacity is omitted) and backgroundOpacity (0..100).',
  background: 'Use backgroundColor (defaults to visible opacity when backgroundOpacity is omitted) and backgroundOpacity (0..100).',
  borderRadius: 'Use backgroundRadius for text card corner radius (transform.borderRadius is for clip frame).',
  textAlign: 'Use align ("left" | "center" | "right").',
  anchorPoint: 'Use anchor ("center" origin 50%,50% | "top-left" origin 5%,8.89% | "middle-left" origin 5%,50%).',
  origin: 'Use anchor ("center" origin 50%,50% | "top-left" origin 5%,8.89% | "middle-left" origin 5%,50%).',
  borderColor: 'Use accentBarPosition ("left" | "top" | "none"), accentBarColor, and accentBarWidth.',
  borderLeft: 'Use accentBarPosition: "left", accentBarColor, and accentBarWidth.',
  borderTop: 'Use accentBarPosition: "top", accentBarColor, and accentBarWidth.',
  shadow: 'Use shadowEnabled, shadowColor, shadowOpacity, shadowBlur, shadowOffsetX, shadowOffsetY.',
  stroke: 'Use strokeColor and strokeWidth.',
  left: 'Use transform.x (% of canvas) relative to anchor origin: center→(tx-50), top-left/middle-left→(tx-5).',
  top: 'Use transform.y (% of canvas) relative to anchor origin: center/middle-left→(ty-50), top-left→(ty-8.89).',
  width: 'Text box width wraps automatically; scale via transform.scale or fontSize.',
  height: 'Text box height wraps automatically; scale via transform.scale or fontSize.',
};

const BUNDLED_UI_FONTS = new Set(['geist', 'ioskeleymono', 'ioskeley mono']);

export function validateTextClipProps(props: Record<string, unknown>): string | null {
  for (const key of Object.keys(props)) {
    if (!ALLOWED_TEXT_PROP_KEYS.has(key)) {
      const hint = TEXT_FIELD_HINTS[key];
      const supported = [...ALLOWED_TEXT_PROP_KEYS].join(', ');
      return hint
        ? `unsupported text prop "${key}": ${hint}`
        : `unsupported text prop "${key}" (not rendered on text clips). Supported: ${supported}`;
    }
  }
  if (props.anchor !== undefined && props.anchor !== 'center' && props.anchor !== 'top-left' && props.anchor !== 'middle-left') {
    return `text anchor must be "center", "top-left", or "middle-left" (got ${String(props.anchor)})`;
  }
  if (props.align !== undefined && props.align !== 'left' && props.align !== 'center' && props.align !== 'right') {
    return `text align must be "left", "center", or "right" (got ${String(props.align)})`;
  }
  if (props.accentBarPosition !== undefined && props.accentBarPosition !== 'none' && props.accentBarPosition !== 'left' && props.accentBarPosition !== 'top') {
    return `text accentBarPosition must be "none", "left", or "top" (got ${String(props.accentBarPosition)})`;
  }
  if (props.textStylePreset !== undefined && !presetById.has(String(props.textStylePreset))) {
    return `unknown textStylePreset "${String(props.textStylePreset)}". Supported: ${TEXT_STYLE_PRESETS.map((p) => p.id).join(', ')}`;
  }
  if (props.fontFamily !== undefined && props.fontAssetId === undefined) {
    const raw = String(props.fontFamily).trim();
    if (!raw) return 'text fontFamily cannot be empty';
    const first = raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
    if (!BUNDLED_UI_FONTS.has(first.toLowerCase()) && !isLoadableFontFamily(first)) {
      return `unsupported fontFamily "${raw}". Call search_fonts (supports Chinese aliases like "宋体" / "思源宋体") to choose a loadable font.`;
    }
  }
  for (const numKey of [
    'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'strokeWidth',
    'shadowOpacity', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
    'backgroundOpacity', 'backgroundPadding', 'backgroundPaddingX', 'backgroundPaddingY', 'backgroundRadius',
    'accentBarWidth', 'entranceFrames', 'exitFrames', 'strikeThickness', 'strikeStartSec', 'strikeDurationSec',
  ] as const) {
    if (props[numKey] !== undefined && (typeof props[numKey] !== 'number' || !Number.isFinite(props[numKey]))) {
      return `text prop "${numKey}" must be a finite number`;
    }
  }
  return null;
}
