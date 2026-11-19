import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { ClipEffect, TimelineItem, TimelineState } from '../../editor/types';
import { mosaicSourceSize, mosaicTrackFor, mosaicTrackRegionToStatic, readMosaicAt, setMosaicRegion } from '../../editor/mosaic';
import { t } from '../../i18n/locale';
import { renderedVisualFrameRect, visibleVisualFrameRect } from '../../editor/visualFrameGeometry';
import { isBackgroundFillActive } from '../../editor/backgroundFill';
import { dragPreviewMask, MASK_HANDLES, previewMaskDelta, previewMaskPoint, type MaskHandle } from './previewMask';
import { visiblePreviewCandidates } from './previewTransform';
import type { PreviewPoint, PreviewRect } from './previewTransform';

interface PreviewMosaicOverlayProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onSetItemEffects: (id: string, effects: ClipEffect[]) => void;
  onBeginHistoryGesture: () => void;
  onEndHistoryGesture: () => void;
}
interface MosaicGeometry {
  region: ReturnType<typeof readMosaicAt>['region'];
  sourceRect: PreviewRect;
  outline: PreviewPoint[];
  handles: Record<Exclude<MaskHandle, 'move'>, PreviewPoint>;
}
interface Gesture {
  pointerId: number; item: TimelineItem; frame: number; localFrame: number;
  region: MosaicGeometry['region']; sourceRect: PreviewRect; handle: MaskHandle;
  client: PreviewPoint; began: boolean;
}
const labels: Record<Exclude<MaskHandle, 'move'>, string> = {
  nw: '马赛克区域左上角', n: '马赛克区域上边', ne: '马赛克区域右上角', e: '马赛克区域右边',
  se: '马赛克区域右下角', s: '马赛克区域下边', sw: '马赛克区域左下角', w: '马赛克区域左边',
};

function targetAndGeometry(state: TimelineState, frame: number): { item: TimelineItem; geometry: MosaicGeometry } | null {
  if ((state.selectedIds?.length ?? 0) > 1 || state.width <= 0 || state.height <= 0) return null;
  const item = state.items.find((entry) => entry.id === state.selectedId);
  if (!item || (item.kind !== 'video' && item.kind !== 'image')
    || frame < item.startFrame || frame >= item.startFrame + item.durationInFrames) return null;
  const candidate = visiblePreviewCandidates(state, frame).find((entry) => entry.item.id === item.id);
  if (!candidate) return null;
  const localFrame = Math.max(0, Math.round(frame) - item.startFrame);
  const mosaic = readMosaicAt(item, localFrame);
  if (mosaic.mode !== 'local') return null;
  const fit = isBackgroundFillActive(state, item) ? 'contain' : state.fit ?? 'contain';
  const track = mosaicTrackFor(item);
  const sourceSize = track ? mosaicSourceSize(item) : { width: item.width ?? state.width, height: item.height ?? state.height };
  const canvas = { width: state.width, height: state.height };
  const sourceRect = track ? (() => {
    const frame = visibleVisualFrameRect(canvas, { width: item.width ?? state.width, height: item.height ?? state.height }, fit);
    const inner = renderedVisualFrameRect(frame, sourceSize, fit === 'contain' ? 'cover' : fit);
    return { x: frame.x + inner.x, y: frame.y + inner.y, width: inner.width, height: inner.height };
  })() : visibleVisualFrameRect(canvas, sourceSize, fit);
  if (!(sourceRect.width > 0 && sourceRect.height > 0)) return null;
  const x0 = sourceRect.x + (mosaic.region.centerX - mosaic.region.width / 2) * sourceRect.width;
  const y0 = sourceRect.y + (mosaic.region.centerY - mosaic.region.height / 2) * sourceRect.height;
  const x1 = x0 + mosaic.region.width * sourceRect.width;
  const y1 = y0 + mosaic.region.height * sourceRect.height;
  const at = (x: number, y: number) => previewMaskPoint(state, item, localFrame, { x, y });
  const raw = { nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0], e: [x1, (y0 + y1) / 2],
    se: [x1, y1], s: [(x0 + x1) / 2, y1], sw: [x0, y1], w: [x0, (y0 + y1) / 2] } as const;
  const handles = {} as MosaicGeometry['handles'];
  for (const handle of MASK_HANDLES) {
    const point = at(...raw[handle]);
    if (!point) return null;
    handles[handle] = point;
  }
  return { item, geometry: { region: mosaic.region, sourceRect, outline: [handles.nw, handles.ne, handles.se, handles.sw], handles } };
}

function clientPoint(event: PointerEvent<HTMLDivElement>): PreviewPoint {
  return { x: event.clientX, y: event.clientY };
}

