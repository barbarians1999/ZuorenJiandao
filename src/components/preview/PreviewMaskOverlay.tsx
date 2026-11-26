import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { ClipMask, KeyframeEasing, KeyframeProp, TimelineItem, TimelineState } from '../../editor/types';
import { t } from '../../i18n/locale';
import { MASK_CHANNELS, MASK_HANDLES, dragPreviewMask, previewMaskDelta, previewMaskGeometry,
  previewMaskTarget, previewMaskWrites, type MaskHandle } from './previewMask';

export interface PreviewMaskOverlayProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  playing?: boolean;
  onSetItemMask: (id: string, mask: ClipMask | null) => void;
  onSetItemKeyframe: (id: string, prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe: (id: string, prop: KeyframeProp, frame: number) => void;
  onBeginHistoryGesture: () => void;
  onEndHistoryGesture: () => void;
}
interface Gesture {
  pointerId: number; handle: MaskHandle; item: TimelineItem; mask: ClipMask;
  frame: number; localFrame: number; width: number; height: number;
  client: { x: number; y: number }; began: boolean;
  touched: Set<keyof typeof MASK_CHANNELS>;
}
const labels = { nw: '蒙版左上角', n: '蒙版上边', ne: '蒙版右上角', e: '蒙版右边',
  se: '蒙版右下角', s: '蒙版下边', sw: '蒙版左下角', w: '蒙版左边' };

