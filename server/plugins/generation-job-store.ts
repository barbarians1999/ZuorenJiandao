import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { runtimeProfile } from '../runtime-profile.ts';
import { renameWithRetry } from './project-store-durable.ts';
import {
  initializeSqliteProjectStore,
  registerStorageMigrationBarrier,
  sqliteReadEntry,
  sqliteStoreEnabled,
  storePath as sqliteProjectStorePath,
  sqliteWriteEntry,
} from '../storage/sqlite-store.ts';
import { GENERATION_JOBS_KV_KEY } from '../storage/sqlite-migration.ts';
import {
  TERMINAL,
  acceptanceOf,
  makeAcceptanceWaiter,
  mergeGenerationResultUrls,
  snapshotOf,
} from './generation-job-types.ts';
import type {
  GenerationCleanupPolicy,
  GenerationCleanupPolicyHandler,
  GenerationJob,
  GenerationJobResumer,
  GenerationJobSnapshot,
  GenerationOperationTimestamps,
  GenerationRetentionGuard,
} from './generation-job-types.ts';

export const jobs = new Map<string, GenerationJob>();
export const resumers = new Map<string, GenerationJobResumer>();
const cleanupPolicyHandlers = new Map<string, GenerationCleanupPolicyHandler>();
const retentionGuards = new Map<string, GenerationRetentionGuard>();
const MAX_JOB_AGE_MS = 60 * 60_000;
const STORE_PATH = runtimeProfile().generationJobStore;
let persistenceHydrated = false;
let persistenceQueue: Promise<void> = Promise.resolve();
let persistenceMigrationGate: Promise<void> | null = null;
const GENERATION_JOB_LEASE_REGISTRY = Symbol.for('openchatcut.generation-job-store-leases');
type GenerationLeaseRegistryHost = { [key: symbol]: Map<string, DatabaseSync[]> | undefined };
const registryHost = globalThis as unknown as GenerationLeaseRegistryHost;
const generationLeaseRegistry = registryHost[GENERATION_JOB_LEASE_REGISTRY]
  ?? (registryHost[GENERATION_JOB_LEASE_REGISTRY] = new Map<string, DatabaseSync[]>());
let generationJobsLeaseKey: string | null = null;

function canonicalStorePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot resolve generation-job store path ${absolute}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    try {
      const parent = dirname(absolute);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      return resolve(realpathSync.native(parent), basename(absolute));
    } catch (parentError) {
      throw new Error(`Cannot resolve generation-job store path ${absolute}: ${parentError instanceof Error ? parentError.message : String(parentError)}`, { cause: parentError });
    }
  }
}

function generationStoreLockTargets(): Array<{ identity: string; target: string; lockPath: string }> {
  const jsonStore = canonicalStorePath(STORE_PATH);
  const sqliteStore = canonicalStorePath(sqliteProjectStorePath());
  const candidates = [
    { target: jsonStore, lockPath: `${STORE_PATH}.lease.sqlite3` },
    { target: sqliteStore, lockPath: `${sqliteStore}.generation-job-lease.sqlite3` },
  ];
  const byIdentity = new Map<string, { identity: string; target: string; lockPath: string }>();
  for (const candidate of candidates) {
    const canonicalLock = canonicalStorePath(candidate.lockPath);
    const identity = process.platform === 'win32' ? canonicalLock.toLowerCase() : canonicalLock;
    if (!byIdentity.has(identity)) byIdentity.set(identity, { ...candidate, identity });
  }
  return [...byIdentity.values()].sort((a, b) => a.identity.localeCompare(b.identity));
}

function lockKey(targets = generationStoreLockTargets()): string {
  return targets.map(({ identity }) => identity).join('\n');
}

function isSqliteBusyOrLocked(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: unknown; errcode?: unknown; errno?: unknown; message?: unknown };
  const code = String(detail.code ?? '').toUpperCase();
  const sqliteCode = Number(detail.errcode ?? detail.errno);
  const primaryCode = Number.isInteger(sqliteCode) ? sqliteCode & 0xff : -1;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || primaryCode === 5 || primaryCode === 6
    || /^(?:database|table) is (?:locked|busy)$/i.test(String(detail.message ?? '').trim());
}

function closeLeaseDatabases(databases: readonly DatabaseSync[]): void {
  for (const database of [...databases].reverse()) {
    try { database.exec('ROLLBACK;'); } catch { /* no transaction remains */ }
    try { database.close(); } catch { /* closing all partial locks is best effort */ }
  }
}

export class GenerationJobStoreLockConflictError extends Error {
  readonly code = 'GENERATION_JOB_STORE_LOCK_CONFLICT';

  constructor(target: string, cause: unknown) {
    super(`Another desktop or development server is using generation jobs for ${target}. Close it before starting another instance.`, { cause });
    this.name = 'GenerationJobStoreLockConflictError';
  }
}

