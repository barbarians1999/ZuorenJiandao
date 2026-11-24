import assert from 'node:assert/strict';
import { makeDraft } from '../editor/store';
import { loadAgentRuntimeSidecar } from '../persist/agentRuntimeStore';
import { ExternalBridgeRuntime } from './external-bridge-runtime';
import { getExternalAutoApprove, setExternalAutoApprove } from './external-auto-approve';
import {
  ExternalEditSessionOutcomeError,
  revisionOf,
} from './external-edit-session';
import {
  isExternalDraftTool,
  isExternalGlobalReadTool,
  isExternalReadTool,
  isExternalRealTool,
} from './external-tool-policy';
import { externalToolSchemas } from './external-tool-schemas';
import {
  externalToolFailureOutcome,
  type ExternalRecordedInvocation,
} from './external-run-ledger';
import { policyForTool } from './execution-policy';
import { ASK_MODE_TOOL_SCHEMAS } from './ask-mode-tools';
import {
  agentRunId,
  base,
  needsConfirmation,
  reviewed,
  sessionStatus,
} from './external-edit-session-core.verify';
import { lateCall } from './external-edit-session-cancellation.verify';
const live = makeDraft(base);
const runtime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: live.commands,
    getState: live.getState,
    getDoc: live.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
export const runtimeBinding = {
  projectId: 'runtime-project',
  editorInstanceId: 'runtime-editor',
  baseRevision: revisionOf(base),
};
const missingSkill = await runtime.execute(
  'load_skill',
  { name: 'missing-skill-check' },
  runtimeBinding,
);
assert(
  missingSkill
    && typeof missingSkill === 'object'
    && 'error' in missingSkill
    && String(missingSkill.error).includes('no such skill'),
  'stateless skill reads execute without an edit session',
);
const begun = await runtime.execute('begin_edit_session', {}, runtimeBinding);
assert(begun && typeof begun === 'object' && 'editSessionId' in begun);
await assert.rejects(
  runtime.execute('begin_edit_session', {}, runtimeBinding),
  /list_edit_sessions/,
  'active-session conflicts remain tool errors and point callers to recovery discovery',
);
const listed = await runtime.execute('list_edit_sessions', {}, runtimeBinding);
assert(Array.isArray(listed) && listed.some((entry) => (
  entry && typeof entry === 'object' && 'editSessionId' in entry
  && entry.editSessionId === begun.editSessionId
)), 'project sessions are discoverable before recovery');
await assert.rejects(
  runtime.execute('set_aspect_ratio', {
    editSessionId: begun.editSessionId,
    ratio: 'cinemascope',
  }, runtimeBinding),
  (error: unknown) => error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'rejected',
  'connected invalid arguments fail shared schema validation before execution',
);
await assert.rejects(
  runtime.execute('hidden_internal_tool', {
    editSessionId: begun.editSessionId,
  }, runtimeBinding),
  (error: unknown) => error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'rejected'
    && error.message.includes('not active'),
  'connected calls cannot invoke schemas outside the registered catalog',
);

// Every real-project invocation is confirm-gated; the durable approval allows
// exactly one retry with the same session/run, tool, and canonical arguments.
const guarded = await runtime.execute(
  'read_export_history',
  { editSessionId: begun.editSessionId, limit: 1 },
  runtimeBinding,
);
assert(needsConfirmation(guarded), 'real-project tools ask for exact one-shot confirmation');
assert.equal(
  guarded && typeof guarded === 'object' && 'status' in guarded ? guarded.status : undefined,
  'pending',
  'real-project confirmation replies expose an explicit pending status',
);
const guard = runtime.pendingGuard();
assert(guard && guard.tool === 'read_export_history', 'pending guard surfaces the requested tool');
let durableRun = (await loadAgentRuntimeSidecar('runtime-project')).runs
  .find((run) => run.runId === agentRunId(begun));
