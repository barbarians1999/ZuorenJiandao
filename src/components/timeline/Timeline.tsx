import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { theme, themeAlpha } from '../../theme';
import {
  TRANSITION_LABELS, captionsOnTrack, isEffectTrack, isTextTrack, selectedIdsOf, trackKind, type TrackId,
} from '../../editor/types';
import { ClipContextMenu } from './ClipContextMenu';
import { Icon } from '../icons';
import { CaptionStyleMenu } from '../../captions/CaptionStyleMenu';
import { CaptionTrackLane } from '../../captions/CaptionTrackLane';
import { captionSelectionsInFrameRange } from '../../captions/captionSelection';
import { removeManualCue } from '../../captions/manualCaptions';
import { TrackHead } from './TrackHead';
import { TrackLane } from './TrackLane';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { MarkerEditor } from './MarkerEditor';
import { trackDeletePlan } from './trackDelete';
import { TrackContextMenu } from './TrackContextMenu';
import { TransitionContextMenu } from './TransitionContextMenu';
import { closeCaptionTrackGaps, trackClearPlan } from './trackContextOperations';
import { HEADER_W, RULER_H } from './timelineUtil';
import { playheadScrubGrabOffsetPx } from './timelineSeek';
import {
  CAPTION_SELECTION_OWNER_SELECTOR,
  CAPTION_SELECTION_TIMELINE_CLIP_SELECTOR,
  CAPTION_SELECTION_TIMELINE_HEAD_SELECTOR,
  CAPTION_SELECTION_TIMELINE_REGION_SELECTOR,
  shouldClearCaptionSelectionFromPointer,
} from '../../captions/captionSelectionInteraction';
import type { TimelineProps } from './timelineTypes';
import { useTimelineController } from './useTimelineController';
import { SceneDetectionDialog } from '../../scene-detection/SceneDetectionDialog';
import { mainTrackId } from '../../editor/magneticTimeline';
import { canItemMoveToTrack } from '../../editor/multiSelect';
import { trackDisplayLabel, trackOrderForHeaderDrop, type TrackDropSide } from './trackHeaderReorder';

