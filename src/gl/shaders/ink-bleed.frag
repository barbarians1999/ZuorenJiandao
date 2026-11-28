#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_ratio;
uniform vec2 u_origin;
uniform float u_roughness;

in vec2 v_texCoord;
out vec4 fragColor;

vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float a = dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float val = 0.0;
    float amp = 0.55;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
        val += amp * gradientNoise(p * freq);
        amp *= 0.5;
        freq *= 2.05;
    }
    return val;
}

float cornerDist(vec2 origin, vec2 corner, float ratio) {
    vec2 d = (corner - origin) * vec2(ratio, 1.0);
    return length(d);
}

void main() {
    vec2 uv = v_texCoord;
    vec4 cOut = texture(u_outgoing, uv);
    vec4 cIn = texture(u_incoming, uv);
    if (u_progress <= 0.0001) { fragColor = cOut; return; }
    if (u_progress >= 0.9999) { fragColor = cIn; return; }

    vec2 origin = clamp(u_origin, 0.0, 1.0);
    vec2 delta = (uv - origin) * vec2(u_ratio, 1.0);
    float dist = length(delta);

    float maxDist = max(
        max(cornerDist(origin, vec2(0.0, 0.0), u_ratio), cornerDist(origin, vec2(1.0, 0.0), u_ratio)),
        max(cornerDist(origin, vec2(0.0, 1.0), u_ratio), cornerDist(origin, vec2(1.0, 1.0), u_ratio))
    );

    float macro = fbm(delta * 3.4);
    float fibers = fbm(delta * 13.5) * 0.28;
    float organic = (macro + fibers) * u_roughness;

    float pr = smoothstep(0.0, 1.0, u_progress);
    float radius = mix(-0.35 * u_roughness, maxDist + 0.45 * u_roughness, pr);
    float shape = dist - organic;

    float feather = 0.035;
    float mask = smoothstep(radius + feather, radius - feather, shape);

    // Subtle wet xuan-paper ink absorption fringe along the expanding capillary boundary
    float edgeBand = smoothstep(0.07, 0.0, abs(shape - radius));
    float endpointFade = smoothstep(0.0, 0.08, u_progress) * smoothstep(1.0, 0.90, u_progress);
    vec4 mixed = mix(cOut, cIn, mask);
    mixed.rgb = mix(mixed.rgb, mixed.rgb * 0.48 + vec3(0.05, 0.04, 0.035), edgeBand * 0.42 * endpointFade);

    fragColor = mixed;
}
