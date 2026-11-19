import { pictureAnimationTiming } from '../../shared/picture-animation-timing.mjs';

interface TimelineQaState {
  fps: number;
  width: number;
  height: number;
  items: Array<{
    id: string;
    track: string;
    startFrame: number;
    durationInFrames: number;
    kind: string;
    volume?: number;
    audioDetached?: boolean;
    fadeInFrames?: number;
    fadeOutFrames?: number;
    pictureDisabled?: boolean;
    props?: Record<string, unknown>;
  }>;
  transitions?: Array<{
    type: string;
    durationInFrames: number;
    outgoingItemId: string;
    incomingItemId: string;
    trackId: string;
    enabled?: boolean;
  }>;
  tracks?: Record<string, { kind?: 'video' | 'audio' | 'caption'; hidden?: boolean; muted?: boolean; captions?: TimelineQaState['captions'] } | undefined>;
  captions?: {
    enabled: boolean;
    layout?: CaptionQaLayout;
    sourceEntries?: CaptionQaSource[];
    layoutPolicy?: CaptionQaLayoutPolicy | null;
  } | null;
}

interface CaptionQaLayout {
  anchor?: string;
  offsetXRatio?: number;
  offsetYRatio?: number;
}

interface CaptionQaSource extends CaptionQaLayout {
  id: string;
  visible?: boolean;
  slotId?: string;
}

type CaptionQaLayoutPolicy =
  | { mode: 'single-lane' | 'auto-stack'; maxVisibleSources?: number }
  | { mode: 'manual-slots'; slots: Array<CaptionQaLayout & { id: string }> };

function qaTrackKind(state: TimelineQaState, track: string): 'video' | 'audio' | 'caption' {
  const prefix = track.toUpperCase()[0];
  return state.tracks?.[track]?.kind ?? (prefix === 'A' ? 'audio' : prefix === 'C' ? 'caption' : 'video');
}

function qaTimelineDuration(state: TimelineQaState): number {
  const end = state.items.reduce(
    (maximum, item) => Math.max(maximum, item.startFrame + item.durationInFrames),
    0,
  );
  return Math.max(end, state.fps);
}

export type ExportQaSeverity = 'error' | 'warning';

export interface ExportQaInterval {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface ExportQaIssue {
  code: string;
  severity: ExportQaSeverity;
  message: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface ExportQaAnalysis {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  blackFrames: ExportQaInterval[];
  frozenFrames: ExportQaInterval[];
  silence: ExportQaInterval[];
  meanVolumeDb?: number;
  maxVolumeDb?: number;
}

export interface ExportQaExpectations {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  expectsAudio: boolean;
  expectedBlackIntervals?: ExportQaInterval[];
  expectedSilenceIntervals?: ExportQaInterval[];
}

export interface ExportQaReport extends ExportQaAnalysis {
  ok: boolean;
  issues: ExportQaIssue[];
  summary: {
    errors: number;
    warnings: number;
  };
}

/** Merge deterministic timeline findings into the media analysis report. */
export function mergeExportQaIssues(
  report: ExportQaReport,
  additionalIssues: ExportQaIssue[],
): ExportQaReport {
  const keys = new Set(report.issues.map((issue) => [
    issue.code,
    issue.startSeconds ?? '',
    issue.endSeconds ?? '',
    issue.message,
  ].join('|')));
  const issues = [...report.issues];
  for (const issue of additionalIssues) {
    const key = [issue.code, issue.startSeconds ?? '', issue.endSeconds ?? '', issue.message].join('|');
    if (!keys.has(key)) {
      keys.add(key);
      issues.push(issue);
    }
  }
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  return {
    ...report,
    ok: errors === 0,
    issues,
    summary: { errors, warnings: issues.length - errors },
  };
}

function captionPlacements(state: TimelineQaState): CaptionQaLayout[] {
  const placements: CaptionQaLayout[] = [];
  const trackCaptions = Object.values(state.tracks ?? {})
    .filter((track) => track?.kind === 'caption' && track.captions)
    .map((track) => track!.captions!);
  const captionsList = trackCaptions.length ? trackCaptions : state.captions ? [state.captions] : [];
  for (const captions of captionsList.filter((entry) => entry.enabled)) {
    const sources = (captions.sourceEntries ?? []).filter((source) => source.visible !== false);
    if (!sources.length) placements.push(captions.layout ?? {});
    for (const source of sources) {
      const slot = captions.layoutPolicy?.mode === 'manual-slots' && source.slotId
        ? captions.layoutPolicy.slots.find((candidate) => candidate.id === source.slotId)
        : undefined;
      if (slot) placements.push(slot);
      else if (source.anchor || source.offsetXRatio !== undefined || source.offsetYRatio !== undefined) placements.push(source);
      else placements.push(captions.layout ?? {});
    }
  }
  const unique = new Map<string, CaptionQaLayout>();
  for (const placement of placements) {
    const key = `${placement.anchor ?? 'bottom-center'}|${placement.offsetXRatio ?? 0}|${placement.offsetYRatio ?? 0}`;
    unique.set(key, placement);
  }
  return [...unique.values()];
}

/**
 * Check caption placement against the same 5% action-safe frame shown by the
 * preview overlay. Only definite geometry violations are reported so custom
 * layouts near the normal 8–10% title-safe area are not false positives.
 */
export function captionLayoutQaIssues(state: TimelineQaState): ExportQaIssue[] {
  const issues: ExportQaIssue[] = [];
  for (const placement of captionPlacements(state)) {
    const anchor = placement.anchor ?? 'bottom-center';
    const x = Number(placement.offsetXRatio ?? 0);
    const y = Number(placement.offsetYRatio ?? 0);
    const horizontal = anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center';
    const vertical = anchor.startsWith('top')
      ? 'top'
      : (anchor.startsWith('middle') || anchor === 'center') ? 'middle' : 'bottom';

    const horizontalGap = horizontal === 'left' ? 0.1 + x
      : horizontal === 'right' ? 0.1 - x
        : 0.5 - Math.abs(x);
    if (!Number.isFinite(x) || horizontalGap < 0.05) {
      issues.push({
        code: 'caption_safe_area_horizontal',
        severity: 'warning',
        message: `Caption placement ${anchor} crosses the 5% horizontal action-safe boundary.`,
      });
    }

    const verticalGap = vertical === 'middle' ? 0.5 - Math.abs(y) : 0.08 + y;
    if (!Number.isFinite(y) || verticalGap < 0.05 || verticalGap > 0.95) {
      issues.push({
        code: 'caption_safe_area_vertical',
        severity: 'warning',
        message: `Caption placement ${anchor} crosses the 5% vertical action-safe boundary.`,
      });
    }
  }
  return issues;
}

const rounded = (value: number, digits = 3): number => Number(value.toFixed(digits));

function interval(start: number, end: number): ExportQaInterval | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    startSeconds: rounded(start),
    endSeconds: rounded(end),
    durationSeconds: rounded(end - start),
  };
}

