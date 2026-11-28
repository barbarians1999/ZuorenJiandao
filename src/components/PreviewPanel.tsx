import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Player, Thumbnail, type CallbackListener, type PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import type { CompositionMosaic } from '../editor/compositionMosaic';
import type { SelectedPreviewStatus, SelectedPreviewStatusListener } from '../gl/previewAdapter';
import {
  captionTrackEntries,
  type MediaAsset,
  type ProjectDoc,
  type ClipTransform,
  type ClipMask,
  type ClipEffect,
  type KeyframeEasing,
  type KeyframeProp,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import { isTimelineMediaAssetKind } from '../editor/mediaTypes';
import { useSelectionRefMode } from '../agent/selection-refs';
import { RegionPickOverlay } from './preview/RegionPickOverlay';
import { CaptionPreviewEditor } from '../captions/CaptionPreviewEditor';
import type { CaptionSelectionRef } from '../captions/captionSelection';
import type { CaptionsData } from '../captions/types';
import {
  onCaptionStylePointerDrop,
  type CaptionStyleDragPayload,
} from '../captions/captionStyleDrag';
import { appendDroppedManualCaption } from '../captions/manualCaptions';
import { Icon } from './icons';
import { useT } from '../i18n/locale';
import { invokeAction } from '../shortcuts/actionRegistry';
import { type ReviewOpenRequest } from '../review/ReviewCommentsButton';
import { usePreviewProjectDoc } from '../media/previewMedia';
import { loadTimelineView } from '../persist/sessionPrefs';
import { PreviewProxyStatus } from './preview/PreviewSourceControls';
import { PreviewMonitorBar } from './preview/PreviewMonitorBar';
import { PreviewAudioLevelMeter } from './preview/PreviewAudioLevelMeter';
import type { SlipPreview } from '../editor/slip';
import { SlipTwoUpPreview } from './SlipTwoUpPreview';
import { PREVIEW_SHARED_AUDIO_TAGS } from './previewAudioPool';
import { SafeZoneOverlay } from './SafeZoneOverlay';
import { PreviewTransformOverlay } from './preview/PreviewTransformOverlay';
import { PreviewMaskOverlay } from './preview/PreviewMaskOverlay';
import { PreviewMosaicOverlay } from './preview/PreviewMosaicOverlay';
import { fitPreviewCanvasSize, previewPaddedClientSize, previewStageContentSize, type PreviewCanvasSize } from './preview/previewCanvasGeometry';
import { SourceAssetPreview } from './preview/SourceAssetPreview';
import { resolvePreviewRenderProject, resolveSelectedPreviewTargetId } from './preview/previewRenderProject';
import { PreviewPlaybackRateContext } from '../editor/PreviewPlaybackContext';
import { PLAYBACK_RATE_EVENT, SHUTTLE_STATE_EVENT } from './timeline/shuttle';

const MEDIA_LOADING_NOTICE_DELAY_MS = 160;

function previewStatusKey(status: Pick<SelectedPreviewStatus, 'kind' | 'targetId'>): string {
  return `${status.kind}\u0000${status.targetId}`;
}

interface PreviewPanelProps {
  maskEditing?: boolean;
  mosaicEditing?: boolean;
  selectedMosaicEffectId?: string | null;
  onSelectMosaicEffect?: (effectId: string) => void;
  onSetItemMask?: (id: string, mask: ClipMask | null) => void;
  onSetCompositionMosaic?: (id: string, patch: Partial<CompositionMosaic>) => void;
  onSetItemEffects?: (id: string, effects: ClipEffect[]) => void;
  state: TimelineState;
  project: ProjectDoc;
  playerRef: RefObject<PlayerRef | null>;
  onImport: (file: File) => Promise<void>;
  offlineSrcs?: ReadonlySet<string>;
  /** Direct editing of canvas captions (check box + floating toolbar). If it has not been transmitted (such as proposal preview status), it is read-only. */
  onUpdateCaptions?: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onLiveCaptionsPreview?: (trackId: TrackId, patch: Partial<CaptionsData> | null) => void;
  onSelectCaption?: (selection: CaptionSelectionRef | null) => void;
  activeCaptionSelection?: CaptionSelectionRef | null;
  onSelectItem?: (id: string | null) => void;
  onSetItemTransform?: (id: string, patch: ClipTransform) => void;
  onSetItemKeyframe?: (id: string, prop: KeyframeProp, localFrame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe?: (id: string, prop: KeyframeProp, localFrame: number) => void;
  onSeek?: (frame: number) => void;
  onBeginHistoryGesture?: () => void;
  onEndHistoryGesture?: () => void;
  onItemPropChange?: (id: string, key: string, value: unknown) => void;
  projectId: string;
  timelineId: string;
  reviewState: TimelineState;
  selectedItem: TimelineItem | null;
  reviewRequest?: ReviewOpenRequest | null;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  selectedPreviewStatuses?: readonly SelectedPreviewStatus[];
  onSelectedPreviewStatus?: SelectedPreviewStatusListener;
  slipPreview?: SlipPreview | null;
  hoverPreviewFrame?: number | null;
  timelineScrubbing?: boolean;
  previewAsset?: MediaAsset | null;
  onClosePreviewAsset?: () => void;
  onAddPreviewAsset?: (asset: MediaAsset) => void;
  zoneIn?: number | null;
  zoneOut?: number | null;
  projectName?: string;
}

export const PreviewPanel = memo(function PreviewPanel({
  maskEditing = false, mosaicEditing = false, selectedMosaicEffectId = null, onSelectMosaicEffect, onSetItemMask, onSetItemEffects, onSetCompositionMosaic,
  state, project, playerRef, onImport, offlineSrcs, onUpdateCaptions, onLiveCaptionsPreview, onSelectCaption, activeCaptionSelection,
  onSelectItem, onSetItemTransform, onSetItemKeyframe, onRemoveItemKeyframe, onSeek, onBeginHistoryGesture, onEndHistoryGesture,
  onItemPropChange,
  projectId, timelineId, reviewState: _reviewState, selectedItem, reviewRequest: _reviewRequest, inspectorOpen: _inspectorOpen, onToggleInspector: _onToggleInspector,
  selectedPreviewStatuses, onSelectedPreviewStatus, slipPreview,
  hoverPreviewFrame = null, timelineScrubbing = false,
  previewAsset = null, onClosePreviewAsset, onAddPreviewAsset,
  zoneIn = null, zoneOut = null, projectName,
}: PreviewPanelProps) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const renderProject = useMemo<ProjectDoc>(
    () => resolvePreviewRenderProject(project, timelineId, state),
    [project, state, timelineId],
  );
  const preview = usePreviewProjectDoc(renderProject, timelineId, { playing });
  const duration = preview.plan.durationInFrames;
  const hasItems = state.items.length > 0;
  const savedPlayhead = useMemo(
    () => hasItems ? loadTimelineView(projectId, timelineId)?.playhead ?? 0 : 0,
    [hasItems, projectId, timelineId],
  );
  const [hiddenCaptionKeys, setHiddenCaptionKeys] = useState<Record<string, string | null>>({});
  const selectedPreviewTargetId = useMemo(
    () => resolveSelectedPreviewTargetId(selectedItem, preview.state.transitions),
    [selectedItem, preview.state.transitions],
  );
  const playerInputProps = useMemo(() => ({
    state: preview.state,
    project: preview.project,
    timelineId,
    selectedItemId: selectedPreviewTargetId,
    hiddenCaptionKeys,
    onSelectedPreviewStatus,
    previewAudioEnabled: !timelineScrubbing,
  }), [preview.state, preview.project, timelineId, selectedPreviewTargetId, hiddenCaptionKeys, onSelectedPreviewStatus, timelineScrubbing]);
  const thumbnailInputProps = useMemo(() => ({
    state: preview.state,
    project: preview.project,
    timelineId,
    hiddenCaptionKeys,
    previewAudioEnabled: false,
  }), [preview.state, preview.project, timelineId, hiddenCaptionKeys]);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<PreviewCanvasSize>({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [shuttleRate, setShuttleRate] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  useEffect(() => {
    const onRate = (event: Event) => {
      const rate = (event as CustomEvent<{ rate?: number }>).detail?.rate;
      setPlaybackRate(typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1);
    };
    const onShuttle = (event: Event) => {
      const rate = (event as CustomEvent<{ rate?: number }>).detail?.rate;
      setShuttleRate(typeof rate === 'number' && Number.isFinite(rate) ? rate : 0);
    };
    window.addEventListener(PLAYBACK_RATE_EVENT, onRate);
    window.addEventListener(SHUTTLE_STATE_EVENT, onShuttle);
    return () => {
      window.removeEventListener(PLAYBACK_RATE_EVENT, onRate);
      window.removeEventListener(SHUTTLE_STATE_EVENT, onShuttle);
    };
  }, []);
  const [showSafe, setShowSafe] = useState(false);
  const [audioMeterOpen, setAudioMeterOpen] = useState(false);
  const [autoEditCaption, setAutoEditCaption] = useState<{ trackId: TrackId; laneId: string } | null>(null);
  // Expose Player during full screen preview (` shortcut key/timeline toolbar button to make Player full screen)
  // Comes with a control bar; the editing state still uses the timeline transport, and does not display dual sets of controls.
  // Must listen to Remotion's own fullscreenchange: it walks the webkit legacy API in Chrome,
  // The document standard event is not guaranteed to be triggered, the SDK emitter is the real source.
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const playerStyle = useMemo(
    () => ({ width: '100%', height: '100%', backgroundColor: fullscreen ? '#000' : undefined }),
    [fullscreen],
  );
  const transformApi = onSelectItem && onSetItemTransform && onSetItemKeyframe && onRemoveItemKeyframe && onSeek
    && onBeginHistoryGesture && onEndHistoryGesture
    ? {
      onSelectItem,
      onSetItemTransform,
      onSetItemKeyframe,
      onRemoveItemKeyframe,
      onSeek,
      onBeginHistoryGesture,
      onEndHistoryGesture,
      onItemPropChange,


    }
    : null;
  const previewCanvasSize = fitPreviewCanvasSize(stageSize, {
    width: state.width,
    height: state.height,
  });
  const shaderFallbacks = useMemo(
    () => (selectedPreviewStatuses ?? []).filter((status) => status.phase === 'fallback' || status.phase === 'waiting')
      .map((status) => status.phase === 'waiting' ? { ...status, fallbackReason: 'media-loading' as const } : status),
    [selectedPreviewStatuses],
  );
  const durableShaderFallback = shaderFallbacks.find((status) => status.fallbackReason !== 'media-loading');
  const mediaLoadingFallbacks = useMemo(
    () => shaderFallbacks.filter((status) => status.fallbackReason === 'media-loading'),
    [shaderFallbacks],
  );
  const mediaLoadingKeys = useMemo(
    () => mediaLoadingFallbacks.map(previewStatusKey).sort(),
    [mediaLoadingFallbacks],
  );
  const mediaLoadingStartedAtRef = useRef(new Map<string, number>());
  const [visibleMediaLoading, setVisibleMediaLoading] = useState<{ key: string; startedAt: number } | null>(null);
  useEffect(() => {
    const startedAt = mediaLoadingStartedAtRef.current;
    const activeKeys = new Set(mediaLoadingKeys);
    for (const key of startedAt.keys()) {
      if (!activeKeys.has(key)) startedAt.delete(key);
    }
    const now = Date.now();
    for (const key of mediaLoadingKeys) {
      if (!startedAt.has(key)) startedAt.set(key, now);
    }
    let nextKey: string | undefined;
    let nextVisibleAt = Number.POSITIVE_INFINITY;
    for (const key of mediaLoadingKeys) {
      const visibleAt = startedAt.get(key)! + MEDIA_LOADING_NOTICE_DELAY_MS;
      if (visibleAt < nextVisibleAt) {
        nextKey = key;
        nextVisibleAt = visibleAt;
      }
    }
    if (!nextKey) return undefined;
    const nextStartedAt = startedAt.get(nextKey)!;
    const timeout = window.setTimeout(
      () => setVisibleMediaLoading({ key: nextKey, startedAt: nextStartedAt }),
      Math.max(0, nextVisibleAt - now),
    );
    return () => window.clearTimeout(timeout);
  }, [mediaLoadingKeys]);
  const visibleMediaLoadingFallback = mediaLoadingFallbacks.find((status) => {
    const key = previewStatusKey(status);
    if (!visibleMediaLoading || key !== visibleMediaLoading.key) return false;
    return mediaLoadingStartedAtRef.current.get(key) === visibleMediaLoading.startedAt;
  });
  const visibleShaderFallback = durableShaderFallback ?? visibleMediaLoadingFallback;
  const offlineNames = [...new Set(renderProject.timelines
    .filter((timeline) => preview.plan.timelineIds.includes(timeline.id))
    .flatMap((timeline) => timeline.items)
    .filter((item) => !!item.src && offlineSrcs?.has(item.src))
    .map((item) => item.name))];
  useEffect(() => {
    const player = playerRef.current;
    if (!player) { setPlaying(false); return; }
    const onChange: CallbackListener<'fullscreenchange'> = (e) => {
      fullscreenRef.current = e.detail.isFullscreen;
      setFullscreen(e.detail.isFullscreen);
    };
    const ensureUnmutedWhenHiddenControls = () => {
      if (fullscreenRef.current) return;
      try {
        if (player.isMuted?.()) player.unmute?.();
      } catch {
        // Ignore detached Player errors.
      }
    };
    const onPlay = () => {
      setPlaying(true);
      ensureUnmutedWhenHiddenControls();
    };
    const onPause = () => { setPlaying(false); setPlaybackRate(1); };
    const onMuteChange: CallbackListener<'mutechange'> = (e) => {
      if (e.detail.isMuted && !fullscreenRef.current) {
        try {
          if (player.isPlaying?.()) player.unmute?.();
        } catch {
          // Ignore detached Player errors.
        }
      }
    };
    player.addEventListener('fullscreenchange', onChange);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onPause);
    player.addEventListener('mutechange', onMuteChange);
    try { setPlaying(!!player.isPlaying?.()); } catch { setPlaying(false); }
    return () => {
      player.removeEventListener('fullscreenchange', onChange);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onPause);
      player.removeEventListener('mutechange', onMuteChange);
    };
  }, [playerRef, hasItems, timelineId]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const apply = (next: PreviewCanvasSize) => {
      if (next.width <= 0 || next.height <= 0) return;
      setStageSize((current) => (
        current.width === next.width && current.height === next.height ? current : next
      ));
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(previewStageContentSize(entry));
    });
    observer.observe(stage);
    const style = getComputedStyle(stage);
    apply(previewPaddedClientSize(
      { width: stage.clientWidth, height: stage.clientHeight },
      {
        left: Number.parseFloat(style.paddingLeft) || 0,
        right: Number.parseFloat(style.paddingRight) || 0,
        top: Number.parseFloat(style.paddingTop) || 0,
        bottom: Number.parseFloat(style.paddingBottom) || 0,
      },
    ));
    return () => observer.disconnect();
  }, []);
  // Selection mode (canvas-region-marked): drag a marquee → region reference
  const pickMode = useSelectionRefMode();
  useEffect(() => {
    if (!previewAsset) return;
    invokeAction('shuttle-pause', undefined, 'toolbar');
    playerRef.current?.pause();
  }, [previewAsset, playerRef]);
  const importFiles = async (files: FileList | File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try { for (const file of Array.from(files)) await onImport(file); }
    finally { setBusy(false); }
  };
  const dropCaptionStyle = (payload: CaptionStyleDragPayload | null, clientX: number, clientY: number): boolean => {
    const box = videoBoxRef.current;
    const entry = captionTrackEntries(state).find(({ id }) => id === payload?.trackId);
    if (!payload || !box || !entry?.captions || !onUpdateCaptions) return false;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const startMs = ((playerRef.current?.getCurrentFrame() ?? 0) / state.fps) * 1000;
    const dropped = appendDroppedManualCaption(entry.captions, state.items, payload.template, t('双击编辑字幕'), startMs, {
      anchor: 'middle-center', offsetXRatio: x - 0.5, offsetYRatio: y - 0.5,
    });
    if (!dropped) return false;
    playerRef.current?.pause();
    onUpdateCaptions(dropped.patch, payload.trackId);
    setAutoEditCaption({ trackId: payload.trackId, laneId: dropped.laneId });
    return true;
  };
  const dropCaptionStyleRef = useRef(dropCaptionStyle);
  dropCaptionStyleRef.current = dropCaptionStyle;
  useEffect(() => onCaptionStylePointerDrop(({ payload, clientX, clientY }) => {
    dropCaptionStyleRef.current(payload, clientX, clientY);
  }), []);
  return (
    <section
      className="cc-preview-panel"
      data-cc-shortcut-surface="preview"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        const active = document.activeElement;
        if (active instanceof HTMLElement && !event.currentTarget.contains(active)
          && !target.closest('input, select, textarea, [contenteditable="true"]')) {
          active.blur();
        }
        if (!target.closest('button, input, select, textarea, [contenteditable="true"], [role="slider"]')) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      style={{ display: 'flex', flex: 1, flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}
    >
      <div className="cc-preview-header" style={{ height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', borderBottom: `0.5px solid ${theme.border}`, flexShrink: 0 }}>
        {previewAsset ? (
          <>
            <span className="cc-preview-source-pill">{t('素材预览')}</span>
            <span className="cc-preview-spec cc-preview-source-name" title={previewAsset.name} style={{ marginLeft: 8, fontSize: 11.5, color: theme.text }}>
              {previewAsset.name}
            </span>
            {previewAsset.width && previewAsset.height ? (
              <span className="cc-preview-spec" style={{ marginLeft: 8, fontSize: 11, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>
                {previewAsset.width} × {previewAsset.height}
              </span>
            ) : null}
            <div className="cc-preview-header-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              {onAddPreviewAsset && isTimelineMediaAssetKind(previewAsset.kind) && (
                <button
                  type="button"
                  className="cc-preview-source-btn is-primary"
                  onClick={() => onAddPreviewAsset(previewAsset)}
                >
                  {t('加入时间线')}
                </button>
              )}
              <button
                type="button"
                className="cc-preview-source-btn"
                onClick={() => onClosePreviewAsset?.()}
              >
                {t('返回时间线')}
              </button>
            </div>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: theme.text }}>{t('预览')}</span>
            <span className="cc-preview-spec" style={{ marginLeft: 10, fontSize: 11, color: theme.textDim, fontVariantNumeric: 'tabular-nums' }}>
              {state.width} × {state.height} · {state.fps} fps
            </span>
            {pickMode && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 10, fontSize: 11, color: theme.accent }}>
                <Icon name="cursor" size={11} />
                {t('选择模式：在画面上拖框选区作为引用')}
              </span>
            )}
            <div className="cc-preview-header-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              {state.items.length > 0 && (
                <button type="button" onClick={() => setShowSafe((v) => !v)} aria-pressed={showSafe}
                  title={t('切换安全区参考框')}
                  style={{
                    fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                    border: `0.5px solid ${theme.border}`, background: showSafe ? theme.panelAlt : 'transparent',
                    color: showSafe ? theme.text : theme.textDim,
                  }}>
                  {t('安全框')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {previewAsset && (
        <SourceAssetPreview
          key={previewAsset.id}
          asset={previewAsset}
          fps={state.fps}
          onClose={() => onClosePreviewAsset?.()}
          onAdd={onAddPreviewAsset}
        />
      )}
      {!previewAsset && <PreviewProxyStatus proxies={preview.proxies} />}
      <div className="cc-preview-stage-row" style={previewAsset ? { display: 'none' } : undefined}>
      <div ref={stageRef} className="cc-preview-stage"
        style={previewAsset ? { display: 'none' } : undefined}
        // Suppress the browser's native <video> context menu (download / picture-in-picture
        // / loop) because the preview is a canvas, not an exposed HTML5 video element.
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onDrop={(event) => { event.preventDefault(); void importFiles(event.dataTransfer.files); }}>
        {state.items.length === 0 ? (
          <>
            <input ref={inputRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ''; }} />
            <button className="cc-preview-empty" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={24} />
              <span>{busy ? t('正在导入媒体…') : t('点击导入或拖拽媒体到这里')}</span>
            </button>
          </>
        ) : (
          // Wrapper carries the sizing so the safe-zone overlay lines up exactly
          // on the video rect (Player fills the wrapper).
          <div ref={videoBoxRef} className="cc-preview-canvas" style={{
            position: 'relative',
            width: previewCanvasSize.width || (state.width >= state.height ? '100%' : 'auto'),
            height: previewCanvasSize.height || (state.width >= state.height ? 'auto' : '100%'),
            aspectRatio: `${state.width} / ${state.height}`,
          }} onErrorCapture={(event) => {
            if (!(event.target instanceof HTMLVideoElement)) return;
            const failedUrl = event.target.currentSrc || event.target.src;
            const failedBase = failedUrl.split('#')[0];
            const source = preview.proxies.find(({ src, proxy }) => {
              const urls = [src, proxy.status === 'ready' ? proxy.previewSrc : ''].filter(Boolean);
              return urls.some((url) => new URL(url, window.location.href).href.split('#')[0] === failedBase);
            });
            if (source) preview.requestFallback(source.src);
          }}>
            <PreviewPlaybackRateContext.Provider value={playbackRate}>
              <Player
                ref={playerRef}
                component={TimelineComposition}
                inputProps={playerInputProps}
                durationInFrames={duration}
                initialFrame={Math.min(savedPlayhead, duration - 1)}
                fps={state.fps}
                compositionWidth={state.width}
                compositionHeight={state.height}
                playbackRate={playbackRate}
                numberOfSharedAudioTags={PREVIEW_SHARED_AUDIO_TAGS}
                // Full screen black: WebKit legacy full screen div does not automatically blacken the background, and the page checkerboard will be revealed on both sides.
                style={playerStyle}
                controls={fullscreen}
                // Playback runs only through the timeline transport
                // (play/pause button + Space shortcut), not the player itself. clickToPlay
                // off = clicking the frame doesn't toggle; spaceKeyToPlayOrPause off = the app
                // shortcut is the single Space handler (the Player's own handler would
                // double-toggle it to a no-op).
                clickToPlay={fullscreen}
                spaceKeyToPlayOrPause={false}
                _experimentalKeepAudioContextAlive
                acknowledgeRemotionLicense
                // No loop: playback stops at the final frame (editor convention).
                // Restart by pressing play again.
                moveToBeginningWhenEnded={false}
              />
            </PreviewPlaybackRateContext.Provider>
            {!playing && !timelineScrubbing && !fullscreen && hoverPreviewFrame !== null && (
              <div className="cc-preview-hover-frame" aria-label={t('时间线悬停预览')}>
                <Thumbnail
                  component={TimelineComposition}
                  inputProps={thumbnailInputProps}
                  frameToDisplay={hoverPreviewFrame}
                  durationInFrames={duration}
                  fps={state.fps}
                  compositionWidth={state.width}
                  compositionHeight={state.height}
                  style={{ display: 'block', width: '100%', aspectRatio: `${state.width} / ${state.height}` }}
                />
              </div>
            )}
            {slipPreview && <SlipTwoUpPreview preview={slipPreview} />}
            {offlineNames.length > 0 && (
              <div role="status" className="cc-preview-canvas-status is-offline">
                {t('离线素材：{list}', { list: offlineNames.join('、') })}
              </div>
            )}
            {visibleShaderFallback && (
              <div role="status" aria-live="polite" className="cc-preview-canvas-status is-fallback">
                {visibleShaderFallback.fallbackReason === 'media-loading'
                  ? t('正在加载效果预览；暂时显示回退画面')
                  : visibleShaderFallback.adapter === 'css-transition'
                    ? t('着色器预览已回退为 CSS 近似；当前画面不代表导出效果')
                    : t('着色器预览不可用；当前显示未处理源画面')}
              </div>
            )}
            {!visibleShaderFallback && (state.items.some((item) => item.effects?.length)
              || state.items.some((item) => item.kind === 'sequence')
              || state.transitions?.some((transition) => transition.enabled !== false)) && (
              <div role="status" data-preview-fidelity="on-demand" className="cc-preview-canvas-status is-fidelity">
                {selectedItem?.kind === 'sequence'
                  ? t('嵌套序列轻量预览')
                  : t('轻量预览 · 选中片段看精确效果')}
              </div>
            )}
            {showSafe && <SafeZoneOverlay />}
            {pickMode && <RegionPickOverlay state={state} playerRef={playerRef} />}
            {!pickMode && !fullscreen && transformApi && (
              maskEditing && onSetItemMask
                ? <PreviewMaskOverlay state={state} playerRef={playerRef} playing={playing} onSetItemMask={onSetItemMask} {...transformApi} />
                : mosaicEditing && onSetItemEffects
                  ? <PreviewMosaicOverlay state={state} playerRef={playerRef} playing={playing}
                      selectedEffectId={selectedMosaicEffectId}
                      onSelectEffect={onSelectMosaicEffect}
                      onSetItemEffects={onSetItemEffects}
                      onBeginHistoryGesture={transformApi.onBeginHistoryGesture} onEndHistoryGesture={transformApi.onEndHistoryGesture} />
                : <PreviewTransformOverlay state={state} playerRef={playerRef} playing={playing} captionActive={Boolean(activeCaptionSelection)} {...transformApi} onSetItemMask={onSetItemMask} onSetCompositionMosaic={onSetCompositionMosaic} />
            )}
            {!maskEditing && !mosaicEditing && !pickMode && !fullscreen && onUpdateCaptions && captionTrackEntries(state).map(({ id, captions }) => captions?.enabled ? (
              <CaptionPreviewEditor
                key={id}
                trackId={id}
                state={state}
                captions={captions}
                playerRef={playerRef}
                playing={playing}
                onUpdateCaptions={(patch) => onUpdateCaptions(patch, id)}
                onLivePreview={onLiveCaptionsPreview ? (patch) => onLiveCaptionsPreview(id, patch) : undefined}
                onActiveTargetChange={(key) => setHiddenCaptionKeys((prev) => (prev[id] ?? null) === key ? prev : { ...prev, [id]: key })}
                onSelectCaption={onSelectCaption}
                activeSelection={activeCaptionSelection}
                autoEditLaneId={autoEditCaption?.trackId === id ? autoEditCaption.laneId : undefined}
                onAutoEditHandled={() => setAutoEditCaption(null)}
              />
            ) : null)}
          </div>
        )}
      </div>
      {audioMeterOpen && !fullscreen && !previewAsset && (
        <PreviewAudioLevelMeter
          state={preview.state}
          project={preview.project}
          timelineId={timelineId}
          playerRef={playerRef}
          hoverPreviewFrame={hoverPreviewFrame}
        />
      )}
      </div>
      <PreviewMonitorBar
        state={state}
        project={project}
        projectName={projectName}
        timelineId={timelineId}
        playerRef={playerRef}
        duration={duration}
        playing={playing}
        shuttleRate={shuttleRate}
        zoneIn={zoneIn}
        zoneOut={zoneOut}
        hidden={Boolean(previewAsset)}
        onSeek={onSeek}
        audioMeterOpen={audioMeterOpen}
        onToggleAudioMeter={() => setAudioMeterOpen((v) => !v)}
      />
    </section>
  );
});
