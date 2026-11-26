import type { CaptionWordOverride } from './types';

export function stableOverrideKeys(
  overrides: Record<number, CaptionWordOverride>,
  wordRef: string,
): number[] {
  // A legacy override (empty wordRef, keyed by plain index) must never match a
  // stable lookup: `'' === ''` would merge distinct legacy entries together.
  if (!wordRef) return [];
  return Object.entries(overrides)
    .filter(([, override]) => override.wordRef === wordRef)
    .map(([key]) => Number(key));
}

export function buildStableOverrideMap(
  overrides: Record<number, CaptionWordOverride> | undefined,
): Map<string, CaptionWordOverride> {
  const stable = new Map<string, CaptionWordOverride>();
  if (!overrides) return stable;
  for (const override of Object.values(overrides)) {
    if (override.wordRef && !stable.has(override.wordRef)) {
      stable.set(override.wordRef, override);
    }
  }
  return stable;
}

export function lookupCaptionWordOverride(
  overrides: Record<number, CaptionWordOverride> | undefined,
  stableByRef: ReadonlyMap<string, CaptionWordOverride>,
  index: number,
  wordRef: string,
): CaptionWordOverride | undefined {
  if (!overrides) return undefined;
  if (wordRef) {
    const stable = stableByRef.get(wordRef);
    if (stable !== undefined) return stable;
  }
  const legacy = overrides[index];
  return legacy?.wordRef ? undefined : legacy;
}

export function captionWordOverride(
  overrides: Record<number, CaptionWordOverride> | undefined,
  index: number,
  wordRef: string,
): CaptionWordOverride | undefined {
  if (!overrides) return undefined;
  const stableKey = stableOverrideKeys(overrides, wordRef)[0];
  if (stableKey !== undefined) return overrides[stableKey];
  const legacy = overrides[index];
  return legacy?.wordRef ? undefined : legacy;
}

function freeOverrideKey(overrides: Record<number, CaptionWordOverride>, indices: number[]): number {
  const keys = [...indices, ...Object.keys(overrides).map(Number)].filter(Number.isFinite);
  let candidate = keys.length ? Math.max(...keys) + 1 : 0;
  while (overrides[candidate]) candidate += 1;
  return candidate;
}

export function setCaptionWordOverride(
  overrides: Record<number, CaptionWordOverride>,
  indices: number[],
  index: number,
  wordRef: string,
  patch: CaptionWordOverride,
): Record<number, CaptionWordOverride> {
  const next = { ...overrides };
  const stableKeys = stableOverrideKeys(next, wordRef);
  const legacy = next[index];
  const key = stableKeys[0]
    ?? (!legacy || !legacy.wordRef ? index : freeOverrideKey(next, indices));
  const base = stableKeys.length ? next[key] : (!legacy?.wordRef ? legacy : undefined);
  for (const duplicate of stableKeys.slice(1)) delete next[duplicate];
  if (key !== index && legacy && !legacy.wordRef) delete next[index];
  next[key] = { ...base, ...patch, wordRef };
  return next;
}

export function clearCaptionWordOverride(
  overrides: Record<number, CaptionWordOverride>,
  index: number,
  wordRef: string,
): Record<number, CaptionWordOverride> {
  const next = { ...overrides };
  for (const key of stableOverrideKeys(next, wordRef)) delete next[key];
  if (next[index] && !next[index]!.wordRef) delete next[index];
  return next;
}
