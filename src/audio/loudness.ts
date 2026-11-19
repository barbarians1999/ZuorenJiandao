// Loudness normalization analysis core. The naming style is the same as isolate_voice(verb_noun).
//
// Split into two halves: pure function (can run check under node, no DOM dependencies) + browser-specific (fetch+WebAudio decoding).

// ── Pure function (node-testable) ────────────────────────────────────────────

// ponytail: simplified version of BS.1770 - approximate integrated loudness using 400ms block mean square energy + absolute silence threshold,
// Omits true K-weighting pre-filtering (overhead + high pass) and relative thresholding (10dB lower than unthresholded loudness)
// blocks should also be culled). For steady/quasi-steady assets (speech, music) the error is usually within a few LUFS, which is sufficient
// Rough judgment on "whether to increase gain/how much to increase"; assets containing large sections of silence + sudden loudness will deviate more.
// Upgrade path: Connect K-weighting biquad filter + relative threshold, align with ITU-R BS.1770-4 full process.
export function integratedLoudnessFromSamples(samples: Float32Array, sampleRate: number): number {
  if (samples.length === 0 || sampleRate <= 0) return -70; // Empty/illegal input → Silence lower limit, do not return NaN
  const blockSize = Math.max(1, Math.round(sampleRate * 0.4)); // BS.1770 gating block = 400ms
  const blockMeanSquares: number[] = [];
  for (let start = 0; start < samples.length; start += blockSize) {
    const end = Math.min(start + blockSize, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    blockMeanSquares.push(sum / (end - start));
  }
  // Mean square threshold corresponding to BS.1770 absolute threshold (blocks below -70 LUFS are considered silent and not included in the average)
  const ABSOLUTE_GATE_MS = 10 ** ((-70 + 0.691) / 10);
  const gated = blockMeanSquares.filter((ms) => ms > ABSOLUTE_GATE_MS);
  const kept = gated.length > 0 ? gated : blockMeanSquares; // When fully silent, it degenerates to use all blocks to avoid empty arrays.
  const meanSquare = kept.reduce((a, b) => a + b, 0) / kept.length;
  const EPS = 1e-10; // Anti-log10(0) = -Infinity
  return -0.691 + 10 * Math.log10(Math.max(meanSquare, EPS));
}

export interface LoudnessSourceRange {
  startFrame: number;
  endFrame: number;
}

export interface LoudnessMeasurement {
  lufs: number;
  samplePeak: number;
}

/** Measure only the source samples that play in the selected output ranges. */
export function measureLoudnessRanges(
  channels: readonly Float32Array[],
  sampleRate: number,
  fps: number,
  ranges: readonly LoudnessSourceRange[],
  playbackRate = 1,
): LoudnessMeasurement {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0
    || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(playbackRate) || playbackRate <= 0) {
    throw new Error('无法分析所选片段的音频范围');
  }
  const length = Math.min(...channels.map((channel) => channel.length));
  const monoParts: Float32Array[] = [];
  let samplePeak = 0;
  for (const range of ranges) {
    if (!Number.isFinite(range.startFrame) || !Number.isFinite(range.endFrame) || range.endFrame <= range.startFrame) continue;
    const start = Math.max(0, range.startFrame * sampleRate / fps);
    const end = Math.min(length, range.endFrame * sampleRate / fps);
    if (end <= start) continue;
    const count = Math.max(1, Math.floor((end - start) / playbackRate));
    const mono = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const position = Math.min(end - 1, start + i * playbackRate);
      const left = Math.floor(position);
      const right = Math.min(length - 1, left + 1);
      const fraction = position - left;
      let mixed = 0;
      for (const channel of channels) {
        const value = channel[left]! + (channel[right]! - channel[left]!) * fraction;
        mixed += value / channels.length;
        samplePeak = Math.max(samplePeak, Math.abs(value));
      }
      mono[i] = mixed;
    }
    monoParts.push(mono);
  }
  const total = monoParts.reduce((sum, part) => sum + part.length, 0);
  if (!total) throw new Error('所选片段没有可分析的音频');
  const samples = new Float32Array(total);
  let offset = 0;
  for (const part of monoParts) { samples.set(part, offset); offset += part.length; }
  const lufs = integratedLoudnessFromSamples(samples, sampleRate);
  if (lufs <= -70) throw new Error('所选片段没有可分析声音，未修改任何片段。');
  return { lufs, samplePeak };
}

