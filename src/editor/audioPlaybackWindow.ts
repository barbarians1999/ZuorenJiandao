import { buildAudioCrossfadePlanMap } from './audioCrossfade';
import type { MediaAsset, TimelineItem, TransitionItem } from './types';

export interface PlayerAudioWindow {
  from: number;
  activeFrom?: number;
  to: number;
}

/** Mount only audio that can be active or premounted at the current Player frame. */
export function audioPlaybackWindows(items: TimelineItem[], timelineItems: TimelineItem[], assets: MediaAsset[],
  transitions: TransitionItem[] | undefined, _fps: number, premountFor: number) {
  const crossfadeMap = buildAudioCrossfadePlanMap(timelineItems, transitions, assets);
  return items.flatMap((item) => {
    const extensions = crossfadeMap.get(item.id)?.extensions ?? { beforeFrames: 0, afterFrames: 0 };
    const activeFrom = item.startFrame - extensions.beforeFrames;
    return [{
      item,
      from: activeFrom - premountFor,
      activeFrom,
      to: item.startFrame + item.durationInFrames + extensions.afterFrames,
    }];
  });
}

/**
 * Keep every currently active audio window mounted, and cap premount-only
 * upcoming clips so dense word-cut timelines cannot exhaust Remotion's
 * shared `<Html5Audio>` tag pool.
 */
export function selectActivePlayerAudioWindows<T extends PlayerAudioWindow>(
  windows: readonly T[],
  frame: number,
  maxPremountNeighbors = 6,
): T[] {
  const active: T[] = [];
  const premounting: T[] = [];
  for (const window of windows) {
    if (frame < window.from || frame >= window.to) continue;
    const activeStart = window.activeFrom ?? window.from;
    if (frame >= activeStart) active.push(window);
    else premounting.push(window);
  }
  if (premounting.length <= maxPremountNeighbors) {
    return premounting.length ? [...active, ...premounting] : active;
  }
  const sortedPremount = [...premounting].sort((a, b) => (a.activeFrom ?? a.from) - (b.activeFrom ?? b.from));
  return [...active, ...sortedPremount.slice(0, Math.max(0, maxPremountNeighbors))];
}
