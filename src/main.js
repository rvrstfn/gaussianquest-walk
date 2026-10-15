import * as pc from 'playcanvas';
import { VoxelWorld, parsePly } from './world.js';
import { relightGlsl, sharpenGlsl, overdrawGlsl, OVERDRAW_BLUE_LAYERS, SHARPNESS_LEVELS, sunDirection, lightingForSun, timeRate, TIME_PRESETS, formatTime, LIGHT_TEX_WIDTH } from './relight.js';
import { createSky } from './sky.js';
import { createAmbience } from './ambience.js';
import { buildTerrainMesh } from './terrain-mesh.js';
import { buildMeadow } from './meadow.js';
import { createLand } from './land.js';
import { buildTree } from './tree.js';
import { buildCritters } from './critters.js';
import { buildBoulders } from './rocks.js';
import { buildLantern } from './lantern.js';

const params = new URLSearchParams(location.search);

// ---- scene layout (metres, Y up). Positions avoid the stream that crosses the tile.
// sink: how far the lowest point goes below the lowest ground under the footprint
// (a radius in object units: trees use their trunk, rocks their full base).
const GROUND = { asset: 'ground-hd-lite', scale: 20, pos: [0, 0], yaw: 0, wrap: 0.1, water: true };
const PROPS = [
    { asset: 'tree', scale: 9, pos: [6.55, -5.25], yaw: 30, wrap: 0.6, footprint: 0.05, sink: 0.7, wind: true },
    { asset: 'tree', scale: 7, pos: [-6, 7], yaw: 200, wrap: 0.6, footprint: 0.25, sink: 0.5, wind: true },
    { asset: 'rock', scale: 2.6, pos: [3, 7], yaw: 0, wrap: 0.15, footprint: 0.25, sink: 0.45 },
    { asset: 'rock', scale: 1.7, pos: [-7, -8], yaw: 120, wrap: 0.15, footprint: 0.25, sink: 0.3 },
    { asset: 'rock', scale: 1.1, pos: [8, 6.5], yaw: 250, wrap: 0.15, footprint: 0.25, sink: 0.2 },
    // crosses the stream between the tree hill (north) and the big rock (south)
    { asset: 'bridge', scale: 3.6, pos: [2.41, 2.2], yaw: 6, wrap: 0.2, footprint: 0.05, sink: 0.15 }
];
const START = { pos: [0, 9], yaw: 0 };
// the world, generated (src/land.js): ?world=meadow (default): ground, lake, grass and
// flowers; ?world=alpine: mountain, pines, boulders
const WORLD = params.get('world') === 'alpine' ? 'alpine' : 'meadow';
const land = createLand({ scene: WORLD });
if (land) START.pos = [0, 8];
// For comparison: ?ground=hd is the unpruned 262k tile, ?ground=lo the 32k tile.
if (params.get('ground') === 'lo') GROUND.asset = 'ground';
if (params.get('ground') === 'hd') GROUND.asset = 'ground-hd';
// held props: lantern in the right hand; the stick (left hand) is off for now
const LANTERN = { scale: 0.32, lightOffset: -0.17, color: [1.0, 0.62, 0.28], intensity: 1.6 };
const STICK = { enabled: false, scale: 1.15, gripBelowTop: 0.38, tilt: -75 }; // grip a third of the way down; off for now
// ground mesh prototype (?terrain=mesh): a heightmap mesh textured with a top-down bake of the
// splat terrain (?bake=albedo renders that bake); only splats standing out of the surface stay
// ?terrain=occluder keeps every splat and puts the same mesh a little under the surface:
// it hides the splat layers underneath from the GPU and fills any gaps with the baked colour
const TERRAIN = { center: [0, 0], half: 10.1, albedo: 'assets/terrain-albedo.jpg', cullBelow: 0.25, cullAbove: 0.15, occluderDepth: 0.06 };
// the occluder is the default; short forms for typing on the headset: ?t=s (plain splats), ?t=m (mesh)
const terrainParam = { o: 'occluder', m: 'mesh', s: 'splat' }[params.get('t')] ?? params.get('terrain') ?? 'occluder';
const terrainMode = terrainParam === 'mesh';
const occluderMode = terrainParam === 'occluder';
if (params.has('occ')) TERRAIN.occluderDepth = Number(params.get('occ')); // ?occ=metres below the surface
if (params.has('cull')) [TERRAIN.cullBelow, TERRAIN.cullAbove] = params.get('cull').split(',').map(Number); // ?cull=below,above (m)
const bakeMode = params.get('bake') === 'albedo';
// LOD terrain experiment (?lod=N): the terrain is drawn from the streamed LOD build in
// assets/<ground>-lod (tools/build_lod.sh), keeping about N terrain splats, finest nearest
// the camera. Relighting, shadows and water look up each splat by its PLY index, which
// the LOD build changes, so this terrain keeps its baked colours: compare against ?nomod.
const lodTerrain = params.has('lod') ? Number(params.get('lod') || 100000) : 0;
// procedural meadow (?meadow=N): about N splats of grass and flowers generated at startup (src/meadow.js)
const meadowBudget = params.has('meadow') || land ? Number(params.get('meadow') || (land ? (land.scene === 'alpine' ? 220000 : 300000) : 100000)) : 0;
const turfBudget = land ? Number(params.get('turf') ?? (land.scene === 'alpine' ? 90000 : 120000)) : 0; // short single-splat blades between the tufts (?turf=N)
const MEADOW = { asset: 'meadow', scale: 1, pos: [0, 0], yaw: 0, wrap: 0.6, sway: 0.05, noCollide: true };
const TREE = { asset: 'tree-synth', scale: 1, pos: [0, 0], yaw: 0, wrap: 0.55, sway: 0.12 }; // collides and casts shadows
const BOULDERS = { asset: 'boulders', scale: 1, pos: [0, 0], yaw: 0, wrap: 0.15 };    // collide and cast shadows too
const WATER = { asset: 'water', scale: 1, pos: [0, 0], yaw: 0, wrap: 0, noCollide: true, mirror: true };
let waterInst = null; // the synthetic world's water sheet: its reflection follows the head
let critterInst = null; // butterflies, bees and fireflies: their time of day follows the sun
const CRITTERS = { asset: 'critters', scale: 1, pos: [0, 0], yaw: 0, wrap: 0.5, noCollide: true, critters: true };
const WIND_DIR = [0.8, 0.6];
const CANOPY_START = 0.5; // fraction of tree height where the foliage begins

// ---- walking
const WALK_SPEED = 2.3;
const RUN_SPEED = 4.2;
const STEP_HEIGHT = 0.45;
const MAX_DROP = 2.5;
const BODY_RADIUS = 0.22;
const BODY_HEIGHT = 1.6;
const DESKTOP_EYE = 1.65;
// in VR the eyes are always this high above the ground, whether you sit, stand or crouch (?eye=metres)
const XR_EYE = Number(params.get('eye') ?? 1.8);
const TURN_SPEED = 90;         // degrees per second at full stick
let turnRate = 0;

// ---- time of day
const DAY_SECONDS = 240;      // a full 24 h cycle while playing (dawn and dusk run slower, midday faster)
const SCRUB_HOURS = 3;        // per second at full stick
const TIMELAPSE_HOURS = 5;    // per second when jumping to a preset
const SHADOW_REFRESH_DEG = 0.75;

const statusEl = document.getElementById('status');
const enterButton = document.getElementById('enter');
const setStatus = (text) => { if (statusEl.textContent !== text) statusEl.textContent = text; };

const canvas = document.getElementById('app');
const app = new pc.Application(canvas, {
    graphicsDeviceOptions: { deviceTypes: ['webgl2'], antialias: false, alpha: false, xrCompatible: true },
    mouse: new pc.Mouse(canvas),
    keyboard: new pc.Keyboard(window)
});
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());
app.start();
window.__dbg = { app, pc, get overdraw() { return overdrawStats; }, setTerrainMode: (m) => setTerrainMode(m), get terrain() { return terrain; }, get lantern() { return lantern; }, get stick() { return stick; }, get lamp() { return lamp; }, get hands() { return hands; }, get ambience() { return ambience; }, get perf() { return PERF; }, get rig() { return rig; }, get camera() { return camera; }, get world() { return world; }, get instances() { return instances; }, get shadowStats() { return shadowStats; } };

