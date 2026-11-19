import { activeTimeline, timelineTrackIds, trackKind, type ProjectDoc, type Timeline } from './types';
import { sequenceGraphError } from './sequenceGraph';
import { resolveCaptionWords } from '../captions/resolve';
import { mainTrackId } from './magneticTimeline';

/** Move selected clips into an editable nested timeline in one history step. */
export function planSubdraft(doc: ProjectDoc, ids: readonly string[], uid: (prefix: string) => string):
  { ok: true; doc: ProjectDoc; timelineId: string; itemId: string } | { ok: false; error: string } {
  const parent = activeTimeline(doc);
  const chosen = new Set(ids);
  const items = parent.items.filter((item) => chosen.has(item.id));
  if (!items.length) return { ok: false, error: '请先选择要合并的片段。' };
  if (items.some((item) => parent.tracks?.[item.track]?.locked)) return { ok: false, error: '请先解锁所选片段的轨道。' };
  const all = items.length === parent.items.length;
  const order = timelineTrackIds(parent);
  const tracks = new Set(items.map((item) => item.track));
  const crossing = (groupIds: string[]) => groupIds.some((id) => chosen.has(id)) && groupIds.some((id) => !chosen.has(id));
  if (parent.linkGroups?.some((group) => crossing(group.itemIds))
    || parent.multicamGroups?.some((group) => crossing(group.angles.map((angle) => angle.itemId)))) {
    return { ok: false, error: '请把已链接或多机位组合的所有片段一起选中。' };
  }
  if (!all && parent.multicamGroups?.some((group) => group.angles.some((angle) => chosen.has(angle.itemId)))) {
    return { ok: false, error: '多机位组合请选择全部片段创建子草稿，以保留切换时间。' };
  }
  if (Object.values(parent.tracks ?? {}).some((track) => track?.soloed)) return { ok: false, error: '请先关闭轨道独奏，再创建子草稿。' };
  if (!all && [...tracks].some((id) => parent.tracks?.[id]?.role || parent.tracks?.[id]?.audioRouting)) {
    return { ok: false, error: '含跨轨配乐压低规则时，请选择全部片段创建子草稿。' };
  }
  const captionData = [parent.captions, ...Object.values(parent.tracks ?? {}).map((track) => track?.captions)].filter(Boolean);
  if (!all && captionData.some((caption) => caption!.sourceMode === 'timeline'
    || (caption!.sources ?? []).some((id) => chosen.has(id)) || chosen.has(caption!.sourceItemId ?? '')
    || caption!.sourceEntries?.some((entry) => chosen.has(entry.itemId)))) {
    return { ok: false, error: '所选片段关联已有字幕，请一并选择全部片段，或在子草稿整理完后生成字幕。' };
  }
  const start = all ? 0 : Math.min(...items.map((item) => item.startFrame));
  const end = Math.max(...items.map((item) => item.startFrame + item.durationInFrames),
    ...(all ? captionData.flatMap((caption) => resolveCaptionWords(caption!, parent.items, parent.fps)
      .map((word) => Math.ceil(word.end * parent.fps / 1000))) : []));
  const main = mainTrackId(parent);
  const replacesMain = main !== null && items.some((item) => item.track === main);
  if (replacesMain && parent.items.some((item) => item.track === main && !chosen.has(item.id)
    && item.startFrame < end && item.startFrame + item.durationInFrames > start)) {
    return { ok: false, error: '子草稿范围内还有未选中的主轨片段，请把中间片段一起选中，以保持主轨顺序。' };
  }
  const mainFlags = main ? parent.tracks?.[main] : undefined;
  if (replacesMain && !all && ((mainFlags?.hidden && items.some((item) => item.track !== main
    && !parent.tracks?.[item.track]?.hidden)) || (mainFlags?.muted && items.some((item) => item.track !== main
    && ['audio', 'video', 'sequence'].includes(item.kind) && !parent.tracks?.[item.track]?.muted
    && !parent.tracks?.[item.track]?.hidden)))) {
    return { ok: false, error: '主轨的隐藏或静音设置会影响合并后的其他轨道，请先关闭该设置，或全选创建子草稿。' };
  }
  const externalParents = new Set(items.map((item) => item.mainClipId).filter((id): id is string => !!id && !chosen.has(id)));
  if (!replacesMain && externalParents.size > 0
    && (externalParents.size !== 1 || items.some((item) => !item.mainClipId || !externalParents.has(item.mainClipId)))) {
    return { ok: false, error: '所选片段的主轨联动对象不同，请先解除联动，或把对应主轨片段一并放入子草稿。' };
  }
  const visualOrders = items.filter((item) => item.kind !== 'audio').map((item) => order.indexOf(item.track));
  const top = visualOrders.length ? Math.min(...visualOrders) : order.findIndex((id) => trackKind(parent, id) === 'video');
  const bottom = visualOrders.length ? Math.max(...visualOrders) : top;
  if (parent.items.some((item) => !chosen.has(item.id) && item.kind !== 'audio'
    && item.startFrame < end && item.startFrame + item.durationInFrames > start
    && order.indexOf(item.track) > top && order.indexOf(item.track) < bottom)) {
    return { ok: false, error: '所选轨道之间还有叠放的画面，请一起选中，以保持画面层次。' };
  }
  if (parent.transitions?.some((transition) => chosen.has(transition.incomingItemId) !== chosen.has(transition.outgoingItemId))) {
    return { ok: false, error: '请把转场两侧的片段一起选中。' };
  }
  const timelineId = uid('tl');
  const itemId = uid('item');
  const trackId = replacesMain ? main! : uid('track');
  const name = `子草稿 ${doc.timelines.length}`;
  const child: Timeline = {
    ...parent, id: timelineId, name, hidden: false,
    order: Math.max(...doc.timelines.map((timeline) => timeline.order)) + 1,
    items: items.map((item) => ({ ...item, startFrame: item.startFrame - start,
      ...(item.mainClipId && !chosen.has(item.mainClipId) ? { mainClipId: undefined } : {}),
    })),
    selectedId: null, selectedIds: [],
    trackOrder: all ? order : order.filter((id) => tracks.has(id)),
    tracks: Object.fromEntries(Object.entries(parent.tracks ?? {}).filter(([id]) => all || tracks.has(id))),
    transitions: parent.transitions?.filter((transition) => chosen.has(transition.incomingItemId) && chosen.has(transition.outgoingItemId)),
    captions: all ? parent.captions : null,
    watermark: undefined, markers: [],
    linkGroups: parent.linkGroups?.filter((group) => group.itemIds.every((id) => chosen.has(id))),
    multicamGroups: parent.multicamGroups?.filter((group) => group.angles.every((angle) => chosen.has(angle.itemId))),
  };
  // An editable composite keeps its authored multitrack layout. It must not
  // inherit magnet ON and unexpectedly close intentional internal gaps.
  child.interaction = { ...parent.interaction, mainTrackId: mainTrackId(child) ?? undefined, magnet: false };
  const nextParent: Timeline = {
    ...parent, selectedId: null, selectedIds: [],
    items: [...parent.items.filter((item) => !chosen.has(item.id)).map((item) =>
      item.mainClipId && chosen.has(item.mainClipId) ? { ...item, mainClipId: itemId } : item), {
      id: itemId, kind: 'sequence', timelineId, name, track: trackId,
      startFrame: start, durationInFrames: end - start, srcInFrame: 0,
      width: parent.width, height: parent.height,
      ...(!replacesMain && externalParents.size === 1 ? { mainClipId: [...externalParents][0] } : {}),
    }],
    trackOrder: replacesMain ? order : [...order.slice(0, Math.max(0, top)), trackId, ...order.slice(Math.max(0, top))],
    tracks: {
      ...Object.fromEntries(Object.entries(parent.tracks ?? {}).map(([id, flags]) => [id,
        all ? { ...flags, captions: null, role: undefined, audioRouting: undefined } : flags])),
      [trackId]: replacesMain ? { ...parent.tracks?.[trackId],
        ...(all ? { hidden: false, muted: false, captions: null, role: undefined, audioRouting: undefined } : {}),
      } : { kind: 'video', name },
    },
    captions: all ? null : parent.captions,
    transitions: parent.transitions?.filter((transition) => !chosen.has(transition.incomingItemId) && !chosen.has(transition.outgoingItemId)),
    linkGroups: parent.linkGroups?.filter((group) => !group.itemIds.some((id) => chosen.has(id))),
    multicamGroups: parent.multicamGroups?.filter((group) => !group.angles.some((angle) => chosen.has(angle.itemId))),
  };
  const next = { ...doc, timelines: [...doc.timelines.map((timeline) => timeline.id === parent.id ? nextParent : timeline), child] };
  const error = sequenceGraphError(next);
  return error ? { ok: false, error: error.message } : { ok: true, doc: next, timelineId, itemId };
}