export function PreviewMaskOverlay(props: PreviewMaskOverlayProps) {
  const { state, playerRef, playing = false } = props;
  const [frame, setFrame] = useState(() => Math.round(playerRef.current?.getCurrentFrame() ?? 0));
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pending = useRef<ClipMask | null>(null);
  const raf = useRef(0);
  const latest = useRef(props); latest.current = props;
  const overlaySleeping = playing && !gesture.current;
  const item = overlaySleeping ? undefined : previewMaskTarget(state, frame);
  const geometry = item && previewMaskGeometry(state, item, frame - item.startFrame);

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
    const live = latest.current.state;
    const target = previewMaskTarget(live, g.frame);
    return target?.id === g.item.id && target.mask?.type === g.item.mask?.type
      && target.track === g.item.track && target.transform === g.item.transform
      && target.props?.visualEntrance === g.item.props?.visualEntrance
      && target.props?.visualExit === g.item.props?.visualExit
      && target.props?.visualEntranceFrames === g.item.props?.visualEntranceFrames
      && target.props?.visualExitFrames === g.item.props?.visualExitFrames
      && target.startFrame === g.item.startFrame && target.durationInFrames === g.item.durationInFrames
      && live.width === g.width && live.height === g.height
      && Math.round(latest.current.playerRef.current?.getCurrentFrame() ?? g.frame) === g.frame;
  }, []);
  const commit = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
    const next = pending.current; pending.current = null;
    const g = gesture.current;
    if (!next || !g || !isValid(g)) return;
    // Write against the captured start, not cumulative deltas. Live base avoids
    // overwriting unrelated values changed by another inspector control.
    const liveItem = latest.current.state.items.find((entry) => entry.id === g.item.id)!;
    const writes = previewMaskWrites(liveItem, g.localFrame, g.mask, next, g.touched);
    for (const key of Object.keys(MASK_CHANNELS) as Array<keyof typeof MASK_CHANNELS>) {
      if (Math.abs(next[key] - g.mask[key]) >= 1e-9) g.touched.add(key);
    }
    if (writes.mask) latest.current.onSetItemMask(g.item.id, writes.mask);
    for (const keyframe of writes.keyframes) latest.current.onSetItemKeyframe(g.item.id, keyframe.prop, keyframe.frame, keyframe.value);
  }, [isValid]);
  const finish = useCallback((cancel = false, flush = true) => {
    const g = gesture.current;
    if (!g) return;
    if (flush && !cancel) commit();
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0; pending.current = null;
    if (cancel && g.began && isValid(g)) {
      const liveItem = latest.current.state.items.find((entry) => entry.id === g.item.id)!;
      const restored = { ...liveItem.mask! };
      let staticTouched = false;
      for (const key of g.touched) {
        const prop = MASK_CHANNELS[key];
        if (g.item.keyframes?.[prop]?.length) {
          const original = g.item.keyframes[prop]!.find((kf) => kf.frame === g.localFrame);
          if (original) latest.current.onSetItemKeyframe(g.item.id, prop, original.frame, original.value, original.easing);
          else latest.current.onRemoveItemKeyframe(g.item.id, prop, g.localFrame);
        } else { restored[key] = g.item.mask![key]; staticTouched = true; }
      }
      if (staticTouched) latest.current.onSetItemMask(g.item.id, restored);
    }
    gesture.current = null;
    if (g.began) latest.current.onEndHistoryGesture();
    const el = root.current;
    if (el?.hasPointerCapture(g.pointerId)) el.releasePointerCapture(g.pointerId);
  }, [commit, isValid]);

  useEffect(() => {
    const g = gesture.current;
    if (g && !isValid(g)) finish(false, false);
  }, [state, frame, isValid, finish]);
  useEffect(() => () => { finish(false, false); }, [finish]);

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId || !root.current) return;
    if (!isValid(g)) { finish(false, false); return; }
    const delta = { x: event.clientX - g.client.x, y: event.clientY - g.client.y };
    if (!g.began) {
      if (Math.hypot(delta.x, delta.y) < 3) return;
      g.began = true; latest.current.onBeginHistoryGesture();
    }
    const localDelta = previewMaskDelta({ width: g.width, height: g.height }, g.item, g.localFrame, delta, root.current.getBoundingClientRect());
    if (!localDelta) { finish(false, false); return; }
    pending.current = dragPreviewMask(g.mask, g.handle, localDelta);
    if (!raf.current) raf.current = requestAnimationFrame(commit);
  };
  if (overlaySleeping) return null;
  return <div ref={root} className="cc-preview-mask-overlay" role="group" aria-label={t('预览画布蒙版编辑')}
    tabIndex={0} data-cc-shortcut-surface="inspector"
    onPointerDown={(event) => {
      if (event.button !== 0 || gesture.current || !item || !geometry) return;
      const handle = (event.target as Element).closest('[data-mask-handle]')?.getAttribute('data-mask-handle') as MaskHandle | null;
      if (!handle) return;
      event.preventDefault(); event.stopPropagation(); playerRef.current?.pause();
      event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointerId: event.pointerId, handle, item, mask: geometry.mask, frame,
        localFrame: frame - item.startFrame, width: state.width, height: state.height,
        client: { x: event.clientX, y: event.clientY }, began: false, touched: new Set() };
    }}
    onPointerMove={move}
    onPointerUp={(event) => { if (gesture.current?.pointerId === event.pointerId) { move(event); finish(); } }}
    onPointerCancel={(event) => { if (gesture.current?.pointerId === event.pointerId) finish(true); }}
    onLostPointerCapture={() => finish(false, false)}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(true); }
      // Let the normal undo/redo shortcut run only AFTER ending the active drag.
      if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) finish(false, false);
    }}>
    {geometry && item && <>
      <svg className="cc-preview-transform-outline" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none">
        <polygon className="cc-preview-mask-region" data-mask-handle="move" data-mask-selection={item.id}
          points={geometry.outline.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="transparent" stroke="var(--cc-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {MASK_HANDLES.map((handle) => <button key={handle} type="button" className={`cc-preview-mask-handle mask-${handle}`}
        data-mask-handle={handle} aria-label={t(labels[handle])}
        style={{ left: `${geometry.handles[handle].x / state.width * 100}%`, top: `${geometry.handles[handle].y / state.height * 100}%` }} />)}
      <span className="cc-preview-mask-hint">{t('拖动内部移动 · 拉动边角调整大小 · Esc 取消')}</span>
    </>}
  </div>;
}
