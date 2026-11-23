import * as THREE from 'three';
import { WORLD } from '../config.js';

// Small deterministic JS noise used for CPU-side scattering.
export function hash2(x, z) {
  let h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}
export function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
export function fbm(x, z, oct = 4) {
  let a = 0, b = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { a += b * vnoise(x * f, z * f); b *= 0.5; f *= 2.03; }
  return a / (1 - Math.pow(0.5, oct));
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Biome map: r forest density, g flowers, b tall meadow grass. */
export function buildBiome(hf) {
  const R = WORLD.biomeRes, S = WORLD.size;
  const data = new Uint8Array(R * R * 4);
  const forest = new Float32Array(R * R);
  const n = { x: 0, y: 1, z: 0 };
  const L = WORLD.lake, sm = WORLD.summit;
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    const x = (i + 0.5) / R * S - S / 2, z = (j + 0.5) / R * S - S / 2;
    const h = hf.height(x, z);
    hf.normal(x, z, 4, n);
    const slope = 1 - n.y;
    const trail = hf.trailAt(x, z);
    // forest clusters
    let f = fbm(x * 0.0035 + 11.3, z * 0.0035 - 4.1, 5);
    f = ss(0.5, 0.58, f + 0.08 * fbm(x * 0.02, z * 0.02, 2));
    f *= 1 - ss(950, 1150, h + fbm(x * 0.01, z * 0.01, 2) * 120); // treeline
    f *= 1 - ss(0.38, 0.6, slope);
    f *= ss(WORLD.waterLevel + 2, WORLD.waterLevel + 9, h);
    // keep lake meadow & summit open
    const dl = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
    f *= ss(1.25, 1.8, dl + 0.2 * fbm(x * 0.01, z * 0.01, 2));
    const ds = Math.hypot(x - sm.x, z - sm.z);
    f *= ss(150, 320, ds);
    // flowers like open sunny meadows
    let fl = ss(0.5, 0.75, fbm(x * 0.012 + 3.0, z * 0.012 + 9.0, 4));
    fl *= (1 - f) * (1 - ss(0.25, 0.45, slope)) * (1 - ss(900, 1100, h));
    const meadow = ss(0.35, 0.7, fbm(x * 0.006 - 7.0, z * 0.006 + 2.0, 4)) * (1 - f);
    const k = (j * R + i) * 4;
    forest[j * R + i] = f * (1 - Math.min(1, trail * 2));
    data[k] = Math.round(f * 255);
    data[k + 1] = Math.round(fl * 255);
    data[k + 2] = Math.round(meadow * 255);
    data[k + 3] = 255;
  }
  // flowers and lush grass gather along the whole trail
  if (hf.trailPoints) {
    const rad = 4;
    for (let p = 0; p < hf.trailPoints.length; p += 3) {
      const [tx, tz] = hf.trailPoints[p];
      const ci = Math.floor((tx / S + 0.5) * R), cj = Math.floor((tz / S + 0.5) * R);
      for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= R || j >= R) continue;
        const d = Math.hypot(di, dj) / rad;
        if (d > 1) continue;
        const k = (j * R + i) * 4;
        const bump = (1 - d) * 0.6 * Math.max(0, fbm(i * 0.25, j * 0.25, 2) - 0.35) * 2.2;
        data[k + 1] = Math.min(255, data[k + 1] + bump * 255 * (1 - data[k] / 255));
      }
    }
  }
  const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, forest, sampleForest(x, z) {
    const fx = Math.min(R - 1, Math.max(0, Math.floor((x / S + 0.5) * R)));
    const fz = Math.min(R - 1, Math.max(0, Math.floor((z / S + 0.5) * R)));
    return forest[fz * R + fx];
  }, sampleFlowers(x, z) {
    const fx = Math.min(R - 1, Math.max(0, Math.floor((x / S + 0.5) * R)));
    const fz = Math.min(R - 1, Math.max(0, Math.floor((z / S + 0.5) * R)));
    return data[(fz * R + fx) * 4 + 1] / 255;
  } };
}
