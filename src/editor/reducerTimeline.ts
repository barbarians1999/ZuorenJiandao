import type { TimelineState } from './types';
import { selectedIdsOf } from './types';
import { fitTimelineItems } from './clipFit';
import { reconcileTransitions } from './transitionReconcile';
import { introducesTrackOverlap } from './trackCollision';
import { removeItemsWithGroups } from './linkGroups';
import type { Action } from './reducerActions';
import { actionPolicyFor } from './reducerActionPolicy';
import { applyClipAction } from './reducerClipActions';
import { applyTrackAction } from './reducerTrackActions';
import { applyTranscriptAction } from './reducerTranscriptActions';
import { remapSplitTransitionEndpoints, splitTimelineItem } from './reducerOverwrite';
import { remapSplitTimelineCaptionReferences } from '../captions/reconcileSources';
import { mainTrackId, planDirectionalChange, planMagneticDelete } from './magneticTimeline';
import { planRollingTrim } from './rollingTrim';

export function reduce(s: TimelineState, a: Action): TimelineState {
  const policy = actionPolicyFor(a.type);
  if (a.type === 'roll') {
    const plan = planRollingTrim(s, a.leftId, a.rightId, a.deltaF);
    return plan.error ? s : plan.state;
  }
  const raw = fitTimelineItems(applyAction(s, a));
  // Full-state UI gestures and atomic commands share directional constraints.
  // Magnetic planners already finalize; rechecking the same before/after is
  // idempotent and also covers existing ripple/overwrite command paths.
  const applied = policy.guardOverlaps && s.interaction?.linkage
    ? planDirectionalChange(s, raw).state : raw;
  const guarded = policy.guardOverlaps && introducesTrackOverlap(s, applied)
    ? s
    : applied;
  const next = guarded !== s && guarded.compositingOrder !== 'tracks'
    && (s.compositingOrder === 'tracks' || s.items.some(item => item.kind === 'mosaic')
      || guarded.items.some(item => item.kind === 'mosaic'))
    ? { ...guarded, compositingOrder: 'tracks' as const } : guarded;
  if (!policy.reconcileTransitions || !next.transitions?.length) return next;
  // Reference-stability contract: a no-op (or rejected) action must return the
  // original state, or historyReduce records a phantom undo step and clears redo.
  const reconciled = reconcileTransitions(next.items, next.transitions);
  return reconciled === next.transitions ? next : { ...next, transitions: reconciled };
}

function applyAction(s: TimelineState, a: Action): TimelineState {
  const delegated = applyClipAction(s, a)
    ?? applyTrackAction(s, a, reduce)
    ?? applyTranscriptAction(s, a);
  if (delegated) return delegated;
  switch (a.type) {
    case 'remove':
      if (s.interaction?.magnet && s.items.some((it) => it.id === a.id && it.track === mainTrackId(s))) {
        return planMagneticDelete(s, [a.id]).state;
      }
      return removeItemsWithGroups(s, [a.id], a.ripple);
    case 'split': {
      const item = s.items.find((candidate) => candidate.id === a.id);
      if (!item || s.tracks?.[item.track]?.locked
        || !a.newId || s.items.some((candidate) => candidate.id === a.newId)
        || !Number.isFinite(a.atFrame)) return s;
      // The frame domain is integral (snap, collision, timecode all assume it);
      // a fractional cut point from a tool call must not enter the document.
      const atFrame = Math.round(a.atFrame);
      if (atFrame <= item.startFrame
        || atFrame >= item.startFrame + item.durationInFrames) return s;
      const [left, right] = splitTimelineItem(s, item, atFrame, a.newId);
      return remapSplitTimelineCaptionReferences({
        ...s,
        items: s.items.flatMap((candidate) => candidate.id === a.id ? [left, right]
          : [candidate.mainClipId === item.id && candidate.startFrame >= atFrame
            ? { ...candidate, mainClipId: right.id } : candidate]),
        transitions: remapSplitTransitionEndpoints(s.transitions, item.id, right.id),
      }, item.id, right.id);
    }
    case 'select': {
      if (a.id === null) return { ...s, selectedId: null, selectedIds: [] };
      const mode = a.mode ?? 'replace';
      let ids = selectedIdsOf(s);
      if (mode === 'replace') ids = [a.id];
      else if (mode === 'toggle') {
        ids = ids.includes(a.id) ? ids.filter((id) => id !== a.id) : [...ids, a.id];
      } else if (mode === 'add') {
        if (!ids.includes(a.id)) ids = [...ids, a.id];
      }
      // drop ids that no longer exist
      const live = new Set(s.items.map((it) => it.id));
      ids = ids.filter((id) => live.has(id));
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'selectMany': {
      const live = new Set(s.items.map((it) => it.id));
      const ids = a.ids.filter((id) => live.has(id));
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'selectAll': {
      const ids = s.items.map((it) => it.id);
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'setFullState':
      return a.state; // atomic commit of a proposal's result (one history step)
    default:
      return s;
  }
}
