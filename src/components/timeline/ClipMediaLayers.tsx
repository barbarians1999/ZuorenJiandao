import { memo, useEffect, useMemo, useRef } from 'react';
import type { TimelineItem } from '../../editor/types';
import { filmstripBackground, peaksPath, useClipPreview } from '../../media/clipPreview';
import { filmstripDrawPlan } from '../../media/filmstripLayout';
import type { FilmstripMetadata } from '../../media/clipPreview';
import type { TimelineFrameWindow } from './timelineUtil';
import { clipMediaGeometry, type ClipMediaGeometry } from './clipMediaGeometry';

// Media preview layer within the clip: The video track displays thumbnail frame bars and the sound waves of the clip's own audio track.
// Data comes from /api/waveform, /api/filmstrip (see src/media/clipPreview.ts); geometry button
// srcIn/playbackRate/px mapping, so the frames and waves are in the right position after cropping, speed changing, and timeline scaling.
// The layer is under the label (z-index 0), the pointer is not blocked, and the drag/cropping feel remains unchanged.

const STRIP_RATIO = 0.62; // Video with sound: upper 62% frame bar, lower 38% sound wave
const MAX_STRIP_IMAGE_CACHE = 40;
const stripImageCache = new Map<string, HTMLImageElement>();

function acquireStripImage(stripUrl: string): HTMLImageElement {
  const cached = stripImageCache.get(stripUrl);
  if (cached) {
    stripImageCache.delete(stripUrl);
    stripImageCache.set(stripUrl, cached);
    return cached;
  }
  const image = new Image();
  image.decoding = 'async';
  image.src = stripUrl;
  stripImageCache.set(stripUrl, image);
  if (stripImageCache.size > MAX_STRIP_IMAGE_CACHE) {
    const oldest = stripImageCache.keys().next().value;
    if (oldest) stripImageCache.delete(oldest);
  }
  return image;
}

interface FilmstripStyle {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPositionX: string;
}

interface FilmstripPaintParams {
  stripUrl: string;
  metadata: FilmstripMetadata;
  fps: number;
  px: number;
  srcInFrame: number;
  durationInFrames: number;
  playbackRate: number;
}

function FilmstripLayer({ geometry, hasWave, strip, stripUrl, metadata, fps, px, playbackRate }: {
  geometry: ClipMediaGeometry;
  hasWave: boolean;
  strip: FilmstripStyle | null;
  stripUrl: string | null;
  metadata?: FilmstripMetadata;
  fps: number;
  px: number;
  playbackRate: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintParamsRef = useRef<FilmstripPaintParams | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stripUrl || !metadata) return;
    paintParamsRef.current = {
      stripUrl,
      metadata,
      fps,
      px,
      srcInFrame: geometry.srcInFrame,
      durationInFrames: geometry.durationInFrames,
      playbackRate,
    };
    // Static strips can number in the hundreds; avoid an accelerated layer per tiny canvas.
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    const image = acquireStripImage(stripUrl);
    let disposed = false;
    let raf = 0;

    const paint = () => {
      raf = 0;
      const params = paintParamsRef.current;
      if (!params) return;
      const { metadata: meta } = params;
      if (
        disposed || image.naturalWidth < meta.frameCount * meta.cellWidth
        || image.naturalHeight < meta.cellHeight
      ) return;
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return;
      const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const backingWidth = Math.max(1, Math.round(rect.width * scale));
      const backingHeight = Math.max(1, Math.round(rect.height * scale));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      const tiles = filmstripDrawPlan({
        durationMs: meta.durationMs,
        frameCount: meta.frameCount,
        cellWidth: meta.cellWidth,
        cellHeight: meta.cellHeight,
        fps: params.fps,
        px: params.px,
        srcInFrame: params.srcInFrame,
        durationInFrames: params.durationInFrames,
        playbackRate: params.playbackRate,
        widthPx: rect.width,
        heightPx: rect.height,
      });
      for (const tile of tiles) {
        context.drawImage(
          image,
          tile.frameIndex * meta.cellWidth, 0,
          tile.sourceWidth, meta.cellHeight,
          tile.x, tile.y, tile.width, tile.height,
        );
      }
    };

    const schedule = () => {
      if (disposed || raf) return;
      raf = requestAnimationFrame(paint);
    };
    scheduleRef.current = schedule;

    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    const onLoad = () => schedule();
    if (!image.complete) image.addEventListener('load', onLoad, { once: true });
    else schedule();
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (scheduleRef.current === schedule) scheduleRef.current = null;
      image.removeEventListener('load', onLoad);
      observer.disconnect();
    };
  }, [stripUrl, metadata]);

  useEffect(() => {
    paintParamsRef.current = stripUrl && metadata
      ? {
          stripUrl,
          metadata,
          fps,
          px,
          srcInFrame: geometry.srcInFrame,
          durationInFrames: geometry.durationInFrames,
          playbackRate,
        }
      : null;
    scheduleRef.current?.();
  }, [stripUrl, metadata, fps, px, geometry.srcInFrame, geometry.durationInFrames, playbackRate]);

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute', left: geometry.leftPx, width: geometry.widthPx, top: 0,
        height: hasWave ? `${STRIP_RATIO * 100}%` : '100%',
        zIndex: 0, pointerEvents: 'none', overflow: 'hidden', opacity: 0.92,
        backgroundRepeat: 'no-repeat',
        ...(metadata || !strip ? {} : strip),
      }}
    >
      {metadata && stripUrl && <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />}
    </div>
  );
}

