import { useId } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { getCompiledTemplate } from '../template-host';
import type { AspectFit, TimelineItem, Watermark } from './types';
import { VisualClipSurface } from './TimelineMediaLayer';
import { resolveTextStyle, TEXT_ANCHOR_MARGIN_X, TEXT_ANCHOR_MARGIN_Y, textBackgroundColor, textShadowValue, titleAnimationStyle, titleGraphemes } from './textStyles';
import { animationProgress } from './clipAnimation';
import { resolvePaperBackground } from './paperBackgrounds';
import { resolveVectorShape, type ResolvedVectorShape } from './vectorShapes';

function vectorDashArray(shape: ResolvedVectorShape): string | undefined {
  if (shape.dashPattern === 'dashed') return `${shape.strokeWidth * 3.5} ${shape.strokeWidth * 2}`;
  if (shape.dashPattern === 'dotted') return `${shape.strokeWidth} ${shape.strokeWidth * 1.8}`;
  return undefined;
}

function VectorShapeSvg({ shape, canvasW, canvasH }: {
  shape: ResolvedVectorShape;
  canvasW: number;
  canvasH: number;
}) {
  const markerId = `cc-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const dash = vectorDashArray(shape);
  const opacity = shape.opacity / 100;
  const px1 = shape.x1 * canvasW;
  const py1 = shape.y1 * canvasH;
  const px2 = shape.x2 * canvasW;
  const py2 = shape.y2 * canvasH;
  return (
    <svg
      viewBox={`0 0 ${canvasW} ${canvasH}`}
      width="100%"
      height="100%"
      style={{ display: 'block', overflow: 'visible', opacity, pointerEvents: 'none' }}
    >
      {shape.kind === 'arrow' && (
        <defs>
          <marker
            id={markerId}
            markerWidth={shape.arrowHeadSize}
            markerHeight={shape.arrowHeadSize}
            refX={shape.arrowHeadSize * 0.72}
            refY={shape.arrowHeadSize / 2}
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path
              d={`M 0 0 L ${shape.arrowHeadSize} ${shape.arrowHeadSize / 2} L 0 ${shape.arrowHeadSize} Z`}
              fill={shape.color}
            />
          </marker>
        </defs>
      )}
      {shape.kind === 'rect' ? (
        <rect
          x={shape.x * canvasW}
          y={shape.y * canvasH}
          width={Math.max(1, shape.width * canvasW)}
          height={Math.max(1, shape.height * canvasH)}
          rx={shape.cornerRadius}
          ry={shape.cornerRadius}
          fill={shape.fillOpacity > 0 ? shape.fillColor : 'none'}
          fillOpacity={shape.fillOpacity > 0 ? shape.fillOpacity / 100 : 0}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          strokeDasharray={dash}
        />
      ) : (
        <line
          x1={px1}
          y1={py1}
          x2={px2}
          y2={py2}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          strokeLinecap="round"
          strokeDasharray={dash}
          markerEnd={shape.kind === 'arrow' ? `url(#${markerId})` : undefined}
          markerStart={shape.kind === 'arrow' && shape.bidirectional ? `url(#${markerId})` : undefined}
        />
      )}
    </svg>
  );
}

