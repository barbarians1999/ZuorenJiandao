import type {
  TimelineFoldGroup,
  TimelineItem,
  TimelineState,
  TrackId,
} from '../editor/types';
import { fitItemToDuration } from '../editor/clipFit';
import { splitItemKeyframes } from '../editor/keyframes';
import { splitPictureAnimationProps } from '../editor/clipAnimation';
import { applyRippleShifts, linkedItemIds, maintainLinkGroups } from '../editor/linkGroups';
import { mainTrackId } from '../editor/magneticTimeline';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { reconcileTimelineCaptionReferences } from '../captions/reconcileSources';
import { reconcileTransitions } from '../editor/transitionReconcile';
import type { Action } from '../editor/reducerActions';
import { newTranscriptGeneration } from './identity';
import { fillerIndices, wordTimelineFrame } from './edit';
import { hasOperationalTranscript, msToFrame, type TranscriptVariant, type TranscriptWord } from './types';

export interface TranscriptSourceSpan {
  srcStartFrame: number;
  srcEndFrame: number;
}

export interface ResolvedTranscriptUnit {
  unitId: string;
  anchorItemId: string;
  track: TrackId;
  clips: TimelineItem[];
  canonicalWords: TranscriptWord[];
  transcriptGenerationId?: string;
  sourceVariants?: TranscriptVariant[];
  sourceSpan: TranscriptSourceSpan;
  foldGroup?: TimelineFoldGroup;
  /** Currently audible source word indices in timeline playback order. */
  activeWordOrder: number[];
  /** Canonical word indices not covered by any surviving clip window. */
  deletedWordIdx: number[];
  deletedSet: Set<number>;
  /** Non-undefined when timeline playback order differs from ascending source word indices. */
  playOrder?: number[];
  /** Reconstructed per-boundary compressed pause caps in ms (keyed by word index AFTER gap). */
  gapCapsMs: Record<string, number>;
  /** Reconstructed per-word timeline bounds in frames. */
  wordFrameByIndex: Map<number, { fromFrame: number; toFrame: number; clipId: string }>;
}

const GAP_MATCH_TOLERANCE_MS = 25;

function wordOverlapsClipWindow(word: TranscriptWord, winStartMs: number, winEndMs: number): boolean {
  if (winEndMs <= winStartMs) return false;
  if (word.end <= word.start) {
    return word.start >= winStartMs - 1e-6 && word.start < winEndMs - 1e-6;
  }
  const mid = (word.start + word.end) / 2;
  const overlap = Math.min(word.end, winEndMs) - Math.max(word.start, winStartMs);
  return mid >= winStartMs - 1e-6 && mid <= winEndMs + 1e-6 && overlap > 0;
}

function wordsInWindow(words: readonly TranscriptWord[], startMs: number, endMs: number): TranscriptWord[] {
  return words.filter((w) => {
    const overlap = Math.min(w.end, endMs) - Math.max(w.start, startMs);
    if (w.end <= w.start) return w.start >= startMs - 1e-6 && w.start < endMs - 1e-6;
    return overlap > 0;
  });
}

function inferUnitSourceSpan(
  clips: readonly TimelineItem[],
  words: readonly TranscriptWord[],
  fps: number,
  foldGroup?: TimelineFoldGroup,
): TranscriptSourceSpan {
  if (foldGroup?.sourceSpan) return foldGroup.sourceSpan;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const clip of clips) {
    const win = sourceWindowForTimelineRange(clip, 0, clip.durationInFrames);
    minStart = Math.min(minStart, win.startFrame);
    maxEnd = Math.max(maxEnd, win.endFrame);
  }
  if (!Number.isFinite(minStart)) minStart = 0;
  if (!Number.isFinite(maxEnd)) maxEnd = 0;
  const wordFirstStart = words.length ? (words[0]!.start / 1000) * fps : minStart;
  const wordLastEnd = words.length ? (words[words.length - 1]!.end / 1000) * fps : maxEnd;
  return {
    srcStartFrame: Math.min(minStart, foldGroup ? wordFirstStart : minStart),
    srcEndFrame: Math.max(maxEnd, wordLastEnd),
  };
}

/**
 * Derive one logical transcript unit (either a `foldGroup` or a single clip)
 * purely from current timeline clip geometry (`startFrame`, `durationInFrames`, `srcInFrame`, `playbackRate`).
 */
