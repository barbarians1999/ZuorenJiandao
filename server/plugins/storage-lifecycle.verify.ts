import assert from 'node:assert/strict';
import {
  selectMultipartGcVictims,
  type MultipartGcLimits,
  type MultipartSessionInfo,
} from './upload-multipart.ts';
import {
  previewCachePath,
  previewFingerprint,
  isPreviewDerivative,
  selectPreviewEvictions,
  type PreviewCacheEntry,
} from './media-preview.ts';

const now = 100_000;
const limits: MultipartGcLimits = {
  idleTtlMs: 10_000,
  absoluteTtlMs: 60_000,
  activeGraceMs: 1_000,
  maxSessions: 3,
  maxBytes: 100,
};
const sessions: MultipartSessionInfo[] = [
  { uploadId: 'expired1', createdAt: 1, updatedAt: 1, bytes: 40 },
  { uploadId: 'active01', createdAt: 1, updatedAt: 1, bytes: 40, active: true },
  { uploadId: 'recent01', createdAt: 1, updatedAt: now - 100, bytes: 40 },
];
const ttlVictims = selectMultipartGcVictims(sessions, limits, now);
assert.equal(ttlVictims.has('expired1'), true, 'expired inactive multipart sessions are collected');
assert.equal(ttlVictims.has('active01'), false, 'an in-flight multipart session is never collected');
assert.equal(ttlVictims.has('recent01'), false, 'recent activity protects a multipart session');

const byteVictims = selectMultipartGcVictims([
  { uploadId: 'oldbytes', createdAt: now - 5_000, updatedAt: now - 2_000, bytes: 70 },
  { uploadId: 'newbytes', createdAt: now - 5_000, updatedAt: now - 1_500, bytes: 50 },
], limits, now);
assert.deepEqual([...byteVictims], ['oldbytes'], 'byte pressure evicts the least-recent inactive session');

const source = { size: 4_096, mtimeMs: 1_234.5 };
assert.notEqual(
  previewFingerprint(source),
  previewFingerprint({ ...source, mtimeMs: source.mtimeMs + 1 }),
  'preview cache invalidates when source mtime changes',
);
assert.match(previewFingerprint(source), /^preview-v3-/, 'preview cache identity includes the transform version');
const oldFilmstrip = previewCachePath('sample.mp4', source, 'strip', 'jpg');
const newFilmstrip = previewCachePath('sample.mp4', source, 'strip-v2', 'jpg');
assert.notEqual(oldFilmstrip, newFilmstrip, 'higher resolution filmstrips use a fresh cache entry');
assert.match(newFilmstrip, /\.strip-v2\.jpg$/, 'filmstrip regeneration is versioned independently');
assert.notEqual(
  previewFingerprint(source),
  previewFingerprint({ ...source, size: source.size + 1 }),
  'preview cache invalidates when source size changes',
);

const previewEntries: PreviewCacheEntry[] = [
  { path: 'old.jpg', bytes: 70, lastAccessedAt: 1 },
  { path: 'new.jpg', bytes: 50, lastAccessedAt: 2 },
];
assert.deepEqual(selectPreviewEvictions([
  { path: 'just-built.proxy.mp4', bytes: 1024, lastAccessedAt: Date.now() },
], 512), [], 'oversized proxy survives the build-to-first-read handoff');
const cacheNow = 1_000_000;
assert.deepEqual(selectPreviewEvictions([
  { path: 'idle.proxy.mp4', bytes: 1024, lastAccessedAt: cacheNow - 300_001 },
  { path: 'recent.proxy.mp4', bytes: 1024, lastAccessedAt: cacheNow - 1 },
], 512, new Set(), cacheNow), ['idle.proxy.mp4'], 'idle proxies remain eligible under budget pressure');
assert.deepEqual(selectPreviewEvictions([
  { path: 'reading.proxy.mp4', bytes: 1024, lastAccessedAt: 0 },
], 512, new Set(['reading.proxy.mp4']), cacheNow), [], 'active readers remain protected');
assert.deepEqual(
  selectPreviewEvictions(previewEntries, 80),
  ['old.jpg'],
  'preview LRU enforces an aggregate byte budget',
);
for (const name of ['fixture.peaks.json', 'fixture.peaks-v2.json', 'fixture.peaks-v12.json']) {
  assert.equal(isPreviewDerivative(name), true, `${name} participates in preview cache accounting`);
  assert.deepEqual(selectPreviewEvictions([
    { path: name, bytes: 80, lastAccessedAt: cacheNow - 300_001 },
  ], 50, new Set(), cacheNow), [name], `${name} is eligible under byte budget pressure`);
}
