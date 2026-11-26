import type { TimelineItem, TimelineState } from './types';
import { hasOperationalTranscript } from '../transcript/types';
import {
  assignTranscriptToClipOrUnit,
  compileTranscriptTrackEdit,
  updateUnitTranscriptMetadata,
} from '../transcript/trackEditCompiler';
import type { Action } from './reducerActions';

export function applyTranscriptAction(s: TimelineState, a: Action): TimelineState | undefined {
  switch (a.type) {
    case 'setItemTranscript':
      return assignTranscriptToClipOrUnit(s, a.id, a.words);
    case 'setItemVariants':
      if (!hasOperationalTranscript(s.items.find((it) => it.id === a.id))) return s;
      return updateUnitTranscriptMetadata(s, a.id, () => ({ variants: a.variants }));
    case 'toggleWord':
    case 'deleteWords':
    case 'cleanScript':
    case 'setGapCap':
    case 'setTranscriptPlayOrder':
    case 'clearEdits':
      return compileTranscriptTrackEdit(s, a);
    case 'reorderTrackItems': {
      const onTrack = s.items.filter((it) => it.track === a.track);
      if (onTrack.length < 2) return s;
      const byId = new Map(onTrack.map((it) => [it.id, it]));
      const ordered = a.orderedIds.map((id) => byId.get(id)).filter((x): x is TimelineItem => !!x);
      if (ordered.length < 2) return s;
      const starts = new Map<string, number>();
      if (a.starts) {
        for (const it of ordered) {
          const pinned = a.starts[it.id];
          if (pinned === undefined) continue;
          if (!Number.isFinite(pinned) || pinned < 0) return s;
          starts.set(it.id, Math.round(pinned));
        }
      } else {
        let t = Math.min(...ordered.map((it) => it.startFrame));
        for (const it of ordered) {
          starts.set(it.id, t);
          t += Math.max(1, it.durationInFrames);
        }
      }
      return {
        ...s,
        items: s.items.map((it) =>
          starts.has(it.id) ? { ...it, startFrame: starts.get(it.id)! } : it,
        ),
      };
    }
    case 'fixTranscriptWord': {
      const it = s.items.find((x) => x.id === a.id);
      if (!hasOperationalTranscript(it)) return s;
      return updateUnitTranscriptMetadata(s, a.id, (words) => {
        const word = words[a.wordIndex];
        if (!word || word.text === a.text) return null;
        return { words: words.map((w, i) => (i === a.wordIndex ? { ...w, text: a.text } : w)) };
      });
    }
    case 'renameSpeaker': {
      const it = s.items.find((x) => x.id === a.id);
      if (!hasOperationalTranscript(it)) return s;
      return updateUnitTranscriptMetadata(s, a.id, (words) => {
        if (!words.some((w) => w.speaker === a.from)) return null;
        return { words: words.map((w) => (w.speaker === a.from ? { ...w, speaker: a.to } : w)) };
      });
    }
    case 'setItemDenoise': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || (it.kind !== 'audio' && it.kind !== 'video')) return s;
      if (!a.denoisedSrc) {
        if (!it.denoisedSrc) return s;
        return {
          ...s,
          items: s.items.map((item) =>
            item.id === a.id ? { ...item, denoisedSrc: null, denoiseStrength: null } : item,
          ),
        };
      }
      const nextStrength = a.strength ?? 100;
      if (it.denoisedSrc === a.denoisedSrc && (it.denoiseStrength ?? 100) === nextStrength) return s;
      return {
        ...s,
        items: s.items.map((item) =>
          item.id === a.id
            ? {
                ...item,
                denoisedSrc: a.denoisedSrc,
                denoiseStrength: nextStrength,
              }
            : item,
        ),
      };
    }
    default:
      return undefined;
  }
}
