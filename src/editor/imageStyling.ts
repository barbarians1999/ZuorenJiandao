import type { CSSProperties } from 'react';

export type ArchivalBorderStyle = 'thin-paper' | 'dark-line' | 'none';
export type FadeSide = 'bottom' | 'top' | 'left' | 'right';

export interface ResolvedImageStyling {
  bottomFade: number;
  singleSideFade: number;
  fadeSide: FadeSide;
  edgeFade: number;
  dropShadow: boolean;
  dropShadowBlur: number;
  dropShadowOffsetY: number;
  dropShadowOpacity: number;
  archivalCard: boolean;
  archivalTilt: number;
  archivalBw: number;
  archivalBorder: ArchivalBorderStyle;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const num = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
};

export function resolveImageStyling(props?: Record<string, unknown>): ResolvedImageStyling {
  const p = props ?? {};
  const borderRaw = p.archivalBorder;
  const archivalBorder: ArchivalBorderStyle =
    borderRaw === 'dark-line' || borderRaw === 'none' || borderRaw === 'thin-paper'
      ? borderRaw
      : 'thin-paper';
  const fadeSide: FadeSide =
    p.fadeSide === 'top' || p.fadeSide === 'left' || p.fadeSide === 'right'
      ? p.fadeSide
      : 'bottom';
  const bottomFade = num(p.bottomFade, 0, 0, 80);
  const singleSideFade = p.singleSideFade !== undefined ? num(p.singleSideFade, 0, 0, 80) : bottomFade;
  return {
    bottomFade,
    singleSideFade,
    fadeSide,
    edgeFade: num(p.edgeFade, 0, 0, 40),
    dropShadow: p.dropShadow === true,
    dropShadowBlur: num(p.dropShadowBlur, 26, 0, 80),
    dropShadowOffsetY: num(p.dropShadowOffsetY, 12, -40, 60),
    dropShadowOpacity: num(p.dropShadowOpacity, 45, 0, 100),
    archivalCard: p.archivalCard === true,
    archivalTilt: num(p.archivalTilt, -2.5, -12, 12),
    archivalBw: num(p.archivalBw, 100, 0, 100),
    archivalBorder,
  };
}

export function hasActiveImageStyling(props?: Record<string, unknown>): boolean {
  const s = resolveImageStyling(props);
  return s.singleSideFade > 0 || s.bottomFade > 0 || s.edgeFade > 0 || s.dropShadow || s.archivalCard;
}

const FADE_GRADIENT_DIR: Record<FadeSide, string> = {
  bottom: 'to bottom',
  top: 'to top',
  left: 'to left',
  right: 'to right',
};

export function buildImageMaskStyle(s: ResolvedImageStyling): CSSProperties | undefined {
  const masks: string[] = [];
  const sideFade = s.singleSideFade > 0 ? s.singleSideFade : s.bottomFade;
  if (sideFade > 0) {
    const solidStop = Math.max(0, 100 - sideFade);
    masks.push(`linear-gradient(${FADE_GRADIENT_DIR[s.fadeSide]}, #000 0%, #000 ${solidStop}%, rgba(0,0,0,0) 100%)`);
  }
  if (s.edgeFade > 0) {
    const edge = s.edgeFade;
    const inner = Math.max(edge, 100 - edge);
    masks.push(
      `linear-gradient(to right, rgba(0,0,0,0) 0%, #000 ${edge}%, #000 ${inner}%, rgba(0,0,0,0) 100%)`,
    );
    masks.push(
      `linear-gradient(to bottom, rgba(0,0,0,0) 0%, #000 ${edge}%, #000 ${inner}%, rgba(0,0,0,0) 100%)`,
    );
  }
  if (!masks.length) return undefined;
  const maskImage = masks.join(', ');
  const compositeProps = masks.length > 1
    ? {
        maskComposite: masks.slice(1).map(() => 'intersect').join(', '),
        WebkitMaskComposite: masks.slice(1).map(() => 'source-in').join(', '),
      }
    : {};
  return {
    maskImage,
    WebkitMaskImage: maskImage,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    ...compositeProps,
  } as CSSProperties;
}

