// Voxel occupancy built from splat centres. It drives walking collisions,
// ground following and the sun shadow rays used by the relighting.

export class VoxelWorld {
    constructor(min, max, cell) {
        this.cell = cell;
        this.inv = 1 / cell;
        this.min = min;
        this.nx = Math.ceil((max[0] - min[0]) * this.inv);
        this.ny = Math.ceil((max[1] - min[1]) * this.inv);
        this.nz = Math.ceil((max[2] - min[2]) * this.inv);
        this.counts = new Uint8Array(this.nx * this.ny * this.nz);
        this.topY = min[1];
    }

    // Count the opaque splat centres of one placed asset.
    addPoints(points, opacity, minOpacity = 0.4) {
        const { inv, min, nx, ny, nz, counts } = this;
        for (let i = 0; i < opacity.length; i++) {
            if (opacity[i] < minOpacity) continue;
            const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
            const ix = Math.floor((x - min[0]) * inv);
            const iy = Math.floor((y - min[1]) * inv);
            const iz = Math.floor((z - min[2]) * inv);
            if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
            const k = (iy * nz + iz) * nx + ix;
            if (counts[k] < 255) counts[k]++;
            if (y > this.topY) this.topY = y;
        }
    }

    count(x, y, z) {
        const ix = Math.floor((x - this.min[0]) * this.inv);
        const iy = Math.floor((y - this.min[1]) * this.inv);
        const iz = Math.floor((z - this.min[2]) * this.inv);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return 0;
        return this.counts[(iy * this.nz + iz) * this.nx + ix];
    }

    // Highest occupied height around (x, z) between minY and maxY, or null. Terrain
    // splats are sparser than the cells, so the 3x3 neighbourhood is searched.
    groundAt(x, z, maxY, minY) {
        const { nx, nz, counts } = this;
        const ix = Math.floor((x - this.min[0]) * this.inv);
        const iz = Math.floor((z - this.min[2]) * this.inv);
        if (ix < 1 || iz < 1 || ix >= nx - 1 || iz >= nz - 1) return null;
        const top = Math.min(this.ny - 1, Math.floor((maxY - this.min[1]) * this.inv));
        const bottom = Math.max(0, Math.floor((minY - this.min[1]) * this.inv));
        for (let iy = top; iy >= bottom; iy--) {
            for (let dz = -1; dz <= 1; dz++) {
                const row = (iy * nz + iz + dz) * nx + ix;
                if (counts[row - 1] || counts[row] || counts[row + 1]) return this.min[1] + (iy + 0.75) * this.cell;
            }
        }
        return null;
    }

    // True when a vertical body segment at (x, z) overlaps solid cells.
    bodyBlocked(x, z, fromY, toY, radius, minCount = 2) {
        for (let s = 0; s <= 8; s++) {
            const a = s * Math.PI / 4;
            const px = s === 8 ? x : x + Math.cos(a) * radius;
            const pz = s === 8 ? z : z + Math.sin(a) * radius;
            for (let y = fromY; y <= toY; y += this.cell) {
                if (this.count(px, y, pz) >= minCount) return true;
            }
        }
        return false;
    }

    // Writes sun transmittance (0..255) for each splat. Yields between chunks
    // so the caller can spread the work across frames.
    *traceShadows(points, normals, out, sunDir) {
        const { inv, min, nx, ny, nz, counts, cell } = this;
        const [lx, ly, lz] = sunDir;
        const step = cell * 1.5;
        const topY = this.topY + cell;
        const n = out.length;
        for (let i = 0; i < n; i++) {
            if ((i & 2047) === 2047) yield i;
            const o = i * 3;
            let x = points[o] + normals[o] * 0.3 + lx * 0.15;
            let y = points[o + 1] + normals[o + 1] * 0.3 + ly * 0.15;
            let z = points[o + 2] + normals[o + 2] * 0.3 + lz * 0.15;
            let t = 1;
            for (let s = 0; s < 160 && y < topY; s++) {
                x += lx * step; y += ly * step; z += lz * step;
                const ix = Math.floor((x - min[0]) * inv);
                const iy = Math.floor((y - min[1]) * inv);
                const iz = Math.floor((z - min[2]) * inv);
                if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) break;
                const c = counts[(iy * nz + iz) * nx + ix];
                if (c) {
                    t *= 1 - 0.5 * Math.min(1, c / 4);
                    if (t < 0.04) { t = 0; break; }
                }
            }
            out[i] = Math.round(t * 255);
        }
    }
}

// Minimal reader for the TripoSplat PLY layout (binary little-endian floats).
export function parsePly(buffer) {
    const bytes = new Uint8Array(buffer);
    const marker = 'end_header\n';
    let end = -1;
    for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
        if (bytes[i] === 0x65 && String.fromCharCode(...bytes.subarray(i, i + marker.length)) === marker) {
            end = i + marker.length;
            break;
        }
    }
    if (end < 0) throw new Error('PLY header not found');
    const header = new TextDecoder().decode(bytes.subarray(0, end)).split('\n');
    const count = parseInt(header.find(l => l.startsWith('element vertex')).split(' ')[2], 10);
    const props = header.filter(l => l.startsWith('property float')).map(l => l.split(' ')[2]);
    const stride = props.length;
    const data = new Float32Array(buffer.slice(end, end + count * stride * 4));
    const ix = props.indexOf('x'), iy = props.indexOf('y'), iz = props.indexOf('z'), io = props.indexOf('opacity');
    const ic = props.indexOf('f_dc_0');
    const points = new Float32Array(count * 3);
    const opacity = new Float32Array(count);
    const colors = new Float32Array(count * 3); // base colour, 0..1
    for (let i = 0; i < count; i++) {
        points[i * 3] = data[i * stride + ix];
        points[i * 3 + 1] = data[i * stride + iy];
        points[i * 3 + 2] = data[i * stride + iz];
        opacity[i] = 1 / (1 + Math.exp(-data[i * stride + io]));
        for (let c = 0; c < 3; c++) colors[i * 3 + c] = 0.5 + 0.28209479 * data[i * stride + ic + c];
    }
    return { count, points, opacity, colors };
}
