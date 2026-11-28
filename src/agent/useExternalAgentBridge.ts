import {
  useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction,
} from 'react';
import type { AgentContext } from './context';
import {
  ExternalBridgeRuntime, type ExternalGuardRequest, type ExternalProposalSnapshot,
} from './external-bridge-runtime';
import {
  ExternalEditSessionOutcomeError, type ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import { ExternalCallCancellationRegistry } from './external-call-cancellation';
import type { Proposal } from './proposal';
import { loadExternalProposal } from '../persist/externalProposalStore';
import {
  clearBrowserProjectOwnership,
  browserProjectOwnership,
  installBrowserProjectOwnership,
  projectStoreRemoteAvailable,
  type BrowserProjectOwnership,
} from '../persist/projectStoreTransport';
import { redactTextForAgentRuntime } from './runtime-artifact';
import { projectExternalReply } from './external-result-projection';
export { projectExternalReply } from './external-result-projection';
import { externalBridgeCanStart, type ExternalBridgeReadinessToken } from './external-bridge-readiness';
import {
  EditorBridgeRequestError,
  editorBridgeHeaders,
  registerEditorBridge,
  sendEditorBridgeResult,
  setExternalBridgeReadOnly,
  unregisterEditorBridge,
  type MultiWindowConflictInfo,
} from './external-bridge-registration';
import { handleExternalBridgeAttemptError } from './external-bridge-attempt-error';
import { useT } from '../i18n/locale';
import { useExternalAutoApprove } from './external-auto-approve';
import {
  parseExternalCall,
  parseExternalCancellation as parseCancellation,
  type ExternalCall,
} from './externalBridgePayload';
export type { ExternalCall } from './externalBridgePayload';

interface ExternalCallRuntime {
  execute: ExternalBridgeRuntime['execute'];
  binding?: ExternalBridgeRuntime['binding'];
  discardOwnerSessions?: (sessionIds: string[]) => Promise<void>;
}

export type ExternalResultSender = (
  id: string,
  outcome: ExternalEditSessionTerminalStatus,
  value: unknown,
  signal: AbortSignal,
  baseRevision?: string,
) => Promise<void>;

interface ExternalBridgeRuntimeSlot extends ExternalBridgeReadinessToken {
  runtime: ExternalBridgeRuntime;
}
interface ExternalBridgeHydrator {
  hydrate: ExternalBridgeRuntime['hydrate'];
}

export interface ExternalProposalController {
  proposal: Proposal | null;
  proposalStale: boolean;
  error: string | null;
  applyProposal: (selected: Set<number>) => void;
  forceApplyProposal: (selected: Set<number>) => void;
  rejectProposal: () => void;
  /** Pending real-project tool confirmation from an external session. */
  pendingGuard: ExternalGuardRequest | null;
  confirmGuard: (id: string, allow: boolean) => void;
  /** Persisted master switch: auto-approve all external edits and real-tool calls. */
  autoApprove: boolean;
  setAutoApprove: (enabled: boolean) => void;
  conflict: MultiWindowConflictInfo | null;
  takeover: () => void;
}

function retryDelay(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 1_000);
  return promise;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function failedOutcome(
  error: unknown,
  signal: AbortSignal,
): {
  outcome: Exclude<ExternalEditSessionTerminalStatus, 'applied'>;
  message: string;
} {
  const message = redactTextForAgentRuntime(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 1_200) || 'External editor call failed.';
  if (error instanceof ExternalEditSessionOutcomeError) {
    return { outcome: error.outcome, message };
  }
  return {
    outcome: signal.aborted ? 'cancelled' : 'failed',
    message,
  };
}

export async function executeExternalCall(
  call: ExternalCall,
  runtime: ExternalCallRuntime,
  bridgeSignal: AbortSignal,
  cancellations: ExternalCallCancellationRegistry,
  deliverResult: ExternalResultSender,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(bridgeSignal.reason);
  if (bridgeSignal.aborted) controller.abort(bridgeSignal.reason);
  else bridgeSignal.addEventListener('abort', cancel, { once: true });
  cancellations.register(call.id, controller);
  let outcome: ExternalEditSessionTerminalStatus = 'applied';
  let value: unknown;
  try {
    try {
      value = projectExternalReply(
        await runtime.execute(call.name, call.arguments, call.binding, controller.signal),
      );
      // Flush pending project saves before reporting the result: the settle
      // syncs the registry to the committed store revision, and a follow-up MCP
      // session binding against a pre-autosave revision would be rejected as
      // stale by the ownership renew check.
      try {
        const { flushProjectSaves } = await import('../persist/projectStore');
        await flushProjectSaves(call.binding.projectId);
      } catch {
        // Save flushing is best-effort; the poll loop still converges afterwards.
      }
    } catch (error) {
      const failed = failedOutcome(error, controller.signal);
      outcome = failed.outcome;
      value = projectExternalReply(failed.message);
    }
    const runtimeBinding = runtime.binding?.();
    const settledRevision = (
      runtimeBinding
        ? browserProjectOwnership(call.binding.projectId, runtimeBinding.editorInstanceId)?.baseRevision
        : undefined
    ) ?? runtimeBinding?.baseRevision;
    await deliverResult(call.id, outcome, value, bridgeSignal, settledRevision);
  } finally {
    cancellations.release(call.id);
    bridgeSignal.removeEventListener('abort', cancel);
  }
}

async function pollEditor(
  projectId: string,
  runtime: ExternalBridgeRuntime,
  cancellations: ExternalCallCancellationRegistry,
  ownership: BrowserProjectOwnership,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const cachedBaseRevision = browserProjectOwnership(projectId, runtime.getEditorInstanceId())?.baseRevision;
    const binding = runtime.binding(cachedBaseRevision);
    const query = new URLSearchParams({
      projectId,
      editorId: binding.editorInstanceId,
      baseRevision: cachedBaseRevision ?? binding.baseRevision,
    });
    const response = await fetch(`/api/external-agent/poll?${query}`, {
      headers: editorBridgeHeaders(false, ownership.registrationCapability),
      signal,
    });
    if (response.status === 204) continue;
    if (!response.ok) {
      if (response.status === 409) {
        let body: { code?: string; holderClientKind?: 'desktop' | 'browser' | null; error?: string } | undefined;
        try { body = await response.json() as typeof body; } catch { body = undefined; }
        throw new EditorBridgeRequestError('poll', response.status, body?.code, body?.holderClientKind, body?.error);
      }
      throw new EditorBridgeRequestError('poll', response.status);
    }
    await executeExternalCall(
      parseExternalCall(await response.json()),
      runtime,
      signal,
      cancellations,
      (id, outcome, value, resultSignal, baseRevision) => sendEditorBridgeResult(
        id,
        outcome,
        value,
        resultSignal,
        ownership.registrationCapability,
        baseRevision,
      ),
    );
    const updatedRevision = runtime.binding().baseRevision;
    if (updatedRevision && updatedRevision !== ownership.baseRevision) {
      ownership = { ...ownership, baseRevision: updatedRevision };
      installBrowserProjectOwnership(ownership);
    }
  }
}

