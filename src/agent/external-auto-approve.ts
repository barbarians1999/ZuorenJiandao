import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'cc.externalAutoApprove';
const listeners = new Set<() => void>();
let currentValue: boolean | null = null;
let storageListenerAttached = false;

function readStoredAutoApprove(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function ensureInitialized(): boolean {
  if (currentValue === null) {
    currentValue = readStoredAutoApprove();
  }
  if (!storageListenerAttached && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    storageListenerAttached = true;
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next = event.newValue === '1';
      if (currentValue === next) return;
      currentValue = next;
      for (const listener of listeners) listener();
    });
  }
  return currentValue;
}

export function getExternalAutoApprove(): boolean {
  return ensureInitialized();
}

export function setExternalAutoApprove(enabled: boolean): void {
  const next = Boolean(enabled);
  const previous = ensureInitialized();
  currentValue = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    }
  } catch {
    // Storage may be unavailable in tests or private browsing.
  }
  if (previous !== next) {
    for (const listener of listeners) listener();
  }
}

export function subscribeExternalAutoApprove(listener: () => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useExternalAutoApprove(): readonly [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeExternalAutoApprove,
    getExternalAutoApprove,
    () => false,
  );
  return [enabled, setExternalAutoApprove] as const;
}
