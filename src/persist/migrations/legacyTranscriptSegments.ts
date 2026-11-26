// Migration-only helper reconstructing legacy virtual-transcript segments from pre-track-ssot projects.
// Runtime playback, preview, and export MUST NOT import this module.

export interface LegacyTranscriptWord {
  id?: string;
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
}

export interface LegacyKeptSegment {
  srcStartFrame: number;
  srcEndFrame: number;
  fromFrame: number;
  durFrames: number;
}

export interface LegacyEditOpts {
  maxGapFrames?: number;
  gapCapsMs?: Record<string, number>;
  playOrder?: number[];
  cutPadFrames?: number;
  window?: { startFrame: number; durFrames: number };
}

export interface LegacyTranscriptCarrier {
  transcript?: LegacyTranscriptWord[];
  transcriptGenerationId?: string;
  transcriptStale?: boolean;
}

export function hasOperationalTranscript<T extends LegacyTranscriptCarrier>(
  item: T | null | undefined,
): item is T & { transcript: LegacyTranscriptWord[]; transcriptStale?: false } {
  return Boolean(
    item
    && item.transcriptStale !== true
    && Array.isArray(item.transcript)
    && item.transcript.length > 0,
  );
}

export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

export function itemWindow(it: { kind: string; srcInFrame?: number; durationInFrames: number }): LegacyEditOpts['window'] {
  if (it.kind !== 'audio') return undefined;
  return { startFrame: it.srcInFrame ?? 0, durFrames: it.durationInFrames };
}

export function itemEditOpts(it: {
  silenceFrames?: number;
  gapCapsMs?: Record<string, number>;
  transcriptPlayOrder?: number[];
  cutPadFrames?: number;
}): LegacyEditOpts {
  return {
    maxGapFrames: it.silenceFrames,
    gapCapsMs: it.gapCapsMs,
    playOrder: it.transcriptPlayOrder,
    cutPadFrames: it.cutPadFrames,
  };
}

export function gapCapFrames(opts: LegacyEditOpts, nextWordIdx: number, fps: number): number | null {
  const key = String(nextWordIdx);
  if (opts.gapCapsMs && Object.prototype.hasOwnProperty.call(opts.gapCapsMs, key)) {
    const ms = opts.gapCapsMs[key];
    return Math.max(0, Math.round((ms / 1000) * fps));
  }
  if (opts.maxGapFrames != null) return opts.maxGapFrames;
  return null;
}

function windowSegments(
  segs: LegacyKeptSegment[],
  offsetFrames: number,
  window: { startFrame: number; durFrames: number },
): LegacyKeptSegment[] {
  const w0 = Math.max(0, window.startFrame);
  const w1 = w0 + Math.max(0, window.durFrames);
  const out: LegacyKeptSegment[] = [];
  let pos = offsetFrames;
  for (const seg of segs) {
    const local0 = seg.fromFrame - offsetFrames;
    const local1 = local0 + seg.durFrames;
    const a = Math.max(local0, w0);
    const b = Math.min(local1, w1);
    if (b <= a) continue;
    const headCut = a - local0;
    const tailCut = local1 - b;
    out.push({
      srcStartFrame: seg.srcStartFrame + headCut,
      srcEndFrame: seg.srcEndFrame - tailCut,
      fromFrame: pos,
      durFrames: b - a,
    });
    pos += b - a;
  }
  return out;
}

export function keptSegments(
  words: LegacyTranscriptWord[],
  deleted: Set<number>,
  fps: number,
  offsetFrames: number,
  opts: LegacyEditOpts = {},
): LegacyKeptSegment[] {
  const seq = (
    opts.playOrder?.length
      ? opts.playOrder
      : words.map((_, i) => i)
  ).filter((i) => i >= 0 && i < words.length && !deleted.has(i));

  const half = Math.max(0, Math.floor((opts.cutPadFrames ?? 0) / 2));

  const segs: LegacyKeptSegment[] = [];
  let pos = offsetFrames;
  let si = 0;
  while (si < seq.length) {
    const wi = seq[si]!;
    let srcStart = msToFrame(words[wi]!.start, fps);
    let srcEnd = msToFrame(words[wi]!.end, fps);
    let sj = si;
    let curWi = wi;
    let capped = false;
    while (sj + 1 < seq.length) {
      const nextWi = seq[sj + 1]!;
      if (nextWi !== curWi + 1) break;
      const nextStart = msToFrame(words[nextWi]!.start, fps);
      const gap = nextStart - srcEnd;
      if (gap < 0) break;
      const cap = gapCapFrames(opts, nextWi, fps);
      if (cap != null && gap > cap) {
        srcEnd += cap;
        capped = true;
        break;
      }
      srcEnd = msToFrame(words[nextWi]!.end, fps);
      curWi = nextWi;
      sj += 1;
    }
    if (half > 0) {
      if (wi > 0 && (si === 0 ? true : seq[si - 1] !== wi - 1)) {
        const silence = srcStart - msToFrame(words[wi - 1]!.end, fps);
        srcStart = Math.max(0, srcStart - Math.max(0, Math.min(silence, half)));
      }
      if (!capped && curWi + 1 < words.length && seq[sj + 1] !== curWi + 1) {
        const silence = msToFrame(words[curWi + 1]!.start, fps) - srcEnd;
        srcEnd += Math.max(0, Math.min(silence, half));
      }
    }
    const durFrames = Math.max(1, srcEnd - srcStart);
    segs.push({ srcStartFrame: srcStart, srcEndFrame: srcEnd, fromFrame: pos, durFrames });
    pos += durFrames;
    si = sj + 1;
  }
  return opts.window ? windowSegments(segs, offsetFrames, opts.window) : segs;
}

export function editedStreamFrames(
  words: LegacyTranscriptWord[],
  deleted: Set<number>,
  fps: number,
  opts: LegacyEditOpts = {},
): number {
  return keptSegments(words, deleted, fps, 0, opts).reduce((s, seg) => s + seg.durFrames, 0);
}

export function editedFrames(
  words: LegacyTranscriptWord[],
  deleted: Set<number>,
  fps: number,
  opts: LegacyEditOpts = {},
): number {
  return Math.max(1, editedStreamFrames(words, deleted, fps, opts));
}
