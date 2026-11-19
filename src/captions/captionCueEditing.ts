import { newManualCueIdentity } from '../transcript/identity';
import type { TranscriptWord } from '../transcript/types';
import { captionWordOverride } from './wordOverrides';
import { normalizeCaptionSourceEntries } from './sourceOrder';
import { joinCaptionWords, type CaptionDisplayCueEdit, type CaptionDisplayCuePart, type CaptionSourceSpan, type CaptionsData } from './types';
import { resolveEntryProjection } from './resolve';
import { projectCaptionSourceSpans } from './captionSourceSpans';
import { captionFontKey } from '../fonts/captionFontScope';
import type { CueRow } from './captionCues';
import type { TimelineItem } from '../editor/types';

export type CaptionCueEditAction = 'save' | 'split' | 'mergePrevious' | 'mergeNext';
export interface CaptionCueEditRequest {
  captions: CaptionsData;
  items: TimelineItem[];
  fps: number;
  rows: CueRow[];
  rowIndex: number;
  action: CaptionCueEditAction;
  text: string;
  caret?: number;
  manualTiming?: { startMs: number; endMs: number };
  acceptMergeConflict?: boolean;
}
export interface CaptionCueEditResult {
  patch: Partial<CaptionsData> | null;
  reason?: string;
  confirm?: string;
  focus?: { manualCueId?: string; displayPartId?: string; caret: number };
}

const fail = (reason: string): CaptionCueEditResult => ({ patch: null, reason });
const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];
const graphemeCount = (text: string) => typeof Intl.Segmenter === 'function'
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length
  : Array.from(text).length;
const mergeText = (left: string, right: string) => /\s$/.test(left) || /^\s/.test(right)
  ? left + right : joinCaptionWords([{ text: left }, { text: right }]);

function splitText(text: string, caret: number): { left: string; right: string; ratio: number } | null {
  const at = Math.max(0, Math.min(text.length, Math.floor(caret)));
  const left = text.slice(0, at);
  const right = text.slice(at);
  const leftCount = graphemeCount(left.trim()), rightCount = graphemeCount(right.trim());
  if (!leftCount || !rightCount) return null;
  return { left, right, ratio: leftCount / (leftCount + rightCount) };
}

function sourceEntryFor(row: CueRow, captions: CaptionsData) {
  return row.entry && !row.manual
    ? captions.sourceEntries?.find((entry) => entry.id === row.entry!.id && !entry.words)
    : undefined;
}

function sourceSpansForRefs(
  captions: CaptionsData,
  entry: NonNullable<CueRow['entry']>,
  items: TimelineItem[],
  fps: number,
  refs: readonly string[],
): CaptionSourceSpan[] {
  const item = items.find((candidate) => candidate.id === entry.itemId);
  const transcript = item?.transcript;
  if (!item || !transcript?.length) return [];
  const projection = resolveEntryProjection(entry, items, fps);
  return refs.flatMap((wordRef) => {
    const position = projection.wordRefs.indexOf(wordRef);
    if (position < 0) return [];
    const sourceIndex = projection.indices[position]!;
    const source = transcript[sourceIndex];
    if (!source) return [];
    const override = captionWordOverride(captions.wordOverrides, sourceIndex, wordRef);
    return [{ wordRef, startMs: source.start, endMs: source.end,
      sourceText: projection.words[position]?.text ?? source.text,
      ...(override?.timingOffsetMs !== undefined ? { timingOffsetMs: override.timingOffsetMs } : {}) }];
  });
}

function sourceDisplayForRow(
  captions: CaptionsData, row: CueRow, text: string, items: TimelineItem[], fps: number,
): { entry: NonNullable<CueRow['entry']>; editId: string; part: CaptionDisplayCuePart; existing: boolean } | null {
  const entry = sourceEntryFor(row, captions);
  if (!entry) return null;
  const record = row.displayCueEditId ? entry.displayCueEdits?.find((edit) => edit.id === row.displayCueEditId) : undefined;
  const part = record?.parts.find((candidate) => candidate.id === row.displayCuePartId);
  if (record && part) return { entry, editId: record.id, part: { ...part, text }, existing: true };

  let refs = [...row.wordRefs];
  // Older cueTextPatch stored one sentence on its first word and hid the rest.
  if (refs.length === 1) {
    const projection = resolveEntryProjection(entry, items, fps);
    const first = projection.wordRefs.indexOf(refs[0]!);
    const override = first >= 0 ? captionWordOverride(captions.wordOverrides, projection.indices[first]!, refs[0]!) : undefined;
    if (first >= 0 && override?.text && override.forceBreak) {
      for (let index = first + 1; index < projection.wordRefs.length; index += 1) {
        const ref = projection.wordRefs[index]!;
        const next = captionWordOverride(captions.wordOverrides, projection.indices[index]!, ref);
        if (next?.forceBreak || !next?.hidden) break;
        refs.push(ref);
      }
    }
  }
  const sourceSpans = sourceSpansForRefs(captions, entry, items, fps, refs);
  if (!refs.length || sourceSpans.length !== refs.length) return null;
  return { entry, editId: newManualCueIdentity(), part: { id: newManualCueIdentity(), text, sourceSpans }, existing: false };
}

