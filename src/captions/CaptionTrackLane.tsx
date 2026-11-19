import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { buildCaptionPages } from './captionPages';
import { timelineTrackIds, trackKind, type TimelineState, type TrackId } from '../editor/types';
import type { CaptionPage, CaptionsData } from './types';
import { theme, themeAlpha } from '../theme';
import { useT } from '../i18n/locale';
import { areCaptionCuesAdjacent, resizedManualCueTiming, rolledAdjacentManualCuesTiming, type ManualCueEdge } from './manualCaptions';
import {
  captionSelectionKey, resolveCaptionSelection,
  type CaptionSelectOptions, type CaptionSelectionRef,
} from './captionSelection';
import { captionContextMenuIntent, updateCaptionSelections } from './captionSelectionInteraction';
import {
  selectionMovePreviewDeltaForCaption, type TimelineSelectionMovePreview,
} from './captionGroupMove';
import {
  appendCaptionClipboardToTrack, createCaptionTimelineClipboard, type CaptionTimelineClipboard,
} from './captionTimelineClipboard';
import { droppedFiles, hasExternalFiles } from '../media/externalFileDrop';
import type { EditMode } from '../components/timeline/timelineUtil';
import { manualCueTargets, resolveDisplayRollSpans, useCaptionTrim, useDisplayCueTrim, useCaptionRollTrim, displayCueTrimRange, useCaptionMove, useCaptionSelectionMove, type CaptionRollPair, type DisplayCueTrimTarget, type ManualCueTarget, type CaptionCueMove } from './useCaptionCueGestures';

function cueText(words: Array<{ text: string }>): string {
  return words.map((word) => word.text.trim()).filter(Boolean).join(' ');
}

