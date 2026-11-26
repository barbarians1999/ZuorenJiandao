import type { AgentContext } from '../context';
import {
  appendManualCue,
  identifyManualCues,
  isManualCaptionEntry,
  newManualCaptions,
  newManualEntry,
  promoteCaptionEntries,
  removeManualCue,
  updateManualCue,
} from '../../captions/manualCaptions';
import { PastedTranscriptError, type PastedTranscriptErrorCode } from '../../captions/pastedTranscript';
import { buildPastedTranscriptTrack, transcribedSpeechOnTrack } from '../../captions/pastedTranscriptTrack';
import { normalizeCaptionSourceEntries } from '../../captions/sourceOrder';
import { parseSrt } from '../../captions/srt';
import type { CaptionsData, CaptionSourceEntry } from '../../captions/types';
import {
  captionsOnTrack,
  defaultTrackId,
  resolveTrackId,
  timelineTrackIds,
  trackAlias,
  type TimelineState,
  type TrackId,
} from '../../editor/types';

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;

const DEFAULT_CUE_MS = 3_000;

const PASTED_TRANSCRIPT_ERRORS: Record<PastedTranscriptErrorCode, string> = {
  'empty-script': '请先提供文字稿内容（json.script 或 json.text）。',
  'missing-timing': '所选口播轨道没有可用的转写时间，请先转写该轨道。',
  'no-matchable-text': '文字稿里没有可用于匹配的文字或数字。',
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const intNum = (v: unknown): number | undefined => (
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
);

function parseCueTiming(
  raw: Record<string, unknown>,
  options: { allowMissingEnd?: boolean; defaultStart?: number; defaultEnd?: number } = {},
): { startMs: number; endMs: number } | { error: string } {
  const startRaw = num(raw.startMs) ?? num(raw.start) ?? options.defaultStart;
  if (startRaw === undefined) return { error: 'cue requires finite startMs' };
  const startMs = Math.round(startRaw);
  if (startMs < 0) return { error: 'startMs must be >= 0' };

  const endRaw = num(raw.endMs) ?? num(raw.end)
    ?? (options.defaultEnd !== undefined ? options.defaultEnd : options.allowMissingEnd ? startMs + DEFAULT_CUE_MS : undefined);
  if (endRaw === undefined) return { error: 'cue requires finite endMs' };
  const endMs = Math.round(endRaw);
  if (endMs <= startMs) return { error: `endMs (${endMs}) must be greater than startMs (${startMs})` };

  return { startMs, endMs };
}

function trackMetadata(state: TimelineState, preferredTrackId: TrackId | null) {
  const resolved = preferredTrackId && captionsOnTrack(state, preferredTrackId)
    ? preferredTrackId
    : defaultTrackId(state, 'caption');
  return {
    captionTrackId: resolved,
    captionTrackAlias: resolved ? trackAlias(state, resolved) : null,
  };
}

function findCueById(
  entries: readonly CaptionSourceEntry[],
  cueId: string,
  laneIdFilter?: string,
): { lane: CaptionSourceEntry; index: number } | null {
  for (const entry of entries) {
    if (!isManualCaptionEntry(entry)) continue;
    if (laneIdFilter && entry.id !== laneIdFilter) continue;
    const index = (entry.words ?? []).findIndex((word) => word.id === cueId);
    if (index >= 0) return { lane: entry, index };
  }
  return null;
}

function countManualCues(c: CaptionsData | null | undefined): number {
  if (!c?.sourceEntries?.length) return 0;
  return c.sourceEntries.reduce((sum, entry) => sum + (isManualCaptionEntry(entry) ? (entry.words?.length ?? 0) : 0), 0);
}

function resolveWriteMode(
  json: Record<string, unknown>,
  c: CaptionsData | null,
  requestedTrack: string,
): { mode: 'create_track' | 'replace' | 'append_lane' } | { error: string } {
  const explicit = str(json.mode);
  if (explicit) {
    if (explicit === 'create_track' || explicit === 'replace' || explicit === 'append_lane') {
      return { mode: explicit };
    }
    return { error: `unknown mode "${explicit}"; expected create_track, replace, or append_lane` };
  }
  if (json.createTrack === true || (!requestedTrack && c?.enabled)) {
    return { mode: 'create_track' };
  }
  return { mode: 'replace' };
}

function writeManualCaptionsTrack(
  mode: 'create_track' | 'replace' | 'append_lane',
  nextCaptions: CaptionsData,
  label: string,
  c: CaptionsData | null,
  ctx: AgentContext,
  s: TimelineState,
  targetTrackId: TrackId | null,
): { captionTrackId: TrackId | null; captionTrackAlias: string | null; createdTrack: boolean } {
  const entry = nextCaptions.sourceEntries?.[0];
  if (mode === 'create_track') {
    const createdId = ctx.commands.createCaptionTrack(nextCaptions, { name: label });
    const latest = ctx.getState();
    return {
      captionTrackId: createdId,
      captionTrackAlias: trackAlias(latest, createdId),
      createdTrack: true,
    };
  }
  if (mode === 'append_lane' && c && entry) {
    const existing = promoteCaptionEntries(c, s.items);
    const mergedEntries = normalizeCaptionSourceEntries([...existing, entry]);
    ctx.commands.updateCaptions({
      enabled: true,
      sourceEntries: mergedEntries,
      sources: undefined,
      sourceMode: 'item',
      words: undefined,
    });
    return {
      ...trackMetadata(ctx.getState(), targetTrackId),
      createdTrack: false,
    };
  }
  if (c) {
    ctx.commands.updateCaptions({
      ...nextCaptions,
      wordOverrides: undefined,
      sourceItemId: undefined,
      sources: undefined,
      words: undefined,
    });
  } else {
    ctx.commands.setCaptions(nextCaptions);
  }
  return {
    ...trackMetadata(ctx.getState(), targetTrackId),
    createdTrack: !c,
  };
}

export function execCueAdd(
  json: Record<string, unknown>,
  c: CaptionsData | null,
  ctx: AgentContext,
  s: TimelineState,
  targetTrackId: TrackId | null,
): Result {
  const rawList = Array.isArray(json.cues) ? json.cues : [json];
  if (!rawList.length) return { error: 'cue_add needs {text, startMs, endMs?} or {cues:[...]}' };

  const defaultLaneFilter = str(json.laneId);
  const validated: Array<{ text: string; startMs: number; endMs: number; laneId?: string }> = [];
  for (let i = 0; i < rawList.length; i += 1) {
    const raw = rawList[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `cue_add item ${i} must be an object` };
    }
    const rec = raw as Record<string, unknown>;
    const text = str(rec.text);
    if (!text) return { error: `cue_add item ${i} requires non-empty text` };
    const timing = parseCueTiming(rec, { allowMissingEnd: true });
    if ('error' in timing) return { error: `cue_add item ${i}: ${timing.error}` };
    validated.push({
      text,
      startMs: timing.startMs,
      endMs: timing.endMs,
      laneId: str(rec.laneId) || defaultLaneFilter || undefined,
    });
  }

  const isNew = !c;
  let working: CaptionsData;
  if (isNew) {
    working = newManualCaptions();
  } else {
    const promoted = promoteCaptionEntries(c, s.items);
    working = {
      ...c,
      enabled: true,
      sourceEntries: promoted,
      sources: undefined,
      sourceMode: 'item',
      words: undefined,
    };
  }

  const entries = [...(working.sourceEntries ?? [])];
  const resolveLaneId = (requestedLaneId?: string): string | { error: string } => {
    if (requestedLaneId) {
      const match = entries.find((entry) => entry.id === requestedLaneId);
      if (!match || !isManualCaptionEntry(match)) {
        return { error: `manual caption lane "${requestedLaneId}" not found` };
      }
      return match.id;
    }
    const existingManual = entries.find(isManualCaptionEntry);
    if (existingManual) return existingManual.id;
    const fresh = newManualEntry(1);
    entries.push(fresh);
    working = { ...working, sourceEntries: normalizeCaptionSourceEntries(entries) };
    return fresh.id;
  };

  const insertedIds: Array<{ cueId: string; laneId: string }> = [];
  for (const item of validated) {
    const laneOrErr = resolveLaneId(item.laneId);
    if (typeof laneOrErr !== 'string') return laneOrErr;
    const laneId = laneOrErr;
    const beforeWords = working.sourceEntries?.find((entry) => entry.id === laneId)?.words ?? [];
    const beforeIds = new Set(beforeWords.map((word) => word.id).filter(Boolean));
    const patch = appendManualCue(working, laneId, item.text, item.startMs, item.endMs);
    if (!patch) return { error: `failed to append cue "${item.text}"` };
    working = { ...working, ...patch };
    const afterWords = working.sourceEntries?.find((entry) => entry.id === laneId)?.words ?? [];
    const created = afterWords.find((word) => word.id && !beforeIds.has(word.id))
      ?? afterWords.find((word) => word.text === item.text && word.start === item.startMs && word.end === item.endMs);
    insertedIds.push({ cueId: created?.id ?? '', laneId });
  }

  if (isNew) {
    ctx.commands.setCaptions(working);
  } else {
    ctx.commands.updateCaptions({
      enabled: true,
      sourceEntries: working.sourceEntries,
      sources: undefined,
      sourceMode: 'item',
      words: undefined,
    });
  }

  const added = insertedIds.map(({ cueId, laneId }, idx) => {
    const laneWords = working.sourceEntries?.find((entry) => entry.id === laneId)?.words ?? [];
    const index = cueId ? laneWords.findIndex((word) => word.id === cueId) : -1;
    const cue = index >= 0 ? laneWords[index]! : validated[idx]!;
    return {
      cueId: cueId || null,
      laneId,
      index,
      text: cue.text,
      startMs: 'start' in cue ? cue.start : cue.startMs,
      endMs: 'end' in cue ? cue.end : cue.endMs,
    };
  });

  const meta = trackMetadata(ctx.getState(), targetTrackId);
  return {
    ok: true,
    ...meta,
    laneId: added[0]?.laneId ?? null,
    added,
    cueCount: countManualCues(working),
  };
}

