import assert from 'node:assert/strict';
import { ProjectAutosaveQueue } from './projectAutosaveQueue';
import { SaveCoordinator } from '../persist/projectStoreCoordinators';
import type { ProjectDoc } from './types';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';

const doc = (name: string): ProjectDoc => ({ version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [
  { id: 'main', name, order: 0, fps: 30, width: 1920, height: 1080, items: [], selectedId: null },
] });

const snapshots: ProjectDoc[] = [];
const acknowledged: string[] = [];
const loaded: string[] = [];
let fail = true;
const coordinator = new SaveCoordinator(async (_id, snapshot) => {
  snapshots.push(snapshot);
  if (fail) throw new Error('Disk full');
  return { saved: true, indexUpdated: true };
});
const queue = new ProjectAutosaveQueue('project', coordinator.enqueue.bind(coordinator),
  (snapshot) => acknowledged.push(snapshot.timelines[0]!.name), (snapshot) => loaded.push(snapshot.timelines[0]!.name));
const baseline = doc('baseline');
const edited = doc('first edit');
assert.equal(queue.observe(baseline), false);
assert.deepEqual(loaded, ['baseline'], 'the first observed snapshot is the loaded project baseline');
assert.equal(queue.enqueue(), null, 'opening a project does not autosave it');
assert.equal(queue.observe(edited), true);
assert.equal(queue.getSnapshot().status, 'saving');
const first = queue.enqueue()!;
assert.equal(queue.enqueue(), null, 'duplicate clicks cannot enqueue the same snapshot twice');
assert.equal((await first).status, 'failed');
assert.deepEqual(queue.getSnapshot(), { status: 'error', error: 'Disk full' });
assert.equal(queue.hasPending(), true);
assert.equal(queue.observe(edited), false, 'effect replay leaves failed pending work intact');
fail = false;
const retry = queue.enqueue()!;
assert.equal(queue.getSnapshot().status, 'saving');
assert.equal((await retry).status, 'saved');
assert.equal((await coordinator.flush('project')).ok, true);
assert.equal(queue.getSnapshot().status, 'saved');
assert.equal(queue.hasPending(), false);
assert.deepEqual(snapshots.map((snapshot) => snapshot.timelines[0]!.name), ['first edit', 'first edit']);
assert.deepEqual(acknowledged, ['first edit'], 'only a successful latest snapshot is acknowledged');

// An earlier completion must neither restore stale work nor flash a saved or
// failed state over a newer attempt still in flight.
let releaseOld!: () => void;
let releaseNew!: () => void;
const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
const concurrent = new ProjectAutosaveQueue('serial', async (projectId, snapshot) => {
  const old = snapshot.timelines[0]!.name === 'old';
  await (old ? oldGate : newGate);
  return { projectId, revision: old ? 1 : 2, epoch: 0, status: old ? 'failed' : 'saved', saved: !old, indexUpdated: !old };
});
concurrent.observe(baseline);
concurrent.observe(doc('old'));
const old = concurrent.enqueue()!;
concurrent.observe(doc('new'));
const newer = concurrent.enqueue()!;
releaseOld();
await old;
assert.equal(concurrent.hasPending(), false);
assert.equal(concurrent.getSnapshot().status, 'saving');
releaseNew();
await newer;
assert.equal(concurrent.getSnapshot().status, 'saved');

let releaseOldSuccess!: () => void;
let releaseNewSuccess!: () => void;
const oldSuccessGate = new Promise<void>((resolve) => { releaseOldSuccess = resolve; });
const newSuccessGate = new Promise<void>((resolve) => { releaseNewSuccess = resolve; });
const acknowledgedSnapshots: string[] = [];
const delayed = new ProjectAutosaveQueue('delayed', async (projectId, snapshot) => {
  const name = snapshot.timelines[0]!.name;
  await (name === 'old snapshot' ? oldSuccessGate : newSuccessGate);
  return { projectId, revision: 1, epoch: 0, status: 'saved', saved: true, indexUpdated: true };
}, (snapshot) => acknowledgedSnapshots.push(snapshot.timelines[0]!.name));
delayed.observe(baseline); delayed.observe(doc('old snapshot'));
const oldSuccess = delayed.enqueue()!;
delayed.observe(doc('new snapshot'));
releaseOldSuccess(); await oldSuccess;
assert.deepEqual(acknowledgedSnapshots, [], 'an older successful write is not acknowledged while a newer snapshot is pending');
const newSuccess = delayed.enqueue()!;
releaseNewSuccess(); await newSuccess;
assert.deepEqual(acknowledgedSnapshots, ['new snapshot']);

// A failed old write cannot displace a newer edit still inside the debounce.
let finish!: () => void;
const gate = new Promise<void>((resolve) => { finish = resolve; });
const recentWrites: string[] = [];
const debounced = new ProjectAutosaveQueue('debounced', async (projectId, snapshot) => {
  const name = snapshot.timelines[0]!.name;
  recentWrites.push(name);
  if (name === 'old') { await gate; throw new Error('old error'); }
  return { projectId, revision: 2, epoch: 0, status: 'saved', saved: true, indexUpdated: true };
});
debounced.observe(baseline); debounced.observe(doc('old'));
const pending = debounced.enqueue()!;
debounced.observe(doc('latest edit'));
finish(); await pending;
assert.equal(debounced.getSnapshot().status, 'saving');
await debounced.enqueue();
assert.deepEqual(recentWrites, ['old', 'latest edit']);
assert.equal(debounced.getSnapshot().status, 'saved');

const throws = new ProjectAutosaveQueue('throws', () => { throw new Error('snapshot failed'); });
throws.observe(baseline); throws.observe(edited);
assert.equal((await throws.enqueue())!.status, 'failed', 'synchronous snapshot failures remain retryable');
assert.equal(throws.hasPending(), true);
console.log('projectAutosaveQueue.verify: retry exact snapshot, busy/error/saved states, stale completion, debounce, effect replay and synchronous failures passed');
