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
  'open-settings',
  'select-before-playhead',
  'select-after-playhead',
  'select-track-before-playhead',
  'select-track-after-playhead',
]);

const WORKSPACE_VIEW_SHORTCUTS = new Set([
  'zoom-in',
  'zoom-out',
  'zoom-fit',
  'fullscreen',
  'snapping',
  'selection-mode',
  'interaction-mode-selection',
  'interaction-mode-trim',
  'interaction-mode-slip',
  'interaction-mode-rate-stretch',
  'interaction-mode-blade',
  'interaction-mode-pen',
  'toggle-picture',
  'marker-add',
  'marker-shortcut-add-and-open',
  'marker-modify-at-playhead',
  'marker-delete-at-playhead',
  'marker-prev',
  'marker-next',
]);

export function shortcutAllowedForSurface(actionId: string, surface: ShortcutSurface): boolean {
  if (PROJECT_SHORTCUTS.has(actionId)) return true;
  if (actionId === 'split') {
    return surface === 'timeline' || surface === 'preview' || surface === 'inspector' || surface === 'other';
  }
  if (PREVIEW_SHORTCUTS.has(actionId)) {
    return surface === 'timeline' || surface === 'preview' || surface === 'inspector' || surface === 'other';
  }
  if (actionId === 'marker-add') return surface === 'timeline' || surface === 'preview' || surface === 'other';
  if (surface === 'preview') return actionId === 'fullscreen';
  if (surface === 'other') return WORKSPACE_VIEW_SHORTCUTS.has(actionId);
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