export function PreviewMosaicOverlay({ state, playerRef, onSetItemEffects, onBeginHistoryGesture, onEndHistoryGesture }: PreviewMosaicOverlayProps) {
  const [frame, setFrame] = useState(() => Math.round(playerRef.current?.getCurrentFrame() ?? 0));
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pending = useRef<MosaicGeometry['region'] | null>(null);
  const raf = useRef(0);
  const latest = useRef({ state, playerRef, onSetItemEffects, onBeginHistoryGesture, onEndHistoryGesture });
  latest.current = { state, playerRef, onSetItemEffects, onBeginHistoryGesture, onEndHistoryGesture };
  const target = targetAndGeometry(state, frame);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(Math.round(player.getCurrentFrame()));
    const onFrame = ({ detail }: { detail: { frame: number } }) => setFrame(Math.round(detail.frame));
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [playerRef]);

  const isValid = useCallback((g: Gesture) => {
    const current = latest.current.state;
    const active = targetAndGeometry(current, g.frame);
    return active?.item.id === g.item.id && active.item.transform === g.item.transform
      && active.geometry.sourceRect.width === g.sourceRect.width
      && active.geometry.sourceRect.height === g.sourceRect.height
      && Math.round(latest.current.playerRef.current?.getCurrentFrame() ?? g.frame) === g.frame;
  }, []);
  const commit = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
    const next = pending.current; pending.current = null;
    const g = gesture.current;
    if (!next || !g || !isValid(g)) return;
    const liveItem = latest.current.state.items.find((entry) => entry.id === g.item.id);
    if (!liveItem) return;
    const stateNow = latest.current.state;
    const fit = isBackgroundFillActive(stateNow, liveItem) ? 'contain' : stateNow.fit ?? 'contain';
    const region = mosaicTrackFor(liveItem)
      ? mosaicTrackRegionToStatic(liveItem, next, fit, { width: stateNow.width, height: stateNow.height })
      : next;
    const effects = setMosaicRegion(liveItem.effects ?? [], region, `fx_mosaic_${crypto.randomUUID()}`);
    latest.current.onSetItemEffects(g.item.id, effects);
  }, [isValid]);
  const finish = useCallback((cancel = false, flush = true) => {
    const g = gesture.current;
    if (!g) return;
    if (flush && !cancel) commit();
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0; pending.current = null;
    if (cancel && g.began && isValid(g)) {
      const liveItem = latest.current.state.items.find((entry) => entry.id === g.item.id);
      if (liveItem) latest.current.onSetItemEffects(g.item.id,
        setMosaicRegion(liveItem.effects ?? [], g.region, `fx_mosaic_${crypto.randomUUID()}`, !!mosaicTrackFor(liveItem)));
    }
    gesture.current = null;
    if (g.began) latest.current.onEndHistoryGesture();
    if (root.current?.hasPointerCapture(g.pointerId)) root.current.releasePointerCapture(g.pointerId);
  }, [commit, isValid]);
  useEffect(() => {
    if (gesture.current && !isValid(gesture.current)) finish(false, false);
  }, [state, frame, isValid, finish]);
  useEffect(() => () => { finish(false, false); }, [finish]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId || !root.current) return;
    if (!isValid(g)) { finish(false, false); return; }
    const dx = event.clientX - g.client.x, dy = event.clientY - g.client.y;
    if (!g.began) {
      if (Math.hypot(dx, dy) < 3) return;
      g.began = true; latest.current.onBeginHistoryGesture();
    }
    const stateNow = latest.current.state;
    const canvasDelta = previewMaskDelta({ width: stateNow.width, height: stateNow.height }, g.item, g.localFrame,
      { x: dx, y: dy }, root.current.getBoundingClientRect());
    if (!canvasDelta) { finish(false, false); return; }
    const localDelta = { x: canvasDelta.x * stateNow.width / g.sourceRect.width,
      y: canvasDelta.y * stateNow.height / g.sourceRect.height };
    const rect = { type: 'rectangle' as const, x: g.region.centerX - g.region.width / 2,
      y: g.region.centerY - g.region.height / 2, width: g.region.width, height: g.region.height };
    const next = dragPreviewMask(rect, g.handle, localDelta);
    pending.current = { ...g.region, centerX: next.x + next.width / 2, centerY: next.y + next.height / 2,
      width: next.width, height: next.height };
    if (!raf.current) raf.current = requestAnimationFrame(commit);
  };
  return <div ref={root} className="cc-preview-mask-overlay" role="group" aria-label={t('预览画布局部马赛克编辑')}
    tabIndex={0} data-cc-shortcut-surface="inspector"
    onPointerDown={(event) => {
      if (event.button !== 0 || gesture.current || !target) return;
      const handle = (event.target as Element).closest('[data-mosaic-handle]')?.getAttribute('data-mosaic-handle') as MaskHandle | null;
      if (!handle) return;
      event.preventDefault(); event.stopPropagation(); playerRef.current?.pause();
      event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointerId: event.pointerId, item: target.item, frame, localFrame: frame - target.item.startFrame,
        region: target.geometry.region, sourceRect: target.geometry.sourceRect, handle, client: clientPoint(event), began: false };
    }}
    onPointerMove={move}
    onPointerUp={(event) => { if (gesture.current?.pointerId === event.pointerId) { move(event); finish(); } }}
    onPointerCancel={(event) => { if (gesture.current?.pointerId === event.pointerId) finish(true); }}
    onLostPointerCapture={() => finish(false, false)}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(true); }
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) finish(false, false);
    }}>
    {target && <>
      <svg className="cc-preview-transform-outline" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none">
        <polygon className="cc-preview-mask-region" data-mosaic-selection={target.item.id}
          data-mosaic-handle="move" points={target.geometry.outline.map((point) => `${point.x},${point.y}`).join(' ')}
          fill="transparent" stroke="var(--cc-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {MASK_HANDLES.map((handle) => <button key={handle} type="button" className={`cc-preview-mask-handle mask-${handle}`}
        data-mosaic-handle={handle} aria-label={t(labels[handle])}
        style={{ left: `${target.geometry.handles[handle].x / state.width * 100}%`, top: `${target.geometry.handles[handle].y / state.height * 100}%` }} />)}
      <span className="cc-preview-mask-hint">{t('拖动马赛克范围移动 · 拉动边角调整大小 · Esc 取消')}</span>
    </>}
  </div>;
}
