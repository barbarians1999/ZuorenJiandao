import { resolveCaptionWords } from '../captions/resolve';
import { joinCaptionWords } from '../captions/types';
import type { CaptionsData } from '../captions/types';
import {
  activeTimeline,
  captionTrackEntries,
  resolveTrackId,
  timelineDuration,
  timelineTrackIds,
  trackAlias,
  trackKind,
} from '../editor/types';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from '../editor/types';
import { toSegments } from '../transcript/segment';
import { fingerprintSharedShotPlan, timelineVersionFor } from './sharedShotPlanProjection';

export { canonicalJson, fingerprintSharedShotPlan } from './sharedShotPlanProjection';

export const SHARED_SHOT_PLAN_SCHEMA_VERSION = 'narrated-video-shot-plan/v1';

export type SharedShotPlanWarningCode =
  | 'PRIMARY_VISUAL_GAP'
  | 'SHOT_BOUNDARY_SPLITS_SENTENCE'
  | 'CAPTION_WORDS_UNAVAILABLE'
  | 'MULTIPLE_CAPTION_TRACKS';

export interface SharedShotPlanWarning {
  code: SharedShotPlanWarningCode;
  message: string;
  shot_id?: string;
  sentence_id?: string;
  frame?: number;
}

export type SharedShotPlanErrorCode =
  | 'PRIMARY_TRACK_NOT_FOUND'
  | 'PRIMARY_TRACK_HIDDEN'
  | 'PRIMARY_TRACK_NOT_VIDEO'
  | 'PRIMARY_TRACK_EMPTY'
  | 'PRIMARY_TRACK_AMBIGUOUS'
  | 'INVALID_PRIMARY_ITEM_RANGE'
  | 'PRIMARY_TRACK_OVERLAP'
  | 'INVALID_CAPTION_TIMING';

export class SharedShotPlanError extends Error {
  readonly code: SharedShotPlanErrorCode;
  readonly details?: unknown;

  constructor(
    code: SharedShotPlanErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'SharedShotPlanError';
    this.code = code;
    this.details = details;
  }
}

interface SentenceProjection {
  sentence_id: string;
  start: number;
  end: number;
  text: string;
  startFrame: number;
  endFrameExclusive: number;
}

interface Segment {
  startFrame: number;
  endFrameExclusive: number;
  item: TimelineItem | null;
}

export interface SharedShotPlan {
  schema_version: typeof SHARED_SHOT_PLAN_SCHEMA_VERSION;
  generated_at: string;
  plan_fingerprint: string;
  project: {
    project_id: string | null;
    title: string;
    timeline_id: string;
    timeline_version: string;
    base_video: null;
    width: number;
    height: number;
    fps: number;
    total_duration: number;
    total_frames: number;
    primary_track_id: string;
    primary_track_alias: string;
  };
  sources: {
    timeline: 'active-project-timeline';
    caption_track_id: string | null;
  };
  composite_contract: {
    time_origin: 'shot_local_zero';
    master_duration_policy: 'exact_shot_duration';
    master_naming: '{shot_id}_animation.mov';
    alpha_required: true;
    overlay_at: 'shot.timeline.in';
  };
  sentences: Array<Omit<SentenceProjection, 'startFrame' | 'endFrameExclusive'>>;
  chapters: Array<{ chapter_id: string; topic: string; from_frame: number }>;
  shots: Array<Record<string, unknown>>;
  validation: {
    status: 'ready' | 'needs_review';
    warnings: SharedShotPlanWarning[];
  };
}

