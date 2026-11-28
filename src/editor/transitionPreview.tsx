import { useId, type CSSProperties, type ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CssTransitionType, TransitionDirection } from './types';

interface Entrance {
  opacity: number;
  transform?: string;
  filter?: string;
  clipPath?: string;
  overlay?: { background: string; opacity: number };
  archivalLine?: { p: number; color: string; widthPx: number };
  inkMask?: { p: number; originX: number; originY: number };
}

function smoothstep(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return clamped * clamped * (3 - 2 * clamped);
}

function hermiteEase(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * c * (10 - c * (15 - 6 * c));
}

function entranceStyle(
  type: CssTransitionType,
  p: number,
  dir: TransitionDirection,
  opts?: { originX?: number; originY?: number; lineColor?: string; lineWidthPx?: number; line?: boolean },
): Entrance {
  const tri = 1 - Math.abs(2 * p - 1);
  if (type === 'cross-dissolve') return { opacity: smoothstep(p) };
  if (type === 'luma-blend') return { opacity: smoothstep(p), filter: `brightness(${1 + tri * 0.6})` };
  if (type === 'dip-to-black') return { opacity: p >= 0.5 ? 1 : 0, overlay: { background: '#000', opacity: tri } };
  if (type === 'flash') return { opacity: p >= 0.5 ? 1 : 0, overlay: { background: '#fff', opacity: tri * tri } };
  if (type === 'ink-bleed') {
    if (p >= 0.999) return { opacity: 1 };
    return {
      opacity: p <= 0 ? 0 : 1,
      inkMask: {
        p: smoothstep(p),
        originX: typeof opts?.originX === 'number' && Number.isFinite(opts.originX) ? Math.max(0, Math.min(1, opts.originX)) : 0.5,
        originY: typeof opts?.originY === 'number' && Number.isFinite(opts.originY) ? Math.max(0, Math.min(1, opts.originY)) : 0.5,
      },
    };
  }
  if (type === 'archival-line-wipe' || (type === 'soft-wipe' && opts?.line)) {
    const ease = hermiteEase(p);
    const hidden = `${Math.max(0, 100 - ease * 100).toFixed(2)}%`;
    const clipPath = dir === 'right' ? `inset(0 0 0 ${hidden})`
      : dir === 'up' ? `inset(0 0 ${hidden} 0)`
      : dir === 'down' ? `inset(${hidden} 0 0 0)`
      : `inset(0 ${hidden} 0 0)`;
    const defaultColor = type === 'soft-wipe' ? '#ffffff' : '#a62121';
    const defaultWidth = type === 'soft-wipe' ? 3.5 : 2.5;
    return {
      opacity: 1,
      clipPath,
      archivalLine: {
        p: ease,
        color: typeof opts?.lineColor === 'string' && opts.lineColor ? opts.lineColor : defaultColor,
        widthPx: typeof opts?.lineWidthPx === 'number' && Number.isFinite(opts.lineWidthPx)
          ? Math.max(1, Math.min(20, opts.lineWidthPx))
          : defaultWidth,
      },
    };
  }
  if (type === 'soft-wipe') {
    const hidden = `${Math.max(0, 100 - p * 100).toFixed(2)}%`;
    const clipPath = dir === 'right' ? `inset(0 0 0 ${hidden})`
      : dir === 'up' ? `inset(0 0 ${hidden} 0)`
      : dir === 'down' ? `inset(${hidden} 0 0 0)`
      : `inset(0 ${hidden} 0 0)`;
    return { opacity: 1, clipPath };
  }
  const offset = (1 - p) * 100;
  const sign = dir === 'right' || dir === 'down' ? -1 : 1;
  const axis = dir === 'up' || dir === 'down' ? 'Y' : 'X';
  return { opacity: 1, transform: `translate${axis}(${sign * offset}%)` };
}

function backgroundFor(type: CssTransitionType): string {
  return type === 'flash' ? '#fff' : '#000';
}

interface LayerProps {
  type: CssTransitionType;
  frames: number;
  dir: TransitionDirection;
  line?: boolean;
  originX?: number;
  originY?: number;
  lineColor?: string;
  lineWidthPx?: number;
  children: ReactNode;
}

