import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { ProjectDoc, TimelineItem } from '../editor/types';
import { migrateProjectDoc } from '../persist/projectStore';
import { newTranscriptGeneration } from '../transcript/identity';
import { identifyManualCues } from './manualCaptions';
import { parseSrt } from './srt';
import { buildCues } from './captionCues';
import { planCaptionCueEdit } from './captionCueEditing';
import { captionListId } from './captionList';
import { historyReduce, type History } from '../editor/reduce';
import { buildCommands } from '../editor/storeCommandBuilder';
import type { CaptionsData } from './types';

const fps = 30;
const makeSource = (): TimelineItem => ({ id: 'asr-source', track: 'V1', kind: 'video', name: 'ASR source', src: '/media/asr.mp4',
  startFrame: 30, durationInFrames: 180, ...newTranscriptGeneration([
    { text: 'Keep', start: 200, end: 500 }, { text: '🧪', start: 600, end: 900 }, { text: 'spaces', start: 1100, end: 1400 },
  ]) });
const sourceCaptions = (source: TimelineItem): CaptionsData => ({ enabled: true, template: 'plain', pacing: 'phrase', sourceMode: 'item',
  sourceEntries: [{ id: 'asr-lane', itemId: source.id }] });
const text = (row: ReturnType<typeof buildCues>[number]) => row.text;
function planned(captions: CaptionsData, items: TimelineItem[], action: 'split' | 'mergePrevious' | 'mergeNext', rowIndex: number, value: string, caret?: number): CaptionsData {
  const rows = buildCues(captions, items, fps);
  let result = planCaptionCueEdit({ captions, items, fps, rows, rowIndex, action, text: value, caret });
  if (result.confirm) result = planCaptionCueEdit({ captions, items, fps, rows, rowIndex, action, text: value, caret, acceptMergeConflict: true });
  assert(result.patch, result.reason ?? `${action} should produce a patch`);
  return { ...captions, ...result.patch };
}
function persistReload(captions: CaptionsData, source: TimelineItem): { doc: ProjectDoc; captions: CaptionsData } {
  const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [{
    id: 'main', name: 'main', order: 0, fps, width: 1920, height: 1080, selectedId: null, items: [source],
    trackOrder: ['C1', 'V1'], tracks: { C1: { kind: 'caption', captions }, V1: { kind: 'video' } },
  }] };
  const migrated = migrateProjectDoc(JSON.parse(JSON.stringify(doc)) as unknown);
  assert(migrated, 'serialized project should migrate and reload');
  const loadedCaptions = Object.values(migrated.timelines[0]?.tracks ?? {}).find((track) => track?.kind === 'caption')?.captions;
  assert(loadedCaptions, 'caption track survives JSON migration');
  return { doc: migrated, captions: loadedCaptions };
}

// SRT-imported/manual cues split at the caret, retain visible whitespace and emoji, then merge with only the adjacent cue text.
{
  const imported = identifyManualCues(parseSrt('1\n00:00:00,000 --> 00:00:01,000\n  keep 🧪 spaces  \n\n2\n00:00:01,100 --> 00:00:02,000\nnext\n'));
  const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceEntries: [{ id: 'srt-lane', itemId: 'manual:srt-lane', words: imported }] };
  const initialRows = buildCues(captions, [], fps);
  const original = text(initialRows[0]!);
  const split = planned(captions, [], 'split', 0, original, original.indexOf('🧪'));
  const splitRows = buildCues(split, [], fps);
  assert.equal(splitRows.length, 3);
  assert.equal(`${splitRows[0]!.text}${splitRows[1]!.text}`, original, 'split preserves the original whitespace and emoji');
  assert(splitRows[0]!.text.endsWith(' '));
  assert(splitRows[1]!.text.startsWith('🧪'));
  const merged = planned(split, [], 'mergeNext', 1, splitRows[1]!.text);
  const mergedRows = buildCues(merged, [], fps);
  assert.equal(mergedRows.length, 2);
  assert.equal(mergedRows[1]!.text, '🧪 spaces next', 'merge joins the adjacent cue once instead of duplicating the full source phrase');
}

