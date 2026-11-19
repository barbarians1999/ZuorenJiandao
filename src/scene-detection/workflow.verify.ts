import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce, type History } from '../editor/reduce';
import { moveItemWithGroups } from '../editor/linkGroups';
import type { ProjectDoc, Timeline, TimelineItem, TimelineLinkGroup } from '../editor/types';
import { mapScenesToItem, planSceneSplits, sceneAnalysisIdentity, sceneDetectionUnavailable, sceneRequestRange } from './apply';
import { SceneDetectionSession } from './session';
import type { SceneDetectionJobSnapshot } from './jobs';

const video: TimelineItem = { id: 'v', name: 'trimmed video', kind: 'video', track: 'V1', src: '/media/uploads/v.mp4',
  startFrame: 100, durationInFrames: 180, srcInFrame: 60, playbackRate: 2 };
const audio: TimelineItem = { id: 'a', name: 'detached linked audio', kind: 'audio', track: 'A1', src: '/media/uploads/a.wav',
  startFrame: 100, durationInFrames: 180, srcInFrame: 10, volume: .7 };
const music: TimelineItem = { ...audio, id: 'music', name: 'independent music', track: 'A2', startFrame: 0, durationInFrames: 400 };
const title: TimelineItem = { id: 'title', name: 'title', kind: 'text', track: 'V2', startFrame: 100, durationInFrames: 180, props: { text: 'keep' } };
const timeline: Timeline = { id: 'main', name: 'main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: video.id,
  items: [video, audio, music, title], trackOrder: ['V2', 'V1', 'A1', 'A2'],
  tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, A1: { kind: 'audio' }, A2: { kind: 'audio' } },
  linkGroups: [{ id: 'av', anchorItemId: video.id, mode: 'linked', itemIds: [video.id, audio.id] }],
};
assert.deepEqual(sceneRequestRange(video, 30), { rangeStartMs: 2000, rangeEndMs: 14000 });
assert.equal(sceneRequestRange({ ...video, playbackRate: 0 }, 30), null);
assert.equal(sceneRequestRange({ ...video, playbackRate: -1 }, 30), null);
assert.equal(sceneRequestRange({ ...video, playbackRate: Number.NaN }, 30), null);
assert.equal(sceneRequestRange(video, 0), null);
assert.equal(sceneDetectionUnavailable(timeline, { ...video, kind: 'gif' }), '请先选择视频片段');
assert.match(sceneDetectionUnavailable({ ...timeline, tracks: { V1: { kind: 'video', locked: true } } }, video)!, /锁定/);
const scenes = [{ timeMs: 1000, score: .6, kind: 'cut' as const }, { timeMs: 4000, score: .6, kind: 'cut' as const },
  { timeMs: 8000, score: .6, kind: 'cut' as const }, { timeMs: 15000, score: .6, kind: 'cut' as const }];
const mapped = mapScenesToItem(scenes, video, 30);
assert.deepEqual(mapped.map((scene) => scene.timelineFrame), [130, 190]);
assert.equal(mapScenesToItem(scenes, { ...video, playbackRate: -1 }, 30).length, 0);
assert.equal(sceneAnalysisIdentity(timeline, video), sceneAnalysisIdentity(timeline, { ...video, startFrame: 220 }));
assert.notEqual(sceneAnalysisIdentity(timeline, video), sceneAnalysisIdentity(timeline, { ...video, srcInFrame: 61 }));
const anotherTimeline: Timeline = { ...timeline, id: 'child' };
assert.notEqual(sceneAnalysisIdentity(timeline, video), sceneAnalysisIdentity(anotherTimeline, video));

