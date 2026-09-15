import type { TranscriptWord } from '../transcript/types';

export const PASTED_CAPTION_MAX_CHARS = 20;

export interface PastedTranscriptAlignment {
  cues: TranscriptWord[];
  quality: number;
  weak: boolean;
  sourceCharacters: number;
  scriptCharacters: number;
}

interface TimedCharacter {
  value: string;
  start: number;
  end: number;
}

const SENTENCE_END = /[。！？!?；;]/u;
const SOFT_BREAK = /[，,、：:\s]/u;
const ALIGNMENT_CHAR = /[0-9a-z\u3400-\u9fff\uf900-\ufaff]/u;

function normalizedCharacters(text: string): string[] {
  return Array.from(text.normalize('NFKC').toLocaleLowerCase()).filter((character) => ALIGNMENT_CHAR.test(character));
}

function visibleLength(text: string): number {
  return Array.from(text).filter((character) => !/\s/u.test(character)).length;
}

function hardLimitIndex(characters: string[], maxCharacters: number): number {
  let visible = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (!/\s/u.test(characters[index]!)) visible += 1;
    if (visible >= maxCharacters) return index + 1;
  }
  return characters.length;
}

function splitLongLine(line: string, maxCharacters: number): string[] {
  const chunks: string[] = [];
  let rest = line.trim().replace(/[ \t]+/g, ' ');
  while (visibleLength(rest) > maxCharacters) {
    const characters = Array.from(rest);
    const hard = hardLimitIndex(characters, maxCharacters);
    const minimum = Math.max(1, Math.floor(hard * 0.55));
    let cut = hard;
    for (let index = hard - 1; index >= minimum; index -= 1) {
      if (SOFT_BREAK.test(characters[index]!)) {
        cut = index + 1;
        break;
      }
    }
    const chunk = characters.slice(0, cut).join('').trim();
    if (chunk) chunks.push(chunk);
    rest = characters.slice(cut).join('').trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Newlines and sentence punctuation are hard authorial boundaries. */
export function splitPastedTranscript(
  source: string,
  maxCharacters = PASTED_CAPTION_MAX_CHARS,
): string[] {
  if (!Number.isFinite(maxCharacters) || maxCharacters < 1) return [];
  const chunks: string[] = [];
  for (const rawLine of source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let sentence = '';
    for (const character of Array.from(line)) {
      sentence += character;
      if (!SENTENCE_END.test(character)) continue;
      chunks.push(...splitLongLine(sentence, Math.floor(maxCharacters)));
      sentence = '';
    }
    if (sentence.trim()) chunks.push(...splitLongLine(sentence, Math.floor(maxCharacters)));
  }
  return chunks.filter(Boolean);
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

/**
 * Locally align corrected copy to projected ASR timings. Each search is bounded
 * around the proportional boundary, so a 40-minute transcript cannot trigger
 * an unbounded full-document edit-distance matrix.
 */
export function alignPastedTranscript(
  script: string,
  projectedWords: readonly TranscriptWord[],
  maxCharacters = PASTED_CAPTION_MAX_CHARS,
): PastedTranscriptAlignment {
  const texts = splitPastedTranscript(script, maxCharacters);
  if (!texts.length) throw new Error('请先粘贴文字稿。');
  const source = timedCharacters(projectedWords);
  if (!source.length) throw new Error('当前轨道没有可用的转写时间，请先进行本机转写。');
  const targets = texts.map(normalizedCharacters);
  const scriptCharacters = targets.reduce((sum, target) => sum + target.length, 0);
  if (!scriptCharacters) throw new Error('文字稿里没有可用于匹配的文字或数字。');

  if (source.length < texts.length) {
    return {
      cues: proportionalCues(texts, source), quality: 0, weak: true,
      sourceCharacters: source.length, scriptCharacters,
    };
  }

  const sourceValues = source.map((character) => character.value);
  const cues: TranscriptWord[] = [];
  let sourceCursor = 0;
  let targetRemaining = scriptCharacters;
  let weightedQuality = 0;
  let previousEnd = source[0]!.start;

  texts.forEach((text, cueIndex) => {
    const target = targets[cueIndex]!;
    const cuesAfter = texts.length - cueIndex - 1;
    let boundary = source.length;
    let quality = 0;
    if (cuesAfter > 0) {
      const available = source.length - sourceCursor;
      const expectedLength = Math.max(1, Math.round(available * target.length / Math.max(1, targetRemaining)));
      const ideal = sourceCursor + expectedLength;
      const radius = Math.min(240, Math.max(12, Math.ceil(expectedLength * 0.8)));
      const lower = Math.max(sourceCursor + 1, ideal - radius);
      const upper = Math.min(source.length - cuesAfter, ideal + radius);
      let bestScore = Number.POSITIVE_INFINITY;
      for (let candidate = lower; candidate <= upper; candidate += 1) {
        const candidateText = sourceValues.slice(sourceCursor, candidate);
        const distance = editDistance(target, candidateText);
        const normalized = distance / Math.max(1, target.length, candidateText.length);
        const proximity = Math.abs(candidate - ideal) / Math.max(1, expectedLength);
        const score = normalized + proximity * 0.12;
        if (score < bestScore) {
          bestScore = score;
          boundary = candidate;
          quality = Math.max(0, 1 - normalized);
        }
      }
    } else {
      const candidateText = sourceValues.slice(sourceCursor);
      quality = Math.max(0, 1 - editDistance(target, candidateText) / Math.max(1, target.length, candidateText.length));
    }

    const first = source[sourceCursor]!;
    const last = source[Math.max(sourceCursor, boundary - 1)]!;
    const start = Math.max(previousEnd, first.start);
    const end = Math.max(start + 1, last.end);
    cues.push({ text, start: Math.round(start), end: Math.max(Math.round(start) + 1, Math.round(end)) });
    previousEnd = end;
    sourceCursor = boundary;
    targetRemaining -= target.length;
    weightedQuality += quality * Math.max(1, target.length);
  });

  const quality = weightedQuality / scriptCharacters;
  const lengthRatio = scriptCharacters / source.length;
  return {
    cues,
    quality,
    weak: quality < 0.55 || lengthRatio < 0.55 || lengthRatio > 1.8,
    sourceCharacters: source.length,
    scriptCharacters,
  };
}
