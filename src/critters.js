import * as pc from 'playcanvas';
import { packSplats, quatFromBasis, flip } from './meadow.js';

// Butterflies, bumblebees and fireflies (synthetic world): a handful of splats each, built
// in the critter's own frame (x forward, y up, z to its right) around its origin. The
// relight shader (uCritters) moves every critter along its own path, faces it where it
// flies, flaps its wings and shows it by day (butterflies, bees) or at dusk and night
// (fireflies, which blink and glow). Two tables drive it: per splat, which critter it
// belongs to and which part it is (critterBytes); per critter, where its home patch is
// and what kind it is (pathData: centre x, ground y, centre z, kind + seed). A height
// map of the meadow (the lake counted at its water level) lets the shader keep each
// critter at its height above the ground right under it, wherever its path goes. Both
// share one float texture: row 0 holds the paths, rows 1 to G the height map (in red),
// so the splat shader needs no extra sampler.

export const PART = { BODY: 0, WING_RIGHT: 1, WING_LEFT: 2, GLOW_CORE: 3, GLOW_HALO: 4 };
export const KIND = { BUTTERFLY: 0, BEE: 1, FIREFLY: 2 };

const BUTTERFLIES = [
    { wing: [0.96, 0.96, 0.9], tip: [0.15, 0.14, 0.12] },  // cabbage white
    { wing: [1.0, 0.9, 0.35], tip: [0.85, 0.72, 0.2] },    // brimstone
    { wing: [0.95, 0.5, 0.1], tip: [0.08, 0.06, 0.05] },   // orange, dark tips
    { wing: [0.45, 0.62, 1.0], tip: [0.25, 0.3, 0.55] }    // common blue
];

