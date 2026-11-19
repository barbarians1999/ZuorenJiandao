import type { TimelineState, TrackId } from '../../editor/types';
import { canItemMoveToTrack, groupMoveIds, moveItemsByDelta } from '../../editor/multiSelect';
import { rateStretchItem } from '../../editor/rateStretch';
import { sourceFramesToTimelineFrames, sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import type { EditorCommands } from '../../editor/store';
import { hasOperationalTranscript } from '../../transcript/types';
import type { Drag, EditMode } from './timelineUtil';
import { mainTrackId, planMagneticTrim } from '../../editor/magneticTimeline';
import { rebasePictureAnimationAfterTiming } from '../../editor/clipAnimation';
import { planRollingTrim } from '../../editor/rollingTrim';
import { showAppToast } from '../../ui/appToast';

/** Used for BOTH pointer preview and release, so ripple geometry cannot bounce. */
export function planTimelineMagneticTrim(state: TimelineState, drag: Drag, editMode: EditMode) {
  if (!state.interaction?.magnet || drag.baseTrack !== mainTrackId(state)
    || editMode === 'rate-stretch' || (drag.mode !== 'trim-left' && drag.mode !== 'trim-right')) return undefined;
  const target = state.items.find((item) => item.id === drag.id);
  if (!target) return undefined;
  const minimumDuration = Math.max(6, Math.round(state.fps * 0.5));
  if (drag.mode === 'trim-right') return planMagneticTrim(state, drag.id, {
    durationInFrames: drag.baseDur < minimumDuration
      ? Math.max(drag.baseDur, drag.baseDur + drag.deltaF)
      : Math.max(minimumDuration, drag.baseDur + drag.deltaF),
  });
  const sourceTimed = target.kind === 'video' || target.kind === 'audio' || target.kind === 'sequence';
  const delta = Math.min(Math.max(0, drag.baseDur - minimumDuration), drag.deltaF);
  return planMagneticTrim(state, drag.id, {
    startFrame: drag.baseStart + delta, durationInFrames: drag.baseDur - delta,
    ...(sourceTimed ? { srcInFrame: sourceWindowForTimelineRange(
      target.kind === 'audio' && hasOperationalTranscript(target) ? { ...target, playbackRate: 1 } : target,
      delta, drag.baseDur - delta,
    ).startFrame } : {}),
  });
}

/**
 * The right edge of the nearest same-track clip that ends at or before `baseStart`.
 * Used to clamp a left-extend trim so the dragged edge never overlaps its predecessor
 * (which would be rolled back by the overlap guard and "bounce" on release).
 */
export function predecessorRightEdge(state: TimelineState, id: string, track: TrackId | undefined, baseStart: number): number {
  let rightEdge = -Infinity;
  for (const item of state.items) {
    if (item.id === id || item.track !== track) continue;
    const end = item.startFrame + item.durationInFrames;
    if (end > baseStart) continue;
    if (end > rightEdge) rightEdge = end;
  }
  return rightEdge;
}

function commitMoveGesture(state: TimelineState, commands: EditorCommands, drag: Drag) {
  const { id, baseStart, deltaF, targetTrack, baseTrack } = drag;
  const baseItem = state.items.find((item) => item.id === id);
  const validTrack = !!targetTrack && !!baseItem && canItemMoveToTrack(state, baseItem, targetTrack);
  const track = validTrack ? targetTrack : baseTrack;
  if (deltaF === 0 && track === baseTrack) return;
  const ids = groupMoveIds(state, id);
  if (ids.length === 1) {
    commands.moveItem(id, { startFrame: Math.max(0, baseStart + deltaF), track });
    return;
  }
  const next = moveItemsByDelta(
    state,
    ids,
    deltaF,
    track !== baseTrack ? { from: baseTrack, to: track } : null,
  );
  if (next !== state) commands.applyState(next);
}

function commitTrimGesture(
  state: TimelineState,
  commands: EditorCommands,
  drag: Drag,
  editMode: EditMode,
) {
  const { id, mode, baseStart, baseDur, baseSrcIn, deltaF, baseTrack } = drag;
  if (editMode === 'rate-stretch') {
    const next = rateStretchItem(state, id, mode === 'trim-left' ? 'left' : 'right', deltaF);
    if (next !== state) commands.applyState(next);
    return;
  }
  if (mode === 'trim-left') {
    const target = state.items.find((item) => item.id === id);
    if (!target) return;
    const sourceTimed = target.kind === 'video' || target.kind === 'audio' || target.kind === 'sequence';
    const wordDriven = target.kind === 'audio' && hasOperationalTranscript(target);
    // Pictures, MG, text, solids and word-driven audio have no source
    // duration limit: their left edge can extend back to timeline zero.
    // Only real file media (video/plain audio/sequence) are bounded by
    // srcInFrame.
    let earliestDelta = -baseStart;
    if (sourceTimed) {
      const sourceBacktrack = wordDriven
        ? baseSrcIn
        : sourceFramesToTimelineFrames(target, baseSrcIn);
      earliestDelta = Math.max(earliestDelta, -Math.floor(sourceBacktrack));
    }
    // Left-extend must stop at the nearest preceding same-track clip's right edge.
    // Without this clamp the retime would overlap the predecessor and the reducer's
    // overlap guard would roll the whole gesture back — dragging past it would show
    // a preview extension but "bounce" on release.
    if (!(state.interaction?.magnet && baseTrack === mainTrackId(state))) {
      earliestDelta = Math.max(earliestDelta, predecessorRightEdge(state, id, baseTrack, baseStart) - baseStart);
    }
    const minDuration = Math.max(6, Math.round(state.fps * 0.5));
    const delta = Math.max(Math.min(deltaF, Math.max(0, baseDur - minDuration)), earliestDelta);
    if (delta === 0) return;
    const timing = {
      startFrame: baseStart + delta,
      durationInFrames: baseDur - delta,
      ...(sourceTimed ? {
        srcInFrame: wordDriven
          ? sourceWindowForTimelineRange(
              { srcInFrame: baseSrcIn, playbackRate: 1 },
              delta,
              baseDur - delta,
            ).startFrame
          : sourceWindowForTimelineRange(
              { ...target, srcInFrame: baseSrcIn },
              delta,
              baseDur - delta,
            ).startFrame,
      } : {}),
    };
    commands.setItemTiming(id, timing);
    return;
  }
  const minDuration = Math.max(6, Math.round(state.fps * 0.5));
  const durationInFrames = baseDur < minDuration
    ? Math.max(baseDur, baseDur + deltaF)
    : Math.max(minDuration, baseDur + deltaF);
  const actual = durationInFrames - baseDur;
  if (actual === 0) return;
  if (editMode !== 'trim' || (state.interaction?.magnet && baseTrack === mainTrackId(state))) {
    commands.setItemTiming(id, { durationInFrames });
    return;
  }
  const clipEnd = baseStart + baseDur;
  const items = state.items.map((item) =>
    item.id === id ? rebasePictureAnimationAfterTiming(item, { ...item, durationInFrames })
      : item.track === baseTrack && item.startFrame >= clipEnd
        ? { ...item, startFrame: item.startFrame + actual }
        : item);
  commands.applyState({ ...state, items });
}

export function commitTimelineDragGesture(
  state: TimelineState,
  commands: EditorCommands,
  drag: Drag,
  editMode: EditMode,
) {
  const magnetic = planTimelineMagneticTrim(state, drag, editMode);
  if (magnetic) {
    if (magnetic.error) window.alert(magnetic.error);
    else if (magnetic.state !== state) commands.applyState(magnetic.state);
    return;
  }
  if (drag.mode === 'roll') {
    if (!drag.rightId) { window.alert('滚动裁剪缺少右侧片段。'); return; }
    const current = commands.getState?.() ?? state;
    const plan = planRollingTrim(current, drag.id, drag.rightId, drag.deltaF);
    if (plan.error) window.alert(plan.error);
    else {
      if (plan.state !== current) commands.applyRollingTrim(drag.id, drag.rightId, drag.deltaF);
      if (plan.limitMessage) showAppToast(plan.limitMessage);
    }
    return;
  }
  if (drag.mode === 'slip') {
    if (Math.abs(drag.deltaF) >= 1e-6) commands.slipItem(drag.id, drag.deltaF);
  } else if (drag.mode === 'move') commitMoveGesture(state, commands, drag);
  else commitTrimGesture(state, commands, drag, editMode);
}