export interface BuildSharedShotPlanInput {
  doc: ProjectDoc;
  projectId?: string;
  primaryTrackId?: string;
  guardFrames?: number;
  generatedAt?: string;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isVisualItem(item: TimelineItem): boolean {
  return item.kind !== 'audio';
}

function primaryCandidates(timeline: Timeline): string[] {
  return timelineTrackIds(timeline).filter((id) => (
    trackKind(timeline, id) === 'video'
    && timeline.tracks?.[id]?.hidden !== true
    && timeline.items.some((item) => item.track === id && isVisualItem(item))
  ));
}

function candidateDetails(timeline: Timeline, ids: readonly string[]) {
  return ids.map((id) => ({
    id,
    alias: trackAlias(timeline, id),
    name: timeline.tracks?.[id]?.name ?? null,
    role: timeline.tracks?.[id]?.role ?? null,
    itemCount: timeline.items.filter((item) => item.track === id && isVisualItem(item)).length,
  }));
}

export function resolvePrimaryShotTrack(timeline: Timeline, requested?: string): string {
  if (requested?.trim()) {
    const id = resolveTrackId(timeline, requested.trim(), 'video');
    if (!id) throw new SharedShotPlanError('PRIMARY_TRACK_NOT_FOUND', `找不到主镜头轨：${requested}`);
    if (trackKind(timeline, id) !== 'video') {
      throw new SharedShotPlanError('PRIMARY_TRACK_NOT_VIDEO', `轨道 ${requested} 不是视频轨`);
    }
    if (timeline.tracks?.[id]?.hidden === true) {
      throw new SharedShotPlanError('PRIMARY_TRACK_HIDDEN', `轨道 ${requested} 已隐藏，不能作为主镜头轨`);
    }
    if (!timeline.items.some((item) => item.track === id && isVisualItem(item))) {
      throw new SharedShotPlanError('PRIMARY_TRACK_EMPTY', `轨道 ${requested} 没有画面片段`);
    }
    return id;
  }

  const candidates = primaryCandidates(timeline);
  const anchors = candidates.filter((id) => timeline.tracks?.[id]?.role === 'anchor');
  if (anchors.length === 1) return anchors[0]!;

  const namedV1 = candidates.filter((id) => (
    id.toUpperCase() === 'V1'
    || timeline.tracks?.[id]?.name?.trim().toUpperCase() === 'V1'
  ));
  if (namedV1.length === 1) return namedV1[0]!;
  if (candidates.length === 1) return candidates[0]!;

  throw new SharedShotPlanError(
    'PRIMARY_TRACK_AMBIGUOUS',
    candidates.length
      ? '存在多条可能的主镜头轨，请显式指定 primaryTrackId'
      : '当前时间线没有可用的主视频轨',
    { candidates: candidateDetails(timeline, candidates) },
  );
}

function validateAndSegmentPrimaryTrack(timeline: Timeline, primaryTrackId: string): Segment[] {
  const items = timeline.items
    .filter((item) => item.track === primaryTrackId && isVisualItem(item))
    .toSorted((left, right) => left.startFrame - right.startFrame
      || (left.startFrame + left.durationInFrames) - (right.startFrame + right.durationInFrames)
      || left.id.localeCompare(right.id));
  for (const item of items) {
    if (!Number.isInteger(item.startFrame) || item.startFrame < 0
      || !Number.isInteger(item.durationInFrames) || item.durationInFrames <= 0) {
      throw new SharedShotPlanError(
        'INVALID_PRIMARY_ITEM_RANGE',
        `主镜头片段 ${item.id} 的帧范围无效`,
        { itemId: item.id, startFrame: item.startFrame, durationInFrames: item.durationInFrames },
      );
    }
  }
  const totalFrames = timelineDuration(timeline);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const item of items) {
    if (item.startFrame < cursor) {
      throw new SharedShotPlanError(
        'PRIMARY_TRACK_OVERLAP',
        `主镜头轨在第 ${item.startFrame} 帧发生重叠`,
        { itemId: item.id, frame: item.startFrame },
      );
    }
    if (item.startFrame > cursor) segments.push({ startFrame: cursor, endFrameExclusive: item.startFrame, item: null });
    const endFrameExclusive = item.startFrame + item.durationInFrames;
    segments.push({ startFrame: item.startFrame, endFrameExclusive, item });
    cursor = endFrameExclusive;
  }
  if (cursor < totalFrames) segments.push({ startFrame: cursor, endFrameExclusive: totalFrames, item: null });
  return segments;
}

