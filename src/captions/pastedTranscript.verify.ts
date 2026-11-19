import assert from 'node:assert/strict';
import { alignPastedTranscript, PastedTranscriptError, splitPastedTranscript } from './pastedTranscript';
import type { TranscriptWord } from '../transcript/types';

const words = (text: string): TranscriptWord[] => Array.from(text).map((character, index) => ({
  text: character,
  start: index * 100,
  end: (index + 1) * 100,
}));

// Basic splitting with trailing punctuation stripped
assert.deepEqual(splitPastedTranscript('第一句。\n第二句！'), ['第一句', '第二句']);

// Natural clause breaking at commas with trailing punctuation stripped
assert.deepEqual(
  splitPastedTranscript('当年在莫斯科，红军战士们英勇作战，彻底粉碎了敌人的进攻。'),
  ['当年在莫斯科', '红军战士们英勇作战', '彻底粉碎了敌人的进攻'],
);

// Short intro clause merged with main clause
assert.deepEqual(
  splitPastedTranscript('其实，事情远没有那么简单。'),
  ['其实，事情远没有那么简单'],
);

// Protected numbers and times
assert.deepEqual(
  splitPastedTranscript('售价为 3.14 万元，上午 10:30 开始直播。'),
  ['售价为 3.14 万元', '上午 10:30 开始直播'],
);

// Quotes with inner punctuation stripped while preserving closing quotes
assert.deepEqual(
  splitPastedTranscript('他大喊：“绝不后退！”接着冲了上去。'),
  ['他大喊：“绝不后退”', '接着冲了上去'],
);

// Book titles intact with trailing period stripped
assert.deepEqual(
  splitPastedTranscript('今天我们一起重读《资本论》。'),
  ['今天我们一起重读《资本论》'],
);

// Long sentence without punctuation split at word boundaries (never cutting a word)
const long = splitPastedTranscript('这是一段没有标点而且长度明显超过二十个汉字需要自动分开的完整文字稿');
assert.ok(long.length >= 2);
assert.ok(long.every((cue) => Array.from(cue).length <= 20));

// Specific Russian historical long sentence (no slicing words like 斯大林格勒, 保卫战, 法西斯侵略者)
const battle = '在斯大林格勒保卫战期间苏联红军以顽强的意志击溃了法西斯侵略者';
const battleChunks = splitPastedTranscript(battle, 20);
assert.ok(battleChunks.length >= 2);
assert.ok(battleChunks.some((s) => s.includes('斯大林格勒')));
assert.ok(battleChunks.some((s) => s.includes('保卫战')));
assert.ok(battleChunks.some((s) => s.includes('法西斯侵略者')));
assert.equal(battleChunks.join(''), battle);

// Alignment tests
const exact = alignPastedTranscript('这是一段口播。', words('这是一段口播'));
assert.equal(exact.cues.map((cue) => cue.text).join(''), '这是一段口播');
assert.equal(exact.cues[0]!.start, 0);
assert.equal(exact.cues.at(-1)!.end, 600);
assert.ok(exact.quality > 0.95);
assert.equal(exact.weak, false);
assert.deepEqual(exact.reviewCueIndices, [], 'exact sentences do not need an invented review warning');

const edited = alignPastedTranscript('今天讲新版本。这里删掉一句。最后导出 MP4。', words('今天讲旧版本这里有一句最后导出MP4'));
assert.equal(edited.cues.map((cue) => cue.text).join(''), '今天讲新版本这里删掉一句最后导出 MP4');
for (let index = 0; index < edited.cues.length; index += 1) {
  const cue = edited.cues[index]!;
  assert.ok(cue.end > cue.start);
  if (index) assert.ok(cue.start >= edited.cues[index - 1]!.end);
}

const repeated = alignPastedTranscript('重复内容，重复内容。\n重复内容，最后一句。', words('重复内容重复内容重复内容最后一句'));
assert.ok(repeated.cues.length >= 2);
for (let index = 0; index < repeated.cues.length; index += 1) {
  const cue = repeated.cues[index]!;
  assert.ok(cue.end > cue.start);
  if (index) assert.ok(cue.start >= repeated.cues[index - 1]!.end);
}

const weak = alignPastedTranscript('苹果香蕉火车轮船。', words('完全不同的口播内容'));
assert.equal(weak.weak, true);
assert.deepEqual(weak.reviewCueIndices, [0]);
const mixed = alignPastedTranscript('第一句完全相同。苹果香蕉轮船。末句完全相同。', words('第一句完全相同这些内容有差异末句完全相同'));
assert.ok(mixed.reviewCueIndices.includes(1), 'local mismatch must be discoverable even when track-level quality is acceptable');
assert.ok(mixed.reviewCueIndices.every((index) => index >= 0 && index < mixed.cues.length));
assert.deepEqual(alignPastedTranscript('一。二。三。', words('一')).reviewCueIndices, [0, 1, 2], 'proportional fallback flags all estimated sentences');

