import { buildCues, type CueRow } from './captionCues';
import type { CaptionPreviewTarget } from './captionPreviewTarget';
import { isManualCaptionEntry } from './manualCaptions';
import { effectivePreset } from './renderStyles';
import { orderedCaptionSourceEntries } from './sourceOrder';
import { captionFontKey } from '../fonts/captionFontScope';
import {
  captionsOnTrack,
  timelineTrackIds,
  trackKind,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import type { CaptionsData, CaptionSourceEntry } from './types';

export type CaptionSelectionRef =
  | { trackId: TrackId; kind: 'single'; pageId: string }
  | { trackId: TrackId; kind: 'manual'; laneId: string; cueId: string };

export interface CaptionSelectOptions {
  additive?: boolean;
  preserveWithItems?: boolean;
  toggle?: boolean;
}

export interface SelectedCaptionInspector {
  trackId: TrackId;
  captions: CaptionsData;
  target: CaptionPreviewTarget;
  /** Current multi-selection on this same caption track, for font-only edits. */
  fontTargets?: readonly CaptionPreviewTarget[];
}

export interface ResolvedCaptionSelection extends SelectedCaptionInspector {
  selection: CaptionSelectionRef;
}

const autoCueIndexMemo = new WeakMap<readonly CueRow[], { rows: CueRow[]; byPageId: Map<string, number> }>();
const manualEntryByIdMemo = new WeakMap<CaptionsData, Map<string, CaptionSourceEntry>>();
const manualWordIndexMemo = new WeakMap<CaptionSourceEntry, Map<string, number>>();

function selectableAutomaticCuesIndex(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
): { rows: CueRow[]; byPageId: Map<string, number> } {
  const all = buildCues(captions, items, fps);
  let cached = autoCueIndexMemo.get(all);
  if (!cached) {
    const rows = all.filter((cue) => !cue.manual);
    const byPageId = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 1) {
      const id = rows[i]!.id;
      if (!byPageId.has(id)) byPageId.set(id, i);
    }
    cached = { rows, byPageId };
    autoCueIndexMemo.set(all, cached);
  }
  return cached;
}

function findSourceEntryById(captions: CaptionsData, laneId: string): CaptionSourceEntry | undefined {
  if (!captions.sourceEntries?.length) return undefined;
  let byId = manualEntryByIdMemo.get(captions);
  if (!byId) {
    byId = new Map();
    for (const entry of captions.sourceEntries) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
    manualEntryByIdMemo.set(captions, byId);
  }
  return byId.get(laneId);
}

function manualWordIndexById(entry: CaptionSourceEntry): Map<string, number> | null {
  if (!entry.words) return null;
  let byId = manualWordIndexMemo.get(entry);
  if (!byId) {
    byId = new Map();
    for (let i = 0; i < entry.words.length; i += 1) {
      const id = entry.words[i]?.id;
      if (id && !byId.has(id)) byId.set(id, i);
    }
    manualWordIndexMemo.set(entry, byId);
  }
  return byId;
}

function selectableAutomaticCues(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
): CueRow[] {
  return selectableAutomaticCuesIndex(captions, items, fps).rows;
}

export function captionSelectionRef(trackId: TrackId, target: CaptionPreviewTarget): CaptionSelectionRef {
  return target.kind === 'single'
    ? { trackId, kind: 'single', pageId: target.pageId }
    : { trackId, kind: 'manual', laneId: target.laneId, cueId: target.cueId };
}

export function captionSelectionKey(selection: CaptionSelectionRef | null): string | null {
  if (!selection) return null;
  return selection.kind === 'single'
    ? `${selection.trackId}:single:${selection.pageId}`
    : `${selection.trackId}:manual:${selection.laneId}:${selection.cueId}`;
}

