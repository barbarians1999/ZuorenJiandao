import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveBenchmarkAttempt, auditBenchmarkArtifact, benchmarkSourceDigest, createBenchmarkIdentity, fileContentIdentity,
  identityDigest, restoreBenchmarkResults, reusableBenchmarkResult, sameBenchmarkIdentity, syncBenchmarkMedia } from './benchmark-result-identity.mjs';

const root = await mkdtemp(join(tmpdir(), 'benchmark-identity-'));
try {
  for (const name of ['src', 'remotion', 'shared', 'assets', 'config', 'server', 'desktop', 'scripts']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'entry.js'), `// ${name}: first source\n`);
  }
  await writeFile(join(root, 'package.json'), '{"version":"test"}');
  const media = join(root, 'media.bin'), target = join(root, 'render-input.bin'), output = join(root, 'audited.mp4');
  await writeFile(media, 'AAAA');
  await writeFile(target, 'BBBB');
  await syncBenchmarkMedia(media, target);
  assert.equal(await readFile(target, 'utf8'), 'AAAA', 'same-size stale profile media must be replaced');
  await writeFile(output, 'small-audited-output');
  const states = { simple: { fps: 30, items: [{ id: 'clip', src: '/media/source', startFrame: 60 }] } };
  const configuration = { route: 'server', backend: 'swangle', cacheBytes: 256, codec: 'h264', frameRange: [0, 299] };
  const sourceDigest = await benchmarkSourceDigest(root);
  const makeIdentity = (changes = {}) => createBenchmarkIdentity({ states, configuration, sourceDigest,
    materials: [{ name: 'actual-input', file: media }], ...changes });
  const identity = await makeIdentity();
  const entry = { name: 'simple', route: 'server', status: 'passed', resultIdentity: identity, output,
    artifactIdentity: await fileContentIdentity(output), decodeErrors: 0, keyPictures: [{ frame: 1 }], syncSamples: [{ offsetMs: 0 }] };
  const preview = { name: 'simple', mode: 'original', status: 'passed', resultIdentity: identity,
    latency: { failed: 0 }, results: [{ status: 'presented' }], playback: { droppedFrames: 0 } };
  const scope = { kind: 'export', name: 'simple', route: 'server' };
  const proxyPreview = { ...preview, mode: 'proxy', proxyArtifacts: [{ file: target, identity: await fileContentIdentity(target) }] };
  assert(await reusableBenchmarkResult(proxyPreview, identity, { kind: 'preview', name: 'simple', mode: 'proxy' }));
  await writeFile(target, 'DDDD');
  assert(!await reusableBenchmarkResult(proxyPreview, identity, { kind: 'preview', name: 'simple', mode: 'proxy' }), 'changed proxy cache invalidates cached preview');
  assert(await reusableBenchmarkResult(entry, identity, scope), 'matching audited result is reusable');
  assert(!await reusableBenchmarkResult(entry, identity, { ...scope, route: 'webcodecs' }), 'route must match');
  assert(!await reusableBenchmarkResult({ ...entry, artifactIdentity: undefined }, identity, scope), 'legacy artifact is not audited evidence');
  assert(!await reusableBenchmarkResult({ ...entry, resultIdentity: undefined }, identity, scope), 'legacy passed result cannot suppress a rerun');
  assert(!await reusableBenchmarkResult({ ...entry, status: 'failed' }, identity, scope));
  assert(!await reusableBenchmarkResult({ ...entry, status: 'unsupported' }, identity, scope));
  assert(!await reusableBenchmarkResult({ ...entry, syncSamples: [] }, identity, scope), 'audit is required');
  const previous = { exports: [entry, { name: 'layered', route: 'webcodecs', status: 'unsupported' }],
    previews: [preview], failures: [{ reason: 'original failure' }], inFlight: { name: 'layered', route: 'server' },
    attemptHistory: [{ status: 'older failure' }], selectedExactPreview: { samples: [{ status: 'presented', compositeMatched: true }] } };
  previous.resultIdentity = identity;
  const saved = JSON.stringify(previous);
  const report = { attemptHistory: archiveBenchmarkAttempt(previous) };
  await restoreBenchmarkResults(report, previous, identity);
  assert.equal(report.exports.length, 1); assert.equal(report.previews.length, 1);
  assert.equal(report.attemptHistory.length, 2);
  assert.equal(report.selectedExactPreview.samples[0].compositeMatched, true);
  assert.equal(report.attemptHistory[1].failures[0].reason, 'original failure');
  assert.equal(report.attemptHistory[1].exports[1].status, 'unsupported');
  assert.equal(report.attemptHistory[1].interruption.status, 'interrupted');
  assert.equal(JSON.stringify(previous), saved, 'archiving cannot mutate previous evidence');
  await restoreBenchmarkResults(report, { ...previous, failures: [{ stage: 'selected-exact-preview', reason: 'real prior failure' }] }, identity,
    { retainPreviewFailures: true });
  assert.equal(report.failures[0].reason, 'real prior failure', 'unrerun known preview failure cannot turn into a pass');

  // Small regression for the original bug: same project/route and old passed
  // report, but a changed source file. The active route must now be rerun.
  await writeFile(join(root, 'src', 'entry.js'), '// changed renderer source\n');
  const changedSource = await makeIdentity({ sourceDigest: await benchmarkSourceDigest(root) });
  await restoreBenchmarkResults(report, previous, changedSource);
  assert.equal(report.exports.length, 0); assert.equal(report.previews.length, 0);
  assert.equal(report.selectedExactPreview, undefined, 'stale auxiliary evidence is not current');
  assert(!await reusableBenchmarkResult(entry, changedSource, scope), 'changed source schedules retest before route skip');
  const changedProject = await makeIdentity({ states: { simple: { ...states.simple, fps: 25 } } });
  assert(!sameBenchmarkIdentity(identity, changedProject), 'project state participates in identity');
  for (const changes of [{ backend: 'angle' }, { cacheBytes: 128 }, { codec: 'h265' }, { frameRange: [30, 299] }]) {
    assert(!sameBenchmarkIdentity(identity, await makeIdentity({ configuration: { ...configuration, ...changes } })),
      `configuration change invalidates result: ${JSON.stringify(changes)}`);
  }
  const runtimeIdentity = await makeIdentity({ runtimes: [{ name: 'native-encoder', file: target }] });
  await writeFile(target, 'EEEE');
  assert(!sameBenchmarkIdentity(runtimeIdentity, await makeIdentity({ runtimes: [{ name: 'native-encoder', file: target }] })),
    'changed actual runtime binary invalidates result even with unchanged declared settings');
  assert.equal(identityDigest(configuration), identityDigest(Object.fromEntries(Object.entries(configuration).reverse())),
    'object insertion order and resume control flags are not a change in actual settings');
  const before = await stat(media);
  await writeFile(media, 'CCCC'); await utimes(media, before.atime, before.mtime);
  assert.equal((await stat(media)).size, before.size);
  assert(!sameBenchmarkIdentity(identity, await makeIdentity()), 'actual bytes change invalidates even with same size/mtime');
  assert(!await reusableBenchmarkResult(entry, await makeIdentity(), scope));
  await writeFile(output, 'changed-output-bytes');
  assert(!await reusableBenchmarkResult(entry, identity, scope), 'same-size changed export cannot reuse the old audit');
  await assert.rejects(auditBenchmarkArtifact(output, async () => {
    await writeFile(output, 'modified-during-audit'); return { decodeErrors: 0 };
  }), /changed during its audit/);
  await rm(output);
  assert(!await reusableBenchmarkResult(entry, identity, scope), 'missing export must rerun');

  // The real entrypoints must validate before any name/route skip. This also
  // guards accidentally restoring the old unconditional passed carry-forward.
  const generated = await readFile(resolve('scripts/generated-edit-benchmark.mts'), 'utf8');
  const runner = await readFile(resolve('scripts/long-video-runner.mts'), 'utf8');
  assert.match(generated, /archiveBenchmarkAttempt\(previousReport\)/);
  assert.doesNotMatch(generated, /report\.(?:exports|previews)\s*=\s*previous\./);
  assert(runner.indexOf('await restoreBenchmarkResults(') < runner.indexOf("await canReuse('preview'"));
  assert.equal((runner.match(/if \(await canReuse\(/g) ?? []).length, 3);
  assert.doesNotMatch(runner, /if \((?:exports|previews)\.some\([^\n]+continue;/, 'no unchecked name/route reuse');
  console.log('benchmark result identity: source/project/material/config changes, legacy invalidation, artifact audit and full history preservation passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
