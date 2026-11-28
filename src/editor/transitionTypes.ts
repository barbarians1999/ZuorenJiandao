import type { TrackId } from './trackTypes.js';

/** transitions with a CSS fallback for non-texturable DOM clips. */
export type CssTransitionType =
  | 'cross-dissolve'
  | 'dip-to-black'
  | 'soft-wipe'
  | 'whip-pan'
  | 'flash'
  | 'luma-blend'
  | 'ink-bleed'
  | 'archival-line-wipe';

/** these video transitions run their real GLSL for video/image clips. */
export type GlslTransitionType =
  | CssTransitionType
  | 'page-curl'
  | 'rack-focus'
  | 'organic-dissolve'
  | 'impact-shake'
  | 'anticipation-zoom'
  | 'clean-line-wipe'
  | 'circle-wipe'
  | 'radial-blur'
  | 'glitch-cut'
  | 'dip-to-color'
  | 'mosaic-reveal'
  | 'blinds-reveal'
  | 'split-slide';

/** Audio-only transitions (preset `trAudioCrossFade`) — no picture. */
export type AudioTransitionType = 'audio-cross-fade';

/** builtin transition ids + extended library transitions + audio + custom shader.
 *  'custom-shader' = a submit_shader-generated transition; its two-input GLSL lives on the
 *  TransitionItem (customFrag), NOT in the exhaustive GLSL_TRANSITIONS record. */
export type TransitionType = GlslTransitionType | AudioTransitionType | 'custom-shader';

export const GLSL_TRANSITION_TYPES: ReadonlySet<string> = new Set<string>([
  'cross-dissolve', 'dip-to-black', 'soft-wipe', 'whip-pan', 'flash', 'luma-blend',
  'ink-bleed', 'archival-line-wipe',
  'page-curl', 'rack-focus', 'organic-dissolve', 'impact-shake', 'anticipation-zoom', 'clean-line-wipe',
  'circle-wipe', 'radial-blur', 'glitch-cut', 'dip-to-color',
  'mosaic-reveal', 'blinds-reveal', 'split-slide',
  'custom-shader', // takes the GL render path; frag comes from the item, not GLSL_TRANSITIONS
]);

export const CSS_TRANSITION_TYPES: ReadonlySet<string> = new Set<string>([
  'cross-dissolve', 'dip-to-black', 'soft-wipe', 'whip-pan', 'flash', 'luma-blend',
  'ink-bleed', 'archival-line-wipe',
]);

export const AUDIO_TRANSITION_TYPES: ReadonlySet<AudioTransitionType> = new Set<AudioTransitionType>([
  'audio-cross-fade',
]);

export function isAudioTransition(type: TransitionType): type is AudioTransitionType {
  return AUDIO_TRANSITION_TYPES.has(type as AudioTransitionType);
}

export function isVisualTransition(type: TransitionType): type is GlslTransitionType {
  return !isAudioTransition(type);
}

// en labels for the transition library cards (Resource Library·Transition·Screen Transition).
// Shared by the inspector select + the resource-library grid.
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  'ink-bleed': '宣纸墨迹晕染',
  'archival-line-wipe': '细线平滑拉幕',
  'anticipation-zoom': '推进转场',
  'clean-line-wipe': '划线擦除转场',
  'cross-dissolve': '叠化转场',
  'dip-to-black': '闪黑转场',
  flash: '闪白转场',
  'impact-shake': '冲击抖动转场',
  'luma-blend': '叠加转场',
  'organic-dissolve': '光溶转场',
  'page-curl': '翻页转场',
  'rack-focus': '焦点转场',
  'soft-wipe': '柔化擦除转场',
  'whip-pan': '甩镜转场',
  'circle-wipe': '圆形擦除转场',
  'radial-blur': '径向模糊转场',
  'glitch-cut': '故障切换转场',
  'dip-to-color': '闪色转场',
  'mosaic-reveal': '棋盘消散转场',
  'blinds-reveal': '百叶开合转场',
  'split-slide': '双向分屏转场',
  /** preset.name.trAudioCrossFade */
  'audio-cross-fade': '音频交叉淡化',
  /** submit_shader-generated custom transition (per-item label in customLabel) */
  'custom-shader': '自定义着色器转场',
};

/** catalog display order + extended visual transitions. */
export const TRANSITION_ORDER: readonly GlslTransitionType[] = [
  'ink-bleed',
  'archival-line-wipe',
  'anticipation-zoom',
  'clean-line-wipe',
  'cross-dissolve',
  'dip-to-black',
  'flash',
  'impact-shake',
  'luma-blend',
  'organic-dissolve',
  'page-curl',
  'rack-focus',
  'soft-wipe',
  'whip-pan',
  'circle-wipe',
  'radial-blur',
  'glitch-cut',
  'dip-to-color',
  'mosaic-reveal',
  'blinds-reveal',
  'split-slide',
];

/** Audio transition catalog (trAudioCrossFade). */
export const AUDIO_TRANSITION_ORDER: readonly AudioTransitionType[] = [
  'audio-cross-fade',
];

export function parseBuiltinTransitionId(assetId: string): TransitionType | null {
  const raw = assetId.replace(/^builtin:tr-/, '');
  if ((TRANSITION_ORDER as readonly string[]).includes(raw)) return raw as TransitionType;
  if ((AUDIO_TRANSITION_ORDER as readonly string[]).includes(raw)) return raw as TransitionType;
  return null;
}

export type TransitionDirection = 'left' | 'right' | 'up' | 'down';

/** an independent transition item straddling the cut between two adjacent
 * same-track clips (transition_item: outgoing→incoming). */
export interface TransitionItem {
  id: string;
  type: TransitionType;
  /** transition length in frames (half retreats into outgoing, half into incoming) */
  durationInFrames: number;
  outgoingItemId: string;
  incomingItemId: string;
  trackId: TrackId;
  enabled?: boolean;
  /** direction for wipe/whip transitions (default 'left') */
  direction?: TransitionDirection;
  /** ink-bleed origin in normalized canvas coordinates (0..1, default 0.5) */
  originX?: number;
  originY?: number;
  /** archival-line-wipe seam color hex (default '#a62121') and width in px (default 2.5) */
  lineColor?: string;
  lineWidthPx?: number;
  /** type='custom-shader' only: the submit_shader-generated two-input transition GLSL,
   *  stored here (not in a registry) so it persists with the project and renders after
   *  reload. customUniforms = {u_<key>: value}; customLabel = display name. */
  customFrag?: string;
  customUniforms?: Record<string, number>;
  customLabel?: string;
}
