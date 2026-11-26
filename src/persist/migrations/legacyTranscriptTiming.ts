// Stage 4 legacy virtual-transcript migration (`L1`–`L5`) -> `track-ssot-v1`.
// This is the ONLY module allowed to inspect legacy virtual-transcript fields
// (`deletedWordIdx`, `silenceFrames`, `cutPadFrames`, `gapCapsMs`, `transcriptPlayOrder`)
// during document upgrade. Runtime playback, preview, and export never touch them.
import type {
  ProjectDoc,
  Timeline,
  TimelineFoldGroup,
  TimelineItem,
  TimelineLegacyTimingReview,
  TimelineLinkGroup,
} from '../../editor/types.js';
import { fitItemToDuration, fitTimelineItems } from '../../editor/clipFit.js';
import { splitItemKeyframes } from '../../editor/keyframes.js';
import { splitPictureAnimationProps } from '../../editor/clipAnimation.js';
import { maintainLinkGroups } from '../../editor/linkGroups.js';
import { reconcileTransitions } from '../../editor/transitionReconcile.js';
import { remapSplitTimelineCaptionReferences } from '../../captions/reconcileSources.js';
import { hasPotentialClipAudio } from '../../../shared/timeline-media-schedule.mjs';
import type { TranscriptVariant, TranscriptWord } from '../../transcript/types.js';
import {
  hasOperationalTranscript,
  itemEditOpts,
  itemWindow,
  keptSegments,
  msToFrame,
  type LegacyEditOpts,
} from './legacyTranscriptSegments.js';

interface LegacyVirtualFields {
  deletedWordIdx?: number[];
  silenceFrames?: number;
  cutPadFrames?: number;
  gapCapsMs?: Record<string, number>;
  transcriptPlayOrder?: number[];
}

type LegacyTimelineItem = TimelineItem & LegacyVirtualFields;

function stripLegacyVirtualFields(item: LegacyTimelineItem): TimelineItem {
  const {
    deletedWordIdx: _deletedWordIdx,
    silenceFrames: _silenceFrames,
    cutPadFrames: _cutPadFrames,
    gapCapsMs: _gapCapsMs,
    transcriptPlayOrder: _transcriptPlayOrder,
    ...clean
  } = item;
  return clean;
}

function hasLegacyVirtualEdits(item: LegacyTimelineItem): boolean {
  return (
    (Array.isArray(item.deletedWordIdx) && item.deletedWordIdx.length > 0)
    || item.silenceFrames != null
    || (item.gapCapsMs != null && Object.keys(item.gapCapsMs).length > 0)
    || (Array.isArray(item.transcriptPlayOrder) && item.transcriptPlayOrder.length > 0)
  );
}

function assetDurationFrames(item: TimelineItem, doc: Pick<ProjectDoc, 'assets'>): number | undefined {
  const matched = (item.sourceAssetId ? doc.assets.find((a) => a.id === item.sourceAssetId) : undefined)
    ?? (item.src ? doc.assets.find((a) => a.src === item.src) : undefined);
  return matched?.durationInFrames != null && Number.isFinite(matched.durationInFrames)
    ? matched.durationInFrames
    : undefined;
}

function itemHasTranscriptOrLegacyFields(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const it = raw as Record<string, unknown>;
  return (
    (Array.isArray(it.transcript) && it.transcript.length > 0)
    || it.deletedWordIdx !== undefined
    || it.silenceFrames !== undefined
    || it.cutPadFrames !== undefined
    || it.gapCapsMs !== undefined
    || it.transcriptPlayOrder !== undefined
  );
}

/** True when any timeline item carries a transcript or legacy virtual-playback field. */
export function hasLegacyTranscriptOrVirtualFields(rawDoc: unknown): boolean {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) return false;
  const doc = rawDoc as { timelines?: unknown; items?: unknown };
  if (Array.isArray(doc.items) && doc.items.some(itemHasTranscriptOrLegacyFields)) return true;
  if (Array.isArray(doc.timelines)) {
    for (const tl of doc.timelines) {
      if (tl && typeof tl === 'object' && Array.isArray((tl as { items?: unknown }).items)) {
        if ((tl as { items: unknown[] }).items.some(itemHasTranscriptOrLegacyFields)) return true;
      }
    }
  }
  return false;
}

