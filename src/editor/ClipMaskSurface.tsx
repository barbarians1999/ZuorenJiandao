import { useId, type CSSProperties, type ReactNode } from 'react';
import type { ResolvedClipMask } from './clipMask';

/**
 * DOM alpha-mask surface for feathered masks.  The SVG stays inline in the
 * document so Remotion SSR/headless rendering does not depend on data-URI
 * decoding or external resources. Hard masks are deliberately left to the
 * caller's clip-path fast path.
 */
export function ClipMaskSurface({ mask, width, height, children }: {
  mask?: ResolvedClipMask;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const rawId = useId();
  if (!mask || mask.featherPx <= 0) return <>{children}</>;
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const maskId = `cc-clip-mask-${safeId}`;
  const filterId = `${maskId}-blur`;
  const canvasWidth = Math.max(1, width);
  const canvasHeight = Math.max(1, height);
  // This defs-only SVG has a zero-sized viewport. Percentage filter bounds
  // resolve against that viewport and can erase the complete masked picture.
  const filterPadding = Math.max(1, mask.featherPx * 4);
  const shape = mask.type === 'rectangle'
    ? <rect x={mask.x * canvasWidth} y={mask.y * canvasHeight}
        width={mask.width * canvasWidth} height={mask.height * canvasHeight} />
    : <ellipse cx={(mask.x + mask.width / 2) * canvasWidth} cy={(mask.y + mask.height / 2) * canvasHeight}
        rx={mask.width * canvasWidth / 2} ry={mask.height * canvasHeight / 2} />;
  const surfaceStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    maskImage: `url(#${maskId})`,
    WebkitMaskImage: `url(#${maskId})`,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
  } as CSSProperties;
  return (
    <>
      <svg aria-hidden width={0} height={0} style={{ position: 'absolute', pointerEvents: 'none' }}>
        <defs>
          <filter id={filterId} x={-filterPadding} y={-filterPadding}
            width={canvasWidth + filterPadding * 2} height={canvasHeight + filterPadding * 2} filterUnits="userSpaceOnUse">
            <feGaussianBlur stdDeviation={mask.featherPx} />
          </filter>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={canvasWidth} height={canvasHeight}>
            <g fill="white" filter={`url(#${filterId})`}>{shape}</g>
          </mask>
        </defs>
      </svg>
      <div style={surfaceStyle}>{children}</div>
    </>
  );
}
