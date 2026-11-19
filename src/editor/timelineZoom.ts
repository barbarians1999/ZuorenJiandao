export interface TimelineZoomLimits {
  min: number;
  max: number;
}

export const MIN_TIMELINE_ZOOM_FLOOR = 0.001;

export function minimumTimelineZoomForFit(
  viewportWidth: number,
  headerWidth: number,
  padding: number,
  totalFrames: number,
  basePixelsPerFrame: number,
  defaultMinimum: number,
): number {
  const usable = viewportWidth - headerWidth - padding;
  if (!Number.isFinite(usable) || usable <= 0 || !Number.isFinite(totalFrames) || totalFrames <= 0
    || !Number.isFinite(basePixelsPerFrame) || basePixelsPerFrame <= 0) return defaultMinimum;
  const fitZoom = usable / (totalFrames * basePixelsPerFrame);
  return Math.max(MIN_TIMELINE_ZOOM_FLOOR, Math.min(defaultMinimum, fitZoom));
}

export function timelineZoomLimitsForFit(
  viewportWidth: number,
  headerWidth: number,
  padding: number,
  totalFrames: number,
  basePixelsPerFrame: number,
  defaultMinimum: number,
  maximum: number,
): TimelineZoomLimits {
  return {
    min: minimumTimelineZoomForFit(
      viewportWidth, headerWidth, padding, totalFrames, basePixelsPerFrame, defaultMinimum,
    ),
    max: maximum,
  };
}

export const clampTimelineZoom = (
  zoom: number,
  limits: TimelineZoomLimits,
): number => Math.min(limits.max, Math.max(limits.min, zoom));

export const scaleTimelineZoom = (
  zoom: number,
  factor: number,
  limits: TimelineZoomLimits,
): number => clampTimelineZoom(zoom * factor, limits);

export function fitTimelineZoom(
  viewportWidth: number,
  headerWidth: number,
  padding: number,
  totalFrames: number,
  basePixelsPerFrame: number,
  limits: TimelineZoomLimits,
): number | null {
  const usable = viewportWidth - headerWidth - padding;
  if (usable <= 0 || totalFrames <= 0 || basePixelsPerFrame <= 0) return null;
  return clampTimelineZoom(usable / (totalFrames * basePixelsPerFrame), limits);
}

export function anchoredTimelineScrollLeft(
  currentScrollLeft: number,
  pointerViewportX: number,
  headerWidth: number,
  oldPixelsPerFrame: number,
  newPixelsPerFrame: number,
): number {
  if (oldPixelsPerFrame <= 0 || newPixelsPerFrame <= 0) return currentScrollLeft;
  const frame = (pointerViewportX + currentScrollLeft - headerWidth) / oldPixelsPerFrame;
  return Math.max(0, frame * newPixelsPerFrame + headerWidth - pointerViewportX);
}

/** Keep the playhead anchored in view on zoom; center it when currently off-screen. */
export function playheadAnchoredTimelineScrollLeft(
  currentScrollLeft: number,
  viewportWidth: number,
  headerWidth: number,
  playheadFrame: number,
  oldPixelsPerFrame: number,
  newPixelsPerFrame: number,
): number {
  if (oldPixelsPerFrame <= 0 || newPixelsPerFrame <= 0) return currentScrollLeft;
  const usableWidth = Math.max(0, viewportWidth - headerWidth);
  if (usableWidth <= 0) return currentScrollLeft;
  const frame = Math.max(0, playheadFrame);
  const currentPlayheadViewportX = headerWidth + frame * oldPixelsPerFrame - currentScrollLeft;
  const isPlayheadVisible = currentPlayheadViewportX >= headerWidth && currentPlayheadViewportX <= viewportWidth;
  const edgeMargin = Math.min(80, usableWidth * 0.25);
  const anchorViewportX = isPlayheadVisible
    ? Math.min(viewportWidth - edgeMargin, Math.max(headerWidth + edgeMargin, currentPlayheadViewportX))
    : headerWidth + usableWidth / 2;
  return Math.max(0, frame * newPixelsPerFrame + headerWidth - anchorViewportX);
}

export function defaultTimelineZoom(
  fps: number,
  basePixelsPerFrame: number,
  rulerLabelMinPx: number,
  limits: TimelineZoomLimits,
): number {
  const zoom = rulerLabelMinPx / (12 * Math.max(1, fps) * basePixelsPerFrame);
  return clampTimelineZoom(zoom, limits);
}