export function resolveTranscriptUnit(
  state: Pick<TimelineState, 'items' | 'foldGroups' | 'fps'>,
  itemId: string,
): ResolvedTranscriptUnit | null {
  const target = state.items.find((it) => it.id === itemId);
  if (!target) return null;

  const group = state.foldGroups?.find((g) => g.itemIds.includes(itemId));
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const clips = (group
    ? group.itemIds.map((id) => byId.get(id)).filter((c): c is TimelineItem => Boolean(c))
    : [target]
  ).sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  if (!clips.length) return null;

  const primary = clips[0]!;
  const canonicalWords = (group?.sourceTranscript?.length ? group.sourceTranscript : primary.transcript) ?? [];
  if (!canonicalWords.length) return null;

  const fps = Math.max(1, state.fps || 30);
  const wordFrameByIndex = new Map<number, { fromFrame: number; toFrame: number; clipId: string }>();
  const clipMatchedIndices = new Map<string, number[]>();
  const activeWordOrder: number[] = [];
  const seenWords = new Set<number>();

  for (const clip of clips) {
    const win = sourceWindowForTimelineRange(clip, 0, clip.durationInFrames);
    const winStartMs = (win.startFrame / fps) * 1000;
    const winEndMs = (win.endFrame / fps) * 1000;
    const matched: number[] = [];
    for (let i = 0; i < canonicalWords.length; i += 1) {
      if (seenWords.has(i)) continue;
      const w = canonicalWords[i]!;
      if (!wordOverlapsClipWindow(w, winStartMs, winEndMs)) continue;
      seenWords.add(i);
      matched.push(i);
      activeWordOrder.push(i);
      const tfStart = wordTimelineFrame(clip, w, fps) ?? clip.startFrame;
      const localEnd = Math.round(
        sourceFramesToTimelineFrames(clip, Math.min(msToFrame(w.end, fps), win.endFrame) - win.startFrame),
      );
      const tfEnd = clip.startFrame + Math.max(tfStart - clip.startFrame + 1, Math.min(clip.durationInFrames, localEnd));
      wordFrameByIndex.set(i, { fromFrame: tfStart, toFrame: Math.max(tfStart + 1, tfEnd), clipId: clip.id });
    }
    clipMatchedIndices.set(clip.id, matched);
  }

  const deletedWordIdx: number[] = [];
  for (let i = 0; i < canonicalWords.length; i += 1) {
    if (!seenWords.has(i)) deletedWordIdx.push(i);
  }

  let chronological = true;
  for (let k = 1; k < activeWordOrder.length; k += 1) {
    if (activeWordOrder[k]! < activeWordOrder[k - 1]!) {
      chronological = false;
      break;
    }
  }

  // Reconstruct any split-compressed pauses across adjacent sub-clips.
  const gapCapsMs: Record<string, number> = {};
  for (let cIdx = 0; cIdx < clips.length - 1; cIdx += 1) {
    const leftClip = clips[cIdx]!;
    const rightClip = clips[cIdx + 1]!;
    const leftWords = clipMatchedIndices.get(leftClip.id) ?? [];
    const rightWords = clipMatchedIndices.get(rightClip.id) ?? [];
    if (!leftWords.length || !rightWords.length) continue;
    const lastGi = leftWords[leftWords.length - 1]!;
    const firstGi = rightWords[0]!;
    if (firstGi !== lastGi + 1) continue;
    const rawGapMs = Math.max(0, canonicalWords[firstGi]!.start - canonicalWords[lastGi]!.end);
    const leftWin = sourceWindowForTimelineRange(leftClip, 0, leftClip.durationInFrames);
    const rightWin = sourceWindowForTimelineRange(rightClip, 0, rightClip.durationInFrames);
    const keptTailMs = Math.max(0, (leftWin.endFrame / fps) * 1000 - canonicalWords[lastGi]!.end);
    const keptHeadMs = Math.max(0, canonicalWords[firstGi]!.start - (rightWin.startFrame / fps) * 1000);
    const timelineGapMs = Math.max(0, ((rightClip.startFrame - (leftClip.startFrame + leftClip.durationInFrames)) / fps) * 1000);
    const appliedMs = Math.min(rawGapMs, Math.max(0, Math.round(keptTailMs + keptHeadMs + timelineGapMs)));
    if (rawGapMs - appliedMs > GAP_MATCH_TOLERANCE_MS) {
      gapCapsMs[String(firstGi)] = appliedMs;
    }
  }

  return {
    unitId: group?.id ?? primary.id,
    anchorItemId: primary.id,
    track: primary.track,
    clips,
    canonicalWords,
    transcriptGenerationId: group?.transcriptGenerationId ?? primary.transcriptGenerationId,
    sourceVariants: group?.sourceVariants ?? primary.variants,
    sourceSpan: inferUnitSourceSpan(clips, canonicalWords, fps, group),
    foldGroup: group,
    activeWordOrder,
    deletedWordIdx,
    deletedSet: new Set(deletedWordIdx),
    playOrder: chronological ? undefined : activeWordOrder,
    gapCapsMs,
    wordFrameByIndex,
  };
}

