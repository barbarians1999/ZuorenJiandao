// Registry of the GLSL transitions (builtin:tr-*), mapping our
// TransitionType → fragment source + default uniforms. Defaults follow the
// (name, default, min, max) table in shaders/README.md; the vec3
// color defaults aren't in that table — chosen by eye.
import type { GlslTransitionType, TransitionDirection } from '../editor/types';
import type { UniformValue } from './runtime';
import pageCurl from './shaders/page-curl.frag?raw';
import rackFocus from './shaders/rack-focus.frag?raw';
import organicDissolve from './shaders/organic-dissolve.frag?raw';
import impactShake from './shaders/impact-shake.frag?raw';
import anticipationZoom from './shaders/anticipation-zoom.frag?raw';
import cleanLineWipe from './shaders/clean-line-wipe.frag?raw';
import crossDissolve from './shaders/cross-dissolve.frag?raw';
import dipToBlack from './shaders/dip-to-black.frag?raw';
import flash from './shaders/flash.frag?raw';
import lumaBlend from './shaders/luma-blend.frag?raw';
import softWipe from './shaders/soft-wipe.frag?raw';
import whipPan from './shaders/whip-pan.frag?raw';
import circleWipe from './shaders/circle-wipe.frag?raw';
import radialBlur from './shaders/radial-blur.frag?raw';
import glitchCut from './shaders/glitch-cut.frag?raw';
import dipToColor from './shaders/dip-to-color.frag?raw';
import mosaicReveal from './shaders/mosaic-reveal.frag?raw';
import blindsReveal from './shaders/blinds-reveal.frag?raw';
import splitSlide from './shaders/split-slide.frag?raw';
import inkBleed from './shaders/ink-bleed.frag?raw';
import archivalLineWipe from './shaders/archival-line-wipe.frag?raw';

function hexToRgbUnit(hex: string | undefined, fallback: [number, number, number]): [number, number, number] {
  const clean = typeof hex === 'string' ? hex.trim().replace(/^#/, '') : '';
  if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r / 255, g / 255, b / 255];
    }
  }
  return fallback;
}

export interface GlslTransitionDef {
  frag: string;
  /** per-frame uniforms beyond u_progress/u_resolution/u_aspect */
  uniforms: (ctx: {
    time: number;
    aspect: number;
    direction: TransitionDirection;
    width?: number;
    height?: number;
    originX?: number;
    originY?: number;
    lineColor?: string;
    lineWidthPx?: number;
  }) => Record<string, UniformValue>;
}

