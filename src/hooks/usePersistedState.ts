import { useEffect, useRef, useState } from 'react';

// useState backed by localStorage: reads the saved value on init, writes on
// change. Errors (private mode / quota / bad JSON) fall back to `initial`.
export function usePersistedState<T>(
  key: string,
  initial: T,
  options?: { writeDebounceMs?: number },
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const writeDebounceMs = options?.writeDebounceMs ?? 0;
  const latestRef = useRef({ key, value });
  latestRef.current = { key, value };
  const dirtyRef = useRef(false);

  useEffect(() => {
    const persist = (targetKey: string, targetValue: T) => {
      try {
        localStorage.setItem(targetKey, JSON.stringify(targetValue));
      } catch {
        /* ignore storage errors */
      }
      dirtyRef.current = false;
    };
    if (writeDebounceMs <= 0) {
      persist(key, value);
      return undefined;
    }
    dirtyRef.current = true;
    const timer = window.setTimeout(() => persist(key, value), writeDebounceMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [key, value, writeDebounceMs]);

  useEffect(() => () => {
    if (!dirtyRef.current) return;
    try {
      localStorage.setItem(latestRef.current.key, JSON.stringify(latestRef.current.value));
    } catch {
      /* ignore storage errors */
    }
  }, []);

  return [value, setValue];
}
