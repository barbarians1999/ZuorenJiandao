export interface HybridCompatSpan {
  from: number;
  to: number;
  compatAudio: boolean;
  reasons: string[];
  itemNames: string[];
}

export interface ExportCompatSpanDetail {
  fromFrame: number;
  toFrame: number;
  fromSeconds: number;
  toSeconds: number;
  reasons: string[];
  itemNames: string[];
}

export interface ExportRoutePreflight {
  mode: 'fast' | 'segmented' | 'compat';
  totalFrames: number;
  compatFrames: number;
  compatSeconds: number;
  reasons: string[];
  spanDetails: ExportCompatSpanDetail[];
  animatedCaptionWarning: boolean;
  probeStatus?: 'checking' | 'pending-media' | 'probed' | 'local-fallback';
}

export interface OverlayHybridPlanResult {
  eligible: boolean;
  reason?: string;
  renderRoute: 'hybrid' | null;
  hybridMode?: 'segmented-hybrid' | 'overlay-plates';
  fps?: number;
  width?: number;
  height?: number;
  outputWidth?: number;
  outputHeight?: number;
  fit?: string;
  rangeStart?: number;
  rangeEnd?: number;
  frames?: number;
  compatSpans?: HybridCompatSpan[];
  fastSpans?: Array<{ from: number; to: number }>;
  compatFrames?: number;
  compatReasons?: string[];
  baseSegments?: unknown[];
  overlayVideos?: unknown[];
  mosaics?: unknown[];
  visualTrackIds?: string[];
  audioSegments?: unknown[];
  hasCaptions?: boolean;
  hasWatermark?: boolean;
  hasOverlays?: boolean;
  hasUnderlays?: boolean;
  underlayItemIds?: string[];
  state?: unknown;
  _rebuildForExtraCompat?: (extraRawCompatSpans: readonly unknown[]) => OverlayHybridPlanResult;
}

export function planOverlayHybridExport(options?: {
  state?: unknown;
  project?: unknown;
  timelineId?: string;
  codec?: string;
  scale?: number;
  frameRange?: [number, number];
  separateAudioTo?: string;
  allowCompatSpans?: boolean;
}): OverlayHybridPlanResult;

export function formatCompatSpanDetails(
  compatSpans?: readonly HybridCompatSpan[],
  fps?: number,
): ExportCompatSpanDetail[];

export function summarizeExportPreflight(options?: {
  state?: unknown;
  project?: unknown;
  timelineId?: string;
  codec?: string;
  fps?: number;
  frameRange?: [number, number];
  scale?: number;
  hybridPlan?: OverlayHybridPlanResult | null;
  fallbackReason?: string;
  probeStatus?: ExportRoutePreflight['probeStatus'];
}): ExportRoutePreflight;
