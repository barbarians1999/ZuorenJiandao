import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import type { EditorCommands } from '../../editor/store';
import { removeItemsFromState, selectableItemIdsOnTrackSide } from '../../editor/multiSelect';
import { setLinkGroup, unlinkItems, groupedItemIds, groupTimelineItems, ungroupTimelineItems } from '../../editor/linkGroups';
import { attachToMainClip, mainTrackId, planMagneticDelete } from '../../editor/magneticTimeline';
import { planExpandSubdraft, planIndependentSubdraft, type SubdraftOperation } from '../../editor/subdraftOperations';
import { canMulticamItem, runMulticamSync } from '../../multicam/sync';
import { TRANSITION_LABELS, ZOOM_SHAPE_LABELS, type ProjectDoc, type TimelineItem, type TimelineState, type TransitionItem } from '../../editor/types';
import { ALL_FX, LUT_EFFECTS } from '../../gl/fx/effects';
import { Icon, type IconName } from '../icons';
import { useT } from '../../i18n/locale';
import { canSplitTimelineItemAtFrame } from '../../editor/splitEligibility';
import { sceneDetectionUnavailable } from '../../scene-detection/apply';
import { detachAudio, detachAudioUnavailable } from '../../editor/detachAudio';
import { useShortcutHint } from '../../shortcuts/useShortcutHint';

// speed presets for the variable speed submenu
const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;
const SPEED_PRESET_EPSILON = 0.01;

function displaySpeedRate(rate: number): number {
  return Number(rate.toFixed(3));
}

function matchesSpeedPreset(rate: number, preset: number): boolean {
  return Math.abs(rate - preset) < SPEED_PRESET_EPSILON;
}

// Clip right-click menu. Multi-camera synchronization: client audio alignment (src/multicam).

