import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { PlayerRef } from '@remotion/player';
import type { ClipMask, FlexCrop, ClipTransform, KeyframeEasing, KeyframeProp, TimelineItem, TimelineState } from '../../editor/types';
import { resolveMaskAt } from '../../editor/clipMask';
import { parseCompositionMosaic, type CompositionMosaic } from '../../editor/compositionMosaic';
import { previewMaskWrites } from './previewMask';
import { t } from '../../i18n/locale';
import {
  cyclePreviewCandidate,
  edgeCropPreviewTransform,
  edgeResizeClipMask,
  edgeResizeCompositionMosaic,
  hitPreviewCandidates,
  movePreviewTransform,
  previewCandidateGeometry,
  previewClientDelta,
  previewEdgeMidpoints,
  previewPointerFromClient,
  resizeCompositionMosaic,
  rotatePreviewTransform,
  shouldSelectedItemPreemptCaptions,
  uniformScaleAxesPreviewTransform,
  visiblePreviewCandidates,
  type ClickCycleState,
  type EffectivePreviewTransform,
  type PreviewPoint,
  type PreviewResizeHandle,
  type PreviewScaleEdge,
  type PreviewSize,
} from './previewTransform';
import { canPreviewTextEdit, previewTextEditFields } from './previewTextEdit';
import { PreviewTextEditBar } from './PreviewTextEditBar';
import { MotionPathOverlay } from './MotionPathOverlay';

export interface PreviewTransformOverlayProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onSelectItem: (id: string | null) => void;
  onSetItemTransform: (id: string, patch: ClipTransform) => void;
  onSetItemKeyframe: (id: string, prop: KeyframeProp, localFrame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe?: (id: string, prop: KeyframeProp, localFrame: number) => void;
  onSeek?: (frame: number) => void;
  onBeginHistoryGesture: () => void;
  onEndHistoryGesture: () => void;
  /** Live text style edits for text / text-like MG clips. */
  onItemPropChange?: (id: string, key: string, value: unknown) => void;
  /** Resize a solid shape's clip mask directly from preview edge handles. */
  onSetItemMask?: (id: string, mask: ClipMask | null) => void;
  /** Resize a composition mosaic region directly from preview edge handles. */
  onSetCompositionMosaic?: (id: string, patch: Partial<CompositionMosaic>) => void;
  /** True when a caption cue is actively selected/edited on the canvas. */
  captionActive?: boolean;
  playing?: boolean;
}

const DOUBLE_CLICK_MS = 320;

type GestureMode = 'move' | 'scale' | 'crop-edge' | 'rotate';

interface GestureState {
  pointerId: number;
  item: TimelineItem;
  mode: GestureMode;
  /** When mode is crop-edge, which edge is being dragged. */
  edge?: PreviewScaleEdge;
  /** When mode is scale, which corner is being dragged. */
  corner?: Exclude<PreviewResizeHandle, PreviewScaleEdge>;
  /** Crop snapshot at pointer-down (edge crop keeps the opposite side fixed). */
  startCrop?: FlexCrop;
  /** Resolved mask snapshot at pointer-down for `solid` shape edge resizing. */
  startMask?: ClipMask;
  /** Mosaic region snapshot at pointer-down for `mosaic` edge resizing. */
  startMosaic?: CompositionMosaic;
  /** Viewport client coords — not overlay-relative, so inspector layout cannot fake a drag. */
  startClient: PreviewPoint;
  center: PreviewPoint;
  transform: EffectivePreviewTransform;
  localFrame: number;
  moved: boolean;
}

type TransformWriteProp = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation';

interface PendingValues {
  item: TimelineItem;
  localFrame: number;
  values: Partial<Record<TransformWriteProp, number>>;
  /** Edge crop writes the full crop object (or undefined to clear). */
  crop?: FlexCrop | undefined;
  cropTouched?: boolean;
  /** Edge resize update for `solid` clip mask. */
  maskUpdate?: { item: TimelineItem; localFrame: number; start: ClipMask; next: ClipMask };
  /** Edge resize patch for `mosaic` composition region. */
  mosaicPatch?: Partial<CompositionMosaic>;
}