/** Resolve every visible caption cue whose frames intersect a marquee range (or lie on one side of a playhead). */
export function captionSelectionsInFrameRange(
  trackId: TrackId,
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  rangeStartFrame: number,
  rangeEndFrame: number,
  boundaryMode: 'intersect' | 'within' = 'intersect',
): CaptionSelectionRef[] {
  if (!captions.enabled) return [];
  const lo = Math.min(rangeStartFrame, rangeEndFrame);
  const hi = Math.max(rangeStartFrame, rangeEndFrame);
  const candidates: Array<{
    selection: CaptionSelectionRef;
    start: number;
    end: number;
    laneOrder: number;
  }> = [];

  for (const cue of selectableAutomaticCues(captions, items, fps)) {
    candidates.push({
      selection: { trackId, kind: 'single', pageId: cue.id },
      start: cue.start,
      end: cue.end,
      laneOrder: -1,
    });
  }
  for (const [laneOrder, entry] of orderedCaptionSourceEntries(captions.sourceEntries ?? []).entries()) {
    if (!isManualCaptionEntry(entry) || entry.visible === false) continue;
    for (const cue of (entry.words ?? [])) {
      if (!cue.id) continue;
      candidates.push({
        selection: { trackId, kind: 'manual', laneId: entry.id, cueId: cue.id },
        start: cue.start,
        end: cue.end,
        laneOrder,
      });
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter(({ start, end }) => {
      const startFrame = Math.max(0, Math.round(start * fps / 1000));
      const endFrame = Math.max(startFrame + 1, Math.round(end * fps / 1000));
      return boundaryMode === 'within'
        ? startFrame >= lo && endFrame <= hi
        : endFrame > lo && startFrame < hi;
    })
    .sort((a, b) => a.start - b.start
      || a.end - b.end
      || a.laneOrder - b.laneOrder
      || captionSelectionKey(a.selection)!.localeCompare(captionSelectionKey(b.selection)!))
    .flatMap(({ selection }) => {
      const key = captionSelectionKey(selection)!;
      if (seen.has(key)) return [];
      seen.add(key);
      return [selection];
    });
}

/** Select every visible cue on unlocked caption tracks. */
export function allCaptionSelections(state: TimelineState): CaptionSelectionRef[] {
  return timelineTrackIds(state).flatMap((trackId) => {
    if (trackKind(state, trackId) !== 'caption' || state.tracks?.[trackId]?.locked) return [];
    const captions = captionsOnTrack(state, trackId);
    return captions
      ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, 0, Number.MAX_SAFE_INTEGER)
      : [];
  });
}

/** Select every visible cue on unlocked caption tracks before or after `playheadFrame`. */
export function selectableCaptionSelectionsAtPlayheadSide(
  state: TimelineState,
  playheadFrame: number,
  side: 'before' | 'after',
): CaptionSelectionRef[] {
  const frame = Math.max(0, Math.round(playheadFrame));
  const lo = side === 'before' ? 0 : frame;
  const hi = side === 'before' ? frame : Number.MAX_SAFE_INTEGER;
  if (side === 'before' && frame <= 0) return [];
  return timelineTrackIds(state).flatMap((trackId) => {
    if (trackKind(state, trackId) !== 'caption' || state.tracks?.[trackId]?.locked) return [];
    const captions = captionsOnTrack(state, trackId);
    return captions
      ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, lo, hi, 'within')
      : [];
  });
}

/** Select every visible cue on one unlocked caption track before or after `referenceFrame`. */
export function selectableCaptionSelectionsOnTrackSide(
  state: TimelineState,
  trackId: TrackId,
  referenceFrame: number,
  side: 'left' | 'right',
): CaptionSelectionRef[] {
  if (trackKind(state, trackId) !== 'caption' || state.tracks?.[trackId]?.locked) return [];
  const frame = Math.max(0, Math.round(referenceFrame));
  if (side === 'left' && frame <= 0) return [];
  const captions = captionsOnTrack(state, trackId);
  return captions
    ? captionSelectionsInFrameRange(
        trackId,
        captions,
        state.items,
        state.fps,
        side === 'left' ? 0 : frame,
        side === 'left' ? frame : Number.MAX_SAFE_INTEGER,
        'within',
      )
    : [];
}