function setSourceEdit(captions: CaptionsData, entryId: string, edit: CaptionDisplayCueEdit): Partial<CaptionsData> {
  return { sourceEntries: (captions.sourceEntries ?? []).map((entry) => entry.id === entryId
    ? { ...entry, displayCueEdits: [...(entry.displayCueEdits ?? []).filter((candidate) => candidate.id !== edit.id), edit] }
    : entry) };
}

function splitSourceSpans(
  spans: CaptionSourceSpan[], text: string, caret: number, ratio: number, row: CueRow, item: TimelineItem, fps: number,
): [CaptionSourceSpan[], CaptionSourceSpan[]] {
  const sourceText = joinCaptionWords(spans.map((span) => ({ text: span.sourceText })));
  if (sourceText === text && spans.length > 1) {
    for (let index = 1; index < spans.length; index += 1) {
      const boundary = joinCaptionWords(spans.slice(0, index).map((span) => ({ text: span.sourceText }))).length;
      const nextStart = joinCaptionWords(spans.slice(0, index + 1).map((span) => ({ text: span.sourceText }))).length - spans[index]!.sourceText.length;
      if (caret === boundary || caret === nextStart) return [spans.slice(0, index), spans.slice(index)];
    }
  }
  const outputSplitFrame = (row.start + (row.end - row.start) * ratio) * fps / 1000;
  const projected = projectCaptionSourceSpans(item, spans, fps);
  const inside = projected.find((entry) => outputSplitFrame > entry.startFrame && outputSplitFrame < entry.endFrame);
  if (inside) {
    const index = inside.spanIndex;
    const span = spans[index]!;
    const rate = item.kind === 'audio' ? 1 : Math.max(0.01, item.playbackRate ?? 1);
    const sourceFrame = inside.sourceStartFrame + (outputSplitFrame - inside.startFrame) * rate;
    const cutMs = sourceFrame * 1000 / fps;
    const left = [...spans.slice(0, index), { ...span, endMs: cutMs }];
    const right = [{ ...span, startMs: cutMs }, ...spans.slice(index + 1)];
    return [left, right];
  }
  const next = projected.find((entry) => entry.startFrame >= outputSplitFrame);
  if (next) return [spans.slice(0, next.spanIndex), spans.slice(next.spanIndex)];
  if (spans.length <= 1) {
    const span = spans[0];
    if (!span) return [[], []];
    const at = span.startMs + (span.endMs - span.startMs) * ratio;
    return [[{ ...span, endMs: at }], [{ ...span, startMs: at }]];
  }
  // A split in an unvoiced gap falls between source spans; retain every span on one side.
  const total = spans.reduce((sum, span) => sum + Math.max(1, span.endMs - span.startMs), 0);
  const wanted = total * ratio;
  let used = 0;
  for (let index = 0; index < spans.length; index += 1) {
    used += Math.max(1, spans[index]!.endMs - spans[index]!.startMs);
    if (used >= wanted && index + 1 < spans.length) return [spans.slice(0, index + 1), spans.slice(index + 1)];
  }
  return [spans.slice(0, -1), spans.slice(-1)];
}

function spanDurationMs(spans: readonly CaptionSourceSpan[], item: TimelineItem): number {
  const rate = item.kind === 'audio' ? 1 : Math.max(0.01, item.playbackRate ?? 1);
  return spans.reduce((sum, span) => sum + Math.max(0, span.endMs - span.startMs) / rate, 0);
}

