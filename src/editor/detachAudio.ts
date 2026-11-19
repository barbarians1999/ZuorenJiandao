import { isAudioTransition, timelineTrackIds, trackKind, type TimelineItem, type TimelineState } from './types';

export function hasAudioTransition(state: TimelineState, id: string): boolean {
  return (state.transitions ?? []).some((transition) => isAudioTransition(transition.type)
    && (transition.outgoingItemId === id || transition.incomingItemId === id));
}

function selectedVideos(state: TimelineState, ids: string | readonly string[]): TimelineItem[] {
  const selected = new Set(typeof ids === 'string' ? [ids] : ids);
  return state.items.filter(item => selected.has(item.id) && item.kind === 'video' && !item.audioDetached);
}

export function detachAudioUnavailable(state: TimelineState, ids: string | readonly string[]): string | null {
  const videos = selectedVideos(state, ids);
  if (!videos.length) return '所选片段中没有尚未分离音频的视频';
  if (videos.some(video => state.tracks?.[video.track]?.locked)) return '请先解锁所选视频所在的轨道';
  if (videos.some(video => !video.src)) return '所选视频缺少素材地址，请先重新链接素材';
  if (videos.some(video => hasAudioTransition(state, video.id))) return '请先移除所选视频的音频转场';
  return null;
}

/** One state update for all selected videos; new clips reserve their audio ranges in order. */
export function detachAudio(state: TimelineState, ids: string | readonly string[], uid: (prefix: string) => string): TimelineState {
  if (detachAudioUnavailable(state, ids)) return state;
  let next = state;
  const audioIds: string[] = [];
  for (const video of selectedVideos(state, ids)) {
    next = detachClipAudio(next, video, uid);
    audioIds.push(next.selectedId!);
  }
  return { ...next, selectedIds: audioIds };
}

function detachClipAudio(state: TimelineState, video: TimelineItem, uid: (prefix: string) => string): TimelineState {
  const order = timelineTrackIds(state);
  let track = order.find((candidate) => trackKind(state, candidate) === 'audio'
    && !state.tracks?.[candidate]?.locked && !state.tracks?.[candidate]?.muted && !state.tracks?.[candidate]?.hidden
    && !state.items.some((other) => other.track === candidate && other.startFrame < video.startFrame + video.durationInFrames
      && other.startFrame + other.durationInFrames > video.startFrame));
  let tracks = state.tracks;
  if (!track) {
    track = uid('track');
    tracks = { ...tracks, [track]: { kind: 'audio' } };
    order.push(track);
  }
  const { pictureDisabled: _pictureDisabled, ...audioSource } = video;
  const audio: TimelineItem = {
    ...audioSource, id: uid('item'), track, kind: 'audio', mainClipId: undefined,
    audioDetached: true, multicamGroupId: undefined, multicamAngleId: undefined,
    keyframes: video.keyframes?.volume ? { volume: video.keyframes.volume } : undefined,
  };
  const keyframes = video.keyframes ? { ...video.keyframes, volume: undefined } : undefined;
  return { ...state, tracks, trackOrder: order,
    items: [...state.items.map((item) => item.id === video.id ? { ...item, volume: 0, keyframes, audioDetached: true } : item), audio],
    selectedId: audio.id, selectedIds: [audio.id],
  };
}
