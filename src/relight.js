// Relighting for splats. Splats are re-shaded when the unified renderer copies
// them into its work buffer, using precomputed per-splat normals + AO
// (uLightData) and CPU-traced key-light transmittance (uShadow). Both textures
// are 256 texels wide and indexed by the splat's original PLY index.
// The same pass sways tree foliage (uWind) and makes the stream shimmer (uWater).

export const LIGHT_TEX_WIDTH = 256;

export const relightGlsl = /* glsl */ `
uniform sampler2D uLightData;
uniform sampler2D uShadow;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uWrap;
uniform float uRelight;
uniform float uTime;
uniform vec4 uWind;   // xy: horizontal direction, z: sway at the top (m), w: height where the canopy starts
uniform float uWindHeight; // canopy height above uWind.w
uniform float uWater;
uniform vec4 uLamp;       // hand lantern: xyz world position, w intensity (0 = off)
uniform vec3 uLampColor;
uniform float uGlow;      // > 0 on the lantern itself: its warm window glows
uniform sampler2D uHeightMap; // ground mesh heights (ground mesh prototype)
uniform vec4 uHeightBounds;   // xy: grid origin (x, z), z: 1 / grid size, w: 1 = cull splats on the mesh
uniform vec2 uCullBand;       // hide splats from x below to y above the mesh surface

uniform sampler2D uGrassData; // procedural meadow, per splat: r wind weight (0 at the root), g phase
uniform float uGrass;         // meadow sway at full weight (m); 0 on every other instance
uniform float uMirror;        // 1 on the water sheet (land.js): waves, sky reflection and glints
uniform vec3 uEye;            // head position, for the water's view-dependent reflection
uniform vec3 uZenith;         // sky colours, as the sky dome draws them
uniform vec3 uHorizon;

// Water waves: three long, gentle swells (travelling sines) plus short ripples from
// evolving noise, so the small scale has no fixed directions to cross into a lattice.
// Ripples are stronger in gusty patches (cat's paws) that drift with the wind.
// waterWaves returns the height and its x and z slopes.
void waterWave(vec2 p, vec2 dir, float k, float w, float a, inout vec3 sum) {
    float phase = k * dot(p, normalize(dir)) - w * uTime;
    sum += vec3(a * sin(phase), normalize(dir) * (a * k * cos(phase)));
}
float wHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float wNoise(vec3 p) { // 3D value noise: x, z in space, the third axis is time
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x), mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y);
    float b = mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x), mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y);
    return mix(a, b, f.z);
}
vec2 wRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
float ripples(vec2 p) {
    vec2 wind = vec2(0.8, 0.6);
    float paws = 0.35 + 1.3 * smoothstep(0.35, 0.75, wNoise(vec3((p - wind * uTime * 0.35) * 0.3, uTime * 0.05)));
    float h = (wNoise(vec3(wRot(p, 0.4) * 9.0 - wind * uTime * 1.2, uTime * 0.6)) - 0.5) * 0.0024
            + (wNoise(vec3(wRot(p, 1.9) * 17.0 - wind * uTime * 2.0, uTime * 0.9)) - 0.5) * 0.0013
            + (wNoise(vec3(wRot(p, 3.1) * 29.0 - wind * uTime * 2.8, uTime * 1.3)) - 0.5) * 0.0007;
    return h * paws;
}
vec3 waterWaves(vec2 p) {
    vec3 sum = vec3(0.0);
    waterWave(p, vec2(0.8, 0.6), 4.0, 2.4, 0.004, sum);
    waterWave(p, vec2(0.6, 0.8), 7.0, 3.3, 0.0025, sum);
    waterWave(p, vec2(1.0, 0.2), 12.0, 4.4, 0.0015, sum);
    const float e = 0.008; // slopes of the ripples by central differences
    float hx = ripples(p + vec2(e, 0.0)) - ripples(p - vec2(e, 0.0));
    float hz = ripples(p + vec2(0.0, e)) - ripples(p - vec2(0.0, e));
    sum += vec3(ripples(p), hx / (2.0 * e), hz / (2.0 * e));
    return sum;
}
vec3 waterNormal(vec2 p) {
    vec3 g = waterWaves(p);
    return normalize(vec3(-g.y, 1.0, -g.z));
}
vec4 waterQuatMul(vec4 a, vec4 b) {
    return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

// ---- butterflies, bees and fireflies (critters.js). Each splat knows its critter and
// part; each critter its home patch, kind and seed. Splat centres are offsets in the
// critter's frame (x forward, y up, z right), moved here along the critter's path.
uniform float uCritters;         // 1 on the critter instance
uniform sampler2D uCritterData;  // per splat: critter id (r, g), part (b)
uniform sampler2D uCritterPath;  // per critter: home x, ground y, home z, kind + seed
uniform float uDusk;             // 0 by day, 1 from dusk: fireflies out, butterflies and bees away
uniform vec4 uCritterGroundRect;  // the height map in uCritterPath rows 1..: min x, min z, texels per metre, texels per side

// ground height under the critters (the lake at its water level), bilinear
float critterGround(vec2 xz) {
    vec2 g = (xz - uCritterGroundRect.xy) * uCritterGroundRect.z;
    int n = int(uCritterGroundRect.w) - 1;
    ivec2 i0 = clamp(ivec2(floor(g)), ivec2(0), ivec2(n - 1));
    vec2 f = clamp(g - vec2(i0), 0.0, 1.0);
    ivec2 i = i0 + ivec2(0, 1); // row 0 holds the paths
    float a = texelFetch(uCritterPath, i, 0).r, b = texelFetch(uCritterPath, i + ivec2(1, 0), 0).r;
    float c = texelFetch(uCritterPath, i + ivec2(0, 1), 0).r, d = texelFetch(uCritterPath, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

struct Critter { vec3 pos; float yaw; float flap; float show; float kind; float seed; float part; float t; };

vec3 critterOffset(float kind, float seed, float t) {
    float s1 = seed * 6.2832, s2 = fract(seed * 7.31) * 6.2832;
    if (kind < 0.5) {
        // butterfly: lazy loops over its flower patch, rising and dipping
        float r = 1.0 + 1.6 * fract(seed * 3.7);
        return vec3(sin(t * 0.27 + s1) * r + 0.5 * sin(t * 0.71 + s2),
                    0.55 + 0.3 * sin(t * 0.43 + s2) + 0.05 * sin(t * 1.9 + s1),
                    sin(t * 0.21 + s2 + 1.3) * r + 0.5 * cos(t * 0.63 + s1));
    }
    if (kind < 1.5) {
        // bee: quick darts low over the flowers, with hovering pauses
        float tw = t + 0.6 * sin(t * 1.3 + s1);
        float r = 0.5 + 0.8 * fract(seed * 5.3);
        return vec3(sin(tw * 0.9 + s1) * r + 0.15 * sin(tw * 4.1 + s2),
                    0.3 + 0.12 * sin(tw * 1.7 + s2),
                    sin(tw * 1.13 + s2) * r + 0.15 * cos(tw * 3.7 + s1));
    }
    // firefly: a slow drift low over the grass
    float r = 0.6 + 1.0 * fract(seed * 4.1);
    return vec3(sin(t * 0.13 + s1) * r + 0.2 * sin(t * 0.5 + s2),
                0.5 + 0.45 * sin(t * 0.17 + s2) + 0.1 * sin(t * 0.9 + s1),
                cos(t * 0.11 + s2) * r + 0.2 * cos(t * 0.43 + s1));
}

Critter critter() {
    Critter k;
    vec4 d = texelFetch(uCritterData, ivec2(int(splat.index & 255u), int(splat.index >> 8u)), 0);
    int id = int(d.r * 255.0 + 0.5) + int(d.g * 255.0 + 0.5) * 256;
    k.part = floor(d.b * 255.0 + 0.5);
    vec4 home = texelFetch(uCritterPath, ivec2(id, 0), 0);
    k.kind = floor(home.w);
    k.seed = fract(home.w);
    k.t = uTime + k.seed * 100.0;
    vec3 p0 = critterOffset(k.kind, k.seed, k.t), p1 = critterOffset(k.kind, k.seed, k.t + 0.05);
    vec3 v = p1 - p0;
    k.yaw = atan(-v.z, v.x); // face where it flies
    if (k.kind < 0.5) {
        // wingbeats, now and then a glide with the wings held up in a V
        float beating = smoothstep(-0.3, 0.3, sin(k.t * 0.8 + k.seed * 20.0));
        float beat = sin(k.t * 6.2832 * 6.5);
        k.flap = 0.35 + 0.8 * beat * beating + 0.25 * (1.0 - beating);
        p0.y += 0.012 * beat * beating; // bobbing with each beat
    } else if (k.kind < 1.5) {
        k.flap = 0.35 + 0.45 * sin(k.t * 6.2832 * 23.0);
    } else {
        k.flap = 0.0;
    }
    // height above the ground right under it, not above its home, so it never dives into a slope
    k.pos = vec3(home.x + p0.x, 0.0, home.z + p0.z);
    // at least 12 cm above the ground or, over the lake, above the water (the map counts the water level)
    k.pos.y = critterGround(k.pos.xz) + max(p0.y, 0.12);
    float day = 1.0 - smoothstep(0.1, 0.6, uDusk);
    k.show = k.kind < 1.5 ? day : smoothstep(0.3, 0.9, uDusk);
    return k;
}

vec3 critterRotate(vec3 v, Critter k) {
    // wings: about the body axis, both wings up for a positive flap (the right wing sits at
    // +z, so it turns by -flap; the left is mirrored)
    float a = k.part == 1.0 ? -k.flap : (k.part == 2.0 ? k.flap : 0.0);
    v = vec3(v.x, v.y * cos(a) - v.z * sin(a), v.y * sin(a) + v.z * cos(a));
    // heading: about up
    return vec3(v.x * cos(k.yaw) + v.z * sin(k.yaw), v.y, -v.x * sin(k.yaw) + v.z * cos(k.yaw));
}

vec3 relightRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void modifySplatCenter(inout vec3 center) {
    if (uCritters > 0.5) {
        Critter k = critter();
        center = k.pos + critterRotate(center, k);
        return;
    }
    if (uMirror > 0.5) {
        center.y += waterWaves(center.xz).x;
        return;
    }
    if (uWind.z > 0.0) {
        // only the canopy moves: zero at the canopy base (trunk stays still), growing towards the top
        float h = clamp((center.y - uWind.w) / uWindHeight, 0.0, 1.0);
        float bend = h * h;
        float gust = 0.6 + 0.4 * sin(uTime * 0.45) * sin(uTime * 0.17 + 1.3);
        float sway = sin(uTime * 1.1) * 0.7 + sin(uTime * 1.9 + 0.8) * 0.3;
        // slow rustle, smooth in space so neighbouring leaves move together
        float rustle = sin(uTime * 2.1 + dot(center, vec3(1.3, 0.9, 1.7))) * 0.012 * h;
        center.xz += uWind.xy * (uWind.z * bend * gust * sway) + rustle;
    }
    if (uGrass > 0.0) {
        // gust fronts roll across the meadow along the wind; each blade adds its own flutter
        vec4 gd = texelFetch(uGrassData, ivec2(int(splat.index & 255u), int(splat.index >> 8u)), 0);
        float gust = 0.6 + 0.4 * sin(uTime * 0.45) * sin(uTime * 0.17 + 1.3); // in step with the trees
        float front = sin(dot(center.xz, uWind.xy) * 0.8 - uTime * 2.3) * 0.5 + 0.5;
        float flutter = sin(uTime * 3.7 + gd.g * 6.2832) * 0.3;
        center.xz += uWind.xy * (uGrass * gd.r * (0.25 + gust * front * front + flutter));
    }
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    if (uCritters > 0.5) {
        Critter k = critter();
        float a = k.part == 1.0 ? -k.flap : (k.part == 2.0 ? k.flap : 0.0);
        vec4 flap = vec4(sin(a * 0.5), 0.0, 0.0, cos(a * 0.5));
        vec4 heading = vec4(0.0, sin(k.yaw * 0.5), 0.0, cos(k.yaw * 0.5));
        rotation = waterQuatMul(heading, waterQuatMul(flap, rotation));
        scale *= k.show; // gone when it's not their time of day
        return;
    }
    if (uMirror > 0.5) {
        // tilt the flat splat from straight up to the wave normal
        vec3 n = waterNormal(originalCenter.xz);
        rotation = waterQuatMul(normalize(vec4(n.z, 0.0, -n.x, 1.0 + n.y)), rotation);
        return;
    }
    if (uHeightBounds.w > 0.5) {
        // ground splats lying on the mesh are drawn by the mesh: shrink them away
        ivec2 size = textureSize(uHeightMap, 0);
        vec2 uv = (originalCenter.xz - uHeightBounds.xy) * uHeightBounds.z;
        ivec2 tc = clamp(ivec2(uv * vec2(size - 1) + 0.5), ivec2(0), size - 1);
        float d = originalCenter.y - texelFetch(uHeightMap, tc, 0).r;
        if (d > -uCullBand.x && d < uCullBand.y) scale = vec3(0.0);
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    ivec2 tc = ivec2(int(splat.index & 255u), int(splat.index >> 8u));
    if (uCritters > 0.5) {
        Critter k = critter();
        if (k.part >= 3.0) {
            // firefly: glows on its own, a short pulse every few seconds
            float period = 2.5 + 3.0 * fract(k.seed * 9.1);
            float ph = fract(k.t / period);
            float blink = smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.15, 0.45, ph));
            color.rgb *= 0.2 + 1.3 * blink;
            color.a *= k.part == 3.0 ? 0.3 + 0.7 * blink : blink;
            return;
        }
        // butterflies and bees fall through to the ordinary lighting below
    }
    if (uMirror > 0.5) {
        // water: the body colour seen straight down, the sky mirrored at grazing angles
        // (Schlick Fresnel), sharp sun or moon glints and the lantern's reflection
        vec3 n = waterNormal(center.xz);
        vec3 e = normalize(uEye - center);
        vec3 r = reflect(-e, n);
        float up = abs(r.y);
        vec3 sky = mix(uHorizon, uZenith, pow(up, 0.5));
        // just above the horizon the reflection shows the far shore and hills
        sky = mix(uGroundColor * vec3(0.35, 0.5, 0.25) + uSkyColor * 0.12, sky, smoothstep(0.0, 0.07, up));
        float shadow = texelFetch(uShadow, tc, 0).r;
        float toSun = max(dot(r, uSunDir), 0.0);
        vec3 spec = uSunColor * (pow(toSun, 900.0) * 24.0 + pow(toSun, 60.0) * 0.35) * shadow;
        if (uLamp.w > 0.0) {
            vec3 l = uLamp.xyz - center;
            float d2 = dot(l, l);
            vec3 h = normalize(l * inversesqrt(max(d2, 1e-4)) + e);
            spec += uLampColor * uLamp.w * pow(max(dot(n, h), 0.0), 300.0) * 8.0 / (1.0 + 0.5 * d2);
        }
        float fresnel = 0.04 + 0.96 * pow(1.0 - max(dot(n, e), 0.0), 3.0);
        vec3 body = color.rgb * (uSkyColor + uSunColor * max(uSunDir.y, 0.0) * shadow * 0.6);
        vec3 lit = mix(body, sky, fresnel) + spec;
        color.rgb = mix(color.rgb, lit, uRelight);
        color.a = min(1.0, color.a * (0.7 + 0.6 * fresnel) + dot(spec, vec3(0.3)));
        return;
    }
    vec4 ld = texelFetch(uLightData, tc, 0);
    vec3 n = normalize(relightRotate(model_rotation, ld.xyz * 2.0 - 1.0));
    float ao = ld.w;
    float shadow = texelFetch(uShadow, tc, 0).r;

    // stream: blue splats get travelling ripples and sun glints
    float water = 0.0;
    float glint = 0.0;
    if (uWater > 0.5) {
        water = smoothstep(0.04, 0.14, color.b - max(color.r, color.g * 0.92));
        if (water > 0.0) {
            vec2 p = center.xz;
            float w1 = sin(dot(p, vec2(1.7, 0.6)) * 2.2 - uTime * 2.4);
            float w2 = sin(dot(p, vec2(-0.5, 1.9)) * 2.9 - uTime * 1.9);
            float w3 = sin(dot(p, vec2(1.1, -1.3)) * 5.3 + uTime * 3.3);
            float ripple = (w1 + w2 + w3) / 3.0;
            color.rgb *= 1.0 + 0.18 * ripple * water;
            glint = pow(max(w1 * w2 * w3, 0.0), 3.0) * water;
        }
    }

    float diffuse = max((dot(n, uSunDir) + uWrap) / (1.0 + uWrap), 0.0);
    vec3 ambient = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5) * ao;
    vec3 light = ambient + uSunColor * diffuse * shadow * mix(1.0, ao, 0.5);

    // lantern: warm point light with soft falloff, fading out by about 6 m
    if (uLamp.w > 0.0) {
        vec3 toLamp = uLamp.xyz - center;
        float d2 = dot(toLamp, toLamp);
        float falloff = uLamp.w / (1.0 + 1.5 * d2) * (1.0 - smoothstep(16.0, 36.0, d2));
        float facing = max(dot(n, toLamp * inversesqrt(max(d2, 1e-4))) * 0.6 + 0.4, 0.0);
        light += uLampColor * falloff * facing * mix(1.0, ao, 0.5);
    }

    vec3 relit = color.rgb * light + glint * 1.4 * uSunColor * shadow;
    if (uGlow > 0.0) {
        float warm = smoothstep(0.5, 0.75, color.r) * smoothstep(0.05, 0.25, color.r - color.b);
        relit = mix(relit, color.rgb * 1.7, warm * uGlow);
    }
    vec3 original = color.rgb + glint * 0.6;
    color.rgb = mix(original, relit, uRelight);
}
`;

