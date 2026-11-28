import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { CallbackListener, PlayerRef } from '@remotion/player';
import type { ProjectDoc, TimelineState } from '../../editor/types';
import { MARKER_HEX } from '../../editor/markerTypes';
import { useT } from '../../i18n/locale';
import { invokeAction } from '../../shortcuts/actionRegistry';
import { useShortcutHint } from '../../shortcuts/useShortcutHint';
import { showAppToast } from '../../ui/appToast';
import { Icon } from '../icons';
import { PreviewSourceToggle } from './PreviewSourceControls';
import {
  exportCurrentStillFrame,
  formatPreviewTimecode,
  frameFromTrackRatio,
  percentOfTimelineFrame,
  resolvePreviewZoneSpan,
} from './exportStillFrame';

interface PreviewMonitorBarProps {
  state: TimelineState;
  project: ProjectDoc;
  projectName?: string;
  timelineId: string;
  playerRef: RefObject<PlayerRef | null>;
  duration: number;
  playing: boolean;
  shuttleRate: number;
  zoneIn?: number | null;
  zoneOut?: number | null;
  hidden?: boolean;
  onSeek?: (frame: number) => void;
  audioMeterOpen?: boolean;
  onToggleAudioMeter?: () => void;
}

export function PreviewMonitorBar({
  state,
  project,
  projectName,
  timelineId,
  playerRef,
  duration,
  playing,
  shuttleRate,
  zoneIn = null,
  zoneOut = null,
  hidden = false,
  onSeek,
  audioMeterOpen = false,
  onToggleAudioMeter,
}: PreviewMonitorBarProps) {
  const t = useT();
  const shortcut = useShortcutHint();
  const trackRef = useRef<HTMLDivElement>(null);
  const timecodeCurrentRef = useRef<HTMLSpanElement>(null);
  const scrubFillRef = useRef<HTMLDivElement>(null);
  const scrubThumbRef = useRef<HTMLDivElement>(null);
  const currentFrameRef = useRef(0);
  const paintRafRef = useRef(0);
  const lastTcPaintRef = useRef(0);
  const [exportingStill, setExportingStill] = useState(false);

  const keyHint = (id: string, fallback: string) => shortcut(id) ?? fallback;
  const markerKey = keyHint('marker-add', 'M');
  const zoneInKey = keyHint('zone-in', 'I');
  const zoneClearInKey = keyHint('zone-clear-in', 'Shift+I');
  const zoneOutKey = keyHint('zone-out', 'O');
  const zoneClearOutKey = keyHint('zone-clear-out', 'Shift+O');
  const zoneClearKey = keyHint('zone-clear', 'X');
  const shuttleBackKey = keyHint('shuttle-back', 'J');
  const seekBackKey = keyHint('seek-back', '←');
  const rawPlayPauseKey = keyHint('play-pause', 'Space');
  const playPauseKey = rawPlayPauseKey === 'Space' ? t('空格') : rawPlayPauseKey;
  const seekFwdKey = keyHint('seek-fwd', '→');
  const shuttleFwdKey = keyHint('shuttle-fwd', 'L');
  const fullscreenKey = keyHint('fullscreen', '`');

  const hasItems = state.items.length > 0;
  const totalTimelineFrames = useMemo(
    () => state.items.reduce((max, item) => Math.max(max, item.startFrame + item.durationInFrames), 0),
    [state.items],
  );
  const displayDurationFrames = hasItems ? totalTimelineFrames : 0;
  const spanFrames = Math.max(1, totalTimelineFrames || duration);
  const maxSeekFrame = Math.max(0, (totalTimelineFrames > 0 ? Math.min(duration - 1, totalTimelineFrames) : duration - 1));
  const isTransportActive = playing || shuttleRate !== 0;

  const paintDom = (nextFrame: number, forceTc = false) => {
    const rounded = Math.max(0, Math.round(nextFrame));
    currentFrameRef.current = rounded;
    const pct = hasItems ? percentOfTimelineFrame(rounded, spanFrames) : 0;
    if (scrubFillRef.current) scrubFillRef.current.style.width = `${pct}%`;
    if (scrubThumbRef.current) scrubThumbRef.current.style.left = `${pct}%`;
    const now = performance.now();
    if (timecodeCurrentRef.current && (forceTc || now - lastTcPaintRef.current >= 80)) {
      lastTcPaintRef.current = now;
      timecodeCurrentRef.current.textContent = formatPreviewTimecode(hasItems ? rounded : 0, state.fps);
    }
  };
  const paintDomRef = useRef(paintDom);
  paintDomRef.current = paintDom;

  useLayoutEffect(() => {
    paintDomRef.current(currentFrameRef.current, true);
  }, [spanFrames, hasItems, state.fps]);

  useEffect(() => {
    let attachedPlayer: PlayerRef | null = null;
    let detachPlayer: (() => void) | null = null;
    const attach = (player: PlayerRef) => {
      let pendingPlayFrame: number | null = null;
      const cancelPaint = () => {
        if (paintRafRef.current) {
          cancelAnimationFrame(paintRafRef.current);
          paintRafRef.current = 0;
        }
        pendingPlayFrame = null;
      };
      const commitFrame = (next: number) => {
        cancelPaint();
        const rounded = Math.max(0, Math.round(next));
        paintDomRef.current(rounded, true);
      };
      try {
        commitFrame(player.getCurrentFrame?.() ?? 0);
      } catch { /* ignore */ }
      const onFrameUpdate: CallbackListener<'frameupdate'> = (e) => {
        let isActivePlay = false;
        try { isActivePlay = Boolean(player.isPlaying?.()); } catch { isActivePlay = false; }
        if (!isActivePlay) {
          commitFrame(e.detail.frame);
          return;
        }
        pendingPlayFrame = e.detail.frame;
        if (!paintRafRef.current) {
          paintRafRef.current = requestAnimationFrame(() => {
            paintRafRef.current = 0;
            if (pendingPlayFrame !== null) {
              paintDomRef.current(pendingPlayFrame, false);
            }
          });
        }
      };
      const onSettled = (e: { detail?: { frame?: number } }) => {
        const next = typeof e.detail?.frame === 'number' ? e.detail.frame : (player.getCurrentFrame?.() ?? currentFrameRef.current);
        commitFrame(next);
      };
      player.addEventListener('frameupdate', onFrameUpdate);
      player.addEventListener('seeked', onSettled);
      player.addEventListener('pause', onSettled);
      player.addEventListener('ended', onSettled);
      return () => {
        cancelPaint();
        player.removeEventListener('frameupdate', onFrameUpdate);
        player.removeEventListener('seeked', onSettled);
        player.removeEventListener('pause', onSettled);
        player.removeEventListener('ended', onSettled);
      };
    };
    const syncPlayer = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const player = playerRef.current;
      if (player === attachedPlayer) return;
      detachPlayer?.();
      attachedPlayer = player;
      detachPlayer = player ? attach(player) : null;
      if (!player) paintDomRef.current(0, true);
    };
    const onVisibilityChange = () => {
      if (!document.hidden) syncPlayer();
    };
    syncPlayer();
    const watchdog = window.setInterval(syncPlayer, 150);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      detachPlayer?.();
    };
  }, [playerRef, hasItems, timelineId]);

  const projectMarkers = useMemo(
    () => (state.markers ?? []).filter((marker) => marker.scope === 'project'),
    [state.markers],
  );

  const seekToFrame = (frame: number) => {
    if (!hasItems) return;
    const clamped = Math.max(0, Math.min(maxSeekFrame, Math.round(frame)));
    paintDomRef.current(clamped, true);
    if (onSeek) onSeek(clamped);
    else playerRef.current?.seekTo(clamped);
  };

  const scrubAtClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || !hasItems) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = (clientX - rect.left) / rect.width;
    seekToFrame(frameFromTrackRatio(ratio, spanFrames));
  };

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasItems || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.cc-preview-marker-pin')) return;
    event.preventDefault();
    if (shuttleRate !== 0) invokeAction('shuttle-pause', undefined, 'toolbar');
    try { playerRef.current?.pause(); } catch { /* ignore */ }
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubAtClientX(event.clientX);
  };

  const handleTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    scrubAtClientX(event.clientX);
  };

  const handleTrackPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleTrackKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasItems || event.ctrlKey || event.metaKey || event.altKey) return;
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      seekToFrame(currentFrameRef.current - step);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      seekToFrame(currentFrameRef.current + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      seekToFrame(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seekToFrame(maxSeekFrame);
    }
  };

  const handleExportStill = async () => {
    if (!hasItems || exportingStill) return;
    setExportingStill(true);
    try {
      let liveFrame: number | undefined;
      try {
        liveFrame = playerRef.current?.getCurrentFrame?.();
      } catch { /* ignore */ }
      const targetFrame = Math.max(0, Math.min(maxSeekFrame, Math.round(liveFrame ?? currentFrameRef.current)));
      await exportCurrentStillFrame({
        state,
        project,
        timelineId,
        frame: targetFrame,
        projectName,
      });
    } catch (error) {
      showAppToast(error instanceof Error ? error.message : t('静帧导出失败'), { error: true });
    } finally {
      setExportingStill(false);
    }
  };

  const renderedFrame = hasItems ? currentFrameRef.current : 0;
  const playheadPct = hasItems ? percentOfTimelineFrame(renderedFrame, spanFrames) : 0;
  const zoneSpan = hasItems ? resolvePreviewZoneSpan(zoneIn, zoneOut, spanFrames) : null;

  return (
    <div className="cc-preview-monitor-bar" style={hidden ? { display: 'none' } : undefined}>
      <div className="cc-preview-timecode-row">
        <span ref={timecodeCurrentRef} className="cc-preview-timecode-current" title={t('当前播放头时间')}>
          {formatPreviewTimecode(renderedFrame, state.fps)}
        </span>
        <span className="cc-preview-timecode-total" title={t('视频总时长')}>
          {formatPreviewTimecode(displayDurationFrames, state.fps)}
        </span>
      </div>

      <div
        ref={trackRef}
        className={`cc-preview-scrub-track${hasItems ? '' : ' is-disabled'}`}
        role="slider"
        tabIndex={hasItems ? 0 : -1}
        aria-label={t('预览时间轴')}
        aria-valuemin={0}
        aria-valuemax={hasItems ? spanFrames : 0}
        aria-valuenow={renderedFrame}
        aria-valuetext={formatPreviewTimecode(renderedFrame, state.fps)}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
        onPointerCancel={handleTrackPointerUp}
        onKeyDown={handleTrackKeyDown}
      >
        <div className="cc-preview-scrub-ruler" aria-hidden />
        <div className="cc-preview-scrub-rail">
          <div ref={scrubFillRef} className="cc-preview-scrub-fill" style={{ width: `${playheadPct}%` }} />
          {zoneSpan && (
            <div
              className="cc-preview-zone-range"
              style={{ left: `${zoneSpan.leftPct}%`, width: `${zoneSpan.widthPct}%` }}
            />
          )}
          {hasItems && zoneIn != null && (
            <span
              className="cc-preview-zone-handle is-in"
              style={{ left: `${percentOfTimelineFrame(zoneIn, spanFrames)}%` }}
              title={`${t('入点')} ${formatPreviewTimecode(zoneIn, state.fps)}`}
            />
          )}
          {hasItems && zoneOut != null && (
            <span
              className="cc-preview-zone-handle is-out"
              style={{ left: `${percentOfTimelineFrame(zoneOut, spanFrames)}%` }}
              title={`${t('出点')} ${formatPreviewTimecode(zoneOut, state.fps)}`}
            />
          )}
          {hasItems && projectMarkers.map((marker) => (
            <button
              key={marker.id}
              type="button"
              className="cc-preview-marker-pin"
              style={{
                left: `${percentOfTimelineFrame(marker.fromFrame, spanFrames)}%`,
                ...(marker.color ? { color: MARKER_HEX[marker.color] ?? marker.color } : {}),
              }}
              title={marker.note ? `${marker.note} (${formatPreviewTimecode(marker.fromFrame, state.fps)})` : formatPreviewTimecode(marker.fromFrame, state.fps)}
              aria-label={marker.note || t('跳转到标记')}
              onClick={(event) => {
                event.stopPropagation();
                seekToFrame(marker.fromFrame);
              }}
            />
          ))}
        </div>
        {hasItems && (
          <div ref={scrubThumbRef} className="cc-preview-scrub-thumb" style={{ left: `${playheadPct}%` }} aria-hidden />
        )}
      </div>

      <div className="cc-preview-transport">
        <div className="cc-preview-transport-side cc-preview-transport-left">
          <button
            type="button"
            className="cc-preview-transport-icon cc-tip"
            data-tip={t('添加标记 ({key})', { key: markerKey })}
            aria-label={t('添加标记 ({key})', { key: markerKey })}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invokeAction('marker-add', undefined, 'toolbar')}
          >
            <Icon name="bookmark" size={14} />
          </button>
          <button
            type="button"
            className={`cc-preview-transport-icon cc-tip${zoneIn != null ? ' is-active' : ''}`}
            data-tip={t('标记入点 ({inKey}) · {clearKey} 取消', { inKey: zoneInKey, clearKey: zoneClearInKey })}
            aria-label={t('标记入点 ({key})', { key: zoneInKey })}
            aria-pressed={zoneIn != null}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => invokeAction(event.shiftKey ? 'zone-clear-in' : 'zone-in', undefined, 'toolbar')}
          >
            <Icon name="markIn" size={14} />
          </button>
          <button
            type="button"
            className={`cc-preview-transport-icon cc-tip${zoneOut != null ? ' is-active' : ''}`}
            data-tip={t('标记出点 ({outKey}) · {clearKey} 取消', { outKey: zoneOutKey, clearKey: zoneClearOutKey })}
            aria-label={t('标记出点 ({key})', { key: zoneOutKey })}
            aria-pressed={zoneOut != null}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => invokeAction(event.shiftKey ? 'zone-clear-out' : 'zone-out', undefined, 'toolbar')}
          >
            <Icon name="markOut" size={14} />
          </button>
          {(zoneIn != null || zoneOut != null) && (
            <button
              type="button"
              className="cc-preview-transport-icon cc-preview-zone-clear-btn cc-tip"
              data-tip={t('清除入出点 ({key})', { key: zoneClearKey })}
              aria-label={t('清除入出点 ({key})', { key: zoneClearKey })}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => invokeAction('zone-clear', undefined, 'toolbar')}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>

        <div className="cc-preview-transport-center">
          <button
            type="button"
            className={`cc-preview-transport-icon cc-preview-shuttle-btn cc-tip${shuttleRate < 0 ? ' is-active' : ''}`}
            data-tip={shuttleRate < 0 ? t('快退 {rate}× ({key})', { rate: Math.abs(shuttleRate), key: shuttleBackKey }) : t('快退 ({key})', { key: shuttleBackKey })}
            aria-label={shuttleRate < 0 ? t('快退 {rate}× ({key})', { rate: Math.abs(shuttleRate), key: shuttleBackKey }) : t('快退 ({key})', { key: shuttleBackKey })}
            aria-pressed={shuttleRate < 0}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invokeAction('shuttle-back', undefined, 'toolbar')}
          >
            <Icon name="fastRewind" size={13} />
            {shuttleRate < 0 && <span className="cc-preview-rate-tag">{Math.abs(shuttleRate)}×</span>}
          </button>
          <button
            type="button"
            className="cc-preview-transport-icon cc-tip"
            data-tip={t('后退一帧 ({key})', { key: seekBackKey })}
            aria-label={t('后退一帧 ({key})', { key: seekBackKey })}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invokeAction('seek-back', undefined, 'toolbar')}
          >
            <Icon name="prev" size={14} />
          </button>
          <button
            type="button"
            className="cc-timeline-play-button cc-preview-play-button cc-tip"
            data-tip={isTransportActive ? t('暂停 ({key})', { key: playPauseKey }) : t('播放 ({key})', { key: playPauseKey })}
            aria-label={isTransportActive ? t('暂停 ({key})', { key: playPauseKey }) : t('播放 ({key})', { key: playPauseKey })}
            aria-pressed={isTransportActive}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invokeAction('play-pause', undefined, 'toolbar')}
          >
            <Icon name={isTransportActive ? 'pause' : 'play'} size={15} />
          </button>
          <button
            type="button"
            className="cc-preview-transport-icon cc-tip"
            data-tip={t('前进一帧 ({key})', { key: seekFwdKey })}
            aria-label={t('前进一帧 ({key})', { key: seekFwdKey })}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invokeAction('seek-fwd', undefined, 'toolbar')}
          >
            <Icon name="next" size={14} />
          </button>
          <button
            type="button"
            className={`cc-preview-transport-icon cc-preview-shuttle-btn cc-tip${shuttleRate > 1 ? ' is-active' : ''}`}
            data-tip={shuttleRate > 1 ? t('快进 {rate}× ({key})', { rate: shuttleRate, key: shuttleFwdKey }) : t('快进 ({key})', { key: shuttleFwdKey })}
            aria-label={shuttleRate > 1 ? t('快进 {rate}× ({key})', { rate: shuttleRate, key: shuttleFwdKey }) : t('快进 ({key})', { key: shuttleFwdKey })}
            aria-pressed={shuttleRate > 1}
            disabled={!hasItems}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => invokeAction('shuttle-fast-forward', undefined, 'toolbar')}
          >
            <Icon name="fastForward" size={13} />
            {shuttleRate > 1 && <span className="cc-preview-rate-tag">{shuttleRate}×</span>}
          </button>
        </div>

        <div className="cc-preview-transport-side cc-preview-transport-right">
          <button
            type="button"
            className="cc-preview-transport-icon cc-tip"
            data-tip={exportingStill ? t('正在导出静帧…') : t('导出静帧画面')}
            aria-label={t('导出静帧画面')}
            disabled={!hasItems || exportingStill}
            onClick={() => { void handleExportStill(); }}
          >
            <Icon name="camera" size={15} />
          </button>
          {hasItems && <PreviewSourceToggle />}
          {onToggleAudioMeter && (
            <button
              type="button"
              className={`cc-preview-transport-icon cc-preview-audio-meter-toggle cc-tip${audioMeterOpen ? ' is-active' : ''}`}
              data-tip={audioMeterOpen ? t('收起音量电平') : t('音量电平')}
              aria-label={t('音量电平')}
              aria-pressed={audioMeterOpen}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onToggleAudioMeter}
            >
              <Icon name="audioMeter" size={15} />
            </button>
          )}
          <button
            type="button"
            className="cc-preview-transport-icon cc-tip cc-tip-r"
            data-tip={t('全屏预览 ({key})', { key: fullscreenKey })}
            aria-label={t('全屏预览 ({key})', { key: fullscreenKey })}
            onClick={() => invokeAction('fullscreen', undefined, 'toolbar')}
          >
            <Icon name="fullscreen" size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
