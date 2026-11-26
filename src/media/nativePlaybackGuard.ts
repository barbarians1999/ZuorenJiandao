const GUARDED_MEDIA_ELEMENTS = new WeakSet<HTMLMediaElement>();

/**
 * Append a non-fragment hash when none exists so Remotion's `<Html5Video>`
 * does not append a `#t=start,end` media fragment that truncates playback
 * when a clip's source offset exceeds the edited timeline duration or rate > 1.
 */
export function withOpenEndedPreviewHash(src: string): string {
  if (!src || src.startsWith('data:') || src.includes('#')) return src;
  return `${src}#preview`;
}

/**
 * Provide sufficient wall-clock decode headroom before Remotion's
 * `seek-due-to-shift` aborts and restarts an in-flight GOP seek.
 */
export function nativeAcceptableTimeShiftSeconds(
  clipPlaybackRate?: number,
  globalPlaybackRate?: number,
): number {
  const clipRate = Number.isFinite(clipPlaybackRate) && (clipPlaybackRate ?? 1) > 0
    ? (clipPlaybackRate ?? 1)
    : 1;
  const globalRate = Number.isFinite(globalPlaybackRate) && (globalPlaybackRate ?? 1) > 0
    ? (globalPlaybackRate ?? 1)
    : 1;
  const effectiveRate = Math.max(0.25, clipRate * globalRate);
  return Math.max(2.2, 2.2 * effectiveRate);
}

function findCurrentTimeDescriptor(el: HTMLMediaElement): PropertyDescriptor | undefined {
  if (typeof HTMLMediaElement !== 'undefined') {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    if (desc?.get && desc?.set) return desc;
  }
  let proto: object | null = el;
  while (proto && proto !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'currentTime');
    if (desc?.get && desc?.set) return desc;
    proto = Object.getPrototypeOf(proto);
  }
  return undefined;
}

function promotePreload(el: HTMLMediaElement): void {
  const src = el.currentSrc || el.src || '';
  if (!src || src.startsWith('data:')) return;
  try {
    if (el.preload !== 'auto') el.preload = 'auto';
  } catch {
    // Ignore read-only preload stubs in non-DOM test doubles.
  }
}

/** Strip any `#preview` fragment and unwrap `/api/preview-proxy-file?src=...` to its original source URL. */
export function extractOriginalPreviewSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const withoutHash = src.split('#')[0] ?? src;
  const qIndex = withoutHash.indexOf('?');
  if (qIndex >= 0) {
    const base = withoutHash.slice(0, qIndex);
    if (base.endsWith('/api/preview-proxy-file')) {
      const params = new URLSearchParams(withoutHash.slice(qIndex + 1));
      const raw = params.get('src');
      return raw || withoutHash;
    }
  }
  return withoutHash;
}

/** Release decoded media buffers, hardware decoder sessions, and HTTP sockets held by a video element. */
export function releaseNativeVideoElement(video: HTMLVideoElement | null | undefined): void {
  if (!video) return;
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch {
    // Ignore teardown errors on detached nodes
  }
}

export function attachNativeVideoStallWatchdog(
  video: HTMLVideoElement,
  options: {
    onFallback: (reason: string) => void;
    retryDelayMs?: number;
    fallbackDelayMs?: number;
  },
): () => void {
  const retryDelayMs = options.retryDelayMs ?? 2500;
  const fallbackDelayMs = options.fallbackDelayMs ?? 4000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retried = false;
  let settled = false;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    video.removeEventListener('loadedmetadata', onLoadedMetadata);
    video.removeEventListener('loadeddata', onReady);
    video.removeEventListener('canplay', onReady);
    video.removeEventListener('canplaythrough', onReady);
    video.removeEventListener('playing', onReady);
    video.removeEventListener('stalled', onStalledOrWaiting);
    video.removeEventListener('waiting', onStalledOrWaiting);
    video.removeEventListener('emptied', onEmptied);
  };

  const triggerFallback = (reason: string) => {
    if (settled || disposed) return;
    settled = true;
    cleanup();
    options.onFallback(reason);
  };

  const checkZeroDimensions = (): boolean => {
    if (video.readyState >= 1 && video.videoWidth === 0 && video.videoHeight === 0) {
      triggerFallback('zero-video-dimensions');
      return true;
    }
    return false;
  };

  const scheduleWatch = () => {
    if (disposed || settled || timer !== null) return;
    const src = video.currentSrc || video.src || '';
    if (!src || video.readyState >= 2) return;
    const delay = retried ? fallbackDelayMs : retryDelayMs;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || settled || video.isConnected === false) return;
      if (checkZeroDimensions()) return;
      if (video.readyState >= 2) return;
      if (!retried) {
        retried = true;
        const targetTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const onReapply = () => {
          if (disposed || settled) return;
          if (checkZeroDimensions()) return;
          try {
            if (targetTime > 0 && Math.abs(video.currentTime - targetTime) > 0.02) {
              video.currentTime = targetTime;
            }
          } catch { /* ignore */ }
        };
        video.addEventListener('loadedmetadata', onReapply, { once: true });
        try {
          video.load();
        } catch {
          // Ignore load failures; fallback timer below handles unrecovered stalls.
        }
        scheduleWatch();
        return;
      }
      triggerFallback('video-decode-stalled');
    }, delay);
  };

  const onLoadedMetadata = () => {
    if (checkZeroDimensions()) return;
    if (video.readyState < 2) scheduleWatch();
  };

  const onReady = () => {
    if (checkZeroDimensions()) return;
    clearTimer();
  };

  const onStalledOrWaiting = () => {
    if (video.readyState < 2) scheduleWatch();
  };

  const onEmptied = () => {
    clearTimer();
  };

  video.addEventListener('loadedmetadata', onLoadedMetadata);
  video.addEventListener('loadeddata', onReady);
  video.addEventListener('canplay', onReady);
  video.addEventListener('canplaythrough', onReady);
  video.addEventListener('playing', onReady);
  video.addEventListener('stalled', onStalledOrWaiting);
  video.addEventListener('waiting', onStalledOrWaiting);
  video.addEventListener('emptied', onEmptied);

  if (!checkZeroDimensions() && video.readyState < 2) {
    scheduleWatch();
  }

  return cleanup;
}

