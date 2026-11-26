import type { TimelineItem } from '../editor/types.js';
import { isStableIdentity } from '../transcript/identity.js';
import { areCaptionCuesAdjacent, isManualCaptionEntry } from './manualCaptions.js';
import { msToFrame } from '../transcript/types.js';
import { effectivePreset } from './renderStyles.js';
import {
  applyWordOverrides,
  resolveCaptionProjection,
  wordRefIndexMap,
  type CaptionProjection,
} from './resolve.js';
import { orderedCaptionSourceEntries } from './sourceOrder.js';
import { captionFontKey } from '../fonts/captionFontScope.js';
import { projectCaptionSourceSpans } from './captionSourceSpans.js';
import type { CaptionStyleOverride } from './styles.js';
import {
  CAPTION_MAX_CHARS_PER_LINE,
  CAPTION_MAX_VISUAL_LINES,
  paginate,
  type CaptionPage,
  type CaptionsData,
  type CaptionSourceEntry,
  type CaptionSourceSpan,
  type CaptionWordOverride,
} from './types.js';
import { buildStableOverrideMap, lookupCaptionWordOverride } from './wordOverrides.js';

export interface CaptionPageIdentity {
  id: string;
  laneId: string;
  laneOrder: number;
  entry?: CaptionSourceEntry;
  page: CaptionPage;
  srcIdxs: number[];
  wordRefs: string[];
  manual: boolean;
  displayCueEditId?: string;
  displayCuePartId?: string;
  displayCueSegmentId?: string;
  sourceSpans?: CaptionSourceSpan[];
  fontOverride?: Pick<CaptionStyleOverride, 'fontFamily' | 'fontAssetId'>;
}

const pageId = (laneId: string, refs: readonly string[], page: CaptionPage): string => {
  const stable = refs.length === page.words.length && refs.every(isStableIdentity);
  return stable
    ? `page2:${laneId}:${refs.join('|')}`
    : `legacy:${laneId}:${page.start}:${page.end}:${page.words.map((word) => word.text).join('\u0000')}`;
};

