/**
 * Unified Jianying-style unitless "字号" scale conversion helpers.
 *
 * Underlying storage remains model-native for full project/render compatibility:
 * - Captions store `fontSize` as a ratio of composition height (`0.02..0.14`).
 * - Text clips store `fontSize` in 1080p design-space pixels (`24..300`, default `96`).
 *
 * Both map onto a single physical scale where `1` unit = `0.005` × canvas height
 * (= `5.4px` at 1080p), so typical captions sit cleanly in `5..15` (default `8`)
 * and text clips can scale from `4.5` up to `55.5` seamlessly.
 */

export const CAPTION_RATIO_MIN = 0.02;
export const CAPTION_RATIO_MAX = 0.14;
export const CAPTION_SCALE_MIN = 4;
export const CAPTION_SCALE_MAX = 28;
export const CAPTION_SCALE_STEP = 0.5;

export const TEXT_DESIGN_PX_MIN = 24;
export const TEXT_DESIGN_PX_MAX = 300;
export const TEXT_DESIGN_PX_DEFAULT = 96;
export const TEXT_PX_PER_UNIT = 1080 / 200; // 5.4 px at 1080p
export const TEXT_SCALE_MIN = 4.5;
export const TEXT_SCALE_MAX = 55.5;
export const TEXT_SCALE_STEP = 0.5;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Convert stored caption height-ratio font size (`0.02..0.14`) to unitless Jianying scale (`4..28`). */
export function captionRatioToScale(ratio: number): number {
  const safeRatio = Number.isFinite(ratio) ? clamp(ratio, CAPTION_RATIO_MIN, CAPTION_RATIO_MAX) : 0.04;
  return Math.round(safeRatio * 2000) / 10;
}

/** Convert unitless Jianying caption scale (`4..28`) back to stored height-ratio (`0.02..0.14`). */
export function captionScaleToRatio(scale: number): number {
  const safeScale = Number.isFinite(scale) ? clamp(scale, CAPTION_SCALE_MIN, CAPTION_SCALE_MAX) : 8;
  return clamp(Math.round((safeScale / 200) * 10000) / 10000, CAPTION_RATIO_MIN, CAPTION_RATIO_MAX);
}

/** Convert stored 1080p text-clip `fontSize` (`24..300` px) to unitless Jianying scale (`4.5..55.5`). */
export function textPxToScale(px: number): number {
  const safePx = Number.isFinite(px) ? clamp(px, TEXT_DESIGN_PX_MIN, TEXT_DESIGN_PX_MAX) : TEXT_DESIGN_PX_DEFAULT;
  return Math.round((safePx / TEXT_PX_PER_UNIT) * 10) / 10;
}

/** Convert unitless Jianying text scale (`4.5..55.5`) back to stored 1080p design pixels (`24..300`). */
export function textScaleToPx(scale: number): number {
  const safeScale = Number.isFinite(scale) ? clamp(scale, TEXT_SCALE_MIN, TEXT_SCALE_MAX) : textPxToScale(TEXT_DESIGN_PX_DEFAULT);
  return clamp(Math.round(safeScale * TEXT_PX_PER_UNIT * 10) / 10, TEXT_DESIGN_PX_MIN, TEXT_DESIGN_PX_MAX);
}

/** Format unitless Jianying font-size scale consistently without `%` or `px`. */
export function formatFontSizeScale(scale: number): string {
  const rounded = Math.round(scale * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