// ---- splat edge sharpening, shared by every splat
let sharpIndex = Math.max(0, SHARPNESS_LEVELS.findIndex(l => l.name === (params.get('sharp') ?? 'original')));
const splatMaterial = app.scene.gsplat.material;
const splatChunks = splatMaterial.getShaderChunks('glsl');
let overdraw = params.has('overdraw'); // ?overdraw or O: count splat layers per pixel
function applySharpness() {
    // the original kernel uses the engine's own chunk, so it costs nothing extra per pixel
    if (overdraw) splatChunks.set('gsplatModifyPS', overdrawGlsl);
    else if (SHARPNESS_LEVELS[sharpIndex].p > 1) splatChunks.set('gsplatModifyPS', sharpenGlsl);
    else splatChunks.delete('gsplatModifyPS');
    splatMaterial.setParameter('uSharpness', SHARPNESS_LEVELS[sharpIndex].p);
    splatMaterial.setParameter('uCover', SHARPNESS_LEVELS[sharpIndex].cover);
    splatMaterial.setParameter('uRect', SHARPNESS_LEVELS[sharpIndex].rect ?? 0);
    splatMaterial.update();
}
function cycleSharpness() {
    sharpIndex = (sharpIndex + 1) % SHARPNESS_LEVELS.length;
    applySharpness();
}
applySharpness();

// ---- overdraw view: only the splat layers show, on black. The ground mesh still writes
// depth (so the occluder still hides what it hides) but no colour.
const overdrawStats = { mean: 0, covered: 0, p95: 0, max: 0 };
function setOverdraw(on) {
    overdraw = on;
    applySharpness();
    const skyEntity = app.root.findByName('sky');
    if (skyEntity) skyEntity.enabled = !on;
    for (const m of terrain?.materials ?? []) {
        m.redWrite = m.greenWrite = m.blueWrite = m.alphaWrite = !on;
        m.update();
    }
    lastLightKey = ''; // re-apply the clear colour
}

// desktop readout, once a second: layers per pixel, decoded from the blue channel
let overdrawReadAt = 0;
let overdrawPixels = null;
app.on('frameend', () => {
    if (!overdraw || app.xr.active || performance.now() < overdrawReadAt) return;
    overdrawReadAt = performance.now() + 1000;
    const gl = app.graphicsDevice.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    if (overdrawPixels?.length !== w * h * 4) overdrawPixels = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, overdrawPixels);
    const hist = new Uint32Array(256);
    for (let i = 2; i < overdrawPixels.length; i += 4) hist[overdrawPixels[i]]++;
    const toLayers = (b) => b / 255 * OVERDRAW_BLUE_LAYERS;
    let sum = 0, covered = 0, max = 0;
    for (let b = 1; b < 256; b++) {
        if (!hist[b]) continue;
        sum += hist[b] * toLayers(b);
        covered += hist[b];
        max = b;
    }
    let seen = 0, p95 = 0;
    for (let b = 1; b < 256; b++) {
        seen += hist[b];
        if (seen >= covered * 0.95) { p95 = b; break; }
    }
    overdrawStats.mean = sum / (w * h);
    overdrawStats.covered = covered ? sum / covered : 0;
    overdrawStats.p95 = toLayers(p95);
    overdrawStats.max = toLayers(max);
});

// ---- GPU cost. Splats smaller than minPixelSize on screen and fragments fainter than
// alphaClipForward are skipped; fixed foveation renders the edges of the view at lower
// resolution; framebufferScaleFactor scales the whole XR framebuffer.
const PERF = {
    foveation: Number(params.get('fov') ?? 1),
    framebufferScale: Number(params.get('fb') ?? params.get('f') ?? 0.8), // 80%: looks the same on soft splats, ~20% faster (?f=1 for full)
    minPixelSize: Number(params.get('minpx') ?? 2), // 4 was cheaper but made small splats blink in and out
    alphaClip: Number(params.get('clip') ?? 1 / 32)
};
app.scene.gsplat.minPixelSize = PERF.minPixelSize;
// sort by distance rather than along the view direction: steadier while the head turns (?sort=linear to compare)
app.scene.gsplat.radialSorting = params.get('sort') !== 'linear';
app.scene.gsplat.alphaClipForward = PERF.alphaClip;

// ---- player rig: the rig sits at the feet, the camera is the head.
const rig = new pc.Entity('rig');
app.root.addChild(rig);
const camera = new pc.Entity('camera');
camera.addComponent('camera', { clearColor: new pc.Color(0.5, 0.7, 0.93), nearClip: 0.05, farClip: 1000, fov: 70 });
camera.setLocalPosition(0, DESKTOP_EYE, 0);
rig.addChild(camera);

const sky = createSky(app);

const hands = {};
for (const side of ['left', 'right']) {
    const hand = new pc.Entity(`${side}-hand`); // follows the controller grip; carries the held props
    hand.enabled = false;
    rig.addChild(hand); // moves with the body, so steps and turns don't leave it a frame behind
    hands[side] = hand;
}

// ---- loading
const loadSplat = (name, url = `assets/${name}.ply`) => new Promise((resolve, reject) => {
    const asset = new pc.Asset(name, 'gsplat', { url }, { reorder: false });
    asset.once('load', () => resolve(asset));
    asset.once('error', reject);
    app.assets.add(asset);
    app.assets.load(asset);
});
const fetchBuffer = (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
});

// per-splat table, LIGHT_TEX_WIDTH texels wide and indexed by splat
function splatTable(name, rows, bytes) {
    const data = new Uint8Array(LIGHT_TEX_WIDTH * rows * 4);
    data.set(bytes);
    return new pc.Texture(app.graphicsDevice, {
        name, width: LIGHT_TEX_WIDTH, height: rows, format: pc.PIXELFORMAT_RGBA8,
        mipmaps: false, minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, levels: [data]
    });
}
const noGrass = splatTable('no-grass', 1, new Uint8Array(0));

const sources = {};
for (const name of [...(land ? [] : [GROUND.asset, 'tree', 'rock', 'bridge']), ...(STICK.enabled ? ['stick'] : [])]) {
    sources[name] = Promise.all([loadSplat(name), fetchBuffer(`assets/${name}.ply`), fetchBuffer(`assets/${name}.light.bin`)])
        .then(([asset, ply, light]) => {
            const parsed = parsePly(ply);
            const rows = Math.ceil(parsed.count / LIGHT_TEX_WIDTH);
            const lightTex = splatTable(`${name}-light`, rows, new Uint8Array(light));
            // the source is Y down: its largest y is the lowest point once flipped
            let bottom = -Infinity, top = Infinity;
            for (let i = 0; i < parsed.count; i++) {
                if (parsed.opacity[i] <= 0.4) continue;
                bottom = Math.max(bottom, parsed.points[i * 3 + 1]);
                top = Math.min(top, parsed.points[i * 3 + 1]);
            }
            return { name, asset, ...parsed, rows, lightBytes: new Uint8Array(light), lightTex, bottom, height: bottom - top };
        });
}

// the lantern is built from splats (src/lantern.js)
sources.lantern = (async () => {
    const lantern = buildLantern(app);
    const rows = Math.ceil(lantern.count / LIGHT_TEX_WIDTH);
    return { ...lantern, rows, lightTex: splatTable('lantern-light', rows, lantern.lightBytes), height: 1 };
})();

const lodSource = lodTerrain ? loadSplat(`${GROUND.asset}-lod`, `assets/${GROUND.asset}-lod/lod-meta.json`) : null;

