import { useEffect } from 'react';
import { isShortcutImeComposing, matchShortcut, normalizeKey, shouldIgnoreShortcutRepeat, isTypingTarget } from './match';
import { effectiveMatchingCatalog } from './keymap';
import { invokeAction } from './actionRegistry';
import { shortcutAllowedForSurface, shortcutSurfaceFromTarget } from './shortcutScope';

export type ShortcutHandler = (ctx: { shift: boolean; alt: boolean; mod: boolean }) => void;

/**
 * Global keydown dispatcher for the default preset.
 * Keyboard matching is only an input adapter. Every surface dispatches through
 * the same action registry, so toolbar/menu/shortcut behavior cannot drift.
 */
export function useShortcutDispatcher(
  opts?: { enabled?: boolean },
): void {
  const enabled = opts?.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const held = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target);
      const isBracketKey = e.code === 'BracketLeft' || e.code === 'BracketRight'
        || e.key === '【' || e.key === '】' || e.key === '{' || e.key === '}';
      const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
      if (isShortcutImeComposing(e) && (typing || (!isBracketKey && !hasModifier))) return;
      const nk = normalizeKey(e.key);
      if (!['shift', 'control', 'alt', 'meta'].includes(nk)) held.add(nk);
      if (e.defaultPrevented) return;

      // Shift+Backspace is ripple-delete — special case: still match delete with shift
      const selection = window.getSelection();
      const hasTextSelection = selection?.isCollapsed === false;
      const id = matchShortcut(e, effectiveMatchingCatalog(), { held, hasTextSelection });
      if (!id) return;
      if (!shortcutAllowedForSurface(id, shortcutSurfaceFromTarget(e.target))) return;
      if (shouldIgnoreShortcutRepeat(id, e)) return;
      if (id === 'marker-add' && document.querySelector('[aria-modal="true"]')) return;

      // Tab in non-typing: ask-ai; don't steal tab in inputs
      if (id === 'ask-ai' && isTypingTarget(e.target)) return;

      const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
      const handled = invokeAction(id, {
        shift: e.shiftKey,
        alt: e.altKey,
        mod: isMac ? e.metaKey : e.ctrlKey,
      }, 'shortcut');
      if (handled) e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(normalizeKey(e.key));
    };
    const onBlur = () => held.clear();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);
}
