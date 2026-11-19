import { gaussianKernel } from '../gl/fx/gaussianBlur';

/** Region coordinates belong to the composition, never to a source clip. */
export interface CompositionMosaic {
  shape: 'rectangle' | 'ellipse';
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  strength: number;
  /** Inward feather distance in composition pixels. */
  feather: number;
  opacity: number;
}

export const DEFAULT_COMPOSITION_MOSAIC: CompositionMosaic = {
  shape: 'rectangle', centerX: .5, centerY: .5, width: .35, height: .35,
  strength: 70, feather: 0, opacity: 1,
};

export interface MosaicMaskTransform { x: number; y: number; rotation: number; scaleX: number; scaleY: number }
export type MosaicMatrix = readonly [number, number, number, number, number, number];

/** Match the editor's composition-centered CSS transform order, transforming only the region. */
export function compositionMosaicMatrix(transforms: readonly MosaicMaskTransform[], width: number, height: number): MosaicMatrix | null {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
  let result: MosaicMatrix = [1, 0, 0, 1, 0, 0];
  for (const transform of transforms) {
    if (![transform.x, transform.y, transform.rotation, transform.scaleX, transform.scaleY].every(Number.isFinite)) return null;
    const radians = transform.rotation * Math.PI / 180;
    const cosine = Math.cos(radians), sine = Math.sin(radians);
    const a = cosine * transform.scaleX, b = sine * transform.scaleX;
    const c = -sine * transform.scaleY, d = cosine * transform.scaleY;
    const e = width / 2 + transform.x * width / 100 - a * width / 2 - c * height / 2;
    const f = height / 2 + transform.y * height / 100 - b * width / 2 - d * height / 2;
    const [ra, rb, rc, rd, re, rf] = result;
    result = [ra * a + rc * b, rb * a + rd * b, ra * c + rc * d, rb * c + rd * d,
      ra * e + rc * f + re, rb * e + rd * f + rf];
  }
  return result;
}

/** Invalid redaction data must not silently turn into an unfiltered picture. */
export function parseCompositionMosaic(value: unknown): CompositionMosaic | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.shape !== 'rectangle' && raw.shape !== 'ellipse') return null;
  const bounds = {
    centerX: [0, 1], centerY: [0, 1], width: [.01, 1], height: [.01, 1],
    strength: [1, 100], feather: [0, 100], opacity: [0, 1],
  } as const;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const number = raw[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) return null;
  }
  return {
    shape: raw.shape, centerX: raw.centerX as number, centerY: raw.centerY as number,
    width: raw.width as number, height: raw.height as number, strength: raw.strength as number,
    feather: raw.feather as number, opacity: raw.opacity as number,
  };
}

export function compositionMosaicRect(value: CompositionMosaic, width: number, height: number) {
  const w = value.width * width, h = value.height * height;
  return { x: value.centerX * width - w / 2, y: value.centerY * height - h / 2, width: w, height: h };
}

export function compositionMosaicProtectionRect(value: CompositionMosaic, width: number, height: number, matrix: MosaicMatrix) {
  const rect = compositionMosaicRect(value, width, height);
  const [a, b, c, d, e, f] = matrix;
  const points = [[rect.x, rect.y], [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]]
    .map(([x, y]) => ({ x: a * x! + c * y! + e, y: b * x! + d * y! + f }));
  const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
  return { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y };
}

export const compositionMosaicSigma = (value: Pick<CompositionMosaic, 'strength'>) => gaussianKernel(value.strength).sigma;
const number = (value: number) => Number(value.toFixed(6)).toString();
const smoothstep = (value: number) => value * value * (3 - 2 * value);
const stop = (offset: number, opacity: number) =>
  `<stop offset="${number(offset)}" stop-color="white" stop-opacity="${number(opacity)}"/>`;

function edgeStops(ratio: number): string {
  const steps = [0, .25, .5, .75, 1];
  return steps.map(t => stop(t * ratio, smoothstep(t))).join('')
    + steps.map(t => stop(1 - ratio + t * ratio, 1 - smoothstep(t))).join('');
}

/** The mask is transparent outside the selected shape, including its feather. */
export function compositionMosaicShapeMarkup(value: CompositionMosaic, width: number, height: number, idPrefix: string): string {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new Error('Invalid mosaic composition size');
  }
  const rect = compositionMosaicRect(value, width, height);
  const { x, y, width: w, height: h } = rect;
  const feather = Math.min(value.feather, w / 2, h / 2);
  const attributes = `x="${number(x)}" y="${number(y)}" width="${number(w)}" height="${number(h)}"`;
  const ellipse = `cx="${number(x + w / 2)}" cy="${number(y + h / 2)}" rx="${number(w / 2)}" ry="${number(h / 2)}"`;
  if (!/^[a-zA-Z0-9_-]+$/.test(idPrefix)) throw new Error('Invalid mosaic SVG identity');
  const edgeId = `${idPrefix}-edge`, horizontalId = `${idPrefix}-horizontal`;
  const verticalId = `${idPrefix}-vertical`, verticalMaskId = `${idPrefix}-vertical-mask`;
  let content: string;
  if (feather === 0) {
    content = value.shape === 'ellipse' ? `<ellipse ${ellipse} fill="white"/>` : `<rect ${attributes} fill="white"/>`;
  } else if (value.shape === 'ellipse') {
    const inner = 1 - feather / Math.min(w / 2, h / 2);
    const stops = stop(0, 1) + [0, .25, .5, .75, 1]
      .map(t => stop(inner + (1 - inner) * t, 1 - smoothstep(t))).join('');
    content = `<defs><radialGradient id="${edgeId}">${stops}</radialGradient></defs><ellipse ${ellipse} fill="url(#${edgeId})"/>`;
  } else {
    content = `<defs><linearGradient id="${horizontalId}">${edgeStops(feather / w)}</linearGradient>`
      + `<linearGradient id="${verticalId}" x1="0" y1="0" x2="0" y2="1">${edgeStops(feather / h)}</linearGradient>`
      + `<mask id="${verticalMaskId}" maskUnits="userSpaceOnUse" ${attributes}><rect ${attributes} fill="url(#${verticalId})"/></mask></defs>`
      + `<rect ${attributes} fill="url(#${horizontalId})" mask="url(#${verticalMaskId})"/>`;
  }
  return content;
}

/** Translation and opacity stay synchronous; only shape/scale/rotation need a new mask image. */
export function compositionMosaicMaskAsset(value: CompositionMosaic, width: number, height: number, matrix: MosaicMatrix) {
  const scale = Math.hypot(matrix[0], matrix[1]) || Math.hypot(matrix[2], matrix[3]);
  if (!(scale > 0)) return null;
  const linear: MosaicMatrix = [matrix[0] / scale, matrix[1] / scale, matrix[2] / scale, matrix[3] / scale, 0, 0];
  const bounds = compositionMosaicProtectionRect(value, width, height, linear);
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${number(bounds.width)}" height="${number(bounds.height)}" viewBox="${number(bounds.x)} ${number(bounds.y)} ${number(bounds.width)} ${number(bounds.height)}">`
    + `<g transform="matrix(${linear.map(number).join(' ')})">${compositionMosaicShapeMarkup(value, width, height, 'mosaic')}</g></svg>`;
  return { source: `data:image/svg+xml,${encodeURIComponent(svg)}`, x: bounds.x * scale + matrix[4], y: bounds.y * scale + matrix[5],
    width: bounds.width * scale, height: bounds.height * scale };
}
