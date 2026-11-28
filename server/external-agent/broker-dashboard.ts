interface PollWaiter {
  clientId: string;
  wake: () => void;
  evict: () => void;
}

const DASHBOARD_ONLINE_MS = 15_000;

const dashboards = new Map<string, { lastSeen: number; clientKind: string }>();
const openQueue: string[] = [];
const pollWaiters = new Set<PollWaiter>();

function pruneDashboards(now = Date.now()): void {
  for (const [id, info] of dashboards.entries()) {
    if (now - info.lastSeen >= DASHBOARD_ONLINE_MS) dashboards.delete(id);
  }
}

export function hasConnectedDashboard(now = Date.now()): boolean {
  pruneDashboards(now);
  return dashboards.size > 0;
}

export function requestDashboardOpenProject(projectId: string): boolean {
  if (!hasConnectedDashboard()) return false;
  if (!openQueue.includes(projectId)) openQueue.push(projectId);
  const waiters = [...pollWaiters];
  pollWaiters.clear();
  for (const waiter of waiters) waiter.wake();
  return true;
}

export async function waitForDashboardOpenRequest(
  clientId: string,
  clientKind = 'browser',
  signal?: AbortSignal,
): Promise<string | null> {
  const cleanId = clientId.trim();
  if (cleanId) {
    dashboards.set(cleanId, { lastSeen: Date.now(), clientKind });
    // Evict any superseded poll from the same tab (e.g., React StrictMode remount)
    // without letting it consume openQueue entries.
    for (const existing of [...pollWaiters]) {
      if (existing.clientId === cleanId) existing.evict();
    }
  }
  const immediate = openQueue.shift();
  if (immediate) return immediate;
  if (signal?.aborted) return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const cleanup = () => {
      pollWaiters.delete(waiter);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const next = openQueue.shift() ?? null;
      if (cleanId) dashboards.set(cleanId, { lastSeen: Date.now(), clientKind });
      resolve(next);
    };
    const evict = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    const onAbort = () => evict();
    const waiter: PollWaiter = { clientId: cleanId, wake: finish, evict };
    pollWaiters.add(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function clearDashboardState(): void {
  dashboards.clear();
  openQueue.length = 0;
  for (const waiter of [...pollWaiters]) waiter.evict();
  pollWaiters.clear();
}