/** Return unique operational transcript units for a list of items (deduped by foldGroup). */
export function resolveTranscriptUnitsForItems(
  state: Pick<TimelineState, 'items' | 'foldGroups' | 'fps'>,
  items: readonly TimelineItem[],
): ResolvedTranscriptUnit[] {
  const out: ResolvedTranscriptUnit[] = [];
  const seenUnits = new Set<string>();
  const sorted = [...items].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  for (const item of sorted) {
    if (!hasOperationalTranscript(item)) {
      const group = state.foldGroups?.find((g) => g.itemIds.includes(item.id));
      if (!group?.sourceTranscript?.length) continue;
    }
    const unit = resolveTranscriptUnit(state, item.id);
    if (!unit || seenUnits.has(unit.unitId)) continue;
    if (unit.clips.every((c) => c.transcriptStale === true)) continue;
    seenUnits.add(unit.unitId);
    out.push(unit);
  }
  return out;
}

interface SourceMsSpan {
  srcStartMs: number;
  srcEndMs: number;
  wordIndices: number[];
}

function buildSourceMsSpans(
  words: readonly TranscriptWord[],
  deleted: ReadonlySet<number>,
  fps: number,
  sourceSpan: TranscriptSourceSpan,
  opts: {
    playOrder?: readonly number[];
    gapCapsMs?: Readonly<Record<string, number>>;
    silenceFrames?: number;
    cutPadFrames?: number;
  },
): SourceMsSpan[] {
  const rawOrder = opts.playOrder?.length ? opts.playOrder : words.map((_, i) => i);
  const seq = rawOrder.filter((i) => i >= 0 && i < words.length && !deleted.has(i));
  if (!seq.length) return [];

  const halfPadMs = Math.max(0, (Math.floor((opts.cutPadFrames ?? 0) / 2) / fps) * 1000);
  const globalCapMs = opts.silenceFrames != null ? Math.max(0, (opts.silenceFrames / fps) * 1000) : null;
  const fullStartMs = (sourceSpan.srcStartFrame / fps) * 1000;
  const fullEndMs = (sourceSpan.srcEndFrame / fps) * 1000;

  const gapCapMsFor = (nextWordIdx: number): number | null => {
    const key = String(nextWordIdx);
    if (opts.gapCapsMs && Object.prototype.hasOwnProperty.call(opts.gapCapsMs, key)) {
      return Math.max(0, opts.gapCapsMs[key]!);
    }
    return globalCapMs;
  };

  const spans: SourceMsSpan[] = [];
  let si = 0;
  while (si < seq.length) {
    const wi = seq[si]!;
    let srcStartMs = words[wi]!.start;
    let srcEndMs = words[wi]!.end;
    const wordIndices = [wi];
    let sj = si;
    let curWi = wi;
    let capped = false;
    while (sj + 1 < seq.length) {
      const nextWi = seq[sj + 1]!;
      if (nextWi !== curWi + 1) break;
      const nextStartMs = words[nextWi]!.start;
      const gapMs = nextStartMs - srcEndMs;
      if (gapMs < 0) break;
      const capMs = gapCapMsFor(nextWi);
      if (capMs != null && gapMs > capMs + 1) {
        srcEndMs += capMs;
        capped = true;
        break;
      }
      srcEndMs = Math.max(srcEndMs, words[nextWi]!.end);
      wordIndices.push(nextWi);
      curWi = nextWi;
      sj += 1;
    }

    const leftIsCut = (si === 0 && wi > 0) || (si > 0 && seq[si - 1] !== wi - 1);
    const rightIsCut = !capped && (sj + 1 < seq.length ? seq[sj + 1] !== curWi + 1 : curWi + 1 < words.length);
    if (halfPadMs > 0) {
      if (leftIsCut && wi > 0) {
        const silenceMs = Math.max(0, srcStartMs - words[wi - 1]!.end);
        srcStartMs = Math.max(fullStartMs, srcStartMs - Math.min(silenceMs, halfPadMs));
      }
      if (rightIsCut && curWi + 1 < words.length) {
        const silenceMs = Math.max(0, words[curWi + 1]!.start - srcEndMs);
        srcEndMs = Math.min(fullEndMs, srcEndMs + Math.min(silenceMs, halfPadMs));
      }
    }

    // Preserve natural leading/trailing silence whenever edge words remain intact in place.
    if (si === 0 && wi === 0 && !deleted.has(0)) {
      srcStartMs = Math.min(srcStartMs, fullStartMs);
    }
    if (sj === seq.length - 1 && curWi === words.length - 1 && !deleted.has(curWi)) {
      srcEndMs = Math.max(srcEndMs, fullEndMs);
    }

    srcEndMs = Math.max(srcStartMs + (1000 / fps), srcEndMs);
    spans.push({ srcStartMs, srcEndMs, wordIndices });
    si = sj + 1;
  }

  return spans;
}

function makeUniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  const candidate = `${base}_${n}`;
  taken.add(candidate);
  return candidate;
}

function buildTrackSubClips(
  template: TimelineItem,
  spans: readonly SourceMsSpan[],
  canonicalWords: readonly TranscriptWord[],
  sourceVariants: TranscriptVariant[] | undefined,
  generationId: string | undefined,
  fps: number,
  unitStartFrame: number,
  takenIds: Set<string>,
  seedIds: readonly string[],
): TimelineItem[] {
  const rate = template.playbackRate && template.playbackRate > 0 ? template.playbackRate : 1;
  const baseId = seedIds[0] ?? template.id;

  if (!spans.length) {
    // Keep a 1-frame placeholder when all words are deleted so UI "还原全部" remains accessible.
    const id = makeUniqueId(baseId, takenIds);
    return [fitItemToDuration({
      ...template,
      id,
      startFrame: unitStartFrame,
      durationInFrames: 1,
      transcript: [],
      transcriptGenerationId: generationId,
      variants: undefined,
    })];
  }

  const out: TimelineItem[] = [];
  let timelineCursorFloat = unitStartFrame;
  let timelineStartInt = unitStartFrame;
  let accumulatedSrcTimeline = 0;

  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    const srcInFloat = (span.srcStartMs / 1000) * fps;
    const srcInFrame = template.kind === 'audio' || rate !== 1 ? srcInFloat : Math.round(srcInFloat);
    const srcDurFrames = Math.max(1 / fps, ((span.srcEndMs - span.srcStartMs) / 1000) * fps);
    const timelineDurFloat = srcDurFrames / rate;
    timelineCursorFloat += timelineDurFloat;
    const endInt = Math.max(timelineStartInt + 1, Math.round(timelineCursorFloat));
    const durationInFrames = endInt - timelineStartInt;

    const id = i < seedIds.length ? makeUniqueId(seedIds[i]!, takenIds) : makeUniqueId(`${baseId}_s${i + 1}`, takenIds);
    const sliceWords = wordsInWindow(canonicalWords, span.srcStartMs, span.srcEndMs);
    const localKf = template.keyframes
      ? splitItemKeyframes(template.keyframes, Math.round(accumulatedSrcTimeline))?.[0]
      : undefined;
    const subItem: TimelineItem = fitItemToDuration({
      ...template,
      id,
      startFrame: timelineStartInt,
      durationInFrames,
      srcInFrame,
      props: splitPictureAnimationProps(template, Math.round(accumulatedSrcTimeline)),
      fadeInFrames: i === 0 ? template.fadeInFrames : undefined,
      fadeOutFrames: i === spans.length - 1 ? template.fadeOutFrames : undefined,
      transcript: sliceWords,
      transcriptGenerationId: generationId,
      variants: sliceWords.length === canonicalWords.length ? sourceVariants : undefined,
      ...(localKf ? { keyframes: template.keyframes } : {}),
    });
    out.push(subItem);
    timelineStartInt = endInt;
    accumulatedSrcTimeline += timelineDurFloat;
  }

  return out;
}

function buildPartnerSubClips(
  partner: TimelineItem,
  targetClips: readonly TimelineItem[],
  targetUnitStart: number,
  firstTargetClip: TimelineItem,
  targetOldSpan: TranscriptSourceSpan,
  spans: readonly SourceMsSpan[],
  fps: number,
  takenIds: Set<string>,
): TimelineItem[] {
  const tRate = firstTargetClip.playbackRate && firstTargetClip.playbackRate > 0 ? firstTargetClip.playbackRate : 1;
  const pRate = partner.playbackRate && partner.playbackRate > 0 ? partner.playbackRate : 1;
  const anchorSrcDelta = (firstTargetClip.srcInFrame ?? 0) - targetOldSpan.srcStartFrame;
  const partnerOrigStartSrcIn = Math.max(0, (partner.srcInFrame ?? 0) - anchorSrcDelta * (pRate / tRate));
  const partnerLeadOffsetFrames = partner.startFrame - targetUnitStart;

  if (!spans.length) {
    const id = makeUniqueId(partner.id, takenIds);
    return [fitItemToDuration({
      ...partner,
      id,
      startFrame: Math.max(0, targetUnitStart + partnerLeadOffsetFrames),
      durationInFrames: 1,
    })];
  }

  const out: TimelineItem[] = [];
  for (let i = 0; i < targetClips.length; i += 1) {
    const ref = targetClips[i]!;
    const span = spans[i];
    const id = i === 0 ? makeUniqueId(partner.id, takenIds) : makeUniqueId(`${partner.id}_s${i + 1}`, takenIds);
    const spanStartFrame = span ? (span.srcStartMs / 1000) * fps : targetOldSpan.srcStartFrame;
    const srcDeltaTargetFrames = spanStartFrame - targetOldSpan.srcStartFrame;
    const partnerSrcIn = Math.max(0, partnerOrigStartSrcIn + srcDeltaTargetFrames * (pRate / tRate));
    out.push(fitItemToDuration({
      ...partner,
      id,
      startFrame: Math.max(0, ref.startFrame + partnerLeadOffsetFrames),
      durationInFrames: ref.durationInFrames,
      srcInFrame: partner.kind === 'video' && pRate === 1 ? Math.round(partnerSrcIn) : partnerSrcIn,
      fadeInFrames: i === 0 ? partner.fadeInFrames : undefined,
      fadeOutFrames: i === targetClips.length - 1 ? partner.fadeOutFrames : undefined,
    }));
  }
  return out;
}

