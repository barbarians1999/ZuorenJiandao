export interface FilmstripLayoutInput {
  durationMs: number;
  frameCount: number;
  cellWidth: number;
  cellHeight: number;
  fps: number;
  px: number;
  srcInFrame: number;
  durationInFrames: number;
  playbackRate: number;
  widthPx: number;
  heightPx: number;
}

export interface FilmstripDrawTile {
  frameIndex: number;
  sourceWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Lay out source frames at their real aspect ratio. Each sampled frame fills
 * its source-time interval with repeated, crisp tiles; when the timeline is
 * zoomed far out, adjacent samples are coalesced instead of squeezed into
 * narrow, blurry slivers.
 */
export function filmstripDrawPlan(input: FilmstripLayoutInput): FilmstripDrawTile[] {
  const {
    durationMs, frameCount, cellWidth, cellHeight, fps, px,
    srcInFrame, durationInFrames, playbackRate, widthPx, heightPx,
  } = input;
  if (
    !(durationMs > 0) || !(frameCount > 0) || !(cellWidth > 0) || !(cellHeight > 0)
    || !(fps > 0) || !(px > 0) || !(durationInFrames > 0) || !(widthPx > 0) || !(heightPx > 0)
  ) return [];
  if (![srcInFrame, playbackRate].every(Number.isFinite)) return [];

  const sourceFrames = (durationMs / 1000) * fps;
  if (!(sourceFrames > 0)) return [];
  const rate = Math.max(0.01, playbackRate || 1);
  const sourceStart = Math.max(0, srcInFrame);
  const sourceEnd = sourceStart + durationInFrames * rate;
  const aspect = cellWidth / cellHeight;
  const naturalTileWidth = heightPx * aspect;
  const sampleWidth = sourceFrames / frameCount;
  const sampleTimelineWidth = sampleWidth / rate * px;
  const groupSize = Math.max(1, Math.ceil((naturalTileWidth * 0.9) / Math.max(0.01, sampleTimelineWidth)));
  const tiles: FilmstripDrawTile[] = [];

  const appendInterval = (frameIndex: number, intervalStart: number, intervalEnd: number) => {
    const visibleStart = Math.max(sourceStart, intervalStart);
    const visibleEnd = Math.min(sourceEnd, intervalEnd);
    if (!(visibleEnd > visibleStart)) return;
    const xStart = Math.max(0, Math.min(widthPx, ((visibleStart - sourceStart) / rate) * px));
    const xEnd = Math.max(xStart, Math.min(widthPx, ((visibleEnd - sourceStart) / rate) * px));
    const span = xEnd - xStart;
    if (!(span > 0.25)) return;

    const tileWidth = Math.min(naturalTileWidth, span);
    const tileHeight = tileWidth / aspect;
    const y = (heightPx - tileHeight) / 2;
    for (let x = xStart; x < xEnd - 0.01; x += tileWidth) {
      const width = Math.min(tileWidth, xEnd - x);
      tiles.push({
        frameIndex,
        sourceWidth: cellWidth * (width / tileWidth),
        x,
        y,
        width,
        height: tileHeight,
      });
    }
  };

  for (let first = 0; first < frameCount; first += groupSize) {
    const after = Math.min(frameCount, first + groupSize);
    const intervalStart = first * sampleWidth;
    const intervalEnd = after === frameCount ? sourceFrames : after * sampleWidth;
    const visibleStart = Math.max(sourceStart, intervalStart);
    const visibleEnd = Math.min(sourceEnd, intervalEnd);
    if (!(visibleEnd > visibleStart)) continue;
    const center = (visibleStart + visibleEnd) / 2;
    const frameIndex = Math.max(first, Math.min(after - 1, Math.floor(center / sampleWidth)));
    appendInterval(frameIndex, intervalStart, intervalEnd);
  }

  // Clips may extend past the media's duration, in which case the editor
  // freezes the last frame. Keep that same behavior in the timeline strip.
  if (sourceEnd > sourceFrames && sourceStart < sourceEnd) {
    appendInterval(frameCount - 1, sourceFrames, sourceEnd);
  }

  return tiles;
}