/** effects copied from a clip (the clip's effects[] stack) */
export interface FxClip {
  filters?: TimelineItem['filters'];
  transform?: TimelineItem['transform'];
  zoom?: TimelineItem['zoom'];
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

interface ClipContextMenuProps {
  item: TimelineItem;
  /** Transitions (in/out) related to this clip are listed and removed by "Applied Effects" */
  transitions: TransitionItem[];
  x: number;
  y: number;
  playhead: number;
  commands: EditorCommands;
  /** Active timeline — needed for multi-select batch delete */
  timeline: TimelineState;
  /** Required for graph-aware subdraft operations; never synthesize a partial document. */
  projectDoc?: ProjectDoc;
  /** Current multi-selection (includes item when right-clicked inside the set) */
  selectedIds: string[];
  fxClip: FxClip | null;
  onCopyFx: (fx: FxClip) => void;
  onClose: () => void;
  /** Export MG animation → ProRes 4444 alpha .mov download */
  onExportMg: (item: TimelineItem) => void;
  /** Turn to video → bake to a video clip in place */
  onConvertToVideo: (item: TimelineItem) => void;
  onAddComment: (item: TimelineItem, frame: number, clientX: number, clientY: number) => void;
  /** Pick a local replacement for this media clip. */
  onRelinkFile: (item: TimelineItem) => void;
  /** Open local scene detection for this video clip. */
  onDetectScenes: (item: TimelineItem) => void;
  onCopy?: () => void;
  onPaste?: () => void;
}

export function ClipContextMenu({ item, transitions, x, y, playhead, commands, timeline, projectDoc, selectedIds, fxClip, onCopyFx, onClose, onExportMg, onConvertToVideo, onAddComment, onRelinkFile, onDetectScenes, onCopy, onPaste }: ClipContextMenuProps) {
  const t = useT();
  const shortcut = useShortcutHint();
  const ref = useRef<HTMLDivElement>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const applySubdraftOperation = (planner: typeof planExpandSubdraft) => {
    if (!projectDoc) return;
    const result: SubdraftOperation = planner(projectDoc, item.id, (prefix) => `${prefix}_${crypto.randomUUID()}`);
    if (!result.ok) { window.alert(t(result.error)); return; }
    commands.applyDoc(result.doc);
    commands.selectItems(result.itemIds);
  };
  // Right-click on a multi-selected clip → batch ops on the whole set (NLE convention).
  const batchIds = groupedItemIds(timeline, selectedIds.includes(item.id) && selectedIds.length > 1 ? selectedIds : [item.id]);
  const batchN = batchIds.length;
  const selectedVideos = timeline.items.filter(clip => batchIds.includes(clip.id) && clip.kind === 'video');
  const detachCount = selectedVideos.filter(clip => !clip.audioDetached).length;
  const detachDisabledReason = detachAudioUnavailable(timeline, batchIds);
  // Multicam: need ≥2 selected video/audio with media
  const multicamIds = (batchN > 1 ? batchIds : selectedIds.length > 1 ? selectedIds : [])
    .map((id) => timeline.items.find((x) => x.id === id))
    .filter((x): x is TimelineItem => !!x && canMulticamItem(x))
    .map((x) => x.id);
  // If only one selected but right-clicked a media clip, still require multi-select
  const multicamReady = multicamIds.length >= 2;
  const multicamHint = multicamReady
    ? t('对 {n} 个片段按时间码、采集时钟或音频依次对齐', { n: multicamIds.length })
    : batchN < 2 && selectedIds.length < 2
      ? t('先框选 2 个及以上视频/音频片段')
      : t('多机位同步只支持带媒体的视频/音频片段');
  const multicamGroup = item.multicamGroupId
    ? timeline.multicamGroups?.find((group) => group.id === item.multicamGroupId)
    : timeline.multicamGroups?.find((group) => group.angles.some((angle) => angle.itemId === item.id));
  const linkedGroup = timeline.linkGroups?.find((group) => group.mode === 'linked' && group.itemIds.includes(item.id));
  const syncLockGroup = timeline.linkGroups?.find((group) => group.mode === 'sync-lock' && group.itemIds.includes(item.id));
  const ordinaryGroup = timeline.linkGroups?.some((group) => group.mode === 'group' && group.itemIds.some((id) => batchIds.includes(id)));
  const attachable = attachToMainClip({ ...timeline, interaction: { ...timeline.interaction,
    linkage: true, linkedKinds: ['text', 'video', 'image', 'audio', 'other'],
  } }, { ...item, mainClipId: undefined });
  const removeSelection = (ripple: boolean) => {
    if (timeline.interaction?.magnet && timeline.items.some((clip) => batchIds.includes(clip.id) && clip.track === mainTrackId(timeline))) {
      const plan = planMagneticDelete(timeline, batchIds);
      if (plan.error) window.alert(plan.error);
      else if (plan.state !== timeline) commands.applyState(plan.state);
    } else if (batchN === 1) {
      if (ripple) commands.rippleDeleteItem(batchIds[0]!);
      else commands.removeItem(batchIds[0]!);
    } else commands.applyState(removeItemsFromState(timeline, batchIds, ripple));
  };
  const toggleRelationship = (mode: 'linked' | 'sync-lock') => {
    const existing = mode === 'linked' ? linkedGroup : syncLockGroup;
    const next = existing
      ? unlinkItems(timeline, batchN > 1 ? batchIds : [item.id], mode)
      : setLinkGroup(timeline, {
          id: globalThis.crypto?.randomUUID?.() ?? `link_${Date.now().toString(36)}`,
          itemIds: batchIds,
          anchorItemId: item.id,
          mode,
        });
    if (next !== timeline) commands.applyState(next);
  };

  const runMulticam = async () => {
    if (!multicamReady || syncBusy) return;
    setSyncBusy(true);
    setSyncMsg(t('正在读取时间码、采集时钟或音频…'));
    try {
      // Prefer right-clicked item as reference when it's in the set
      const refId = multicamIds.includes(item.id) ? item.id : undefined;
      const result = await runMulticamSync({
        state: timeline,
        itemIds: multicamIds,
        referenceItemId: refId,
      });
      if (result.changed && result.nextState) commands.applyState(result.nextState);
      const methods = [...new Set(result.offsets.map((offset) => offset.method))].join(' / ');
      setSyncMsg(result.groupId
        ? (result.skippedItemIds.length
          ? t('多机位组已保存（{method}），跳过 {m} 个', { method: methods, m: result.skippedItemIds.length })
          : t('多机位组已保存（{method}）', { method: methods }))
        : result.status === 'already_synced'
          ? t('已经对齐（偏移小于 1 帧）')
          : result.status === 'failed'
            ? result.message
            : t('无法对齐所选片段（缺少时间码且音频置信度过低）'));
      if (result.changed) {
        // brief toast then close
        window.setTimeout(() => onClose(), 900);
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : t('多机位同步失败'));
    } finally {
      setSyncBusy(false);
    }
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const [showSpeed, setShowSpeed] = useState(false);
  const [showApplied, setShowApplied] = useState(false);
  // Use conservative clamping for the initial value, and accurately shrink it after measuring the actual size (expanding sub-area/weight when changing anchor)
  const [pos, setPos] = useState(() => ({ left: Math.min(x, window.innerWidth - 210), top: Math.min(y, window.innerHeight - 380) }));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, showApplied, showSpeed]);

