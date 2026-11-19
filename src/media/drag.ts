import type { DragEvent } from 'react';
import { isEffectItemKind, type MediaAsset, type TrackKind } from '../editor/types';
import { isTimelineMediaAssetKind } from '../editor/mediaTypes';
import { setEditorDrag } from '../editor/editorDrag';
import type { MediaPlacementPurpose } from './placementPurpose';
import { isMediaSourceRange, sourceRangeFromMap, type MediaSourceRange, type MediaSourceRanges } from '../editor/mediaSourceRange';

const MEDIA_DRAG_MIME = 'application/x-openchatcut-media-asset';
const MEDIA_DRAG_KIND_MIME: Record<'video' | 'audio', string> = {
  video: 'application/x-openchatcut-media-video',
  audio: 'application/x-openchatcut-media-audio',
};
const MEDIA_DRAG_EFFECT_MIME = 'application/x-openchatcut-media-effect';
const MAX_ASSET_ID_LENGTH = 200;

interface MediaDragPayload {
  v: 1;
  assetId: string;
  purpose?: MediaPlacementPurpose;
  sourceRange?: MediaSourceRange;
}

export function mediaAssetTrackKind(asset: Pick<MediaAsset, 'kind'>): 'video' | 'audio' | null {
  if (!isTimelineMediaAssetKind(asset.kind)) return null;
  return asset.kind === 'audio' ? 'audio' : 'video';
}

export function setMediaAssetDrag(
  event: DragEvent,
  asset: Pick<MediaAsset, 'id' | 'kind' | 'name'>,
  assetIds?: readonly string[],
  purpose?: MediaPlacementPurpose,
  sourceRanges?: MediaSourceRanges,
): void {
  const kind = mediaAssetTrackKind(asset);
  const sourceRange = sourceRangeFromMap(sourceRanges, asset.id);
  setEditorDrag(event, {
    source: 'media',
    id: asset.id,
    assetIds: assetIds ? [...assetIds] : undefined,
    name: asset.name,
    assetKind: asset.kind,
    purpose,
    sourceRange,
    sourceRanges,
  });
  event.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify({ v: 1, assetId: asset.id, purpose, sourceRange }));
  if (kind) event.dataTransfer.setData(MEDIA_DRAG_KIND_MIME[kind], '1');
  if (kind === 'video' && isTimelineMediaAssetKind(asset.kind) && isEffectItemKind(asset.kind)) {
    event.dataTransfer.setData(MEDIA_DRAG_EFFECT_MIME, '1');
  }
  // copyMove: timeline drop uses copy; media-pool folder drop uses move.
  // effectAllowed "copy" alone rejects folder dropEffect "move" in Chromium.
  event.dataTransfer.effectAllowed = 'copyMove';
}

export function hasCompatibleMediaDrag(
  event: DragEvent,
  trackKind: TrackKind,
  isText = false,
  isEffect = false,
): boolean {
  if (isText) return false;
  if (trackKind !== 'video' && trackKind !== 'audio') return false;
  const types = Array.from(event.dataTransfer.types ?? []);
  if (isEffect) return trackKind === 'video' && types.includes(MEDIA_DRAG_EFFECT_MIME);
  return types.includes(MEDIA_DRAG_KIND_MIME[trackKind]);
}

export function parseMediaAssetDrag(event: DragEvent): string | null {
  return parseMediaAssetDrop(event)?.assetId ?? null;
}

export function parseMediaAssetDragText(raw: string): string | null {
  return parseMediaAssetDropText(raw)?.assetId ?? null;
}

export function parseMediaAssetDrop(event: DragEvent): MediaDragPayload | null {
  return parseMediaAssetDropText(event.dataTransfer.getData(MEDIA_DRAG_MIME));
}

export function parseMediaAssetDropText(raw: string): MediaDragPayload | null {
  if (!raw || raw[0] !== '{') return null;
  try {
    const payload = JSON.parse(raw) as Partial<MediaDragPayload>;
    if (payload.v !== 1 || typeof payload.assetId !== 'string') return null;
    if (payload.purpose !== undefined && payload.purpose !== 'bgm') return null;
    if (payload.sourceRange !== undefined && !isMediaSourceRange(payload.sourceRange)) return null;
    const id = payload.assetId.trim();
    const validCharacters = Array.from(id).every((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
    return id && id.length <= MAX_ASSET_ID_LENGTH && validCharacters
      ? { v: 1, assetId: id, purpose: payload.purpose, ...(payload.sourceRange ? { sourceRange: payload.sourceRange } : {}) }
      : null;
  } catch {
    return null;
  }
}

export function canDropMediaAsset(
  asset: Pick<MediaAsset, 'kind'>,
  trackKind: TrackKind,
  isText = false,
  isEffect = false,
): boolean {
  if (isText) return false;
  if (isEffect) return trackKind === 'video' && isTimelineMediaAssetKind(asset.kind) && isEffectItemKind(asset.kind);
  return mediaAssetTrackKind(asset) === trackKind;
}