export function execCueUpdate(
  json: Record<string, unknown>,
  c: CaptionsData,
  ctx: AgentContext,
  _s: TimelineState,
  targetTrackId: TrackId | null,
): Result {
  const entries = c.sourceEntries ?? [];
  const manualLanes = entries.filter(isManualCaptionEntry);
  if (!manualLanes.length) {
    return { error: 'no manual caption cues on this track; use cue_add, import_srt, or paste_transcript first' };
  }

  const rawList = Array.isArray(json.cues) ? json.cues : [json];
  if (!rawList.length) return { error: 'cue_update needs {cueId|index, text?, startMs?, endMs?} or {cues:[...]}' };

  const defaultLaneId = str(json.laneId);
  const resolvedTargets: Array<{
    laneId: string;
    cueId: string;
    fallbackIndex: number;
    text: string;
    startMs: number;
    endMs: number;
  }> = [];

  for (let i = 0; i < rawList.length; i += 1) {
    const raw = rawList[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `cue_update item ${i} must be an object` };
    }
    const rec = raw as Record<string, unknown>;
    const laneFilter = str(rec.laneId) || defaultLaneId;
    const cueId = str(rec.cueId);
    const indexArg = intNum(rec.index);

    let lane: CaptionSourceEntry | undefined;
    let index = -1;
    if (cueId) {
      const found = findCueById(entries, cueId, laneFilter || undefined);
      if (!found) return { error: `cue "${cueId}" not found` };
      lane = found.lane;
      index = found.index;
    } else if (indexArg !== undefined) {
      lane = laneFilter ? manualLanes.find((entry) => entry.id === laneFilter) : manualLanes[0];
      if (!lane) return { error: laneFilter ? `manual caption lane "${laneFilter}" not found` : 'no manual caption lane' };
      index = indexArg;
    } else {
      return { error: `cue_update item ${i} requires cueId or index` };
    }

    const current = lane.words?.[index];
    if (!current) return { error: `cue at index ${index} not found in lane ${lane.id}` };

    const hasText = typeof rec.text === 'string';
    const hasStart = num(rec.startMs) !== undefined || num(rec.start) !== undefined;
    const hasEnd = num(rec.endMs) !== undefined || num(rec.end) !== undefined;
    if (!hasText && !hasStart && !hasEnd) {
      return { error: `cue_update item ${i} must change at least one of text, startMs, or endMs` };
    }

    const nextText = hasText ? str(rec.text) : current.text;
    if (!nextText) return { error: `cue_update item ${i}: text cannot be empty` };

    const timing = parseCueTiming(rec, {
      defaultStart: current.start,
      defaultEnd: current.end,
    });
    if ('error' in timing) return { error: `cue_update item ${i}: ${timing.error}` };

    resolvedTargets.push({
      laneId: lane.id,
      cueId: current.id ?? '',
      fallbackIndex: index,
      text: nextText,
      startMs: timing.startMs,
      endMs: timing.endMs,
    });
  }

  let working = c;
  for (const target of resolvedTargets) {
    const laneWords = working.sourceEntries?.find((entry) => entry.id === target.laneId && isManualCaptionEntry(entry))?.words ?? [];
    const liveIndex = target.cueId
      ? laneWords.findIndex((word) => word.id === target.cueId)
      : target.fallbackIndex;
    if (liveIndex < 0 || !laneWords[liveIndex]) {
      return { error: `cue "${target.cueId || target.fallbackIndex}" disappeared during batch update` };
    }
    const patch = updateManualCue(working, target.laneId, liveIndex, target.text, target.startMs, target.endMs);
    if (!patch) return { error: `failed to update cue "${target.cueId || liveIndex}"` };
    working = { ...working, ...patch };
  }

  ctx.commands.updateCaptions({
    sourceEntries: working.sourceEntries,
    sources: undefined,
    sourceMode: 'item',
    words: undefined,
  });

  const updated = resolvedTargets.map((target) => {
    const laneWords = working.sourceEntries?.find((entry) => entry.id === target.laneId)?.words ?? [];
    const index = target.cueId
      ? laneWords.findIndex((word) => word.id === target.cueId)
      : laneWords.findIndex((word) => word.text === target.text && word.start === target.startMs && word.end === target.endMs);
    const word = index >= 0 ? laneWords[index]! : undefined;
    return {
      cueId: word?.id ?? (target.cueId || null),
      laneId: target.laneId,
      index,
      text: word?.text ?? target.text,
      startMs: word?.start ?? target.startMs,
      endMs: word?.end ?? target.endMs,
    };
  });

  return {
    ok: true,
    ...trackMetadata(ctx.getState(), targetTrackId),
    updated,
  };
}

