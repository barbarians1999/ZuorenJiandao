import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { acknowledgeSavedCaptionDrafts, captionDataSignature, planPendingCaptionRecovery, readCaptionDraftRecovery, writeCaptionDraftRecovery, type PendingCaptionDraftRecovery } from './captionDraftRecovery';
import type { CaptionsData } from './types';
import type { ProjectDoc, Timeline } from '../editor/types';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { if (this.failWrites) throw new Error('storage full'); this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const storage = new MemoryStorage();
const draftA = { id: 'cue-a', baseText: '旧甲', baseStart: 0, baseEnd: 1000, text: '新甲', start: '0', end: '1' };
const draftB = { id: 'cue-b', baseText: '旧乙', baseStart: 1000, baseEnd: 2000, text: '新乙', start: '1', end: '2' };
const baseline: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', words: [
  { id: 'a', text: '旧甲', start: 0, end: 1000 }, { id: 'b', text: '旧乙', start: 1000, end: 2000 },
] };
const stateA: CaptionsData = { ...baseline, words: [
  { id: 'a', text: '新甲', start: 0, end: 1000 }, { id: 'b', text: '旧乙', start: 1000, end: 2000 },
] };
const stateB: CaptionsData = { ...stateA, words: [
  { id: 'a', text: '新甲', start: 0, end: 1000 }, { id: 'b', text: '新乙', start: 1000, end: 2000 },
] };
const branchB: CaptionsData = { ...baseline, words: [
  { id: 'a', text: '旧甲', start: 0, end: 1000 }, { id: 'b', text: '新乙', start: 1000, end: 2000 },
] };
const unrelated: CaptionsData = { ...baseline, words: [{ id: 'x', text: '外部改动', start: 0, end: 500 }] };
const entryA: PendingCaptionDraftRecovery = { timelineId: 'main', trackId: 'C1',
  baseSignature: captionDataSignature(baseline), targetSignature: captionDataSignature(stateA), draft: draftA,
  patch: { words: stateA.words } };
const entryB: PendingCaptionDraftRecovery = { timelineId: 'main', trackId: 'C1',
  baseSignature: captionDataSignature(stateA), targetSignature: captionDataSignature(stateB), draft: draftB,
  patch: { words: stateB.words } };
assert.deepEqual(planPendingCaptionRecovery(baseline, [entryA, entryB]), { words: stateB.words }, 'chained edits can be explicitly restored from their original base');
assert.deepEqual(planPendingCaptionRecovery(stateA, [entryA, entryB]), { words: stateB.words }, 'a partially saved chain resumes at its matching state');
assert.equal(planPendingCaptionRecovery(unrelated, [entryA, entryB]), null, 'conflicts do not produce an overwrite patch');
assert.equal(captionDataSignature({ b: 2, a: 1 }), captionDataSignature({ a: 1, b: 2 }), 'signatures ignore object key order');
const clearFieldsPatch: Partial<CaptionsData> = { words: undefined, sources: undefined };
const clearFieldsBase: CaptionsData = { ...baseline, words: undefined, sources: ['legacy'] };
const clearFieldsTarget = { ...clearFieldsBase, ...clearFieldsPatch };
const clearFieldsEntry: PendingCaptionDraftRecovery = { ...entryA, baseSignature: captionDataSignature(clearFieldsBase),
  targetSignature: captionDataSignature(clearFieldsTarget), patch: clearFieldsPatch };
const clearFieldsKey = 'cc-caption-inline:project-1:main:C4';
writeCaptionDraftRecovery(clearFieldsKey, { draft: null, pending: [clearFieldsEntry] }, storage);
const restoredPatch = readCaptionDraftRecovery(clearFieldsKey, storage).pending[0]!.patch;
assert.equal(Object.hasOwn(restoredPatch, 'words'), true);
assert.equal(restoredPatch.words, undefined, 'undefined patches survive localStorage serialization');
assert.deepEqual(planPendingCaptionRecovery(clearFieldsBase, [readCaptionDraftRecovery(clearFieldsKey, storage).pending[0]!]), clearFieldsPatch);
const failedWriteKey = 'cc-caption-inline:project-1:main:C5';
storage.failWrites = true;
assert.equal(writeCaptionDraftRecovery(failedWriteKey, { draft: null, pending: [entryA] }, storage), false, 'storage errors are reported to the caller');
storage.failWrites = false;
assert.deepEqual(readCaptionDraftRecovery(failedWriteKey, storage), { draft: null, pending: [] }, 'failed writes do not claim a recovery record exists');

const key = 'cc-caption-inline:project-1:main:C1';
const otherTrackKey = 'cc-caption-inline:project-1:main:C2';
const otherProjectKey = 'cc-caption-inline:project-2:main:C1';
const legacyKey = 'cc-caption-inline:project-1:main:C3';
const activeDraft = { id: 'cue-c', baseText: '原文', baseStart: 0, baseEnd: 500, text: '未提交', start: '0', end: '0.5' };
writeCaptionDraftRecovery(key, { draft: activeDraft, pending: [entryA, entryB] }, storage);
writeCaptionDraftRecovery(otherTrackKey, { draft: null, pending: [{ ...entryA, trackId: 'C2' }] }, storage);
writeCaptionDraftRecovery(otherProjectKey, { draft: null, pending: [entryA] }, storage);
storage.setItem(legacyKey, JSON.stringify(activeDraft));

const timeline = (captions: CaptionsData, other: CaptionsData = unrelated): Timeline => ({
  id: 'main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080, items: [], selectedId: null,
  trackOrder: ['C1', 'C2'], tracks: { C1: { kind: 'caption', captions }, C2: { kind: 'caption', captions: other } },
});
const project = (captions: CaptionsData): ProjectDoc => ({ version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main',
  assets: [], mediaFolders: [], timelines: [timeline(captions)] });

assert.deepEqual(acknowledgeSavedCaptionDrafts('project-1', project(stateA), storage), [key]);
assert.deepEqual(readCaptionDraftRecovery(key, storage), { draft: activeDraft, pending: [entryB] }, 'saving A clears only A, preserves active draft and later B');
assert.deepEqual(acknowledgeSavedCaptionDrafts('project-1', project(stateB), storage), [key]);
assert.deepEqual(readCaptionDraftRecovery(key, storage), { draft: activeDraft, pending: [] }, 'saving B clears the confirmed chain but keeps active typing');
assert.deepEqual(readCaptionDraftRecovery(otherTrackKey, storage).pending, [{ ...entryA, trackId: 'C2' }], 'another caption track is not cleared');
assert.deepEqual(readCaptionDraftRecovery(otherProjectKey, storage).pending, [entryA], 'another project is not cleared');
assert.deepEqual(readCaptionDraftRecovery(legacyKey, storage).draft, activeDraft, 'legacy drafts remain readable');
const branchKey = 'cc-caption-inline:project-1:main:C6';
const branchEntry: PendingCaptionDraftRecovery = { ...entryB, baseSignature: captionDataSignature(baseline),
  targetSignature: captionDataSignature(branchB), patch: { words: branchB.words } };
writeCaptionDraftRecovery(branchKey, { draft: null, pending: [entryA, branchEntry] }, storage);
assert.deepEqual(acknowledgeSavedCaptionDrafts('project-1', project(branchB), storage), [branchKey]);
assert.deepEqual(readCaptionDraftRecovery(branchKey, storage).pending, [entryA], 'saving a branch keeps an unrelated failed edit visible');
console.log('captionDraftRecovery.verify: chained restore, snapshot-scoped cleanup, active draft preservation, project/track isolation and legacy compatibility passed');