export function Timeline(props: TimelineProps) {
  const {
    state, commands, playerRef, onRecordVoiceover, onReviewItem, onDropExternalFiles,
    selectedCaptions, onSelectCaption, onMarqueeCaptionSelect,
    t, total, empty, trackIds, indexes, innerRef, scrollRef,
    relinkInputRef, trackInsertInputRef,
    hoverPreviewFrame, captionSelectionMovePreview, setCaptionSelectionMovePreview,
    commitTimelineSelectionMove, zoom, zoomMin, setZoom, px, metaOf,
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    playing, editMode, placeMode, setPlaceMode, snapping, hoverPreviewEnabled, setHoverPreviewEnabled,
    captionsVisible, captionMenu, setCaptionMenu, trackMenu, setTrackMenu, transitionMenu, setTransitionMenu,
    duckMenu, setDuckMenu, captionError, setCaptionError,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu, recorder, toggleCaptions,
    pickMode, ctxMenu, setCtxMenu, fxClip, setFxClip, clipJob, setClipJob,
    beginRelink, relinkFile, beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    innerW, visibleWindow, rowHeightOf, tracksHeight,
    majorFrames, minorFrames, minorTicksPerMajor, rulerSpanFrames,
    frameFromClientX, trackFromClientY, copyCaptionSelections, pasteCaptionClipboard,
    pointer, drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel, cancelSeekGesture,
    activeSelectionMovePreview, libDropTarget, setLibDropTarget,
    applyLibraryToClip, applyLibraryToTrack, seekTo, seekFrame,
    clearHoverPreview, updateHoverPreview, startSeekGesture, updateSeekGesture, finishSeekGesture,
    markers, zoneIn, zoneOut, editing, editMarker, setEditMarker, pinnedItemIds,
  } = useTimelineController(props);
  const lastPlayheadGripX = useRef<number | null>(null);
  const playheadLineDragRef = useRef<{ startX: number; grabOffsetPx: number; dragged: boolean } | null>(null);
  const [trackReorderDrag, setTrackReorderDrag] = useState<{ sourceId: TrackId; targetId: TrackId; side: TrackDropSide } | null>(null);
  const trackReorderCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { trackReorderCleanupRef.current?.(); }, []);
  const startTrackHeaderReorder = (event: ReactPointerEvent<HTMLDivElement>, sourceId: TrackId) => {
    trackReorderCleanupRef.current?.();
    const startY = event.clientY;
    const sourceKind = trackKind(state, sourceId);
    let active = false;
    let current = { sourceId, targetId: sourceId, side: 'after' as TrackDropSide };
    const resolveTarget = (clientY: number) => {
      const rows = [...(innerRef.current?.querySelectorAll<HTMLElement>('[data-timeline-track-row]') ?? [])]
        .filter((row) => {
          const id = row.dataset.timelineTrackRow;
          return !!id && trackKind(state, id) === sourceKind;
        });
      if (!rows.length) return current;
      let chosen = rows[0]!;
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        chosen = row;
        if (clientY <= rect.bottom) break;
      }
      const rect = chosen.getBoundingClientRect();
      const targetId = chosen.dataset.timelineTrackRow || sourceId;
      const side: TrackDropSide = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      return { sourceId, targetId, side };
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKey, true);
      trackReorderCleanupRef.current = null;
      setTrackReorderDrag(null);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (!active && Math.abs(moveEvent.clientY - startY) < 4) return;
      active = true;
      current = resolveTarget(moveEvent.clientY);
      setTrackReorderDrag(current);
    };
    const onUp = () => {
      const shouldCommit = active;
      const committed = current;
      cleanup();
      if (!shouldCommit) return;
      const order = trackOrderForHeaderDrop(state, committed.sourceId, committed.targetId, committed.side);
      if (order !== null) commands.updateTrack(committed.sourceId, { order });
    };
    const onCancel = () => cleanup();
    const onKey = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); cleanup(); } };
    trackReorderCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey, true);
  };
  const lastVideoTrackId = [...trackIds].reverse().find((id) => trackKind(state, id) === 'video') ?? null;
  const [sceneDetectionItemId, setSceneDetectionItemId] = useState<string | null>(null);
  const sceneDetectionItem = sceneDetectionItemId
    ? state.items.find((item) => item.id === sceneDetectionItemId) ?? null
    : null;
  const draggedItem = drag ? indexes.itemById.get(drag.id) : undefined;
  const dragTargetLocked = !!drag && !drag.newTrackDrop && state.tracks?.[drag.targetTrack]?.locked;
  const dragTargetWrongKind = !!drag && !drag.newTrackDrop && drag.mode === 'move'
    && (draggedItem
      ? !canItemMoveToTrack(state, draggedItem, drag.targetTrack)
      : trackKind(state, drag.targetTrack) !== trackKind(state, drag.baseTrack));
  const newTrackDropLabel = !drag?.newTrackDrop ? ''
    : draggedItem?.kind === 'audio' ? t('松手在下方新增音乐轨道')
      : drag.newTrackPlacement === 'top'
        ? t(draggedItem?.kind === 'text' ? '松手在上方新增文字轨道' : '松手在上方新增画面轨道')
        : t('松手在下方新增视频轨道');
  const dragNotice = trackReorderDrag
    ? `${t('拖动调整轨道顺序，松手放到')} ${trackDisplayLabel(state, trackReorderDrag.targetId, t)} ${trackReorderDrag.side === 'before' ? t('上方') : t('下方')}`
    : !drag ? '' : drag.planError ? t(drag.planError)
    : drag.limitMessage ? t(drag.limitMessage)
    : dragTargetLocked ? t('目标轨道已锁定，片段不会移入；请拖到其他轨道。')
      : dragTargetWrongKind ? t('这条轨道不接受此类型，请拖到同类型轨道或新增区域。')
        : drag.newTrackDrop ? newTrackDropLabel
          : drag.mode === 'roll' ? t('滚动裁剪左右片段')
          : drag.mode !== 'move' ? t(drag.mode === 'slip' ? '调整素材使用的源区间' : '松手确认片段裁切')
            : state.interaction?.magnet && drag.targetTrack === mainTrackId(state)
              ? t('松手插入主轨，后续片段自动补位')
              : `${t('松手移动到')} ${trackDisplayLabel(state, drag.targetTrack, t)}`;

  const openClipContextMenu = useCallback((menu: { id: string; x: number; y: number }) => {
    setTrackMenu(null);
    setTransitionMenu(null);
    setCtxMenu(menu);
  }, [setCtxMenu, setTrackMenu, setTransitionMenu]);
  const openTransitionContextMenu = useCallback((menu: { id: string; x: number; y: number }) => {
    setCtxMenu(null);
    setCaptionMenu(null);
    setDuckMenu(null);
    setTrackMenu(null);
    setTransitionMenu(menu);
  }, [setCaptionMenu, setCtxMenu, setDuckMenu, setTrackMenu, setTransitionMenu]);
  const openTrackContextMenu = useCallback((menu: { trackId: TrackId; x: number; y: number; frame: number }) => {
    setCtxMenu(null);
    setCaptionMenu(null);
    setDuckMenu(null);
    setTransitionMenu(null);
    setTrackMenu(menu);
  }, [setCaptionMenu, setCtxMenu, setDuckMenu, setTrackMenu, setTransitionMenu]);

  return (
    <section
      className="cc-timeline"
      data-cc-shortcut-surface="timeline"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        const active = document.activeElement;
        if (active instanceof HTMLElement && !event.currentTarget.contains(active)
          && !target.closest('input, select, textarea, [contenteditable="true"]')) {
          active.blur();
        }
        if (!target.closest('button:not([data-roll-handle]):not([data-caption-roll-handle]):not(.cc-playhead-grip), input, select, textarea, [contenteditable="true"]')) {
          event.currentTarget.focus({ preventScroll: true });
        }
        if (!target.closest(CAPTION_SELECTION_OWNER_SELECTOR)
          && shouldClearCaptionSelectionFromPointer({
            insideTimelineClip: !!target.closest(CAPTION_SELECTION_TIMELINE_CLIP_SELECTOR),
            insideTimelineBlank: !!target.closest(CAPTION_SELECTION_TIMELINE_REGION_SELECTOR),
            insideTimelineHead: !!target.closest(CAPTION_SELECTION_TIMELINE_HEAD_SELECTOR),
            additive: event.metaKey || event.ctrlKey,
          })) {
          onSelectCaption(null);
        }
      }}
      style={{ flex: 1, borderLeft: `0.5px solid ${theme.border}`, background: theme.bg, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}
    >
      {/* marker note editor (click a pin → note popup) */}
      {editing && <MarkerEditor editing={editing} fps={state.fps} commands={commands} onClose={() => setEditMarker(null)} />}
      <TimelineToolbar
        headerLeading={props.headerLeading}
        state={state} commands={commands}
        editMode={editMode}
        placeMode={placeMode} setPlaceMode={setPlaceMode}
        snapping={snapping}
        hoverPreviewEnabled={hoverPreviewEnabled} setHoverPreviewEnabled={setHoverPreviewEnabled}
        recorder={recorder} canRecord={!!onRecordVoiceover}
        playing={playing}
        timecodeRef={toolbarTimecodeRef} playheadRef={playheadRef} playheadFrame={playheadRef.current} total={total}
        captionsVisible={captionsVisible}
        zoom={zoom} zoomMin={zoomMin} setZoom={setZoom}
        onPreviewCut={(frame) => { clearHoverPreview(); playerRef.current?.pause(); seekFrame(frame); }}
      />

      <div className="cc-timeline-drag-status" role="status" aria-live="polite"
        style={{ minHeight: 24, padding: '2px 12px', boxSizing: 'border-box', flexShrink: 0,
          fontSize: 14, color: drag?.planError || drag?.limitMessage || dragTargetLocked || dragTargetWrongKind ? theme.accent : theme.textMuted }}>
        {dragNotice}
      </div>

      {/* selection-mode hint strip (subtle banner while picking refs) */}
      {pickMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 12px', fontSize: 11, color: theme.accent, borderBottom: `0.5px solid ${theme.border}`, background: theme.panelAlt, flexShrink: 0 }}>
          <Icon name="cursor" size={12} />
          {t('选择模式：点片段引用 · 拖过标尺/空白选时间段 · 单击标尺打时间点 — 引用会加进聊天输入框')}
        </div>
      )}

      {/* scrollable ruler + tracks (playhead spans both). Ctrl/⌘+wheel = time
          zoom at playhead, Alt+wheel = horizontal scroll; Alt+Shift+wheel = track height. */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }}
        onPointerDownCapture={startSeekGesture}
        onPointerMoveCapture={(event) => { updateSeekGesture(event); updateHoverPreview(event); }}
        onPointerUpCapture={finishSeekGesture}
        onPointerCancelCapture={(event) => {
          cancelSeekGesture(event);
          clearHoverPreview();
        }}
        onLostPointerCapture={(event) => { cancelSeekGesture(event); onPointerCancel(); }}
        onPointerLeave={clearHoverPreview}
        onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        title={t('Ctrl/⌘+滚轮 以轴线为中心缩放时间轴 · Alt+滚轮 横向滚动 · Alt+Shift+滚轮 调整轨道高度')}>
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek, hold to scrub; selection mode: click = timepoint, drag = timerange).
The playhead line/triangle is pointerEvents:none, click it to click the ruler - scrub the same path to take effect.*/}
          <TimelineRuler
            state={state} empty={empty} px={px}
            majorFrames={majorFrames} minorFrames={minorFrames} minorTicksPerMajor={minorTicksPerMajor}
            rulerEndFrame={rulerSpanFrames} visibleWindow={visibleWindow}
            pickMode={pickMode} startPick={startPick} seekTo={seekTo}
            rulerTimecodeRef={rulerTimecodeRef} playheadFrame={playheadRef.current}
            zoneIn={zoneIn} zoneOut={zoneOut} markers={markers} onEditMarker={setEditMarker}
            pinnedMarkerId={editMarker}
          />

          {/* tracks */}
          {trackIds.map((trackId) => {
            const meta = metaOf(trackId);
            const config = state.tracks?.[trackId] ?? {};
            const trackCaptions = meta.kind === 'caption' ? captionsOnTrack(state, trackId) : null;
            const isDropTarget = drag?.mode === 'move' && !drag.newTrackDrop && drag.targetTrack === trackId
              && (draggedItem ? canItemMoveToTrack(state, draggedItem, trackId) : meta.kind === 'video' && !state.tracks?.[trackId]?.locked);
            const hidden = meta.kind === 'caption' ? !trackCaptions?.enabled : config.hidden ?? false;
            const headConfig = meta.kind === 'caption' ? { ...config, hidden } : config;
            const locked = config.locked ?? false;
            const isText = isTextTrack(state, trackId, mainTrackId(state));
            const isEffect = isEffectTrack(state, trackId, mainTrackId(state));
            const titleName = trackDisplayLabel(state, trackId, t);
            // Stable title (类型+序号) plus optional custom name as a second row,
            // so track naming never drifts when AI creates tracks with its own labels.

            const customName = config.name || undefined;
            const deletePlan = trackDeletePlan(state, trackId);
            const reorderTargetSide = trackReorderDrag?.targetId === trackId ? trackReorderDrag.side : null;
            const isVideoBottomNewTrackTarget = !!drag && drag.mode === 'move' && drag.newTrackDrop && drag.newTrackPlacement === 'bottom' && trackId === lastVideoTrackId && draggedItem?.kind !== 'audio';
            return (
              <div key={trackId} data-timeline-track-row={trackId} className={`cc-track-row${reorderTargetSide ? ` is-reorder-${reorderTargetSide}` : ''}${isVideoBottomNewTrackTarget ? ' is-new-track-after' : ''}`} style={{ height: rowHeightOf(trackId), background: isDropTarget ? `color-mix(in srgb, ${theme.success} 15%, ${theme.bg})` : undefined }}>
                <TrackHead
                  trackId={trackId} kind={meta.kind} isText={isText} isEffect={isEffect} trackName={titleName} customName={customName} config={headConfig}
                  onStartReorder={(event) => startTrackHeaderReorder(event, trackId)}
                  isReorderSource={trackReorderDrag?.sourceId === trackId}



                  deleteBlockedReason={deletePlan.blockedReason}
                  onDelete={() => {
                    if (deletePlan.requiresConfirmation
                      && !window.confirm(t('删除轨道会同时删除其中的片段、字幕和转场，确认继续吗？'))) return;
                    if (deletePlan.actions.length) commands.batch(deletePlan.actions, t('删除轨道'));
                  }}
  
                  menuElevated={captionMenu?.id === trackId || duckMenu?.id === trackId}
                  width={HEADER_W} commands={commands}
                  onToggleCaptions={() => toggleCaptions(trackId)}
                  // Both menus are attached with trigger buttons, top clamping margin = maximum menu height + margin (captions 420, dodge ≈ 300);
                  // When the caption menu is clipped to the left, space should be reserved for the translation submenu that pops to the right (212+4+128)
                  onToggleCaptionMenu={(rect) => {
                    if (captionMenu?.id === trackId) closeTrackDrillMenu();
                    else openCaptionTrackMenu(trackId, rect);
                  }}
  
                  onToggleDuckMenu={(rect) => {
                    if (duckMenu?.id === trackId) closeTrackDrillMenu();
                    else openDuckTrackMenu(trackId, rect);
                  }}
  
                  duckMenuPos={duckMenu?.id === trackId ? duckMenu : null}
                  onCloseDuckMenu={closeTrackDrillMenu}
                  onBackDuckMenu={backFromTrackDrillMenu}
                >
                  {captionMenu?.id === trackId && (
                    <CaptionStyleMenu
                      state={state} commands={commands} trackId={trackId} pos={captionMenu}
                      error={captionError} onError={setCaptionError} onClose={closeTrackDrillMenu}
                      onBack={backFromTrackDrillMenu}
                    />
                  )}
                </TrackHead>
                {meta.kind === 'caption' ? <CaptionTrackLane state={state} captions={trackCaptions} trackId={trackId}
                  playheadFrame={playheadRef.current} px={px} rowHeight={rowHeightOf(trackId)} locked={locked} hidden={hidden} snapping={snapping}
                  editMode={editMode} pickMode={pickMode} onStartMarquee={pointer.startMarquee}
                  trackFromClientY={trackFromClientY}
                  selectedCaptions={selectedCaptions} selectedItemIds={selectedIdsOf(state)}
                  selectionMovePreview={activeSelectionMovePreview}
                  onSelectCaption={onSelectCaption}
                  onActivateCaptionWorkspace={props.onActivateCaptionWorkspace}
                  onSelectionMovePreview={setCaptionSelectionMovePreview}
                  onLiveCaptionsPreview={props.onLiveCaptionPreview ? (patch) => props.onLiveCaptionPreview?.(patch ? { kind: 'patch', source: 'timeline', trackId, patch } : null) : undefined}
                  onLiveSelectionMovePreview={props.onLiveCaptionPreview ? (preview) => props.onLiveCaptionPreview?.(preview ? { kind: 'selectionMove', source: 'timeline', preview } : null) : undefined}
                  onMoveTimelineSelection={commitTimelineSelectionMove}
                  onUpdate={(patch) => commands.updateCaptions(patch, trackId)}
                  onMove={(move) => moveCaptionCue(trackId, move)}
                  onDropExternalFiles={onDropExternalFiles}
                  frameFromClientX={frameFromClientX}
                  onTrackContextMenu={(menu) => {
                    setCtxMenu(null);
                    setCaptionMenu(null);
                    setDuckMenu(null);
                    setTrackMenu(menu);
  
                  }}
                  onCopyCue={() => { copyCaptionSelections(); }}
                  onPasteCue={pasteCaptionClipboard}
                  onDelete={(laneId, index) => trackCaptions && commands.updateCaptions(removeManualCue(trackCaptions, laneId, index), trackId)} /> : <TrackLane
                  trackId={trackId} indexes={indexes} state={state} commands={commands} pointer={pointer}
                  editMode={editMode} pickMode={pickMode} locked={locked} hidden={hidden} muted={config.muted ?? false}
                  px={px} rowHeight={rowHeightOf(trackId)} visibleWindow={visibleWindow}
                  pinnedItemIds={pinnedItemIds}
                  selectionMovePreview={captionSelectionMovePreview}
                  libDropTarget={libDropTarget} setLibDropTarget={setLibDropTarget}
                  applyLibraryToClip={applyLibraryToClip} applyLibraryToTrack={applyLibraryToTrack}
                  rippleOnDrop={placeMode === 'insert'}
                  overwriteOnDrop={placeMode === 'overwrite'}
                  onDropExternalFiles={onDropExternalFiles}
                  frameFromClientX={frameFromClientX} onContextMenu={openClipContextMenu}
                  onTransitionContextMenu={openTransitionContextMenu}
                  onTrackContextMenu={openTrackContextMenu} scrollRef={scrollRef}
                />}
              </div>
            );
          })}

          {/* snap guide — appears while a drag edge is locked onto a target */}
          {drag && drag.snapAt !== null && (
            <div className="cc-snap-guide" style={{ position: 'absolute', top: 0, left: HEADER_W + drag.snapAt * px, height: RULER_H + tracksHeight }} />
          )}

          {hoverPreviewFrame !== null && (
            <div
              aria-hidden
              className="cc-timeline-hover-guide"
              style={{ left: HEADER_W + hoverPreviewFrame * px, height: RULER_H + tracksHeight }}
            />
          )}

          {/* selection-mode timerange marquee (time-marked drag) */}
          {pickDrag && Math.abs(pickDrag.endFrame - pickDrag.startFrame) > 0 && (
            <div style={{
              position: 'absolute', top: 0,
              left: HEADER_W + Math.min(pickDrag.startFrame, pickDrag.endFrame) * px,
              width: Math.abs(pickDrag.endFrame - pickDrag.startFrame) * px,
              height: RULER_H + tracksHeight,
              background: 'rgba(88,166,255,0.14)', borderLeft: '0.5px solid #58a6ff', borderRight: '0.5px solid #58a6ff',
              pointerEvents: 'none', zIndex: 5,
            }} />
          )}

          {/* playhead — GPU layer + rAF-coalesced updates for smoother scrub/play */}
          <div
            ref={playheadLineRef}
            className="cc-playhead"
            style={{
              position: 'absolute', top: 0, left: 0,
              transform: `translate3d(${HEADER_W + playheadRef.current * px}px,0,0)`,
              height: RULER_H + tracksHeight,
              pointerEvents: 'none',
              willChange: 'transform',
              zIndex: 15,
            }}
          >
            <div className="cc-playhead-handle" style={{ transform: 'translateX(-6px)', width: 13, height: 11, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
            <button type="button" className="cc-playhead-grip" aria-label={t('拖动播放头')} title={t('拖动播放头')}
              style={{ position: 'sticky', top: RULER_H - 14, marginTop: Math.max(0, RULER_H - 25), transform: 'translateX(-50%)' }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if (pickMode) { startPick(event, 'ruler'); return; }
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                lastPlayheadGripX.current = event.clientX;
                seekTo(event.clientX);
              }}
              onPointerMove={(event) => {
                if (pickMode || !event.currentTarget.hasPointerCapture(event.pointerId) || lastPlayheadGripX.current === event.clientX) return;
                lastPlayheadGripX.current = event.clientX;
                seekTo(event.clientX);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  if (!pickMode && lastPlayheadGripX.current !== event.clientX) seekTo(event.clientX);
                  lastPlayheadGripX.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={(event) => { lastPlayheadGripX.current = null; cancelSeekGesture(event); }}
              onLostPointerCapture={(event) => { lastPlayheadGripX.current = null; cancelSeekGesture(event); }}
              onKeyDown={(event) => {
                if (pickMode || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
                event.preventDefault();
                event.stopPropagation();
                seekFrame(playheadRef.current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1));
              }}
            />
            <div
              className="cc-playhead-line-grip"
              data-playhead-line-grip
              aria-hidden="true"
              title={t('拖动播放头')}
              style={{
                top: RULER_H,
                pointerEvents: editMode === 'blade' ? 'none' : 'auto',
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || editMode === 'blade') return;
                if (pickMode) { startPick(event, 'ruler'); return; }
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                const rect = innerRef.current?.getBoundingClientRect();
                const grabOffsetPx = rect
                  ? playheadScrubGrabOffsetPx(event.clientX, rect.left + HEADER_W + playheadRef.current * px)
                  : 0;
                playheadLineDragRef.current = { startX: event.clientX, grabOffsetPx, dragged: false };
                lastPlayheadGripX.current = event.clientX;
              }}
              onPointerMove={(event) => {
                if (pickMode || !event.currentTarget.hasPointerCapture(event.pointerId) || lastPlayheadGripX.current === event.clientX) return;
                const lineDrag = playheadLineDragRef.current;
                if (!lineDrag) return;
                if (!lineDrag.dragged && Math.abs(event.clientX - lineDrag.startX) < 1) return;
                lineDrag.dragged = true;
                lastPlayheadGripX.current = event.clientX;
                seekTo(event.clientX - lineDrag.grabOffsetPx);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  const lineDrag = playheadLineDragRef.current;
                  if (!pickMode && lineDrag?.dragged && lastPlayheadGripX.current !== event.clientX) {
                    seekTo(event.clientX - lineDrag.grabOffsetPx);
                  }
                  playheadLineDragRef.current = null;
                  lastPlayheadGripX.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={(event) => {
                playheadLineDragRef.current = null;
                lastPlayheadGripX.current = null;
                cancelSeekGesture(event);
              }}
              onLostPointerCapture={(event) => {
                playheadLineDragRef.current = null;
                lastPlayheadGripX.current = null;
                cancelSeekGesture(event);
              }}
            />
          </div>
        </div>
      </div>

      {/* rubber-band selection rect (client/fixed so it tracks the pointer while scrolling) */}
      {marquee && (() => {
        const left = Math.min(marquee.x0, marquee.x1);
        const top = Math.min(marquee.y0, marquee.y1);
        const w = Math.abs(marquee.x1 - marquee.x0);
        const h = Math.abs(marquee.y1 - marquee.y0);
        if (w < 2 && h < 2) return null;
        return (
          <div
            aria-hidden
            style={{
              position: 'fixed',
              left, top, width: w, height: h,
              border: '1px solid rgba(120, 170, 255, 0.95)',
              background: 'rgba(80, 140, 255, 0.16)',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 80,
              boxSizing: 'border-box',
            }}
          />
        );
      })()}

      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,audio/*,image/*,.gif,.svg"
        hidden
        onChange={(event) => { void relinkFile(event.currentTarget.files); }}
      />
      <input
        ref={trackInsertInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => insertTrackFiles(event.currentTarget.files)}
      />

      {/* transition badge right-click menu: remove and retime from where it is drawn */}
      {transitionMenu && (() => {
        const transition = (state.transitions ?? []).find((item) => item.id === transitionMenu.id);
        if (!transition) return null;
        const locked = !!state.tracks?.[transition.trackId]?.locked;
        return (
          <TransitionContextMenu
            label={t(TRANSITION_LABELS[transition.type] ?? transition.type)}
            durationInFrames={transition.durationInFrames}
            fps={state.fps}
            locked={locked}
            x={transitionMenu.x}
            y={transitionMenu.y}
            onSetDuration={(frames) => commands.setTransition(transition.id, { durationInFrames: frames })}
            onRemove={() => commands.removeTransition(transition.id)}
            onClose={() => setTransitionMenu(null)}
          />
        );
      })()}

      {/* blank-track right-click menu */}
      {trackMenu && (() => {
        const trackId = trackMenu.trackId;
        if (!trackIds.includes(trackId)) return null;
        const kind = trackKind(state, trackId);
        const config = state.tracks?.[trackId] ?? {};
        const captions = kind === 'caption' ? captionsOnTrack(state, trackId) : null;
        const items = state.items.filter((item) => item.track === trackId);
        const captionSelections = captions
          ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, 0, Number.MAX_SAFE_INTEGER)
          : [];
        const sortedItems = [...items].sort((a, b) => a.startFrame - b.startFrame);
        const captionTighten = captions ? closeCaptionTrackGaps(captions) : null;
        const canTighten = kind === 'caption'
          ? !!captionTighten?.changed
          : sortedItems.some((item, index) => index > 0
            && item.startFrame > sortedItems[index - 1]!.startFrame + sortedItems[index - 1]!.durationInFrames);
        const clearPlan = trackClearPlan(state, trackId);
        const deletePlan = trackDeletePlan(state, trackId);
        const hidden = kind === 'caption' ? !captions?.enabled : !!config.hidden;
        return (
          <TrackContextMenu
            kind={kind}
            x={trackMenu.x}
            y={trackMenu.y}
            hidden={hidden}
            muted={!!config.muted}
            soloed={!!config.soloed}
            locked={!!config.locked}
            canTighten={canTighten}
            hasContents={clearPlan.hasContents}
            hasSelectable={kind === 'caption' ? captionSelections.length > 0 : items.length > 0}
            deleteBlockedReason={deletePlan.blockedReason}
            onInsert={() => beginTrackInsert(trackId, trackMenu.frame)}
            onTighten={() => {
              if (kind === 'caption' && captionTighten?.changed) commands.setCaptions(captionTighten.captions, trackId);
              else if (kind !== 'caption') commands.tightenTrack(trackId);
            }}
            onSelectAll={() => {
              if (kind === 'caption') {
                commands.selectItems([]);
                onMarqueeCaptionSelect(captionSelections, { additive: false, preserveWithItems: false });
              } else {
                onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
                commands.selectItems(items.map((item) => item.id));
              }
            }}
            onClear={() => {
              if (clearPlan.blockedReason || !clearPlan.hasContents) return;
              if (!window.confirm(t('清空轨道会删除其中的片段、字幕和转场，确认继续吗？'))) return;
              commands.batch(clearPlan.actions, t('清空轨道'));
              onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
            }}
            onToggleHidden={() => {
              if (kind === 'caption') toggleCaptions(trackId);
              else commands.toggleTrackFlag(trackId, 'hidden');
            }}
            onToggleMuted={() => commands.toggleTrackFlag(trackId, 'muted')}
            onToggleSolo={() => commands.toggleTrackFlag(trackId, 'soloed')}
            onToggleLocked={() => commands.toggleTrackFlag(trackId, 'locked')}
            onRename={() => {
              const current = state.tracks?.[trackId]?.name ?? '';
              const next = window.prompt(t('轨道名称（留空恢复默认）'), current) ?? null;
              if (next === null) return;
              commands.updateTrack(trackId, { name: next.trim() ? next.trim() : undefined });
            }}
            onOpenDuck={(rect) => openDuckTrackMenu(trackId, rect, trackMenu, true)}
            onOpenCaptionStyle={(rect) => openCaptionTrackMenu(trackId, rect, false, trackMenu, true)}
            onDelete={() => {
              if (deletePlan.blockedReason) return;
              if (deletePlan.requiresConfirmation
                && !window.confirm(t('删除轨道会同时删除其中的片段、字幕和转场，确认继续吗？'))) return;
              commands.batch(deletePlan.actions, t('删除轨道'));
              onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
            }}
            onClose={() => setTrackMenu(null)}
          />
        );
      })()}

      {/* clip right-click menu */}
      {ctxMenu && (() => {
        const item = state.items.find((it) => it.id === ctxMenu.id);
        if (!item) return null;
        return (
          <ClipContextMenu onCopy={() => props.shortcutApiRef?.current?.copySelected()} onPaste={() => props.shortcutApiRef?.current?.pasteClipboard()} item={item} x={ctxMenu.x} y={ctxMenu.y} playhead={playheadRef.current} commands={commands}
            projectDoc={props.projectDoc}
            timeline={state}
            selectedIds={selectedIdsOf(state)}
            transitions={(state.transitions ?? []).filter((t) => t.incomingItemId === item.id || t.outgoingItemId === item.id)}
            fxClip={fxClip} onCopyFx={setFxClip} onClose={() => setCtxMenu(null)}
            onExportMg={exportMg} onConvertToVideo={convertToVideo}
            onAddComment={(target, frame, clientX, clientY) => {
              playerRef.current?.seekTo(frame);
              onReviewItem?.({ itemId: target.id, frame, clientX, clientY });
            }}
            onRelinkFile={beginRelink}
            onDetectScenes={(target) => { setSceneDetectionItemId(target.id); setCtxMenu(null); }} />
        );
      })()}

      {sceneDetectionItem && (
        <SceneDetectionDialog
          key={`${props.projectId ?? ''}:${(state as { id?: string }).id ?? ''}:${sceneDetectionItem.id}`}
          state={state}
          commands={commands}
          item={sceneDetectionItem}
          onPreviewCut={(frame) => { clearHoverPreview(); playerRef.current?.pause(); seekFrame(frame); }}
          onClose={() => setSceneDetectionItemId(null)}
        />
      )}

      {/* single-clip render status (export MG / convert to video take a few seconds)*/}
      {clipJob && (
        <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 200,
          background: clipJob.error ? theme.accent : theme.panelAlt, color: clipJob.error ? theme.onAccent : theme.text,
          border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '9px 16px', fontSize: 12.5,
          boxShadow: `0 8px 28px ${themeAlpha.shadow(0.5)}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{clipJob.msg}</span>
          {clipJob.error && <button onClick={() => setClipJob(null)} style={{ background: 'none', border: 'none', color: theme.onAccent, cursor: 'pointer', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} /></button>}
        </div>
      )}
    </section>
  );
}