function lanePages(
  captions: CaptionsData,
  entry: CaptionSourceEntry,
  laneOrder: number,
  projection: CaptionProjection,
  globalIndexByRef: ReadonlyMap<string, number>,
  itemsById: ReadonlyMap<string, TimelineItem>,
  stableOverrides: ReadonlyMap<string, CaptionWordOverride>,
  fps: number,
): CaptionPageIdentity[] {
  const { words, wordRefs: refs } = projection;
  // Stable source identity is authoritative. Numeric legacy positions are only
  const sourceIndices = refs.map((ref) => globalIndexByRef.get(ref) ?? -1);
  const indices = isStableIdentity(entry.id) ? sourceIndices.map(() => -1) : sourceIndices;
  const applied = applyWordOverrides(words, indices, captions.wordOverrides, refs);
  const requestedLines = captions.perSource?.[entry.id]?.maxLines;
  const validLines = typeof requestedLines === 'number' && Number.isFinite(requestedLines)
    ? Math.floor(requestedLines)
    : CAPTION_MAX_VISUAL_LINES;
  const lines = Math.max(1, Math.min(CAPTION_MAX_VISUAL_LINES, validLines));
  const preset = entry.style ? { ...effectivePreset(captions), ...entry.style } : effectivePreset(captions);
  const perPage = requestedLines === undefined ? preset.wordsPerPage : Math.max(1, (preset.wordsPerPage ?? 6) * lines);
  const manual = isManualCaptionEntry(entry);
  const coveredRefs = new Set((entry.displayCueEdits ?? []).flatMap((edit) => edit.coveredWordRefs));
  const visible = applied.words.flatMap((word, index) => coveredRefs.has(applied.wordRefs[index] ?? '')
    ? [] : [{ word, index }]);
  const breaks = new Set<number>();
  let visibleIndex = 0;
  for (let index = 0; index < applied.words.length; index += 1) {
    if (coveredRefs.has(applied.wordRefs[index] ?? '')) continue;
    if (applied.breakBefore.has(index)) breaks.add(visibleIndex);
    visibleIndex += 1;
  }
  const pages = manual
    ? visible.map(({ word }) => ({ words: [word], start: word.start, end: word.end }))
    : paginate(visible.map(({ word }) => word), captions.pacing, perPage, breaks, CAPTION_MAX_CHARS_PER_LINE, lines);
  let cursor = 0;
  const source = itemsById.get(entry.itemId);
  const positionByRef = wordRefIndexMap(projection);
  const sourceSpansFor = (refs: readonly string[]): CaptionSourceSpan[] => {
    if (!source?.transcript?.length) return [];
    return refs.flatMap((ref) => {
      const position = positionByRef.get(ref);
      if (position === undefined) return [];
      const sourceIndex = projection.indices[position]!;
      const word = source.transcript![sourceIndex];
      if (!word) return [];
      const override = lookupCaptionWordOverride(captions.wordOverrides, stableOverrides, sourceIndex, ref);
      return [{ wordRef: ref, startMs: word.start, endMs: word.end,
        sourceText: projection.words[position]?.text ?? word.text, ...(override?.timingOffsetMs !== undefined ? { timingOffsetMs: override.timingOffsetMs } : {}) }];
    });
  };
  const automaticPages = pages.map((page) => {
    const projected = visible.slice(cursor, cursor + page.words.length);
    const wordRefs = projected.map(({ index }) => applied.wordRefs[index]!);
    const sourceRefs = [...wordRefs];
    for (const ref of wordRefs) {
      const position = positionByRef.get(ref);
      if (position === undefined) continue;
      const firstOverride = lookupCaptionWordOverride(captions.wordOverrides, stableOverrides, projection.indices[position]!, ref);
      if (!firstOverride?.text || !firstOverride.forceBreak) continue;
      for (let next = position + 1; next < projection.wordRefs.length; next += 1) {
        const nextRef = projection.wordRefs[next]!;
        const nextOverride = lookupCaptionWordOverride(captions.wordOverrides, stableOverrides, projection.indices[next]!, nextRef);
        if (nextOverride?.forceBreak) break;
        if (!nextOverride?.hidden) break;
        sourceRefs.push(nextRef);
      }
    }
    const srcIdxs = wordRefs.map((ref) => globalIndexByRef.get(ref) ?? -1).filter((index) => index >= 0);
    cursor += page.words.length;
    const fontKey = captionFontKey(manual ? page.words[0]?.id : undefined, wordRefs[0]);
    return { id: pageId(entry.id, wordRefs, page), laneId: entry.id, laneOrder, entry, page, srcIdxs, wordRefs, manual,
      sourceSpans: manual ? [] : sourceSpansFor([...new Set(sourceRefs)]),
      fontOverride: fontKey ? captions.cueFonts?.[fontKey] : undefined };
  });
  if (!source || !entry.displayCueEdits?.length) return automaticPages;
  const editedPages: CaptionPageIdentity[] = [];
  for (const edit of entry.displayCueEdits) for (const part of edit.parts) {
    const ranges = new Map<string, { startFrame: number; endFrame: number }>();
    for (const span of projectCaptionSourceSpans(source, part.sourceSpans, fps)) {
      const next = { startFrame: span.startFrame, endFrame: span.endFrame };
      const previous = ranges.get(span.segmentKey);
      ranges.set(span.segmentKey, previous ? { startFrame: Math.min(previous.startFrame, next.startFrame),
        endFrame: Math.max(previous.endFrame, next.endFrame) } : next);
    }
    for (const [segmentIndex, range] of [...ranges.values()].sort((left, right) => left.startFrame - right.startFrame).entries()) {
      if (range.endFrame <= range.startFrame) continue;
      const page = { words: [{ id: `${part.id}:${segmentIndex}`, text: part.text,
        start: range.startFrame * 1000 / fps, end: range.endFrame * 1000 / fps }],
        start: range.startFrame * 1000 / fps, end: range.endFrame * 1000 / fps };
      const id = `display:${entry.id}:${edit.id}:${part.id}:${segmentIndex}`;
      const wordRefs = [...new Set(part.sourceSpans.map((span) => span.wordRef))];
      const srcIdxs = wordRefs.map((ref) => globalIndexByRef.get(ref) ?? -1).filter((index) => index >= 0);
      editedPages.push({ id, laneId: entry.id, laneOrder, entry, page, srcIdxs, wordRefs, manual: false,
        displayCueEditId: edit.id, displayCuePartId: part.id, displayCueSegmentId: id,
        sourceSpans: part.sourceSpans,
        fontOverride: captions.cueFonts?.[captionFontKey(part.id, undefined)!]
          ?? (part.sourceSpans[0]?.wordRef ? captions.cueFonts?.[captionFontKey(undefined, part.sourceSpans[0].wordRef)!] : undefined) });
    }
  }
  return [...automaticPages, ...editedPages].sort((left, right) => left.page.start - right.page.start
    || left.page.end - right.page.end || left.id.localeCompare(right.id));
}

