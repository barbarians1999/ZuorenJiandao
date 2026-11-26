import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Img, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { gifFrameIndexAtTimeMs, parseGifTiming, type GifTiming } from '../../shared/gif-timing.mjs';
import type { TimelineItem } from './types';

interface CachedGifEntry {
  bytes: Uint8Array;
  timing: GifTiming;
  width: number;
  height: number;
  decoder: ImageDecoder | null;
  decoderFailed: boolean;
  frames: Map<number, ImageBitmap>;
  inFlight: Map<number, Promise<ImageBitmap | null>>;
}

const MAX_CACHED_GIFS = 16;
const MAX_CACHED_FRAMES_PER_GIF = 120;
const gifCache = new Map<string, CachedGifEntry>();
const gifLoadPromises = new Map<string, Promise<CachedGifEntry | null>>();

function closeEntryResources(entry: CachedGifEntry): void {
  for (const bmp of entry.frames.values()) {
    try { bmp.close(); } catch {}
  }
  entry.frames.clear();
  if (entry.decoder) {
    try { entry.decoder.close(); } catch {}
    entry.decoder = null;
  }
}

function touchCacheEntry(src: string, entry: CachedGifEntry): void {
  if (gifCache.has(src)) gifCache.delete(src);
  gifCache.set(src, entry);
  while (gifCache.size > MAX_CACHED_GIFS) {
    const oldestKey = gifCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = gifCache.get(oldestKey);
    gifCache.delete(oldestKey);
    if (oldest) closeEntryResources(oldest);
  }
}

async function createGifDecoder(bytes: Uint8Array): Promise<ImageDecoder | null> {
  if (typeof ImageDecoder === 'undefined') return null;
  try {
    if (typeof ImageDecoder.isTypeSupported === 'function') {
      const supported = await ImageDecoder.isTypeSupported('image/gif');
      if (!supported) return null;
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const decoder = new ImageDecoder({ data: copy.buffer, type: 'image/gif' });
    await decoder.tracks.ready;
    return decoder;
  } catch {
    return null;
  }
}

async function loadGifEntry(src: string): Promise<CachedGifEntry | null> {
  const cached = gifCache.get(src);
  if (cached) {
    touchCacheEntry(src, cached);
    return cached;
  }
  const existing = gifLoadPromises.get(src);
  if (existing) return existing;

  const task = (async (): Promise<CachedGifEntry | null> => {
    try {
      const response = await fetch(src);
      if (!response.ok) return null;
      const buf = await response.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const timing = parseGifTiming(bytes);
      const decoder = timing.frameCount > 1 ? await createGifDecoder(bytes) : null;
      const rep = decoder?.tracks?.selectedTrack?.repetitionCount;
      const normalizedTiming: GifTiming = rep === Infinity
        ? { ...timing, loopCount: 0 }
        : Number.isFinite(rep) && (rep ?? 0) >= 0
          ? { ...timing, loopCount: Math.max(1, (rep ?? 0) + 1) }
          : timing;
      const entry: CachedGifEntry = {
        bytes,
        timing: normalizedTiming,
        width: Math.max(1, timing.width ?? 1),
        height: Math.max(1, timing.height ?? 1),
        decoder,
        decoderFailed: !decoder && timing.frameCount > 1,
        frames: new Map(),
        inFlight: new Map(),
      };
      touchCacheEntry(src, entry);
      return entry;
    } catch {
      return null;
    } finally {
      gifLoadPromises.delete(src);
    }
  })();

  gifLoadPromises.set(src, task);
  return task;
}

async function decodeGifFrameBitmap(entry: CachedGifEntry, frameIndex: number): Promise<ImageBitmap | null> {
  const cached = entry.frames.get(frameIndex);
  if (cached) {
    entry.frames.delete(frameIndex);
    entry.frames.set(frameIndex, cached);
    return cached;
  }
  const inflight = entry.inFlight.get(frameIndex);
  if (inflight) return inflight;

  const task = (async (): Promise<ImageBitmap | null> => {
    try {
      if (!entry.decoder && !entry.decoderFailed) {
        entry.decoder = await createGifDecoder(entry.bytes);
        if (!entry.decoder) entry.decoderFailed = true;
      }
      if (!entry.decoder) return null;
      const result = await entry.decoder.decode({ frameIndex, completeFramesOnly: true });
      const videoFrame = result.image;
      try {
        const w = videoFrame.displayWidth || videoFrame.codedWidth || entry.width;
        const h = videoFrame.displayHeight || videoFrame.codedHeight || entry.height;
        if (w > 0 && h > 0) {
          entry.width = w;
          entry.height = h;
        }
        const bitmap = await createImageBitmap(videoFrame);
        entry.frames.set(frameIndex, bitmap);
        while (entry.frames.size > MAX_CACHED_FRAMES_PER_GIF) {
          const oldestIdx = entry.frames.keys().next().value;
          if (oldestIdx === undefined) break;
          const oldBmp = entry.frames.get(oldestIdx);
          entry.frames.delete(oldestIdx);
          try { oldBmp?.close(); } catch {}
        }
        return bitmap;
      } finally {
        videoFrame.close();
      }
    } catch {
      return null;
    } finally {
      entry.inFlight.delete(frameIndex);
    }
  })();

  entry.inFlight.set(frameIndex, task);
  return task;
}

/**
 * Resolve exact source time (ms) for a GIF clip at a given clip-local timeline frame.
 */
export function gifSourceTimeMsAtLocalFrame(
  item: Pick<TimelineItem, 'srcInFrame' | 'playbackRate'>,
  localFrame: number,
  fps: number,
): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const safeRate = Number.isFinite(item.playbackRate) && (item.playbackRate ?? 1) > 0
    ? Math.max(0.01, item.playbackRate ?? 1)
    : 1;
  const srcIn = Number.isFinite(item.srcInFrame) && (item.srcInFrame ?? 0) >= 0
    ? (item.srcInFrame ?? 0)
    : 0;
  const sourceFrame = srcIn + Math.max(0, localFrame) * safeRate;
  return (sourceFrame / safeFps) * 1000;
}