function withoutExpectedIntervals(
  measured: readonly ExportQaInterval[],
  fps: number,
  expected: readonly ExportQaInterval[] = [],
): ExportQaInterval[] {
  const guard = 0.5 / Math.max(1, fps);
  const allowed = expected
    .map((value) => ({ start: value.startSeconds + guard, end: value.endSeconds - guard }))
    .filter((value) => value.end > value.start)
    .sort((a, b) => a.start - b.start);
  const result: ExportQaInterval[] = [];
  for (const value of measured) {
    let parts: Array<[number, number]> = [[value.startSeconds, value.endSeconds]];
    for (const window of allowed) {
      parts = parts.flatMap(([start, end]) => {
        if (window.end <= start || window.start >= end) return [[start, end]];
        return [
          ...(window.start > start ? [[start, Math.min(window.start, end)] as [number, number]] : []),
          ...(window.end < end ? [[Math.max(window.end, start), end] as [number, number]] : []),
        ];
      });
      if (!parts.length) break;
    }
    result.push(...parts.map(([start, end]) => ({ startSeconds: start, endSeconds: end, durationSeconds: end - start })));
  }
  return result;
}

interface FrameRange { startFrame: number; endFrameExclusive: number }
interface QaFrameLayer {
  id: string;
  startFrame: number;
  endFrameExclusive: number;
  transparentRanges: Array<[number, number]>;
}

