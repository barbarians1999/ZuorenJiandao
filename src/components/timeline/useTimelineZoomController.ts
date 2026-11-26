import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { loadTimelineView, saveTimelineView } from '../../persist/sessionPrefs';
import {
  clampTimelineZoom,
  defaultTimelineZoom,
  fitTimelineZoom,
  playheadAnchoredTimelineScrollLeft,
  scaleTimelineZoom,
  timelineZoomLimitsForFit,
  type TimelineZoomLimits,
} from '../../editor/timelineZoom';
import {
  HEADER_W,
  MIN_TIME_ZOOM,
  PX_PER_FRAME,
  RULER_LABEL_MIN_PX,
} from './timelineUtil';

const MAX_TIME_ZOOM = 6;
const TRACK_MIN = 0.6;
const TRACK_MAX = 3;
const TIMELINE_FIT_PADDING = 48;
type NumberSetter = Dispatch<SetStateAction<number>>;

interface TimelineZoomControllerOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  totalFrames: number;
  fps: number;
  projectId?: string;
  timelineId?: string;
  getPlayheadFrame?: () => number;
}

interface ZoomViewState {
  key: string;
  zoom: number;
  trackScale: number;
}

function limitsForWidth(viewportWidth: number, totalFrames: number): TimelineZoomLimits {
  return timelineZoomLimitsForFit(
    viewportWidth, HEADER_W, TIMELINE_FIT_PADDING, totalFrames, PX_PER_FRAME, MIN_TIME_ZOOM, MAX_TIME_ZOOM,
  );
}

function fittedZoom(element: HTMLDivElement, totalFrames: number, fps: number): number {
  const limits = limitsForWidth(element.clientWidth, totalFrames);
  return fitTimelineZoom(
    element.clientWidth, HEADER_W, TIMELINE_FIT_PADDING, totalFrames, PX_PER_FRAME, limits,
  ) ?? defaultTimelineZoom(fps, PX_PER_FRAME, RULER_LABEL_MIN_PX, limits);
}

function useTimelineWheelZoom(
  scrollRef: RefObject<HTMLDivElement | null>,
  applyAnchoredZoom: NumberSetter,
  setTrackScale: NumberSetter,
  zoomLimits: TimelineZoomLimits,
) {
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let zoomRaf = 0;
    let pendingZoomFactor = 1;
    let scaleRaf = 0;
    let pendingScaleFactor = 1;

    const flushZoom = () => {
      zoomRaf = 0;
      const factor = pendingZoomFactor;
      pendingZoomFactor = 1;
      if (factor !== 1) {
        applyAnchoredZoom((oldZoom) => scaleTimelineZoom(oldZoom, factor, zoomLimits));
      }
    };

    const flushScale = () => {
      scaleRaf = 0;
      const factor = pendingScaleFactor;
      pendingScaleFactor = 1;
      if (factor !== 1) {
        setTrackScale((current) => Math.min(TRACK_MAX, Math.max(TRACK_MIN, current * factor)));
      }
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        if (event.deltaY === 0) return;
        pendingZoomFactor *= event.deltaY < 0 ? 1.12 : 1 / 1.12;
        if (!zoomRaf) zoomRaf = requestAnimationFrame(flushZoom);
        return;
      }
      if (event.altKey && !event.shiftKey) {
        event.preventDefault();
        element.scrollLeft += event.deltaY || event.deltaX;
        return;
      }
      if (!event.altKey || !event.shiftKey) return;
      event.preventDefault();
      if (event.deltaY === 0) return;
      pendingScaleFactor *= event.deltaY < 0 ? 1.1 : 1 / 1.1;
      if (!scaleRaf) scaleRaf = requestAnimationFrame(flushScale);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (zoomRaf) cancelAnimationFrame(zoomRaf);
      if (scaleRaf) cancelAnimationFrame(scaleRaf);
      element.removeEventListener('wheel', onWheel);
    };
  }, [applyAnchoredZoom, scrollRef, setTrackScale, zoomLimits]);
}