const worldHalf = land ? land.walkHalf + 0.5 : 11; // the synthetic world: the meadow and the hills around it
const world = new VoxelWorld([-worldHalf, -6, -worldHalf], [worldHalf, land ? 18 : 14, worldHalf], 0.15);
const instances = [];
let fixedSplats = 0; // splats drawn in full, outside the LOD terrain

function place(src, cfg, groundY) {
    const holder = new pc.Entity(`${cfg.asset}-holder`);
    holder.setLocalPosition(cfg.pos[0], groundY, cfg.pos[1]);
    holder.setLocalEulerAngles(0, cfg.yaw, 0);
    holder.setLocalScale(cfg.scale, cfg.scale, cfg.scale);
    const splat = new pc.Entity(cfg.asset);
    splat.setLocalEulerAngles(0, 0, 180); // Y down -> Y up
    splat.setLocalPosition(0, src.bottom, 0); // after the flip the lowest point sits at the holder
    holder.addChild(splat);
    app.root.addChild(holder);
    splat.addComponent('gsplat', { asset: src.asset });
    if (cfg.lodAsset) {
        // the LOD build is already in metres and Y up: undo the holder's scale, skip the flip.
        // The PLY splat stays for its transform and uniforms but isn't drawn.
        const lod = new pc.Entity(`${cfg.asset}-lod`);
        lod.setLocalPosition(0, src.bottom, 0);
        lod.setLocalScale(1 / cfg.scale, 1 / cfg.scale, 1 / cfg.scale);
        holder.addChild(lod);
        lod.addComponent('gsplat', { asset: cfg.lodAsset });
        splat.gsplat.enabled = false;
    } else {
        fixedSplats += src.count;
    }

    // world-space centres and normals for collisions and shadow rays
    const m = splat.getWorldTransform();
    const v = new pc.Vec3(), w = new pc.Vec3();
    const points = new Float32Array(src.count * 3);
    const normals = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) {
        v.set(src.points[i * 3], src.points[i * 3 + 1], src.points[i * 3 + 2]);
        m.transformPoint(v, w);
        points[i * 3] = w.x; points[i * 3 + 1] = w.y; points[i * 3 + 2] = w.z;
        v.set(src.lightBytes[i * 4] / 127.5 - 1, src.lightBytes[i * 4 + 1] / 127.5 - 1, src.lightBytes[i * 4 + 2] / 127.5 - 1);
        m.transformVector(v, w).normalize();
        normals[i * 3] = w.x; normals[i * 3 + 1] = w.y; normals[i * 3 + 2] = w.z;
    }
    if (!cfg.noCollide) world.addPoints(points, src.opacity);

    const shadowData = new Uint8Array(LIGHT_TEX_WIDTH * src.rows).fill(255);
    const shadowTex = new pc.Texture(app.graphicsDevice, {
        name: `${cfg.asset}-shadow`, width: LIGHT_TEX_WIDTH, height: src.rows, format: pc.PIXELFORMAT_R8,
        mipmaps: false, minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE, levels: [shadowData]
    });
    const g = splat.gsplat;
    if (!params.has('nomod')) g.setWorkBufferModifier({ glsl: relightGlsl });
    g.setParameter('uLightData', src.lightTex);
    g.setParameter('uShadow', shadowTex);
    g.setParameter('uWrap', cfg.wrap);
    // every instance sets every uniform, otherwise it would inherit another instance's values
    // the wind bends only the canopy: everything below CANOPY_START of the height stays still
    const height = src.height * cfg.scale;
    const canopyBase = groundY + CANOPY_START * height;
    g.setParameter('uWind', new Float32Array(cfg.wind ? [WIND_DIR[0], WIND_DIR[1], 0.012 * height, canopyBase] : [0, 0, 0, 0]));
    g.setParameter('uWindHeight', (1 - CANOPY_START) * height);
    g.setParameter('uWater', cfg.water ? 1 : 0);
    g.setParameter('uTime', 0);
    setLampUniforms(g, cfg.glow ?? 0);
    setCullUniforms(g, false);
    g.setParameter('uGrassData', src.grassTex ?? noGrass);
    g.setParameter('uGrass', src.grassTex ? cfg.sway : 0);
    if (src.grassTex) g.setParameter('uWind', new Float32Array([WIND_DIR[0], WIND_DIR[1], 0, 0])); // direction only: no tree bend
    setMirrorUniforms(g, !!cfg.mirror);
    const inst = {
        splat, points, normals, shadowData, shadowTex, animated: !!(cfg.wind || cfg.water || src.grassTex || cfg.mirror || cfg.critters),
        base: [cfg.pos[0], groundY, cfg.pos[1]], height
    };
    instances.push(inst);
    return inst;
}

// lowest ground under a footprint, so props on slopes don't float on the downhill side
// ---- held props: a lantern hanging from the right hand, a walking stick in the left
const lamp = { pos: [0, 0, 0], intensity: 0, on: true };
let lantern = null, stick = null;

let terrain = null;
const noHeightMap = new pc.Texture(app.graphicsDevice, {
    name: 'no-height', width: 1, height: 1, format: pc.PIXELFORMAT_R32F, mipmaps: false,
    minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST, levels: [new Float32Array([-1000])]
});
function setCullUniforms(g, on) {
    g.setParameter('uHeightMap', on ? terrain.heightTex : noHeightMap);
    g.setParameter('uHeightBounds', new Float32Array(on ? terrain.cullBounds : [0, 0, 0, 0]));
    g.setParameter('uCullBand', new Float32Array([TERRAIN.cullBelow, TERRAIN.cullAbove]));
}

function setMirrorUniforms(g, on) {
    // critters off too: every instance sets every uniform
    g.setParameter('uCritters', 0);
    g.setParameter('uCritterData', noGrass);
    g.setParameter('uCritterPath', noGrass);
    g.setParameter('uDusk', 0);
    g.setParameter('uCritterGroundRect', new Float32Array([0, 0, 1, 2]));
    g.setParameter('uMirror', on ? 1 : 0);
    g.setParameter('uEye', new Float32Array([0, 1.6, 0]));
    g.setParameter('uZenith', new Float32Array([0.22, 0.44, 0.85]));
    g.setParameter('uHorizon', new Float32Array([0.62, 0.77, 0.95]));
}

function setLampUniforms(g, glow) {
    g.setParameter('uLamp', new Float32Array([...lamp.pos, lamp.intensity]));
    g.setParameter('uLampColor', new Float32Array(LANTERN.color));
    g.setParameter('uGlow', glow);
}

// a splat that moves with the player: relit like the scene, never in collisions or shadow tracing
function heldSplat(src, name, glow) {
    const holder = new pc.Entity(`${name}-holder`);
    const splat = new pc.Entity(name);
    holder.addChild(splat);
    splat.addComponent('gsplat', { asset: src.asset });
    fixedSplats += src.count;
    const shadowTex = new pc.Texture(app.graphicsDevice, {
        name: `${name}-shadow`, width: LIGHT_TEX_WIDTH, height: src.rows, format: pc.PIXELFORMAT_R8,
        mipmaps: false, levels: [new Uint8Array(LIGHT_TEX_WIDTH * src.rows).fill(255)]
    });
    const g = splat.gsplat;
    if (!params.has('nomod')) g.setWorkBufferModifier({ glsl: relightGlsl });
    g.setParameter('uLightData', src.lightTex);
    g.setParameter('uShadow', shadowTex);
    g.setParameter('uWrap', 0.4);
    g.setParameter('uWind', new Float32Array([0, 0, 0, 0]));
    g.setParameter('uWindHeight', 1);
    g.setParameter('uWater', 0);
    g.setParameter('uTime', 0);
    setLampUniforms(g, glow);
    setCullUniforms(g, false);
    g.setParameter('uGrassData', noGrass);
    g.setParameter('uGrass', 0);
    setMirrorUniforms(g, false);
    // in the instance list for lighting updates only; added after the shadow worker starts
    instances.push({ splat, animated: false, held: true });
    return { holder, splat };
}

