import { memo, useEffect, useMemo, useRef, useState } from 'react';
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

const staggeredQueue: Array<() => void> = [];
let staggeredRaf = 0;

function flushStaggeredQueue() {
  staggeredRaf = 0;
  const deadline = performance.now() + 4.5;
  let ran = 0;
  while (staggeredQueue.length > 0 && (ran === 0 || (ran < 3 && performance.now() < deadline))) {
    const task = staggeredQueue.shift()!;
    ran += 1;
    task();
  }
  if (staggeredQueue.length > 0) {
    staggeredRaf = requestAnimationFrame(flushStaggeredQueue);
  }
}

function enqueueStaggeredTask(task: () => void): () => void {
  staggeredQueue.push(task);
  if (!staggeredRaf) staggeredRaf = requestAnimationFrame(flushStaggeredQueue);
  return () => {
    const idx = staggeredQueue.indexOf(task);
    if (idx >= 0) staggeredQueue.splice(idx, 1);
  };
}

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
  widthPx: number;
  heightPx: number;
}

function FilmstripLayer({ geometry, heightPx, hasWave, strip, stripUrl, metadata, fps, px, playbackRate }: {
  geometry: ClipMediaGeometry;
  heightPx: number;
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
  const lastPaintedRef = useRef<{ stripUrl: string; px: number } | null>(null);
  const zoomTimerRef = useRef<number | null>(null);

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
      widthPx: geometry.widthPx,
      heightPx,
    };
    // Static strips can number in the hundreds; avoid an accelerated layer per tiny canvas.
    const context = canvas.getContext('2d');
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
      if (!(params.widthPx > 0 && params.heightPx > 0)) return;
      const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const backingWidth = Math.max(1, Math.round(params.widthPx * scale));
      const backingHeight = Math.max(1, Math.round(params.heightPx * scale));
      if (canvas.width !== backingWidth) canvas.width = backingWidth;
      if (canvas.height !== backingHeight) canvas.height = backingHeight;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, params.widthPx, params.heightPx);

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
        widthPx: params.widthPx,
        heightPx: params.heightPx,
      });
      for (const tile of tiles) {
        context.drawImage(
          image,
          tile.frameIndex * meta.cellWidth, 0,
          tile.sourceWidth, meta.cellHeight,
          tile.x, tile.y, tile.width, tile.height,
        );
      }
      lastPaintedRef.current = { stripUrl: params.stripUrl, px: params.px };
    };

    const schedule = () => {
      if (disposed || raf) return;
      raf = requestAnimationFrame(paint);
    };
    scheduleRef.current = schedule;

    const onLoad = () => schedule();
    if (!image.complete) image.addEventListener('load', onLoad, { once: true });
    else schedule();
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (scheduleRef.current === schedule) scheduleRef.current = null;
      image.removeEventListener('load', onLoad);
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
          widthPx: geometry.widthPx,
          heightPx,
        }
      : null;
    if (zoomTimerRef.current !== null) {
      window.clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = null;
    }
    let cancelStagger: (() => void) | null = null;
    const canvas = canvasRef.current;
    const hasBitmap = !!canvas && canvas.width > 0 && canvas.height > 0;
    const onlyZoomChanged = hasBitmap
      && lastPaintedRef.current?.stripUrl === stripUrl
      && lastPaintedRef.current?.px !== px;
    if (onlyZoomChanged) {
      zoomTimerRef.current = window.setTimeout(() => {
        zoomTimerRef.current = null;
        cancelStagger = enqueueStaggeredTask(() => {
          cancelStagger = null;
          scheduleRef.current?.();
        });
      }, 80);
    } else {
      scheduleRef.current?.();
    }
    return () => {
      if (zoomTimerRef.current !== null) {
        window.clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = null;
      }
      cancelStagger?.();
      cancelStagger = null;
    };
  }, [stripUrl, metadata, fps, px, geometry.srcInFrame, geometry.durationInFrames, geometry.widthPx, heightPx, playbackRate]);

  return (
    <div
      className="cc-clip-filmstrip"
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

function WaveLayer({ geometry, viewBoxWidth, height, path, strip, video }: {
  geometry: ClipMediaGeometry;
  viewBoxWidth: number;
  height: number;
  path: string;
  strip: boolean;
  video: boolean;
}) {
  return (
    <svg
      aria-hidden
      className={`cc-clip-wave${video ? ' on-video' : ''}`}
      viewBox={`0 0 ${viewBoxWidth.toFixed(1)} ${height.toFixed(1)}`}
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
  const geoWidthPx = geometry?.widthPx ?? 0;
  const geoSrcInFrame = geometry?.srcInFrame ?? 0;
  const geoDurationInFrames = geometry?.durationInFrames ?? 0;
  const [settledPx, setSettledPx] = useState(px);
  const lastWaveRef = useRef<{ path: string; widthPx: number; px: number } | null>(null);
  useEffect(() => {
    if (px === settledPx) return;
    if (!lastWaveRef.current?.path) {
      setSettledPx(px);
      return;
    }
    let cancelStagger: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelStagger = enqueueStaggeredTask(() => {
        cancelStagger = null;
        setSettledPx(px);
      });
    }, 80);
    return () => {
      window.clearTimeout(timer);
      cancelStagger?.();
      cancelStagger = null;
    };
  }, [px, settledPx]);

  const zoomPending = px !== settledPx && !!lastWaveRef.current?.path;
  const computedWave = useMemo(() => {
    if (zoomPending && lastWaveRef.current) {
      return lastWaveRef.current;
    }
    const path = preview && geoWidthPx > 0 && hasWave && height > 0
      ? peaksPath(preview, {
          widthPx: geoWidthPx, height: waveH, fps,
          srcInFrame: geoSrcInFrame, durationInFrames: geoDurationInFrames, playbackRate,
        })
      : '';
    return { path, widthPx: geoWidthPx, px };
  }, [zoomPending, preview, geoWidthPx, geoSrcInFrame, geoDurationInFrames, hasWave, height, waveH, fps, playbackRate, px]);
  if (!zoomPending) {
    lastWaveRef.current = computedWave.path ? computedWave : null;
  }

  if (!preview || !geometry || height <= 0) return null;

  const strip = isVideo ? filmstripBackground(preview, {
    px, fps, srcInFrame: geometry.srcInFrame, playbackRate,
  }) : null;

  return (
    <>
      {hasStrip && <FilmstripLayer
        geometry={geometry}
        heightPx={hasWave ? height * STRIP_RATIO : height}
        hasWave={hasWave}
        strip={strip}
        stripUrl={preview.stripUrl}
        metadata={preview.stripMetadata}
        fps={fps}
        px={px}
        playbackRate={playbackRate}
      />}
      {computedWave.path && (
        <WaveLayer
          geometry={geometry}
          viewBoxWidth={computedWave.widthPx > 0 ? computedWave.widthPx : geoWidthPx}
          height={waveH}
          path={computedWave.path}
          strip={hasStrip}
          video={isVideo}
        />
      )}
    </>
  );
});