const CLICK_TOLERANCE = 4;
const DRAG_THRESHOLD = 3;

const clientPoint = (event: ReactPointerEvent): PreviewPoint => ({
  x: event.clientX,
  y: event.clientY,
});

const EDGE_HANDLES = new Set<string>(['crop-n', 'crop-s', 'crop-e', 'crop-w']);
const CORNER_HANDLES: Record<string, Exclude<PreviewResizeHandle, PreviewScaleEdge>> = {
  'scale-0': 'nw',
  'scale-1': 'ne',
  'scale-2': 'se',
  'scale-3': 'sw',
};

const handleMode = (target: EventTarget | null): {
  mode: GestureMode;
  edge?: PreviewScaleEdge;
  corner?: Exclude<PreviewResizeHandle, PreviewScaleEdge>;
} | null => {
  const handle = target instanceof Element ? target.closest<HTMLElement>('[data-preview-handle]') : null;
  const value = handle?.dataset.previewHandle;
  if (value === 'rotate') return { mode: 'rotate' };
  if (value && EDGE_HANDLES.has(value)) {
    return { mode: 'crop-edge', edge: value.slice('crop-'.length) as PreviewScaleEdge };
  }
  if (value && value in CORNER_HANDLES) {
    return { mode: 'scale', corner: CORNER_HANDLES[value] };
  }
  if (value?.startsWith('scale-')) return { mode: 'scale' };
  return null;
};

export function formatTransformDragHud(
  mode: GestureMode,
  values: Partial<Record<TransformWriteProp, number>>,
  base: EffectivePreviewTransform,
): string | null {
  if (mode === 'move') {
    const x = Math.round(values.x ?? base.x);
    const y = Math.round(values.y ?? base.y);
    return `X ${x} · Y ${y}`;
  }
  if (mode === 'scale' || mode === 'rotate') {
    const scale = values.scale ?? values.scaleX ?? base.scaleX ?? base.scale ?? 1;
    const rotation = values.rotation ?? base.rotation ?? 0;
    const normalizedDeg = Math.round(((rotation % 360) + 540) % 360 - 180);
    return `${Math.round(scale * 100)}% · ${normalizedDeg}°`;
  }
  return null;
}

