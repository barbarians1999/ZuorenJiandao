import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import {
  compositionMosaicMaskAsset, compositionMosaicMatrix, compositionMosaicProtectionRect, compositionMosaicSigma,
  parseCompositionMosaic, type MosaicMaskTransform,
} from './compositionMosaic';
import { appearanceAt } from './clipFade';
import { pictureAnimationAt } from './clipAnimation';
import type { TimelineItem } from './types';

const NO_TRANSFORMS: readonly MosaicMaskTransform[] = [];
const SUPPORTED_KEYFRAMES = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity']);

function MaskReadiness({ source, onReady, onError }: {
  source: string; onReady: (source: string) => void; onError: (source: string, message: string) => void;
}) {
  const [handle] = useState(() => delayRender('Preparing composition mosaic mask'));
  useEffect(() => {
    let active = true, released = false, frame = 0;
    const release = () => { if (!released) { released = true; continueRender(handle); } };
    const image = new Image(); image.src = source;
    image.decode().then(() => {
      if (!active) return;
      onReady(source);
      frame = requestAnimationFrame(release);
    }, error => {
      if (!active) return;
      onError(source, error instanceof Error ? error.message : String(error));
      release();
    });
    return () => { active = false; cancelAnimationFrame(frame); release(); };
  }, [handle, onError, onReady, source]);
  return null;
}

/** Filters this subtree's actual flattened picture; each source/audio node appears only once. */
export function CompositionMosaicSurface({ configuration, width, height, active, transforms = NO_TRANSFORMS, failureMessage, children }: {
  configuration: unknown; width: number; height: number; active: boolean; transforms?: readonly MosaicMaskTransform[];
  failureMessage?: string; children: ReactNode;
}) {
  const id = `cc-composition-mosaic-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const value = useMemo(() => parseCompositionMosaic(configuration), [configuration]);
  const sizeValid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  const matrix = useMemo(() => compositionMosaicMatrix(transforms, width, height), [height, transforms, width]);
  const mask = useMemo(() => value && sizeValid && matrix ? compositionMosaicMaskAsset(value, width, height, matrix) : null,
    [height, matrix, sizeValid, value, width]);
  const strength = value?.strength ?? 70;
  const sigma = useMemo(() => compositionMosaicSigma({ strength }), [strength]);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [handle] = useState(() => delayRender('Checking composition mosaic renderer'));
  const [ready, setReady] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ source: string; message: string } | null>(null);
  const environment = getRemotionEnvironment();
  const emptyRegion = !!value && sizeValid && !!matrix && !mask;
  const visible = active && value?.opacity !== 0 && !emptyRegion;
  const failed = visible && (!value || !sizeValid || !matrix || supported === false || failure?.source === mask?.source);
  const filtered = visible && !failed && supported === true && !!mask && ready === mask.source;
  const onReady = useCallback((source: string) => setReady(source), []);
  const onError = useCallback((source: string, message: string) => {
    setFailure({ source, message });
    if (getRemotionEnvironment().isRendering) cancelRender(new Error(`Composition mosaic mask failed: ${message}`));
  }, []);

  useEffect(() => {
    setSupported(typeof CSS !== 'undefined' && CSS.supports('filter', 'url("#cc-mosaic-support")')
      && typeof SVGFEGaussianBlurElement !== 'undefined' && typeof SVGFEImageElement !== 'undefined');
    let released = false;
    const release = () => { if (!released) { released = true; continueRender(handle); } };
    const frame = requestAnimationFrame(release);
    return () => { cancelAnimationFrame(frame); release(); };
  }, [handle]);
  useEffect(() => {
    if (failed && environment.isRendering) cancelRender(new Error(failureMessage ?? 'Composition mosaic configuration or renderer is unavailable'));
  }, [environment.isRendering, failed, failureMessage]);

  const protection = value && sizeValid && matrix ? compositionMosaicProtectionRect(value, width, height, matrix)
    : { x: 0, y: 0, width: '100%', height: '100%' };
  return <div data-composition-mosaic={id} data-mosaic-status={!visible ? 'inactive' : failed ? 'failed' : filtered ? 'ready' : 'loading'}
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    {mask && value && matrix && sizeValid && <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
      <defs>
        <filter id={id} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width={width} height={height} colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={sigma} result="blurred" />
        <feImage href={mask.source} x={mask.x} y={mask.y} width={mask.width} height={mask.height} preserveAspectRatio="none" result="shape" />
        <feComponentTransfer in="shape" result="region"><feFuncA type="linear" slope={value.opacity} /></feComponentTransfer>
        <feComposite in="blurred" in2="region" operator="in" result="inside" />
        <feComposite in="SourceGraphic" in2="region" operator="out" result="outside" />
        <feComposite in="inside" in2="outside" operator="arithmetic" k2="1" k3="1" />
      </filter></defs>
    </svg>}
    {visible && mask && supported !== false && <MaskReadiness key={mask.source} source={mask.source} onReady={onReady} onError={onError} />}
    <div style={{ position: 'absolute', inset: 0, filter: filtered ? `url(#${id})` : undefined }}>{children}</div>
    {visible && !filtered && <div data-mosaic-protection style={{ position: 'absolute', left: protection.x, top: protection.y,
      width: protection.width, height: protection.height, background: '#000' }} />}
    {failed && !environment.isRendering && <div role="alert" style={{ position: 'absolute', top: 8, left: 8,
      padding: '6px 10px', color: '#fff', background: '#181818', fontSize: 16 }}>
      {failureMessage ?? '马赛克未能显示，请检查区域设置或重新打开工程。'}
    </div>}
  </div>;
}

/** Keep the lower tree mounted while only the adjustment's time/parameters change. */
export function TimelineMosaicBarrier({ item, width, height, unsupportedTransition = false, children }: {
  item: TimelineItem; width: number; height: number; unsupportedTransition?: boolean; children: ReactNode;
}) {
  const frame = useCurrentFrame();
  const localFrame = frame - item.startFrame;
  const appearance = appearanceAt(item, localFrame, false, { width, height });
  const unsupported = unsupportedTransition || item.mask || item.zoom || item.backgroundFill || item.effects?.length
    || pictureAnimationAt(item, localFrame).blur > 0
    || item.filters && Object.entries(item.filters).some(([key, value]) => value !== undefined
      && value !== ({ brightness: 1, contrast: 1, saturate: 1, blur: 0 } as Record<string, number>)[key])
    || item.transform?.crop && Object.values(item.transform.crop).some(value => value)
    || item.transform?.borderRadius
    || Object.entries(item.keyframes ?? {}).some(([key, values]) => !SUPPORTED_KEYFRAMES.has(key) && values?.length);
  const parsed = parseCompositionMosaic(item.mosaic);
  const configuration = parsed && !unsupported ? { ...parsed, opacity: parsed.opacity * appearance.opacity } : null;
  return <CompositionMosaicSurface configuration={configuration} width={width} height={height}
    transforms={appearance.transformSurfaces} active={localFrame >= 0 && localFrame < item.durationInFrames}
    failureMessage={unsupportedTransition ? '独立马赛克不支持片段转场，请先移除转场。'
      : unsupported ? '独立马赛克不支持当前附加画面处理，请还原这些设置。' : undefined}>
    {children}
  </CompositionMosaicSurface>;
}
