import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import { resolveTranscriptUnit } from '../../transcript/trackEditCompiler';
import type { AgentContext } from '../context';
import { execTranscriptTool } from './transcript-tools';

const words = [
  { text: 'hello', start: 0, end: 400, speaker: 'A' },
  { text: 'world', start: 600, end: 1000, speaker: 'A' },
  { text: 'again', start: 1500, end: 2000, speaker: 'A' },
];

const clip: TimelineItem = {
  id: 'clip_voice',
  kind: 'audio',
  track: 'A1',
  startFrame: 0,
  durationInFrames: 60,
  name: 'voice',
  src: '/media/uploads/voice.wav',
  transcript: words,
};

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [],
  items: [clip],
  trackOrder: ['A1'],
  tracks: { A1: { kind: 'audio' } },
}));

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

// Perform real track-level edits first (delete word 1 + cap pause + reorder), then clear_edits.
draft.commands.deleteWords('clip_voice', [1]);
draft.commands.setGapCap('clip_voice', 2, 100);
draft.commands.setTranscriptPlayOrder('clip_voice', [2, 0]);
const beforeUnit = resolveTranscriptUnit(draft.getState(), 'clip_voice')!;
assert.equal(beforeUnit.deletedWordIdx.length, 1);
assert.equal(beforeUnit.playOrder?.length, 2);

const result = await execTranscriptTool(
  'manage_transcript',
  { action: 'clear_edits', itemId: 'clip_v' },
  ctx,
) as {
  ok?: boolean;
  action?: string;
  itemId?: string;
  restored?: { deletedWords: number; gapOverrides: number; silenceCap: boolean; playOrder: boolean };
  durationInFrames?: number;
};

assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.action, 'clear_edits');
assert.equal(result.itemId, 'clip_voice');
assert.equal(result.restored?.deletedWords, 1);
assert.equal(result.restored?.playOrder, true);

const afterUnit = resolveTranscriptUnit(draft.getState(), 'clip_voice')!;
assert.deepEqual(afterUnit.deletedWordIdx, []);
assert.equal(afterUnit.playOrder, undefined);
assert.equal(draft.getState().foldGroups, undefined, 'clear_edits dissolves temporary foldGroup');
assert.equal(afterUnit.canonicalWords.length, 3);
assert.ok(typeof result.durationInFrames === 'number' && result.durationInFrames > 0);

const again = await execTranscriptTool(
  'manage_transcript',
  { action: 'clear_edits', track: 'A1' },
  ctx,
) as { ok?: boolean; restored?: { deletedWords: number } };
assert.equal(again.ok, true);
assert.equal(again.restored?.deletedWords, 0);

console.log('transcript-clear-edits.verify: ok');