let id = 0;
const before = structuredClone(timeline);
const plan = planSceneSplits(timeline, video.id, mapped, (prefix) => `${prefix}-${++id}`);
if (!plan.ok) assert.fail(plan.error);
assert.equal(plan.ok, true);
assert.deepEqual(timeline, before, 'planning does not mutate the input');
assert.equal(plan.cutCount, 2);
assert.equal(plan.linkedAudioCount, 1);
const fragments = (source: TimelineItem) => plan.state.items.filter((item) => item.src === source.src).sort((a, b) => a.startFrame - b.startFrame);
const vf = fragments(video), af = fragments(audio);
assert.deepEqual(vf.map((item) => [item.startFrame, item.durationInFrames, item.srcInFrame]), [[100, 30, 60], [130, 60, 120], [190, 90, 240]]);
assert.deepEqual(af.filter((item) => item.id !== 'music').map((item) => [item.startFrame, item.durationInFrames, item.srcInFrame]), [[100, 30, 10], [130, 60, 40], [190, 90, 100]]);
assert.deepEqual(plan.state.items.find((item) => item.id === music.id), music);
assert.deepEqual(plan.state.items.find((item) => item.id === title.id), title);
assert.equal(plan.state.linkGroups?.length, 3);
for (const fragment of vf) {
  const group: TimelineLinkGroup | undefined = plan.state.linkGroups!.find((entry) => entry.itemIds.includes(fragment.id));
  assert.equal(group?.mode, 'linked');
  const companion: TimelineItem | undefined = plan.state.items.find((item) => item.id !== fragment.id && group!.itemIds.includes(item.id));
  assert.equal(companion?.startFrame, fragment.startFrame);
  assert.equal(companion?.durationInFrames, fragment.durationInFrames);
}
const moved = moveItemWithGroups(plan.state, vf[2]!.id, 200);
assert.equal(moved.items.find((item) => item.id === vf[0]!.id)?.startFrame, 100, 'moving the last shot does not move previous shots');
assert.equal(moved.items.find((item) => item.kind === 'audio' && item.track === 'A1' && item.durationInFrames === 90)?.startFrame, 200);
const chosenOnly = planSceneSplits(timeline, video.id, [mapped[1]!]);
assert.equal(chosenOnly.ok && chosenOnly.cutCount, 1, 'only checked cut points are applied');
const locked = planSceneSplits({ ...timeline, tracks: { ...timeline.tracks, A1: { kind: 'audio', locked: true } } }, video.id, mapped);
assert.equal(locked.ok, false);
assert.deepEqual(timeline, before, 'a locked companion rejects the whole edit without partial changes');
const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: timeline.id, timelines: [timeline] };
let history: History = { past: [], present: doc, future: [] };
history = historyReduce(history, { type: 'batch', label: 'Split scenes', actions: [{ type: 'setFullState', state: plan.state }] });
assert.equal(history.past.length, 1);
assert.equal(history.present.timelines[0]!.items.length, 8);
const saved = JSON.parse(JSON.stringify(history.present)) as ProjectDoc;
assert.deepEqual(saved.timelines[0]!.linkGroups, plan.state.linkGroups, 'split A/V links survive save/reopen');
history = historyReduce(history, { type: 'undo' });
assert.deepEqual(history.present, doc);
history = historyReduce(history, { type: 'redo' });
assert.equal(history.present.timelines[0]!.items.length, 8);

const snapshot = (status: SceneDetectionJobSnapshot['status'] = 'queued'): SceneDetectionJobSnapshot => ({ id: 'job', src: video.src!, status,
  progress: 0, processedMs: 0, createdAt: 1, updatedAt: 1, result: null, error: null });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve }; };
{
  const pending = deferred<SceneDetectionJobSnapshot>(); const cancelled: string[] = [];
  const session = new SceneDetectionSession(() => pending.promise, async (jobId) => { cancelled.push(jobId); return snapshot('cancelled'); });
  const start = session.start({ src: video.src! });
  await assert.rejects(() => session.start({ src: video.src! }), /已有检测/);
  await session.cancel(); pending.resolve(snapshot());
  assert.equal(await start, null); assert.deepEqual(cancelled, ['job'], 'cancel during POST cancels the later-created job');
}
{
  const pending = deferred<SceneDetectionJobSnapshot>(); const cancelled: string[] = [];
  const session = new SceneDetectionSession(() => pending.promise, async (jobId) => { cancelled.push(jobId); return snapshot('cancelled'); });
  const start = session.start({ src: video.src! });
  await session.close(); pending.resolve(snapshot());
  assert.equal(await start, null); assert.deepEqual(cancelled, ['job'], 'closing before POST resolves leaves no detached job');
}
{
  const session = new SceneDetectionSession(async () => snapshot(), async () => snapshot('cancelled'));
  await session.start({ src: video.src! });
  assert.equal(session.accept({ ...snapshot(), id: 'old-job' }), false);
  await session.cancel();
  assert.equal(session.accept(snapshot('detecting')), false, 'a stale GET cannot revive a cancelled job');
  await session.close(); assert.equal(session.accept(snapshot('completed')), false);
}
{
  const session = new SceneDetectionSession(async () => snapshot(), async () => { throw new Error('cancel failed'); });
  await session.start({ src: video.src! });
  await assert.rejects(() => session.cancel(), /cancel failed/, 'cancellation errors are observable');
}
const server = readFileSync(new URL('../../server/plugins/scene-detection.ts', import.meta.url), 'utf8');
const timelineView = readFileSync(new URL('../components/timeline/Timeline.tsx', import.meta.url), 'utf8');
assert.equal((timelineView.match(/onPreviewCut=\{\(frame\) => \{ clearHoverPreview\(\); playerRef.current\?\.pause\(\); seekFrame\(frame\); \}\}/g) ?? []).length, 2,
  'toolbar and dialog preview use the frame seeker, never the mouse-coordinate seeker');
assert.match(server, /const detectionLimiter = new TaskLimiter\(1\)/);
assert.match(server, /const evidenceLimiter = new TaskLimiter\(2\)/);
assert.match(server, /detectionLimiter\.run\(\(\) => runJob\(job\)\)/);
assert.match(server, /detectionLimiter\.run\(\(\) => detectScenesInFile\(media.file, body\)\)/);
console.log('scene workflow: bounded source ranges, checked cuts, linked A/V partitions, one-step undo/reopen, latest identity and late cancellation passed');
