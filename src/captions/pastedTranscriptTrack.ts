import type { TimelineItem, TrackId } from '../editor/types';
import { hasOperationalTranscript } from '../transcript/types';
import { isLikelyNonSpeech, mediaOnTrack } from '../transcript/trackOptions';
import { alignPastedTranscript, type PastedTranscriptAlignment } from './pastedTranscript';
import { resolveCaptionWords } from './resolve';
import type { CaptionsData } from './types';

interface BuildPastedTranscriptTrackInput {
  script: string;
  items: TimelineItem[];
  fps: number;
  track: TrackId;
  laneId: string;
  label: string;
}

export interface BuiltPastedTranscriptTrack {
  captions: CaptionsData;
  alignment: PastedTranscriptAlignment;
  sourceItemIds: string[];
}

export function transcribedSpeechOnTrack(items: TimelineItem[], track: TrackId): TimelineItem[] {
  return mediaOnTrack(items, track).filter((item) => !isLikelyNonSpeech(item) && hasOperationalTranscript(item));
}

/**
 * Build a new manual caption lane. The edited speech track contributes timing;
 * the pasted script contributes the visible copy, leaving ASR and old captions untouched.
 */
export function buildPastedTranscriptTrack(input: BuildPastedTranscriptTrackInput): BuiltPastedTranscriptTrack {
  const sourceItems = transcribedSpeechOnTrack(input.items, input.track);
  if (!sourceItems.length) throw new Error('所选口播轨道没有可用的转写，请先进行本机转写。');
  const sourceItemIds = sourceItems.map((item) => item.id);
  const projected = resolveCaptionWords({
    enabled: true,
    template: 'plain',
    pacing: 'phrase',
    sources: sourceItemIds,
    sourceMode: 'item',
  }, input.items, input.fps);
  const alignment = alignPastedTranscript(input.script, projected);
  alignment.cues = alignment.cues.map((cue, index) => ({ ...cue, id: `${input.laneId}:cue:${index}` }));
  return {
    alignment,
    sourceItemIds,
    captions: {
      enabled: true,
      template: 'plain',
      pacing: 'phrase',
      sourceMode: 'item',
      bilingual: false,
      styleOverride: {
        fontFamily: 'Noto Sans SC',
        fontSize: 0.04,
        fontWeight: 700,
        color: '#ffffff',
        highlightColor: '#ffffff',
        strokeColor: '#000000',
        strokeWidth: 4,
        textShadow: 'none',
        wholeLine: true,
      },
      sourceEntries: [{
        id: input.laneId,
        itemId: `manual:${input.laneId}`,
        label: input.label,
        words: alignment.cues,
      }],
    },
  };
}
