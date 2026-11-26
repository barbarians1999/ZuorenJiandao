import type { TimelineItem, TrackId } from '../editor/types';
import { mediaOnTrack, isLikelyNonSpeech } from '../transcript/trackOptions';
import { hasOperationalTranscript } from '../transcript/types';
import type { TranscriptWord } from '../transcript/types';

export function pastedSpeechItems(items: TimelineItem[], track: TrackId): TimelineItem[] {
  return mediaOnTrack(items, track).filter((item) => !isLikelyNonSpeech(item));
}

/** Multiple cuts from the same source need only one recognition request. */
export function pastedRecognitionJobs(items: TimelineItem[]) {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items.filter((candidate) => !hasOperationalTranscript(candidate))) {
    if (!item.src) continue;
    groups.set(item.src, [...(groups.get(item.src) ?? []), item]);
  }
  return [...groups].map(([path, clips]) => ({ path, itemId: clips[0].id, label: clips[0].name ?? clips[0].id, clips }));
}

/** Concurrent edits require fresh alignment; recognition itself is read-only. */
export function pastedTimingSnapshot(items: TimelineItem[], track: TrackId): string {
  return JSON.stringify(pastedSpeechItems(items, track));
}

export function applyPastedRecognition(items: TimelineItem[], results: ReadonlyMap<string, TranscriptWord[]>): TimelineItem[] {
  return items.map((item) => results.has(item.id) ? {
    ...item, transcript: results.get(item.id)!, transcriptStale: false,
    variants: undefined,
  } : item);
}
