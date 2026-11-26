import { useEffect } from 'react';
import { isMacPlatform, isTypingTarget } from '../shortcuts/match';

const ZOOM_STEP = 0.05;

export function resolveUiScaleShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented'>,
  options: { inEditor: boolean; isMac: boolean },
): number | 'reset' | null {
  if (event.defaultPrevented) return null;
  const mod = options.isMac ? (event.metaKey && !event.ctrlKey) : (event.ctrlKey && !event.metaKey);
  if (!mod) return null;

  const key = event.key;
  if (!event.altKey && (key === '0' || event.code === 'Digit0')) return 'reset';
  if (key === '=' || key === '+' || event.code === 'Equal') {
    return !options.inEditor || event.altKey ? ZOOM_STEP : null;
  }
  if (key === '-' || key === '_' || event.code === 'Minus') {
    return !options.inEditor || event.altKey ? -ZOOM_STEP : null;
  }
  return null;
}

/**
 * Desktop zoom accelerators (issue #85): step the saved UI scale by 5%
 * (clamped 80%–150% in the main process), Mod + 0 resets to 100%.
 * Inside the editor workspace, bare Mod + =/- stays reserved for timeline
 * zoom; Mod + Alt + =/- steps UI scale instead.
 */
export function useUiScaleShortcuts(inEditor = false): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const desktop = window.openChatCutDesktop;
      if (!desktop?.zoomStep) return;
      const step = resolveUiScaleShortcut(event, { inEditor, isMac: isMacPlatform() });
      if (step === null) return;
      event.preventDefault();
      void desktop.zoomStep(step);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [inEditor]);
}
