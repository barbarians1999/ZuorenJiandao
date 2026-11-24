import { useContext, useEffect, useRef, type RefObject } from 'react';
import { HistoryGestureContext } from './historyGesture';
import { wheelStepScalar } from './scalarMath';

interface UseInspectorWheelOptions {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (next: number) => void;
  onStep?: (next: number) => void;
}

/** Adjust numeric box inspector controls with the mouse wheel (not range sliders) without scrolling the panel. */
export function useInspectorWheel<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: UseInspectorWheelOptions,
): void {
  const gesture = useContext(HistoryGestureContext);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gestureRef = useRef(gesture);
  gestureRef.current = gesture;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let wheelGestureActive = false;
    let wheelGestureTimer: ReturnType<typeof setTimeout> | null = null;

    const endWheelGesture = () => {
      if (wheelGestureTimer) {
        clearTimeout(wheelGestureTimer);
        wheelGestureTimer = null;
      }
      if (!wheelGestureActive) return;
      wheelGestureActive = false;
      gestureRef.current?.end();
    };

    const onWheel = (event: WheelEvent) => {
      const current = optionsRef.current;
      if (current.disabled || event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();

      if (!wheelGestureActive) {
        wheelGestureActive = true;
        gestureRef.current?.begin();
      }
      if (wheelGestureTimer) clearTimeout(wheelGestureTimer);
      wheelGestureTimer = setTimeout(endWheelGesture, 350);

      const next = wheelStepScalar(
        current.value,
        event.deltaY,
        current.step,
        current.min,
        current.max,
        { shiftKey: event.shiftKey, metaKey: event.metaKey || event.altKey },
      );
      if (Math.abs(next - current.value) >= 1e-9) {
        current.onChange(next);
        current.onStep?.(next);
      }
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      endWheelGesture();
    };
  }, [ref]);
}