function partitionWordsForSegment(
  words: readonly TranscriptWord[],
  segStartFrame: number,
  segEndFrame: number,
  fps: number,
): TranscriptWord[] {
  const startMs = (segStartFrame / fps) * 1000;
  const endMs = (segEndFrame / fps) * 1000;
  return words.filter((w) => {
    if (w.end <= w.start) return w.start >= startMs - 1e-6 && w.start < endMs - 1e-6;
    return Math.min(w.end, endMs) > Math.max(w.start, startMs);
  });
}

function partitionVariantsForWords(
  variants: readonly TranscriptVariant[] | undefined,
  canonicalWords: readonly TranscriptWord[],
  keptWords: readonly TranscriptWord[],
): TranscriptVariant[] | undefined {
  if (!variants?.length || !keptWords.length) return undefined;
  const srcIdxByWord = new Map<TranscriptWord, number>();
  canonicalWords.forEach((w, idx) => srcIdxByWord.set(w, idx));
  return variants.map((variant) => {
    const bySrcIdx = new Map(variant.words.map((vw) => [vw.i, vw.text]));
    const remappedWords = keptWords.flatMap((w, localIdx) => {
      const srcIdx = srcIdxByWord.get(w);
      const text = srcIdx != null ? bySrcIdx.get(srcIdx) : undefined;
      return text !== undefined ? [{ i: localIdx, text }] : [];
    });
    return { ...variant, words: remappedWords };
  });
}

function materializeLegacyEditedItem(
  rawItem: LegacyTimelineItem,
  cleanBase: TimelineItem,
  words: TranscriptWord[],
  deleted: Set<number>,
  fps: number,
  opts: LegacyEditOpts,
  review: NonNullable<TimelineItem['legacyTimingReview']>,
  takenIds: Set<string>,
): { clips: TimelineItem[]; foldGroup?: TimelineFoldGroup } {
  const segs = keptSegments(words, deleted, fps, rawItem.startFrame, opts);
  if (!segs.length) {
    return {
      clips: [{
        ...cleanBase,
        legacyTimingReview: review,
      }],
    };
  }

  let runningOffset = 0;
  const subClips: TimelineItem[] = segs.map((seg, index) => {
    let subId = rawItem.id;
    if (index > 0) {
      let suffix = index;
      subId = `${rawItem.id}_mig_${suffix}`;
      while (takenIds.has(subId)) {
        suffix += 1;
        subId = `${rawItem.id}_mig_${suffix}`;
      }
      takenIds.add(subId);
    }
    const segWords = partitionWordsForSegment(words, seg.srcStartFrame, seg.srcEndFrame, fps);
    const segVariants = partitionVariantsForWords(cleanBase.variants, words, segWords);
    const slicedKf = cleanBase.keyframes
      ? splitItemKeyframes(cleanBase.keyframes, runningOffset)[1]
      : undefined;
    const boundedKf = slicedKf
      ? splitItemKeyframes(slicedKf, seg.durFrames)[0]
      : undefined;
    runningOffset += seg.durFrames;
    const isFirst = index === 0;
    const isLast = index === segs.length - 1;
    return fitItemToDuration({
      ...cleanBase,
      id: subId,
      props: splitPictureAnimationProps(cleanBase, seg.fromFrame - rawItem.startFrame),
      startFrame: seg.fromFrame,
      durationInFrames: seg.durFrames,
      srcInFrame: seg.srcStartFrame,
      fadeInFrames: isFirst ? cleanBase.fadeInFrames : undefined,
      fadeOutFrames: isLast ? cleanBase.fadeOutFrames : undefined,
      transcript: segWords.length ? segWords : cleanBase.transcript,
      ...(segVariants !== undefined ? { variants: segVariants } : {}),
      ...(boundedKf ? { keyframes: boundedKf } : {}),
      legacyTimingReview: review,
    });
  });

  if (subClips.length < 2) {
    return { clips: subClips };
  }

  const minSrc = Math.min(...subClips.map((c) => c.srcInFrame ?? 0));
  const maxSrc = Math.max(...subClips.map((c) => (c.srcInFrame ?? 0) + c.durationInFrames));
  const foldGroup: TimelineFoldGroup = {
    id: `fg_mig_${rawItem.id}`,
    track: cleanBase.track,
    itemIds: subClips.map((c) => c.id),
    collapsed: true,
    label: cleanBase.name,
    sourceTranscript: words,
    transcriptGenerationId: cleanBase.transcriptGenerationId,
    ...(cleanBase.variants ? { sourceVariants: cleanBase.variants } : {}),
    sourceSpan: { srcStartFrame: minSrc, srcEndFrame: maxSrc },
  };
  return { clips: subClips, foldGroup };
}