export function SolidLayer({ item, canvasW, canvasH, borderRadius }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
}) {
  const filterId = `cc-paper-grain-${useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const shape = resolveVectorShape(item.props);
  if (shape) {
    return (
      <VisualClipSurface item={item} fit="cover" canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
        <AbsoluteFill style={{ pointerEvents: 'none', overflow: 'visible' }}>
          <VectorShapeSvg shape={shape} canvasW={canvasW} canvasH={canvasH} />
        </AbsoluteFill>
      </VisualClipSurface>
    );
  }
  const paper = resolvePaperBackground(item.props);
  const bg = paper.isTextured
    ? `radial-gradient(ellipse 78% 74% at 50% 46%, ${paper.colors[0]} 0%, ${paper.colors[1]} 58%, ${paper.colors[2]} 100%)`
    : paper.color;
  const grainOpacity = paper.isTextured && paper.paperGrain > 0 ? Math.min(0.42, (paper.paperGrain / 100) * 0.38) : 0;
  const vignetteAlpha = paper.isTextured && paper.paperVignette > 0 ? Math.min(0.75, (paper.paperVignette / 100) * 0.55) : 0;
  return (
    <VisualClipSurface item={item} fit="cover" canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
      <AbsoluteFill style={{ background: bg, overflow: 'hidden' }}>
        {grainOpacity > 0 && (
          <svg
            aria-hidden
            width={canvasW}
            height={canvasH}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              opacity: grainOpacity,
              mixBlendMode: 'overlay',
              pointerEvents: 'none',
            }}
          >
            <filter id={filterId}>
              <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="3" seed="27" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter={`url(#${filterId})`} />
          </svg>
        )}
        {vignetteAlpha > 0 && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              background: `radial-gradient(ellipse 76% 72% at 50% 48%, rgba(0,0,0,0) 46%, rgba(0,0,0,${vignetteAlpha.toFixed(2)}) 100%)`,
              pointerEvents: 'none',
            }}
          />
        )}
        {paper.isTextured && paper.paperAccentLine && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: '4.5%',
              right: '4.5%',
              top: '5.5%',
              height: 1.5,
              background: paper.lineColor,
              opacity: 0.52,
              pointerEvents: 'none',
            }}
          />
        )}
      </AbsoluteFill>
    </VisualClipSurface>
  );
}

export function WatermarkLayer({ watermark, canvasH }: { watermark: Watermark; canvasH: number }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    color: '#ffffff',
    opacity: Math.max(0, Math.min(1, watermark.opacity)),
    fontSize: Math.round(canvasH * 0.035),
    fontWeight: 700,
    fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
    textShadow: '0 2px 8px rgba(0,0,0,0.6)',
    whiteSpace: 'nowrap',
  };
  const pad = Math.round(canvasH * 0.04);
  if (watermark.position[0] === 't') style.top = pad;
  else style.bottom = pad;
  if (watermark.position[1] === 'l') style.left = pad;
  else style.right = pad;
  return <AbsoluteFill style={{ pointerEvents: 'none' }}><div style={style}>{watermark.text}</div></AbsoluteFill>;
}

