import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { buildCaptionPages } from './captionPages';
import type { CaptionSourceEntry, CaptionsData, CaptionSourceSpan, CaptionWordOverride } from './types';
import { joinCaptionWords } from './types';
import { setCaptionWordOverride } from './wordOverrides';
import type { CaptionStyleOverride } from './styles';

export interface CueRow {
  id: string;
  laneId: string;
  manual: boolean;
  start: number;
  end: number;
  text: string;
  /** The key of the visible word in this sentence in the wordOverrides index space */
  srcIdxs: number[];
  /** Stable identities aligned with srcIdxs. */
  wordRefs: string[];
  entry?: CaptionSourceEntry;
  /** Raw manual-lane cue index, used to edit/delete without a display override. */
  manualIndex: number | null;
  pageWords: TranscriptWord[];
  sourceSpans: CaptionSourceSpan[];
  displayCueEditId?: string;
  displayCuePartId?: string;
  displayCueSegmentId?: string;
  fontOverride?: Pick<CaptionStyleOverride, 'fontFamily' | 'fontAssetId'>;
}

export function fmtCueMs(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

/** Renders a paged recalculation of SingleStreamCaptions, but retains the override keys for each visible word.*/
export function buildCues(captions: CaptionsData, items: TimelineItem[], fps: number): CueRow[] {
  return buildCaptionPages(captions, items, fps).map((identity) => {
    const pageWord = identity.page.words[0];
    const manualIndex = identity.manual && identity.entry?.words
      ? identity.entry.words.findIndex((word) => pageWord && (
        pageWord.id ? word.id === pageWord.id
          : word.start === pageWord.start && word.end === pageWord.end && word.text === pageWord.text
      ))
      : -1;
    return {
      id: identity.id,
      laneId: identity.laneId,
      manual: identity.manual,
      start: identity.page.start,
      end: identity.page.end,
      text: joinCaptionWords(identity.page.words),
      srcIdxs: identity.srcIdxs,
      wordRefs: identity.wordRefs,
      entry: identity.entry,
      manualIndex: manualIndex >= 0 ? manualIndex : null,
      pageWords: identity.page.words,
      sourceSpans: identity.sourceSpans ?? [],
      displayCueEditId: identity.displayCueEditId,
      displayCuePartId: identity.displayCuePartId,
      displayCueSegmentId: identity.displayCueSegmentId,
      fontOverride: identity.fontOverride,
    };
  });
}

/** Translate the text changes in sentence k into wordOverrides patches.*/
export function cueTextPatch(
  captions: CaptionsData,
  rows: CueRow[],
  index: number,
  text: string,
): Partial<CaptionsData> | null {
  const cue = rows[index];
  if (!cue) return null;
  if (cue.displayCueEditId && cue.displayCuePartId) {
    const entry = captions.sourceEntries?.find(candidate => candidate.id === cue.laneId);
    const edit = entry?.displayCueEdits?.find(candidate => candidate.id === cue.displayCueEditId);
    if (!edit?.parts.some(part => part.id === cue.displayCuePartId)) return null;
    const trimmed = text.trim();
    return { sourceEntries: captions.sourceEntries!.map(candidate => candidate.id !== entry!.id ? candidate : {
      ...candidate,
      displayCueEdits: candidate.displayCueEdits!.map(record => record.id !== edit.id ? record : {
        ...record,
        // Keep the record's covered refs even when its final part is removed.
        parts: trimmed ? record.parts.map(part => part.id === cue.displayCuePartId ? { ...part, text: trimmed } : part)
          : record.parts.filter(part => part.id !== cue.displayCuePartId),
      }),
    }) };
  }
  if (cue.srcIdxs.length === 0) return null;
  const allIndices = rows.flatMap((row) => row.srcIdxs);
  let next: Record<number, CaptionWordOverride> = { ...(captions.wordOverrides ?? {}) };
  const put = (source: number, wordRef: string, patch: CaptionWordOverride) => {
    next = setCaptionWordOverride(next, allIndices, source, wordRef, patch);
  };
  const trimmed = text.trim();
  if (!trimmed) {
    cue.srcIdxs.forEach((source, position) => put(source, cue.wordRefs[position]!, { hidden: true }));
  } else {
    const [first, ...rest] = cue.srcIdxs;
    put(first!, cue.wordRefs[0]!, { text: trimmed, hidden: false, forceBreak: true });
    rest.forEach((source, position) => put(source, cue.wordRefs[position + 1]!, { hidden: true }));
    const nextFirst = rows[index + 1]?.srcIdxs[0];
    const nextRef = rows[index + 1]?.wordRefs[0];
    if (nextFirst !== undefined && nextRef) put(nextFirst, nextRef, { forceBreak: true });
  }
  return { wordOverrides: next };
}
