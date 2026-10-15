// Traces key-light transmittance for every placed splat off the main thread.
// init:  { grid, instances: [{ points, normals }] }
// trace: { id, dir }  ->  { id, dir, shadows: [Uint8Array per instance] }
import { VoxelWorld } from './world.js';

let world = null;
let instances = [];

self.onmessage = ({ data }) => {
    if (data.type === 'init') {
        world = Object.assign(Object.create(VoxelWorld.prototype), data.grid);
        instances = data.instances;
        return;
    }
    const shadows = instances.map(({ points, normals }) => {
        const out = new Uint8Array(points.length / 3);
        for (const _ of world.traceShadows(points, normals, out, data.dir));
        return out;
    });
    self.postMessage({ id: data.id, dir: data.dir, shadows }, shadows.map(s => s.buffer));
};