assert(durableRun);
assert.deepEqual(
  durableRun.events.slice(-2).map((event) => event.type),
  ['tool_requested', 'approval_requested'],
  'durable intent and pending approval precede needs_confirmation',
);
assert.equal(
  (await loadAgentRuntimeSidecar('runtime-project')).approvals
    .find((approval) => approval.approvalId === guard!.id)?.status,
  'pending',
);
await runtime.confirmRealTool(guard!.id, true);
const differentArgs = await runtime.execute(
  'read_export_history',
  { editSessionId: begun.editSessionId, limit: 2 },
  runtimeBinding,
);
assert(needsConfirmation(differentArgs), 'an approval cannot authorize different arguments');
const differentGuard = runtime.pendingGuard();
assert(differentGuard && differentGuard.id !== guard!.id);
const released = await runtime.execute(
  'read_export_history',
  { editSessionId: begun.editSessionId, limit: 1 },
  runtimeBinding,
);
assert(!needsConfirmation(released), 'the exact approved retry consumes its one-shot authorization');
durableRun = (await loadAgentRuntimeSidecar('runtime-project')).runs
  .find((run) => run.runId === agentRunId(begun));
assert(durableRun);
const decidedAt = durableRun.events.findIndex((event) => (
  event.type === 'approval_decided' && event.approvalId === guard!.id
));
const startedAt = durableRun.events.findIndex((event) => event.type === 'tool_started');
assert(decidedAt >= 0 && startedAt > decidedAt, 'approval resolution is durable before execution starts');
await runtime.confirmRealTool(differentGuard!.id, false);
assert(runtime.pendingGuard() === null, 'resolved guards leave the pending set');

const draftingInfo = await runtime.execute(
  'get_edit_session',
  { editSessionId: begun.editSessionId },
  runtimeBinding,
);
assert.equal(sessionStatus(draftingInfo), 'drafting');
await assert.rejects(
  runtime.execute('get_edit_session', { editSessionId: begun.editSessionId }, {
    ...runtimeBinding,
    projectId: 'other-project',
  }),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
);
await assert.rejects(
  runtime.execute('begin_edit_session', {}, runtimeBinding, lateCall.signal),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'cancelled'
  ),
  'a cancellation tombstone produces the cancelled terminal outcome before execution',
);
await runtime.execute(
  'discard_edit_session',
  { editSessionId: begun.editSessionId },
  runtimeBinding,
);
durableRun = (await loadAgentRuntimeSidecar('runtime-project')).runs
  .find((run) => run.runId === agentRunId(begun));
assert.equal(durableRun?.status, 'aborted');
assert.equal(durableRun?.events.at(-1)?.type, 'final', 'cancelled sessions have a durable terminal record');

live.commands.setAspect(1080, 1920, 'contain');
await runtime.hydrate({
  sessionId: 'runtime-applied-session',
  clientName: 'Codex',
  approvalMode: 'manual',
  status: 'applied',
  baseRevision: runtimeBinding.baseRevision,
  createdAt: Date.now(),
  operationCount: 1,
  appliedOperationCount: 1,
  proposal: null,
});
await assert.rejects(
  runtime.execute(
    'get_edit_session',
    { editSessionId: 'runtime-applied-session' },
    runtimeBinding,
  ),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
  'hydration cannot fabricate the exact revision produced by a prior UI apply',
);
await assert.rejects(
  runtime.execute(
    'set_aspect_ratio',
    {
      editSessionId: 'runtime-applied-session',
      ratio: '1:1',
    },
    runtimeBinding,
  ),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
  'mutating tools retain strict base-revision validation',
);
await assert.rejects(
  runtime.execute(
    'get_edit_session',
    { editSessionId: 'unknown-session' },
    runtimeBinding,
  ),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale'
  ),
  'unknown session ids cannot use terminal-read revision relaxation',
);

const rejectedLive = makeDraft(base);
const rejectedRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: rejectedLive.commands,
    getState: rejectedLive.getState,
    getDoc: rejectedLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
await rejectedRuntime.hydrate({
  sessionId: 'runtime-rejected-session',
  clientName: 'Codex',
  approvalMode: 'manual',
  status: 'rejected',
  baseRevision: revisionOf(base),
  createdAt: Date.now(),
  operationCount: 1,
  proposal: null,
});
const rejectedInfo = await rejectedRuntime.execute(
  'get_edit_session',
  { editSessionId: 'runtime-rejected-session' },
  runtimeBinding,
);
assert.equal(sessionStatus(rejectedInfo), 'rejected');

const reviewLive = makeDraft(base);
const reviewRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: reviewLive.commands,
    getState: reviewLive.getState,
    getDoc: reviewLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