const MIN_GAIN = 0.05;
const MAX_GAIN = 8;

/** The linear gain multiple required to achieve the target loudness, sandwiched between [MIN_GAIN, MAX_GAIN] to prevent blasting/silencing. */
export function gainForTarget(currentLufs: number, targetLufs: number): number {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return 1; // Illegal input → Keep gain unchanged and prevent NaN from spreading
  const gain = 10 ** ((targetLufs - currentLufs) / 20);
  if (!Number.isFinite(gain)) return MAX_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}

// ── Browser only (fetch + WebAudio decoding) ─────────────────────────────────

function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const out = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i] / numberOfChannels;
  }
  return out;
}

/** Pull audio source→OfflineAudioContext offline decoding (no sound, not restricted by automatic playback policy)→mix mono
 * →Measure integrated loudness. Browser-specific; it should not be adjusted in the node environment (OfflineAudioContext does not exist). */
export async function analyzeClipLoudness(src: string): Promise<number> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  // The length is just a placeholder; the actual sampling rate/number of channels is subject to the decoding result of decodeAudioData.
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  return integratedLoudnessFromSamples(mixToMono(audioBuffer), audioBuffer.sampleRate);
}

export interface LoudnessSelection {
  itemId: string;
  src: string;
  fps: number;
  playbackRate: number;
  ranges: readonly LoudnessSourceRange[];
}

async function decodeLoudnessSource(src: string): Promise<AudioBuffer> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`加载音频失败: ${src} (HTTP ${res.status})`);
  const arrayBuffer = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(arrayBuffer);
}

/** Decode each source once per operation; measure each distinct clip range separately. */
export async function analyzeLoudnessSelections(
  selections: readonly LoudnessSelection[],
  decode: (src: string) => Promise<AudioBuffer> = decodeLoudnessSource,
): Promise<Map<string, PromiseSettledResult<LoudnessMeasurement>>> {
  const groups = new Map<string, LoudnessSelection[]>();
  for (const selection of selections) groups.set(selection.src, [...(groups.get(selection.src) ?? []), selection]);
  const results = new Map<string, PromiseSettledResult<LoudnessMeasurement>>();
  const pending = [...groups.entries()];
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const [src, group] = pending[next++]!;
      let buffer: AudioBuffer;
      try { buffer = await decode(src); }
      catch (reason) {
        for (const selection of group) results.set(selection.itemId, { status: 'rejected', reason });
        continue;
      }
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
      for (const selection of group) {
        try {
          results.set(selection.itemId, { status: 'fulfilled', value: measureLoudnessRanges(
            channels, buffer.sampleRate, selection.fps, selection.ranges, selection.playbackRate,
          ) });
        } catch (reason) { results.set(selection.itemId, { status: 'rejected', reason }); }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(pending.length, LOUDNESS_DECODE_CONCURRENCY) }, worker));
  return results;
}

const LOUDNESS_DECODE_CONCURRENCY = 2;

/** Share whole-source analysis only within this operation; never retain decoded audio. */
export async function analyzeLoudnessBatch(
  sources: readonly string[],
  analyze: (src: string) => Promise<number> = analyzeClipLoudness,
): Promise<Map<string, PromiseSettledResult<number>>> {
  const pending = [...new Set(sources)];
  const results = new Map<string, PromiseSettledResult<number>>();
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const src = pending[next++];
      try {
        results.set(src, { status: 'fulfilled', value: await analyze(src) });
      } catch (reason) {
        results.set(src, { status: 'rejected', reason });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(pending.length, LOUDNESS_DECODE_CONCURRENCY) }, worker));
  return results;
}
