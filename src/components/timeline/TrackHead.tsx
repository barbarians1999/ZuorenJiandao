// Track header unit: highlighted track label + show/mute/lock/caption menu/dodge/delete actions,
// plus the "Auto-dodge · mix role" popover. Cross-track menu exclusivity stays in Timeline;
// this component only renders and forwards commands.
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { theme } from '../../theme';
import { Icon } from '../icons';
import type { EditorCommands } from '../../editor/store';
import type { TrackFlags, TrackId, TrackKind } from '../../editor/types';
import { useT } from '../../i18n/locale';
import type { TrackDeletePlan } from './trackDelete';
import { MenuDrillHeader } from './MenuDrillHeader';
import { TrackAudioControl } from '../audio/TrackAudioControl';


const flagBtn = (active: boolean): React.CSSProperties => ({
  width: 20, height: 20, display: 'grid', placeItems: 'center',
  background: active ? theme.panelAlt : 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0,
  color: active ? theme.accent : theme.textMuted, opacity: 1, flexShrink: 0,
});

interface TrackHeadProps {
  trackId: TrackId;
  kind: TrackKind;
  isText?: boolean;
  isEffect?: boolean;
  /** Stable title, e.g. 视频1 / V1 — never the custom name. */
  trackName: string;
  /** Optional custom name rendered as a second row under the title. */
  customName?: string;
  config: TrackFlags;
  deleteBlockedReason: TrackDeletePlan['blockedReason'];
  onDelete: () => void;
  onStartReorder?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  isReorderSource?: boolean;
  /** caption menu open on this track → raise head above neighbors */
  menuElevated: boolean;
  width: number;
  commands: EditorCommands;
  onToggleCaptions: () => void;
  onToggleCaptionMenu: (rect: DOMRect) => void;
  onToggleDuckMenu: (rect: DOMRect) => void;
  duckMenuPos: { left: number; top: number } | null;
  onCloseDuckMenu: () => void;
  onBackDuckMenu?: () => void;
  /** the open CaptionStyleMenu (fixed-positioned), when this track owns it */
  children?: ReactNode;
}

function trackDeleteTitle(
  blockedReason: TrackDeletePlan['blockedReason'],
  t: ReturnType<typeof useT>,
): string {
  if (blockedReason === 'last-video') return t('至少保留一条视频轨道');
  if (blockedReason === 'locked') return t('请先解锁轨道');
  return t('删除轨道');
}