function captionProjection(timeline: Timeline, warnings: SharedShotPlanWarning[]): {
  captionTrackId: string | null;
  sentences: SentenceProjection[];
} {
  const enabledTracks = captionTrackEntries(timeline).filter((entry) => entry.captions?.enabled);
  let captionTrackId: string | null = enabledTracks[0]?.id ?? null;
  let captions: CaptionsData | null | undefined = enabledTracks[0]?.captions;
  if (!captions && timeline.captions?.enabled) {
    captions = timeline.captions;
    captionTrackId = null;
  }
  if (enabledTracks.length > 1) {
    warnings.push({
      code: 'MULTIPLE_CAPTION_TRACKS',
      message: `检测到 ${enabledTracks.length} 条已启用字幕轨；共享分镜使用 ${captionTrackId}`,
    });
  }
  if (!captions) {
    warnings.push({ code: 'CAPTION_WORDS_UNAVAILABLE', message: '当前时间线没有可解析的字幕词级时间' });
    return { captionTrackId, sentences: [] };
  }
  const words = resolveCaptionWords(captions, timeline.items, timeline.fps);
  if (!words.length) {
    warnings.push({ code: 'CAPTION_WORDS_UNAVAILABLE', message: '字幕已启用，但没有可解析的词级时间' });
    return { captionTrackId, sentences: [] };
  }
  for (const [index, word] of words.entries()) {
    const previous = words[index - 1];
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start
      || (previous && word.start < previous.start)) {
      throw new SharedShotPlanError(
        'INVALID_CAPTION_TIMING',
        `字幕词 ${index + 1} 的时间无效`,
        { index, start: word.start, end: word.end },
      );
    }
  }
  const groups = toSegments(words);
  return {
    captionTrackId,
    sentences: groups.map((group, index) => {
      const first = group.words[0]!;
      const last = group.words[group.words.length - 1]!;
      return {
        sentence_id: `S${String(index + 1).padStart(3, '0')}`,
        start: roundSeconds(first.start / 1000),
        end: roundSeconds(last.end / 1000),
        text: joinCaptionWords(group.words),
        startFrame: Math.floor((first.start / 1000) * timeline.fps),
        endFrameExclusive: Math.ceil((last.end / 1000) * timeline.fps),
      };
    }),
  };
}

function portableAssetFor(item: TimelineItem | null, assets: readonly MediaAsset[]): MediaAsset | undefined {
  if (!item) return undefined;
  return assets.find((asset) => asset.id === item.sourceAssetId)
    ?? (item.src ? assets.find((asset) => asset.src === item.src) : undefined);
}

function portableSource(item: TimelineItem, assets: readonly MediaAsset[]): Record<string, unknown> {
  const asset = portableAssetFor(item, assets);
  return {
    item_id: item.id,
    source_asset_id: item.sourceAssetId ?? asset?.id ?? null,
    source_file: item.sourceFilename ?? asset?.sourceFilename ?? asset?.name ?? item.name,
    source_content_hash: item.sourceContentHash ?? asset?.sourceContentHash ?? null,
    source_revision: item.sourceRevision ?? asset?.sourceRevision ?? null,
  };
}

function overlayItems(timeline: Timeline, primaryTrackId: string, segment: Segment, assets: readonly MediaAsset[]) {
  const visibleVideoTracks = new Set(timelineTrackIds(timeline).filter((id) => (
    id !== primaryTrackId && trackKind(timeline, id) === 'video' && timeline.tracks?.[id]?.hidden !== true
  )));
  return timeline.items
    .filter((item) => visibleVideoTracks.has(item.track) && isVisualItem(item)
      && item.startFrame < segment.endFrameExclusive
      && item.startFrame + item.durationInFrames > segment.startFrame)
    .toSorted((left, right) => timelineTrackIds(timeline).indexOf(left.track) - timelineTrackIds(timeline).indexOf(right.track)
      || left.startFrame - right.startFrame || left.id.localeCompare(right.id))
    .map((item) => ({
      ...portableSource(item, assets),
      track_id: item.track,
      track_alias: trackAlias(timeline, item.track),
      kind: item.kind,
      start_frame: item.startFrame,
      end_frame_exclusive: item.startFrame + item.durationInFrames,
    }));
}

