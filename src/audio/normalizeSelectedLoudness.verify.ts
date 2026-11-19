import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { activeEditorState, type TimelineItem } from '../editor/types';
import { loudnessSelectionForItem } from './normalizeSelectedLoudness';
import { analyzeLoudnessSelections, measureLoudnessRanges } from './loudness';

const base: TimelineItem = {
  id: 'trimmed', name: 'trimmed', kind: 'audio', src: '/same.wav', track: 'A1',
  startFrame: 0, srcInFrame: 10, durationInFrames: 20, playbackRate: 2,
};
const doc = {
  version: CURRENT_PROJECT_VERSION, assets: [], activeTimelineId: 'main', mediaFolders: [],
  timelines: [{ id: 'main', name: 'main', order: 0, width: 1920, height: 1080, fps: 30, selectedId: null, items: [base] }],
};
const state = activeEditorState(doc);
assert.deepEqual(loudnessSelectionForItem(base, state).ranges, [{ startFrame: 10, endFrame: 50 }]);
assert.equal(loudnessSelectionForItem(base, state).playbackRate, 2);
assert.throws(() => loudnessSelectionForItem({ ...base, playbackRate: 0 }, state), /变速无效/);

const transcriptItem: TimelineItem = {
  ...base, id: 'edited', srcInFrame: 0, durationInFrames: 90, playbackRate: 1,
  transcript: [
    { text: 'one', start: 0, end: 1000 },
    { text: 'two', start: 1000, end: 2000 },
    { text: 'three', start: 2000, end: 3000 },
  ],
  deletedWordIdx: [1], transcriptPlayOrder: [2, 0, 2],
};
const transcriptState = activeEditorState({ ...doc, timelines: [{ ...doc.timelines[0]!, items: [transcriptItem] }] });
assert.deepEqual(loudnessSelectionForItem(transcriptItem, transcriptState).ranges, [
  { startFrame: 60, endFrame: 90 }, { startFrame: 0, endFrame: 30 }, { startFrame: 60, endFrame: 90 },
], 'play order duplicates are retained and deleted words are excluded');

const source = new Float32Array(90).fill(0.01);
source.fill(0.1, 0, 30);
source.fill(0.5, 30, 60);
const firstRange = measureLoudnessRanges([source], 30, 30, [{ startFrame: 0, endFrame: 30 }]);
const secondRange = measureLoudnessRanges([source], 30, 30, [{ startFrame: 30, endFrame: 60 }]);
assert(firstRange.lufs < secondRange.lufs - 10, 'samples outside each trim do not affect its loudness');
assert.equal(secondRange.samplePeak, 0.5);
assert.throws(() => measureLoudnessRanges([new Float32Array(30)], 30, 30,
  [{ startFrame: 0, endFrame: 30 }]), /没有可分析声音/);
const shortRate = measureLoudnessRanges([source], 30, 30, [{ startFrame: 0, endFrame: 30 }], 2);
assert(Math.abs(shortRate.lufs - firstRange.lufs) < 0.1, 'positive playback rate preserves amplitude while mapping output time');

let decodeCalls = 0;
const grouped = await analyzeLoudnessSelections([
  { itemId: 'a', src: '/same.wav', fps: 30, playbackRate: 1, ranges: [{ startFrame: 0, endFrame: 30 }] },
  { itemId: 'b', src: '/same.wav', fps: 30, playbackRate: 1, ranges: [{ startFrame: 30, endFrame: 60 }] },
], async () => {
  decodeCalls += 1;
  return { numberOfChannels: 1, sampleRate: 30, getChannelData: () => source } as unknown as AudioBuffer;
});
assert.equal(decodeCalls, 1, 'a shared source is decoded once per operation');
const measuredA = grouped.get('a');
const measuredB = grouped.get('b');
if (measuredA?.status !== 'fulfilled' || measuredB?.status !== 'fulfilled') throw new Error('range analysis did not finish');
assert.notEqual(measuredA.value.lufs, measuredB.value.lufs, 'different trims are measured independently');

console.log('normalizeSelectedLoudness.verify: trim mapping, retime, transcript mapping, source sharing and range-specific measurement OK');