// Sun direction for a time of day (hours). Rises in the east (+x) at about 6:40,
// peaks in the south (+z) at about 50 degrees and sets in the west at about 17:20.
export function sunDirection(hours) {
    const h = (hours - 12) / 24 * Math.PI * 2;
    const tilt = Math.PI / 6;
    const d = [-Math.sin(h), Math.cos(h) * Math.cos(tilt) - 0.08, Math.cos(h) * Math.sin(tilt)];
    const len = Math.hypot(...d);
    return d.map(v => v / len);
}

// Colours by sun elevation (degrees). key: key-light colour (sun, or moon at night),
// sky/ground: hemisphere ambient, clear: horizon colour, zenith: overhead sky colour.
const ROWS = [
    { el: -15, key: [0.24, 0.3, 0.46], sky: [0.06, 0.08, 0.14], ground: [0.03, 0.03, 0.04], clear: [0.03, 0.04, 0.09], zenith: [0.005, 0.01, 0.03] },
    { el: -6, key: [0.18, 0.2, 0.32], sky: [0.1, 0.1, 0.18], ground: [0.04, 0.04, 0.05], clear: [0.16, 0.12, 0.22], zenith: [0.03, 0.04, 0.12] },
    { el: -2, key: [0.4, 0.25, 0.22], sky: [0.22, 0.18, 0.28], ground: [0.08, 0.07, 0.07], clear: [0.62, 0.34, 0.36], zenith: [0.12, 0.14, 0.32] },
    { el: 3, key: [1.3, 0.7, 0.36], sky: [0.36, 0.34, 0.44], ground: [0.2, 0.15, 0.12], clear: [0.95, 0.6, 0.4], zenith: [0.26, 0.36, 0.6] },
    { el: 16, key: [1.05, 0.86, 0.66], sky: [0.42, 0.48, 0.6], ground: [0.22, 0.2, 0.16], clear: [0.7, 0.74, 0.84], zenith: [0.3, 0.48, 0.78] },
    { el: 35, key: [0.8, 0.78, 0.72], sky: [0.46, 0.52, 0.62], ground: [0.26, 0.24, 0.2], clear: [0.62, 0.77, 0.95], zenith: [0.22, 0.44, 0.85] }
];
const HANDOVER = -2; // sun hands the key light to the moon at this elevation