await reviewRuntime.hydrate({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'manual',
  status: 'awaiting_review',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal,
});
const awaitingInfo = await reviewRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(awaitingInfo), 'awaiting_review');
assert(isExternalDraftTool('set_aspect_ratio'));
assert(isExternalReadTool('read_project'));
assert(isExternalReadTool('search_stock_media'));
assert(isExternalReadTool('search_media'));
assert(isExternalDraftTool('apply_caption_avoidance'));
assert(isExternalDraftTool('place_graphics_in_safe_zone'));
assert(isExternalDraftTool('auto_reframe'));
assert(!isExternalDraftTool('delete_project'));
assert(!isExternalDraftTool('submit_render_job'));
assert(isExternalRealTool('submit_render_job'), 'real-project tools are exposed to external agents (confirm-gated)');
assert(isExternalRealTool('submit_image'), 'generation is confirm-gated for external agents');
assert(isExternalRealTool('import_media'), 'import is confirm-gated for external agents');
assert(isExternalGlobalReadTool('load_skill'));
assert(!isExternalDraftTool('load_skill'));
const askModeToolNames = new Set(ASK_MODE_TOOL_SCHEMAS.map((tool) => tool.name));
assert(askModeToolNames.has('load_skill'), 'Q&A mode exposes the current skill reader');
assert(askModeToolNames.has('read_project'), 'Q&A mode exposes project inspection');
assert(!askModeToolNames.has('search_stock_media'), 'retired online stock search is not exposed');
assert(askModeToolNames.has('search_media'), 'Q&A mode retains local media search');
assert(!askModeToolNames.has('edit_captions'), 'Q&A mode excludes draft edits');
assert(!askModeToolNames.has('submit_render_job'), 'Q&A mode excludes live side effects');
assert(
  ASK_MODE_TOOL_SCHEMAS.every(
    (tool) => isExternalGlobalReadTool(tool.name) || isExternalReadTool(tool.name),
  ),
  'every Q&A mode tool is classified read-only',
);
const externalLoadSkill = externalToolSchemas().find((tool) => tool.name === 'load_skill');
assert(externalLoadSkill, 'load_skill is exposed to external agents');
assert.equal(externalLoadSkill.annotations?.readOnlyHint, true);
assert(!('editSessionId' in (externalLoadSkill.input_schema.properties ?? {})));
assert(!externalLoadSkill.input_schema.required?.includes('editSessionId'));
const externalSubmitRender = externalToolSchemas().find((tool) => tool.name === 'submit_render_job');
assert(externalSubmitRender, 'submit_render_job is exposed to external agents');
assert.equal(externalSubmitRender.annotations?.readOnlyHint, false);
assert(externalSubmitRender.input_schema.required?.includes('editSessionId'), 'real tools carry editSessionId for the confirmation gate');

// Auto applies the staged proposal only; real-project tools remain explicitly gated.
const autoLive = makeDraft(base);
const autoRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: autoLive.commands,
    getState: autoLive.getState,
    getDoc: autoLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
);
const autoBinding = {
  projectId: 'runtime-project',
  editorInstanceId: 'runtime-editor',
  baseRevision: revisionOf(base),
};
const autoYoloSession = await autoRuntime.execute('begin_edit_session', { approvalMode: 'auto' }, autoBinding);
assert(autoYoloSession && typeof autoYoloSession === 'object' && 'editSessionId' in autoYoloSession);
const autoGuarded = await autoRuntime.execute(
  'read_export_history',
  { editSessionId: autoYoloSession.editSessionId },
  autoBinding,
);
assert(!needsConfirmation(autoGuarded), 'auto sessions execute real-project tools directly without confirmation');
assert(autoRuntime.pendingGuard() === null, 'auto execution leaves no pending approval');

const ambiguousInvocation: ExternalRecordedInvocation = {
  toolCallId: 'ambiguous-call',
  toolName: 'submit_render_job',
  argsDigest: 'sha256:ambiguous',
  operationId: 'render-op',
  policy: policyForTool('submit_render_job'),
};
assert.equal(
  externalToolFailureOutcome(ambiguousInvocation, new Error('connection lost'), true).kind,
  'outcome_unknown',
  'failures after a guarded real side effect starts remain explicitly ambiguous',
);

