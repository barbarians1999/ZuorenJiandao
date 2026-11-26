import { useEffect } from 'react';
import { isTypingTarget } from '../shortcuts/match';

export type MacNativeEditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

export interface MacNativeEditContext {
  isMacDesktop: boolean;
  isTypingTarget: boolean;
  hasTextSelection: boolean;
}

export function resolveMacNativeEditAction(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'defaultPrevented' | 'isComposing'>,
  ctx: MacNativeEditContext,
): MacNativeEditAction | null {
  if (!ctx.isMacDesktop || event.defaultPrevented || event.isComposing) return null;
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  const letter = /^[a-z]$/i.test(event.key)
    ? event.key.toLowerCase()
    : (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : null);
  if (!letter) return null;

  if (ctx.isTypingTarget) {
    if (letter === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (event.shiftKey) return null;
    if (letter === 'x') return 'cut';
    if (letter === 'c') return 'copy';
    if (letter === 'v') return 'paste';
    if (letter === 'a') return 'selectAll';
    return null;
  }

  if (letter === 'c' && !event.shiftKey && ctx.hasTextSelection) return 'copy';
  return null;
}

/**
 * Fallback for macOS Electron when Edit menu roles are omitted so renderer
 * shortcuts receive Cmd+Z/C/X/V/A directly: execute native editing in text
 * inputs and selected UI text via webContents[action]().
 */
export function useMacNativeEditFallback(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const desktop = window.openChatCutDesktop;
      if (desktop?.platform !== 'darwin' || typeof desktop.nativeEdit !== 'function') return;
      const selection = window.getSelection();
      const action = resolveMacNativeEditAction(event, {
        isMacDesktop: true,
        isTypingTarget: isTypingTarget(event.target),
        hasTextSelection: selection?.isCollapsed === false,
      });
      if (!action) return;
      event.preventDefault();
      void desktop.nativeEdit(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
