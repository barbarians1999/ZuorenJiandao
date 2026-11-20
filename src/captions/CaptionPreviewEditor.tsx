import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineState, TrackId } from '../editor/types';
import type { CaptionsData } from './types';
import { captionSelectionKey, captionSelectionRef, type CaptionSelectionRef } from './captionSelection';
import { CAPTION_STYLES } from './styles';
import { captionPreviewTextColor, captionPreviewTextColorPatch, captionTextStyle, containerStyle } from './renderStyles';
import { buildCues, cueTextPatch } from './captionCues';
import { updateManualCue } from './manualCaptions';
import { planCaptionCueEdit } from './captionCueEditing';
import { captionCueKeyboardIntent } from './captionCueEditingKeyboard';
import {
  captionPreviewLayoutPatch,
  captionPreviewNudgePatch,
  captionPreviewStylePatch,
  captionPreviewTextPatch,
  findCaptionPreviewTarget,
  type CaptionPreviewNudgeDirection,
} from './captionPreviewTarget';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { captionTemplatePatch } from './captionTemplatePatch';
import { captionPreviewOutsideClickAction } from './captionPreviewToolbar';
import {
  captionRatioToScale,
  captionScaleToRatio,
  formatFontSizeScale,
} from '../editor/fontSizeScale';
import {
  computeTightCaptionFrameInsets,
  computeTightTextareaMetrics,
  type TightCaptionFrameInsets,
} from './captionPreviewBoxGeometry';

// Preview the caption direct editing layer on the canvas: click on the screen caption → check box + floating toolbar (AI Edit/Style/Font Size).
// Editor side overlay, no synthesis: geometry is recalculated by passing "display area px size" to containerStyle,
// The hit box is a transparent copy of the text in the same font (same layout as true rendering). Single stream text changes
// cueTextPatch, the manual lane is directly changed to correspond to the cue; the style/font size/color/position are all updated with updateCaptions, which can be revoked.
// Drag and drop: press and hold the caption to move → let go and submit the layout offset at once (one step undo); display the entity during dragging
// The ghost follows the hand, and the synthetic layer falls to the same position after letting go. All styles use cc-capedit-* classes (tokens, with skins).

interface CaptionPreviewEditorProps {
  trackId: TrackId;
  state: TimelineState;
  captions: CaptionsData;
  playerRef: RefObject<PlayerRef | null>;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
  onLivePreview?: (patch: Partial<CaptionsData> | null) => void;
  onActiveTargetChange?: (key: string | null) => void;
  onSelectCaption?: (selection: CaptionSelectionRef) => void;
  activeSelection?: CaptionSelectionRef | null;
  autoEditLaneId?: string;
  onAutoEditHandled?: () => void;
}

const clampFont = (v: number): number => Math.min(0.14, Math.max(0.02, v));
const clampWidthRatio = (v: number): number => Math.min(0.98, Math.max(0.2, v));
const DRAG_THRESHOLD = 4;
const ARROW_NUDGE_DIRECTION: Partial<Record<string, CaptionPreviewNudgeDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};
/** Text color quick color palette (white/black + common accent colors) */
const COLOR_SWATCHES = ['#ffffff', '#0a0a0a', '#FFD84A', '#FF5A5A', '#6EE7F9', '#7CFF9B', '#FF8FD1', '#FFA94D'];

interface DragRef {
  startX: number; startY: number;
  baseX: number; baseY: number;
  ySign: 1 | -1;
  moved: boolean;
}

