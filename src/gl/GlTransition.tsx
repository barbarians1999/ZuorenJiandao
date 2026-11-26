import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AbsoluteFill, Img, Video, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame, useVideoConfig } from 'remotion';
import { createGlRuntime, type GlRuntime } from './runtime';
import { cubeSettled, ensureCube } from './fx/cube';
import { disposeRuntimeSlot, ensureRuntimeSlot } from './runtimeSlot';
import { buildEffectShaderFrame, buildTransitionShaderFrame } from './shaderFrame';
import { glPreviewFailureReason } from './previewAdapter';
import type { SelectedPreviewFallbackReason, SelectedPreviewStatusListener } from './previewAdapter';
import { GLSL_TRANSITIONS } from './transitions';
import { glEffects } from './clipEffects';
import type { AspectFit, GlslTransitionType, TimelineItem, TransitionDirection } from '../editor/types';
import { backgroundFillAppearanceFor, backgroundFillFilter } from '../editor/backgroundFill';
import { appearanceAt, type ClipAppearance, clipOpacityAt } from '../editor/clipFade';
import { pictureAnimationAt } from '../editor/clipAnimation';
import { videoReadyAtFrame } from './sourceReadiness';
import { zoomAt } from '../editor/zoom';
import { paintTransitionPlacement, transitionPlacementRequired } from './transitionPlacement';
import { applyClipMaskFeatherCanvas, clipMaskCanvas, resolveMaskAt, type ResolvedClipMask } from '../editor/clipMask';
import { withOpenEndedPreviewHash } from '../media/nativePlaybackGuard';

// One GLSL transition window straddling the cut from R to R+L. A muted,
// frame-synced media pair feeds 2D staging canvases, each clip's ordered effect
// graph, then the transition shader in one WebGL context. TimelineComposition's
// effect-aware CSS composition remains visible until the exact GL frame is ready.
// DOM clips (MG/text) stay on that CSS path because they cannot be textured.

interface GlTransitionProps {
  type: GlslTransitionType | 'custom-shader';
  direction: TransitionDirection;
  /** type='custom-shader': the submit_shader-generated two-input GLSL (from the item) + its
   *  uniform values. When present, rendered instead of a GLSL_TRANSITIONS built-in. */
  customFrag?: string;
  customUniforms?: Record<string, number>;
  /** transition length in frames */
  L: number;
  /** absolute timeline frame where the window starts (for u_time) */
  windowStart: number;
  outgoing: TimelineItem;
  incoming: TimelineItem;
  /** source in-points (frames) for each clip at the window start */
  trimOut: number;
  trimIn: number;
  width: number;
  height: number;
  fit: AspectFit;
  outgoingBackgroundFill?: boolean;
  incomingBackgroundFill?: boolean;
  previewTargetId?: string;
  onReadyChange?: (ready: boolean) => void;
  onPreviewStatus?: SelectedPreviewStatusListener;
}

type MediaEl = HTMLVideoElement | HTMLImageElement;

const isReady = (el: MediaEl, sourceFrame: number, fps: number): boolean =>
  el instanceof HTMLVideoElement ? videoReadyAtFrame(el, sourceFrame, fps) : el.complete;

function mediaSize(el: MediaEl): { width: number; height: number } {
  return el instanceof HTMLVideoElement
    ? { width: el.videoWidth, height: el.videoHeight }
    : { width: el.naturalWidth, height: el.naturalHeight };
}

function drawPlaced(ctx: CanvasRenderingContext2D, el: MediaEl, fit: AspectFit, overscan = 1): void {
  const source = mediaSize(el);
  if (!source.width || !source.height) return;
  const scale = (fit === 'cover'
    ? Math.max(ctx.canvas.width / source.width, ctx.canvas.height / source.height)
    : Math.min(ctx.canvas.width / source.width, ctx.canvas.height / source.height)) * overscan;
  const width = source.width * scale;
  const height = source.height * scale;
  ctx.drawImage(el, (ctx.canvas.width - width) / 2, (ctx.canvas.height - height) / 2, width, height);
}

