import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { ClipEffect, TimelineItem, TimelineState } from '../../editor/types';
import {
  listClipMosaics,
  mosaicTrackForEffect,
  mosaicTrackRegionToStatic,
  updateClipMosaicById,
  type ClipMosaicEntry,
  type MosaicRegion,
} from '../../editor/mosaic';
import { t } from '../../i18n/locale';
import { renderedVisualFrameRect, visibleVisualFrameRect } from '../../editor/visualFrameGeometry';
import { isBackgroundFillActive } from '../../editor/backgroundFill';
import { dragPreviewMask, MASK_HANDLES, previewMaskDelta, previewMaskPoint, type MaskHandle } from './previewMask';
import { visiblePreviewCandidates } from './previewTransform';
import type { PreviewPoint, PreviewRect } from './previewTransform';

interface PreviewMosaicOverlayProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  playing?: boolean;
  selectedEffectId?: string | null;
  onSelectEffect?: (effectId: string) => void;
  onSetItemEffects: (id: string, effects: ClipEffect[]) => void;
  onBeginHistoryGesture: () => void;
  onEndHistoryGesture: () => void;
}
interface MosaicGeometry {
  region: MosaicRegion;
  sourceRect: PreviewRect;
  outline: PreviewPoint[];
  handles: Record<Exclude<MaskHandle, 'move'>, PreviewPoint>;
}
interface MosaicTargetEntry {
  entry: ClipMosaicEntry;
  geometry: MosaicGeometry;
}
interface Gesture {
  pointerId: number; item: TimelineItem; effectId: string; frame: number; localFrame: number;
  region: MosaicRegion; sourceRect: PreviewRect; handle: MaskHandle;
  client: PreviewPoint; began: boolean;
}
const labels: Record<Exclude<MaskHandle, 'move'>, string> = {
  nw: '马赛克区域左上角', n: '马赛克区域上边', ne: '马赛克区域右上角', e: '马赛克区域右边',
  se: '马赛克区域右下角', s: '马赛克区域下边', sw: '马赛克区域左下角', w: '马赛克区域左边',
};

function targetAndGeometries(state: TimelineState, frame: number): { item: TimelineItem; entries: MosaicTargetEntry[] } | null {
  if ((state.selectedIds?.length ?? 0) > 1 || state.width <= 0 || state.height <= 0) return null;
  const item = state.items.find((entry) => entry.id === state.selectedId);
  if (!item || (item.kind !== 'video' && item.kind !== 'image')
    || frame < item.startFrame || frame >= item.startFrame + item.durationInFrames) return null;
  const candidate = visiblePreviewCandidates(state, frame).find((entry) => entry.item.id === item.id);
  if (!candidate) return null;
  const localFrame = Math.max(0, Math.round(frame) - item.startFrame);
  const localMosaics = listClipMosaics(item, localFrame).filter((entry) => entry.mode === 'local');
  if (!localMosaics.length) return null;
  const fit = isBackgroundFillActive(state, item) ? 'contain' : state.fit ?? 'contain';
  const canvas = { width: state.width, height: state.height };
  const at = (x: number, y: number) => previewMaskPoint(state, item, localFrame, { x, y });
  const entries: MosaicTargetEntry[] = [];
  for (const entry of localMosaics) {
    const track = mosaicTrackForEffect(item, entry.id);
    const sourceSize = track
      ? { width: track.sourceWidth, height: track.sourceHeight }
      : { width: item.width ?? state.width, height: item.height ?? state.height };
    const sourceRect = track ? (() => {
      const frameRect = visibleVisualFrameRect(canvas, { width: item.width ?? state.width, height: item.height ?? state.height }, fit);
      const inner = renderedVisualFrameRect(frameRect, sourceSize, fit === 'contain' ? 'cover' : fit);
      return { x: frameRect.x + inner.x, y: frameRect.y + inner.y, width: inner.width, height: inner.height };
    })() : visibleVisualFrameRect(canvas, sourceSize, fit);
    if (!(sourceRect.width > 0 && sourceRect.height > 0)) continue;
    const x0 = sourceRect.x + (entry.region.centerX - entry.region.width / 2) * sourceRect.width;
    const y0 = sourceRect.y + (entry.region.centerY - entry.region.height / 2) * sourceRect.height;
    const x1 = x0 + entry.region.width * sourceRect.width;
    const y1 = y0 + entry.region.height * sourceRect.height;
    const raw = { nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0], e: [x1, (y0 + y1) / 2],
      se: [x1, y1], s: [(x0 + x1) / 2, y1], sw: [x0, y1], w: [x0, (y0 + y1) / 2] } as const;
    const handles = {} as MosaicGeometry['handles'];
    let valid = true;
    for (const handle of MASK_HANDLES) {
      const point = at(...raw[handle]);
      if (!point) { valid = false; break; }
      handles[handle] = point;
    }
    if (!valid) continue;
    entries.push({
      entry,
      geometry: { region: entry.region, sourceRect, outline: [handles.nw, handles.ne, handles.se, handles.sw], handles },
    });
  }
  return entries.length ? { item, entries } : null;
}

