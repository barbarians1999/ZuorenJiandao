import type { TranscriptWord } from '../transcript/types';
import { normalizeChineseAlignmentChar } from './t2sMap';
import { alignNormalizedSequences } from './transcriptAlignment';

export const PASTED_CAPTION_MAX_CHARS = 20;

export type PastedTranscriptErrorCode = 'empty-script' | 'missing-timing' | 'no-matchable-text';

export class PastedTranscriptError extends Error {
  readonly code: PastedTranscriptErrorCode;

  constructor(code: PastedTranscriptErrorCode) {
    super(code);
    this.code = code;
    this.name = 'PastedTranscriptError';
  }
}

export interface PastedTranscriptAlignment {
  cues: TranscriptWord[];
  quality: number;
  weak: boolean;
  sourceCharacters: number;
  scriptCharacters: number;
  /** Transient local review hints, not part of saved caption data. */
  reviewCueIndices: number[];
}

interface TimedCharacter {
  value: string;
  start: number;
  end: number;
}

const TRAILING_PUNCT = /[。！？!?；;，,、：:…—～~．｡､\s]+$/u;
const INNER_TRAILING_PUNCT = /([。！？!?；;，,、：:…—～~．｡､\s]+)(["'”’）)】》」』〉]+)$/u;

export function stripTrailingPunctuation(rawText: string): string {
  let text = rawText.trim();
  if (!text) return '';

  for (let round = 0; round < 3; round += 1) {
    if (INNER_TRAILING_PUNCT.test(text)) {
      text = text.replace(INNER_TRAILING_PUNCT, '$2');
    }
    const next = text.replace(TRAILING_PUNCT, '');
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

const ALIGNMENT_CHAR = /[0-9a-z\u3400-\u9fff\uf900-\ufaff]/u;

function normalizedCharacters(text: string): string[] {
  return Array.from(text.normalize('NFKC').toLocaleLowerCase())
    .map(normalizeChineseAlignmentChar)
    .filter((character) => ALIGNMENT_CHAR.test(character));
}

function visibleLength(text: string): number {
  return Array.from(text).filter((character) => !/\s/u.test(character)).length;
}

function isCjkChar(char: string): boolean {
  if (!char) return false;
  const c = char.charCodeAt(0);
  return (c >= 19968 && c <= 40959) || (c >= 13312 && c <= 19903)
    || (c >= 12352 && c <= 12447) || (c >= 12448 && c <= 12543)
    || (c >= 44032 && c <= 55215);
}

const NO_LINE_START = new Set(['的', '了', '着', '过', '呢', '吧', '啊', '吗', '呀', '呗', '哩', '啦', '与', '和', '及', '或']);

const PREFER_BREAK_AFTER = new Set([
  '之后', '随后', '接着', '然后', '期间', '同时', '并且', '而且', '但是', '然而', '不过',
  '因为', '所以', '因此', '如果', '假如', '虽然', '尽管', '此外', '另外', '以及',
  '的时候', '看来', '其实', '比如', '例如',
]);

const wordSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
  : null;

function segmentWords(text: string): string[] {
  if (!wordSegmenter) {
    return Array.from(text);
  }
  const result: string[] = [];
  for (const seg of wordSegmenter.segment(text)) {
    if (seg.segment) result.push(seg.segment);
  }
  return result;
}

function splitLongClauseAtWordBoundaries(clause: string, maxCharacters: number): string[] {
  const totalLen = visibleLength(clause);
  if (totalLen <= maxCharacters) return [clause];

  const words = segmentWords(clause);
  if (words.length <= 1) return [clause];

  const numChunks = Math.ceil(totalLen / maxCharacters);
  const targetPerChunk = totalLen / numChunks;

  const chunks: string[] = [];
  let currentWords: string[] = [];
  let currentLen = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const wordLen = visibleLength(word);
    const wouldLen = currentLen + wordLen;
    const remainingWords = words.slice(i);
    const remainingLen = remainingWords.reduce((s, w) => s + visibleLength(w), 0);

    let shouldCut = false;
    if (currentLen > 0) {
      if (wouldLen > maxCharacters) {
        shouldCut = true;
      } else if (currentLen >= 4 && remainingLen >= 4 && currentLen >= targetPerChunk - 1) {
        const nextFirstChar = Array.from(word.trimStart())[0] ?? '';
        if (!NO_LINE_START.has(nextFirstChar)) {
          const curTrimmed = currentWords.join('').trimEnd();
          const matchesPrefer = Array.from(PREFER_BREAK_AFTER).some((p) => curTrimmed.endsWith(p));
          if (matchesPrefer || wouldLen >= maxCharacters - 2 || currentLen >= targetPerChunk) {
            shouldCut = true;
          }
        }
      }
    }

    if (shouldCut && currentWords.length > 0) {
      const nextFirst = Array.from(word.trimStart())[0] ?? '';
      if (NO_LINE_START.has(nextFirst) && wouldLen <= maxCharacters + 1) {
        currentWords.push(word);
        currentLen += wordLen;
        chunks.push(currentWords.join(''));
        currentWords = [];
        currentLen = 0;
        continue;
      }

      chunks.push(currentWords.join(''));
      currentWords = [word];
      currentLen = wordLen;
    } else {
      currentWords.push(word);
      currentLen += wordLen;
    }
  }

  if (currentWords.length > 0) {
    const lastChunk = currentWords.join('');
    if (chunks.length > 0 && visibleLength(lastChunk) < 4
        && visibleLength(chunks[chunks.length - 1]!) + visibleLength(lastChunk) <= maxCharacters) {
      chunks[chunks.length - 1] = chunks[chunks.length - 1] + lastChunk;
    } else {
      chunks.push(lastChunk);
    }
  }

  return chunks;
}

function splitIntoClauses(rawText: string): string[] {
  const clauses: string[] = [];
  const chars = Array.from(rawText);
  let current = '';

  const isProtectedDot = (idx: number): boolean => {
    const prev = chars[idx - 1];
    const next = chars[idx + 1];
    if (!prev || !next) return false;
    return (/[0-9a-zA-Z]/u.test(prev) && /[0-9a-zA-Z]/u.test(next));
  };

  const isProtectedColon = (idx: number): boolean => {
    const prev = chars[idx - 1];
    const next = chars[idx + 1];
    if (!prev || !next) return false;
    return (/[0-9]/u.test(prev) && /[0-9]/u.test(next));
  };

  let inQuotes = false;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    current += ch;

    if (ch === '“' || ch === '《' || ch === '「' || ch === '『') {
      inQuotes = true;
    } else if (ch === '”' || ch === '》' || ch === '」' || ch === '』') {
      inQuotes = false;
    }

    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '；' || ch === ';') {
      while (i + 1 < chars.length && /["'”’）)】》」』〉]/u.test(chars[i + 1]!)) {
        i += 1;
        current += chars[i]!;
      }
      clauses.push(current);
      current = '';
      continue;
    }

    if (ch === '.' && !isProtectedDot(i)) {
      while (i + 1 < chars.length && /["'”’）)】》」』〉]/u.test(chars[i + 1]!)) {
        i += 1;
        current += chars[i]!;
      }
      clauses.push(current);
      current = '';
      continue;
    }

    if (ch === '，' || ch === ',' || ((ch === '：' || ch === ':') && !isProtectedColon(i))) {
      if (inQuotes) continue;
      while (i + 1 < chars.length && /["'”’）)】》」』〉]/u.test(chars[i + 1]!)) {
        i += 1;
        current += chars[i]!;
      }
      clauses.push(current);
      current = '';
      continue;
    }

    if (/\s/u.test(ch) && i > 0 && i < chars.length - 1) {
      const prev = chars[i - 1]!;
      const next = chars[i + 1]!;
      if (isCjkChar(prev) && isCjkChar(next)) {
        clauses.push(current);
        current = '';
        continue;
      }
    }
  }

  if (current.trim()) {
    clauses.push(current);
  }

  return clauses;
}

const INTRO_PUNCT = /[，,：:、]\s*$/u;

function mergeShortIntroClauses(clauses: string[], maxCharacters: number): string[] {
  const merged: string[] = [];
  let i = 0;
  while (i < clauses.length) {
    const cur = clauses[i]!;
    const curClean = stripTrailingPunctuation(cur);
    const curLen = visibleLength(curClean);

    // Only merge short introductory clauses that end with weak pause punctuation (commas, colons, pauses)
    if (curLen >= 1 && curLen <= 3 && INTRO_PUNCT.test(cur.trim()) && i + 1 < clauses.length) {
      const next = clauses[i + 1]!;
      const nextClean = stripTrailingPunctuation(next);
      const combinedLen = curLen + visibleLength(nextClean);
      if (combinedLen <= Math.min(18, maxCharacters)) {
        merged.push(cur + next);
        i += 2;
        continue;
      }
    }
    merged.push(cur);
    i += 1;
  }
  return merged;
}

/** Newlines, clauses, and natural pause punctuation are authorial boundaries; trailing pause marks are stripped. */
export function splitPastedTranscript(
  source: string,
  maxCharacters = PASTED_CAPTION_MAX_CHARS,
): string[] {
  if (!Number.isFinite(maxCharacters) || maxCharacters < 1) return [];
  const normalizedSource = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalizedSource.trim()) return [];

  const result: string[] = [];

  for (const rawLine of normalizedSource.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const initialClauses = splitIntoClauses(line);
    const mergedClauses = mergeShortIntroClauses(initialClauses, maxCharacters);

    for (const clause of mergedClauses) {
      const cleanClause = clause.trim();
      if (!cleanClause) continue;

      if (visibleLength(cleanClause) <= maxCharacters) {
        const stripped = stripTrailingPunctuation(cleanClause);
        if (stripped) result.push(stripped);
      } else {
        const subChunks = splitLongClauseAtWordBoundaries(cleanClause, maxCharacters);
        for (const sub of subChunks) {
          const stripped = stripTrailingPunctuation(sub);
          if (stripped) result.push(stripped);
        }
      }
    }
  }

  return result.filter(Boolean);
}

function timedCharacters(words: readonly TranscriptWord[]): TimedCharacter[] {
  const characters: TimedCharacter[] = [];
  for (const word of words) {
    const normalized = normalizedCharacters(word.text);
    if (!normalized.length || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) continue;
    const duration = word.end - word.start;
    normalized.forEach((value, index) => {
      characters.push({
        value,
        start: word.start + duration * index / normalized.length,
        end: word.start + duration * (index + 1) / normalized.length,
      });
    });
  }
  return characters;
}

function editDistance(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function proportionalCues(texts: readonly string[], source: readonly TimedCharacter[]): TranscriptWord[] {
  const weights = texts.map((text) => Math.max(1, normalizedCharacters(text).length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const first = source[0]!;
  const last = source[source.length - 1]!;
  const duration = Math.max(texts.length, last.end - first.start);
  let accumulated = 0;
  return texts.map((text, index) => {
    const start = first.start + duration * accumulated / total;
    accumulated += weights[index]!;
    const end = first.start + duration * accumulated / total;
    return { text, start: Math.round(start), end: Math.max(Math.round(start) + 1, Math.round(end)) };
  });
}

interface CuePlacement {
  anchored: boolean;
  sFirst: number;
  sLast: number;
  rawStart: number;
  rawEnd: number;
  gapSourceStart: number;
  gapSourceEnd: number;
  singleGapCue: boolean;
}

function resolveUnanchoredRuns(
  placements: CuePlacement[],
  targets: readonly (readonly string[])[],
  source: readonly TimedCharacter[],
): void {
  const firstSourceStart = source[0]!.start;
  const lastSourceEnd = source[source.length - 1]!.end;
  let index = 0;
  while (index < placements.length) {
    if (placements[index]!.anchored) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < placements.length && !placements[index]!.anchored) index += 1;
    const runEnd = index - 1;

    const prev = runStart > 0 ? placements[runStart - 1]! : undefined;
    const next = runEnd + 1 < placements.length ? placements[runEnd + 1]! : undefined;
    const sLeft = prev ? prev.sLast + 1 : 0;
    const sRight = next ? next.sFirst : source.length;
    const minMs = prev ? prev.rawEnd : firstSourceStart;
    const maxMs = next ? next.rawStart : lastSourceEnd;

    const count = runEnd - runStart + 1;
    const gapStartMs = sLeft < sRight ? Math.max(minMs, source[sLeft]!.start) : minMs;
    const rawGapEndMs = sLeft < sRight ? Math.min(maxMs, source[sRight - 1]!.end) : maxMs;
    const gapEndMs = Math.max(gapStartMs + count, rawGapEndMs);
    const totalDuration = gapEndMs - gapStartMs;

    let totalWeight = 0;
    for (let cueIdx = runStart; cueIdx <= runEnd; cueIdx += 1) {
      totalWeight += Math.max(1, targets[cueIdx]!.length);
    }

    let accumulated = 0;
    for (let cueIdx = runStart; cueIdx <= runEnd; cueIdx += 1) {
      const weight = Math.max(1, targets[cueIdx]!.length);
      const start = gapStartMs + (totalDuration * accumulated) / totalWeight;
      accumulated += weight;
      const end = gapStartMs + (totalDuration * accumulated) / totalWeight;
      const item = placements[cueIdx]!;
      item.rawStart = start;
      item.rawEnd = end;
      item.gapSourceStart = sLeft;
      item.gapSourceEnd = sRight;
      item.singleGapCue = count === 1;
    }
  }
}

/**
 * Globally align corrected copy to projected ASR timings using unique-anchor
 * discovery + affine-gap DP, so localized script differences cannot push
 * subsequent cues onto proportional character-count estimates.
 */
export function alignPastedTranscript(
  script: string,
  projectedWords: readonly TranscriptWord[],
  maxCharacters = PASTED_CAPTION_MAX_CHARS,
): PastedTranscriptAlignment {
  const normalizedScript = script.replace(/^\uFEFF/, '').trim();
  if (!normalizedScript) throw new PastedTranscriptError('empty-script');
  const texts = splitPastedTranscript(script, maxCharacters);
  if (!texts.length) throw new PastedTranscriptError('no-matchable-text');
  const source = timedCharacters(projectedWords);
  if (!source.length) throw new PastedTranscriptError('missing-timing');
  const targets = texts.map(normalizedCharacters);
  const scriptCharacters = targets.reduce((sum, target) => sum + target.length, 0);
  if (!scriptCharacters) throw new PastedTranscriptError('no-matchable-text');

  if (source.length < texts.length) {
    return {
      cues: proportionalCues(texts, source), quality: 0, weak: true,
      sourceCharacters: source.length, scriptCharacters,
      reviewCueIndices: texts.map((_, index) => index),
    };
  }

  const targetChars: string[] = [];
  const cueRanges: Array<{ start: number; end: number }> = [];
  for (const target of targets) {
    const start = targetChars.length;
    for (const char of target) targetChars.push(char);
    cueRanges.push({ start, end: targetChars.length });
  }

  const sourceValues = source.map((character) => character.value);
  const targetToSource = alignNormalizedSequences(targetChars, sourceValues);

  const placements: CuePlacement[] = targets.map((target, cueIndex) => {
    const range = cueRanges[cueIndex]!;
    let sFirst = -1;
    let sLast = -1;
    let alignedCount = 0;
    let exactCount = 0;
    for (let t = range.start; t < range.end; t += 1) {
      const s = targetToSource[t]!;
      if (s < 0) continue;
      if (sFirst < 0) sFirst = s;
      sLast = s;
      alignedCount += 1;
      if (targetChars[t] === sourceValues[s]) exactCount += 1;
    }

    const span = sFirst >= 0 ? sLast - sFirst + 1 : 0;
    const maxReasonableSpan = Math.max(target.length * 4 + 16, 48);
    const anchored = alignedCount > 0
      && (exactCount >= 1 || alignedCount >= Math.ceil(target.length * 0.5))
      && span <= maxReasonableSpan;

    return {
      anchored,
      sFirst,
      sLast,
      rawStart: anchored ? source[sFirst]!.start : 0,
      rawEnd: anchored ? source[sLast]!.end : 0,
      gapSourceStart: 0,
      gapSourceEnd: 0,
      singleGapCue: false,
    };
  });

  resolveUnanchoredRuns(placements, targets, source);

  const cues: TranscriptWord[] = [];
  let weightedQuality = 0;
  let previousEnd = source[0]!.start;
  const reviewCueIndices: number[] = [];

  texts.forEach((text, cueIndex) => {
    const target = targets[cueIndex]!;
    const placement = placements[cueIndex]!;
    const start = Math.round(Math.max(previousEnd, placement.rawStart));
    const end = Math.max(start + 1, Math.round(placement.rawEnd));
    cues.push({ text, start, end });
    previousEnd = end;

    let quality = 0;
    if (placement.anchored) {
      const candidateText = sourceValues.slice(placement.sFirst, placement.sLast + 1);
      const dist = editDistance(target, candidateText);
      quality = Math.max(0, 1 - dist / Math.max(1, target.length, candidateText.length));
    } else if (
      placement.singleGapCue
      && placement.gapSourceStart < placement.gapSourceEnd
      && placement.gapSourceEnd - placement.gapSourceStart <= Math.max(target.length * 4, 32)
    ) {
      const candidateText = sourceValues.slice(placement.gapSourceStart, placement.gapSourceEnd);
      const dist = editDistance(target, candidateText);
      quality = Math.max(0, 1 - dist / Math.max(1, target.length, candidateText.length));
    }

    weightedQuality += quality * Math.max(1, target.length);
    if (quality < 0.55) reviewCueIndices.push(cueIndex);
  });

  const quality = weightedQuality / scriptCharacters;
  const lengthRatio = scriptCharacters / source.length;
  return {
    cues,
    quality,
    weak: quality < 0.55 || lengthRatio < 0.55 || lengthRatio > 1.8,
    sourceCharacters: source.length,
    scriptCharacters,
    reviewCueIndices: lengthRatio < 0.55 || lengthRatio > 1.8 ? texts.map((_, index) => index) : reviewCueIndices,
  };
}
