import assert from 'node:assert/strict';
import { buildCues } from '../../captions/captionCues';
import { makeDraft } from '../../editor/store';
import { captionTrackEntries, type TimelineState } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { isExternalServerDirectCall } from '../external-tool-policy';
import { executeOfflineTool } from '../../../server/external-agent/offline-executor';
import { CAPTIONS_TOOL_SCHEMAS } from './schemas/captions-tools';
import { execCaptionsTool } from './captions-tools';

function createTestCtx(state: TimelineState): {
  draft: ReturnType<typeof makeDraft>;
  ctx: AgentContext;
} {
  const draft = makeDraft(docFromTimeline(state));
  const ctx: AgentContext = {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  };
  return { draft, ctx };
}

// ── 1) Manual cue CRUD on a timeline with NO ASR transcript ──────────────
{
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [{ id: 'v1', track: 'V1', startFrame: 0, durationInFrames: 300, name: 'clip', kind: 'video', src: '/v1.mp4' }],
  };
  const { draft, ctx } = createTestCtx(state);

  // Batch cue_add auto-enables C1 manual captions without requiring ASR
  const added = await execCaptionsTool('edit_captions', {
    action: 'cue_add',
    json: {
      cues: [
        { text: '第二句字幕', startMs: 4000, endMs: 6500 },
        { text: '第一句字幕', startMs: 500, endMs: 2500 },
      ],
    },
  }, ctx) as {
    ok: boolean;
    captionTrackId: string;
    captionTrackAlias: string;
    added: Array<{ cueId: string; laneId: string; index: number; text: string; startMs: number; endMs: number }>;
    cueCount: number;
    automaticCaptionAvoidance?: unknown;
  };
  assert.equal(added.ok, true);
  assert.equal(added.captionTrackAlias, 'C1');
  assert.equal(added.cueCount, 2);
  assert.equal(added.added.length, 2);
  assert.equal(added.automaticCaptionAvoidance, undefined, 'cue_add must not trigger automatic geometry avoidance');

  const firstCue = added.added.find((c) => c.text === '第一句字幕')!;
  const secondCue = added.added.find((c) => c.text === '第二句字幕')!;
  assert.ok(firstCue.cueId);
  assert.equal(firstCue.index, 0, 'cues are sorted chronologically');
  assert.equal(secondCue.index, 1);

  // Verify read_captions exposes manualCues and UI buildCues shows them in Caption List
  const read1 = await execCaptionsTool('read_captions', {}, ctx) as {
    enabled: boolean;
    manualCues: Array<{ cueId: string; text: string; startMs: number; endMs: number }>;
    pageCount: number;
  };
  assert.equal(read1.enabled, true);
  assert.equal(read1.manualCues.length, 2);
  assert.equal(read1.manualCues[0]!.text, '第一句字幕');
  assert.equal(read1.manualCues[1]!.text, '第二句字幕');
  assert.equal(read1.pageCount, 2);

  const liveCaptions = draft.getState().tracks?.[added.captionTrackId]?.captions!;
  const uiRows = buildCues(liveCaptions, draft.getState().items, 30);
  assert.deepEqual(uiRows.map((r) => r.text), ['第一句字幕', '第二句字幕'], 'cues appear in UI Caption List');
  assert.ok(uiRows.every((r) => r.manual), 'UI rows are manual cues');

  // cue_update by cueId (moving earlier cue later so order flips) + by index
  const updated = await execCaptionsTool('edit_captions', {
    action: 'cue_update',
    json: {
      cueId: firstCue.cueId,
      text: '已修改的第一句',
      startMs: 7000,
      endMs: 9000,
    },
  }, ctx) as {
    ok: boolean;
    updated: Array<{ cueId: string; index: number; text: string; startMs: number; endMs: number }>;
  };
  assert.equal(updated.ok, true);
  assert.equal(updated.updated[0]!.cueId, firstCue.cueId, 'cueId preserved on update');
  assert.equal(updated.updated[0]!.index, 1, 're-sorted after time change');
  assert.equal(updated.updated[0]!.text, '已修改的第一句');

  const updatedByIndex = await execCaptionsTool('edit_captions', {
    action: 'cue_update',
    json: { index: 0, text: '首句改字' },
  }, ctx) as { ok: boolean; updated: Array<{ text: string; startMs: number }> };
  assert.equal(updatedByIndex.ok, true);
  assert.equal(updatedByIndex.updated[0]!.text, '首句改字');
  assert.equal(updatedByIndex.updated[0]!.startMs, 4000, 'unspecified timing preserved');

  // Invalid timing rejected cleanly
  const badUpdate = await execCaptionsTool('edit_captions', {
    action: 'cue_update',
    json: { cueId: firstCue.cueId, startMs: 9000, endMs: 8000 },
  }, ctx) as { error?: string };
  assert.ok(badUpdate.error?.includes('greater than startMs'));

  // cue_remove by cueId, then add two and clearAll
  const removed = await execCaptionsTool('edit_captions', {
    action: 'cue_remove',
    json: { cueId: firstCue.cueId },
  }, ctx) as { ok: boolean; removedCount: number; remainingCount: number };
  assert.equal(removed.ok, true);
  assert.equal(removed.removedCount, 1);
  assert.equal(removed.remainingCount, 1);

  await execCaptionsTool('edit_captions', {
    action: 'cue_add',
    json: {
      cues: [
        { text: 'A', startMs: 100, endMs: 500 },
        { text: 'B', startMs: 600, endMs: 900 },
      ],
    },
  }, ctx);
  const cleared = await execCaptionsTool('edit_captions', {
    action: 'cue_remove',
    json: { clearAll: true },
  }, ctx) as { ok: boolean; removedCount: number; remainingCount: number };
  assert.equal(cleared.ok, true);
  assert.equal(cleared.removedCount, 3);
  assert.equal(cleared.remainingCount, 0);
}

