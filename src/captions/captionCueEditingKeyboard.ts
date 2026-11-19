export type CaptionCueKeyboardIntent = 'native' | 'save' | 'selection' | 'split' | 'mergePrevious' | 'mergeNext';

export interface CaptionCueKeyboardInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  textLength: number;
}

export function captionCueKeyboardIntent(input: CaptionCueKeyboardInput): CaptionCueKeyboardIntent {
  if (input.isComposing || input.keyCode === 229) return 'native';
  if (input.key === 'Enter') {
    if (input.shiftKey || input.altKey) return 'native';
    if (input.ctrlKey || input.metaKey) return 'save';
    if (input.selectionStart !== input.selectionEnd) return 'selection';
    return 'split';
  }
  if (input.shiftKey || input.ctrlKey || input.metaKey || input.altKey
    || input.selectionStart === null || input.selectionEnd === null
    || input.selectionStart !== input.selectionEnd) return 'native';
  if (input.key === 'Backspace' && input.selectionStart === 0) return 'mergePrevious';
  if (input.key === 'Delete' && input.selectionStart === input.textLength) return 'mergeNext';
  return 'native';
}
