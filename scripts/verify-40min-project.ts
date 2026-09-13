import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CURRENT_PROJECT_VERSION } from '../shared/project-version';
import { historyReduce, type History } from '../src/editor/reduce';
import { buildCommands } from '../src/editor/storeCommandBuilder';
import { captionTrackEntries, timelineDuration, type ProjectDoc, type TimelineItem } from '../src/editor/types';
import {
  createProject,
  flushProjectSaves,
  loadProject,
  resetProjectStoreMemory,
  saveProject,
} from '../src/persist/projectStore';

const FPS = 30;
const DURATION_FRAMES = 40 * 60 * FPS;

function videoItems(): TimelineItem[] {
  return Array.from({ length: 240 }, (_, index) => ({
    id: `video-${index}`,
    track: 'V1',
    startFrame: index * 10 * FPS,
    durationInFrames: 10 * FPS,
    srcInFrame: index * 3 * FPS,
    kind: 'video',
    name: `口播素材 ${index + 1}.mp4`,
    src: '/media/uploads/talking-head.mp4',
    sourceAssetId: 'asset-video',
    fadeInFrames: index === 0 ? 0 : 6,
    fadeOutFrames: 6,
  }));
}

function mgItems(): TimelineItem[] {
  return Array.from({ length: 80 }, (_, index) => ({
    id: `mg-${index}`,
    track: 'V2',
    startFrame: index * 30 * FPS + 8 * FPS,
    durationInFrames: 6 * FPS,
    kind: 'motion-graphic',
    name: `SH${String(index + 1).padStart(3, '0')} MG`,
    templateId: 'kinetic-type',
    props: { text: `重点 ${index + 1}` },
    keyframes: {
      x: [
        { frame: 0, value: -25, easing: 'easeOut' },
        { frame: 24, value: 0, easing: 'easeInOut' },
        { frame: 150, value: 0, easing: 'easeIn' },
        { frame: 179, value: 20 },
      ],
      opacity: [
        { frame: 0, value: 0, easing: 'easeOut' },
        { frame: 12, value: 1 },
        { frame: 168, value: 1, easing: 'easeIn' },
        { frame: 179, value: 0 },
      ],
    },
  }));
}

function narrationItems(): TimelineItem[] {
  return Array.from({ length: 40 }, (_, index) => ({
    id: `narration-${index}`,
    track: 'A1',
    startFrame: index * 60 * FPS,
    durationInFrames: 60 * FPS,
    srcInFrame: index * 60 * FPS,
    kind: 'audio',
    name: `口播 ${index + 1}.mp3`,
    src: '/media/uploads/narration.mp3',
    sourceAssetId: 'asset-narration',
    volume: 1,
    fadeInFrames: 3,
    fadeOutFrames: 3,
  }));
}

function document(): ProjectDoc {
  const captionWords = Array.from({ length: 240 }, (_, index) => ({
    id: `caption-${index}`,
    text: `第${index + 1}段口播字幕`,
    start: index * 10_000,
    end: index * 10_000 + 9_000,
  }));
  return {
    version: CURRENT_PROJECT_VERSION,
    activeTimelineId: 'timeline-main',
    mediaFolders: [],
    assets: [
      { id: 'asset-video', name: 'talking-head.mp4', kind: 'video', src: '/media/uploads/talking-head.mp4', durationInFrames: DURATION_FRAMES },
      { id: 'asset-narration', name: 'narration.mp3', kind: 'audio', src: '/media/uploads/narration.mp3', durationInFrames: DURATION_FRAMES },
      { id: 'asset-bgm', name: 'bgm.mp3', kind: 'audio', src: '/media/uploads/bgm.mp3', durationInFrames: DURATION_FRAMES },
    ],
    timelines: [{
      id: 'timeline-main',
      name: '40 分钟横屏主时间线',
      order: 0,
      fps: FPS,
      width: 1920,
      height: 1080,
      trackOrder: ['V2', 'V1', 'C1', 'A1', 'A2'],
      tracks: {
        V2: { kind: 'video', name: 'MG' },
        V1: { kind: 'video', name: '主画面' },
        C1: {
          kind: 'caption',
          name: '字幕',
          captions: {
            enabled: true,
            template: 'bold-outline',
            pacing: 'phrase',
            motionPreset: 'none',
            words: captionWords,
            styleOverride: {
              fontFamily: 'Source Han Serif SC',
              color: '#000000',
              strokeColor: '#ffffff',
              strokeWidth: 6,
              wordsPerPage: 1,
            },
            layout: { anchor: 'bottom-center' },
          },
        },
        A1: { kind: 'audio', name: '口播', role: 'anchor' },
        A2: { kind: 'audio', name: 'BGM', role: 'follower', audioRouting: { duckDepthDb: -12 } },
      },
      items: [
        ...videoItems(),
        ...mgItems(),
        ...narrationItems(),
        {
          id: 'bgm',
          track: 'A2',
          startFrame: 0,
          durationInFrames: DURATION_FRAMES,
          kind: 'audio',
          name: '全片 BGM.mp3',
          src: '/media/uploads/bgm.mp3',
          sourceAssetId: 'asset-bgm',
          volume: 0.2,
          fadeInFrames: 60,
          fadeOutFrames: 120,
        },
      ],
      selectedId: null,
    }],
  };
}

