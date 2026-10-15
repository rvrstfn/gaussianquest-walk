import * as pc from 'playcanvas';

// Ground as an opaque heightmap mesh, textured with a top-down bake of the splat
// terrain and lit like the splats (sun or moon with traced shadows, hemisphere
// ambient, the hand lantern, stream ripples). It costs one opaque layer of pixels
// instead of many blended splats; the splats that stand out of the surface stay.

// Relief (synthetic world): a baked displacement map over the walkable square, decoded
// as (r - 0.5) * range metres. The coarse mesh takes a smoothed (mip) level of it; the
// near patch around the player takes full detail.
const reliefGLSL = /* glsl */ `
uniform sampler2D uDispTex;
uniform vec4 uReliefRect; // xy: min x, z of the baked square, z: 1 / its size, w: 1 = on
uniform vec2 uRelief;     // x: decode range (m), y: mip level for the coarse mesh
float relief(vec2 xz, float lod) {
    vec2 uv = (xz - uReliefRect.xy) * uReliefRect.z;
    if (uReliefRect.w < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    return (textureLod(uDispTex, uv, lod).r - 0.5) * uRelief.x;
}
`;

const vertexGLSL = /* glsl */ `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vPos;
varying vec3 vNormal;
varying vec2 vUv;
${reliefGLSL}
void main(void) {
    vec4 world = matrix_model * vec4(aPosition, 1.0);
    world.y += relief(world.xz, uRelief.y);
    vPos = world.xyz;
    vNormal = aNormal;
    vUv = aUv0;
    gl_Position = matrix_viewProjection * world;
}
`;

// The near patch: a dense grid that follows the player (snapped to its own cells so it
// doesn't swim), with the hills read from the coarse mesh's height grid and the relief
// in full detail, blending to the coarse mesh's smoothed relief at its edge. Normals
// come from the displaced surface, so the bumps catch the light.
const nearVertexGLSL = /* glsl */ `
attribute vec3 aPosition;
uniform mat4 matrix_viewProjection;
uniform vec2 uNearOrigin;
uniform float uNearSize;
uniform sampler2D uHeightTex;
uniform vec4 uHeightGrid;  // min x, min z, step, nodes per side
uniform vec4 uAlbedoRect;  // min x, min z, 1 / size of the coarse mesh
varying vec3 vPos;
varying vec3 vNormal;
varying vec2 vUv;
${reliefGLSL}
float hills(vec2 xz) {
    vec2 g = (xz - uHeightGrid.xy) / uHeightGrid.z;
    int n = int(uHeightGrid.w) - 1;
    ivec2 i = clamp(ivec2(floor(g)), ivec2(0), ivec2(n - 1));
    vec2 f = clamp(g - vec2(i), 0.0, 1.0);
    float a = texelFetch(uHeightTex, i, 0).r, b = texelFetch(uHeightTex, i + ivec2(1, 0), 0).r;
    float c = texelFetch(uHeightTex, i + ivec2(0, 1), 0).r, d = texelFetch(uHeightTex, i + ivec2(1, 1), 0).r;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float ground(vec2 xz, float lod) { return hills(xz) + relief(xz, lod); }
void main(void) {
    vec2 xz = uNearOrigin + aPosition.xz;
    vec2 toEdge = min(xz - uNearOrigin, uNearOrigin + uNearSize - xz);
    float lod = mix(uRelief.y, 0.0, smoothstep(0.1, 1.2, min(toEdge.x, toEdge.y)));
    const float e = 0.03;
    float h = ground(xz, lod);
    vNormal = normalize(vec3(ground(xz - vec2(e, 0.0), lod) - ground(xz + vec2(e, 0.0), lod), 2.0 * e,
                             ground(xz - vec2(0.0, e), lod) - ground(xz + vec2(0.0, e), lod)));
    vPos = vec3(xz.x, h + 0.003, xz.y);
    vUv = (xz - uAlbedoRect.xy) * uAlbedoRect.z;
    gl_Position = matrix_viewProjection * vec4(vPos, 1.0);
}
`;

