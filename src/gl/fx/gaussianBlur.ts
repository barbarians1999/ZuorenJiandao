import type { FxDef } from './uniforms';

/** A normalized discrete Gaussian. Adjacent positive taps are paired for
 * linear texture sampling: same convolution, roughly half the texture reads.
 * Integer sigma bounds the shader cache to 24 variants while dragging. */
export function gaussianKernel(strength: number) {
  const safe = Number.isFinite(strength) ? Math.max(1, Math.min(100, strength)) : 70;
  const sigma = Math.max(1, Math.round(safe * .24));
  const radius = sigma * 3;
  const weights = Array.from({ length: radius + 1 }, (_, index) => Math.exp(-(index ** 2) / (2 * sigma ** 2)));
  const total = weights[0]! + 2 * weights.slice(1).reduce((sum, value) => sum + value, 0);
  const normalized = weights.map((value) => value / total);
  const pairs: Array<{ offset: number; weight: number }> = [];
  for (let index = 1; index <= radius; index += 2) {
    const first = normalized[index]!, second = normalized[index + 1] ?? 0;
    const weight = first + second;
    pairs.push({ weight, offset: index + second / weight });
  }
  return { sigma, radius, weights: normalized, center: normalized[0]!, pairs };
}

export function gaussianFragment(strength: number) {
  const kernel = gaussianKernel(strength);
  const number = (value: number) => value.toFixed(10);
  return `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_direction;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 stepUV = u_direction / u_resolution;
  vec4 sum = texture(u_input, v_texCoord) * ${number(kernel.center)};
  ${kernel.pairs.map((pair) => `sum += (texture(u_input, v_texCoord + stepUV * ${number(pair.offset)}) + texture(u_input, v_texCoord - stepUV * ${number(pair.offset)})) * ${number(pair.weight)};`).join('\n  ')}
  fragColor = sum;
}`;
}

export function gaussianBlurDefinition(copy: string, composite: string): FxDef {
  return {
    id: 'builtin:fx-local-gaussian-blur', name: '高斯模糊',
    desc: '局部或全屏高斯模糊，可调整强度、位置、尺寸和边缘羽化。',
    frag: copy,
    pipeline: (uniforms) => {
      const strength = typeof uniforms.u_strength === 'number' ? uniforms.u_strength : 70;
      const blur = gaussianFragment(strength);
      return [
        { frag: copy },
        { frag: blur, uniforms: { u_direction: [1, 0] } },
        { frag: blur, uniforms: { u_direction: [0, 1] } },
        { frag: composite, inputFrom: 0, samplers: { u_blurred: 2 }, uniforms },
      ];
    },
    props: [
      { key: 'center_x', label: '水平位置', default: .5, min: 0, max: 1, step: .01 },
      { key: 'center_y', label: '垂直位置', default: .5, min: 0, max: 1, step: .01 },
      { key: 'width_ratio', label: '宽度', default: .35, min: .01, max: 1, step: .01 },
      { key: 'height_ratio', label: '高度', default: .35, min: .01, max: 1, step: .01 },
      { key: 'strength', label: '模糊强度', default: 70, min: 1, max: 100, step: 1 },
      { key: 'feather', label: '羽化', default: 0, min: 0, max: 100, step: 1 },
    ],
  };
}
