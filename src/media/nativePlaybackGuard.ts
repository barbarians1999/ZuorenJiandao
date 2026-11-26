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
  let metadataSeekScheduled = false;

  const descriptor = findCurrentTimeDescriptor(el);
  const nativeGet = descriptor?.get;
  const nativeSet = descriptor?.set;

  const onLoadedMetadata = () => {
    metadataSeekScheduled = false;
    const target = pendingMetadataSeek;
    pendingMetadataSeek = null;
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
    if (metadataSeekScheduled) {
      metadataSeekScheduled = false;
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
    }
  };

  el.addEventListener('emptied', resetMetadataSeek);
  el.addEventListener('loadstart', () => {
    resetMetadataSeek();
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