function uncoveredIntentIntervals(
  layers: readonly QaFrameLayer[],
  range: FrameRange,
  fps: number,
): ExportQaInterval[] {
  const boundaries = new Set([range.startFrame, range.endFrameExclusive]);
  for (const layer of layers) {
    for (const frame of [layer.startFrame, layer.endFrameExclusive, ...layer.transparentRanges.flat()]) {
      if (frame > range.startFrame && frame < range.endFrameExclusive) boundaries.add(frame);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const intervals: ExportQaInterval[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const start = sorted[index - 1]!;
    const end = sorted[index]!;
    const middle = (start + end) / 2;
    const active = layers.filter((layer) => middle >= layer.startFrame && middle < layer.endFrameExclusive);
    const fullyVisible = active.some((layer) => !layer.transparentRanges.some(([fadeStart, fadeEnd]) =>
      middle >= fadeStart && middle < fadeEnd));
    // A gap is intentional. A fade can expose black only when it is the sole
    // active layer; any other active layer may cover the gap/fade.
    if (active.length > 1 || (active.length === 1 && fullyVisible)) continue;
    const value = interval((start - range.startFrame) / fps, (end - range.startFrame) / fps);
    if (!value) continue;
    const previous = intervals.at(-1);
    if (previous && Math.abs(previous.endSeconds - value.startSeconds) < 1e-9) {
      previous.endSeconds = value.endSeconds;
      previous.durationSeconds = value.endSeconds - previous.startSeconds;
    } else intervals.push(value);
  }
  return intervals;
}

function frameLayer(
  item: TimelineQaState['items'][number],
  range: FrameRange,
  includePictureFade: boolean,
): QaFrameLayer {
  const endFrameExclusive = item.startFrame + item.durationInFrames;
  const transparentRanges: Array<[number, number]> = [];
  const addTransparent = (start: number, end: number) => {
    const clippedStart = Math.max(range.startFrame, item.startFrame, start);
    const clippedEnd = Math.min(range.endFrameExclusive, endFrameExclusive, end);
    if (clippedEnd > clippedStart) transparentRanges.push([clippedStart, clippedEnd]);
  };
  addTransparent(item.startFrame, item.startFrame + Math.max(0, item.fadeInFrames ?? 0));
  addTransparent(endFrameExclusive - Math.max(0, item.fadeOutFrames ?? 0), endFrameExclusive);
  if (includePictureFade && item.props) {
    const timing = pictureAnimationTiming(item);
    if (item.props.visualEntrance === 'fade' && timing.entrance) {
      addTransparent(item.startFrame + timing.entrance.from, item.startFrame + timing.entrance.until);
    }
    if (item.props.visualExit === 'fade' && timing.exit) {
      addTransparent(item.startFrame + timing.exit.from, item.startFrame + timing.exit.until);
    }
  }
  return {
    id: item.id,
    startFrame: Math.max(range.startFrame, item.startFrame),
    endFrameExclusive: Math.min(range.endFrameExclusive, endFrameExclusive),
    transparentRanges,
  };
}

function uncoveredTransitionBlackIntervals(
  state: TimelineQaState,
  range: FrameRange,
  fps: number,
  visualLayers: readonly QaFrameLayer[],
): ExportQaInterval[] {
  const result: ExportQaInterval[] = [];
  for (const transition of state.transitions ?? []) {
    if (transition.enabled === false || transition.type !== 'dip-to-black'
      || !Number.isSafeInteger(transition.durationInFrames) || transition.durationInFrames <= 0) continue;
    const outgoing = state.items.find((item) => item.id === transition.outgoingItemId);
    const incoming = state.items.find((item) => item.id === transition.incomingItemId);
    if (!outgoing || !incoming || outgoing.track !== incoming.track || outgoing.track !== transition.trackId
      || !visualLayers.some((layer) => layer.id === outgoing.id)
      || !visualLayers.some((layer) => layer.id === incoming.id)) continue;
    const start = incoming.startFrame - Math.floor(transition.durationInFrames / 2);
    const firstBlackFrame = Math.ceil(transition.durationInFrames * 0.45);
    const endBlackFrameExclusive = Math.floor(transition.durationInFrames * 0.55) + 1;
    const candidateStart = Math.max(range.startFrame, start + firstBlackFrame);
    const candidateEnd = Math.min(range.endFrameExclusive, start + endBlackFrameExclusive);
    if (candidateEnd <= candidateStart) continue;

    const blockers = visualLayers.filter((layer) => layer.id !== outgoing.id && layer.id !== incoming.id);
    const boundaries = new Set([candidateStart, candidateEnd]);
    for (const blocker of blockers) {
      if (blocker.startFrame > candidateStart && blocker.startFrame < candidateEnd) boundaries.add(blocker.startFrame);
      if (blocker.endFrameExclusive > candidateStart && blocker.endFrameExclusive < candidateEnd) boundaries.add(blocker.endFrameExclusive);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      const a = sorted[index - 1]!;
      const b = sorted[index]!;
      const middle = (a + b) / 2;
      if (blockers.some((layer) => middle >= layer.startFrame && middle < layer.endFrameExclusive)) continue;
      result.push({ startSeconds: (a - range.startFrame) / fps, endSeconds: (b - range.startFrame) / fps,
        durationSeconds: (b - a) / fps });
    }
  }
  return result;
}

function mergeIntervals(intervals: readonly ExportQaInterval[]): ExportQaInterval[] {
  const result: ExportQaInterval[] = [];
  for (const value of [...intervals].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const previous = result.at(-1);
    if (previous && value.startSeconds <= previous.endSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, value.endSeconds);
      previous.durationSeconds = previous.endSeconds - previous.startSeconds;
    } else result.push({ ...value });
  }
  return result;
}

/** Parse the stable key/value messages emitted by FFmpeg analysis filters. */
export function parseExportQaLog(log: string): Pick<
  ExportQaAnalysis,
  'blackFrames' | 'frozenFrames' | 'silence' | 'meanVolumeDb' | 'maxVolumeDb'
> {
  const blackFrames: ExportQaInterval[] = [];
  const frozenFrames: ExportQaInterval[] = [];
  const silence: ExportQaInterval[] = [];

  for (const match of log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    const value = interval(Number(match[1]), Number(match[2]));
    if (value) blackFrames.push(value);
  }

  const freezeStarts: number[] = [];
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/freeze_start:\s*([\d.]+)/);
    if (start) freezeStarts.push(Number(start[1]));
    const end = line.match(/freeze_end:\s*([\d.]+)(?:\s*\|\s*freeze_duration:\s*([\d.]+))?/);
    if (end && freezeStarts.length) {
      const value = interval(freezeStarts.shift()!, Number(end[1]));
      if (value) frozenFrames.push(value);
    }
  }

  let silenceStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) silenceStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/);
    if (end && silenceStart != null) {
      const value = interval(silenceStart, Number(end[1]));
      if (value) silence.push(value);
      silenceStart = null;
    }
  }

  const mean = [...log.matchAll(/mean_volume:\s*(-?(?:inf|[\d.]+))\s*dB/gi)].at(-1)?.[1];
  const max = [...log.matchAll(/max_volume:\s*(-?(?:inf|[\d.]+))\s*dB/gi)].at(-1)?.[1];
  const parseDb = (value?: string): number | undefined => {
    if (!value || /^-?inf$/i.test(value)) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };

  return {
    blackFrames,
    frozenFrames,
    silence,
    meanVolumeDb: parseDb(mean),
    maxVolumeDb: parseDb(max),
  };
}