function planSourceSplit(
  captions: CaptionsData, row: CueRow, text: string, caret: number, items: TimelineItem[], fps: number,
): CaptionCueEditResult {
  const split = splitText(text, caret);
  if (!split) return fail('光标两侧都需要有字幕文字。');
  const data = sourceDisplayForRow(captions, row, text, items, fps);
  if (!data) return fail('无法确定这句字幕对应的源词，未更改。');
  const item = items.find((candidate) => candidate.id === data.entry.itemId);
  if (!item) return fail('字幕源素材不可用，未更改。');
  if (new Set(projectCaptionSourceSpans(item, data.part.sourceSpans, fps).map((span) => span.segmentKey)).size > 1)
    return fail('这句字幕跨越多个源素材片段，请先调整时间线后再拆分。');
  const [leftSpans, rightSpans] = splitSourceSpans(data.part.sourceSpans, text, caret, split.ratio, row, item, fps);
  const minFrameMs = 1000 / fps;
  if (!leftSpans.length || !rightSpans.length || spanDurationMs(leftSpans, item) < minFrameMs
    || spanDurationMs(rightSpans, item) < minFrameMs) return fail('源词时间不足以拆成两句，未更改。');
  const leftProjection = projectCaptionSourceSpans(item, leftSpans, fps);
  const rightProjection = projectCaptionSourceSpans(item, rightSpans, fps);
  if (!leftProjection.length || !rightProjection.length
    || Math.max(...leftProjection.map((span) => span.endFrame)) > Math.min(...rightProjection.map((span) => span.startFrame)))
    return fail('源词时间有重叠，无法安全拆分；文字已保留，请调整时间或更换拆分位置。');
  if (data.existing && row.displayCueEditId && row.displayCuePartId) {
    const current = data.entry.displayCueEdits!.find((edit) => edit.id === data.editId)!;
    const rightId = newManualCueIdentity();
    const parts = current.parts.flatMap((part) => part.id === row.displayCuePartId
      ? [{ ...part, text: split.left, sourceSpans: leftSpans }, { id: rightId, text: split.right, sourceSpans: rightSpans }]
      : [part]);
    const font = captions.cueFonts?.[cueFontKey(data.part.id)] ?? row.fontOverride;
    const fonts = font ? new Map([[cueFontKey(rightId), font]]) : new Map();
    return { patch: { ...setSourceEdit(captions, data.entry.id, { ...current, parts }), ...cueFontEdits(captions, fonts) }, focus: { displayPartId: rightId, caret: 0 } };
  }
  const rightId = newManualCueIdentity();
  const edit: CaptionDisplayCueEdit = { id: data.editId, coveredWordRefs: unique(data.part.sourceSpans.map((span) => span.wordRef)),
    parts: [{ ...data.part, text: split.left, sourceSpans: leftSpans },
      { id: rightId, text: split.right, sourceSpans: rightSpans }] };
  const font = row.fontOverride;
  const fonts = font ? new Map([[cueFontKey(data.part.id), font], [cueFontKey(rightId), font]]) : new Map();
  return { patch: { ...setSourceEdit(captions, data.entry.id, edit), ...cueFontEdits(captions, fonts) }, focus: { displayPartId: rightId, caret: 0 } };
}

function planSourceSave(captions: CaptionsData, row: CueRow, text: string, items: TimelineItem[], fps: number): CaptionCueEditResult {
  const data = sourceDisplayForRow(captions, row, text, items, fps);
  if (!data) return fail('无法确定这句字幕对应的源词，未更改。');
  if (data.existing && row.displayCueEditId && row.displayCuePartId) {
    const current = data.entry.displayCueEdits!.find((edit) => edit.id === data.editId)!;
    const parts = text.trim()
      ? current.parts.map((part) => part.id === row.displayCuePartId ? { ...part, text } : part)
      : current.parts.filter((part) => part.id !== row.displayCuePartId);
    return { patch: setSourceEdit(captions, data.entry.id, { ...current, parts }) };
  }
  const edit: CaptionDisplayCueEdit = { id: data.editId, coveredWordRefs: unique(data.part.sourceSpans.map((span) => span.wordRef)),
    parts: text.trim() ? [{ ...data.part, text }] : [] };
  return { patch: setSourceEdit(captions, data.entry.id, edit) };
}

function updateManualWords(captions: CaptionsData, laneId: string, words: TranscriptWord[]): Partial<CaptionsData> {
  return { sourceEntries: normalizeCaptionSourceEntries((captions.sourceEntries ?? []).map((entry) => entry.id === laneId ? { ...entry, words } : entry)),
    sources: undefined, sourceMode: 'item', words: undefined };
}

