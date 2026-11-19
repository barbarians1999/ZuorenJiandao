// 素材清理纯逻辑检查:引用做差、级联删的独占判定语义(经内存态 projectStore 走真流程)。
// 跑法:npx tsx src/persist/mediaCleanup.check.ts(已挂 verify:persist,随 pretest 执行)。
import assert from 'node:assert/strict';
import { collectAllUploadRefs, orphanDocIdsToPurge, scanUnreferenced, unreferencedOf } from './mediaCleanup';
import { configureSharedKvBackend, kvDel, kvGet, kvSet, type SharedKvBackend } from './sharedKv';
import { listPacks } from '../plugins/store';
import { createProject, listProjectDocIds, purgeProject } from './projectStore';
import type { ProjectDoc } from '../editor/types';

// ── unreferencedOf:盘面 − 引用 ──────────────────────────────────────────
{
  const files = [
    { name: 'a.mp4', bytes: 10, mtimeMs: 1 },
    { name: '李白_01_开篇.mp3', bytes: 20, mtimeMs: 2 },
    { name: 'kept.png', bytes: 30, mtimeMs: 3 },
  ];
  const refs = new Set(['/media/uploads/kept.png']);
  const orphans = unreferencedOf(files, refs);
  assert.deepEqual(orphans.map((f) => f.name), ['a.mp4', '李白_01_开篇.mp3'], '引用的不进无主清单(中文名照常)');
  console.log('unreferencedOf: OK');
}

// ── orphanDocIdsToPurge:索引健康守卫 ────────────────────────────────────
{
  assert.deepEqual(orphanDocIdsToPurge(new Set(['a']), ['a', 'b']), ['b'], '不在索引中的文档是孤儿');
  assert.deepEqual(orphanDocIdsToPurge(new Set(['a']), ['a']), [], '索引齐全时无孤儿');
  assert.deepEqual(orphanDocIdsToPurge(new Set(), []), [], '空库无事发生');
  assert.deepEqual(orphanDocIdsToPurge(new Set(), ['a', 'b']), [],
    '索引为空但文档存在 = 索引丢失/不可读,禁止把全部工程当孤儿清除');
  console.log('orphanDocIdsToPurge: OK');
}

// ── 引用并集 + 独占判定(内存态 projectStore) ────────────────────────────
{
  const doc = (src: string): ProjectDoc => ({
    version: 3,
    assets: [{ id: 'a1', name: 'x', kind: 'video', src, durationInFrames: 30 }],
    mediaFolders: [],
    timelines: [{ id: 'tl1', name: '序列 1', fps: 30, width: 1920, height: 1080, selectedId: null, items: [] } as never],
    activeTimelineId: 'tl1',
  } as never);
  const shared = '/media/uploads/shared.mp4';
  const solo = '/media/uploads/solo.mp4';
  const p1 = await createProject('甲', doc(shared));
  const p2 = await createProject('乙', doc(shared));
  const p3 = await createProject('丙', doc(solo));

  let refs = await collectAllUploadRefs();
  assert.ok(refs.has(shared) && refs.has(solo), '并集含全部引用');

  // 排除 p3 后 solo 无人引用 → 级联删应删;shared 因 p2 仍在 → 保
  refs = await collectAllUploadRefs(p3.id);
  assert.ok(!refs.has(solo) && refs.has(shared), '排除自身后:独占的裸奔,共享的仍被护住');

  // 删掉 p1 后 shared 仍被 p2 引用
  await purgeProject(p1.id);
  refs = await collectAllUploadRefs();
  assert.ok(refs.has(shared), '复制体在,共享素材引用不丢');

  for (const m of [p2, p3]) await purgeProject(m.id);
  assert.equal((await listProjectDocIds()).length, 0, 'purge 后文档清零');
  console.log('collectAllUploadRefs/级联语义: OK');
}

console.log('\nmediaCleanup.check: ALL PASSED');

// A missing index entry is recoverable data, not permission for scan-time deletion.
{
  const originalFetch = globalThis.fetch;
  const retained = { assets: [{ src: '/media/uploads/recoverable.mp4' }] };
  await kvSet('project:unindexed-recovery', retained);
  await kvSet('versions:unindexed-recovery', [{ doc: { assets: [{ src: '/media/uploads/old-version.mp4' }] } }]);
  globalThis.fetch = (async () => Response.json({ files: [
    { name: 'recoverable.mp4', bytes: 10, mtimeMs: 1 },
    { name: 'old-version.mp4', bytes: 10, mtimeMs: 1 },
  ] })) as typeof fetch;
  try {
    const scan = await scanUnreferenced();
    assert.equal(scan.orphanDocsPurged, 0);
    assert.deepEqual(scan.sourceCandidates, [], 'orphan documents and version media remain protected');
    assert.deepEqual(await kvGet('project:unindexed-recovery'), retained, 'scanning never removes project data');
  } finally { globalThis.fetch = originalFetch; }
}

// A storage error must stop cleanup instead of returning every upload as unreferenced.
{
  const failing = {
    keys: async () => { throw new Error('inventory unavailable'); },
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    writeAgentRuntime: async () => { throw new Error('unused'); },
    updateAgentRunLease: async () => { throw new Error('unused'); },
  } satisfies SharedKvBackend;
  configureSharedKvBackend(failing);
  try { await assert.rejects(collectAllUploadRefs(), /inventory unavailable/); }
  finally { configureSharedKvBackend(undefined); }
}
console.log('mediaCleanup: read-only orphan scan and incomplete inventory protection passed');

{
  const names = ['my clip.mp4', "author's.mp4", 'encoded%20name.mp4'];
  await kvSet('export-recovery:filename-test', { nested: names.map((name) => ({ src: `/media/uploads/${name}` })) });
  const refs = await collectAllUploadRefs();
  assert.deepEqual(unreferencedOf(names.map((name) => ({ name, bytes: 1, mtimeMs: 1 })), refs), []);
  assert.ok(refs.has('/media/uploads/encoded name.mp4'));
  await kvSet('project:quarantine-test', { kind: 'quarantined-project-store-entry', quarantineFile: 'preserved.json' });
  await assert.rejects(collectAllUploadRefs(), /无法安全清理/);
  await kvDel('project:quarantine-test');
}
{
  const originalFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  try {
    globalThis.fetch = (async () => { throw new TypeError('extension inventory unavailable'); }) as typeof fetch;
    await assert.rejects(listPacks({ strict: true }), /extension inventory unavailable/);
    globalThis.fetch = (async () => Response.json({ packs: [{ id: 'unknown', cubeUrls: { lut: '/media/uploads/keep.cube' } }] })) as typeof fetch;
    await assert.rejects(listPacks({ strict: true }), /Cannot verify/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}
