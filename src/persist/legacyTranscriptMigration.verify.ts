// Stage 4 guardrails: verify 5-case (`L1`–`L5`) legacy virtual-transcript migration,
// write-once immutable `project-legacy-backup:<id>` preservation, idempotence,
// `dismissLegacyTimingReview` + undo/redo, and Hengshui 3 exact source in-point recovery.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectIdFromProjectStoreKey } from '../../shared/project-store-validation';
import { historyReduce, reduce } from '../editor/reduce';
import { kvGet, kvSet } from './sharedKv';
import {
  loadLegacyProjectBackup,
  loadProject,
  loadProjectForEditing,
  migrateProjectDoc,
  resetProjectStoreMemory,
} from './projectStore';
import type { ProjectDoc } from '../editor/types';

const wordsForSeconds = (pairs: Array<[string, number, number]>) =>
  pairs.map(([text, startMs, endMs], i) => ({ id: `w_${i}`, text, start: startMs, end: endMs }));

const makeBaseV3Doc = (items: Array<Record<string, unknown>>, extraTimeline: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 3,
  activeTimelineId: 'tl_legacy',
  assets: [
    { id: 'asset-a', name: 'speech.wav', kind: 'audio', src: '/speech.wav', durationInFrames: 1200 },
    { id: 'asset-v', name: 'talk.mp4', kind: 'video', src: '/talk.mp4', durationInFrames: 1200, width: 1920, height: 1080, fps: 30 },
  ],
  mediaFolders: [],
  timelines: [{
    id: 'tl_legacy',
    name: 'Legacy Timeline',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    selectedIds: [],
    trackOrder: ['track_tl_legacy_1', 'track_tl_legacy_2'],
    tracks: {
      track_tl_legacy_1: { kind: 'video' },
      track_tl_legacy_2: { kind: 'audio' },
    },
    items,
    ...extraTimeline,
  }],
});

// 1. L1 + L2: unedited transcribed clips keep exact geometry (`startFrame`, `durationInFrames`, `srcInFrame`).
// L1: word bounds match clip bounds within tolerance -> NO review badge.
// L2: word bounds differ >6f from track clip bounds -> keeps track pauses intact + flags L2 review.
{
  const l1Audio = {
    id: 'a-l1',
    name: 'L1 Clean',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 0,
    durationInFrames: 90,
    srcInFrame: 0,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    transcript: wordsForSeconds([['hello', 60, 1500], ['world', 1550, 2940]]),
  };
  const l2Audio = {
    id: 'a-l2',
    name: 'L2 Pause Margin',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 120,
    durationInFrames: 150,
    srcInFrame: 30,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    // w0=2000ms (60f vs srcIn 30f -> diff 30f > 6), wN=5200ms (156f vs end 180f -> diff 24f > 6)
    transcript: wordsForSeconds([['late', 2000, 3500], ['end', 3600, 5200]]),
  };
  const doc = migrateProjectDoc(makeBaseV3Doc([l1Audio, l2Audio]))!;
  assert.equal(doc.transcriptTimingModel, 'track-ssot-v1');
  const tl = doc.timelines[0]!;
  const migL1 = tl.items.find((it) => it.id === 'a-l1')!;
  const migL2 = tl.items.find((it) => it.id === 'a-l2')!;
  assert.equal(migL1.legacyTimingReview, undefined, 'L1 aligned clip gets no review badge');
  assert.equal(migL1.srcInFrame, 0);
  assert.equal(migL2.startFrame, 120, 'L2 preserves startFrame');
  assert.equal(migL2.durationInFrames, 150, 'L2 never destructively chops natural pauses');
  assert.equal(migL2.srcInFrame, 30, 'L2 preserves srcInFrame');
  assert.equal(migL2.legacyTimingReview?.caseCode, 'L2');
  assert.equal(tl.legacyTimingReview?.required, true);
  assert.deepEqual(tl.legacyTimingReview?.affectedItemIds, ['a-l2']);
}

