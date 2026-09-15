import assert from 'node:assert/strict';
import type { TimelineItem } from '../editor/types';
import { buildPastedTranscriptTrack, transcribedSpeechOnTrack } from './pastedTranscriptTrack';

const item = (id: string, track: string, startFrame: number, text: string, name = id): TimelineItem => ({
  id,
  track,
  kind: 'audio',
  name,
  src: `local://${id}.mp3`,
  startFrame,
  durationInFrames: 30,
  transcript: Array.from(text).map((character, index) => ({ text: character, start: index * 100, end: (index + 1) * 100 })),
});

const items = [
  item('voice-1', 'A1', 0, '第一句口播'),
  item('music', 'A1', 30, '不应进入字幕', 'BGM music'),
  item('voice-2', 'A1', 60, '第二句口播'),
  item('other', 'A2', 0, '其他轨道'),
];

assert.deepEqual(transcribedSpeechOnTrack(items, 'A1').map(({ id }) => id), ['voice-1', 'voice-2']);
const built = buildPastedTranscriptTrack({
  script: '第一句口播。\n第二句口播。',
  items,
  fps: 30,
  track: 'A1',
  laneId: 'lane-test',
  label: '文字稿字幕',
});
assert.deepEqual(built.sourceItemIds, ['voice-1', 'voice-2']);
assert.equal(built.captions.sourceEntries?.[0]?.words?.map(({ text }) => text).join(''), '第一句口播。第二句口播。');
assert.equal(built.captions.template, 'plain');
assert.equal(built.captions.styleOverride?.fontFamily, 'Noto Sans SC');
assert.equal(built.captions.styleOverride?.color, '#111111');
assert.equal(built.captions.styleOverride?.strokeColor, '#ffffff');
assert.equal(built.captions.styleOverride?.wholeLine, true);
assert.throws(() => buildPastedTranscriptTrack({ ...built, script: '没有来源', items, fps: 30, track: 'A3', laneId: 'none', label: 'none' }), /没有可用的转写/);

console.log('pastedTranscriptTrack.verify: full speech track creates an independent styled caption lane');