function cueFontEdits(
  captions: CaptionsData,
  set: ReadonlyMap<string, NonNullable<CaptionsData['cueFonts']>[string]>,
  remove: readonly string[] = [],
): Partial<CaptionsData> {
  const cueFonts = { ...captions.cueFonts };
  for (const key of remove) delete cueFonts[key];
  for (const [key, font] of set) cueFonts[key] = font;
  return Object.keys(cueFonts).length ? { cueFonts } : { cueFonts: undefined };
}

const cueFontKey = (id: string) => captionFontKey(id, undefined)!;

function planManualEdit(request: CaptionCueEditRequest, row: CueRow): CaptionCueEditResult {
  const entry = row.entry;
  const index = row.manualIndex;
  const original = entry?.words?.[index ?? -1];
  if (!entry || !original || index == null) return fail('这句手动字幕已变化，未更改。');
  const words = [...entry.words!];
  const startMs = request.manualTiming?.startMs ?? original.start;
  const endMs = request.manualTiming?.endMs ?? original.end;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) return fail('开始时间不能为负数，结束时间必须晚于开始时间。');
  const current = { ...original, text: request.text, start: startMs, end: endMs };
  if (request.action === 'save') {
    if (!current.text.trim()) return fail('字幕内容不能为空，未修改。');
    words[index] = current;
    return { patch: updateManualWords(request.captions, entry.id, words) };
  }
  if (request.action === 'split') {
    const split = splitText(request.text, request.caret ?? 0);
    if (!split) return fail('光标两侧都需要有字幕文字。');
    const minFrameMs = 1000 / request.fps;
    if (endMs - startMs < 2 * minFrameMs) return fail('字幕时长不足一帧拆分，未更改。');
    const cut = Math.max(startMs + minFrameMs, Math.min(endMs - minFrameMs, startMs + (endMs - startMs) * split.ratio));
    const newId = newManualCueIdentity();
    words.splice(index, 1, { ...current, text: split.left, end: cut },
      { id: newId, text: split.right, start: cut, end: current.end });
    const originalFontKey = original.id ? cueFontKey(original.id) : undefined;
    const font = originalFontKey ? request.captions.cueFonts?.[originalFontKey] : undefined;
    const fonts = font ? new Map([[cueFontKey(newId), font]]) : new Map();
    return { patch: { ...updateManualWords(request.captions, entry.id, words), ...cueFontEdits(request.captions, fonts) }, focus: { manualCueId: newId, caret: 0 } };
  }
  const neighbor = request.rows[request.rowIndex + (request.action === 'mergePrevious' ? -1 : 1)];
  if (!neighbor || !neighbor.manual || neighbor.laneId !== row.laneId) return fail('没有可合并的同车道相邻字幕。');
  const neighborIndex = neighbor.manualIndex;
  const adjacent = entry.words?.[neighborIndex ?? -1];
  if (!adjacent || neighborIndex == null || neighborIndex === index) return fail('相邻字幕已变化，未更改。');
  const leftIndex = request.action === 'mergePrevious' ? neighborIndex : index;
  const rightIndex = request.action === 'mergePrevious' ? index : neighborIndex;
  const left = leftIndex === index ? current : entry.words![leftIndex]!;
  const right = rightIndex === index ? current : entry.words![rightIndex]!;
  const merged: TranscriptWord = { ...left, text: mergeText(left.text, right.text),
    start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) };
  const next = words.filter((_, position) => position !== rightIndex);
  const target = next.findIndex((word) => word.id === left.id);
  if (target < 0) return fail('相邻字幕已变化，未更改。');
  next[target] = merged;
  return { patch: { ...updateManualWords(request.captions, entry.id, next),
    ...cueFontEdits(request.captions, new Map(), right.id ? [cueFontKey(right.id)] : []) }, focus: { manualCueId: left.id, caret: merged.text.length - right.text.length } };
}

