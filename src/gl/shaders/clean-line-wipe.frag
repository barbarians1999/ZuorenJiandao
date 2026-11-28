#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_lineWidth;
uniform vec3 u_lineColor;
uniform vec2 u_dir;
in vec2 v_texCoord;
out vec4 fragColor;
// Custom bezier-like easing: slow start, fast middle, slow end with overshoot feel
float customEase(float t) {
    // Approximate cubic-bezier(0.7, 0, 0.3, 1) - fast in the middle
    float t2 = t * t;
    float t3 = t2 * t;
    // Hermite interpolation with strong acceleration in center
    return t3 * (10.0 - 15.0 * t + 6.0 * t2);
}
void main() {
    vec4 cOut = texture(u_outgoing, v_texCoord);
    vec4 cIn  = texture(u_incoming, v_texCoord);
    if (u_progress <= 0.0001) { fragColor = cOut; return; }
    if (u_progress >= 0.9999) { fragColor = cIn; return; }
    float p = customEase(u_progress);
    float coord = 0.0;
    if (abs(u_dir.x) >= abs(u_dir.y)) {
        coord = u_dir.x >= 0.0 ? v_texCoord.x : (1.0 - v_texCoord.x);
    } else {
        coord = u_dir.y >= 0.0 ? v_texCoord.y : (1.0 - v_texCoord.y);
    }
    float lw = max(0.0006, u_lineWidth);
    // Line position sweeps across the screen
    float pos = p * (1.0 + lw * 2.0) - lw;
    // Clean wipe split
    vec4 baseColor = mix(cIn, cOut, step(pos, coord));
    // Line at the wipe edge
    float dist = abs(coord - pos);
    float line = smoothstep(lw, lw * 0.3, dist);
    vec3 finalColor = mix(baseColor.rgb, u_lineColor, line);
    fragColor = vec4(finalColor, baseColor.a);
}