export function useTimelineZoomController(options: TimelineZoomControllerOptions) {
  const { scrollRef, totalFrames, fps, projectId, timelineId, getPlayheadFrame } = options;
  const key = `${projectId ?? 'default'}\u0000${timelineId ?? 'default'}`;
  const [view, setView] = useState<ZoomViewState>({ key: '', zoom: 1, trackScale: 1 });
  const totalFramesRef = useRef(totalFrames);
  totalFramesRef.current = totalFrames;
  const [viewportWidth, setViewportWidth] = useState(0);
  const zoomLimits = useMemo(() => limitsForWidth(viewportWidth, totalFrames), [totalFrames, viewportWidth]);
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const getPlayheadFrameRef = useRef(getPlayheadFrame);
  getPlayheadFrameRef.current = getPlayheadFrame;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateWidth = () => {
      const nextWidth = element.clientWidth;
      setViewportWidth((current) => current === nextWidth ? current : nextWidth);
    };
    updateWidth();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef]);
  const zoom = view.key === key ? view.zoom : 1;
  const trackScale = view.key === key ? view.trackScale : 1;
  const viewByKeyRef = useRef<Record<string, Pick<ZoomViewState, 'zoom' | 'trackScale'>>>({});
  if (view.key) viewByKeyRef.current[view.key] = { zoom: view.zoom, trackScale: view.trackScale };
  const initializedKeyRef = useRef<string | null>(null);
  const pendingAutoFitRef = useRef<string | null>(null);
  const pendingScrollRef = useRef<{ targetZoom: number; scrollLeft: number } | null>(null);
  const liveZoomRef = useRef(zoom);
  if (pendingScrollRef.current === null) liveZoomRef.current = zoom;

  const rawSetZoom = useCallback<NumberSetter>((next) => {
    setView((current) => {
      const base = current.key === key ? current : { key, zoom: 1, trackScale: 1 };
      const value = typeof next === 'function' ? next(base.zoom) : next;
      return value === base.zoom ? base : { ...base, zoom: value };
    });
  }, [key]);
  const applyAnchoredZoom = useCallback<NumberSetter>((nextOrUpdater) => {
    const oldZoom = liveZoomRef.current;
    const rawNext = typeof nextOrUpdater === 'function' ? nextOrUpdater(oldZoom) : nextOrUpdater;
    const next = clampTimelineZoom(rawNext, zoomLimits);
    if (next === oldZoom) return;
    const element = scrollRef.current;
    if (element) {
      const baseScroll = pendingScrollRef.current?.scrollLeft ?? element.scrollLeft;
      const rawScroll = playheadAnchoredTimelineScrollLeft(
        baseScroll,
        element.clientWidth,
        HEADER_W,
        getPlayheadFrameRef.current?.() ?? 0,
        PX_PER_FRAME * oldZoom,
        PX_PER_FRAME * next,
      );
      const estimatedInnerWidth = Math.max(
        HEADER_W + totalFramesRef.current * (PX_PER_FRAME * next) + 240,
        element.clientWidth,
      );
      const maxEstimatedScroll = Math.max(0, estimatedInnerWidth - element.clientWidth);
      pendingScrollRef.current = {
        targetZoom: next,
        scrollLeft: Math.min(maxEstimatedScroll, Math.max(0, rawScroll)),
      };
    }
    liveZoomRef.current = next;
    rawSetZoom(next);
  }, [rawSetZoom, scrollRef, zoomLimits]);
  const setTrackScale = useCallback<NumberSetter>((next) => {
    setView((current) => {
      const base = current.key === key ? current : { key, zoom: 1, trackScale: 1 };
      const value = typeof next === 'function' ? next(base.trackScale) : next;
      return value === base.trackScale ? base : { ...base, trackScale: value };
    });
  }, [key]);

  const pendingPersistRef = useRef<{ projectId: string; timelineId: string; patch: { zoom?: number; trackScale?: number; scrollLeft?: number } } | null>(null);
  const persistTimerRef = useRef<number | null>(null);

  const flushPersist = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingPersistRef.current;
    if (!pending) return;
    pendingPersistRef.current = null;
    saveTimelineView(pending.projectId, pending.timelineId, pending.patch);
  }, []);

  const queuePersist = useCallback((pid: string, tid: string, patch: { zoom?: number; trackScale?: number; scrollLeft?: number }) => {
    const cur = pendingPersistRef.current;
    if (cur && cur.projectId === pid && cur.timelineId === tid) {
      Object.assign(cur.patch, patch);
    } else {
      flushPersist();
      pendingPersistRef.current = { projectId: pid, timelineId: tid, patch: { ...patch } };
    }
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(flushPersist, 280);
  }, [flushPersist]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || viewportWidth <= 0 || initializedKeyRef.current === key) return;
    const saved = projectId && timelineId ? loadTimelineView(projectId, timelineId) : null;
    const limits = limitsForWidth(element.clientWidth, totalFramesRef.current);
    const nextZoom = saved
      ? clampTimelineZoom(saved.zoom, limits)
      : totalFramesRef.current > 0
        ? fittedZoom(element, totalFramesRef.current, fpsRef.current)
        : defaultTimelineZoom(fpsRef.current, PX_PER_FRAME, RULER_LABEL_MIN_PX, limits);
    pendingAutoFitRef.current = !saved && totalFramesRef.current <= 0 ? key : null;
    pendingScrollRef.current = null;
    liveZoomRef.current = nextZoom;
    initializedKeyRef.current = key;
    setView({ key, zoom: nextZoom, trackScale: saved?.trackScale ?? 1 });
    element.scrollLeft = saved?.scrollLeft ?? 0;
  }, [key, projectId, scrollRef, timelineId, viewportWidth]);

  useEffect(() => {
    const element = scrollRef.current;
    const views = viewByKeyRef.current;
    if (!element) return;
    return () => {
      flushPersist();
      if (projectId && timelineId) {
        const previous = views[key] ?? { zoom: 1, trackScale: 1 };
        saveTimelineView(projectId, timelineId, {
          zoom: previous.zoom,
          trackScale: previous.trackScale,
          scrollLeft: element.scrollLeft,
        });
      }
    };
  }, [flushPersist, key, projectId, scrollRef, timelineId]);

  useEffect(() => {
    if (view.key !== key) return;
    const clamped = clampTimelineZoom(view.zoom, zoomLimits);
    if (clamped !== view.zoom) applyAnchoredZoom(clamped);
  }, [applyAnchoredZoom, key, view.key, view.zoom, zoomLimits]);

  useEffect(() => {
    if (view.key !== key || !projectId || !timelineId) return;
    queuePersist(projectId, timelineId, { zoom: view.zoom, trackScale: view.trackScale });
  }, [key, projectId, queuePersist, timelineId, view]);

  useEffect(() => {
    if (pendingAutoFitRef.current !== key || totalFrames <= 0) return;
    const element = scrollRef.current;
    if (!element) return;
    pendingAutoFitRef.current = null;
    pendingScrollRef.current = null;
    const fitted = fittedZoom(element, totalFrames, fps);
    liveZoomRef.current = fitted;
    rawSetZoom(fitted);
    element.scrollLeft = 0;
  }, [fps, key, rawSetZoom, scrollRef, totalFrames]);

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const element = scrollRef.current;
    if (!pending || !element) return;
    if (Math.abs(zoom - pending.targetZoom) > 1e-9) return;
    pendingScrollRef.current = null;
    const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollLeft = Math.min(maxScroll, Math.max(0, pending.scrollLeft));
  }, [scrollRef, totalFrames, zoom]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !projectId || !timelineId) return;
    const onScroll = () => {
      queuePersist(projectId, timelineId, { scrollLeft: element.scrollLeft });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      flushPersist();
      saveTimelineView(projectId, timelineId, { scrollLeft: element.scrollLeft });
    };
  }, [flushPersist, projectId, queuePersist, scrollRef, timelineId]);

  useTimelineWheelZoom(scrollRef, applyAnchoredZoom, setTrackScale, zoomLimits);

  const zoomBy = useCallback(
    (factor: number) => applyAnchoredZoom((current) => scaleTimelineZoom(current, factor, zoomLimits)),
    [applyAnchoredZoom, zoomLimits],
  );
  const fitToView = useCallback(() => {
    const element = scrollRef.current;
    if (!element || totalFrames <= 0) return;
    pendingAutoFitRef.current = null;
    pendingScrollRef.current = null;
    const fitted = fittedZoom(element, totalFrames, fps);
    liveZoomRef.current = fitted;
    rawSetZoom(fitted);
    element.scrollLeft = 0;
  }, [fps, rawSetZoom, scrollRef, totalFrames]);

  const getExpectedScrollLeft = useCallback(
    () => pendingScrollRef.current?.scrollLeft ?? scrollRef.current?.scrollLeft ?? 0,
    [scrollRef],
  );

  return {
    zoom,
    zoomMin: zoomLimits.min,
    setZoom: applyAnchoredZoom,
    zoomBy,
    fitToView,
    getExpectedScrollLeft,
    pixelsPerFrame: PX_PER_FRAME * zoom,
    trackScale,
  };
}
