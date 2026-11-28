import type { Tpl } from '../../types';
import {
  defaultTrackId,
  parseBuiltinTransitionId,
  resolveTrackId,
  type TimelineItem,
  type TimelineState,
  type TransitionDirection,
  type TransitionType,
} from '../../editor/types';

type OpResult = Record<string, unknown>;
type Entry = Record<string, unknown>;

function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const query = String(id ?? '');
  if (!query) return null;
  return items.find((item) => item.id === query || item.id.startsWith(query)) ?? null;
}

function findAdjacentOutgoing(items: TimelineItem[], incoming: TimelineItem): TimelineItem | null {
  const prior = items.filter((item) =>
    item.id !== incoming.id
    && item.track === incoming.track
    && item.kind !== 'audio'
    && item.startFrame + item.durationInFrames <= incoming.startFrame + 2);
  if (!prior.length) return null;
  const outgoing = prior.reduce((best, item) =>
    item.startFrame + item.durationInFrames > best.startFrame + best.durationInFrames ? item : best);
  return incoming.startFrame - (outgoing.startFrame + outgoing.durationInFrames) > 2
    ? null
    : outgoing;
}

const DIRECTIONS = new Set<TransitionDirection>(['left', 'right', 'up', 'down']);
const HEX_6 = /^#[0-9a-f]{6}$/i;

export function parseTransitionExtraFields(entry: Entry): {
  patch: Partial<{
    direction: TransitionDirection;
    originX: number;
    originY: number;
    lineColor: string;
    lineWidthPx: number;
  }>;
  error?: string;
} {
  const patch: Partial<{
    direction: TransitionDirection;
    originX: number;
    originY: number;
    lineColor: string;
    lineWidthPx: number;
  }> = {};
  if (entry.direction !== undefined) {
    const d = String(entry.direction) as TransitionDirection;
    if (!DIRECTIONS.has(d)) return { patch, error: 'transition direction must be left/right/up/down' };
    patch.direction = d;
  }
  if (entry.originX !== undefined) {
    if (typeof entry.originX !== 'number' || !Number.isFinite(entry.originX) || entry.originX < 0 || entry.originX > 1) {
      return { patch, error: 'transition originX must be a finite number in 0..1' };
    }
    patch.originX = Math.round(entry.originX * 1000) / 1000;
  }
  if (entry.originY !== undefined) {
    if (typeof entry.originY !== 'number' || !Number.isFinite(entry.originY) || entry.originY < 0 || entry.originY > 1) {
      return { patch, error: 'transition originY must be a finite number in 0..1' };
    }
    patch.originY = Math.round(entry.originY * 1000) / 1000;
  }
  if (entry.lineColor !== undefined) {
    const color = String(entry.lineColor).trim();
    if (!HEX_6.test(color)) return { patch, error: 'transition lineColor must be a #rrggbb hex color' };
    patch.lineColor = color;
  }
  if (entry.lineWidthPx !== undefined) {
    if (typeof entry.lineWidthPx !== 'number' || !Number.isFinite(entry.lineWidthPx) || entry.lineWidthPx < 1 || entry.lineWidthPx > 20) {
      return { patch, error: 'transition lineWidthPx must be a finite number in 1..20' };
    }
    patch.lineWidthPx = Math.round(entry.lineWidthPx * 10) / 10;
  }
  return { patch };
}

export function resolveTransitionTargets(state: TimelineState, entry: Entry): {
  incoming: TimelineItem;
  outgoing: TimelineItem;
} | { error: string; hint?: string } {
  const direct = findItem(state.items, entry.incomingItemId);
  let incoming = direct;
  if (!incoming && entry.trackId != null && entry.fromFrame != null) {
    const track = String(entry.trackId);
    const frame = Number(entry.fromFrame);
    incoming = state.items
      .filter((item) => item.track === track && item.kind !== 'audio' && Math.abs(item.startFrame - frame) <= 2)
      .sort((a, b) => a.startFrame - b.startFrame)[0] ?? null;
  }
  if (!incoming || incoming.kind === 'audio') {
    return { error: 'transition needs incomingItemId (the later clip at the cut)' };
  }
  if (entry.outgoingItemId && !findItem(state.items, entry.outgoingItemId)) {
    return { error: `outgoingItemId not found: ${entry.outgoingItemId}` };
  }
  const outgoing = findAdjacentOutgoing(state.items, incoming);
  if (!outgoing) {
    return {
      error: `no adjacent prior clip before ${incoming.id} on track ${incoming.track}`,
      hint: 'Transition straddles a cut between two same-track visual clips',
    };
  }
  const requestedOutgoing = entry.outgoingItemId ? findItem(state.items, entry.outgoingItemId) : null;
  if (requestedOutgoing && requestedOutgoing.id !== outgoing.id) {
    return { error: `outgoingItemId ${entry.outgoingItemId} is not the adjacent prior clip (found ${outgoing.id})` };
  }
  return { incoming, outgoing };
}

