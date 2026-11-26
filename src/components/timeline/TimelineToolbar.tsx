// Toolbar at the top of the timeline (translated verbatim from Timeline.tsx): Editing mode cluster / Drop track mode / Narration recording /
// Play + time code / zoom cluster / aspect ratio / caption display / full screen. The timecode span is drawn by the playhead painter
// timecodeRef direct writing (rAF frame), here only the initial value is rendered.
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../../theme';
import { Icon, type IconName } from '../icons';
import { ASPECT_PRESETS, captionTrackEntries, type TimelineState } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { useFocusReturn } from '../../hooks/useFocusReturn';
import { invokeAction } from '../../shortcuts/actionRegistry';
import { useShortcutHint } from '../../shortcuts/useShortcutHint';
import { MIN_TIME_ZOOM, fmt, type EditMode } from './timelineUtil';
import { TimelineSpeedControl } from './TimelineSpeedControl';
import { SceneDetectionDialog } from '../../scene-detection/SceneDetectionDialog';
import { MotionTrackingDialog } from '../../tracking/MotionTrackingDialog';
import { TrackCreateControl } from './TrackCreateControl';
import { canSplitSelectedTimelineItem } from '../../editor/splitEligibility';
import { mainTrackId } from '../../editor/magneticTimeline';
import { sceneDetectionUnavailable } from '../../scene-detection/apply';
import { planFillToNextTrackClip, planSpeedForTargetSeconds } from '../../editor/speedDuration';
import { showAppToast } from '../../ui/appToast';

function ToolSep() {
  return <span className="cc-timeline-tool-separator" role="separator" aria-orientation="vertical" />;
}

