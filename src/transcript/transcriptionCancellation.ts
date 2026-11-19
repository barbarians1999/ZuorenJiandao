/** A cancelled UI attempt must never fall through to another engine or apply late results. */
export function transcriptionCancelled(): Error {
  const error = new Error('Transcription cancelled');
  error.name = 'AbortError';
  return error;
}

export function throwIfTranscriptionCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw transcriptionCancelled();
}

export function isTranscriptionCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Reject promptly even if an underlying desktop/decode promise settles late. */
export function cancellableTranscription<T>(operation: () => Promise<T>, signal?: AbortSignal, onCancel?: () => void): Promise<T> {
  throwIfTranscriptionCancelled(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      try { onCancel?.(); } catch { /* Cancellation remains final if backend cleanup fails. */ }
      reject(transcriptionCancelled());
    };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => {
      throwIfTranscriptionCancelled(signal);
      return operation();
    }).then(
      (value) => { signal.removeEventListener('abort', cancel); if (!signal.aborted) resolve(value); },
      (error) => { signal.removeEventListener('abort', cancel); reject(signal.aborted ? transcriptionCancelled() : error); },
    );
  });
}