function clientPoint(event: PointerEvent<HTMLDivElement>): PreviewPoint {
  return { x: event.clientX, y: event.clientY };
}

export function PreviewMosaicOverlay({
  state,
  playerRef,
  playing = false,
  selectedEffectId = null,
  onSelectEffect,
  onSetItemEffects,
  onBeginHistoryGesture,
  onEndHistoryGesture,
}: PreviewMosaicOverlayProps) {
  const [frame, setFrame] = useState(() => Math.round(playerRef.current?.getCurrentFrame() ?? 0));
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pending = useRef<MosaicRegion | null>(null);
  const raf = useRef(0);
  const latest = useRef({ state, playerRef, onSetItemEffects, onBeginHistoryGesture, onEndHistoryGesture });
  latest.current = { state, playerRef, onSetItemEffects, onBeginHistoryGesture, onEndHistoryGesture };
  const overlaySleeping = playing && !gesture.current;
  const target = overlaySleeping ? null : targetAndGeometries(state, frame);
  const activeTarget = target
    ? (target.entries.find(({ entry }) => entry.id === selectedEffectId) ?? target.entries[0] ?? null)
    : null;

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const syncNow = () => setFrame(Math.round(player.getCurrentFrame()));
    syncNow();
    const onFrame = ({ detail }: { detail: { frame: number } }) => {
      if (playingRef.current && !gesture.current) return;
      setFrame(Math.round(detail.frame));
    };
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('pause', syncNow);
    player.addEventListener('seeked', syncNow);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('pause', syncNow);
      player.removeEventListener('seeked', syncNow);
    };
  }, [playerRef]);
  useEffect(() => {
    if (!playing && playerRef.current) setFrame(Math.round(playerRef.current.getCurrentFrame()));
  }, [playing, playerRef]);

  const isValid = useCallback((g: Gesture) => {
    const current = latest.current.state;
    const active = targetAndGeometries(current, g.frame);
    const match = active?.entries.find(({ entry }) => entry.id === g.effectId);
    return active?.item.id === g.item.id && !!match && active.item.transform === g.item.transform
      && match.geometry.sourceRect.width === g.sourceRect.width
      && match.geometry.sourceRect.height === g.sourceRect.height
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
    const region = mosaicTrackForEffect(liveItem, g.effectId)
      ? mosaicTrackRegionToStatic(liveItem, next, fit, { width: stateNow.width, height: stateNow.height }, g.effectId)
      : next;
    const effects = updateClipMosaicById(liveItem.effects ?? [], g.effectId, { region });
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
      if (liveItem) latest.current.onSetItemEffects(
        g.item.id,
        updateClipMosaicById(liveItem.effects ?? [], g.effectId, {
          region: g.region,
          preserveTrack: !!mosaicTrackForEffect(liveItem, g.effectId),
        }),
      );
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
    const startLeft = Math.max(0, Math.min(1 - 0.01, g.region.centerX - g.region.width / 2));
    const startTop = Math.max(0, Math.min(1 - 0.01, g.region.centerY - g.region.height / 2));
    const startWidth = Math.max(0.01, Math.min(1 - startLeft, g.region.width));
    const startHeight = Math.max(0.01, Math.min(1 - startTop, g.region.height));
    const rect = { type: 'rectangle' as const, x: startLeft, y: startTop, width: startWidth, height: startHeight };
    const next = dragPreviewMask(rect, g.handle, localDelta);
    const width = Math.max(0.01, next.width);
    const height = Math.max(0.01, next.height);
    pending.current = { ...g.region, centerX: next.x + width / 2, centerY: next.y + height / 2, width, height };
    if (!raf.current) raf.current = requestAnimationFrame(commit);
  };
  if (overlaySleeping) return null;
  return <div ref={root} className="cc-preview-mask-overlay" role="group" aria-label={t('预览画布局部马赛克编辑')}
    tabIndex={0} data-cc-shortcut-surface="inspector"
    onPointerDown={(event) => {
      if (event.button !== 0 || gesture.current || !target) return;
      const selectTarget = (event.target as Element).closest('[data-mosaic-select]');
      const selectId = selectTarget?.getAttribute('data-mosaic-select');
      if (selectId) {
        event.preventDefault(); event.stopPropagation();
        onSelectEffect?.(selectId);
        return;
      }
      if (!activeTarget) return;
      const handle = (event.target as Element).closest('[data-mosaic-handle]')?.getAttribute('data-mosaic-handle') as MaskHandle | null;
      if (!handle) return;
      event.preventDefault(); event.stopPropagation(); playerRef.current?.pause();
      event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        pointerId: event.pointerId,
        item: target.item,
        effectId: activeTarget.entry.id,
        frame,
        localFrame: frame - target.item.startFrame,
        region: activeTarget.geometry.region,
        sourceRect: activeTarget.geometry.sourceRect,
        handle,
        client: clientPoint(event),
        began: false,
      };
    }}
    onPointerMove={move}
    onPointerUp={(event) => { if (gesture.current?.pointerId === event.pointerId) { move(event); finish(); } }}
    onPointerCancel={(event) => { if (gesture.current?.pointerId === event.pointerId) finish(true); }}
    onLostPointerCapture={() => finish(false, false)}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(true); }
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) finish(false, false);
    }}>
    {target && activeTarget && <>
      <svg className="cc-preview-transform-outline" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none">
        {target.entries.map(({ entry, geometry }) => entry.id === activeTarget.entry.id ? null : (
          <polygon
            key={entry.id}
            className="cc-preview-mask-region is-inactive"
            data-mosaic-select={entry.id}
            points={geometry.outline.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="transparent"
            stroke="var(--cc-accent)"
            strokeOpacity="0.55"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'all', cursor: 'pointer' }}
          />
        ))}
        <polygon className="cc-preview-mask-region" data-mosaic-selection={target.item.id}
          data-mosaic-effect-id={activeTarget.entry.id}
          data-mosaic-handle="move" points={activeTarget.geometry.outline.map((point) => `${point.x},${point.y}`).join(' ')}
          fill="transparent" stroke="var(--cc-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {target.entries.length > 1 && target.entries.map(({ entry, geometry }) => {
        const isActive = entry.id === activeTarget.entry.id;
        return (
          <span
            key={entry.id}
            style={{
              position: 'absolute',
              left: `${Math.max(2, Math.min(92, geometry.handles.nw.x / state.width * 100))}%`,
              top: `${Math.max(2, Math.min(92, geometry.handles.nw.y / state.height * 100))}%`,
              transform: 'translate(4px, 4px)',
              padding: '1px 6px',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.4,
              background: isActive ? 'var(--cc-accent)' : 'var(--cc-panel)',
              color: isActive ? 'var(--cc-on-accent)' : 'var(--cc-text)',
              border: '1px solid var(--cc-accent)',
              pointerEvents: 'none',
            }}
          >
            {t('马赛克 {n}', { n: entry.index })}
          </span>
        );
      })}
      {MASK_HANDLES.map((handle) => <button key={handle} type="button" className={`cc-preview-mask-handle mask-${handle}`}
        data-mosaic-handle={handle} aria-label={t(labels[handle])}
        style={{ left: `${activeTarget.geometry.handles[handle].x / state.width * 100}%`, top: `${activeTarget.geometry.handles[handle].y / state.height * 100}%` }} />)}
      <span className="cc-preview-mask-hint">{t('拖动马赛克范围移动 · 拉动边角调整大小 · Esc 取消')}</span>
    </>}
  </div>;
}