function createHeldProps(lanternSrc, stickSrc) {
    // lantern: hook at the hand, kept upright by gravity (see updateHeld)
    lantern = heldSplat(lanternSrc, 'lantern', 1);
    let hookY = Infinity;
    for (let i = 1; i < lanternSrc.points.length; i += 3) hookY = Math.min(hookY, lanternSrc.points[i]);
    lantern.splat.setLocalEulerAngles(0, 0, 180); // Y down -> Y up
    lantern.splat.setLocalPosition(0, hookY, 0);     // the hook (topmost point) sits at the hand
    lantern.holder.setLocalScale(LANTERN.scale, LANTERN.scale, LANTERN.scale);
    lantern.holder.enabled = false;
    app.root.addChild(lantern.holder);

    if (!stickSrc) return;
    // stick: straighten the slanted model along its main axis, crook up, then hold it by the crook
    // with the shaft running down the controller handle, tipped slightly forward
    const p = stickSrc.points, n = p.length / 3;
    const mean = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mean[k] += p[i * 3 + k] / n;
    let axis = new pc.Vec3(0, 1, 0);
    for (let iter = 0; iter < 20; iter++) { // power iteration for the main axis
        const next = new pc.Vec3();
        for (let i = 0; i < n; i += 4) {
            const dx = p[i * 3] - mean[0], dy = p[i * 3 + 1] - mean[1], dz = p[i * 3 + 2] - mean[2];
            const d = dx * axis.x + dy * axis.y + dz * axis.z;
            next.x += d * dx; next.y += d * dy; next.z += d * dz;
        }
        axis = next.normalize();
    }
    if (axis.y > 0) axis.mulScalar(-1); // point at the crook, which is the top (smallest y, Y down)
    const align = new pc.Quat();
    const cross = new pc.Vec3().cross(axis, pc.Vec3.UP);
    align.setFromAxisAngle(cross.normalize(), Math.acos(Math.max(-1, Math.min(1, axis.y))) * pc.math.RAD_TO_DEG);
    let topPoint = null, best = -Infinity;
    for (let i = 0; i < n; i++) {
        const d = (p[i * 3] - mean[0]) * axis.x + (p[i * 3 + 1] - mean[1]) * axis.y + (p[i * 3 + 2] - mean[2]) * axis.z;
        if (d > best) { best = d; topPoint = new pc.Vec3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); }
    }
    const top = align.transformVector(topPoint);
    stick = heldSplat(stickSrc, 'stick', 0);
    stick.splat.setLocalRotation(align);
    stick.splat.setLocalPosition(-top.x, -top.y + STICK.gripBelowTop, -top.z);
    stick.holder.setLocalEulerAngles(STICK.tilt, 0, 0); // tilt about the grip's X axis so the shaft points at the ground
    stick.holder.setLocalScale(STICK.scale, STICK.scale, STICK.scale);
    hands.left.addChild(stick.holder);
}

// the lantern hangs straight down from the right hand and turns with it; it lights up after dusk
function updateHeld() {
    if (!lantern) return;
    const hand = hands.right;
    lantern.holder.enabled = hand.enabled;
    let intensity = 0;
    if (hand.enabled) {
        const pos = hand.getPosition();
        const f = hand.forward;
        lantern.holder.setPosition(pos.x, pos.y, pos.z);
        lantern.holder.setEulerAngles(0, Math.atan2(-f.x, -f.z) * pc.math.RAD_TO_DEG, 0);
        lamp.pos = [pos.x, pos.y + LANTERN.lightOffset, pos.z];
        const dusk = Math.max(0, Math.min(1, (2 - light.elevation) / 8)); // off by day, full from -6 degrees
        intensity = lamp.on ? LANTERN.intensity * dusk : 0;
    }
    if (intensity === 0 && lamp.intensity === 0) return;
    lamp.intensity = intensity;
    if (terrain) {
        terrain.set('uLamp', [...lamp.pos, lamp.intensity]);
        terrain.set('uLampColor', LANTERN.color);
    }
    for (const inst of instances) setLampUniforms(inst.splat.gsplat, inst.splat === lantern.splat ? Math.max(0.15, intensity / LANTERN.intensity) : 0);
}

function footprintGround(x, z, radius) {
    let low = world.groundAt(x, z, 30, -10);
    for (let s = 0; s < 8; s++) {
        const a = s * Math.PI / 4;
        const g = world.groundAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius, 30, -10);
        if (g !== null && (low === null || g < low)) low = g;
    }
    return low ?? 0;
}

// ---- lighting state: time of day drives the sun unless the sun is aimed by hand
let hours = TIME_PRESETS[1].hours;
let hoursTarget = null;   // set while time-lapsing to a preset
let playing = false;
let presetIndex = 1;
let manualSun = null;     // sun direction placed with the grip / right mouse
let relight = 1;
let light = null;
let lastLightKey = '';
let shadowDir = null;
let elapsed = 0;

function currentSunDir() {
    return manualSun ?? sunDirection(hours);
}

function applyLighting() {
    light = lightingForSun(currentSunDir());
    const key = JSON.stringify([light.keyDir, light.key, light.sky, light.ground, relight]);
    if (key === lastLightKey) return;
    lastLightKey = key;
    for (const { splat } of instances) {
        const g = splat.gsplat;
        g.setParameter('uSunDir', new Float32Array(light.keyDir));
        g.setParameter('uSunColor', new Float32Array(light.key));
        g.setParameter('uSkyColor', new Float32Array(light.sky));
        g.setParameter('uGroundColor', new Float32Array(light.ground));
        g.setParameter('uRelight', relight);
        g.setParameter('uZenith', new Float32Array(light.zenith));
        g.setParameter('uHorizon', new Float32Array(light.clear));
    }
    if (terrain) {
        terrain.set('uSunDir', light.keyDir);
        terrain.set('uSunColor', light.key);
        terrain.set('uSkyColor', light.sky);
        terrain.set('uGroundColor', light.ground);
        terrain.set('uRelight', relight);
    }
    const c = overdraw ? [0, 0, 0] : bakeMode ? [0.42, 0.55, 0.2] : light.clear; // grass colour, so gaps in the bake don't show
    camera.camera.clearColor = new pc.Color(c[0], c[1], c[2]);
}

function updateSky() {
    const sun = currentSunDir();
    const el = light.elevation;
    sky.follow(camera.getPosition());
    sky.update({
        zenith: light.zenith,
        horizon: light.clear,
        sunDir: sun,
        sunColor: light.sunColor,
        sunUp: Math.max(0, Math.min(1, (el + 1) / 3)),
        moonDir: sun.map(v => -v),
        night: Math.max(0, Math.min(1, (-el - 3) / 9)),
        time: elapsed
    });
}

function jumpToPreset(i) {
    presetIndex = (i + TIME_PRESETS.length) % TIME_PRESETS.length;
    manualSun = null;
    playing = false;
    hours %= 24;
    hoursTarget = TIME_PRESETS[presetIndex].hours;
    if (hoursTarget <= hours) hoursTarget += 24; // always time-lapse forwards
}

function scrubTime(deltaHours) {
    manualSun = null;
    hoursTarget = null;
    hours = (hours + deltaHours + 24) % 24;
}

function togglePlaying() {
    playing = !playing;
    manualSun = null;
    hoursTarget = null;
}

function aimSun(direction) {
    const d = [direction.x, Math.max(0.08, direction.y), direction.z];
    const len = Math.hypot(...d);
    manualSun = d.map(v => v / len);
    playing = false;
    hoursTarget = null;
}

function advanceTime(dt) {
    if (hoursTarget !== null) {
        // hours may pass 24 during the time-lapse; it wraps once the target is reached
        hours += TIMELAPSE_HOURS * dt;
        if (hours >= hoursTarget) {
            hours = hoursTarget % 24;
            hoursTarget = null;
        }
    } else if (playing) {
        hours = (hours + 24 * dt / DAY_SECONDS * timeRate(light?.elevation ?? 0)) % 24;
    }
}

