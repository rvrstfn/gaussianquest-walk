import { packSplats, quatFromBasis, flip } from './meadow.js';

// The lantern carried in the right hand: a storm lantern built from splats, with an iron
// base and cap, a glass globe around a flame, four wire guards and a brass handle whose
// top is the hook. It is 1 unit tall, centred on the origin (held at LANTERN.scale), and
// its glass and flame are warm enough for the relighting shader to make them glow.

const IRON = [0.11, 0.12, 0.11], BRASS = [0.42, 0.32, 0.14], GLASS = [0.9, 0.6, 0.34], FLAME = [1.0, 0.85, 0.45];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const perp = (d) => norm(Math.abs(d[1]) < 0.9 ? cross(d, [0, 1, 0]) : cross(d, [1, 0, 0]));

export function buildLantern(app) {
    const pos = [], rot = [], scl = [], col = [], alpha = [], normal = [], ao = [];
    // a flat disc splat at p facing n
    const disc = (p, n, r, c, a = 0.99, occl = 1) => {
        const ta = perp(n), tb = cross(n, ta);
        pos.push(...flip(p));
        rot.push(...quatFromBasis(flip(ta), flip(tb), flip(n)));
        scl.push(r, r, r * 0.15);
        col.push(...c); alpha.push(a); normal.push(...flip(n)); ao.push(occl);
    };
    // a surface of revolution: radius(t) for t in 0..1 from y0 to y1, tiles about `step` apart
    const lathe = (y0, y1, radius, c, { step = 0.02, a = 0.99, inward = false } = {}) => {
        const rows = Math.max(2, Math.ceil(Math.abs(y1 - y0) / step));
        for (let i = 0; i <= rows; i++) {
            const t = i / rows, y = y0 + (y1 - y0) * t, r = radius(t);
            const dr = (radius(Math.min(1, t + 0.01)) - radius(Math.max(0, t - 0.01))) / 0.02 / (y1 - y0);
            const around = Math.max(6, Math.ceil(2 * Math.PI * r / step));
            for (let j = 0; j < around; j++) {
                const ang = (j + 0.5 * (i % 2)) / around * 2 * Math.PI, cx = Math.cos(ang), cz = Math.sin(ang);
                let n = norm([cx, -dr, cz]);
                if (inward) n = n.map(v => -v);
                disc([cx * r, y, cz * r], n, step * 0.75, c, a);
            }
        }
    };
    // a flat ring or disc at height y, facing up or down
    const cap = (y, r0, r1, up, c) => {
        for (let r = r0; r <= r1 + 1e-6; r += 0.02) {
            const around = Math.max(1, Math.ceil(2 * Math.PI * r / 0.02));
            for (let j = 0; j < around; j++) {
                const ang = j / around * 2 * Math.PI;
                disc([Math.cos(ang) * r, y, Math.sin(ang) * r], [0, up ? 1 : -1, 0], 0.016, c);
            }
        }
    };
    // a thin wire along points
    const wire = (points, r, c) => {
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i], b = points[i + 1], d = b.map((v, k) => v - a[k]), len = Math.hypot(...d);
            const steps = Math.max(1, Math.ceil(len / (r * 1.5)));
            for (let s = 0; s < steps; s++) {
                const t = (s + 0.5) / steps, p = a.map((v, k) => v + d[k] * t);
                const dir = norm(d), side = norm(cross(dir, [p[0], 0, p[2]].every(v => v === 0) ? [1, 0, 0] : [p[0], 0, p[2]]));
                const n = norm(cross(side, dir));
                pos.push(...flip(p));
                rot.push(...quatFromBasis(flip(side), flip(dir), flip(n)));
                scl.push(r, len / steps * 0.7, r);
                col.push(...c); alpha.push(0.99); normal.push(...flip(n)); ao.push(1);
            }
        }
    };

    // the base: a squat drum with a rolled rim
    lathe(-0.5, -0.31, (t) => 0.19 + 0.012 * Math.sin(t * Math.PI), IRON);
    cap(-0.5, 0, 0.19, false, IRON);
    cap(-0.31, 0.1, 0.2, true, IRON);
    // the glass globe, bulging in the middle, and the flame inside it
    const globe = (t) => 0.115 + 0.055 * Math.sin(t * Math.PI);
    lathe(-0.31, 0.17, globe, GLASS, { step: 0.025, a: 0.22 });
    for (let i = 0; i < 40; i++) {
        const t = i / 39, y = -0.17 + 0.16 * t, r = 0.035 * Math.sin(Math.PI * Math.min(1, t * 1.3));
        const ang = i * 2.4;
        disc([Math.cos(ang) * r * 0.5, y, Math.sin(ang) * r * 0.5], [Math.cos(ang), 0, Math.sin(ang)], 0.025 + r * 0.5, FLAME, 0.97);
    }
    // four wire guards following the globe
    for (let k = 0; k < 4; k++) {
        const ang = (k + 0.5) * Math.PI / 2, pts = [];
        for (let i = 0; i <= 12; i++) {
            const t = i / 12, r = globe(t) + 0.03;
            pts.push([Math.cos(ang) * r, -0.31 + 0.48 * t, Math.sin(ang) * r]);
        }
        wire(pts, 0.009, IRON);
    }
    // the cap: a cone over the globe, a short chimney with a lid
    lathe(0.17, 0.29, (t) => 0.2 - 0.13 * t, IRON);
    cap(0.17, 0.12, 0.2, false, IRON);
    lathe(0.29, 0.34, () => 0.06, IRON, { step: 0.015 });
    cap(0.34, 0, 0.08, true, IRON);
    // the brass handle: a half ring over the cap, its top the hook
    const bail = [];
    for (let i = 0; i <= 24; i++) {
        const a = Math.PI * i / 24;
        bail.push([Math.cos(a) * 0.21, 0.27 + Math.sin(a) * 0.23, 0]);
    }
    wire(bail, 0.011, BRASS);

    const src = packSplats(app, 'lantern', { pos, rot, scl, col, alpha, normal, ao });
    return src;
}
