import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function frameRanges(durationFrames, segmentFrames) {
  if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0
    || !Number.isSafeInteger(segmentFrames) || segmentFrames <= 0) {
    throw new Error('Frame duration and segment size must be positive safe integers');
  }
  const ranges = [];
  for (let start = 0; start < durationFrames; start += segmentFrames) {
    ranges.push([start, Math.min(durationFrames - 1, start + segmentFrames - 1)]);
  }
  return ranges;
}

export async function renderTimelineInSegments({
  durationFrames, segmentFrames, temporaryDirectory, outputPath,
  renderSegment, joinSegments, onSegment = async () => {}, recoverSegment = async () => false,
}) {
  const ranges = frameRanges(durationFrames, segmentFrames);
  await mkdir(temporaryDirectory, { recursive: true });
  const segments = [];
  for (let index = 0; index < ranges.length; index++) {
    const output = join(temporaryDirectory, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
    const recovered = await recoverSegment({ index, range: ranges[index], output });
    if (!recovered) await renderSegment({ index, range: ranges[index], output });
    segments.push(output);
    await onSegment({ index: index + 1, count: ranges.length, range: ranges[index], output, recovered });
  }
  const playlist = join(dirname(temporaryDirectory), `${temporaryDirectory.split(/[\\/]/).at(-1)}.ffconcat`);
  const escape = (value) => value.replaceAll('\\', '/').replaceAll("'", "'\\''");
  await writeFile(playlist, `ffconcat version 1.0\n${segments.map((file) => `file '${escape(file)}'`).join('\n')}\n`, 'utf8');
  await joinSegments({ playlist, segments, ranges, outputPath });
  return { ranges, segments, playlist, outputPath };
}

export async function validateVideoAndPcmSegment({ file, range, fps, probe, signal }) {
  const frameCount = range[1] - range[0] + 1;
  const expected = frameCount / fps;
  const videoInfo = await probe(file, signal);
  signal?.throwIfAborted();
  const videos = videoInfo.streams.filter((entry) => entry.codec_type === 'video');
  if (videos.length !== 1 || videoInfo.streams.some((entry) => entry.codec_type === 'audio')
    || Number(videos[0].nb_frames) !== frameCount || !Number.isFinite(Number(videos[0].duration))
    || Math.abs(Number(videos[0].duration) - expected) > 1 / 48000) {
    throw new Error(`Video segment must be video-only with exactly its frame duration: ${file}`);
  }
  const audio = file.replace(/\.mp4$/, '.wav');
  if (audio === file) throw new Error('Video segment requires an .mp4 extension');
  const info = await probe(audio, signal);
  signal?.throwIfAborted();
  const stream = info.streams.find((entry) => entry.codec_type === 'audio');
  const duration = Number(stream?.duration ?? info.format?.duration);
  if (!stream || !/^pcm_/.test(stream.codec_name) || Number(stream.sample_rate) !== 48000
    || !Number.isInteger(stream.channels) || stream.channels < 1
    || !Number.isFinite(duration) || Math.abs(duration - expected) > 1 / 48000) {
    throw new Error(`PCM segment must have exactly its frame duration: ${audio}`);
  }
  return { audio, video: videos[0], signature: `${stream.codec_name}/${stream.sample_rate}/${stream.channels}` };
}

/** Video-only segments have exact frame durations. PCM sidecars are encoded
 * once at the end so AAC encoder padding cannot accumulate at every cut. */
export async function joinVideoAndPcmSegments({ playlist, segments, ranges, outputPath, fps, command, probe, ffmpegPath, signal }) {
  signal?.throwIfAborted();
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Invalid segment frame rate');
  if (!segments.length || segments.length !== ranges.length) throw new Error('Missing segment range');
  const files = [];
  let audioSignature;
  for (let i = 0; i < segments.length; i++) {
    const [start, end] = ranges[i];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start
      || start !== (i ? ranges[i - 1][1] + 1 : 0)) throw new Error('Segment ranges must be contiguous from frame zero');
    const { audio, signature } = await validateVideoAndPcmSegment({ file: segments[i], range: ranges[i], fps, probe, signal });
    audioSignature ??= signature;
    if (signature !== audioSignature) throw new Error('PCM segment formats differ');
    files.push(audio);
  }
  const escape = (value) => value.replaceAll('\\', '/').replaceAll("'", "'\\''");
  const audioPlaylist = `${playlist}.pcm.ffconcat`;
  await writeFile(audioPlaylist, `ffconcat version 1.0\n${files.map((file) => `file '${escape(file)}'`).join('\n')}\n`, 'utf8');
  await command(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'concat', '-safe', '0', '-i', playlist,
    '-f', 'concat', '-safe', '0', '-i', audioPlaylist,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', outputPath], signal);
  signal?.throwIfAborted();
  return { audioPlaylist, audioFiles: files, audioEncoding: 'PCM chunks, one final AAC encode' };
}
