export type VectorShapeKind = 'line' | 'rect' | 'arrow';
export type VectorDashPattern = 'solid' | 'dashed' | 'dotted';

export interface ResolvedVectorShape {
  kind: VectorShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
  dashPattern: VectorDashPattern;
  opacity: number;
  cornerRadius: number;
  fillColor: string;
  fillOpacity: number;
  arrowHeadSize: number;
  bidirectional: boolean;
}

export const VECTOR_SHAPE_KINDS: ReadonlyArray<{ id: VectorShapeKind; label: string }> = [
  { id: 'line', label: '精细直线' },
  { id: 'rect', label: '矩形边框' },
  { id: 'arrow', label: '指向箭头' },
];

export const VECTOR_SHAPE_DEFAULTS: Record<VectorShapeKind, Partial<ResolvedVectorShape>> = {
  line: {
    x1: 0.25,
    y1: 0.5,
    x2: 0.75,
    y2: 0.5,
    color: '#d4af37',
    strokeWidth: 2,
    dashPattern: 'solid',
    opacity: 100,
  },
  rect: {
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
    color: '#d4af37',
    strokeWidth: 3,
    dashPattern: 'solid',
    cornerRadius: 4,
    fillColor: '#000000',
    fillOpacity: 0,
    opacity: 100,
  },
  arrow: {
    x1: 0.25,
    y1: 0.5,
    x2: 0.75,
    y2: 0.5,
    color: '#d4af37',
    strokeWidth: 3,
    dashPattern: 'solid',
    arrowHeadSize: 16,
    bidirectional: false,
    opacity: 100,
  },
};

const ALLOWED_VECTOR_SHAPE_KEYS = new Set([
  'shapeKind',
  'x1',
  'y1',
  'x2',
  'y2',
  'x',
  'y',
  'width',
  'height',
  'color',
  'strokeWidth',
  'dashPattern',
  'opacity',
  'cornerRadius',
  'fillColor',
  'fillOpacity',
  'arrowHeadSize',
  'bidirectional',
]);

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

const hexOr = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.trim() ? value.trim() : fallback
);

export function resolveVectorShape(props: Record<string, unknown> = {}): ResolvedVectorShape | null {
  const rawKind = props.shapeKind;
  if (rawKind !== 'line' && rawKind !== 'rect' && rawKind !== 'arrow') return null;
  const defaults = VECTOR_SHAPE_DEFAULTS[rawKind];
  const dashPattern: VectorDashPattern =
    props.dashPattern === 'dashed' || props.dashPattern === 'dotted' ? props.dashPattern : 'solid';
  return {
    kind: rawKind,
    x1: clamp(props.x1, defaults.x1 ?? 0.25, 0, 1),
    y1: clamp(props.y1, defaults.y1 ?? 0.5, 0, 1),
    x2: clamp(props.x2, defaults.x2 ?? 0.75, 0, 1),
    y2: clamp(props.y2, defaults.y2 ?? 0.5, 0, 1),
    x: clamp(props.x, defaults.x ?? 0.25, 0, 1),
    y: clamp(props.y, defaults.y ?? 0.25, 0, 1),
    width: clamp(props.width, defaults.width ?? 0.5, 0.01, 1),
    height: clamp(props.height, defaults.height ?? 0.5, 0.01, 1),
    color: hexOr(props.color, defaults.color ?? '#d4af37'),
    strokeWidth: clamp(props.strokeWidth, defaults.strokeWidth ?? 2, 1, 20),
    dashPattern,
    opacity: clamp(props.opacity, defaults.opacity ?? 100, 0, 100),
    cornerRadius: clamp(props.cornerRadius, defaults.cornerRadius ?? 0, 0, 80),
    fillColor: hexOr(props.fillColor, defaults.fillColor ?? '#000000'),
    fillOpacity: clamp(props.fillOpacity, defaults.fillOpacity ?? 0, 0, 100),
    arrowHeadSize: clamp(props.arrowHeadSize, defaults.arrowHeadSize ?? 16, 6, 48),
    bidirectional: props.bidirectional === true,
  };
}

export function vectorShapeBounds(
  shape: ResolvedVectorShape,
  canvasW: number,
  canvasH: number,
  minHitPx = 24,
): { x: number; y: number; width: number; height: number } {
  if (canvasW <= 0 || canvasH <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  if (shape.kind === 'rect') {
    const rawW = shape.width * canvasW;
    const rawH = shape.height * canvasH;
    const width = Math.max(minHitPx, rawW);
    const height = Math.max(minHitPx, rawH);
    const x = shape.x * canvasW - (width - rawW) / 2;
    const y = shape.y * canvasH - (height - rawH) / 2;
    return { x, y, width, height };
  }
  const px1 = shape.x1 * canvasW;
  const py1 = shape.y1 * canvasH;
  const px2 = shape.x2 * canvasW;
  const py2 = shape.y2 * canvasH;
  const pad = Math.max(minHitPx / 2, shape.strokeWidth / 2 + (shape.kind === 'arrow' ? shape.arrowHeadSize * 0.6 : 4));
  const minX = Math.min(px1, px2) - pad;
  const minY = Math.min(py1, py2) - pad;
  const maxX = Math.max(px1, px2) + pad;
  const maxY = Math.max(py1, py2) + pad;
  return {
    x: minX,
    y: minY,
    width: Math.max(minHitPx, maxX - minX),
    height: Math.max(minHitPx, maxY - minY),
  };
}

export function validateVectorShapeProps(props: Record<string, unknown>): string | null {
  if (props.shapeKind !== 'line' && props.shapeKind !== 'rect' && props.shapeKind !== 'arrow') {
    return `shapeKind must be "line", "rect", or "arrow" (got ${String(props.shapeKind)})`;
  }
  for (const key of Object.keys(props)) {
    if (!ALLOWED_VECTOR_SHAPE_KEYS.has(key)) {
      return `unsupported shape prop "${key}". Supported: ${[...ALLOWED_VECTOR_SHAPE_KEYS].join(', ')}`;
    }
  }
  for (const unitKey of ['x1', 'y1', 'x2', 'y2', 'x', 'y', 'width', 'height'] as const) {
    if (props[unitKey] !== undefined) {
      const n = props[unitKey];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
        return `shape prop "${unitKey}" must be a normalized finite number in 0..1`;
      }
    }
  }
  if (props.strokeWidth !== undefined) {
    const sw = props.strokeWidth;
    if (typeof sw !== 'number' || !Number.isFinite(sw) || sw < 1 || sw > 20) {
      return 'shape strokeWidth must be a finite number in 1..20 (px)';
    }
  }
  if (props.dashPattern !== undefined && props.dashPattern !== 'solid' && props.dashPattern !== 'dashed' && props.dashPattern !== 'dotted') {
    return `shape dashPattern must be "solid", "dashed", or "dotted" (got ${String(props.dashPattern)})`;
  }
  for (const numKey of ['opacity', 'cornerRadius', 'fillOpacity', 'arrowHeadSize'] as const) {
    if (props[numKey] !== undefined && (typeof props[numKey] !== 'number' || !Number.isFinite(props[numKey]))) {
      return `shape prop "${numKey}" must be a finite number`;
    }
  }
  return null;
}