function TB({ icon, title, label, onClick, active, disabled, tipRight, className, iconSize = 18 }: {
  icon: IconName; title: string; label?: string; onClick?: () => void; active?: boolean; disabled?: boolean; tipRight?: boolean;
  className?: string; iconSize?: number;
}) {
  return (
    <button type="button" className={`cc-timeline-tool-button cc-tip${tipRight ? ' cc-tip-r' : ''}${className ? ` ${className}` : ''}`} data-tip={title} aria-label={title} onClick={onClick} disabled={disabled}
      aria-pressed={active}
      style={{ minWidth: 34, height: 34, flexShrink: 0, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: label ? '0 8px' : 4, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 14, whiteSpace: 'nowrap', color: disabled ? theme.textDim : active ? theme.accent : theme.textMuted, opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={iconSize} />{label && <span>{label}</span>}
    </button>
  );
}

function hidePopover(el: HTMLElement | null) {
  try {
    (el as (HTMLElement & { hidePopover?: () => void }) | null)?.hidePopover?.();
  } catch { /* ignore when closed or unsupported */ }
}

const EDIT_MODE_OPTIONS: ReadonlyArray<{
  mode: EditMode;
  icon: IconName;
  label: string;
  title: string;
  action: 'interaction-mode-selection' | 'interaction-mode-trim' | 'interaction-mode-slip' | 'interaction-mode-rate-stretch' | 'interaction-mode-blade' | 'interaction-mode-pen';
}> = [
  { mode: 'selection', icon: 'cursor', label: '选择', title: '选择模式：移动与裁剪首尾', action: 'interaction-mode-selection' },
  { mode: 'trim', icon: 'trim', label: '波纹修剪', title: '波纹修剪：裁剪并自动合缝', action: 'interaction-mode-trim' },
  { mode: 'slip', icon: 'swap', label: '滑移起点', title: '滑移模式：调整源素材区间', action: 'interaction-mode-slip' },
  { mode: 'rate-stretch', icon: 'rateStretch', label: '拖拽变速', title: '拖拽变速：拉伸改变播放速度', action: 'interaction-mode-rate-stretch' },
  { mode: 'blade', icon: 'blade', label: '刀片', title: '刀片模式：点击处切分片段', action: 'interaction-mode-blade' },
  { mode: 'pen', icon: 'pencil', label: '关键帧', title: '钢笔模式：绘制透明度或音量关键帧', action: 'interaction-mode-pen' },
];

function EditModeControl({ editMode, actionTitle }: { editMode: EditMode; actionTitle: (title: string, id: string) => string }) {
  const t = useT();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const current = EDIT_MODE_OPTIONS.find((item) => item.mode === editMode) ?? EDIT_MODE_OPTIONS[0]!;
  return (
    <div className="cc-popover-anchor">
      <button
        type="button"
        className={`cc-timeline-tool-button cc-mode-picker-trigger is-${editMode}`}
        popoverTarget={menuId}
        aria-label={t('编辑模式：{mode}', { mode: t(current.label) })}
        title={t('切换编辑模式')}
      >
        <Icon name={current.icon} size={15} />
        <span>{t(current.label)}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        className="cc-track-create-menu cc-popover-menu cc-edit-mode-popover"
        role="group"
        aria-label={t('编辑模式')}
      >
        {EDIT_MODE_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={editMode === option.mode}
            className={editMode === option.mode ? 'selected' : undefined}
            title={actionTitle(t(option.title), option.action)}
            onClick={() => {
              invokeAction(option.action, undefined, 'toolbar');
              hidePopover(menuRef.current);
            }}
          >
            <Icon name={option.icon} size={15} />
            <span>{t(option.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AspectRatioControl({
  width,
  height,
  fit,
  activeAspect,
  activeFit,
  onSetAspect,
}: {
  width: number;
  height: number;
  fit?: 'contain' | 'cover';
  activeAspect: string;
  activeFit: string;
  onSetAspect: (w: number, h: number, nextFit?: 'contain' | 'cover') => void;
}) {
  const t = useT();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const currentFit = fit === 'cover' ? 'cover' : 'contain';
  return (
    <div className="cc-popover-anchor">
      <button
        type="button"
        className="cc-aspect-select"
        popoverTarget={menuId}
        aria-label={t('画幅比例与适配')}
        title={t('画幅比例与适配')}
      >
        <Icon name="aspect" size={15} />
        <span>{activeAspect} · {activeFit}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        className="cc-track-create-menu cc-popover-menu cc-aspect-popover"
        role="group"
        aria-label={t('画幅比例与适配')}
      >
        <div className="cc-aspect-popover-heading">{t('画幅比例')}</div>
        {ASPECT_PRESETS.map((preset) => {
          const selected = preset.width === width && preset.height === height;
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={selected}
              className={selected ? 'selected' : undefined}
              onClick={() => {
                onSetAspect(preset.width, preset.height, fit);
                hidePopover(menuRef.current);
              }}
            >
              <span>{preset.label}</span>
            </button>
          );
        })}
        <hr className="cc-track-create-separator" />
        <div className="cc-aspect-popover-heading">{t('内容适配')}</div>
        {(['contain', 'cover'] as const).map((entry) => {
          const selected = currentFit === entry;
          return (
            <button
              key={entry}
              type="button"
              aria-pressed={selected}
              className={selected ? 'selected' : undefined}
              onClick={() => {
                onSetAspect(width, height, entry);
                hidePopover(menuRef.current);
              }}
            >
              <span>{t(entry === 'cover' ? '裁切' : '留边')}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimelineMoreControl(props: {
  trackingEnabled: boolean;
  onTracking: (restoreFocus: () => void) => void;
  state: TimelineState;
  hasSelected: boolean;
  hoverPreviewEnabled: boolean;
  setHoverPreviewEnabled: (enabled: boolean) => void;
  placeMode: 'insert' | 'overwrite';
  setPlaceMode: (mode: 'insert' | 'overwrite') => void;
  onCompactTracks: () => void;
  onToggleLinkage: () => void;
  onLinkageKinds: (linkedKinds: LinkedKind[]) => void;
}) {
  const t = useT();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const linkageEnabled = props.state.interaction?.linkage === true;
  const restoreFocus = () => triggerRef.current?.focus();
  return (
    <div className="cc-popover-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="cc-timeline-tool-button cc-timeline-more-trigger cc-tip"
        popoverTarget={menuId}
        data-tip={t('更多操作')}
        aria-label={t('更多操作')}
      >
        <Icon name="more" size={16} />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        className="cc-track-create-menu cc-timeline-more-menu cc-popover-menu"
        role="group"
        aria-label={t('更多操作')}
      >
        <button
          type="button"
          disabled={!props.hasSelected}
          title={t('删除选中片段并前移同轨后续片段 (Shift+Delete)')}
          onClick={() => {
            invokeAction('ripple-delete', undefined, 'toolbar');
            hidePopover(menuRef.current);
          }}
        >
          <Icon name="trim" size={15} />
          <span>{t('删除并合缝')}</span>
          <small>Shift+Del</small>
        </button>
        <button
          type="button"
          title={t('合并同类轨道空隙并清理空轨道')}
          onClick={() => {
            props.onCompactTracks();
            hidePopover(menuRef.current);
          }}
        >
          <Icon name="sort" size={15} />
          <span>{t('整理轨道')}</span>
        </button>
        <button
          type="button"
          disabled={!props.trackingEnabled}
          title={!props.trackingEnabled ? t('请先选择媒体池视频片段') : undefined}
          onClick={() => {
            hidePopover(menuRef.current);
            props.onTracking(restoreFocus);
          }}
        >
          <Icon name="tracking" size={15} />
          <span>{t('运动跟踪')}</span>
        </button>
        <button
          type="button"
          title={t('选中当前轨道播放头左侧片段 (Shift+[)')}
          onClick={() => {
            invokeAction('select-track-before-playhead', undefined, 'toolbar');
            hidePopover(menuRef.current);
          }}
        >
          <Icon name="prev" size={15} />
          <span>{t('单轨向左全选')}</span>
          <small>Shift+[</small>
        </button>
        <button
          type="button"
          title={t('选中当前轨道播放头右侧片段 (Shift+])')}
          onClick={() => {
            invokeAction('select-track-after-playhead', undefined, 'toolbar');
            hidePopover(menuRef.current);
          }}
        >
          <Icon name="next" size={15} />
          <span>{t('单轨向右全选')}</span>
          <small>Shift+]</small>
        </button>
        <hr className="cc-track-create-separator" />
        <button
          type="button"
          aria-pressed={linkageEnabled}
          className={linkageEnabled ? 'selected' : undefined}
          title={linkageEnabled ? t('联动：开；绑定素材随主片段移动') : t('联动：关；移动主片段不带动绑定素材')}
          onClick={props.onToggleLinkage}
        >
          <Icon name="paperclip" size={15} />
          <span>{t('联动')}</span>
          <small>{linkageEnabled ? t('开') : t('关')}</small>
        </button>
        <button
          type="button"
          aria-pressed={props.hoverPreviewEnabled}
          className={props.hoverPreviewEnabled ? 'selected' : undefined}
          title={props.hoverPreviewEnabled ? t('预览轴：开；鼠标悬停时间线即预览') : t('预览轴：关；点击时间线才跳转预览')}
          onClick={() => props.setHoverPreviewEnabled(!props.hoverPreviewEnabled)}
        >
          <Icon name={props.hoverPreviewEnabled ? 'eye' : 'eyeOff'} size={15} />
          <span>{t('预览轴')}</span>
          <small>{props.hoverPreviewEnabled ? t('开') : t('关')}</small>
        </button>
        <button
          type="button"
          title={t('拖入素材时插入顺延或覆盖重叠')}
          onClick={() => props.setPlaceMode(props.placeMode === 'insert' ? 'overwrite' : 'insert')}
        >
          <Icon name="swap" size={15} />
          <span>{props.placeMode === 'insert' ? t('插入素材') : t('覆盖素材')}</span>
        </button>
        <hr className="cc-track-create-separator" />
        <strong className="cc-timeline-more-heading">{t('联动范围')}</strong>
        {LINKED_KINDS.map(({ kind, label }) => {
          const kinds: readonly LinkedKind[] = props.state.interaction?.linkedKinds ?? ['text', 'video', 'image', 'other'];
          return <label key={kind} className="cc-timeline-linkage-option">
            <input type="checkbox" checked={kinds.includes(kind)} onChange={(event) => props.onLinkageKinds(
              event.currentTarget.checked ? [...kinds, kind] : kinds.filter((entry) => entry !== kind),
            )} />{t(label)}
          </label>;
        })}
      </div>
    </div>
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
  playerRef?: RefObject<PlayerRef | null>;
  total: number;
  captionsVisible: boolean;
  zoom: number;
  zoomMin?: number;
  setZoom: (z: number) => void;
  onPreviewCut?: (frame: number) => void;
  headerLeading?: ReactNode;
}

export const TimelineToolbar = memo(function TimelineToolbar({
  state, commands, editMode, placeMode, setPlaceMode, snapping, hoverPreviewEnabled, setHoverPreviewEnabled,
  recorder, canRecord, playing: _playing, timecodeRef, playheadRef, playheadFrame, playerRef, total, captionsVisible,
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
  const shortcut = useShortcutHint();
  const actionTitle = (title: string, id: string) => {
    const keys = shortcut(id);
    return keys ? `${title} (${keys})` : title;
  };
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
    const player = playerRef?.current;
    if (player) {
      player.addEventListener('frameupdate', update);
      player.addEventListener('seeked', update);
      player.addEventListener('pause', update);
      player.addEventListener('play', update);
      return () => {
        player.removeEventListener('frameupdate', update);
        player.removeEventListener('seeked', update);
        player.removeEventListener('pause', update);
        player.removeEventListener('play', update);
      };
    }
    const timer = window.setInterval(update, 160);
    return () => window.clearInterval(timer);
  }, [playheadRef, playerRef, state]);
  const pendingZoomRef = useRef<number | null>(null);
  const zoomRafRef = useRef(0);
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;
  useEffect(() => () => {
    if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
  }, []);
  const speedItem = useMemo(
    () => state.items.find((item) => (
      item.id === state.selectedId && (item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence')
    )) ?? null,
    [state.items, state.selectedId],
  );
  const speedFillPlan = useMemo(
    () => (speedItem ? planFillToNextTrackClip(state, speedItem.id) : null),
    [speedItem, state],
  );
  const sceneItem = useMemo(
    () => state.items.find((item) => item.id === state.selectedId && item.kind === 'video') ?? null,
    [state.items, state.selectedId],
  );
  const sceneUnavailable = useMemo(
    () => sceneDetectionUnavailable(state, sceneItem),
    [sceneItem, state],
  );
  const trackingItem = useMemo(
    () => state.items.find((item) => (
      item.id === state.selectedId
      && item.kind === 'video'
      && /^\/media\/uploads\//.test(item.src ?? '')
    )) ?? null,
    [state.items, state.selectedId],
  );
  const [sceneDetectionTargetId, setSceneDetectionTargetId] = useState<string | null>(null);
  const sceneDetectionTarget = useMemo(
    () => (sceneDetectionTargetId ? state.items.find((item) => item.id === sceneDetectionTargetId) ?? null : null),
    [sceneDetectionTargetId, state.items],
  );
  const [motionTrackingOpen, setMotionTrackingOpen] = useState(false);
  const modalFocus = useFocusReturn();
  const captionTracks = useMemo(
    () => captionTrackEntries(state).filter((entry) => entry.captions),
    [state],
  );
  const activeAspect = ASPECT_PRESETS.find((preset) => preset.width === state.width && preset.height === state.height)?.label ?? `${state.width}:${state.height}`;
  const activeFit = state.fit === 'cover' ? t('裁切') : t('留边');
  const hasCaptions = captionTracks.length > 0;
  return (
    <>
      <div className="cc-timeline-toolbar">
      <div className="cc-timeline-header-bar">
      {headerLeading}
      <div className="cc-timeline-control-row">
      <span ref={timecodeRef} className="cc-timeline-timecode">{fmt(playheadFrame, state.fps)} / {fmt(total, state.fps)}</span>
      <div className="cc-timeline-view-controls">
      <TB icon="zoomOut" title={actionTitle(t('缩小时间轴'), 'zoom-out')} tipRight onClick={() => invokeAction('zoom-out', undefined, 'toolbar')} />
      <input type="range" min={zoomMin} max={6} step="any" value={zoom}
        onChange={(e) => {
          pendingZoomRef.current = Number(e.target.value);
          if (!zoomRafRef.current) {
            zoomRafRef.current = requestAnimationFrame(() => {
              zoomRafRef.current = 0;
              if (pendingZoomRef.current !== null) {
                setZoomRef.current(pendingZoomRef.current);
                pendingZoomRef.current = null;
              }
            });
          }
        }}
        title={t('缩放时间轴')} aria-label={t('缩放时间轴')} aria-valuetext={`${Number((zoom * 100).toFixed(2))}%`} className="cc-timeline-zoom" />
      <TB icon="zoomIn" title={actionTitle(t('放大时间轴'), 'zoom-in')} tipRight onClick={() => invokeAction('zoom-in', undefined, 'toolbar')} />
      <TB icon="fit" title={actionTitle(t('适配视图'), 'zoom-fit')} tipRight onClick={() => invokeAction('zoom-fit', undefined, 'toolbar')} />
      <AspectRatioControl
        width={state.width}
        height={state.height}
        fit={state.fit}
        activeAspect={activeAspect}
        activeFit={activeFit}
        onSetAspect={(width, height, fit) => commands.setAspect(width, height, fit)}
      />
      <button type="button" className={`cc-caption-toggle cc-tip cc-tip-r${captionsVisible ? ' active' : ''}`} data-tip={hasCaptions
        ? t('字幕显示（仅控制字幕轨，不影响画面文字）')
        : t('字幕显示（暂无字幕轨）')} aria-label={t('字幕显示')} aria-pressed={captionsVisible} disabled={!hasCaptions} onClick={() => commands.setCaptionsHidden(captionsVisible)}><Icon name="captions" size={17} /><span>{captionsVisible ? t('字幕 开') : t('字幕 关')}</span></button>
      </div>
      </div>
      </div>
      <div className="cc-timeline-tool-group" role="toolbar" aria-label={t('时间轴工具栏')}>
        <div role="group" aria-label={t('编辑模式与剪辑')}>
          <EditModeControl editMode={editMode} actionTitle={actionTitle} />
          <TrackCreateControl commands={commands} />
          <TB icon="scissors" label={t('分割')} title={actionTitle(t('在播放头切分选中片段'), 'split')} disabled={!canSplitSelected} onClick={() => invokeAction('split', undefined, 'toolbar')} />
          <TB icon="sparkles" label={t('智能分割镜头')} title={sceneUnavailable ? t(sceneUnavailable) : t('检测镜头变化并一键分割')}
            disabled={!!sceneUnavailable} onClick={() => {
              const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              modalFocus.remember(() => restore?.focus());
              setSceneDetectionTargetId(sceneItem!.id);
            }} />
          <TB icon="trash" label={t('删除')} title={actionTitle(t('删除选中片段'), 'delete')} disabled={!state.selectedId} onClick={() => invokeAction('delete', undefined, 'toolbar')} />
          <TB icon="film" label={t('子草稿')} title={actionTitle(t('合并为子草稿'), 'create-subdraft')} disabled={!state.selectedId} onClick={() => invokeAction('create-subdraft', undefined, 'toolbar')} />
        </div>
        <ToolSep />
        <div role="group" aria-label={t('吸附与更多')}>
          <TB icon="magnet" label={t('主轨磁吸')} title={magnet ? t('主轨磁吸：开；换序或删除后自动合缝') : t('主轨磁吸：关；保留主轨空隙')}
            active={magnet} onClick={() => updateInteraction({ magnet: !magnet })} />
          <TB icon="tracking" label={t('自动吸附')} title={actionTitle(snapping ? t('自动吸附：开') : t('自动吸附：关'), 'snapping')} active={snapping} onClick={() => invokeAction('snapping', undefined, 'toolbar')} />
          <TimelineMoreControl
            trackingEnabled={!!trackingItem}
            state={state}
            hasSelected={!!state.selectedId}
            hoverPreviewEnabled={hoverPreviewEnabled}
            setHoverPreviewEnabled={setHoverPreviewEnabled}
            placeMode={placeMode}
            setPlaceMode={setPlaceMode}
            onCompactTracks={() => {
              const res = commands.compactTracks();
              showAppToast(res.movedItemCount > 0 || res.removedTrackIds.length > 0
                ? t('已整理轨道：合并 {moved} 个片段，清理 {removed} 条空轨道', { moved: res.movedItemCount, removed: res.removedTrackIds.length })
                : t('轨道已紧凑，无需整理'));
            }}
            onToggleLinkage={() => updateInteraction({ linkage: !(state.interaction?.linkage === true) })}
            onTracking={(restoreFocus) => { modalFocus.remember(restoreFocus); setMotionTrackingOpen(true); }}
            onLinkageKinds={(linkedKinds) => updateInteraction({ linkedKinds })}
          />
        </div>
        <ToolSep />
        <div role="group" aria-label={t('录音与变速')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span className="cc-mic-group">
            <TB icon="mic" active={recorder.recording}
              title={recorder.recording ? t('● 录音中，点击停止') : recorder.error ? t('录音失败：{error}', { error: recorder.error }) : t('录制旁白')}
              disabled={!canRecord} onClick={recorder.toggle} />
            <Icon name="chevronDown" size={13} />
          </span>
          {recorder.recording && <span title={t('录音中')} style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />}
          <TimelineSpeedControl
            item={speedItem}
            fps={state.fps}
            fillPlan={speedFillPlan}
            onChange={(rate) => { if (speedItem) commands.setItemSpeed(speedItem.id, rate); }}
            onDurationChange={(targetSeconds) => {
              if (!speedItem) return;
              const plan = planSpeedForTargetSeconds(speedItem, targetSeconds, state.fps);
              if (!plan) return;
              commands.setItemSpeed(speedItem.id, plan.rate);
              if (plan.clamped) {
                showAppToast(t('超出 0.1×–8× 变速范围，已调整为 {rate}×（{seconds} 秒）', {
                  rate: Number(plan.rate.toFixed(2)),
                  seconds: (plan.resultingFrames / Math.max(1, state.fps)).toFixed(2),
                }));
              }
            }}
            onFillToNext={() => {
              if (!speedItem || !speedFillPlan?.ok) return;
              commands.setItemSpeed(speedItem.id, speedFillPlan.rate);
              if (speedFillPlan.remainingGapFrames > 0) {
                showAppToast(t('已按最慢 0.10× 变速延长，仍有空隙未能完全填满'));
              }
            }}
          />
        </div>
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
});
