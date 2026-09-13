import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { AgentContext } from '../agent/context';
import { execExportTool } from '../agent/tools/export-tools';
import type { ProjectDoc, Timeline, TimelineItem } from '../editor/types';
import {
  buildSharedShotPlan,
  canonicalJson,
  fingerprintSharedShotPlan,
  SharedShotPlanError,
} from './sharedShotPlan';

const video = (
  id: string,
  track: string,
  startFrame: number,
  durationInFrames: number,
  sourceAssetId = id,
): TimelineItem => ({
  id,
  track,
  startFrame,
  durationInFrames,
  kind: 'video',
  name: `${id}.mp4`,
  sourceAssetId,
  sourceFilename: `${id}.mp4`,
  src: `C:\\private\\${id}.mp4`,
});

function project(timeline: Timeline, inactive?: Timeline): ProjectDoc {
  const assetIds = new Set(timeline.items.map((item) => item.sourceAssetId).filter((id): id is string => !!id));
  return {
    version: CURRENT_PROJECT_VERSION,
    activeTimelineId: timeline.id,
    mediaFolders: [],
    timelines: inactive ? [timeline, inactive] : [timeline],
    assets: [...assetIds].map((id) => ({
      id,
      name: `${id}.mp4`,
      sourceFilename: `${id}.mp4`,
      kind: 'video',
      src: `C:\\machine-a\\${id}.mp4`,
      durationInFrames: 900,
      sourceContentHash: id.padEnd(64, '0').slice(0, 64),
    })),
  };
}

function timeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    id: 'timeline-main',
    name: '主片',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    trackOrder: ['overlay', 'main', 'C1'],
    tracks: {
      overlay: { kind: 'video', name: '叠加' },
      main: { kind: 'video', name: 'V1' },
      C1: { kind: 'caption' },
    },
    items: [
      video('base-a', 'main', 0, 100),
      video('base-b', 'main', 100, 100),
      video('overlay-a', 'overlay', 20, 10),
      video('overlay-b', 'overlay', 70, 80),
    ],
    captions: {
      enabled: true,
      template: 'plain',
      pacing: 'phrase',
      words: [
        { id: 'w1', text: '第一句。', start: 0, end: 2_900 },
        { id: 'w2', text: '第二句。', start: 3_000, end: 6_000 },
      ],
    },
    selectedId: null,
    ...overrides,
  };
}

const baseDoc = project(timeline());
const plan = await buildSharedShotPlan({
  doc: baseDoc,
  projectId: 'local-project-a',
  generatedAt: '2026-09-13T00:00:00.000Z',
});
assert.equal(plan.schema_version, 'narrated-video-shot-plan/v1');
assert.equal(plan.project.primary_track_id, 'main');
assert.deepEqual(plan.shots.map((shot) => shot.shot_id), ['SH001', 'SH002']);
assert.deepEqual((plan.shots[0]!.visual as { overlays: unknown[] }).overlays.length, 2,
  '叠加层只被记录，不为每个 V2 边界切分镜');
assert.deepEqual((plan.shots[1]!.visual as { overlays: unknown[] }).overlays.length, 1);
assert.equal(plan.validation.warnings.some((warning) => warning.code === 'SHOT_BOUNDARY_SPLITS_SENTENCE'), true);
assert.deepEqual((plan.shots[0]!.sentences as { ids: string[] }).ids, ['S001', 'S002']);
assert.deepEqual((plan.shots[1]!.sentences as { ids: string[] }).ids, ['S002']);
assert.equal((plan.shots[0]!.animation_handoff as { master_filename: string }).master_filename, 'SH001_animation.mov');

