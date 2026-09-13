import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { KeyframeEasing, TimelineItem, TimelineState } from '../../editor/types';
import { t } from '../../i18n/locale';
import { effectivePreviewTransform, previewCandidateGeometry, type PreviewPoint } from './previewTransform';
import { motionPathDelta, motionPathKeyframeFrames, sampleMotionPath } from './motionPath';

export interface MotionPathOverlayProps {
  state: TimelineState; item: TimelineItem; frame: number;
  onSetItemKeyframe: (id: string, prop: 'x' | 'y', localFrame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe: (id: string, prop: 'x' | 'y', localFrame: number) => void;
  onSeek: (frame: number) => void; onBeginHistoryGesture: () => void; onEndHistoryGesture: () => void;
}

interface DragState { pointerId: number; frame: number; startClient: PreviewPoint; startX: number; startY: number; moved: boolean }
const percent = (point: PreviewPoint, state: TimelineState) => ({ left: `${state.width ? point.x / state.width * 100 : 0}%`, top: `${state.height ? point.y / state.height * 100 : 0}%` });

export function MotionPathOverlay({ state, item, frame, onSetItemKeyframe, onRemoveItemKeyframe, onSeek, onBeginHistoryGesture, onEndHistoryGesture }: MotionPathOverlayProps) {
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null); const historyRef = useRef(false); const clickHandledRef = useRef(false); const rootRef = useRef<HTMLDivElement>(null);
  const frames = useMemo(() => motionPathKeyframeFrames(item), [item]);
  useEffect(() => setSelectedFrame(null), [item.id]);
  const points = useMemo(() => sampleMotionPath(item), [item]);
  const geometries = useMemo(() => new Map(points.map((point) => [point.frame, previewCandidateGeometry(state, { item, localFrame: point.frame, transform: effectivePreviewTransform(item, item.startFrame + point.frame) }).center] as const)), [item, points, state]);
  const localFrame = Math.round(frame) - item.startFrame; const inClip = localFrame >= 0 && localFrame < item.durationInFrames;
  const atPlayhead = !!item.keyframes?.x?.some((keyframe) => keyframe.frame === localFrame)
    && !!item.keyframes?.y?.some((keyframe) => keyframe.frame === localFrame);
  const selectedExists = selectedFrame != null && frames.includes(selectedFrame);
  const endGesture = useCallback(() => { const active = historyRef.current; historyRef.current = false; dragRef.current = null; if (active) onEndHistoryGesture(); }, [onEndHistoryGesture]);
  useEffect(() => () => endGesture(), [endGesture]);
  const addAtPlayhead = useCallback(() => {
    if (!inClip || atPlayhead) return;
    const transform = effectivePreviewTransform(item, frame);
    const local = Math.round(frame) - item.startFrame;
    const hasX = item.keyframes?.x?.some((keyframe) => keyframe.frame === local);
    const hasY = item.keyframes?.y?.some((keyframe) => keyframe.frame === local);
    onBeginHistoryGesture();
    if (!hasX) onSetItemKeyframe(item.id, 'x', local, transform.x);
    if (!hasY) onSetItemKeyframe(item.id, 'y', local, transform.y);
    onEndHistoryGesture();
    setSelectedFrame(local);
  }, [atPlayhead, frame, inClip, item, onBeginHistoryGesture, onEndHistoryGesture, onSetItemKeyframe]);
  const removeSelected = useCallback(() => { if (!selectedExists || selectedFrame == null) return; onBeginHistoryGesture(); onRemoveItemKeyframe(item.id, 'x', selectedFrame); onRemoveItemKeyframe(item.id, 'y', selectedFrame); onEndHistoryGesture(); setSelectedFrame(null); }, [item.id, onBeginHistoryGesture, onEndHistoryGesture, onRemoveItemKeyframe, selectedExists, selectedFrame]);
  const onNodePointerDown = (event: PointerEvent<HTMLButtonElement>, nodeFrame: number) => { if (event.button !== 0 || dragRef.current) return; event.preventDefault(); event.stopPropagation(); clickHandledRef.current = false; setSelectedFrame(nodeFrame); const transform = effectivePreviewTransform(item, item.startFrame + nodeFrame); dragRef.current = { pointerId: event.pointerId, frame: nodeFrame, startClient: { x: event.clientX, y: event.clientY }, startX: transform.x, startY: transform.y, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); };
  const onNodePointerMove = (event: PointerEvent<HTMLButtonElement>) => { const drag = dragRef.current; const root = rootRef.current; if (!drag || drag.pointerId !== event.pointerId || !root) return; const delta = motionPathDelta({ x: event.clientX - drag.startClient.x, y: event.clientY - drag.startClient.y }, root.getBoundingClientRect()); if (!drag.moved && Math.hypot(delta.x, delta.y) < 0.25) return; if (!drag.moved) { drag.moved = true; onBeginHistoryGesture(); historyRef.current = true; } const xEasing = item.keyframes?.x?.find((keyframe) => keyframe.frame === drag.frame)?.easing; const yEasing = item.keyframes?.y?.find((keyframe) => keyframe.frame === drag.frame)?.easing; onSetItemKeyframe(item.id, 'x', drag.frame, drag.startX + delta.x, xEasing); onSetItemKeyframe(item.id, 'y', drag.frame, drag.startY + delta.y, yEasing); };
  const onNodePointerUp = (event: PointerEvent<HTMLButtonElement>) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); const moved = drag.moved; clickHandledRef.current = true; endGesture(); if (!moved) onSeek(item.startFrame + drag.frame); };
  const onNodeClick = (nodeFrame: number) => { if (clickHandledRef.current) { clickHandledRef.current = false; return; } onSeek(item.startFrame + nodeFrame); };
  const onNodeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, nodeFrame: number) => { if (event.key !== 'Delete' && event.key !== 'Backspace') return; event.preventDefault(); setSelectedFrame(nodeFrame); onBeginHistoryGesture(); onRemoveItemKeyframe(item.id, 'x', nodeFrame); onRemoveItemKeyframe(item.id, 'y', nodeFrame); onEndHistoryGesture(); setSelectedFrame(null); };
  if (state.width <= 0 || state.height <= 0) return null;
  const path = points.length > 1 ? points.map((point, index) => { const center = geometries.get(point.frame)!; return `${index ? 'L' : 'M'} ${center.x} ${center.y}`; }).join(' ') : '';
  return <div ref={rootRef} className="cc-motion-path-overlay" data-motion-path-interactive onDoubleClick={(event) => event.stopPropagation()}>
    <div className="cc-motion-path-toolbar" data-motion-path-interactive>
      <button type="button" data-motion-path-interactive onClick={addAtPlayhead} disabled={!inClip || atPlayhead} title={!inClip ? t('播放头不在所选片段内') : atPlayhead ? t('当前位置已有位置关键帧') : undefined} aria-label={t('在播放头添加位置关键帧')}>＋ {t('在播放头添加位置关键帧')}</button>
      <button type="button" data-motion-path-interactive onClick={removeSelected} disabled={!selectedExists} title={!selectedExists ? t('请先选择一个位置关键帧') : undefined} aria-label={t('删除所选位置关键帧')}>{t('删除所选位置关键帧')}</button>
    </div>
    {path && <svg className="cc-motion-path-trail" viewBox={`0 0 ${state.width} ${state.height}`} preserveAspectRatio="none" aria-hidden="true"><path d={path} fill="none" stroke="var(--cc-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>}
    {frames.map((nodeFrame) => { const center = geometries.get(nodeFrame); if (!center) return null; const selected = selectedFrame === nodeFrame; return <button key={nodeFrame} type="button" className={`cc-motion-path-node${selected ? ' is-selected' : ''}`} data-motion-path-interactive data-motion-path-frame={nodeFrame} aria-pressed={selected} aria-label={t('位置关键帧，第 {frame} 帧', { frame: nodeFrame })} style={percent(center, state)} onPointerDown={(event) => onNodePointerDown(event, nodeFrame)} onPointerMove={onNodePointerMove} onPointerUp={onNodePointerUp} onPointerCancel={endGesture} onLostPointerCapture={endGesture} onClick={() => onNodeClick(nodeFrame)} onKeyDown={(event) => onNodeKeyDown(event, nodeFrame)} />; })}
  </div>;
}
