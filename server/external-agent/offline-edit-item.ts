import type { AgentContext } from '../../src/agent/context.js';
import { SERVER_DIRECT_TEMPLATE_IDS } from '../../src/agent/external-tool-policy.js';
import { executeAtomicEditBatch, type EditItemOperation } from '../../src/agent/tools/edit-item-batch.js';
import {
  rejectSpecializedUnknownFields,
  resolveUpdateType,
  shouldCoerceEffectUpdateToClip,
  stripEffectLocators,
} from '../../src/agent/tools/edit-item-fields.js';
import {
  AUTHORED_ADD_KINDS,
  GENERIC_ADD_KINDS,
  GENERIC_ITEM_KINDS,
  applyGeneric,
  validateAuthoredAdd,
  validateGenericAdd,
  validateGenericDelete,
  validateGenericUpdate,
  validateSlipUpdate,
} from '../../src/agent/tools/edit-item-generic.js';
import { replaceTimelineItemAsset } from '../../src/agent/tools/edit-item-pool-replacement.js';
import {
  validateBuiltinTransitionAdd,
  validateLocalMgAdd,
  validateTransitionDeleteShared,
  validateTransitionUpdateShared,
} from '../../src/agent/tools/edit-item-pure-specials.js';
import type { OpResult } from '../../src/agent/tools/edit-item-shared.js';
import { makeDraft, type DraftEngine } from '../../src/editor/store.js';
import type { TimelineItem, TransitionType } from '../../src/editor/types.js';
import { EXPLAINER_TEMPLATES } from '../../src/library/explainerTemplates.js';
import { resolveEditItemFonts } from '../../src/agent/fontResolver.js';

const OFFLINE_TEMPLATES = EXPLAINER_TEMPLATES.filter((t) => SERVER_DIRECT_TEMPLATE_IDS.has(t.id));

type Entry = Record<string, unknown>;

interface OfflineEditItemDraft {
  engine: DraftEngine;
  context: AgentContext;
}

function findItem(items: readonly TimelineItem[], id: unknown): TimelineItem | null {
  const query = String(id ?? '');
  if (!query) return null;
  return items.find((item) => item.id === query || item.id.startsWith(query)) ?? null;
}

function validateOfflineAdd(ctx: AgentContext, entry: Entry): OpResult {
  const type = String(entry.type ?? '');
  const assetId = String(entry.assetId ?? '');
  if (type === 'effect') {
    return { error: 'edit_item adds type "effect" requires the browser editor' };
  }
  if (type === 'transition') {
    const unknown = rejectSpecializedUnknownFields('adds', 'transition', entry);
    if (unknown) return { error: unknown };
    return validateBuiltinTransitionAdd(ctx.getState(), entry);
  }
  if (type === 'motion-graphic' && assetId.startsWith('library:motion-graphic:')) {
    const tplId = assetId.slice('library:motion-graphic:'.length);
    if (!SERVER_DIRECT_TEMPLATE_IDS.has(tplId)) {
      return { error: 'library motion-graphic additions require the browser editor' };
    }
    const unknown = rejectSpecializedUnknownFields('adds', 'motion-graphic', entry);
    return unknown ? { error: unknown } : validateLocalMgAdd(ctx.getState(), OFFLINE_TEMPLATES, entry);
  }
  if (type === 'audio' && assetId.startsWith('library:sound:')) {
    return { error: 'library sound additions require the browser editor' };
  }
  if (AUTHORED_ADD_KINDS.has(type)) return validateAuthoredAdd(ctx.getState(), entry);
  if (GENERIC_ADD_KINDS.has(type)) return validateGenericAdd(ctx.getState(), ctx.getDoc().assets ?? [], entry);
  return {
    error: `add type not supported: ${type}`,
    supported: ['video', 'image', 'gif', 'svg', 'audio', 'text', 'solid', 'shape', 'transition', 'motion-graphic'],
  };
}

function validateOfflineUpdate(ctx: AgentContext, entry: Entry): OpResult {
  if (entry.operation !== undefined) return validateSlipUpdate(ctx.getState(), entry);
  const item = findItem(ctx.getState().items, entry.itemId ?? entry.id ?? entry.targetItemId);
  const type = resolveUpdateType(entry, item?.kind, GENERIC_ITEM_KINDS);
  if (shouldCoerceEffectUpdateToClip(entry, type, item?.kind, GENERIC_ITEM_KINDS) && item) {
    return validateGenericUpdate(
      ctx.getState(),
      stripEffectLocators(entry, item.kind, item.id),
      ctx.getDoc().assets,
    );
  }
  if (type === 'effect') {
    return { error: 'edit_item updates type "effect" requires the browser editor' };
  }
  if (type === 'transition') {
    const unknown = rejectSpecializedUnknownFields('updates', 'transition', entry);
    return unknown ? { error: unknown } : validateTransitionUpdateShared(ctx.getState(), entry);
  }
  if (GENERIC_ITEM_KINDS.has(type)) {
    return validateGenericUpdate(
      ctx.getState(),
      item ? stripEffectLocators(entry, type, item.id) : entry,
      ctx.getDoc().assets,
    );
  }
  return {
    error: `update type not supported: ${type}`,
    supported: [...GENERIC_ITEM_KINDS],
    hint: 'type must be the item\'s actual kind (video/audio/image/gif/svg/text/solid/motion-graphic/sequence), never the literal "generic" or "clip"',
  };
}