/** Lock both identities because JSON and SQLite deployments share generation snapshots through either path. */
export function acquireGenerationJobStoreLease(): void {
  if (generationJobsLeaseKey && generationLeaseRegistry.has(generationJobsLeaseKey)) return;
  const targets = generationStoreLockTargets();
  const key = lockKey(targets);
  if (generationLeaseRegistry.has(key)) {
    generationJobsLeaseKey = key;
    return;
  }
  const acquired: DatabaseSync[] = [];
  let current: { target: string; lockPath: string } | undefined;
  try {
    for (const next of targets) {
      current = next;
      mkdirSync(dirname(next.lockPath), { recursive: true, mode: 0o700 });
      const database = new DatabaseSync(next.lockPath);
      try {
        database.exec('PRAGMA busy_timeout = 250;');
        database.exec(`CREATE TABLE IF NOT EXISTS generation_job_lease (
          id INTEGER PRIMARY KEY CHECK (id = 1), process_id INTEGER NOT NULL, acquired_at INTEGER NOT NULL
        );`);
        database.exec('BEGIN IMMEDIATE;');
        database.prepare(`INSERT INTO generation_job_lease (id, process_id, acquired_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET process_id = excluded.process_id, acquired_at = excluded.acquired_at`)
          .run(process.pid, Date.now());
        acquired.push(database);
      } catch (error) {
        closeLeaseDatabases([database]);
        throw error;
      }
    }
    generationLeaseRegistry.set(key, acquired);
    generationJobsLeaseKey = key;
  } catch (error) {
    closeLeaseDatabases(acquired);
    const reason = error instanceof Error ? error.message : String(error);
    if (isSqliteBusyOrLocked(error)) {
      throw new GenerationJobStoreLockConflictError(current?.target ?? STORE_PATH, error);
    }
    throw new Error(`Could not acquire generation-job lock for ${current?.target ?? STORE_PATH} (${current?.lockPath ?? 'lock path unavailable'}): ${reason}`, { cause: error });
  }
}

/** Verifiers release the lease before removing their temporary storage root. */
export function releaseGenerationJobStoreLease(): void {
  const key = generationJobsLeaseKey ?? lockKey();
  generationJobsLeaseKey = null;
  const leases = generationLeaseRegistry.get(key);
  if (!leases) return;
  generationLeaseRegistry.delete(key);
  closeLeaseDatabases(leases);
}

registerStorageMigrationBarrier(async () => {
  acquireGenerationJobStoreLease();
  // Before hydration, only drain existing writes: writing the empty in-memory
  // map would destroy the configured legacy ledger before it is imported.
  // Once hydrated, persist the current in-memory snapshot as the migration
  // boundary, then wait until no later queued write exists.
  if (persistenceHydrated) await persistJobs();
  let observed: Promise<void>;
  do {
    observed = persistenceQueue;
    await observed;
  } while (observed !== persistenceQueue);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  persistenceMigrationGate = gate;
  return () => {
    if (persistenceMigrationGate === gate) persistenceMigrationGate = null;
    release();
  };
});

export function resumerKey(toolName?: string, provider?: string): string {
  return `${toolName ?? ''}:${provider ?? ''}`;
}

export function registerGenerationJobResumer(toolName: string, provider: string, resumer: GenerationJobResumer): void {
  resumers.set(resumerKey(toolName, provider), resumer);
}

export function registerGenerationCleanupPolicy(
  policy: GenerationCleanupPolicy,
  handler: GenerationCleanupPolicyHandler,
): void {
  cleanupPolicyHandlers.set(policy, handler);
}

export function registerGenerationRetentionGuard(
  policy: GenerationCleanupPolicy,
  guard: GenerationRetentionGuard,
): void {
  retentionGuards.set(policy, guard);
}


function persistedRows(): GenerationJobSnapshot[] {
  return [...jobs.values()].map(snapshotOf);
}

export function persistJobs(): Promise<void> {
  acquireGenerationJobStoreLease();
  const write = persistenceQueue.catch(() => undefined).then(async () => {
    const migrationGate = persistenceMigrationGate;
    if (migrationGate) await migrationGate;
    if (sqliteStoreEnabled()) {
      // SQLite backend: the whole jobs snapshot lives under one kv key.
      await sqliteWriteEntry(GENERATION_JOBS_KV_KEY, { version: 1, jobs: persistedRows() });
      return;
    }
    await mkdir(dirname(STORE_PATH), { recursive: true });
    const temporary = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, jobs: persistedRows() }), 'utf8');
      await renameWithRetry(temporary, STORE_PATH);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  });
  persistenceQueue = write.then(() => undefined, () => undefined);
  return write;
}

