import { hasOperationalTranscript } from '../transcript/types';
import { isBackgroundFillActive } from './backgroundFill';
import { compositionPlan } from './compositionPlan';
import { mainTrackId } from './magneticTimeline';
import { resolveTimelineRenderPlan, sequenceGraphError } from './sequenceGraph';
import { sourceFrameAt } from './sourceLimit';
import { activeTimeline, timelineTrackIds, trackKind, type Marker, type ProjectDoc, type Timeline, type TimelineItem } from './types';

type IdFactory = (prefix: string) => string;
export type SubdraftOperation = { ok: true; doc: ProjectDoc; itemIds: string[]; timelineId?: string }
  | { ok: false; error: string };
const fail = (error: string): SubdraftOperation => ({ ok: false, error });

function target(doc: ProjectDoc, itemId: string) {
  const parent = activeTimeline(doc);
  const item = parent?.items.find((entry) => entry.id === itemId && entry.kind === 'sequence');
  const child = doc.timelines.find((entry) => entry.id === item?.timelineId);
  return parent && item && child ? { parent, item, child } : null;
}

/** Copy the reachable timeline DAG, not the media pool. Item ids are timeline-local
 * (as in tl.duplicate); keeping them preserves every internal metadata reference. */
export function planIndependentSubdraft(doc: ProjectDoc, itemId: string, uid: IdFactory): SubdraftOperation {
  const found = target(doc, itemId);
  if (!found) return fail('找不到这个子草稿，请重新选择。');
  const { parent, item, child } = found;
  if (parent.tracks?.[item.track]?.locked) return fail('请先解锁子草稿所在轨道。');
  const invalid = sequenceGraphError(doc);
  if (invalid) return fail(invalid.message);
  const reachable = new Map<string, Timeline>();
  const visit = (timeline: Timeline) => {
    if (reachable.has(timeline.id)) return;
    reachable.set(timeline.id, timeline);
    for (const entry of timeline.items) if (entry.kind === 'sequence') {
      visit(doc.timelines.find((candidate) => candidate.id === entry.timelineId)!);
    }
  };
  visit(child);
  const ids = new Map([...reachable.keys()].map((id) => [id, uid('tl')]));
  const rootId = ids.get(child.id)!;
  let order = Math.max(...doc.timelines.map((entry) => entry.order));
  const copies = [...reachable.values()].map((source): Timeline => {
    const copy = structuredClone(source);
    return { ...copy, id: ids.get(source.id)!, name: `${source.name} · 独立副本`, order: ++order,
      hidden: source.id === child.id ? false : source.hidden, selectedId: null, selectedIds: [],
      items: copy.items.map((entry) => entry.kind === 'sequence'
        ? { ...entry, timelineId: ids.get(entry.timelineId!)! } : entry),
    };
  });
  const next: ProjectDoc = { ...doc, timelines: [...doc.timelines.map((timeline) => timeline.id === parent.id
    ? { ...parent, items: parent.items.map((entry) => entry.id === item.id
      ? { ...entry, timelineId: rootId, name: `${item.name} · 独立副本` } : entry) } : timeline), ...copies] };
  const error = sequenceGraphError(next);
  return error ? fail(error.message) : { ok: true, doc: next, itemIds: [itemId], timelineId: rootId };
}

const animated = (item: TimelineItem) => !!item.fadeInFrames || !!item.fadeOutFrames
  || Object.values(item.keyframes ?? {}).some((frames) => !!frames?.length)
  || !!item.zoom || !!item.effects?.length
  || ['entrance', 'exit', 'visualEntrance', 'visualExit'].some((key) =>
    item.props?.[key] != null && item.props[key] !== 'none');

function wrapperEffects(item: TimelineItem): boolean {
  const tr = item.transform ?? {};
  return animated(item) || !!item.mask || !!item.backgroundFill
    || (item.volume ?? 1) !== 1
    || ['scale', 'scaleX', 'scaleY', 'opacity'].some((key) => (tr[key as keyof typeof tr] ?? 1) !== 1)
    || ['x', 'y', 'rotation', 'borderRadius'].some((key) => (tr[key as keyof typeof tr] ?? 0) !== 0)
    || Object.values(tr.crop ?? {}).some((value) => !!value)
    || ['brightness', 'contrast', 'saturate'].some((key) => (item.filters?.[key as keyof NonNullable<TimelineItem['filters']>] ?? 1) !== 1)
    || !!item.filters?.blur;
}

const captions = (timeline: Timeline) => [timeline.captions, ...Object.values(timeline.tracks ?? {}).map((track) => track?.captions)].filter(Boolean);
const routing = (timeline: Timeline) => Object.values(timeline.tracks ?? {}).some((track) =>
  track?.soloed || track?.role || (track?.audioRouting?.gainDb ?? 0) !== 0 || track?.audioRouting?.duckDepthDb != null);

