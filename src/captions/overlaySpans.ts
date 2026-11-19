import type { TimelineState } from '../editor/timelineTypes.js';
import { captionTrackEntries } from '../editor/timelineTypes.js';
import { activeCaptionPages, buildCaptionPages, type CaptionPageIdentity } from './captionPages.js';
import { laneGroupsFromPages } from './lanes.js';
import { effectivePreset } from './renderStyles.js';
import { activeTranslation, currentWordIndex, LINGER_MS, type CaptionsData } from './types.js';

export interface OverlayCaptionTimingSummary {
  /**Sorted unique cut frames inside [rangeStart, rangeEnd] where static caption state changes.*/
  cutFrames: number[];
  /**Sorted [from, to) half-open animated intervals inside [rangeStart, rangeEnd).*/
  animatedRanges: Array<[number, number]>;
  /**Sorted [from, to) half-open intervals inside [rangeStart, rangeEnd) where >=1 caption is visible.*/
  activeRanges: Array<[number, number]>;
}

const PAGE_ENTER_MS = 180;
const PAGE_EXIT_MS = 120;
const WORD_ENTER_MS = 140;

const clampFrame = (frame: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, frame));

function captionSignatureForTrack(
  captions: CaptionsData,
  pages: CaptionPageIdentity[],
  frame: number,
  fps: number,
): string {
  const ms = (frame / fps) * 1000;
  const basePreset = effectivePreset(captions);
  if (captions.sourceEntries?.length) {
    const groups = laneGroupsFromPages(pages, captions, ms, fps);
    if (!groups?.length) return '';
    return groups.map((group) => group.lanes.map((lane) => {
      const preset = { ...basePreset, ...lane.entry.style, ...lane.fontOverride };
      return `${lane.entry.id}:${lane.pageId}:${preset.wholeLine ? 'w' : lane.curIdx}`;
    }).join(',')).join('|');
  }
  const active = activeCaptionPages(pages, ms, fps)[0];
  if (!active) return '';
  const preset = active.fontOverride ? { ...basePreset, ...active.fontOverride } : basePreset;
  const wordPart = preset.wholeLine ? 'w' : String(currentWordIndex(active.page, ms));
  const tr = captions.bilingual && captions.translation
    ? activeTranslation(captions.translation, ms)
    : null;
  return `${active.id}:${wordPart}:${tr ? `${tr.start}:${tr.text}` : ''}`;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (!ranges.length) return [];
  const sorted = [...ranges].filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** Compute exact static cut boundaries, animated spans, and visibility spans for all enabled caption tracks. */
export function collectOverlayCaptionTiming(
  state: TimelineState,
  rangeStart: number,
  rangeEnd: number,
): OverlayCaptionTimingSummary {
  const cutSet = new Set<number>([rangeStart, rangeEnd]);
  const animated: Array<[number, number]> = [];
  const active: Array<[number, number]> = [];
  if (state.captionsHidden === true || rangeEnd <= rangeStart) {
    return { cutFrames: [rangeStart, rangeEnd], animatedRanges: [], activeRanges: [] };
  }
  const fps = Math.max(1, Number(state.fps) || 30);
  const msToCandidateFrames = (ms: number): number[] => {
    const approx = Math.round((ms / 1000) * fps);
    const out: number[] = [];
    for (let d = -2; d <= 2; d++) out.push(clampFrame(approx + d, rangeStart, rangeEnd));
    return out;
  };
  const pushAnimMs = (fromMs: number, toMs: number) => {
    const a = clampFrame(Math.floor((fromMs / 1000) * fps), rangeStart, rangeEnd);
    const b = clampFrame(Math.ceil((toMs / 1000) * fps) + 1, rangeStart, rangeEnd);
    if (b > a) animated.push([a, b]);
  };

  for (const { id, captions } of captionTrackEntries(state)) {
    if (!captions?.enabled || state.tracks?.[id]?.hidden) continue;
    const pages = buildCaptionPages(captions, state.items, fps);
    if (!pages.length) continue;
    const basePreset = effectivePreset(captions);
    const motion = captions.motionPreset;
    const isPageMotion = motion === 'fade-up' || motion === 'pop';
    const isWordMotion = motion === 'word-pop' || motion === 'karaoke-pulse';

    // Gather every candidate edge timestamp around which visible caption state can change.
    const probeFrames = new Set<number>([rangeStart, rangeEnd - 1]);
    for (const identity of pages) {
      const { page } = identity;
      const preset = identity.entry?.style
        ? { ...basePreset, ...identity.entry.style, ...identity.fontOverride }
        : (identity.fontOverride ? { ...basePreset, ...identity.fontOverride } : basePreset);
      for (const f of msToCandidateFrames(page.start)) probeFrames.add(f);
      for (const f of msToCandidateFrames(page.end)) probeFrames.add(f);
      for (const f of msToCandidateFrames(page.end + LINGER_MS)) probeFrames.add(f);
      if (!preset.wholeLine || isWordMotion) {
        for (const word of page.words) {
          if (!preset.wholeLine) {
            for (const f of msToCandidateFrames(word.start)) probeFrames.add(f);
            for (const f of msToCandidateFrames(word.end)) probeFrames.add(f);
          }
          if (motion === 'word-pop') pushAnimMs(word.start, word.start + WORD_ENTER_MS);
          else if (motion === 'karaoke-pulse') pushAnimMs(word.start, word.end);
        }
      }
      if (isPageMotion) {
        pushAnimMs(page.start, page.start + PAGE_ENTER_MS);
        pushAnimMs(page.end - PAGE_EXIT_MS, page.end);
      }
    }
    if (captions.bilingual && captions.translation?.length) {
      for (const tr of captions.translation) {
        for (const f of msToCandidateFrames(tr.start)) probeFrames.add(f);
        for (const f of msToCandidateFrames(tr.end + LINGER_MS)) probeFrames.add(f);
      }
    }

    // Evaluate signature across contiguous sorted probe windows to detect exact edge cuts & visibility.
    const sortedProbes = [...probeFrames]
      .filter((f) => f >= rangeStart && f < rangeEnd)
      .sort((a, b) => a - b);

    // Check transitions at sortedProbes and between consecutive probes if step === 1.
    let activeStart: number | null = null;
    let prevFrame = -1;
    let prevSig = '';
    for (const f of sortedProbes) {
      // Between prevFrame and f (> 1 apart), no event edge occurred, so prevSig persisted across [prevFrame, f).
      const sig = captionSignatureForTrack(captions, pages, f, fps);
      if (prevFrame < 0) {
        if (sig) activeStart = f;
        prevSig = sig;
        prevFrame = f;
        continue;
      }
      if (sig !== prevSig) {
        // Because candidate probes include +/-2 around every ms edge, prevFrame and f are separated
        // by at most 1 frame when an edge actually falls inside a probe cluster, OR we binary-check the midpoint if apart.
        let cutFrame = f;
        if (f - prevFrame > 1) {
          let lo = prevFrame;
          let hi = f;
          while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (captionSignatureForTrack(captions, pages, mid, fps) === prevSig) lo = mid;
            else hi = mid;
          }
          cutFrame = hi;
        }
        cutSet.add(cutFrame);
        const cutSig = cutFrame === f ? sig : captionSignatureForTrack(captions, pages, cutFrame, fps);
        if (!prevSig && cutSig) activeStart = cutFrame;
        else if (prevSig && !cutSig && activeStart !== null) {
          active.push([activeStart, cutFrame]);
          activeStart = null;
        }
        prevSig = cutSig;
        prevFrame = cutFrame;
      } else {
        prevFrame = f;
      }
    }
    if (activeStart !== null && prevSig) active.push([activeStart, rangeEnd]);
  }

  return {
    cutFrames: [...cutSet].sort((a, b) => a - b),
    animatedRanges: mergeRanges(animated),
    activeRanges: mergeRanges(active),
  };
}
