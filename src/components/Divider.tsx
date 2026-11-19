import { useRef, useState } from 'react';
import { theme } from '../theme';
import { useT } from '../i18n/locale';

// A thin drag handle for resizing adjacent panels. Reports the pointer delta
// (along its axis) on each move; the parent clamps and applies it to a size.
interface DividerProps {
  onResize: (delta: number) => void;
  orientation?: 'vertical' | 'horizontal';
  ariaValue?: { value: number; min: number; max: number };
  ariaValueLabel?: string;
  onResizeStart?: () => void;
  onResizeCancel?: () => void;
  onReset?: () => void;
}

export function Divider({ onResize, orientation = 'vertical', ariaValue, ariaValueLabel, onResizeStart, onResizeCancel, onReset }: DividerProps) {
  const t = useT();
  const last = useRef<number | null>(null);
  const pointerId = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const [hovered, setHovered] = useState(false);
  const horiz = orientation === 'horizontal';
  const axis = (e: React.PointerEvent) => (horiz ? e.clientY : e.clientX);
  const finishDrag = (cancelled: boolean) => {
    if (last.current === null) return;
    last.current = null;
    pointerId.current = null;
    setActive(false);
    if (cancelled) onResizeCancel?.();
  };

  return (
    <div
      className={`cc-panel-divider ${horiz ? 'horizontal' : 'vertical'}${active ? ' is-active' : ''}${hovered ? ' is-hovered' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation={horiz ? 'horizontal' : 'vertical'}
      aria-label={t('拖动调整大小；双击恢复默认，Esc 取消')}
      aria-valuenow={ariaValue?.value}
      aria-valuemin={ariaValue?.min}
      aria-valuemax={ariaValue?.max}
      aria-valuetext={ariaValue && ariaValueLabel ? `${t(ariaValueLabel)} ${Math.round(ariaValue.value * 10) / 10}%` : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.focus({ preventScroll: true });
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerId.current = e.pointerId;
        last.current = axis(e);
        setActive(true);
        onResizeStart?.();
      }}
      onPointerMove={(e) => {
        if (last.current == null) return;
        const cur = axis(e);
        const d = cur - last.current;
        last.current = cur;
        if (d) onResize(d);
      }}
      onPointerUp={(e) => {
        finishDrag(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => finishDrag(true)}
      onLostPointerCapture={() => finishDrag(true)}
      onDoubleClick={() => { if (last.current === null) onReset?.(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && last.current !== null) {
          event.preventDefault();
          const activePointer = pointerId.current;
          finishDrag(true);
          if (activePointer !== null && event.currentTarget.hasPointerCapture(activePointer)) {
            event.currentTarget.releasePointerCapture(activePointer);
          }
          return;
        }
        const step = event.shiftKey ? 32 : 8;
        const delta = horiz
          ? event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
          : event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        if (!delta) return;
        event.preventDefault();
        onResize(delta);
      }}
      title={t('拖动调整大小；双击恢复默认，Esc 取消')}
      style={{
        position: 'relative', zIndex: 20,
        width: horiz ? '100%' : 9, height: horiz ? 9 : '100%',
        left: horiz ? 0 : -4, top: horiz ? -4 : 0,
        cursor: horiz ? 'row-resize' : 'col-resize',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{
        position: 'absolute', pointerEvents: 'none',
        left: horiz ? 0 : 4, top: horiz ? 4 : 0,
        // Visible line stays 0.5px (one physical pixel on Retina); the hit area
        // is deliberately wider for touchpads and high-density screens.
        width: horiz ? '100%' : 0.5, height: horiz ? 0.5 : '100%',
        background: active ? theme.accent : hovered ? theme.borderLight : theme.border,
      }} />
      <span className="cc-panel-divider-grip" aria-hidden="true" />
    </div>
  );
}
