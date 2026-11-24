import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { MgThumb } from '../../media/MgThumb';
import { usePreviewMediaSource } from '../../media/previewMedia';
import { Icon } from '../icons';
import { formatSourcePreviewTime, resolveSourceSwapPlan } from './sourceAssetPreviewState';

interface SourceAssetPreviewProps {
  asset: MediaAsset;
  fps: number;
  onClose: () => void;
  onAdd?: (asset: MediaAsset) => void;
}

export function SourceAssetPreview({ asset, fps, onClose }: SourceAssetPreviewProps) {
  const t = useT();
  const isPlayable = asset.kind === 'video' || asset.kind === 'audio';
  const videoPreview = usePreviewMediaSource(asset.kind === 'video' ? asset.src : undefined);
  const effectiveVideoSrc = asset.kind === 'video' ? (videoPreview.previewSrc ?? asset.src) : undefined;
  const mediaSrc = asset.kind === 'video' ? effectiveVideoSrc : asset.kind === 'audio' ? asset.src : undefined;

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeMediaRef = () => (asset.kind === 'video' ? videoRef.current : audioRef.current);

  const fallbackDuration = Math.max(0, asset.durationInFrames / Math.max(1, fps));
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration);
  const [error, setError] = useState<string | null>(null);

  const prevAssetIdRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const playingRef = useRef(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  useEffect(() => {
    setError(null);
    setPlaying(false);
    setMuted(false);
    setCurrentTime(0);
    currentTimeRef.current = 0;
    playingRef.current = false;
    mutedRef.current = false;
    setDuration(Math.max(0, asset.durationInFrames / Math.max(1, fps)));
  }, [asset.id, asset.durationInFrames, fps]);

  useEffect(() => {
    if (!isPlayable) {
      prevAssetIdRef.current = asset.id;
      return undefined;
    }
    if (!mediaSrc) return undefined;
    const media = asset.kind === 'video' ? videoRef.current : audioRef.current;
    if (!media) return undefined;

    const plan = resolveSourceSwapPlan({
      prevAssetId: prevAssetIdRef.current,
      nextAssetId: asset.id,
      currentTime: media.currentTime || currentTimeRef.current,
      playing: !media.paused || playingRef.current,
      muted: mutedRef.current,
    });
    prevAssetIdRef.current = asset.id;

    let cancelled = false;
    const applyResume = () => {
      if (cancelled) return;
      media.muted = plan.muted;
      if (plan.resumeTime > 0) {
        const target = Number.isFinite(media.duration) && media.duration > 0
          ? Math.min(plan.resumeTime, Math.max(0, media.duration - 0.05))
          : plan.resumeTime;
        media.currentTime = target;
        currentTimeRef.current = target;
        setCurrentTime(target);
      } else {
        media.currentTime = 0;
      }
      if (plan.shouldPlay) {
        void media.play().catch(() => setPlaying(false));
      } else {
        media.pause();
        setPlaying(false);
      }
    };

    media.muted = plan.muted;
    const srcChanged = media.getAttribute('src') !== mediaSrc;
    if (srcChanged) {
      media.src = mediaSrc;
      media.load();
    }
    if (!srcChanged && media.readyState >= 1) {
      applyResume();
    } else {
      media.addEventListener('loadedmetadata', applyResume, { once: true });
    }

    return () => {
      cancelled = true;
      media.removeEventListener('loadedmetadata', applyResume);
      currentTimeRef.current = media.currentTime || currentTimeRef.current;
      playingRef.current = !media.paused;
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, [asset.id, asset.kind, isPlayable, mediaSrc]);

  const togglePlay = useCallback(() => {
    const media = asset.kind === 'video' ? videoRef.current : audioRef.current;
    if (!media) return;
    if (!media.paused) {
      media.pause();
      return;
    }
    if (Number.isFinite(media.duration) && media.duration > 0 && media.currentTime >= media.duration - 0.05) {
      media.currentTime = 0;
    }
    void media.play().catch(() => setPlaying(false));
  }, [asset.kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === ' ' && isPlayable && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('input, textarea, select, [contenteditable="true"], [data-cc-shortcut-surface="timeline"], [data-cc-shortcut-surface="inspector"], [data-cc-shortcut-surface="agent-input"]')) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isPlayable, onClose, togglePlay]);

  const handleMediaError = () => {
    if (asset.kind === 'video') {
      const originalFailed = effectiveVideoSrc === asset.src
        && (videoPreview.proxy.status === 'failed' || videoPreview.proxy.status === 'unavailable');
      if (!originalFailed) {
        videoPreview.requestFallback();
        return;
      }
    }
    setPlaying(false);
    setError(t('该素材暂时无法预览，请检查原文件是否存在'));
  };

  return (
    <div className="cc-source-preview-root">
      <div className="cc-preview-stage cc-source-preview-stage">
        {asset.kind === 'video' && (
          <video
            ref={videoRef}
            key={asset.id}
            poster={videoPreview.posterSrc}
            playsInline
            preload="auto"
            muted={muted}
            className="cc-source-preview-video"
            aria-label={t('素材预览：{name}', { name: asset.name })}
            onClick={togglePlay}
            onLoadedMetadata={(event) => {
              const nextDuration = event.currentTarget.duration;
              if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
            }}
            onTimeUpdate={(event) => {
              currentTimeRef.current = event.currentTarget.currentTime;
              setCurrentTime(event.currentTarget.currentTime);
            }}
            onPlay={() => { setError(null); playingRef.current = true; setPlaying(true); }}
            onPause={() => { playingRef.current = false; setPlaying(false); }}
            onEnded={() => { playingRef.current = false; setPlaying(false); }}
            onError={handleMediaError}
          />
        )}
        {asset.kind === 'audio' && (
          <div className="cc-source-preview-audio">
            <audio
              ref={audioRef}
              key={asset.id}
              preload="auto"
              muted={muted}
              onLoadedMetadata={(event) => {
                const nextDuration = event.currentTarget.duration;
                if (Number.isFinite(nextDuration) && nextDuration > 0) setDuration(nextDuration);
              }}
              onTimeUpdate={(event) => {
                currentTimeRef.current = event.currentTarget.currentTime;
                setCurrentTime(event.currentTarget.currentTime);
              }}
              onPlay={() => { setError(null); playingRef.current = true; setPlaying(true); }}
              onPause={() => { playingRef.current = false; setPlaying(false); }}
              onEnded={() => { playingRef.current = false; setPlaying(false); }}
              onError={handleMediaError}
            />
            <span className="cc-source-preview-audio-icon" aria-hidden="true">
              <Icon name="music" size={38} strokeWidth={1.5} />
            </span>
            <strong className="cc-source-preview-audio-title" title={asset.name}>{asset.name}</strong>
            <span className="cc-source-preview-audio-status">
              {playing ? t('正在试听音频素材') : t('音频素材 · 点击下方按钮播放')}
            </span>
          </div>
        )}
        {(asset.kind === 'image' || asset.kind === 'gif' || asset.kind === 'svg') && (
          <img
            src={asset.src}
            alt={asset.name}
            className="cc-source-preview-image"
            draggable={false}
            onError={() => setError(t('该素材暂时无法预览，请检查原文件是否存在'))}
          />
        )}
        {asset.kind === 'motion-graphic' && (
          <div className="cc-source-preview-mg">
            <MgThumb asset={asset} fps={fps} active />
          </div>
        )}
        {error && (
          <div className="cc-source-preview-error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="cc-preview-transport cc-source-preview-transport">
        {isPlayable ? (
          <>
            <div className="cc-preview-transport-side">
              <span className="cc-source-preview-time">
                {formatSourcePreviewTime(currentTime)} / {formatSourcePreviewTime(duration)}
              </span>
            </div>
            <div className="cc-preview-transport-center cc-source-preview-controls">
              <button
                type="button"
                className="cc-timeline-play-button cc-preview-play-button cc-tip"
                data-tip={playing ? t('暂停') : t('播放')}
                aria-label={playing ? t('暂停') : t('播放')}
                aria-pressed={playing}
                onClick={togglePlay}
              >
                <Icon name={playing ? 'pause' : 'play'} size={15} />
              </button>
              <input
                type="range"
                className="cc-source-preview-scrubber"
                aria-label={t('素材预览进度')}
                min={0}
                max={Math.max(0.01, duration)}
                step="any"
                value={Math.min(currentTime, Math.max(0.01, duration))}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setCurrentTime(next);
                  const media = activeMediaRef();
                  if (media) media.currentTime = next;
                }}
              />
            </div>
            <div className="cc-preview-transport-side cc-preview-transport-right">
              <button
                type="button"
                className="cc-preview-transport-icon cc-tip cc-tip-r"
                data-tip={muted ? t('取消静音') : t('静音')}
                aria-label={muted ? t('取消静音') : t('静音')}
                aria-pressed={muted}
                onClick={() => {
                  const next = !muted;
                  setMuted(next);
                  const media = activeMediaRef();
                  if (media) media.muted = next;
                }}
              >
                <Icon name={muted ? 'volumeOff' : 'volume'} size={15} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="cc-preview-transport-side" />
            <div className="cc-preview-transport-center">
              <span className="cc-source-preview-hint">{t('单击时间线或按 Esc 返回时间线预览')}</span>
            </div>
            <div className="cc-preview-transport-side cc-preview-transport-right" />
          </>
        )}
      </div>
    </div>
  );
}
