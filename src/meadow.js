import * as pc from 'playcanvas';

// Procedural meadow (?meadow=N): grass blades and a few flowers made of splats,
// generated at startup with no asset file. Blades grow in clumps on the grassy
// parts of the scanned ground and take their colour from the ground under them,
// so they blend with the TripoSplat art. Each blade is a chain of thin splats
// along a curved spine: darker and more occluded at the base, lighter at the tip.
//
// Every splat is ours, so the lighting tables are exact: the normal and AO go in
// lightBytes (the layout of <asset>.light.bin) and the wind weight and phase in
// grassBytes, both indexed by splat. Output is in the PLY source frame (Y down,
// flipped 180 degrees about Z) so place() in main.js can treat it like a loaded asset.

const SH_C0 = 0.28209479177387814;
const CELL = 0.1;               // ground grid (m)
const SEGMENTS = 3;             // splats per blade
const FLOWER_CHANCE = 0.035;    // per clump
const PETALS = [[0.98, 0.97, 0.9], [1.0, 0.86, 0.3], [0.78, 0.66, 0.95], [1.0, 0.68, 0.78], [0.96, 0.95, 0.98]];

function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// smooth value noise in 0..1, for patchy density
function valueNoise(seed) {
    const hash = (x, z) => {
        let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    return (x, z) => {
        const ix = Math.floor(x), iz = Math.floor(z);
        const fx = x - ix, fz = z - iz;
        const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
        const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
        return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
    };
}

// Ground surface per 10 cm cell from the terrain splats (world space): the median
// height of the opaque splats, and the mean colour of the splats near it.
function groundGrid(points, colors, opacity, half) {
    const n = Math.round(2 * half / CELL);
    const cells = Array.from({ length: n * n }, () => []);
    for (let i = 0; i < opacity.length; i++) {
        if (opacity[i] < 0.5) continue;
        const ix = Math.floor((points[i * 3] + half) / CELL), iz = Math.floor((points[i * 3 + 2] + half) / CELL);
        if (ix >= 0 && iz >= 0 && ix < n && iz < n) cells[iz * n + ix].push(i);
    }
    const height = new Float32Array(n * n).fill(NaN);
    const color = new Float32Array(n * n * 3);
    cells.forEach((list, k) => {
        if (list.length < 3) return;
        const ys = list.map(i => points[i * 3 + 1]).sort((a, b) => a - b);
        const h = ys[ys.length >> 1];
        height[k] = h;
        let m = 0;
        for (const i of list) {
            if (Math.abs(points[i * 3 + 1] - h) > 0.05) continue;
            for (let c = 0; c < 3; c++) color[k * 3 + c] += colors[i * 3 + c];
            m++;
        }
        for (let c = 0; c < 3; c++) color[k * 3 + c] /= Math.max(m, 1);
    });
    const at = (x, z) => {
        const ix = Math.floor((x + half) / CELL), iz = Math.floor((z + half) / CELL);
        return ix >= 0 && iz >= 0 && ix < n && iz < n ? iz * n + ix : -1;
    };
    return { n, height, color, at };
}

// unit quaternion (x, y, z, w) of the rotation whose columns are a, b, c
export function quatFromBasis(a, b, c) {
    const [m00, m10, m20] = a, [m01, m11, m21] = b, [m02, m12, m22] = c;
    const tr = m00 + m11 + m22;
    let x, y, z, w;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
    }
    return [x, y, z, w];
}

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const flip = (v) => [-v[0], -v[1], v[2]]; // world -> PLY source frame (180 degrees about Z)
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ground: { points (world), colors, opacity } of the scanned terrain, or sample(x, z) ->
// { h, slope, c, density, flowers: { chance, kind } } | null for a synthetic one (land.js).
// world: the VoxelWorld, used to keep blades out of rocks and trunks. budget: number of splats.
export function buildMeadow(app, { ground, sample: landSample, world, budget, turf = 0, half = 10, seed = 1 }) {
    const rand = rng(seed);
    const patches = valueNoise(seed * 7 + 3);
    const grid = landSample ? null : groundGrid(ground.points, ground.colors, ground.opacity, half);

    const pos = [], rot = [], scl = [], col = [], alpha = [], normal = [], ao = [], wind = [];
    const emit = (p, tangent, side, size, c, a, n, occlusion, weight, phase) => {
        const face = cross(tangent, side);
        pos.push(...flip(p));
        rot.push(...quatFromBasis(flip(tangent), flip(side), flip(face)));
        scl.push(...size);
        col.push(...c);
        alpha.push(a);
        normal.push(...flip(n));
        ao.push(occlusion);
        wind.push(weight, phase);
    };

    // surface height (bilinear between cell medians) and the cell's ground colour
    const scanSample = (x, z) => {
        const k = grid.at(x, z);
        if (k < 0 || Number.isNaN(grid.height[k])) return null;
        const hs = [grid.at(x + CELL, z), grid.at(x - CELL, z), grid.at(x, z + CELL), grid.at(x, z - CELL)].map(j => (j < 0 ? NaN : grid.height[j]));
        if (hs.some(Number.isNaN)) return null;
        const slope = Math.hypot(hs[0] - hs[1], hs[2] - hs[3]) / (2 * CELL);
        return { h: grid.height[k], slope, c: [grid.color[k * 3], grid.color[k * 3 + 1], grid.color[k * 3 + 2]] };
    };
    const isGrass = ([r, g, b]) => g > r * 1.04 && g > b * 1.25 && b - Math.max(r, g * 0.92) < 0.04;
    const sample = landSample ?? scanSample;

    let clumps = 0, flowers = 0, tries = 0;
    while (alpha.length < budget && tries < budget * 20) {
        tries++;
        const cx = (rand() * 2 - 1) * half, cz = (rand() * 2 - 1) * half;
        const s = sample(cx, cz);
        if (!s || s.slope > 0.7 || (!landSample && !isGrass(s.c))) continue;
        // patchy meadow: dense swathes and thin gaps
        const density = s.density ?? patches(cx * 0.45, cz * 0.45) * 0.75 + patches(cx * 1.7 + 9, cz * 1.7) * 0.25;
        if (rand() > density * density * 1.6) continue;
        if (world.bodyBlocked(cx, cz, s.h + 0.12, s.h + 0.5, 0.1, 2)) continue;

        clumps++;
        // on synthetic ground a third are loose scatters that fill the gaps between tufts
        const scatter = landSample && rand() < 0.35;
        const clumpScale = scatter ? 0.5 + rand() * 0.4 : 0.65 + rand() * 0.7;
        const hueShift = (rand() - 0.5) * 0.12;
        const dry = rand() < 0.15 ? 0.35 : rand() * 0.12; // the odd straw-coloured clump
        const blades = scatter ? 3 + Math.floor(rand() * 4) : 6 + Math.floor(rand() * 9);
        const phase = rand();
        const flowerKind = s.flowers?.kind ?? { petal: PETALS[Math.floor(rand() * PETALS.length)], centre: [1, 0.82, 0.25] };
        const stems = rand() < (s.flowers?.chance ?? FLOWER_CHANCE) ? 1 + Math.floor(rand() * (landSample ? 3 : 1)) : 0;
        for (let b = 0; b < blades + stems && alpha.length < budget; b++) {
            const isStem = b >= blades;
            const r = Math.sqrt(rand()) * (scatter ? 0.3 : 0.08 * clumpScale);
            const a0 = rand() * Math.PI * 2;
            const bx = cx + Math.cos(a0) * r, bz = cz + Math.sin(a0) * r;
            const sb = sample(bx, bz);
            if (!sb) continue;
            const base = [bx, sb.h - 0.015, bz];
            const H = isStem ? 0.28 + rand() * 0.14 : (0.1 + 0.24 * rand() ** 1.5) * clumpScale;
            // lean outwards from the clump centre, with some randomness
            const la = a0 + (rand() - 0.5) * 1.6;
            const d = [Math.cos(la), 0, Math.sin(la)];
            const lean = isStem ? 0.08 + rand() * 0.1 : 0.15 + rand() * 0.45;
            const side = norm(cross([0, 1, 0], d));
            const width = isStem ? 0.0025 : 0.006 + rand() * 0.006;
            const g = sb.c;
            const lo = [g[0] * 0.42, g[1] * 0.55, g[2] * 0.3];
            const hiRaw = [g[0] * 1.05 + 0.03 + hueShift, g[1] * 1.08 + 0.02, g[2] * 0.75];
            const hi = hiRaw.map((v, k) => v + ([0.85, 0.78, 0.4][k] - v) * dry);
            const bladePhase = phase + rand() * 0.15;
            let tip = base, tipTangent = [0, 1, 0];
            for (let k = 0; k < SEGMENTS; k++) {
                const t = (k + 0.5) / SEGMENTS;
                const p = [base[0] + d[0] * H * lean * t * t, base[1] + H * t * (1 - 0.25 * lean * t), base[2] + d[2] * H * lean * t * t];
                const tangent = norm([d[0] * 2 * lean * t, 1, d[2] * 2 * lean * t]);
                const segLen = H / SEGMENTS;
                const size = [segLen * 0.5, width * (1 - 0.6 * t), 0.0015];
                const c = lo.map((v, j) => clamp01(v + (hi[j] - v) * t ** 0.8));
                const n = norm(cross(tangent, side).map((v, j) => v * 0.45 + (j === 1 ? 0.9 : 0)));
                emit(p, tangent, side, size, c, 0.92 - 0.12 * t, n[1] < 0 ? n.map(v => -v) : n,
                    0.32 + 0.68 * t ** 0.8, clamp01(t ** 1.6 * H / 0.3), bladePhase);
                tip = p; tipTangent = tangent;
            }
            if (isStem && flowerKind.spike) {
                // lupin: a tapering spike of small blooms up the top of the stem
                flowers++;
                for (let k = 0; k < 7; k++) {
                    const t = k / 6;
                    const p = [tip[0] + tipTangent[0] * 0.012 * k, tip[1] + 0.012 + 0.016 * k, tip[2] + tipTangent[2] * 0.012 * k];
                    const r = 0.009 * (1 - 0.6 * t);
                    const c = flowerKind.petal.map(v => clamp01(v * (0.8 + 0.3 * t + rand() * 0.1)));
                    emit(p, [0, 1, 0], [1, 0, 0], [r * 1.2, r, r], c, 0.95, [0, 1, 0], 0.7 + 0.3 * t, clamp01(H / 0.3), bladePhase);
                }
            } else if (isStem) {
                flowers++;
                const petal = flowerKind.petal;
                const head = [tip[0] + tipTangent[0] * 0.02, tip[1] + 0.02, tip[2] + tipTangent[2] * 0.02];
                const petals = 4 + Math.floor(rand() * 3);
                const spin = rand() * Math.PI * 2;
                for (let k = 0; k < petals; k++) {
                    const a = spin + k * Math.PI * 2 / petals;
                    const out = [Math.cos(a), 0, Math.sin(a)];
                    const p = [head[0] + out[0] * 0.012, head[1], head[2] + out[2] * 0.012];
                    const c = petal.map(v => clamp01(v * (0.85 + rand() * 0.2)));
                    emit(p, out, norm(cross([0, 1, 0], out)), [0.011, 0.0065, 0.0015], c, 0.95, [0, 1, 0], 1, clamp01(H / 0.3), bladePhase);
                }
                emit(head, [1, 0, 0], [0, 0, 1], [0.005, 0.005, 0.004], flowerKind.centre, 1, [0, 1, 0], 1, clamp01(H / 0.3), bladePhase);
            }
        }
    }

    // turf: short blades of one splat each, spread evenly between the tufts so the
    // ground reads as grass rather than a flat green surface
    const total = alpha.length + turf;
    for (let tries = 0; alpha.length < total && tries < turf * 6; tries++) {
        const x = (rand() * 2 - 1) * half, z = (rand() * 2 - 1) * half;
        const s = sample(x, z);
        if (!s || s.slope > 0.8 || rand() > s.density) continue;
        const H = 0.03 + rand() * 0.045;
        const la = rand() * Math.PI * 2;
        const d = [Math.cos(la), 0, Math.sin(la)];
        const lean = 0.2 + rand() * 0.6;
        const tangent = norm([d[0] * lean, 1, d[2] * lean]);
        const side = norm(cross([0, 1, 0], d));
        const p = [x + tangent[0] * H * 0.5, s.h + tangent[1] * H * 0.5 - 0.008, z + tangent[2] * H * 0.5];
        const g = s.c, t = 0.35 + rand() * 0.4;
        const c = [g[0] * (0.55 + 0.5 * t), g[1] * (0.62 + 0.45 * t), g[2] * (0.45 + 0.35 * t)].map(clamp01);
        const n = norm(cross(tangent, side).map((v, j) => v * 0.4 + (j === 1 ? 0.9 : 0)));
        emit(p, tangent, side, [H * 0.5, 0.005 + rand() * 0.005, 0.0015], c, 0.9, n[1] < 0 ? n.map(v => -v) : n,
            0.45 + 0.3 * t, 0.15, rand());
    }

    const out = packSplats(app, 'meadow', { pos, rot, scl, col, alpha, normal, ao, wind });
    return { ...out, height: 0.4, stats: { clumps, flowers } };
}

