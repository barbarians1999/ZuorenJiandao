import { captionsOnTrack } from '../editor/timelineTypes';
import type { ProjectDoc } from '../editor/projectTypes';
import type { CaptionsData } from './types';

export interface CaptionCueDraftRecoveryValue {
  id: string;
  baseText: string;
  baseStart: number;
  baseEnd: number;
  text: string;
  start: string;
  end: string;
}

export interface PendingCaptionDraftRecovery {
  timelineId: string;
  trackId: string;
  baseSignature: string;
  targetSignature: string;
  draft: CaptionCueDraftRecoveryValue;
  patch: Partial<CaptionsData>;
}

export interface CaptionDraftRecoveryState {
  draft: CaptionCueDraftRecoveryValue | null;
  pending: PendingCaptionDraftRecovery[];
}

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const undefinedMarker = '__cc_caption_recovery_undefined__';

const isDraft = (value: unknown): value is CaptionCueDraftRecoveryValue => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.id === 'string' && typeof draft.baseText === 'string' && typeof draft.text === 'string'
    && typeof draft.start === 'string' && typeof draft.end === 'string'
    && Number.isFinite(draft.baseStart) && Number.isFinite(draft.baseEnd);
};

const isPending = (value: unknown): value is PendingCaptionDraftRecovery => {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Record<string, unknown>;
  return typeof pending.timelineId === 'string' && typeof pending.trackId === 'string'
    && typeof pending.baseSignature === 'string' && typeof pending.targetSignature === 'string'
    && isDraft(pending.draft) && !!pending.patch && typeof pending.patch === 'object';
};

export function readCaptionDraftRecovery(key: string, storage?: StorageLike): CaptionDraftRecoveryState {
  try {
    const raw = resolveStorage(storage)?.getItem(key);
    if (!raw) return { draft: null, pending: [] };
    const saved = restoreUndefined(JSON.parse(raw)) as Record<string, unknown>;
    if (saved.version === 1) return {
      draft: isDraft(saved.draft) ? saved.draft : null,
      pending: Array.isArray(saved.pending) ? saved.pending.filter(isPending) : [],
    };
    return { draft: isDraft(saved) ? saved : null, pending: [] };
  } catch { return { draft: null, pending: [] }; }
}

export function writeCaptionDraftRecovery(key: string, value: CaptionDraftRecoveryState, storage?: StorageLike): boolean {
  try {
    const target = resolveStorage(storage);
    if (!target) return false;
    if (!value.draft && !value.pending.length) target.removeItem(key);
    else target.setItem(key, JSON.stringify(encodeUndefined({ version: 1, ...value })));
    return true;
  } catch { return false; }
}

/** Stable, compact identity for a captions snapshot; JSON key order is irrelevant. */
export function captionDataSignature(value: unknown): string {
  const json = stableJson(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

/** Rebuild a sequence of edits only when each saved base matches the next patch. */
export function planPendingCaptionRecovery(
  current: CaptionsData,
  pending: readonly PendingCaptionDraftRecovery[],
): Partial<CaptionsData> | null {
  let signature = captionDataSignature(current);
  let start = -1;
  for (let index = 0; index < pending.length; index += 1) {
    if (pending[index]!.targetSignature === signature) start = index + 1;
  }
  if (start < 0) start = pending.findIndex((entry) => entry.baseSignature === signature);
  if (start < 0 || start >= pending.length) return null;

  let projected = current;
  const combined: Partial<CaptionsData> = {};
  for (const entry of pending.slice(start)) {
    if (entry.baseSignature !== captionDataSignature(projected)) return null;
    projected = { ...projected, ...entry.patch };
    if (entry.targetSignature !== captionDataSignature(projected)) return null;
    Object.assign(combined, entry.patch);
  }
  return Object.keys(combined).length ? combined : null;
}

/** Clear only edits proven present in the exact snapshot that was just saved. */
export function acknowledgeSavedCaptionDrafts(projectId: string, doc: ProjectDoc, storage?: StorageLike): string[] {
  let target = storage;
  try { target ??= typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return []; }
  if (!target) return [];
  const prefix = `cc-caption-inline:${projectId}:`;
  const changedKeys: string[] = [];
  try {
    for (let i = target.length - 1; i >= 0; i -= 1) {
      const key = target.key(i);
      if (!key?.startsWith(prefix)) continue;
      const state = readFromStorage(target, key);
      if (!state.pending.length) continue;
      let remaining = state.pending;
      for (const timeline of doc.timelines) {
        const trackId = state.pending[0]?.trackId;
        if (!trackId || !state.pending.some((entry) => entry.timelineId === timeline.id && entry.trackId === trackId)) continue;
        const signature = captionDataSignature(captionsOnTrack(timeline, trackId));
        let confirmedThrough = -1;
        for (let index = 0; index < remaining.length; index += 1) {
          const entry = remaining[index]!;
          if (entry.timelineId === timeline.id && entry.trackId === trackId && entry.targetSignature === signature) confirmedThrough = index;
        }
        if (confirmedThrough >= 0) {
          let confirmedStart = confirmedThrough;
          while (confirmedStart > 0) {
            const previous = remaining[confirmedStart - 1]!;
            const current = remaining[confirmedStart]!;
            if (previous.timelineId !== current.timelineId || previous.trackId !== current.trackId
              || previous.targetSignature !== current.baseSignature) break;
            confirmedStart -= 1;
          }
          remaining = [...remaining.slice(0, confirmedStart), ...remaining.slice(confirmedThrough + 1)];
        }
      }
      if (remaining.length === state.pending.length) continue;
      if (writeCaptionDraftRecovery(key, { draft: state.draft, pending: remaining }, target)) changedKeys.push(key);
    }
  } catch { return changedKeys; }
  if (changedKeys.length) {
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cc-caption-drafts-saved', { detail: { projectId, changedKeys } }));
    } catch { /* The on-disk project snapshot is still authoritative. */ }
  }
  return changedKeys;
}

function readFromStorage(storage: StorageLike, key: string): CaptionDraftRecoveryState {
  try {
    const raw = storage.getItem(key);
    if (!raw) return { draft: null, pending: [] };
    const saved = restoreUndefined(JSON.parse(raw)) as Record<string, unknown>;
    if (saved.version === 1) return {
      draft: isDraft(saved.draft) ? saved.draft : null,
      pending: Array.isArray(saved.pending) ? saved.pending.filter(isPending) : [],
    };
    return { draft: isDraft(saved) ? saved : null, pending: [] };
  } catch { return { draft: null, pending: [] }; }
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function encodeUndefined(value: unknown): unknown {
  if (value === undefined) return { [undefinedMarker]: true };
  if (Array.isArray(value)) return value.map(encodeUndefined);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeUndefined(item)]));
  return value;
}

function restoreUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreUndefined);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record[undefinedMarker] === true && Object.keys(record).length === 1) return undefined;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, restoreUndefined(item)]));
  }
  return value;
}