function planSourceMerge(request: CaptionCueEditRequest, row: CueRow, neighbor: CueRow): CaptionCueEditResult {
  if (neighbor.manual || row.laneId !== neighbor.laneId || neighbor.entry?.id !== row.entry?.id) return fail('合并只能在同一字幕来源内进行。');
  const current = sourceDisplayForRow(request.captions, row, request.text, request.items, request.fps);
  const adjacent = sourceDisplayForRow(request.captions, neighbor, neighbor.text, request.items, request.fps);
  if (!current || !adjacent) return fail('无法确定相邻字幕的源词，未更改。');
  if (current.entry.id !== adjacent.entry.id || current.part.id === adjacent.part.id) return fail('相邻字幕来源不连续，未更改。');
  const left = request.action === 'mergePrevious' ? adjacent.part : current.part;
  const right = request.action === 'mergePrevious' ? current.part : adjacent.part;
  const leftRow = request.action === 'mergePrevious' ? neighbor : row;
  const item = request.items.find((candidate) => candidate.id === current.entry.itemId);
  if (!item || new Set(projectCaptionSourceSpans(item, [...left.sourceSpans, ...right.sourceSpans], request.fps).map((span) => span.segmentKey)).size > 1)
    return fail('相邻字幕跨越多个源素材片段，请先调整时间线后再合并。');
  const mergedPart: CaptionDisplayCuePart = { id: left.id,
    text: mergeText(left.text, right.text),
    sourceSpans: [...left.sourceSpans, ...right.sourceSpans] };
  const removed = [
    ...(current.existing && row.displayCuePartId ? [{ editId: current.editId, partId: row.displayCuePartId }] : []),
    ...(adjacent.existing && neighbor.displayCuePartId ? [{ editId: adjacent.editId, partId: neighbor.displayCuePartId }] : []),
  ];
  const newEdit: CaptionDisplayCueEdit = { id: newManualCueIdentity(),
    coveredWordRefs: unique(mergedPart.sourceSpans.map((span) => span.wordRef)), parts: [mergedPart] };
  const sourceEntries = (request.captions.sourceEntries ?? []).map((entry) => {
    if (entry.id !== current.entry.id) return entry;
    const next: CaptionDisplayCueEdit[] = [];
    for (const edit of entry.displayCueEdits ?? []) {
      const remaining = edit.parts.filter((part) => !removed.some((item) => item.editId === edit.id && item.partId === part.id));
      if (remaining.length === edit.parts.length) next.push(edit);
      else if (remaining.length) next.push({ ...edit, parts: remaining,
        coveredWordRefs: unique(remaining.flatMap((part) => part.sourceSpans.map((span) => span.wordRef))) });
    }
    next.push(newEdit);
    return { ...entry, displayCueEdits: next };
  });
  const leftFont = request.captions.cueFonts?.[cueFontKey(left.id)] ?? leftRow.fontOverride;
  const removedFontKeys = right.id === left.id ? [] : [cueFontKey(right.id)];
  const fonts = leftFont ? new Map([[cueFontKey(left.id), leftFont]]) : new Map();
  return { patch: { sourceEntries, ...cueFontEdits(request.captions, fonts, removedFontKeys) }, focus: { displayPartId: left.id, caret: mergedPart.text.length - right.text.length } };
}

export function planCaptionCueEdit(request: CaptionCueEditRequest): CaptionCueEditResult {
  const row = request.rows[request.rowIndex];
  if (!row) return fail('找不到这句字幕，未更改。');
  if (request.action === 'mergePrevious' || request.action === 'mergeNext') {
    const neighbor = request.rows[request.rowIndex + (request.action === 'mergePrevious' ? -1 : 1)];
    if (!neighbor || neighbor.laneId !== row.laneId || neighbor.manual !== row.manual || neighbor.entry?.id !== row.entry?.id)
      return fail('只能合并同一来源的相邻字幕。');
    if (row.manual && (row.manualIndex == null || neighbor.manualIndex == null || Math.abs(row.manualIndex - neighbor.manualIndex) !== 1))
      return fail('两句之间还有其他字幕，无法合并。');
    const timedRow = row.manual && request.manualTiming ? { ...row, start: request.manualTiming.startMs, end: request.manualTiming.endMs } : row;
    const left = request.action === 'mergePrevious' ? neighbor : timedRow;
    const right = request.action === 'mergePrevious' ? timedRow : neighbor;
    if (left.start > right.start || request.rows.some((other) => other !== row && other !== neighbor
      && other.start < Math.max(left.end, right.end) && other.end > Math.min(left.start, right.start)))
      return fail('合并范围与其他字幕相交，请先调整时间或轨道。');
  }
  if (row.manual) return planManualEdit(request, row);
  if (request.action === 'save') return planSourceSave(request.captions, row, request.text, request.items, request.fps);
  if (request.action === 'split') return planSourceSplit(request.captions, row, request.text, request.caret ?? 0, request.items, request.fps);
  const neighbor = request.rows[request.rowIndex + (request.action === 'mergePrevious' ? -1 : 1)];
  if (!neighbor) return fail('没有可合并的相邻字幕。');
  return planSourceMerge(request, row, neighbor);
}