function CaptionCueBlock({
  page, index, target, selectionRef, locked, selected, hasBatchSelection, px, fps, moveOffsetY,
  displayTarget, rollTiming, hasRollLeft, hasRollRight,
  selectionMovePreview, trim, displayTrim, move, selectionMove, onSelect, onShiftSelectRange,
  onActivateCaptionWorkspace, onDelete, onMenu,
}: {
  page: CaptionPage; index: number; target?: ManualCueTarget; selectionRef: CaptionSelectionRef | null;
  displayTarget?: DisplayCueTrimTarget;
  rollTiming?: { start: number; end: number } | null;
  hasRollLeft?: boolean;
  hasRollRight?: boolean;
  locked: boolean; selected: boolean; hasBatchSelection: boolean; px: number; fps: number;
  moveOffsetY: number; selectionMovePreview: TimelineSelectionMovePreview | null;
  trim: ReturnType<typeof useCaptionTrim>;
  displayTrim: ReturnType<typeof useDisplayCueTrim>;
  move: ReturnType<typeof useCaptionMove>;
  selectionMove: ReturnType<typeof useCaptionSelectionMove>;
  onSelect: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onShiftSelectRange?: (target: CaptionSelectionRef) => CaptionSelectionRef[] | null;
  onActivateCaptionWorkspace?: (selection: CaptionSelectionRef) => void;
  onDelete: (target: ManualCueTarget) => void;
  onMenu: (event: ReactMouseEvent, target: ManualCueTarget, selection: CaptionSelectionRef) => void;
}) {
  const t = useT();
  const key = target ? `${target.laneId}:${target.words[target.index]?.id ?? target.index}` : `${page.start}:${index}`;
  const timing = target && trim.drag?.key === key
    ? resizedManualCueTiming(target.words, target.index, trim.drag.edge, trim.drag.deltaFrames * 1000 / fps, fps)
    : null;
  const displayTiming = displayTarget && displayTrim.drag?.key === key
    ? displayCueTrimRange(displayTarget, fps, displayTrim.drag.edge, displayTrim.drag.deltaFrames)
    : null;
  const legacyMoveFrames = move.drag?.key === key ? move.drag.deltaFrames : 0;
  const selectionMoveFrames = selectionMovePreviewDeltaForCaption(selectionRef, selectionMovePreview);
  const moveMs = (legacyMoveFrames + selectionMoveFrames) * 1000 / fps;
  const startMs = rollTiming?.start ?? timing?.start ?? displayTiming?.start ?? page.start + moveMs;
  const endMs = rollTiming?.end ?? timing?.end ?? displayTiming?.end ?? page.end + moveMs;
  const startFrame = Math.max(0, Math.round(startMs * fps / 1000));
  const durationFrames = Math.max(1, Math.round((endMs - startMs) * fps / 1000));
  const cueWidthPx = Math.max(2, durationFrames * px);
  const narrowCue = cueWidthPx < 20;
  const text = cueText(page.words);
  const handle = (edge: ManualCueEdge) => {
    if (!(target || displayTarget) || locked || (selected && hasBatchSelection)) return null;
    const edgeWidth = Math.min(6, Math.max(1, cueWidthPx / 3));
    const style = cueWidthPx < 32
      ? { width: edgeWidth, ...(edge === 'start' ? { left: -edgeWidth / 2 } : { right: -edgeWidth / 2 }) }
      : edge === 'start' && hasRollLeft
        ? { left: 6 }
        : edge === 'end' && hasRollRight
          ? { right: 6 }
          : undefined;
    return <div
      className={`cc-caption-track-trim ${edge === 'start' ? 'left' : 'right'}`}
      style={style}
      role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={t(edge === 'start' ? '拖动调整字幕开始时间' : '拖动调整字幕结束时间')}
      aria-valuenow={Math.round(edge === 'start' ? startMs : endMs)}
      title={t(edge === 'start' ? '拖动调整字幕开始时间' : '拖动调整字幕结束时间')}
      onPointerDown={(event) => displayTarget
        ? displayTrim.start(event, key, displayTarget, edge)
        : target && trim.start(event, key, target, edge)}
      onPointerMove={(event) => displayTarget ? displayTrim.move(event, key) : trim.move(event, key)}
      onPointerUp={(event) => displayTarget ? displayTrim.finish(event, key) : trim.finish(event, key)}
      onPointerCancel={() => { trim.cancel(); displayTrim.cancel(); }}
      onLostPointerCapture={() => { trim.cancel(); displayTrim.cancel(); }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        if (displayTarget) displayTrim.nudge(displayTarget, edge, event.key === 'ArrowLeft' ? -1 : 1);
        else if (target) trim.nudge(target, edge, event.key === 'ArrowLeft' ? -1 : 1);
      }}
    />;
  };
  return (
    <div className={`cc-caption-track-cue${selected ? ' selected' : ''}`} data-caption-selection-owner="timeline-cue"
      data-narrow={narrowCue ? 'true' : undefined}
      title={text} tabIndex={selectionRef && !locked ? 0 : undefined}
      style={{ left: startFrame * px, width: cueWidthPx,
        transform: move.drag?.key === key && moveOffsetY ? `translate3d(0, ${moveOffsetY}px, 0)` : undefined,
        zIndex: move.drag?.key === key || selectionMoveFrames ? 10 : undefined }}
      onPointerDown={(event) => {
        if (!selectionRef || locked) return;
        if (event.button === 0 && !(event.target as HTMLElement).closest('.cc-caption-track-trim')) onActivateCaptionWorkspace?.(selectionRef);
        if (event.shiftKey && onShiftSelectRange) {
          const range = onShiftSelectRange(selectionRef);
          if (range && range.length > 0) {
            selectionMove.start(event, key, page, selectionRef, range);
            event.currentTarget.focus();
            return;
          }
        }
        const additive = event.metaKey || event.ctrlKey;
        if (additive) {
          onSelect(selectionRef, { additive: true, preserveWithItems: true, toggle: true });
          event.currentTarget.focus();
          return;
        }
        const groupStarted = selectionMove.start(event, key, page, selectionRef);
        if (!selected) onSelect(selectionRef);
        event.currentTarget.focus();
        if (!groupStarted && target) move.start(event, key, target, selectionRef);
      }}
      onPointerCancel={() => {
        move.cancel();
        selectionMove.cancel();
      }}
      onContextMenu={(event) => {
        if (!target || locked || !selectionRef) return;
        event.preventDefault();
        event.stopPropagation();
        if (captionContextMenuIntent(event.ctrlKey) === 'ignore-after-toggle') return;
        if (!selected) onSelect(selectionRef);
        onMenu(event, target, selectionRef);
      }}
      onKeyDown={(event) => {
        if (!target || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
        event.preventDefault();
        onDelete(target);
      }}>
      {handle('start')}<span>{text}</span>{handle('end')}
    </div>
  );
}