function WaveLayer({ geometry, height, path, strip, video }: {
  geometry: ClipMediaGeometry;
  height: number;
  path: string;
  strip: boolean;
  video: boolean;
}) {
  return (
    <svg
      aria-hidden
      className={`cc-clip-wave${video ? ' on-video' : ''}`}
      viewBox={`0 0 ${geometry.widthPx.toFixed(1)} ${height.toFixed(1)}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute', left: geometry.leftPx, width: geometry.widthPx, bottom: 0,
        height: strip ? `${(1 - STRIP_RATIO) * 100}%` : '100%',
        zIndex: 0, pointerEvents: 'none', overflow: 'hidden',
      }}
    >
      <path d={path} />
    </svg>
  );
}

export const ClipMediaLayers = memo(function ClipMediaLayers({ item, px, fps, height, clipStartFrame, durationInFrames,
  srcInFrame, playbackRate, visibleWindow }: {
  item: TimelineItem;
  px: number;
  /** The height of the fragment content area (px), the amplitude of the sound wave path is calculated based on it */
  height: number;
  fps: number;
  clipStartFrame: number;
  durationInFrames: number;
  srcInFrame: number;
  playbackRate: number;
  visibleWindow: TimelineFrameWindow;
}) {
  const preview = useClipPreview(item.src, item.kind, item.sourceRevision);
  const geometry = clipMediaGeometry({
    clipStartFrame, durationInFrames, srcInFrame, playbackRate, px, visibleWindow,
  });
  const isVideo = item.kind === 'video';
  const hasStrip = isVideo && !!preview?.stripUrl;
  const hasWave = (preview?.peaks.length ?? 0) > 0;
  const waveH = hasStrip && hasWave ? Math.max(6, height * (1 - STRIP_RATIO)) : height;
  const d = useMemo(() => (
    preview && geometry && hasWave && height > 0
      ? peaksPath(preview, {
          widthPx: geometry.widthPx, height: waveH, fps,
          srcInFrame: geometry.srcInFrame, durationInFrames: geometry.durationInFrames, playbackRate,
        })
      : ''
  ), [preview, geometry, hasWave, height, waveH, fps, playbackRate]);

  if (!preview || !geometry || height <= 0) return null;

  const strip = isVideo ? filmstripBackground(preview, {
    px, fps, srcInFrame: geometry.srcInFrame, playbackRate,
  }) : null;

  return (
    <>
      {hasStrip && <FilmstripLayer
        geometry={geometry}
        hasWave={hasWave}
        strip={strip}
        stripUrl={preview.stripUrl}
        metadata={preview.stripMetadata}
        fps={fps}
        px={px}
        playbackRate={playbackRate}
      />}
      {d && <WaveLayer geometry={geometry} height={waveH} path={d} strip={hasStrip} video={isVideo} />}
    </>
  );
});
