import * as pc from 'playcanvas';

// Procedural sky dome that follows the camera: horizon-to-zenith gradient,
// sun and moon discs with glow, drifting clouds (mostly by day) and twinkling
// stars at night. Colours are in the same space as the clear colour.

const vertexGLSL = /* glsl */ `
attribute vec3 aPosition;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vDir;

void main(void) {
    vDir = aPosition;
    gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);
}
`;

const fragmentGLSL = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunUp;      // 0..1, sun above the horizon
uniform vec3 uMoonDir;
uniform float uNight;      // 0..1, how dark it is (stars, moon)
uniform float uTime;

uniform sampler2D uCloudNoise;

float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main(void) {
    vec3 dir = normalize(vDir);
    float up = dir.y;

    // gradient: horizon colour low, zenith colour high; below the horizon fades darker
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.55));
    if (up < 0.0) sky = mix(uHorizon, uHorizon * 0.35, clamp(-up * 3.0, 0.0, 1.0));

    // warm glow around the sun, strongest when it is low
    float sd = max(dot(dir, uSunDir), 0.0);
    float low = 1.0 - clamp(uSunDir.y * 2.5, 0.0, 1.0);
    sky += uSunColor * (pow(sd, 6.0) * 0.35 * low + pow(sd, 64.0) * 0.4) * uSunUp;

    // stars above the horizon: a few per coarse cell, each kept away from the
    // cell edge so it is never clipped, a few pixels wide and slowly breathing
    vec3 stars = vec3(0.0);
    if (uNight > 0.0 && up > 0.0) {
        vec3 cell = floor(dir * 120.0);
        float h = hash(cell);
        if (h > 0.986) {
            vec3 jitter = vec3(hash(cell + 3.1), hash(cell + 5.7), hash(cell + 9.3));
            vec3 centre = normalize((cell + 0.3 + 0.4 * jitter) / 120.0);
            float d = length(dir - centre) * 120.0;
            float twinkle = 0.88 + 0.12 * sin(uTime * (0.4 + h * 0.8) + jitter.x * 30.0);
            vec3 c = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.75), jitter.y);
            float bright = 0.35 + 0.65 * (h - 0.986) / 0.014;
            stars = c * smoothstep(0.3, 0.05, d) * twinkle * bright * 1.3;
        }
        stars *= uNight * smoothstep(0.0, 0.15, up);
    }

    // sun and moon discs
    float sunDisc = smoothstep(0.99975, 0.99985, dot(dir, uSunDir)) * uSunUp;
    float moonDot = dot(dir, uMoonDir);
    float moonDisc = smoothstep(0.99980, 0.99988, moonDot) * uNight;
    float moonGlow = pow(max(moonDot, 0.0), 200.0) * 0.12 * uNight;

    // clouds on a curved layer above the island
    float cloud = 0.0;
    vec3 cloudCol = vec3(0.0);
    if (up > 0.0) {
        vec2 p = dir.xz / (up + 0.12) * 0.4 + vec2(uTime * 0.003, uTime * 0.00125);
        float n = texture2D(uCloudNoise, p).r;
        float coverage = mix(0.62, 0.72, uNight); // fewer clouds at night
        cloud = smoothstep(coverage, coverage + 0.18, n) * smoothstep(0.0, 0.18, up);
        float thick = smoothstep(coverage, coverage + 0.35, n);
        vec3 lit = uHorizon * 0.7 + uSunColor * 0.55 * uSunUp + uZenith * 0.3;
        vec3 shade = mix(uZenith, uHorizon, 0.5) * 0.55;
        cloudCol = mix(lit, shade, thick * 0.6);
        // silver lining towards the sun
        cloudCol += uSunColor * pow(sd, 12.0) * 0.6 * uSunUp * (1.0 - thick);
    }

    vec3 col = sky + stars;
    col = mix(col, vec3(1.0, 0.96, 0.85) * 1.4, sunDisc);
    col += vec3(0.85, 0.88, 1.0) * moonGlow;
    col = mix(col, vec3(0.88, 0.9, 0.96), moonDisc);
    col = mix(col, cloudCol, cloud * 0.92);
    gl_FragColor = vec4(col, 1.0);
}
`;

// Tileable 5-octave value-noise fbm, baked once so the sky shader only does a
// texture lookup per pixel (the per-pixel fbm was too heavy at Quest resolution).
function cloudNoiseTexture(device, size = 256) {
    const tex = new pc.Texture(device, {
        name: 'cloudNoise', width: size, height: size, format: pc.PIXELFORMAT_R8,
        mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT,
        minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR
    });
    const data = tex.lock();
    const v = new Float32Array(size * size);
    let amp = 0.5;
    for (let period = 4; period <= 64; period *= 2, amp *= 0.5) {
        const lattice = Float32Array.from({ length: period * period }, Math.random);
        const at = (i, j) => lattice[(j % period) * period + (i % period)];
        for (let y = 0; y < size; y++) {
            const fy = y / size * period, j = Math.floor(fy), ty = fy - j, uy = ty * ty * (3 - 2 * ty);
            for (let x = 0; x < size; x++) {
                const fx = x / size * period, i = Math.floor(fx), tx = fx - i, ux = tx * tx * (3 - 2 * tx);
                const top = at(i, j) + (at(i + 1, j) - at(i, j)) * ux;
                const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * ux;
                v[y * size + x] += amp * (top + (bottom - top) * uy);
            }
        }
    }
    for (let k = 0; k < v.length; k++) data[k] = Math.round(Math.min(1, v[k]) * 255);
    tex.unlock();
    return tex;
}

export function createSky(app) {
    const material = new pc.ShaderMaterial({
        uniqueName: 'ProceduralSky',
        vertexGLSL,
        fragmentGLSL,
        attributes: { aPosition: pc.SEMANTIC_POSITION }
    });
    material.cull = pc.CULLFACE_FRONT;
    material.depthWrite = false;
    material.setParameter('uCloudNoise', cloudNoiseTexture(app.graphicsDevice));
    material.update();

    const entity = new pc.Entity('sky');
    entity.addComponent('render', { type: 'sphere', material, castShadows: false, receiveShadows: false });
    entity.setLocalScale(900, 900, 900);
    for (const mi of entity.render.meshInstances) mi.cull = false;
    app.root.addChild(entity);

    const set = (name, v) => material.setParameter(name, Array.isArray(v) ? new Float32Array(v) : v);
    return {
        // follow the camera so the dome never gets closer
        follow(position) {
            entity.setPosition(position);
        },
        update({ zenith, horizon, sunDir, sunColor, sunUp, moonDir, night, time }) {
            set('uZenith', zenith);
            set('uHorizon', horizon);
            set('uSunDir', sunDir);
            set('uSunColor', sunColor);
            set('uSunUp', sunUp);
            set('uMoonDir', moonDir);
            set('uNight', night);
            set('uTime', time);
        }
    };
}