function remapCaptionsForReplacedUnit(
  state: TimelineState,
  oldIds: ReadonlySet<string>,
  primaryOldId: string,
  newIds: readonly string[],
): TimelineState {
  const mapCaptions = (captions: TimelineState['captions']) => {
    if (!captions || captions.sourceMode === 'timeline') return captions;
    let changed = false;
    let sourceItemId = captions.sourceItemId;
    let sources = captions.sources;
    let sourceEntries = captions.sourceEntries;
    let perSource = captions.perSource;

    if (sourceItemId && oldIds.has(sourceItemId)) {
      sourceItemId = newIds[0] ?? primaryOldId;
      changed = true;
    }
    if (sources?.some((id) => oldIds.has(id))) {
      let inserted = false;
      sources = sources.flatMap((id) => {
        if (!oldIds.has(id)) return [id];
        if (inserted) return [];
        inserted = true;
        return [...newIds];
      });
      changed = true;
    }
    if (sourceEntries?.some((entry) => oldIds.has(entry.itemId))) {
      let inserted = false;
      sourceEntries = sourceEntries.flatMap((entry) => {
        if (!oldIds.has(entry.itemId) || entry.words) return [entry];
        if (inserted) return [];
        inserted = true;
        return newIds.map((newId, idx) => {
          if (idx === 0) return { ...entry, itemId: newId };
          const splitId = `${entry.id}:ssot:${newId}`;
          if (captions.perSource?.[entry.id]) {
            perSource = { ...perSource, [splitId]: { ...captions.perSource[entry.id]! } };
          }
          return { ...entry, id: splitId, itemId: newId };
        });
      });
      changed = true;
    }
    return changed ? { ...captions, sourceItemId, sources, sourceEntries, perSource } : captions;
  };

  const nextCaptions = mapCaptions(state.captions);
  let nextTracks = state.tracks;
  if (state.tracks) {
    let tracksChanged = false;
    const copy = { ...state.tracks };
    for (const [trackId, flags] of Object.entries(state.tracks)) {
      if (!flags?.captions) continue;
      const mapped = mapCaptions(flags.captions);
      if (mapped !== flags.captions) {
        copy[trackId] = { ...flags, captions: mapped };
        tracksChanged = true;
      }
    }
    if (tracksChanged) nextTracks = copy;
  }
  return reconcileTimelineCaptionReferences({ ...state, captions: nextCaptions, tracks: nextTracks });
}

export type TranscriptMutationAction = Extract<
  Action,
  { type: 'toggleWord' | 'deleteWords' | 'cleanScript' | 'setGapCap' | 'setTranscriptPlayOrder' | 'clearEdits' }
>;

/**
 * Compile any word/silence/reorder transcript edit into real timeline track geometry
 * (`TimelineItem[]` + independent `foldGroups`), obeying locks, linked A/V clips,
 * sync locks, main-clip attachments, and caption source bindings.
 */
