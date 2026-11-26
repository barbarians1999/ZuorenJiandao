export type ShortcutSurface =
  | 'media-pool'
  | 'timeline'
  | 'agent-chat'
  | 'agent-input'
  | 'inspector'
  | 'preview'
  | 'other';

const PREVIEW_SHORTCUTS = new Set([
  'play-pause',
  'seek-back',
  'seek-fwd',
  'seek-back-sec',
  'seek-fwd-sec',
  'shuttle-back',
  'shuttle-fwd',
  'shuttle-pause',
  'shuttle-jog-back',
  'shuttle-jog-fwd',
  'prev-edit',
  'next-edit',
  'zone-in',
  'zone-out',
  'zone-clear-in',
  'zone-clear-out',
  'zone-clear',
]);

const PROJECT_SHORTCUTS = new Set([
  'undo',
  'redo',
  'save-version',
  'keyboard-shortcuts',
  'ask-ai',
  'select-before-playhead',
  'select-after-playhead',
  'select-track-before-playhead',
  'select-track-after-playhead',
]);

export function shortcutAllowedForSurface(actionId: string, surface: ShortcutSurface): boolean {
  if (PROJECT_SHORTCUTS.has(actionId)) return true;
  if (actionId === 'split') {
    return surface === 'timeline' || surface === 'preview' || surface === 'inspector' || surface === 'other';
  }
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
