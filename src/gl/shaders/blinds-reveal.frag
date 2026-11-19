#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform vec2 u_axis;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
    vec4 a = texture(u_outgoing, v_texCoord);
    vec4 b = texture(u_incoming, v_texCoord);
    if (u_progress <= 0.0) { fragColor = a; return; }
    if (u_progress >= 1.0) { fragColor = b; return; }
    float position = dot(v_texCoord, u_axis);
    float distanceToCenter = abs(fract(position * 10.0) - 0.5) * 2.0;
    float p = u_progress * u_progress * (3.0 - 2.0 * u_progress);
    float reveal = 1.0 - smoothstep(p - 0.025, p + 0.025, distanceToCenter);
    fragColor = mix(a, b, reveal);
}
