#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform vec2 u_axis;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
    vec2 uv = v_texCoord;
    if (u_progress <= 0.0) { fragColor = texture(u_outgoing, uv); return; }
    if (u_progress >= 1.0) { fragColor = texture(u_incoming, uv); return; }
    float p = u_progress * u_progress * (3.0 - 2.0 * u_progress);
    float position = dot(uv, u_axis);
    float side = position < 0.5 ? 1.0 : -1.0;
    float shifted = position + side * p * 0.5;
    bool remains = position < 0.5 ? shifted < 0.5 : shifted >= 0.5;
    fragColor = remains ? texture(u_outgoing, uv + u_axis * side * p * 0.5) : texture(u_incoming, uv);
}
