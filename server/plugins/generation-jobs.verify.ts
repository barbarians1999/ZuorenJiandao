import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  cleanupGenerationJobsFixture,
  setupGenerationJobsFixture,
} from './generation-jobs.verify-fixtures.ts';
import {
  verifyExportJobResultNames,
  verifyFailedAndResumableGenerationJobs,
  verifyMurekaAudioUrls,
  verifyRestoredGenerationJobs,
  verifySuccessfulGenerationJobs,
  verifyTaskLimitedGenerationJobs,
} from './generation-jobs.verify-groups.ts';

// This verifier exercises the JSON-file persistence path and runs against the
// real HOME; force the SQLite backend off so a migrated machine cannot change
// its semantics (sqliteStoreEnabled: explicit env != '1' disables).
process.env.OPENCHATCUT_SQLITE_STORE = '0';

const fixture = await setupGenerationJobsFixture();

// This verify controls the persisted store before intentionally crossing the module-load boundary.
const generationJobs = await import('./generation-jobs.ts');
const exportRuntime = await import('./export-runtime.ts');
const music = await import('./music.ts');

generationJobs.acquireGenerationJobStoreLease();
const acquireLease = "import { acquireGenerationJobStoreLease, releaseGenerationJobStoreLease } from './server/plugins/generation-job-store.ts'; acquireGenerationJobStoreLease();";
const probeLease = (env: NodeJS.ProcessEnv, source = acquireLease) => {
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', source,
  ], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5_000 });
  if (child.error) throw child.error;
  return child;
};
const conflictProbes = [
  ['same generation JSON path', process.env],
  ['different generation JSON override but same SQLite root', {
    ...process.env,
    OPENCHATCUT_GENERATION_JOB_STORE: join(fixture.storeRoot, 'alternate-operations.json'),
  }],
  ['same root reached through a normalized JSON path', {
    ...process.env,
    OPENCHATCUT_GENERATION_JOB_STORE: join(fixture.storeRoot, 'nested', '..', 'operations.json'),
  }],
  ['different profile id with the same data directory', {
    ...process.env,
    OPENCHATCUT_DEV_PROFILE_ID: '44444444-4444-4444-8444-444444444444',
  }],
];
for (const [label, env] of conflictProbes) {
  const conflict = probeLease(env);
  assert.notEqual(conflict.status, 0, `${label} must share at least one writer lock`);
  assert.match(conflict.stderr, /Another desktop or development server is using generation jobs/);
}

