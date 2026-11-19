import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chapterSourceDigest } from './chapter-render-bundle.mjs';

// Identity is content based. Size/mtime alone must never authorise result reuse.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
export const identityDigest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export async function fileContentIdentity(file) {
  const before = await stat(file);
  assert.ok(before.isFile(), `Identity requires a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await stat(file);
  assert.equal(after.size, before.size, `File changed while hashing: ${file}`);
  assert.equal(after.mtimeMs, before.mtimeMs, `File changed while hashing: ${file}`);
  assert.equal(after.ctimeMs, before.ctimeMs, `File changed while hashing: ${file}`);
  return { bytes: after.size, sha256: hash.digest('hex') };
}

export async function benchmarkSourceDigest(root = resolve('.')) {
  // Product rendering is covered by the existing digest; also cover server,
  // Electron and the benchmark host/auditor, which can change the evidence.
  const files = [];
  async function visit(relative) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Cannot fingerprint linked benchmark source: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (/\.(?:[cm]?[jt]sx?|json|html|css)$/.test(name) && !/\.verify\./.test(name)) {
        files.push({ name, ...await fileContentIdentity(join(root, name)) });
      }
    }
  }
  for (const directory of ['server', 'desktop', 'scripts']) await visit(directory);
  return identityDigest({ product: await chapterSourceDigest(root), files });
}

export async function createBenchmarkIdentity({ states, materials, configuration, sourceDigest, runtimes = [] }) {
  const inputs = [];
  for (const { name, file } of materials) inputs.push({ name, ...await fileContentIdentity(file) });
  const binaries = [];
  for (const { name, file } of runtimes) binaries.push({ name, ...await fileContentIdentity(file) });
  return { version: 1, source: sourceDigest, project: identityDigest(states),
    materials: identityDigest(inputs), configuration: identityDigest({ configuration, binaries }), inputs, binaries };
}

export const sameBenchmarkIdentity = (left, right) => Boolean(left && right && left.version === 1 && right.version === 1
  && ['source', 'project', 'materials', 'configuration'].every((key) => typeof left[key] === 'string'
    && left[key].length === 64 && left[key] === right[key]));

export async function auditBenchmarkArtifact(file, audit) {
  const artifactIdentity = await fileContentIdentity(file);
  const result = await audit();
  assert.deepEqual(await fileContentIdentity(file), artifactIdentity, 'Export changed during its audit');
  return { ...result, artifactIdentity };
}

export async function syncBenchmarkMedia(source, target) {
  const expected = await fileContentIdentity(source);
  const actual = await fileContentIdentity(target).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (identityDigest(expected) !== identityDigest(actual)) {
    await cp(source, target, { preserveTimestamps: true });
    assert.deepEqual(await fileContentIdentity(target), expected, 'Benchmark media copy changed');
  }
  return expected;
}

export async function reusableBenchmarkResult(entry, identity, { kind, name, route, mode }) {
  if (!entry || entry.name !== name || !sameBenchmarkIdentity(entry.resultIdentity, identity)) return false;
  if (kind === 'preview') {
    if (!(entry.mode === mode && entry.status === 'passed' && entry.latency?.failed === 0
      && Array.isArray(entry.results) && entry.results.length > 0
      && entry.results.every((sample) => sample.status === 'presented') && entry.playback)) return false;
    if (mode === 'proxy') {
      if (!Array.isArray(entry.proxyArtifacts) || !entry.proxyArtifacts.length) return false;
      for (const artifact of entry.proxyArtifacts) {
        const actual = await fileContentIdentity(artifact.file).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!actual || identityDigest(actual) !== identityDigest(artifact.identity)) return false;
      }
    }
    return true;
  }
  if (entry.route !== route || entry.status !== 'passed' || entry.decodeErrors !== 0
    || !Array.isArray(entry.keyPictures) || !entry.keyPictures.length
    || !Array.isArray(entry.syncSamples) || !entry.syncSamples.length || !entry.output || !entry.artifactIdentity) return false;
  const actual = await fileContentIdentity(entry.output).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return actual !== null && identityDigest(actual) === identityDigest(entry.artifactIdentity);
}

export function archiveBenchmarkAttempt(previous) {
  const { attemptHistory = [], ...snapshot } = previous;
  if (snapshot.inFlight) snapshot.interruption = { detectedAt: new Date().toISOString(), status: 'interrupted',
    reason: 'previous process ended before completion; cause is not inferred' };
  return [...attemptHistory, snapshot];
}

export async function restoreBenchmarkResults(report, previous, identity, { retainPreviewFailures = false } = {}) {
  // All failed, legacy and incompatible evidence stays in attemptHistory. Only
  // individually validated current results are allowed into the active arrays.
  report.resultIdentity = identity;
  report.previews = [];
  report.exports = [];
  report.failures = [];
  for (const key of ['proxyGeneration', 'previewSettingsPersistence', 'selectedExactPreview', 'sharedVisualRender']) delete report[key];
  if (previous) {
    for (const entry of previous.previews ?? []) if (await reusableBenchmarkResult(entry, identity,
      { kind: 'preview', name: entry.name, mode: entry.mode })) report.previews.push(entry);
    for (const entry of previous.exports ?? []) if (await reusableBenchmarkResult(entry, identity,
      { kind: 'export', name: entry.name, route: entry.route })) report.exports.push(entry);
    if (sameBenchmarkIdentity(previous.resultIdentity, identity)) {
      if (previous.proxyGeneration?.confirmedRebuild === true && report.previews.some((entry) => entry.mode === 'proxy'))
        report.proxyGeneration = previous.proxyGeneration;
      if (previous.previewSettingsPersistence?.passed === true) report.previewSettingsPersistence = previous.previewSettingsPersistence;
      if (previous.selectedExactPreview?.samples?.length && previous.selectedExactPreview.samples.every(
        (sample) => sample.status === 'presented' && sample.compositeMatched === true)) report.selectedExactPreview = previous.selectedExactPreview;
      if (previous.sharedVisualRender?.length >= 7 && previous.sharedVisualRender.every(
        (sample) => Number.isFinite(sample.meanAbsoluteError) && sample.meanAbsoluteError <= 3)) report.sharedVisualRender = previous.sharedVisualRender;
      if (retainPreviewFailures) report.failures = (previous.failures ?? []).filter((entry) =>
        ['preview', 'preview-settings-persistence', 'selected-exact-preview'].includes(entry.stage));
    }
  }
  report.resumeValidation = { at: new Date().toISOString(), reusedPreviews: report.previews.length,
    reusedExports: report.exports.length, scope: 'SHA-256 source/project/media/configuration plus audited export artifact content; legacy evidence is history only' };
}
