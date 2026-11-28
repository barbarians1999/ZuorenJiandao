import { buildAudioCrossfadePlanMap } from '../../editor/audioCrossfade';
import { audioGainAt, hasSoloTrack, isTrackEffectivelyMuted } from '../../editor/audioRouting';
import { clipFadeFactor } from '../../editor/clipFade';
import { volumeAtFrame } from '../../editor/keyframes';
import { sourceFrameAt } from '../../editor/sourceLimit';
import type { ProjectDoc, TimelineItem, TimelineState } from '../../editor/types';
import { voiceIsolationMix } from '../../audio/voiceMix';
import { isPreviewable, resolvePeaksPerSecond, soundEffectPreview } from '../../media/clipPreview';

export const AUDIO_METER_TICKS = [0, -6, -12, -18, -24, -36, -48] as const;
export const AUDIO_METER_FLOOR_DB = -48;
const SILENCE_LINEAR_THRESHOLD = 0.0001; // -80 dBFS
const CLIP_LINEAR_THRESHOLD = 0.99426; // ~ -0.05 dBFS (rounds to 0.0 dB on readout)

export interface AudioStereoEnvelope {
  leftPeaks: ArrayLike<number>;
  rightPeaks: ArrayLike<number>;
  peaksPerSecond: number;
  durationMs: number;
}

export interface AudioLevelReading {
  leftLinear: number;
  rightLinear: number;
  peakLinear: number;
  leftDb: number;
  rightDb: number;
  peakDb: number;
  leftPercent: number;
  rightPercent: number;
  clippingLeft: boolean;
  clippingRight: boolean;
  clipping: boolean;
}

export function linearToDecibels(linear: number): number {
  if (!Number.isFinite(linear) || linear <= SILENCE_LINEAR_THRESHOLD) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(linear);
}

export function decibelsToMeterPercent(
  db: number,
  floorDb: number = AUDIO_METER_FLOOR_DB,
): number {
  if (!Number.isFinite(db) || db <= floorDb) return 0;
  if (db >= 0) return 100;
  return Math.max(0, Math.min(100, ((db - floorDb) / (0 - floorDb)) * 100));
}

export function formatAudioMeterDb(db: number): string {
  if (!Number.isFinite(db) || db <= -60) return '-∞';
  const rounded = Math.round(db * 10) / 10;
  if (Math.abs(rounded) < 0.05) return '0.0';
  return rounded > 0 ? `+${rounded.toFixed(1)}` : rounded.toFixed(1);
}

export function buildAudioLevelReading(
  rawLeftLinear: number,
  rawRightLinear: number,
): AudioLevelReading {
  const leftLinear = Number.isFinite(rawLeftLinear) ? Math.max(0, rawLeftLinear) : 0;
  const rightLinear = Number.isFinite(rawRightLinear) ? Math.max(0, rawRightLinear) : 0;
  const peakLinear = Math.max(leftLinear, rightLinear);
  const leftDb = linearToDecibels(leftLinear);
  const rightDb = linearToDecibels(rightLinear);
  const peakDb = linearToDecibels(peakLinear);
  const leftPercent = decibelsToMeterPercent(leftDb);
  const rightPercent = decibelsToMeterPercent(rightDb);
  // Instantaneous overload indicator: lights up immediately at >= 0 dB, turns off immediately when < 0 dB.
  const clippingLeft = leftLinear >= CLIP_LINEAR_THRESHOLD;
  const clippingRight = rightLinear >= CLIP_LINEAR_THRESHOLD;
  return {
    leftLinear,
    rightLinear,
    peakLinear,
    leftDb,
    rightDb,
    peakDb,
    leftPercent,
    rightPercent,
    clippingLeft,
    clippingRight,
    clipping: clippingLeft || clippingRight,
  };
}

export const SILENT_AUDIO_LEVEL_READING: AudioLevelReading = buildAudioLevelReading(0, 0);

