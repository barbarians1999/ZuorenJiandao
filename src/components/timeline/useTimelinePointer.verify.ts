import assert from 'node:assert/strict';
import type { EditorCommands } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import type { Drag } from './timelineUtil';
import { commitTimelineDragGesture } from './useTimelinePointer';
import { shouldClearSelectionOnModeSwitch } from './useTimelineShortcuts';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: 'clip-a',
  selectedIds: ['clip-a'],
  items: [{
    id: 'clip-a',
    track: 'video-main',
    startFrame: 100,
    durationInFrames: 50,
    name: 'Clip A',
    kind: 'video',
    srcInFrame: 12,
  }],
};

const drag: Drag = {
  id: 'clip-a',
  mode: 'move',
  baseStart: 100,
  baseDur: 50,
  baseTrack: 'video-main',
  baseSrcIn: 12,
  startX: 0,
  deltaF: 15,
  targetTrack: 'video-main',
  snapAt: null,
};

const calls: Array<{ method: string; args: unknown[] }> = [];
const commands = new Proxy({}, {
  get: (_target, property) => (...args: unknown[]) => {
    calls.push({ method: String(property), args });
  },
}) as EditorCommands;

commitTimelineDragGesture(state, commands, drag, 'selection');
assert.equal(calls.length, 1, 'pointer release delegates one EditorCore commit');
assert.equal(calls[0]?.method, 'moveItem');
assert.deepEqual(calls[0]?.args, ['clip-a', { startFrame: 115, track: 'video-main' }]);

calls.length = 0;
commitTimelineDragGesture(state, commands, {
  ...drag,
  mode: 'trim-left',
  deltaF: 10,
}, 'trim');
assert.deepEqual(
  calls[0]?.args,
  ['clip-a', { startFrame: 110, durationInFrames: 40, srcInFrame: 22 }],
  '1x left trim keeps the established source in-point behavior',
);

calls.length = 0;
const fastState: TimelineState = {
  ...state,
  items: [{ ...state.items[0]!, playbackRate: 2 }],
};
commitTimelineDragGesture(fastState, commands, {
  ...drag,
  mode: 'trim-left',
  deltaF: 10,
}, 'trim');
assert.equal(calls[0]?.method, 'setItemTiming');
assert.deepEqual(
  calls[0]?.args,
  ['clip-a', { startFrame: 110, durationInFrames: 40, srcInFrame: 32 }],
  '2x left trim consumes twice as many source frames while keeping the timeline right edge fixed',
);

calls.length = 0;
const slowState: TimelineState = {
  ...state,
  items: [{ ...state.items[0]!, playbackRate: 0.5 }],
};
commitTimelineDragGesture(slowState, commands, {
  ...drag,
  mode: 'trim-left',
  deltaF: 10,
}, 'trim');
assert.deepEqual(
  calls[0]?.args,
  ['clip-a', { startFrame: 110, durationInFrames: 40, srcInFrame: 17 }],
  '0.5x left trim consumes half as many source frames',
);

calls.length = 0;
const edgeState: TimelineState = {
  ...fastState,
  items: [{ ...fastState.items[0]!, startFrame: 1, srcInFrame: 100 }],
};
commitTimelineDragGesture(edgeState, commands, {
  ...drag,
  mode: 'trim-left',
  baseStart: 1,
  baseSrcIn: 100,
  deltaF: -100,
}, 'trim');
assert.deepEqual(
  calls[0]?.args,
  ['clip-a', { startFrame: 0, durationInFrames: 51, srcInFrame: 98 }],
  'timeline-head clamp adjusts the effective delta so the right edge remains fixed',
);

for (const kind of ['image', 'gif', 'svg', 'motion-graphic', 'text', 'solid'] as const) {
  calls.length = 0;
  const extensibleState: TimelineState = {
    ...state,
    items: [{ ...state.items[0]!, kind, srcInFrame: undefined }],
  };
  commitTimelineDragGesture(extensibleState, commands, {
    ...drag,
    mode: 'trim-left',
    baseSrcIn: 0,
    deltaF: -10,
  }, 'selection');
  assert.equal(calls[0]?.method, 'setItemTiming', `${kind} left extension commits one retime`);
  assert.deepEqual(
    calls[0]?.args,
    ['clip-a', { startFrame: 90, durationInFrames: 60 }],
    `${kind} has no source in-point, so empty timeline space is valid trim handle`,
  );
}

// A source-free clip must not extend past the nearest preceding same-track clip's
// right edge: the preview and commit clamp there instead of bouncing on release
// (an overlapping retime would be rolled back by the reducer's overlap guard).
for (const kind of ['image', 'gif', 'svg', 'motion-graphic', 'text', 'solid'] as const) {
  calls.length = 0;
  const collidingState: TimelineState = {
    ...state,
    items: [
      { ...state.items[0]!, kind, startFrame: 120, durationInFrames: 50, srcInFrame: undefined },
      { id: 'prev', track: 'video-main', startFrame: 70, durationInFrames: 40, name: 'Prev', kind: kind as never },
    ],
  };
  commitTimelineDragGesture(collidingState, commands, {
    ...drag,
    id: 'clip-a',
    mode: 'trim-left',
    baseStart: 120,
    baseDur: 50,
    baseSrcIn: 0,
    deltaF: -120, // attempts to extend far past the predecessor
  }, 'selection');
  assert.equal(calls[0]?.method, 'setItemTiming', `${kind} collision commits a clamped retime`);
  assert.deepEqual(
    calls[0]?.args,
    ['clip-a', { startFrame: 110, durationInFrames: 60 }],
    `${kind} left extension clamps to the predecessor right edge (70+40) instead of overlapping`,
  );
}

calls.length = 0;
commitTimelineDragGesture(state, commands, {
  ...drag,
  mode: 'slip',
  deltaF: 7,
}, 'slip');
assert.equal(calls.length, 1, 'slip release commits exactly one editor operation');
assert.equal(calls[0]?.method, 'slipItem');
assert.deepEqual(calls[0]?.args, ['clip-a', 7]);

assert.equal(
  shouldClearSelectionOnModeSwitch('selection', 'selection', 2, 0),
  true,
  'pressing A in selection mode with multiple items selected clears batch selection',
);
assert.equal(
  shouldClearSelectionOnModeSwitch('selection', 'selection', 0, 3),
  true,
  'pressing A in selection mode with multiple captions selected clears batch selection',
);
assert.equal(
  shouldClearSelectionOnModeSwitch('selection', 'selection', 0, 0),
  false,
  'pressing A with empty selection is a no-op',
);
assert.equal(
  shouldClearSelectionOnModeSwitch('blade', 'selection', 1, 0),
  false,
  'returning from blade mode preserves single-item selection',
);
assert.equal(
  shouldClearSelectionOnModeSwitch('blade', 'selection', 2, 1),
  true,
  'returning from blade mode clears multi-item/mixed batch selection',
);
assert.equal(
  shouldClearSelectionOnModeSwitch('selection', 'blade', 3, 2),
  false,
  'switching to another tool mode does not clear selection',
);

const pointerSource = (await import('node:fs')).readFileSync(new URL('./useTimelinePointer.ts', import.meta.url), 'utf8');
assert.match(pointerSource, /currentDrag\.mode === 'move' && currentDrag\.activated === false/, 'plain clicks inside 4px deadzone do not trigger clip moves');
assert.match(pointerSource, /canItemMoveToTrack\(state, draggedPrimary, targetTrack\)/, 'vertical drags prevent video clips from jumping onto dedicated text tracks');
