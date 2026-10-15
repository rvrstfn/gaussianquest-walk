// Positional environmental sound, synthesised with Web Audio (no sound files).
// Every source sits at a world position behind an HRTF panner; the listener
// follows the head, so sounds stay put as you turn and walk.
//
//   stream   bubbling water at a few points along the water splats
//   leaves   a rustle in each tree canopy that swells with the visible wind gusts
//   wind     a soft, non-positional breeze everywhere
//   birds    chirps and trills from the trees by day, busiest around sunrise
//   crickets pulsing chirps in the grass at night
//   owl      an occasional hoot from a tree at night

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

// same gust and sway as the foliage shader (relight.js), so the rustle follows the motion
export const windGust = (t) => 0.6 + 0.4 * Math.sin(t * 0.45) * Math.sin(t * 0.17 + 1.3);
const windSway = (t) => Math.sin(t * 1.1) * 0.7 + Math.sin(t * 1.9 + 0.8) * 0.3;

export function createAmbience({ water, trees, grass }) {
    let ctx = null, master = null, noise = null;
    let enabled = true;
    const leaves = [];
    let breeze = null;
    const crickets = [];
    let nextBird = 0, nextOwl = 0;

    function panner(pos, ref = 2) {
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'inverse';
        p.refDistance = ref;
        p.maxDistance = 60;
        p.rolloffFactor = 1;
        p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2];
        p.connect(master);
        return p;
    }

    // a looping white-noise source, started at a random offset so sources don't correlate
    function noiseSource() {
        const s = ctx.createBufferSource();
        s.buffer = noise;
        s.loop = true;
        s.start(0, Math.random() * noise.duration);
        return s;
    }

    function filter(type, frequency, Q = 0.7) {
        const f = ctx.createBiquadFilter();
        f.type = type; f.frequency.value = frequency; f.Q.value = Q;
        return f;
    }

    function gain(value) {
        const g = ctx.createGain();
        g.gain.value = value;
        return g;
    }

    // babbling water: noise through band-passes whose centre jumps around at a few
    // hertz (driven by low-passed noise), plus a quiet broadband hiss
    function stream(pos) {
        const out = panner(pos, 1.6);
        for (const [centre, depth, q, level] of [[700, 30000, 6, 0.9], [1400, 45000, 8, 0.6], [2600, 60000, 10, 0.35]]) {
            const band = filter('bandpass', centre, q);
            const wobble = filter('lowpass', 14);
            const wobbleDepth = gain(depth);
            noiseSource().connect(wobble).connect(wobbleDepth).connect(band.frequency);
            noiseSource().connect(band).connect(gain(level)).connect(out);
        }
        noiseSource().connect(filter('bandpass', 3500, 0.6)).connect(gain(0.05)).connect(out);
    }

    function rustle(pos) {
        const level = gain(0);
        noiseSource().connect(filter('highpass', 1400)).connect(filter('lowpass', 5000)).connect(level).connect(panner(pos, 3));
        leaves.push(level);
    }

    function startBreeze() {
        const lp = filter('lowpass', 350, 0.5);
        const level = gain(0);
        noiseSource().connect(lp).connect(level).connect(master);
        breeze = { lp, level };
    }

    function startCrickets() {
        for (const pos of grass) {
            const osc = ctx.createOscillator();
            osc.frequency.value = rand(4200, 4800);
            const env = gain(0);
            osc.connect(env).connect(panner(pos, 1.2));
            osc.start();
            crickets.push({ env, next: ctx.currentTime + rand(0, 1), period: rand(0.5, 0.8), pulses: Math.round(rand(2, 4)) });
        }
    }

    // one bird phrase: a few whistled sweeps, or a fast trill
    function bird(pos, level) {
        const out = panner(pos, 4);
        const t0 = ctx.currentTime + 0.05;
        const osc = ctx.createOscillator();
        const env = gain(0);
        osc.connect(env).connect(out);
        let t = t0;
        if (Math.random() < 0.7) {
            const base = rand(2400, 4200);
            const notes = Math.round(rand(2, 6));
            const up = Math.random() < 0.5;
            for (let n = 0; n < notes; n++) {
                const len = rand(0.06, 0.16);
                const f0 = base * rand(0.85, 1.15);
                osc.frequency.setValueAtTime(up ? f0 * 0.75 : f0 * 1.25, t);
                osc.frequency.exponentialRampToValueAtTime(f0, t + len);
                env.gain.setValueAtTime(0, t);
                env.gain.linearRampToValueAtTime(level, t + 0.012);
                env.gain.linearRampToValueAtTime(0, t + len);
                t += len + rand(0.04, 0.12);
            }
        } else {
            const f = rand(3500, 5500), len = rand(0.35, 0.8), rate = rand(22, 34);
            osc.frequency.setValueAtTime(f, t);
            osc.frequency.linearRampToValueAtTime(f * rand(0.8, 1.1), t + len);
            for (let k = 0; k < len * rate; k++) {
                const s = t + k / rate;
                env.gain.setValueAtTime(0, s);
                env.gain.linearRampToValueAtTime(level * 0.8, s + 0.008);
                env.gain.linearRampToValueAtTime(0, s + 0.6 / rate);
            }
            t += len;
        }
        osc.start(t0);
        osc.stop(t + 0.1);
        osc.onended = () => out.disconnect();
    }

    // "hoo, hoo-hooo": low sine with a slight downward glide
    function owl(pos) {
        const out = panner(pos, 6);
        const osc = ctx.createOscillator();
        const env = gain(0);
        osc.connect(env).connect(out);
        const f = rand(330, 400);
        let t = ctx.currentTime + 0.05;
        for (const [len, gap] of [[0.28, 0.35], [0.18, 0.08], [0.7, 0]]) {
            osc.frequency.setValueAtTime(f * 1.04, t);
            osc.frequency.linearRampToValueAtTime(f * 0.94, t + len);
            env.gain.setValueAtTime(0, t);
            env.gain.linearRampToValueAtTime(0.5, t + 0.06);
            env.gain.linearRampToValueAtTime(0, t + len);
            t += len + gap;
        }
        osc.start();
        osc.stop(t + 0.1);
        osc.onended = () => out.disconnect();
    }

    return {
        // must run inside a user gesture (a click or key press)
        start() {
            if (ctx) { ctx.resume(); return; }
            ctx = new AudioContext();
            master = gain(enabled ? 0.8 : 0);
            master.connect(ctx.destination);
            noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
            const d = noise.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            for (const pos of water) stream(pos);
            for (const tree of trees) rustle(tree.canopy);
            startBreeze();
            startCrickets();
        },
        toggle() {
            enabled = !enabled;
            if (master) master.gain.setTargetAtTime(enabled ? 0.8 : 0, ctx.currentTime, 0.1);
            return enabled;
        },
        get enabled() { return enabled; },
        layout: { water, trees, grass },
        get state() { return ctx?.state ?? 'not started'; },
        // head: world position; forward/up: unit vectors; elevation: sun elevation in degrees
        update({ time, head, forward, up, elevation }) {
            if (!ctx) return;
            const now = ctx.currentTime;
            const l = ctx.listener;
            if (l.positionX) {
                l.positionX.value = head.x; l.positionY.value = head.y; l.positionZ.value = head.z;
                l.forwardX.value = forward.x; l.forwardY.value = forward.y; l.forwardZ.value = forward.z;
                l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
            } else {
                l.setPosition(head.x, head.y, head.z);
                l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
            }

            const day = smooth(-4, 4, elevation);
            const night = smooth(-3, -10, elevation);
            const dawn = smooth(-4, 2, elevation) * (1 - smooth(10, 20, elevation));

            // leaves and breeze follow the gusts that sway the canopy
            const gust = windGust(time);
            const sway = Math.abs(windSway(time));
            const rustleLevel = 0.04 + 0.19 * gust * gust * (0.4 + 0.6 * sway);
            for (const g of leaves) g.gain.setTargetAtTime(rustleLevel, now, 0.25);
            breeze.level.gain.setTargetAtTime(0.04 + 0.075 * gust, now, 0.5);
            breeze.lp.frequency.setTargetAtTime(250 + 300 * gust * (0.5 + 0.5 * sway), now, 0.5);

            // birds: denser at dawn, a few through the day, none at night
            const rate = day * (0.15 + 0.6 * dawn); // phrases per second
            if (rate > 0.01 && now > nextBird) {
                const tree = pick(trees);
                const p = tree.canopy;
                const r = tree.radius;
                bird([p[0] + rand(-r, r), p[1] + rand(-r * 0.5, r * 0.5), p[2] + rand(-r, r)], 0.25);
                nextBird = now + rand(0.4, 2) / rate * 0.5;
            }
            if (night > 0.5 && now > nextOwl) {
                if (nextOwl > 0) owl(pick(trees).canopy);
                nextOwl = now + rand(15, 40);
            }

            // crickets: schedule each chirp (a few short pulses) shortly ahead
            for (const c of crickets) {
                while (c.next < now + 0.3) {
                    const level = 0.12 * night;
                    for (let k = 0; k < c.pulses; k++) {
                        const s = Math.max(c.next, now) + k * 0.035;
                        c.env.gain.setValueAtTime(0, s);
                        c.env.gain.linearRampToValueAtTime(level, s + 0.004);
                        c.env.gain.linearRampToValueAtTime(0, s + 0.022);
                    }
                    c.next += c.period * rand(0.9, 1.1);
                }
            }
        }
    };
}