export function TextLayer({ item, canvasW, canvasH, fit, frameOffset = 0 }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  fit: AspectFit;
  frameOffset?: number;
}) {
  const dw = item.width ?? 1920;
  const dh = item.height ?? 1080;
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  const style = resolveTextStyle(item.props ?? {});
  const localFrame = useCurrentFrame() + frameOffset;
  const { fps } = useVideoConfig();
  const progress = animationProgress(localFrame, item.durationInFrames,
    style.entrance === 'none' ? 0 : style.entranceFrames, style.exit === 'none' ? 0 : style.exitFrames);
  const strikeStartFrame = Math.max(0, style.strikeStartSec * fps);
  const strikeSpanFrames = Math.max(1, style.strikeDurationSec * fps);
  const rawStrikeP = style.strikeAnimated
    ? Math.max(0, Math.min(1, (localFrame - strikeStartFrame) / strikeSpanFrames))
    : 0;
  const strikeP = 1 - Math.pow(1 - rawStrikeP, 3);
  const entranceStyle = titleAnimationStyle(style.entrance, progress.entrance, style.letterSpacing);
  const exitStyle = titleAnimationStyle(style.exit, progress.exit, style.letterSpacing);
  const typingProgress = Math.min(style.entrance === 'typewriter' ? progress.entrance : 1, style.exit === 'typewriter' ? progress.exit : 1);
  const graphemes = typingProgress < 1 ? titleGraphemes(style.text) : [];
  const align = style.align;
  const isLeftAnchored = style.anchor === 'top-left' || style.anchor === 'middle-left';
  const justify = isLeftAnchored ? 'flex-start' : (align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center');
  const alignItems = style.anchor === 'top-left' ? 'flex-start' : 'center';
  const containerPadding = style.anchor === 'top-left'
    ? `${TEXT_ANCHOR_MARGIN_Y}px ${TEXT_ANCHOR_MARGIN_X}px`
    : `0 ${TEXT_ANCHOR_MARGIN_X}px`;
  const cardBg = textBackgroundColor(style);
  const shadowCss = textShadowValue(style);
  const accentLeft = style.accentBarPosition === 'left' ? style.accentBarWidth : 0;
  const accentTop = style.accentBarPosition === 'top' ? style.accentBarWidth : 0;
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: dw, height: dh, flexShrink: 0, transform: `scale(${scale})`, display: 'flex', alignItems, justifyContent: justify, padding: containerPadding, boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '100%', ...entranceStyle }}><div style={{ maxWidth: '100%', ...exitStyle }}><div style={{
          position: 'relative',
          color: style.color,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          textAlign: align,
          maxWidth: '100%',
          fontFamily: style.fontFamily,
          fontStyle: style.fontStyle,
          textDecoration: style.textDecoration,
          letterSpacing: style.letterSpacing + (style.entrance === 'tracking' ? (1 - progress.entrance) * 24 : 0) + (style.exit === 'tracking' ? (1 - progress.exit) * 24 : 0),
          lineHeight: style.lineHeight,
          whiteSpace: 'pre-wrap',
          display: 'inline-block',
          paddingTop: style.backgroundPaddingY + accentTop,
          paddingBottom: style.backgroundPaddingY,
          paddingLeft: style.backgroundPaddingX + accentLeft,
          paddingRight: style.backgroundPaddingX,
          borderRadius: style.backgroundRadius,
          backgroundColor: cardBg,
          boxShadow: cardBg ? shadowCss : undefined,
          overflow: cardBg && style.accentBarPosition !== 'none' ? 'hidden' : undefined,
          paintOrder: 'stroke fill',
          WebkitTextStroke: style.strokeWidth > 0 ? `${style.strokeWidth * 2}px ${style.strokeColor}` : undefined,
          textShadow: cardBg ? undefined : shadowCss,
        }}>
          {style.accentBarPosition !== 'none' && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                ...(style.accentBarPosition === 'left'
                  ? { bottom: 0, width: style.accentBarWidth }
                  : { right: 0, height: style.accentBarWidth }),
                background: style.accentBarColor,
                pointerEvents: 'none',
              }}
            />
          )}
          {typingProgress === 1 ? style.text : graphemes.map((glyph, index) => <span key={index} style={{ visibility: index < Math.floor(graphemes.length * typingProgress) ? 'visible' : 'hidden' }}>{glyph}</span>)}
          {style.strikeAnimated && strikeP > 0 && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: '52%',
                height: style.strikeThickness,
                background: style.strikeColor,
                borderRadius: style.strikeThickness / 2,
                transform: `translateY(-50%) scaleX(${strikeP})`,
                transformOrigin: 'left center',
                pointerEvents: 'none',
              }}
            />
          )}
        </div></div></div>
      </div>
    </AbsoluteFill>
  );
}

export function ItemLayer({ item, canvasW, canvasH, fit, borderRadius, frameOffset = 0 }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  fit: AspectFit;
  borderRadius: number;
  frameOffset?: number;
}) {
  const dw = item.width ?? 1920;
  const dh = item.height ?? 1080;
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  try {
    const Template = getCompiledTemplate(item.code ?? '');
    return (
      <VisualClipSurface item={item} fit={fit} canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <div style={{ width: dw, height: dh, position: 'relative', flexShrink: 0, transform: `scale(${scale})` }}>
            <Template item={{ props: item.props ?? {}, width: dw, height: dh, durationInFrames: item.durationInFrames, frameOffset }} />
          </div>
        </div>
      </VisualClipSurface>
    );
  } catch (error) {
    return (
      <AbsoluteFill style={{ color: '#f88', fontFamily: 'monospace', fontSize: 20, padding: 40, whiteSpace: 'pre-wrap' }}>
        {(item.name + ' — compile error:\n') + (error instanceof Error ? error.message : String(error))}
      </AbsoluteFill>
    );
  }
}
