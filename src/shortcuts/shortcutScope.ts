export type ShortcutSurface =
  | 'media-pool'
  | 'timeline'
  | 'agent-chat'
  | 'agent-input'
  | 'inspector'
  | 'preview'
  | 'other';

const PREVIEW_SHORTCUTS = new Set(['seek-back', 'seek-fwd', 'prev-edit', 'next-edit']);

const PROJECT_SHORTCUTS = new Set([
  'undo',
  'redo',
  'save-version',
  'keyboard-shortcuts',
  'ask-ai',
  'select-before-playhead',
  'select-after-playhead',
]);

export function shortcutAllowedForSurface(actionId: string, surface: ShortcutSurface): boolean {
  if (PROJECT_SHORTCUTS.has(actionId)) return true;
  if (actionId === 'marker-add') return surface === 'timeline' || surface === 'preview' || surface === 'other';
  if (surface === 'preview') return PREVIEW_SHORTCUTS.has(actionId);
  return surface === 'timeline';
}

export function shortcutSurfaceFromTarget(target: EventTarget | null): ShortcutSurface {
  if (!(target instanceof Element)) return 'other';
  const surface = target.closest<HTMLElement>('[data-cc-shortcut-surface]')?.dataset.ccShortcutSurface;
  if (
    surface === 'media-pool'
    || surface === 'timeline'
    || surface === 'agent-chat'
    || surface === 'agent-input'
    || surface === 'inspector'
    || surface === 'preview'
  ) return surface;
  return 'other';
}