export function PreviewTransformOverlay({
  state,
  playerRef,
  onSelectItem,
  onSetItemTransform,
  onSetItemKeyframe,
  onRemoveItemKeyframe,
  onSeek,
  onBeginHistoryGesture,
  onEndHistoryGesture,
  onItemPropChange,
  onSetItemMask,
  onSetCompositionMosaic,
  captionActive = false,
  playing = false,
}: PreviewTransformOverlayProps) {
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(() => Math.round(playerRef.current?.getCurrentFrame() ?? 0));
  const [previewSize, setPreviewSize] = useState<PreviewSize>({ width: state.width, height: state.height });
  const [textAutoEdit, setTextAutoEdit] = useState(false);
  const [dragHud, setDragHud] = useState<string | null>(null);
  const lastClickRef = useRef<{ id: string; at: number } | null>(null);
  const cycleRef = useRef<ClickCycleState | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const pendingRef = useRef<PendingValues | null>(null);
  const commitRafRef = useRef(0);
  const endHistoryRef = useRef(onEndHistoryGesture);
  endHistoryRef.current = onEndHistoryGesture;

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setPreviewSize({ width: root.clientWidth, height: root.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return undefined;
    setFrame(Math.round(player.getCurrentFrame()));
    let paintRaf = 0;
    let pendingFrame: number | null = null;
    const syncNow = () => {
      if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
      pendingFrame = null;
      setFrame(Math.round(player.getCurrentFrame()));
    };
    const onFrame = (event: { detail: { frame: number } }) => {
      if (playingRef.current && !gestureRef.current) return;
      pendingFrame = Math.round(event.detail.frame);
      if (paintRaf) return;
      paintRaf = requestAnimationFrame(() => {
        paintRaf = 0;
        if (pendingFrame != null) setFrame(pendingFrame);
        pendingFrame = null;
      });
    };
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('pause', syncNow);
    player.addEventListener('seeked', syncNow);
    return () => {
      if (paintRaf) cancelAnimationFrame(paintRaf);
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('pause', syncNow);
      player.removeEventListener('seeked', syncNow);
    };
  }, [playerRef]);
  useEffect(() => {
    if (!playing && playerRef.current) {
      setFrame(Math.round(playerRef.current.getCurrentFrame()));
    }
  }, [playing, playerRef]);

  const overlaySleeping = playing && !gestureRef.current && !textAutoEdit;
  const candidates = useMemo(() => (overlaySleeping ? [] : visiblePreviewCandidates(state, frame)), [overlaySleeping, frame, state]);
  const selectedCandidate = useMemo(
    () => state.width > 0 && state.height > 0
      ? candidates.find(({ item }) => item.id === state.selectedId) ?? null
      : null,
    [candidates, state.height, state.selectedId, state.width],
  );
  const selection = useMemo(
    () => selectedCandidate ? previewCandidateGeometry(state, selectedCandidate) : null,
    [selectedCandidate, state],
  );
  const preemptCaptions = !captionActive
    && !!selectedCandidate
    && shouldSelectedItemPreemptCaptions(state, selectedCandidate);

  useEffect(() => {
    cycleRef.current = null;
  }, [frame, state.height, state.width]);

  useEffect(() => {
    setTextAutoEdit(false);
    lastClickRef.current = null;
  }, [state.selectedId]);

  const commitPending = useCallback(() => {
    if (commitRafRef.current) {
      cancelAnimationFrame(commitRafRef.current);
      commitRafRef.current = 0;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const patch: ClipTransform = {};
    for (const [prop, value] of Object.entries(pending.values) as Array<[TransformWriteProp, number]>) {
      if (pending.item.keyframes?.[prop]?.length) {
        onSetItemKeyframe(pending.item.id, prop, pending.localFrame, value);
      } else {
        patch[prop] = value;
      }
    }
    if (pending.cropTouched) patch.crop = pending.crop;
    if (Object.keys(patch).length) onSetItemTransform(pending.item.id, patch);
    if (pending.maskUpdate && onSetItemMask) {
      const { mask, keyframes } = previewMaskWrites(
        pending.maskUpdate.item,
        pending.maskUpdate.localFrame,
        pending.maskUpdate.start,
        pending.maskUpdate.next,
      );
      for (const kf of keyframes) onSetItemKeyframe(pending.item.id, kf.prop, kf.frame, kf.value);
      if (mask) onSetItemMask(pending.item.id, mask);
    }
    if (pending.mosaicPatch && onSetCompositionMosaic) {
      onSetCompositionMosaic(pending.item.id, pending.mosaicPatch);
    }
  }, [onSetCompositionMosaic, onSetItemKeyframe, onSetItemMask, onSetItemTransform]);

  const queueValues = useCallback((pending: PendingValues) => {
    pendingRef.current = pending;
    if (commitRafRef.current) return;
    commitRafRef.current = requestAnimationFrame(() => {
      commitRafRef.current = 0;
      commitPending();
    });
  }, [commitPending]);

  const finishGesture = useCallback((resetCycle: boolean) => {
    if (!gestureRef.current) return;
    commitPending();
    gestureRef.current = null;
    setDragHud(null);
    if (resetCycle) cycleRef.current = null;
    onEndHistoryGesture();
  }, [commitPending, onEndHistoryGesture]);

  useEffect(() => () => {
    if (commitRafRef.current) cancelAnimationFrame(commitRafRef.current);
    if (gestureRef.current) endHistoryRef.current();
    gestureRef.current = null;
    pendingRef.current = null;
  }, []);

  useEffect(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const track = state.tracks?.[gesture.item.track];
    const stillExists = state.items.some((item) => item.id === gesture.item.id);
    const pictureDisabled = state.items.find((item) => item.id === gesture.item.id)?.pictureDisabled === true;
    if (!stillExists || pictureDisabled || track?.hidden || track?.locked || state.selectedId !== gesture.item.id) {
      finishGesture(true);
    }
  }, [finishGesture, state.items, state.selectedId, state.tracks]);

  const updateGesture = useCallback((event: ReactPointerEvent) => {
    const gesture = gestureRef.current;
    const root = rootRef.current;
    if (!gesture || !root || gesture.pointerId !== event.pointerId) return;
    const rect = root.getBoundingClientRect();
    const currentClient = clientPoint(event);
    const delta = previewClientDelta(gesture.startClient, currentClient);
    if (!gesture.moved && Math.hypot(delta.x, delta.y) >= DRAG_THRESHOLD) gesture.moved = true;
    if (!gesture.moved) return;

    const previewSize = { width: rect.width, height: rect.height };
    const current = previewPointerFromClient(currentClient, rect, state);
    const start = previewPointerFromClient(gesture.startClient, rect, state);

    if (gesture.mode === 'move') {
      const moved = movePreviewTransform(gesture.transform, delta, previewSize);
      setDragHud(formatTransformDragHud('move', moved, gesture.transform));
      queueValues({ item: gesture.item, localFrame: gesture.localFrame, values: moved });
    } else if (gesture.mode === 'scale') {
      if (gesture.item.kind === 'mosaic' && gesture.corner && gesture.startMosaic && onSetCompositionMosaic) {
        const nextMosaic = resizeCompositionMosaic(
          state,
          gesture.transform,
          gesture.startMosaic,
          current.composition,
          gesture.corner,
        );
        setDragHud(`${Math.round(nextMosaic.width * 100)}% × ${Math.round(nextMosaic.height * 100)}%`);
        queueValues({
          item: gesture.item,
          localFrame: gesture.localFrame,
          values: {},
          mosaicPatch: {
            centerX: nextMosaic.centerX,
            centerY: nextMosaic.centerY,
            width: nextMosaic.width,
            height: nextMosaic.height,
          },
        });
        return;
      }
      const scaled = uniformScaleAxesPreviewTransform(
        gesture.transform,
        gesture.center,
        start.composition,
        current.composition,
      );
      setDragHud(formatTransformDragHud('scale', scaled, gesture.transform));
      queueValues({
        item: gesture.item,
        localFrame: gesture.localFrame,
        values: scaled,
      });
    } else if (gesture.mode === 'crop-edge' && gesture.edge) {
      if (gesture.item.kind === 'mosaic') {
        if (gesture.startMosaic && onSetCompositionMosaic) {
          const nextMosaic = edgeResizeCompositionMosaic(
            state,
            gesture.transform,
            gesture.startMosaic,
            current.composition,
            gesture.edge,
          );
          setDragHud(`${Math.round(nextMosaic.width * 100)}% × ${Math.round(nextMosaic.height * 100)}%`);
          queueValues({
            item: gesture.item,
            localFrame: gesture.localFrame,
            values: {},
            mosaicPatch: {
              centerX: nextMosaic.centerX,
              centerY: nextMosaic.centerY,
              width: nextMosaic.width,
              height: nextMosaic.height,
            },
          });
        }
        return;
      }
      if (gesture.item.kind === 'solid' && gesture.startMask && onSetItemMask) {
        const nextMask = edgeResizeClipMask(
          state,
          gesture.transform,
          gesture.startMask,
          current.composition,
          gesture.edge,
        );
        queueValues({
          item: gesture.item,
          localFrame: gesture.localFrame,
          values: {},
          maskUpdate: {
            item: gesture.item,
            localFrame: gesture.localFrame,
            start: gesture.startMask,
            next: nextMask,
          },
        });
        return;
      }
      const { crop } = edgeCropPreviewTransform(
        state,
        gesture.transform,
        gesture.startCrop,
        current.composition,
        gesture.edge,
      );
      queueValues({
        item: gesture.item,
        localFrame: gesture.localFrame,
        values: {},
        crop,
        cropTouched: true,
      });
    } else {
      const rotation = rotatePreviewTransform(
        gesture.transform.rotation,
        gesture.center,
        start.composition,
        current.composition,
      );
      setDragHud(formatTransformDragHud('rotate', { rotation }, gesture.transform));
      queueValues({
        item: gesture.item,
        localFrame: gesture.localFrame,
        values: { rotation },
      });
    }
  }, [onSetCompositionMosaic, onSetItemMask, queueValues, state]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[data-motion-path-interactive]'))) return;
    if (event.button !== 0 || gestureRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    event.currentTarget.focus({ preventScroll: true });
    const pointClient = clientPoint(event);
    const { ui: pointUi, composition: pointComposition } = previewPointerFromClient(pointClient, rect, state);
    const modeFromHandle = handleMode(event.target);
    let candidate = selectedCandidate;
    let mode: GestureMode = modeFromHandle?.mode ?? 'move';
    let edge = modeFromHandle?.edge;
    let corner = modeFromHandle?.corner;

    if (!modeFromHandle) {
      const hitSelectedTarget = event.target instanceof Element && Boolean(event.target.closest('[data-preview-selected-hit]'));
      const hits = hitPreviewCandidates(state, frame, pointComposition);
      if (hitSelectedTarget && selectedCandidate && hits.some(({ item }) => item.id === selectedCandidate.item.id)) {
        cycleRef.current = null;
        candidate = selectedCandidate;
        onSelectItem(candidate.item.id);
        mode = 'move';
        edge = undefined;
        corner = undefined;
      } else {
        const cycled = cyclePreviewCandidate(cycleRef.current, pointUi, hits, CLICK_TOLERANCE);
        if (!cycled) {
          cycleRef.current = null;
          onSelectItem(null);
          return;
        }
        cycleRef.current = cycled.next;
        candidate = hits.find(({ item }) => item.id === cycled.id) ?? null;
        if (!candidate) return;
        onSelectItem(candidate.item.id);
        mode = 'move';
        edge = undefined;
        corner = undefined;
      }
    }

    if (!candidate) return;
    event.preventDefault();
    event.stopPropagation();
    playerRef.current?.pause();
    setFrame(Math.round(playerRef.current?.getCurrentFrame() ?? frame));
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      item: candidate.item,
      mode,
      edge,
      corner,
      startCrop: candidate.item.transform?.crop,
      startMask: candidate.item.kind === 'solid' && candidate.item.mask
        ? (resolveMaskAt(candidate.item, candidate.localFrame, { width: state.width, height: state.height }) ?? candidate.item.mask)
        : undefined,
      startMosaic: candidate.item.kind === 'mosaic'
        ? (parseCompositionMosaic(candidate.item.mosaic) ?? undefined)
        : undefined,
      startClient: pointClient,
      center: {
        x: state.width / 2 + candidate.transform.x / 100 * state.width,
        y: state.height / 2 + candidate.transform.y / 100 * state.height,
      },
      transform: candidate.transform,
      localFrame: candidate.localFrame,
      moved: false,
    };
    onBeginHistoryGesture();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    updateGesture(event);
    const moved = gesture.moved;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!moved && canPreviewTextEdit(gesture.item) && previewTextEditFields(gesture.item)?.textKey) {
      const now = Date.now();
      const prev = lastClickRef.current;
      if (prev && prev.id === gesture.item.id && now - prev.at <= DOUBLE_CLICK_MS) {
        lastClickRef.current = null;
        setTextAutoEdit(true);
      } else {
        lastClickRef.current = { id: gesture.item.id, at: now };
      }
    } else {
      lastClickRef.current = null;
    }
    finishGesture(moved);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    finishGesture(true);
  };

  const rotateHandle = useMemo(() => {
    if (!selection) return null;
    const top = {
      x: (selection.corners[0].x + selection.corners[1].x) / 2,
      y: (selection.corners[0].y + selection.corners[1].y) / 2,
    };
    const dx = top.x - selection.center.x;
    const dy = top.y - selection.center.y;
    const length = Math.hypot(dx, dy) || 1;
    const previewScale = previewSize.width > 0 && previewSize.height > 0
      ? Math.min(previewSize.width / state.width, previewSize.height / state.height)
      : 0;
    const compositionOffset = previewScale > 0 ? 28 / previewScale : 28;
    return {
      stem: top,
      handle: { x: top.x + dx / length * compositionOffset, y: top.y + dy / length * compositionOffset },
    };
  }, [previewSize.height, previewSize.width, selection, state.height, state.width]);

  const percentPosition = (point: PreviewPoint) => ({
    left: `${point.x / state.width * 100}%`,
    top: `${point.y / state.height * 100}%`,
  });

  const edgeMidpoints = selection ? previewEdgeMidpoints(selection.corners) : null;
  const selectedIsEllipse = selectedCandidate
    ? (selectedCandidate.item.kind === 'solid' && selectedCandidate.item.mask?.type === 'ellipse')
      || (selectedCandidate.item.kind === 'mosaic' && parseCompositionMosaic(selectedCandidate.item.mosaic)?.shape === 'ellipse')
    : false;
  const ellipseOutline = selection && edgeMidpoints && selectedIsEllipse ? {
    cx: selection.center.x,
    cy: selection.center.y,
    rx: Math.max(0.5, Math.hypot(edgeMidpoints.e.x - selection.center.x, edgeMidpoints.e.y - selection.center.y)),
    ry: Math.max(0.5, Math.hypot(edgeMidpoints.s.x - selection.center.x, edgeMidpoints.s.y - selection.center.y)),
    angle: Math.atan2(edgeMidpoints.e.y - selection.center.y, edgeMidpoints.e.x - selection.center.x) * 180 / Math.PI,
  } : null;
  const edgeHandles: Array<{ edge: PreviewScaleEdge; label: string; className: string }> = [
    { edge: 'n', label: t('裁切上边（拖入则遮住上方）'), className: 'cc-preview-transform-crop-n' },
    { edge: 's', label: t('裁切下边（拖入则遮住下方）'), className: 'cc-preview-transform-crop-s' },
    { edge: 'e', label: t('裁切右边（拖入则遮住右侧）'), className: 'cc-preview-transform-crop-e' },
    { edge: 'w', label: t('裁切左边（拖入则遮住左侧）'), className: 'cc-preview-transform-crop-w' },
  ];

  if (overlaySleeping) return null;

  return (
    <div
      ref={rootRef}
      className="cc-preview-transform-overlay"
      role="group"
      aria-label={t('预览画布片段变换')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={updateGesture}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={() => finishGesture(true)}
    >
      <div className="cc-preview-transform-backdrop" />
      {selection && rotateHandle && (
        <>
          <svg
            className="cc-preview-transform-outline"
            style={preemptCaptions ? { zIndex: 5 } : undefined}
            viewBox={`0 0 ${state.width} ${state.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {preemptCaptions && (ellipseOutline ? (
              <ellipse
                data-preview-selected-hit={selectedCandidate!.item.id}
                cx={ellipseOutline.cx}
                cy={ellipseOutline.cy}
                rx={ellipseOutline.rx}
                ry={ellipseOutline.ry}
                transform={`rotate(${ellipseOutline.angle} ${ellipseOutline.cx} ${ellipseOutline.cy})`}
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: 'move' }}
              />
            ) : (
              <polygon
                data-preview-selected-hit={selectedCandidate!.item.id}
                points={selection.corners.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: 'move' }}
              />
            ))}
            <polygon
              data-preview-selection={selectedCandidate!.item.id}
              points={selection.corners.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke="var(--cc-accent)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
            {ellipseOutline && (
              <ellipse
                data-preview-ellipse={selectedCandidate!.item.id}
                cx={ellipseOutline.cx}
                cy={ellipseOutline.cy}
                rx={ellipseOutline.rx}
                ry={ellipseOutline.ry}
                transform={`rotate(${ellipseOutline.angle} ${ellipseOutline.cx} ${ellipseOutline.cy})`}
                fill="none"
                stroke="var(--cc-accent)"
                strokeWidth="1.5"
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <line
              x1={rotateHandle.stem.x}
              y1={rotateHandle.stem.y}
              x2={rotateHandle.handle.x}
              y2={rotateHandle.handle.y}
              stroke="var(--cc-accent)"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {selection.corners.map((point, index) => (
            <button
              key={index}
              type="button"
              className={`cc-preview-transform-handle cc-preview-transform-scale cc-preview-transform-scale-${index}`}
              data-preview-handle={`scale-${index}`}
              aria-label={t('从角点 {n} 等比缩放片段', { n: index + 1 })}
              style={{ ...percentPosition(point), ...(preemptCaptions ? { zIndex: 5 } : undefined) }}
            />
          ))}
          {edgeMidpoints && edgeHandles.map(({ edge, label, className }) => (
            <button
              key={edge}
              type="button"
              className={`cc-preview-transform-handle cc-preview-transform-crop ${className}`}
              data-preview-handle={`crop-${edge}`}
              aria-label={label}
              style={{ ...percentPosition(edgeMidpoints[edge]), ...(preemptCaptions ? { zIndex: 5 } : undefined) }}
            />
          ))}
          <button
            type="button"
            className="cc-preview-transform-handle cc-preview-transform-rotate"
            data-preview-handle="rotate"
            aria-label={t('旋转片段')}
            style={{ ...percentPosition(rotateHandle.handle), ...(preemptCaptions ? { zIndex: 5 } : undefined) }}
          />
          {dragHud && (
            <div
              className="cc-preview-transform-hud"
              aria-hidden="true"
              style={{
                left: `${Math.max(8, Math.min(92, (selection.corners.reduce((sum, p) => sum + p.x, 0) / selection.corners.length) / state.width * 100))}%`,
                top: `${Math.max(8, Math.min(92, Math.max(...selection.corners.map((p) => p.y)) / state.height * 100))}%`,
              }}
            >
              {dragHud}
            </div>
          )}
          {onItemPropChange
            && selectedCandidate
            && previewTextEditFields(selectedCandidate.item)
            && (
              <PreviewTextEditBar
                item={selectedCandidate.item}
                selection={selection}
                composition={{ width: state.width, height: state.height }}
                onPropChange={onItemPropChange}
                autoEdit={textAutoEdit}
                onAutoEditHandled={() => setTextAutoEdit(false)}
              />
            )}
        </>
      )}
      {selection && selectedCandidate && onRemoveItemKeyframe && onSeek && (
        <MotionPathOverlay
          state={state} item={selectedCandidate.item}
          frame={frame}
          onSetItemKeyframe={onSetItemKeyframe}
          onRemoveItemKeyframe={onRemoveItemKeyframe}
          onSeek={onSeek}
          onBeginHistoryGesture={onBeginHistoryGesture}
          onEndHistoryGesture={onEndHistoryGesture}
        />
      )}
    </div>
  );
}