const fragmentGLSL = /* glsl */ `
precision highp float;
varying vec3 vPos;
varying vec3 vNormal;
varying vec2 vUv;
uniform sampler2D uAlbedo;
uniform sampler2D uShadowMap;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uWrap;
uniform float uRelight;
uniform float uTime;
uniform vec4 uLamp;
uniform vec3 uLampColor;
uniform float uDetail; // 1: photo and procedural detail on top of the albedo (synthetic world)
uniform float uFloor;  // nothing is drawn below this height: the floating island's slopes end in the void
uniform sampler2D uGrassTex;  // CC0 aerial photo of grass with soil and stones (15 m square)
uniform sampler2D uSoilTex;   // CC0 photo of soil and pebbles (1 m square), for the shore and lake bed
uniform sampler2D uRockTex;   // CC0 cliff photo for rock (alpine): where the albedo's alpha is 0
uniform vec4 uRockTexMean;    // its average colour (rgb) and the metres it covers (a)
uniform sampler2D uBakedGrass; // the grass photo baked over the walkable square, matching the relief
uniform vec4 uReliefRect;
uniform vec4 uNearRect;       // the near patch (min x, min z, max x, max z): the coarse mesh leaves it out
uniform float uNearCut;       // 1 on the coarse mesh while the near patch is drawn
uniform vec3 uGrassTexMean;   // average colours of the two photos
uniform vec3 uSoilTexMean;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec2 tRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec2 tHash2(vec2 p) { return vec2(tHash(p), tHash(p + 19.19)); }

// Tufts seen from above, as spot noise: every cell scatters one soft blob of random
// size, position and brightness, and the blobs of neighbouring cells overlap and blend,
// so there are no cell edges to see. Inside a blob, soft blade streaks radiate from its
// centre. Returns (shade, green/yellow tint, dry tint).
vec3 tufts(vec2 p) {
    vec2 cell = floor(p);
    float shade = 0.0, tint = 0.0, dry = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 id = cell + vec2(float(i), float(j));
        vec2 r = id + tHash2(id) - p;                     // anywhere in its cell
        float radius = 0.4 + 0.4 * tHash(id + 4.4);
        float d2 = dot(r, r) / (radius * radius);
        if (d2 > 2.5) continue;
        float blob = exp(-2.2 * d2);
        float angle = atan(r.y, r.x);
        float streaks = tNoise(vec2(angle * 2.8 + tHash(id + 7.7) * 30.0, sqrt(d2) * 1.5)) - 0.5;
        shade += blob * (tHash(id + 1.3) - 0.5 + streaks * 0.8 * smoothstep(0.05, 0.6, d2));
        tint += blob * (tHash(id + 8.1) - 0.5);
        dry += blob * max(tHash(id + 5.9) - 0.75, 0.0) * 4.0; // one tuft in four a little straw-coloured
    }
    return vec3(shade, tint, dry);
}

float tLuma(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

// Hex tiling (texture bombing on a triangle grid): the plane is cut into triangles whose
// corners each show the texture with their own random rotation and offset, blended by
// sharpened barycentric weights, so a tiled photo never repeats in a visible pattern.
// textureGrad keeps the mip level from the unrotated uv, so the seams don't flicker.
vec3 hexSample(sampler2D tex, vec2 uv, vec2 corner, vec2 dx, vec2 dy) {
    float a = tHash(corner) * 6.2832;
    vec2 offset = tHash2(corner + 3.3);
    return textureGrad(tex, tRot(uv, a) + offset, tRot(dx, a), tRot(dy, a)).rgb;
}
vec3 hexTile(sampler2D tex, vec2 uv) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    vec2 skewed = mat2(1.0, 0.0, -0.57735027, 1.15470054) * uv * 3.0; // triangles about a third of a tile
    vec2 cell = floor(skewed);
    vec3 b = vec3(fract(skewed), 0.0);
    b.z = 1.0 - b.x - b.y;
    vec3 w;
    vec2 c1, c2, c3;
    if (b.z > 0.0) { w = vec3(b.z, b.y, b.x); c1 = cell; c2 = cell + vec2(0.0, 1.0); c3 = cell + vec2(1.0, 0.0); }
    else { w = vec3(-b.z, 1.0 - b.y, 1.0 - b.x); c1 = cell + 1.0; c2 = cell + vec2(1.0, 0.0); c3 = cell + vec2(0.0, 1.0); }
    w = w * w * w;
    w /= w.x + w.y + w.z;
    return hexSample(tex, uv, c1, dx, dy) * w.x + hexSample(tex, uv, c2, dx, dy) * w.y + hexSample(tex, uv, c3, dx, dy) * w.z;
}

// Ground detail finer than the albedo. On grass: an aerial photo of real grass with soil
// and stones, hex-tiled so its repeat doesn't show. Its brightness modulates the albedo, and where the photo shows
// bare soil or stones (not green) those come through in their own colours. Small soft
// tufts add the finest scale. Shore and lake bed get the soil and pebbles photo.
// On steep ground a photo projected from above stretches down the slope. Triplanar: also
// project it from the two sides and blend by the surface normal, so a bank gets the photo
// straight on. The blend is sharp, so a bank shows one projection at full contrast (its
// soil and stones) rather than an average of three. Only steep pixels pay for it.
vec3 triplanar(sampler2D tex, vec3 pos, vec3 n, float size, vec3 fromAbove) {
    vec3 w = pow(abs(n), vec3(12.0));
    w /= w.x + w.y + w.z;
    if (w.y > 0.97) return fromAbove;
    vec3 c = fromAbove * w.y;
    c += hexTile(tex, pos.zy / size + 0.31) * w.x;
    c += hexTile(tex, pos.xy / size + 0.67) * w.z;
    return c;
}

vec3 grassDetail(vec3 base, vec2 p, vec3 pos, vec3 n, float rock) {
    float grass = smoothstep(0.02, 0.1, base.g - max(base.r, base.b));
    float px = length(fwidth(p)); // metres per pixel
    float fine = 1.0 - smoothstep(0.01, 0.035, px);
    float finest = 1.0 - smoothstep(0.004, 0.014, px);

    // inside the baked square the photo comes from the bake (its stones sit on their bumps);
    // outside, from live hex tiling, blended over the last metre
    vec2 buv = (p - uReliefRect.xy) * uReliefRect.z;
    float baked = uReliefRect.w * smoothstep(0.0, 1.0, min(min(buv.x, 1.0 - buv.x), min(buv.y, 1.0 - buv.y)) / uReliefRect.z);
    vec3 gt = baked > 0.999 ? texture2D(uBakedGrass, buv).rgb
        : mix(hexTile(uGrassTex, p / 15.0), texture2D(uBakedGrass, clamp(buv, 0.0, 1.0)).rgb, baked);
    gt = triplanar(uGrassTex, pos, n, 15.0, gt);
    float soil = smoothstep(0.42, 0.75, gt.b / max(gt.g, 1e-3));
    vec3 onGrass = base * (tLuma(gt) / tLuma(uGrassTexMean));
    onGrass *= mix(vec3(1.0), gt / uGrassTexMean, 0.15);
    onGrass = mix(onGrass, gt * 0.95, soil * 0.8);

    vec3 st = triplanar(uSoilTex, pos, n, 1.0, hexTile(uSoilTex, p));
    vec3 onSoil = base * mix(vec3(tLuma(st) / tLuma(uSoilTexMean)), st / uSoilTexMean, 0.5);

    // steep banks show bare earth and stones in irregular patches, the steeper the more
    float steep = 1.0 - smoothstep(0.62, 0.93, n.y);
    float exposed = steep * smoothstep(0.3, 0.65, tNoise(pos.xz * 0.9 + pos.y * 0.7) * 0.7 + tNoise(pos.xz * 3.1 - pos.y * 2.3) * 0.3);
    vec3 c = mix(onSoil, onGrass, grass);
    c = mix(c, st * vec3(0.82, 0.8, 0.74), exposed * 0.85 * grass); // the soil photo in its own colours
    vec3 small = tufts(tRot(p, 2.0) / 0.09 + 50.0);
    vec3 tiny = tufts(tRot(p, 1.2) / 0.035 + 90.0);
    c *= 1.0 + (small.x * 0.25 * fine + tiny.x * 0.2 * finest) * grass;
    c *= 1.0 + vec3(0.12, 0.05, -0.18) * (small.y * fine + tiny.y * 0.5 * finest) * grass;
    if (rock > 0.001) {
        // rock: the cliff photo, triplanar so cliff faces aren't stretched; its light and
        // dark modulate the pale limestone albedo, with a little of its own colour
        // the side projections are not rotated, so the photo's strata stay horizontal
        float size = uRockTexMean.a;
        vec3 w = pow(abs(n), vec3(8.0));
        w /= w.x + w.y + w.z;
        vec3 rp = hexTile(uRockTex, p / size) * w.y
            + texture2D(uRockTex, vec2(pos.z, -pos.y) / size + 0.31).rgb * w.x
            + texture2D(uRockTex, vec2(pos.x, -pos.y) / size + 0.67).rgb * w.z;
        float shade = pow(tLuma(rp) / tLuma(uRockTexMean.rgb), 0.75);
        vec3 onRock = base * shade * mix(vec3(1.0), rp / uRockTexMean.rgb, 0.25);
        c = mix(c, onRock, rock);
    }
    // snow (a very bright albedo) stays smooth: no photo detail
    c = mix(c, base, smoothstep(0.86, 0.93, min(base.r, min(base.g, base.b))));
    return c;
}

void main(void) {
    if (uNearCut > 0.5 && vPos.x > uNearRect.x && vPos.z > uNearRect.y && vPos.x < uNearRect.z && vPos.z < uNearRect.w) discard;
    // the near patch reaches past the edge of the world near the border: nothing there
    if (vUv.x < 0.0 || vUv.y < 0.0 || vUv.x > 1.0 || vUv.y > 1.0) discard;
    if (vPos.y < uFloor) discard;
    vec4 albedo = texture2D(uAlbedo, vUv);
    vec3 base = albedo.rgb;
    if (uDetail > 0.0) base = grassDetail(base, vPos.xz, vPos, normalize(vNormal), 1.0 - albedo.a);
    vec3 n = normalize(vNormal);
    float shadow = texture2D(uShadowMap, vUv).r;

    // stream: same blue test, ripples and glints as the splat shader
    float water = smoothstep(0.04, 0.14, base.b - max(base.r, base.g * 0.92));
    float glint = 0.0;
    if (water > 0.0) {
        vec2 p = vPos.xz;
        float w1 = sin(dot(p, vec2(1.7, 0.6)) * 2.2 - uTime * 2.4);
        float w2 = sin(dot(p, vec2(-0.5, 1.9)) * 2.9 - uTime * 1.9);
        float w3 = sin(dot(p, vec2(1.1, -1.3)) * 5.3 + uTime * 3.3);
        base *= 1.0 + 0.18 * (w1 + w2 + w3) / 3.0 * water;
        glint = pow(max(w1 * w2 * w3, 0.0), 3.0) * water;
    }

    // bare rock (albedo alpha < 1) takes the light without wrap, so its facets meet at
    // hard edges between lit and shaded
    float wrap = uWrap * smoothstep(0.3, 0.9, albedo.a);
    float diffuse = max((dot(n, uSunDir) + wrap) / (1.0 + wrap), 0.0);
    vec3 light = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5) + uSunColor * diffuse * shadow;
    if (uLamp.w > 0.0) {
        vec3 toLamp = uLamp.xyz - vPos;
        float d2 = dot(toLamp, toLamp);
        float falloff = uLamp.w / (1.0 + 1.5 * d2) * (1.0 - smoothstep(16.0, 36.0, d2));
        light += uLampColor * falloff * max(dot(n, toLamp * inversesqrt(max(d2, 1e-4))) * 0.6 + 0.4, 0.0);
    }
    vec3 relit = base * light + glint * 1.4 * uSunColor * shadow;
    gl_FragColor = vec4(mix(base + glint * 0.6, relit, uRelight), 1.0);
}
`;