// A two-frame manual cue can split; a one-frame cue and a caret with a blank side are rejected without a patch.
{
  const words = identifyManualCues(parseSrt('1\n00:00:00,000 --> 00:00:00,067\na🧪\n\n2\n00:00:01,000 --> 00:00:01,033\nxy\n'));
  const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceEntries: [{ id: 'short', itemId: 'manual:short', words }] };
  const rows = buildCues(captions, [], fps);
  const allowed = planCaptionCueEdit({ captions, items: [], fps, rows, rowIndex: 0, action: 'split', text: rows[0]!.text, caret: 1 });
  assert(allowed.patch, allowed.reason ?? 'two frames should split');
  const oneFrame = planCaptionCueEdit({ captions, items: [], fps, rows, rowIndex: 1, action: 'split', text: rows[1]!.text, caret: 1 });
  assert.equal(oneFrame.patch, null);
  assert(oneFrame.reason);
  const blankSide = planCaptionCueEdit({ captions, items: [], fps, rows, rowIndex: 0, action: 'split', text: rows[0]!.text, caret: 0 });
  assert.equal(blankSide.patch, null);
  assert(blankSide.reason);
}

// Source-linked ASR split persists through migration, merges by span, and continues to follow source timing.
{
  const source = makeSource();
  const originalTranscript = structuredClone(source.transcript);
  const captions = sourceCaptions(source);
  const rows = buildCues(captions, [source], fps);
  assert.equal(rows.length, 1, 'the normal word gaps remain in one phrase cue');
  assert.equal(rows[0]!.text, 'Keep 🧪 spaces');
  const split = planned(captions, [source], 'split', 0, rows[0]!.text, 5);
  const savedSplit = persistReload(split, source);
  const splitRows = buildCues(savedSplit.captions, [source], fps);
  assert.deepEqual(splitRows.map(text), ['Keep ', '🧪 spaces']);
  assert(splitRows.every((row) => row.displayCuePartId));
  assert.deepEqual(savedSplit.captions.sourceEntries?.[0]?.displayCueEdits?.[0]?.coveredWordRefs, rows[0]!.wordRefs,
    'the display edit covers the lane-stable refs associated with the three ASR words');
  const removeLeft = planCaptionCueEdit({ captions: savedSplit.captions, items: [source], fps, rows: splitRows, rowIndex: 0, action: 'save', text: '' });
  assert(removeLeft.patch, removeLeft.reason ?? 'first display part should be removable');
  const afterLeftRemoval = { ...savedSplit.captions, ...removeLeft.patch };
  const remainingRows = buildCues(afterLeftRemoval, [source], fps);
  assert.equal(remainingRows.length, 1);
  const removeLast = planCaptionCueEdit({ captions: afterLeftRemoval, items: [source], fps, rows: remainingRows, rowIndex: 0, action: 'save', text: '' });
  assert(removeLast.patch, removeLast.reason ?? 'last display part should be removable');
  const deletedRoundTrip = persistReload({ ...afterLeftRemoval, ...removeLast.patch }, source);
  const emptyEdit = deletedRoundTrip.captions.sourceEntries?.[0]?.displayCueEdits?.[0];
  assert.deepEqual(emptyEdit?.parts, [], 'removing the last part retains an empty suppression record');
  assert.deepEqual(emptyEdit?.coveredWordRefs, rows[0]!.wordRefs);
  assert.equal(buildCues(deletedRoundTrip.captions, [source], fps).length, 0, 'deleted display text does not revive original ASR words');
  const merged = planned(savedSplit.captions, [source], 'mergeNext', 0, splitRows[0]!.text);
  const savedMerge = persistReload(merged, source);
  const mergedRows = buildCues(savedMerge.captions, [source], fps);
  assert.equal(mergedRows.length, 1);
  assert.equal(mergedRows[0]!.text, 'Keep 🧪 spaces');
  assert.equal(mergedRows[0]!.start, rows[0]!.start);
  assert.equal(mergedRows[0]!.end, rows[0]!.end);
  assert.equal(savedMerge.captions.sourceEntries?.[0]?.itemId, source.id, 'source association survives split, migration, and merge');
  assert.deepEqual(source.transcript, originalTranscript, 'display edits never mutate the source ASR transcript');

  const moved = buildCues(savedMerge.captions, [{ ...source, startFrame: source.startFrame + 30 }], fps)[0]!;
  assert.equal(moved.start - mergedRows[0]!.start, 1000, 'display timing follows a source move');
  const trimmedItem = { ...source, startFrame: 30, srcInFrame: 6, durationInFrames: 90 };
  const trimmed = buildCues(savedMerge.captions, [trimmedItem], fps)[0]!;
  assert.equal(trimmed.start, 1000, 'display timing follows the source trim boundary');
  const sped = buildCues(savedMerge.captions, [{ ...trimmedItem, playbackRate: 2 }], fps)[0]!;
  assert.equal(sped.start, trimmed.start);
  assert.equal(sped.end - sped.start, (trimmed.end - trimmed.start) / 2, 'fixed positive playback speed scales the projected span');

  const unsafe = planCaptionCueEdit({ captions, items: [{ ...source, transcript: [] }], fps, rows, rowIndex: 0,
    action: 'split', text: rows[0]!.text, caret: 5 });
  assert.equal(unsafe.patch, null, 'missing source-word mapping must not write a guessed edit');
  assert(unsafe.reason);
}