  // List of applied effects: special effects/LUT/zoom/transition, click to remove
  const effects = item.effects ?? [];
  const applied: { key: string; label: string; remove: () => void }[] = [
    ...effects.map((fx) => ({
      key: fx.id,
      label: `${fx.assetId in LUT_EFFECTS ? 'LUT' : t('特效')} · ${t(ALL_FX[fx.assetId]?.name ?? fx.assetId)}`,
      remove: () => commands.setItemEffects(item.id, effects.filter((e) => e.id !== fx.id)),
    })),
    ...(item.zoom?.shape || (item.zoom?.reframeCurve?.keyframes.length ?? 0) > 0
      ? [{
          key: 'zoom',
          label: t('缩放 · {name}', { name: item.zoom?.shape ? t(ZOOM_SHAPE_LABELS[item.zoom.shape] ?? item.zoom.shape) : item.zoom?.label ?? t('关键帧') }),
          remove: () => commands.setItemZoom(item.id, null),
        }]
      : []),
    ...transitions.map((tr) => ({
      key: tr.id,
      label: t(tr.incomingItemId === item.id ? '转场 · {name}（入）' : '转场 · {name}（出）', { name: t(TRANSITION_LABELS[tr.type] ?? tr.type) }),
      remove: () => commands.removeTransition(tr.id),
    })),
  ];
  const inside = canSplitTimelineItemAtFrame(item, playhead, !!timeline.tracks?.[item.track]?.locked);
  const isVisual = item.kind !== 'audio';
  const isDom = item.kind === 'motion-graphic' || item.kind === 'text'; // DOM clips → alpha MG export
  const canSpeed = item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence';
  const sceneDetectionDisabledReason = sceneDetectionUnavailable(timeline, item);
  const canDetectScenes = !sceneDetectionDisabledReason;
  const canRelink = !timeline.tracks?.[item.track]?.locked && !!item.src && ['video', 'audio', 'image', 'gif', 'svg'].includes(item.kind);
  const rate = item.playbackRate ?? 1;
  const displayedRate = displaySpeedRate(rate);
  const reviewFrame = Math.max(item.startFrame, Math.min(playhead, item.startFrame + item.durationInFrames - 1));
  const run = (fn: () => void) => () => { fn(); onClose(); };

  const copyFx = () => onCopyFx({ filters: item.filters, transform: item.transform, zoom: item.zoom, fadeInFrames: item.fadeInFrames, fadeOutFrames: item.fadeOutFrames });
  const pasteFx = () => {
    if (!fxClip) return;
    if (fxClip.filters) commands.setItemFilters(item.id, fxClip.filters);
    if (fxClip.transform) commands.setItemTransform(item.id, fxClip.transform);
    commands.setItemZoom(item.id, fxClip.zoom ?? null);
    commands.setItemFade(item.id, { fadeInFrames: fxClip.fadeInFrames ?? 0, fadeOutFrames: fxClip.fadeOutFrames ?? 0 });
  };

  // keep the menu on-screen: The height of the menu changes with the entry/expanded state. If the height is estimated to be too high, it will overflow at the bottom——
  // After the mounting and unfolding state changes, measure the real size and then clamp it (useLayoutEffect is run before drawing and does not flash).
  const style: React.CSSProperties = {
    position: 'fixed', left: pos.left, top: pos.top,
    zIndex: 100, minWidth: 200, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto',
    background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
    borderRadius: 5, boxShadow: `0 12px 36px ${themeAlpha.shadow(0.55)}`, padding: 5, fontSize: 12.5, color: theme.text,
  };

