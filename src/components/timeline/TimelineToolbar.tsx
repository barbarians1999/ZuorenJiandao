// Toolbar at the top of the timeline (translated verbatim from Timeline.tsx): Editing mode cluster / Drop track mode / Narration recording /
// Play + time code / zoom cluster / aspect ratio / caption display / full screen. The timecode span is drawn by the playhead painter
// timecodeRef direct writing (rAF frame), here only the initial value is rendered.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { theme } from '../../theme';
import { Icon, type IconName } from '../icons';
import { ASPECT_PRESETS, captionTrackEntries, type TimelineState } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { useFocusReturn } from '../../hooks/useFocusReturn';
import { invokeAction } from '../../shortcuts/actionRegistry';
import { MIN_TIME_ZOOM, fmt, type EditMode } from './timelineUtil';
import { TimelineSpeedControl } from './TimelineSpeedControl';
import { SceneDetectionDialog } from '../../scene-detection/SceneDetectionDialog';
import { MotionTrackingDialog } from '../../tracking/MotionTrackingDialog';
import { TrackCreateControl } from './TrackCreateControl';
import { canSplitSelectedTimelineItem } from '../../editor/splitEligibility';
import { mainTrackId } from '../../editor/magneticTimeline';
import { sceneDetectionUnavailable } from '../../scene-detection/apply';
import { showAppToast } from '../../ui/appToast';

// Group spacing between toolbar clusters uses gaps without a visible divider.
function ToolSep() {
  return <span className="cc-timeline-tool-separator" aria-hidden="true" />;
}

