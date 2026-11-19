import { isAudioTransition } from './types';
import type { TimelineItem, TransitionItem } from './types';
import { sourceFrameAt } from './sourceLimit';
import { volumeAtFrame } from './keyframes';
import { clipFadeFactor } from './clipFade';

const FRAME_EPSILON = 0.01;

export function sharedAudioVolume(items: TimelineItem[], muted: boolean,
  gainAt: (track: TimelineItem['track'], frame: number) => number): number | ((frame: number) => number) {
  if (muted || items.every(item => (item.volume ?? 1) === 0 && !item.keyframes?.volume?.length)) return 0;
  const first = items[0];
  return (frame) => {
    const timelineFrame = (first?.startFrame ?? 0) + frame;
    const item = items.find(candidate => timelineFrame >= candidate.startFrame && timelineFrame < candidate.startFrame + candidate.durationInFrames);
    if (!item || muted) return 0;
    const localFrame = timelineFrame - item.startFrame;
    return volumeAtFrame(item, localFrame) * gainAt(item.track, timelineFrame)
      * clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  };
}

/** The caller is outside the group's Sequence, so frame is already timeline-relative. */
export function sharedVisualFrame(group: TimelineItem[], timelineFrame: number) {
  const item = group.find((candidate) => timelineFrame >= candidate.startFrame
    && timelineFrame < candidate.startFrame + candidate.durationInFrames) ?? group[0];
  return item ? { item, localFrame: timelineFrame - item.startFrame } : null;
}

function canShareAudio(
  previous: TimelineItem,
  next: TimelineItem,
  audioTransitionPairs: Set<string>,
): boolean {
  const previousAudio = previous.denoisedSrc || previous.src;
  const nextAudio = next.denoisedSrc || next.src;
  if (!previousAudio || previousAudio !== nextAudio || previous.track !== next.track) return false;
  if ((previous.denoisedSrc || next.denoisedSrc)
    && (previous.src !== next.src
      || (previous.denoiseStrength ?? 100) !== (next.denoiseStrength ?? 100))) return false;
  if (previous.startFrame + previous.durationInFrames !== next.startFrame) return false;
  if ((previous.playbackRate ?? 1) !== (next.playbackRate ?? 1)) return false;
  if (audioTransitionPairs.has(`${previous.id}:${next.id}`)) return false;
  return Math.abs(sourceFrameAt(previous, previous.durationInFrames) - sourceFrameAt(next, 0)) <= FRAME_EPSILON;
}

export function continuousVideoAudioGroups(
  items: TimelineItem[],
  transitions?: TransitionItem[],
): TimelineItem[][] {
  const audioTransitionPairs = new Set((transitions ?? [])
    .filter((transition) => transition.enabled !== false && isAudioTransition(transition.type))
    .map((transition) => `${transition.outgoingItemId}:${transition.incomingItemId}`));
  const videos = items
    .filter((item) => item.kind === 'video' && !!item.src)
    .sort((a, b) => a.track.localeCompare(b.track) || a.startFrame - b.startFrame);
  const groups: TimelineItem[][] = [];
  for (const item of videos) {
    const group = groups.at(-1);
    if (group?.length && canShareAudio(group.at(-1)!, item, audioTransitionPairs)) group.push(item);
    else groups.push([item]);
  }
  return groups.filter((group) => group.length > 1 || group.some((item) => item.pictureDisabled === true));
}

/** Whether a clip can join a shared-visual group: one decoder element plays
 *  the consecutive same-source run. Any per-clip rendering concern (GL effect,
 *  background fill, transition extension/entrance, denoise, animated
 *  transform/keyframes/zoom, filters) keeps the clip on its own element. */
export function shareableVisualItem(input: {
  item: TimelineItem;
  hasBackgroundFill: boolean;
  hasExtendBefore: boolean;
  hasExtendAfter: boolean;
  hasEntrance: boolean;
  hasGlEffect: boolean;
}): boolean {
  const { item } = input;
  return item.kind === 'video'
    && !!item.src
    && !item.denoisedSrc
    && !input.hasGlEffect
    && !input.hasBackgroundFill
    && !input.hasExtendBefore
    && !input.hasExtendAfter
    && !input.hasEntrance
    && !item.transform
    && !item.keyframes
    && !item.filters;
}
