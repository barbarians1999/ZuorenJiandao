import type { TimelineItem } from './types';

function sameSourceIdentity(a: TimelineItem, b: TimelineItem): boolean {
  if (a.sourceAssetId && b.sourceAssetId) return a.sourceAssetId === b.sourceAssetId;
  if (a.sourceContentHash && b.sourceContentHash) return a.sourceContentHash === b.sourceContentHash;
  return false;
}

function isLegacyDetachedPair(audio: TimelineItem, video: TimelineItem): boolean {
  return video.kind === 'video'
    && video.audioDetached === true
    && video.volume === 0
    && !video.keyframes?.volume
    && sameSourceIdentity(audio, video)
    && (audio.srcInFrame ?? 0) === (video.srcInFrame ?? 0)
    && audio.durationInFrames === video.durationInFrames
    && (audio.playbackRate ?? 1) === (video.playbackRate ?? 1);
}

/** Keep audio taken from a video on the same renderer path as that video's audio. */
export function usesVideoAudioRenderer(item: TimelineItem, timelineItems: readonly TimelineItem[] = []): boolean {
  if (item.kind === 'video') return true;
  if (item.kind !== 'audio') return false;
  if (item.audioDetached) return true;

  const matches = timelineItems.filter((candidate) => isLegacyDetachedPair(item, candidate));
  return matches.length === 1;
}