export function compileTranscriptTrackEdit(
  state: TimelineState,
  action: TranscriptMutationAction,
): TimelineState {
  const unit = resolveTranscriptUnit(state, action.id);
  if (!unit || unit.clips.every((c) => c.transcriptStale === true)) return state;

  const fps = Math.max(1, state.fps || 30);
  const oldUnitIds = unit.clips.map((c) => c.id);
  const oldUnitIdSet = new Set(oldUnitIds);
  const allLinkedIds = new Set(linkedItemIds(state, oldUnitIds));
  const partnerItems = state.items.filter((it) => allLinkedIds.has(it.id) && !oldUnitIdSet.has(it.id)
    && (it.kind === 'audio' || it.kind === 'video'));

  // Obey locked tracks (self or linked partner).
  if (unit.clips.some((c) => state.tracks?.[c.track]?.locked)
    || partnerItems.some((p) => state.tracks?.[p.track]?.locked)) {
    return state;
  }

  const deleted = new Set(unit.deletedWordIdx);
  const gapCapsMs: Record<string, number> = { ...unit.gapCapsMs };
  let playOrder: number[] | undefined = unit.playOrder ? [...unit.playOrder] : undefined;
  let silenceFrames: number | undefined;
  let cutPadFrames: number | undefined;

  switch (action.type) {
    case 'toggleWord': {
      if (action.idx < 0 || action.idx >= unit.canonicalWords.length) return state;
      if (deleted.has(action.idx)) deleted.delete(action.idx);
      else deleted.add(action.idx);
      break;
    }
    case 'deleteWords': {
      let changed = false;
      for (const idx of action.idxs) {
        if (idx >= 0 && idx < unit.canonicalWords.length && !deleted.has(idx)) {
          deleted.add(idx);
          changed = true;
        }
      }
      if (!changed) return state;
      break;
    }
    case 'cleanScript': {
      if (action.removeFillers) {
        for (const idx of fillerIndices(unit.canonicalWords)) deleted.add(idx);
      }
      if (action.replaceGapCaps) {
        for (const key of Object.keys(gapCapsMs)) delete gapCapsMs[key];
        for (const [k, v] of Object.entries(action.gapCapsMs ?? {})) gapCapsMs[k] = v;
      } else if (action.gapCapsMs) {
        for (const [k, v] of Object.entries(action.gapCapsMs)) gapCapsMs[k] = v;
      }
      silenceFrames = action.silenceFrames;
      cutPadFrames = action.cutPadFrames;
      break;
    }
    case 'setGapCap': {
      if (action.afterWordIndex < 0 || action.afterWordIndex >= unit.canonicalWords.length) return state;
      const key = String(action.afterWordIndex);
      if (action.maxMs == null) {
        delete gapCapsMs[key];
      } else {
        gapCapsMs[key] = Math.max(0, Math.round(action.maxMs));
      }
      break;
    }
    case 'setTranscriptPlayOrder': {
      if (action.playOrder == null) {
        if (!playOrder?.length) return state;
        playOrder = undefined;
      } else {
        const cleaned = action.playOrder.filter((i) => Number.isInteger(i) && i >= 0 && i < unit.canonicalWords.length);
        if (!cleaned.length) return state;
        playOrder = cleaned;
      }
      break;
    }
    case 'clearEdits': {
      deleted.clear();
      for (const key of Object.keys(gapCapsMs)) delete gapCapsMs[key];
      playOrder = undefined;
      break;
    }
  }

  const spans = action.type === 'clearEdits'
    ? [{
        srcStartMs: (unit.sourceSpan.srcStartFrame / fps) * 1000,
        srcEndMs: (unit.sourceSpan.srcEndFrame / fps) * 1000,
        wordIndices: unit.canonicalWords.map((_, i) => i),
      }]
    : buildSourceMsSpans(unit.canonicalWords, deleted, fps, unit.sourceSpan, {
        playOrder,
        gapCapsMs,
        silenceFrames,
        cutPadFrames,
      });

  const takenIds = new Set(state.items.map((it) => it.id).filter((id) => !oldUnitIdSet.has(id)
    && !partnerItems.some((p) => p.id === id)));
  const unitStartFrame = unit.clips[0]!.startFrame;
  const oldUnitEnd = Math.max(...unit.clips.map((c) => c.startFrame + c.durationInFrames));
  const template = unit.clips[0]!;

  const newUnitClips = buildTrackSubClips(
    template,
    spans,
    unit.canonicalWords,
    unit.sourceVariants,
    unit.transcriptGenerationId,
    fps,
    unitStartFrame,
    takenIds,
    oldUnitIds,
  );
  const newUnitEnd = Math.max(...newUnitClips.map((c) => c.startFrame + c.durationInFrames));
  const deltaEnd = newUnitEnd - oldUnitEnd;

  // Group linked partner items by track so chained edits rebuild each partner track cleanly once.
  const partnerTracks = new Map<TrackId, TimelineItem[]>();
  for (const partner of partnerItems) {
    const arr = partnerTracks.get(partner.track) ?? [];
    arr.push(partner);
    partnerTracks.set(partner.track, arr);
  }
  const replacedPartnerMap = new Map<string, TimelineItem[]>();
  const oldPartnerIdSet = new Set(partnerItems.map((p) => p.id));
  for (const [, pList] of partnerTracks) {
    pList.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    const headPartner = pList[0]!;
    replacedPartnerMap.set(
      headPartner.id,
      buildPartnerSubClips(headPartner, newUnitClips, unitStartFrame, template, unit.sourceSpan, spans, fps, takenIds),
    );
  }

  const allRemovedIds = new Set([...oldUnitIdSet, ...oldPartnerIdSet]);
  const followerTracks = new Set<TrackId>([unit.track, ...partnerItems.map((p) => p.track)]);
  const mainTrack = mainTrackId(state);

  // Ripple later same-track followers and remap mainClipId attachments.
  const baseShifts = new Map<string, number>();
  if (deltaEnd !== 0) {
    for (const item of state.items) {
      if (allRemovedIds.has(item.id)) continue;
      if (followerTracks.has(item.track) && item.startFrame >= oldUnitEnd) {
        baseShifts.set(item.id, deltaEnd);
      } else if (item.mainClipId && oldUnitIdSet.has(item.mainClipId) && state.interaction?.linkage !== false
        && item.track !== mainTrack) {
        baseShifts.set(item.id, deltaEnd);
      }
    }
  }

  const untouched = state.items.filter((it) => !allRemovedIds.has(it.id));
  const allNewClips = [
    ...newUnitClips,
    ...[...replacedPartnerMap.values()].flat(),
  ];

  let interimState: TimelineState = {
    ...state,
    items: [
      ...untouched.map((item) => {
        if (item.mainClipId && oldUnitIdSet.has(item.mainClipId)) {
          const fallbackTarget = newUnitClips.find((c) => c.startFrame <= item.startFrame
            && c.startFrame + c.durationInFrames > item.startFrame) ?? newUnitClips[0]!;
          return { ...item, mainClipId: fallbackTarget.id };
        }
        return item;
      }),
      ...allNewClips,
    ],
  };

  if (baseShifts.size > 0) {
    const protectedIds = new Set(allNewClips.map((c) => c.id));
    const shifted = applyRippleShifts(interimState, baseShifts, protectedIds);
    if (!shifted) return state;
    interimState = shifted;
  }

  // Update foldGroups strictly independently of linkGroups.
  const nextFoldGroupsBase = (state.foldGroups ?? []).filter((g) => g.id !== unit.foldGroup?.id
    && !g.itemIds.some((id) => oldPartnerIdSet.has(id)));
  const hasDeletedOrReordered = deleted.size > 0 || Boolean(playOrder?.length)
    || Object.keys(gapCapsMs).length > 0 || newUnitClips.length > 1;
  const keepPrimaryFoldGroup = action.type !== 'clearEdits' && hasDeletedOrReordered;

  if (keepPrimaryFoldGroup) {
    nextFoldGroupsBase.push({
      id: unit.foldGroup?.id ?? `fg_${unit.anchorItemId}`,
      track: unit.track,
      itemIds: newUnitClips.map((c) => c.id),
      collapsed: unit.foldGroup?.collapsed ?? true,
      label: unit.foldGroup?.label ?? template.name,
      sourceTranscript: unit.canonicalWords,
      transcriptGenerationId: unit.transcriptGenerationId,
      sourceVariants: unit.sourceVariants,
      sourceSpan: unit.sourceSpan,
    });
  }
  for (const [partnerId, pClips] of replacedPartnerMap) {
    if (pClips.length < 2) continue;
    const origPartner = partnerItems.find((p) => p.id === partnerId)!;
    const origGroup = state.foldGroups?.find((g) => g.itemIds.includes(partnerId));
    nextFoldGroupsBase.push({
      id: origGroup?.id ?? `fg_${partnerId}`,
      track: origPartner.track,
      itemIds: pClips.map((c) => c.id),
      collapsed: origGroup?.collapsed ?? true,
      label: origGroup?.label ?? origPartner.name,
      ...(origPartner.transcript?.length ? {
        sourceTranscript: origPartner.transcript,
        transcriptGenerationId: origPartner.transcriptGenerationId,
      } : {}),
    });
  }

  // Update linked pairs for new partner sub-clips while preserving existing link groups on unaffected items.
  const remainingItemIds = new Set(interimState.items.map((it) => it.id));
  let nextLinkGroups = maintainLinkGroups(state.linkGroups, remainingItemIds) ?? [];
  if (partnerItems.length > 0 && newUnitClips.length > 0) {
    const existingPartnerLinks = state.linkGroups?.filter((g) => g.mode === 'linked'
      && g.itemIds.some((id) => oldUnitIdSet.has(id))) ?? [];
    if (existingPartnerLinks.length > 0) {
      nextLinkGroups = nextLinkGroups.filter((g) => !(g.mode === 'linked' && g.itemIds.some((id) => oldUnitIdSet.has(id))));
      for (let i = 0; i < newUnitClips.length; i += 1) {
        const pairIds = [
          newUnitClips[i]!.id,
          ...[...replacedPartnerMap.values()].map((arr) => arr[i]?.id).filter((id): id is string => Boolean(id)),
        ];
        if (pairIds.length >= 2) {
          nextLinkGroups.push({
            id: `lg_ssot_${newUnitClips[i]!.id}`,
            itemIds: pairIds,
            anchorItemId: pairIds[0]!,
            mode: 'linked',
          });
        }
      }
    }
  }

  const nextSelectedIds = (state.selectedIds ?? (state.selectedId ? [state.selectedId] : []))
    .filter((id) => !oldUnitIdSet.has(id));
  if (state.selectedId && oldUnitIdSet.has(state.selectedId) && newUnitClips[0]) {
    nextSelectedIds.push(newUnitClips[0].id);
  }
  const uniqueSelected = [...new Set(nextSelectedIds)].filter((id) => remainingItemIds.has(id));

  let nextState: TimelineState = {
    ...interimState,
    items: interimState.items.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)),
    foldGroups: nextFoldGroupsBase.length ? nextFoldGroupsBase : undefined,
    linkGroups: nextLinkGroups.length ? nextLinkGroups : undefined,
    selectedIds: uniqueSelected,
    selectedId: uniqueSelected[uniqueSelected.length - 1] ?? null,
  };

  nextState = remapCaptionsForReplacedUnit(nextState, oldUnitIdSet, unit.anchorItemId, newUnitClips.map((c) => c.id));
  nextState = {
    ...nextState,
    transitions: reconcileTransitions(nextState.items, nextState.transitions ?? []),
  };
  return nextState;
}