/**
 * Idempotently harden a native `<video>` or shared `<audio>` element for
 * timeline playback:
 * 1. Promote `preload` to `'auto'` for real media URLs so premounted tags buffer.
 * 2. Coalesce `readyState === 0` (`HAVE_NOTHING`) `currentTime` writes until
 *    `loadedmetadata` arrives so Remotion does not thrash 30Hz seeks.
 */
export function attachNativeMediaElementGuard(el: HTMLMediaElement | null): void {
  if (!el) return;
  promotePreload(el);
  if (GUARDED_MEDIA_ELEMENTS.has(el)) return;
  GUARDED_MEDIA_ELEMENTS.add(el);

  let pendingMetadataSeek: number | null = null;
  let pendingSeekSrc: string | null = null;
  let metadataSeekScheduled = false;

  const descriptor = findCurrentTimeDescriptor(el);
  const nativeGet = descriptor?.get;
  const nativeSet = descriptor?.set;

  const onLoadedMetadata = () => {
    metadataSeekScheduled = false;
    const target = pendingMetadataSeek;
    pendingMetadataSeek = null;
    pendingSeekSrc = null;
    if (target === null || el.readyState < 1 || !nativeGet || !nativeSet) return;
    const duration = el.duration;
    const clampedTarget = Number.isFinite(duration) && duration > 0
      ? Math.min(Math.max(0, duration - 0.001), Math.max(0, target))
      : Math.max(0, target);
    const current = Number(nativeGet.call(el));
    if (!Number.isFinite(current) || Math.abs(current - clampedTarget) > 0.02) {
      nativeSet.call(el, clampedTarget);
    }
  };

  const resetMetadataSeek = () => {
    pendingMetadataSeek = null;
    pendingSeekSrc = null;
    if (metadataSeekScheduled) {
      metadataSeekScheduled = false;
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
    }
  };

  el.addEventListener('emptied', resetMetadataSeek);
  el.addEventListener('loadstart', () => {
    const currentSrc = el.currentSrc || el.src || '';
    if (pendingMetadataSeek !== null && currentSrc !== '' && currentSrc !== pendingSeekSrc) {
      resetMetadataSeek();
    }
    promotePreload(el);
  });

  if (!descriptor || descriptor.configurable === false || !nativeGet || !nativeSet) {
    return;
  }

  try {
    Object.defineProperty(el, 'currentTime', {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      get() {
        if (el.readyState === 0 && pendingMetadataSeek !== null) {
          return pendingMetadataSeek;
        }
        return nativeGet.call(el);
      },
      set(value: number) {
        if (!Number.isFinite(value)) return;
        const normalized = Math.max(0, value);
        if (el.readyState === 0) {
          const firstWhileUnloaded = pendingMetadataSeek === null;
          pendingMetadataSeek = normalized;
          pendingSeekSrc = el.currentSrc || el.src || '';
          if (!metadataSeekScheduled) {
            metadataSeekScheduled = true;
            el.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
          }
          if (firstWhileUnloaded) {
            nativeSet.call(el, normalized);
          }
          return;
        }
        resetMetadataSeek();
        nativeSet.call(el, normalized);
      },
    });
  } catch {
    // Keep element functional if runtime locks own-property currentTime redefinition.
  }
}