export function sampleEnvelopeAtSeconds(
  envelope: AudioStereoEnvelope | null | undefined,
  sourceSeconds: number,
  windowSeconds = 1 / 30,
): { left: number; right: number } {
  if (!envelope) return { left: 0, right: 0 };
  const leftLen = envelope.leftPeaks.length;
  const rightLen = envelope.rightPeaks.length;
  if (leftLen === 0 && rightLen === 0) return { left: 0, right: 0 };
  if (!Number.isFinite(sourceSeconds) || sourceSeconds < 0) return { left: 0, right: 0 };
  if (envelope.durationMs > 0 && sourceSeconds * 1000 > envelope.durationMs + 20) {
    return { left: 0, right: 0 };
  }
  const rate = envelope.peaksPerSecond > 0 ? envelope.peaksPerSecond : 100;
  const span = Math.max(1 / rate, Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 1 / 30);
  const fromIndex = Math.max(0, Math.floor(sourceSeconds * rate));
  const toIndex = Math.max(fromIndex, Math.ceil((sourceSeconds + span) * rate) - 1);

  let left = 0;
  if (leftLen > 0 && fromIndex < leftLen) {
    const hi = Math.min(leftLen - 1, toIndex);
    for (let i = fromIndex; i <= hi; i += 1) {
      const v = envelope.leftPeaks[i] ?? 0;
      if (v > left) left = v;
    }
  }

  let right = 0;
  if (rightLen > 0 && fromIndex < rightLen) {
    const hi = Math.min(rightLen - 1, toIndex);
    for (let i = fromIndex; i <= hi; i += 1) {
      const v = envelope.rightPeaks[i] ?? 0;
      if (v > right) right = v;
    }
  } else {
    right = left;
  }

  return { left, right };
}

export type AudioEnvelopeResolver = (
  src: string,
  kind: TimelineItem['kind'],
  sourceRevision?: string,
) => AudioStereoEnvelope | null;

function accumulateTimelineAudioEnergy({
  state,
  project,
  frame,
  resolveEnvelope,
  forceMuted = false,
  parentGain = 1,
  visitedTimelines,
}: {
  state: TimelineState;
  project?: ProjectDoc;
  frame: number;
  resolveEnvelope: AudioEnvelopeResolver;
  forceMuted?: boolean;
  parentGain?: number;
  visitedTimelines: Set<string>;
}): { leftSq: number; rightSq: number } {
  if (!Number.isFinite(frame) || frame < 0 || parentGain <= 0) {
    return { leftSq: 0, rightSq: 0 };
  }
  const fps = state.fps > 0 ? state.fps : 30;
  const windowSeconds = 1 / fps;
  const isHidden = (track: TimelineItem['track']) => state.tracks?.[track]?.hidden ?? false;
  const anySolo = hasSoloTrack(state);
  const isMuted = (track: TimelineItem['track']) => isTrackEffectivelyMuted(state, track, forceMuted, anySolo);

  const anchorRanges = state.items
    .filter((item) => state.tracks?.[item.track]?.role === 'anchor'
      && !isHidden(item.track)
      && !isMuted(item.track)
      && Boolean(item.src || item.denoisedSrc)
      && item.pictureDisabled !== true
      && !(item.kind === 'video' && item.audioDetached))
    .map((item) => [item.startFrame, item.startFrame + item.durationInFrames] as const);

  const duckGain = (track: TimelineItem['track'], atFrame: number): number => {
    const config = state.tracks?.[track];
    if (config?.role !== 'follower' || !anchorRanges.some(([from, to]) => atFrame >= from && atFrame < to)) {
      return 1;
    }
    return 10 ** ((config.audioRouting?.duckDepthDb ?? -12) / 20);
  };

  const trackGainAt = (track: TimelineItem['track'], atFrame: number): number =>
    audioGainAt(state, track, duckGain(track, atFrame));

  const crossfadeMap = buildAudioCrossfadePlanMap(state.items, state.transitions, project?.assets ?? []);
  const assetById = new Map((project?.assets ?? []).map((asset) => [asset.id, asset]));

  let leftSq = 0;
  let rightSq = 0;

  for (const item of state.items) {
    if (item.pictureDisabled === true) continue;
    if (isHidden(item.track) || isMuted(item.track)) continue;

    if (item.kind === 'sequence') {
      if (!project || !item.timelineId || visitedTimelines.has(item.timelineId)) continue;
      if (frame < item.startFrame || frame >= item.startFrame + item.durationInFrames) continue;
      const child = project.timelines.find((entry) => entry.id === item.timelineId);
      if (!child) continue;
      const localFrame = frame - item.startFrame;
      const childFrame = sourceFrameAt(item, localFrame);
      const seqGain = parentGain
        * volumeAtFrame(item, localFrame)
        * clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)
        * trackGainAt(item.track, frame);
      if (seqGain <= 0) continue;
      const nextVisited = new Set(visitedTimelines);
      nextVisited.add(item.timelineId);
      const childEnergy = accumulateTimelineAudioEnergy({
        state: child,
        project,
        frame: childFrame,
        resolveEnvelope,
        forceMuted: false,
        parentGain: seqGain,
        visitedTimelines: nextVisited,
      });
      leftSq += childEnergy.leftSq;
      rightSq += childEnergy.rightSq;
      continue;
    }

    if (item.kind !== 'audio' && item.kind !== 'video') continue;
    if (item.kind === 'video' && item.audioDetached) continue;
    if (!item.src && !item.denoisedSrc) continue;

    const crossfade = crossfadeMap.get(item.id);
    const beforeFrames = crossfade?.extensions.beforeFrames ?? 0;
    const afterFrames = crossfade?.extensions.afterFrames ?? 0;
    const activeStart = item.startFrame - beforeFrames;
    const activeEnd = item.startFrame + item.durationInFrames + afterFrames;
    if (frame < activeStart || frame >= activeEnd) continue;

    const localFrame = frame - item.startFrame;
    const clipVol = volumeAtFrame(item, localFrame);
    const fadeGain = clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
    const trackGain = trackGainAt(item.track, frame);
    const crossfadeGain = crossfade ? crossfade.gainAt(frame) : 1;
    const totalGain = parentGain * clipVol * fadeGain * trackGain * crossfadeGain;
    if (totalGain <= 0) continue;

    const sourceFrame = sourceFrameAt(item, localFrame);
    const sourceSeconds = Math.max(0, sourceFrame / fps);
    const playbackRate = item.playbackRate && item.playbackRate > 0 ? item.playbackRate : 1;
    const sampleWindowSeconds = windowSeconds * playbackRate;
    const assetRevision = item.sourceAssetId ? assetById.get(item.sourceAssetId)?.sourceRevision : undefined;

    let clipLeft = 0;
    let clipRight = 0;

    if (item.denoisedSrc && item.src) {
      const mix = voiceIsolationMix(item.denoiseStrength);
      if (mix.dry > 0) {
        const dryEnv = resolveEnvelope(item.src, item.kind, assetRevision);
        const drySample = sampleEnvelopeAtSeconds(dryEnv, sourceSeconds, sampleWindowSeconds);
        clipLeft += drySample.left * mix.dry;
        clipRight += drySample.right * mix.dry;
      }
      if (mix.wet > 0) {
        const wetEnv = resolveEnvelope(item.denoisedSrc, 'audio', assetRevision);
        const wetSample = sampleEnvelopeAtSeconds(wetEnv, sourceSeconds, sampleWindowSeconds);
        clipLeft += wetSample.left * mix.wet;
        clipRight += wetSample.right * mix.wet;
      }
    } else {
      const activeSrc = item.denoisedSrc ?? item.src!;
      const env = resolveEnvelope(activeSrc, item.kind, assetRevision);
      const sample = sampleEnvelopeAtSeconds(env, sourceSeconds, sampleWindowSeconds);
      clipLeft = sample.left;
      clipRight = sample.right;
    }

    const outLeft = clipLeft * totalGain;
    const outRight = clipRight * totalGain;
    leftSq += outLeft * outLeft;
    rightSq += outRight * outRight;
  }

  return { leftSq, rightSq };
}

