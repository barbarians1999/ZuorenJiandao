#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_aspect;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
    vec4 a = texture(u_outgoing, v_texCoord);
    vec4 b = texture(u_incoming, v_texCoord);
    if (u_progress <= 0.0) { fragColor = a; return; }
    if (u_progress >= 1.0) { fragColor = b; return; }
    vec2 cell = floor(v_texCoord * vec2(12.0 * max(u_aspect, 0.1), 12.0));
    float seed = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
    // Stable per-cell order; only timeline progress changes the result.
    float threshold = 0.04 + seed * 0.84;
    float reveal = smoothstep(threshold, threshold + 0.12, u_progress);
    fragColor = mix(a, b, reveal);
}