// points: world-space splat centres of the ground; bounds: { center: [x, z], half }.
// heightAt(x, z), for a synthetic ground, replaces the points.
export function buildTerrainMesh(app, { points, opacity, bounds, cell = 0.08, heightAt = null }) {
    const minX = bounds.center[0] - bounds.half, minZ = bounds.center[1] - bounds.half;
    const N = Math.round(2 * bounds.half / cell) + 1;
    const step = 2 * bounds.half / (N - 1);

    // height per grid node: the median of the opaque splats around it, which follows
    // the soil and lets tufts and flowers stick out above the surface
    const count = new Int32Array(N * N);
    const node = new Int32Array(heightAt ? 0 : points.length / 3).fill(-1);
    for (let i = 0; i < node.length; i++) {
        if (opacity[i] < 0.5) continue;
        const gx = Math.round((points[i * 3] - minX) / step), gz = Math.round((points[i * 3 + 2] - minZ) / step);
        if (gx < 0 || gz < 0 || gx >= N || gz >= N) continue;
        node[i] = gz * N + gx;
        count[node[i]]++;
    }
    const start = new Int32Array(N * N + 1);
    for (let k = 0; k < N * N; k++) start[k + 1] = start[k] + count[k];
    const ys = new Float32Array(start[N * N]);
    const fill = start.slice(0, N * N);
    for (let i = 0; i < node.length; i++) if (node[i] >= 0) ys[fill[node[i]]++] = points[i * 3 + 1];
    let height = new Float32Array(N * N);
    let valid = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) {
        if (count[k] < 2) continue;
        const slice = ys.subarray(start[k], start[k + 1]).sort();
        height[k] = slice[Math.floor((slice.length - 1) * 0.5)];
        valid[k] = 1;
    }

    if (heightAt) {
        for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) height[z * N + x] = heightAt(minX + x * step, minZ + z * step);
        valid.fill(1);
    }

    // close small holes, then smooth twice
    for (let pass = 0; pass < (heightAt ? 0 : 6); pass++) {
        const h2 = height.slice(), v2 = valid.slice();
        for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
            const k = z * N + x;
            if (valid[k]) continue;
            let sum = 0, n = 0;
            for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                const q = k + dz * N + dx;
                if (valid[q]) { sum += height[q]; n++; }
            }
            if (n >= 3) { h2[k] = sum / n; v2[k] = 1; }
        }
        height = h2; valid = v2;
    }
    for (let pass = 0; pass < (heightAt ? 0 : 2); pass++) {
        const smooth = height.slice();
        for (let z = 1; z < N - 1; z++) for (let x = 1; x < N - 1; x++) {
            const k = z * N + x;
            if (!valid[k]) continue;
            let sum = 0, n = 0;
            for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                const q = k + dz * N + dx;
                if (valid[q]) { sum += height[q]; n++; }
            }
            smooth[k] = sum / n;
        }
        height = smooth;
    }

    const positions = new Float32Array(N * N * 3), normals = new Float32Array(N * N * 3), uvs = new Float32Array(N * N * 2);
    const h = (x, z) => height[Math.min(N - 1, Math.max(0, z)) * N + Math.min(N - 1, Math.max(0, x))];
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
        const k = z * N + x;
        positions[k * 3] = minX + x * step; positions[k * 3 + 1] = height[k]; positions[k * 3 + 2] = minZ + z * step;
        const nx = h(x - 1, z) - h(x + 1, z), nz = h(x, z - 1) - h(x, z + 1), ny = 2 * step;
        const len = Math.hypot(nx, ny, nz);
        normals[k * 3] = nx / len; normals[k * 3 + 1] = ny / len; normals[k * 3 + 2] = nz / len;
        uvs[k * 2] = x / (N - 1); uvs[k * 2 + 1] = z / (N - 1);
    }
    const indices = [];
    for (let z = 0; z < N - 1; z++) for (let x = 0; x < N - 1; x++) {
        const a = z * N + x, b = a + 1, c = a + N, d = c + 1;
        if (valid[a] && valid[b] && valid[c] && valid[d]) indices.push(a, c, b, b, c, d);
    }

    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(positions);
    mesh.setNormals(normals);
    mesh.setUvs(0, uvs);
    mesh.setIndices(N * N > 65535 ? new Uint32Array(indices) : new Uint16Array(indices));
    mesh.update();

    const material = new pc.ShaderMaterial({
        uniqueName: 'TerrainMesh', vertexGLSL, fragmentGLSL,
        attributes: { aPosition: pc.SEMANTIC_POSITION, aNormal: pc.SEMANTIC_NORMAL, aUv0: pc.SEMANTIC_TEXCOORD0 }
    });
    const shadowData = new Uint8Array(N * N).fill(255);
    const shadowTex = new pc.Texture(app.graphicsDevice, {
        name: 'terrain-shadow', width: N, height: N, format: pc.PIXELFORMAT_R8, mipmaps: false,
        minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, levels: [shadowData]
    });
    material.setParameter('uShadowMap', shadowTex);
    material.setParameter('uDetail', 0);
    material.setParameter('uFloor', -1e6);
    const grey = new pc.Texture(app.graphicsDevice, { name: 'detail-placeholder', width: 1, height: 1, levels: [new Uint8Array([128, 128, 128, 255])] });
    material.setParameter('uGrassTex', grey);
    material.setParameter('uSoilTex', grey);
    material.setParameter('uGrassTexMean', new Float32Array([0.5, 0.5, 0.5]));
    material.setParameter('uSoilTexMean', new Float32Array([0.5, 0.5, 0.5]));
    material.setParameter('uRockTex', grey);
    material.setParameter('uRockTexMean', new Float32Array([0.5, 0.5, 0.5, 5]));
    // no relief and no near patch until setRelief() / createNear()
    material.setParameter('uDispTex', grey);
    material.setParameter('uBakedGrass', grey);
    material.setParameter('uReliefRect', new Float32Array([0, 0, 1, 0]));
    material.setParameter('uRelief', new Float32Array([0, 0]));
    material.setParameter('uNearRect', new Float32Array([0, 0, 0, 0]));
    material.setParameter('uNearCut', 0);
    material.setParameter('uAlbedo', new pc.Texture(app.graphicsDevice, { // until the bake loads
        name: 'terrain-albedo-placeholder', width: 1, height: 1, levels: [new Uint8Array([107, 140, 51, 255])]
    }));
    material.update();

    // heights for culling the splats that lie on the new surface (texel = grid node)
    const heightData = new Float32Array(N * N);
    for (let k = 0; k < N * N; k++) heightData[k] = valid[k] ? height[k] : -1000;
    const heightTex = new pc.Texture(app.graphicsDevice, {
        name: 'terrain-height', width: N, height: N, format: pc.PIXELFORMAT_R32F, mipmaps: false,
        minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, levels: [heightData]
    });

    const entity = new pc.Entity('terrain-mesh');
    entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)], castShadows: false, receiveShadows: false });
    app.root.addChild(entity);

    const materials = [material];
    const setAll = (name, value) => {
        for (const m of materials) m.setParameter(name, Array.isArray(value) ? new Float32Array(value) : value);
    };
    let near = null;

    return {
        entity, material, heightTex,
        get materials() { return materials; }, // the coarse mesh's and, once created, the near patch's
        // relief: { n, cell, min, range, encoded (Uint8 heights), colour (RGBA8 grass photo) } from land.bake()
        setRelief(relief) {
            const opts = { width: relief.n, height: relief.n, mipmaps: true, minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE };
            setAll('uDispTex', new pc.Texture(app.graphicsDevice, { ...opts, name: 'relief', format: pc.PIXELFORMAT_R8, levels: [relief.encoded] }));
            setAll('uBakedGrass', new pc.Texture(app.graphicsDevice, { ...opts, name: 'relief-colour', format: pc.PIXELFORMAT_RGBA8, anisotropy: 8, levels: [relief.colour] }));
            setAll('uReliefRect', [relief.min, relief.min, 1 / (relief.n * relief.cell), 1]);
            // the coarse mesh (vertices every `step`) takes the relief smoothed to about its spacing
            setAll('uRelief', [relief.range, Math.log2(step / relief.cell)]);
        },
        // the near patch: size x size metres of cell-sized squares around the player
        createNear(size = 10, cell = 0.03) {
            const n = Math.round(size / cell) + 1;
            const positions = new Float32Array(n * n * 3);
            for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
                const k = (z * n + x) * 3;
                positions[k] = x * cell; positions[k + 2] = z * cell;
            }
            const indices = new Uint32Array((n - 1) * (n - 1) * 6);
            let i = 0;
            for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) {
                const a = z * n + x, b = a + 1, c = a + n, d = c + 1;
                indices.set([a, c, b, b, c, d], i);
                i += 6;
            }
            const patch = new pc.Mesh(app.graphicsDevice);
            patch.setPositions(positions);
            patch.setIndices(indices);
            patch.update();
            const nearMaterial = new pc.ShaderMaterial({
                uniqueName: 'TerrainNear', vertexGLSL: nearVertexGLSL, fragmentGLSL,
                attributes: { aPosition: pc.SEMANTIC_POSITION }
            });
            for (const [name, value] of Object.entries(material.parameters)) nearMaterial.setParameter(name, value.data);
            nearMaterial.setParameter('uNearCut', 0);
            nearMaterial.setParameter('uNearSize', size);
            nearMaterial.setParameter('uNearOrigin', new Float32Array([0, 0]));
            nearMaterial.setParameter('uHeightTex', heightTex);
            nearMaterial.setParameter('uHeightGrid', new Float32Array([minX, minZ, step, N]));
            nearMaterial.setParameter('uAlbedoRect', new Float32Array([minX, minZ, 1 / (2 * bounds.half), 0]));
            nearMaterial.update();
            materials.push(nearMaterial);
            const instance = new pc.MeshInstance(patch, nearMaterial);
            instance.cull = false; // it moves in the vertex shader
            const nearEntity = new pc.Entity('terrain-near');
            nearEntity.addComponent('render', { meshInstances: [instance], castShadows: false, receiveShadows: false });
            app.root.addChild(nearEntity);
            setAll('uNearCut', 1);
            nearMaterial.setParameter('uNearCut', 0);
            near = { size, cell, material: nearMaterial };
        },
        // centre the near patch on the player, snapped to its cells
        followNear(x, z) {
            if (!near) return;
            const ox = Math.floor((x - near.size / 2) / near.cell) * near.cell, oz = Math.floor((z - near.size / 2) / near.cell) * near.cell;
            near.material.setParameter('uNearOrigin', new Float32Array([ox, oz]));
            const m = 0.15; // overlap, so no crack shows between the two
            material.setParameter('uNearRect', new Float32Array([ox + m, oz + m, ox + near.size - m, oz + near.size - m]));
        },
        cullBounds: [minX, minZ, 1 / (2 * bounds.half), 1],
        // receiver for the shadow worker: one shadow value per grid node
        shadowReceiver: { points: positions, normals },
        setShadows(values) {
            shadowData.set(values);
            shadowTex.lock().set(shadowData);
            shadowTex.unlock();
        },
        setAlbedo(texture) {
            setAll('uAlbedo', texture);
        },
        set(name, value) {
            setAll(name, value);
        }
    };
}