const gapTimeline = timeline({
  items: [video('base-a', 'main', 0, 50), video('base-b', 'main', 70, 30), video('cover', 'overlay', 40, 40)],
  captions: null,
});
const gapPlan = await buildSharedShotPlan({ doc: project(gapTimeline), generatedAt: '2026-09-13T00:00:00.000Z' });
assert.deepEqual(gapPlan.shots.map((shot) => {
  const value = shot.timeline as { start_frame: number; end_frame_exclusive: number };
  return { start_frame: value.start_frame, end_frame_exclusive: value.end_frame_exclusive };
}), [
  { start_frame: 0, end_frame_exclusive: 50 },
  { start_frame: 50, end_frame_exclusive: 70 },
  { start_frame: 70, end_frame_exclusive: 100 },
]);
assert.equal((gapPlan.shots[1]!.visual as { kind: string }).kind, 'gap');
assert.equal(gapPlan.validation.warnings.some((warning) => warning.code === 'PRIMARY_VISUAL_GAP'), true);
assert.equal(gapPlan.validation.warnings.some((warning) => warning.code === 'CAPTION_WORDS_UNAVAILABLE'), true);

const anchorTimeline = timeline({
  tracks: {
    overlay: { kind: 'video', name: '其他轨', role: 'anchor' },
    main: { kind: 'video', name: 'V1', role: 'follower' },
    C1: { kind: 'caption' },
  },
});
assert.equal((await buildSharedShotPlan({ doc: project(anchorTimeline) })).project.primary_track_id, 'overlay');

const ambiguousTimeline = timeline({
  tracks: {
    overlay: { kind: 'video', name: '上层' },
    main: { kind: 'video', name: '下层' },
    C1: { kind: 'caption' },
  },
});
await assert.rejects(
  buildSharedShotPlan({ doc: project(ambiguousTimeline) }),
  (error: unknown) => error instanceof SharedShotPlanError
    && error.code === 'PRIMARY_TRACK_AMBIGUOUS'
    && (error.details as { candidates: unknown[] }).candidates.length === 2,
);
assert.equal((await buildSharedShotPlan({ doc: project(ambiguousTimeline), primaryTrackId: 'main' })).project.primary_track_id, 'main');

const overlappingTimeline = timeline({
  items: [video('base-a', 'main', 0, 60), video('base-b', 'main', 50, 50)],
});
await assert.rejects(
  buildSharedShotPlan({ doc: project(overlappingTimeline) }),
  (error: unknown) => error instanceof SharedShotPlanError && error.code === 'PRIMARY_TRACK_OVERLAP',
);

const invalidCaptions = timeline();
invalidCaptions.captions!.words = [
  { id: 'w1', text: '后一句。', start: 2_000, end: 2_500 },
  { id: 'w2', text: '前一句。', start: 1_000, end: 1_500 },
];
await assert.rejects(
  buildSharedShotPlan({ doc: project(invalidCaptions) }),
  (error: unknown) => error instanceof SharedShotPlanError && error.code === 'INVALID_CAPTION_TIMING',
  '字幕词时间倒序时拒绝导出',
);

const movedMachineDoc = structuredClone(baseDoc);
movedMachineDoc.assets.forEach((asset) => { asset.src = `D:\\replacement\\${asset.name}`; });
movedMachineDoc.timelines[0]!.items.forEach((item) => { if (item.src) item.src = `D:\\replacement\\${item.name}`; });
const machinePlan = await buildSharedShotPlan({
  doc: movedMachineDoc,
  projectId: 'local-project-b',
  generatedAt: '2030-01-01T00:00:00.000Z',
});
assert.equal(machinePlan.project.timeline_version, plan.project.timeline_version, '换机路径不改变时间线版本');
assert.equal(machinePlan.plan_fingerprint, plan.plan_fingerprint, '本机工程 id、路径和生成时间不改变计划指纹');
assert.doesNotMatch(JSON.stringify(machinePlan), /D:\\\\replacement|C:\\\\private|C:\\\\machine-a/,
  '共享计划不得泄漏绝对素材路径');