export function execCueRemove(
  json: Record<string, unknown>,
  c: CaptionsData,
  ctx: AgentContext,
  _s: TimelineState,
  targetTrackId: TrackId | null,
): Result {
  const entries = c.sourceEntries ?? [];
  const manualLanes = entries.filter(isManualCaptionEntry);
  if (!manualLanes.length) {
    return { error: 'no manual caption cues on this track' };
  }

  const defaultLaneId = str(json.laneId);
  if (json.clearAll === true) {
    if (defaultLaneId && !manualLanes.some((entry) => entry.id === defaultLaneId)) {
      return { error: `manual caption lane "${defaultLaneId}" not found` };
    }
    const removedCount = manualLanes
      .filter((entry) => !defaultLaneId || entry.id === defaultLaneId)
      .reduce((sum, entry) => sum + (entry.words?.length ?? 0), 0);
    const nextEntries = entries.map((entry) =>
      isManualCaptionEntry(entry) && (!defaultLaneId || entry.id === defaultLaneId)
        ? { ...entry, words: [] }
        : entry,
    );
    const working: CaptionsData = { ...c, sourceEntries: normalizeCaptionSourceEntries(nextEntries) };
    ctx.commands.updateCaptions({
      sourceEntries: working.sourceEntries,
      sources: undefined,
      sourceMode: 'item',
      words: undefined,
    });
    return {
      ok: true,
      ...trackMetadata(ctx.getState(), targetTrackId),
      removedCount,
      remainingCount: countManualCues(working),
    };
  }

  const rawTargets: Array<{ cueId?: string; laneId?: string; index?: number }> = [];
  if (Array.isArray(json.cueIds)) {
    for (const id of json.cueIds) {
      if (typeof id === 'string' && id.trim()) rawTargets.push({ cueId: id.trim(), laneId: defaultLaneId || undefined });
    }
  } else if (Array.isArray(json.cues)) {
    for (const item of json.cues) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        rawTargets.push({
          cueId: str(rec.cueId) || undefined,
          laneId: str(rec.laneId) || defaultLaneId || undefined,
          index: intNum(rec.index),
        });
      }
    }
  } else {
    rawTargets.push({
      cueId: str(json.cueId) || undefined,
      laneId: defaultLaneId || undefined,
      index: intNum(json.index),
    });
  }

  if (!rawTargets.length || (!rawTargets[0]!.cueId && rawTargets[0]!.index === undefined)) {
    return { error: 'cue_remove needs {cueId}, {cueIds:[...]}, {index, laneId?}, or {clearAll:true}' };
  }

  const resolved: Array<{ laneId: string; cueId: string; index: number }> = [];
  const seen = new Set<string>();
  for (const target of rawTargets) {
    if (target.cueId) {
      const found = findCueById(entries, target.cueId, target.laneId);
      if (!found) return { error: `cue "${target.cueId}" not found` };
      const key = `${found.lane.id}:${found.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push({ laneId: found.lane.id, cueId: target.cueId, index: found.index });
      }
    } else if (target.index !== undefined) {
      const lane = target.laneId ? manualLanes.find((entry) => entry.id === target.laneId) : manualLanes[0];
      if (!lane) return { error: target.laneId ? `manual caption lane "${target.laneId}" not found` : 'no manual caption lane' };
      const word = lane.words?.[target.index];
      if (!word) return { error: `cue at index ${target.index} not found in lane ${lane.id}` };
      const key = `${lane.id}:${target.index}`;
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push({ laneId: lane.id, cueId: word.id ?? '', index: target.index });
      }
    } else {
      return { error: 'each cue_remove target requires cueId or index' };
    }
  }

  // Delete in descending index order so fallback indices never shift prior to removal.
  resolved.sort((a, b) => b.index - a.index);
  let working = c;
  for (const target of resolved) {
    const laneWords = working.sourceEntries?.find((entry) => entry.id === target.laneId && isManualCaptionEntry(entry))?.words ?? [];
    const liveIndex = target.cueId ? laneWords.findIndex((word) => word.id === target.cueId) : target.index;
    if (liveIndex < 0) continue;
    working = { ...working, ...removeManualCue(working, target.laneId, liveIndex) };
  }

  ctx.commands.updateCaptions({
    sourceEntries: working.sourceEntries,
    sources: undefined,
    sourceMode: 'item',
    words: undefined,
  });

  return {
    ok: true,
    ...trackMetadata(ctx.getState(), targetTrackId),
    removedCount: resolved.length,
    remainingCount: countManualCues(working),
  };
}

export function execImportSrt(
  json: Record<string, unknown>,
  c: CaptionsData | null,
  ctx: AgentContext,
  s: TimelineState,
  targetTrackId: TrackId | null,
  requestedTrack: string,
): Result {
  const srtText = (
    typeof json.srt === 'string' ? json.srt
      : typeof json.srtText === 'string' ? json.srtText
        : typeof json.content === 'string' ? json.content
          : ''
  );
  if (!srtText.trim()) {
    const rawPath = str(json.srtPath) || str(json.path);
    if (rawPath) {
      return {
        error: `import_srt requires UTF-8 SRT text in json.srt or json.content (cannot read filesystem path "${rawPath}" directly; read the file and pass its content)`,
      };
    }
    return { error: 'import_srt needs non-empty SRT text in json.srt or json.content' };
  }

  const modeInfo = resolveWriteMode(json, c, requestedTrack);
  if ('error' in modeInfo) return modeInfo;

  let cues;
  try {
    cues = identifyManualCues(parseSrt(srtText));
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  const label = str(json.name) || str(json.label) || 'SRT 字幕';
  const laneId = `srt_${crypto.randomUUID()}`;
  const base = newManualCaptions();
  const nextCaptions: CaptionsData = {
    ...base,
    sourceEntries: [{
      id: laneId,
      itemId: `manual:${laneId}`,
      label,
      words: cues,
    }],
  };

  const written = writeManualCaptionsTrack(modeInfo.mode, nextCaptions, label, c, ctx, s, targetTrackId);
  return {
    ok: true,
    ...written,
    laneId,
    mode: modeInfo.mode,
    cueCount: cues.length,
    startMs: cues[0]!.start,
    endMs: cues[cues.length - 1]!.end,
  };
}

export function execPasteTranscript(
  args: Args,
  json: Record<string, unknown>,
  c: CaptionsData | null,
  ctx: AgentContext,
  s: TimelineState,
  targetTrackId: TrackId | null,
  requestedTrack: string,
): Result {
  const script = (
    typeof json.script === 'string' ? json.script
      : typeof json.text === 'string' ? json.text
        : ''
  );
  if (!script.trim()) return { error: 'paste_transcript needs non-empty script text in json.script or json.text' };

  const modeInfo = resolveWriteMode(json, c, requestedTrack);
  if ('error' in modeInfo) return modeInfo;

  const requestedSpeech = str(json.trackId) || str(json.track) || str(args.trackId);
  let speechTrackId: TrackId | null = null;
  if (requestedSpeech) {
    speechTrackId = resolveTrackId(s, requestedSpeech);
    if (!speechTrackId) return { error: `speech track "${requestedSpeech}" not found` };
    if (!transcribedSpeechOnTrack(s.items, speechTrackId).length) {
      return { error: `speech track ${trackAlias(s, speechTrackId)} has no transcribed clips; transcribe it first` };
    }
  } else {
    speechTrackId = timelineTrackIds(s).find((id) => transcribedSpeechOnTrack(s.items, id).length > 0) ?? null;
    if (!speechTrackId) {
      return { error: 'no transcribed speech track available; transcribe a track or use import_srt / cue_add instead' };
    }
  }

  const label = str(json.name) || str(json.label) || '文字稿字幕';
  const laneId = `lane_${crypto.randomUUID()}`;
  let built;
  try {
    built = buildPastedTranscriptTrack({
      script,
      items: s.items,
      fps: s.fps,
      track: speechTrackId,
      laneId,
      label,
    });
  } catch (cause) {
    if (cause instanceof PastedTranscriptError) {
      return { error: PASTED_TRANSCRIPT_ERRORS[cause.code] };
    }
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }

  const written = writeManualCaptionsTrack(modeInfo.mode, built.captions, label, c, ctx, s, targetTrackId);
  const reviewCues = built.alignment.reviewCueIndices.slice(0, 20).map((idx) => {
    const cue = built.alignment.cues[idx]!;
    return {
      cueId: cue.id ?? null,
      index: idx,
      text: cue.text,
      startMs: cue.start,
      endMs: cue.end,
    };
  });

  return {
    ok: true,
    ...written,
    laneId,
    mode: modeInfo.mode,
    speechTrackId,
    speechTrackAlias: trackAlias(s, speechTrackId),
    sourceItemIds: built.sourceItemIds,
    cueCount: built.alignment.cues.length,
    reviewCueCount: built.alignment.reviewCueIndices.length,
    ...(reviewCues.length ? { reviewCues } : {}),
  };
}