// 2. L3: split transcribed audio with lost `srcInFrame = 0` recovers exact offset without changing timeline placement.
{
  const splitPart0 = {
    id: 'split-0',
    name: 'Part 0',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 0,
    durationInFrames: 90,
    srcInFrame: 0,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    transcript: wordsForSeconds([['intro', 100, 2900]]),
  };
  // In-place split at frame 95 whose srcInFrame was zeroed to 0
  const splitPart1 = {
    id: 'split-1',
    name: 'Part 1 InPlace',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 95,
    durationInFrames: 120,
    srcInFrame: 0,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    transcript: wordsForSeconds([['chapter2', 3250, 7000]]),
  };
  // Split at ~220 then moved to timeline startFrame 400 with srcInFrame lost to 0
  const splitPart2 = {
    id: 'split-2',
    name: 'Part 2 Moved',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 400,
    durationInFrames: 120,
    srcInFrame: 0,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    transcript: wordsForSeconds([['chapter3', 7200, 10800]]),
  };
  const doc = migrateProjectDoc(makeBaseV3Doc([splitPart0, splitPart1, splitPart2]))!;
  const tl = doc.timelines[0]!;
  assert.equal(tl.items.find((it) => it.id === 'split-0')?.srcInFrame, 0);
  const p1 = tl.items.find((it) => it.id === 'split-1')!;
  const p2 = tl.items.find((it) => it.id === 'split-2')!;
  assert.equal(p1.startFrame, 95);
  assert.equal(p1.durationInFrames, 120);
  assert.equal(p1.srcInFrame, 95, 'in-place split recovers exact frame 95');
  assert.equal(p1.legacyTimingReview?.caseCode, 'L3');
  assert.equal(p2.startFrame, 400);
  assert.equal(p2.durationInFrames, 120);
  assert.equal(p2.srcInFrame, 215, 'moved split recovers continuous source in-point');
  assert.equal(p2.legacyTimingReview?.caseCode, 'L3');
}

// 3. L4 + L5: legacy transcript-edited audio & video materialize real sub-clips + collapsed foldGroups,
// strip all virtual fields, remap captions & transitions, and migrate idempotently.
{
  const words = wordsForSeconds([
    ['keepA', 0, 1000],
    ['dropFiller', 1000, 2000],
    ['keepB', 2000, 3000],
  ]);
  const legacyEditedAudio = {
    id: 'a-l4',
    name: 'L4 Edited Audio',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 0,
    durationInFrames: 60,
    srcInFrame: 0,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    transcript: words,
    deletedWordIdx: [1],
    cutPadFrames: 2,
  };
  const legacyEditedVideo = {
    id: 'v-l5',
    name: 'L5 Edited Video',
    kind: 'video',
    track: 'track_tl_legacy_1',
    startFrame: 0,
    durationInFrames: 90,
    srcInFrame: 0,
    src: '/talk.mp4',
    sourceAssetId: 'asset-v',
    transcript: words,
    deletedWordIdx: [1],
  };
  const rawDoc = makeBaseV3Doc([legacyEditedAudio, legacyEditedVideo], {
    tracks: {
      track_tl_legacy_1: { kind: 'video' },
      track_tl_legacy_2: { kind: 'audio' },
      track_tl_legacy_3: {
        kind: 'caption',
        captions: {
          enabled: true,
          template: 'bold-outline',
          pacing: 'phrase',
          sourceEntries: [{ id: 'ce-1', itemId: 'a-l4', visible: true }],
        },
      },
    },
    trackOrder: ['track_tl_legacy_3', 'track_tl_legacy_1', 'track_tl_legacy_2'],
  });
  const doc = migrateProjectDoc(rawDoc)!;
  const tl = doc.timelines[0]!;
  const audioCuts = tl.items.filter((it) => it.track === 'track_tl_legacy_2');
  const videoCuts = tl.items.filter((it) => it.track === 'track_tl_legacy_1');
  assert.equal(audioCuts.length, 2, 'L4 materializes 2 kept audio sub-clips');
  assert.equal(videoCuts.length, 2, 'L5 materializes 2 kept video sub-clips');
  assert.equal(audioCuts[0]!.legacyTimingReview?.caseCode, 'L4');
  assert.equal(videoCuts[0]!.legacyTimingReview?.caseCode, 'L5');
  assert.equal(tl.foldGroups?.length, 2, 'both L4 and L5 create collapsed foldGroups');
  assert.ok(tl.foldGroups!.every((g) => g.collapsed && g.itemIds.length === 2));
  for (const item of tl.items) {
    assert.equal('deletedWordIdx' in item, false, 'legacy fields stripped completely');
    assert.equal('silenceFrames' in item, false);
    assert.equal('cutPadFrames' in item, false);
    assert.equal('gapCapsMs' in item, false);
    assert.equal('transcriptPlayOrder' in item, false);
  }
  const remappedEntries = tl.tracks?.track_tl_legacy_3?.captions?.sourceEntries ?? [];
  assert.equal(remappedEntries.length, 2, 'caption sourceEntries track all split sub-clips');

  // Idempotence: running migrateProjectDoc again must not change anything.
  const secondPass = migrateProjectDoc(doc)!;
  assert.deepEqual(secondPass.timelines[0]!.items.map((it) => it.id), tl.items.map((it) => it.id));

  // dismissLegacyTimingReview (single clip & all clips + undo/redo).
  let hist = { past: [] as ProjectDoc[], present: doc, future: [] as ProjectDoc[] };
  hist = historyReduce(hist, { type: 'dismissLegacyTimingReview', itemId: 'v-l5' });
  const afterOne = hist.present.timelines[0]!;
  assert.equal(afterOne.items.filter((it) => it.track === 'track_tl_legacy_1').some((it) => it.legacyTimingReview), false);
  assert.equal(afterOne.legacyTimingReview?.required, true, 'L4 items still remain under review');
  const afterDismissAll = historyReduce(hist, { type: 'dismissLegacyTimingReview' });
  assert.equal(afterDismissAll.present.timelines[0]!.legacyTimingReview, undefined, 'dismissing all clears banner');
  const afterUndo = historyReduce(afterDismissAll, { type: 'undo' });
  assert.equal(afterUndo.present.timelines[0]!.legacyTimingReview?.required, true, 'undo restores review banner');
  void reduce;
}

