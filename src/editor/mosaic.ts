import type { AspectFit, ClipEffect, ClipEffectMosaicTrack, TimelineItem } from './types';
import { sourceFrameAt } from './sourceLimit';
import { visibleVisualFrameRect } from './visualFrameGeometry';

export const LOCAL_MOSAIC_ID = 'builtin:fx-local-mosaic';
export const FULL_MOSAIC_ID = 'builtin:fx-pixelate';
export const GAUSSIAN_MOSAIC_ID = 'builtin:fx-local-gaussian-blur';
export type MosaicMode = 'none' | 'local' | 'full';
export interface MosaicRegion { centerX: number; centerY: number; width: number; height: number; strength: number; feather: number }
export const DEFAULT_MOSAIC: MosaicRegion = { centerX: .5, centerY: .5, width: .35, height: .35, strength: 70, feather: 0 };
const MAX_MOSAIC_TRACK_POINTS = 150;
const scalar = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export const isMosaicEffect = (effect: Pick<ClipEffect, 'assetId'>) =>
  effect.assetId === GAUSSIAN_MOSAIC_ID || effect.assetId === LOCAL_MOSAIC_ID || effect.assetId === FULL_MOSAIC_ID;
export const hasPrivacyMosaic = (item?: Pick<TimelineItem, 'effects'>) => (item?.effects ?? []).some(isMosaicEffect);
export function normalizeMosaic(region: MosaicRegion): MosaicRegion {
  return { centerX: scalar(region.centerX, .5, 0, 1), centerY: scalar(region.centerY, .5, 0, 1),
    width: scalar(region.width, .35, .01, 1), height: scalar(region.height, .35, .01, 1),
    strength: Math.round(scalar(region.strength, 70, 1, 100)), feather: scalar(region.feather, 0, 0, 100) };
}
export function readMosaic(effects: readonly ClipEffect[] = []): { mode: MosaicMode; region: MosaicRegion; count: number; legacyCount: number } {
  const entries = effects.filter((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID), effect = entries[0];
  const legacyCount = effects.filter((effect) => isMosaicEffect(effect) && effect.assetId !== GAUSSIAN_MOSAIC_ID).length;
  if (!effect) return { mode: 'none', region: { ...DEFAULT_MOSAIC }, count: 0, legacyCount };
  const values = effect.overrides ?? {};
  const region = normalizeMosaic({ centerX: Number(values.center_x ?? .5), centerY: Number(values.center_y ?? .5),
      width: Number(values.width_ratio ?? .35), height: Number(values.height_ratio ?? .35),
      strength: Number(values.strength ?? 70), feather: Number(values.feather ?? 0) });
  const full = region.centerX === .5 && region.centerY === .5 && region.width === 1 && region.height === 1 && region.feather === 0;
  return { mode: full ? 'full' : 'local', region, count: entries.length, legacyCount };
}
export function mosaicSourceIdentity(item: TimelineItem): string | null {
  const contentHash = item.sourceContentHash?.toLowerCase() ?? null;
  if (item.sourceAssetId || item.sourceRevision || contentHash) {
    // Preview proxy copies replace only `src`; these persisted identities remain source-local.
    return JSON.stringify([item.sourceAssetId ?? null, item.sourceRevision ?? null, contentHash]);
  }
  const fallback = item.originalFilePath ?? item.src;
  return fallback ? JSON.stringify([fallback]) : null;
}
export function normalizeMosaicTrack(value: unknown): ClipEffectMosaicTrack | null {
  if (!value || typeof value !== 'object') return null;
  const track = value as Partial<ClipEffectMosaicTrack>;
  if (typeof track.sourceIdentity !== 'string' || !track.sourceIdentity
    || !Number.isFinite(track.sourceWidth) || track.sourceWidth! <= 0
    || !Number.isFinite(track.sourceHeight) || track.sourceHeight! <= 0
    || !Array.isArray(track.points) || track.points.length < 2 || track.points.length > MAX_MOSAIC_TRACK_POINTS) return null;
  let previous = -Infinity;
  const points: ClipEffectMosaicTrack['points'] = [];
  for (const point of track.points) {
    if (!point || !Number.isFinite(point.sourceFrame) || point.sourceFrame < 0 || point.sourceFrame <= previous
      || !Number.isFinite(point.x) || point.x < 0 || point.x > 1
      || !Number.isFinite(point.y) || point.y < 0 || point.y > 1) return null;
    points.push({ sourceFrame: point.sourceFrame, x: point.x, y: point.y });
    previous = point.sourceFrame;
  }
  return { sourceIdentity: track.sourceIdentity, sourceWidth: track.sourceWidth!, sourceHeight: track.sourceHeight!, points };
}
export function evaluateMosaicTrack(trackValue: unknown, sourceFrame: number, sourceIdentity: string | null): { centerX: number; centerY: number } | null {
  const track = normalizeMosaicTrack(trackValue);
  if (!track || !sourceIdentity || track.sourceIdentity !== sourceIdentity || !Number.isFinite(sourceFrame)) return null;
  const points = track.points;
  if (sourceFrame <= points[0]!.sourceFrame) return { centerX: points[0]!.x, centerY: points[0]!.y };
  const last = points[points.length - 1]!;
  if (sourceFrame >= last.sourceFrame) return { centerX: last.x, centerY: last.y };
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    if (sourceFrame <= to.sourceFrame) {
      const p = (sourceFrame - from.sourceFrame) / (to.sourceFrame - from.sourceFrame);
      return { centerX: from.x + (to.x - from.x) * p, centerY: from.y + (to.y - from.y) * p };
    }
  }
  return { centerX: last.x, centerY: last.y };
}
export function mosaicTrackFor(item: TimelineItem): ClipEffectMosaicTrack | null {
  const mosaic = readMosaic(item.effects);
  if (mosaic.mode !== 'local' || mosaic.count !== 1) return null;
  const track = normalizeMosaicTrack(item.effects?.find((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID)?.mosaicTrack);
  return track?.sourceIdentity === mosaicSourceIdentity(item) ? track : null;
}
export function mosaicSourceSize(item: TimelineItem, fallback: { width: number; height: number } = { width: 1, height: 1 }): { width: number; height: number } {
  const track = mosaicTrackFor(item);
  return track ? { width: track.sourceWidth, height: track.sourceHeight }
    : { width: item.width ?? fallback.width, height: item.height ?? fallback.height };
}
export function readMosaicAt(item: TimelineItem, localFrame: number) {
  const mosaic = readMosaic(item.effects);
  if (mosaic.mode !== 'local' || mosaic.count !== 1) return mosaic;
  const tracked = mosaicTrackFor(item);
  const center = evaluateMosaicTrack(tracked, sourceFrameAt(item, localFrame), mosaicSourceIdentity(item));
  return center ? { ...mosaic, region: normalizeMosaic({ ...mosaic.region, ...center }) } : mosaic;
}
/** Map a source-normalized mosaic rectangle through the same contain/cover placement as ClipFx.drawFit. */
export function mosaicRegionToStage(region: MosaicRegion, source: { width: number; height: number }, stage: { width: number; height: number }, fit: AspectFit): MosaicRegion | null {
  const width = Math.max(1, stage.width), height = Math.max(1, stage.height);
  const sourceWidth = Math.max(1, source.width), sourceHeight = Math.max(1, source.height);
  const scale = fit === 'cover' ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale, drawnHeight = sourceHeight * scale;
  const offsetX = (width - drawnWidth) / 2, offsetY = (height - drawnHeight) / 2;
  const mapped = {
    ...region,
    centerX: (offsetX + region.centerX * drawnWidth) / width,
    centerY: (offsetY + region.centerY * drawnHeight) / height,
    width: region.width * drawnWidth / width,
    height: region.height * drawnHeight / height,
  };
  // Preserve source rectangles that are still partially visible; discard a fully cropped box rather than clamping it onto an unrelated edge.
  if (mapped.centerX >= 0 && mapped.centerX <= 1 && mapped.centerY >= 0 && mapped.centerY <= 1) return mapped;
  const left = Math.max(0, offsetX + (region.centerX - region.width / 2) * drawnWidth);
  const right = Math.min(width, offsetX + (region.centerX + region.width / 2) * drawnWidth);
  const top = Math.max(0, offsetY + (region.centerY - region.height / 2) * drawnHeight);
  const bottom = Math.min(height, offsetY + (region.centerY + region.height / 2) * drawnHeight);
  if (right <= left || bottom <= top) return null;
  // The viewport edge is not a mosaic edge: keep it opaque so a clipped target cannot leak through feathering.
  return { ...region, centerX: (left + right) / (2 * width), centerY: (top + bottom) / (2 * height), feather: 0,
    width: (right - left) / width, height: (bottom - top) / height };
}
export function mosaicTrackRegionToStatic(item: TimelineItem, region: MosaicRegion, fit: AspectFit,
  canvas: { width: number; height: number }): MosaicRegion {
  const track = mosaicTrackFor(item);
  if (!track) return region;
  const source = { width: track.sourceWidth, height: track.sourceHeight };
  const stage = visibleVisualFrameRect(canvas,
    { width: item.width ?? canvas.width, height: item.height ?? canvas.height }, fit);
  return mosaicRegionToStage(region, source, stage, fit === 'contain' ? 'cover' : fit) ?? readMosaic(item.effects).region;
}
export function mosaicEffectsAt(item: TimelineItem, localFrame: number, fit: AspectFit, stage: { width: number; height: number }): ClipEffect[] | undefined {
  const effects = item.effects;
  if (!effects) return effects;
  const track = mosaicTrackFor(item);
  if (!track) return effects;
  const mosaic = readMosaicAt(item, localFrame);
  if (mosaic.mode !== 'local' || mosaic.count !== 1) return effects;
  const index = effects.findIndex((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID);
  const original = effects[index]!;
  const size = { width: track.sourceWidth, height: track.sourceHeight };
  const mapped = mosaicRegionToStage(mosaic.region, size, stage, fit);
  if (!mapped) return effects.filter((_, at) => at !== index);
  if (mapped.centerX === Number(original.overrides?.center_x ?? .5)
    && mapped.centerY === Number(original.overrides?.center_y ?? .5)
    && mapped.width === Number(original.overrides?.width_ratio ?? .35)
    && mapped.height === Number(original.overrides?.height_ratio ?? .35)) return effects;
  return effects.map((effect, at) => at === index ? { ...effect, overrides: {
    ...effect.overrides, center_x: mapped.centerX, center_y: mapped.centerY,
    width_ratio: mapped.width, height_ratio: mapped.height,
  } } : effect);
}
export function setMosaicTrack(effects: readonly ClipEffect[], effectId: string, value: unknown): ClipEffect[] | null {
  const mosaic = readMosaic(effects);
  if (mosaic.mode !== 'local' || mosaic.count !== 1
    || !effects.some((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID && effect.id === effectId)) return null;
  const track = normalizeMosaicTrack(value);
  if (!track) return null;
  return effects.map((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID && effect.id === effectId
    ? { ...effect, mosaicTrack: track } : effect);
}
export function clearMosaicTrack(item: TimelineItem, localFrame: number, newId: string, fit: AspectFit,
  canvas: { width: number; height: number }): ClipEffect[] {
  const mosaic = readMosaicAt(item, localFrame);
  const track = mosaicTrackFor(item);
  if (!track) return setMosaicRegion(item.effects ?? [], { ...mosaic.region }, newId);
  return setMosaicRegion(item.effects ?? [], mosaicTrackRegionToStatic(item, mosaic.region, fit, canvas), newId);
}
/** Edit only the first mosaic; preserve other effects and additional redactions. */
export function setMosaicRegion(effects: readonly ClipEffect[], region: MosaicRegion, newId: string, preserveTrack = false): ClipEffect[] {
  const normalized = normalizeMosaic(region), index = effects.findIndex((effect) => effect.assetId === GAUSSIAN_MOSAIC_ID);
  const previous = index < 0 ? undefined : effects[index];
  const next: ClipEffect = { id: previous?.id ?? newId, assetId: GAUSSIAN_MOSAIC_ID,
    overrides: { ...previous?.overrides,
      center_x: normalized.centerX, center_y: normalized.centerY, width_ratio: normalized.width,
      height_ratio: normalized.height, strength: normalized.strength, feather: normalized.feather },
    ...(preserveTrack && previous?.mosaicTrack ? { mosaicTrack: previous.mosaicTrack } : {}) };
  return index < 0 ? [...effects, next] : effects.map((effect, at) => at === index ? next : effect);
}
export function setMosaicMode(effects: readonly ClipEffect[], mode: MosaicMode, newId: string): ClipEffect[] {
  if (mode === 'none') return effects.filter((effect) => !isMosaicEffect(effect));
  const strength = readMosaic(effects).region.strength;
  return setMosaicRegion(effects, { ...DEFAULT_MOSAIC, strength,
    ...(mode === 'full' ? { width: 1, height: 1 } : {}) }, newId);
}

/** Privacy effects must never reveal the unprocessed source as a fallback. */
export function mosaicPresentation({ protectedSource, readyForCurrentFrame }: { protectedSource: boolean; readyForCurrentFrame: boolean }) {
  return { showSource: !protectedSource && !readyForCurrentFrame, showCanvas: readyForCurrentFrame,
    showProtection: protectedSource && !readyForCurrentFrame };
}
