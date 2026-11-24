import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, cancelRender, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { Video as MediaVideo } from '@remotion/media';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildEffectShaderFrame } from './shaderFrame';
import { glPreviewFailureReason } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import type { AspectFit, ClipEffectValue, TimelineItem } from '../editor/types';
import { sourceFrameAt } from '../editor/sourceLimit';
import { glEffects } from './clipEffects';
import { hasPrivacyMosaic, mosaicEffectsAt, mosaicPresentation } from '../editor/mosaic';

// One video/image clip rendered through a builtin:fx-* single-input WebGL pass.
// Mounts a hidden, frame-synced media
// element (Remotion keeps it accurate in preview AND headless render),
// rasterizes it to a 2D staging canvas with the clip's contain/cover layout,
// then runs the effect's fragment shader to the visible canvas (with alpha, so
// luma-key etc. composite over lower tracks). Registered effects are flattened
// into one ordered pass graph, preserving the clip's effects[] order.

interface ClipFxProps {
  item: TimelineItem;
  fit: AspectFit;
  width: number;
  height: number;
  frameOffset?: number;
  onPreviewStatus?: SelectedPreviewStatusListener;
}

const PREVIEW_MAX_EDGE = 960;
const PIXEL_OVERRIDE_KEYS = new Set([
  'feather',
  'block_size',
  'blockSize',
  'blurRadius',
  'border_width',
  'corner_radius',
]);
const GAUSSIAN_BLUR_ASSET_IDS = new Set([
  'builtin:fx-local-gaussian-blur',
  'builtin:fx-gaussian-blur',
]);

function scalePreviewOverrides(
  assetId: string,
  overrides: Record<string, ClipEffectValue> | undefined,
  scale: number,
): Record<string, ClipEffectValue> | undefined {
  if (scale >= 1 || !overrides) return overrides;
  let changed = false;
  const next: Record<string, ClipEffectValue> = { ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (PIXEL_OVERRIDE_KEYS.has(key) || (key === 'strength' && GAUSSIAN_BLUR_ASSET_IDS.has(assetId))) {
      next[key] = value * scale;
      changed = true;
    }
  }
  return changed ? next : overrides;
}

// contain/cover placement matching MediaFill's objectFit, so GL frames align
// with the rest of the composition.
function drawFit(ctx: CanvasRenderingContext2D, source: CanvasImageSource, fit: AspectFit): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const dimensions = source as CanvasImageSource & {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    width?: number;
    height?: number;
  };
  const nw = dimensions.videoWidth
    ?? dimensions.naturalWidth
    ?? dimensions.displayWidth
    ?? dimensions.width
    ?? 0;
  const nh = dimensions.videoHeight
    ?? dimensions.naturalHeight
    ?? dimensions.displayHeight
    ?? dimensions.height
    ?? 0;
  ctx.clearRect(0, 0, W, H);
  if (!nw || !nh) return;
  const scale = fit === 'cover' ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
  const dw = nw * scale;
  const dh = nh * scale;
  ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

