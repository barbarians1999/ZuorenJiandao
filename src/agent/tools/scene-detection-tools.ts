export { SCENE_DETECTION_TOOL_SCHEMAS, SCENE_DETECTION_TOOL_NAMES } from './schemas/scene-detection-tools';
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import type { SceneChange } from '../../scene-detection/detect';
import {
  mapScenesToItem,
  sceneMarkerActions,
  sceneSplitActions,
  planSceneSplits,
  sceneRequestRange,
  sceneAnalysisIdentity,
} from '../../scene-detection/apply';

type Args = Record<string, unknown>;
type ApplyMode = 'report' | 'markers' | 'split';

const prefixed = <T extends { id: string }>(items: readonly T[], value: unknown): T | null => {
  const id = String(value ?? '').trim();
  return id ? (items.find((item) => item.id === id || item.id.startsWith(id)) ?? null) : null;
};

function sourceFor(ctx: AgentContext, args: Args): { asset: MediaAsset | null; item: TimelineItem | null; src: string } | { error: string } {
  const state = ctx.getState();
  const item = prefixed(state.items, args.itemId);
  if (args.itemId && !item) return { error: `timeline item not found: ${String(args.itemId)}` };
  if (item && item.kind !== 'video' && item.kind !== 'gif') return { error: `item ${item.id} is ${item.kind}; scene detection requires video/gif` };
  const asset = prefixed(ctx.getDoc().assets, args.assetId)
    ?? (item?.src ? ctx.getDoc().assets.find((candidate) => candidate.src === item.src) ?? null : null);
  if (args.assetId && !asset) return { error: `media asset not found: ${String(args.assetId)}` };
  if (asset && asset.kind !== 'video' && asset.kind !== 'gif') return { error: `asset ${asset.id} is ${asset.kind}; scene detection requires video/gif` };
  const src = item?.src ?? asset?.src ?? '';
  if (!src) return { error: 'itemId or assetId is required and must resolve to a source video' };
  if (!src.startsWith('/media/uploads/')) {
    return { error: 'scene detection requires a persisted local media source under /media/uploads; finish uploading or relink the asset first' };
  }
  return { asset, item, src };
}

export async function execSceneDetectionTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'detect_scenes') return { error: `unknown tool ${name}` };
  const target = sourceFor(ctx, args);
  if ('error' in target) return target;
  const initialState = ctx.getState();
  const timelineId = ctx.getDoc().activeTimelineId;
  const identity = target.item ? sceneAnalysisIdentity(initialState, target.item) : null;
  const apply = (args.apply === 'markers' || args.apply === 'split' ? args.apply : 'report') as ApplyMode;
  if (apply !== 'report' && !target.item) return { error: `apply=${apply} requires itemId so source cuts can be mapped onto the timeline` };
  if (target.item && ctx.getState().tracks?.[target.item.track]?.locked && apply !== 'report') {
    return { error: `track containing ${target.item.id} is locked` };
  }

  const minSceneSeconds = Number(args.minSceneSeconds);
  const sourceRange = target.item ? sceneRequestRange(target.item, initialState.fps) : null;
  if (target.item && !sourceRange) return { error: 'scene detection requires a valid forward playback range' };
  const body = {
    src: target.src,
    ...(sourceRange ?? {}),
    threshold: Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : undefined,
    minSceneMs: Number.isFinite(minSceneSeconds) ? Math.round(minSceneSeconds * 1000) : undefined,
    maxScenes: Number.isFinite(Number(args.maxScenes)) ? Number(args.maxScenes) : undefined,
  };
  const response = await fetch('/api/detect-scenes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
    durationMs?: number;
    threshold?: number;
    minSceneMs?: number;
    scenes?: SceneChange[];
  };
  if (!response.ok) return { error: result.error ?? `scene detection failed (${response.status})` };
  const scenes = result.scenes ?? [];
  const latest = ctx.getState();
  const currentItem = target.item ? latest.items.find((item) => item.id === target.item!.id) : null;
  if (target.item && (!currentItem || ctx.getDoc().activeTimelineId !== timelineId
    || sceneAnalysisIdentity(latest, currentItem) !== identity)) {
    return { error: 'timeline item or source range changed during scene analysis; run detection again' };
  }
  const mapped = currentItem ? mapScenesToItem(scenes, currentItem, latest.fps) : [];

  if (currentItem && apply !== 'report' && mapped.length) {
    if (latest.tracks?.[currentItem.track]?.locked) return { error: 'track was locked during scene analysis' };
    const plan = apply === 'split' && currentItem.kind === 'video' ? planSceneSplits(latest, currentItem.id, mapped) : null;
    if (plan && !plan.ok) return { error: plan.error };
    const actions = apply === 'markers' ? sceneMarkerActions(currentItem, mapped)
      : plan?.ok ? [{ type: 'setFullState' as const, state: plan.state }] : sceneSplitActions(currentItem, mapped);
    ctx.commands.batch(actions, apply === 'markers' ? 'Add scene markers' : 'Split clip at scene changes');
  }

  return {
    ok: true,
    apply,
    assetId: target.asset?.id ?? null,
    itemId: target.item?.id ?? null,
    durationMs: result.durationMs ?? null,
    threshold: result.threshold ?? null,
    minSceneMs: result.minSceneMs ?? null,
    detectedCount: scenes.length,
    applicableCount: target.item ? mapped.length : null,
    appliedCount: apply === 'report' ? 0 : mapped.length,
    scenes: target.item
      ? mapped.map((scene) => ({
          sourceTimeMs: scene.timeMs,
          timelineFrame: scene.timelineFrame,
          itemLocalFrame: scene.itemLocalFrame,
          score: scene.score,
          kind: scene.kind,
        }))
      : scenes.map((scene) => ({ sourceTimeMs: scene.timeMs, score: scene.score, kind: scene.kind })),
  };
}