function chaptersFor(timeline: Timeline): Array<{ chapter_id: string; topic: string; from_frame: number }> {
  return (timeline.markers ?? []).flatMap((marker) => {
    if (marker.scope !== 'project') return [];
    const match = /^(?:chapter|章节)\s*[:：]\s*(.+)$/i.exec(marker.note.trim());
    return match ? [{ chapter_id: marker.id, topic: match[1]!.trim(), from_frame: marker.fromFrame }] : [];
  }).toSorted((left, right) => left.from_frame - right.from_frame || left.chapter_id.localeCompare(right.chapter_id));
}

function chapterAt(chapters: SharedShotPlan['chapters'], frame: number) {
  return chapters.filter((chapter) => chapter.from_frame <= frame).at(-1) ?? null;
}

export async function buildSharedShotPlan(input: BuildSharedShotPlanInput): Promise<SharedShotPlan> {
  const timeline = activeTimeline(input.doc);
  const primaryTrackId = resolvePrimaryShotTrack(timeline, input.primaryTrackId);
  const segments = validateAndSegmentPrimaryTrack(timeline, primaryTrackId);
  const warnings: SharedShotPlanWarning[] = [];
  const { captionTrackId, sentences } = captionProjection(timeline, warnings);
  const chapters = chaptersFor(timeline);
  const guardFrames = Number.isInteger(input.guardFrames) && (input.guardFrames ?? 0) >= 0
    ? input.guardFrames!
    : 6;

  const boundaryWarnings = new Set<string>();
  const shots = segments.map((segment, index) => {
    const shotId = `SH${String(index + 1).padStart(3, '0')}`;
    if (!segment.item) {
      warnings.push({
        code: 'PRIMARY_VISUAL_GAP',
        message: `主镜头轨在 ${segment.startFrame}–${segment.endFrameExclusive} 帧为空`,
        shot_id: shotId,
        frame: segment.startFrame,
      });
    }
    const covered = sentences.filter((sentence) => (
      sentence.startFrame < segment.endFrameExclusive && sentence.endFrameExclusive > segment.startFrame
    ));
    const crossesIn = covered.filter((sentence) => sentence.startFrame < segment.startFrame).map((sentence) => sentence.sentence_id);
    const crossesOut = covered.filter((sentence) => sentence.endFrameExclusive > segment.endFrameExclusive).map((sentence) => sentence.sentence_id);
    for (const sentence of covered) {
      if (sentence.startFrame < segment.endFrameExclusive && sentence.endFrameExclusive > segment.endFrameExclusive
        && index < segments.length - 1) {
        const key = `${segment.endFrameExclusive}:${sentence.sentence_id}`;
        if (!boundaryWarnings.has(key)) {
          boundaryWarnings.add(key);
          warnings.push({
            code: 'SHOT_BOUNDARY_SPLITS_SENTENCE',
            message: `第 ${segment.endFrameExclusive} 帧切点穿过句子 ${sentence.sentence_id}`,
            shot_id: shotId,
            sentence_id: sentence.sentence_id,
            frame: segment.endFrameExclusive,
          });
        }
      }
    }
    const chapter = chapterAt(chapters, segment.startFrame);
    const item = segment.item;
    const asset = portableAssetFor(item, input.doc.assets);
    const sourceStartFrame = item?.srcInFrame ?? 0;
    const sourceEndFrame = sourceStartFrame + (item ? item.durationInFrames * (item.playbackRate ?? 1) : 0);
    const crossShot = crossesIn.length > 0 || crossesOut.length > 0;
    return {
      shot_id: shotId,
      index: index + 1,
      chapter_id: chapter?.chapter_id ?? null,
      topic: chapter?.topic ?? null,
      timeline: {
        in: roundSeconds(segment.startFrame / timeline.fps),
        out: roundSeconds(segment.endFrameExclusive / timeline.fps),
        duration: roundSeconds((segment.endFrameExclusive - segment.startFrame) / timeline.fps),
        start_frame: segment.startFrame,
        end_frame_exclusive: segment.endFrameExclusive,
        frame_count: segment.endFrameExclusive - segment.startFrame,
      },
      sentences: {
        start_id: covered[0]?.sentence_id ?? null,
        end_id: covered.at(-1)?.sentence_id ?? null,
        ids: covered.map((sentence) => sentence.sentence_id),
        text: covered.map((sentence) => sentence.text).join(''),
        cross_shot: crossShot,
        crosses_in: crossesIn,
        crosses_out: crossesOut,
      },
      visual: item ? {
        kind: item.kind,
        ...portableSource(item, input.doc.assets),
        source_in: roundSeconds(sourceStartFrame / timeline.fps),
        source_out: roundSeconds(sourceEndFrame / timeline.fps),
        fit: timeline.fit ?? 'contain',
        notes: [],
        overlays: overlayItems(timeline, primaryTrackId, segment, input.doc.assets),
      } : {
        kind: 'gap',
        item_id: null,
        source_asset_id: null,
        source_file: null,
        source_content_hash: null,
        source_revision: null,
        source_in: 0,
        source_out: 0,
        fit: timeline.fit ?? 'contain',
        notes: ['primary-track-gap'],
        overlays: overlayItems(timeline, primaryTrackId, segment, input.doc.assets),
      },
      animation_handoff: {
        candidate: null,
        brief: null,
        preferred_type: null,
        guard_frames: guardFrames,
        guard: crossShot ? ['preserve-sentence-continuity-across-shot-boundary'] : [],
        cross_shot: crossShot,
        continuity: 'preserve_timeline_continuity',
        continuity_group: null,
        edge_policy: 'local_zero_equals_shot_in',
        master_filename: `${shotId}_animation.mov`,
      },
      invalidation: {
        timeline_item_id: item?.id ?? null,
        source_asset_id: item?.sourceAssetId ?? asset?.id ?? null,
        source_revision: item?.sourceRevision ?? asset?.sourceRevision ?? null,
        source_content_hash: item?.sourceContentHash ?? asset?.sourceContentHash ?? null,
      },
    };
  });

  const totalFrames = timelineDuration(timeline);
  const timelineVersion = await timelineVersionFor(timeline, primaryTrackId, input.doc.assets);
  const withoutFingerprint: Omit<SharedShotPlan, 'plan_fingerprint'> = {
    schema_version: SHARED_SHOT_PLAN_SCHEMA_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    project: {
      project_id: input.projectId ?? null,
      title: timeline.name,
      timeline_id: timeline.id,
      timeline_version: timelineVersion,
      base_video: null,
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      total_duration: roundSeconds(totalFrames / timeline.fps),
      total_frames: totalFrames,
      primary_track_id: primaryTrackId,
      primary_track_alias: trackAlias(timeline, primaryTrackId),
    },
    sources: { timeline: 'active-project-timeline', caption_track_id: captionTrackId },
    composite_contract: {
      time_origin: 'shot_local_zero',
      master_duration_policy: 'exact_shot_duration',
      master_naming: '{shot_id}_animation.mov',
      alpha_required: true,
      overlay_at: 'shot.timeline.in',
    },
    sentences: sentences.map(({ startFrame: _startFrame, endFrameExclusive: _endFrame, ...sentence }) => sentence),
    chapters,
    shots,
    validation: { status: warnings.length ? 'needs_review' : 'ready', warnings },
  };
  const plan = { ...withoutFingerprint, plan_fingerprint: '' } as SharedShotPlan;
  plan.plan_fingerprint = await fingerprintSharedShotPlan(plan);
  return plan;
}
