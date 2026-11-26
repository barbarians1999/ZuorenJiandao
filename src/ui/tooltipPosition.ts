export interface TooltipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TooltipSize {
  width: number;
  height: number;
}

export interface TooltipViewport {
  width: number;
  height: number;
}

export type TooltipPlacement = 'bottom' | 'top';
export type TooltipAlign = 'start' | 'end' | 'center';

export interface TooltipPositionInput {
  anchor: TooltipRect;
  tooltip: TooltipSize;
  viewport: TooltipViewport;
  preferredPlacement?: TooltipPlacement;
  preferredAlign?: TooltipAlign;
  gap?: number;
  gutter?: number;
}

export interface TooltipPositionResult {
  left: number;
  top: number;
  placement: TooltipPlacement;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute viewport coordinates for a Top-Layer tooltip, automatically flipping
 * vertically when space is tight and clamping horizontally inside viewport gutters.
 */
export function computeTooltipPosition({
  anchor,
  tooltip,
  viewport,
  preferredPlacement = 'bottom',
  preferredAlign = 'start',
  gap = 7,
  gutter = 8,
}: TooltipPositionInput): TooltipPositionResult {
  const bottomTop = anchor.bottom + gap;
  const topTop = anchor.top - gap - tooltip.height;
  const fitsBottom = bottomTop + tooltip.height <= viewport.height - gutter;
  const fitsTop = topTop >= gutter;

  let placement: TooltipPlacement;
  if (preferredPlacement === 'top') {
    if (fitsTop) {
      placement = 'top';
    } else if (fitsBottom) {
      placement = 'bottom';
    } else {
      placement = anchor.top >= viewport.height - anchor.bottom ? 'top' : 'bottom';
    }
  } else {
    if (fitsBottom) {
      placement = 'bottom';
    } else if (fitsTop) {
      placement = 'top';
    } else {
      placement = viewport.height - anchor.bottom >= anchor.top ? 'bottom' : 'top';
    }
  }

  const rawTop = placement === 'top' ? topTop : bottomTop;
  const maxTop = Math.max(gutter, viewport.height - gutter - tooltip.height);
  const top = clamp(rawTop, gutter, maxTop);

  let rawLeft: number;
  if (preferredAlign === 'end') {
    rawLeft = anchor.right - tooltip.width;
  } else if (preferredAlign === 'center') {
    rawLeft = anchor.left + (anchor.width - tooltip.width) / 2;
  } else {
    rawLeft = anchor.left;
  }

  const maxLeft = Math.max(gutter, viewport.width - gutter - tooltip.width);
  const left = clamp(rawLeft, gutter, maxLeft);

  return {
    left: Math.round(left),
    top: Math.round(top),
    placement,
  };
}