export function buildImageInnerStyle(s: ResolvedImageStyling): CSSProperties | undefined {
  if (!s.dropShadow && !s.archivalCard) return undefined;
  const filters: string[] = [];
  if (s.archivalCard && s.archivalBw > 0) {
    const ratio = s.archivalBw / 100;
    const contrast = 1 + 0.22 * ratio;
    const sepia = 0.08 * ratio;
    filters.push(`grayscale(${s.archivalBw}%) contrast(${contrast.toFixed(2)}) sepia(${sepia.toFixed(2)})`);
  }
  if (s.dropShadow) {
    const alpha = (s.dropShadowOpacity / 100).toFixed(2);
    filters.push(`drop-shadow(0 ${s.dropShadowOffsetY}px ${s.dropShadowBlur}px rgba(0,0,0,${alpha}))`);
  }
  const border = !s.archivalCard
    ? undefined
    : s.archivalBorder === 'thin-paper'
      ? '2px solid rgba(244, 236, 218, 0.85)'
      : s.archivalBorder === 'dark-line'
        ? '2px solid rgba(28, 24, 22, 0.65)'
        : undefined;
  return {
    ...(filters.length ? { filter: filters.join(' ') } : {}),
    ...(s.archivalCard
      ? {
          transform: `rotate(${s.archivalTilt}deg) scale(0.92)`,
          transformOrigin: '50% 50%',
          border,
          boxSizing: 'border-box',
          boxShadow: '0 18px 44px rgba(0, 0, 0, 0.46), 0 4px 12px rgba(0, 0, 0, 0.26)',
        }
      : {}),
  };
}

export const ALLOWED_IMAGE_STYLING_KEYS = new Set<string>([
  'bottomFade',
  'singleSideFade',
  'fadeSide',
  'edgeFade',
  'dropShadow',
  'dropShadowBlur',
  'dropShadowOffsetY',
  'dropShadowOpacity',
  'archivalCard',
  'archivalTilt',
  'archivalBw',
  'archivalBorder',
  'visualEntrance',
  'visualExit',
  'visualEntranceFrames',
  'visualExitFrames',
  'visualEntranceWindow',
  'visualExitWindow',
]);

export function validateImageStylingProps(props: Record<string, unknown>): string | null {
  for (const key of Object.keys(props)) {
    if (!ALLOWED_IMAGE_STYLING_KEYS.has(key)) {
      return `unsupported visual prop "${key}". Supported: ${[...ALLOWED_IMAGE_STYLING_KEYS].join(', ')}`;
    }
  }
  if (props.fadeSide !== undefined && props.fadeSide !== 'bottom' && props.fadeSide !== 'top' && props.fadeSide !== 'left' && props.fadeSide !== 'right') {
    return `fadeSide must be "bottom", "top", "left", or "right" (got ${String(props.fadeSide)})`;
  }
  if (props.archivalBorder !== undefined && props.archivalBorder !== 'thin-paper' && props.archivalBorder !== 'dark-line' && props.archivalBorder !== 'none') {
    return `archivalBorder must be "thin-paper", "dark-line", or "none" (got ${String(props.archivalBorder)})`;
  }
  for (const [k, min, max] of [
    ['bottomFade', 0, 80],
    ['singleSideFade', 0, 80],
    ['edgeFade', 0, 40],
    ['dropShadowBlur', 0, 80],
    ['dropShadowOffsetY', -40, 60],
    ['dropShadowOpacity', 0, 100],
    ['archivalTilt', -12, 12],
    ['archivalBw', 0, 100],
  ] as const) {
    if (props[k] !== undefined) {
      const v = props[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
        return `${k} must be a finite number in ${min}..${max}`;
      }
    }
  }
  for (const b of ['dropShadow', 'archivalCard'] as const) {
    if (props[b] !== undefined && typeof props[b] !== 'boolean') {
      return `${b} must be a boolean`;
    }
  }
  return null;
}