export function CaptionTrackLane({
  state, captions, trackId, playheadFrame, px, rowHeight, hidden, locked, snapping, trackFromClientY,
  editMode = 'selection', pickMode = false, onStartMarquee,
  selectedCaptions: controlledSelectedCaptions, selectedItemIds = [], selectionMovePreview = null,
  onSelectCaption, onActivateCaptionWorkspace, onSelectionMovePreview = () => {}, onLiveCaptionsPreview, onLiveSelectionMovePreview, onMoveTimelineSelection = () => {},
  onUpdate, onMove, onDelete, onCopyCue, onPasteCue,
  onAddSelectionToChat, isOverChatComposer,
  onDropExternalFiles, frameFromClientX, onTrackContextMenu,
}: {
  state: TimelineState; captions: CaptionsData | null; trackId: TrackId; playheadFrame: number; px: number;
  hidden: boolean; locked: boolean; snapping: boolean; rowHeight: number; trackFromClientY: (clientY: number) => TrackId;
  editMode?: EditMode; pickMode?: boolean; onStartMarquee?: (event: React.PointerEvent) => void;
  selectedCaptions?: CaptionSelectionRef[];
  selectedItemIds?: readonly string[];
  selectionMovePreview?: TimelineSelectionMovePreview | null;
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onActivateCaptionWorkspace?: (selection: CaptionSelectionRef) => void;
  onSelectionMovePreview?: (preview: TimelineSelectionMovePreview | null) => void;
  onLiveCaptionsPreview?: (patch: Partial<CaptionsData> | null) => void;
  onLiveSelectionMovePreview?: (preview: TimelineSelectionMovePreview | null) => void;
  onMoveTimelineSelection?: (
    itemIds: readonly string[],
    captionSelections: readonly CaptionSelectionRef[],
    deltaFrames: number,
  ) => void;
  onUpdate: (patch: Partial<CaptionsData>) => void; onMove: (move: CaptionCueMove) => void;
  onDelete: (laneId: string, index: number) => void;
  onCopyCue?: (selection: CaptionSelectionRef) => void;
  onPasteCue?: () => boolean;
  onAddSelectionToChat?: (selection: { itemIds: string[]; captionSelections: CaptionSelectionRef[] }) => void;
  isOverChatComposer?: (clientX: number, clientY: number) => boolean;
  onDropExternalFiles?: (files: File[], trackId: TrackId, startFrame: number) => void;
  frameFromClientX?: (clientX: number) => number;
  onTrackContextMenu?: (menu: { trackId: TrackId; x: number; y: number; frame: number }) => void;
}) {
  const t = useT();
  const [localSelections, setLocalSelections] = useState<CaptionSelectionRef[]>([]);
  const selectedCaptions = controlledSelectedCaptions ?? localSelections;
  const selectCaption = (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => {
    if (onSelectCaption) {
      onSelectCaption(selection, options);
      return;
    }
    if (!selection) {
      setLocalSelections([]);
      return;
    }
    if (!options?.additive) {
      setLocalSelections([selection]);
      return;
    }
    setLocalSelections((current) => updateCaptionSelections(current, selection, options.toggle ? 'toggle' : 'add'));
  };
  const [timelineClipboard, setTimelineClipboard] = useState<CaptionTimelineClipboard | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: ManualCueTarget;
    selection: CaptionSelectionRef;
  } | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [timelineEditMessage, setTimelineEditMessage] = useState<string | null>(null);
  const closeMenu = () => {
    setMenu(null);
    setMenuError(null);
  };
  useEffect(() => {
    if (!menu) return;
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [menu]);
  const pages = captions ? buildCaptionPages(captions, state.items, state.fps) : [];
  const targets = manualCueTargets(captions);
  const trim = useCaptionTrim({ state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate, onLivePreview: onLiveCaptionsPreview });
  const displayTrim = useDisplayCueTrim({ state, trackId, playheadFrame, px, snapping, locked, onUpdate, onLivePreview: onLiveCaptionsPreview,
    onProblem: setTimelineEditMessage });
  const rollTrim = useCaptionRollTrim({ state, captions, trackId, playheadFrame, px, snapping, locked, onUpdate, onLivePreview: onLiveCaptionsPreview,
    onProblem: setTimelineEditMessage });
  const move = useCaptionMove({
    state, captions, trackId, playheadFrame, px, snapping, locked, trackFromClientY, onMove, onLivePreview: onLiveCaptionsPreview,
    isOverChatComposer,
    onDropSelectionToChat: onAddSelectionToChat,
  });
  const selectionMove = useCaptionSelectionMove({
    state,
    trackId,
    playheadFrame,
    px,
    snapping,
    locked,
    selectedCaptions,
    selectedItemIds,
    onPreview: (preview) => {
      onSelectionMovePreview(preview);
      onLiveSelectionMovePreview?.(preview);
    },
    onCommit: onMoveTimelineSelection,
    onClickWithoutDrag: (selection) => selectCaption(selection),
    onBlocked: setTimelineEditMessage,
    isOverChatComposer,
    onDropSelectionToChat: onAddSelectionToChat,
  });
  const trackIds = timelineTrackIds(state);
  const moveOffsetY = move.drag
    && trackKind(state, move.drag.targetTrackId) === 'caption'
    && !state.tracks?.[move.drag.targetTrackId]?.locked
    ? (trackIds.indexOf(move.drag.targetTrackId) - trackIds.indexOf(trackId)) * rowHeight
    : 0;
  const remove = (target: ManualCueTarget) => {
    selectCaption(null);
    closeMenu();
    onDelete(target.laneId, target.index);
  };
  const copyCue = async (selection: CaptionSelectionRef) => {
    const selectionIsActive = selectedCaptions.some(
      (candidate) => captionSelectionKey(candidate) === captionSelectionKey(selection),
    );
    const selections = selectionIsActive ? selectedCaptions : [selection];
    const cues = selections.flatMap((candidate) => {
      const resolved = resolveCaptionSelection(state, candidate)?.target.cue;
      return resolved ? [{ text: resolved.text, start: resolved.start, end: resolved.end }] : [];
    });
    const clipboard = createCaptionTimelineClipboard(cues);
    if (!clipboard) return;
    setTimelineClipboard(clipboard);
    onCopyCue?.(selection);
    try {
      await navigator.clipboard.writeText(clipboard.cues.map((cue) => cue.text).join('\n'));
    } catch {
      // The structured in-app clipboard remains available when OS permission is denied.
    }
    closeMenu();
  };
  const pasteCue = () => {
    if (onPasteCue?.()) {
      closeMenu();
      return;
    }
    if (!captions || !timelineClipboard) {
      setMenuError(t('剪贴板里没有可粘贴的文字'));
      return;
    }
    const patch = appendCaptionClipboardToTrack(
      captions,
      state.items,
      timelineClipboard,
      Math.round(playheadFrame * 1000 / state.fps),
    );
    if (!patch) {
      setMenuError(t('剪贴板里没有可粘贴的文字'));
      return;
    }
    onUpdate(patch);
    closeMenu();
  };
  return (
    <div className="cc-caption-track-lane" data-caption-selection-region="timeline" style={{
      background: locked ? `color-mix(in srgb, ${theme.bg} 70%, ${themeAlpha.shadow(1)})` : theme.bg,
      opacity: hidden ? 0.4 : locked ? 0.75 : 1,
      overflow: move.drag || selectionMove.drag ? 'visible' : undefined,
      zIndex: move.drag || selectionMove.drag ? 20 : undefined,
    }}
      onPointerDown={(event) => {
        if (locked || pickMode || editMode !== 'selection') return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-caption-selection-owner]')) return;
        onStartMarquee?.(event);
      }}
      onDragOver={(event) => {
        if (!hasExternalFiles(event.dataTransfer) || locked) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        const files = droppedFiles(event.dataTransfer);
        if (!files.length || locked || !onDropExternalFiles || !frameFromClientX) return;
        event.preventDefault();
        event.stopPropagation();
        onDropExternalFiles(files, trackId, frameFromClientX(event.clientX));
      }}
      onContextMenu={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('[data-caption-selection-owner]') || !frameFromClientX || !onTrackContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onTrackContextMenu({ trackId, x: event.clientX, y: event.clientY, frame: frameFromClientX(event.clientX) });
      }}>
      {timelineEditMessage && <div role="alert" className="cc-caption-track-edit-error">{t(timelineEditMessage)}</div>}
      {(() => {
        const rows = pages.map((identity, index) => {
          const page = identity.page;
          const target = page.words.length === 1 && page.words[0]?.id ? targets.get(page.words[0].id) : undefined;
          const cueId = target ? page.words[0]?.id : undefined;
          const source = identity.displayCueEditId && identity.entry
            ? state.items.find((item) => item.id === identity.entry!.itemId) : undefined;
          const displayTarget = identity.displayCueEditId && identity.displayCuePartId && identity.sourceSpans?.length && source
            ? { laneId: identity.entry!.id, editId: identity.displayCueEditId, partId: identity.displayCuePartId,
              key: identity.id, source, sourceSpans: identity.sourceSpans } satisfies DisplayCueTrimTarget
            : undefined;
          const selectionRef = target && cueId
            ? { trackId, kind: 'manual' as const, laneId: target.laneId, cueId }
            : { trackId, kind: 'single' as const, pageId: identity.id };
          const selected = selectedCaptions.some(
            (selection) => captionSelectionKey(selection) === captionSelectionKey(selectionRef),
          );
          const key = target ? `${target.laneId}:${target.words[target.index]?.id ?? target.index}` : `${page.start}:${index}`;
          return { identity, index, key, page, target, displayTarget, selectionRef, selected };
        });

        const hasBatchSelection = selectedCaptions.length > 1
          || (selectedCaptions.length > 0 && selectedItemIds.length > 0);
        const handleShiftSelectRange = (targetRef: CaptionSelectionRef): CaptionSelectionRef[] | null => {
          const anchor = [...selectedCaptions].reverse().find((item) => item.trackId === trackId) ?? selectedCaptions.at(-1);
          const anchorKey = anchor ? captionSelectionKey(anchor) : null;
          const targetKey = captionSelectionKey(targetRef);
          if (!anchorKey || !targetKey) return null;
          const aIdx = rows.findIndex((row) => captionSelectionKey(row.selectionRef) === anchorKey);
          const bIdx = rows.findIndex((row) => captionSelectionKey(row.selectionRef) === targetKey);
          if (aIdx < 0 || bIdx < 0) return null;
          const range = rows.slice(Math.min(aIdx, bIdx), Math.max(aIdx, bIdx) + 1).map((row) => row.selectionRef);
          const preserveWithItems = selectedItemIds.length > 0;
          for (const ref of range) {
            selectCaption(ref, { additive: true, preserveWithItems, toggle: false });
          }
          const merged = [...selectedCaptions];
          const seen = new Set(merged.map((item) => captionSelectionKey(item)));
          for (const ref of range) {
            const k = captionSelectionKey(ref);
            if (k && !seen.has(k)) {
              seen.add(k);
              merged.push(ref);
            }
          }
          return merged;
        };

        const rollPairs: Array<{ pair: CaptionRollPair; boundaryMs: number }> = [];
        const hasRollLeft = new Set<string>();
        const hasRollRight = new Set<string>();
        if (!locked) {
          for (let i = 0; i < rows.length - 1; i += 1) {
            const left = rows[i]!;
            const right = rows[i + 1]!;
            if (!areCaptionCuesAdjacent(left.page.end, right.page.start, state.fps)) continue;
            if (hasBatchSelection && (left.selected || right.selected)) continue;
            const leftWidthPx = Math.max(1, Math.round((left.page.end - left.page.start) * state.fps / 1000)) * px;
            const rightWidthPx = Math.max(1, Math.round((right.page.end - right.page.start) * state.fps / 1000)) * px;
            if (leftWidthPx < 32 || rightWidthPx < 32) continue;
            if (left.target && right.target && left.target.laneId === right.target.laneId && right.target.index === left.target.index + 1) {
              const key = `roll:${left.key}:${right.key}`;
              rollPairs.push({
                pair: { key, kind: 'manual', leftKey: left.key, rightKey: right.key, left: left.target, right: right.target },
                boundaryMs: Math.round((left.page.end + right.page.start) / 2),
              });
              hasRollRight.add(left.key);
              hasRollLeft.add(right.key);
            } else if (left.displayTarget && right.displayTarget && left.displayTarget.laneId === right.displayTarget.laneId) {
              const key = `roll:${left.key}:${right.key}`;
              rollPairs.push({
                pair: { key, kind: 'display', leftKey: left.key, rightKey: right.key, left: left.displayTarget, right: right.displayTarget },
                boundaryMs: Math.round((left.page.end + right.page.start) / 2),
              });
              hasRollRight.add(left.key);
              hasRollLeft.add(right.key);
            }
          }
        }

        const rollTimingByKey = new Map<string, { start: number; end: number }>();
        let activeRollBoundaryMs: number | null = null;
        if (rollTrim.drag) {
          const { pair, deltaFrames } = rollTrim.drag;
          if (pair.kind === 'manual') {
            const rolled = rolledAdjacentManualCuesTiming(
              pair.left.words,
              pair.left.index,
              pair.right.index,
              deltaFrames * 1000 / state.fps,
              state.fps,
            );
            if (rolled) {
              rollTimingByKey.set(pair.leftKey, { start: rolled.leftStart, end: rolled.leftEnd });
              rollTimingByKey.set(pair.rightKey, { start: rolled.rightStart, end: rolled.rightEnd });
              activeRollBoundaryMs = rolled.boundaryMs;
            }
          } else {
            const resolved = resolveDisplayRollSpans(pair.left, pair.right, state.fps, deltaFrames);
            if (resolved) {
              rollTimingByKey.set(pair.leftKey, resolved.leftRange);
              rollTimingByKey.set(pair.rightKey, resolved.rightRange);
              activeRollBoundaryMs = Math.round((resolved.leftRange.end + resolved.rightRange.start) / 2);
            }
          }
        }

        return (
          <>
            {rows.map(({ identity, index, key, page, target, displayTarget, selectionRef, selected }) => (
              <CaptionCueBlock key={identity.id} page={page} index={index} target={target} displayTarget={displayTarget}
                rollTiming={rollTimingByKey.get(key) ?? null}
                hasRollLeft={hasRollLeft.has(key)} hasRollRight={hasRollRight.has(key)}
                selectionRef={selectionRef}
                locked={locked} selected={selected} hasBatchSelection={hasBatchSelection} px={px} fps={state.fps} moveOffsetY={moveOffsetY}
                selectionMovePreview={selectionMovePreview}
                trim={trim} displayTrim={displayTrim} move={move} selectionMove={selectionMove} onSelect={selectCaption}
                onShiftSelectRange={handleShiftSelectRange}
                onActivateCaptionWorkspace={onActivateCaptionWorkspace} onDelete={remove}
                onMenu={(event, cue, selection) => {
                  setMenuError(null);
                  setMenu({
                    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 180)),
                    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 300)),
                    target: cue,
                    selection,
                  });
                }} />
            ))}
            {rollPairs.map(({ pair, boundaryMs }) => {
              const displayBoundaryMs = rollTrim.drag?.key === pair.key && activeRollBoundaryMs !== null
                ? activeRollBoundaryMs
                : boundaryMs;
              const boundaryFrame = Math.max(0, Math.round(displayBoundaryMs * state.fps / 1000));
              return (
                <button key={pair.key} type="button" data-caption-roll-handle data-caption-selection-owner="caption-roll"
                  className="cc-caption-roll-grip"
                  aria-label={t('拖动同时调整相邻字幕边界')}
                  title={t('拖动接缝同时调整前后字幕时间；方向键逐帧调整')}
                  style={{ left: boundaryFrame * px }}
                  onPointerDown={(event) => rollTrim.start(event, pair, boundaryMs)}
                  onPointerMove={(event) => rollTrim.move(event, pair.key)}
                  onPointerUp={(event) => rollTrim.finish(event, pair.key)}
                  onPointerCancel={() => rollTrim.cancel()}
                  onLostPointerCapture={() => rollTrim.cancel()}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    event.stopPropagation();
                    rollTrim.nudge(pair, event.key === 'ArrowLeft' ? -1 : 1);
                  }}
                />
              );
            })}
          </>
        );
      })()}
      {menu && <div className="cc-caption-cue-menu" data-caption-selection-owner="cue-menu" role="menu"
        style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" role="menuitem" onClick={() => void copyCue(menu.selection)}>{t('复制')}</button>
        <button type="button" role="menuitem" onClick={pasteCue}>{t('粘贴')}</button>
        <button type="button" role="menuitem" onClick={() => remove(menu.target)}>{t('删除')}</button>
        {menuError && <div role="alert">{menuError}</div>}
      </div>}
    </div>
  );
}
