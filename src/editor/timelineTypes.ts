import type { CaptionsData } from '../captions/types.js';
import type { SerializableFxDef } from '../gl/fx/uniforms.js';
import type { AspectFit } from './aspectTypes.js';
import type { TimelineItem } from './clipTypes.js';
import type { Marker } from './markerTypes.js';
import type { MediaAsset, MediaAssetKind } from './mediaTypes.js';
import type { MulticamGroup, TimelineLinkGroup } from './multicamTypes.js';
import { TRACK_ORDER, type TrackFlags, type TrackId, type TrackKind, type TrackNature } from './trackTypes.js';
import type { TransitionItem } from './transitionTypes.js';

/** text watermark overlay (updateWatermark — in-app behavior, no precise signature,
 * shape (custom shape). A generic brand overlay burned into preview + export;
 * default disabled, NOT a paywall/free-tier gimmick. */
export type WatermarkPosition = 'tl' | 'tr' | 'bl' | 'br';
export interface Watermark {
  enabled: boolean;
  text: string;
  position: WatermarkPosition;
  /** 0..1 overlay opacity */
  opacity: number;
}
export const DEFAULT_WATERMARK: Watermark = { enabled: false, text: '', position: 'br', opacity: 0.7 };

export interface TimelineState {
  fps: number;
  width: number;
  height: number;
  /** how items fit when the canvas ratio differs from their design box */
  fit?: AspectFit;
  /** Enabled by independent adjustment layers; retained if the last layer is removed. */
  compositingOrder?: 'tracks';
  items: TimelineItem[];
  /** Editing behavior only. Absent in existing projects: never repack on load. */
  interaction?: {
    mainTrackId?: TrackId;
    magnet?: boolean;
    linkage?: boolean;
    snapping?: boolean;
    linkedKinds?: ('text' | 'video' | 'image' | 'audio' | 'other')[];
  };
  /** visual top-to-bottom order of stable track ids */
  trackOrder?: TrackId[];
  /** per-track metadata (keyed by stable TrackId; legacy states only have flags) */
  tracks?: Partial<Record<TrackId, TrackFlags>>;
  /** transitions between adjacent same-track clips (transition_item) */
  transitions?: TransitionItem[];
  /** timeline annotations / TODO anchors (manage_markers) */
  markers?: Marker[];
  /** Optional professional edit relationships; absent in legacy projects. */
  linkGroups?: TimelineLinkGroup[];
  /** Persistent multicam sources, sync evidence and range camera decisions. */
  multicamGroups?: MulticamGroup[];
  /** Derived compatibility view of ProjectDoc.assets; never persisted here */
  assets?: MediaAsset[];
  /** Global caption-system visibility (captions off also hides on-screen text
   * clips). When absent, derive from caption tracks being all disabled. */
  captionsHidden?: boolean;
  /** Primary selection (last clicked) — inspector / single-item ops. */
  selectedId: string | null;
  /**
   * Multi-select set (⌘A / ⌘click / ⇧click).
   * Always kept in sync with selectedId: primary is the last id in the list.
   * Older docs may omit this; use `selectedIdsOf()`.
   */
  selectedIds?: string[];
  /** captions overlay (captions), rendered on top + burned into export*/
  captions?: CaptionsData | null;
  /** text watermark overlay (updateWatermark), rendered on top + burned into export */
  watermark?: Watermark;
  /** Serializable def of non-built-in fx (plugin/submit_shader), stored by assetId. Snapshot when applying effects,
   * TimelineComposition is registered in ALL_FX before rendering - refresh and headless export are therefore self-contained.*/
  fxDefs?: Record<string, SerializableFxDef>;
}

/** one timeline/sequence within a project (a project holds many timelines).
 * A Timeline IS a TimelineState plus identity — so every component that consumes
 * a TimelineState keeps working when handed the active timeline. */
export interface Timeline extends TimelineState {
  id: string;
  name: string;
  /** tab order (ascending) */
  order: number;
  /** hidden tab (manage_timelines update.hidden): data kept, tab not shown */
  hidden?: boolean;
}