/** Identity-keyed memo for the pure (captions, items, fps) → pages pipeline.
 * Reducers are immutable, so the same items/captions references recur within a
 * state's lifetime — the timeline caption lane re-runs the whole merge +
 * pagination on every render and at every drag start (captionSnapPoints),
 * which is expensive for large merged sources. WeakMap keeps the cache bounded
 * by live state references; every caller treats the output as read-only. */
const captionPagesMemo = new WeakMap<TimelineItem[], WeakMap<CaptionsData, Map<number, CaptionPageIdentity[]>>>();

/** Canonical lane-aware pagination shared by preview, selection, and subtitle export. */
export function buildCaptionPages(captions: CaptionsData, items: TimelineItem[], fps: number): CaptionPageIdentity[] {
  let byCaptions = captionPagesMemo.get(items);
  if (!byCaptions) {
    byCaptions = new WeakMap();
    captionPagesMemo.set(items, byCaptions);
  }
  let byFps = byCaptions.get(captions);
  if (!byFps) {
    byFps = new Map();
    byCaptions.set(captions, byFps);
  }
  const cached = byFps.get(fps);
  if (cached) return cached;
  const pages = computeCaptionPages(captions, items, fps);
  byFps.set(fps, pages);
  return pages;
}

function computeCaptionPages(captions: CaptionsData, items: TimelineItem[], fps: number): CaptionPageIdentity[] {
  const projection = resolveCaptionProjection(captions, items, fps);
  if (captions.sourceEntries?.length) {
    const entries = orderedCaptionSourceEntries(captions.sourceEntries).filter((entry) => entry.visible !== false);
    const globalIndexByRef = new Map(projection.wordRefs.map((ref, index) => [ref, index]));
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const stableOverrides = buildStableOverrideMap(captions.wordOverrides);
    return entries.flatMap((entry, laneOrder) => lanePages(captions, entry, laneOrder, projection.entries!.get(entry)!, globalIndexByRef, itemsById, stableOverrides, fps))
      .sort((left, right) => left.page.start - right.page.start || left.laneOrder - right.laneOrder || left.page.end - right.page.end || left.id.localeCompare(right.id));
  }
  const applied = applyWordOverrides(projection.words, projection.indices, captions.wordOverrides, projection.wordRefs);
  const pages = paginate(applied.words, captions.pacing, effectivePreset(captions).wordsPerPage, applied.breakBefore, CAPTION_MAX_CHARS_PER_LINE, CAPTION_MAX_VISUAL_LINES);
  let cursor = 0;
  return pages.map((page) => {
    const wordRefs = applied.wordRefs.slice(cursor, cursor + page.words.length);
    const srcIdxs = applied.indices.slice(cursor, cursor + page.words.length).filter((index) => index >= 0);
    cursor += page.words.length;
    const fontKey = captionFontKey(undefined, wordRefs[0]);
    return { id: pageId('single', wordRefs, page), laneId: 'single', laneOrder: 0, page, srcIdxs, wordRefs, manual: false,
      fontOverride: fontKey ? captions.cueFonts?.[fontKey] : undefined };
  });
}

