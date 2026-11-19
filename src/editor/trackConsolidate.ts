import { mainTrackId } from './magneticTimeline.js';
import {
  isTextTrack,
  timelineTrackIds,
  trackKind,
  trackNature,
  type TimelineItem,
  type TimelineState,
  type TrackFlags,
  type TrackId,
} from './types.js';

export interface CompactTracksResult {
  state: TimelineState;
  movedItemCount: number;
  removedTrackIds: TrackId[];
}

interface Interval {
  start: number;
  end: number;
}

interface PlacementCluster {
  currentTrack: TrackId;
  itemIds: string[];
  items: TimelineItem[];
  minStart: number;
  minEnd: number;
  lanePriority: number;
}

function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function canPlaceClusterOnLane(
  cluster: PlacementCluster,
  occupied: readonly Interval[],
): boolean {
  return cluster.items.every((item) => {
    const span: Interval = { start: item.startFrame, end: item.startFrame + item.durationInFrames };
    return occupied.every((other) => !intervalsOverlap(span, other));
  });
}

function audioPartitionKey(flags: TrackFlags | undefined): string {
  const hidden = flags?.hidden ? 1 : 0;
  const muted = flags?.muted ? 1 : 0;
  const soloed = flags?.soloed ? 1 : 0;
  const role = flags?.role ?? '';
  const duck = flags?.audioRouting?.duckDepthDb ?? '';
  const gain = flags?.audioRouting?.gainDb ?? '';
  return `audio:${hidden}:${muted}:${soloed}:${role}:${duck}:${gain}`;
}

function trackPartitionKey(state: TimelineState, trackId: TrackId, main: TrackId | null): string | null {
  if (state.tracks?.[trackId]?.locked) return null;
  if (trackId === main) return null;
  const flags = state.tracks?.[trackId];
  const nature = trackNature(state, trackId, main);
  if (nature === 'caption') return null;
  if (nature === 'audio') return audioPartitionKey(flags);
  // Keep hidden vs visible tracks isolated so consolidating never reveals hidden clips or hides visible ones.
  const hidden = flags?.hidden ? 1 : 0;
  const muted = flags?.muted ? 1 : 0;
  return `${nature}:${hidden}:${muted}`;
}

function transitionClusterMap(items: readonly TimelineItem[], state: TimelineState): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const root = parent.get(id) ?? id;
    if (root === id) return id;
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const item of items) parent.set(item.id, item.id);
  for (const transition of state.transitions ?? []) {
    if (parent.has(transition.outgoingItemId) && parent.has(transition.incomingItemId)) {
      unite(transition.outgoingItemId, transition.incomingItemId);
    }
  }
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const root = find(item.id);
    const list = groups.get(root);
    if (list) list.push(item.id);
    else groups.set(root, [item.id]);
  }
  return groups;
}

/**
 * Vertically compact non-overlapping clips within unlocked same-nature track groups
 * (overlay video, dedicated text, and compatible audio tracks) while keeping
 * `mainTrackId`, clip start frames, durations, locked tracks, and transitions intact.
 */
