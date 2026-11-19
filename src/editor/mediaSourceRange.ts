/** Source positions use project-FPS frames, just like imported asset durations. */
export interface MediaSourceRange {
  srcInFrame: number;
  durationInFrames: number;
}

export type MediaSourceRanges = Readonly<Record<string, MediaSourceRange>>;

export function isMediaSourceRange(value: unknown): value is MediaSourceRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Partial<MediaSourceRange>;
  return Number.isSafeInteger(range.srcInFrame) && range.srcInFrame! >= 0
    && Number.isSafeInteger(range.durationInFrames) && range.durationInFrames! > 0;
}

export function isMediaSourceRanges(value: unknown): value is MediaSourceRanges {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([id, range]) => id.length > 0 && isMediaSourceRange(range));
}

/** Validate before creating tracks; source bounds also apply to programmatic adds. */
export function resolveMediaSourceRange(
  asset: { durationInFrames: number },
  requested?: Partial<MediaSourceRange>,
): MediaSourceRange | undefined {
  if (requested?.srcInFrame === undefined && requested?.durationInFrames === undefined) return undefined;
  const total = Math.round(asset.durationInFrames);
  const start = requested.srcInFrame ?? 0;
  const length = requested.durationInFrames;
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isFinite(start)
    || (length !== undefined && (!Number.isFinite(length) || length <= 0))) {
    throw new Error('素材选段范围无效，请重新设置入点和出点。');
  }
  const srcInFrame = Math.max(0, Math.round(start));
  if (srcInFrame >= total) throw new Error('素材入点已超出原片范围，请重新选段。');
  return {
    srcInFrame,
    durationInFrames: Math.min(total - srcInFrame, Math.max(1, Math.round(length ?? total - srcInFrame))),
  };
}

export function sourceRangeFromMap(ranges: MediaSourceRanges | undefined, id: string): MediaSourceRange | undefined {
  return ranges && Object.hasOwn(ranges, id) ? ranges[id] : undefined;
}