const overlayMoved = structuredClone(baseDoc);
overlayMoved.timelines[0]!.items.find((item) => item.id === 'overlay-a')!.startFrame += 1;
const movedPlan = await buildSharedShotPlan({ doc: overlayMoved, generatedAt: plan.generated_at });
assert.deepEqual(movedPlan.shots.map((shot) => shot.shot_id), ['SH001', 'SH002']);
assert.notEqual(movedPlan.project.timeline_version, plan.project.timeline_version, '叠加层变化使旧动画清单失效');
assert.notEqual(movedPlan.plan_fingerprint, plan.plan_fingerprint);

const creativeRevision = structuredClone(plan);
(creativeRevision.shots[0]!.animation_handoff as Record<string, unknown>).brief = '数字从左侧进入';
creativeRevision.plan_fingerprint = await fingerprintSharedShotPlan(creativeRevision);
assert.equal(creativeRevision.project.timeline_version, plan.project.timeline_version,
  '只改动画说明不制造第二套时间线版本');
assert.notEqual(creativeRevision.plan_fingerprint, plan.plan_fingerprint,
  '动画说明变化仍会使共享计划指纹变化');

const inactive: Timeline = { ...timeline({ id: 'inactive', name: '未打开时间线' }), order: 1 };
const withInactive = project(timeline(), inactive);
const inactivePlanA = await buildSharedShotPlan({ doc: withInactive, generatedAt: plan.generated_at });
withInactive.timelines[1]!.items[0]!.startFrame += 20;
const inactivePlanB = await buildSharedShotPlan({ doc: withInactive, generatedAt: plan.generated_at });
assert.equal(inactivePlanA.project.timeline_version, inactivePlanB.project.timeline_version,
  '非活动时间线不参与共享分镜版本');

const markerTimeline = timeline({
  markers: [{ id: 'chapter-1', scope: 'project', fromFrame: 40, durationFrames: 0, note: '章节：劳动与技术', color: 'red' }],
});
const markerPlan = await buildSharedShotPlan({ doc: project(markerTimeline) });
assert.equal(markerPlan.shots.length, 2, '章节标记不制造切点');
assert.equal(markerPlan.chapters[0]?.topic, '劳动与技术');
assert.equal(markerPlan.shots[1]?.chapter_id, 'chapter-1');

assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));

const previousDocument = globalThis.document;
const previousCreateObjectUrl = URL.createObjectURL;
const previousRevokeObjectUrl = URL.revokeObjectURL;
let clicks = 0;
let downloadedName = '';
URL.createObjectURL = (() => 'blob:shared-shot-plan') as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
globalThis.document = {
  createElement: () => ({
    href: '',
    set download(value: string) { downloadedName = value; },
    get download() { return downloadedName; },
    click() { clicks += 1; },
    remove() {},
  }),
  body: { appendChild() {} },
} as unknown as Document;
try {
  const ctx: AgentContext = {
    commands: {} as AgentContext['commands'],
    getState: () => baseDoc.timelines[0]!,
    getDoc: () => baseDoc,
    getProjectId: () => 'local-project-a',
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  };
  const result = await execExportTool('export_shared_shot_plan', { filename: '共享/分镜' }, ctx) as {
    ok?: boolean; shotCount?: number; timelineVersion?: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.shotCount, 2);
  assert.match(result.timelineVersion ?? '', /^tlv1-[0-9a-f]{64}$/);
  assert.equal(clicks, 1);
  assert.equal(downloadedName, '共享_分镜.json');

  const ambiguousCtx = { ...ctx, getDoc: () => project(ambiguousTimeline) };
  const failed = await execExportTool('export_shared_shot_plan', {}, ambiguousCtx) as { code?: string };
  assert.equal(failed.code, 'PRIMARY_TRACK_AMBIGUOUS');
  assert.equal(clicks, 1, '致命校验失败不得触发下载');
} finally {
  globalThis.document = previousDocument;
  URL.createObjectURL = previousCreateObjectUrl;
  URL.revokeObjectURL = previousRevokeObjectUrl;
}

console.log('sharedShotPlan.verify: primary-track shots, overlays, gaps, captions, hashes, and download gate passed');
