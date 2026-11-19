import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '../editor/types';
import type { MediaSourceRange } from '../editor/mediaSourceRange';
import type { MediaPlacementPurpose } from './placementPurpose';
import { setMediaAssetDrag } from './drag';

function SourceSecondsInput({ label, frame, fps, maxFrame, onChange }: {
  label: string; frame: number; fps: number; maxFrame: number; onChange: (frame: number) => void;
}) {
  const [value, setValue] = useState((frame / fps).toFixed(3));
  useEffect(() => setValue((frame / fps).toFixed(3)), [frame, fps]);
  const commit = () => {
    const parsed = Number(value);
    if (value.trim() && Number.isFinite(parsed)) onChange(Math.max(0, Math.min(maxFrame, Math.round(parsed * fps))));
    setValue((frame / fps).toFixed(3));
  };
  return <label>{label}<span><input aria-label={label} type="number" min={0} max={maxFrame / fps}
    step={1 / fps} value={value} onChange={(event) => setValue(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /> 秒</span></label>;
}

/** One original-source player; marking never modifies the asset or the project. */
export function MediaSourceRangePanel({ asset, fps, range, purpose, onChange, onAdd, onClose }: {
  asset: MediaAsset; fps: number; range: MediaSourceRange; purpose?: MediaPlacementPurpose;
  onChange: (range: MediaSourceRange) => void; onAdd: () => void; onClose: () => void;
}) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [currentFrame, setCurrentFrame] = useState(range.srcInFrame);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = Math.max(1, Math.round(asset.durationInFrames));
  const end = range.srcInFrame + range.durationInFrames;
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    const media = mediaRef.current;
    // StrictMode replays effects without restoring a src removed by cleanup.
    if (media && !media.getAttribute('src')) { media.src = asset.src; media.load(); }
    return () => { if (media) { media.pause(); media.removeAttribute('src'); media.load(); } };
  }, [asset.src]);
  const seek = (frame: number) => {
    const next = Math.max(0, Math.min(total - 1, frame));
    setCurrentFrame(next);
    if (mediaRef.current) mediaRef.current.currentTime = next / fps;
  };
  const setIn = (frame: number) => {
    const start = Math.min(total - 1, Math.max(0, frame));
    onChange({ srcInFrame: start, durationInFrames: Math.max(start + 1, end) - start });
  };
  const setOut = (frame: number) => {
    const stop = Math.max(1, Math.min(total, frame));
    const start = Math.min(range.srcInFrame, stop - 1);
    onChange({ srcInFrame: start, durationInFrames: stop - start });
  };
  const togglePlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (!media.paused) media.pause();
    else {
      if (media.currentTime * fps < range.srcInFrame || media.currentTime * fps >= end - 0.5) seek(range.srcInFrame);
      void media.play().catch(() => setError('原片暂时无法播放；可以重试，或关闭选段后重新关联素材。'));
    }
  };
  return <section ref={rootRef} className="cc-source-range" aria-label="素材选段预览" tabIndex={0}
    data-cc-shortcut-surface="source-range"
    onKeyDown={(event) => {
      // Do not let source I/O, arrows, or space affect the timeline behind the panel.
      event.stopPropagation();
      if ((event.target as HTMLElement).closest('input, textarea, select') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === 'i') { event.preventDefault(); setIn(currentFrame); }
      else if (event.key.toLowerCase() === 'o') { event.preventDefault(); setOut(currentFrame + 1); }
      else if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); mediaRef.current?.pause(); seek(currentFrame + (event.key === 'ArrowLeft' ? -1 : 1)); }
      else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    }}>
    <header><strong title={asset.name}>选段 · {asset.name}</strong><button type="button" onClick={onClose} aria-label="关闭选段预览">收起</button></header>
    <video ref={mediaRef} src={asset.src} preload="metadata" playsInline aria-label={`${asset.name} 原片预览`}
      className={asset.kind === 'audio' ? 'is-audio' : undefined}
      onLoadedMetadata={() => { setError(null); seek(range.srcInFrame); }}
      onTimeUpdate={() => {
        const media = mediaRef.current;
        if (!media) return;
        const frame = Math.max(0, Math.min(total - 1, Math.floor(media.currentTime * fps + 0.001)));
        setCurrentFrame(frame);
        if (!media.paused && media.currentTime * fps >= end) { media.pause(); seek(end - 1); }
      }}
      onPlay={() => { setError(null); setPlaying(true); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => setError('原片预览失败，请检查素材是否仍在原位置。此处不会修改工程。')} />
    {asset.kind === 'audio' && <div className="cc-source-audio-label">音频选段 · 可播放试听</div>}
    <div className="cc-source-range-playback"><button type="button" onClick={togglePlay}>{playing ? '暂停' : '播放选段'}</button>
      <output>{(currentFrame / fps).toFixed(3)} 秒 · 第 {currentFrame + 1} 帧</output></div>
    <input className="cc-source-scrubber" aria-label="原片播放位置" type="range" min={0} max={total - 1} step={1}
      value={currentFrame} onChange={(event) => { mediaRef.current?.pause(); seek(Number(event.target.value)); }} />
    <div className="cc-source-range-marks">
      <div><button type="button" onClick={() => setIn(currentFrame)}>设为入点 I</button><SourceSecondsInput label="入点" frame={range.srcInFrame} fps={fps} maxFrame={total - 1} onChange={setIn} /></div>
      <div><button type="button" onClick={() => setOut(currentFrame + 1)}>设为出点 O</button><SourceSecondsInput label="出点" frame={end} fps={fps} maxFrame={total} onChange={setOut} /></div>
    </div>
    <p>已选 {(range.durationInFrames / fps).toFixed(3)} 秒 · 第 {range.srcInFrame + 1}–{end} 帧 / 共 {total} 帧（工程 {fps} fps）</p>
    <div className="cc-source-range-actions">
      <button type="button" className="cc-source-range-add" onClick={onAdd} draggable onDragStart={(event) => {
        mediaRef.current?.pause(); setMediaAssetDrag(event, asset, [asset.id], purpose, { [asset.id]: range });
      }}>加入选段 · 也可拖到轨道</button>
      <button type="button" onClick={() => onChange({ srcInFrame: 0, durationInFrames: total })}>恢复整段</button>
    </div>
    <small>仅取所选区间；原文件不变。拖到主轨插入，拖到上方画面轨叠加。</small>
    {error && <div role="alert" className="cc-source-range-error">{error}<button type="button" onClick={() => { setError(null); mediaRef.current?.load(); }}>重试预览</button></div>}
  </section>;
}