function StyledLayer({ entrance, children }: { entrance: Entrance; children: ReactNode }) {
  const rawId = useId();
  const { width, height } = useVideoConfig();
  const ink = entrance.inkMask;
  if (ink) {
    const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const maskId = `cc-ink-mask-${safeId}`;
    const filterId = `cc-ink-disp-${safeId}`;
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const cx = ink.originX * w;
    const cy = ink.originY * h;
    const maxRadius = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy),
      Math.hypot(w - cx, h - cy),
    );
    const r = Math.max(0, ink.p * (maxRadius + 160) - 40);
    const pad = 160;
    return (
      <>
        <svg aria-hidden width={0} height={0} style={{ position: 'absolute', pointerEvents: 'none' }}>
          <defs>
            <filter id={filterId} x={-pad} y={-pad} width={w + pad * 2} height={h + pad * 2} filterUnits="userSpaceOnUse">
              <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="4" seed="19" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale={140} xChannelSelector="R" yChannelSelector="G" />
            </filter>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
              <g filter={`url(#${filterId})`}>
                <circle cx={cx} cy={cy} r={r} fill="white" />
              </g>
            </mask>
          </defs>
        </svg>
        <AbsoluteFill style={{
          opacity: entrance.opacity,
          maskImage: `url(#${maskId})`,
          WebkitMaskImage: `url(#${maskId})`,
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskSize: '100% 100%',
          WebkitMaskSize: '100% 100%',
        }}>
          {children}
        </AbsoluteFill>
      </>
    );
  }
  return <AbsoluteFill style={{ opacity: entrance.opacity, transform: entrance.transform, filter: entrance.filter, clipPath: entrance.clipPath }}>{children}</AbsoluteFill>;
}

function ArchivalWipeLine({ p, dir, color, widthPx }: { p: number; dir: TransitionDirection; color: string; widthPx: number }) {
  if (p <= 0 || p >= 1) return null;
  const horizontal = dir === 'left' || dir === 'right';
  const edge = `${(p * 100).toFixed(2)}%`;
  const half = -(widthPx / 2);
  const style: CSSProperties = {
    background: color,
    pointerEvents: 'none',
    ...(horizontal
      ? { top: 0, bottom: 0, width: widthPx, [dir === 'right' ? 'right' : 'left']: edge, transform: `translateX(${dir === 'right' ? -half : half}px)` }
      : { left: 0, right: 0, height: widthPx, [dir === 'down' ? 'bottom' : 'top']: edge, transform: `translateY(${dir === 'down' ? -half : half}px)` }),
  };
  return <div style={{ position: 'absolute', ...style }} />;
}

function WipeLine({ p, dir }: { p: number; dir: TransitionDirection }) {
  if (p <= 0 || p >= 1) return null;
  const vertical = dir === 'left' || dir === 'right';
  const edge = `${(p * 100).toFixed(2)}%`;
  const style: CSSProperties = {
    background: '#fff',
    boxShadow: '0 0 12px rgba(255,255,255,.9)',
    ...(vertical
      ? { top: 0, bottom: 0, width: 4, [dir === 'right' ? 'right' : 'left']: edge }
      : { left: 0, right: 0, height: 4, [dir === 'down' ? 'bottom' : 'top']: edge }),
  };
  return <div style={{ position: 'absolute', transform: 'translate(-2px, -2px)', ...style }} />;
}

function Layer({ style, entrance, line, p, dir, children }: {
  style?: CSSProperties;
  entrance: Entrance;
  line?: boolean;
  p: number;
  dir: TransitionDirection;
  children: ReactNode;
}) {
  return (
    <AbsoluteFill style={style}>
      <StyledLayer entrance={entrance}>{children}</StyledLayer>
      {entrance.overlay && <AbsoluteFill style={{ background: entrance.overlay.background, opacity: entrance.overlay.opacity }} />}
      {entrance.archivalLine && <ArchivalWipeLine p={entrance.archivalLine.p} dir={dir} color={entrance.archivalLine.color} widthPx={entrance.archivalLine.widthPx} />}
      {line && !entrance.archivalLine && <WipeLine p={p} dir={dir} />}
    </AbsoluteFill>
  );
}

export function PreviewTransitionIn({ type, frames, dir, line, originX, originY, lineColor, lineWidthPx, isolated = false, children }: LayerProps & { isolated?: boolean }) {
  const frame = useCurrentFrame();
  // Keep the wrapper tree stable after completion: remounting BrowserVideo makes
  // Remotion wait for a fresh seek and pauses the shared audio transport.
  const p = Math.max(0, Math.min(1, frame / Math.max(1, frames)));
  const entrance = entranceStyle(type, p, dir, { originX, originY, lineColor, lineWidthPx, line });
  return (
    <Layer
      style={isolated ? { background: backgroundFor(type) } : undefined}
      entrance={entrance}
      line={line}
      p={p}
      dir={dir}
    >
      {children}
    </Layer>
  );
}