// ── 2) SRT import (BOM, CRLF, HTML tags, replace, create_track, append_lane) ──
{
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [{ id: 'v1', track: 'V1', startFrame: 0, durationInFrames: 600, name: 'clip', kind: 'video', src: '/v1.mp4' }],
  };
  const { draft, ctx } = createTestCtx(state);

  const srtPayload = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n<b>开场白</b>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,200\r\n第二行字幕\r\n';
  const res1 = await execCaptionsTool('edit_captions', {
    action: 'import_srt',
    json: { srt: srtPayload, name: '主字幕' },
  }, ctx) as { ok: boolean; captionTrackId: string; captionTrackAlias: string; mode: string; cueCount: number; startMs: number; endMs: number };
  assert.equal(res1.ok, true);
  assert.equal(res1.captionTrackAlias, 'C1');
  assert.equal(res1.mode, 'replace');
  assert.equal(res1.cueCount, 2);
  assert.equal(res1.startMs, 1000);
  assert.equal(res1.endMs, 6200);

  const c1Rows = buildCues(draft.getState().tracks![res1.captionTrackId]!.captions!, draft.getState().items, 30);
  assert.deepEqual(c1Rows.map((r) => r.text), ['开场白', '第二行字幕']);

  // Without captionTrackId when C1 is already enabled -> auto-creates C2
  const res2 = await execCaptionsTool('edit_captions', {
    action: 'import_srt',
    json: { content: '1\n00:00:00,500 --> 00:00:02,000\nEnglish Line\n', name: 'EN' },
  }, ctx) as { ok: boolean; captionTrackAlias: string; createdTrack: boolean; mode: string };
  assert.equal(res2.ok, true);
  assert.equal(res2.mode, 'create_track');
  assert.equal(res2.createdTrack, true);
  assert.equal(res2.captionTrackAlias, 'C2');
  assert.equal(captionTrackEntries(draft.getState()).length, 2);

  // append_lane on C1 (addressed by alias C1)
  const res3 = await execCaptionsTool('edit_captions', {
    action: 'import_srt',
    captionTrackId: 'C1',
    json: { srt: '1\n00:00:07,000 --> 00:00:09,000\n补充字幕\n', mode: 'append_lane', name: '补充' },
  }, ctx) as { ok: boolean; mode: string; createdTrack: boolean };
  assert.equal(res3.ok, true);
  assert.equal(res3.mode, 'append_lane');
  assert.equal(res3.createdTrack, false);
  assert.equal(draft.getState().tracks![res1.captionTrackId]!.captions!.sourceEntries!.length, 2);

  // srtPath returns clear guidance without attempting fs access
  const pathErr = await execCaptionsTool('edit_captions', {
    action: 'import_srt',
    json: { srtPath: 'C:/tmp/sub.srt' },
  }, ctx) as { error?: string };
  assert.ok(pathErr.error?.includes('json.srt'));
}

