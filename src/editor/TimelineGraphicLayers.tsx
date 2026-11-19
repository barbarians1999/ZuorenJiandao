import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { getCompiledTemplate } from '../template-host';
import type { AspectFit, TimelineItem, Watermark } from './types';
import { VisualClipSurface } from './TimelineMediaLayer';
import { resolveTextStyle, textBackgroundColor, textShadowValue, titleAnimationStyle, titleGraphemes } from './textStyles';
import { animationProgress } from './clipAnimation';

export function SolidLayer({ item, canvasW, canvasH, borderRadius }: {
  item: TimelineItem;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
}) {
  const color = String(item.props?.color ?? '#1a1a1a');
  return (
    <VisualClipSurface item={item} fit="cover" canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
      <AbsoluteFill style={{ background: color }} />
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
  const progress = animationProgress(useCurrentFrame() + frameOffset, item.durationInFrames,
    style.entrance === 'none' ? 0 : style.entranceFrames, style.exit === 'none' ? 0 : style.exitFrames);
  const entranceStyle = titleAnimationStyle(style.entrance, progress.entrance, style.letterSpacing);
  const exitStyle = titleAnimationStyle(style.exit, progress.exit, style.letterSpacing);
  const typingProgress = Math.min(style.entrance === 'typewriter' ? progress.entrance : 1, style.exit === 'typewriter' ? progress.exit : 1);
  const graphemes = typingProgress < 1 ? titleGraphemes(style.text) : [];
  const align = style.align;
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: dw, height: dh, flexShrink: 0, transform: `scale(${scale})`, display: 'flex', alignItems: 'center', justifyContent: justify, padding: '0 96px', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '100%', ...entranceStyle }}><div style={{ maxWidth: '100%', ...exitStyle }}><div style={{
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
          padding: style.backgroundPadding,
          borderRadius: style.backgroundRadius,
          backgroundColor: textBackgroundColor(style),
          paintOrder: 'stroke fill',
          WebkitTextStroke: style.strokeWidth > 0 ? `${style.strokeWidth * 2}px ${style.strokeColor}` : undefined,
          textShadow: textShadowValue(style),
        }}>{typingProgress === 1 ? style.text : graphemes.map((glyph, index) => <span key={index} style={{ visibility: index < Math.floor(graphemes.length * typingProgress) ? 'visible' : 'hidden' }}>{glyph}</span>)}</div></div></div>
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