const staleRecordLive = makeDraft(base);
const staleRecordRuntime = new ExternalBridgeRuntime(
  'stale-record-project',
  'stale-record-editor',
  () => ({
    commands: staleRecordLive.commands,
    getState: staleRecordLive.getState,
    getDoc: staleRecordLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'stale-record-project',
  }),
  () => undefined,
);
const staleRecordBinding = {
  projectId: 'stale-record-project',
  editorInstanceId: 'stale-record-editor',
  baseRevision: revisionOf(base),
};
const staleRecordSession = await staleRecordRuntime.execute(
  'begin_edit_session',
  {},
  staleRecordBinding,
);
assert(staleRecordSession && typeof staleRecordSession === 'object' && 'editSessionId' in staleRecordSession);
staleRecordLive.commands.setAspect(1080, 1080, 'contain');
await assert.rejects(
  staleRecordRuntime.execute('set_aspect_ratio', {
    editSessionId: staleRecordSession.editSessionId,
    ratio: '1:1',
  }, staleRecordBinding),
  (error: unknown) => error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'stale',
);
const staleRecordedRun = (await loadAgentRuntimeSidecar('stale-record-project')).runs
  .find((run) => run.runId === agentRunId(staleRecordSession));
assert.equal(staleRecordedRun?.status, 'aborted');
assert.equal(staleRecordedRun?.events.at(-1)?.type, 'final', 'stale sessions have a durable terminal record');

// Master auto-approve toggle tests (default off, bypasses manual real-tool & proposal gates when on, approveAllPending resolves queued gates).
{
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof requestAnimationFrame;
  try {
    setExternalAutoApprove(false);
    assert.equal(getExternalAutoApprove(), false, 'master auto-approve defaults to false');

    const toggleLive = makeDraft(base);
    let publishedCount = 0;
    const toggleRuntime = new ExternalBridgeRuntime(
      'auto-approve-project',
      'auto-approve-editor',
      () => ({
        commands: toggleLive.commands,
        getState: toggleLive.getState,
        getDoc: toggleLive.getDoc,
        getCreativeMode: () => null,
        templates: [],
        audio: [],
        getProjectId: () => 'auto-approve-project',
      }),
      (snap) => { if (snap.proposal) publishedCount += 1; },
    );
    const toggleBinding = () => ({
      projectId: 'auto-approve-project',
      editorInstanceId: 'auto-approve-editor',
      baseRevision: revisionOf(toggleLive.getDoc()),
    });

    // 1) When autoApprove is true, a manual session skips real-tool confirmation and auto-applies review_edit_session.
    setExternalAutoApprove(true);
    assert.equal(getExternalAutoApprove(), true);
    const s1 = await toggleRuntime.execute('begin_edit_session', { approvalMode: 'manual' }, toggleBinding()) as { editSessionId: string };
    const directReal = await toggleRuntime.execute('read_export_history', { editSessionId: s1.editSessionId }, toggleBinding());
    assert(!needsConfirmation(directReal), 'master toggle skips real-tool confirmation on manual session');
    await toggleRuntime.execute('set_aspect_ratio', { editSessionId: s1.editSessionId, ratio: '1:1' }, toggleBinding());
    const review1 = await toggleRuntime.execute('review_edit_session', { editSessionId: s1.editSessionId, summary: 'auto-applied' }, toggleBinding());
    assert.equal(sessionStatus(review1), 'applied', 'master toggle auto-applies review_edit_session');
    assert.equal(toggleLive.getState().width, 1080);

    // 2) When disabled again, manual confirmation returns, and approveAllPending() resolves pending guard + awaiting proposal.
    setExternalAutoApprove(false);
    const s2 = await toggleRuntime.execute('begin_edit_session', { approvalMode: 'manual' }, toggleBinding()) as { editSessionId: string };
    const gated = await toggleRuntime.execute('read_export_history', { editSessionId: s2.editSessionId }, toggleBinding());
    assert(needsConfirmation(gated), 'disabling master toggle restores manual real-tool gate');
    assert(toggleRuntime.pendingGuard() !== null);
    await toggleRuntime.execute('set_aspect_ratio', { editSessionId: s2.editSessionId, ratio: '9:16' }, toggleBinding());
    const review2 = await toggleRuntime.execute('review_edit_session', { editSessionId: s2.editSessionId, summary: 'awaiting review' }, toggleBinding());
    assert.equal(sessionStatus(review2), 'awaiting_review');
    assert.ok(publishedCount >= 1);

    setExternalAutoApprove(true);
    await toggleRuntime.approveAllPending();
    assert.equal(toggleRuntime.pendingGuard(), null, 'approveAllPending clears pending real-tool guard');
    assert.equal(toggleLive.getState().width, 1080);
    assert.equal(toggleLive.getState().height, 1920, 'approveAllPending applies awaiting proposal');
    setExternalAutoApprove(false);
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
  }
}