  return (
    <div ref={ref} className="cc-clip-context-menu" style={style}>
      <Item label={t('添加评论')} icon="clipboard" onClick={run(() => onAddComment(item, reviewFrame, x, y))} />
      <Sep />
      <Item
        label={syncBusy ? t('多机位同步中…') : t('多机位同步')}
        icon="users"
        disabled={!multicamReady || syncBusy}
        onClick={() => { void runMulticam(); }}
      />
      {syncMsg && (
        <div style={{ padding: '4px 9px 6px', fontSize: 11, color: theme.textMuted, lineHeight: 1.35 }}>
          {syncMsg}
        </div>
      )}
      {!multicamReady && !syncMsg && (
        <div style={{ padding: '0 9px 6px', fontSize: 10.5, color: theme.textDim, lineHeight: 1.3 }}>
          {multicamHint}
        </div>
      )}
      {multicamGroup && (
        <div style={{ padding: '0 9px 6px', fontSize: 10.5, color: theme.textDim, lineHeight: 1.3 }}>
          {t('多机位组 · {n} 机位 · {method}', {
            n: multicamGroup.angles.length,
            method: multicamGroup.syncMethod,
          })}
        </div>
      )}
      <Item
        label={linkedGroup ? t('取消链接音视频') : t('链接所选音视频')}
        icon={linkedGroup ? 'unlock' : 'users'}
        disabled={!linkedGroup && batchN < 2}
        onClick={run(() => toggleRelationship('linked'))}
      />
      <Item
        label={syncLockGroup ? t('取消同步锁定') : t('同步锁定所选片段')}
        icon={syncLockGroup ? 'unlock' : 'lock'}
        disabled={!syncLockGroup && batchN < 2}
        onClick={run(() => toggleRelationship('sync-lock'))}
      />
      <Sep />
      <Item label={t('复制')} icon="copy" shortcut={shortcut('copy')} disabled={!onCopy} onClick={run(() => onCopy?.())} />
      <Item label={t('粘贴到播放头')} icon="clipboard" shortcut={shortcut('paste')} disabled={!onPaste} onClick={run(() => onPaste?.())} />
      <Item label={t('此轨向左全选')} icon="prev" disabled={!!timeline.tracks?.[item.track]?.locked}
        onClick={run(() => commands.selectItems(selectableItemIdsOnTrackSide(timeline, item.track, item.startFrame, 'left', { anchorItemId: item.id })))} />
      <Item label={t('此轨向右全选')} icon="next" disabled={!!timeline.tracks?.[item.track]?.locked}
        onClick={run(() => commands.selectItems(selectableItemIdsOnTrackSide(timeline, item.track, item.startFrame, 'right', { anchorItemId: item.id })))} />
      <Item label={t('组合所选片段')} icon="users" shortcut={shortcut('group')} disabled={batchN < 2}
        onClick={run(() => commands.applyState(groupTimelineItems(timeline, batchIds, crypto.randomUUID())))} />
      <Item label={t('取消组合')} icon="unlock" shortcut={shortcut('ungroup')} disabled={!ordinaryGroup}
        onClick={run(() => commands.applyState(ungroupTimelineItems(timeline, batchIds)))} />
      {item.track !== mainTrackId(timeline) && <Item
        label={item.mainClipId ? t('取消跟随主片段') : t('绑定到下方主片段')}
        icon={item.mainClipId ? 'unlock' : 'users'}
        title={t('绑定后，开启联动时随主片段移动和删除；单独移动这个片段不会反向拖动主轨')}
        disabled={!!timeline.tracks?.[item.track]?.locked || (!item.mainClipId && !attachable.mainClipId)}
        onClick={run(() => commands.applyState({ ...timeline, items: timeline.items.map((clip) => clip.id === item.id
          ? { ...clip, mainClipId: item.mainClipId ? undefined : attachable.mainClipId } : clip) }))}
      />}
      <Item label={t('创建子草稿（合并所选片段）')} icon="film" onClick={run(() => {
        const result = commands.createSubdraft(batchIds);
        if (!result.ok) window.alert(t(result.error));
      })} />
      {item.kind === 'sequence' && item.timelineId && <Item label={t('打开子草稿编辑')} icon="film" onClick={run(() => commands.switchTimeline(item.timelineId!))} />}
      {item.kind === 'sequence' && <>
        <Item label={t('制作独立副本（只修改这一处）')} icon="copy"
          title={t('复制内部所有嵌套子草稿；原始媒体共用，不影响其他位置的同一子草稿')}
          disabled={!projectDoc || !!timeline.tracks?.[item.track]?.locked}
          onClick={run(() => applySubdraftOperation(planIndependentSubdraft))} />
        <Item label={t('展开为原片段')} icon="film"
          title={t('将当前显示的源范围展开到时间线，保留原子草稿，可一次撤销')}
          disabled={!projectDoc || !!timeline.tracks?.[item.track]?.locked}
          onClick={run(() => applySubdraftOperation(planExpandSubdraft))} />
      </>}
      <Item label={t('切分')} icon="scissors" shortcut={shortcut('split')} disabled={!inside} onClick={run(() => commands.splitItem(item.id, playhead))} />
      {selectedVideos.length > 0 && <Item label={detachCount > 1 ? t('分离音频（{n} 个视频）', { n: detachCount }) : t('分离音频')} icon="volume"
        disabled={!!detachDisabledReason} title={detachDisabledReason ? t(detachDisabledReason) : undefined}
        onClick={run(() => commands.applyState(detachAudio(timeline, batchIds, (prefix) => `${prefix}_${crypto.randomUUID()}`)))} />}
      <Item label={t('智能分割镜头')} icon="sparkles" disabled={!canDetectScenes}
        title={sceneDetectionDisabledReason ? t(sceneDetectionDisabledReason) : undefined}
        onClick={run(() => onDetectScenes(item))} />
      <Sep />
      <Item label={applied.length ? t('已应用效果（{n}）', { n: applied.length }) : t('已应用效果')} icon="filter" chevron disabled={applied.length === 0}
        onClick={applied.length ? () => setShowApplied((v) => !v) : undefined} />
      {showApplied && applied.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 6px 6px 35px' }}>
          {applied.map((a) => (
            <button key={a.key} title={t('点击移除')} onClick={run(a.remove)} style={appliedRow}
              onMouseEnter={(e) => { e.currentTarget.style.background = theme.bg; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{a.label}</span>
              <span style={{ color: theme.textDim, flexShrink: 0 }}>×</span>
            </button>
          ))}
        </div>
      )}
      <Item label={t('复制效果')} icon="sparkles" disabled={!isVisual} onClick={run(copyFx)} />
      <Item label={t('粘贴效果')} icon="clipboard" shortcut={shortcut('paste-effects')} disabled={!isVisual || !fxClip} onClick={run(pasteFx)} />
      <Item label={!matchesSpeedPreset(rate, 1) ? t('变速（{rate}×）', { rate: displayedRate }) : t('变速')} icon="clock" chevron disabled={!canSpeed}
        onClick={canSpeed ? () => setShowSpeed((v) => !v) : undefined} />
      {showSpeed && canSpeed && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 9px 6px 35px' }}>
          {SPEED_PRESETS.map((s) => {
            const active = matchesSpeedPreset(rate, s);
            return (
              <button key={s} onClick={run(() => commands.setItemSpeed(item.id, s))}
                style={{
                  cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 5,
                  border: `0.5px solid ${active ? theme.accent : theme.border}`,
                  background: active ? theme.accent : 'none', color: active ? theme.onAccent : theme.text,
                }}>{s}×</button>
            );
          })}
        </div>
      )}
      <Sep />
      <Item label={t('重新链接文件')} icon="folder" disabled={!canRelink} onClick={run(() => onRelinkFile(item))} />
      <Sep />
      <Item label={t('导出 MG 动画')} icon="download" disabled={!isDom} onClick={run(() => onExportMg(item))} />
      <Item label={t('转为视频')} icon="film" disabled={item.kind === 'audio'} onClick={run(() => onConvertToVideo(item))} />
      <Sep />
      <Item
        label={batchN > 1 ? t('删除（{n}）', { n: batchN }) : t('删除')}
        icon="trash"
        danger
        shortcut={shortcut('delete')}
        onClick={run(() => removeSelection(false))}
      />
      <Item
        label={batchN > 1 ? t('波纹删除（{n}）', { n: batchN }) : t('波纹删除（合缝）')}
        icon="trash"
        danger
        shortcut={shortcut('ripple-delete')}
        onClick={run(() => removeSelection(true))}
      />
    </div>
  );
}

const appliedRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none',
  borderRadius: 5, padding: '4px 8px', fontSize: 11.5, color: theme.text, cursor: 'pointer',
};

function Sep() {
  return <div style={{ height: 0.5, background: theme.border, margin: '5px 6px' }} />;
}

function Item({ label, icon, shortcut, disabled, danger, pro, chevron, title, onClick }: {
  label: string; icon: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; pro?: boolean; chevron?: boolean; title?: string; onClick?: () => void;
}) {
  return (
    <button disabled={disabled} title={title} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none',
        borderRadius: 6, padding: '7px 9px', fontSize: 12.5, cursor: disabled ? 'default' : 'pointer',
        color: disabled ? theme.textDim : danger ? theme.accent : theme.text, opacity: disabled ? 0.45 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = theme.bg; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <span style={{ width: 16, display: 'grid', placeItems: 'center', lineHeight: 0, color: danger ? theme.accent : theme.textDim }}><Icon name={icon} size={15} /></span>
      <span style={{ flex: 1 }}>{label}</span>
      {pro && <span style={{ fontSize: 9, fontWeight: 700, color: theme.accent, border: `0.5px solid ${theme.accent}`, borderRadius: 3, padding: '0 3px' }}>PRO</span>}
      {chevron && <span style={{ color: theme.textDim }}>›</span>}
      {shortcut && <span style={{ color: theme.textDim, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{shortcut}</span>}
    </button>
  );
}