export function measureTimelineAudioLevelAtFrame({
  state,
  project,
  timelineId,
  frame,
  resolveEnvelope,
}: {
  state: TimelineState;
  project?: ProjectDoc;
  timelineId?: string;
  frame: number;
  resolveEnvelope: AudioEnvelopeResolver;
}): AudioLevelReading {
  const visited = new Set<string>();
  if (timelineId) visited.add(timelineId);
  const { leftSq, rightSq } = accumulateTimelineAudioEnergy({
    state,
    project,
    frame,
    resolveEnvelope,
    visitedTimelines: visited,
  });
  return buildAudioLevelReading(Math.sqrt(leftSq), Math.sqrt(rightSq));
}

// ── Browser Stereo & Waveform Envelope Cache ─────────────────────────────────

interface CachedEnvelopeEntry {
  stereo: AudioStereoEnvelope | null;
  fallback: AudioStereoEnvelope | null;
  stereoPromise: Promise<void> | null;
  fallbackPromise: Promise<void> | null;
  listeners: Set<() => void>;
}

const MAX_ENVELOPE_CACHE_ENTRIES = 36;
const envelopeCache = new Map<string, CachedEnvelopeEntry>();

function cacheKeyFor(src: string, sourceRevision?: string): string {
  return `${src}\u0000${sourceRevision ?? 'v1'}`;
}

function evictOldEnvelopeEntries(): void {
  if (envelopeCache.size <= MAX_ENVELOPE_CACHE_ENTRIES) return;
  for (const [key, entry] of envelopeCache) {
    if (envelopeCache.size <= MAX_ENVELOPE_CACHE_ENTRIES) break;
    if (entry.listeners.size === 0 && !entry.stereoPromise && !entry.fallbackPromise) {
      envelopeCache.delete(key);
    }
  }
}

