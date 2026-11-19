import { audioCrossfadeAutomation } from './audioCrossfade';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import type { MediaAsset, TimelineItem, TransitionItem } from './types';

/** Mount only audio that can be active or premounted at the current Player frame. */
export function audioPlaybackWindows(items: TimelineItem[], timelineItems: TimelineItem[], assets: MediaAsset[],
  transitions: TransitionItem[] | undefined, fps: number, premountFor: number) {
  return items.flatMap((item) => {
    if (hasOperationalTranscript(item)) {
      const segments = keptSegments(item.transcript, new Set(item.deletedWordIdx ?? []), fps, item.startFrame,
        { ...itemEditOpts(item), window: itemWindow(item) });
      if (!segments.length) return [];
      return [{ item, from: Math.min(...segments.map(s => s.fromFrame)) - premountFor,
        to: Math.max(...segments.map(s => s.fromFrame + s.durFrames)) }];
    }
    const { extensions } = audioCrossfadeAutomation(item, timelineItems, transitions, assets);
    return [{ item, from: item.startFrame - extensions.beforeFrames - premountFor,
      to: item.startFrame + item.durationInFrames + extensions.afterFrames }];
  });
}
