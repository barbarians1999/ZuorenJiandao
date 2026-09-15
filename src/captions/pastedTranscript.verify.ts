import assert from 'node:assert/strict';
import { alignPastedTranscript, splitPastedTranscript } from './pastedTranscript';
import type { TranscriptWord } from '../transcript/types';

const words = (text: string): TranscriptWord[] => Array.from(text).map((character, index) => ({
  text: character,
  start: index * 100,
  end: (index + 1) * 100,
}));

assert.deepEqual(splitPastedTranscript('第一句。\n第二句！'), ['第一句。', '第二句！']);
const long = splitPastedTranscript('这是一段没有标点而且长度明显超过二十个汉字需要自动分开的完整文字稿');
assert.ok(long.length >= 2);
assert.ok(long.every((cue) => Array.from(cue).length <= 20));

const exact = alignPastedTranscript('这是一段口播。', words('这是一段口播'));
assert.equal(exact.cues.map((cue) => cue.text).join(''), '这是一段口播。');
assert.equal(exact.cues[0]!.start, 0);
assert.equal(exact.cues.at(-1)!.end, 600);
assert.ok(exact.quality > 0.95);
assert.equal(exact.weak, false);

const edited = alignPastedTranscript('今天讲新版本。这里删掉一句。最后导出 MP4。', words('今天讲旧版本这里有一句最后导出MP4'));
assert.equal(edited.cues.map((cue) => cue.text).join(''), '今天讲新版本。这里删掉一句。最后导出 MP4。');
for (let index = 0; index < edited.cues.length; index += 1) {
  const cue = edited.cues[index]!;
  assert.ok(cue.end > cue.start);
  if (index) assert.ok(cue.start >= edited.cues[index - 1]!.end);
}

const repeated = alignPastedTranscript('重复内容，重复内容。\n重复内容，最后一句。', words('重复内容重复内容重复内容最后一句'));
assert.equal(repeated.cues.length, 2);
assert.ok(repeated.cues[1]!.start >= repeated.cues[0]!.end);

const weak = alignPastedTranscript('苹果香蕉火车轮船。', words('完全不同的口播内容'));
assert.equal(weak.weak, true);

assert.throws(() => alignPastedTranscript('', words('有时间')),
  /请先粘贴文字稿/);
assert.throws(() => alignPastedTranscript('有文字', []),
  /请先进行本机转写/);

console.log('pastedTranscript.verify: local transcript-to-caption alignment passed');
