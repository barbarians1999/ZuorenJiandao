import { canTrackAcceptItemKind, defaultTrackId, isDedicatedEffectItemKind, isEffectItemKind, isEffectTrack, isTextTrack, timelineTrackIds, trackKind, type TimelineFoldGroup, type TimelineState, type TrackFlags, type TrackVisualRole, type TimelineItem, type TimelineLinkGroup } from './types';
import { attachToMainClip, mainTrackId, planDirectionalChange, planMagneticInsert, type MagneticPlan } from './magneticTimeline';
import { cloneFoldGroupsForCopiedItems } from './foldGroups';

export interface ClipPasteOptions {
  sourceMainTrackId?: string | null;
  groups?: readonly TimelineLinkGroup[];
  foldGroups?: readonly TimelineFoldGroup[];
  /** Duplicate keeps original lanes instead of targeting the selected lane. */
  keepSourceTracks?: boolean;
  /** Explicitly selected target track (from track header or empty lane click). */
  targetTrackId?: string | null;
}

/** Copy placement and identity are planned together, then committed as one undo step. */
export function planClipPasteResult(state: TimelineState, clips: readonly TimelineItem[], sourceTracks: Partial<Record<string, TrackFlags>> | undefined,
  playhead: number, uid: (prefix: string) => string, options: ClipPasteOptions = {}): MagneticPlan {
  if (!clips.length) return { state };
  if (!Number.isFinite(playhead)) return { state, error: '粘贴位置无效，操作未执行。' };
  const base = Math.min(...clips.map((clip) => clip.startFrame));
  const frame = Math.max(0, Math.round(playhead));
  const main = mainTrackId(state);
  const tracks = { ...state.tracks };
  const order = timelineTrackIds(state);
  const mapping = new Map<string, string>();
  const idMap = new Map(clips.map((clip) => [clip.id, uid('item')]));
  const sourceIds = [...new Set(clips.map((clip) => clip.track))];
  const primary = state.items.find((item) => item.id === state.selectedId);
  const createLane = (sourceId: string, kind: 'video' | 'audio', visualRole?: TrackVisualRole) => {
    const id = uid('track');
    tracks[id] = { kind, ...(visualRole ? { visualRole } : {}), name: sourceTracks?.[sourceId]?.name };
    if (kind === 'video') order.unshift(id);
    else order.push(id);
    return id;
  };
  const isTrackCompatible = (
    id: string | null | undefined,
    kind: 'video' | 'audio',
    isEffectGroup: boolean,
    members: readonly TimelineItem[],
    ignoreLocked = false,
  ) => {
    if (!id || !order.includes(id) || trackKind(state, id) !== kind) return false;
    const checkState = ignoreLocked && tracks[id]?.locked
      ? { ...state, tracks: { ...tracks, [id]: { ...tracks[id], locked: false } } }
      : state;
    return members.every((clip) => canTrackAcceptItemKind(checkState, clip.kind, id, main))
      && (!isEffectGroup || isEffectTrack(checkState, id, main));
  };
  const sourceGroups = sourceIds.map((sourceId) => {
    const members = clips.filter((clip) => clip.track === sourceId);
    const kind: 'video' | 'audio' = members[0]!.kind === 'audio' ? 'audio' : 'video';
    const isTextGroup = kind === 'video' && members.every((clip) => clip.kind === 'text');
    const sourceWasEffect = sourceTracks?.[sourceId]?.visualRole === 'effect';
    const isEffectGroup = kind === 'video' && !isTextGroup && (
      members.every((clip) => isDedicatedEffectItemKind(clip.kind))
      || (sourceWasEffect && members.every((clip) => isEffectItemKind(clip.kind)))
    );
    const roleForLane: TrackVisualRole | undefined = isTextGroup ? 'text' : isEffectGroup ? 'effect' : undefined;
    return { sourceId, members, kind, isTextGroup, isEffectGroup, roleForLane };
  });
  const explicitTargetId = !options.keepSourceTracks && options.targetTrackId && order.includes(options.targetTrackId)
    ? options.targetTrackId
    : null;
  const leadGroupForExplicitTarget = explicitTargetId
    ? (sourceGroups.length === 1
      ? (isTrackCompatible(explicitTargetId, sourceGroups[0]!.kind, sourceGroups[0]!.isEffectGroup, sourceGroups[0]!.members, true)
        ? sourceGroups[0]
        : undefined)
      : ((options.sourceMainTrackId
        ? sourceGroups.find((g) => g.sourceId === options.sourceMainTrackId
          && isTrackCompatible(explicitTargetId, g.kind, g.isEffectGroup, g.members, true))
        : undefined)
        ?? sourceGroups.find((g) => isTrackCompatible(explicitTargetId, g.kind, g.isEffectGroup, g.members, true))))
    : undefined;
  for (const group of sourceGroups) {
    const { sourceId, members, kind, isTextGroup, isEffectGroup, roleForLane } = group;
    const isValidTarget = (id: string) => isTrackCompatible(id, kind, isEffectGroup, members);
    const explicitMatches = Boolean(
      explicitTargetId
      && leadGroupForExplicitTarget?.sourceId === sourceId
      && isTrackCompatible(explicitTargetId, kind, isEffectGroup, members, true)
      && ![...mapping.values()].includes(explicitTargetId),
    );
    if (explicitMatches && tracks[explicitTargetId!]?.locked) {
      return { state, error: '目标轨道已锁定，请先解锁或选择其他轨道。' };
    }
    let target: string | null | undefined;
    if (options.keepSourceTracks && order.includes(sourceId) && isValidTarget(sourceId)) {
      target = sourceId;
    } else if (explicitMatches) {
      target = explicitTargetId!;
    } else if (sourceIds.length === 1) {
      if (primary && isValidTarget(primary.track) && (!tracks[primary.track]?.locked || (primary.track === main && state.interaction?.magnet))) {
        target = primary.track;
      } else if (order.includes(sourceId) && isValidTarget(sourceId) && (!tracks[sourceId]?.locked || (sourceId === main && state.interaction?.magnet))) {
        target = sourceId;
      } else if (kind === 'video') {
        target = isTextGroup
          ? order.find((id) => id !== main && isTextTrack(state, id, main)) ?? null
          : isEffectGroup
            ? order.find((id) => id !== main && isEffectTrack(state, id, main)) ?? null
            : main;
      } else {
        target = defaultTrackId(state, kind);
      }
    } else if (options.sourceMainTrackId === sourceId && kind === 'video' && !isTextGroup && !isEffectGroup) {
      target = main;
    } else if (order.includes(sourceId) && isValidTarget(sourceId)) {
      target = sourceId;
    } else {
      target = null;
    }
    // A copied title/attached overlay stays above the picture track even when
    // the user has cleared selection or selected the main video before pasting.
    if (!explicitMatches && target === main && members.every((clip) => clip.kind === 'text' || isEffectItemKind(clip.kind) || !!clip.mainClipId)) {
      target = sourceId !== main && order.includes(sourceId) && isValidTarget(sourceId)
        ? sourceId : order.find((id) => id !== main && isValidTarget(id));
    }
    if (target && tracks[target]?.locked && target === main && state.interaction?.magnet) {
      return { state, error: '主轨已锁定，请先解锁后再粘贴。' };
    }
    if (!target || tracks[target]?.locked || !isValidTarget(target) || [...mapping.values()].includes(target)) target = createLane(sourceId, kind, roleForLane);
    mapping.set(sourceId, target);
  }
  const copied = clips.map((clip): TimelineItem => ({
    ...structuredClone(clip), id: idMap.get(clip.id)!, track: mapping.get(clip.track)!,
    startFrame: frame + clip.startFrame - base,
    // Never keep a source-draft id merely because a target draft reuses it.
    mainClipId: clip.mainClipId ? idMap.get(clip.mainClipId) : undefined,
  }));
  let next: TimelineState = { ...state, tracks, trackOrder: order,
    ...(main ? { interaction: { ...state.interaction, mainTrackId: main } } : {}),
  };
  const mainCopies = state.interaction?.magnet ? copied.filter((clip) => clip.track === main).sort((a, b) => a.startFrame - b.startFrame) : [];
  if (mainCopies.length) {
    const plan = planMagneticInsert(next, mainCopies, Math.min(...mainCopies.map((clip) => clip.startFrame)));
    if (plan.error) return { state, error: plan.error };
    next = plan.state;
  }
  const placedMain = new Map(next.items.filter((clip) => mainCopies.some((copy) => copy.id === clip.id)).map((clip) => [clip.id, clip]));
  const mainOffset = mainCopies.length ? placedMain.get(mainCopies[0]!.id)!.startFrame - mainCopies[0]!.startFrame : 0;
  const pending = copied.filter((clip) => !placedMain.has(clip.id)).map((clip) => {
    const parent = clip.mainClipId ? placedMain.get(clip.mainClipId) : undefined;
    const sourceParent = parent ? mainCopies.find((copy) => copy.id === parent.id)! : undefined;
    return { ...clip, startFrame: clip.startFrame + (parent && sourceParent ? parent.startFrame - sourceParent.startFrame : mainOffset) };
  });
  // Test side-lane collisions AFTER main insertion has moved existing followers.
  for (const sourceId of sourceIds) {
    const members = pending.filter((clip) => clip.track === mapping.get(sourceId));
    if (!members.length) continue;
    if (members.some((clip) => next.items.some((other) => other.track === clip.track
      && other.startFrame < clip.startFrame + clip.durationInFrames
      && other.startFrame + other.durationInFrames > clip.startFrame))) {
      const memberKind = members[0]!.kind === 'audio' ? 'audio' : 'video';
      const memberIsText = memberKind === 'video' && members.every((clip) => clip.kind === 'text');
      const memberIsEffect = memberKind === 'video' && !memberIsText && (
        members.every((clip) => isDedicatedEffectItemKind(clip.kind))
        || (sourceTracks?.[sourceId]?.visualRole === 'effect' && members.every((clip) => isEffectItemKind(clip.kind)))
      );
      const target = createLane(sourceId, memberKind, memberIsText ? 'text' : memberIsEffect ? 'effect' : undefined);
      for (const clip of members) clip.track = target;
    }
  }
  next = { ...next, tracks, trackOrder: order, items: [...next.items, ...pending] };
  const copiedIds = new Set(copied.map((clip) => clip.id));
  const validParents = new Set(next.items.filter((clip) => clip.track === mainTrackId(next)).map((clip) => clip.id));
  next.items = next.items.map((clip) => {
    if (!copiedIds.has(clip.id)) return clip;
    // If the copied parent was placed on an overlay lane, the pair no longer
    // has a main-track relationship. Do not silently bind its child to some
    // unrelated existing main video underneath it.
    if (clip.mainClipId && !validParents.has(clip.mainClipId)) return { ...clip, mainClipId: undefined };
    return attachToMainClip(next, clip);
  });
  const copiedGroups = (options.groups ?? []).filter((group) => group.itemIds.every((id) => idMap.has(id))).map((group) => ({
    ...group, id: uid('group'), itemIds: group.itemIds.map((id) => idMap.get(id)!), anchorItemId: idMap.get(group.anchorItemId)!,
  }));
  const copiedFoldGroups = cloneFoldGroupsForCopiedItems(
    options.foldGroups,
    idMap,
    next.items.filter((clip) => copiedIds.has(clip.id)),
    uid,
  );
  next = { ...next,
    ...(copiedGroups.length ? { linkGroups: [...(next.linkGroups ?? []), ...copiedGroups] } : {}),
    ...(copiedFoldGroups.length ? { foldGroups: [...(next.foldGroups ?? []), ...copiedFoldGroups] } : {}),
    selectedIds: copied.map((clip) => clip.id), selectedId: copied.at(-1)!.id,
  };
  const result = planDirectionalChange(state, next);
  return result.error ? { state, error: result.error } : result;
}

/** Compatibility wrapper for callers that only need the resulting state. */
export function planClipPaste(state: TimelineState, clips: readonly TimelineItem[], sourceTracks: Partial<Record<string, TrackFlags>> | undefined,
  playhead: number, uid: (prefix: string) => string, options?: ClipPasteOptions): TimelineState {
  return planClipPasteResult(state, clips, sourceTracks, playhead, uid, options).state;
}
