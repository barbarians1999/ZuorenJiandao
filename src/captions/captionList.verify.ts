import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce, type History } from '../editor/reduce';
import { buildCommands } from '../editor/storeCommandBuilder';
import type { ProjectDoc, TimelineItem } from '../editor/types';
import { newTranscriptGeneration } from '../transcript/identity';
import { buildCues } from './captionCues';
import { appendCaptionCueAfter, captionListId, captionListPatch, captionListRange, captionListSelection, captionReplaceEdits, selectedCaptionListIds } from './captionList';
import type { CaptionsData } from './types';

const source: TimelineItem = { id: 'source', track: 'A1', kind: 'audio', name: 'source', startFrame: 30, durationInFrames: 300,
  ...newTranscriptGeneration([
    { text: '第一句', start: 0, end: 600 }, { text: '第二句', start: 2000, end: 2600 }, { text: '第三句', start: 4000, end: 4600 },
  ]) };
const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'word', sourceMode: 'item',
  sourceEntries: [{ id: 'linked', itemId: source.id }, { id: 'manual', itemId: 'manual:manual', words: [
    { id: 'manual1', text: '手动第一句', start: 8000, end: 9000 }, { id: 'manual2', text: '手动第二句', start: 9500, end: 10000 },
  ] }],
};
const items = [source];
const rows = buildCues(captions, items, 30);
assert.equal(rows.filter((row) => !row.manual).length, 3);
assert.equal(rows.filter((row) => row.manual).length, 2);
assert.equal(new Set(rows.map(captionListId)).size, rows.length, 'each visible cue has a unique stable list identity');
const ids = rows.map(captionListId);
const refs = rows.map((row) => captionListSelection('C1', row)!);
assert.deepEqual(selectedCaptionListIds('C1', rows, [refs[1], refs[4]]), [ids[1], ids[4]], 'timeline selections map back to list rows');
assert.deepEqual(captionListRange(rows, ids[1], ids[3]), ids.slice(1, 4));
assert.deepEqual(captionListRange(rows, ids[3], ids[1]), ids.slice(1, 4));
assert.deepEqual(captionListRange(rows, 'removed-anchor', ids[3]), [ids[3]]);