const aliasParent = await mkdtemp(join(tmpdir(), 'openchatcut-generation-jobs-alias-'));
const aliasRoot = join(aliasParent, 'root-alias');
try {
  await symlink(fixture.storeRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasConflict = probeLease({
    ...process.env,
    OPENCHATCUT_GENERATION_JOB_STORE: join(aliasRoot, 'operations.json'),
  });
  assert.notEqual(aliasConflict.status, 0, 'realpath aliases of the configured JSON store must share the lock');
  assert.match(aliasConflict.stderr, /Another desktop or development server is using generation jobs/);
} finally {
  await rm(aliasParent, { recursive: true, force: true });
}

const independentRoot = join(fixture.storeRoot, 'independent-root');
const independent = probeLease({
  ...process.env,
  OPENCHATCUT_DATA_DIR: independentRoot,
  OPENCHATCUT_GENERATION_JOB_STORE: join(independentRoot, 'operations.json'),
}, `${acquireLease} releaseGenerationJobStoreLease();`);
assert.equal(independent.status, 0, `different storage roots must remain independent: ${independent.stderr}`);

const corruptRoot = join(fixture.storeRoot, 'corrupt-lock-root');
const corruptStorePath = join(corruptRoot, 'operations.json');
await mkdir(corruptRoot);
await writeFile(`${corruptStorePath}.lease.sqlite3`, 'not a SQLite database');
const corruptLock = probeLease({
  ...process.env,
  OPENCHATCUT_DATA_DIR: corruptRoot,
  OPENCHATCUT_GENERATION_JOB_STORE: corruptStorePath,
});
assert.notEqual(corruptLock.status, 0);
assert.match(corruptLock.stderr, /Could not acquire generation-job lock for .*operations\.json/);
assert.doesNotMatch(corruptLock.stderr, /Another desktop or development server is using generation jobs/,
  'corruption is reported as its storage error, not an instance conflict');

const migrationProbeSource = `
  import { existsSync } from 'node:fs';
  import { initializeSqliteProjectStore, sqliteMigrationStatus, storePath } from './server/storage/sqlite-store.ts';
  import './server/plugins/generation-job-store.ts';
  try { await initializeSqliteProjectStore(); console.log(JSON.stringify({ kind: 'returned', status: sqliteMigrationStatus(), databaseExists: existsSync(storePath()) })); }
  catch (error) { const status = sqliteMigrationStatus(); console.log(JSON.stringify({ kind: 'threw', code: error.code, phase: status.phase, receipt: status.receipt, databaseExists: existsSync(storePath()) })); }
`;
const migrationConflict = probeLease({ ...process.env, OPENCHATCUT_SQLITE_STORE: '1' }, migrationProbeSource);
assert.equal(migrationConflict.status, 0, migrationConflict.stderr);
const blockedMigration = JSON.parse(migrationConflict.stdout.trim().split(/\r?\n/).at(-1)!) as {
  kind: string; code: string; phase: string; receipt: unknown; databaseExists: boolean;
};
assert.equal(blockedMigration.kind, 'threw', 'migration lock conflict must propagate beyond startup fail-open');
assert.equal(blockedMigration.code, 'GENERATION_JOB_STORE_LOCK_CONFLICT');
assert.equal(blockedMigration.phase, 'failed');
assert.equal(blockedMigration.receipt, null);
assert.equal(blockedMigration.databaseExists, false, 'migration must not create SQLite authority while jobs are locked');

verifyExportJobResultNames(fixture, exportRuntime);
await verifyRestoredGenerationJobs(fixture, generationJobs, exportRuntime);
await verifySuccessfulGenerationJobs(fixture, generationJobs, exportRuntime);
await verifyFailedAndResumableGenerationJobs(fixture, generationJobs);
await verifyTaskLimitedGenerationJobs(generationJobs);
verifyMurekaAudioUrls(music);

generationJobs.releaseGenerationJobStoreLease();
const legacyPortableLock = new DatabaseSync(`${fixture.storePath}.lease.sqlite3`);
legacyPortableLock.exec('PRAGMA busy_timeout = 250;');
legacyPortableLock.exec(`CREATE TABLE IF NOT EXISTS generation_job_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1), process_id INTEGER NOT NULL, acquired_at INTEGER NOT NULL
);`);
legacyPortableLock.exec('BEGIN IMMEDIATE;');
try {
  const legacyConflict = probeLease({
    ...process.env,
    OPENCHATCUT_DATA_DIR: join(fixture.storeRoot, 'new-sqlite-root'),
    OPENCHATCUT_GENERATION_JOB_STORE: fixture.storePath,
  });
  assert.notEqual(legacyConflict.status, 0, 'new services must honor the portable generation JSON lease path');
  assert.match(legacyConflict.stderr, /Another desktop or development server is using generation jobs/);
} finally {
  legacyPortableLock.exec('ROLLBACK;');
  legacyPortableLock.close();
}
const afterRelease = probeLease(process.env, `${acquireLease} releaseGenerationJobStoreLease();`);
assert.equal(afterRelease.status, 0, `another process can acquire the released generation-job store: ${afterRelease.stderr}`);
const migrationAfterRelease = probeLease({ ...process.env, OPENCHATCUT_SQLITE_STORE: '1' }, migrationProbeSource);
assert.equal(migrationAfterRelease.status, 0, `migration can proceed after release: ${migrationAfterRelease.stderr}`);
const migrated = JSON.parse(migrationAfterRelease.stdout.trim().split(/\r?\n/).at(-1)!) as {
  kind: string; status: { phase: string; receipt: unknown }; databaseExists: boolean;
};
assert.equal(migrated.kind, 'returned');
assert.equal(migrated.status.phase, 'complete');
assert.ok(migrated.status.receipt, 'released generation jobs permit the authoritative receipt');
assert.equal(migrated.databaseExists, true);
await cleanupGenerationJobsFixture(fixture);

const { renameWithRetry } = await import('./project-store-durable.ts');
if (process.platform === 'win32') {
  let attempts = 0;
  await renameWithRetry('src.tmp', 'dst.json', async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('transient lock'), { code: 'EPERM' });
  });
  assert.equal(attempts, 2, 'renameWithRetry retries transient Win32 EPERM errors');
}

console.log('generation checks passed');