/** Track ids in visual top-to-bottom order. Legacy four-lane states still work. */
export function timelineTrackIds(s: TimelineState): TrackId[] {
  const ids = s.trackOrder ? [...s.trackOrder] : [...TRACK_ORDER];
  for (const id of Object.keys(s.tracks ?? {})) if (!ids.includes(id)) ids.push(id);
  for (const item of s.items) if (!ids.includes(item.track)) ids.push(item.track);
  return ids;
}

export function trackKind(s: TimelineState, id: TrackId): TrackKind {
  const prefix = id.toUpperCase()[0];
  return s.tracks?.[id]?.kind ?? (prefix === 'A' ? 'audio' : prefix === 'C' ? 'caption' : 'video');
}

/** True when a non-main visual track is dedicated to overlay text clips. */
export function isTextTrack(s: TimelineState, id: TrackId, mainId?: TrackId | null): boolean {
  if (trackKind(s, id) !== 'video') return false;
  const ids = timelineTrackIds(s);
  const explicitMain = s.interaction?.mainTrackId;
  const resolvedMain = mainId !== undefined
    ? mainId
    : (explicitMain && ids.includes(explicitMain) && trackKind(s, explicitMain) === 'video'
      ? explicitMain
      : ids.toReversed().find((candidate) => trackKind(s, candidate) === 'video') ?? null);
  if (resolvedMain && id === resolvedMain) return false;
  if (s.tracks?.[id]?.visualRole === 'text') return true;
  const onTrack = s.items.filter((item) => item.track === id);
  return onTrack.length > 0 && onTrack.every((item) => item.kind === 'text');
}

/** True when `id` is a dedicated effects/shapes/MG overlay lane (not main track). */
export function isEffectTrack(s: TimelineState, id: TrackId, mainId?: TrackId | null): boolean {
  const ids = timelineTrackIds(s);
  const explicitMain = s.interaction?.mainTrackId;
  const resolvedMain = mainId !== undefined
    ? mainId
    : (explicitMain && ids.includes(explicitMain) && trackKind(s, explicitMain) === 'video'
      ? explicitMain
      : ids.toReversed().find((candidate) => trackKind(s, candidate) === 'video') ?? null);
  if (resolvedMain && id === resolvedMain) return false;
  return trackKind(s, id) === 'video' && s.tracks?.[id]?.visualRole === 'effect';
}

export function isEffectItemKind(kind: TimelineItem['kind']): boolean {
  return kind === 'solid' || kind === 'mosaic' || kind === 'motion-graphic' || kind === 'gif' || kind === 'svg';
}

/** Strict track nature used to keep text, effect, video/picture, audio, and caption tracks segregated. */
export function trackNature(s: TimelineState, id: TrackId, mainId?: TrackId | null): TrackNature {
  const kind = trackKind(s, id);
  if (kind !== 'video') return kind;
  if (isTextTrack(s, id, mainId)) return 'text';
  if (isEffectTrack(s, id, mainId)) return 'effect';
  return 'video';
}

export function itemTrackNature(item: Pick<TimelineItem, 'kind'>): 'audio' | 'text' | 'effect' | 'video' {
  if (item.kind === 'audio') return 'audio';
  if (item.kind === 'text') return 'text';
  if (isEffectItemKind(item.kind)) return 'effect';
  return 'video';
}

export function canTrackAcceptItemKind(
  s: TimelineState,
  itemKind: TimelineItem['kind'],
  trackId: TrackId,
  mainId?: TrackId | null,
): boolean {
  if (s.tracks?.[trackId]?.locked) return false;
  const target = trackNature(s, trackId, mainId);
  if (target === 'caption') return false;
  if (itemKind === 'audio') return target === 'audio';
  if (itemKind === 'text') return target === 'text';
  if (target === 'text') return false;
  if (target === 'effect') return isEffectItemKind(itemKind);
  return target === 'video';
}