function validateOfflineDelete(ctx: AgentContext, entry: Entry): OpResult {
  const type = String(entry.type ?? '');
  if (!type || type === 'effect') {
    return { error: `edit_item deletes type "${type || 'effect'}" requires the browser editor` };
  }
  if (type === 'transition') {
    const unknown = rejectSpecializedUnknownFields('deletes', 'transition', entry);
    return unknown ? { error: unknown } : validateTransitionDeleteShared(ctx.getState(), entry);
  }
  if (GENERIC_ITEM_KINDS.has(type)) return validateGenericDelete(ctx.getState(), entry);
  return { error: `delete unsupported type ${type}` };
}

function validateOperation(draft: OfflineEditItemDraft, operation: EditItemOperation): OpResult {
  if (operation.bucket === 'adds') return validateOfflineAdd(draft.context, operation.entry);
  if (operation.bucket === 'updates') return validateOfflineUpdate(draft.context, operation.entry);
  return validateOfflineDelete(draft.context, operation.entry);
}

function commitMediaPlan(ctx: AgentContext, plan: OpResult): OpResult {
  const asset = (ctx.getDoc().assets ?? []).find((item) => item.id === plan.assetId);
  if (!asset) return { error: `pool asset vanished: ${String(plan.assetId)}` };
  const durationInFrames = typeof plan.durationInFrames === 'number'
    ? Number(plan.durationInFrames)
    : undefined;
  const srcInFrame = typeof plan.srcInFrame === 'number'
    ? Number(plan.srcInFrame)
    : undefined;
  const sourceFramesNeeded = (srcInFrame ?? 0) + (durationInFrames ?? asset.durationInFrames);
  const importAsset = asset.durationInFrames >= sourceFramesNeeded
    ? asset
    : { ...asset, durationInFrames: sourceFramesNeeded };
  const itemId = ctx.commands.addMediaItem(importAsset, {
    track: plan.track as string,
    startFrame: plan.startFrame as number | undefined,
    srcInFrame,
    durationInFrames,
  });
  if (plan.props && typeof plan.props === 'object') {
    ctx.commands.updateItemProps(itemId, plan.props as Record<string, unknown>);
  }
  return {
    ok: true,
    kind: plan.kind,
    placed: {
      assetId: asset.id,
      itemId,
      name: asset.name,
      kind: asset.kind,
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: durationInFrames ?? asset.durationInFrames,
      srcInFrame,
    },
  };
}

function commitPoolAssetReplacement(ctx: AgentContext, plan: OpResult): OpResult {
  const doc = ctx.getDoc();
  const asset = doc.assets.find((candidate) => candidate.id === plan.assetId);
  if (!asset) return { error: `pool asset vanished: ${String(plan.assetId)}` };
  const next = replaceTimelineItemAsset(doc, doc.activeTimelineId, String(plan.itemId), asset, {
    durationInFrames: Number(plan.durationInFrames),
    srcInFrame: typeof plan.srcInFrame === 'number' ? plan.srcInFrame : undefined,
  });
  ctx.commands.applyDoc(next);
  const timeline = next.timelines.find((entry) => entry.id === next.activeTimelineId);
  const item = timeline?.items.find((entry) => entry.id === plan.itemId);
  return {
    ok: true,
    plan: 'replacePoolAsset',
    itemId: plan.itemId,
    assetId: asset.id,
    kind: asset.kind,
    track: item?.track,
    startFrame: item?.startFrame,
    durationInFrames: plan.durationInFrames,
    sourceStartFrame: plan.sourceStartFrame,
    sourceDurationInFrames: plan.sourceDurationInFrames,
  };
}

function commitOfflinePlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  if (!plan.ok || plan.error) return plan;
  const name = String(plan.plan);
  if (name === 'addMedia') return commitMediaPlan(ctx, plan);
  if (name === 'replacePoolAsset') return commitPoolAssetReplacement(ctx, plan);
  if (name === 'addText') {
    const itemId = ctx.commands.addTextClip({
      track: plan.track as string | undefined,
      strictTrack: plan.strictTrack === true,
      startFrame: plan.startFrame as number | undefined,
      durationInFrames: plan.durationInFrames as number | undefined,
      ripple,
      name: plan.name as string | undefined,
      text: plan.text as string | undefined,
      fontSize: plan.fontSize as number | undefined,
      color: plan.color as string | undefined,
      fontWeight: plan.fontWeight as number | undefined,
      align: plan.align as 'left' | 'center' | 'right' | undefined,
    });
    if (plan.props && typeof plan.props === 'object') {
      ctx.commands.updateItemProps(itemId, plan.props as Record<string, unknown>);
    }
    const placedTrack = ctx.getState().items.find((i) => i.id === itemId)?.track ?? plan.track;
    return {
      ok: true,
      kind: 'text',
      placed: {
        itemId,
        name: plan.name ?? '文字',
        text: plan.text,
        track: placedTrack,
        startFrame: plan.startFrame ?? 'appended',
        durationInFrames: plan.durationInFrames ?? 90,
        color: plan.color,
        fontSize: plan.fontSize,
      },
      ripple,
    };
  }
  if (name === 'addSolid') {
    const itemId = ctx.commands.addSolidItem({
      track: plan.track as string | undefined,
      strictTrack: plan.strictTrack === true,
      startFrame: plan.startFrame as number | undefined,
      durationInFrames: plan.durationInFrames as number | undefined,
      color: plan.color as string | undefined,
      name: plan.name as string | undefined,
      props: plan.props as Record<string, unknown> | undefined,
      ripple,
    });
    const placedTrack = ctx.getState().items.find((i) => i.id === itemId)?.track ?? plan.track;
    return {
      ok: true,
      kind: 'solid',
      placed: {
        itemId,
        name: plan.name ?? '纯色',
        color: plan.color ?? '#1a1a1a',
        track: placedTrack,
        startFrame: plan.startFrame ?? 'appended',
        durationInFrames: plan.durationInFrames ?? 150,
      },
      ripple,
    };
  }
  if (name === 'addMg') {
    const template = OFFLINE_TEMPLATES.find((item) => item.id === plan.templateId);
    if (!template) return { error: `offline template vanished: ${String(plan.templateId)}` };
    const itemId = ctx.commands.addMotionGraphic(template, {
      track: plan.track as string | undefined,
      strictTrack: plan.strictTrack === true,
      startFrame: plan.startFrame as number | undefined,
      durationInFrames: plan.durationInFrames as number | undefined,
      name: plan.name as string | undefined,
      props: plan.props as Record<string, unknown> | undefined,
      ripple,
    });
    const placedTrack = ctx.getState().items.find((i) => i.id === itemId)?.track ?? plan.track;
    return {
      ok: true,
      kind: 'motion-graphic',
      itemId,
      templateId: template.id,
      name: plan.name ?? template.name,
      track: placedTrack,
      ripple,
    };
  }
  if (name === 'addTransition') {
    const id = ctx.commands.addTransition(
      String(plan.incomingItemId),
      plan.type as TransitionType,
      plan.durationInFrames as number | undefined,
    );
    if (plan.extraPatch && typeof plan.extraPatch === 'object') {
      ctx.commands.setTransition(id, plan.extraPatch as Record<string, unknown>);
    }
    return {
      ok: true,
      kind: 'transition',
      transition: {
        id,
        type: plan.type,
        assetId: plan.assetId ?? `builtin:tr-${String(plan.type)}`,
        durationInFrames: plan.durationInFrames,
        outgoingItemId: plan.outgoingItemId,
        incomingItemId: plan.incomingItemId,
        ...(plan.extraPatch ? (plan.extraPatch as Record<string, unknown>) : {}),
      },
    };
  }
  if (name === 'setTransition') {
    ctx.commands.setTransition(
      String(plan.id),
      plan.patch as Partial<{ type: TransitionType; durationInFrames: number }>,
    );
    return { ok: true, kind: 'transition', id: plan.id, patch: plan.patch };
  }
  if (name === 'removeTransition') {
    ctx.commands.removeTransition(String(plan.id));
    return { ok: true, deleted: 'transition', id: plan.id };
  }
  if (name === 'genericUpdate' || name === 'genericDelete' || name === 'slip'
    || name === 'replaceMedia' || name === 'relinkMedia') {
    return applyGeneric(plan, ctx.commands) ?? { error: `unknown plan ${name}` };
  }
  return { error: `unknown plan ${name}` };
}

/**
 * Pure-data offline executor for `edit_item` (pool media placement, authored text/solid,
 * generic clip updates/deletes/slip/pool replacement) without GL/library/browser imports.
 */
export async function execOfflineEditItemTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  const ripple = args.ripple === true;
  const { args: resolvedArgs, resolvedAssets } = await resolveEditItemFonts(args, ctx);
  return executeAtomicEditBatch<OfflineEditItemDraft>(resolvedArgs, {
    createDraft: () => {
      const engine = makeDraft(ctx.getDoc());
      return {
        engine,
        context: {
          ...ctx,
          commands: engine.commands,
          getState: engine.getState,
          getDoc: engine.getDoc,
        },
      };
    },
    validate: validateOperation,
    apply: (draft, plan) => commitOfflinePlan(draft.context, plan, ripple),
    publish: (draft) => {
      for (const asset of resolvedAssets) {
        if (!draft.context.getDoc().assets.some((entry) => entry.id === asset.id)) {
          draft.context.commands.addAsset(asset);
        }
      }
      ctx.commands.applyDoc(draft.engine.getDoc());
    },
  });
}