async function pollCancellations(
  projectId: string,
  editorInstanceId: string,
  runtime: ExternalCallRuntime,
  cancellations: ExternalCallCancellationRegistry,
  registrationCapability: string,
  signal: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({ projectId, editorId: editorInstanceId });
  while (!signal.aborted) {
    const response = await fetch(`/api/external-agent/cancellation?${query}`, {
      headers: editorBridgeHeaders(false, registrationCapability),
      signal,
    });
    if (response.status === 204) continue;
    if (!response.ok) throw new EditorBridgeRequestError('cancellation poll', response.status);
    const cancellation = parseCancellation(await response.json());
    if (cancellation.ownerGone?.length) {
      await runtime.discardOwnerSessions?.(cancellation.ownerGone);
      continue;
    }
    cancellations.cancel(cancellation.id, cancellation.message);
  }
}


async function pollRegisteredBridge(
  projectId: string,
  editorInstanceId: string,
  runtime: ExternalBridgeRuntime,
  cancellations: ExternalCallCancellationRegistry,
  ownership: BrowserProjectOwnership,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all([
    pollEditor(projectId, runtime, cancellations, ownership, signal),
    pollCancellations(
      projectId,
      editorInstanceId,
      runtime,
      cancellations,
      ownership.registrationCapability,
      signal,
    ),
  ]);
}