{
  const patch = captionListPatch(captions, items, 30, [{ id: ids[1], text: '源字幕改正' }])!;
  assert(patch.wordOverrides);
  assert.equal(patch.sourceEntries, undefined, 'linked-source edits remain word overrides, not fixed cues');
  const next = { ...captions, ...patch };
  const changed = buildCues(next, items, 30).find((row) => captionListId(row) === ids[1])!;
  assert.equal(changed.text, '源字幕改正');
  assert.equal(changed.start, rows[1].start);
  const moved = buildCues(next, [{ ...source, startFrame: source.startFrame + 90 }], 30).find((row) => captionListId(row) === ids[1])!;
  assert.equal(moved.text, changed.text);
  assert.equal(moved.start - changed.start, 3000, 'corrected source subtitle continues to follow the source clip');
  assert.deepEqual(items, [source], 'list correction never mutates the source transcript');
}
{
  const patch = captionListPatch(captions, items, 30, [{ id: ids[3], text: '手动改正', start: 8100, end: 9400 }])!;
  const edited = buildCues({ ...captions, ...patch }, items, 30).find((row) => captionListId(row) === ids[3])!;
  assert.equal(edited.text, '手动改正'); assert.equal(edited.start, 8100); assert.equal(edited.end, 9400);
  assert.equal(captionListSelection('C1', edited)?.kind, 'manual');
}
{
  const patch = captionListPatch(captions, items, 30, [ids[0], ids[3], ids[4]].map((id) => ({ id, text: null })))!;
  const remaining = buildCues({ ...captions, ...patch }, items, 30);
  assert.deepEqual(remaining.map(captionListId), [ids[1], ids[2]], 'batch removal resolves manual indices by ID after each removal');
  assert.equal(patch.sourceEntries?.find((entry) => entry.id === 'linked')?.itemId, source.id);
  assert(Object.values(patch.wordOverrides ?? {}).some((entry) => entry.hidden && entry.wordRef), 'automatic removal keeps stable source-word refs');
  const initial: ProjectDoc = { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [{
    id: 'main', name: 'main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: null, items,
    tracks: { C1: { kind: 'caption', captions }, A1: { kind: 'audio' } }, trackOrder: ['C1', 'A1'],
  }] };
  let history: History = { past: [], present: initial, future: [] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  commands.updateCaptions(patch, 'C1');
  assert.equal(history.past.length, 1, 'entire batch is one caption update and one undo record');
  commands.undo(); assert.deepEqual(history.present, initial);
  commands.redo(); assert.equal(buildCues(history.present.timelines[0].tracks!.C1!.captions!, items, 30).length, 2);
}
{
  const edits = captionReplaceEdits(rows, '句', '段');
  assert.equal(edits.length, 5);
  const patch = captionListPatch(captions, items, 30, edits)!;
  const next = buildCues({ ...captions, ...patch }, items, 30);
  assert(next.every((row) => !row.text.includes('句')));
  assert.deepEqual(next.map(captionListId), ids, 'replace preserves stable identities across both source and manual subtitles');
  assert.deepEqual(captionReplaceEdits(rows, '', 'x'), []);
  assert.deepEqual(captionReplaceEdits([{ ...rows[0], text: 'A.b a.B' }], 'a.b', '$1').map((entry) => entry.text), ['$1 $1'],
    'replacement is literal and matches the same case-insensitive text search');
  assert.equal(captionListPatch(captions, items, 30, [{ id: 'unknown', text: 'x' }]), null);
}
{
  const originalSource = JSON.stringify(source);
  const spans = rows.filter(row => !row.manual).slice(0, 2).map(row => row.sourceSpans[0]!);
  assert(spans.every(Boolean));
  const explicit: CaptionsData = { ...captions, sourceEntries: captions.sourceEntries!.map(entry => entry.id !== 'linked' ? entry : {
    ...entry, displayCueEdits: [{ id: 'display-edit', coveredWordRefs: spans.map(span=>span.wordRef), parts: [
      { id: 'display-a', text: '显示第一句', sourceSpans: [spans[0]!] },
      { id: 'display-b', text: '显示第二句', sourceSpans: [spans[1]!] },
    ] }],
  }) };
  const explicitRows = buildCues(explicit, items, 30).filter(row=>row.displayCuePartId);
  assert.equal(explicitRows.length, 2);
  const correction = captionListPatch(explicit, items, 30, [{ id: captionListId(explicitRows[0]!), text: '已改正' }]);
  assert(correction, 'Correcting an explicit source display cue must produce a patch');
  const corrected = { ...explicit, ...correction };
  assert.equal(buildCues(corrected, items, 30).find(row=>row.displayCuePartId==='display-a')?.text, '已改正');
  const removal = captionListPatch(corrected, items, 30, explicitRows.map(row=>({id:captionListId(row),text:null})))!;
  assert(removal, 'Batch removal of explicit parts must produce one patch');
  const deleted = JSON.parse(JSON.stringify({ ...corrected, ...removal }));
  assert.equal(buildCues(deleted, items, 30).filter(row=>!row.manual).length, 1,
    'Removing both display parts retains source suppression, so the two original words do not reappear');
  assert.equal(deleted.sourceEntries.find((entry: {id:string})=>entry.id==='linked').itemId, source.id);
  assert.equal(JSON.stringify(source), originalSource, 'Display correction/deletion never edits the transcript');
  const initial: ProjectDoc = { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [{
    id:'main',name:'main',order:0,fps:30,width:1920,height:1080,selectedId:null,items,
    tracks:{C1:{kind:'caption',captions:corrected},A1:{kind:'audio'}},trackOrder:['C1','A1'],
  }] };
  let history:History={past:[],present:initial,future:[]};
  const commands=buildCommands(action=>{history=historyReduce(history,action);},()=>history.present);
  commands.updateCaptions(removal,'C1');assert.equal(history.past.length,1);
  commands.undo();assert.deepEqual(history.present,initial);
  commands.redo();assert.equal(buildCues(history.present.timelines[0]!.tracks!.C1!.captions!,items,30).filter(row=>!row.manual).length,1);
}
{
  const originalSource = JSON.stringify(source);
  const gapAdd = appendCaptionCueAfter(captions, items, 30, ids[3]!, '插入新句');
  assert(gapAdd, 'adding a cue after a manual row with a 500ms gap must succeed');
  const afterGapRows = buildCues({ ...captions, ...gapAdd.patch }, items, 30);
  const insertedGap = afterGapRows.find((row) => row.entry?.words?.[row.manualIndex ?? -1]?.id === gapAdd.cueId);
  assert(insertedGap && insertedGap.start === 9000 && insertedGap.end === 9500, 'fits new cue cleanly inside available gap');

  const tailAdd = appendCaptionCueAfter(captions, items, 30, ids[4]!, '结尾新句');
  assert(tailAdd, 'adding after the last manual row succeeds');
  const afterTailRows = buildCues({ ...captions, ...tailAdd.patch }, items, 30);
  const insertedTail = afterTailRows.find((row) => row.entry?.words?.[row.manualIndex ?? -1]?.id === tailAdd.cueId);
  assert(insertedTail && insertedTail.start === 10000 && insertedTail.end === 12000, 'uses default 2s duration when trailing space is open');

  const tightCaptions: CaptionsData = {
    enabled: true, template: 'plain', pacing: 'word', sourceMode: 'item',
    sourceEntries: [{ id: 'manual', itemId: 'manual:manual', words: [
      { id: 't1', text: '紧贴第一句', start: 0, end: 1000 },
      { id: 't2', text: '紧贴第二句', start: 1000, end: 2000 },
    ] }],
  };
  const tightRows = buildCues(tightCaptions, items, 30);
  const tightAdd = appendCaptionCueAfter(tightCaptions, items, 30, captionListId(tightRows[0]!), '另轨新句');
  assert(tightAdd && (tightAdd.patch.sourceEntries?.length ?? 0) === 2, 'tight manual gap falls back to a fresh manual lane');

  const sourceAdd = appendCaptionCueAfter(captions, items, 30, ids[0]!, '随口插入');
  assert(sourceAdd, 'adding after a transcript-linked row creates a manual cue');
  assert.equal(JSON.stringify(source), originalSource, 'adding a caption cue never mutates source transcript');
}
console.log('captionList.verify: stable list/timeline identity, ranges, corrections, source following, manual timing, mixed batch removal/replacement, add-after and one-step undo');