export function ClipFx({ item, fit, width, height, frameOffset = 0, onPreviewStatus }: ClipFxProps) {
  const frame = useCurrentFrame() + frameOffset;
  const { fps } = useVideoConfig();
  const isRendering = getRemotionEnvironment().isRendering;
  const protectedSource = hasPrivacyMosaic(item);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceLayerRef = useRef<HTMLDivElement | null>(null);
  const protectionLayerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const failedAdapterRef = useRef<{ definitionKey: string; reason: SelectedPreviewFallbackReason } | null>(null);
  const stagedRenderKeyRef = useRef<string | null>(null);
  const hasRenderedRef = useRef(false);
  const renderedKeyRef = useRef<string | null>(null);
  const [hasRendered, setHasRendered] = useState(false);
  const [privacyFailure, setPrivacyFailure] = useState(false);
  const trimBefore = sourceFrameAt(item, frameOffset);

  const previewScale = !isRendering && Math.max(width, height) > PREVIEW_MAX_EDGE
    ? PREVIEW_MAX_EDGE / Math.max(width, height)
    : 1;
  const renderW = previewScale < 1 ? Math.max(2, Math.round((width * previewScale) / 2) * 2) : width;
  const renderH = previewScale < 1 ? Math.max(2, Math.round((height * previewScale) / 2) * 2) : height;

  const staging = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = renderW;
    c.height = renderH;
    return c;
  }, [renderW, renderH]);

  const active = useMemo(() => glEffects({ ...item, effects: mosaicEffectsAt(item, frame, fit, { width, height }) }), [item, frame, fit, width, height]);
  const definitionKey = useMemo(
    () => active.map(({ def }) => `${def.id}:${def.frag}`).join('\u0000'),
    [active],
  );
  // Shader parameter changes do not require another decoded video frame.
  // A paused MediaVideo does not emit onVideoFrame again just for a slider.
  const mediaKey = useMemo(
    () => JSON.stringify([item.src, trimBefore, item.playbackRate, frame, fit, renderW, renderH]),
    [item.src, trimBefore, item.playbackRate, frame, fit, renderW, renderH],
  );
  const renderKey = useMemo(
    () => JSON.stringify([mediaKey, active.map(({ fx }) => [fx.id, fx.overrides])]),
    [mediaKey, active],
  );
  const onVideoFrame = useCallback(
    (source: CanvasImageSource) => {
      const ctx = staging.getContext('2d');
      if (!ctx) return;
      drawFit(ctx, source, fit);
      stagedRenderKeyRef.current = mediaKey;
    },
    [fit, mediaKey, staging],
  );

  useEffect(() => {
    if (!onPreviewStatus) return;
    const targetId = item.id;
    return () => {
      onPreviewStatus({
        kind: 'effect',
        targetId,
        adapter: 'gl-effect',
        phase: 'inactive',
      });
    };
  }, [item.id, onPreviewStatus]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || active.length === 0) return;
    const handle = isRendering ? delayRender(`clip-fx ${active.map(({ def }) => def.id).join(',')}`) : null;
    let done = false;
    let raf = 0;
    const report = (phase: 'waiting' | 'ready' | 'fallback', fallbackReason?: SelectedPreviewFallbackReason) => {
      onPreviewStatus?.({
        kind: 'effect',
        targetId: item.id,
        adapter: 'gl-effect',
        phase,
        fallbackReason,
      });
    };
    const finish = () => {
      if (!done && handle != null) {
        done = true;
        continueRender(handle);
      }
    };
    const priorFailure = failedAdapterRef.current?.definitionKey === definitionKey
      ? failedAdapterRef.current.reason
      : null;
    if (priorFailure) {
      report('fallback', priorFailure);
      if (protectedSource && isRendering) cancelRender(new Error(`Mosaic could not render: ${priorFailure}`));
      finish();
      return () => finish();
    }
    let waitingReported = false;
    const reportWaiting = () => {
      if (waitingReported) return;
      waitingReported = true;
      report('fallback', 'media-loading');
    };
    // .cube LUT is loaded first; tick waits until loading has settled. A failed
    // LUT is an intentional pass-through with intensity=0 in fxPasses().
    for (const { def } of active) if (def.cube) void ensureCube(def.cube);
    const tick = () => {
      const decodedVideo = item.kind !== 'image';
      const mediaReady = decodedVideo
        ? stagedRenderKeyRef.current === mediaKey
        : !!imageRef.current?.complete;
      if (!mediaReady) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      if (active.some(({ def }) => def.cube && !cubeSettled(def.cube))) { reportWaiting(); raf = requestAnimationFrame(tick); return; }
      try {
        const runtime = ensureRuntimeSlot(runtimeRef, () => createGlRuntime(canvas));
        const ctx = staging.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        if (!decodedVideo && imageRef.current) drawFit(ctx, imageRef.current, fit);
        const shaderFrame = buildEffectShaderFrame(
          active.map(({ fx, def }) => ({ def, overrides: scalePreviewOverrides(def.id, fx.overrides, previewScale) })),
          frame,
          fps,
        );
        runtime.renderFxChain(shaderFrame.passes, staging);
        renderedKeyRef.current = renderKey;
        // Make the freshly drawn canvas authoritative before unblocking export;
        // React state then preserves the same choice for subsequent renders.
        canvas.style.opacity = '1';
        if (sourceLayerRef.current) sourceLayerRef.current.style.opacity = '0';
        if (protectionLayerRef.current) protectionLayerRef.current.style.display = 'none';
        if (!isRendering && !hasRenderedRef.current) {
          hasRenderedRef.current = true;
          setHasRendered(true);
        }
        report('ready');
      } catch (error) {
        const reason = glPreviewFailureReason(error);
        failedAdapterRef.current = { definitionKey, reason };
        disposeRuntimeSlot(runtimeRef);
        report('fallback', reason);
        console.error('[clip-fx]', error);
        if (protectedSource) {
          renderedKeyRef.current = null;
          canvas.style.opacity = '0';
          if (protectionLayerRef.current) protectionLayerRef.current.style.display = 'flex';
          setPrivacyFailure(true);
          if (isRendering) cancelRender(error instanceof Error ? error : new Error(String(error)));
        }
      }
      finish();
    };
    tick();
    return () => { cancelAnimationFrame(raf); finish(); };
  }, [active, definitionKey, fit, staging, item.id, item.kind, frame, fps, isRendering, mediaKey, renderKey, previewScale, onPreviewStatus, protectedSource]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [renderW, renderH, definitionKey]);

  // Once any GL frame has been drawn, keep the canvas visible across seeks:
  // falling back to the raw source layer would flash the UNFILTERED frame for
  // the 1-2 frames until the new frame's shader pass is ready. The first
  // (never-drawn) load still falls back to the honest source while media loads.
  const showingShaderFrame = hasRendered && (!protectedSource || renderedKeyRef.current === renderKey);
  const presentation = mosaicPresentation({ protectedSource, readyForCurrentFrame: showingShaderFrame });
  if (active.length === 0) return <AbsoluteFill>
    {item.kind === 'image'
      // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
      ? <Img src={item.src!} style={{ width: '100%', height: '100%', objectFit: fit }} />
      : <MediaVideo src={item.src!} trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} muted
          headless={isRendering} style={{ width: '100%', height: '100%' }} objectFit={fit} />}
  </AbsoluteFill>;
  return (
    <AbsoluteFill>
      {protectedSource && <AbsoluteFill ref={protectionLayerRef} style={{ display: presentation.showProtection ? 'flex' : 'none', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14 }}>
        {privacyFailure ? '打码暂不可用，已隐藏画面；可关闭后重新应用' : '正在准备打码画面…'}
      </AbsoluteFill>}
      {/* The source is the honest Player fallback while media/GL is unavailable.
          Once this exact frame+parameter key is drawn, only the GL canvas shows. */}
      <AbsoluteFill ref={sourceLayerRef} style={{ opacity: presentation.showSource ? 1 : 0, pointerEvents: 'none' }}>
        {item.kind === 'image'
          // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
          ? <Img ref={imageRef} src={item.src!} style={{ width: '100%', height: '100%', objectFit: fit }} />
          : <MediaVideo src={item.src!} trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} muted
              headless={isRendering} onVideoFrame={onVideoFrame} style={{ width: '100%', height: '100%' }} objectFit={fit} />}
      </AbsoluteFill>
      <canvas ref={canvasRef} width={renderW} height={renderH} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: showingShaderFrame ? 1 : 0 }} />
    </AbsoluteFill>
  );
}