resetProjectStoreMemory();
const source = document();
assert.equal(timelineDuration(source.timelines[0]!), DURATION_FRAMES);
assert.equal(source.timelines[0]!.items.length, 361);

const createStarted = performance.now();
const project = await createProject('左人剪刀 40 分钟验收', source);
const createMs = performance.now() - createStarted;

let history: History = { past: [], present: source, future: [] };
const commands = buildCommands(
  (action) => { history = historyReduce(history, action); },
  () => history.present,
);
const editStarted = performance.now();
commands.batch([
  { type: 'move', id: 'mg-40', startFrame: 40 * 30 * FPS + 8 * FPS + 15 },
  { type: 'setKeyframe', id: 'mg-40', prop: 'x', frame: 90, value: 12, easing: 'easeInOut' },
  { type: 'setVolume', id: 'bgm', volume: 0.18 },
], '40 分钟工程手动调整');
const editMs = performance.now() - editStarted;

const saveStarted = performance.now();
const saved = await saveProject(project.id, history.present);
assert.equal(saved.saved, true);
const flushed = await flushProjectSaves(project.id);
assert.equal(flushed.ok, true);
const saveMs = performance.now() - saveStarted;

const reopenStarted = performance.now();
const reopened = await loadProject(project.id);
const reopenMs = performance.now() - reopenStarted;
assert.ok(reopened);
const reopenedTimeline = reopened.timelines[0]!;
assert.equal(reopenedTimeline.width, 1920);
assert.equal(reopenedTimeline.height, 1080);
assert.equal(reopenedTimeline.fps, FPS);
assert.equal(reopenedTimeline.items.length, 361);
assert.equal(timelineDuration(reopenedTimeline), DURATION_FRAMES);
assert.equal(reopenedTimeline.items.find((item) => item.id === 'mg-40')?.startFrame, 36_255);
assert.equal(reopenedTimeline.items.find((item) => item.id === 'bgm')?.volume, 0.18);
assert.equal(reopenedTimeline.items.find((item) => item.id === 'mg-40')?.keyframes?.x?.some((keyframe) => keyframe.frame === 90 && keyframe.value === 12), true);
const captionCues = captionTrackEntries(reopenedTimeline)
  .flatMap((entry) => entry.captions?.words ?? []).length;
assert.equal(captionCues, 240);

const serializedBytes = Buffer.byteLength(JSON.stringify(reopened));
console.log(JSON.stringify({
  durationMinutes: 40,
  resolution: '1920x1080',
  fps: FPS,
  timelineItems: reopenedTimeline.items.length,
  captionCues,
  serializedBytes,
  createMs: Number(createMs.toFixed(2)),
  editMs: Number(editMs.toFixed(2)),
  saveMs: Number(saveMs.toFixed(2)),
  reopenMs: Number(reopenMs.toFixed(2)),
  heapUsedMiB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)),
}));
