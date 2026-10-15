import { packSplats, quatFromBasis, flip } from './meadow.js';

// Procedural broadleaf tree (an oak after a summer reference photo, with an old,
// contorted, bonsai-like trunk), built straight from splats. Branches grow recursively:
// a stout trunk splitting into big limbs, then branches and twigs. Trunk and limbs bend
// in smooth S-curves (curvature from a few sines along the length, carried in a
// parallel-transported frame) and rise towards the light. The trunk flares at the foot
// into surface roots that follow and sink into the ground; its cross-section has lobes
// that spiral up as it twists, and every limb swells where it leaves its parent. Bark
// is overlapping tile-like splats around the wood, coloured from a CC0 bark photo and
// pushed in or out by its displacement map, so the furrows have real depth; thin twigs
// are one elongated splat per segment. Leaves grow in clumps at the twig ends, mostly on each
// clump's outer shell, as small flat splats: bright and yellow-green where exposed on
// top, dark and occluded underneath and inside the crown.
//
// Per splat we know the normal, AO and a wind weight (height in the crown) and phase
// (one per clump, so a clump moves together), so the relight shader lights, shadows
// and sways it like the meadow. Output is in the PLY source frame for place().

function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map(v => v * s);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// any unit vector perpendicular to d
const perp = (d) => norm(Math.abs(d[1]) < 0.9 ? cross(d, [0, 1, 0]) : cross(d, [1, 0, 0]));
// d tilted by `angle` (radians) towards the azimuth `spin` around it
function tilt(d, angle, spin) {
    const u = perp(d), v = cross(d, u);
    const side = add(scale(u, Math.cos(spin)), scale(v, Math.sin(spin)));
    return norm(add(scale(d, Math.cos(angle)), scale(side, Math.sin(angle))));
}

// levels: trunk, limbs, branches, twigs. gnarl (small jitter), up (rise to the light),
// bend (curvature, rad/m), wave (length of a bend, m), lobes and twist (rad/m) shape the
// branch of that level; children, start, angle, length and radius shape its children.
const LEVELS = [
    { children: 6, start: 0.62, angle: [0.55, 1.1], length: [4.2, 5.2], radius: 0.55, gnarl: 0.02, up: 0.012, bend: 0.55, wave: 2.6, lobes: 0.17, twist: 0.7 },
    { children: 6, start: 0.22, angle: [0.6, 1.0], length: [1.8, 2.8], radius: 0.5, gnarl: 0.04, up: 0.01, bend: 0.5, wave: 1.9, lobes: 0.09, twist: 0.5 },
    { children: 4, start: 0.3, angle: [0.6, 1.0], length: [0.8, 1.4], radius: 0.55, gnarl: 0.12, up: 0.025, bend: 0.4, wave: 1.1, lobes: 0.04, twist: 0.3 },
    { children: 0, gnarl: 0.22, up: 0.015, bend: 0.3, wave: 0.7, lobes: 0, twist: 0 }
];
const ROOT = { gnarl: 0.05, up: 0, bend: 0.7, wave: 1.3, lobes: 0.1, twist: 0.2 };
const TRUNK = { length: 3.0, radius: 0.26, flare: 0.2, lean: 0.28, taper: 0.3 }; // a trunk barely narrows; branches do
const BARK_SIZE = 2.15; // metres covered by the bark photo
const BARK = [[0.3, 0.27, 0.22], [0.42, 0.38, 0.31]];
const LEAF_DARK = [0.1, 0.2, 0.05], LEAF_MID = [0.22, 0.38, 0.09], LEAF_SUN = [0.5, 0.62, 0.16];

// A spruce-like pine for the alpine scene: a tall, nearly straight trunk tapering to the
// top, branches all the way up in a spiral, long below and short above (a cone),
// drooping a little and turning up at the tips; needles in flat dark pads along them.
const PINE_LEVELS = [
    { children: 34, start: 0.14, angle: [1.5, 1.85], lengthAt: (t, r) => (2.7 * (1 - t) ** 0.95 + 0.25) * (0.85 + 0.3 * r()),
      radius: 0.3, gnarl: 0.006, up: 0.004, bend: 0.06, wave: 4, lobes: 0.05, twist: 0.15 },
    { children: 5, start: 0.25, angle: [0.7, 1.1], length: [0.35, 0.8], radius: 0.5, gnarl: 0.05, up: 0.02, bend: 0.25, wave: 1.2, lobes: 0, twist: 0 },
    { children: 0, gnarl: 0.1, up: 0.01, bend: 0.2, wave: 0.8, lobes: 0, twist: 0 }
];
const SPECIES = {
    oak: { levels: LEVELS, trunk: TRUNK, leaf: [LEAF_DARK, LEAF_MID, LEAF_SUN], needles: false, roots: 6 },
    pine: { levels: PINE_LEVELS, trunk: { length: 12, radius: 0.24, flare: 0.2, lean: 0.03, taper: 0.88 },
            leaf: [[0.03, 0.09, 0.05], [0.08, 0.19, 0.1], [0.2, 0.33, 0.14]], needles: true, roots: 4 }
};