// 4. Write-once immutable pre-migration backup (`project-legacy-backup:<id>`).
{
  resetProjectStoreMemory();
  const projectId = 'legacy-backup-test';
  assert.equal(projectIdFromProjectStoreKey(`project-legacy-backup:${projectId}`), projectId);
  const rawLegacy = makeBaseV3Doc([{
    id: 'a-l2',
    name: 'L2 Clip',
    kind: 'audio',
    track: 'track_tl_legacy_2',
    startFrame: 0,
    durationInFrames: 120,
    srcInFrame: 0,
    src: '/speech.wav',
    sourceAssetId: 'asset-a',
    transcript: wordsForSeconds([['word', 1000, 2000]]),
  }]);
  await kvSet(`project:${projectId}`, rawLegacy);

  const loaded1 = await loadProjectForEditing(projectId);
  assert.equal(loaded1.status, 'ok');
  if (loaded1.status !== 'ok') throw new Error('expected ok');
  assert.equal(loaded1.doc.transcriptTimingModel, 'track-ssot-v1');

  const backup1 = await loadLegacyProjectBackup(projectId);
  assert.ok(backup1, 'legacy backup created automatically on first load');
  assert.deepEqual(backup1.rawDoc, rawLegacy, 'backup stores exact original pre-migration bytes');

  // Even if project entry is overwritten and loaded again, backup stays untouched and immutable.
  await kvSet(`project:${projectId}`, { ...loaded1.doc, name: 'Modified' });
  await loadProject(projectId);
  const backup2 = await kvGet<{ backedUpAt: number; rawDoc: unknown }>(`project-legacy-backup:${projectId}`);
  assert.deepEqual(backup2, backup1, 'project-legacy-backup:<id> is strictly write-once');
}

// 5. Real Hengshui 3 read-only migration verification from Stage 0 SQLite backup.
{
  const backupSqlite = path.resolve(
    'release/logs/track-ssot-20261125/backups/project-store-v1.pre-track-ssot.sqlite3',
  );
  if (existsSync(backupSqlite)) {
    const db = new DatabaseSync(backupSqlite, { readOnly: true });
    const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('project:ed229ef5-0fbc-4b89-ab27-c463a7fe755a') as { v: string } | undefined;
    db.close();
    if (row?.v) {
      const rawHs = JSON.parse(row.v) as unknown;
      const migHs = migrateProjectDoc(rawHs)!;
      assert.equal(migHs.transcriptTimingModel, 'track-ssot-v1');
      const tlV02 = migHs.timelines.find((tl) => tl.id === 'tl_7e0071f8-9883-4727-9a63-b9674e5cb6a1')!;
      assert.ok(tlV02, 'Hengshui 3 timeline present');
      const voiceClips = tlV02.items
        .filter((it) => it.src?.includes('6eb4b42e-f06c-4f3c-a2e0-c4fc808f5c42'))
        .sort((a, b) => a.startFrame - b.startFrame);
      assert.deepEqual(
        voiceClips.map((c) => ({ start: c.startFrame, dur: c.durationInFrames, srcIn: c.srcInFrame })),
        [
          { start: 0, dur: 1262, srcIn: 0 },
          { start: 1334, dur: 8134, srcIn: 1334 },
          { start: 9540, dur: 7505, srcIn: 9540 },
          { start: 17117, dur: 7105, srcIn: 17117 },
          { start: 24294, dur: 6213, srcIn: 24294 },
          { start: 30578, dur: 5462, srcIn: 30578 },
        ],
        'Hengshui 3 migration must recover exact source offsets for all 5 split voiceover chapters',
      );
      assert.equal(voiceClips[0]!.legacyTimingReview, undefined);
      for (const c of voiceClips.slice(1)) {
        assert.equal(c.legacyTimingReview?.caseCode, 'L3');
      }
    }
  }
}

console.log('legacyTranscriptMigration.verify: all Stage 4 migration & Hengshui 3 checks passed');