// Lighting for a sun direction. Below the horizon the moon (opposite the sun)
// becomes the key light; the key fades to zero around the handover.
export function lightingForSun(sunDir) {
    const el = Math.asin(Math.max(-1, Math.min(1, sunDir[1]))) * 180 / Math.PI;
    let i = 0;
    while (i < ROWS.length - 2 && el > ROWS[i + 1].el) i++;
    const a = ROWS[i], b = ROWS[i + 1];
    const t = Math.max(0, Math.min(1, (el - a.el) / (b.el - a.el)));
    const mix = (x, y) => x.map((v, k) => v + (y[k] - v) * t);
    const fade = Math.min(1, Math.abs(el - HANDOVER) / 3);
    const moon = el < HANDOVER;
    const raw = moon ? sunDir.map(v => -v) : [...sunDir];
    raw[1] = Math.max(raw[1], 0.03);
    const len = Math.hypot(...raw);
    return {
        moon,
        elevation: el,
        sunColor: mix(a.key, b.key), // unfaded, for the sky glow
        zenith: mix(a.zenith, b.zenith),
        keyDir: raw.map(v => v / len),
        key: mix(a.key, b.key).map(v => v * fade),
        sky: mix(a.sky, b.sky),
        ground: mix(a.ground, b.ground),
        clear: mix(a.clear, b.clear)
    };
}