assert.throws(() => alignPastedTranscript('', words('有时间')),
  (error) => error instanceof PastedTranscriptError && error.code === 'empty-script');
assert.throws(() => alignPastedTranscript('有文字', []),
  (error) => error instanceof PastedTranscriptError && error.code === 'missing-timing');
assert.throws(() => alignPastedTranscript('!!!', words('有时间')),
  (error) => error instanceof PastedTranscriptError && error.code === 'no-matchable-text');

// Traditional Chinese Whisper ASR against Simplified Chinese pasted script.
const tradWords: TranscriptWord[] = [
  { text: '歡迎', start: 500, end: 900 },
  { text: '收看', start: 900, end: 1300 },
  { text: '這段', start: 1300, end: 1700 },
  { text: '關於', start: 2200, end: 2600 },
  { text: '歷史', start: 2600, end: 3000 },
  { text: '視頻', start: 3000, end: 3500 },
];
const t2sAligned = alignPastedTranscript('欢迎收看这段，关于历史视频。', tradWords);
assert.equal(t2sAligned.weak, false);
assert.deepEqual(t2sAligned.reviewCueIndices, []);
assert.equal(t2sAligned.cues[0]!.start, 500);
assert.equal(t2sAligned.cues[0]!.end, 1700, 'silence gap before next clause is preserved');
assert.equal(t2sAligned.cues[1]!.start, 2200);
assert.equal(t2sAligned.cues[1]!.end, 3500);

// 20-minute long-form script (~3,600 chars) with localized ~50-char insertion/deletion
// and uneven pauses: cues after the 50-char difference must stay locked to audio.
const longSentences: string[] = [];
const longWords: TranscriptWord[] = [];
let cursorMs = 1000;
for (let i = 0; i < 240; i += 1) {
  const sentence = `第${i + 1}节讲述莫斯科保卫战期间的关键战役细节。`;
  longSentences.push(sentence);
  if (i === 30) {
    // 50+ extra spoken characters in ASR not present in pasted script
    for (const ch of '这里口播临时补充了一段大约五十多字的现场背景解说用来测试长文档在遭遇局部差异之后是否依然能精准锁住声音') {
      longWords.push({ text: ch, start: cursorMs, end: cursorMs + 180 });
      cursorMs += 180;
    }
    cursorMs += 1500;
  }
  const cleanChars = Array.from(sentence.replace(/[。，]/g, ''));
  const stepMs = i % 3 === 0 ? 320 : 190; // uneven speaking rate
  for (const ch of cleanChars) {
    longWords.push({ text: ch, start: cursorMs, end: cursorMs + stepMs });
    cursorMs += stepMs;
  }
  cursorMs += i % 5 === 0 ? 1200 : 250; // varied inter-sentence silences
}
const tailExpectedStart = longWords.at(-Array.from('第240节讲述莫斯科保卫战期间的关键战役细节').length)!.start;
const tailExpectedEnd = longWords.at(-1)!.end;
// Also insert an unspoken 50-char paragraph in the pasted script around cue 120
// (note: each 21-char sentence splits into 2 cues cleanly by word boundary).
longSentences.splice(120, 0, '这段大约五十个字的书面补充内容在实际录音里完全被剪掉了请不要连累后面的时间');
const longStart = performance.now();
const longAligned = alignPastedTranscript(longSentences.join('\n'), longWords);
const longElapsedMs = performance.now() - longStart;
assert.ok(longElapsedMs < 500, `20-minute alignment stayed fast (${Math.round(longElapsedMs)}ms)`);
assert.equal(longAligned.weak, false);
assert.equal(longAligned.cues.at(-2)!.start, tailExpectedStart, 'final sentence after 50-char ASR extra + 50-char script insertion locks to true audio start');
assert.equal(longAligned.cues.at(-1)!.end, tailExpectedEnd, 'final cue locks to true audio end');
assert.ok(!longAligned.reviewCueIndices.includes(longAligned.cues.length - 1), 'tail cue needs no review flag');
assert.ok(longAligned.reviewCueIndices.length > 0 && longAligned.reviewCueIndices.length < 10, 'only the unspoken inserted paragraph is flagged for review');

console.log('pastedTranscript.verify: local transcript-to-caption alignment passed');