// ---- shadow tracing runs in a worker; stale shadows stay up until a pass lands
const shadowWorker = new Worker(new URL('./shadow-worker.js', import.meta.url), { type: 'module' });
let shadowBusy = false;
let shadowStarted = 0;
const shadowStats = { lastMs: 0, passes: 0 };

function initShadowWorker() {
    const { cell, inv, min, nx, ny, nz, counts, topY } = world;
    shadowWorker.postMessage({
        type: 'init',
        grid: { cell, inv, min, nx, ny, nz, counts, topY },
        instances: [...instances.map(({ points, normals }) => ({ points, normals })), ...(terrain ? [terrain.shadowReceiver] : [])]
    });
    tracedCount = instances.length;
}
let tracedCount = 0;

shadowWorker.onmessage = ({ data }) => {
    data.shadows.forEach((shadow, i) => {
        if (i === tracedCount) { terrain?.setShadows(shadow); return; }
        const inst = instances[i];
        inst.shadowData.set(shadow);
        inst.shadowTex.lock().set(inst.shadowData);
        inst.shadowTex.unlock();
        inst.splat.gsplat.setParameter('uShadow', inst.shadowTex); // marks the work buffer dirty
    });
    shadowStats.lastMs = performance.now() - shadowStarted;
    shadowStats.passes++;
    shadowBusy = false;
};

function updateShadows() {
    // re-trace whenever the key light has moved far enough and no pass is running
    if (shadowBusy || !light) return;
    const d = light.keyDir;
    const dot = shadowDir ? d[0] * shadowDir[0] + d[1] * shadowDir[1] + d[2] * shadowDir[2] : -1;
    if (dot >= Math.cos(SHADOW_REFRESH_DEG * Math.PI / 180)) return;
    shadowDir = [...d];
    shadowBusy = true;
    shadowStarted = performance.now();
    shadowWorker.postMessage({ type: 'trace', dir: shadowDir });
}

// ---- walking and collisions
let feetY = 0;
let lastHead = new pc.Vec3();

function standHeight(x, z, fromFeet) {
    const g = world.groundAt(x, z, fromFeet + STEP_HEIGHT, fromFeet - MAX_DROP);
    if (g === null) return null; // off the island
    if (world.bodyBlocked(x, z, g + STEP_HEIGHT, g + BODY_HEIGHT, BODY_RADIUS)) return null;
    return g;
}

function headPosition() {
    return camera.getPosition().clone();
}

function moveRig(dx, dz) {
    const p = rig.getPosition();
    rig.setPosition(p.x + dx, p.y, p.z + dz);
}

function walk(moveX, moveZ, dt) {
    const head = headPosition();

    // physical roomscale steps: undo a step into something solid
    if (standHeight(head.x, head.z, feetY) === null && lastHead) {
        moveRig(lastHead.x - head.x, lastHead.z - head.z);
        head.copy(lastHead);
    }

    if (moveX || moveZ) {
        const tryMoves = [[moveX, moveZ], [moveX, 0], [0, moveZ]];
        for (const [mx, mz] of tryMoves) {
            if ((mx || mz) && standHeight(head.x + mx, head.z + mz, feetY) !== null) {
                moveRig(mx, mz);
                head.x += mx; head.z += mz;
                break;
            }
        }
    }

    const ground = standHeight(head.x, head.z, feetY);
    if (ground !== null) feetY += (ground - feetY) * Math.min(1, dt * 12);
    const p = rig.getPosition();
    // in VR, lift or lower the whole rig so the head sits XR_EYE above the ground,
    // whatever the real head height in the play space
    const lift = app.xr.active ? XR_EYE - camera.getLocalPosition().y : 0;
    rig.setPosition(p.x, feetY + lift, p.z);
    lastHead = headPosition();
}

function resetToStart() {
    const g = world.groundAt(START.pos[0], START.pos[1], 30, -10) ?? 0;
    feetY = g;
    rig.setPosition(START.pos[0], g, START.pos[1]);
    rig.setEulerAngles(0, START.yaw, 0);
    if (app.xr?.active) {
        // put the head (not the play-area centre) on the start point
        const h = camera.getPosition();
        moveRig(START.pos[0] - h.x, START.pos[1] - h.z);
    }
    lastHead = headPosition();
}

// yaw the rig around the head so turning doesn't swing you sideways
function turn(degrees) {
    const before = camera.getPosition().clone();
    rig.rotate(0, degrees, 0);
    const after = camera.getPosition();
    moveRig(before.x - after.x, before.z - after.z);
}