/** Turn media measurements into a conservative, structured acceptance report. */
export function assessExportQuality(
  analysis: ExportQaAnalysis,
  expected: ExportQaExpectations,
): ExportQaReport {
  const issues: ExportQaIssue[] = [];
  const add = (issue: ExportQaIssue) => issues.push(issue);

  if (!analysis.hasVideo) {
    add({ code: 'missing_video', severity: 'error', message: 'The exported file has no video stream.' });
  }

  const durationTolerance = Math.max(0.25, 2 / Math.max(1, expected.fps));
  const durationDelta = Math.abs(analysis.durationSeconds - expected.durationSeconds);
  if (durationDelta > durationTolerance) {
    add({
      code: 'duration_mismatch',
      severity: 'error',
      message: `Export duration differs by ${durationDelta.toFixed(2)}s (expected ${expected.durationSeconds.toFixed(2)}s, got ${analysis.durationSeconds.toFixed(2)}s).`,
    });
  }

  if (analysis.hasVideo && (analysis.width !== expected.width || analysis.height !== expected.height)) {
    add({
      code: 'resolution_mismatch',
      severity: 'error',
      message: `Export resolution is ${analysis.width}×${analysis.height}; expected ${expected.width}×${expected.height}.`,
    });
  }

  if (analysis.hasVideo && Math.abs(analysis.fps - expected.fps) > 0.5) {
    add({
      code: 'fps_mismatch',
      severity: 'warning',
      message: `Export frame rate is ${analysis.fps.toFixed(2)} fps; expected ${expected.fps.toFixed(2)} fps.`,
    });
  }

  if (expected.expectsAudio && !analysis.hasAudio) {
    add({ code: 'missing_audio', severity: 'error', message: 'The timeline contains audible media but the export has no audio stream.' });
  }

  for (const black of withoutExpectedIntervals(analysis.blackFrames, expected.fps, expected.expectedBlackIntervals)
    .filter((value) => value.durationSeconds >= 0.2)) {
    const atEdge = black.startSeconds <= 0.08 || black.endSeconds >= analysis.durationSeconds - 0.08;
    if (!atEdge || black.durationSeconds >= 0.75) {
      add({
        code: 'black_frames',
        severity: black.durationSeconds >= 1 ? 'error' : 'warning',
        message: `Black frames detected for ${black.durationSeconds.toFixed(2)}s.`,
        startSeconds: black.startSeconds,
        endSeconds: black.endSeconds,
      });
    }
  }

  for (const frozen of withoutExpectedIntervals(analysis.frozenFrames, expected.fps, expected.expectedBlackIntervals)
    .filter((value) => value.durationSeconds >= 0.75)) {
    add({
      code: 'frozen_frames',
      severity: frozen.durationSeconds >= 3 ? 'error' : 'warning',
      message: `A still/frozen span lasts ${frozen.durationSeconds.toFixed(2)}s; verify that it is intentional.`,
      startSeconds: frozen.startSeconds,
      endSeconds: frozen.endSeconds,
    });
  }

  if (expected.expectsAudio) {
    for (const silent of withoutExpectedIntervals(analysis.silence, expected.fps, expected.expectedSilenceIntervals)
      .filter((value) => value.durationSeconds >= 3)) {
      const atEdge = silent.startSeconds <= 0.1 || silent.endSeconds >= analysis.durationSeconds - 0.1;
      if (!atEdge || silent.durationSeconds >= 5) {
        add({
          code: 'long_silence',
          severity: 'warning',
          message: `Audio is silent for ${silent.durationSeconds.toFixed(2)}s; verify that the gap is intentional.`,
          startSeconds: silent.startSeconds,
          endSeconds: silent.endSeconds,
        });
      }
    }
  }

  if (analysis.maxVolumeDb != null && analysis.maxVolumeDb >= -0.1) {
    add({
      code: 'audio_peak',
      severity: 'warning',
      message: `Audio peaks at ${analysis.maxVolumeDb.toFixed(1)} dBFS and may clip after platform transcoding.`,
    });
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  return { ...analysis, ok: errors === 0, issues, summary: { errors, warnings } };
}

/** Adjacent visual clip boundaries worth inspecting in the final render. */
export function timelineCutTimesSeconds(state: TimelineQaState, maxCuts = 12): number[] {
  const fps = Math.max(1, state.fps);
  const cuts: number[] = [];
  const trackIds = new Set(state.items.map((item) => item.track));
  for (const track of trackIds) {
    if (qaTrackKind(state, track) !== 'video' || state.tracks?.[track]?.hidden) continue;
    const items = state.items
      .filter((item) => item.track === track && item.kind !== 'audio')
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1]!;
      const current = items[index]!;
      const gap = current.startFrame - (previous.startFrame + previous.durationInFrames);
      if (Math.abs(gap) <= 1) cuts.push(current.startFrame / fps);
    }
  }
  return [...new Set(cuts.map((value) => rounded(value, 4)))]
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, Math.min(24, Math.round(maxCuts))));
}

