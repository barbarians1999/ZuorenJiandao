import type { FontChoice } from '../../shared/desktop-fonts';
import type { CaptionsData } from '../captions/types';
import type { CaptionPreviewTarget } from '../captions/captionPreviewTarget';

export type CaptionFontScope = 'selected' | 'track';

export function captionFontKey(manualCueId: string | undefined, firstWordRef: string | undefined): string | undefined {
  return manualCueId ? `cue:${manualCueId}` : firstWordRef ? `word:${firstWordRef}` : undefined;
}

export function targetCaptionFontKey(target: CaptionPreviewTarget): string | undefined {
  if (target.kind === 'manual') return captionFontKey(target.cueId, undefined);
  const row = target.rows[target.cueIndex];
  return row?.displayCuePartId ? captionFontKey(row.displayCuePartId, undefined)
    : captionFontKey(undefined, row?.wordRefs[0]);
}

export function captionSelectedFontsPatch(captions: CaptionsData, choice: FontChoice,
  targets: readonly CaptionPreviewTarget[]): Partial<CaptionsData> {
  if (!targets.length) throw new Error('请先选中需要更换字体的字幕');
  const cueFonts = { ...captions.cueFonts };
  for (const target of targets) {
    const key = targetCaptionFontKey(target);
    if (!key) throw new Error('这句字幕没有稳定标识，请先重新生成或导入字幕');
    cueFonts[key] = { fontFamily: choice.fontFamily, fontAssetId: choice.fontAssetId ?? null };
  }
  return { cueFonts };
}

/** A font change never replaces color, stroke, timing, layout, or motion. */
export function captionFontPatch(captions: CaptionsData, choice: FontChoice, scope: CaptionFontScope, target?: CaptionPreviewTarget): Partial<CaptionsData> {
  // null explicitly clears a font inherited from a track after JSON round trips.
  const font = { fontFamily: choice.fontFamily, fontAssetId: choice.fontAssetId ?? null };
  if (scope === 'selected' && target) {
    return captionSelectedFontsPatch(captions, choice, [target]);
  }
  return {
    styleOverride: { ...captions.styleOverride, ...font },
    cueFonts: undefined,
    ...(captions.sourceEntries ? { sourceEntries: captions.sourceEntries.map((entry) => {
      if (!entry.style) return entry;
      const { fontFamily: _family, fontAssetId: _asset, ...style } = entry.style;
      return { ...entry, style };
    }) } : {}),
  };
}
