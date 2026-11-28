import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { CallbackListener, PlayerRef } from '@remotion/player';
import type { ProjectDoc, TimelineState } from '../../editor/types';
import { useT } from '../../i18n/locale';
import {
  AUDIO_METER_FLOOR_DB,
  AUDIO_METER_TICKS,
  decibelsToMeterPercent,
  formatAudioMeterDb,
  getOrLoadAudioStereoEnvelope,
  measureTimelineAudioLevelAtFrame,
  SILENT_AUDIO_LEVEL_READING,
  type AudioLevelReading,
} from './previewAudioLevelMeterState';

interface PreviewAudioLevelMeterProps {
  state: TimelineState;
  project: ProjectDoc;
  timelineId: string;
  playerRef: RefObject<PlayerRef | null>;
  hoverPreviewFrame?: number | null;
}

export function PreviewAudioLevelMeter({
  state,
  project,
  timelineId,
  playerRef,
  hoverPreviewFrame = null,
}: PreviewAudioLevelMeterProps) {
  const t = useT();
  const readoutRef = useRef<HTMLDivElement>(null);
  const leftFillRef = useRef<HTMLDivElement>(null);
  const rightFillRef = useRef<HTMLDivElement>(null);
  const leftClipRef = useRef<HTMLSpanElement>(null);
  const rightClipRef = useRef<HTMLSpanElement>(null);
  const currentFrameRef = useRef(0);
  const rafRef = useRef(0);

  const applyReadingToDom = (reading: AudioLevelReading) => {
    const leftInset = Math.max(0, Math.min(100, 100 - reading.leftPercent));
    const rightInset = Math.max(0, Math.min(100, 100 - reading.rightPercent));
    if (leftFillRef.current) {
      leftFillRef.current.style.clipPath = `inset(${leftInset.toFixed(1)}% 0 0 0)`;
    }
    if (rightFillRef.current) {
      rightFillRef.current.style.clipPath = `inset(${rightInset.toFixed(1)}% 0 0 0)`;
    }
    if (leftClipRef.current) {
      leftClipRef.current.classList.toggle('is-clipping', reading.clippingLeft);
    }
    if (rightClipRef.current) {
      rightClipRef.current.classList.toggle('is-clipping', reading.clippingRight);
    }
    if (readoutRef.current) {
      readoutRef.current.textContent = formatAudioMeterDb(reading.peakDb);
      readoutRef.current.classList.toggle('is-clipping', reading.clipping);
    }
  };

  const paintAtFrame = (frame: number) => {
    const clampedFrame = Math.max(0, Math.round(frame));
    currentFrameRef.current = clampedFrame;
    if (state.items.length === 0) {
      applyReadingToDom(SILENT_AUDIO_LEVEL_READING);
      return;
    }
    const reading = measureTimelineAudioLevelAtFrame({
      state,
      project,
      timelineId,
      frame: clampedFrame,
      resolveEnvelope: (src, kind, revision) =>
        getOrLoadAudioStereoEnvelope(src, kind, revision, () => {
          schedulePaint(currentFrameRef.current);
        }),
    });
    applyReadingToDom(reading);
  };

  const paintAtFrameRef = useRef(paintAtFrame);
  paintAtFrameRef.current = paintAtFrame;

  const schedulePaint = (frame: number) => {
    currentFrameRef.current = Math.max(0, Math.round(frame));
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      paintAtFrameRef.current(currentFrameRef.current);
    });
  };

  useLayoutEffect(() => {
    const targetFrame = hoverPreviewFrame !== null
      ? hoverPreviewFrame
      : (playerRef.current?.getCurrentFrame?.() ?? currentFrameRef.current);
    paintAtFrameRef.current(targetFrame);
  }, [state, project, timelineId, hoverPreviewFrame, playerRef]);

  useEffect(() => {
    let attachedPlayer: PlayerRef | null = null;
    let detachPlayer: (() => void) | null = null;

    const attach = (player: PlayerRef) => {
      try {
        paintAtFrameRef.current(player.getCurrentFrame?.() ?? 0);
      } catch {
        // Ignore detached player read
      }
      const onFrameUpdate: CallbackListener<'frameupdate'> = (event) => {
        schedulePaint(event.detail.frame);
      };
      const onSettled = (event: { detail?: { frame?: number } }) => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        const nextFrame = typeof event?.detail?.frame === 'number'
          ? event.detail.frame
          : (player.getCurrentFrame?.() ?? currentFrameRef.current);
        paintAtFrameRef.current(nextFrame);
      };
      player.addEventListener('frameupdate', onFrameUpdate);
      player.addEventListener('seeked', onSettled);
      player.addEventListener('pause', onSettled);
      player.addEventListener('ended', onSettled);
      return () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
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
      if (!player) paintAtFrameRef.current(0);
    };

    syncPlayer();
    const watchdog = window.setInterval(syncPlayer, 150);
    return () => {
      window.clearInterval(watchdog);
      detachPlayer?.();
    };
  }, [playerRef, timelineId]);

  return (
    <aside
      className="cc-preview-audio-meter"
      role="region"
      aria-label={t('音量电平')}
    >
      <div
        ref={readoutRef}
        className="cc-preview-audio-meter-db"
        title={t('当前音量分贝 (dB)')}
      >
        -∞
      </div>

      <div className="cc-preview-audio-meter-clip-row" title={t('爆音指示灯 (达到或超过 0 dB 时亮红灯)')}>
        <span ref={leftClipRef} className="cc-preview-audio-meter-clip" aria-label={t('左声道爆音指示')} />
        <span ref={rightClipRef} className="cc-preview-audio-meter-clip" aria-label={t('右声道爆音指示')} />
      </div>

      <div className="cc-preview-audio-meter-body">
        <div className="cc-preview-audio-meter-bars">
          <div className="cc-preview-audio-meter-bar-track" aria-label={t('左声道电平')}>
            <div
              ref={leftFillRef}
              className="cc-preview-audio-meter-bar-fill"
              style={{ clipPath: 'inset(100% 0 0 0)' }}
            />
          </div>
          <div className="cc-preview-audio-meter-bar-track" aria-label={t('右声道电平')}>
            <div
              ref={rightFillRef}
              className="cc-preview-audio-meter-bar-fill"
              style={{ clipPath: 'inset(100% 0 0 0)' }}
            />
          </div>
        </div>

        <div className="cc-preview-audio-meter-scale" aria-hidden="true">
          {AUDIO_METER_TICKS.map((tick) => {
            const topPct = 100 - decibelsToMeterPercent(tick, AUDIO_METER_FLOOR_DB);
            return (
              <span
                key={tick}
                className={`cc-preview-audio-meter-tick${tick === 0 ? ' is-zero' : ''}`}
                style={{ top: `${topPct}%` }}
              >
                {tick}
              </span>
            );
          })}
        </div>
      </div>

      <div className="cc-preview-audio-meter-channels" aria-hidden="true">
        <span>L</span>
        <span>R</span>
      </div>
    </aside>
  );
}