function drawMediaFrame(
  ctx: CanvasRenderingContext2D,
  el: MediaEl,
  fit: AspectFit,
  item: TimelineItem,
  backgroundFill: boolean,
  opacity: number,
  mask: ResolvedClipMask | undefined,
  featherCanvas: HTMLCanvasElement,
  localFrame: number,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.globalAlpha = opacity;
  clipMaskCanvas(ctx, mask, ctx.canvas.width, ctx.canvas.height);
  const drawForeground = (foregroundFit: AspectFit) => {
    ctx.save();
    if (item.zoom) {
      const zoom = zoomAt(item.zoom, localFrame, item.durationInFrames);
      const x = zoom.focalX * ctx.canvas.width, y = zoom.focalY * ctx.canvas.height;
      ctx.translate(x, y); ctx.scale(zoom.magnification, zoom.magnification); ctx.translate(-x, -y);
    }
    drawPlaced(ctx, el, foregroundFit);
    ctx.restore();
  };
  if (!backgroundFill) {
    drawForeground(fit);
    applyClipMaskFeatherCanvas(ctx, mask, ctx.canvas.width, ctx.canvas.height, featherCanvas);
    ctx.restore();
    return;
  }
  const appearance = backgroundFillAppearanceFor(item, ctx.canvas.width, ctx.canvas.height);
  const filters = item.filters;
  ctx.save();
  ctx.filter = backgroundFillFilter(appearance, filters);
  drawPlaced(ctx, el, 'cover', appearance.overscanScale);
  ctx.restore();
  ctx.save();
  ctx.filter = `brightness(${filters?.brightness ?? 1}) contrast(${filters?.contrast ?? 1}) saturate(${filters?.saturate ?? 1}) blur(${filters?.blur ?? 0}px)`;
  drawForeground('contain');
  ctx.restore();
  applyClipMaskFeatherCanvas(ctx, mask, ctx.canvas.width, ctx.canvas.height, featherCanvas);
  ctx.restore();
}

function MediaSource({ item, trim, fit, elRef }: { item: TimelineItem; trim: number; fit: AspectFit; elRef: React.MutableRefObject<MediaEl | null> }) {
  const { fps } = useVideoConfig();
  const isRendering = getRemotionEnvironment().isRendering;
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: fit };
  if (item.kind === 'image') {
    // impeccable-disable-next-line broken-image -- Remotion Img component, src comes from item runtime injection
    return <Img ref={elRef as React.MutableRefObject<HTMLImageElement | null>} src={item.src!} style={style} />;
  }
  // Muted: the original clip sequences own audio; this element only feeds GL textures.
  return (
    <Video
      ref={elRef as React.MutableRefObject<HTMLVideoElement | null>}
      src={isRendering ? item.src! : withOpenEndedPreviewHash(item.src!)}
      trimBefore={trim}
      playbackRate={item.playbackRate ?? 1}
      acceptableTimeShiftInSeconds={isRendering ? 0.5 / fps : 1.5}
      muted
      style={style}
    />
  );
}

/** Move the already-masked picture, not its source time or its audio. */
function animatedTransitionSource(source: HTMLCanvasElement, slot: { canvas: HTMLCanvasElement | null }, item: TimelineItem, frame: number): HTMLCanvasElement {
  const motion = pictureAnimationAt(item, frame);
  const appearance: ClipAppearance = appearanceAt(item, frame, false, source);
  if (!transitionPlacementRequired(appearance, motion.blur)) return source;
  const destination = slot.canvas ?? (slot.canvas = document.createElement('canvas'));
  if (destination.width !== source.width) destination.width = source.width;
  if (destination.height !== source.height) destination.height = source.height;
  const ctx = destination.getContext('2d');
  if (!ctx) throw new Error('transition animation staging context unavailable');
  paintTransitionPlacement(ctx, source, appearance, motion.blur);
  return destination;
}

