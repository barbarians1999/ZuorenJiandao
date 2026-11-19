// Test-host protection, not a claim to diagnose an OS freeze or a memory peak.
// A screenshot failure is not proof of host OOM: Remotion also maps an
// unavailable GPU surface to its generic memory/disk error. Halt heavy routes
// for investigation rather than launching the next route after such a failure.
export function renderFailureStopReason(message) {
  const value = String(message);
  if (/resource guard|Invalid .* sample|worker cleanup|cancel|abort|timeout/i.test(value)) return 'guard-cancel-timeout';
  if (/out of memory|ran out of memory or disk space|unable to capture screenshot|could not take a screenshot|gpu process.*crash|webgl context.*lost/i.test(value)) {
    return 'renderer-resource-or-graphics';
  }
  return null;
}

export async function withResourceGuard({
  sample, run, onSample = () => {}, signal,
  minimumFreeMemoryBytes = 2 * 1024 ** 3,
  enforceMemoryLimit = true,
  minimumFreeDiskBytes = 2 * 1024 ** 3,
  intervalMs = 5000,
}) {
  if (typeof enforceMemoryLimit !== 'boolean') throw new Error('Invalid memory protection setting');
  for (const value of [minimumFreeMemoryBytes, minimumFreeDiskBytes, intervalMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid resource guard threshold');
  }
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let active = true, pending;
  const poll = async () => {
    try {
      const measured = await sample();
      if (!active) return;
      for (const key of ['freeMemoryBytes', 'freeDiskBytes']) {
        if (!Number.isFinite(measured[key]) || measured[key] < 0) throw new Error(`Invalid ${key} sample`);
      }
      await onSample({ at: new Date().toISOString(), ...measured });
      if ((enforceMemoryLimit && measured.freeMemoryBytes < minimumFreeMemoryBytes) || measured.freeDiskBytes < minimumFreeDiskBytes) {
        throw new Error(`Benchmark resource guard stopped rendering: free RAM ${measured.freeMemoryBytes} bytes; free disk ${measured.freeDiskBytes} bytes`);
      }
    } catch (error) {
      if (active && !controller.signal.aborted) controller.abort(new Error(
        `Benchmark resource guard: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  };
  combined.throwIfAborted();
  await poll();
  combined.throwIfAborted();
  const timer = setInterval(() => {
    if (!pending && !combined.aborted) pending = poll().finally(() => { pending = undefined; });
  }, intervalMs);
  try {
    const result = await run(combined);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    combined.throwIfAborted();
    throw error;
  } finally {
    active = false;
    clearInterval(timer);
    await pending;
  }
}