// base: trunk foot in world space; leaves: leaf splat budget; groundAt(x, z): ground
// height, for the roots; bark(u, v) -> { c: [r, g, b], h: 0..1 } samples the bark photo
// and its displacement (u, v in photo repeats), or null for plain colours.
// species: 'oak' (the default) or 'pine'; size scales the trunk's length (and its girth a little)
export function buildTree(app, { base, leaves = 90000, seed = 7, groundAt = () => base[1], bark = null, species = 'oak', size = 1 }) {
    const S = SPECIES[species];
    const LV = S.levels, TR = { ...S.trunk, length: S.trunk.length * size, radius: S.trunk.radius * Math.sqrt(size) };
    const rand = rng(seed);            // the tree's structure
    const barkRand = rng(seed + 101);  // bark tile jitter: separate, so bark changes never reshuffle the structure
    const rootRand = rng(seed + 202);  // the roots: separate too
    const range = ([a, b]) => a + (b - a) * rand();
    const pos = [], rot = [], scl = [], col = [], alpha = [], normal = [], ao = [], wind = [];
    let height = 9; // for the wind weight; refined once the crown is known
    const emit = (p, a, b, size, c, op, n, occ, phase) => {
        pos.push(...flip(p));
        rot.push(...quatFromBasis(flip(a), flip(b), flip(cross(a, b))));
        scl.push(...size);
        col.push(...c);
        alpha.push(op);
        normal.push(...flip(n));
        ao.push(occ);
        wind.push(phase); // the weight is filled in at the end, from the height
    };

    // ---- bark: overlapping tiles around a tube of nodes, coloured and displaced by the photo
    function barkTube(nodes, L, phase) {
        const lobePhase = [barkRand() * 6.2832, barkRand() * 6.2832];
        for (let s = 0; s < nodes.length - 1; s++) {
            const { p: a, r, u, arc } = nodes[s];
            const b = nodes[s + 1].p;
            const ab = add(b, scale(a, -1));
            const len = Math.hypot(...ab);
            const axis = scale(ab, 1 / len);
            const shade = 0.45 + 0.4 * Math.min(1, (a[1] - base[1]) / 6);
            if (r < 0.03) {
                // thin wood: one elongated splat per segment
                const c = bark ? bark(0.37, arc / BARK_SIZE).c : mix(BARK[0], BARK[1], barkRand());
                emit(add(a, scale(ab, 0.5)), axis, perp(axis), [len * 0.55, r * 0.9, r * 0.9], c.map(v => v * 0.9), 0.95, perp(axis), shade, phase);
                continue;
            }
            let tile = Math.min(0.022, Math.max(0.016, r * 0.3)); // small tiles keep the bark crisp
            // a pine's trunk hides among its branches above head height: larger tiles there
            if (S.needles) tile = Math.max(0.028, Math.min(0.07, 0.028 + 0.008 * Math.max(0, a[1] - base[1] - 2.5)));
            const around = Math.max(6, Math.round(2 * Math.PI * r / tile));
            const rings = Math.max(1, Math.round(len / (tile * 1.1)));
            const uu = norm(add(u, scale(axis, -dot(u, axis)))), vv = cross(axis, uu);
            const depth = Math.min(0.032, r * 0.2); // furrow depth
            // how fast the radius changes along the wood: on a flaring foot the surface slopes
            // outwards, and the tiles must lie along that slope rather than stand on the axis
            const rNext = nodes[s + 1].r;
            const slope = (rNext - r) / len;
            const along = Math.sqrt(1 + slope * slope);
            for (let k = 0; k < rings; k++) {
                const f = (k + 0.5) / rings, at = arc + f * len;
                const c0 = add(a, scale(ab, f));
                const rf = r + (rNext - r) * f; // radius grows smoothly, ring by ring
                const twist = L.twist * at;
                // lobes are a little stronger at the foot of the trunk, where they run into the roots
                const lobeAmp = L.lobes * (1 + (L === LV[0] ? 0.3 * Math.exp(-at / 0.6) : 0));
                for (let j = 0; j < around; j++) {
                    const th = (j + (barkRand() - 0.5) * 0.3) / around * 6.2832;
                    const a3 = 3 * th + twist + lobePhase[0], a5 = 5 * th - 0.7 * twist + lobePhase[1];
                    const lobe = 1 + lobeAmp * (0.6 * Math.cos(a3) + 0.4 * Math.cos(a5));
                    const dLobe = -lobeAmp * (1.8 * Math.sin(a3) + 2.0 * Math.sin(a5)); // d(lobe)/d(angle)
                    const out = add(scale(uu, Math.cos(th)), scale(vv, Math.sin(th)));
                    const round = cross(axis, out); // direction of increasing angle around the wood
                    // the fluted surface: tangent around it and its true normal, so tiles lie flat on
                    // the flute walls instead of sticking out of them like fins
                    const R = rf * lobe, dR = rf * dLobe;
                    const tangent = norm(add(scale(out, dR), scale(round, R)));
                    const surfaceOut = norm(add(scale(out, R), scale(round, -dR)));
                    // the photo follows the twist, so the furrows spiral with the lobes
                    const bu = ((th + twist) * r) / BARK_SIZE, bv = at / BARK_SIZE;
                    const sample = bark ? bark(bu, bv) : { c: mix(BARK[0], BARK[1], barkRand()), h: barkRand() };
                    const rr = rf * lobe + (sample.h - 0.5) * depth;
                    // furrows dark, ridges light
                    const c = sample.c.map(v => v * (0.45 + 0.85 * sample.h));
                    let up = norm(add(axis, scale(surfaceOut, slope * lobe))); // along the surface, up the wood
                    let side = scale(tangent, -1);
                    if (bark) {
                        // tilt the tile with the slope of the bark relief, so ridges catch the light
                        // and furrow walls fall into shade
                        const e = 0.012 / BARK_SIZE, step = 2 * 0.012;
                        const dAround = (bark(bu + e, bv).h - bark(bu - e, bv).h) * depth / step;
                        const dAlong = (bark(bu, bv + e).h - bark(bu, bv - e).h) * depth / step;
                        up = norm(add(up, scale(surfaceOut, dAlong)));
                        const s0 = add(side, scale(surfaceOut, dAround));
                        side = norm(add(s0, scale(up, -dot(up, s0))));
                    }
                    const width = Math.hypot(R, dR) * Math.PI / around * 1.25; // true surface length per tile
                    // tiles overlap their neighbours above and below and are staggered a little, so rows don't show as stripes
                    const stagger = scale(ab, (barkRand() - 0.5) * 0.5 / rings);
                    emit(add(add(c0, stagger), scale(out, rr)), up, side, [len * along / rings * 0.75, width * 0.85, 0.004],
                        c, 0.995, cross(up, side), shade * (0.35 + 0.65 * sample.h) * (0.8 + 0.2 * Math.max(0, out[1] + 0.5)), phase);
                }
            }
        }
    }

    // a path of nodes that bends smoothly: curvature about two axes of a frame carried
    // along the path (parallel transport), each a sum of two sines of the arc length
    function path(origin, dir, length, radiusAt, L, step, onStep = null, random = rand) {
        const segments = Math.max(3, Math.round(length / step));
        const st = length / segments;
        const w = 2 * Math.PI / L.wave;
        const ph = [random(), random(), random(), random()].map(v => v * 6.2832);
        const nodes = [];
        let p = origin, d = dir, u = perp(dir);
        for (let s = 0; s <= segments; s++) {
            const arc = s * st, t = s / segments;
            nodes.push({ p, d, u, r: radiusAt(t, arc), t, arc });
            const v = cross(d, u);
            const cu = L.bend * (Math.sin(arc * w + ph[0]) + 0.5 * Math.sin(arc * w * 2.3 + ph[1]));
            const cv = L.bend * (Math.sin(arc * w * 0.8 + ph[2]) + 0.5 * Math.sin(arc * w * 1.9 + ph[3]));
            const wobble = [random() - 0.5, random() - 0.5, random() - 0.5];
            d = norm(add(add(add(d, scale(u, cu * st)), scale(v, cv * st)), add(scale(wobble, L.gnarl), [0, L.up, 0])));
            u = norm(add(u, scale(d, -dot(u, d))));
            p = add(p, scale(d, st));
            if (onStep) [p, d] = onStep(p, d, t);
        }
        return nodes;
    }

    // ---- branches
    const clumps = [];
    function grow(origin, dir, length, radius, level, phase, flare = 0) {
        const L = LV[level];
        const nodes = path(origin, dir, length, (t, arc) => {
            let r = radius * (1 - (level === 0 ? TR.taper : 0.6) * t);
            if (flare) r *= 1 + flare * Math.exp(-arc / 0.3);        // the trunk's foot: a slight swell into the roots
            else r *= 1 + 0.6 * Math.exp(-arc / 0.22);               // collar where a limb leaves its parent
            return r;
        }, L, level <= 1 ? 0.06 : 0.12);
        barkTube(nodes, L, phase);
        // children
        if (L.children) {
            const count = L.children + Math.floor(rand() * 2);
            const spin0 = rand() * 6.2832;
            for (let i = 0; i < count; i++) {
                const t = L.start + (1 - L.start) * (count === 1 ? 1 : i / (count - 1)) * (0.85 + 0.15 * rand());
                const n = nodes[Math.min(nodes.length - 1, Math.round(t * (nodes.length - 1)))];
                const childDir = tilt(n.d, range(L.angle), spin0 + i * 2.39996 + rand() * 0.5); // golden angle around the parent
                const childLen = L.lengthAt ? L.lengthAt(t, rand) : range(L.length) * (1 - 0.35 * (t - L.start));
                // start a little inside the parent, so the collar grows out of it
                grow(add(n.p, scale(childDir, -n.r * 0.3)), childDir, childLen, Math.max(0.012, n.r * L.radius), level + 1, level === 0 ? rand() : phase);
            }
        }
        if (S.needles && level >= 1) {
            // needle pads along the branch, flattened, smaller towards its tip
            const every = Math.max(1, Math.round(0.3 / (level <= 1 ? 0.06 : 0.12)));
            for (let k = level === 1 ? Math.round(nodes.length * 0.15) : 0; k < nodes.length; k += every) {
                const n = nodes[k];
                const r = level === 1 ? 0.24 + 0.24 * (1 - 0.6 * n.t) : 0.22;
                clumps.push({ c: add(n.p, [0, -0.04, 0]), r: r * (0.85 + 0.3 * rand()), flat: 0.5, phase: phase + rand() * 0.2 });
            }
        } else if (level >= 2) {
            // an irregular clump: two or three overlapping lumps around the branch end
            const end = nodes[nodes.length - 1];
            const r = level === 3 ? 0.4 + 0.3 * rand() : 0.5 + 0.3 * rand();
            const lumps = [{ c: end.p, r }];
            for (let i = 1 + Math.floor(rand() * 2); i > 0; i--) {
                const off = [rand() - 0.5, (rand() - 0.5) * 0.6, rand() - 0.5].map(v => v * r * 1.4);
                lumps.push({ c: add(add(end.p, scale(end.d, -r * 0.4 * rand())), off), r: r * (0.55 + 0.35 * rand()) });
            }
            clumps.push(...lumps.map(l => ({ ...l, phase: phase + rand() * 0.2 })));
        }
    }
    // the trunk leans a little to one side; its bends bring it back towards the light
    grow(base, tilt([0, 1, 0], TR.lean, rand() * 6.2832), TR.length, TR.radius, 0, 0, TR.flare);

    // surface roots: out from the foot, hugging the ground and sinking into it as they thin
    const roots = S.roots + Math.floor(rootRand() * 3);
    for (let i = 0; i < roots; i++) {
        const a = (i + (rootRand() - 0.5) * 0.6) / roots * 6.2832;
        const out = [Math.cos(a), 0, Math.sin(a)];
        const r0 = TR.radius * (0.3 + 0.18 * rootRand());
        const start = add(base, add(scale(out, TR.radius * 0.7), [0, 0.12, 0]));
        const nodes = path(start, norm(add(out, [0, -0.25, 0])), 1.1 + rootRand() * 1.0, (t) => r0 * (1 - 0.85 * t), ROOT, 0.06,
            (p, d, t) => {
                const flat = norm([d[0], 0, d[2]]);
                const y = groundAt(p[0], p[2]) - r0 * (1 - 0.85 * t) * (0.3 + 0.6 * t); // sunk into the ground, more as it thins
                return [[p[0], y, p[2]], flat];
            }, rootRand);
        barkTube(nodes, ROOT, 0);
    }

    // ---- crown shape: centre and extent of the clumps, for exposure and AO
    let top = -Infinity, bottom = Infinity;
    const centre = [0, 0, 0];
    for (const k of clumps) {
        top = Math.max(top, k.c[1] + k.r); bottom = Math.min(bottom, k.c[1] - k.r);
        for (let i = 0; i < 3; i++) centre[i] += k.c[i] / clumps.length;
    }
    let crownRadius = 0;
    for (const k of clumps) crownRadius = Math.max(crownRadius, Math.hypot(k.c[0] - centre[0], k.c[2] - centre[2]) + k.r);
    height = top - base[1];

    // ---- leaves: shared out over the clumps by their surface area
    const area = clumps.reduce((s, k) => s + k.r * k.r, 0);
    for (const k of clumps) {
        const n = Math.round(leaves * k.r * k.r / area);
        const hue = (rand() - 0.5) * 0.08;
        // how exposed the clump is: on top and at the edge of the crown
        const outward = norm(add(k.c, scale(centre, -1)));
        const radial = Math.hypot(k.c[0] - centre[0], k.c[2] - centre[2]) / crownRadius;
        const clumpExposure = clamp01(0.25 + 0.5 * (k.c[1] - bottom) / (top - bottom) + 0.35 * radial);
        for (let i = 0; i < n; i++) {
            // mostly on the clump's outer shell, flattened a little underneath
            const dir = norm([rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]);
            // leaves on the inner side of a clump deep in the crown are always hidden behind
            // other clumps: skip most of them (they would only cost fill)
            if (dot(dir, outward) < -0.15 && radial < 0.75 && rand() < 0.85) continue;
            const shell = 0.55 + 0.45 * Math.sqrt(rand());
            const offset = scale(dir, k.r * shell);
            if (offset[1] < 0) offset[1] *= 0.6;
            if (k.flat) offset[1] *= k.flat; // a pine's needle pads are flat
            const p = add(k.c, offset);
            // leaf faces mostly outwards from its clump and up, with some flutter of angle
            const nrm = norm(add(add(scale(dir, 0.7), [0, 0.6, 0]), [(rand() - 0.5) * 0.9, (rand() - 0.5) * 0.9, (rand() - 0.5) * 0.9]));
            const a = perp(nrm), spin = rand() * 6.2832; // any direction in the leaf plane
            const spun = add(scale(a, Math.cos(spin)), scale(cross(nrm, a), Math.sin(spin)));
            const b = cross(nrm, spun);
            const exposure = clamp01(clumpExposure * 0.55 + 0.45 * (shell - 0.55) / 0.45 * Math.max(0, dir[1] * 0.6 + 0.5) + 0.15 * dot(dir, outward));
            const [dark, midC, sun] = S.leaf;
            let c = exposure < 0.5 ? mix(dark, midC, exposure * 2) : mix(midC, sun, (exposure - 0.5) * 2);
            c = c.map((v, j) => clamp01(v * (0.88 + 0.24 * rand()) + (j === 0 ? hue : j === 2 ? -hue * 0.5 : 0)));
            const s = 0.022 + 0.012 * rand();
            // a pine's needles: thin and long; an oak's leaves: broad
            emit(p, spun, b, S.needles ? [s * 2.6, s * 0.75, 0.0015] : [s * 1.4, s, 0.0015], c, 0.92, nrm, 0.3 + 0.7 * exposure, k.phase);
        }
    }

    // wind weight: nothing at the foot, growing with height through the crown
    const windPairs = [];
    for (let i = 0; i < alpha.length; i++) {
        const y = -pos[i * 3 + 1]; // back from the source frame (Y down)
        const h = clamp01((y - base[1]) / height);
        windPairs.push(h * h, wind[i]);
    }
    const out = packSplats(app, 'tree', { pos, rot, scl, col, alpha, normal, ao, wind: windPairs });
    return { ...out, height, crown: { centre, radius: crownRadius, top, bottom }, stats: { clumps: clumps.length } };
}