/** Update word text or speaker or variants consistently across a unit and its foldGroup. */
export function updateUnitTranscriptMetadata(
  state: TimelineState,
  itemId: string,
  updater: (words: TranscriptWord[], variants: TranscriptVariant[] | undefined) => {
    words?: TranscriptWord[];
    variants?: TranscriptVariant[];
    generationId?: string;
    clearVariants?: boolean;
  } | null,
): TimelineState {
  const unit = resolveTranscriptUnit(state, itemId);
  if (!unit || unit.clips.every((c) => c.transcriptStale === true)) return state;
  const result = updater(unit.canonicalWords, unit.sourceVariants);
  if (!result) return state;

  const nextCanonical = result.words ?? unit.canonicalWords;
  const nextVariants = result.clearVariants ? undefined : (result.variants ?? unit.sourceVariants);
  const nextGenId = result.generationId ?? unit.transcriptGenerationId;
  const fps = Math.max(1, state.fps || 30);
  const unitIds = new Set(unit.clips.map((c) => c.id));

  return {
    ...state,
    items: state.items.map((item) => {
      if (!unitIds.has(item.id)) return item;
      const win = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
      const startMs = (win.startFrame / fps) * 1000;
      const endMs = (win.endFrame / fps) * 1000;
      return {
        ...item,
        transcript: unit.clips.length === 1 && !unit.foldGroup ? nextCanonical : wordsInWindow(nextCanonical, startMs, endMs),
        transcriptGenerationId: nextGenId,
        transcriptStale: false,
        ...(result.clearVariants
          ? { variants: undefined }
          : nextVariants !== undefined
            ? { variants: nextVariants }
            : {}),
      };
    }),
    foldGroups: state.foldGroups?.map((g) => (g.id === unit.foldGroup?.id
      ? {
          ...g,
          sourceTranscript: nextCanonical,
          transcriptGenerationId: nextGenId,
          sourceVariants: nextVariants,
        }
      : g)),
  };
}