function notifyEntry(entry: CachedEnvelopeEntry): void {
  for (const listener of entry.listeners) listener();
}

async function decodeBrowserStereoEnvelope(src: string): Promise<AudioStereoEnvelope | null> {
  if (typeof globalThis.fetch !== 'function') return null;
  const AudioCtx = globalThis.AudioContext
    || (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  let ctx: AudioContext | null = null;
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    ctx = new AudioCtx();
    const decoded = await ctx.decodeAudioData(buffer);
    const durationMs = Math.max(1, Math.round(decoded.duration * 1000));
    const bins = Math.max(16, Math.min(36_000, Math.round(decoded.duration * 100)));
    const totalSamples = decoded.length;
    const ch0 = decoded.getChannelData(0);
    const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : ch0;
    const leftPeaks = new Float32Array(bins);
    const rightPeaks = new Float32Array(bins);
    for (let i = 0; i < bins; i += 1) {
      const lo = Math.floor((i / bins) * totalSamples);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) / bins) * totalSamples));
      const stride = Math.max(1, Math.floor((hi - lo) / 64));
      let maxL = 0;
      let maxR = 0;
      for (let s = lo; s < hi; s += stride) {
        const vl = Math.abs(ch0[s] ?? 0);
        const vr = Math.abs(ch1[s] ?? 0);
        if (vl > maxL) maxL = vl;
        if (vr > maxR) maxR = vr;
      }
      leftPeaks[i] = Math.min(1, maxL);
      rightPeaks[i] = Math.min(1, maxR);
    }
    return {
      leftPeaks,
      rightPeaks,
      peaksPerSecond: bins / Math.max(0.001, decoded.duration),
      durationMs,
    };
  } catch {
    return null;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

async function fetchServerWaveformFallback(
  src: string,
  sourceRevision?: string,
): Promise<AudioStereoEnvelope | null> {
  if (!isPreviewable(src) || typeof globalThis.fetch !== 'function') return null;
  try {
    const query = new URLSearchParams({
      src,
      ...(sourceRevision ? { sourceRevision } : {}),
    }).toString();
    const response = await fetch(`/api/waveform?${query}`);
    if (!response.ok) return null;
    const data = await response.json() as { peaks?: number[]; peaksPerSecond?: number; durationMs?: number } | null;
    const peaks = data?.peaks ?? [];
    if (!peaks.length) return null;
    const durationMs = data?.durationMs ?? 0;
    const peaksPerSecond = resolvePeaksPerSecond(peaks, data?.peaksPerSecond, durationMs);
    return {
      leftPeaks: peaks,
      rightPeaks: peaks,
      peaksPerSecond,
      durationMs,
    };
  } catch {
    return null;
  }
}

export function getOrLoadAudioStereoEnvelope(
  src: string,
  _kind: TimelineItem['kind'],
  sourceRevision?: string,
  onReady?: () => void,
): AudioStereoEnvelope | null {
  if (!src) return null;
  const sfx = soundEffectPreview(src);
  if (sfx) {
    return {
      leftPeaks: sfx.peaks,
      rightPeaks: sfx.peaks,
      peaksPerSecond: sfx.peaksPerSecond,
      durationMs: sfx.durationMs,
    };
  }
  const key = cacheKeyFor(src, sourceRevision);
  let entry = envelopeCache.get(key);
  if (!entry) {
    entry = {
      stereo: null,
      fallback: null,
      stereoPromise: null,
      fallbackPromise: null,
      listeners: new Set(),
    };
    envelopeCache.set(key, entry);
    evictOldEnvelopeEntries();
  }
  if (onReady) entry.listeners.add(onReady);

  if (!entry.fallback && !entry.stereo && !entry.fallbackPromise && isPreviewable(src)) {
    const target = entry;
    target.fallbackPromise = fetchServerWaveformFallback(src, sourceRevision)
      .then((env) => {
        if (env) {
          target.fallback = env;
          notifyEntry(target);
        }
      })
      .finally(() => {
        target.fallbackPromise = null;
      });
  }

  if (!entry.stereo && !entry.stereoPromise) {
    const target = entry;
    target.stereoPromise = decodeBrowserStereoEnvelope(src)
      .then((env) => {
        if (env) {
          target.stereo = env;
          notifyEntry(target);
        }
      })
      .finally(() => {
        target.stereoPromise = null;
      });
  }

  return entry.stereo ?? entry.fallback;
}