function normalizePersistedJob(value: unknown): GenerationJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<GenerationJobSnapshot>;
  if (typeof row.id !== 'string'
    || (row.status !== 'queued' && row.status !== 'running' && row.status !== 'succeeded' && row.status !== 'failed')
    || typeof row.progress !== 'number'
    || !row.params || typeof row.params !== 'object' || Array.isArray(row.params)
    || typeof row.createdAt !== 'number'
    || typeof row.updatedAt !== 'number') return null;
  const timestamps = row.timestamps && typeof row.timestamps === 'object' && !Array.isArray(row.timestamps)
    ? row.timestamps as GenerationOperationTimestamps
    : { createdAt: row.createdAt, submittedAt: row.createdAt, updatedAt: row.updatedAt };
  const restored = !TERMINAL.has(row.status);
  const cleanupPolicy = typeof row.cleanupPolicy === 'string' ? row.cleanupPolicy : undefined;
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    phase: restored ? 'recovering' : row.phase,
    processedFrames: row.processedFrames,
    totalFrames: row.totalFrames,
    params: row.params as Record<string, unknown>,
    submitArgs: row.submitArgs,
    toolName: row.toolName,
    label: row.label,
    provider: row.provider,
    providerTaskId: row.providerTaskId,
    sourceRevisions: row.sourceRevisions,
    resultUrls: mergeGenerationResultUrls([], Array.isArray(row.resultUrls) ? row.resultUrls : []),
    expectedResultCount: Number.isSafeInteger(row.expectedResultCount) && Number(row.expectedResultCount) > 0
      ? Number(row.expectedResultCount)
      : undefined,
    retryClass: restored ? 'restart-recoverable' : row.retryClass ?? 'none',
    timestamps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    result: row.result,
    results: row.results,
    error: row.error,
    code: row.code,
    retryable: row.retryable,
    cleanupPolicy,
    pendingDownloadUrl: row.pendingDownloadUrl,
    retentionMs: normalizeRetentionMs(undefined, cleanupPolicy),
    acceptance: makeAcceptanceWaiter(),
    restored,
  };
}

export async function loadPersistedJobs(): Promise<void> {
  acquireGenerationJobStoreLease();
  await initializeSqliteProjectStore();
  let parsed: { version?: unknown; jobs?: unknown } | null = null;
  if (sqliteStoreEnabled()) {
    const row = await sqliteReadEntry(GENERATION_JOBS_KV_KEY);
    if (row.found && row.value && typeof row.value === 'object') {
      parsed = row.value as { version?: unknown; jobs?: unknown };
    }
  } else {
    try {
      parsed = JSON.parse(await readFile(STORE_PATH, 'utf8')) as { version?: unknown; jobs?: unknown };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
    persistenceHydrated = true;
    return;
  }
  for (const value of parsed.jobs) {
    const job = normalizePersistedJob(value);
    if (!job || jobs.has(job.id)) continue;
    jobs.set(job.id, job);
    if (job.timestamps.acceptedAt) job.acceptance?.resolve(acceptanceOf(job));
    if (TERMINAL.has(job.status)) scheduleExpiry(job);
  }
  persistenceHydrated = true;
}

export function normalizeRetentionMs(value: number | undefined, cleanupPolicy?: string): number {
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (Number.isFinite(value) && Number(value) >= 0) return Number(value);
  return cleanupPolicy === 'server-export' ? Number.POSITIVE_INFINITY : MAX_JOB_AGE_MS;
}

export function scheduleExpiry(job: GenerationJob, retryMs?: number): void {
  if (!TERMINAL.has(job.status)) return;
  clearTimeout(job.expiryTimer);
  if (retryMs === undefined && !Number.isFinite(job.retentionMs)) return;
  const remaining = retryMs ?? Math.max(0, job.retentionMs - (Date.now() - job.updatedAt));
  job.expiryTimer = setTimeout(() => { void evictTerminalJob(job.id, true); }, remaining);
  job.expiryTimer.unref?.();
}

async function retentionBlocked(job: GenerationJob): Promise<boolean> {
  const guard = job.cleanupPolicy ? retentionGuards.get(job.cleanupPolicy) : undefined;
  if (!guard) return false;
  try {
    return await guard(job.id);
  } catch (error) {
    console.warn(`[generation-job] retention guard failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

export async function evictTerminalJob(jobId: string, retentionExpiry = false): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job || !TERMINAL.has(job.status)) return false;
  const cleanup = job.cleanupPolicy
    ? cleanupPolicyHandlers.get(job.cleanupPolicy)
    : job.cleanupResult;
  if (job.cleanupPolicy && !cleanup) {
    console.warn(`[generation-job] refusing to evict ${jobId}: unknown cleanup policy ${job.cleanupPolicy}`);
    return false;
  }
  if (await retentionBlocked(job)) {
    if (retentionExpiry) scheduleExpiry(job, 60_000);
    return false;
  }
  if (job.results?.length && cleanup) {
    try {
      await Promise.all(job.results.map((result) => cleanup(result)));
    } catch (error) {
      console.warn(`[generation-job] failed to clean result for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  jobs.delete(jobId);
  clearTimeout(job.expiryTimer);
  try {
    await persistJobs();
  } catch (error) {
    jobs.set(jobId, job);
    if (retentionExpiry) scheduleExpiry(job, 60_000);
    throw error;
  }
  return true;
}

export async function cleanOldJobs(): Promise<void> {
  const now = Date.now();
  const expired = [...jobs.values()].filter((job) => (
    TERMINAL.has(job.status)
    && Number.isFinite(job.retentionMs)
    && now - job.updatedAt > job.retentionMs
  ));
  await Promise.all(expired.map((job) => evictTerminalJob(job.id, true)));
}