// Turns per-splat arrays (world frame, already flipped to the PLY source frame) into a
// gsplat asset plus the tables place() in main.js expects. wind is optional (meadow only).
export function packSplats(app, name, { pos, rot, scl, col, alpha, normal, ao, wind = null }) {
    const count = alpha.length;
    const props = {
        x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
        f_dc_0: new Float32Array(count), f_dc_1: new Float32Array(count), f_dc_2: new Float32Array(count),
        opacity: new Float32Array(count),
        scale_0: new Float32Array(count), scale_1: new Float32Array(count), scale_2: new Float32Array(count),
        rot_0: new Float32Array(count), rot_1: new Float32Array(count), rot_2: new Float32Array(count), rot_3: new Float32Array(count)
    };
    const points = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const opacity = new Float32Array(count);
    const lightBytes = new Uint8Array(count * 4);
    const grassBytes = wind ? new Uint8Array(count * 4) : null;
    for (let i = 0; i < count; i++) {
        props.x[i] = points[i * 3] = pos[i * 3];
        props.y[i] = points[i * 3 + 1] = pos[i * 3 + 1];
        props.z[i] = points[i * 3 + 2] = pos[i * 3 + 2];
        for (let c = 0; c < 3; c++) {
            colors[i * 3 + c] = col[i * 3 + c];
            props[`f_dc_${c}`][i] = (col[i * 3 + c] - 0.5) / SH_C0;
            props[`scale_${c}`][i] = Math.log(scl[i * 3 + c]);
            lightBytes[i * 4 + c] = Math.round((normal[i * 3 + c] * 0.5 + 0.5) * 255);
        }
        opacity[i] = alpha[i];
        props.opacity[i] = Math.log(alpha[i] / (1 - alpha[i]));
        props.rot_0[i] = rot[i * 4 + 3]; props.rot_1[i] = rot[i * 4]; props.rot_2[i] = rot[i * 4 + 1]; props.rot_3[i] = rot[i * 4 + 2];
        lightBytes[i * 4 + 3] = Math.round(ao[i] * 255);
        if (wind) {
            grassBytes[i * 4] = Math.round(wind[i * 2] * 255);
            grassBytes[i * 4 + 1] = Math.round((wind[i * 2 + 1] % 1) * 255);
        }
    }
    const data = new pc.GSplatData([{
        name: 'vertex', count,
        properties: Object.entries(props).map(([name, storage]) => ({ type: 'float', name, storage, byteSize: 4 }))
    }]);
    const asset = new pc.Asset(name, 'gsplat', null);
    asset.resource = new pc.GSplatResource(app.graphicsDevice, data, { prepareCenters: true });
    asset.loaded = true;
    app.assets.add(asset);
    return { name, asset, count, points, opacity, colors, lightBytes, grassBytes, bottom: 0 };
}
