import { externalToolSchemas } from './external-tool-schemas';
import type { ExternalEditSessionTerminalStatus } from './external-edit-session';
import type { BrowserProjectOwnership } from '../persist/projectStoreTransport';

const EDITOR_REGISTRATION_CAPABILITY_HEADER = 'X-OpenChatCut-Editor-Registration';

export interface MultiWindowConflictInfo {
  code: 'MULTI_WINDOW_CONFLICT' | 'OWNERSHIP_TAKEN_OVER';
  holderClientKind?: 'desktop' | 'browser' | null;
  message: string;
}

const readOnlyProjects = new Set<string>();
const readOnlyListeners = new Set<() => void>();

export function setExternalBridgeReadOnly(projectId: string, readOnly: boolean): void {
  const had = readOnlyProjects.has(projectId);
  if (had === readOnly) return;
  if (readOnly) readOnlyProjects.add(projectId);
  else readOnlyProjects.delete(projectId);
  for (const listener of readOnlyListeners) listener();
}

export function isExternalBridgeReadOnly(projectId: string): boolean {
  return readOnlyProjects.has(projectId);
}

export function subscribeExternalBridgeReadOnly(listener: () => void): () => void {
  readOnlyListeners.add(listener);
  return () => readOnlyListeners.delete(listener);
}

export function editorTabIdentity(): { tabId: string; clientKind: 'desktop' | 'browser' } {
  const clientKind: 'desktop' | 'browser' =
    typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
      ? 'desktop'
      : 'browser';
  let tabId = '';
  try {
    const key = 'zuoren:editorTabId';
    tabId = window.sessionStorage.getItem(key) ?? '';
    if (!tabId) {
      tabId = crypto.randomUUID();
      window.sessionStorage.setItem(key, tabId);
    }
  } catch {
    tabId = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `tab_${Date.now()}`;
  }
  return { tabId, clientKind };
}

export class EditorBridgeRequestError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly code?: string;
  readonly holderClientKind?: 'desktop' | 'browser' | null;

  constructor(
    operation: string,
    status: number,
    code?: string,
    holderClientKind?: 'desktop' | 'browser' | null,
    serverMessage?: string,
  ) {
    super(serverMessage || `${operation} failed: HTTP ${status}`);
    this.name = 'EditorBridgeRequestError';
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.holderClientKind = holderClientKind;
  }
}

export function editorBridgeHeaders(
  json = false,
  registrationCapability?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (registrationCapability) {
    headers[EDITOR_REGISTRATION_CAPABILITY_HEADER] = registrationCapability;
  }
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export async function sendEditorBridgeResult(
  id: string,
  outcome: ExternalEditSessionTerminalStatus,
  value: unknown,
  signal: AbortSignal,
  registrationCapability: string,
  baseRevision?: string,
): Promise<void> {
  const response = await fetch('/api/external-agent/result', {
    method: 'POST',
    headers: editorBridgeHeaders(true, registrationCapability),
    body: JSON.stringify({ id, outcome, value, ...(baseRevision ? { baseRevision } : {}) }),
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw new EditorBridgeRequestError('result', response.status);
  }
}

export async function unregisterEditorBridge(
  projectId: string,
  editorInstanceId: string,
  registrationCapability?: string,
): Promise<void> {
  if (!registrationCapability) return;
  await fetch('/api/external-agent/unregister', {
    method: 'POST',
    headers: editorBridgeHeaders(true, registrationCapability),
    body: JSON.stringify({ projectId, editorId: editorInstanceId }),
    keepalive: true,
  }).catch(() => undefined);
}

export async function registerEditorBridge(
  projectId: string,
  editorInstanceId: string,
  baseRevision: string,
  signal: AbortSignal,
  registrationCapability?: string,
  options?: { forceTakeover?: boolean },
): Promise<BrowserProjectOwnership> {
  const identity = editorTabIdentity();
  const response = await fetch('/api/external-agent/register', {
    method: 'POST',
    headers: editorBridgeHeaders(true, registrationCapability),
    body: JSON.stringify({
      projectId,
      editorId: editorInstanceId,
      baseRevision,
      tools: externalToolSchemas(),
      tabId: identity.tabId,
      clientKind: identity.clientKind,
      ...(options?.forceTakeover ? { forceTakeover: true } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    let body: { code?: string; holderClientKind?: 'desktop' | 'browser' | null; error?: string } | undefined;
    try {
      body = await response.json() as typeof body;
    } catch {
      body = undefined;
    }
    throw new EditorBridgeRequestError(
      'registration',
      response.status,
      body?.code,
      body?.holderClientKind,
      body?.error,
    );
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('invalid editor registration response');
  const registration = value as Partial<{
    ok: boolean;
    ownershipEpoch: number;
    registrationCapability: string;
  }>;
  if (registration.ok !== true || typeof registration.ownershipEpoch !== 'number'
    || !Number.isSafeInteger(registration.ownershipEpoch) || registration.ownershipEpoch < 1
    || typeof registration.registrationCapability !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(registration.registrationCapability)) {
    throw new Error('invalid editor registration response');
  }
  return {
    projectId,
    ownerId: editorInstanceId,
    epoch: registration.ownershipEpoch,
    baseRevision,
    registrationCapability: registration.registrationCapability,
  };
}
