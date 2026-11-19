/**
 * Global anchor + affine-gap dynamic programming sequence alignment for
 * long-form pasted scripts (e.g. 20-40 minute voiceovers) vs ASR character streams.
 *
 * Why anchors + Gotoh DP instead of single-pass local cue search:
 * A single localized ~50-character difference in a 4,000-character script used
 * to push subsequent cues outside the tiny local search radius, locking the
 * entire remainder of the timeline onto proportional character-count estimates.
 */

interface AnchorSpan {
  tStart: number;
  sStart: number;
  length: number;
}

const MATCH_SCORE = 4;
const MISMATCH_PENALTY = -3;
const GAP_OPEN_PENALTY = -8;
const GAP_EXTEND_PENALTY = -2;
const NEG_INF = -1_000_000_000;
const EXACT_DP_CELL_LIMIT = 400_000;
const BANDED_DP_CELL_LIMIT = 1_500_000;
const MIN_HALF_BAND = 260;

class MaxFenwick {
  private readonly scores: number[];
  private readonly indices: number[];

  constructor(size: number) {
    this.scores = new Array(size + 1).fill(0);
    this.indices = new Array(size + 1).fill(-1);
  }

  update(position: number, score: number, index: number): void {
    for (let i = position + 1; i < this.scores.length; i += i & -i) {
      if (score > this.scores[i]!) {
        this.scores[i] = score;
        this.indices[i] = index;
      }
    }
  }

  query(position: number): { score: number; index: number } {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = position + 1; i > 0; i -= i & -i) {
      if (this.scores[i]! > bestScore) {
        bestScore = this.scores[i]!;
        bestIndex = this.indices[i]!;
      }
    }
    return { score: bestScore, index: bestIndex };
  }
}

function uniqueKgrams(
  sequence: readonly string[],
  from: number,
  to: number,
  k: number,
): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = from; i <= to - k; i += 1) {
    const gram = sequence.slice(i, i + k).join('');
    if (index.has(gram)) index.set(gram, -1);
    else index.set(gram, i);
  }
  return index;
}

function mergeHitsIntoSpans(hits: Array<{ t: number; s: number }>, k: number): AnchorSpan[] {
  if (!hits.length) return [];
  const byDiagonal = new Map<number, number[]>();
  for (const hit of hits) {
    const diag = hit.s - hit.t;
    let list = byDiagonal.get(diag);
    if (!list) {
      list = [];
      byDiagonal.set(diag, list);
    }
    list.push(hit.t);
  }

  const spans: AnchorSpan[] = [];
  for (const [diag, tList] of byDiagonal) {
    tList.sort((a, b) => a - b);
    let start = tList[0]!;
    let end = start + k;
    for (let idx = 1; idx < tList.length; idx += 1) {
      const t = tList[idx]!;
      if (t <= end) {
        end = Math.max(end, t + k);
      } else {
        spans.push({ tStart: start, sStart: start + diag, length: end - start });
        start = t;
        end = t + k;
      }
    }
    spans.push({ tStart: start, sStart: start + diag, length: end - start });
  }
  return spans;
}

/**
 * Select maximum-weight strictly non-overlapping monotonic anchors using a
 * 2D sweep-line over t with a coordinate-compressed Fenwick tree on s.
 */
function selectDisjointAnchors(spans: AnchorSpan[]): AnchorSpan[] {
  if (!spans.length) return [];
  const sValues = Array.from(new Set(spans.flatMap((span) => [span.sStart, span.sStart + span.length])))
    .sort((a, b) => a - b);
  const sRank = new Map<number, number>();
  sValues.forEach((value, idx) => sRank.set(value, idx));

  const events: Array<{ t: number; kind: 0 | 1; spanIndex: number }> = [];
  for (let idx = 0; idx < spans.length; idx += 1) {
    const span = spans[idx]!;
    events.push({ t: span.tStart, kind: 1, spanIndex: idx });
    events.push({ t: span.tStart + span.length, kind: 0, spanIndex: idx });
  }
  // Process completions (kind 0) before new starts (kind 1) at the same t so
  // touching intervals (prev.tEnd === curr.tStart) remain eligible.
  events.sort((a, b) => a.t - b.t || a.kind - b.kind);

  const bit = new MaxFenwick(sValues.length);
  const bestScore = new Array<number>(spans.length).fill(0);
  const previous = new Array<number>(spans.length).fill(-1);

  for (const event of events) {
    const span = spans[event.spanIndex]!;
    if (event.kind === 1) {
      const prior = bit.query(sRank.get(span.sStart)!);
      bestScore[event.spanIndex] = prior.score + span.length;
      previous[event.spanIndex] = prior.index;
    } else {
      bit.update(
        sRank.get(span.sStart + span.length)!,
        bestScore[event.spanIndex]!,
        event.spanIndex,
      );
    }
  }

  let bestEnd = 0;
  for (let idx = 1; idx < spans.length; idx += 1) {
    if (bestScore[idx]! > bestScore[bestEnd]!) bestEnd = idx;
  }

  const chosen: AnchorSpan[] = [];
  for (let cursor = bestEnd; cursor >= 0; cursor = previous[cursor]!) {
    chosen.push(spans[cursor]!);
  }
  chosen.reverse();
  return chosen;
}

