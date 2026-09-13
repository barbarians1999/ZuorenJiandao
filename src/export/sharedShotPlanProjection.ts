import {
  timelineTrackIds,
  trackKind,
} from '../editor/types';
import type { MediaAsset, Timeline } from '../editor/types';
import type { SharedShotPlan } from './sharedShotPlan';

const PROJECTION_VERSION = 'left-cut-timeline-projection/v1';

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizedTimelineProjection(
  timeline: Timeline,
  primaryTrackId: string,
  assets: readonly MediaAsset[],
): unknown {
  const trackIds = timelineTrackIds(timeline);
  const referencedAssetIds = new Set(timeline.items.map((item) => item.sourceAssetId).filter((id): id is string => !!id));
  return {
    projection_version: PROJECTION_VERSION,
    timeline: {
      id: timeline.id,
      fps: timeline.fps,
      width: timeline.width,
      height: timeline.height,
      fit: timeline.fit ?? null,
      primary_track_id: primaryTrackId,
      tracks: trackIds.map((id) => ({
        id,
        kind: trackKind(timeline, id),
        name: timeline.tracks?.[id]?.name ?? null,
        role: timeline.tracks?.[id]?.role ?? null,
        hidden: timeline.tracks?.[id]?.hidden ?? false,
        muted: timeline.tracks?.[id]?.muted ?? false,
        captions: timeline.tracks?.[id]?.captions ?? null,
      })),
      items: timeline.items.toSorted((left, right) => trackIds.indexOf(left.track) - trackIds.indexOf(right.track)
        || left.startFrame - right.startFrame || left.id.localeCompare(right.id)).map((item) => ({
          id: item.id,
          track: item.track,
          name: item.name,
          kind: item.kind,
          startFrame: item.startFrame,
          durationInFrames: item.durationInFrames,
          sourceAssetId: item.sourceAssetId ?? null,
          sourceFilename: item.sourceFilename ?? null,
          sourceRevision: item.sourceRevision ?? null,
          sourceContentHash: item.sourceContentHash ?? null,
          srcInFrame: item.srcInFrame ?? null,
          playbackRate: item.playbackRate ?? null,
          transcript: item.transcript ?? null,
          transcriptStale: item.transcriptStale ?? false,
          templateId: item.templateId ?? null,
          code: item.code ?? null,
          props: item.props ?? null,
          keyframes: item.keyframes ?? null,
          transform: item.transform ?? null,
          filters: item.filters ?? null,
          effects: item.effects ?? null,
          zoom: item.zoom ?? null,
          fadeInFrames: item.fadeInFrames ?? null,
          fadeOutFrames: item.fadeOutFrames ?? null,
          backgroundFill: item.backgroundFill ?? false,
          backgroundFillStrength: item.backgroundFillStrength ?? null,
          volume: item.volume ?? null,
        })),
      captions: timeline.captions ?? null,
      markers: (timeline.markers ?? []).toSorted((left, right) => left.fromFrame - right.fromFrame || left.id.localeCompare(right.id)),
    },
    assets: assets.filter((asset) => referencedAssetIds.has(asset.id)).toSorted((left, right) => left.id.localeCompare(right.id)).map((asset) => ({
      id: asset.id,
      name: asset.name,
      sourceFilename: asset.sourceFilename ?? null,
      kind: asset.kind,
      durationInFrames: asset.durationInFrames,
      sourceRevision: asset.sourceRevision ?? null,
      sourceContentHash: asset.sourceContentHash ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      code: asset.code ?? null,
      props: asset.props ?? null,
    })),
  };
}

export async function timelineVersionFor(
  timeline: Timeline,
  primaryTrackId: string,
  assets: readonly MediaAsset[],
): Promise<string> {
  const projection = normalizedTimelineProjection(timeline, primaryTrackId, assets);
  return `tlv1-${await sha256Hex(canonicalJson(projection))}`;
}

function planFingerprintPayload(plan: Omit<SharedShotPlan, 'plan_fingerprint'> | SharedShotPlan): unknown {
  const { generated_at: _generatedAt, plan_fingerprint: _fingerprint, ...rest } = plan as SharedShotPlan;
  return { ...rest, project: { ...rest.project, project_id: null } };
}

export async function fingerprintSharedShotPlan(plan: SharedShotPlan): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(planFingerprintPayload(plan)))}`;
}