export function TrackHead({
  trackId, kind, isText = false, isEffect = false, trackName, customName, config, deleteBlockedReason, onDelete, onStartReorder, isReorderSource = false, menuElevated, width,
  commands, onToggleCaptions, onToggleCaptionMenu, onToggleDuckMenu, duckMenuPos, onCloseDuckMenu, onBackDuckMenu, children,
}: TrackHeadProps) {
  const t = useT();
  const hidden = config.hidden ?? false;
  const muted = config.muted ?? false;
  const soloed = config.soloed ?? false;
  const locked = config.locked ?? false;
  const isCaption = kind === 'caption';
  const deleteTitle = trackDeleteTitle(deleteBlockedReason, t);
  const tagColor = isText ? theme.clipText : isEffect ? theme.clipMg : kind === 'video' ? theme.trackVideo : kind === 'audio' ? theme.trackAudioA1 : theme.trackCaption;
  const baseTitle = customName && customName !== trackName ? `${trackName} · ${customName}` : trackName;
  const nameTitle = config.role === 'anchor' ? `${baseTitle} · ${t('人声')}`
    : config.role === 'follower' ? `${baseTitle} · ${t('配乐（说话时压低）')}`
      : baseTitle;
  return (
      

    <div className={`cc-track-head${isReorderSource ? ' is-reorder-source' : ''}`} style={{ width, cursor: onStartReorder ? 'grab' : undefined, ...(menuElevated ? { zIndex: 40 } : {}) }} title={t('按住上下拖动调整轨道顺序')} onPointerDown={(event) => { if (!onStartReorder || event.button !== 0) return; const target = event.target instanceof Element ? event.target : null; if (target?.closest('button, input, select, textarea, [role="menu"], .cc-caption-style-menu, .cc-duck-menu')) return; onStartReorder(event); }}>
      <div className="cc-track-head-controls">
        <span className={`cc-track-name is-${kind}${isText ? ' is-text' : ''}${isEffect ? ' is-effect' : ''}`} title={t('{name}（{id}）', { name: nameTitle, id: trackId })} style={{ background: tagColor }}>
          <span className="cc-track-name-title">{trackName}</span>
        </span>
        <button style={flagBtn(hidden)} title={hidden ? t('显示轨道') : t('隐藏轨道')} aria-label={hidden ? t('显示轨道') : t('隐藏轨道')} aria-pressed={hidden} onClick={isCaption ? onToggleCaptions : () => commands.toggleTrackFlag(trackId, 'hidden')}><Icon name={hidden ? 'eyeOff' : 'eye'} size={14} /></button>
        {!isCaption && <button style={flagBtn(muted)} title={muted ? t('取消静音') : t('静音轨道')} aria-label={muted ? t('取消静音') : t('静音轨道')} aria-pressed={muted} onClick={() => commands.toggleTrackFlag(trackId, 'muted')}><Icon name={muted ? 'volumeOff' : 'volume'} size={14} /></button>}
        {!isCaption && <button style={{ ...flagBtn(soloed), color: soloed ? theme.accent : theme.textMuted, fontSize: 10, fontWeight: 700 }} title={soloed ? t('取消独奏') : t('独奏轨道')} aria-label={soloed ? t('取消独奏') : t('独奏轨道')} aria-pressed={soloed} onClick={() => commands.toggleTrackFlag(trackId, 'soloed')}>S</button>}
        <button style={{ ...flagBtn(false), color: locked ? theme.textStrong : theme.textMuted }} title={locked ? t('解锁轨道') : t('锁定轨道（禁止移动 / 裁剪 / 删除 / 落轨）')} aria-label={locked ? t('解锁轨道') : t('锁定轨道（禁止移动 / 裁剪 / 删除 / 落轨）')} aria-pressed={locked} onClick={() => commands.toggleTrackFlag(trackId, 'locked')}><Icon name={locked ? 'lock' : 'unlock'} size={14} /></button>
        {isCaption && <button data-caption-menu-trigger style={flagBtn(false)} title={t('字幕样式与翻译')} aria-label={t('字幕样式与翻译')} aria-haspopup="menu" onClick={(e) => onToggleCaptionMenu(e.currentTarget.getBoundingClientRect())}><Icon name="chevronDown" size={12} /></button>}
        {!isCaption && <button data-duck-menu-trigger style={{ ...flagBtn(false), color: config.role === 'anchor' || config.role === 'follower' ? theme.gold : theme.textMuted }} title={t('人声与配乐')} aria-label={t('人声与配乐')} aria-haspopup="menu" onClick={(e) => onToggleDuckMenu(e.currentTarget.getBoundingClientRect())}><Icon name="sliders" size={13} /></button>}
        <button
          type="button"
          className="cc-track-fixed-action"
          disabled={deleteBlockedReason !== null}
          title={deleteTitle}
          aria-label={deleteTitle}
          onClick={onDelete}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      {children}
      {duckMenuPos && (
        <DuckMenu trackId={trackId} config={config} pos={duckMenuPos} commands={commands} onClose={onCloseDuckMenu} onBack={onBackDuckMenu ?? onCloseDuckMenu} />
      )}
    </div>
  );
}

// Duck (auto-dodge) role menu is a track-head menu item, not a
// permanent widget. Sets the per-track role (anchor speech / follower music) + duck depth;
// the engine (TimelineComposition duckGain) already reacts to it.
function DuckMenu({ trackId, config, pos, commands, onClose, onBack }: {
  trackId: TrackId;
  config: TrackFlags;
  pos: { left: number; top: number };
  commands: EditorCommands;
  onClose: () => void;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <div className="cc-caption-style-menu cc-duck-menu" style={{ position: 'fixed', left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
      <MenuDrillHeader title={t('人声与配乐')} onBack={onBack} />
      <div style={{ padding: '8px 10px' }}>
        <TrackAudioControl config={config} onChange={(patch) => commands.updateTrack(trackId, patch)}
          onRoleChosen={(role) => { if (role !== 'follower') onClose(); }} />
      </div>
    </div>
  );
}
