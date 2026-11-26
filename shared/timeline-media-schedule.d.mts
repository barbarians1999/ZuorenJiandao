export const AUDIO_RATIONAL_DENOMINATOR: 48000;
export const AUDIO_DEFAULT_SAMPLE_RATE: 48000;

export interface ClipSourceWindow {
  playbackRate: number;
  srcInFrameExact: number;
  srcEndFrameExact: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  timelineStartSec: number;
  timelineEndSec: number;
  sourceStartSec: number;
  sourceDurationSec: number;
  sourceStartSample: number;
  sourceDurationSamples: number;
}

export interface AudioSampleWindow {
  startSample: number;
  endSample: number;
  durationSamples: number;
}

export interface CrossfadeCurve {
  direction: 'in' | 'out';
  startFrame: number;
  duration: number;
}

export interface ItemCrossfadePlan {
  beforeFrames: number;
  afterFrames: number;
  curves: CrossfadeCurve[];
}

export interface AudioCrossfadeHandlePlan {
  beforeFrames: number;
  afterFrames: number;
  requestedBeforeFrames: number;
  requestedAfterFrames: number;
  hasFullHandles: boolean;
}

export interface ScheduledAudioSegment {
  itemId: string;
  src: string;
  timelineStartFrame: number;
  frames: number;
  timelineStartSample: number;
  timelineEndSample: number;
  durationSamples: number;
  sourceFrame: number;
  sourceStartSec: number;
  playbackRate: number;
  itemDuration: number;
  offsetInItem: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  gain: number;
  fromVideo: boolean;
  duckIntervals?: Array<[number, number]>;
  duckFactor?: number;
  crossfades?: Array<{ direction: 'in' | 'out'; startFrame: number; durationFrames: number }>;
  volumeKeyframes?: Array<{ frame: number; value: number }>;
}

export interface TrackRoutingResult {
  trackIdsInOrder: string[];
  audioTrackIds: string[];
  anyAudioSolo: boolean;
  anchorRanges: Array<[number, number]>;
  isTrackHidden: (trackId: string) => boolean;
  isTrackMuted: (trackId: string) => boolean;
  isTrackAudible: (trackId: string) => boolean;
  trackLinearGain: (trackId: string) => number;
  duckFactorForTrack: (trackId: string) => number;
  gainAt: (trackId: string, frame: number) => number;
}

export interface AssetIndex {
  byId: Map<string, { id?: string; src?: string; durationInFrames?: number }>;
  bySrc: Map<string, { id?: string; src?: string; durationInFrames?: number }>;
}

export function normalizePlaybackRate(rawRate: unknown): number;
export function normalizeSrcInFrame(rawSrcInFrame: unknown): number;
export function resolveClipSourceWindow(
  item: { startFrame?: number; durationInFrames?: number; srcInFrame?: number; playbackRate?: number } | null | undefined,
  fps?: number,
  sampleRate?: number,
): ClipSourceWindow;
export function computeAudioSampleWindow(
  timelineStartFrame: number,
  timelineEndFrame: number,
  rangeStart?: number,
  fps?: number,
  sampleRate?: number,
): AudioSampleWindow;
export function voiceIsolationMix(strength: unknown): { dry: number; wet: number };
export function mergeFrameRanges(ranges: ReadonlyArray<readonly [number, number]>, boundStart?: number, boundEnd?: number): Array<[number, number]>;
export function trackKindForSchedule(state: unknown, id: string): 'video' | 'audio' | 'caption';
export function isVisualOverlayItemVisible(state: unknown, item: unknown): boolean;
export function hasPotentialClipAudio(item: unknown): boolean;
export function resolveTrackRouting(
  state: unknown,
  options?: {
    forceMuted?: boolean;
    anchorItems?: readonly unknown[];
    rangeStart?: number;
    rangeEnd?: number;
  },
): TrackRoutingResult;
export function buildAssetIndex(assets?: readonly unknown[]): AssetIndex;
export function findSourceAsset(item: unknown, assetIndex: AssetIndex): { id?: string; src?: string; durationInFrames?: number } | undefined;
export function planAudioCrossfadeFromIndex(
  outgoing: unknown,
  incoming: unknown,
  transition: unknown,
  assetIndex: AssetIndex,
  options?: { hasZeroHandles?: (item: unknown) => boolean },
): AudioCrossfadeHandlePlan;
export function resolveAudioCrossfadePlans(
  audioItems: readonly unknown[],
  audioTransitions?: readonly unknown[],
  assets?: readonly unknown[],
  options?: { hasZeroHandles?: (item: unknown) => boolean },
): Map<string, ItemCrossfadePlan>;
export function evaluateCrossfadeGainAt(curves: readonly CrossfadeCurve[] | undefined, absoluteFrame: number): number;
export function compileAudioSchedule(
  state: unknown,
  options?: {
    audioItems?: readonly unknown[];
    audioTransitions?: readonly unknown[];
    rangeStart?: number;
    rangeEnd?: number;
    sampleRate?: number;
    crossfadePlans?: Map<string, ItemCrossfadePlan>;
    routing?: TrackRoutingResult;
  },
): {
  routing: TrackRoutingResult;
  crossfadePlans: Map<string, ItemCrossfadePlan>;
  audioSegments: ScheduledAudioSegment[];
};
