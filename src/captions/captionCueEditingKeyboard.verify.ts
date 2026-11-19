import assert from 'node:assert/strict';
import { captionCueKeyboardIntent } from './captionCueEditingKeyboard';

const key = (overrides: Partial<Parameters<typeof captionCueKeyboardIntent>[0]> = {}) => captionCueKeyboardIntent({
  key: 'Enter', selectionStart: 2, selectionEnd: 2, textLength: 4, ...overrides,
});

assert.equal(key(), 'split');
assert.equal(key({ shiftKey: true }), 'native');
assert.equal(key({ ctrlKey: true }), 'save');
assert.equal(key({ metaKey: true }), 'save');
assert.equal(key({ selectionStart: 1, selectionEnd: 3 }), 'selection');
assert.equal(key({ isComposing: true }), 'native');
assert.equal(key({ keyCode: 229 }), 'native');
assert.equal(key({ key: 'Backspace', selectionStart: 0, selectionEnd: 0 }), 'mergePrevious');
assert.equal(key({ key: 'Delete', selectionStart: 4, selectionEnd: 4 }), 'mergeNext');
assert.equal(key({ key: 'Backspace', selectionStart: 1, selectionEnd: 1 }), 'native');
assert.equal(key({ key: 'Delete', selectionStart: 1, selectionEnd: 1 }), 'native');
assert.equal(key({ key: 'Backspace', selectionStart: 0, selectionEnd: 1 }), 'native');
assert.equal(key({ key: 'Delete', selectionStart: 4, selectionEnd: 4, shiftKey: true }), 'native');
console.log('caption cue keyboard intents passed');
