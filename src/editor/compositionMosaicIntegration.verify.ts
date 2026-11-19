import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { compositionPlan } from './compositionPlan';
import { DEFAULT_COMPOSITION_MOSAIC } from './compositionMosaic';
import type { ProjectDoc, Timeline, TimelineItem } from './types';
import { runProjectMigrations } from '../persist/migrations';
import { browserTimelineBlocker } from '../export/browserExport';
import { timelineVersionFor } from '../export/sharedShotPlanProjection';
import { projectTimelineItem } from '../agent/tools/timeline-item-projection';
import { reduce } from './reducerTimeline';
import { historyReduce } from './reducerHistory';
import type { History } from './reducerHistory';

const clip = (id: string, track: string, startFrame: number): TimelineItem => ({ id, kind: 'video', name: id, track,
  startFrame, durationInFrames: 30, srcInFrame: 10, src: `/${id}.mp4`, width: 640, height: 360 });
const mosaic: TimelineItem = { id: 'mosaic', name: 'Mosaic', kind: 'mosaic', track: 'adjust', startFrame: 10,
  durationInFrames: 40, mosaic: { ...DEFAULT_COMPOSITION_MOSAIC } };
const timeline: Timeline = { id: 'main', name: 'Main', order: 0, fps: 30, width: 640, height: 360, selectedId: null,
  trackOrder: ['upper', 'adjust', 'C1', 'lower'], tracks: { upper: { kind: 'video' }, adjust: { kind: 'video' },
    lower: { kind: 'video' }, C1: { kind: 'caption', captions: { enabled: true, template: 'plain', pacing: 'phrase',
      words: [{ text: 'Lower caption', start: 0, end: 2000 }] } } },
  items: [clip('a', 'lower', 0), clip('b', 'lower', 30), mosaic, { ...clip('top', 'upper', 0), durationInFrames: 60 }],
  transitions: [{ id: 'tr', type: 'page-curl', outgoingItemId: 'a', incomingItemId: 'b', durationInFrames: 8, trackId: 'lower' }],
};
const project: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: timeline.id, timelines: [timeline] };
const before = JSON.stringify(project);
const plan = compositionPlan(timeline, { mode: 'player', selectedItemId: 'top' });
assert.equal(plan.glWindows.length, 1, 'lower transition stays exact when another item is selected');
const barrier = plan.pictureLayers.findIndex(layer => layer.kind === 'mosaic');
assert.ok(barrier > plan.pictureLayers.findIndex(layer => layer.kind === 'transition'));
assert.ok(barrier > plan.pictureLayers.findIndex(layer => layer.kind === 'captions'));
assert.ok(barrier < plan.pictureLayers.findIndex(layer => layer.kind === 'visual' && layer.items[0]?.id === 'top'));
const legacy = compositionPlan({ ...timeline, items: timeline.items.filter(item => item.kind !== 'mosaic') });
assert.equal(legacy.usesTrackCompositing, false);
assert.equal(legacy.pictureLayers.at(-1)?.kind, 'captions', 'old projects retain the existing top-level caption order');
const hidden = compositionPlan({ ...timeline, tracks: { ...timeline.tracks, adjust: { kind: 'video', hidden: true } } });
assert.equal(hidden.usesTrackCompositing, true);
assert.ok(!hidden.pictureLayers.some(layer => layer.kind === 'mosaic'));
const roundtrip = runProjectMigrations(JSON.parse(JSON.stringify(project)));
assert.deepEqual(roundtrip?.doc.timelines[0]?.items.find(item => item.id === 'mosaic')?.mosaic, mosaic.mosaic);
assert.equal(roundtrip?.doc.timelines[0]?.compositingOrder, 'tracks');
assert.equal(compositionPlan({ ...timeline, compositingOrder: 'tracks',
  items: timeline.items.filter(item => item.kind !== 'mosaic') }).usesTrackCompositing, true,
  'removing an adjustment does not revert the established compositing order');
assert.equal(runProjectMigrations({ ...project, timelines: [{ ...timeline,
  items: timeline.items.map(item => item.id === 'mosaic' ? { ...item, mosaic: { ...item.mosaic, strength: NaN } } : item) }] }), null);
assert.match(browserTimelineBlocker(timeline, project, timeline.id)!, /马赛克/);
const parent: Timeline = { ...timeline, id: 'parent', transitions: [], items: [{ id: 'nested', name: 'Nested', kind: 'sequence',
  track: 'lower', startFrame: 0, durationInFrames: 60, timelineId: 'main' }] };
const nested: ProjectDoc = { ...project, activeTimelineId: 'parent', timelines: [parent, timeline] };
assert.match(browserTimelineBlocker(parent, nested, 'parent')!, /马赛克/);
const firstVersion = await timelineVersionFor(timeline, 'lower', []);
const changed = { ...timeline, items: timeline.items.map(item => item.id === 'mosaic'
  ? { ...item, mosaic: { ...item.mosaic!, strength: 20 } } : item) };
assert.notEqual(await timelineVersionFor(changed, 'lower', []), firstVersion, 'mosaic changes invalidate timeline identity');
assert.notEqual(await timelineVersionFor({ ...timeline, items: timeline.items.map(item => item.id === 'mosaic'
  ? { ...item, pictureDisabled: true } : item) }, 'lower', []), firstVersion, 'V visibility changes invalidate timeline identity');
assert.deepEqual(projectTimelineItem(mosaic, timeline, []).mosaic, mosaic.mosaic);
assert.equal(reduce(timeline, { type: 'remove', id: mosaic.id }).compositingOrder, 'tracks',
  'deleting an unsaved adjustment retains its established track order');
const legacyDoc = { ...project, timelines: [{ ...timeline, items: timeline.items.filter(item => item.kind !== 'mosaic') }] };
const initialHistory: History = { past: [], present: legacyDoc, future: [] };
const { startFrame, ...newItem } = mosaic;
const added = historyReduce(initialHistory, { type: 'add', item: newItem, startFrame });
assert.equal(added.present.timelines[0]?.compositingOrder, 'tracks');
assert.equal(historyReduce(added, { type: 'undo' }).present.timelines[0]?.compositingOrder, undefined,
  'undoing the first adjustment insertion restores the original project behavior');
assert.equal(JSON.stringify(project), before, 'planning and normalization leave the source document untouched');
console.log('compositionMosaicIntegration.verify: layer order, persistence, nested export gating and source identity passed');
