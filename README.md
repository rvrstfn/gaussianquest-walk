# GaussianQuest Walk

Two walkable worlds for Quest 3, built from procedurally generated Gaussian splats with
PlayCanvas 2.22 and run in the Quest Browser over WebXR:

- **Meadow** (`?world=meadow`, the default): rolling hills around a lake, grass and
  wild flowers, an old oak, butterflies, bumblebees and fireflies.
- **Alps** (`?world=alpine`): a limestone mountain with snow on its upper slopes, scree,
  an emerald tarn, alpine flowers, a small wood of pines and angular boulders.

Everything is generated in the browser at startup, down to the lantern you carry at
night. The only asset files are a few CC0 photo textures. Both worlds are floating islands
with a full day cycle: sun, moon and stars, traced shadows, wind and synthesised sound.
Use the **Meadow · Alps** links on the start panel to switch between them.

## Run on the Quest

```bash
npm install
npm run dev                                   # serves https://localhost:5173 and https://<LAN IP>:5173
```

The dev server uses a self-signed certificate (`@vitejs/plugin-basic-ssl`).

- **Wi-Fi:** open `https://<this PC's LAN IP>:5173` in the Quest Browser and
  accept the certificate warning once (Advanced → Proceed). The PC firewall
  must allow TCP 5173.
- **USB:** `npx -y metavr adb reverse tcp:5173 tcp:5173`, then
  `npx -y metavr device browser https://localhost:5173/`.

Press **Enter VR** in the page. It also runs in a desktop browser.

| Quest | Desktop | Action |
|---|---|---|
| Left stick (click to run) | WASD, Shift | Walk relative to where you look |
| Right stick left/right | Mouse (click to lock) | Smooth turn (up to 90°/s) / look |
| Right stick up/down | Q / E | Scrub the time of day |
| A | 1–4 | Time-lapse to morning, noon, golden hour, night |
| Y | P | Play/pause the day cycle (4 min: about 50 s dawn, 50 s day, 50 s dusk, 90 s night) |
| Hold right grip and point | Hold right mouse | Place the sun where you point |
| B | L | Relighting on/off |
| Right trigger | K | Cycle splat sharpness: original (default), soft, crisp, painterly, max |
| Left grip | M | Sound on/off |
| Left trigger | | Lantern light on/off (it lights up by itself after dusk) |
| X | R | Back to the start point |

## How it works

**Land** (`src/land.js`). Layered value noise makes the hills around a lake, ringed by
higher hills with two saddles, east and west, where the low sun gets in. Past the hills
the ground rounds over an irregular rim and falls into the void, so the world's edge is
never in view. The ground is an opaque heightmap mesh (`src/terrain-mesh.js`) with a
painted albedo. The shader adds detail from CC0 photos, hex-tiled so the repeat doesn't
show, with sharp triplanar projection on steep banks. In the Alps a limestone ridge rises
along the north side, its face cut into flat facets that meet at hard edges. The rock uses
a cliff photo that isn't rotated, so its strata stay horizontal, and snow lies on the upper
slopes that aren't too steep.

**Water.** A sheet of flat splats over the lake bed. In the work-buffer pass
(`src/relight.js`), long swells and noise ripples lift and tilt each splat. Its colour
mixes the water body with the reflected sky, sun or moon glints and the lantern at night.

**Grass and flowers** (`src/meadow.js`). Tufts, turf blades and flower drifts, all splats:
daisies, buttercups, lupins, clover and cornflowers in the meadow; gentians, edelweiss,
alpine roses, globeflowers and monkshood in the Alps. Gust fronts roll across them in step
with the trees.

**Trees** (`src/tree.js`). The oak grows recursively: a contorted trunk with flaring roots,
limbs bending in S-curves, twigs and about 90k leaves in clumps. The pines have a straight
trunk, a spiral of branches long below and short above, and flat pads of needles. Bark is
tile-like splats coloured from a CC0 bark photo and displaced by its height map. Trees
block walking, cast shadows and sway in the wind.

**Boulders** (`src/rocks.js`). Blocks bounded by a dozen random cut planes, so the faces
are flat and meet at sharp edges, covered in splats coloured and displaced from the cliff
photo.

**Critters** (`src/critters.js`, `?critters=0` turns them off). Butterflies and bumblebees
by day, blinking fireflies at dusk. Each is a few splats animated on the GPU along its own
path.

**Light.** Every splat carries a normal and an ambient occlusion term. The sun rises in
the east and peaks in the south; sky and ambient colours follow its elevation, and the
moon takes over at night. A Web Worker traces shadows through a voxel grid
(`src/shadow-worker.js`, `src/world.js`). The sky (`src/sky.js`) is a procedural dome
with clouds, a sun disc, stars and the moon. The lantern in your right hand (`src/lantern.js`) is a
warm point light from dusk on.

**Collisions** (`src/world.js`). Opaque splats fill a 15 cm voxel grid. You follow the
ground, step up 45 cm and can't walk through trunks or rocks.

**Sound** (`src/ambience.js`). Web Audio synthesis, no sound files: a soft breeze, leaves
rustling with the gusts, birds by day, crickets and an owl at night, each placed in 3D.

**Performance on Quest 3.** Fixed foveated rendering, the XR framebuffer at 80%
resolution (`?f=1` for full), splats under 2 px skipped, radial sorting and an alpha clip.
The ground is a mesh rather than splats, which keeps overdraw low. The Alps carry more
splats than the meadow (the pines are about 400k), so they are heavier.

Debug URL parameters: `?view=x,y,z,yaw,pitch` places the desktop camera,
`?time=0..24` sets the time of day, `?play` starts the cycle,
`?sharp=original|soft|crisp|painterly|max` sets sharpness, `?meadow=N` and `?turf=N`
set the grass budgets, `?leaves=N` the oak's leaves, `?needles=N` each pine's needles,
`?eye=` the VR eye height, `?nomod` disables relighting, `?overdraw` (or O) shows splat
layers per pixel.

## Licence

The code is MIT licensed (see `LICENSE`). The textures are CC0 from Poly Haven; see
`public/assets/textures/LICENSE.txt` for their authors. PlayCanvas is MIT licensed.