function sourceKeyOf(item: TimelineItem): string | null {
  if (item.sourceAssetId) return `asset:${item.sourceAssetId}`;
  if (item.src) return `src:${item.src}`;
  return null;
}

function migrateTimeline(timeline: Timeline, doc: Pick<ProjectDoc, 'assets'>): Timeline {
  const fps = Math.max(1, timeline.fps || 30);
  const rawItems = timeline.items as LegacyTimelineItem[];
  const takenIds = new Set(rawItems.map((it) => it.id));

  // Track recovered/known end frames of preceding unedited audio slices per source asset
  // in word timeline order so L3 can recover exact source in-points reliably.
  const audioSiblingsOrdered = rawItems
    .filter((it) => it.kind === 'audio' && hasOperationalTranscript(it) && !hasLegacyVirtualEdits(it))
    .map((it) => ({
      id: it.id,
      sourceKey: sourceKeyOf(it),
      w0Frame: Math.max(0, msToFrame(it.transcript![0]!.start, fps)),
      wNFrame: Math.max(1, msToFrame(it.transcript![it.transcript!.length - 1]!.end, fps)),
    }))
    .sort((a, b) => a.w0Frame - b.w0Frame || a.wNFrame - b.wNFrame || a.id.localeCompare(b.id));

  const recoveredEndByAudioId = new Map<string, number>();
  const latestSiblingEndBySource = new Map<string, { wNFrame: number; endSrcFrame: number }>();
  const l3RecoveredSrcInById = new Map<string, { srcInFrame: number; estimatedDeltaFrames: number }>();

  for (const sib of audioSiblingsOrdered) {
    const rawItem = rawItems.find((it) => it.id === sib.id)!;
    const rawSrcIn = rawItem.srcInFrame ?? 0;
    const dur = Math.max(1, rawItem.durationInFrames);
    const assetDur = assetDurationFrames(rawItem, doc);
    const prev = sib.sourceKey ? latestSiblingEndBySource.get(sib.sourceKey) : undefined;
    const hasPrecedingSibling = !!prev && sib.w0Frame >= prev.wNFrame - 2;
    const precedingEnd = hasPrecedingSibling ? prev!.endSrcFrame : undefined;

    let effectiveSrcIn = rawSrcIn;
    if (rawSrcIn === 0 && (sib.wNFrame > dur + 2 || hasPrecedingSibling)) {
      // Case L3: split transcribed audio whose srcInFrame was reset to 0.
      const inPlaceMatch = (
        rawItem.startFrame > 0
        && sib.w0Frame >= rawItem.startFrame - 2
        && sib.wNFrame <= rawItem.startFrame + dur + 2
        && (assetDur == null || rawItem.startFrame + dur <= assetDur + 2)
        && (precedingEnd == null || rawItem.startFrame >= precedingEnd - 2)
      );
      if (inPlaceMatch) {
        effectiveSrcIn = rawItem.startFrame;
      } else if (
        precedingEnd != null
        && sib.w0Frame >= precedingEnd - 2
        && precedingEnd + dur >= sib.wNFrame - 2
        && (sib.w0Frame - precedingEnd) <= Math.max(2, dur - (sib.wNFrame - sib.w0Frame) + 4)
      ) {
        effectiveSrcIn = Math.max(0, precedingEnd);
      } else {
        effectiveSrcIn = Math.max(
          0,
          assetDur != null ? Math.min(sib.w0Frame, Math.max(0, assetDur - dur)) : sib.w0Frame,
        );
      }
      if (effectiveSrcIn !== rawSrcIn) {
        l3RecoveredSrcInById.set(sib.id, {
          srcInFrame: effectiveSrcIn,
          estimatedDeltaFrames: Math.max(0, sib.w0Frame - effectiveSrcIn),
        });
      }
    }
    const endSrc = effectiveSrcIn + dur;
    recoveredEndByAudioId.set(sib.id, endSrc);
    if (sib.sourceKey) {
      latestSiblingEndBySource.set(sib.sourceKey, {
        wNFrame: Math.max(prev?.wNFrame ?? 0, sib.wNFrame),
        endSrcFrame: Math.max(prev?.endSrcFrame ?? 0, endSrc),
      });
    }
  }

  const nextItems: TimelineItem[] = [];
  const addedFoldGroups: TimelineFoldGroup[] = [];
  const replacedIdsMap = new Map<string, string[]>();
  const affectedItemIds: string[] = [];

  for (const rawItem of rawItems) {
    const cleanBase = stripLegacyVirtualFields(rawItem);
    if (!hasOperationalTranscript(rawItem)) {
      // L1: no operational transcript -> pure track geometry preserved.
      nextItems.push(cleanBase);
      continue;
    }

    const words = rawItem.transcript;
    const deleted = new Set(Array.isArray(rawItem.deletedWordIdx) ? rawItem.deletedWordIdx : []);
    const edited = hasLegacyVirtualEdits(rawItem);

    if (edited && rawItem.kind === 'video') {
      // L5: legacy transcript-edited video clip (visual continuous, audio segmented).
      const review: NonNullable<TimelineItem['legacyTimingReview']> = {
        caseCode: 'L5',
        summary: '旧版文字稿编辑视频片段：旧版画面按连续区间播放而声轨按词切分，已统一转为真实轨道切分，请核对声画切点。',
      };
      if (hasPotentialClipAudio(rawItem)) {
        const res = materializeLegacyEditedItem(
          rawItem,
          cleanBase,
          words,
          deleted,
          fps,
          itemEditOpts(rawItem),
          review,
          takenIds,
        );
        nextItems.push(...res.clips);
        if (res.foldGroup) addedFoldGroups.push(res.foldGroup);
        replacedIdsMap.set(rawItem.id, res.clips.map((c) => c.id));
        affectedItemIds.push(...res.clips.map((c) => c.id));
      } else {
        nextItems.push({ ...cleanBase, legacyTimingReview: review });
        affectedItemIds.push(cleanBase.id);
      }
      continue;
    }

    if (edited && rawItem.kind === 'audio') {
      // L4: legacy transcript-edited audio clip (deleted words / gap compression / play order / pad).
      const review: NonNullable<TimelineItem['legacyTimingReview']> = {
        caseCode: 'L4',
        summary: '旧版删词/压缩停顿片段已转为真实轨道切分，词级时间戳可能与自然气口存在细微偏差，请复核切点。',
        estimatedDeltaFrames: Math.max(1, rawItem.cutPadFrames ?? 1),
      };
      const res = materializeLegacyEditedItem(
        rawItem,
        cleanBase,
        words,
        deleted,
        fps,
        { ...itemEditOpts(rawItem), window: itemWindow(rawItem) },
        review,
        takenIds,
      );
      nextItems.push(...res.clips);
      if (res.foldGroup) addedFoldGroups.push(res.foldGroup);
      replacedIdsMap.set(rawItem.id, res.clips.map((c) => c.id));
      affectedItemIds.push(...res.clips.map((c) => c.id));
      continue;
    }

    // Unedited transcribed clip: distinguish L3 (recovered srcInFrame), L2 (head/tail pause delta), L1 (clean).
    const l3 = l3RecoveredSrcInById.get(rawItem.id);
    if (l3) {
      const review: NonNullable<TimelineItem['legacyTimingReview']> = {
        caseCode: 'L3',
        summary: '旧版切分带稿音频曾丢失源入点（0:00），已按词时间戳与轨道范围恢复源入点，请确认首尾切点。',
        estimatedDeltaFrames: l3.estimatedDeltaFrames,
      };
      nextItems.push(fitItemToDuration({
        ...cleanBase,
        srcInFrame: l3.srcInFrame,
        legacyTimingReview: review,
      }));
      affectedItemIds.push(cleanBase.id);
      continue;
    }

    const rawSrcIn = cleanBase.srcInFrame ?? 0;
    const dur = Math.max(1, cleanBase.durationInFrames);
    const w0Frame = Math.max(0, msToFrame(words[0]!.start, fps));
    const wNFrame = Math.max(w0Frame + 1, msToFrame(words[words.length - 1]!.end, fps));
    const audibleTrack = hasPotentialClipAudio(cleanBase);
    const headDiff = Math.abs(w0Frame - rawSrcIn);
    const tailDiff = Math.abs((rawSrcIn + dur) - wNFrame);
    if (audibleTrack && (headDiff > 6 || tailDiff > 6)) {
      // L2: unedited clip whose recorded head/tail pauses were truncated by legacy word-span audio.
      // Never chop the track clip destructively; keep exact track bounds and flag for optional review.
      nextItems.push({
        ...cleanBase,
        legacyTimingReview: {
          caseCode: 'L2',
          summary: '该未删词带稿片段在旧版曾仅按首尾词区间发声，现按时间轴真实轨道范围完整播放首尾自然停顿，请确认起止位置。',
          estimatedDeltaFrames: Math.max(headDiff, tailDiff),
        },
      });
      affectedItemIds.push(cleanBase.id);
      continue;
    }

    // L1: clean alignment.
    nextItems.push(cleanBase);
  }

  // Update mainClipId, transitions, linkGroups, and captions when L4/L5 expanded a clip into sub-clips.
  let updatedItems = nextItems;
  let updatedTransitions = timeline.transitions;
  let updatedLinkGroups: TimelineLinkGroup[] | undefined = timeline.linkGroups;

  if (replacedIdsMap.size > 0) {
    updatedItems = nextItems.map((it) => {
      if (!it.mainClipId) return it;
      const mapped = replacedIdsMap.get(it.mainClipId);
      if (!mapped?.length) return it;
      return { ...it, mainClipId: mapped[0]! };
    });

    if (updatedTransitions?.length) {
      updatedTransitions = updatedTransitions.map((tr) => {
        const mappedOut = replacedIdsMap.get(tr.outgoingItemId);
        return mappedOut?.length ? { ...tr, outgoingItemId: mappedOut[mappedOut.length - 1]! } : tr;
      });
    }

    if (updatedLinkGroups?.length) {
      updatedLinkGroups = updatedLinkGroups.map((lg) => ({
        ...lg,
        itemIds: lg.itemIds.flatMap((id) => replacedIdsMap.get(id) ?? [id]),
      }));
    }
  }

  const remainingSet = new Set(updatedItems.map((it) => it.id));
  updatedLinkGroups = maintainLinkGroups(updatedLinkGroups, remainingSet);

  const mergedFoldGroups = [
    ...(timeline.foldGroups ?? []),
    ...addedFoldGroups,
  ];

  const uniqueAffected = [...new Set(affectedItemIds)].filter((id) => remainingSet.has(id));
  const legacyTimingReview: TimelineLegacyTimingReview | undefined = uniqueAffected.length
    ? {
        required: true,
        summary: `检测到 ${uniqueAffected.length} 处旧版文字稿切点需要确认（原始工程存档已自动保留）`,
        affectedItemIds: uniqueAffected,
      }
    : undefined;

  let migratedTimeline: Timeline = fitTimelineItems({
    ...timeline,
    items: updatedItems,
    ...(updatedTransitions ? { transitions: reconcileTransitions(updatedItems, updatedTransitions) } : {}),
    ...(updatedLinkGroups !== undefined ? { linkGroups: updatedLinkGroups } : {}),
    ...(mergedFoldGroups.length ? { foldGroups: mergedFoldGroups } : {}),
    ...(legacyTimingReview ? { legacyTimingReview } : {}),
  });

  for (const [oldId, newIds] of replacedIdsMap) {
    for (const rightId of [...newIds.slice(1)].reverse()) {
      migratedTimeline = remapSplitTimelineCaptionReferences(migratedTimeline, oldId, rightId);
    }
  }

  return migratedTimeline;
}

/**
 * Convert a pre-`track-ssot-v1` ProjectDoc to `track-ssot-v1` (idempotent).
 * Plain non-transcribed documents remain untouched.
 */
export function migrateLegacyTranscriptTiming(doc: ProjectDoc): ProjectDoc {
  if (doc.transcriptTimingModel === 'track-ssot-v1') return doc;
  if (!hasLegacyTranscriptOrVirtualFields(doc)) return doc;
  const migratedTimelines = doc.timelines.map((tl) => migrateTimeline(tl, doc));
  return {
    ...doc,
    transcriptTimingModel: 'track-ssot-v1',
    timelines: migratedTimelines,
  };
}
