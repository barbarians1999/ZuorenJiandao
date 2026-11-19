import type { ClipAppearance } from '../editor/clipFade';

export function transitionPlacementRequired(appearance: ClipAppearance, blur: number): boolean {
  return !!appearance.cropRect || blur > 0 || appearance.transformSurfaces.some((surface) =>
    surface.x !== 0 || surface.y !== 0 || surface.rotation !== 0 || surface.scaleX !== 1 || surface.scaleY !== 1);
}

/** CSS transforms compose left-to-right around the canvas centre. Crop belongs
 * to that transformed local canvas, and opacity is applied once by GL later. */
export function paintTransitionPlacement(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, appearance: ClipAppearance, blur: number): void {
  const { width, height } = source;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  try {
    for (const surface of appearance.transformSurfaces) {
      ctx.translate(width / 2, height / 2);
      ctx.translate(surface.x * width / 100, surface.y * height / 100);
      ctx.rotate(surface.rotation * Math.PI / 180);
      ctx.scale(surface.scaleX, surface.scaleY);
      ctx.translate(-width / 2, -height / 2);
    }
    if (appearance.cropRect) {
      const { x, y, width: cropWidth, height: cropHeight } = appearance.cropRect;
      ctx.beginPath(); ctx.rect(x, y, cropWidth, cropHeight); ctx.clip();
    }
    ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    ctx.drawImage(source, 0, 0);
  } finally { ctx.restore(); }
}