async function runBridgeAttempt(
  projectId: string, editorInstanceId: string,
  runtime: ExternalBridgeRuntime, signal: AbortSignal,
  onError: (message: string | null) => void,
  forceTakeoverRef: { current: boolean },
  onConflict: (conflict: MultiWindowConflictInfo) => void,
): Promise<'retry' | 'conflict'> {
  const cancellations = new ExternalCallCancellationRegistry();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  let ownership: BrowserProjectOwnership | undefined;
  let result: 'retry' | 'conflict' = 'retry';
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', cancel, { once: true });
  try {
    const forceTakeover = forceTakeoverRef.current;
    ownership = await registerEditorBridge(
      projectId, editorInstanceId, runtime.binding().baseRevision,
      controller.signal,
      browserProjectOwnership(projectId, editorInstanceId)?.registrationCapability,
      forceTakeover ? { forceTakeover: true } : undefined,
    );
    forceTakeoverRef.current = false;
    installBrowserProjectOwnership(ownership);
    onError(null);
    await pollRegisteredBridge(
      projectId,
      editorInstanceId,
      runtime,
      cancellations,
      ownership,
      controller.signal,
    );
  } catch (error) {
    if (
      error instanceof EditorBridgeRequestError
      && error.status === 409
      && (error.code === 'MULTI_WINDOW_CONFLICT' || error.code === 'OWNERSHIP_TAKEN_OVER')
    ) {
      forceTakeoverRef.current = false;
      onConflict({
        code: error.code,
        holderClientKind: error.holderClientKind ?? null,
        message: error.message,
      });
      result = 'conflict';
    } else {
      handleExternalBridgeAttemptError(error, signal, onError);
    }
  } finally {
    controller.abort();
    signal.removeEventListener('abort', cancel);
    cancellations.abortAll(controller.signal.reason);
    if (ownership) clearBrowserProjectOwnership(ownership);
    await unregisterEditorBridge(
      projectId, editorInstanceId,
      ownership?.registrationCapability,
    );
  }
  return result;
}

async function runBridge(
  projectId: string,
  runtime: ExternalBridgeRuntime,
  signal: AbortSignal,
  onError: (message: string | null) => void,
  forceTakeoverRef: { current: boolean },
  onConflict: (conflict: MultiWindowConflictInfo) => void,
): Promise<void> {
  const { editorInstanceId } = runtime.binding();
  while (!signal.aborted) {
    const outcome = await runBridgeAttempt(
      projectId,
      editorInstanceId,
      runtime,
      signal,
      onError,
      forceTakeoverRef,
      onConflict,
    );
    if (outcome === 'conflict' || signal.aborted) break;
    await retryDelay();
  }
}

