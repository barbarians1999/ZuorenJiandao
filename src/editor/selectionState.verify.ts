import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { applySelection, reduceSelection, selectionFromProject, stripTransientSelection } from './selectionState';
import type { ProjectDoc } from './types';
import { revisionOf } from '../agent/external-edit-session';

const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'tl',
  timelines: [{
    id: 'tl', name: '主序列', order: 0, fps: 30, width: 1920, height: 1080,
    selectedId: 'a', selectedIds: ['a'], items: [
      { id: 'a', track: 'V1', kind: 'video', name: 'A', src: '/a.mp4', startFrame: 0, durationInFrames: 30 },
      { id: 'b', track: 'V1', kind: 'video', name: 'B', src: '/b.mp4', startFrame: 30, durationInFrames: 30 },
    ],
  }],
};

const clean = stripTransientSelection(doc);
assert.equal(clean.timelines[0]?.selectedId, null);
assert.deepEqual(clean.timelines[0]?.selectedIds, []);
assert.equal(revisionOf(doc), revisionOf(clean), 'Legacy selection must not stale an external MCP binding');
const noSelectionArray = { ...clean, timelines: clean.timelines.map(({ selectedIds: _ignored, ...timeline }) => timeline) };
assert.equal(revisionOf(noSelectionArray), revisionOf(clean), 'Missing legacy selectedIds must normalize to the same revision');
assert.notEqual(revisionOf(clean), revisionOf({ ...clean, timelines: clean.timelines.map((timeline) => ({
  ...timeline, items: timeline.items.map((item) => ({ ...item, durationInFrames: item.durationInFrames + 1 })),
})) }), 'Real timeline changes must still invalidate bindings');
const initial = selectionFromProject(doc);
const selected = reduceSelection(initial, clean, { type: 'select', id: 'b' });
assert.deepEqual(selected.tl, { selectedId: 'b', selectedIds: ['b'] });
assert.equal(clean.timelines[0]?.selectedId, null, 'selection does not mutate the project');
const rendered = applySelection(clean.timelines[0]!, selected);
assert.equal(rendered.selectedId, 'b');
assert.deepEqual(rendered.selectedIds, ['b']);
assert.deepEqual(reduceSelection(selected, clean, { type: 'select', id: null }).tl, { selectedId: null, selectedIds: [] });
console.log('selectionState.verify OK');
