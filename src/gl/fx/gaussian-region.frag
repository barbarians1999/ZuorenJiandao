#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform sampler2D u_blurred;
uniform float u_width;
uniform float u_height;
uniform float u_center_x;
uniform float u_center_y;
uniform float u_width_ratio;
uniform float u_height_ratio;
uniform float u_feather;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 res = vec2(u_width, u_height);
  // UI coordinates are top-down; framebuffer UV coordinates are bottom-up.
  vec2 center = vec2(u_center_x, 1.0 - u_center_y) * res;
  vec2 halfSize = vec2(u_width_ratio, u_height_ratio) * res * 0.5;
  vec2 d = abs(v_texCoord * res - center) - halfSize;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  float mask = u_feather > 0.0 ? 1.0 - smoothstep(-u_feather, 0.0, dist) : float(dist <= 0.0);
  fragColor = mix(texture(u_input, v_texCoord), texture(u_blurred, v_texCoord), mask);
}