// ── 3) paste_transcript alignment against transcribed track ──────────────
{
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [
      {
        id: 'vo1',
        track: 'A1',
        startFrame: 0,
        durationInFrames: 180,
        name: 'voice',
        kind: 'audio',
        src: '/vo.wav',
        transcript: [
          { text: '大家好', start: 0, end: 800 },
          { text: '欢迎来到', start: 850, end: 1600 },
          { text: '我们的节目', start: 1650, end: 2600 },
        ],
      },
    ],
  };
  const { draft, ctx } = createTestCtx(state);
  const pasted = await execCaptionsTool('edit_captions', {
    action: 'paste_transcript',
    json: { script: '大家好，欢迎来到我们的节目！' },
  }, ctx) as { ok: boolean; speechTrackAlias: string; cueCount: number; captionTrackId: string; captionTrackAlias: string };
  assert.equal(pasted.ok, true);
  assert.equal(pasted.speechTrackAlias, 'A1');
  assert.equal(pasted.captionTrackAlias, 'C1');
  assert.ok(pasted.cueCount >= 1);
  const rows = buildCues(draft.getState().tracks![pasted.captionTrackId]!.captions!, draft.getState().items, 30);
  assert.ok(rows.length >= 1 && rows.some((r) => r.text.includes('大家好')));

  // Missing transcript returns clear error
  const noAsrCtx = createTestCtx({ ...state, items: [{ ...state.items[0]!, transcript: undefined }] }).ctx;
  const noAsr = await execCaptionsTool('edit_captions', {
    action: 'paste_transcript',
    json: { script: '测试文稿' },
  }, noAsrCtx) as { error?: string };
  assert.ok(noAsr.error?.includes('no transcribed speech track'));
}

// ── 4) skipAvoidance opt-out & manual enable on long-video timelines ─────
{
  const state: TimelineState = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [
      {
        id: 'long-v1',
        track: 'V1',
        startFrame: 0,
        durationInFrames: 36_000,
        name: '20min',
        kind: 'video',
        // Non-existent local asset path would fail/stall if geometry analysis ran instead of skipping.
        src: '/media/nonexistent-20min-test.mp4',
        transcript: [{ text: '长视频测试', start: 0, end: 1000 }],
      },
    ],
  };
  const { ctx } = createTestCtx(state);

  const enabledSkipped = await execCaptionsTool('edit_captions', {
    action: 'enable',
    skipAvoidance: true,
  }, ctx) as { ok: boolean; automaticCaptionAvoidance?: { ok: boolean; skipped?: boolean } };
  assert.equal(enabledSkipped.ok, true);
  assert.equal(enabledSkipped.automaticCaptionAvoidance?.skipped, true);

  const sourceSetSkipped = await execCaptionsTool('edit_captions', {
    action: 'source_set',
    json: { mode: 'timeline', skipAvoidance: true },
  }, ctx) as { ok: boolean; automaticCaptionAvoidance?: { ok: boolean; skipped?: boolean } };
  assert.equal(sourceSetSkipped.ok, true);
  assert.equal(sourceSetSkipped.automaticCaptionAvoidance?.skipped, true);

  // enable with json:{manual:true} works without ASR
  const noAsr = createTestCtx({
    ...state,
    items: [{ ...state.items[0]!, transcript: undefined }],
  }).ctx;
  const manualEnable = await execCaptionsTool('edit_captions', {
    action: 'enable',
    skipAvoidance: true,
    json: { manual: true },
  }, noAsr) as { ok: boolean; manual?: boolean; automaticCaptionAvoidance?: { skipped?: boolean } };
  assert.equal(manualEnable.ok, true);
  assert.equal(manualEnable.manual, true);
  assert.equal(manualEnable.automaticCaptionAvoidance?.skipped, true);
}

// ── 5) Server-direct offline policy & schema checks ──────────────────────
{
  const schema = CAPTIONS_TOOL_SCHEMAS.find((tool) => tool.name === 'edit_captions')!;
  const props = schema.input_schema.properties!;
  const actionEnum = (props.action as { enum: string[] }).enum;
  for (const action of ['cue_add', 'cue_update', 'cue_remove', 'import_srt', 'paste_transcript']) {
    assert.ok(actionEnum.includes(action), `schema action enum includes ${action}`);
    assert.equal(isExternalServerDirectCall('edit_captions', { action }), true, `${action} is server-direct`);
  }
  assert.ok('skipAvoidance' in props, 'schema includes skipAvoidance');

  const { ctx } = createTestCtx({
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [],
  });
  const offlineRes = await executeOfflineTool('edit_captions', {
    action: 'cue_add',
    json: { text: '离线添加字幕', startMs: 1000, endMs: 3000 },
  }, ctx) as { ok: boolean; cueCount: number };
  assert.equal(offlineRes.ok, true);
  assert.equal(offlineRes.cueCount, 1);
}

console.log('captions-manual-import.verify: cue CRUD, SRT import, paste_transcript, skipAvoidance, and offline execution OK');
