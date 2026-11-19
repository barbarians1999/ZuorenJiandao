import type { AtomicAction } from '../editor/reduce';
import type { TimelineItem, TimelineState, TimelineLinkGroup } from '../editor/types';
import { reduce } from '../editor/reducerTimeline';
import { linkedItemIds } from '../editor/linkGroups';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../editor/sourceLimit';
import type { SceneChange } from './detect';

export interface MappedScene extends SceneChange {
  timelineFrame: number;
  itemLocalFrame: number;
}

/** Map source-media cut times through clip trim and playback speed. */
export function mapScenesToItem(
  scenes: readonly SceneChange[],
  item: TimelineItem,
  fps: number,
): MappedScene[] {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(item.playbackRate ?? 1)
    || (item.playbackRate ?? 1) <= 0) return [];
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  const mapped = scenes.flatMap((scene): MappedScene[] => {
    if (!Number.isFinite(scene.timeMs) || !Number.isFinite(scene.score)) return [];
    const sourceFrame = (scene.timeMs / 1000) * fps;
    if (sourceFrame <= window.startFrame || sourceFrame >= window.endFrame) return [];
    const itemLocalFrame = Math.round(sourceFramesToTimelineFrames(item, sourceFrame - window.startFrame));
    if (itemLocalFrame <= 0 || itemLocalFrame >= item.durationInFrames) return [];
    return [{ ...scene, itemLocalFrame, timelineFrame: item.startFrame + itemLocalFrame }];
  });
  const unique = new Map(mapped.map((scene) => [scene.timelineFrame, scene]));
  return [...unique.values()].sort((a, b) => a.timelineFrame - b.timelineFrame);
}

/** The source window is independent of the clip's placement on the timeline. */
export function sceneRequestRange(item: TimelineItem, fps: number): { rangeStartMs: number; rangeEndMs: number } | null {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(item.playbackRate ?? 1)
    || (item.playbackRate ?? 1) <= 0 || !Number.isFinite(item.durationInFrames) || item.durationInFrames < 1) return null;
  const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
  if (!Number.isFinite(window.startFrame) || !Number.isFinite(window.endFrame) || window.endFrame <= window.startFrame) return null;
  return { rangeStartMs: window.startFrame / fps * 1000, rangeEndMs: window.endFrame / fps * 1000 };
}

/** Placement changes can be remapped; trim, source, speed or timeline changes require a new analysis. */
export function sceneAnalysisIdentity(state: TimelineState, item: TimelineItem): string {
  return JSON.stringify([(state as TimelineState & { id?: string }).id, state.fps, item.id, item.kind,
    item.src, item.sourceRevision, item.sourceContentHash, item.srcInFrame ?? 0,
    item.durationInFrames, item.playbackRate ?? 1]);
}

export function sceneDetectionUnavailable(state: TimelineState, item: TimelineItem | null): string | null {
  if (!item || item.kind !== 'video') return '请先选择视频片段';
  if (!item.src?.startsWith('/media/uploads/')) return '请先完成素材导入，再智能分割镜头';
  if (!sceneRequestRange(item, state.fps)) return '当前片段的速度或素材范围无法分析';
  if (state.tracks?.[item.track]?.locked) return '当前轨道已锁定，无法应用场景检测结果';
  return null;
}

export type SceneSplitPlan = { ok: true; state: TimelineState; cutCount: number; linkedAudioCount: number }
  | { ok: false; error: string };

/** Plan the entire edit before committing: A/V links follow the same timeline cuts,
 * while ordinary groups, independent music and captions do not create extra cuts. */