/** Current human alias. Video aliases count bottom-up; audio/caption aliases top-down. */
export function trackAlias(s: TimelineState, id: TrackId): string {
  const ids = timelineTrackIds(s);
  const kind = trackKind(s, id);
  const same = ids.filter((candidate) => trackKind(s, candidate) === kind);
  const index = same.indexOf(id);
  if (index < 0) return id;
  if (kind === 'video') return `V${same.length - index}`;
  return `${kind === 'caption' ? 'C' : 'A'}${index + 1}`;
}

/** Resolve either a stable id or current Cn/Vn/An alias. */
export function resolveTrackId(s: TimelineState, ref: unknown, kind?: TrackKind): TrackId | null {
  const value = String(ref ?? '').trim();
  const ids = timelineTrackIds(s).filter((id) => !kind || trackKind(s, id) === kind);
  if (ids.includes(value)) return value;
  const upper = value.toUpperCase();
  return ids.find((id) => trackAlias(s, id) === upper) ?? null;
}

/** Default placement lane: V1 (bottom video) or A1 (top audio). */
/** Selected clip ids (multi-select aware; falls back to selectedId). */
export function selectedIdsOf(s: Pick<TimelineState, 'selectedId' | 'selectedIds'>): string[] {
  if (s.selectedIds && s.selectedIds.length) return s.selectedIds;
  return s.selectedId ? [s.selectedId] : [];
}

export function isItemSelected(s: Pick<TimelineState, 'selectedId' | 'selectedIds'>, id: string): boolean {
  return selectedIdsOf(s).includes(id);
}

/** Visual (picture) clip kinds — not pure audio. */
export function isVisualItemKind(kind: TimelineItem['kind']): boolean {
  return kind !== 'audio';
}

/** Kinds that draw from a media src (file-backed). */
export function isFileMediaKind(kind: TimelineItem['kind'] | MediaAssetKind): boolean {
  return kind === 'video' || kind === 'image' || kind === 'audio' || kind === 'gif' || kind === 'svg';
}

/** Kinds rendered via MediaFill (raster/video path). */
export function isRasterMediaKind(kind: TimelineItem['kind']): boolean {
  return kind === 'video' || kind === 'image' || kind === 'gif' || kind === 'svg';
}

export function defaultTrackId(s: TimelineState, kind: TrackKind): TrackId | null {
  if (kind === 'video') {
    const pictureIds = timelineTrackIds(s).filter((id) => trackKind(s, id) === 'video' && !isTextTrack(s, id) && !isEffectTrack(s, id));
    const alias = resolveTrackId(s, 'V1', 'video');
    if (alias && !isTextTrack(s, alias) && !isEffectTrack(s, alias)) return alias;
    return pictureIds.at(-1) ?? null;
  }
  const alias = kind === 'caption' ? 'C1' : 'A1';
  return resolveTrackId(s, alias, kind)
    ?? timelineTrackIds(s).find((id) => trackKind(s, id) === kind)
    ?? null;
}

/** Caption data for one lane. The first caption lane falls back to legacy projects. */
export function captionsOnTrack(s: TimelineState, id: TrackId): CaptionsData | null {
  const own = s.tracks?.[id]?.captions;
  if (own !== undefined) return own;
  return id === defaultTrackId(s, 'caption') ? s.captions ?? null : null;
}

export function captionTrackEntries(s: TimelineState): Array<{ id: TrackId; captions: CaptionsData | null }> {
  return timelineTrackIds(s)
    .filter((id) => trackKind(s, id) === 'caption')
    .map((id) => ({ id, captions: captionsOnTrack(s, id) }));
}

/** total timeline length = last item's end (min 1s). */
export function timelineDuration(s: TimelineState): number {
  const end = s.items.reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
  return Math.max(end, s.fps);
}

/** first free frame on a track (append point). */
export function trackEnd(s: TimelineState, track: TrackId): number {
  return s.items
    .filter((it) => it.track === track)
    .reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
}