// Splitting inside a single source word creates two distinct editable list rows.
{
  const source: TimelineItem = { id: 'one-word', track: 'A1', kind: 'audio', name: 'one', startFrame: 0, durationInFrames: 90,
    ...newTranscriptGeneration([{ text: '字幕测试', start: 0, end: 1000 }]) };
  const captions = sourceCaptions(source);
  const rows = buildCues(captions, [source], fps);
  const split = planned(captions, [source], 'split', 0, rows[0]!.text, 2);
  const parts = buildCues(split, [source], fps);
  assert.equal(parts.length, 2);
  assert.notEqual(captionListId(parts[0]!), captionListId(parts[1]!));
}

// Gaps, overlaps and different fonts merge directly without a modal confirm prompt; another intersecting cue still blocks merging.
{
  const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', cueFonts: { 'cue:b': { fontFamily: 'Other' } },
    sourceEntries: [{ id: 'manual', itemId: 'manual:manual', words: [
      { id: 'a', text: '甲', start: 0, end: 1000 }, { id: 'b', text: '乙', start: 1200, end: 2000 },
    ] }] };
  const rows = buildCues(captions, [], fps);
  const request = { captions, items: [], fps, rows, rowIndex: 0, action: 'mergeNext' as const, text: '甲' };
  const directGapMerge = planCaptionCueEdit(request);
  assert.equal(directGapMerge.confirm, undefined);
  assert(directGapMerge.patch, 'gap merge applies directly without confirmation prompt');
  const overlap = { ...rows[1]!, start: 900 };
  const overlapMerge = planCaptionCueEdit({ ...request, rows: [rows[0]!, overlap] });
  assert.equal(overlapMerge.confirm, undefined);
  assert(overlapMerge.patch, 'overlap merge applies directly without confirmation prompt');
  const differentFont = { ...rows[1]!, start: rows[0]!.end, fontOverride: { fontFamily: 'Other' } };
  const fontMerge = planCaptionCueEdit({ ...request, rows: [rows[0]!, differentFont] });
  assert.equal(fontMerge.confirm, undefined);
  assert(fontMerge.patch, 'different-font merge applies directly without confirmation prompt');
  const other = { ...rows[0]!, id: 'other', laneId: 'another', start: 1050, end: 1100 };
  const blocked = planCaptionCueEdit({ ...request, rows: [rows[0]!, rows[1]!, other] });
  assert.equal(blocked.patch, null); assert.match(blocked.reason ?? '', /其他字幕/);
}
// Split and merge are each one project history operation and survive project serialization.
{
  const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceEntries: [{ id: 'manual', itemId: 'manual:manual', words: [
    { id: 'a', text: '前后两段', start: 0, end: 2000 },
  ] }] };
  const doc: ProjectDoc = { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [{
    id: 'main', name: 'main', order: 0, fps, width: 1920, height: 1080, selectedId: null, items: [makeSource()],
    trackOrder: ['C1', 'V1'], tracks: { C1: { kind: 'caption', captions }, V1: { kind: 'video' } },
  }] };
  let history: History = { past: [], present: doc, future: [] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const firstRows = buildCues(captions, [], fps);
  const split = planCaptionCueEdit({ captions, items: [], fps, rows: firstRows, rowIndex: 0, action: 'split', text: firstRows[0]!.text, caret: 2 });
  assert(split.patch); commands.updateCaptions(split.patch, 'C1');
  const splitDoc = structuredClone(history.present);
  commands.undo(); assert.deepEqual(history.present, doc);
  commands.redo(); assert.deepEqual(history.present, splitDoc);
  const current = history.present.timelines[0]!.tracks!.C1!.captions!;
  const rows = buildCues(current, [], fps);
  const merge = planCaptionCueEdit({ captions: current, items: [], fps, rows, rowIndex: 0, action: 'mergeNext', text: rows[0]!.text });
  assert(merge.patch); commands.updateCaptions(merge.patch, 'C1');
  const mergedDoc = structuredClone(history.present);
  commands.undo(); assert.deepEqual(history.present, splitDoc);
  commands.redo(); assert.deepEqual(history.present, mergedDoc);
  const loaded = migrateProjectDoc(JSON.parse(JSON.stringify(mergedDoc)) as unknown);
  assert(loaded);
  const loadedCaptions = Object.values(loaded.timelines[0]!.tracks ?? {}).find((track) => track?.kind === 'caption')?.captions;
  assert(loadedCaptions); assert.equal(buildCues(loadedCaptions, [], fps)[0]!.text, '前后两段');
}
// A source-word boundary with overlapping ASR timestamps must never create overlapping cues.
{
  const source: TimelineItem = { id: 'overlap', track: 'V1', kind: 'video', name: 'overlap', startFrame: 0, durationInFrames: 90,
    ...newTranscriptGeneration([{ text: '一', start: 0, end: 1000 }, { text: '二', start: 900, end: 2000 }]) };
  const captions = sourceCaptions(source);
  const rows = buildCues(captions, [source], fps);
  const split = planCaptionCueEdit({ captions, items: [source], fps, rows, rowIndex: 0, action: 'split', text: rows[0]!.text, caret: 1 });
  assert.equal(split.patch, null); assert.match(split.reason ?? '', /重叠/);
  const extendedSource = { ...source, ...newTranscriptGeneration([
    { text: '一', start: 0, end: 1000 }, { text: '二', start: 900, end: 2000 },
    { text: '三', start: 2200, end: 2600 },
  ]) };
  const extendedCaptions = sourceCaptions(extendedSource);
  const extendedRows = buildCues(extendedCaptions, [extendedSource], fps);
  const safeSplit = planCaptionCueEdit({ captions: extendedCaptions, items: [extendedSource], fps, rows: extendedRows, rowIndex: 0, action: 'split', text: '一二三', caret: 2 });
  assert(safeSplit.patch, 'Chinese word boundaries must not be mistaken for an English separator');
  assert.deepEqual(buildCues({ ...extendedCaptions, ...safeSplit.patch }, [extendedSource], fps).map((row) => row.text), ['一二', '三']);
  const saved = planCaptionCueEdit({ captions, items: [source], fps, rows, rowIndex: 0, action: 'save', text: '  保留空白  ' });
  assert(saved.patch); assert.equal(buildCues({ ...captions, ...saved.patch }, [source], fps)[0]!.text, '  保留空白  ');
}
// Editing times can reorder rows; the next caret target is a cue identity, not an old list index.
{
  const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceEntries: [{ id: 'manual', itemId: 'manual:manual', words: [
    { id: 'first', text: '前段后段', start: 0, end: 4000 }, { id: 'second', text: '另一句', start: 6000, end: 8000 },
  ] }] };
  const rows = buildCues(captions, [], fps);
  const split = planCaptionCueEdit({ captions, items: [], fps, rows, rowIndex: 0, action: 'split', text: '前段后段', caret: 2, manualTiming: { startMs: 10000, endMs: 14000 } });
  assert(split.patch); assert(split.focus?.manualCueId);
  const target = buildCues({ ...captions, ...split.patch }, [], fps).find((row) => row.entry?.words?.[row.manualIndex ?? -1]?.id === split.focus!.manualCueId);
  assert.equal(target?.text, '后段'); assert.equal(split.focus.caret, 0);
}
console.log('caption cue editing behaviors passed');
