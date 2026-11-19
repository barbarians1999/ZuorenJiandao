const CJK_OR_FULLWIDTH_RE = /[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6]/;

export interface CaptionBoxRectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TightCaptionFrameInsets {
  left: number;
  right: number;
}

let captionMeasureCtx: CanvasRenderingContext2D | null | undefined;

function getCaptionMeasureContext(font: string): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (captionMeasureCtx === undefined) {
    try {
      captionMeasureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      captionMeasureCtx = null;
    }
  }
  if (captionMeasureCtx) captionMeasureCtx.font = font;
  return captionMeasureCtx;
}

function approximateLineWidth(line: string, fontSize: number, letterSpacing: number): number {
  if (!line) return fontSize;
  const glyphs = Array.from(line);
  let width = 0;
  for (const ch of glyphs) {
    if (CJK_OR_FULLWIDTH_RE.test(ch)) width += fontSize * 1.02;
    else if (/\s/.test(ch)) width += fontSize * 0.35;
    else if (/[A-ZMWQ@#%&]/.test(ch)) width += fontSize * 0.72;
    else width += fontSize * 0.58;
  }
  return width + Math.max(0, glyphs.length - 1) * letterSpacing;
}

/**
 * Given the container rect and glyph `Range.getClientRects()` rects, return
 * pixel offsets (`left`, `right`) for `.cc-capedit-frame` so wrapped multi-line
 * subtitles keep a tight selection frame around actual glyphs instead of
 * stretching across the full column width.
 */
export function computeTightCaptionFrameInsets(
  containerRect: Pick<CaptionBoxRectLike, 'left' | 'right' | 'width'>,
  glyphRects: readonly Pick<CaptionBoxRectLike, 'left' | 'right' | 'width' | 'height'>[],
  horizontalPad = 8,
): TightCaptionFrameInsets | null {
  if (!(containerRect.width > 0)) return null;
  const visibleGlyphs = glyphRects.filter((rect) => rect.width > 0.5 && rect.height > 0.5);
  if (visibleGlyphs.length === 0) return null;

  let minLeft = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  for (const rect of visibleGlyphs) {
    if (rect.left < minLeft) minLeft = rect.left;
    if (rect.right > maxRight) maxRight = rect.right;
  }
  if (!Number.isFinite(minLeft) || !Number.isFinite(maxRight) || maxRight <= minLeft) return null;

  const glyphSpan = maxRight - minLeft;
  const maxAllowedLeft = Math.max(-horizontalPad, containerRect.width - horizontalPad);
  const rawLeft = minLeft - containerRect.left - horizontalPad;
  const rawRight = containerRect.right - maxRight - horizontalPad;
  // Clamp so frame never collapses past the glyph span.
  const left = Math.max(-horizontalPad, Math.min(maxAllowedLeft - glyphSpan, rawLeft));
  const right = Math.max(-horizontalPad, Math.min(maxAllowedLeft - glyphSpan, rawRight));
  return {
    left: Number(left.toFixed(2)),
    right: Number(right.toFixed(2)),
  };
}

/**
 * Compute tight textarea width and row count while editing inline captions so
 * short captions do not expand to 100% column width.
 */
export function computeTightTextareaMetrics(params: {
  text: string;
  font: string;
  fontSize: number;
  letterSpacing?: number;
  maxWidthPx: number;
  caretSlackPx?: number;
}): { widthPx: number; rows: number } {
  const {
    text,
    font,
    fontSize,
    letterSpacing = 0,
    maxWidthPx,
    caretSlackPx = 20,
  } = params;
  const safeMaxWidth = Math.max(48, maxWidthPx);
  const safeFontSize = Math.max(10, fontSize);
  const ctx = getCaptionMeasureContext(font);
  const lines = (text || ' ').split(/\r?\n/);

  let maxLineWidth = 0;
  let wrappedRows = 0;
  for (const line of lines) {
    const measured = ctx
      ? ctx.measureText(line || ' ').width + Math.max(0, Array.from(line).length - 1) * letterSpacing
      : approximateLineWidth(line, safeFontSize, letterSpacing);
    const widthWithSlack = measured + caretSlackPx;
    if (widthWithSlack > maxLineWidth) maxLineWidth = widthWithSlack;
    wrappedRows += Math.max(1, Math.ceil(measured / Math.max(1, safeMaxWidth - caretSlackPx)));
  }

  return {
    widthPx: Math.max(Math.min(safeMaxWidth, safeFontSize * 2.2), Math.min(safeMaxWidth, Math.ceil(maxLineWidth))),
    rows: Math.max(1, wrappedRows),
  };
}