// Rightmost page whose start has passed (each lane is start-ordered by
// buildCaptionPages), -1 when none. Binary search replaces the per-frame
// reverse linear scan: O(pages) → O(log pages) per animation tick.
/**
 * Resolve cue start boundaries consistently with timeline track frame rounding so
 * a playhead positioned on the cut/seam between two cues activates the following cue.
 */
export function hasCaptionCueStartedAt(startMs: number, ms: number, fps?: number, prevEndMs?: number): boolean {
  if (startMs <= ms) return true;
  if (!fps || !Number.isFinite(fps) || fps <= 0) return false;
  const frame = Math.max(0, msToFrame(ms, fps));
  if (frame <= 0) return false;
  if (Math.max(0, msToFrame(startMs, fps)) <= frame) return true;
  if (prevEndMs !== undefined && prevEndMs < startMs && areCaptionCuesAdjacent(prevEndMs, startMs, fps)) {
    const seamMs = Math.round((prevEndMs + startMs) / 2);
    return seamMs <= ms || Math.max(0, msToFrame(seamMs, fps)) <= frame;
  }
  return false;
}

export function hasCaptionCueEndedAt(startMs: number, endMs: number, ms: number, fps?: number): boolean {
  if (ms >= endMs) return true;
  if (!fps || !Number.isFinite(fps) || fps <= 0) return false;
  const frame = Math.max(0, msToFrame(ms, fps));
  const startFrame = Math.max(0, msToFrame(startMs, fps));
  const endFrame = Math.max(0, msToFrame(endMs, fps));
  return endFrame > startFrame && frame >= endFrame;
}

function lastStartedIndex(lane: readonly CaptionPageIdentity[], ms: number, fps?: number): number {
  let lo = 0;
  let hi = lane.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const prevEnd = mid > 0 ? lane[mid - 1]!.page.end : undefined;
    if (hasCaptionCueStartedAt(lane[mid].page.start, ms, fps, prevEnd)) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const lanePagesCache = new WeakMap<readonly CaptionPageIdentity[], readonly (readonly CaptionPageIdentity[])[]>();

function cachedLanesForPages(pages: readonly CaptionPageIdentity[]): readonly (readonly CaptionPageIdentity[])[] {
  let lanes = lanePagesCache.get(pages);
  if (!lanes) {
    const byLane = new Map<string, CaptionPageIdentity[]>();
    for (const page of pages) {
      const lane = byLane.get(page.laneId);
      if (lane) lane.push(page);
      else byLane.set(page.laneId, [page]);
    }
    lanes = [...byLane.values()];
    lanePagesCache.set(pages, lanes);
  }
  return lanes;
}

export function activeCaptionPages(pages: readonly CaptionPageIdentity[], ms: number, fps?: number): CaptionPageIdentity[] {
  if (pages.length === 0) return [];
  const lanes = cachedLanesForPages(pages);
  return lanes.flatMap((lane) => {
    if (lane[0]?.manual) {
      // Manual cues may overlap: the latest started page wins while on screen;
      // walk back over expired ones (same result as the reverse linear find).
      let i = lastStartedIndex(lane, ms, fps);
      while (i >= 0) {
        const candidate = lane[i];
        if (!hasCaptionCueEndedAt(candidate.page.start, candidate.page.end, ms, fps)) return [candidate];
        i -= 1;
      }
      return [];
    }
    const i = lastStartedIndex(lane, ms, fps);
    if (i < 0) return [];
    const active = lane[i].page;
    return !hasCaptionCueEndedAt(active.start, active.end, ms, fps) ? [lane[i]] : [];
  }).sort((left, right) => left.laneOrder - right.laneOrder || left.id.localeCompare(right.id));
}
