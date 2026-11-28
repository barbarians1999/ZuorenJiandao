#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform vec2 u_dir;
uniform vec3 u_lineColor;
uniform float u_lineWidthUv;

in vec2 v_texCoord;
out vec4 fragColor;

float hermiteEase(float t) {
    float c = clamp(t, 0.0, 1.0);
    return c * c * c * (10.0 - c * (15.0 - 6.0 * c));
}

void main() {
    vec2 uv = v_texCoord;
    vec4 cOut = texture(u_outgoing, uv);
    vec4 cIn = texture(u_incoming, uv);
    if (u_progress <= 0.0001) { fragColor = cOut; return; }
    if (u_progress >= 0.9999) { fragColor = cIn; return; }

    float p = hermiteEase(u_progress);
    float coord = 0.0;
    if (abs(u_dir.x) >= abs(u_dir.y)) {
        coord = u_dir.x >= 0.0 ? uv.x : (1.0 - uv.x);
    } else {
        coord = u_dir.y >= 0.0 ? uv.y : (1.0 - uv.y);
    }

    float lw = max(0.0006, u_lineWidthUv);
    float pos = p * (1.0 + lw * 2.0) - lw;
    float edge = smoothstep(pos + 0.0008, pos - 0.0008, coord);
    vec4 baseColor = mix(cOut, cIn, edge);

    float dist = abs(coord - pos);
    float lineAlpha = smoothstep(lw * 0.75, lw * 0.25, dist);
    float endpointFade = smoothstep(0.0, 0.05, u_progress) * smoothstep(1.0, 0.95, u_progress);
    vec3 finalRgb = mix(baseColor.rgb, u_lineColor, lineAlpha * endpointFade);

    fragColor = vec4(finalRgb, baseColor.a);
}