function findAnchors(
  target: readonly string[],
  source: readonly string[],
  tFrom: number,
  tTo: number,
  sFrom: number,
  sTo: number,
  k: number,
): AnchorSpan[] {
  if (tTo - tFrom < k || sTo - sFrom < k) return [];
  const targetGrams = uniqueKgrams(target, tFrom, tTo, k);
  const sourceGrams = uniqueKgrams(source, sFrom, sTo, k);
  const hits: Array<{ t: number; s: number }> = [];
  for (const [gram, t] of targetGrams) {
    if (t < 0) continue;
    const s = sourceGrams.get(gram);
    if (s !== undefined && s >= 0) hits.push({ t, s });
  }
  if (!hits.length) return [];
  return selectDisjointAnchors(mergeHitsIntoSpans(hits, k));
}

function runGotohDp(
  target: readonly string[],
  source: readonly string[],
  tA: number,
  tB: number,
  sA: number,
  sB: number,
  targetToSource: Int32Array,
): void {
  const dt = tB - tA;
  const ds = sB - sA;
  if (dt <= 0 || ds <= 0) return;

  const exact = dt * ds <= EXACT_DP_CELL_LIMIT;
  const maxBandCells = Math.max(MIN_HALF_BAND, Math.floor(BANDED_DP_CELL_LIMIT / Math.max(1, dt)));
  const minRequiredBand = Math.max(MIN_HALF_BAND, Math.abs(ds - dt) + 200, Math.ceil(ds / Math.max(1, dt)) + 8);
  const halfBand = exact ? Math.max(dt, ds) + 1 : Math.min(minRequiredBand, maxBandCells);

  const rowLo = new Int32Array(dt + 1);
  const rowHi = new Int32Array(dt + 1);
  const rowStart = new Int32Array(dt + 1);
  let totalCells = 0;

  for (let i = 0; i <= dt; i += 1) {
    const center = Math.round((i * ds) / dt);
    const lo = exact ? 0 : Math.max(0, center - halfBand);
    const hi = exact ? ds : Math.min(ds, center + halfBand);
    rowLo[i] = lo;
    rowHi[i] = hi;
    rowStart[i] = totalCells;
    totalCells += hi - lo + 1;
  }

  // Packed state predecessors per cell: bits 0..1 for M, bits 2..3 for D, bits 4..5 for I.
  const trace = new Uint8Array(totalCells);
  const row0Width = rowHi[0]! - rowLo[0]! + 1;
  let prevM = new Int32Array(row0Width).fill(NEG_INF);
  let prevD = new Int32Array(row0Width).fill(NEG_INF);
  let prevI = new Int32Array(row0Width).fill(NEG_INF);

  prevM[0] = 0;
  for (let k = 1; k < row0Width; k += 1) {
    const j = rowLo[0]! + k;
    prevI[k] = GAP_OPEN_PENALTY + j * GAP_EXTEND_PENALTY;
    trace[rowStart[0]! + k] = 2 << 4;
  }

  for (let i = 1; i <= dt; i += 1) {
    const lo = rowLo[i]!;
    const hi = rowHi[i]!;
    const width = hi - lo + 1;
    const prevLo = rowLo[i - 1]!;
    const prevHi = rowHi[i - 1]!;
    const baseOffset = rowStart[i]!;
    const targetChar = target[tA + i - 1]!;

    const currM = new Int32Array(width).fill(NEG_INF);
    const currD = new Int32Array(width).fill(NEG_INF);
    const currI = new Int32Array(width).fill(NEG_INF);

    for (let k = 0; k < width; k += 1) {
      const j = lo + k;
      let mPrev = 0;
      let dPrev = 1;
      let iPrev = 2;

      if (j > 0 && j - 1 >= prevLo && j - 1 <= prevHi) {
        const pk = j - 1 - prevLo;
        let best = prevM[pk]!;
        if (prevD[pk]! > best) {
          best = prevD[pk]!;
          mPrev = 1;
        }
        if (prevI[pk]! > best) {
          best = prevI[pk]!;
          mPrev = 2;
        }
        if (best > NEG_INF / 2) {
          currM[k] = best + (targetChar === source[sA + j - 1] ? MATCH_SCORE : MISMATCH_PENALTY);
        }
      }

      if (j >= prevLo && j <= prevHi) {
        const pk = j - prevLo;
        const fromD = prevD[pk]! + GAP_EXTEND_PENALTY;
        const fromM = prevM[pk]! + GAP_OPEN_PENALTY + GAP_EXTEND_PENALTY;
        const fromI = prevI[pk]! + GAP_OPEN_PENALTY + GAP_EXTEND_PENALTY;
        let best = fromD;
        dPrev = 1;
        if (fromM > best) {
          best = fromM;
          dPrev = 0;
        }
        if (fromI > best) {
          best = fromI;
          dPrev = 2;
        }
        currD[k] = best;
      }

      if (k > 0) {
        const fromI = currI[k - 1]! + GAP_EXTEND_PENALTY;
        const fromM = currM[k - 1]! + GAP_OPEN_PENALTY + GAP_EXTEND_PENALTY;
        const fromD = currD[k - 1]! + GAP_OPEN_PENALTY + GAP_EXTEND_PENALTY;
        let best = fromI;
        iPrev = 2;
        if (fromM > best) {
          best = fromM;
          iPrev = 0;
        }
        if (fromD > best) {
          best = fromD;
          iPrev = 1;
        }
        currI[k] = best;
      }

      trace[baseOffset + k] = mPrev | (dPrev << 2) | (iPrev << 4);
    }

    prevM = currM;
    prevD = currD;
    prevI = currI;
  }

  const endK = ds - rowLo[dt]!;
  let state: 0 | 1 | 2 = 0;
  let endBest = prevM[endK]!;
  if (prevD[endK]! > endBest) {
    endBest = prevD[endK]!;
    state = 1;
  }
  if (prevI[endK]! > endBest) {
    state = 2;
  }

  let i = dt;
  let j = ds;
  while (i > 0 || j > 0) {
    const tr = trace[rowStart[i]! + (j - rowLo[i]!)]!;
    if (state === 0) {
      targetToSource[tA + i - 1] = sA + j - 1;
      state = (tr & 3) as 0 | 1 | 2;
      i -= 1;
      j -= 1;
    } else if (state === 1) {
      state = ((tr >> 2) & 3) as 0 | 1 | 2;
      i -= 1;
    } else {
      state = ((tr >> 4) & 3) as 0 | 1 | 2;
      j -= 1;
    }
  }
}

