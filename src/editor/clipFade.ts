import { sampleKeyframes } from './keyframes';
import type { TimelineItem } from './types';
import { flexCropClipPath, flexCropRect, hasFlexCrop, type FlexCropRect } from './flexCrop';
import { clipMaskPath, resolveMaskAt, type ResolvedClipMask } from './clipMask';
import { pictureAnimationAt } from './clipAnimation';
import { resolveTextAnchorDesignOrigin, resolveTextStyle } from './textStyles';

/** Fade multiplier at a Sequence-relative frame. */
export function clipFadeFactor(
  frame: number,
  durationInFrames: number,
  fadeInFrames = 0,
  fadeOutFrames = 0,
): number {
  let factor = 1;
  if (fadeInFrames > 0) factor = Math.min(factor, frame / fadeInFrames);
  if (fadeOutFrames > 0) factor = Math.min(factor, (durationInFrames - frame) / fadeOutFrames);
  return Math.max(0, Math.min(1, factor));
}

/** Visual opacity shared by the foreground and any full-canvas companion layer. */
export function clipOpacityAt(item: TimelineItem, frame: number, hidden = false): number {
  const opacityKeyframes = item.keyframes?.opacity;
  const opacity = opacityKeyframes?.length
    ? sampleKeyframes(opacityKeyframes, frame)
    : item.transform?.opacity ?? 1;
  const visibleOpacity = hidden ? 0 : Math.max(0, Math.min(1, opacity));
  return clipFadeFactor(frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames) * visibleOpacity * pictureAnimationAt(item, frame).opacity;
}

export interface ClipAppearance {
  opacity: number;
  borderRadius: number;
  foregroundStyle: import('react').CSSProperties;
  maskClipPath?: string;
  mask?: ResolvedClipMask;
  /** Numerical counterpart of foregroundStyle.transform, in the same order. */
  transformSurfaces: Array<{ x: number; y: number; rotation: number; scaleX: number; scaleY: number }>;
  cropRect?: FlexCropRect;
}

/** Per-frame clip appearance (opacity/border/transform/crop/filters) shared by
 *  the clip wrapper and the shared-visual video group. */
export function appearanceAt(
  item: import('./types').TimelineItem,
  frame: number,
  hiddenByCaptions: boolean,
  canvas: { width: number; height: number } = { width: 0, height: 0 },
): ClipAppearance {
  const keyframeValue = (prop: import('./types').KeyframeProp): number | undefined => {
    const values = item.keyframes?.[prop];
    return values?.length ? sampleKeyframes(values, frame) : undefined;
  };
  const transform = item.transform;
  const scale = keyframeValue('scale');
  const rawScaleX = keyframeValue('scaleX') ?? transform?.scaleX ?? scale ?? transform?.scale ?? 1;
  const rawScaleY = keyframeValue('scaleY') ?? transform?.scaleY ?? scale ?? transform?.scale ?? 1;
  const scaleX = scale !== undefined || keyframeValue('scaleX') !== undefined ? Math.max(0.001, rawScaleX) : rawScaleX;
  const scaleY = scale !== undefined || keyframeValue('scaleY') !== undefined ? Math.max(0.001, rawScaleY) : rawScaleY;
  const hasScale = scale !== undefined || keyframeValue('scaleX') !== undefined || keyframeValue('scaleY') !== undefined
    || transform?.scale !== undefined || transform?.scaleX !== undefined || transform?.scaleY !== undefined;
  const hasTransform = transform || keyframeValue('x') !== undefined || keyframeValue('y') !== undefined
    || keyframeValue('rotation') !== undefined || hasScale;
  const cssTransform = hasTransform
    ? `translate(${keyframeValue('x') ?? transform?.x ?? 0}%, ${keyframeValue('y') ?? transform?.y ?? 0}%) rotate(${keyframeValue('rotation') ?? transform?.rotation ?? 0}deg) scale(${scaleX}, ${scaleY})`
    : undefined;
  const motion = pictureAnimationAt(item, frame);
  const crop = transform?.crop;
  const clipPath = hasFlexCrop(crop) ? flexCropClipPath(crop, canvas.width, canvas.height) : undefined;
  const opacity = clipOpacityAt(item, frame, hiddenByCaptions);
  const filters = item.filters;
  const mask = resolveMaskAt(item, frame, canvas);
  let transformOrigin = '50% 50%';
  if (item.kind === 'text') {
    const dw = item.width && item.width > 0 ? item.width : 1920;
    const dh = item.height && item.height > 0 ? item.height : 1080;
    const style = resolveTextStyle(item.props ?? {});
    const designOrigin = resolveTextAnchorDesignOrigin(dw, dh, style.anchor);
    if (canvas.width > 0 && canvas.height > 0) {
      const scale = Math.min(canvas.width / dw, canvas.height / dh);
      const px = ((canvas.width / 2 + (designOrigin.x - dw / 2) * scale) / canvas.width) * 100;
      const py = ((canvas.height / 2 + (designOrigin.y - dh / 2) * scale) / canvas.height) * 100;
      transformOrigin = `${px.toFixed(4)}% ${py.toFixed(4)}%`;
    } else {
      transformOrigin = `${((designOrigin.x / dw) * 100).toFixed(4)}% ${((designOrigin.y / dh) * 100).toFixed(4)}%`;
    }
  }
  return {
    opacity,
    borderRadius: Math.max(0, keyframeValue('borderRadius') ?? transform?.borderRadius ?? 0),
    foregroundStyle: {
      transform: [motion.transform, cssTransform].filter(Boolean).join(' ') || undefined,
      transformOrigin,
      transformBox: 'border-box',
      filter: filters || motion.blur > 0
        ? `brightness(${filters?.brightness ?? 1}) contrast(${filters?.contrast ?? 1}) saturate(${filters?.saturate ?? 1}) blur(${(filters?.blur ?? 0) + motion.blur}px)`
        : undefined,
      clipPath,
    },
    mask,
    maskClipPath: clipMaskPath(mask),
    transformSurfaces: [
      ...motion.surfaces.map((surface) => ({ x: surface.x, y: surface.y, rotation: surface.rotation, scaleX: surface.scale, scaleY: surface.scale })),
      { x: keyframeValue('x') ?? transform?.x ?? 0, y: keyframeValue('y') ?? transform?.y ?? 0,
        rotation: keyframeValue('rotation') ?? transform?.rotation ?? 0, scaleX, scaleY },
    ],
    cropRect: hasFlexCrop(crop) ? flexCropRect(crop, canvas.width, canvas.height) : undefined,
  };
}