// ---- desktop input
let pitch = 0;
let sunAiming = false;
app.mouse.on(pc.EVENT_MOUSEDOWN, (e) => {
    if (app.xr.active) return;
    if (e.button === pc.MOUSEBUTTON_LEFT && !pc.Mouse.isPointerLocked()) app.mouse.enablePointerLock();
    if (e.button === pc.MOUSEBUTTON_RIGHT) sunAiming = true;
});
app.mouse.on(pc.EVENT_MOUSEUP, (e) => {
    if (e.button === pc.MOUSEBUTTON_RIGHT) sunAiming = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
app.mouse.on(pc.EVENT_MOUSEMOVE, (e) => {
    if (app.xr.active || !pc.Mouse.isPointerLocked()) return;
    rig.rotate(0, -e.dx * 0.15, 0);
    pitch = pc.math.clamp(pitch - e.dy * 0.15, -85, 85);
    camera.setLocalEulerAngles(pitch, 0, 0);
});
app.keyboard.on(pc.EVENT_KEYDOWN, (e) => {
    if (e.key >= pc.KEY_1 && e.key <= pc.KEY_4) jumpToPreset(e.key - pc.KEY_1);
    if (e.key === pc.KEY_P) togglePlaying();
    if (e.key === pc.KEY_L) relight = relight ? 0 : 1;
    if (e.key === pc.KEY_R) resetToStart();
    if (e.key === pc.KEY_K) cycleSharpness();
    if (e.key === pc.KEY_M) ambience?.toggle();
    if (e.key === pc.KEY_O) setOverdraw(!overdraw);
});

// ---- XR input
const pressed = {};
const edge = (key, isDown) => {
    const was = pressed[key];
    pressed[key] = isDown;
    return isDown && !was;
};

function xrInput(dt) {
    let moveX = 0, moveZ = 0;
    for (const source of app.xr.input.inputSources) {
        const side = source.handedness;
        const pad = source.gamepad;
        const hand = hands[side];
        if (hand && source.grip) {
            hand.enabled = true;
            hand.setLocalPosition(source.getLocalPosition());
            hand.setLocalRotation(source.getLocalRotation());
        }
        if (!pad) continue;
        const sx = pad.axes[2] ?? 0, sy = pad.axes[3] ?? 0;
        const button = (i) => !!pad.buttons[i]?.pressed;
        if (side === 'left') {
            const len = Math.hypot(sx, sy);
            if (len > 0.15) {
                const speed = (button(3) ? RUN_SPEED : WALK_SPEED) * Math.min(1, (len - 0.15) / 0.75);
                const f = camera.forward, r = camera.right;
                const fl = Math.hypot(f.x, f.z) || 1, rl = Math.hypot(r.x, r.z) || 1;
                const ax = sx / len, ay = -sy / len;
                moveX = (f.x / fl * ay + r.x / rl * ax) * speed * dt;
                moveZ = (f.z / fl * ay + r.z / rl * ax) * speed * dt;
            }
            if (edge('x', button(4))) resetToStart();
            if (edge('y', button(5))) togglePlaying();
            if (edge('ltrigger', button(0))) lamp.on = !lamp.on;
            if (edge('lgrip', button(1))) ambience?.toggle();
        } else if (side === 'right') {
            // stick left/right turns smoothly, up/down scrubs the time of day
            let target = 0;
            if (Math.abs(sx) > Math.abs(sy)) {
                if (Math.abs(sx) > 0.15) {
                    const amount = (Math.abs(sx) - 0.15) / 0.85; // dead zone, then ease in
                    target = -Math.sign(sx) * amount * amount * TURN_SPEED;
                }
            } else if (Math.abs(sy) > 0.25) {
                scrubTime(-sy * SCRUB_HOURS * dt);
            }
            // the turn speed follows the stick with a short lag, so turns start and stop gently
            turnRate += (target - turnRate) * Math.min(1, dt / 0.12);
            if (Math.abs(turnRate) > 0.5) turn(turnRate * dt);
            // hold grip and point the controller at where the sun should be
            if (button(1)) aimSun(source.getDirection());
            if (edge('a', button(4))) jumpToPreset(presetIndex + 1);
            if (edge('b', button(5))) relight = relight ? 0 : 1;
            if (edge('trigger', button(0))) cycleSharpness();
        }
    }
    return [moveX, moveZ];
}

function desktopInput(dt) {
    const k = app.keyboard;
    if (k.isPressed(pc.KEY_E)) scrubTime(SCRUB_HOURS * dt);
    if (k.isPressed(pc.KEY_Q)) scrubTime(-SCRUB_HOURS * dt);
    if (sunAiming) aimSun(camera.forward);
    let ax = 0, ay = 0;
    if (k.isPressed(pc.KEY_W) || k.isPressed(pc.KEY_UP)) ay += 1;
    if (k.isPressed(pc.KEY_S) || k.isPressed(pc.KEY_DOWN)) ay -= 1;
    if (k.isPressed(pc.KEY_D) || k.isPressed(pc.KEY_RIGHT)) ax += 1;
    if (k.isPressed(pc.KEY_A) || k.isPressed(pc.KEY_LEFT)) ax -= 1;
    if (!ax && !ay) return [0, 0];
    const speed = (k.isPressed(pc.KEY_SHIFT) ? RUN_SPEED : WALK_SPEED) * dt / Math.hypot(ax, ay);
    const f = rig.forward, r = rig.right;
    return [(f.x * ay + r.x * ax) * speed, (f.z * ay + r.z * ax) * speed];
}

// ---- XR session
app.xr.on('available:' + pc.XRTYPE_VR, (available) => {
    enterButton.disabled = !available || instances.length === 0;
});
enterButton.addEventListener('click', () => {
    camera.camera.startXr(pc.XRTYPE_VR, pc.XRSPACE_LOCALFLOOR, {
        framebufferScaleFactor: PERF.framebufferScale,
        callback: (err) => { if (err) setStatus(`Could not enter VR: ${err.message}`); }
    });
});
app.xr.on('start', () => {
    app.xr.fixedFoveation = PERF.foveation;
    camera.setLocalPosition(0, 0, 0);
    camera.setLocalEulerAngles(0, 0, 0);
    // the XR camera starts at the play-area origin; snap the head onto the start point next frame
    app.once('update', () => resetToStart());
});
app.xr.on('end', () => {
    hands.left.enabled = hands.right.enabled = false;
    camera.setLocalPosition(0, DESKTOP_EYE, 0);
    camera.setLocalEulerAngles(pitch, 0, 0);
    lastHead = headPosition();
});

// ---- sound: emitters along the stream, in the tree canopies and in the grass
let ambience = null;

// spread-out picks: the densest candidate cells first, at least minGap apart
function spreadPoints(points, colors, test, cell, minGap, max) {
    const cells = new Map();
    for (let i = 0; i < points.length / 3; i++) {
        if (!test(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2])) continue;
        const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
        const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
        const c = cells.get(key) ?? cells.set(key, { n: 0, x: 0, y: 0, z: 0 }).get(key);
        c.n++; c.x += x; c.y += y; c.z += z;
    }
    const picked = [];
    for (const c of [...cells.values()].sort((a, b) => b.n - a.n)) {
        const p = [c.x / c.n, c.y / c.n + 0.1, c.z / c.n];
        if (c.n < 20 || picked.some(q => Math.hypot(q[0] - p[0], q[2] - p[2]) < minGap)) continue;
        picked.push(p);
        if (picked.length === max) break;
    }
    return picked;
}

function initAmbience(groundSrc, groundInst, treeInsts) {
    const isWater = (r, g, b) => b - Math.max(r, g * 0.92) > 0.08;
    const isGrass = (r, g, b) => g > r * 1.1 && g > b * 1.3;
    ambience = createAmbience({
        water: spreadPoints(groundInst.points, groundSrc.colors, isWater, 2, 4, 6),
        grass: spreadPoints(groundInst.points, groundSrc.colors, isGrass, 3, 5, 6).sort(() => Math.random() - 0.5).slice(0, 4),
        trees: treeInsts.map(t => ({ canopy: [t.base[0], t.base[1] + 0.75 * t.height, t.base[2]], radius: 0.25 * t.height }))
    });
    const start = () => ambience.start();
    enterButton.addEventListener('click', start);
    app.graphicsDevice.canvas.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
}

// ---- ground mesh prototype: build the mesh, load the baked colour, cull the flat splats
async function setupTerrainMesh(groundSrc, groundInst) {
    terrain = buildTerrainMesh(app, { points: groundInst.points, opacity: groundSrc.opacity, bounds: TERRAIN });
    const asset = new pc.Asset('terrain-albedo', 'texture', { url: TERRAIN.albedo });
    await new Promise((resolve, reject) => {
        asset.once('load', resolve);
        asset.once('error', reject);
        app.assets.add(asset);
        app.assets.load(asset);
    });
    const tex = asset.resource;
    tex.addressU = tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
    tex.anisotropy = 8;
    terrain.setAlbedo(tex);
    terrain.set('uWrap', GROUND.wrap);
    terrain.set('uTime', 0);
    terrain.set('uLamp', [0, 0, 0, 0]);
    terrain.set('uLampColor', LANTERN.color);
    terrainGround = groundInst;
    setTerrainMode(occluderMode ? 'occluder' : 'mesh');
}

// 'splat': the original splat ground; 'occluder': all splats plus the mesh just under them;
// 'mesh': the drawn mesh with the flat splats culled. Switchable live for A/B timing.
let terrainGround = null;
function setTerrainMode(mode) {
    if (!terrain) return;
    terrain.entity.enabled = mode !== 'splat';
    terrain.entity.setLocalPosition(0, mode === 'occluder' ? -TERRAIN.occluderDepth : 0, 0);
    if (terrainGround) setCullUniforms(terrainGround.splat.gsplat, mode === 'mesh');
}

// ---- terrain bake: the splat ground alone, original colours, seen straight down by an
// orthographic camera that covers TERRAIN; capture the canvas at a square size
function setupAlbedoBake(groundInst) {
    for (const inst of instances) if (inst !== groundInst) inst.splat.enabled = false;
    if (lantern) lantern.holder.enabled = false;
    app.root.findByName('sky').enabled = false;
    relight = 0;
    groundInst.animated = false;
    groundInst.splat.gsplat.setParameter('uWater', 0);
    app.scene.gsplat.minPixelSize = 0;
    app.scene.gsplat.alphaClipForward = 1 / 255;
    const cam = camera.camera;
    cam.projection = pc.PROJECTION_ORTHOGRAPHIC;
    cam.orthoHeight = TERRAIN.half;
    cam.nearClip = 1;
    cam.farClip = 200;
    rig.setPosition(TERRAIN.center[0], 0, TERRAIN.center[1]);
    rig.setEulerAngles(0, 0, 0);
    camera.setLocalPosition(0, 80, 0);
    camera.setLocalEulerAngles(-90, 0, 0); // image top = -Z, image left = -X
    document.getElementById('ui').style.display = 'none';
    window.__bakeReady = true;
}

// ---- boot
(async () => {
    try {
        setStatus('Loading splats…');
        if (land) await bootLand();
        else await bootScan();
        initShadowWorker();
        createHeldProps(await sources.lantern, STICK.enabled ? await sources.stick : null); // after the worker: never traced
        if (land && params.get('critters') !== '0') addCritters(); // after the worker too: they move, so no traced shadows
        // the budget covers every splat; whatever the full-detail ones leave goes to the LOD terrain
        if (lodTerrain) app.scene.gsplat.splatBudget = fixedSplats + lodTerrain;
        if (overdraw) setOverdraw(true);
        resetToStart();
        if (params.has('view')) {
            // debug: ?view=x,y,z,yaw,pitch places the desktop camera
            const [x, y, z, yaw, p] = params.get('view').split(',').map(Number);
            rig.setPosition(x, y - DESKTOP_EYE, z);
            rig.setEulerAngles(0, yaw, 0);
            pitch = p;
            camera.setLocalEulerAngles(pitch, 0, 0);
            feetY = y - DESKTOP_EYE;
            lastHead = null;
        }
        if (params.has('time')) hours = Number(params.get('time'));
        if (params.has('play')) playing = true;
        enterButton.disabled = !app.xr.isAvailable(pc.XRTYPE_VR);
    } catch (err) {
        console.error(err);
        setStatus(`Failed to load: ${err.message}`);
    }
})();

// the scanned island: TripoSplat ground, trees, rocks and bridge
async function bootScan() {
    const ground = await sources[GROUND.asset];
    const groundInst = place(ground, lodSource ? { ...GROUND, lodAsset: await lodSource } : GROUND, 0);
    if (terrainMode || occluderMode) await setupTerrainMesh(ground, groundInst);
    const treeInsts = [];
    for (const cfg of PROPS) {
        const src = await sources[cfg.asset];
        const g = footprintGround(cfg.pos[0], cfg.pos[1], cfg.footprint * cfg.scale);
        const inst = place(src, cfg, g - cfg.sink);
        if (cfg.wind) treeInsts.push(inst);
    }
    if (meadowBudget) {
        // after the props, so blades keep out of rocks and trunks
        const meadow = buildMeadow(app, { ground: { points: groundInst.points, colors: ground.colors, opacity: ground.opacity }, world, budget: meadowBudget });
        const rows = Math.ceil(meadow.count / LIGHT_TEX_WIDTH);
        place({ ...meadow, rows, lightTex: splatTable('meadow-light', rows, meadow.lightBytes), grassTex: splatTable('meadow-grass', rows, meadow.grassBytes) }, MEADOW, 0);
        console.log(`meadow: ${meadow.count} splats, ${meadow.stats.clumps} clumps, ${meadow.stats.flowers} flowers`);
    }
    initAmbience(ground, groundInst, treeInsts);
    if (bakeMode) setupAlbedoBake(groundInst);
}

// An image's pixels, box-filtered down to size x size so a tile a few cm wide samples
// an average rather than one aliased texel. Returns sample(u, v) -> [r, g, b] in 0..1,
// u and v in repeats.
async function loadPixels(url, size) {
    const image = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    return (u, v) => {
        const x = Math.floor((((u % 1) + 1) % 1) * size), y = Math.floor((((v % 1) + 1) % 1) * size);
        const k = (y * size + x) * 4;
        return [data[k] / 255, data[k + 1] / 255, data[k + 2] / 255];
    };
}

// butterflies and bees over the flowers by day, fireflies from dusk (?critters=0 turns them off)
function addCritters() {
    const critters = buildCritters(app, { land });
    const rows = Math.ceil(critters.count / LIGHT_TEX_WIDTH);
    critterInst = place({ ...critters, rows, lightTex: splatTable('critter-light', rows, critters.lightBytes) }, CRITTERS, 0);
    const g = critterInst.splat.gsplat;
    g.setParameter('uCritters', 1);
    g.setParameter('uCritterData', splatTable('critter-data', rows, critters.critterBytes));
    g.setParameter('uCritterPath', critters.pathTex);
    g.setParameter('uCritterGroundRect', new Float32Array(critters.groundRect));
    window.__critterHomes = critters.homes; // debug: [x, ground y, z, kind] per critter
    const { butterflies, bees, fireflies } = critters.stats;
    console.log(`critters: ${butterflies} butterflies, ${bees} bumblebees, ${fireflies} fireflies, ${critters.count} splats`);
}

// the alpine scene's pines: a small wood to the west and a few to the east, spaced out,
// clear of the lake, the rock and the scree. [x, z, index] each
function alpinePines() {
    let a = 77;
    const rand = () => { a = (a * 1103515245 + 12345) >>> 0; return a / 4294967296; };
    const pines = [];
    const groves = [{ x: -11.5, z: 0.5, r: 6.5, n: 11 }, { x: 12, z: -2.5, r: 3.2, n: 3 }];
    for (const g of groves) {
        for (let tries = 0, placed = 0; placed < g.n && tries < 600; tries++) {
            const ang = rand() * 6.2832, d = Math.sqrt(rand()) * g.r;
            const x = g.x + Math.cos(ang) * d, z = g.z + Math.sin(ang) * d;
            if (land.shore(x, z) < 1.5 || land.up(x, z) > 0.01 || land.scree(x, z) > 0.3) continue;
            if (pines.some(([px, pz]) => Math.hypot(px - x, pz - z) < 2.6)) continue;
            pines.push([x, z, pines.length]);
            placed++;
        }
    }
    return pines;
}

// boulders: [{ x, z, r }] along the lake's north-east shore, on the scree at the
// mountain's foot and a few in the grass
function alpineBoulders() {
    let a = 911;
    const rand = () => { a = (a * 1103515245 + 12345) >>> 0; return a / 4294967296; };
    const out = [];
    const tryAdd = (x, z, r) => {
        if (land.shore(x, z) < r * 0.5 || land.up(x, z) > 0.2) return false;
        if (out.some(b => Math.hypot(b.x - x, b.z - z) < b.r + r + 0.3)) return false;
        out.push({ x, z, r });
        return true;
    };
    for (let i = 0, t = 0; i < 4 && t < 200; t++) { // the shore
        const ang = -1.4 + rand() * 1.6, d = 4.6 + rand() * 1.4;
        if (tryAdd(1.5 + Math.cos(ang) * d, -1.8 + Math.sin(ang) * d, 0.35 + rand() * 0.6)) i++;
    }
    for (let i = 0, t = 0; i < 5 && t < 300; t++) { // the scree, a few fallen blocks
        const x = -12 + rand() * 24;
        if (tryAdd(x, land.footZ(x) - 0.5 + rand() * 3.5, 0.5 + rand() * 1.1)) i++;
    }
    for (let i = 0, t = 0; i < 4 && t < 200; t++) { // the grass
        if (tryAdd(-7 + rand() * 14, -4 + rand() * 9, 0.3 + rand() * 0.5)) i++;
    }
    return out;
}

// the synthetic world: ground mesh with the lake bed, the water sheet, then grass and flowers
async function bootLand() {
    terrain = buildTerrainMesh(app, { heightAt: land.height, bounds: { center: [0, 0], half: land.outer }, cell: 0.2 });
    terrain.setAlbedo(land.albedo(app));
    terrain.set('uWrap', 0.1);
    terrain.set('uDetail', 1);
    terrain.set('uFloor', land.waterLevel - 8); // the island's slopes end in the void well below its foot
    // CC0 photos from Poly Haven (public/assets/textures/LICENSE.txt), tiled with mipmaps
    // the alpine scene: grey gravel for scree, shore and banks, and a cliff photo for the rock
    const alpine = land.scene === 'alpine';
    const soilName = alpine ? 'river_small_rocks_diff_1k.jpg' : 'grass_path_2_1k.jpg';
    const [grassTex, soilTex, rockTex] = await Promise.all(['aerial_grass_rock_2k.jpg', soilName, 'marble_cliff_03_diff_1k.jpg'].map(name => new Promise((resolve, reject) => {
        const asset = new pc.Asset(name, 'texture', { url: `assets/textures/${name}` });
        asset.once('load', () => resolve(asset.resource));
        asset.once('error', reject);
        app.assets.add(asset);
        app.assets.load(asset);
    })));
    for (const tex of [grassTex, soilTex, rockTex]) {
        tex.addressU = tex.addressV = pc.ADDRESS_REPEAT;
        tex.anisotropy = 8;
    }
    terrain.set('uGrassTex', grassTex);
    terrain.set('uSoilTex', soilTex);
    terrain.set('uGrassTexMean', [0.448, 0.382, 0.14]);
    terrain.set('uSoilTexMean', alpine ? [0.473, 0.424, 0.356] : [0.557, 0.507, 0.391]);
    terrain.set('uRockTex', rockTex);
    terrain.set('uRockTexMean', [0.613, 0.494, 0.357, 5.75]);
    terrain.set('uTime', 0);
    terrain.set('uLamp', [0, 0, 0, 0]);
    terrain.set('uLampColor', LANTERN.color);
    // relief: real bumps from the photos' displacement maps, baked once over the walkable
    // square (?relief=0 turns it off); everything below stands on the bumped surface
    if (params.get('relief') !== '0') {
        const started = performance.now();
        const [grassColour, grassHeight, soilHeight] = await Promise.all([
            loadPixels('assets/textures/aerial_grass_rock_2k.jpg', 1024),
            loadPixels('assets/textures/aerial_grass_rock_disp_1k.png', 1024),
            loadPixels('assets/textures/grass_path_2_disp_1k.png', 512)
        ]);
        terrain.setRelief(land.bake({ grassColour, grassHeight, soilHeight }));
        terrain.createNear();
        console.log(`relief: baked in ${Math.round(performance.now() - started)} ms`);
    }
    const surface = land.surfacePoints();
    world.addPoints(surface.points, surface.opacity);
    const water = land.water(app);
    const waterRows = Math.ceil(water.count / LIGHT_TEX_WIDTH);
    waterInst = place({ ...water, rows: waterRows, height: 0, lightTex: splatTable('water-light', waterRows, water.lightBytes) }, WATER, 0);
    console.log(`water: ${water.count} splats`);
    // an oak on the knoll north-east of the lake; before the meadow, so no grass grows in its trunk
    // CC0 bark photo and its displacement map (public/assets/textures/LICENSE.txt)
    const [barkColour, barkHeight] = await Promise.all([
        loadPixels('assets/textures/bark_willow_02_diff_1k.jpg', 512),
        loadPixels('assets/textures/bark_willow_02_disp_1k.png', 512)
    ]);
    const bark = (u, v) => ({ c: barkColour(u, v), h: barkHeight(u, v)[0] });
    const plantTree = (opts) => {
        const tree = buildTree(app, { leaves: Number(params.get('leaves') ?? 90000), groundAt: land.surface, bark, ...opts });
        const treeRows = Math.ceil(tree.count / LIGHT_TEX_WIDTH);
        place({ ...tree, rows: treeRows, lightTex: splatTable('tree-light', treeRows, tree.lightBytes), grassTex: splatTable('tree-wind', treeRows, tree.grassBytes) }, TREE, 0);
        console.log(`tree: ${tree.count} splats, ${tree.stats.clumps} clumps, ${tree.height.toFixed(1)} m tall, crown radius ${tree.crown.radius.toFixed(1)} m`);
        return tree;
    };
    const canopies = []; // for the birdsong
    if (alpine) {
        // a small wood of pines to the west, and a few to the east
        for (const [x, z, k] of alpinePines()) {
            const tree = plantTree({ species: 'pine', base: [x, land.surface(x, z) - 0.05, z], seed: 100 + k, size: 0.8 + ((k * 0.37) % 0.4), leaves: Number(params.get('needles') ?? 17000) });
            canopies.push({ canopy: [x, land.surface(x, z) + tree.height * 0.7, z], radius: 1.5 });
        }
        // boulders: along the lake's shore, at the mountain's foot and here and there in the grass
        const [rockColour, rockHeight] = await Promise.all([
            loadPixels('assets/textures/marble_cliff_03_diff_1k.jpg', 512),
            loadPixels('assets/textures/marble_cliff_03_disp_1k.png', 512)
        ]);
        const boulders = buildBoulders(app, { boulders: alpineBoulders(), groundAt: land.surface, rock: (u, v) => ({ c: rockColour(u, v), h: rockHeight(u, v)[0] }) });
        const rows = Math.ceil(boulders.count / LIGHT_TEX_WIDTH);
        place({ ...boulders, rows, lightTex: splatTable('boulder-light', rows, boulders.lightBytes) }, BOULDERS, 0);
        console.log(`boulders: ${boulders.count} splats`);
    } else {
        const tree = plantTree({ base: [6, land.surface(6, -6.5) - 0.1, -6.5] });
        canopies.push({ canopy: [6, land.surface(6, -6.5) + tree.height * 0.7, -6.5], radius: 2.5 });
    }
    const meadow = buildMeadow(app, { sample: land.sample, world, budget: meadowBudget, turf: turfBudget, half: land.grassReach });
    const rows = Math.ceil(meadow.count / LIGHT_TEX_WIDTH);
    place({ ...meadow, rows, lightTex: splatTable('meadow-light', rows, meadow.lightBytes), grassTex: splatTable('meadow-grass', rows, meadow.grassBytes) }, MEADOW, 0);
    console.log(`meadow: ${meadow.count} splats, ${meadow.stats.clumps} clumps, ${meadow.stats.flowers} flowers`);
    // no stream: birds and rustling come from the trees and the hills around
    const edge = [[-11, -9], [10, 9], [-10, 10]].map(([x, z]) => ({ canopy: [x, land.height(x, z) + 1.5, z], radius: 2 }));
    const grass = [[-4, 5], [5, 4], [-5, -6], [4, -7]].map(([x, z]) => [x, land.height(x, z) + 0.1, z]);
    ambience = createAmbience({ water: [], grass, trees: alpine ? canopies : edge });
    const start = () => ambience.start();
    enterButton.addEventListener('click', start);
    app.graphicsDevice.canvas.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
}

app.on('update', (dt) => {
    if (!instances.length) return;
    dt = Math.min(dt, 0.1);
    elapsed += dt;
    const [mx, mz] = app.xr.active ? xrInput(dt) : desktopInput(dt);
    walk(mx, mz, dt);

    advanceTime(dt);
    applyLighting();
    updateSky();
    // wind and water re-shade only the instances that animate
    for (const inst of instances) {
        if (inst.animated) inst.splat.gsplat.setParameter('uTime', elapsed);
    }
    terrain?.set('uTime', elapsed);
    if (terrain?.followNear) {
        const head = camera.getPosition();
        terrain.followNear(head.x, head.z);
    }
    // fireflies come out from dusk (sun 2 degrees above the horizon, fully at 6 below)
    critterInst?.splat.gsplat.setParameter('uDusk', Math.max(0, Math.min(1, (2 - light.elevation) / 8)));
    if (waterInst) {
        const eye = camera.getPosition();
        waterInst.splat.gsplat.setParameter('uEye', new Float32Array([eye.x, eye.y, eye.z]));
    }
    updateShadows();
    updateHeld();
    ambience?.update({ time: elapsed, head: camera.getPosition(), forward: camera.forward, up: camera.up, elevation: light.elevation });

    if (!app.xr.active) {
        const clock = manualSun ? 'sun placed by hand' : `${formatTime(hours)}${playing ? ' ▶' : ''}`;
        const o = overdrawStats;
        const layers = overdraw ? ` · overdraw: ${o.mean.toFixed(1)} layers per pixel, ${o.covered.toFixed(1)} where covered, 95% ≤ ${o.p95.toFixed(0)}, max ${o.max.toFixed(0)}` : '';
        setStatus(`${clock} · sharpness ${SHARPNESS_LEVELS[sharpIndex].name}${relight ? '' : ' · original colours'}${shadowBusy ? ' · shadows…' : ''}${layers}`);
    }
});