export function assignTranscriptToClipOrUnit(
  state: TimelineState,
  itemId: string,
  rawWords: TranscriptWord[],
): TimelineState {
  const patch = newTranscriptGeneration(rawWords);
  const group = state.foldGroups?.find((g) => g.itemIds.includes(itemId));
  if (!group) {
    // Per track-SSOT rule: setting/regenerating transcript NEVER alters srcInFrame or durationInFrames.
    return {
      ...state,
      items: state.items.map((it) => (it.id === itemId
        ? {
            ...it,
            ...patch,
            transcriptStale: false,
            variants: undefined,
          }
        : it)),
    };
  }
  const fps = Math.max(1, state.fps || 30);
  const memberIds = new Set(group.itemIds);
  return {
    ...state,
    items: state.items.map((it) => {
      if (!memberIds.has(it.id)) return it;
      const win = sourceWindowForTimelineRange(it, 0, it.durationInFrames);
      return {
        ...it,
        transcript: wordsInWindow(patch.transcript, (win.startFrame / fps) * 1000, (win.endFrame / fps) * 1000),
        transcriptGenerationId: patch.transcriptGenerationId,
        transcriptStale: false,
        variants: undefined,
      };
    }),
    foldGroups: state.foldGroups?.map((g) => (g.id === group.id
      ? {
          ...g,
          sourceTranscript: patch.transcript,
          transcriptGenerationId: patch.transcriptGenerationId,
          sourceVariants: undefined,
        }
      : g)),
  };
}