export function planSceneSplits(state: TimelineState, itemId: string, scenes: readonly MappedScene[],
  createId: (prefix: string) => string = (prefix) => `${prefix}_${crypto.randomUUID()}`): SceneSplitPlan {
  const target = state.items.find((item) => item.id === itemId);
  const unavailable = sceneDetectionUnavailable(state, target ?? null);
  if (!target || unavailable) return { ok: false, error: unavailable ?? '当前视频片段已不存在，请重新选择' };
  const cuts = [...new Set(scenes.map((scene) => scene.timelineFrame))]
    .filter((frame) => Number.isInteger(frame) && frame > target.startFrame
      && frame < target.startFrame + target.durationInFrames).sort((a, b) => a - b);
  if (!cuts.length) return { ok: false, error: '请至少选择一个可用切点' };
  const memberIds = new Set(linkedItemIds(state, [target.id]));
  const members = state.items.filter((item) => memberIds.has(item.id)
    && (item.kind === 'video' || item.kind === 'audio'));
  if (members.some((item) => state.tracks?.[item.track]?.locked)) {
    return { ok: false, error: '关联的音视频轨道已锁定，请解锁后再分割' };
  }
  if (members.some((item) => !Number.isFinite(item.playbackRate ?? 1) || (item.playbackRate ?? 1) <= 0)) {
    return { ok: false, error: '关联音视频存在不支持的速度，请调整后再分割' };
  }
  const fragments = new Map<string, string[]>();
  let next = state;
  for (const member of members) {
    let currentId = member.id;
    const ids = [currentId];
    for (const frame of cuts) {
      if (frame <= member.startFrame || frame >= member.startFrame + member.durationInFrames) continue;
      const rightId = createId('item');
      const split = reduce(next, { type: 'split', id: currentId, atFrame: frame, newId: rightId });
      if (split === next || !split.items.some((item) => item.id === rightId)) {
        return { ok: false, error: '当前片段无法安全分割，请检查关联轨道和素材范围' };
      }
      next = split;
      ids.push(rightId);
      currentId = rightId;
    }
    fragments.set(member.id, ids);
  }
  const byId = new Map(next.items.map((item) => [item.id, item]));
  const links: TimelineLinkGroup[] = [];
  for (const group of state.linkGroups ?? []) {
    if (group.mode !== 'linked' || !group.itemIds.some((id) => fragments.has(id))) { links.push(group); continue; }
    // One new link group per band prevents a right-hand shot from dragging the
    // unsplit original audio or reconnecting every shot into one large group.
    const bands = new Map<number, string[]>();
    for (const originalId of group.itemIds) {
      for (const fragmentId of fragments.get(originalId) ?? [originalId]) {
        const fragment = byId.get(fragmentId);
        if (!fragment) continue;
        const band = cuts.filter((frame) => frame <= fragment.startFrame).length;
        const ids = bands.get(band) ?? [];
        ids.push(fragmentId);
        bands.set(band, ids);
      }
    }
    for (const [band, ids] of bands) {
      const itemIds = [...new Set(ids)];
      if (itemIds.length < 2) continue;
      const anchorIds = fragments.get(group.anchorItemId) ?? [group.anchorItemId];
      links.push({ ...group, id: band === 0 ? group.id : createId('link'), itemIds,
        anchorItemId: itemIds.find((id) => anchorIds.includes(id)) ?? itemIds[0]! });
    }
  }
  return { ok: true, state: { ...next, linkGroups: links.length ? links : undefined }, cutCount: cuts.length,
    linkedAudioCount: members.filter((member) => member.kind === 'audio' && (fragments.get(member.id)?.length ?? 0) > 1).length };
}

export function sceneMarkerActions(item: TimelineItem, scenes: readonly MappedScene[]): AtomicAction[] {
  return scenes.map((scene, index) => ({
    type: 'addMarker',
    marker: {
      id: `marker_${crypto.randomUUID()}`,
      scope: 'item',
      itemId: item.id,
      fromFrame: scene.timelineFrame,
      durationFrames: 0,
      note: `Scene ${index + 1} · ${scene.kind} · score ${scene.score.toFixed(3)}`,
      color: scene.kind === 'cut' ? 'yellow' : 'purple',
    },
  }));
}

export function sceneSplitActions(item: TimelineItem, scenes: readonly MappedScene[]): AtomicAction[] {
  let currentId = item.id;
  return scenes.map((scene) => {
    const nextId = `item_${crypto.randomUUID()}`;
    const action: AtomicAction = {
      type: 'split', id: currentId, atFrame: scene.timelineFrame, newId: nextId,
    };
    currentId = nextId;
    return action;
  });
}
