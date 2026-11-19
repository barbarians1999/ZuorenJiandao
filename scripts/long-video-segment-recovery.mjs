import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { validateVideoAndPcmSegment, frameRanges } from './long-video-segmented-export.mjs';

const digest = async (file, signal) => {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) { signal?.throwIfAborted(); hash.update(part); }
  return hash.digest('hex');
};

// Only an explicitly selected interrupted checkpoint may supply a committed
// prefix. Invalid evidence fails closed; never overwrite or mutate old samples.
export async function prepareSegmentRecovery({ snapshot, root, name, state, sourceDigest, configuration, signal }) {
  signal?.throwIfAborted();
  const old = snapshot.benchmark;
  if (old.inFlight?.name !== name || old.inFlight?.route !== 'server') return null;
  assert.equal(old.rendererBundleReuse?.sourceDigest, sourceDigest, 'Recovery source digest changed');
  assert.deepEqual(snapshot.timelines[name], state, 'Recovery timeline changed');
  for (const key of ['compatibilityRenderCache', 'compatibilityRenderConcurrency', 'compatibilitySegmentFrames', 'compatibilityRenderGl']) {
    assert.deepEqual(old.configuration[key], configuration[key], `Recovery configuration changed: ${key}`);
  }
  const directory = resolve(old.inFlight.segmentDirectory);
  assert.equal(dirname(directory), resolve(root), 'Recovery directory must be an immediate benchmark child');
  assert.match(directory.split(/[\\/]/).at(-1), /^server-attempt-\d+-(simple|layered)-segments$/);
  assert.ok(!(await lstat(directory)).isSymbolicLink(), 'Linked recovery directory rejected');
  assert.equal(dirname(await realpath(directory)), await realpath(root), 'Recovery directory escaped benchmark root');
  const ranges = frameRanges(720 * state.fps, configuration.compatibilitySegmentFrames);
  const completed = old.inFlight.completedSegments;
  assert.ok(Number.isSafeInteger(completed) && completed >= 0 && completed <= ranges.length, 'Invalid committed prefix');
  assert.equal(snapshot.sources?.length, 4, 'Recovery requires source fingerprints');
  assert.equal(new Set(snapshot.sources.map(source => resolve(source.file))).size, 4, 'Duplicate recovery sources');
  for (const source of snapshot.sources) {
    assert.ok(['media', 'profile/media/uploads'].some(directory => dirname(resolve(source.file)) === resolve(root, directory)),
      'Recovery media must belong to this benchmark');
    assert.ok(['generated-long-gop-frame-id-12min.mp4', 'generated-music.wav'].includes(source.file.split(/[\\/]/).at(-1)),
      'Unexpected recovery media');
    assert.ok(!(await lstat(source.file)).isSymbolicLink(), 'Linked recovery media rejected');
    const info = await stat(source.file);
    assert.equal(info.size, source.bytes); assert.equal(info.mtimeMs, source.mtimeMs);
    assert.equal(await digest(source.file, signal), source.sha256, 'Recovery media changed');
  }
  return { directory, completed, ranges, scope: snapshot.scope };
}

export async function recoverCompletedSegment({ recovery, index, range, output, fps, width, height,
  probe, command, ffmpegPath, signal, onEvidence = async () => {} }) {
  if (!recovery || index >= recovery.completed) return false;
  signal?.throwIfAborted();
  assert.deepEqual(range, recovery.ranges[index], 'Recovery frame range changed');
  const file = join(recovery.directory, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
  const audio = file.replace(/\.mp4$/, '.wav');
  for (const input of [file, audio]) assert.ok((await lstat(input)).isFile() && !(await lstat(input)).isSymbolicLink(), 'Recovery requires regular files');
  const metadata = await validateVideoAndPcmSegment({ file, range, fps, probe, signal });
  assert.equal(metadata.video.width, width); assert.equal(metadata.video.height, height);
  assert.equal(metadata.video.avg_frame_rate, `${fps}/1`);
  const files = [];
  for (const input of [file, audio]) {
    // Decode the whole segment, not just its header, before using old output.
    await command(ffmpegPath, ['-v', 'error', '-xerror', '-threads', '1', '-i', input, '-f', 'null', '-'], signal);
    signal?.throwIfAborted();
    const before = await stat(input), sha256 = await digest(input, signal);
    const target = input === file ? output : output.replace(/\.mp4$/, '.wav');
    await copyFile(input, target, constants.COPYFILE_EXCL);
    assert.equal(await digest(target, signal), sha256, 'Recovery copy mismatch');
    const after = await stat(input);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    files.push({ source: input, target, bytes: before.size, sha256 });
  }
  signal?.throwIfAborted();
  await onEvidence({ segment: index + 1, range, status: 'recovered-after-full-decode', files, at: new Date().toISOString() });
  return true;
}