/** Expand one level without changing the source timeline or repacking the parent.
 * A composite-only operation cannot always be distributed across layers. Refuse
 * those cases explicitly instead of flattening into a visually different edit. */
export function planExpandSubdraft(doc: ProjectDoc, itemId: string, uid: IdFactory): SubdraftOperation {
  const found = target(doc, itemId);
  if (!found) return fail('找不到这个子草稿，请重新选择。');
  const { parent, item, child } = found;
  const invalid = sequenceGraphError(doc);
  if (invalid) return fail(invalid.message);
  if (parent.tracks?.[item.track]?.locked) return fail('请先解锁子草稿所在轨道。');
  if (trackKind(parent, item.track) !== 'video') return fail('请先将子草稿移到画面轨道，再展开。');
  if ((item.playbackRate ?? 1) !== 1) return fail('请先恢复子草稿的整体速度为 1 倍，再展开；内部片段变速可以保留。');
  if (wrapperEffects(item)) return fail('这个子草稿带有整体动画、效果或变换。请先移除整体效果，再展开，以免画面改变。');
  if (parent.width !== child.width || parent.height !== child.height || parent.fps !== child.fps
    || (item.width ?? parent.width) !== parent.width || (item.height ?? parent.height) !== parent.height
    || (parent.fit ?? 'contain') !== (child.fit ?? 'contain')) return fail('子草稿与当前时间线的画布或适配方式不同，暂不能无损展开。');
  if (routing(parent) || routing(child)) return fail('请先关闭独奏和跨轨音量／配乐压低规则，再展开子草稿。');
  if (child.watermark?.enabled || captions(child).length) return fail('子草稿含独立字幕轨或水印，请先在子草稿内处理，再展开。普通文字片段可以展开。');
  if (parent.transitions?.some((entry) => entry.incomingItemId === itemId || entry.outgoingItemId === itemId)) {
    return fail('请先移除子草稿与外侧片段之间的转场，再展开。');
  }
  if (parent.linkGroups?.some((group) => group.mode !== 'group' && group.itemIds.includes(itemId))
    || parent.multicamGroups?.some((group) => group.angles.some((angle) => angle.itemId === itemId))
    || child.multicamGroups?.length || item.multicamGroupId) return fail('请先解除子草稿的音画链接、同步锁定或多机位关系，再展开。');
  const childHasTranscript = child.items.some((entry) => hasOperationalTranscript(entry));
  if (captions(parent).some((caption) => (caption!.sourceMode === 'timeline' && childHasTranscript)
    || caption!.sourceItemId === itemId || caption!.sources?.includes(itemId)
    || caption!.sourceEntries?.some((entry) => entry.itemId === itemId))) {
    return fail('当前字幕引用了这个子草稿，请先解除字幕来源关联，再展开。');
  }
  const from = item.srcInFrame ?? 0;
  const to = from + item.durationInFrames;
  if (!Number.isInteger(from) || from < 0 || item.durationInFrames <= 0
    || to > resolveTimelineRenderPlan(doc, child.id).durationInFrames) return fail('子草稿源范围包含越界或非整帧，暂不能无损展开。');
  const kept = child.items.filter((entry) => entry.startFrame < to && entry.startFrame + entry.durationInFrames > from);
  if (!kept.length) return fail('这个源范围内没有可以展开的片段。');
  const clipped = new Set(kept.filter((entry) => entry.startFrame < from || entry.startFrame + entry.durationInFrames > to).map((entry) => entry.id));
  if (kept.some((entry) => clipped.has(entry.id) && (animated(entry) || hasOperationalTranscript(entry)
    || ['motion-graphic', 'gif', 'svg'].includes(entry.kind)))) return fail('裁切边界碰到了带动画、动态素材或文字剪辑的片段，请调整子草稿裁切范围后再展开。');
  const keptIds = new Set(kept.map((entry) => entry.id));
  if (child.linkGroups?.some((group) => group.mode !== 'group'
    && group.itemIds.some((id) => keptIds.has(id)) && group.itemIds.some((id) => !keptIds.has(id)))) return fail('裁切范围切断了音画链接或同步锁定组合，请将完整组合纳入后再展开。');
  const transitions = (child.transitions ?? []).filter((entry) => keptIds.has(entry.incomingItemId) || keptIds.has(entry.outgoingItemId));
  if (transitions.some((entry) => !keptIds.has(entry.incomingItemId) || !keptIds.has(entry.outgoingItemId)
    || clipped.has(entry.incomingItemId) || clipped.has(entry.outgoingItemId))) return fail('裁切边界碰到了转场片段，请将转场两侧完整纳入后再展开。');
  // Transitions can extend an otherwise out-of-range clip into the visible window.
  if ((child.transitions ?? []).some((entry) => {
    const incoming = child.items.find((clip) => clip.id === entry.incomingItemId);
    if (!incoming || entry.enabled === false) return false;
    const left = incoming.startFrame - Math.floor(entry.durationInFrames / 2);
    const right = left + entry.durationInFrames;
    return left < to && right > from && (!keptIds.has(entry.incomingItemId) || !keptIds.has(entry.outgoingItemId));
  })) return fail('裁切范围跨越了转场窗口，请将转场两侧完整纳入后再展开。');
  const parentOrder = timelineTrackIds(parent);
  const childOrder = timelineTrackIds(child).filter((track) => kept.some((entry) => entry.track === track));
  const pictureTracks = childOrder.filter((track) => trackKind(child, track) === 'video');
  const bottom = pictureTracks.at(-1);
  const parentFlags = parent.tracks?.[item.track];
  const bottomFlags = bottom ? child.tracks?.[bottom] : undefined;
  if (bottom && ((!parentFlags?.hidden && bottomFlags?.hidden) || (!parentFlags?.muted && bottomFlags?.muted)
    || (!parentFlags?.locked && bottomFlags?.locked))) {
    return fail('子草稿底层轨道的隐藏、静音或锁定设置与外部轨道不同，请先统一，再展开。');
  }
  if (parent.items.some((entry) => entry.id !== itemId && entry.track === item.track
    && entry.startFrame < item.startFrame + item.durationInFrames && entry.startFrame + entry.durationInFrames > item.startFrame)) {
    return fail('子草稿所在轨道有重叠片段，请先移开重叠，再展开。');
  }
  const tracks = new Map(childOrder.map((track) => [track, track === bottom ? item.track : uid('track')]));
  const ids = new Map(kept.map((entry) => [entry.id, uid('item')]));
  const main = mainTrackId(parent);
  const items: TimelineItem[] = kept.map((entry) => {
    const left = Math.max(from, entry.startFrame);
    const right = Math.min(to, entry.startFrame + entry.durationInFrames);
    return { ...structuredClone(entry), id: ids.get(entry.id)!, track: tracks.get(entry.track)!,
      startFrame: item.startFrame + left - from, durationInFrames: right - left,
      ...(['audio', 'video', 'sequence'].includes(entry.kind) ? { srcInFrame: sourceFrameAt(entry, left - entry.startFrame) } : {}),
      mainClipId: entry.mainClipId ? ids.get(entry.mainClipId) : item.mainClipId,
    };
  });
  if (kept.some((entry) => entry.mainClipId && (!ids.has(entry.mainClipId)
    || tracks.get(child.items.find((candidate) => candidate.id === entry.mainClipId)!.track) !== main
    || !!item.mainClipId))) return fail('展开后无法保留内部主轨联动关系，请先解除联动，或将子草稿放回主轨。');
  const remaining: TimelineItem[] = [];
  for (const entry of parent.items) {
    if (entry.id === itemId) continue;
    if (entry.mainClipId !== itemId) { remaining.push(entry); continue; }
    const owners = items.filter((candidate) => candidate.track === main && entry.startFrame >= candidate.startFrame
      && entry.startFrame + entry.durationInFrames <= candidate.startFrame + candidate.durationInFrames);
    if (owners.length !== 1) return fail('跟随这个子草稿的片段跨越了多个内部片段，请先解除跟随关系，再展开。');
    remaining.push({ ...entry, mainClipId: owners[0]!.id });
  }
  for (const [key, definition] of Object.entries(child.fxDefs ?? {})) {
    if (parent.fxDefs?.[key] && JSON.stringify(parent.fxDefs[key]) !== JSON.stringify(definition)) return fail('两条时间线中存在同名但不同的效果定义，暂不能无损展开。');
  }
  const before = pictureTracks.filter((track) => track !== bottom).map((track) => tracks.get(track)!);
  const after = childOrder.filter((track) => !pictureTracks.includes(track)).map((track) => tracks.get(track)!);
  const at = parentOrder.indexOf(item.track);
  const metadata = { ...parent.tracks };
  for (const track of childOrder) if (track !== bottom) metadata[tracks.get(track)!] = {
    ...structuredClone(child.tracks?.[track] ?? {}), kind: trackKind(child, track),
    hidden: !!(parentFlags?.hidden || child.tracks?.[track]?.hidden),
    muted: !!(parentFlags?.muted || child.tracks?.[track]?.muted),
  };
  const groups = [...(parent.linkGroups ?? []).map((group) => group.itemIds.includes(itemId)
    ? { ...group, itemIds: group.itemIds.flatMap((id) => id === itemId ? items.map((entry) => entry.id) : [id]),
      anchorItemId: group.anchorItemId === itemId ? items[0]!.id : group.anchorItemId } : group),
  ...(child.linkGroups ?? []).flatMap((group) => {
    const members = group.itemIds.flatMap((id) => ids.has(id) ? [ids.get(id)!] : []);
    return members.length > 1 ? [{ ...group, id: uid('group'), itemIds: members,
      anchorItemId: ids.get(group.anchorItemId) ?? members[0]! }] : [];
  })];
  // Both marker scopes store timeline-absolute frames (including beat markers).
  const markers: Marker[] = (parent.markers ?? []).map((marker) => marker.scope === 'item' && marker.itemId === itemId
    ? { ...marker, scope: 'project', itemId: undefined } : marker);
  for (const marker of child.markers ?? []) {
    const source = marker.scope === 'item' ? child.items.find((entry) => entry.id === marker.itemId) : undefined;
    if (marker.scope === 'item' && (!source || !keptIds.has(source.id))) continue;
    const absolute = marker.fromFrame;
    const left = Math.max(from, absolute);
    const right = Math.min(to, absolute + marker.durationFrames);
    if (marker.durationFrames ? right <= left : absolute < from || absolute >= to) continue;
    const copied = source ? items.find((entry) => entry.id === ids.get(source.id))! : undefined;
    markers.push({ ...marker, id: uid('marker'), itemId: copied?.id,
      fromFrame: item.startFrame + left - from, durationFrames: Math.max(0, right - left) });
  }
  const nextParent: Timeline = { ...parent, selectedId: null, selectedIds: [], items: [...remaining, ...items],
    trackOrder: [...parentOrder.slice(0, at), ...before, item.track, ...after, ...parentOrder.slice(at + 1)],
    tracks: metadata, markers, linkGroups: groups.length ? groups : undefined,
    fxDefs: { ...parent.fxDefs, ...child.fxDefs },
    transitions: [...(parent.transitions ?? []), ...transitions.map((entry) => ({ ...structuredClone(entry), id: uid('transition'),
      trackId: tracks.get(entry.trackId)!, incomingItemId: ids.get(entry.incomingItemId)!, outgoingItemId: ids.get(entry.outgoingItemId)! }))],
  };
  // The current compositor draws shared decoders before ordinary clips and
  // GLSL windows after them. Lifting nested layers must not change that order.
  const parentPlan = compositionPlan(parent);
  const childPlan = compositionPlan(child);
  const flatPlan = compositionPlan(nextParent);
  const paintIds = (plan: ReturnType<typeof compositionPlan>) => [
    ...plan.sharedVisualGroups.flatMap((group) => group.map((clip) => clip.id)),
    ...plan.ordered.filter((clip) => !plan.sharedVisualIds.has(clip.id)).map((clip) => clip.id),
  ];
  const originalOrder = paintIds(parentPlan);
  const expandedOrder = paintIds(flatPlan);
  const external = parentPlan.ordered.filter((clip) => clip.id !== itemId);
  if (parentFlags?.hidden && childPlan.glWindows.some((window) => window.from < to && window.from + window.L > from)) {
    return fail('隐藏的子草稿包含内部转场，暂不能保持隐藏效果展开；请保留子草稿。');
  }
  const overlaps = (left: number, right: number, clip: TimelineItem) =>
    left < clip.startFrame + clip.durationInFrames + (parentPlan.extendAfter.get(clip.id) ?? 0)
    && right > clip.startFrame - (parentPlan.extendBefore.get(clip.id) ?? 0);
  if (childPlan.glWindows.some((window) => window.from < to && window.from + window.L > from
    && external.some((clip) => overlaps(
    item.startFrame + Math.max(from, window.from) - from,
    item.startFrame + Math.min(to, window.from + window.L) - from, clip)))) {
    return fail('内部转场与外侧画面重叠，展开可能改变遮挡关系。请先移开外侧画面，或保留子草稿。');
  }
  const expandedIds = new Set(ids.values());
  if (flatPlan.ordered.filter((clip) => expandedIds.has(clip.id))
    .some((clip) => external.some((outside) => overlaps(clip.startFrame, clip.startFrame + clip.durationInFrames, outside)
      && (originalOrder.indexOf(outside.id) < originalOrder.indexOf(itemId))
        !== (expandedOrder.indexOf(outside.id) < expandedOrder.indexOf(clip.id))))) {
    return fail('连续视频复用会改变展开后的叠放顺序。请先移开重叠画面，或保留子草稿。');
  }
  if (kept.some((entry, index) => isBackgroundFillActive(child, entry) !== isBackgroundFillActive(nextParent, items[index]!))) {
    return fail('展开会改变底层画面的背景填充，请先关闭背景填充，或将子草稿放回主轨。');
  }
  const next = { ...doc, timelines: doc.timelines.map((timeline) => timeline.id === parent.id ? nextParent : timeline) };
  const error = sequenceGraphError(next);
  return error ? fail(error.message) : { ok: true, doc: next, itemIds: items.map((entry) => entry.id) };
}
