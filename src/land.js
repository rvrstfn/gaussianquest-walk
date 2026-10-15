import * as pc from 'playcanvas';
import { packSplats, quatFromBasis, flip } from './meadow.js';

// Synthetic worlds (?world=meadow, ?world=alpine): rolling ground with a lake, all
// generated; the alpine scene adds a limestone mountain along the north side, scree at
// its foot, snow on top, and greener grass with alpine flowers. The
// ground is an opaque heightmap mesh (cheap: one layer of pixels) textured with a
// painted albedo, the lake bed included. The water is a sheet of flat splats over
// the bed (water()), waved and mirrored in the relight shader.
// Grass and flowers go on top as splats (meadow.js, through sample()).

const MEADOW_LAKE = { x: 0.5, z: -1.5, radius: 4.6 }; // in front of the start point
const ALPINE_LAKE = { x: 1.5, z: -1.8, radius: 4.0 }; // a tarn at the mountain's foot
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const BANK = 1.4;          // from the waterline to where the shore meets the hills (m)
const DEPTH = 0.9;         // lake depth in the middle (m)

function hash2(seed) {
    return (x, z) => {
        let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
}

function noise2(seed) {
    const hash = hash2(seed);
    return (x, z) => {
        const ix = Math.floor(x), iz = Math.floor(z);
        const fx = x - ix, fz = z - iz;
        const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
        const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
        return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
    };
}

function fbm(noise, x, z, octaves) {
    let sum = 0, amp = 0.5, f = 1;
    for (let o = 0; o < octaves; o++) {
        sum += amp * noise(x * f + o * 17.3, z * f - o * 9.1);
        f *= 2.03;
        amp *= 0.5;
    }
    return sum;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// half: the meadow (m); outer: how far the ground mesh reaches (past the island's rim);
// scene: 'meadow' or 'alpine'
export function createLand({ half = 12, outer = 33, seed = 3, scene = 'meadow' } = {}) {
    const n1 = noise2(seed), n2 = noise2(seed + 11), n3 = noise2(seed + 23), n4 = noise2(seed + 37);
    const alpine = scene === 'alpine';
    const LAKE = alpine ? ALPINE_LAKE : MEADOW_LAKE;

    // ---- the alpine mountain: a limestone ridge along the north side. Its foot and crest
    // wander a little; up(x, z) is how far up its face a point is (0 at the foot, 1 at the
    // crest). Ridged noise makes crags on the face, and pinnacles stand along the crest.
    const footZ = (x) => -9.5 + 1.4 * Math.sin(x * 0.21 + 2.0) + 0.8 * Math.sin(x * 0.47 + 0.5);
    const crestZ = (x) => -25 + 2.5 * Math.sin(x * 0.13 + 1.0);
    const up = (x, z) => alpine ? Math.max(0, (footZ(x) - z) / (footZ(x) - crestZ(x))) : 0;
    const mountain = (x, z) => {
        const s = up(x, z);
        if (s <= 0) return 0;
        // several peaks and cols along the ridge
        const peaks = 0.45 + 0.55 * smooth(0.25, 0.75, fbm(n3, x * 0.13 + 7, 1.3, 2));
        const amp = 24 * peaks;
        // a steep lower face rising from the scree, easing back towards the crest
        let h = s <= 1 ? amp * (0.55 * s ** 0.8 + 0.45 * s ** 2.2) : amp * (1 - 0.35 * smooth(1, 1.5, s));
        const ridged = 1 - Math.abs(2 * fbm(n2, x * 0.22, z * 0.22, 3) - 1);
        h += 2.5 * ridged * ridged * smooth(0.1, 0.5, s);                   // crags on the face
        h += 10 * Math.max(0, fbm(n4, x * 0.5, z * 0.3, 2) - 0.5) * smooth(0.75, 1, s); // pinnacles
        return h;
    };
    // hard edges: the face is cut into flat facets, the mountain's height taken at the
    // corners of a triangle lattice (turned, bent a little, with jittered corners and
    // diagonals) and laid flat in between, so neighbouring facets meet at sharp creases
    const facetHash = hash2(seed + 51);
    const FACET = 2.6, TURN = 0.41, ct = Math.cos(TURN), st = Math.sin(TURN);
    const corner = (i, j) => {
        const lx = (i + 0.35 * (facetHash(i, j) - 0.5)) * FACET, lz = (j + 0.35 * (facetHash(j + 71, i) - 0.5)) * FACET;
        const x = lx * ct + lz * st, z = -lx * st + lz * ct;
        return mountain(x, z) + 1.6 * (facetHash(i - 13, j + 29) - 0.5) * smooth(0.05, 0.3, up(x, z));
    };
    const faceted = (x, z) => {
        const wx = x + 0.5 * (n2(x * 0.3 + 40, z * 0.3) - 0.5), wz = z + 0.5 * (n3(x * 0.3, z * 0.3 - 40) - 0.5);
        const a = (wx * ct - wz * st) / FACET, b = (wx * st + wz * ct) / FACET;
        const i = Math.floor(a), j = Math.floor(b), fx = a - i, fz = b - j;
        const h00 = corner(i, j), h10 = corner(i + 1, j), h01 = corner(i, j + 1), h11 = corner(i + 1, j + 1);
        if (facetHash(i + 5, j - 5) < 0.5) { // diagonal from (0,0) to (1,1)
            return fx > fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h01 - h00) * fz + (h11 - h01) * fx;
        }
        // diagonal from (1,0) to (0,1)
        return fx + fz < 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
    };
    const rockFace = (x, z) => {
        const s = up(x, z);
        if (s <= 0) return 0;
        const t = smooth(0.02, 0.12, s) * (1 - 0.75 * smooth(0.7, 0.95, s)); // the scree at the foot stays smooth, the summit keeps its point
        return t > 0 ? mountain(x, z) + (faceted(x, z) - mountain(x, z)) * t : mountain(x, z);
    };

    // grey gravel fans where the face meets the meadow
    const scree = (x, z) => alpine ? smooth(footZ(x) + 3, footZ(x) - 0.5, z) * clamp01(0.5 + 0.7 * (n1(x * 0.3, 2.7) - 0.5) + 0.3) : 0;

    // the lake: an irregular round shape. shore(x, z) is the distance outside the
    // waterline (negative on the water), close enough to metres for a gentle outline.
    const lakeRadius = (a) => LAKE.radius + 0.9 * Math.sin(2 * a + 1) + 0.5 * Math.sin(3 * a + 2.4) + 0.25 * Math.sin(5 * a + 0.3);
    const shore = (x, z) => Math.hypot(x - LAKE.x, z - LAKE.z) - lakeRadius(Math.atan2(z - LAKE.z, x - LAKE.x));

    // a floating island: beyond the ring of hills (which end where the old square edge
    // was, HILLS from the centre) the ground curves down over an irregular rim and falls
    // away into the void, so the cut is never in view. The hills themselves are untouched.
    const HILLS = 26;
    const edgeRadius = (a) => HILLS + 4.5 + 1.0 * Math.sin(3 * a + 0.7) + 0.6 * Math.sin(5 * a + 2.1) + 0.3 * Math.sin(9 * a + 1.3);
    const insideEdge = (x, z) => edgeRadius(Math.atan2(z, x)) - Math.hypot(x, z); // metres in from the rim
    // the final slope: rounding over the rim, steeper and steeper
    const rimDrop = (x, z) => { const e = insideEdge(x, z); return e < 3.5 ? 0.9 * (3.5 - e) ** 2 : 0; };
    // two saddles in the ring of hills, east and west, where the low sun rises and sets
    // (8 degrees south of due east and west), so golden hour light reaches the meadow;
    // the rest of the ring stays tall
    const saddle = (x, z) => {
        const a = Math.atan2(z, x);
        const gap = (centre) => { const d = Math.atan2(Math.sin(a - centre), Math.cos(a - centre)); return Math.exp(-((d / 0.3) ** 2)); };
        return 1 - 0.78 * Math.max(gap(0.14), gap(Math.PI - 0.14));
    };
    const hills = (x, z) => {
        const r = Math.hypot(x, z);
        if (alpine) {
            return 1.2 * fbm(n1, x * 0.07, z * 0.07, 3)
                + 0.2 * fbm(n2, x * 0.4, z * 0.4, 2)
                + 3.5 * smooth(half + 1, HILLS, r) * (0.6 + 0.8 * n3(x * 0.15, z * 0.15)) * smooth(-14, -4, z) * saddle(x, z) // lower hills, not in front of the mountain
                + rockFace(x, z);
        }
        return 1.6 * fbm(n1, x * 0.07, z * 0.07, 3)          // broad rolls
            + 0.25 * fbm(n2, x * 0.4, z * 0.4, 2)              // small bumps
            + 1.8 * Math.exp(-((x - 6) ** 2 + (z + 7) ** 2) / 20) // a knoll to the north-east
            + 1.1 * Math.exp(-((x + 7) ** 2 + (z - 6) ** 2) / 14)
            + 5 * smooth(half + 1, HILLS, r) * (0.6 + 0.8 * n3(x * 0.15, z * 0.15)) * saddle(x, z); // hills all around
    };
    const waterLevel = hills(LAKE.x, LAKE.z) - 0.25;

    // the rim's drop comes after the rule below that keeps land above the water level,
    // which would otherwise flatten the island's slope into a skirt
    const height = (x, z) => lakeHeight(x, z) - rimDrop(x, z);
    const lakeHeight = (x, z) => {
        const h = hills(x, z);
        const s = shore(x, z);
        if (s >= BANK) return Math.max(h, waterLevel + 0.06);
        if (s < 0) return waterLevel - 0.03 - DEPTH * smooth(0, 3, -s); // shelving to the middle
        const land = waterLevel + 0.04;
        return land + (Math.max(h, land) - land) * smooth(0, BANK, s); // the shore flattens to the water
    };
    const isWater = (x, z) => shore(x, z) < 0;

    // the meadow's edge: an irregular ring around the middle, so the grass doesn't end in a
    // square; grassEdge() is the distance inside it (negative outside, on the bare hills)
    const grassRadius = (a) => half - 0.6 + 1.3 * Math.sin(3 * a + 1.1) + 0.8 * Math.sin(5 * a + 2.3) + 0.5 * Math.sin(8 * a + 0.4);
    const grassEdge = (x, z) => grassRadius(Math.atan2(z, x)) - Math.hypot(x, z);
    const grassReach = half + 2; // the edge never goes past this
    const walkHalf = 24;         // you walk out to here, over the hills

    // grass tone: fresh yellow-green (greener in the Alps), drier on the high ground, lusher by the water
    const grassColor = (x, z, h, s) => {
        const v = n4(x * 0.35, z * 0.35);
        let c = alpine ? mix([0.27, 0.52, 0.14], [0.47, 0.64, 0.2], v) : mix([0.36, 0.56, 0.12], [0.58, 0.68, 0.18], v);
        c = mix(c, [0.66, 0.64, 0.3], smooth(1.5, 3.5, h) * 0.35);
        c = mix(c, [0.2, 0.5, 0.16], (1 - smooth(0, 1.8, s)) * 0.5);
        return c;
    };

    // flower patches: each patch has one kind, so colours come in drifts like a real meadow
    const FLOWERS = alpine ? [
        { petal: [0.14, 0.28, 0.95], centre: [0.9, 0.95, 1] },  // gentians
        { petal: [0.93, 0.93, 0.87], centre: [0.95, 0.85, 0.4] }, // edelweiss
        { petal: [0.92, 0.25, 0.45], centre: [1, 0.8, 0.5] },   // alpine roses
        { petal: [1, 0.86, 0.22], centre: [1, 0.75, 0.1] },     // globeflowers
        { petal: [0.42, 0.3, 0.82], centre: [0.9, 0.85, 0.6], spike: true } // monkshood
    ] : [
        { petal: [0.97, 0.96, 0.9], centre: [1, 0.8, 0.2] },   // daisies
        { petal: [1, 0.84, 0.18], centre: [1, 0.7, 0.1] },     // buttercups
        { petal: [0.72, 0.52, 0.95], centre: [0.95, 0.85, 0.5], spike: true }, // lupins
        { petal: [1, 0.62, 0.74], centre: [1, 0.85, 0.5] },    // clover pink
        { petal: [0.45, 0.6, 1], centre: [1, 0.95, 0.7] }      // cornflower blue
    ];
    const flowersAt = (x, z) => {
        const zone = n3(x * 0.22 + 40, z * 0.22);
        const strength = smooth(0.45, 0.72, n2(x * 0.18 - 20, z * 0.18 + 5));
        return { chance: 0.03 + 0.55 * strength, kind: FLOWERS[Math.min(FLOWERS.length - 1, Math.floor(zone * FLOWERS.length * 1.2) % FLOWERS.length)] };
    };

    // ---- relief: real bumps in the ground from the photos' displacement maps. Baked once
    // at load on a 2.5 cm grid over the walkable square (plus 1 m): the grass photo's
    // colour and height are hex-tiled with the same random corners, so a stone's colour
    // sits on its bump, and the soil photo adds pebble-sized relief. No relief under the
    // water or at the waterline, and it fades out at the edge of the baked square.
    const relief = { cell: 0.025, min: -(half + 2.5), n: 0, disp: null, colour: null, range: 0.4 };
    const hash = (i, j, k) => {
        let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647) ^ 0x9e3779b9;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    // hex tiling on the CPU: the three triangle corners around (u, v), each with its own
    // random rotation and offset, and their sharpened barycentric weights
    function hexCorners(u, v, salt, out) {
        const sx = (u - 0.57735027 * v) * 3, sy = 1.15470054 * v * 3;
        const cx = Math.floor(sx), cy = Math.floor(sy), fx = sx - cx, fy = sy - cy, fz = 1 - fx - fy;
        const c = fz > 0 ? [[cx, cy, fz], [cx, cy + 1, fy], [cx + 1, cy, fx]] : [[cx + 1, cy + 1, -fz], [cx + 1, cy, 1 - fy], [cx, cy + 1, 1 - fx]];
        let sum = 0;
        for (let k = 0; k < 3; k++) {
            const [i, j, w] = c[k];
            const a = hash(i, j, salt) * 6.2832, co = Math.cos(a), si = Math.sin(a);
            out[k].u = co * u - si * v + hash(i, j, salt + 1);
            out[k].v = si * u + co * v + hash(i, j, salt + 2);
            out[k].w = w * w * w;
            sum += out[k].w;
        }
        for (let k = 0; k < 3; k++) out[k].w /= sum;
    }
    // mean and spread of an image channel, to normalise a displacement map's contrast
    function stats(sampleFn) {
        let s1 = 0, s2 = 0, n = 0;
        for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
            const v = sampleFn((i + 0.5) / 64, (j + 0.5) / 64)[0];
            s1 += v; s2 += v * v; n++;
        }
        const mean = s1 / n;
        return { mean, std: Math.sqrt(Math.max(1e-6, s2 / n - mean * mean)) };
    }
    // grassColour/grassHeight/soilHeight: (u, v) -> [r, g, b] samplers (main.js loadPixels)
    function bake({ grassColour, grassHeight, soilHeight, grassSigma = 0.045, soilSigma = 0.008 }) {
        const n = Math.round(-2 * relief.min / relief.cell);
        const disp = new Float32Array(n * n), colour = new Uint8Array(n * n * 4), encoded = new Uint8Array(n * n);
        const gs = stats(grassHeight), ss = stats(soilHeight);
        const g3 = [{}, {}, {}], s3 = [{}, {}, {}];
        for (let j = 0; j < n; j++) {
            const z = relief.min + (j + 0.5) * relief.cell;
            for (let i = 0; i < n; i++) {
                const x = relief.min + (i + 0.5) * relief.cell, k = j * n + i;
                hexCorners(x / 15, z / 15, 11, g3);
                let r = 0, g = 0, b = 0, gh = 0;
                for (const c of g3) {
                    const col = grassColour(c.u, c.v);
                    r += col[0] * c.w; g += col[1] * c.w; b += col[2] * c.w;
                    gh += grassHeight(c.u, c.v)[0] * c.w;
                }
                hexCorners(x, z, 23, s3);
                let sh = 0;
                for (const c of s3) sh += soilHeight(c.u, c.v)[0] * c.w;
                const edge = Math.min(x - relief.min, -relief.min - x, z - relief.min, -relief.min - z);
                // bumps where the grass is, reaching a little past its edge, none in the water
                const mask = smooth(0, 0.45, shore(x, z)) * smooth(0, 1, edge) * smooth(-1.5, 0.5, grassEdge(x, z));
                const d = mask * ((gh - gs.mean) / gs.std * grassSigma + (sh - ss.mean) / ss.std * soilSigma);
                disp[k] = d;
                encoded[k] = Math.max(0, Math.min(255, Math.round(127.5 + d / relief.range * 255)));
                colour[k * 4] = r * 255; colour[k * 4 + 1] = g * 255; colour[k * 4 + 2] = b * 255; colour[k * 4 + 3] = 255;
            }
        }
        Object.assign(relief, { n, disp, colour, encoded });
        return relief;
    }
    // the baked relief at (x, z), bilinear; 0 outside the baked square or before bake()
    function dispAt(x, z) {
        if (!relief.disp) return 0;
        const gx = (x - relief.min) / relief.cell - 0.5, gz = (z - relief.min) / relief.cell - 0.5;
        const i = Math.floor(gx), j = Math.floor(gz);
        if (i < 0 || j < 0 || i >= relief.n - 1 || j >= relief.n - 1) return 0;
        const fx = gx - i, fz = gz - j, n = relief.n, d = relief.disp;
        const a = d[j * n + i] + (d[j * n + i + 1] - d[j * n + i]) * fx;
        const b = d[(j + 1) * n + i] + (d[(j + 1) * n + i + 1] - d[(j + 1) * n + i]) * fx;
        return a + (b - a) * fz;
    }
    // the ground as you walk on it: the hills plus the relief
    const surface = (x, z) => height(x, z) + dispAt(x, z);

    // for meadow.js: ground height, slope, blade colour and density at (x, z), or null for no grass
    const sample = (x, z) => {
        const edge = grassEdge(x, z);
        if (edge < 0) return null;
        if (alpine && (up(x, z) > 0.02 || scree(x, z) > 0.45)) return null; // no grass on rock or scree
        const s = shore(x, z);
        if (s < 0.08) return null;
        const h = surface(x, z);
        const e = 0.1;
        const slope = Math.hypot(height(x + e, z) - height(x - e, z), height(x, z + e) - height(x, z - e)) / (2 * e);
        const density = (0.55 + 0.45 * n1(x * 0.5 + 7, z * 0.5)) * smooth(0, 0.5, s) * smooth(0, 2.5, edge); // thinning out at the edge
        return { h, slope, c: grassColor(x, z, h, s), density, flowers: flowersAt(x, z) };
    };

    // painted ground under the grass: darker, mottled green with soil showing at the banks
    function albedo(app, size = 1024) {
        const pixels = new Uint8Array(size * size * 4);
        for (let j = 0; j < size; j++) {
            for (let i = 0; i < size; i++) {
                const x = -outer + (i + 0.5) / size * 2 * outer, z = -outer + (j + 0.5) / size * 2 * outer;
                const s = shore(x, z);
                let c, rock = 0; // rock: drawn with the cliff photo (alpha 0 in the albedo)
                if (s < 0) {
                    // lake bed: sand and pebbles in the shallows (pale grey in the Alps), dark silt further out
                    const pebbles = fbm(n2, x * 9, z * 9, 2);
                    c = mix(alpine ? [0.6, 0.6, 0.55] : [0.55, 0.47, 0.33], alpine ? [0.1, 0.22, 0.2] : [0.14, 0.18, 0.11], smooth(0.2, 2.2, -s));
                    c = c.map(v => v * (0.7 + 0.6 * pebbles));
                } else {
                    const h = hills(x, z);
                    const g = grassColor(x, z, h, s).map(v => v * 0.62);
                    const mottle = fbm(n4, x * 1.6, z * 1.6, 3);
                    c = g.map(v => v * (0.75 + 0.5 * mottle));
                    c = mix(c, alpine ? [0.6, 0.6, 0.56] : [0.45, 0.38, 0.25], (1 - smooth(0, 0.45, s)) * 0.85); // sandy (pebbly) shore
                    if (alpine) {
                        c = mix(c, [0.6, 0.59, 0.55].map(v => v * (0.8 + 0.4 * mottle)), smooth(0.35, 0.6, scree(x, z))); // scree
                        rock = smooth(0.06, 0.25, up(x, z));
                        c = mix(c, [0.6, 0.58, 0.54].map(v => v * (0.85 + 0.25 * mottle)), rock); // pale limestone
                        // snow on the upper slopes that aren't too steep to hold it
                        const slope = Math.hypot(hills(x + 0.3, z) - hills(x - 0.3, z), hills(x, z + 0.3) - hills(x, z - 0.3)) / 0.6;
                        const snow = smooth(13.5, 17, h + 3 * (fbm(n2, x * 0.4, z * 0.4, 2) - 0.5)) * (1 - smooth(1.1, 1.9, slope));
                        c = mix(c, [0.95, 0.96, 0.98], snow);
                        rock *= 1 - snow;
                    }
                }
                const k = (j * size + i) * 4;
                pixels[k] = Math.round(Math.min(1, c[0]) * 255);
                pixels[k + 1] = Math.round(Math.min(1, c[1]) * 255);
                pixels[k + 2] = Math.round(Math.min(1, c[2]) * 255);
                pixels[k + 3] = Math.round((1 - rock) * 255);
            }
        }
        return new pc.Texture(app.graphicsDevice, {
            name: 'land-albedo', width: size, height: size, format: pc.PIXELFORMAT_RGBA8,
            mipmaps: true, minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, anisotropy: 8, levels: [pixels]
        });
    }

    // surface points every 10 cm over the walkable area (the meadow and the hills around
    // it), for collisions and shadow rays
    function surfacePoints(spacing = 0.1) {
        const n = Math.round(2 * walkHalf / spacing) + 1;
        const points = new Float32Array(n * n * 3);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const x = -walkHalf + i * spacing, z = -walkHalf + j * spacing, k = (j * n + i) * 3;
            // no ground to stand on within 2.5 m of the rim, so you stop before it falls away
            if (insideEdge(x, z) < 2.5) { points[k + 1] = -1000; continue; }
            points[k] = x; points[k + 1] = surface(x, z); points[k + 2] = z;
        }
        return { points, opacity: new Float32Array(n * n).fill(1) };
    }

    // The water: flat splats on a jittered grid over the lake, about 3.5 cm apart,
    // fading out at the shore. Colour is the water body (absorption); the shader adds
    // waves, the sky's reflection and glints.
    function water(app, { spacing = 0.035, seed: s = 5 } = {}) {
        let a = s >>> 0;
        const rand = () => { // mulberry32
            a = (a + 0x6d2b79f5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), a | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const jitter = () => (rand() - 0.5) * spacing;
        const pos = [], rot = [], scl = [], col = [], alpha = [], normal = [], ao = [];
        const q = quatFromBasis(flip([1, 0, 0]), flip([0, 0, -1]), flip([0, 1, 0])); // thin axis up
        const reach = LAKE.radius + 2;
        for (let x = LAKE.x - reach; x <= LAKE.x + reach; x += spacing) {
            for (let z = LAKE.z - reach; z <= LAKE.z + reach; z += spacing) {
                const px = x + jitter(), pz = z + jitter();
                const sh = shore(px, pz);
                if (sh > 0.06) continue;
                const edge = 1 - smooth(-0.25, 0.06, sh); // clear at the shore
                const deep = smooth(0, 2.5, -sh);
                pos.push(...flip([px, waterLevel, pz]));
                rot.push(...q);
                const r = spacing * (0.42 + 0.12 * rand()); // just enough overlap to close the surface
                scl.push(r, r, 0.003);
                col.push(...(alpine ? mix([0.2, 0.55, 0.46], [0.03, 0.24, 0.24], deep) : mix([0.24, 0.46, 0.42], [0.06, 0.2, 0.24], deep))); // alpine: emerald
                alpha.push(Math.max(0.02, Math.min(0.95, (0.2 + 0.72 * Math.sqrt(deep)) * edge)));
                normal.push(...flip([0, 1, 0]));
                ao.push(1);
            }
        }
        return packSplats(app, 'water', { pos, rot, scl, col, alpha, normal, ao });
    }

    return { scene, waterLevel, half, outer, walkHalf, grassReach, height, surface, isWater, shore, sample, albedo, water, surfacePoints, bake, relief, footZ, up, scree };
}
