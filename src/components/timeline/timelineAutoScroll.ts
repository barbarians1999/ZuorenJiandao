import { timelineGestureHasDragged } from './timelineSeek.js';

export interface TimelineScrollViewport {
  viewportLeft: number;
  viewportRight: number;
  headerInset: number;
  scrollLeft: number;
  maxScrollLeft: number;
}

export interface EdgeScrollDeltaInput extends TimelineScrollViewport {
  clientX: number;
  elapsedMs: number;
  active?: boolean;
  edgeSizePx?: number;
  maxPixelsPerFrame?: number;
  maxPixelsPerSecond?: number;
}

export function incrementalTimelineDragFrames(input: {
  rawDeltaF: number; clientX: number; lastClientX: number; scrollLeft: number;
  lastScrollLeft: number; pixelsPerFrame: number; lastPixelsPerFrame: number;
}): number {
  const px = Math.max(0.001, input.pixelsPerFrame);
  const scrollDelta = input.pixelsPerFrame === input.lastPixelsPerFrame
    ? input.scrollLeft - input.lastScrollLeft : 0;
  return input.rawDeltaF + (input.clientX - input.lastClientX + scrollDelta) / px;
}

/** Elapsed-time edge speed; the sticky track-head area never triggers left scrolling. */
export function edgeScrollDelta(input: EdgeScrollDeltaInput): number {
  const { clientX, elapsedMs, viewportLeft, viewportRight, headerInset, scrollLeft, maxScrollLeft } = input;
  if (input.active === false || !Number.isFinite(clientX) || !Number.isFinite(elapsedMs) || elapsedMs <= 0
    || !Number.isFinite(scrollLeft) || !Number.isFinite(maxScrollLeft)) return 0;
  const left = viewportLeft + headerInset;
  const right = viewportRight;
  if (!(right > left)) return 0;
  const edge = Math.min(Math.max(1, input.edgeSizePx ?? 48), (right - left) / 2);
  const maxStep = Math.max(0, input.maxPixelsPerFrame ?? 24);
  const maxSpeed = Math.max(0, input.maxPixelsPerSecond ?? 1100);
  let direction = 0;
  let penetration = 0;
  if (clientX < left + edge && scrollLeft > 0) {
    direction = -1;
    penetration = clientX < left ? 1 : Math.min(1, Math.max(0, (left + edge - clientX) / edge));
  }
  if (clientX > right - edge && clientX <= right + edge) {
    const rightPenetration = Math.min(1, Math.max(0, (clientX - (right - edge)) / edge));
    if (rightPenetration > penetration && scrollLeft < maxScrollLeft) {
      direction = 1;
      penetration = rightPenetration;
    }
  } else if (clientX > right && scrollLeft < maxScrollLeft) {
    direction = 1;
    penetration = 1;
  }
  if (!direction || !penetration) return 0;
  const requested = Math.min(maxStep, maxSpeed * penetration * penetration * elapsedMs / 1000) * direction;
  return direction < 0 ? Math.max(-scrollLeft, requested) : Math.min(maxScrollLeft - scrollLeft, requested);
}

export interface TimelineAutoScrollGesture {
  pointerId: number;
  clientX: number;
  clientY: number;
}

interface FrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(id: number): void;
}

/** The loop runs only after pointer movement crosses the same 4px gesture slop. */
export function createTimelineAutoScrollController(options: {
  scheduler: FrameScheduler;
  getViewport: () => TimelineScrollViewport | null;
  setScrollLeft: (scrollLeft: number) => void;
  onScrolled: (gesture: TimelineAutoScrollGesture) => void;
}) {
  let gesture: (TimelineAutoScrollGesture & { startX: number; startY: number; active: boolean }) | null = null;
  let frameId: number | null = null;
  let lastTimestamp: number | null = null;

  const stopFrame = () => {
    if (frameId !== null) options.scheduler.cancel(frameId);
    frameId = null;
    lastTimestamp = null;
  };
  const schedule = () => {
    if (frameId === null && gesture?.active) frameId = options.scheduler.request(tick);
  };
  const stop = (pointerId?: number) => {
    if (pointerId !== undefined && gesture?.pointerId !== pointerId) return;
    stopFrame();
    gesture = null;
  };
  const tick = (timestamp: number) => {
    frameId = null;
    if (!gesture?.active) return;
    const viewport = options.getViewport();
    if (!viewport) return;
    const elapsedMs = lastTimestamp === null ? 1000 / 60 : Math.max(0, timestamp - lastTimestamp);
    lastTimestamp = timestamp;
    const delta = edgeScrollDelta({ ...viewport, clientX: gesture.clientX, elapsedMs });
    if (Math.abs(delta) < 0.01) { lastTimestamp = null; return; }
    const scrollLeft = Math.min(viewport.maxScrollLeft, Math.max(0, viewport.scrollLeft + delta));
    if (scrollLeft === viewport.scrollLeft) { lastTimestamp = null; return; }
    options.setScrollLeft(scrollLeft);
    options.onScrolled({ pointerId: gesture.pointerId, clientX: gesture.clientX, clientY: gesture.clientY });
    schedule();
  };

  return {
    start(pointerId: number, clientX: number, clientY: number): void {
      if (gesture?.pointerId === pointerId) {
        gesture.clientX = clientX;
        gesture.clientY = clientY;
        return;
      }
      stopFrame();
      gesture = { pointerId, startX: clientX, startY: clientY, clientX, clientY, active: false };
    },
    update(pointerId: number, clientX: number, clientY: number): void {
      if (!gesture || gesture.pointerId !== pointerId) return;
      gesture.clientX = clientX;
      gesture.clientY = clientY;
      if (!gesture.active && timelineGestureHasDragged(gesture.startX, gesture.startY, clientX, clientY)) {
        gesture.active = true;
        lastTimestamp = null;
      }
      schedule();
    },
    stop,
    dispose: () => stop(),
    getActivePointerId(): number | null { return gesture?.pointerId ?? null; },
  };
}