export function CaptionPreviewEditor({ trackId, state, captions, playerRef, onUpdateCaptions, onLivePreview, onActiveTargetChange, onSelectCaption, activeSelection, autoEditLaneId, onAutoEditHandled }: CaptionPreviewEditorProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const [tightInsets, setTightInsets] = useState<TightCaptionFrameInsets | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [keyboardNotice, setKeyboardNotice] = useState('');
  const [pop, setPop] = useState<'styles' | 'color' | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const dragRef = useRef<DragRef | null>(null);
  const [widthDrag, setWidthDrag] = useState<number | null>(null);
  const widthDragRef = useRef<{ side: -1 | 1; startX: number; baseWidthRatio: number } | null>(null);

  // Display area size (the outer wrapper has been shaped according to the canvas ratio, inset-0 is the video area 1:1)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Follow the playhead (Player frameupdate)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    let raf = 0, pendingFrame = player.getCurrentFrame();
    const flush = () => { raf = 0; setFrame(pendingFrame); };
    const onPause = () => {
      if (raf) cancelAnimationFrame(raf);
      pendingFrame = player.getCurrentFrame();
      flush();
    };
    const onFrame = (e: { detail: { frame: number } }) => {
      pendingFrame = e.detail.frame;
      if (!player.isPlaying()) { if (raf) cancelAnimationFrame(raf); flush(); return; }
      // Player emits frameupdate from a React effect; defer playback UI updates outside that effect chain.
      if (!raf) raf = requestAnimationFrame(flush);
    };
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('pause', onPause);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('pause', onPause);
    };
  }, [playerRef]);

  // Always build flat cues when enabled so multi-lane auto tracks still get a
  // preview hitbox (manual lanes are preferred inside findCaptionPreviewTarget).
  const rows = useMemo(
    () => (captions.enabled ? buildCues(captions, state.items, state.fps) : []),
    [captions, state.items, state.fps],
  );
  const ms = (frame / state.fps) * 1000;
  const target = useMemo(
    () => findCaptionPreviewTarget(captions, state.items, state.fps, ms, rows),
    [captions, state.items, state.fps, ms, rows],
  );
  const cue = target?.cue;
  const targetSelectionKey = target ? captionSelectionKey(captionSelectionRef(trackId, target)) : null;
  const activeSelectionKey = captionSelectionKey(activeSelection ?? null);
  const controlledSelection = activeSelection !== undefined;

  useEffect(() => {
    if (!controlledSelection) return;
    const matches = activeSelectionKey !== null && activeSelectionKey === targetSelectionKey;
    setSelected(matches);
    if (!matches) {
      setEditing(false);
      setPop(null);
    }
  }, [activeSelectionKey, controlledSelection, targetSelectionKey]);

  // In other words, exit the selection; click on overlay to exit also
  useEffect(() => { setSelected(false); setEditing(false); setPop(null); setWidthDrag(null); widthDragRef.current = null; }, [target?.key]);
  useEffect(() => {
    if (!autoEditLaneId || target?.kind !== 'manual' || target.laneId !== autoEditLaneId || !cue) return;
    playerRef.current?.pause();
    setSelected(true);
    setEditing(true);
    setDraft(cue.text);
    onAutoEditHandled?.();
  }, [autoEditLaneId, cue, onAutoEditHandled, playerRef, target]);
  useEffect(() => {
    if (!selected) return;
    const onDown = (event: PointerEvent) => {
      const node = event.target instanceof Node ? event.target : null;
      const action = captionPreviewOutsideClickAction({
        editing,
        popoverOpen: pop !== null,
        insideEditor: Boolean(node && editorRef.current?.contains(node)),
        insideToolbar: Boolean(node && toolbarRef.current?.contains(node)),
        draftChanged: Boolean(target && draft !== target.cue.text),
      });
      if (action.commitDraft && target) {
        const patch = captionPreviewTextPatch(captions, target, draft);
        if (patch) onUpdateCaptions(patch);
      }
      if (action.closeEditor) {
        setEditing(false);
        onLivePreview?.(null);
      }
      if (action.closePopover) setPop(null);
      if (node && rootRef.current && !rootRef.current.contains(node)) {
        setSelected(false);
        setEditing(false);
        setPop(null);
        onLivePreview?.(null);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [captions, draft, editing, onLivePreview, onUpdateCaptions, pop, selected, target]);

  const hiddenKey = target && (selected || editing || drag !== null || widthDrag !== null) ? target.key : null;
  useEffect(() => {
    onActiveTargetChange?.(hiddenKey);
  }, [hiddenKey, onActiveTargetChange]);
  useEffect(() => () => {
    onActiveTargetChange?.(null);
    onLivePreview?.(null);
  }, [onActiveTargetChange, onLivePreview]);

  useLayoutEffect(() => {
    if (!selected || editing || drag !== null || !target || !cue || !box) {
      setTightInsets(null);
      return;
    }
    const hit = hitRef.current;
    if (!hit || typeof document === 'undefined' || typeof document.createRange !== 'function') {
      setTightInsets(null);
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(hit);
    const next = computeTightCaptionFrameInsets(hit.getBoundingClientRect(), Array.from(range.getClientRects()));
    setTightInsets((prev) => (prev?.left === next?.left && prev?.right === next?.right ? prev : next));
  }, [
    selected,
    editing,
    drag,
    widthDrag,
    box,
    target,
    cue,
  ]);

  if (!target || !cue || !box) {
    return <div ref={rootRef} data-caption-selection-owner="preview-caption" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
  }

  const preset = target.preset;
  const currentTextColor = captionPreviewTextColor(preset);
  const effectiveLayout = widthDrag !== null
    ? { ...target.layout, anchor: target.layout?.anchor ?? 'bottom-center', widthRatio: widthDrag }
    : target.layout;
  const block = containerStyle(preset, captions.template, box.w, box.h, effectiveLayout);
  const textCss = {
    ...captionTextStyle(preset, box.h, !preset.wholeLine, Boolean(preset.wholeLine)),
    whiteSpace: 'pre-wrap' as const,
  };

  const maxColumnWidthPx = box.w * clampWidthRatio(effectiveLayout?.widthRatio ?? 0.8);
  const textareaFont = `${textCss.fontStyle ?? 'normal'} ${textCss.fontWeight ?? 400} ${textCss.fontSize ?? 24}px ${textCss.fontFamily ?? 'system-ui, sans-serif'}`;
  const textareaMetrics = editing ? computeTightTextareaMetrics({
    text: draft,
    font: textareaFont,
    fontSize: Number(textCss.fontSize) || 24,
    letterSpacing: Number(textCss.letterSpacing) || 0,
    maxWidthPx: maxColumnWidthPx,
  }) : null;

  const saveText = (text: string) => {
    const editRows = target.kind === 'single' ? target.rows : rows;
    const rowIndex = target.kind === 'single' ? target.cueIndex
      : editRows.findIndex((row) => row.manual && row.laneId === target.laneId && row.manualIndex === target.cueIndex);
    const result = planCaptionCueEdit({ captions, items: state.items, fps: state.fps, rows: editRows, rowIndex,
      action: 'save', text, manualTiming: target.kind === 'manual' ? { startMs: target.cue.start, endMs: target.cue.end } : undefined });
    const patch = result.patch ?? captionPreviewTextPatch(captions, target, text);
    if (patch) onUpdateCaptions(patch);
    onLivePreview?.(null);
    setEditing(false);
    setKeyboardNotice('');
  };
  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.stopPropagation(); onLivePreview?.(null); setEditing(false); return; }
    const intent = captionCueKeyboardIntent({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode, selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd, textLength: event.currentTarget.value.length });
    if (intent === 'native') return;
    event.preventDefault();
    if (intent === 'save') { saveText(draft); return; }
    if (intent === 'selection') { setKeyboardNotice(t('请先取消文字选区，再将光标放在拆分位置。')); return; }
    const editRows = target.kind === 'single' ? target.rows : rows;
    const rowIndex = target.kind === 'single' ? target.cueIndex
      : editRows.findIndex((row) => row.manual && row.laneId === target.laneId && row.manualIndex === target.cueIndex);
    const request = { captions, items: state.items, fps: state.fps, rows: editRows, rowIndex,
      action: intent, text: draft, caret: event.currentTarget.selectionStart ?? 0,
      manualTiming: target.kind === 'manual' ? { startMs: target.cue.start, endMs: target.cue.end } : undefined };
    const result = planCaptionCueEdit({ ...request, acceptMergeConflict: true });
    if (!result.patch) { setKeyboardNotice(result.reason ?? t('无法编辑这句字幕。')); return; }
    onUpdateCaptions(result.patch); onLivePreview?.(null); setEditing(false); setKeyboardNotice('');
  };
  const bumpFont = (dir: 1 | -1) => {
    const next = clampFont(captionScaleToRatio(captionRatioToScale(preset.fontSize) + dir));
    onUpdateCaptions(captionPreviewStylePatch(captions, target, { fontSize: next }));
  };
  const setColor = (hex: string) => {
    onUpdateCaptions(captionPreviewStylePatch(captions, target, captionPreviewTextColorPatch(preset, hex)));
  };
  // ── Drag and move (bottom anchor offsetYRatio positive upward, containerStyle takes the negative sign) ──
  const anchorV = (() => {
    const a = target.layout?.anchor ?? 'bottom-center';
    return a.startsWith('top') ? 'top' : (a.startsWith('middle') || a === 'center') ? 'middle' : 'bottom';
  })();
  const onHitPointerDown = (e: React.PointerEvent) => {
    if (editing) return;
    e.stopPropagation();
    e.preventDefault();
    // Freeze and select on press. A human click can span multiple playback
    // frames; waiting for pointerup allowed the active cue to change first.
    setSelected(true);
    onSelectCaption?.(captionSelectionRef(trackId, target));
    playerRef.current?.pause();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: target.layout?.offsetXRatio ?? 0,
      baseY: target.layout?.offsetYRatio ?? 0,
      ySign: anchorV === 'bottom' ? -1 : 1,
      moved: false,
    };
  };
  const onHitPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      d.moved = true;
      playerRef.current?.pause();
    }
    if (d.moved) setDrag({ dx, dy });
  };
  const onHitPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved && box) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      onUpdateCaptions(captionPreviewLayoutPatch(captions, target, {
          ...target.layout,
          anchor: target.layout?.anchor ?? 'bottom-center',
          offsetXRatio: d.baseX + dx / box.w,
          offsetYRatio: d.baseY + d.ySign * (dy / box.h),
      }));
      setSelected(true);
    } else {
      // Drag threshold not reached = click to select
      setSelected(true);
      playerRef.current?.pause();
    }
    setDrag(null);
  };
  const onHitKeyDown = (e: React.KeyboardEvent) => {
    if (!selected || editing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const direction = ARROW_NUDGE_DIRECTION[e.key];
    if (!direction) return;
    e.preventDefault();
    e.stopPropagation();
    playerRef.current?.pause();
    onUpdateCaptions(captionPreviewNudgePatch(captions, target, direction));
  };

  const curColor = currentTextColor;
  const startWidthResize = (side: -1 | 1, e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box) return;
    e.stopPropagation();
    e.preventDefault();
    playerRef.current?.pause();
    setPop(null);
    e.currentTarget.setPointerCapture(e.pointerId);
    const baseWidthRatio = target.layout?.widthRatio ?? captions.layout?.widthRatio ?? 0.8;
    widthDragRef.current = { side, startX: e.clientX, baseWidthRatio };
    setWidthDrag(baseWidthRatio);
  };
  const moveWidthResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const wd = widthDragRef.current;
    if (!wd || !box) return;
    e.stopPropagation();
    const next = clampWidthRatio(wd.baseWidthRatio + ((e.clientX - wd.startX) * wd.side * 2) / Math.max(120, box.w));
    setWidthDrag(next);
    if (target) {
      onLivePreview?.(captionPreviewLayoutPatch(captions, target, {
        ...target.layout,
        anchor: target.layout?.anchor ?? 'bottom-center',
        widthRatio: Math.round(next * 1000) / 1000,
      }));
    }
  };
  const finishWidthResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const wd = widthDragRef.current;
    widthDragRef.current = null;
    if (!wd || !box) { setWidthDrag(null); return; }
    e.stopPropagation();
    const next = clampWidthRatio(wd.baseWidthRatio + ((e.clientX - wd.startX) * wd.side * 2) / Math.max(120, box.w));
    setWidthDrag(null);
    onLivePreview?.(null);
    onUpdateCaptions(captionPreviewLayoutPatch(captions, target, {
      ...target.layout,
      anchor: target.layout?.anchor ?? 'bottom-center',
      widthRatio: Math.round(next * 1000) / 1000,
    }));
    setSelected(true);
  };
  const cancelWidthResize = () => {
    widthDragRef.current = null;
    setWidthDrag(null);
    onLivePreview?.(null);
  };

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: selected || editing || drag !== null || widthDrag !== null ? 6 : 4, pointerEvents: 'none', overflow: 'visible' }}>
      <div style={{ ...block, pointerEvents: 'none' }}>
        <div style={{ position: 'relative', pointerEvents: 'auto', width: 'fit-content', maxWidth: '100%', transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined }}>
          {editing ? (
            <>
              <textarea
                ref={editorRef}
                value={draft}
                autoFocus
                rows={textareaMetrics?.rows ?? Math.max(1, draft.split('\n').length)}
                onChange={(e) => {
                  const nextText = e.target.value;
                  setDraft(nextText);
                  if (onLivePreview && target) {
                    const patch = target.kind === 'single'
                      ? cueTextPatch(captions, target.rows, target.cueIndex, nextText)
                      : updateManualCue(captions, target.laneId, target.cueIndex, nextText || ' ', target.cue.start, target.cue.end);
                    onLivePreview(patch);
                  }
                }}
                onKeyDown={onEditorKeyDown}
                style={{
                  ...textCss, background: 'transparent', color: currentTextColor,
                  width: textareaMetrics ? `${textareaMetrics.widthPx}px` : '100%', maxWidth: '100%', padding: 0, margin: 0, textAlign: textCss.textAlign ?? 'center',
                  border: '1.5px dashed var(--cc-accent)', borderRadius: 4, boxSizing: 'border-box',
                  outline: 'none', resize: 'none', overflow: 'hidden',
                }}
              />
              {keyboardNotice && <div role="status" className="cc-cap-hint">{keyboardNotice}</div>}
            </>
          ) : (
            // Hitbox: A copy of the same layout text. Normally transparent (the real captions are on the composite layer), they will appear during dragging when the ghost follows your hand.
            <div
              ref={hitRef}
              className="cc-capedit-hit"
              role="button"
              tabIndex={0}
              title={t('点击选中字幕；拖动移动位置；左右边框拖动调宽；双击直接改文字')}
              onPointerDown={onHitPointerDown}
              onPointerMove={onHitPointerMove}
              onPointerUp={onHitPointerUp}
              onKeyDown={onHitKeyDown}
              onDoubleClick={() => { setSelected(true); setPop(null); setEditing(true); setDraft(cue.text); playerRef.current?.pause(); }}
              style={drag || selected || widthDrag !== null
                // Selected / dragging: paint full styles so color, stroke and scale stay visible
                // on the canvas (the Remotion layer underneath may sit slightly offset).
                ? { ...textCss, width: 'fit-content', maxWidth: '100%', opacity: drag ? 0.92 : 1, cursor: drag ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }
                : { ...textCss, width: 'fit-content', maxWidth: '100%', color: 'transparent', WebkitTextStroke: '0px transparent', textShadow: 'none', background: 'transparent', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
            >
              {cue.text}
            </div>
          )}
          {selected && !editing && !drag && (
            <div className="cc-capedit-frame" aria-hidden style={tightInsets ? { left: tightInsets.left, right: tightInsets.right } : undefined}>
              <div
                className="cc-capedit-edge left"
                title={t('左右拖动调整文字框宽度')}
                onPointerDown={(e) => startWidthResize(-1, e)}
                onPointerMove={moveWidthResize}
                onPointerUp={finishWidthResize}
                onPointerCancel={cancelWidthResize}
                onLostPointerCapture={cancelWidthResize}
              />
              <div
                className="cc-capedit-edge right"
                title={t('左右拖动调整文字框宽度')}
                onPointerDown={(e) => startWidthResize(1, e)}
                onPointerMove={moveWidthResize}
                onPointerUp={finishWidthResize}
                onPointerCancel={cancelWidthResize}
                onLostPointerCapture={cancelWidthResize}
              />
            </div>
          )}

          {/* Floating toolbar (AI editing | text/style/color | font size | delete)*/}
          {selected && !drag && widthDrag === null && (
            <div ref={toolbarRef} className="cc-capedit-bar" onPointerDown={(e) => e.stopPropagation()}>
              <button type="button" className="cc-capedit-btn" title={t('编辑文字')} onClick={() => {
                setPop(null);
                if (!editing) {
                  setEditing(true);
                  setDraft(cue.text);
                }
              }}>
                <Icon name="pencil" size={12} />{t('文字')}
              </button>
              <button type="button" className={`cc-capedit-btn${pop === 'styles' ? ' on' : ''}`} title={t('字幕样式')} onClick={() => setPop(pop === 'styles' ? null : 'styles')}>Aa</button>
              <button type="button" className={`cc-capedit-btn${pop === 'color' ? ' on' : ''}`} title={t('文字颜色')} onClick={() => setPop(pop === 'color' ? null : 'color')}>
                <span className="cc-capedit-colordot" style={{ background: curColor }} />
              </button>
              <span className="cc-capedit-divider" aria-hidden />
              <button type="button" className="cc-capedit-btn" title={`${t('缩小字号')} (${formatFontSizeScale(captionRatioToScale(preset.fontSize))})`} onClick={() => bumpFont(-1)}>A−</button>
              <span className="cc-capedit-size-pill" title={t('当前字号')}>{formatFontSizeScale(captionRatioToScale(preset.fontSize))}</span>
              <button type="button" className="cc-capedit-btn" title={`${t('放大字号')} (${formatFontSizeScale(captionRatioToScale(preset.fontSize))})`} onClick={() => bumpFont(1)}>A+</button>
              <span className="cc-capedit-divider" aria-hidden />
              <button type="button" className="cc-capedit-btn danger" title={t('删除这句')} onClick={() => saveText('')}>
                <Icon name="trash" size={12} />
              </button>

              {pop === 'styles' && (
                <div className="cc-capedit-pop styles">
                  {CAPTION_STYLES.map((st) => (
                    <button key={st.id} type="button"
                      className={`cc-capedit-styleitem${st.id === captions.template ? ' on' : ''}`}
                      onClick={() => { onUpdateCaptions(captionTemplatePatch(captions, st.id)); setPop(null); }}>
                      {t(st.labelZh)}
                    </button>
                  ))}
                </div>
              )}
              {pop === 'color' && (
                <div className="cc-capedit-pop color">
                  {COLOR_SWATCHES.map((hex) => (
                    <button key={hex} type="button"
                      className={`cc-capedit-swatch${curColor.toLowerCase() === hex.toLowerCase() ? ' on' : ''}`}
                      style={{ background: hex }}
                      title={hex}
                      onClick={() => { setColor(hex); setPop(null); }} />
                  ))}
                  <label className="cc-capedit-custom" title={t('自定义颜色')}>
                    <input
                      type="color"
                      defaultValue={/^#[0-9a-fA-F]{6}$/.test(curColor) ? curColor : '#ffffff'}
                      onBlur={(e) => { setColor(e.target.value); setPop(null); }}
                    />
                    <span>{t('自定义')}</span>
                  </label>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
