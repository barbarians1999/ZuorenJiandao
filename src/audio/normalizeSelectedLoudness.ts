import { planInspectorBatch } from '../editor/inspectorBatch';
import { captureTimelineItemSource, validateTimelineItemSourceBatch } from '../editor/mediaSourceRevision';
import { sourceFrameAt } from '../editor/sourceLimit';
import type { EditorCommands } from '../editor/store';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { analyzeLoudnessSelections, gainForTarget, type LoudnessSelection } from './loudness';

const TARGET_LUFS = -14;
const PEAK_LIMIT = 10 ** (-1 / 20);

function loudnessSnapshot(item: TimelineItem): string {
  return JSON.stringify([
    item.src, item.sourceAssetId, item.sourceRevision, item.sourceContentHash, item.srcInFrame, item.durationInFrames,
    item.playbackRate, item.transcript, item.transcriptStale,
    item.transcriptGenerationId,
    item.denoisedSrc, item.denoiseStrength, item.volume, item.keyframes?.volume,
  ]);
}

export function loudnessSelectionForItem(item: TimelineItem, state: TimelineState): LoudnessSelection {
  if (item.denoisedSrc) throw new Error('含降噪处理的片段暂不支持统一响度；未修改任何片段。');
  if (item.keyframes?.volume?.length) throw new Error('此片段包含音量关键帧，统一响度无法保留自动化曲线；未修改任何片段。');
  if (item.playbackRate !== undefined && (!Number.isFinite(item.playbackRate) || item.playbackRate < 0.01)) {
    throw new Error('片段变速无效，未修改任何片段。');
  }
  const playbackRate = item.playbackRate ?? 1;
  return {
    itemId: item.id, src: item.src!, fps: state.fps, playbackRate,
    ranges: [{ startFrame: sourceFrameAt(item, 0), endFrame: sourceFrameAt(item, item.durationInFrames) }],
  };
}

/** Publish one undoable batch only after every source and clip setting is still current. */
export async function normalizeSelectedLoudness(
  items: readonly TimelineItem[],
  getState: () => TimelineState,
  getDoc: () => ProjectDoc,
  commands: Pick<EditorCommands, 'batch'>,
): Promise<{ peakLimited: number }> {
  if (!items.length || items.some((item) => item.kind !== 'audio' || !item.src)) return { peakLimited: 0 };
  const doc = getDoc();
  const state = getState();
  if (!Number.isFinite(state.fps) || state.fps <= 0) throw new Error('项目帧率无效，未修改任何片段。');
  const liveById = new Map(state.items.map((item) => [item.id, item]));
  const snapshots = items.map((item) => captureTimelineItemSource(item, doc.assets));
  const settings = new Map(items.map((item) => [item.id, loudnessSnapshot(item)]));
  const selections = items.map((item) => loudnessSelectionForItem(item, state));
  const currentAtStart = items.every((item) => {
    const live = liveById.get(item.id);
    return !!live && loudnessSnapshot(live) === settings.get(item.id);
  });
  if (!currentAtStart) throw new Error('所选片段已变化，请重试统一响度。');

  const analyses = await analyzeLoudnessSelections(selections);
  let peakLimited = 0;
  const results = new Map(snapshots.map((snapshot) => {
    const analysis = analyses.get(snapshot.itemId);
    if (!analysis || analysis.status === 'rejected') throw analysis?.status === 'rejected'
      ? analysis.reason : new Error('所选片段的响度分析未完成。');
    const targetGain = gainForTarget(analysis.value.lufs, TARGET_LUFS);
    const peakGain = analysis.value.samplePeak > 0 ? PEAK_LIMIT / analysis.value.samplePeak : Infinity;
    if (peakGain < targetGain) peakLimited += 1;
    return [snapshot.itemId, {
      sourceRevision: snapshot.sourceRevision,
      gain: Math.min(targetGain, peakGain),
    }];
  }));
  const liveDoc = getDoc();
  const liveState = getState();
  const liveItems = new Map(liveState.items.map((item) => [item.id, item]));
  if (liveDoc.activeTimelineId !== doc.activeTimelineId || liveState.fps !== state.fps
    || validateTimelineItemSourceBatch(snapshots, liveState.items, liveDoc.assets, results).status === 'stale'
    || items.some((item) => !liveItems.has(item.id) || loudnessSnapshot(liveItems.get(item.id)!) !== settings.get(item.id))) {
    throw new Error('所选片段在分析期间发生变化，未应用响度。');
  }
  const plan = planInspectorBatch(liveState, snapshots.map((snapshot) => snapshot.itemId),
    (item) => ({ type: 'setVolume', id: item.id, volume: results.get(item.id)!.gain }),
    (item) => item.kind === 'audio' && results.has(item.id));
  if (!plan.ok) throw new Error('无法应用响度，请检查片段选择和轨道锁定状态。');
  if (plan.actions.length) commands.batch(plan.actions, 'Normalize selected loudness');
  return { peakLimited };
}