export function planCompactTracks(state: TimelineState): CompactTracksResult {
  const ids = timelineTrackIds(state);
  const main = mainTrackId(state);
  const groups = new Map<string, TrackId[]>();

  for (const id of ids) {
    const key = trackPartitionKey(state, id, main);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(id);
    else groups.set(key, [id]);
  }

  const itemDestination = new Map<string, TrackId>();
  const itemById = new Map(state.items.map((item) => [item.id, item]));
  const clustersByRoot = transitionClusterMap(state.items, state);

  for (const [key, groupIds] of groups) {
    if (groupIds.length < 2) continue;
    // Video/text tracks stack bottom-to-top above the main track; pack down toward the lowest lane first.
    const targetLanes = key.startsWith('audio:') ? [...groupIds] : [...groupIds].reverse();
    const laneSet = new Set(targetLanes);
    const occupied = new Map<TrackId, Interval[]>(targetLanes.map((id) => [id, []]));
    const clusters: PlacementCluster[] = [];

    for (const memberIds of clustersByRoot.values()) {
      const members = memberIds.map((id) => itemById.get(id)!).filter(Boolean);
      if (!members.length) continue;
      // Only move a connected cluster if every member lives inside this partition.
      if (!members.every((item) => laneSet.has(item.track))) continue;
      const trackSet = new Set(members.map((item) => item.track));
      const currentTrack = members[0]!.track;
      if (trackSet.size !== 1) continue;
      clusters.push({
        currentTrack,
        itemIds: members.map((item) => item.id),
        items: members,
        minStart: Math.min(...members.map((item) => item.startFrame)),
        minEnd: Math.min(...members.map((item) => item.startFrame + item.durationInFrames)),
        lanePriority: targetLanes.indexOf(currentTrack),
      });
    }

    clusters.sort((a, b) => (
      a.minStart - b.minStart
      || a.minEnd - b.minEnd
      || a.lanePriority - b.lanePriority
    ));

    for (const cluster of clusters) {
      let chosen = targetLanes.find((lane) => canPlaceClusterOnLane(cluster, occupied.get(lane)!));
      if (!chosen) chosen = cluster.currentTrack;
      const destOccupied = occupied.get(chosen)!;
      for (const item of cluster.items) {
        destOccupied.push({ start: item.startFrame, end: item.startFrame + item.durationInFrames });
        if (item.track !== chosen) itemDestination.set(item.id, chosen);
      }
    }
  }

  const movedItemCount = itemDestination.size;
  const nextItems = movedItemCount > 0
    ? state.items.map((item) => {
        const dest = itemDestination.get(item.id);
        return dest ? { ...item, track: dest } : item;
      })
    : state.items;

  const occupiedTracks = new Set(nextItems.map((item) => item.track));
  const nextTransitions = state.transitions?.length
    ? state.transitions.map((transition) => {
        const dest = itemDestination.get(transition.incomingItemId) ?? itemDestination.get(transition.outgoingItemId);
        return dest && dest !== transition.trackId ? { ...transition, trackId: dest } : transition;
      })
    : state.transitions;
  for (const transition of nextTransitions ?? []) occupiedTracks.add(transition.trackId);

  let remainingVideoCount = ids.filter((id) => trackKind(state, id) === 'video').length;
  const removedTrackIds: TrackId[] = [];
  for (const id of ids) {
    if (id === main || state.tracks?.[id]?.locked) continue;
    const kind = trackKind(state, id);
    if (kind === 'caption') continue;
    if (occupiedTracks.has(id)) continue;
    if (kind === 'video') {
      // Never remove the last remaining picture track, or leave 0 video tracks on the timeline.
      if (remainingVideoCount <= 1) continue;
      if (!isTextTrack(state, id, main)) {
        const remainingNonText = ids.filter((candidate) => (
          candidate !== id && !removedTrackIds.includes(candidate)
          && trackKind(state, candidate) === 'video' && !isTextTrack(state, candidate, main)
        ));
        if (remainingNonText.length === 0) continue;
      }
      remainingVideoCount -= 1;
    }
    removedTrackIds.push(id);
  }

  if (movedItemCount === 0 && removedTrackIds.length === 0) {
    return { state, movedItemCount: 0, removedTrackIds: [] };
  }

  const removeSet = new Set(removedTrackIds);
  const nextTracks = { ...state.tracks };
  for (const id of removedTrackIds) delete nextTracks[id];

  return {
    state: {
      ...state,
      items: nextItems,
      ...(nextTransitions ? { transitions: nextTransitions } : {}),
      tracks: nextTracks,
      trackOrder: ids.filter((id) => !removeSet.has(id)),
    },
    movedItemCount,
    removedTrackIds,
  };
}
