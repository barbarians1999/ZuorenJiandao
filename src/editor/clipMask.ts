import type { ClipMask, KeyframeProp, TimelineItem } from './types';
import { sampleKeyframes } from './keyframes';

export const DEFAULT_CLIP_MASK: ClipMask = {
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  feather: 0,
};

export interface ClipMaskCanvas {
  width: number;
  height: number;
}

/** A frame-resolved mask carries the pixel radius needed by SVG/canvas renderers. */
export interface ResolvedClipMask extends ClipMask {
  feather: number;
  featherPx: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const percent = (value: number): string => `${Number((value * 100).toFixed(4))}%`;

/** Keep mask geometry serializable and inside the composition. */
export function normalizeClipMask(mask: ClipMask | undefined): ClipMask | null {
  if (!mask || (mask.type !== 'rectangle' && mask.type !== 'ellipse')) return null;
  if (![mask.x, mask.y, mask.width, mask.height, mask.feather ?? 0].every(Number.isFinite)) return null;
  const x = clamp(mask.x, 0, 0.999);
  const y = clamp(mask.y, 0, 0.999);
  const width = clamp(mask.width, 0.001, 1 - x);
  const height = clamp(mask.height, 0.001, 1 - y);
  // A half-short-edge radius is already enough to dissolve a whole narrow mask;
  // keep the serialized range finite and predictable for untrusted project data.
  const feather = clamp(mask.feather ?? 0, 0, 0.5);
  return {
    type: mask.type,
    x,
    y,
    width,
    height,
    // Preserve legacy serialized masks byte-for-byte when feather was absent;
    // all consumers treat the omitted field as the default zero.
    ...(mask.feather === undefined ? {} : { feather }),
  };
}

export const MASK_KEYFRAME_PROPS = ['maskX', 'maskY', 'maskWidth', 'maskHeight', 'maskFeather'] as const satisfies readonly KeyframeProp[];

/** Resolve static mask geometry and the five animated mask channels at a local frame. */
export function resolveMaskAt(
  item: Pick<TimelineItem, 'mask' | 'keyframes'>,
  localFrame: number,
  canvas: ClipMaskCanvas,
): ResolvedClipMask | undefined {
  const base = item.mask && normalizeClipMask(item.mask);
  if (!base) return undefined;
  const sample = (prop: KeyframeProp, fallback: number): number => {
    const kfs = item.keyframes?.[prop];
    return kfs?.length ? sampleKeyframes(kfs, localFrame) : fallback;
  };
  const normalized = normalizeClipMask({
    type: base.type,
    x: sample('maskX', base.x),
    y: sample('maskY', base.y),
    width: sample('maskWidth', base.width),
    height: sample('maskHeight', base.height),
    feather: sample('maskFeather', base.feather ?? 0),
  });
  if (!normalized) return undefined;
  const shortSide = Math.max(0, Math.min(canvas.width, canvas.height));
  return { ...normalized, feather: normalized.feather ?? 0, featherPx: (normalized.feather ?? 0) * shortSide };
}

/** CSS clip-path shared by the Remotion preview and server renderer. */
export function clipMaskPath(mask: ClipMask | undefined): string | undefined {
  const normalized = mask && normalizeClipMask(mask);
  if (!normalized) return undefined;
  if ((normalized.feather ?? 0) > 0) return undefined;
  if (normalized.type === 'rectangle') {
    const top = percent(normalized.y);
    const right = percent(1 - normalized.x - normalized.width);
    const bottom = percent(1 - normalized.y - normalized.height);
    const left = percent(normalized.x);
    return `inset(${top} ${right} ${bottom} ${left})`;
  }
  return `ellipse(${percent(normalized.width / 2)} ${percent(normalized.height / 2)} at ${percent(normalized.x + normalized.width / 2)} ${percent(normalized.y + normalized.height / 2)})`;
}

/** Apply the same static mask to a 2D staging canvas used by GLSL transitions. */
export function clipMaskCanvas(
  ctx: CanvasRenderingContext2D,
  mask: ClipMask | undefined,
  width: number,
  height: number,
): void {
  const normalized = mask && normalizeClipMask(mask);
  if (!normalized) return;
  // Feathered masks are composited after painting; retaining this hard-edge
  // path is the zero-feather fast path used by both preview and GL staging.
  if ((normalized.feather ?? 0) > 0) return;
  ctx.beginPath();
  if (normalized.type === 'rectangle') {
    ctx.rect(normalized.x * width, normalized.y * height, normalized.width * width, normalized.height * height);
  } else {
    ctx.ellipse(
      (normalized.x + normalized.width / 2) * width,
      (normalized.y + normalized.height / 2) * height,
      normalized.width * width / 2,
      normalized.height * height / 2,
      0,
      0,
      Math.PI * 2,
    );
  }
  ctx.clip();
}

/** Apply a feathered alpha mask to an already-painted staging canvas. */
export function applyClipMaskFeatherCanvas(
  ctx: CanvasRenderingContext2D,
  mask: ResolvedClipMask | ClipMask | undefined,
  width: number,
  height: number,
  reusableMaskCanvas?: HTMLCanvasElement,
): void {
  const normalized = normalizeClipMask(mask);
  if (!normalized || (normalized.feather ?? 0) <= 0) return;
  const featherPx = mask && 'featherPx' in mask
    ? mask.featherPx
    : (normalized.feather ?? 0) * Math.max(0, Math.min(width, height));
  if (!(featherPx > 0)) return;
  const maskCanvas = reusableMaskCanvas ?? document.createElement('canvas');
  const canvasWidth = Math.max(1, Math.round(width));
  const canvasHeight = Math.max(1, Math.round(height));
  if (maskCanvas.width !== canvasWidth) maskCanvas.width = canvasWidth;
  if (maskCanvas.height !== canvasHeight) maskCanvas.height = canvasHeight;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.save();
  maskCtx.filter = `blur(${featherPx}px)`;
  maskCtx.fillStyle = '#fff';
  maskCtx.beginPath();
  if (normalized.type === 'rectangle') {
    maskCtx.rect(normalized.x * width, normalized.y * height, normalized.width * width, normalized.height * height);
  } else {
    maskCtx.ellipse(
      (normalized.x + normalized.width / 2) * width,
      (normalized.y + normalized.height / 2) * height,
      normalized.width * width / 2,
      normalized.height * height / 2,
      0,
      0,
      Math.PI * 2,
    );
  }
  maskCtx.fill();
  maskCtx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.globalAlpha = 1;
  ctx.drawImage(maskCanvas, 0, 0, width, height);
  ctx.restore();
}
