import type { TimelineItem } from '../editor/types';
import { buildCues, cueTextPatch, type CueRow } from './captionCues';
import { captionSelectionKey, type CaptionSelectionRef } from './captionSelection';
import { appendManualCue, isManualCaptionEntry, newManualEntry, promoteCaptionEntries, removeManualCue, updateManualCue } from './manualCaptions';
import type { CaptionsData } from './types';

/** List identity survives text correction, pagination changes, and source retiming. */
export function captionListId(row: CueRow): string {
  if (row.displayCueSegmentId) return `${row.laneId}:display:${row.displayCueSegmentId}`;
  const manualId = row.manualIndex == null ? undefined : row.entry?.words?.[row.manualIndex]?.id;
  return `${row.laneId}:${row.manual ? 'manual' : 'word'}:${manualId ?? row.wordRefs[0] ?? row.id}`;
}

export function captionListSelection(trackId: string, row: CueRow): CaptionSelectionRef | null {
  if (!row.manual) return { trackId, kind: 'single', pageId: row.id };
  const cueId = row.manualIndex == null ? undefined : row.entry?.words?.[row.manualIndex]?.id;
  return cueId ? { trackId, kind: 'manual', laneId: row.laneId, cueId } : null;
}

export function selectedCaptionListIds(trackId: string, rows: readonly CueRow[], selected: readonly CaptionSelectionRef[]): string[] {
  const keys = new Set(selected.map(captionSelectionKey));
  return rows.filter((row) => {
    const selection = captionListSelection(trackId, row);
    return selection && keys.has(captionSelectionKey(selection));
  }).map(captionListId);
}

export function captionListRange(rows: readonly CueRow[], anchor: string | null, target: string): string[] {
  const last = rows.findIndex((row) => captionListId(row) === target);
  if (last < 0) return [];
  const first = rows.findIndex((row) => captionListId(row) === anchor);
  return rows.slice(Math.min(first < 0 ? last : first, last), Math.max(first < 0 ? last : first, last) + 1).map(captionListId);
}

export interface CaptionListEdit { id: string; text: string | null; start?: number; end?: number; }

/** Apply a complete user action through ONE caption patch, retaining linked source-word mappings. */
export function captionListPatch(captions: CaptionsData, items: TimelineItem[], fps: number,
  edits: readonly CaptionListEdit[]): Partial<CaptionsData> | null {
  const rows = buildCues(captions, items, fps);
  const rowById = new Map(rows.map((row, index) => [captionListId(row), { row, index }]));
  let current = captions;
  let result: Partial<CaptionsData> | null = null;
  for (const edit of edits) {
    const found = rowById.get(edit.id);
    if (!found) continue;
    const { row, index } = found;
    const text = edit.text?.trim() ?? '';
    if (text === row.text && edit.start === undefined && edit.end === undefined) continue;
    let patch: Partial<CaptionsData> | null;
    if (row.manual) {
      const original = row.manualIndex == null ? undefined : row.entry?.words?.[row.manualIndex];
      const words = current.sourceEntries?.find((entry) => entry.id === row.laneId)?.words;
      const liveIndex = original?.id ? words?.findIndex((word) => word.id === original.id) ?? -1 : -1;
      if (!original || liveIndex < 0) continue;
      patch = !text ? removeManualCue(current, row.laneId, liveIndex)
        : updateManualCue(current, row.laneId, liveIndex, text, edit.start ?? original.start, edit.end ?? original.end);
    } else {
      // Never turn a source transcript into fixed-time standalone subtitles.
      patch = cueTextPatch(current, rows, index, text);
    }
    if (!patch) continue;
    result = { ...(result ?? {}), ...patch };
    current = { ...current, ...patch };
  }
  return result;
}

export function captionReplaceEdits(rows: readonly CueRow[], find: string, replacement: string): CaptionListEdit[] {
  if (!find) return [];
  const literal = find.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(literal, 'giu');
  return rows.flatMap((row) => {
    const text = row.text.replace(pattern, () => replacement);
    return text === row.text ? [] : [{ id: captionListId(row), text }];
  });
}

const DEFAULT_ADDED_CUE_MS = 2_000;
const MIN_GAP_ADDED_CUE_MS = 200;

function availableCueEndMs(words: readonly { start: number; end: number }[], startMs: number): number | null {
  const overlap = words.some((word) => word.start < startMs + MIN_GAP_ADDED_CUE_MS && word.end > startMs);
  if (overlap) return null;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const word of words) {
    if (word.start >= startMs + MIN_GAP_ADDED_CUE_MS && word.start < nextStart) nextStart = word.start;
  }
  return Math.round(Math.min(startMs + DEFAULT_ADDED_CUE_MS, nextStart));
}

/** Insert a new manual subtitle cue immediately after the given list row without mutating transcripts. */
export function appendCaptionCueAfter(
  captions: CaptionsData,
  items: TimelineItem[],
  fps: number,
  rowId: string,
  defaultText: string,
): { patch: Partial<CaptionsData>; cueId: string } | null {
  const cleanText = defaultText.trim();
  if (!cleanText) return null;
  const rows = buildCues(captions, items, fps);
  const row = rows.find((candidate) => captionListId(candidate) === rowId);
  if (!row) return null;
  const startMs = Math.max(0, Math.round(row.end));
  const entries = promoteCaptionEntries(captions, items);
  const baseCaptions: CaptionsData = { ...captions, enabled: true, sourceEntries: entries, sources: undefined, sourceMode: 'item', words: undefined };

  const manualLanes = entries.filter(isManualCaptionEntry);
  const preferredLane = row.manual ? manualLanes.find((entry) => entry.id === row.laneId) : undefined;
  const candidateLanes = preferredLane ? [preferredLane, ...manualLanes.filter((entry) => entry.id !== preferredLane.id)] : manualLanes;

  let targetLaneId: string | null = null;
  let endMs = startMs + DEFAULT_ADDED_CUE_MS;
  let workingCaptions = baseCaptions;

  for (const lane of candidateLanes) {
    const candidateEnd = availableCueEndMs(lane.words ?? [], startMs);
    if (candidateEnd !== null) {
      targetLaneId = lane.id;
      endMs = candidateEnd;
      break;
    }
  }

  if (!targetLaneId) {
    const fresh = newManualEntry(manualLanes.length + 1);
    targetLaneId = fresh.id;
    workingCaptions = { ...baseCaptions, sourceEntries: [...entries, fresh] };
  }

  const prevIds = new Set((workingCaptions.sourceEntries?.find((entry) => entry.id === targetLaneId)?.words ?? []).map((word) => word.id).filter(Boolean));
  const cuePatch = appendManualCue(workingCaptions, targetLaneId, cleanText, startMs, endMs);
  if (!cuePatch) return null;
  const fullPatch: Partial<CaptionsData> = { enabled: true, ...cuePatch };
  const created = fullPatch.sourceEntries?.find((entry) => entry.id === targetLaneId)?.words?.find((word) => word.id && !prevIds.has(word.id));
  if (!created?.id) return null;
  return { patch: fullPatch, cueId: created.id };
}
