// Pure-logic check for multi-select move / remove. Run: npx tsx src/editor/multiSelect.check.ts
import assert from 'node:assert/strict';
import { canItemMoveToTrack, groupMoveIds, moveItemsByDelta, removeItemsFromState, selectableItemIdsAtPlayheadSide } from './multiSelect';
import type { TimelineItem, TimelineState } from './types';

const clip = (id: string, start: number, track = 'V1'): TimelineItem => ({
  id, name: id, kind: 'motion-graphic', track, startFrame: start, durationInFrames: 30,
});

const base: TimelineState = {
  fps: 30, width: 1920, height: 1080,
  selectedId: 'c',
  selectedIds: ['a', 'b', 'c'],
  items: [clip('a', 0), clip('b', 40), clip('c', 80), clip('d', 120)],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' } },
  trackOrder: ['V2', 'V1', 'A1'],
};

{
  const selectionState: TimelineState = {
    ...base,
    selectedId: 'old-selection',
    selectedIds: ['old-selection'],
    tracks: {
      V1: { kind: 'video' }, A1: { kind: 'audio' }, C1: { kind: 'caption' },
      H1: { kind: 'video', hidden: true }, L1: { kind: 'video', locked: true },
    },
    items: [
      { ...clip('before-video', 2), durationInFrames: 2, kind: 'video' },
      { ...clip('after-audio', 12, 'A1'), durationInFrames: 2, kind: 'audio' },
      { ...clip('spanning-text', 9, 'C1'), durationInFrames: 2, kind: 'text' },
      { ...clip('exact-start-sequence', 10), durationInFrames: 2, kind: 'sequence' },
      { ...clip('exact-end-graphic', 8), durationInFrames: 2, kind: 'motion-graphic' },
      { ...clip('hidden-unlocked-solid', 1, 'H1'), durationInFrames: 2, kind: 'solid' },
      { ...clip('locked-before', 1, 'L1'), durationInFrames: 2, kind: 'video' },
      { ...clip('locked-after', 12, 'L1'), durationInFrames: 2, kind: 'sequence' },
    ],
  };
  assert.deepEqual(selectableItemIdsAtPlayheadSide(selectionState, 10, 'before'), [
    'before-video', 'exact-end-graphic', 'hidden-unlocked-solid',
  ], 'before selects items ending at or before playhead across kinds and excludes straddling items');
  assert.deepEqual(selectableItemIdsAtPlayheadSide(selectionState, 10, 'after'), [
    'after-audio', 'exact-start-sequence',
  ], 'after selects items starting at or after playhead and excludes clips that started before the playhead');
  assert.deepEqual(selectableItemIdsAtPlayheadSide(selectionState, 0, 'before'), [], 'no match replaces selection with empty');
  assert.deepEqual(selectableItemIdsAtPlayheadSide(selectionState, 20, 'after'), [], 'end equal to the playhead is excluded');
}

{
  const ids = groupMoveIds(base, 'b');
  assert.deepEqual(ids, ['a', 'b', 'c'], 'group move uses full multi-selection');
  assert.deepEqual(groupMoveIds(base, 'd'), ['d'], 'unselected grab is single');
}

{
  const next = moveItemsByDelta(base, ['a', 'b', 'c'], 10, null);
  assert.equal(next.items.find((x) => x.id === 'a')!.startFrame, 10);
  assert.equal(next.items.find((x) => x.id === 'b')!.startFrame, 50);
  assert.equal(next.items.find((x) => x.id === 'c')!.startFrame, 90);
  assert.equal(next.items.find((x) => x.id === 'd')!.startFrame, 120, 'non-selected stays');
}

{
  // primary V1 → V2 is index -1 in trackOrder [V2,V1,A1]
  const next = moveItemsByDelta(base, ['a', 'b'], 0, { from: 'V1', to: 'V2' });
  assert.equal(next.items.find((x) => x.id === 'a')!.track, 'V2');
  assert.equal(next.items.find((x) => x.id === 'b')!.track, 'V2');
}

{
  const next = removeItemsFromState(base, ['a', 'b', 'c'], false);
  assert.deepEqual(next.items.map((x) => x.id), ['d']);
  assert.equal(next.selectedId, null);
  assert.deepEqual(next.selectedIds, []);
}

{
  // ripple: remove b (40..70), c starts at 80 → shift left by 30 → 50
  const oneTrack: TimelineState = {
    ...base,
    selectedIds: ['b'],
    items: [clip('a', 0), clip('b', 40), clip('c', 80)],
  };
  const next = removeItemsFromState(oneTrack, ['b'], true);
  assert.equal(next.items.find((x) => x.id === 'c')!.startFrame, 50);
  assert.ok(!next.items.find((x) => x.id === 'b'));
}

{
  const textTrackState: TimelineState = {
    fps: 30, width: 1920, height: 1080,
    selectedId: 'v-main',
    selectedIds: ['v-main'],
    interaction: { mainTrackId: 'V1' },
    tracks: { T1: { kind: 'video', visualRole: 'text' }, V2: { kind: 'video' }, V1: { kind: 'video' } },
    trackOrder: ['T1', 'V2', 'V1'],
    items: [
      { id: 'v-main', name: 'main', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 100 },
      { id: 'txt-1', name: 'title', kind: 'text', track: 'T1', startFrame: 50, durationInFrames: 30 },
    ],
  };
  assert.equal(canItemMoveToTrack(textTrackState, textTrackState.items[0]!, 'T1'), false, 'video clip cannot move onto dedicated text track');
  assert.equal(canItemMoveToTrack(textTrackState, textTrackState.items[0]!, 'V2'), true, 'video clip can move onto normal video track');
  assert.equal(canItemMoveToTrack(textTrackState, textTrackState.items[1]!, 'V1'), false, 'text track item cannot accidentally drop onto main video track');
  const blocked = moveItemsByDelta(textTrackState, ['v-main'], 0, { from: 'V1', to: 'T1' });
  assert.equal(blocked.items.find((item) => item.id === 'v-main')?.track, 'V1', 'moveItemsByDelta keeps video clip on V1 instead of moving onto text track');
}

console.log('multiSelect.check.ts: ok');
