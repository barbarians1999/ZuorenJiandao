import type { TimelineItem, TimelineState } from '../../editor/types';
import { resolveTextAnchorDesignOrigin, resolveTextStyle, TEXT_ANCHOR_MARGIN_X, TEXT_ANCHOR_MARGIN_Y } from '../../editor/textStyles';
import type { PreviewPoint, PreviewRect } from './previewTransform';

const CJK_OR_FULLWIDTH_RE = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]/;
const NARROW_CHAR_RE = /^[\s.,:;!|'"`()[\]{}ilIjtfr1-]$/;
const WIDE_CHAR_RE = /^[A-ZMWQ@#%&*]$/;

type MeasureFn = (segment: string) => number;

let sharedCtx: CanvasRenderingContext2D | null | undefined;
const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function toGraphemes(text: string): string[] {
  if (!text) return [];
  if (segmenter) return Array.from(segmenter.segment(text), (entry) => entry.segment);
  return Array.from(text);
}

function getMeasureContext(font: string): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (sharedCtx === undefined) {
    try {
      const canvas = document.createElement('canvas');
      sharedCtx = canvas.getContext('2d');
    } catch {
      sharedCtx = null;
    }
  }
  if (sharedCtx) sharedCtx.font = font;
  return sharedCtx;
}

function fallbackGraphemeWidth(glyph: string, fontSize: number): number {
  if (CJK_OR_FULLWIDTH_RE.test(glyph)) return fontSize * 1.02;
  if (glyph.length > 1) return fontSize * 1.1; // Emoji / combined cluster
  if (NARROW_CHAR_RE.test(glyph)) return fontSize * 0.36;
  if (WIDE_CHAR_RE.test(glyph)) return fontSize * 0.72;
  return fontSize * 0.58;
}

function createLineMeasurer(style: ReturnType<typeof resolveTextStyle>): MeasureFn {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  const ctx = getMeasureContext(font);
  const tracking = style.letterSpacing;
  return (segment: string) => {
    if (!segment) return 0;
    const glyphs = toGraphemes(segment);
    const trackingExtra = Math.max(0, glyphs.length - 1) * tracking;
    if (ctx) {
      const measured = ctx.measureText(segment).width;
      if (Number.isFinite(measured) && measured > 0) {
        return Math.max(1, measured + trackingExtra);
      }
    }
    let width = 0;
    for (const glyph of glyphs) width += fallbackGraphemeWidth(glyph, style.fontSize);
    return Math.max(1, width + trackingExtra);
  };
}

function wrapParagraphWidth(paragraph: string, maxWidth: number, measure: MeasureFn): number[] {
  if (!paragraph) return [0];
  const fullWidth = measure(paragraph);
  if (fullWidth <= maxWidth) return [fullWidth];

  const glyphs = toGraphemes(paragraph);
  const widths: number[] = [];
  let current = '';
  for (const glyph of glyphs) {
    const candidate = current + glyph;
    if (current && measure(candidate) > maxWidth) {
      widths.push(measure(current));
      current = glyph === ' ' ? '' : glyph;
    } else {
      current = candidate;
    }
  }
  if (current || widths.length === 0) widths.push(measure(current));
  return widths;
}

export function resolveTextAnchorPoint(
  state: Pick<TimelineState, 'width' | 'height' | 'fit'>,
  item: Pick<TimelineItem, 'width' | 'height' | 'props'>,
): PreviewPoint {
  const canvasW = state.width;
  const canvasH = state.height;
  if (canvasW <= 0 || canvasH <= 0) return { x: 0, y: 0 };
  const dw = item.width && item.width > 0 ? item.width : 1920;
  const dh = item.height && item.height > 0 ? item.height : 1080;
  const fit = state.fit ?? 'contain';
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  const style = resolveTextStyle(item.props ?? {});
  const designOrigin = resolveTextAnchorDesignOrigin(dw, dh, style.anchor);
  return {
    x: canvasW / 2 + (designOrigin.x - dw / 2) * scale,
    y: canvasH / 2 + (designOrigin.y - dh / 2) * scale,
  };
}

/**
 * Compute the un-transformed design-space bounding box of a `kind === 'text'` item,
 * matching the `inline-block` text box rendered inside `TextLayer`.
 */
export function measureTextClipRect(
  state: Pick<TimelineState, 'width' | 'height' | 'fit'>,
  item: Pick<TimelineItem, 'width' | 'height' | 'props'>,
): PreviewRect {
  const canvasW = state.width;
  const canvasH = state.height;
  if (canvasW <= 0 || canvasH <= 0) return { x: 0, y: 0, width: 0, height: 0 };

  const dw = item.width && item.width > 0 ? item.width : 1920;
  const dh = item.height && item.height > 0 ? item.height : 1080;
  const fit = state.fit ?? 'contain';
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);

  const style = resolveTextStyle(item.props ?? {});
  const horizontalMargin = TEXT_ANCHOR_MARGIN_X;
  const innerWidth = Math.max(1, dw - horizontalMargin * 2);
  const padX = style.backgroundPaddingX;
  const padY = style.backgroundPaddingY;
  const accentLeft = style.accentBarPosition === 'left' ? style.accentBarWidth : 0;
  const accentTop = style.accentBarPosition === 'top' ? style.accentBarWidth : 0;
  const maxTextWidth = Math.max(1, innerWidth - padX * 2 - accentLeft);
  const measure = createLineMeasurer(style);

  const rawLines = (style.text ?? '').split(/\r?\n/);
  const wrappedWidths: number[] = [];
  for (const line of rawLines.length ? rawLines : ['']) {
    wrappedWidths.push(...wrapParagraphWidth(line, maxTextWidth, measure));
  }

  const lineCount = Math.max(1, wrappedWidths.length);
  const maxLineWidth = wrappedWidths.reduce((max, width) => Math.max(max, width), 0);
  const minTextWidth = Math.max(24, style.fontSize * 0.5);
  const boxWidth = Math.min(innerWidth, Math.max(minTextWidth, maxLineWidth) + padX * 2 + accentLeft);
  const boxHeight = Math.max(style.fontSize * style.lineHeight, lineCount * style.fontSize * style.lineHeight) + padY * 2 + accentTop;

  const isLeftAnchored = style.anchor === 'top-left' || style.anchor === 'middle-left';
  const boxX = isLeftAnchored || style.align === 'left'
    ? horizontalMargin
    : style.align === 'right'
      ? Math.max(horizontalMargin, dw - horizontalMargin - boxWidth)
      : horizontalMargin + Math.max(0, innerWidth - boxWidth) / 2;
  const boxY = style.anchor === 'top-left' ? TEXT_ANCHOR_MARGIN_Y : (dh - boxHeight) / 2;

  return {
    x: canvasW / 2 + (boxX - dw / 2) * scale,
    y: canvasH / 2 + (boxY - dh / 2) * scale,
    width: Math.max(1, boxWidth * scale),
    height: Math.max(1, boxHeight * scale),
  };
}
