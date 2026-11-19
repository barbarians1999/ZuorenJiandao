import { collectReferencedFontAssetIds, collectReferencedFontFaces } from '../fonts/projectFonts';
import type { TimelineState } from './types';

export function timelineReadinessKey(state: TimelineState, dependencies: readonly TimelineState[] = []): string {
  const states = [state, ...dependencies];
  const templates = states.flatMap((entry) => entry.items
    .filter((item) => item.kind === 'motion-graphic' && item.code)
    .map((item) => item.code as string));
  const assetFonts = states.flatMap((entry) => collectReferencedFontAssetIds(entry).map((id) => {
    const asset = entry.assets?.find((candidate) => candidate.id === id);
    return [id, asset?.src, asset?.sourceContentHash];
  }));
  return JSON.stringify([states.flatMap(collectReferencedFontFaces), assetFonts, templates]);
}