export const GLSL_TRANSITIONS: Record<GlslTransitionType, GlslTransitionDef> = {
  'ink-bleed': {
    frag: inkBleed,
    uniforms: ({ aspect, originX, originY }) => ({
      u_ratio: aspect,
      u_origin: [
        typeof originX === 'number' && Number.isFinite(originX) ? Math.max(0, Math.min(1, originX)) : 0.5,
        typeof originY === 'number' && Number.isFinite(originY) ? Math.max(0, Math.min(1, originY)) : 0.5,
      ],
      u_roughness: 0.55,
    }),
  },
  'archival-line-wipe': {
    frag: archivalLineWipe,
    uniforms: ({ direction, width, height, lineColor, lineWidthPx }) => {
      const axisLen = direction === 'up' || direction === 'down'
        ? Math.max(1, height ?? 1080)
        : Math.max(1, width ?? 1920);
      const px = typeof lineWidthPx === 'number' && Number.isFinite(lineWidthPx)
        ? Math.max(1, Math.min(12, lineWidthPx))
        : 2.5;
      return {
        u_dir: direction === 'right' ? [-1, 0] : direction === 'up' ? [0, 1] : direction === 'down' ? [0, -1] : [1, 0],
        u_lineColor: hexToRgbUnit(lineColor, [0.651, 0.129, 0.129]),
        u_lineWidthUv: px / axisLen,
      };
    },
  },
  'mosaic-reveal': { frag: mosaicReveal, uniforms: () => ({}) },
  'blinds-reveal': { frag: blindsReveal, uniforms: ({ direction }) => ({ u_axis: direction === 'up' || direction === 'down' ? [0, 1] : [1, 0] }) },
  'split-slide': { frag: splitSlide, uniforms: ({ direction }) => ({ u_axis: direction === 'up' || direction === 'down' ? [0, 1] : [1, 0] }) },
  'cross-dissolve': {
    frag: crossDissolve,
    uniforms: () => ({ u_easingAmount: 1 }),
  },
  'dip-to-black': {
    frag: dipToBlack,
    uniforms: () => ({ u_blackDuration: 0.2 }),
  },
  flash: {
    frag: flash,
    uniforms: () => ({ u_flashColor: [1, 1, 1], u_flashHold: 0.1, u_overexposure: 2 }),
  },
  'luma-blend': {
    frag: lumaBlend,
    uniforms: () => ({ u_intensity: 2, u_additiveAmount: 0.5, u_threshold: 0.3 }),
  },
  'soft-wipe': {
    frag: softWipe,
    uniforms: () => ({ u_feather: 0.4, u_parallax: 0.05 }),
  },
  'whip-pan': {
    frag: whipPan,
    uniforms: ({ direction }) => ({
      u_dir: direction === 'right' ? [-1, 0] : direction === 'up' ? [0, -1] : direction === 'down' ? [0, 1] : [1, 0],
      u_blurStrength: 0.15,
      u_bounceback: 0.1,
    }),
  },
  'page-curl': {
    frag: pageCurl,
    uniforms: () => ({
      u_radius: 0.12, // Ai default [0.02, 0.5]
      u_glossiness: 0.6, // Ai default [0, 1]
      u_paperTint: [0.97, 0.95, 0.9], // Paper back color (customized)
    }),
  },
  'rack-focus': {
    frag: rackFocus,
    uniforms: () => ({
      u_blurStrength: 0.5, // Ai default [0, 1]
      u_chromaticAberration: 0.4, // Ai default [0, 1]
      u_contrastLoss: 0.2, // Ai default [0, 1]
    }),
  },
  'organic-dissolve': {
    frag: organicDissolve,
    uniforms: ({ time, aspect }) => ({
      u_ratio: aspect,
      u_time: time,
      u_glowWidth: 0.05, // Ai default [0, 0.5]
      u_depth: 1.8, // Ai default [0.1, 4]
      u_glowColor: [1.0, 0.55, 0.18], // Burning edge orange (customized)
    }),
  },
  'impact-shake': {
    frag: impactShake,
    uniforms: () => ({
      u_shakeIntensity: 0.03, // Ai default [0, 0.2]
      u_zoomPunch: 1.08, // Ai default [1, 2]
      u_chromaticAmount: 0.01, // Ai default [0, 0.1]
    }),
  },
  'anticipation-zoom': {
    frag: anticipationZoom,
    uniforms: () => ({
      u_windupAmount: 0.15, // Ai default [0, 1]
      u_zoomAmount: 6, // Ai default [0, 20]
      u_incomingStartScale: 0.8, // Ai default [0.1, 1]
    }),
  },
  'clean-line-wipe': {
    frag: cleanLineWipe,
    uniforms: ({ direction, width, height, lineColor, lineWidthPx }) => {
      const axisLen = direction === 'up' || direction === 'down'
        ? Math.max(1, height ?? 1080)
        : Math.max(1, width ?? 1920);
      const px = typeof lineWidthPx === 'number' && Number.isFinite(lineWidthPx)
        ? Math.max(1, Math.min(20, lineWidthPx))
        : 3.5;
      return {
        u_dir: direction === 'right' ? [-1, 0] : direction === 'up' ? [0, 1] : direction === 'down' ? [0, -1] : [1, 0],
        u_lineWidth: Math.max(0.0006, px / axisLen),
        u_lineColor: hexToRgbUnit(lineColor, [1, 1, 1]),
      };
    },
  },
  // ── Extended generated library ──────────────────────────────────────────
  'circle-wipe': {
    frag: circleWipe,
    uniforms: () => ({
      u_feather: 0.04,
      u_center: [0.5, 0.5],
    }),
  },
  'radial-blur': {
    frag: radialBlur,
    uniforms: () => ({
      u_blurStrength: 0.22,
      u_center: [0.5, 0.5],
    }),
  },
  'glitch-cut': {
    frag: glitchCut,
    uniforms: ({ time }) => ({
      u_intensity: 1,
      u_time: time,
    }),
  },
  'dip-to-color': {
    frag: dipToColor,
    uniforms: () => ({
      // warm brand flash — bright enough to read on dark library cards
      u_color: [0.95, 0.38, 0.14],
      // short hold so PREVIEW_PROGRESS (~0.42) still shows outgoing + color blend
      u_hold: 0.12,
    }),
  },
};
