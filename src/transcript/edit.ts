import { msToFrame, type TranscriptVariant, type TranscriptWord } from './types';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../editor/sourceLimit';

// Fixed filler tokens clean_script strips ("mechanical clean" — no LLM).
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mmm', '嗯', '呃', '啊', '唔', '额']);

export function isFiller(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z一-鿿]/g, '');
  return t.length > 0 && FILLER.has(t);
}

/** Indices of filler words in a transcript (for clean_script filler removal). */
export function fillerIndices(words: TranscriptWord[]): number[] {
  const idxs: number[] = [];
  for (let i = 0; i < words.length; i++) if (isFiller(words[i].text)) idxs.push(i);
  return idxs;
}

export interface ClipTranscriptSlice {
  transcript?: TranscriptWord[];
  variants?: TranscriptVariant[];
}

/**
 * Partition a clip's transcript metadata at a source-frame boundary so each
 * half of a razor split retains the words belonging to its own source window
 * without changing word timing or `transcriptGenerationId`.
 */
export function partitionClipTranscriptAtSourceFrame(
  clip: ClipTranscriptSlice,
  fps: number,
  splitSourceFrame: number,
): { k: number; left: ClipTranscriptSlice; right: ClipTranscriptSlice } | null {
  const words = clip.transcript;
  if (!words?.length) return null;
  const boundaryFrame = Math.round(splitSourceFrame);
  let k = words.length;
  for (let i = 0; i < words.length; i++) {
    if (msToFrame(words[i]!.start, fps) >= boundaryFrame) {
      k = i;
      break;
    }
  }
  const pickVariants = (keep: (i: number) => boolean, rebase: (i: number) => number) =>
    (clip.variants ?? [])
      .map((v) => ({ ...v, words: v.words.filter((w) => keep(w.i)).map((w) => ({ ...w, i: rebase(w.i) })) }))
      .filter((v) => v.words.length > 0);
  const undefIfEmptyArr = <T,>(a: T[]) => (a.length ? a : undefined);
  return {
    k,
    left: {
      transcript: words.slice(0, k),
      variants: undefIfEmptyArr(pickVariants((i) => i < k, (i) => i)),
    },
    right: {
      transcript: words.slice(k),
      variants: undefIfEmptyArr(pickVariants((i) => i >= k, (i) => i - k)),
    },
  };
}

export interface MediaWindowItem {
  startFrame: number;
  durationInFrames: number;
  srcInFrame?: number;
  playbackRate?: number;
}

/** Project words overlapping a clip's continuous [srcIn, srcEnd) window onto timeline ms. */
export function projectMediaWindowWords(
  words: TranscriptWord[],
  fps: number,
  item: MediaWindowItem,
) {
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const out: TranscriptWord[] = [];
  const indices: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    if (wE <= window.startFrame || wS >= window.endFrame) continue;
    const fromF = item.startFrame + sourceFramesToTimelineFrames(item, Math.max(wS, window.startFrame) - window.startFrame);
    const toF = item.startFrame + sourceFramesToTimelineFrames(item, Math.min(wE, window.endFrame) - window.startFrame);
    const start = (fromF / fps) * 1000;
    out.push({ text: words[i].text, start, end: Math.max(start + 1, (toF / fps) * 1000), speaker: words[i].speaker });
    indices.push(i);
  }
  return { words: out, indices };
}

export function mediaWindowWords(words: TranscriptWord[], fps: number, item: MediaWindowItem): TranscriptWord[] {
  return projectMediaWindowWords(words, fps, item).words;
}

/** Source word index (wordOverrides key) overlapping the clip's media window. */
export function mediaWindowKeptIndices(
  words: TranscriptWord[],
  fps: number,
  item: MediaWindowItem,
): number[] {
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const idxs: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const wS = msToFrame(words[i].start, fps);
    const wE = msToFrame(words[i].end, fps);
    if (wE <= window.startFrame || wS >= window.endFrame) continue;
    idxs.push(i);
  }
  return idxs;
}

/** Clip fields needed to project a source word onto the timeline. */
interface WordSeekItem extends MediaWindowItem {
  kind: string;
  transcript?: TranscriptWord[];
}

/**
 * Timeline frame where a source word starts playing inside a clip using its
 * real continuous [srcInFrame, srcInFrame + duration * rate) media window.
 */
export function wordTimelineFrame(item: WordSeekItem, word: TranscriptWord, fps: number): number | null {
  const wS = msToFrame(word.start, fps);
  const wE = msToFrame(word.end, fps);
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  if (wE <= window.startFrame || wS >= window.endFrame) return null;
  const local = Math.round(sourceFramesToTimelineFrames(item, Math.max(wS, window.startFrame) - window.startFrame));
  return item.startFrame + Math.min(Math.max(0, local), Math.max(0, item.durationInFrames - 1));
}