// One icon toolbar button: monochrome line glyphs, active = accent.
// Prompt to use cc-tip real-time tooltip (native title has ~1s inherent delay); tipRight = right-aligned near the right edge
function TB({ icon, title, label, onClick, active, disabled, tipRight, className, iconSize = 18 }: {
  icon: IconName; title: string; label?: string; onClick?: () => void; active?: boolean; disabled?: boolean; tipRight?: boolean;
  className?: string; iconSize?: number;
}) {
  return (
    <button className={`cc-timeline-tool-button cc-tip${tipRight ? ' cc-tip-r' : ''}${className ? ` ${className}` : ''}`} data-tip={title} aria-label={title} onClick={onClick} disabled={disabled}
      aria-pressed={active}
      style={{ minWidth: 34, height: 34, flexShrink: 0, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: label ? '0 8px' : 4, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 14, whiteSpace: 'nowrap', color: disabled ? theme.textDim : active ? theme.accent : theme.textMuted, opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={iconSize} />{label && <span>{label}</span>}
    </button>
  );
}
function closeTimelineMenu(details: HTMLDetailsElement | null, restoreFocus = false) {
  if (!details) return;
  details.open = false;
  if (restoreFocus) queueMicrotask(() => details.querySelector<HTMLElement>('summary')?.focus());
}

function runMenuAction(
  event: MouseEvent<HTMLButtonElement>,
  action: () => void,
  restoreFocus = true,
) {
  action();
  closeTimelineMenu(event.currentTarget.closest('details'), restoreFocus);
}

function TimelineMoreControl(props: {
  trackingEnabled: boolean;
  onTracking: (restoreFocus: () => void) => void;
  state: TimelineState;
  onLinkageKinds: (linkedKinds: LinkedKind[]) => void;
}) {
  const t = useT();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const restoreFocus = () => detailsRef.current?.querySelector<HTMLElement>('summary')?.focus();
  return (
    <details
      ref={detailsRef}
      onToggle={(event) => {
        const details = event.currentTarget;
        if (details.open) requestAnimationFrame(() => details.querySelector<HTMLElement>('button:not(:disabled), input')?.focus());
      }}
      className="cc-track-create cc-timeline-more"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        closeTimelineMenu(detailsRef.current, true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeTimelineMenu(event.currentTarget);
      }}
    >
      <summary aria-label={t('更多操作')} title={t('更多操作')}><Icon name="more" size={16} /></summary>
      <div className="cc-track-create-menu cc-timeline-more-menu" role="group" aria-label={t('更多操作')}>
        <button disabled={!props.trackingEnabled} title={!props.trackingEnabled ? t('请先选择已导入媒体池的视频片段') : undefined} onClick={(event) => runMenuAction(event, () => props.onTracking(restoreFocus), false)}>
          <Icon name="tracking" size={15} />{t('运动跟踪')}
        </button>
        <div className="cc-track-create-separator" />
        <strong className="cc-timeline-more-heading">{t('联动范围')}</strong>
        {LINKED_KINDS.map(({ kind, label }) => {
          const kinds: readonly LinkedKind[] = props.state.interaction?.linkedKinds ?? ['text', 'video', 'image', 'other'];
          return <label key={kind} className="cc-timeline-linkage-option">
            <input type="checkbox" checked={kinds.includes(kind)} onChange={(event) => props.onLinkageKinds(
              event.currentTarget.checked ? [...kinds, kind] : kinds.filter((entry) => entry !== kind),
            )} />{t(label)}
          </label>;
        })}
        <p className="cc-timeline-more-note">{t('只影响已绑定到主片段的素材；开关不会自动绑定现有素材。')}</p>
      </div>
    </details>
  );
}

const LINKED_KINDS = [
  { kind: 'text', label: '文字' },
  { kind: 'video', label: '叠层视频' },
  { kind: 'image', label: '图片' },
  { kind: 'other', label: '子草稿和其他画面' },
  { kind: 'audio', label: '音频（配乐默认不跟随）' },
] as const;
type LinkedKind = typeof LINKED_KINDS[number]['kind'];

/** Directional following is different from symmetric clip grouping. Settings
 * affect the next edit only; turning the switch on never moves existing clips. */
function TimelineLinkageControl({ state, onChange }: {
  state: TimelineState;
  onChange: (patch: Partial<NonNullable<TimelineState['interaction']>>) => void;
}) {
  const t = useT();
  const enabled = state.interaction?.linkage === true;
  return <span style={{ display: 'inline-flex', alignItems: 'center' }}>
    <TB icon="paperclip" label={t('联动')}
      title={enabled ? t('联动：开；已绑定的文字和画面随主片段移动，单独移动它们不会带动主片段') : t('联动：关；移动主片段时不带动已绑定素材')}
      active={enabled} onClick={() => onChange({ linkage: !enabled })} />
  </span>;
}

interface TimelineToolbarProps {
  state: TimelineState;
  commands: EditorCommands;
  editMode: EditMode;
  placeMode: 'insert' | 'overwrite';
  setPlaceMode: (m: 'insert' | 'overwrite') => void;
  snapping: boolean;
  hoverPreviewEnabled: boolean;
  setHoverPreviewEnabled: (enabled: boolean) => void;
  recorder: { recording: boolean; error: string | null; toggle: () => void };
  canRecord: boolean;
  playing: boolean;
  /** painted imperatively by the playhead painter */
  timecodeRef: RefObject<HTMLSpanElement | null>;
  playheadRef: RefObject<number>;
  playheadFrame: number;
  total: number;
  captionsVisible: boolean;
  zoom: number;
  zoomMin?: number;
  setZoom: (z: number) => void;
  onPreviewCut?: (frame: number) => void;
  headerLeading?: ReactNode;
}

export function TimelineToolbar({
  state, commands, editMode, placeMode, setPlaceMode, snapping, hoverPreviewEnabled, setHoverPreviewEnabled,
  recorder, canRecord, playing: _playing, timecodeRef, playheadRef, playheadFrame, total, captionsVisible,
  zoom, zoomMin = MIN_TIME_ZOOM, setZoom, onPreviewCut, headerLeading,
}: TimelineToolbarProps) {
  const t = useT();
  const magnet = state.interaction?.magnet === true;
  const mainTrack = mainTrackId(state);
  const updateInteraction = (patch: Partial<NonNullable<TimelineState['interaction']>>) => {
    commands.applyState({
      ...state,
      interaction: { ...state.interaction, ...(mainTrack ? { mainTrackId: mainTrack } : {}), ...patch },
    });
  };
  const modKey = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const [canSplitSelected, setCanSplitSelected] = useState(() => (
    canSplitSelectedTimelineItem(state, playheadRef.current)
  ));
  useEffect(() => {
    const update = () => {
      const next = canSplitSelectedTimelineItem(state, playheadRef.current);
      setCanSplitSelected((current) => current === next ? current : next);
    };
    update();
    if (!state.selectedId) return undefined;
    const timer = window.setInterval(update, 80);
    return () => window.clearInterval(timer);
  }, [playheadRef, state]);
  const speedItem = state.items.find((item) => (
    item.id === state.selectedId && (item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence')
  )) ?? null;
  const sceneItem = state.items.find((item) => (
    item.id === state.selectedId && item.kind === 'video'
  )) ?? null;
  const sceneUnavailable = sceneDetectionUnavailable(state, sceneItem);
  const trackingItem = state.items.find((item) => (
    item.id === state.selectedId
    && item.kind === 'video'
    && /^\/media\/uploads\//.test(item.src ?? '')
  )) ?? null;
  const [sceneDetectionTargetId, setSceneDetectionTargetId] = useState<string | null>(null);
  const sceneDetectionTarget = state.items.find((item) => item.id === sceneDetectionTargetId) ?? null;
  const [motionTrackingOpen, setMotionTrackingOpen] = useState(false);
  const modalFocus = useFocusReturn();
  const captionTracks = captionTrackEntries(state).filter((entry) => entry.captions);
  const modeLabel = editMode === 'selection' ? t('选择') : editMode === 'trim' ? t('修剪') : editMode === 'slip' ? t('滑移') : editMode === 'rate-stretch' ? t('比率拉伸') : editMode === 'blade' ? t('刀片') : t('钢笔');
  // On-screen text clips count as captions for the toggle (render-layer hidden with them).
  const textClipCount = state.items.filter((item) => item.kind === 'text' || item.kind === 'motion-graphic').length;
  const hasCaptions = captionTracks.length > 0 || textClipCount > 0;
  return (
    <>
      <div className="cc-timeline-toolbar">
      <div className="cc-timeline-header-bar">
      {headerLeading}
      <div className="cc-timeline-control-row">
      <span ref={timecodeRef} className="cc-timeline-timecode">{fmt(playheadFrame, state.fps)} / {fmt(total, state.fps)}</span>
      <div className="cc-timeline-view-controls">
      <TB icon="zoomOut" title={t('缩小时间轴 (⌘−)').replace('⌘', modKey)} tipRight onClick={() => invokeAction('zoom-out', undefined, 'toolbar')} />
      <input type="range" min={zoomMin} max={6} step="any" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
        title={t('缩放时间轴')} aria-label={t('缩放时间轴')} aria-valuetext={`${Number((zoom * 100).toFixed(2))}%`} className="cc-timeline-zoom" />
      <TB icon="zoomIn" title={t('放大时间轴 (⌘＋)').replace('⌘', modKey)} tipRight onClick={() => invokeAction('zoom-in', undefined, 'toolbar')} />
      <TB icon="fit" title={t('适配视图 (⇧Z)')} tipRight onClick={() => invokeAction('zoom-fit', undefined, 'toolbar')} />
      <label className="cc-aspect-select cc-tip cc-tip-r" data-tip={t('画幅比例')}>
        <Icon name="aspect" size={16} />
        <select aria-label={t('画幅比例')} value={ASPECT_PRESETS.find((preset) => preset.width === state.width && preset.height === state.height)?.label ?? ''}
          onChange={(event) => {
            if (event.target.value === '__contain__' || event.target.value === '__cover__') {
              commands.setAspect(state.width, state.height, event.target.value === '__cover__' ? 'cover' : 'contain');
              return;
            }
            const preset = ASPECT_PRESETS.find((entry) => entry.label === event.target.value);
            if (preset) commands.setAspect(preset.width, preset.height, state.fit);
          }}>
          <optgroup label={t('画幅比例')}>{ASPECT_PRESETS.map((preset) => <option key={preset.label} value={preset.label}>{preset.label}</option>)}</optgroup>
          <optgroup label={t('内容适配')}><option value="__contain__">{t('留边')}</option><option value="__cover__">{t('裁切')}</option></optgroup>
        </select>
      </label>
      <span className="cc-aspect-fit-label" role="status" aria-label={t('内容适配：{mode}', { mode: state.fit === 'cover' ? t('裁切') : t('留边') })}>
        {state.fit === 'cover' ? t('裁切') : t('留边')}
      </span>
      <button className={`cc-caption-toggle cc-tip cc-tip-r${captionsVisible ? ' active' : ''}`} data-tip={hasCaptions
        ? captionTracks.length
          ? t('字幕显示')
          : t('字幕显示（画面有 {n} 个文字素材，无字幕轨数据；关闭会一并隐藏）', { n: textClipCount })
        : t('字幕显示（暂无字幕或文字素材，先转写或让 Agent 生成）')} aria-label={t('字幕显示')} aria-pressed={captionsVisible} disabled={!hasCaptions} onClick={() => commands.setCaptionsHidden(captionsVisible)}><Icon name="captions" size={17} /><span>{captionsVisible ? t('字幕 开') : t('字幕 关')}</span></button>
      <TB icon="fullscreen" title={t('全屏预览')} tipRight onClick={() => invokeAction('fullscreen', undefined, 'toolbar')} />
      </div>
      </div>
      </div>
      <div className="cc-timeline-tool-group">
        <span className={`cc-timeline-mode-label is-${editMode}`} role="status" aria-label={t('当前编辑模式：{mode}', { mode: modeLabel })}>
          {t('模式：{mode}', { mode: modeLabel })}
        </span>
        <TB icon="cursor" label={t('选择')} title={t('选择模式 (A)：拖动移动 / 裁剪首尾')} active={editMode === 'selection'} onClick={() => invokeAction('interaction-mode-selection', undefined, 'toolbar')} />
        <details className="cc-track-create cc-edit-mode-menu" onKeyDown={(event) => { if (event.key === 'Escape') closeTimelineMenu(event.currentTarget, true); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeTimelineMenu(event.currentTarget); }}>
        <summary>{t('编辑工具')}</summary><div className="cc-track-create-menu" onClick={(event) => { if ((event.target as HTMLElement).closest('button')) closeTimelineMenu(event.currentTarget.closest('details'), true); }}>
        <TB icon="trim" label={t('波纹修剪')} title={t('修剪模式 (N)：裁剪片段边缘，后续片段自动跟随合缝（波纹）')} active={editMode === 'trim'} onClick={() => invokeAction('interaction-mode-trim', undefined, 'toolbar')} />
        <TB
          icon="swap"
          label={t('调整素材起点')}
          title={t('滑移模式 (U)：保持时间线位置和时长，仅拖动源素材区间')}
          active={editMode === 'slip'}
          onClick={() => invokeAction('interaction-mode-slip', undefined, 'toolbar')}
        />
        <TB
          icon="rateStretch"
          label={t('拖拽变速')}
          title={editMode === 'rate-stretch'
            ? t('退出比率拉伸，返回选择模式')
            : t('比率拉伸：拖动片段首尾，保持源区间并改变播放速度')}
          active={editMode === 'rate-stretch'}
          onClick={() => invokeAction(
            editMode === 'rate-stretch' ? 'interaction-mode-selection' : 'interaction-mode-rate-stretch',
            undefined,
            'toolbar',
          )}
        />
        <TB icon="blade" label={t('刀片工具')} title={t('刀片模式 (B)：点击片段在该处切分')} active={editMode === 'blade'} onClick={() => invokeAction('interaction-mode-blade', undefined, 'toolbar')} />
        <TB icon="pencil" label={t('关键帧工具')} title={t('钢笔模式 (P)：在选中片段上点击绘制关键帧（视觉片段=透明度，音频片段=音量；纵向=值，拖点改帧/值，右键删点）')} active={editMode === 'pen'} onClick={() => invokeAction('interaction-mode-pen', undefined, 'toolbar')} />
        </div></details>
        <TrackCreateControl commands={commands} />
        <TB icon="sort" label={t('整理轨道')} title={t('将同类轨道上下空隙向上合并整理，并清理变空的冗余轨道')} onClick={() => {
          const res = commands.compactTracks();
          showAppToast(res.movedItemCount > 0 || res.removedTrackIds.length > 0
            ? t('已整理轨道：合并移动 {moved} 个片段，清理 {removed} 条空轨道', { moved: res.movedItemCount, removed: res.removedTrackIds.length })
            : t('当前同类轨道已紧凑排列，无需整理'));
        }} />
        <TB icon="scissors" label={t('分割')} title={t('在播放头切分选中片段 (Ctrl+B)')} disabled={!canSplitSelected} onClick={() => invokeAction('split', undefined, 'toolbar')} />
        <TB icon="sparkles" label={t('智能分割镜头')} title={sceneUnavailable ? t(sceneUnavailable) : t('检测当前视频片段的镜头变化，选择切点后一键分割')}
          disabled={!!sceneUnavailable} onClick={() => {
            const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            modalFocus.remember(() => restore?.focus());
            setSceneDetectionTargetId(sceneItem!.id);
          }} />
        <TB icon="trash" label={t('删除')} title={t('删除选中片段 (Delete)')} disabled={!state.selectedId} onClick={() => invokeAction('delete', undefined, 'toolbar')} />
        <TB icon="trim" label={t('删除并合缝')} title={t('删除选中片段并前移同轨后续片段 (Shift+Delete)')} disabled={!state.selectedId} onClick={() => invokeAction('ripple-delete', undefined, 'toolbar')} />
        <TB icon="film" label={t('子草稿')} title={t('把选中片段合为可继续编辑的子草稿 (Alt+G)')} disabled={!state.selectedId} onClick={() => invokeAction('create-subdraft', undefined, 'toolbar')} />
        <TB icon="magnet" label={t('主轨磁吸')} title={magnet ? t('主轨磁吸：开；主轨换序、删除或修剪后自动合缝') : t('主轨磁吸：关；保留主轨空隙；开启本身不改变现有排列')}
          active={magnet} onClick={() => updateInteraction({ magnet: !magnet })} />
        <TimelineLinkageControl state={state} onChange={updateInteraction} />
        <TB icon="tracking" label={t('自动吸附')} title={snapping ? t('自动吸附：开 (S)；拖动时对齐片段边缘和播放头') : t('自动吸附：关 (S)；自由拖动，不对齐参考线')} active={snapping} onClick={() => invokeAction('snapping', undefined, 'toolbar')} />
        <TB icon={hoverPreviewEnabled ? 'eye' : 'eyeOff'} label={t('预览轴')}
          title={hoverPreviewEnabled ? t('预览轴：开；鼠标经过时间线时预览，不移动播放头') : t('预览轴：关；点击时间线才跳转预览')}
          active={hoverPreviewEnabled} onClick={() => setHoverPreviewEnabled(!hoverPreviewEnabled)} />
        <button type="button" className="cc-placement-toggle" title={t('拖入素材的处理方式；覆盖会替换重叠内容')} onClick={() => setPlaceMode(placeMode === 'insert' ? 'overwrite' : 'insert')}>{placeMode === 'insert' ? t('插入素材') : t('覆盖素材')}</button>
        <ToolSep />
        <TimelineMoreControl
          trackingEnabled={!!trackingItem}
          state={state}
          onTracking={(restoreFocus) => { modalFocus.remember(restoreFocus); setMotionTrackingOpen(true); }}
          onLinkageKinds={(linkedKinds) => updateInteraction({ linkedKinds })}
        />
        <ToolSep />
        <span className="cc-mic-group">
          <TB icon="mic" active={recorder.recording}
            title={recorder.recording ? t('● 录音中，点击停止') : recorder.error ? t('录音失败：{error}', { error: recorder.error }) : t('录制旁白（麦克风 → 音频轨）')}
            disabled={!canRecord} onClick={recorder.toggle} />
          <Icon name="chevronDown" size={13} />
        </span>
        {recorder.recording && <span title={t('录音中')} style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />}
        <TimelineSpeedControl
          item={speedItem}
          onChange={(rate) => { if (speedItem) commands.setItemSpeed(speedItem.id, rate); }}
        />
      </div>
      </div>
      {sceneDetectionTarget && (
        <SceneDetectionDialog
          key={`${(state as TimelineState & { id?: string }).id ?? ''}:${sceneDetectionTarget.id}`}
          state={state}
          commands={commands}
          item={sceneDetectionTarget}
          onPreviewCut={onPreviewCut}
          onClose={() => { setSceneDetectionTargetId(null); modalFocus.restore(); }}
        />
      )}
      {motionTrackingOpen && trackingItem && (
        <MotionTrackingDialog
          state={state}
          commands={commands}
          item={trackingItem}
          onClose={() => { setMotionTrackingOpen(false); modalFocus.restore(); }}
        />
      )}
    </>
  );
}