export function exportQaExpectations(
  state: TimelineQaState,
  frameRange?: FrameRange,
): ExportQaExpectations {
  const fps = Math.max(1, state.fps);
  const timelineDuration = qaTimelineDuration(state);
  const startFrame = Math.max(0, Math.min(timelineDuration - 1, Math.floor(frameRange?.startFrame ?? 0)));
  const endFrameExclusive = Math.max(startFrame + 1, Math.min(timelineDuration,
    Math.ceil(frameRange?.endFrameExclusive ?? timelineDuration)));
  const range = { startFrame, endFrameExclusive };
  const overlapsRange = (item: TimelineQaState['items'][number]) =>
    item.startFrame < endFrameExclusive && item.startFrame + item.durationInFrames > startFrame;
  const audibleItems = state.items.filter((item) => {
    const track = state.tracks?.[item.track];
    return !track?.hidden
      && !track?.muted
      && (item.kind === 'audio' || item.kind === 'video')
      && !(item.kind === 'video' && item.audioDetached)
      && (item.volume ?? 1) > 0
      && overlapsRange(item);
  });
  const visibleLayers = state.items.filter((item) => !item.pictureDisabled
    && item.kind !== 'audio' && item.kind !== 'mosaic'
    && qaTrackKind(state, item.track) === 'video'
    && !state.tracks?.[item.track]?.hidden
    && overlapsRange(item));
  const visualLayers = visibleLayers.map((item) => frameLayer(item, range, true));
  const audioLayers = audibleItems.map((item) => frameLayer(item, range, false));
  const expectedBlackIntervals = mergeIntervals([
    ...uncoveredIntentIntervals(visualLayers, range, fps),
    ...uncoveredTransitionBlackIntervals(state, range, fps, visualLayers),
  ]);
  return {
    durationSeconds: (endFrameExclusive - startFrame) / fps,
    width: state.width,
    height: state.height,
    fps,
    expectsAudio: audibleItems.length > 0,
    expectedBlackIntervals,
    expectedSilenceIntervals: uncoveredIntentIntervals(audioLayers, range, fps),
  };
}
