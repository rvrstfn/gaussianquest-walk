import { packSplats, quatFromBasis, flip } from './meadow.js';

// Boulders (alpine scene): angular blocks covered in small tile-like splats, like the
// tree's bark. The shape is the inside of a dozen random cut planes, flattened and sunk
// into the ground. Each tile takes its colour from a CC0
// cliff photo, tinted to pale limestone, and is pushed in or out by the photo's
// displacement map; crevices are darker.

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
const perp = (d) => norm(Math.abs(d[1]) < 0.9 ? cross(d, [0, 1, 0]) : cross(d, [1, 0, 0]));
const LIMESTONE = [0.6, 0.58, 0.54];

// boulders: [{ x, z, r }]; groundAt(x, z); rock(u, v) -> { c, h } samples the cliff photo
// and its displacement (u, v in photo repeats); size: metres the photo covers
export function buildBoulders(app, { boulders, groundAt, rock, size = 5.75, seed = 31 }) {
    const rand = rng(seed);
    const pos = [], rot = [], scl = [], col = [], alpha = [], normal = [], ao = [];
    for (const b of boulders) {
        // shape: a block broken off the cliff, the space inside a dozen random cut planes,
        // so the faces are flat and meet at sharp edges; a faint wave keeps the faces from
        // looking machined
        const waves = [[3.1, 0.035], [7.3, 0.015]].map(([f, amp]) => ({ d: norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]), f, amp, ph: rand() * 6.2832 }));
        const squash = 0.7 + 0.2 * rand();
        const facets = Array.from({ length: 10 + Math.floor(rand() * 5) }, () => ({ n: norm([rand() - 0.5, rand() - 0.5, rand() - 0.5]), at: 0.68 + 0.3 * rand() }));
        facets.push({ n: [0, 1, 0], at: 0.75 + 0.2 * rand() }); // a flattish top
        const radiusAt = (d) => {
            let r = 1.15;
            for (const f of facets) { const c = dot(d, f.n); if (c > 0.02) r = Math.min(r, f.at / c); }
            r *= 1 + waves.reduce((s, w) => s + w.amp * Math.sin(w.f * dot(d, w.d) + w.ph), 0);
            return b.r * r;
        };
        const ground = groundAt(b.x, b.z);
        const centre = [b.x, ground + b.r * squash * 0.35, b.z]; // a third sunk into the ground
        const surface = (d) => { const r = radiusAt(d); return add(centre, [d[0] * r, d[1] * r * squash, d[2] * r]); };
        // tiles about 4 cm apart, spread evenly over the sphere (Fibonacci spiral)
        const tile = 0.04;
        const n = Math.max(60, Math.round(4 * Math.PI * b.r * b.r / (tile * tile)));
        const tint = 0.9 + 0.15 * rand();
        for (let i = 0; i < n; i++) {
            const y = 1 - 2 * (i + 0.5) / n, ring = Math.sqrt(1 - y * y), a = i * 2.39996;
            const d = [Math.cos(a) * ring, y, Math.sin(a) * ring];
            const p = surface(d);
            if (p[1] < groundAt(p[0], p[2]) - 0.04) continue; // buried
            // the surface normal, from two neighbouring points on the shape
            const t1 = perp(d), t2 = cross(d, t1);
            const e = 0.006; // small, so the edges stay sharp
            const pa = surface(norm(add(d, scale(t1, e)))), pb = surface(norm(add(d, scale(t2, e))));
            let nrm = norm(cross(add(pa, scale(p, -1)), add(pb, scale(p, -1))));
            if (dot(nrm, d) < 0) nrm = scale(nrm, -1);
            // the photo, projected along the normal's main axis
            const ax = Math.abs(nrm[0]), ay = Math.abs(nrm[1]), az = Math.abs(nrm[2]);
            const [u, v] = ay > ax && ay > az ? [p[0], p[2]] : ax > az ? [p[2], p[1]] : [p[0], p[1]];
            const sample = rock(u / size + b.x * 0.13, v / size + b.z * 0.17);
            const out = add(p, scale(nrm, (sample.h - 0.5) * 0.04));
            // pale limestone with a little of the photo's own colour; crevices darker
            const luma = sample.c[0] * 0.3 + sample.c[1] * 0.59 + sample.c[2] * 0.11;
            const c = LIMESTONE.map((g, k) => Math.min(1, (g * luma / 0.5 * 0.8 + sample.c[k] * 0.2) * tint * (0.6 + 0.6 * sample.h)));
            // each tile covers its share of the surface, which grows on faces far from the
            // centre or slanted to it, so the corners get no gaps
            const r = Math.hypot(p[0] - centre[0], (p[1] - centre[1]) / squash, p[2] - centre[2]);
            const share = 4 * Math.PI * r * r / n / Math.max(0.3, dot(nrm, d));
            const disc = Math.min(tile * 1.6, 0.62 * Math.sqrt(share));
            const ta = perp(nrm), tb = cross(nrm, ta);
            pos.push(...flip(out));
            rot.push(...quatFromBasis(flip(ta), flip(tb), flip(nrm)));
            scl.push(disc, disc, 0.004);
            col.push(...c);
            alpha.push(0.995);
            normal.push(...flip(nrm));
            ao.push(Math.min(1, 0.45 + 0.55 * sample.h) * (0.75 + 0.25 * Math.max(0, nrm[1])));
        }
    }
    return { ...packSplats(app, 'boulders', { pos, rot, scl, col, alpha, normal, ao }), height: 2 };
}