export function buildTransitionAddPlan(
  entry: Entry,
  assetId: string,
  incoming: TimelineItem,
  outgoing: TimelineItem,
  type: TransitionType,
  custom?: { frag: string; uniforms: Record<string, number>; label: string },
): OpResult {
  const extra = parseTransitionExtraFields(entry);
  if (extra.error) return { error: extra.error };
  const maxDuration = Math.max(2, Math.min(outgoing.durationInFrames, incoming.durationInFrames));
  const defaultDuration = type === 'audio-cross-fade' ? Math.min(15, maxDuration) : Math.min(30, maxDuration);
  const requested = typeof entry.durationInFrames === 'number' && Number.isFinite(entry.durationInFrames)
    ? entry.durationInFrames
    : defaultDuration;
  return {
    ok: true,
    kind: 'transition',
    plan: 'addTransition',
    incomingItemId: incoming.id,
    outgoingItemId: outgoing.id,
    type,
    assetId,
    durationInFrames: Math.max(2, Math.min(requested, maxDuration)),
    ...(Object.keys(extra.patch).length ? { extraPatch: extra.patch } : {}),
    ...(custom ? { custom } : {}),
  };
}

export function validateBuiltinTransitionAdd(state: TimelineState, entry: Entry): OpResult {
  const assetId = String(entry.assetId ?? '');
  const type = parseBuiltinTransitionId(assetId);
  if (!type) {
    return {
      error: `unknown builtin transition assetId ${assetId}`,
      hint: 'Use builtin:tr-<type> (e.g. builtin:tr-ink-bleed, builtin:tr-archival-line-wipe, builtin:tr-cross-dissolve)',
    };
  }
  const targets = resolveTransitionTargets(state, entry);
  if ('error' in targets) return targets;
  return buildTransitionAddPlan(entry, assetId, targets.incoming, targets.outgoing, type);
}

export function validateTransitionUpdateShared(state: TimelineState, entry: Entry): OpResult {
  const id = String(entry.id ?? '');
  const transition = state.transitions?.find((item) => item.id === id || item.id.startsWith(id));
  if (!transition) return { error: `transition not found: ${id}` };
  const extra = parseTransitionExtraFields(entry);
  if (extra.error) return { error: extra.error };
  const patch: Record<string, unknown> = { ...extra.patch };
  if (typeof entry.durationInFrames === 'number') patch.durationInFrames = entry.durationInFrames;
  if (typeof entry.assetId === 'string') {
    const type = parseBuiltinTransitionId(entry.assetId);
    if (!type) return { error: `unknown transition assetId ${entry.assetId}` };
    patch.type = type;
  }
  if (typeof entry.transitionType === 'string') {
    const type = parseBuiltinTransitionId(entry.transitionType) ?? entry.transitionType as TransitionType;
    if (type) patch.type = type;
  }
  return { ok: true, kind: 'transition', plan: 'setTransition', id: transition.id, patch };
}

export function validateTransitionDeleteShared(state: TimelineState, entry: Entry): OpResult {
  const id = String(entry.id ?? '');
  const transition = state.transitions?.find((item) => item.id === id || item.id.startsWith(id));
  if (!transition) return { error: `transition not found: ${id}` };
  return { ok: true, kind: 'transition', plan: 'removeTransition', id: transition.id };
}

export function validateLocalMgAdd(
  state: TimelineState,
  templates: readonly Tpl[],
  entry: Entry,
): OpResult {
  const assetId = String(entry.assetId ?? '');
  const match = /^library:motion-graphic:(.+)$/.exec(assetId);
  if (!match) return { error: 'motion-graphic add expects library:motion-graphic:<id>', got: assetId };
  const id = match[1];
  const template = templates.find((item) => item.id === id || item.id.startsWith(id) || item.name === id)
    ?? templates.find((item) => item.name.toLowerCase() === id.toLowerCase());
  if (!template) return { error: `unknown motion-graphic ${id}`, hint: 'browse_library category=motion-graphics' };
  const rawTrack = entry.track ?? entry.trackId;
  const strictTrack = rawTrack !== undefined && rawTrack !== null && String(rawTrack).trim() !== '';
  let track: string | undefined;
  if (strictTrack) {
    track = resolveTrackId(state, rawTrack, 'video') ?? undefined;
    if (!track) {
      return { error: `unknown or incompatible video track "${String(rawTrack)}"` };
    }
    if (state.tracks?.[track]?.locked) {
      return { error: `track "${track}" is locked` };
    }
  } else {
    if (!defaultTrackId(state, 'video')) return { error: 'no video track; create one with edit_track first' };
  }
  const startFrame = typeof entry.fromFrame === 'number'
    ? Math.max(0, Math.round(entry.fromFrame))
    : typeof entry.startFrame === 'number' ? Math.max(0, Math.round(entry.startFrame)) : undefined;
  const durationInFrames = typeof entry.durationInFrames === 'number' && Number.isFinite(entry.durationInFrames) && entry.durationInFrames >= 1
    ? Math.round(entry.durationInFrames)
    : undefined;
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
  if (entry.props !== undefined && (entry.props === null || typeof entry.props !== 'object' || Array.isArray(entry.props))) {
    return { error: 'motion-graphic props must be a plain object' };
  }
  const props = entry.props ? (entry.props as Record<string, unknown>) : undefined;
  return {
    ok: true,
    kind: 'motion-graphic',
    plan: 'addMg',
    templateId: template.id,
    name: name ?? template.name,
    track,
    ...(strictTrack ? { strictTrack: true } : {}),
    startFrame,
    ...(durationInFrames !== undefined ? { durationInFrames } : {}),
    ...(props ? { props } : {}),
  };
}