function alignRegion(
  target: readonly string[],
  source: readonly string[],
  tFrom: number,
  tTo: number,
  sFrom: number,
  sTo: number,
  kGramSize: number,
  targetToSource: Int32Array,
): void {
  const dt = tTo - tFrom;
  const ds = sTo - sFrom;
  if (dt <= 0 || ds <= 0) return;

  const anchors = kGramSize > 0 ? findAnchors(target, source, tFrom, tTo, sFrom, sTo, kGramSize) : [];
  if (!anchors.length) {
    if (kGramSize > 4 && dt * ds > 120_000) {
      alignRegion(target, source, tFrom, tTo, sFrom, sTo, 4, targetToSource);
      return;
    }
    runGotohDp(target, source, tFrom, tTo, sFrom, sTo, targetToSource);
    return;
  }

  let tCursor = tFrom;
  let sCursor = sFrom;
  for (const anchor of anchors) {
    if (anchor.tStart > tCursor && anchor.sStart > sCursor) {
      const gapDt = anchor.tStart - tCursor;
      const gapDs = anchor.sStart - sCursor;
      const nextK = kGramSize > 4 && gapDt * gapDs > 120_000 ? 4 : 0;
      alignRegion(target, source, tCursor, anchor.tStart, sCursor, anchor.sStart, nextK, targetToSource);
    }
    for (let offset = 0; offset < anchor.length; offset += 1) {
      targetToSource[anchor.tStart + offset] = anchor.sStart + offset;
    }
    tCursor = anchor.tStart + anchor.length;
    sCursor = anchor.sStart + anchor.length;
  }

  if (tTo > tCursor && sTo > sCursor) {
    const tailDt = tTo - tCursor;
    const tailDs = sTo - sCursor;
    const nextK = kGramSize > 4 && tailDt * tailDs > 120_000 ? 4 : 0;
    alignRegion(target, source, tCursor, tTo, sCursor, sTo, nextK, targetToSource);
  }
}

export function alignNormalizedSequences(
  target: readonly string[],
  source: readonly string[],
): Int32Array {
  const targetToSource = new Int32Array(target.length).fill(-1);
  if (!target.length || !source.length) return targetToSource;
  alignRegion(target, source, 0, target.length, 0, source.length, 6, targetToSource);
  return targetToSource;
}