export function GlTransition({ type, direction, L, windowStart, outgoing, incoming, trimOut, trimIn, width, height, fit, outgoingBackgroundFill = false, incomingBackgroundFill = false, customFrag, customUniforms, previewTargetId, onPreviewStatus, onReadyChange }: GlTransitionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<GlRuntime | null>(null);
  const outRef = useRef<MediaEl | null>(null);
  const inRef = useRef<MediaEl | null>(null);
  const failedAdapterRef = useRef<{ definitionKey: string; reason: SelectedPreviewFallbackReason } | null>(null);
  const hasRenderedFrameRef = useRef(false);
  const [hasRenderedFrame, setHasRenderedFrame] = useState(false);

  // 2D staging canvases: clip pixels with contain/cover layout → GL texture source
  const staging = useMemo(() => {
    const make = () => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      return c;
    };
    return { out: make(), in: make(), outMask: make(), inMask: make(), outMotion: { canvas: null as HTMLCanvasElement | null }, inMotion: { canvas: null as HTMLCanvasElement | null } };
  }, [width, height]);

  // custom-shader: build the def from the item's stored GLSL; built-ins come from the registry.
  // Memoized so the def keeps a stable identity across the per-frame renders below.
  const def = useMemo(
    () => (type === 'custom-shader'
      ? (customFrag ? { frag: customFrag, uniforms: () => customUniforms ?? {} } : undefined)
      : GLSL_TRANSITIONS[type]),
    [type, customFrag, customUniforms],
  );
  const outgoingEffects = useMemo(() => glEffects(outgoing), [outgoing]);
  const incomingEffects = useMemo(() => glEffects(incoming), [incoming]);
  const definitionKey = useMemo(
    () => [
      def?.frag ?? '',
      ...outgoingEffects.map(({ def: effect }) => effect.frag),
      ...incomingEffects.map(({ def: effect }) => effect.frag),
    ].join('\u0000'),
    [def?.frag, incomingEffects, outgoingEffects],
  );

  useEffect(() => {
    if (!onPreviewStatus || !previewTargetId) return;
    const targetId = previewTargetId;
    return () => {
      onPreviewStatus({
        kind: 'transition',
        targetId,
        adapter: 'gl-transition',
        phase: 'inactive',
      });
    };
  }, [onPreviewStatus, previewTargetId]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !def) return;
    // Headless export waits for both sources and LUTs. Player preview keeps the
    // effect-aware timeline composition visible until an exact GL frame exists.
    const blockForExport = getRemotionEnvironment().isRendering;
    const handle = blockForExport ? delayRender(`gl-transition ${type} f${frame}`) : null;
    let done = false;
    let raf = 0;
    const report = (phase: 'waiting' | 'ready' | 'fallback', fallbackReason?: SelectedPreviewFallbackReason) => {
      onReadyChange?.(phase === 'ready');
      if (!previewTargetId || !onPreviewStatus) return;
      onPreviewStatus({
        kind: 'transition',
        targetId: previewTargetId,
        adapter: phase === 'ready' ? 'gl-transition' : 'css-transition',
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
    const hideCanvas = () => {
      canvas.style.opacity = '0';
      if (hasRenderedFrameRef.current) {
        hasRenderedFrameRef.current = false;
        setHasRenderedFrame(false);
      }
    };
    const priorFailure = failedAdapterRef.current?.definitionKey === definitionKey
      ? failedAdapterRef.current.reason
      : null;
    if (priorFailure) {
      hideCanvas();
      report('fallback', priorFailure);
      finish();
      return () => finish();
    }
    const activeEffects = [...outgoingEffects, ...incomingEffects];
    for (const { def: effect } of activeEffects) {
      if (effect.cube) void ensureCube(effect.cube);
    }
    let waitingReported = false;
    const reportWaiting = () => {
      if (waitingReported) return;
      waitingReported = true;
      report('fallback', 'media-loading');
    };
    const tick = () => {
      const outgoingSource = outRef.current;
      const incomingSource = inRef.current;
      if (!outgoingSource || !incomingSource
        || !isReady(outgoingSource, trimOut + frame * (outgoing.playbackRate ?? 1), fps)
        || !isReady(incomingSource, trimIn + frame * (incoming.playbackRate ?? 1), fps)
        || activeEffects.some(({ def: effect }) => effect.cube && !cubeSettled(effect.cube))) {
        hideCanvas();
        reportWaiting();
        raf = requestAnimationFrame(tick);
        return;
      }
      try {
        const runtime = ensureRuntimeSlot(runtimeRef, () => createGlRuntime(canvas));
        const outgoingContext = staging.out.getContext('2d');
        const incomingContext = staging.in.getContext('2d');
        if (!outgoingContext || !incomingContext) throw new Error('2d context unavailable');
        const absoluteFrame = windowStart + frame;
        const outgoingOpacity = clipOpacityAt(outgoing, absoluteFrame - outgoing.startFrame);
        const incomingOpacity = clipOpacityAt(incoming, absoluteFrame - incoming.startFrame);
        const outgoingMask = resolveMaskAt(outgoing, absoluteFrame - outgoing.startFrame, { width, height });
        const incomingMask = resolveMaskAt(incoming, absoluteFrame - incoming.startFrame, { width, height });
        drawMediaFrame(
          outgoingContext,
          outgoingSource,
          fit,
          outgoing,
          outgoingBackgroundFill,
          1, // Opacity is applied once after the effect passes, below.
          outgoingMask,
          staging.outMask,
          absoluteFrame - outgoing.startFrame,
        );
        drawMediaFrame(
          incomingContext,
          incomingSource,
          fit,
          incoming,
          incomingBackgroundFill,
          1,
          incomingMask,
          staging.inMask,
          absoluteFrame - incoming.startFrame,
        );
        const transitionFrame = buildTransitionShaderFrame(def, {
          sequenceFrame: frame,
          durationInFrames: L,
          windowStartFrame: windowStart,
          fps,
          width,
          height,
          direction,
        });
        const outgoingFrame = buildEffectShaderFrame(
          outgoingEffects.map(({ fx, def: effect }) => ({ def: effect, overrides: fx.overrides })),
          absoluteFrame - outgoing.startFrame,
          fps,
        );
        const incomingFrame = buildEffectShaderFrame(
          incomingEffects.map(({ fx, def: effect }) => ({ def: effect, overrides: fx.overrides })),
          absoluteFrame - incoming.startFrame,
          fps,
        );
        runtime.renderTransitionWithFx(
          transitionFrame.frag,
          animatedTransitionSource(staging.out, staging.outMotion, outgoing, absoluteFrame - outgoing.startFrame),
          animatedTransitionSource(staging.in, staging.inMotion, incoming, absoluteFrame - incoming.startFrame),
          outgoingFrame.passes,
          incomingFrame.passes,
          transitionFrame.progress,
          transitionFrame.uniforms,
          { outgoing: outgoingOpacity, incoming: incomingOpacity },
        );
        canvas.style.opacity = '1';
        if (!hasRenderedFrameRef.current) {
          hasRenderedFrameRef.current = true;
          setHasRenderedFrame(true);
        }
        report('ready');
      } catch (error) {
        const reason = glPreviewFailureReason(error);
        failedAdapterRef.current = { definitionKey, reason };
        disposeRuntimeSlot(runtimeRef);
        hideCanvas();
        report('fallback', reason);
        console.error('[gl-transition]', error);
      }
      finish();
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      finish();
    };
  }, [
    definitionKey, def, direction, fit, fps, frame, height, incoming, incomingBackgroundFill,
    incomingEffects, L, onPreviewStatus, onReadyChange, outgoing, outgoingBackgroundFill, outgoingEffects,
    previewTargetId, staging, type, width, windowStart, trimOut, trimIn,
  ]);

  useEffect(() => () => {
    disposeRuntimeSlot(runtimeRef);
  }, [width, height, def?.frag]);

  return (
    <AbsoluteFill>
      <AbsoluteFill aria-hidden style={{ opacity: 0, pointerEvents: 'none' }}>
        <AbsoluteFill>
          <MediaSource item={outgoing} trim={trimOut} fit={fit} elRef={outRef} />
        </AbsoluteFill>
        <AbsoluteFill>
          <MediaSource item={incoming} trim={trimIn} fit={fit} elRef={inRef} />
        </AbsoluteFill>
      </AbsoluteFill>
      <canvas
        data-gl-transition={type}
        ref={canvasRef}
        width={width}
        height={height}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: hasRenderedFrame ? 1 : 0,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
}