export async function hydrateExternalBridge(
  projectId: string,
  runtime: ExternalBridgeHydrator,
  isAlive: () => boolean,
  onError: (message: string) => void,
  onHydrated: () => void,
  loadProposal: typeof loadExternalProposal = loadExternalProposal,
): Promise<void> {
  try {
    const pending = await loadProposal(projectId);
    if (!isAlive()) return;
    try {
      await runtime.hydrate(pending);
    } catch (hydrateError) {
      if (isAlive()) onError(errorMessage(hydrateError));
    }
  } catch (loadError) {
    if (!isAlive()) return;
    await runtime.hydrate(null);
    onError(errorMessage(loadError));
  }
  if (isAlive()) onHydrated();
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;
interface RuntimeSlotRef { current: ExternalBridgeRuntimeSlot | null }
interface ContextRef { current: AgentContext }
interface ExternalRuntimeController {
  runtimeRef: RuntimeSlotRef;
  readiness: ExternalBridgeReadinessToken | null;
}

function installExternalRuntime(
  projectId: string,
  ctxRef: ContextRef,
  runtimeRef: RuntimeSlotRef,
  setSnapshot: StateSetter<ExternalProposalSnapshot>,
  setError: StateSetter<string | null>,
  setReadiness: StateSetter<ExternalBridgeReadinessToken | null>,
): () => void {
  let alive = true;
  const editorInstanceId = crypto.randomUUID();
  const runtimeIdentity = {};
  const isCurrent = () => alive && runtimeRef.current?.runtimeIdentity === runtimeIdentity;
  const runtime = new ExternalBridgeRuntime(
    projectId,
    editorInstanceId,
    () => ctxRef.current,
    (next) => { if (isCurrent()) setSnapshot(next); },
  );
  runtimeRef.current = { projectId, editorInstanceId, runtimeIdentity, runtime };
  setReadiness(null);
  void hydrateExternalBridge(
    projectId,
    runtime,
    isCurrent,
    (message) => { if (isCurrent()) setError(message); },
    () => {
      if (isCurrent()) setReadiness({ projectId, editorInstanceId, runtimeIdentity });
    },
  );
  return () => {
    alive = false;
    void runtime.disconnect().catch(() => undefined);
    if (runtimeRef.current?.runtimeIdentity === runtimeIdentity) runtimeRef.current = null;
  };
}

function useExternalRuntime(
  ctx: AgentContext,
  projectId: string,
  setSnapshot: StateSetter<ExternalProposalSnapshot>,
  setError: StateSetter<string | null>,
): ExternalRuntimeController {
  const [readiness, setReadiness] = useState<ExternalBridgeReadinessToken | null>(null);
  const ctxRef = useRef(ctx);
  const runtimeRef = useRef<ExternalBridgeRuntimeSlot | null>(null);
  ctxRef.current = ctx;
  useEffect(
    () => installExternalRuntime(projectId, ctxRef, runtimeRef, setSnapshot, setError, setReadiness),
    [projectId, setError, setSnapshot],
  );
  return { runtimeRef, readiness };
}

function useExternalPolling(
  projectId: string,
  controller: ExternalRuntimeController,
  setError: StateSetter<string | null>,
  forceTakeoverRef: { current: boolean },
  takeoverNonce: number,
  onConflict: (conflict: MultiWindowConflictInfo) => void,
): void {
  useEffect(() => {
    const slot = controller.runtimeRef.current;
    const readiness = controller.readiness;
    if (!readiness || !slot) return undefined;
    const transportAvailable = projectStoreRemoteAvailable();
    if (!externalBridgeCanStart(readiness, slot, projectId, transportAvailable)) {
      if (!transportAvailable) setError(null);
      return undefined;
    }
    const abortController = new AbortController();
    const close = () => {
      void unregisterEditorBridge(
        projectId,
        readiness.editorInstanceId,
        browserProjectOwnership(projectId, readiness.editorInstanceId)?.registrationCapability,
      );
    };
    window.addEventListener('pagehide', close);
    void runBridge(projectId, slot.runtime, abortController.signal, setError, forceTakeoverRef, onConflict);
    return () => {
      window.removeEventListener('pagehide', close);
      abortController.abort();
      close();
    };
  }, [controller.readiness, controller.runtimeRef, forceTakeoverRef, onConflict, projectId, setError, takeoverNonce]);
}

function useExternalActions(
  runtimeRef: RuntimeSlotRef,
  setError: StateSetter<string | null>,
) {
  const runAction = useCallback((action: Promise<void> | undefined) => {
    if (!action) return;
    setError(null);
    void action.catch((actionError) => setError(errorMessage(actionError)));
  }, [setError]);
  const applyProposal = useCallback(
    (selected: Set<number>) => runAction(runtimeRef.current?.runtime.apply(selected)),
    [runAction, runtimeRef],
  );
  const forceApplyProposal = useCallback(
    (selected: Set<number>) => runAction(runtimeRef.current?.runtime.apply(selected, true)),
    [runAction, runtimeRef],
  );
  const rejectProposal = useCallback(
    () => runAction(runtimeRef.current?.runtime.reject()),
    [runAction, runtimeRef],
  );
  return { applyProposal, forceApplyProposal, rejectProposal };
}

function useExternalGuard(
  runtime: ExternalRuntimeController,
  projectId: string,
  setError: StateSetter<string | null>,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const [pendingGuard, setPendingGuard] = useState<ExternalGuardRequest | null>(null);
  const confirmGuard = useCallback(async (id: string, allow: boolean) => {
    const bridge = runtime.runtimeRef.current?.runtime;
    if (!bridge) return;
    setError(null);
    try {
      await bridge.confirmRealTool(id, allow);
      setPendingGuard((current) => (current?.id === id ? null : current));
    } catch (confirmationError) {
      setError(t('工具确认未保存，请重试：{message}', { message: errorMessage(confirmationError) }));
    }
  }, [runtime.runtimeRef, setError, t]);
  const refreshPendingGuard = useCallback(() => {
    const slot = runtime.runtimeRef.current;
    setPendingGuard(slot ? slot.runtime.pendingGuard() : null);
  }, [runtime.runtimeRef]);
  useEffect(() => {
    const slot = runtime.runtimeRef.current;
    if (!slot) return undefined;
    const refresh = () => setPendingGuard(slot.runtime.pendingGuard());
    refresh();
    slot.runtime.onGuardRequest = (request) => setPendingGuard(request);
    const timer = window.setInterval(refresh, 800);
    return () => {
      slot.runtime.onGuardRequest = null;
      window.clearInterval(timer);
    };
  }, [runtime.readiness, runtime.runtimeRef, projectId]);
  return { pendingGuard, confirmGuard, refreshPendingGuard };
}
export function useExternalAgentBridge(ctx: AgentContext, projectId: string): ExternalProposalController {
  const [snapshot, setSnapshot] = useState<ExternalProposalSnapshot>({ proposal: null, stale: false });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MultiWindowConflictInfo | null>(null);
  const [takeoverNonce, setTakeoverNonce] = useState(0);
  const forceTakeoverRef = useRef(false);
  const t = useT();
  const [autoApprove, setAutoApprove] = useExternalAutoApprove();
  const handleConflict = useCallback((info: MultiWindowConflictInfo) => {
    setExternalBridgeReadOnly(projectId, true);
    setConflict(info);
  }, [projectId]);
  useEffect(() => () => {
    setExternalBridgeReadOnly(projectId, false);
  }, [projectId]);
  const takeover = useCallback(() => {
    setExternalBridgeReadOnly(projectId, false);
    forceTakeoverRef.current = true;
    setConflict(null);
    setError(null);
    setTakeoverNonce((n) => n + 1);
  }, [projectId]);
  const runtime = useExternalRuntime(ctx, projectId, setSnapshot, setError);
  useExternalPolling(projectId, runtime, setError, forceTakeoverRef, takeoverNonce, handleConflict);
  const actions = useExternalActions(runtime.runtimeRef, setError);
  const guard = useExternalGuard(runtime, projectId, setError, t);
  const { refreshPendingGuard } = guard;
  useEffect(() => {
    if (!autoApprove) return;
    const bridge = runtime.runtimeRef.current?.runtime;
    if (!bridge) return;
    let cancelled = false;
    void bridge.approveAllPending()
      .then(() => {
        if (!cancelled) refreshPendingGuard();
      })
      .catch((approvalError) => {
        if (!cancelled) setError(errorMessage(approvalError));
      });
    return () => {
      cancelled = true;
    };
  }, [autoApprove, refreshPendingGuard, runtime.readiness, runtime.runtimeRef]);
  return {
    proposal: snapshot.proposal,
    proposalStale: snapshot.stale,
    error,
    ...actions,
    pendingGuard: guard.pendingGuard,
    confirmGuard: guard.confirmGuard,
    autoApprove,
    setAutoApprove,
    conflict,
    takeover,
  };
}