function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// land: land.js; counts of each kind
export function buildCritters(app, { land, butterflies = 16, bees = 24, fireflies = 110, seed = 9 }) {
    const rand = rng(seed);
    const pos = [], rot = [], scl = [], col = [], alpha = [], normal = [], ao = [];
    const parts = [];
    const paths = [];
    let id = 0;
    const emit = (p, yaw, size, c, op, part) => {
        // a flat splat in the critter's x-z plane, turned by yaw about its up axis
        const a = [Math.cos(yaw), 0, -Math.sin(yaw)], b = [Math.sin(yaw), 0, Math.cos(yaw)];
        pos.push(...flip(p));
        rot.push(...quatFromBasis(flip(a), flip(b), flip([0, -1, 0])));
        scl.push(...size);
        col.push(...c);
        alpha.push(op);
        normal.push(...flip([0, 1, 0]));
        ao.push(1);
        parts.push(id, part);
    };
    // a home patch in the meadow; flowery for butterflies and bees, anywhere in the grass
    // (the lake shore included) for fireflies
    const home = (wantFlowers) => {
        for (let tries = 0; tries < 400; tries++) {
            const x = (rand() * 2 - 1) * land.grassReach, z = (rand() * 2 - 1) * land.grassReach;
            const s = land.sample(x, z);
            if (!s) continue;
            if (wantFlowers && s.flowers.chance < 0.25 && tries < 300) continue;
            return [x, land.surface(x, z), z];
        }
        return [0, land.surface(0, 0), 4];
    };
    const addPath = (kind, wantFlowers, at = null) => {
        const [x, y, z] = at ?? home(wantFlowers);
        paths.push(x, y, z, kind + Math.min(0.999, rand()));
    };
    // spread evenly: one home per cell of a grid over the meadow, at a random spot in it
    const spread = (count) => {
        const n = Math.ceil(Math.sqrt(count * 1.6)), cell = 2 * land.grassReach / n;
        const cells = [];
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            for (let tries = 0; tries < 30; tries++) {
                const x = -land.grassReach + (i + rand()) * cell, z = -land.grassReach + (j + rand()) * cell;
                if (land.sample(x, z)) { cells.push([x, land.surface(x, z), z]); break; }
            }
        }
        for (let i = cells.length - 1; i > 0; i--) { const k = Math.floor(rand() * (i + 1)); [cells[i], cells[k]] = [cells[k], cells[i]]; }
        return cells.slice(0, count);
    };
    const beeHomes = spread(bees);

    for (let i = 0; i < butterflies; i++, id++) {
        const look = BUTTERFLIES[i % BUTTERFLIES.length];
        const s = 1.15 + rand() * 0.35; // a little larger than life, to read in VR
        emit([0, 0, 0], 0, [0.012 * s, 0.003 * s, 0.0028 * s], [0.12, 0.1, 0.08], 0.98, PART.BODY);
        for (const side of [1, -1]) {
            const part = side > 0 ? PART.WING_RIGHT : PART.WING_LEFT;
            // forewing, swept a little forward, with a darker tip; hindwing smaller, behind
            emit([0.004 * s, 0, 0.021 * side * s], 0.35 * side, [0.013 * s, 0.019 * s, 0.0012], look.wing, 0.97, part);
            emit([0.012 * s, 0.0005, 0.033 * side * s], 0.5 * side, [0.006 * s, 0.006 * s, 0.0012], look.tip, 0.95, part);
            emit([-0.008 * s, -0.0005, 0.016 * side * s], -0.3 * side, [0.01 * s, 0.013 * s, 0.0012], look.wing.map(v => v * 0.92), 0.97, part);
        }
        addPath(KIND.BUTTERFLY, true);
    }
    for (let i = 0; i < bees; i++, id++) {
        // a bumblebee: round and fuzzy, black with a yellow collar, a yellow band and a white tail
        const s = 2.1 + rand() * 0.4;
        const black = [0.06, 0.055, 0.05], yellow = [0.98, 0.78, 0.18], white = [0.95, 0.93, 0.86];
        emit([0.0075 * s, 0, 0], 0, [0.0028 * s, 0.0027 * s, 0.0027 * s], black, 0.98, PART.BODY);          // head
        emit([0.0035 * s, 0.0004 * s, 0], 0, [0.0028 * s, 0.0042 * s, 0.0044 * s], yellow, 0.98, PART.BODY); // yellow collar
        emit([0.0005 * s, 0, 0], 0, [0.004 * s, 0.0044 * s, 0.0046 * s], black, 0.98, PART.BODY);           // thorax
        emit([-0.0045 * s, 0, 0], 0, [0.0028 * s, 0.0052 * s, 0.0054 * s], yellow, 0.98, PART.BODY);        // yellow band
        emit([-0.0075 * s, 0, 0], 0, [0.003 * s, 0.005 * s, 0.0052 * s], black, 0.98, PART.BODY);           // black band
        emit([-0.0105 * s, 0, 0], 0, [0.0028 * s, 0.0038 * s, 0.004 * s], white, 0.98, PART.BODY);          // white tail
        emit([-0.002 * s, 0, 0], 0, [0.011 * s, 0.0062 * s, 0.0064 * s], [0.45, 0.38, 0.2], 0.3, PART.BODY); // fuzz around it all
        for (const side of [1, -1]) {
            emit([-0.001 * s, 0.0055 * s, 0.0065 * side * s], 0.25 * side, [0.0065 * s, 0.0042 * s, 0.0008], [0.8, 0.82, 0.86], 0.35,
                side > 0 ? PART.WING_RIGHT : PART.WING_LEFT);
        }
        addPath(KIND.BEE, false, beeHomes[i]);
    }
    for (let i = 0; i < fireflies; i++, id++) {
        emit([0, 0, 0], 0, [0.0045, 0.0045, 0.0045], [1.0, 0.95, 0.45], 0.95, PART.GLOW_CORE);
        emit([0, 0, 0], 0, [0.04, 0.04, 0.04], [0.7, 1.0, 0.35], 0.45, PART.GLOW_HALO);
        addPath(KIND.FIREFLY, false);
    }

    const out = packSplats(app, 'critters', { pos, rot, scl, col, alpha, normal, ao });
    const critterBytes = new Uint8Array(out.count * 4);
    for (let i = 0; i < out.count; i++) {
        const who = parts[i * 2];
        critterBytes[i * 4] = who & 255;
        critterBytes[i * 4 + 1] = who >> 8;
        critterBytes[i * 4 + 2] = parts[i * 2 + 1];
    }
    // ground under the critters: the meadow's surface, the lake at its water level
    const G = 128, reach = land.grassReach + 4;
    const W = Math.max(id, G);
    const table = new Float32Array(W * (G + 1) * 4);
    table.set(paths); // row 0
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        const x = -reach + i / (G - 1) * 2 * reach, z = -reach + j / (G - 1) * 2 * reach;
        table[((j + 1) * W + i) * 4] = Math.max(land.surface(x, z), land.waterLevel);
    }
    const pathTex = new pc.Texture(app.graphicsDevice, {
        name: 'critter-paths', width: W, height: G + 1, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
        minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, levels: [table]
    });
    const groundRect = [-reach, -reach, (G - 1) / (2 * reach), G];
    const homes = [];
    for (let i = 0; i < id; i++) homes.push([paths[i * 4], paths[i * 4 + 1], paths[i * 4 + 2], Math.floor(paths[i * 4 + 3])]);
    return { ...out, critterBytes, pathTex, groundRect, homes, height: 1, stats: { butterflies, bees, fireflies } };
}
