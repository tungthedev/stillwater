import { WORLD } from '../config.js';

// Plans a realistic hiking trail over the raw heightmap with A* (grade-penalised,
// which naturally produces switchbacks), then carves it into the terrain.

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v; const top = v[0];
    const lk = k.pop(), lv = v.pop(); const n = k.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        let l = 2 * i + 1, r = l + 1, m = i; let mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

function astar(grid, G, cell, from, to) {
  const N = G * G;
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  const idx = (x, z) => z * G + x;
  const s = idx(from[0], from[1]), t = idx(to[0], to[1]);
  gScore[s] = 0; heap.push(0, s);
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [1, 2], [-2, 1], [-1, 2], [2, -1], [1, -2], [-2, -1], [-1, -2]];
  const tx = to[0], tz = to[1];
  while (heap.size) {
    const c = heap.pop();
    if (c === t) break;
    if (closed[c]) continue;
    closed[c] = 1;
    const cx = c % G, cz = (c / G) | 0;
    const hc = grid[c];
    for (const [dx, dz] of nb) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 1 || nz < 1 || nx >= G - 1 || nz >= G - 1) continue;
      const n = idx(nx, nz);
      if (closed[n]) continue;
      const hn = grid[n];
      if (hn < WORLD.waterLevel + 2.5) continue;
      const d = Math.hypot(dx, dz) * cell;
      const grade = Math.abs(hn - hc) / d;
      // mid-point check for knife edges
      const cost = d * (1 + Math.pow(grade / 0.13, 4) * 2.0 + (grade > 0.42 ? 400 : 0));
      const g = gScore[c] + cost;
      if (g < gScore[n]) {
        gScore[n] = g; came[n] = c;
        const hd = Math.hypot(nx - tx, nz - tz) * cell;
        heap.push(g + hd, n);
      }
    }
  }
  const path = [];
  let c = t;
  while (c !== -1) { path.push([c % G, (c / G) | 0]); if (c === s) break; c = came[c]; }
  return path.reverse();
}

function chaikin(pts, iters) {
  for (let it = 0; it < iters; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= L) {
      const f = t / L;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = L - (t - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function planTrail(heights) {
  const { res, size } = WORLD;
  const G = 256, cell = size / G, ratio = res / G;
  const grid = new Float32Array(G * G);
  for (let z = 0; z < G; z++) for (let x = 0; x < G; x++) {
    const sx = Math.min(res - 1, Math.floor((x + 0.5) * ratio));
    const sz = Math.min(res - 1, Math.floor((z + 0.5) * ratio));
    let mn = Infinity;
    for (let dz = -4; dz <= 4; dz += 2) for (let dx = -4; dx <= 4; dx += 2) {
      const ix = Math.min(res - 1, Math.max(0, sx + dx)), iz = Math.min(res - 1, Math.max(0, sz + dz));
      mn = Math.min(mn, heights[iz * res + ix]);
    }
    grid[z * G + x] = mn;
  }
  const toCell = (p) => [Math.round((p.x / size + 0.5) * G - 0.5), Math.round((p.z / size + 0.5) * G - 0.5)];
  const toWorld = (c) => [(c[0] + 0.5) / G * size - size / 2, (c[1] + 0.5) / G * size - size / 2];

  const L = WORLD.lake;
  const a = -0.35;
  const shore = { x: L.x + Math.cos(a) * L.rx * 1.12, z: L.z + Math.sin(a) * L.rz * 1.12 };
  const ridge = { x: -330, z: -470 };
  const legs = [[WORLD.start, shore], [shore, ridge], [ridge, WORLD.summit]];
  let cells = [];
  for (const [p, q] of legs) {
    const seg = astar(grid, G, cell, toCell(p), toCell(q));
    if (cells.length) seg.shift();
    cells = cells.concat(seg);
  }
  let pts = cells.map(toWorld);
  // gentle meander so it does not look grid-aligned
  pts = chaikin(pts, 4);
  pts = resample(pts, 2.0);
  // smooth again with a moving average on positions
  const sm = pts.map((p, i) => {
    let sx = 0, sz = 0, n = 0;
    for (let k = -6; k <= 6; k++) {
      const q = pts[Math.min(pts.length - 1, Math.max(0, i + k))];
      sx += q[0]; sz += q[1]; n++;
    }
    return [sx / n, sz / n];
  });
  sm[0] = pts[0]; sm[sm.length - 1] = pts[pts.length - 1];
  return { points: sm, shore, ridge };
}

/** Carve the trail into the heightmap, returning the trail mask channel. */
export function carveTrail(heights, trail) {
  const { res, size } = WORLD;
  const texel = size / res;
  const pts = trail.points;
  const sample = (x, z) => {
    const fx = Math.min(res - 1, Math.max(0, Math.round((x / size + 0.5) * res - 0.5)));
    const fz = Math.min(res - 1, Math.max(0, Math.round((z / size + 0.5) * res - 0.5)));
    return heights[fz * res + fx];
  };
  // trail tread height: heavily smoothed profile
  let ph = pts.map((p) => sample(p[0], p[1]));
  for (let pass = 0; pass < 3; pass++) {
    const n = ph.map((_, i) => {
      let s = 0, c = 0;
      for (let k = -8; k <= 8; k++) { s += ph[Math.min(ph.length - 1, Math.max(0, i + k))]; c++; }
      return s / c;
    });
    ph = n;
  }
  ph = ph.map((h) => Math.max(h, WORLD.waterLevel + 0.6));
  trail.heights = ph;
  // cumulative distance
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  trail.dist = dist;

  const N = res * res;
  const best = new Float32Array(N).fill(1e9);
  const bestH = new Float32Array(N);
  const R = 9; // influence radius (m)
  const rt = Math.ceil(R / texel) + 1;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0 && i < 6) continue; // let the very start read as a path, not a clearing
    const [px, pz] = pts[i];
    const cx = Math.round((px / size + 0.5) * res - 0.5), cz = Math.round((pz / size + 0.5) * res - 0.5);
    for (let dz = -rt; dz <= rt; dz++) for (let dx = -rt; dx <= rt; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= res || z >= res) continue;
      const wx = (x + 0.5) / res * size - size / 2, wz = (z + 0.5) / res * size - size / 2;
      const d = Math.hypot(wx - px, wz - pz);
      const j = z * res + x;
      if (d < best[j]) { best[j] = d; bestH[j] = ph[i]; }
    }
  }
  const mask = new Float32Array(N);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let j = 0; j < N; j++) {
    const d = best[j];
    if (d > R) continue;
    const w = 1 - ss(1.6, R, d);
    // keep a slight crown + ditch for realism
    let target = bestH[j] - 0.12 + 0.08 * Math.max(0, 1 - d / 1.2);
    if (heights[j] < WORLD.waterLevel + 1.0) target = Math.min(target, heights[j]);
    heights[j] = heights[j] * (1 - w) + target * w;
    mask[j] = 1 - ss(0.55, 1.75, d);
  }
  return mask;
}