/** Fallback caption inspector target when no clip or cue is explicitly selected. */
export function resolveFirstCaptionSelection(state: TimelineState): SelectedCaptionInspector | null {
  for (const trackId of timelineTrackIds(state)) {
    if (trackKind(state, trackId) !== 'caption') continue;
    const captions = captionsOnTrack(state, trackId);
    if (!captions?.enabled) continue;
    const first = captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, 0, Number.MAX_SAFE_INTEGER)[0];
    if (!first) continue;
    const resolved = resolveCaptionSelection(state, first);
    if (resolved) return resolved;
  }
  return null;
}

export function resolveCaptionSelection(
  state: TimelineState,
  selection: CaptionSelectionRef | null,
): SelectedCaptionInspector | null {
  if (!selection) return null;
  const captions = captionsOnTrack(state, selection.trackId);
  if (!captions?.enabled) return null;
  const preset = effectivePreset(captions);

  if (selection.kind === 'single') {
    const { rows, byPageId } = selectableAutomaticCuesIndex(captions, state.items, state.fps);
    const cueIndex = byPageId.get(selection.pageId) ?? -1;
    const cue = cueIndex >= 0 ? rows[cueIndex] : undefined;
    return cue ? {
      trackId: selection.trackId,
      captions,
      target: {
        kind: 'single',
        key: `single:${cue.id}`,
        pageId: cue.id,
        cueIndex,
        cue,
        rows,
        preset: { ...preset, ...cue.fontOverride },
        layout: captions.layout,
      },
    } : null;
  }

  const entry = findSourceEntryById(captions, selection.laneId);
  const cueIndex = entry ? (manualWordIndexById(entry)?.get(selection.cueId) ?? -1) : -1;
  const cue = cueIndex >= 0 ? entry?.words?.[cueIndex] : undefined;
  if (!entry || !cue) return null;
  return {
    trackId: selection.trackId,
    captions,
    target: {
      kind: 'manual',
      key: `manual:${entry.id}:${cue.id}`,
      laneId: entry.id,
      cueId: cue.id!,
      cueIndex,
      cue,
      preset: { ...preset, ...entry.style, ...captions.cueFonts?.[captionFontKey(cue.id, undefined)!] },
      layout: {
        ...captions.layout,
        anchor: entry.anchor ?? captions.layout?.anchor,
        offsetXRatio: entry.offsetXRatio ?? captions.layout?.offsetXRatio,
        offsetYRatio: entry.offsetYRatio ?? captions.layout?.offsetYRatio,
        scale: entry.scale ?? captions.layout?.scale,
        rotation: entry.rotation ?? captions.layout?.rotation,
        opacity: entry.opacity ?? captions.layout?.opacity,
        widthRatio: entry.widthRatio ?? captions.layout?.widthRatio,
      },
    },
  };
}

/** Resolve valid selections once, in canonical timeline track/time order. */
export function resolveOrderedCaptionSelections(
  state: TimelineState,
  selections: readonly CaptionSelectionRef[],
): ResolvedCaptionSelection[] {
  const trackOrder = new Map(timelineTrackIds(state).map((trackId, index) => [trackId, index]));
  const seen = new Set<string>();
  const resolved = selections.flatMap((selection) => {
    const key = captionSelectionKey(selection)!;
    if (seen.has(key)) return [];
    seen.add(key);
    const inspector = resolveCaptionSelection(state, selection);
    return inspector ? [{ ...inspector, selection }] : [];
  });
  return resolved.sort((a, b) => {
    const aTrack = trackOrder.get(a.trackId) ?? Number.MAX_SAFE_INTEGER;
    const bTrack = trackOrder.get(b.trackId) ?? Number.MAX_SAFE_INTEGER;
    return aTrack - bTrack
      || a.target.cue.start - b.target.cue.start
      || a.target.cue.end - b.target.cue.end
      || captionSelectionKey(a.selection)!.localeCompare(captionSelectionKey(b.selection)!);
  });
}
