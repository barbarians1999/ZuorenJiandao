import { effectivePreset } from '../captions/renderStyles';
import type { CaptionsData } from '../captions/types';
import { captionTrackEntries, type TimelineItem, type TimelineState } from '../editor/types';
import { ensureFont, loadProjectFonts } from './googleFonts';
import { ensureReferencedAssetFont } from './assetFonts';
import { findLocalFont } from './localFonts';

const FONT_PROP_KEYS = new Set([
  'fontFamily', 'fontfamily', 'font_family', 'font', 'headingFont', 'bodyFont', 'titleFont',
]);

function pushFamily(into: Set<string>, raw: unknown): void {
  if (typeof raw !== 'string') return;
  for (const part of raw.split(',')) {
    const face = part.trim().replace(/^["']|["']$/g, '');
    if (face) into.add(face);
  }
}

function scanObjectForFonts(obj: unknown, into: Set<string>, depth = 0): void {
  if (!obj || depth > 6 || typeof obj === 'string') return;
  if (Array.isArray(obj)) {
    for (const value of obj) scanObjectForFonts(value, into, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === 'fontFamily' && typeof (obj as Record<string, unknown>).fontAssetId === 'string') continue;
    if (FONT_PROP_KEYS.has(key) || /fontfamily/i.test(key)) pushFamily(into, value);
    else if (value && typeof value === 'object') scanObjectForFonts(value, into, depth + 1);
  }
}

function scanCodeForFonts(code: string | undefined, into: Set<string>): void {
  if (!code) return;
  const re = /font(?:Family|-family)\s*[:=]\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) pushFamily(into, match[1]);
}

function fontsFromItem(item: TimelineItem, into: Set<string>): void {
  if (item.kind !== 'motion-graphic' && item.kind !== 'text') return;
  scanObjectForFonts(item.props, into);
  scanCodeForFonts(item.code, into);
}

function fontsFromCaptions(captions: CaptionsData | null | undefined, into: Set<string>): void {
  if (!captions?.enabled) return;
  const style = effectivePreset(captions);
  if (!style.fontAssetId) pushFamily(into, style.fontFamily);
  for (const entry of captions.sourceEntries ?? []) {
    if (entry.style?.fontFamily && !entry.style.fontAssetId) pushFamily(into, entry.style.fontFamily);
  }
  for (const font of Object.values(captions.cueFonts ?? {})) if (!font.fontAssetId) pushFamily(into, font.fontFamily);
}

export function collectReferencedFonts(
  state: TimelineState,
  opts?: { captions?: CaptionsData | null },
): string[] {
  const families = new Set<string>();
  for (const item of state.items) fontsFromItem(item, families);
  if (opts && 'captions' in opts) fontsFromCaptions(opts.captions, families);
  else {
    const tracks = captionTrackEntries(state);
    if (tracks.length) tracks.forEach((entry) => fontsFromCaptions(entry.captions, families));
    else fontsFromCaptions(state.captions, families);
  }
  return [...families].sort((a, b) => a.localeCompare(b));
}

export interface ProjectFontFace {
  family: string;
  weight?: number;
}

export function collectReferencedFontFaces(state: TimelineState): ProjectFontFace[] {
  const weights = new Map<string, Set<number>>();
  const configs = captionTrackEntries(state).map((entry) => entry.captions).filter(Boolean) as CaptionsData[];
  if (!configs.length && state.captions) configs.push(state.captions);
  for (const captions of configs) {
    if (!captions.enabled) continue;
    const base = effectivePreset(captions);
    const faces = [{ family: base.fontFamily, weight: base.fontWeight }, ...(captions.sourceEntries ?? []).map((entry) => ({
      family: entry.style?.fontFamily ?? base.fontFamily,
      weight: entry.style?.fontWeight ?? base.fontWeight,
    }))];
    for (const face of faces) {
      const set = weights.get(face.family) ?? new Set<number>();
      set.add(face.weight);
      weights.set(face.family, set);
    }
  }

  return collectReferencedFonts(state).flatMap((family) => {
    const fontWeights = weights.get(family);
    return fontWeights?.size
      ? [...fontWeights].map((weight) => ({ family, weight }))
      : [{ family }];
  });
}

/** Export preloads every referenced face. Preview uses CSS demand loading for sharded local fonts. */
export function loadTimelineFonts(
  state: TimelineState,
  opts?: { tolerateErrors?: boolean },
): Promise<void> {
  if (opts?.tolerateErrors) loadProjectFonts();
  const faces = collectReferencedFontFaces(state);
  const loads = [
    ...faces
      .filter(({ family }) => !opts?.tolerateErrors || !findLocalFont(family)?.stylesheet)
      .map(({ family, weight }) => ensureFont(family, weight)),
    ...collectReferencedFontAssetIds(state).map((id) => ensureReferencedAssetFont(id, state.assets ?? [])),
  ];
  if (!opts?.tolerateErrors) return Promise.all(loads).then(() => undefined);
  return Promise.allSettled(loads).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        // Interactive preview renders with fallback faces rather than blanking the player canvas.
        console.warn('[TimelineReadinessGate] font preload degraded in preview:', result.reason);
      }
    }
  });
}

export function collectReferencedFontAssetIds(state: TimelineState): string[] {
  const ids = new Set<string>();
  const scan = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 10) return;
    if (Array.isArray(value)) { value.forEach((entry) => scan(entry, depth + 1)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'fontAssetId' && typeof child === 'string' && child) ids.add(child);
      else if (child && typeof child === 'object') scan(child, depth + 1);
    }
  };
  for (const item of state.items) if (item.kind === 'text' || item.kind === 'motion-graphic') scan(item.props);
  const captions = captionTrackEntries(state).map((entry) => entry.captions);
  if (!captions.length && state.captions) captions.push(state.captions);
  for (const config of captions) if (config?.enabled) scan(config);
  return [...ids];
}