/**
 * Deterministic GIF renderer bound to Remotion timeline frames (not wall-clock browser loop).
 */
export function SyncedGif({ src, item, frameOffset = 0, style }: {
  src: string;
  item: Pick<TimelineItem, 'srcInFrame' | 'playbackRate'>;
  frameOffset?: number;
  style?: CSSProperties;
}) {
  const seqFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const environment = getRemotionEnvironment();
  const localFrame = Math.max(0, seqFrame + frameOffset);
  const sourceTimeMs = gifSourceTimeMsAtLocalFrame(item, localFrame, fps);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fallbackToImg, setFallbackToImg] = useState(false);
  const [entryVersion, setEntryVersion] = useState(0);
  const entry = gifCache.get(src) ?? null;

  const targetFrameIndex = entry && entry.timing.frameCount > 1
    ? gifFrameIndexAtTimeMs(entry.timing, sourceTimeMs)
    : 0;
  const targetBitmap = entry?.frames.get(targetFrameIndex) ?? null;
  const needsAsyncResolve = !fallbackToImg && (!entry || (entry.timing.frameCount > 1 && !entry.decoderFailed && !targetBitmap));
  const useStaticImg = fallbackToImg || Boolean(entry && (entry.timing.frameCount <= 1 || entry.decoderFailed));

  const renderDelayRef = useRef<number | null>(null);
  const paintKey = `${src}#${targetFrameIndex}`;
  const drawnKeyRef = useRef<string | null>(null);
  const needsCanvasPaint = !useStaticImg && Boolean(targetBitmap) && drawnKeyRef.current !== paintKey;

  if (environment.isRendering && (needsAsyncResolve || needsCanvasPaint) && renderDelayRef.current === null) {
    renderDelayRef.current = delayRender(`SyncedGif:${src}`);
  }

  const releaseRenderDelay = () => {
    if (renderDelayRef.current !== null) {
      const handle = renderDelayRef.current;
      renderDelayRef.current = null;
      continueRender(handle);
    }
  };

  useEffect(() => () => {
    releaseRenderDelay();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setFallbackToImg(false);
    if (!src) return undefined;

    (async () => {
      const loaded = await loadGifEntry(src);
      if (cancelled) return;
      if (!loaded) {
        setFallbackToImg(true);
        return;
      }
      if (loaded.timing.frameCount > 1 && !loaded.decoderFailed) {
        const frameIdx = gifFrameIndexAtTimeMs(loaded.timing, sourceTimeMs);
        const bmp = await decodeGifFrameBitmap(loaded, frameIdx);
        if (cancelled) return;
        if (!bmp) {
          loaded.decoderFailed = true;
          setFallbackToImg(true);
        }
      }
      setEntryVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [src, sourceTimeMs]);

  useLayoutEffect(() => {
    if (useStaticImg) {
      drawnKeyRef.current = null;
      releaseRenderDelay();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || !entry || !targetBitmap) return;
    if (canvas.width !== entry.width || canvas.height !== entry.height) {
      canvas.width = entry.width;
      canvas.height = entry.height;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(targetBitmap, 0, 0, canvas.width, canvas.height);
      drawnKeyRef.current = paintKey;
    }
    releaseRenderDelay();
  }, [useStaticImg, entry, targetBitmap, paintKey, entryVersion]);

  if (useStaticImg) {
    return <Img src={src} style={style} onLoad={releaseRenderDelay} onError={releaseRenderDelay} />;
  }

  return (
    <canvas
      ref={canvasRef}
      width={entry?.width ?? 1}
      height={entry?.height ?? 1}
      style={style}
    />
  );
}
