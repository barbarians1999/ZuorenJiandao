import { appearanceAt } from '../../editor/clipFade';
import { normalizeClipMask, resolveMaskAt } from '../../editor/clipMask';
import type { ClipMask, KeyframeProp, TimelineItem, TimelineState } from '../../editor/types';
import type { PreviewPoint } from './previewTransform';

type Canvas = Pick<TimelineState, 'width' | 'height'>;
type Surface = ReturnType<typeof appearanceAt>['transformSurfaces'][number];
export type MaskHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const MASK_HANDLES: readonly Exclude<MaskHandle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const MASK_CHANNELS = { x: 'maskX', y: 'maskY', width: 'maskWidth', height: 'maskHeight' } as const;

function transformPoint(point: PreviewPoint, canvas: Canvas, surface: Surface, inverse: boolean): PreviewPoint {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const radians = surface.rotation * Math.PI / 180 * (inverse ? -1 : 1);
  const cos = Math.cos(radians), sin = Math.sin(radians);
  let x = point.x - cx, y = point.y - cy;
  if (inverse) {
    x -= surface.x / 100 * canvas.width;
    y -= surface.y / 100 * canvas.height;
    return { x: cx + (x * cos - y * sin) / surface.scaleX, y: cy + (x * sin + y * cos) / surface.scaleY };
  }
  x *= surface.scaleX; y *= surface.scaleY;
  return { x: cx + x * cos - y * sin + surface.x / 100 * canvas.width,
    y: cy + x * sin + y * cos + surface.y / 100 * canvas.height };
}

/** Same transform order/origin as ClipWrapper and continuous video reuse. Zoom
 * and crop are INSIDE/beside the mask, so neither changes mask coordinates. */
export function previewMaskPoint(canvas: Canvas, item: TimelineItem, localFrame: number, point: PreviewPoint, inverse = false): PreviewPoint | null {
  if (!(canvas.width > 0 && canvas.height > 0)) return null;
  const surfaces = appearanceAt(item, localFrame, false, canvas).transformSurfaces;
  if (surfaces.some((s) => ![s.x, s.y, s.rotation, s.scaleX, s.scaleY].every(Number.isFinite)
    || Math.abs(s.scaleX) < 1e-6 || Math.abs(s.scaleY) < 1e-6)) return null;
  // CSS applies the rightmost transform first; inverse applies the leftmost first.
  return (inverse ? surfaces : [...surfaces].reverse()).reduce((p, s) => transformPoint(p, canvas, s, inverse), point);
}

export function previewMaskGeometry(canvas: Canvas, item: TimelineItem, localFrame: number) {
  const mask = resolveMaskAt(item, localFrame, canvas);
  if (!mask) return null;
  const at = (x: number, y: number) => previewMaskPoint(canvas, item, localFrame, { x: x * canvas.width, y: y * canvas.height });
  const left = mask.x, right = mask.x + mask.width, top = mask.y, bottom = mask.y + mask.height;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const raw = { nw: [left, top], n: [cx, top], ne: [right, top], e: [right, cy],
    se: [right, bottom], s: [cx, bottom], sw: [left, bottom], w: [left, cy] } as const;
  const handles = {} as Record<Exclude<MaskHandle, 'move'>, PreviewPoint>;
  for (const key of MASK_HANDLES) {
    const p = at(...raw[key]);
    if (!p) return null;
    handles[key] = p;
  }
  const outline = mask.type === 'rectangle'
    ? [handles.nw, handles.ne, handles.se, handles.sw]
    : Array.from({ length: 64 }, (_, index) => {
      const angle = index * Math.PI * 2 / 64;
      return at(cx + Math.cos(angle) * mask.width / 2, cy + Math.sin(angle) * mask.height / 2)!;
    });
  return { mask, handles, outline };
}

/** Client DELTA, not absolute pointer position: opening/recentering the
 * inspector and grabbing a padded handle must not move or snap the mask. */
export function previewMaskDelta(canvas: Canvas, item: TimelineItem, localFrame: number,
  clientDelta: PreviewPoint, preview: { width: number; height: number }): PreviewPoint | null {
  if (!(preview.width > 0 && preview.height > 0)) return null;
  const origin = previewMaskPoint(canvas, item, localFrame, { x: 0, y: 0 }, true);
  const end = previewMaskPoint(canvas, item, localFrame, {
    x: clientDelta.x / preview.width * canvas.width, y: clientDelta.y / preview.height * canvas.height,
  }, true);
  return origin && end ? { x: (end.x - origin.x) / canvas.width, y: (end.y - origin.y) / canvas.height } : null;
}

export function dragPreviewMask(start: ClipMask, handle: MaskHandle, delta: PreviewPoint): ClipMask {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const min = .001;
  if (handle === 'move') return { ...start,
    x: clamp(start.x + delta.x, 0, 1 - start.width), y: clamp(start.y + delta.y, 0, 1 - start.height) };
  let left = start.x, right = start.x + start.width, top = start.y, bottom = start.y + start.height;
  if (handle.includes('w')) left = clamp(left + delta.x, 0, right - min);
  if (handle.includes('e')) right = clamp(right + delta.x, left + min, 1);
  if (handle.includes('n')) top = clamp(top + delta.y, 0, bottom - min);
  if (handle.includes('s')) bottom = clamp(bottom + delta.y, top + min, 1);
  return { ...start, x: left, y: top, width: right - left, height: bottom - top };
}

/** Only touched geometry channels are written; preserve feather/type and
 * existing curves. An animated channel receives a keyframe at the playhead. */
export function previewMaskWrites(item: TimelineItem, localFrame: number, start: ClipMask, next: ClipMask,
  touched: ReadonlySet<keyof typeof MASK_CHANNELS> = new Set()) {
  const mask = { ...item.mask! };
  let staticChanged = false;
  const keyframes: Array<{ prop: KeyframeProp; frame: number; value: number }> = [];
  for (const key of Object.keys(MASK_CHANNELS) as Array<keyof typeof MASK_CHANNELS>) {
    if (Math.abs(next[key] - start[key]) < 1e-9 && !touched.has(key)) continue;
    const prop = MASK_CHANNELS[key];
    if (item.keyframes?.[prop]?.length) keyframes.push({ prop, frame: localFrame, value: next[key] });
    else { mask[key] = next[key]; staticChanged = true; }
  }
  return { mask: staticChanged ? normalizeClipMask(mask) : null, keyframes };
}

export function previewMaskTarget(state: TimelineState, frame: number): TimelineItem | null {
  if ((state.selectedIds?.length ?? 0) > 1 || state.width <= 0 || state.height <= 0) return null;
  const item = state.items.find((entry) => entry.id === state.selectedId);
  const track = item && state.tracks?.[item.track];
  return item?.mask && item.kind !== 'audio' && !track?.hidden && !track?.locked
    && frame >= item.startFrame && frame < item.startFrame + item.durationInFrames ? item : null;
}