// Times the A button / number keys jump to.
export const TIME_PRESETS = [
    { name: 'Morning', hours: 7.6 },
    { name: 'Noon', hours: 13 },
    { name: 'Golden hour', hours: 17.1 },
    { name: 'Night', hours: 0.5 }
];

// Day/night cycle speed by sun elevation: slow through dawn and dusk, quick
// through the middle of the day, normal at night.
const RATE = [[-90, 1], [-18, 1], [-12, 0.35], [12, 0.35], [24, 1.9], [90, 1.9]];
export function timeRate(elevation) {
    let i = 0;
    while (i < RATE.length - 2 && elevation > RATE[i + 1][0]) i++;
    const [e0, r0] = RATE[i], [e1, r1] = RATE[i + 1];
    return r0 + (r1 - r0) * Math.max(0, Math.min(1, (elevation - e0) / (e1 - e0)));
}

export const formatTime = (hours) => {
    const m = Math.floor((((hours % 24) + 24) % 24) * 60);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Sharper splat footprint, applied per fragment to every splat. The default
// kernel is exp(-4 r^2); this raises the falloff to a power (super-Gaussian),
// so each splat gets a flatter core and a crisper edge. Hard edges lose the
// overlap that the soft tails provided, so cover grows the half-intensity
// radius to close the gaps. p 1 / cover 1 is the original Gaussian.
export const SHARPNESS_LEVELS = [
    { name: 'original', p: 1, cover: 1 },
    { name: 'soft', p: 1.6, cover: 1.05 },
    { name: 'crisp', p: 2.4, cover: 1.12 },
    { name: 'painterly', p: 3.5, cover: 1.2 },
    { name: 'max', p: 12, cover: 1.35 },
    // experiment: each splat drawn as a soft-edged rectangle along its own axes
    { name: 'rectangles', p: 2, cover: 1, rect: 1 }
];

// Overdraw view: every splat fragment that survives the alpha clip adds the
// same colour, so brightness counts the layers drawn per pixel: dark red 4,
// red 8, orange 16, yellow 32, white 64+. Premultiplied blending keeps
// dst * (1 - a), so with a tiny alpha each layer simply adds rgb * a. The
// blue channel holds layers / 128, which the desktop readout decodes.
const OVERDRAW_ALPHA = '(1.0 / 1024.0)';
export const OVERDRAW_BLUE_LAYERS = 128;
export const overdrawGlsl = /* glsl */ `
void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    color = vec4(vec3(1.0 / 8.0, 1.0 / 32.0, 1.0 / 128.0) / ${OVERDRAW_ALPHA}, ${OVERDRAW_ALPHA});
}
`;

export const sharpenGlsl = /* glsl */ `
uniform float uSharpness;
uniform float uCover;
uniform float uRect;

void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    if (uRect > 0.5) {
        // box instead of ellipse: the larger axis decides, with a thin soft edge
        vec2 q = abs(gaussianUV);
        float m = max(q.x, q.y);
        color.a = gaussianColor.a * (1.0 - smoothstep(0.38, 0.46, m));
    } else if (uSharpness > 1.0) {
        // (r / r_half)^2 with r_half^2 = ln2 / 4, widened by uCover
        float q = dot(gaussianUV, gaussianUV) / (0.1733 * uCover * uCover);
        color.a = gaussianColor.a * exp(-0.6931 * pow(q, uSharpness));
    }
}
`;
