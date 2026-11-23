import { HeightField } from './heightmap.js';
import { mulberry32, fbm } from './biome.js';

// Canonical world data representation, spatial queries, rank-based tier subsetting,
// data-driven scenery edits, stable hashing, and baked binary encode/decode/loader.
// Pure data/CPU module: no DOM, no input, no WebGL objects, no single-world singletons.

const TWO_PI = Math.PI * 2;
const TREE_SCALE_MAX = 64;
const TREE_SX_MAX = 4;
const TREE_TINT_MAX = 4;
const PLACEMENTS_MAGIC = 0x4c505753; // 'SWPL' LE
const PATHS_MAGIC = 0x54505753;      // 'SWPT' LE
const GRID_CELL = 16;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function fnvCreate() {
  return { h1: 0x811c9dc5 >>> 0, h2: 0x9e3779b9 >>> 0 };
}

function fnvMixU32(state, word) {
  let h1 = Math.imul(state.h1 ^ (word >>> 0), 0x01000193) >>> 0;
  let h2 = Math.imul(state.h2 ^ (((word >>> 16) | (word << 16)) >>> 0), 0x85ebca6b) >>> 0;
  h2 = (h2 ^ (h1 >>> 13)) >>> 0;
  state.h1 = h1;
  state.h2 = h2;
}

const _f32Scratch = new Float32Array(1);
const _u32Scratch = new Uint32Array(_f32Scratch.buffer);

function fnvMixF32(state, value) {
  if (value === 0) {
    fnvMixU32(state, 0);
    return;
  }
  _f32Scratch[0] = value;
  fnvMixU32(state, _u32Scratch[0]);
}

function fnvMixString(state, str) {
  fnvMixU32(state, str.length);
  for (let i = 0; i < str.length; i++) fnvMixU32(state, str.charCodeAt(i));
}

function fnvFinish(state) {
  return 'fnv64:' + state.h1.toString(16).padStart(8, '0') + state.h2.toString(16).padStart(8, '0');
}

/** Deterministic per-item rank in [0, 1) derived solely from canonical placement properties. */
export function placementRank(x, z, kind, salt = 0) {
  const st = fnvCreate();
  fnvMixU32(st, kind | 0);
  fnvMixU32(st, salt | 0);
  fnvMixU32(st, Math.round(x * 100) | 0);
  fnvMixU32(st, Math.round(z * 100) | 0);
  fnvMixU32(st, (st.h1 ^ st.h2) >>> 0);
  const u16 = ((st.h1 ^ (st.h2 >>> 16)) >>> 0) & 0xffff;
  return u16 / 65536;
}

/**
 * Select a tier's drawn subset from canonical ranked placements.
 * Ranks are stable in [0, 1); density >= 1 returns every item, and lower densities
 * return strict prefixes so subsets nest monotonically across tiers.
 */
export function selectByRank(items, density = 1) {
  if (!items || !items.length) return [];
  if (density >= 1) return items.slice();
  if (density <= 0) return [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.rank < density) out.push(it);
  }
  return out;
}

/** Generate full-density canonical tree & bush placements with stable per-item ranks. */
export function generateTreePlacements(hf, biome, region) {
  const rnd = mulberry32(777);
  const S = region.size;
  const L = region.lake;
  const wl = region.waterLevel;
  const trees = [];
  const n = { x: 0, y: 1, z: 0 };
  const step = 7.6;

  for (let z = -S / 2 + 40; z < S / 2 - 40; z += step) {
    for (let x = -S / 2 + 40; x < S / 2 - 40; x += step) {
      const pullX = (fbm(x * 0.013 + 2.1, z * 0.013 - 3.7, 2) - 0.5) * step * 1.90;
      const pullZ = (fbm(x * 0.013 - 5.3, z * 0.013 + 4.9, 2) - 0.5) * step * 1.90;
      const px = x + (rnd() - 0.5) * step * 1.18 + pullX;
      const pz = z + (rnd() - 0.5) * step * 1.18 + pullZ;
      const f = biome.sampleForest(px, pz);
      const h = hf.height(px, pz);
      if (h < wl + 1.6) continue;
      const avgH = 0.25 * (hf.height(px + 18, pz) + hf.height(px - 18, pz) + hf.height(px, pz + 18) + hf.height(px, pz - 18));
      const drainBoost = Math.max(0, Math.min(0.32, (avgH - h) * 0.10));
      const copse = fbm(px * 0.0085 - 4.1, pz * 0.0085 + 7.3, 3) + drainBoost;
      const edgeFea = Math.max(0, Math.min(1, (copse - 0.36) / 0.28));
      const edgeSmooth = edgeFea * edgeFea * (3 - 2 * edgeFea);
      const clumpFactor = f > 0.62 ? 1.0 : edgeSmooth;
      if (rnd() > f * clumpFactor * 1.22) continue;
      if (hf.trailAt(px, pz) > 0.02) continue;
      hf.normal(px, pz, 2, n);
      if (n.y < 0.72) continue;
      if (h > 1150 + fbm(px * 0.01, pz * 0.01, 2) * 120) continue;
      const dl = Math.hypot((px - L.x) / L.rx, (pz - L.z) / L.rz);
      const alt = (h - 140) / 560;
      const larchPatch = fbm(px * 0.0014 + 19.4, pz * 0.0014 - 11.2, 3) + (fbm(px * 0.0055, pz * 0.0055, 2) - 0.5) * 0.22;
      const larchBlend = Math.max(0, Math.min(1, (larchPatch - 0.52) / 0.28)) * Math.max(0, Math.min(1, (h - 155) / 140));
      const r = rnd();
      let v;
      if (larchBlend > 0.46 && r < larchBlend * 0.54) v = 5;
      else if (dl < 1.85 && dl > 1.02 && r < 0.42) v = 4;
      else if (rnd() < 0.18 + Math.max(0, alt) * 0.85 + f * 0.26) v = 2;
      else v = rnd() < 0.56 ? 0 : 1;
      const edgeShrink = f < 0.40 ? (0.58 + 0.42 * (f / 0.40)) : (0.72 + 0.64 * Math.pow(rnd(), 1.35));
      const baseS = v === 2 || v === 5 ? 12.0 + rnd() * 11.5 : v === 4 ? 12.0 + rnd() * 8.0 : 8.5 + rnd() * 11.0;
      const scale = baseS * edgeShrink * (1 - Math.max(0, h - 700) / 1500);
      const hue = 0.80 + rnd() * 0.36;
      const grove = fbm(px * 0.0036 + 31, pz * 0.0036 - 7, 3);
      const warmG = 1.0 + larchBlend * 0.22 + (grove > 0.55 ? 0.12 : 0.0);
      const coolG = grove < 0.44 ? 1.18 : 1.0;
      trees.push({
        x: px, z: pz, y: h - 0.25, s: scale, rot: rnd() * TWO_PI, v,
        sx: 0.78 + rnd() * 0.48,
        tint: [hue * (0.90 + rnd() * 0.20) * warmG, hue * (0.98 + larchBlend * 0.08), hue * (0.84 + rnd() * 0.24) * coolG * (1.0 - larchBlend * 0.14)],
        bush: false,
        salt: 1,
        rank: placementRank(px, pz, v, 1),
      });
    }
  }

  // Trail-side cathedral trees inside forests
  if (hf.trailPoints) {
    for (let i = 0; i < hf.trailPoints.length; i += 3) {
      const [tx, tz] = hf.trailPoints[i];
      if (biome.sampleForest(tx + 12, tz) + biome.sampleForest(tx - 12, tz) < 0.7) continue;
      const j = Math.min(hf.trailPoints.length - 1, i + 2);
      const dx = hf.trailPoints[j][0] - tx, dz = hf.trailPoints[j][1] - tz, l = Math.hypot(dx, dz) || 1;
      for (const s of [-1, 1]) {
        if (rnd() > 0.56) continue;
        const off = 5.6 + rnd() * 4.2;
        const px = tx - dz / l * off * s, pz = tz + dx / l * off * s;
        if (hf.trailAt(px, pz) > 0.02) continue;
        const h = hf.height(px, pz);
        const r2 = rnd();
        const v = r2 < 0.74 ? 0 : r2 < 0.94 ? 4 : 2;
        const hue = 0.88 + rnd() * 0.22;
        trees.push({
          x: px, z: pz, y: h - 0.25, s: 14.5 + rnd() * 9.0, rot: rnd() * 6.28, v,
          sx: 0.88 + rnd() * 0.28,
          tint: [hue * 0.90, hue * 1.04, hue * 0.92],
          bush: false,
          salt: 2,
          rank: placementRank(px, pz, v, 2),
        });
      }
    }
  }

  // Mid-story bushes
  for (let i = 0; i < 76000; i++) {
    const px = (rnd() - 0.5) * (S - 120), pz = (rnd() - 0.5) * (S - 120);
    const f = biome.sampleForest(px, pz);
    const dlk = Math.hypot((px - L.x) / L.rx, (pz - L.z) / L.rz);
    const lakeRing = dlk > 1.15 && dlk < 2.2 ? 0.07 * (0.4 + fbm(px * 0.015, pz * 0.015, 2)) : 0;
    const underWood = f > 0.55 ? 0.38 * fbm(px * 0.04, pz * 0.04, 2) : 0;
    const edge = (f > 0.05 && f < 0.55 ? 0.5 : 0.04 * fbm(px * 0.02, pz * 0.02, 2) + lakeRing) + underWood;
    if (rnd() > edge) continue;
    const h = hf.height(px, pz);
    if (h < wl + 1.2 || h > 1050) continue;
    if (hf.trailAt(px, pz) > 0.01) continue;
    hf.normal(px, pz, 2, n);
    if (n.y < 0.82) continue;
    const hue = 0.85 + rnd() * 0.3;
    trees.push({
      x: px, z: pz, y: h - 0.15, s: 1.4 + rnd() * 2.2, rot: rnd() * 6.28, v: 3,
      sx: 0.8 + rnd() * 0.5,
      tint: [hue * (0.9 + rnd() * 0.2), hue, hue * 0.9],
      bush: true,
      salt: 3,
      rank: placementRank(px, pz, 3, 3),
    });
  }

  return trees;
}

/** Generate full-density canonical rock placements with stable per-item ranks. */
export function generateRockPlacements(hf, trailPts, streamPts, biome, region) {
  const rnd = mulberry32(99);
  const S = region.size;
  const L = region.lake;
  const wl = region.waterLevel;
  const items = [];
  const n = { x: 0, y: 1, z: 0 };
  const add = (x, z, s, sink = 0.18, v = -1) => {
    const h = hf.height(x, z);
    if (h < wl - 3) return;
    hf.normal(x, z, 1.5, n);
    const kind = v < 0 ? Math.floor(rnd() * 3) : v;
    items.push({
      x, z, y: h - s * sink, s, v: kind, rot: rnd() * TWO_PI,
      tilt: [n.x, n.z],
      rank: placementRank(x, z, kind, 10),
    });
  };

  for (let i = 0; i < 28000 && items.length < 4600; i++) {
    const x = (rnd() - 0.5) * (S - 100), z = (rnd() - 0.5) * (S - 100);
    const h = hf.height(x, z);
    hf.normal(x, z, 3, n);
    const slope = 1 - n.y;
    if (hf.trailAt(x, z) > 0.1) continue;
    let p = 0;
    if (slope > 0.22 && slope < 0.65) p = 0.54;
    else if (slope <= 0.22 && (!biome || biome.sampleFlowers(x, z) < 0.22)) p = 0.014 * (0.5 + fbm(x * 0.01, z * 0.01, 2));
    if (h > 850) p *= 1.6;
    if (rnd() > p) continue;
    const crag = slope > 0.30 && rnd() < 0.06;
    const big = rnd() < 0.10;
    const sc = crag ? 4.5 + rnd() * 5.5 : big ? 2.0 + rnd() * 3.2 : 0.7 + rnd() * 1.1;
    add(x, z, sc, slope <= 0.22 ? 0.16 : 0.46, crag ? 3 : -1);
  }

  for (let i = 0; i < 950; i++) {
    const a = rnd() * TWO_PI, r = 0.90 + rnd() * 0.38;
    const x = L.x + Math.cos(a) * L.rx * r, z = L.z + Math.sin(a) * L.rz * r;
    const h = hf.height(x, z);
    if (Math.abs(h - wl) > 2.6) continue;
    const sc = 0.3 + rnd() * rnd() * 2.2;
    add(x, z, sc, 0.36);
    if (sc > 1.2 && rnd() < 0.5) {
      add(x + (rnd() - 0.5) * 3.5, z + (rnd() - 0.5) * 3.5, 0.4 + rnd() * 0.9, 0.32);
    }
  }

  if (trailPts) {
    for (let i = 0; i < trailPts.length; i += 3) {
      if (rnd() > 0.24) continue;
      const [px, pz] = trailPts[i];
      const j = Math.min(trailPts.length - 1, i + 1);
      const dx = trailPts[j][0] - px, dz = trailPts[j][1] - pz;
      const l = Math.hypot(dx, dz) || 1;
      const side = rnd() < 0.5 ? -1 : 1;
      const off = 2.0 + rnd() * 2.5;
      add(px - dz / l * off * side, pz + dx / l * off * side, 0.22 + rnd() * 0.65, 0.35);
    }
  }

  if (streamPts) {
    for (let i = 2; i < streamPts.length - 2; i += 2) {
      if (rnd() > 0.92) continue;
      const [px, pz] = streamPts[i];
      const [qx, qz] = streamPts[i + 1];
      const dx = qx - px, dz = qz - pz, l = Math.hypot(dx, dz) || 1;
      const side = rnd() < 0.5 ? -1 : 1;
      const off = 1.9 + rnd() * 1.9;
      add(px - dz / l * off * side, pz + dx / l * off * side, 0.45 + rnd() * 1.15, 0.32);
      if (rnd() < 0.22) add(px + (rnd() - 0.5) * 2.0, pz + (rnd() - 0.5) * 2.0, 0.35 + rnd() * 0.55, 0.35);
    }
  }

  const erratics = region.rockErratics || [];
  for (const [x, z, s] of erratics) add(x, z, s, 0.28, 3);
  return items;
}

/** Compute deterministic world anchors (cottage, benches, waterfall, POIs, summit) from terrain & paths. */
export function computeAnchors({ region, hf, trail, streamPlan }) {
  const pts = trail.points;
  const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const dirAt = (i) => {
    const a = at(i - 2), b = at(i + 2);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const nearestIdx = (x, z) => {
    let bi = 0, bd = 1e18;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  const mkBench = (x, z, ry) => {
    const y = Math.max(
      hf.height(x - 0.7 * Math.cos(ry), z + 0.7 * Math.sin(ry)),
      hf.height(x + 0.7 * Math.cos(ry), z - 0.7 * Math.sin(ry)),
    ) - 0.05;
    return { x, z, y: y + 0.46, ry };
  };

  // Cottage anchor
  const cotCfg = region.cottage || { trailIdx: 30, aheadOffset: 6, sideOffset: 19 };
  const [tx, tz] = at(cotCfg.trailIdx);
  const [ax, az] = at(cotCfg.trailIdx + cotCfg.aheadOffset);
  const cdx = ax - tx, cdz = az - tz, cdl = Math.hypot(cdx, cdz) || 1;
  const side = [-cdz / cdl, cdx / cdl];
  const cx = tx + side[0] * cotCfg.sideOffset;
  const cz = tz + side[1] * cotCfg.sideOffset;
  const cry = Math.atan2(-side[0], -side[1]);
  const house = { x: cx, z: cz, r: 8.5, front: [-side[0], -side[1]], ry: cry };

  // Benches & POIs
  const L = region.lake;
  const [sx, sz] = at(4);
  const shoreIdx = nearestIdx(trail.shore.x, trail.shore.z);
  const ridgeIdx = nearestIdx(trail.ridge.x, trail.ridge.z);
  const [lx, lz] = at(shoreIdx);
  const toLake = Math.atan2(L.x - lx, L.z - lz);
  const benchLake = mkBench(lx + Math.sin(toLake) * 4, lz + Math.cos(toLake) * 4, toLake);

  const [rx, rz] = at(ridgeIdx);
  const rd = dirAt(ridgeIdx);
  const look = Math.atan2(-(L.x - rx), -(L.z - rz)) + Math.PI;
  const benchSaddle = mkBench(rx - rd[1] * 3.5, rz + rd[0] * 3.5, look);

  const [ex, ez] = at(pts.length - 1);
  const toLakeS = Math.atan2(L.x - ex, L.z - ez);
  const benchSummit = mkBench(ex + Math.sin(toLakeS) * 9, ez + Math.cos(toLakeS) * 9, toLakeS);
  const benches = [benchLake, benchSaddle, benchSummit];

  const sumH = Math.round(hf.height(ex, ez));
  const summit = { x: ex, z: ez, h: sumH };

  const anchorCoords = {
    trailhead: [sx, sz],
    lake: [lx, lz],
    saddle: [rx, rz],
    summit: [ex, ez],
  };
  const pois = (region.pois || []).map((p) => {
    const [px, pz] = p.anchor ? anchorCoords[p.anchor] : [p.x, p.z];
    const sub = p.subTemplate ? p.subTemplate.replace('{h}', String(sumH)) : p.sub;
    return { name: p.name, sub, x: px, z: pz, r: p.r };
  });

  // Waterfall anchor (mirrors Waterfall cliff/pool geometry without building meshes)
  let falls = null;
  if (streamPlan && streamPlan.points && streamPlan.points.length >= 9) {
    const sp = streamPlan.points;
    let mi = 0, maxG = 0;
    for (let i = 4; i < sp.length - 4; i++) {
      const a = hf.height(sp[i - 3][0], sp[i - 3][1]), b = hf.height(sp[i + 3][0], sp[i + 3][1]);
      const g = (a - b) / 12;
      if (g > maxG) { maxG = g; mi = i; }
    }
    if (maxG >= 0.35) {
      let foot = mi;
      while (foot < sp.length - 4) {
        const a = hf.height(sp[foot][0], sp[foot][1]), b = hf.height(sp[foot + 3][0], sp[foot + 3][1]);
        if ((a - b) / 6 < 0.16) break;
        foot++;
      }
      let top = mi;
      while (top > 3) {
        const a = hf.height(sp[top - 3][0], sp[top - 3][1]), b = hf.height(sp[top][0], sp[top][1]);
        if ((a - b) / 6 < 0.25) break;
        top--;
      }
      const k = streamPlan.brink ?? top;
      const [bx, bz] = sp[k];
      const j = Math.min(sp.length - 1, k + 3);
      const ux0 = sp[j][0] - bx, uz0 = sp[j][1] - bz, ul = Math.hypot(ux0, uz0) || 1;
      const ux = ux0 / ul, uz = uz0 / ul, flx = -uz, flz = ux;
      const profH = (d, lat = 0) => hf.height(bx + ux * d + flx * lat, bz + uz * d + flz * lat);
      let yCrest = -1e9;
      for (let d = -16; d <= -2; d++) yCrest = Math.max(yCrest, profH(d, 0));
      let dLip = -10;
      for (let d = -14; d <= 6; d += 0.5) if (profH(d, 0) >= yCrest - 2.6) dLip = d;
      const yBaseEst = profH(18, 0);
      let dToe = dLip + 6;
      for (let d = dLip + 2; d <= 20; d += 0.5) {
        if (profH(d, 0) <= yBaseEst + 2.8) { dToe = d; break; }
      }
      const yTop = yCrest - 0.85;
      const fi = Math.min(sp.length - 1, foot + 3);
      const poolDist = Math.max(20.0, dToe + 15.5);
      const poolCenter = { x: bx + ux * poolDist, z: bz + uz * poolDist };
      const poolY = Math.max(
        hf.height(poolCenter.x, poolCenter.z) + 2.35,
        hf.height(bx + ux * (poolDist + 16), bz + uz * (poolDist + 16)) + 0.52,
      );
      falls = {
        foot: { x: poolCenter.x, z: poolCenter.z, y: poolY },
        top: { x: bx + ux * dLip, z: bz + uz * dLip, y: yTop },
        footIdx: fi,
      };
    }
  }

  return { house, benches, falls, pois, summit };
}

function filterTreesByCircles(trees, circles) {
  if (!circles.length) return trees;
  return trees.filter((t) => {
    const pad = t.bush ? 0 : t.s * 0.2;
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (Math.hypot(t.x - c.x, t.z - c.z) < c.r + pad) return false;
    }
    return true;
  });
}

function filterRocksByCircles(rocks, circles) {
  if (!circles.length) return rocks;
  return rocks.filter((it) => {
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (Math.hypot(it.x - c.x, it.z - c.z) < c.r) return false;
    }
    return true;
  });
}

/**
 * Apply ordered data-driven scenery edits to canonical placements before draw buffers are built.
 * Supports plain { target, x, z, r } rows and named rule rows.
 */
export function applySceneryEdits(placements, edits, context = {}) {
  let trees = (placements.trees || []).slice();
  let rocks = (placements.rocks || []).slice();
  const heroOaks = (placements.heroOaks || []).slice();
  const { trail, streamPlan, biome, anchors = {} } = context;
  const { house, benches = [], falls } = anchors;
  let forestIdx = context.forestIdx ?? 0;

  const applyCircles = (target, circles) => {
    if (!circles.length) return;
    if (target === 'trees') trees = filterTreesByCircles(trees, circles);
    else if (target === 'rocks') rocks = filterRocksByCircles(rocks, circles);
  };

  for (const row of edits || []) {
    if (!row) continue;

    // Plain explicit circle edit: { target, x, z, r }
    if (!row.rule) {
      applyCircles(row.target, [{ x: row.x, z: row.z, r: row.r }]);
      continue;
    }

    switch (row.rule) {
      case 'cottageClear': {
        if (house) applyCircles(row.target, [{ x: house.x, z: house.z, r: row.r }]);
        break;
      }
      case 'trailStartClear': {
        if (!trail) break;
        const circles = [];
        const lim = Math.min(row.count, trail.points.length);
        for (let i = 0; i < lim; i += row.step) {
          circles.push({ x: trail.points[i][0], z: trail.points[i][1], r: i < row.nearCount ? row.nearR : row.farR });
        }
        applyCircles(row.target, circles);
        break;
      }
      case 'trailSightline': {
        if (!trail) break;
        const dTarget = row.trailFrac * trail.dist[trail.dist.length - 1];
        const idx = Math.max(0, trail.dist.findIndex((x) => x >= dTarget));
        const p = trail.points[idx];
        const q = trail.points[Math.min(trail.points.length - 1, idx + 8)];
        const yaw = Math.atan2(-(q[0] - p[0]), -(q[1] - p[1])) + (row.yawOffset || 0);
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const circles = [];
        for (let dd = row.dMin; dd <= row.dMax; dd += row.dStep) {
          const r = row.r != null ? row.r : row.rBase + dd * (row.rSlope || 0);
          circles.push({ x: p[0] + fx * dd, z: p[1] + fz * dd, r });
        }
        applyCircles(row.target, circles);
        break;
      }
      case 'rayClear': {
        const circles = [];
        for (let d = row.dMin; d <= row.dMax; d += row.dStep) {
          circles.push({ x: row.x + row.dx * d, z: row.z + row.dz * d, r: row.r });
        }
        applyCircles(row.target, circles);
        break;
      }
      case 'cottageSightline': {
        if (!house) break;
        const hx = house.x, hz = house.z;
        const [fxC, fzC] = house.front;
        const camA = Math.atan2(fxC, fzC) + row.camAngleOffset;
        const camX = hx + Math.sin(camA) * row.camDist;
        const camZ = hz + Math.cos(camA) * row.camDist;
        const circles = [];
        for (let f = row.fMin; f <= row.fMax; f += row.fStep) {
          const lxC = hx + fxC * f * 0.65 + Math.sin(camA) * f * 0.35;
          const lzC = hz + fzC * f * 0.65 + Math.cos(camA) * f * 0.35;
          for (let sd = row.sdMin; sd <= row.sdMax; sd += row.sdStep) {
            circles.push({ x: lxC + row.dirX * sd, z: lzC + row.dirZ * sd, r: row.r });
          }
        }
        circles.push({ x: camX, z: camZ, r: row.camR });
        applyCircles(row.target, circles);
        break;
      }
      case 'benchOffsetClear': {
        const sb = benches[row.benchIndex];
        if (!sb) break;
        const sfx = Math.sin(sb.ry), sfz = Math.cos(sb.ry);
        const slx = sfz, slz = -sfx;
        const circles = row.offsets.map(([lat, fwd, r]) => ({
          x: sb.x + slx * lat + sfx * fwd,
          z: sb.z + slz * lat + sfz * fwd,
          r,
        }));
        applyCircles(row.target, circles);
        break;
      }
      case 'signpostSightline': {
        if (!trail || trail.points.length < 9) break;
        const p0 = trail.points[0], p4 = trail.points[4], p8 = trail.points[8];
        const tx = p8[0] - p0[0], tz = p8[1] - p0[1], tl = Math.hypot(tx, tz) || 1;
        const fx = tx / tl, fz = tz / tl, rx = -fz, rz = fx;
        const spx = p4[0] + rx * 1.85, spz = p4[1] + rz * 1.85;
        const circles = [];
        for (let dd = row.dMin; dd <= row.dMax; dd += row.dStep) {
          circles.push({ x: spx + fx * dd, z: spz + fz * dd, r: row.r });
        }
        applyCircles(row.target, circles);
        break;
      }
      case 'forestCathedral': {
        if (!trail || !biome) break;
        let bfF = -1;
        const pts = trail.points;
        for (let i = 0; i < pts.length; i++) {
          if (i < row.minTrailIdx || i > pts.length - row.endMargin) continue;
          const p = pts[i];
          const f = biome.sampleForest(p[0], p[1]) + biome.sampleForest(p[0] + 15, p[1]) + biome.sampleForest(p[0] - 15, p[1]);
          if (f < row.minForest) continue;
          let near = 1e9;
          for (let ti = 0; ti < trees.length; ti++) {
            const tr = trees[ti];
            if (tr.bush) continue;
            const distT = Math.hypot(tr.x - p[0], tr.z - p[1]);
            if (distT < near) near = distT;
          }
          const scF = f + Math.min(near, 7) * 0.4;
          if (scF > bfF) { bfF = scF; forestIdx = i; }
        }
        const treeCircles = [];
        for (let k = Math.max(0, forestIdx - row.corridorBack); k < Math.min(pts.length, forestIdx + row.corridorAhead); k += row.corridorStep) {
          treeCircles.push({ x: pts[k][0], z: pts[k][1], r: row.corridorR });
        }
        const pF = pts[forestIdx], qF = pts[Math.min(pts.length - 1, forestIdx + 10)];
        const fdx = qF[0] - pF[0], fdz = qF[1] - pF[1], fl = Math.hypot(fdx, fdz) || 1;
        const fux = fdx / fl, fuz = fdz / fl;
        const lxF = fuz, lzF = -fux;
        const rockCircles = [];
        for (let dd = row.rockDMin; dd <= row.rockDMax; dd += row.rockDStep) {
          rockCircles.push({ x: pF[0] + fux * dd, z: pF[1] + fuz * dd, r: row.rockR });
        }
        for (const [fwd, lat, r] of row.sideClears) {
          treeCircles.push({ x: pF[0] + fux * fwd + lxF * lat, z: pF[1] + fuz * fwd + lzF * lat, r });
        }
        for (let k = Math.min(pts.length - 1, forestIdx + row.wideStart); k < Math.min(pts.length, forestIdx + row.wideEnd); k += row.wideStep) {
          treeCircles.push({ x: pts[k][0], z: pts[k][1], r: row.wideR });
        }
        applyCircles('trees', treeCircles);
        applyCircles('rocks', rockCircles);
        for (const ho of row.heroOaks || []) {
          heroOaks.push([
            pF[0] + fux * ho.fwd + lxF * ho.lat,
            pF[1] + fuz * ho.fwd + lzF * ho.lat,
            ho.s,
            ho.rot,
            ho.tint.slice(),
          ]);
        }
        break;
      }
      case 'benchSightlines': {
        const circles = [];
        for (const b of benches) {
          const fx = Math.sin(b.ry), fz = Math.cos(b.ry);
          for (let d = row.dMin; d <= row.dMax; d += row.dStep) {
            circles.push({ x: b.x + fx * d, z: b.z + fz * d, r: row.rBase + d * (row.rSlope || 0) });
          }
        }
        applyCircles(row.target, circles);
        break;
      }
      case 'waterfallClear': {
        if (!falls || !falls.foot) break;
        const circles = [];
        if (row.target === 'trees') {
          circles.push({ x: falls.foot.x, z: falls.foot.z, r: 20 });
          if (streamPlan) {
            const sp = streamPlan.points;
            for (let k = falls.footIdx; k < Math.min(sp.length, falls.footIdx + 28); k++) {
              circles.push({ x: sp[k][0], z: sp[k][1], r: 7.5 + (k - falls.footIdx) * 0.14 });
            }
            const kc = Math.min(sp.length - 2, falls.footIdx + 18);
            const [px, pz] = sp[kc], [qx, qz] = sp[kc + 1];
            const tl = Math.hypot(qx - px, qz - pz) || 1;
            const cx = px - (qz - pz) / tl * 5, cz = pz + (qx - px) / tl * 5;
            const tgx = falls.foot.x * 0.6 + falls.top.x * 0.4;
            const tgz = falls.foot.z * 0.6 + falls.top.z * 0.4;
            for (let f = 0.1; f <= 1.0; f += 0.06) {
              circles.push({ x: cx + (tgx - cx) * f, z: cz + (tgz - cz) * f, r: 4.8 + f * 7.2 });
            }
            const rxF = -(qz - pz) / tl, rzF = (qx - px) / tl;
            circles.push({ x: px - rxF * 10, z: pz - rzF * 10, r: 12 });
            circles.push({ x: falls.top.x, z: falls.top.z, r: 15 });
          }
        } else if (row.target === 'rocks') {
          circles.push({ x: falls.foot.x, z: falls.foot.z, r: 19 });
          if (streamPlan) {
            const sp = streamPlan.points;
            for (let k = falls.footIdx; k < Math.min(sp.length, falls.footIdx + 28); k++) {
              circles.push({ x: sp[k][0], z: sp[k][1], r: 6.5 });
            }
          }
        }
        applyCircles(row.target, circles);
        break;
      }
      default:
        throw new Error(`Unknown scenery edit rule: ${row.rule}`);
    }
  }

  return { trees, rocks, heroOaks, forestIdx };
}

/** Stable 64-bit FNV hash over region id, heightmaps, mask, and canonical placements. */
export function computeWorldHash({ region, heights, farHeights, mask, placements }) {
  const st = fnvCreate();
  fnvMixString(st, region.id);
  fnvMixU32(st, heights.length);
  for (let i = 0; i < heights.length; i++) fnvMixF32(st, heights[i]);
  if (farHeights) {
    fnvMixU32(st, farHeights.length);
    for (let i = 0; i < farHeights.length; i++) fnvMixF32(st, farHeights[i]);
  }
  fnvMixU32(st, mask.length);
  for (let i = 0; i < mask.length; i++) fnvMixF32(st, mask[i]);

  const trees = placements.trees || [];
  fnvMixU32(st, trees.length);
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    fnvMixF32(st, t.x);
    fnvMixF32(st, t.y);
    fnvMixF32(st, t.z);
    fnvMixF32(st, t.s);
    fnvMixF32(st, t.rot);
    fnvMixF32(st, t.sx);
    fnvMixU32(st, t.v);
    fnvMixF32(st, t.rank);
  }

  const rocks = placements.rocks || [];
  fnvMixU32(st, rocks.length);
  for (let i = 0; i < rocks.length; i++) {
    const r = rocks[i];
    fnvMixF32(st, r.x);
    fnvMixF32(st, r.y);
    fnvMixF32(st, r.z);
    fnvMixF32(st, r.s);
    fnvMixF32(st, r.rot);
    fnvMixU32(st, r.v);
    fnvMixF32(st, r.rank);
  }

  const heroOaks = placements.heroOaks || [];
  fnvMixU32(st, heroOaks.length);
  for (let i = 0; i < heroOaks.length; i++) {
    const h = heroOaks[i];
    fnvMixF32(st, h[0]);
    fnvMixF32(st, h[1]);
    fnvMixF32(st, h[2]);
    fnvMixF32(st, h[3]);
  }

  return fnvFinish(st);
}

/** Wrap CPU biome arrays into the queryable biome object expected by world systems. */
export function createBiomeData(data, forest, res, size) {
  return {
    data,
    forest,
    res,
    size,
    tex: null,
    sampleForest(x, z) {
      const fx = Math.min(res - 1, Math.max(0, Math.floor((x / size + 0.5) * res)));
      const fz = Math.min(res - 1, Math.max(0, Math.floor((z / size + 0.5) * res)));
      return forest[fz * res + fx];
    },
    sampleFlowers(x, z) {
      const fx = Math.min(res - 1, Math.max(0, Math.floor((x / size + 0.5) * res)));
      const fz = Math.min(res - 1, Math.max(0, Math.floor((z / size + 0.5) * res)));
      return data[(fz * res + fx) * 4 + 1] / 255;
    },
    sampleMeadow(x, z) {
      const fx = Math.min(res - 1, Math.max(0, Math.floor((x / size + 0.5) * res)));
      const fz = Math.min(res - 1, Math.max(0, Math.floor((z / size + 0.5) * res)));
      return data[(fz * res + fx) * 4 + 2] / 255;
    },
    dispose() {
      if (this.tex) {
        this.tex.dispose();
        this.tex = null;
      }
    },
  };
}

function buildSpatialGrid(items, cell) {
  const grid = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const k = Math.floor(it.x / cell) + ',' + Math.floor(it.z / cell);
    let bucket = grid.get(k);
    if (!bucket) {
      bucket = [];
      grid.set(k, bucket);
    }
    bucket.push(it);
  }
  return grid;
}

/** Canonical world data container shared by gameplay queries and draw systems. */
export class WorldData {
  constructor({
    region,
    heights,
    mask,
    farHeights,
    trail,
    streamPlan,
    biome,
    placements,
    anchors,
    forestIdx = 0,
    source = 'baked',
    hash = null,
  }) {
    this.region = region;
    this.heights = heights;
    this.mask = mask;
    this.farHeights = farHeights;
    this.trail = trail;
    this.streamPlan = streamPlan || null;
    this.biome = biome;
    this.placements = {
      trees: placements.trees || [],
      heroOaks: placements.heroOaks || [],
      rocks: placements.rocks || [],
      props: {
        benches: anchors?.benches || [],
        pois: anchors?.pois || [],
        summit: anchors?.summit || null,
        house: anchors?.house || null,
      },
    };
    this.anchors = anchors || { benches: [], pois: [], summit: null, house: null, falls: null };
    this.pois = this.anchors.pois || [];
    this.forestIdx = forestIdx;
    this.source = source;

    this.hf = new HeightField(heights, mask, region.res, region.size);
    this.hf.trailPoints = trail?.points || null;

    this._cell = GRID_CELL;
    this._treeGrid = buildSpatialGrid(this.placements.trees, this._cell);
    this._rockGrid = buildSpatialGrid(this.placements.rocks, this._cell);
    this._rockColliders = this.placements.rocks
      .filter((it) => it.s > 0.9)
      .map((it) => ({ x: it.x, z: it.z, r: it.s * 0.85, top: it.y + it.s * 0.6 }));

    this.hash = hash || computeWorldHash({
      region: this.region,
      heights: this.heights,
      farHeights: this.farHeights,
      mask: this.mask,
      placements: this.placements,
    });
    this._disposables = [];
  }

  height(x, z) {
    return this.hf.height(x, z);
  }

  normal(x, z, e = 1.0, out = { x: 0, y: 1, z: 0 }) {
    return this.hf.normal(x, z, e, out);
  }

  trailAt(x, z) {
    return this.hf.trailAt(x, z);
  }

  isPath(x, z) {
    return this.hf.isPath(x, z);
  }

  biomeAt(x, z) {
    const forest = this.biome.sampleForest(x, z);
    const flowers = this.biome.sampleFlowers(x, z);
    const meadow = this.biome.sampleMeadow ? this.biome.sampleMeadow(x, z) : 0;
    return { forest, flowers, meadow };
  }

  nearestPath(x, z) {
    const pts = this.trail?.points;
    if (!pts || !pts.length) return null;
    let bestIdx = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - x;
      const dz = pts[i][1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    const point = pts[bestIdx];
    return {
      x: point[0],
      z: point[1],
      dist: Math.sqrt(bestD2),
      index: bestIdx,
      along: this.trail.dist ? this.trail.dist[bestIdx] : 0,
      point,
    };
  }

  nearestStream(x, z) {
    const pts = this.streamPlan?.points;
    if (!pts || !pts.length) return null;
    let bestIdx = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - x;
      const dz = pts[i][1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    const point = pts[bestIdx];
    return {
      x: point[0],
      z: point[1],
      dist: Math.sqrt(bestD2),
      index: bestIdx,
      point,
    };
  }

  /**
   * Query canonical placements within `radius` meters of (x, z).
   * `kind`: 'trees' | 'rocks' | 'props' | 'all'.
   */
  placementsInRadius(x, z, radius, kind = 'all', opts = {}) {
    const r2 = radius * radius;
    const includeBushes = opts.includeBushes !== false;
    const maxRank = opts.maxRank ?? 1.0;
    const out = [];

    const scanGrid = (grid, tag, checkBush) => {
      const c = this._cell;
      const minX = Math.floor((x - radius) / c);
      const maxX = Math.floor((x + radius) / c);
      const minZ = Math.floor((z - radius) / c);
      const maxZ = Math.floor((z + radius) / c);
      for (let cz = minZ; cz <= maxZ; cz++) {
        for (let cx = minX; cx <= maxX; cx++) {
          const list = grid.get(cx + ',' + cz);
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const it = list[i];
            if (checkBush && !includeBushes && it.bush) continue;
            if (maxRank < 1 && it.rank >= maxRank) continue;
            const dx = it.x - x, dz = it.z - z;
            if (dx * dx + dz * dz <= r2) {
              out.push(kind === 'all' ? { kind: tag, ...it } : it);
            }
          }
        }
      }
    };

    if (kind === 'trees' || kind === 'all') scanGrid(this._treeGrid, 'tree', true);
    if (kind === 'rocks' || kind === 'all') scanGrid(this._rockGrid, 'rock', false);
    if (kind === 'props' || kind === 'all') {
      const benches = this.placements.props.benches || [];
      for (let i = 0; i < benches.length; i++) {
        const b = benches[i];
        const dx = b.x - x, dz = b.z - z;
        if (dx * dx + dz * dz <= r2) {
          out.push(kind === 'all' ? { kind: 'bench', ...b } : { kind: 'bench', ...b });
        }
      }
      const house = this.placements.props.house;
      if (house) {
        const dx = house.x - x, dz = house.z - z;
        if (dx * dx + dz * dz <= r2) {
          out.push(kind === 'all' ? { kind: 'house', ...house } : { kind: 'house', ...house });
        }
      }
    }
    return out;
  }

  /** Resolve player collision against the full canonical tree list (tier-independent). */
  collideTrees(pos, radius = 0.4) {
    const cx = Math.floor(pos.x / this._cell), cz = Math.floor(pos.z / this._cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this._treeGrid.get((cx + dx) + ',' + (cz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          if (t.bush) continue;
          const tr = t.s * 0.03 + radius;
          const ex = pos.x - t.x, ez = pos.z - t.z;
          const d = Math.hypot(ex, ez);
          if (d < tr && d > 1e-4) {
            pos.x = t.x + ex / d * tr;
            pos.z = t.z + ez / d * tr;
          }
        }
      }
    }
  }

  /** Resolve player collision against the full canonical rock list (tier-independent). */
  collideRocks(pos, ground, radius = 0.35) {
    const colliders = this._rockColliders;
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = pos.x - c.x, dz = pos.z - c.z;
      if (Math.abs(dx) > c.r + 1 || Math.abs(dz) > c.r + 1) continue;
      const d = Math.hypot(dx, dz), rr = c.r + radius;
      if (d < rr && c.top > ground + 0.6 && d > 1e-4) {
        pos.x = c.x + dx / d * rr;
        pos.z = c.z + dz / d * rr;
      }
    }
  }

  trackDisposable(obj) {
    if (obj && typeof obj.dispose === 'function') this._disposables.push(obj);
  }

  dispose() {
    for (let i = this._disposables.length - 1; i >= 0; i--) {
      this._disposables[i].dispose();
    }
    this._disposables.length = 0;
    this.biome?.dispose?.();
  }
}

// ---------------- Binary Encoding / Decoding ----------------

export function encodeGridU16Delta2D(arr, res) {
  const N = res * res;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1e-6, max - min);
  const invSpan = 65535 / span;
  const q = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    q[i] = clamp(Math.round((arr[i] - min) * invSpan), 0, 65535);
  }
  const out = new Uint8Array(N * 2);
  for (let y = 0; y < res; y++) {
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const i = row + x;
      let pred;
      if (y === 0) pred = x === 0 ? 0 : q[i - 1];
      else if (x === 0) pred = q[i - res];
      else pred = clamp(q[i - 1] + q[i - res] - q[i - res - 1], 0, 65535);
      let d = (q[i] - pred) & 0xffff;
      if (d >= 32768) d -= 65536;
      const zz = ((d << 1) ^ (d >> 31)) & 0xffff;
      out[i] = zz >>> 8;
      out[N + i] = zz & 0xff;
    }
  }
  return { bytes: out, min, max };
}

export function decodeGridU16Delta2D(bytes, res, min, max) {
  const N = res * res;
  const span = Math.max(1e-6, max - min);
  const scale = span / 65535;
  const q = new Uint16Array(N);
  const out = new Float32Array(N);
  for (let y = 0; y < res; y++) {
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const i = row + x;
      let pred;
      if (y === 0) pred = x === 0 ? 0 : q[i - 1];
      else if (x === 0) pred = q[i - res];
      else pred = clamp(q[i - 1] + q[i - res] - q[i - res - 1], 0, 65535);
      const zz = (bytes[i] << 8) | bytes[N + i];
      const d = (zz >>> 1) ^ -(zz & 1);
      const val = (pred + d) & 0xffff;
      q[i] = val;
      out[i] = min + val * scale;
    }
  }
  return out;
}

export function encodeGridQuantDelta2D(arr, res, bits = 22) {
  const N = res * res;
  const maxQ = (1 << bits) - 1;
  const bytesPerSample = bits <= 15 ? 2 : 3;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1e-6, max - min);
  const invSpan = maxQ / span;
  const q = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    q[i] = clamp(Math.round((arr[i] - min) * invSpan), 0, maxQ);
  }
  const out = new Uint8Array(N * bytesPerSample);
  const N2 = N * 2;
  for (let y = 0; y < res; y++) {
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const i = row + x;
      let pred;
      if (y === 0) pred = x === 0 ? 0 : q[i - 1];
      else if (x === 0) pred = q[i - res];
      else pred = clamp(q[i - 1] + q[i - res] - q[i - res - 1], 0, maxQ);
      const d = q[i] - pred;
      const zz = ((d << 1) ^ (d >> 31)) >>> 0;
      if (bytesPerSample === 2) {
        out[i] = (zz >>> 8) & 0xff;
        out[N + i] = zz & 0xff;
      } else {
        out[i] = (zz >>> 16) & 0xff;
        out[N + i] = (zz >>> 8) & 0xff;
        out[N2 + i] = zz & 0xff;
      }
    }
  }
  return { bytes: out, min, max };
}

export function decodeGridQuantDelta2D(bytes, res, min, max, bits = 22) {
  const N = res * res;
  const N2 = N * 2;
  const bytesPerSample = bits <= 15 ? 2 : 3;
  const maxQ = (1 << bits) - 1;
  const span = Math.max(1e-6, max - min);
  const scale = span / maxQ;
  const q = new Uint32Array(N);
  const out = new Float32Array(N);
  for (let y = 0; y < res; y++) {
    const row = y * res;
    for (let x = 0; x < res; x++) {
      const i = row + x;
      let pred;
      if (y === 0) pred = x === 0 ? 0 : q[i - 1];
      else if (x === 0) pred = q[i - res];
      else pred = clamp(q[i - 1] + q[i - res] - q[i - res - 1], 0, maxQ);
      const zz = bytesPerSample === 2
        ? (bytes[i] << 8) | bytes[N + i]
        : (bytes[i] << 16) | (bytes[N + i] << 8) | bytes[N2 + i];
      const d = (zz >>> 1) ^ -(zz & 1);
      const val = clamp(pred + d, 0, maxQ);
      q[i] = val;
      out[i] = min + val * scale;
    }
  }
  return out;
}

export function encodeGridU24Delta2D(arr, res) {
  return encodeGridQuantDelta2D(arr, res, 24);
}

export function decodeGridU24Delta2D(bytes, res, min, max) {
  return decodeGridQuantDelta2D(bytes, res, min, max, 24);
}

export function encodeGridF32(arr) {
  const copy = new Float32Array(arr);
  return { bytes: new Uint8Array(copy.buffer), min: 0, max: 0 };
}

export function decodeGridF32(bytes) {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

export function encodeMaskSparseI16(arr, res) {
  const N = res * res;
  let nz = 0;
  for (let i = 0; i < N; i++) if (arr[i] !== 0) nz++;
  const buf = new ArrayBuffer(4 + nz * 6);
  const dv = new DataView(buf);
  dv.setUint32(0, nz, true);
  let off = 4;
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const v = arr[i];
    if (v !== 0) {
      dv.setUint32(off, i - prev, true); off += 4;
      dv.setInt16(off, clamp(Math.round(v * 32767), -32767, 32767), true); off += 2;
      prev = i;
    }
  }
  return new Uint8Array(buf);
}

export function decodeMaskSparseI16(bytes, res) {
  const N = res * res;
  const out = new Float32Array(N);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nz = dv.getUint32(0, true);
  let off = 4;
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    idx += dv.getUint32(off, true); off += 4;
    const q = dv.getInt16(off, true); off += 2;
    out[idx] = q / 32767;
  }
  return out;
}

export function encodeMaskI16Delta(arr, res) {
  return encodeMaskSparseI16(arr, res);
}

export function decodeMaskI16Delta(bytes, res) {
  return decodeMaskSparseI16(bytes, res);
}

export function encodeBiomeData(biome, res) {
  const N = res * res;
  const rgba = biome.data || biome.tex?.image?.data;
  const forest = biome.forest;
  // Lossless 2D-delta planar RGB (3 * N) + delta2d u16 forest (2 * N)
  const out = new Uint8Array(N * 5);
  for (let ch = 0; ch < 3; ch++) {
    const base = ch * N;
    for (let y = 0; y < res; y++) {
      const row = y * res;
      for (let x = 0; x < res; x++) {
        const i = row + x;
        const v = rgba[i * 4 + ch];
        let pred;
        if (y === 0) pred = x === 0 ? 0 : rgba[(i - 1) * 4 + ch];
        else if (x === 0) pred = rgba[(i - res) * 4 + ch];
        else pred = clamp(rgba[(i - 1) * 4 + ch] + rgba[(i - res) * 4 + ch] - rgba[(i - res - 1) * 4 + ch], 0, 255);
        out[base + i] = (v - pred) & 0xff;
      }
    }
  }
  const { bytes: fBytes } = encodeGridU16Delta2D(forest, res);
  out.set(fBytes, N * 3);
  return out;
}

export function decodeBiomeData(bytes, res, size, forestMin = 0, forestMax = 1) {
  const N = res * res;
  const rgba = new Uint8Array(N * 4);
  for (let ch = 0; ch < 3; ch++) {
    const base = ch * N;
    for (let y = 0; y < res; y++) {
      const row = y * res;
      for (let x = 0; x < res; x++) {
        const i = row + x;
        let pred;
        if (y === 0) pred = x === 0 ? 0 : rgba[(i - 1) * 4 + ch];
        else if (x === 0) pred = rgba[(i - res) * 4 + ch];
        else pred = clamp(rgba[(i - 1) * 4 + ch] + rgba[(i - res) * 4 + ch] - rgba[(i - res - 1) * 4 + ch], 0, 255);
        rgba[i * 4 + ch] = (pred + bytes[base + i]) & 0xff;
      }
    }
  }
  for (let i = 0; i < N; i++) rgba[i * 4 + 3] = 255;
  const forest = decodeGridU16Delta2D(bytes.subarray(N * 3, N * 5), res, forestMin, forestMax);
  return createBiomeData(rgba, forest, res, size);
}

export function encodePaths(trail, streamPlan) {
  const tn = trail.points.length;
  const sn = streamPlan ? streamPlan.points.length : 0;
  const headerBytes = 32; // magic, ver, tn, sn, brink, shore.x, shore.z, ridge.x (plus ridge.z -> 36 bytes)
  const totalBytes = 36 + tn * 16 + sn * 12;
  const buf = new ArrayBuffer(totalBytes);
  const dv = new DataView(buf);
  let off = 0;
  dv.setUint32(off, PATHS_MAGIC, true); off += 4;
  dv.setUint32(off, 1, true); off += 4;
  dv.setUint32(off, tn, true); off += 4;
  dv.setUint32(off, sn, true); off += 4;
  dv.setInt32(off, streamPlan?.brink ?? -1, true); off += 4;
  dv.setFloat32(off, trail.shore.x, true); off += 4;
  dv.setFloat32(off, trail.shore.z, true); off += 4;
  dv.setFloat32(off, trail.ridge.x, true); off += 4;
  dv.setFloat32(off, trail.ridge.z, true); off += 4;
  void headerBytes;

  for (let i = 0; i < tn; i++) {
    dv.setFloat32(off, trail.points[i][0], true); off += 4;
    dv.setFloat32(off, trail.points[i][1], true); off += 4;
  }
  for (let i = 0; i < tn; i++) { dv.setFloat32(off, trail.heights[i], true); off += 4; }
  for (let i = 0; i < tn; i++) { dv.setFloat32(off, trail.dist[i], true); off += 4; }
  for (let i = 0; i < sn; i++) {
    dv.setFloat32(off, streamPlan.points[i][0], true); off += 4;
    dv.setFloat32(off, streamPlan.points[i][1], true); off += 4;
  }
  for (let i = 0; i < sn; i++) { dv.setFloat32(off, streamPlan.heights[i], true); off += 4; }
  return new Uint8Array(buf);
}

export function decodePaths(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const magic = dv.getUint32(off, true); off += 4;
  if (magic !== PATHS_MAGIC) throw new Error('Invalid baked paths magic');
  const ver = dv.getUint32(off, true); off += 4;
  if (ver !== 1) throw new Error(`Unsupported paths version ${ver}`);
  const tn = dv.getUint32(off, true); off += 4;
  const sn = dv.getUint32(off, true); off += 4;
  const brink = dv.getInt32(off, true); off += 4;
  const shore = { x: dv.getFloat32(off, true), z: dv.getFloat32(off + 4, true) }; off += 8;
  const ridge = { x: dv.getFloat32(off, true), z: dv.getFloat32(off + 4, true) }; off += 8;

  const tPoints = new Array(tn);
  for (let i = 0; i < tn; i++) {
    tPoints[i] = [dv.getFloat32(off, true), dv.getFloat32(off + 4, true)];
    off += 8;
  }
  const tHeights = new Array(tn);
  for (let i = 0; i < tn; i++) { tHeights[i] = dv.getFloat32(off, true); off += 4; }
  const tDist = new Array(tn);
  for (let i = 0; i < tn; i++) { tDist[i] = dv.getFloat32(off, true); off += 4; }

  let streamPlan = null;
  if (sn > 0) {
    const sPoints = new Array(sn);
    for (let i = 0; i < sn; i++) {
      sPoints[i] = [dv.getFloat32(off, true), dv.getFloat32(off + 4, true)];
      off += 8;
    }
    const sHeights = new Array(sn);
    for (let i = 0; i < sn; i++) { sHeights[i] = dv.getFloat32(off, true); off += 4; }
    streamPlan = { points: sPoints, heights: sHeights, brink: brink >= 0 ? brink : undefined };
  }
  return {
    trail: { points: tPoints, heights: tHeights, dist: tDist, shore, ridge },
    streamPlan,
  };
}

const FLAG_EXPLICIT_RANKS = 1;

export function encodePlacements(placements, anchors, forestIdx = 0, worldSize = 4096) {
  const trees = placements.trees || [];
  const heroOaks = placements.heroOaks || [];
  const rocks = placements.rocks || [];
  const tn = trees.length;
  const hn = heroOaks.length;
  const rn = rocks.length;
  const anchorBytes = new TextEncoder().encode(JSON.stringify(anchors || {}));

  // If every tree carries a canonical generation salt (1..3), recompute rank on decode;
  // otherwise store explicit u16 ranks (e.g., synthetic test worlds).
  const useDerivedRanks = tn > 0 && trees.every((t) => t.salt >= 1 && t.salt <= 3);
  const flags = useDerivedRanks ? 0 : FLAG_EXPLICIT_RANKS;

  // Compact v2 layout:
  // Header: 9 * u32 = 36 bytes (magic, ver=2, flags, worldSizeF32, tn, hn, rn, forestIdx, anchorLen)
  // Trees: delta23 planar x (3*tn) + z (3*tn) + u16 s/rot/sx (6*tn) + u14 tint r/g in u16 (4*tn) + u8 tint b (1*tn)
  //        + optional u16 rank (2*tn) + u8 (v | (salt<<4)) (1*tn)
  //        y is derived from hf.height(x, z) - (bush ? 0.15 : 0.25) on decode.
  const treeRankBytes = useDerivedRanks ? 0 : tn * 2;
  const total = 36 + tn * 18 + treeRankBytes + hn * 28 + rn * 31 + anchorBytes.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let off = 0;
  dv.setUint32(off, PLACEMENTS_MAGIC, true); off += 4;
  dv.setUint32(off, 2, true); off += 4;
  dv.setUint32(off, flags, true); off += 4;
  dv.setFloat32(off, worldSize, true); off += 4;
  dv.setUint32(off, tn, true); off += 4;
  dv.setUint32(off, hn, true); off += 4;
  dv.setUint32(off, rn, true); off += 4;
  dv.setInt32(off, forestIdx, true); off += 4;
  dv.setUint32(off, anchorBytes.length, true); off += 4;

  // Trees planar 23-bit quantized delta-coded x & z (0.49 mm step over 4096 m;
  // 23-bit domain guarantees zigzag delta fits in 24 bits with no wraparound)
  const xBase = off; off += tn * 3;
  const zBase = off; off += tn * 3;
  let px = 0, pz = 0;
  const half = worldSize * 0.5;
  const POS_QMAX = 8388607;
  const invS = POS_QMAX / worldSize;
  for (let i = 0; i < tn; i++) {
    const qx = clamp(Math.round((trees[i].x + half) * invS), 0, POS_QMAX);
    const qz = clamp(Math.round((trees[i].z + half) * invS), 0, POS_QMAX);
    const dx = qx - px, dz = qz - pz;
    const zx = ((dx << 1) ^ (dx >> 31)) >>> 0;
    const zz = ((dz << 1) ^ (dz >> 31)) >>> 0;
    u8[xBase + i] = (zx >>> 16) & 0xff;
    u8[xBase + tn + i] = (zx >>> 8) & 0xff;
    u8[xBase + tn * 2 + i] = zx & 0xff;
    u8[zBase + i] = (zz >>> 16) & 0xff;
    u8[zBase + tn + i] = (zz >>> 8) & 0xff;
    u8[zBase + tn * 2 + i] = zz & 0xff;
    px = qx; pz = qz;
  }

  // Trees: u16 for geometry-sensitive scale/rotation/stretch, u14 for tint.r/g (billboard silhouette phase), u8 for tint.b
  const q16 = (v, max) => clamp(Math.round((v / max) * 65535), 0, 65535);
  const q14 = (v, max) => clamp(Math.round((v / max) * 16383), 0, 16383);
  const q8 = (v, max) => clamp(Math.round((v / max) * 255), 0, 255);
  for (let i = 0; i < tn; i++) { dv.setUint16(off, q16(trees[i].s, TREE_SCALE_MAX), true); off += 2; }
  for (let i = 0; i < tn; i++) {
    const rNorm = ((trees[i].rot % TWO_PI) + TWO_PI) % TWO_PI;
    dv.setUint16(off, q16(rNorm, TWO_PI), true); off += 2;
  }
  for (let i = 0; i < tn; i++) { dv.setUint16(off, q16(trees[i].sx, TREE_SX_MAX), true); off += 2; }
  for (let i = 0; i < tn; i++) { dv.setUint16(off, q14(trees[i].tint[0], TREE_TINT_MAX), true); off += 2; }
  for (let i = 0; i < tn; i++) { dv.setUint16(off, q14(trees[i].tint[1], TREE_TINT_MAX), true); off += 2; }
  for (let i = 0; i < tn; i++) { u8[off++] = q8(trees[i].tint[2], TREE_TINT_MAX); }
  if (!useDerivedRanks) {
    for (let i = 0; i < tn; i++) { dv.setUint16(off, clamp(Math.floor(trees[i].rank * 65536), 0, 65535), true); off += 2; }
  }
  for (let i = 0; i < tn; i++) {
    u8[off++] = (trees[i].v & 0x0f) | (((trees[i].salt || 0) & 0x03) << 4);
  }

  // Hero oaks
  for (let i = 0; i < hn; i++) {
    const h = heroOaks[i];
    dv.setFloat32(off, h[0], true); off += 4;
    dv.setFloat32(off, h[1], true); off += 4;
    dv.setFloat32(off, h[2], true); off += 4;
    dv.setFloat32(off, h[3], true); off += 4;
    dv.setFloat32(off, h[4][0], true); off += 4;
    dv.setFloat32(off, h[4][1], true); off += 4;
    dv.setFloat32(off, h[4][2], true); off += 4;
  }

  // Rocks
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].x, true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].y, true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].z, true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].s, true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].rot, true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].tilt[0], true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setFloat32(off, rocks[i].tilt[1], true); off += 4; }
  for (let i = 0; i < rn; i++) { dv.setUint16(off, clamp(Math.floor(rocks[i].rank * 65536), 0, 65535), true); off += 2; }
  for (let i = 0; i < rn; i++) { u8[off++] = rocks[i].v & 0xff; }

  u8.set(anchorBytes, off);
  return u8;
}

export function decodePlacements(bytes, hf = null) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const magic = dv.getUint32(off, true); off += 4;
  if (magic !== PLACEMENTS_MAGIC) throw new Error('Invalid baked placements magic');
  const ver = dv.getUint32(off, true); off += 4;
  if (ver !== 2) throw new Error(`Unsupported placements version ${ver}`);
  const flags = dv.getUint32(off, true); off += 4;
  const worldSize = dv.getFloat32(off, true); off += 4;
  const tn = dv.getUint32(off, true); off += 4;
  const hn = dv.getUint32(off, true); off += 4;
  const rn = dv.getUint32(off, true); off += 4;
  const forestIdx = dv.getInt32(off, true); off += 4;
  const anchorLen = dv.getUint32(off, true); off += 4;
  const explicitRanks = (flags & FLAG_EXPLICIT_RANKS) !== 0;

  const xBase = off; off += tn * 3;
  const zBase = off; off += tn * 3;
  const tsOff = off; off += tn * 2;
  const trOff = off; off += tn * 2;
  const tsxOff = off; off += tn * 2;
  const tc0Off = off; off += tn * 2;
  const tc1Off = off; off += tn * 2;
  const tc2Off = off; off += tn;
  const trkOff = explicitRanks ? off : 0;
  if (explicitRanks) off += tn * 2;
  const tvOff = off; off += tn;

  const trees = new Array(tn);
  const half = worldSize * 0.5;
  const POS_QMAX = 8388607;
  const posScale = worldSize / POS_QMAX;
  const sScale = TREE_SCALE_MAX / 65535;
  const rScale = TWO_PI / 65535;
  const sxScale = TREE_SX_MAX / 65535;
  const c14Scale = TREE_TINT_MAX / 16383;
  const c8Scale = TREE_TINT_MAX / 255;
  let px = 0, pz = 0;
  for (let i = 0; i < tn; i++) {
    const zx = (bytes[xBase + i] << 16) | (bytes[xBase + tn + i] << 8) | bytes[xBase + tn * 2 + i];
    const zz = (bytes[zBase + i] << 16) | (bytes[zBase + tn + i] << 8) | bytes[zBase + tn * 2 + i];
    px = clamp(px + ((zx >>> 1) ^ -(zx & 1)), 0, POS_QMAX);
    pz = clamp(pz + ((zz >>> 1) ^ -(zz & 1)), 0, POS_QMAX);
    const x = px * posScale - half;
    const z = pz * posScale - half;
    const packed = bytes[tvOff + i];
    const v = packed & 0x0f;
    const salt = (packed >>> 4) & 0x03;
    const bush = v === 3;
    const y = hf ? hf.height(x, z) - (bush ? 0.15 : 0.25) : 0;
    const rank = explicitRanks ? dv.getUint16(trkOff + i * 2, true) / 65536 : placementRank(x, z, v, salt);
    trees[i] = {
      x, y, z,
      s: dv.getUint16(tsOff + i * 2, true) * sScale,
      rot: dv.getUint16(trOff + i * 2, true) * rScale,
      sx: dv.getUint16(tsxOff + i * 2, true) * sxScale,
      tint: [
        dv.getUint16(tc0Off + i * 2, true) * c14Scale,
        dv.getUint16(tc1Off + i * 2, true) * c14Scale,
        bytes[tc2Off + i] * c8Scale,
      ],
      rank,
      v,
      salt,
      bush,
    };
  }

  const heroOaks = new Array(hn);
  for (let i = 0; i < hn; i++) {
    heroOaks[i] = [
      dv.getFloat32(off, true),
      dv.getFloat32(off + 4, true),
      dv.getFloat32(off + 8, true),
      dv.getFloat32(off + 12, true),
      [
        dv.getFloat32(off + 16, true),
        dv.getFloat32(off + 20, true),
        dv.getFloat32(off + 24, true),
      ],
    ];
    off += 28;
  }

  const rxOff = off; off += rn * 4;
  const ryOff = off; off += rn * 4;
  const rzOff = off; off += rn * 4;
  const rsOff = off; off += rn * 4;
  const rrotOff = off; off += rn * 4;
  const rtxOff = off; off += rn * 4;
  const rtzOff = off; off += rn * 4;
  const rrkOff = off; off += rn * 2;
  const rvOff = off; off += rn;

  const rocks = new Array(rn);
  for (let i = 0; i < rn; i++) {
    rocks[i] = {
      x: dv.getFloat32(rxOff + i * 4, true),
      y: dv.getFloat32(ryOff + i * 4, true),
      z: dv.getFloat32(rzOff + i * 4, true),
      s: dv.getFloat32(rsOff + i * 4, true),
      rot: dv.getFloat32(rrotOff + i * 4, true),
      tilt: [dv.getFloat32(rtxOff + i * 4, true), dv.getFloat32(rtzOff + i * 4, true)],
      rank: dv.getUint16(rrkOff + i * 2, true) / 65536,
      v: bytes[rvOff + i],
    };
  }

  const anchors = JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + anchorLen)));
  return { placements: { trees, heroOaks, rocks }, anchors, forestIdx };
}

function encodeHeightByName(arr, res, encoding) {
  if (encoding === 'u16-delta2d-planar') return encodeGridU16Delta2D(arr, res);
  const m = /^u(\d+)-delta2d-planar$/.exec(encoding);
  if (m) return encodeGridQuantDelta2D(arr, res, parseInt(m[1], 10));
  if (encoding === 'f32') return encodeGridF32(arr);
  throw new Error(`Unsupported height encoding: ${encoding}`);
}

function decodeHeightByName(bytes, res, encoding, min, max) {
  if (encoding === 'u16-delta2d-planar') return decodeGridU16Delta2D(bytes, res, min, max);
  const m = /^u(\d+)-delta2d-planar$/.exec(encoding);
  if (m) return decodeGridQuantDelta2D(bytes, res, min, max, parseInt(m[1], 10));
  if (encoding === 'f32') return decodeGridF32(bytes);
  throw new Error(`Unsupported height encoding: ${encoding}`);
}

/** Encode a canonical WorldData instance into manifest + binary files for disk/network delivery. */
export function encodeBakedWorld(worldData, opts = {}) {
  const { region, heights, farHeights, mask, trail, streamPlan, biome, placements, anchors, forestIdx } = worldData;
  const heightNearEnc = opts.heightNearEncoding || 'u22-delta2d-planar';
  const heightFarEnc = opts.heightFarEncoding || 'u14-delta2d-planar';

  const near = encodeHeightByName(heights, region.res, heightNearEnc);
  const far = encodeHeightByName(farHeights, region.farRes, heightFarEnc);
  const maskBytes = encodeMaskSparseI16(mask, region.res);

  let fMin = Infinity, fMax = -Infinity;
  for (let i = 0; i < biome.forest.length; i++) {
    const v = biome.forest[i];
    if (v < fMin) fMin = v;
    if (v > fMax) fMax = v;
  }
  const biomeBytes = encodeBiomeData(biome, region.biomeRes);
  const pathBytes = encodePaths(trail, streamPlan);
  const placementBytes = encodePlacements(placements, anchors, forestIdx, region.size);

  const files = {
    'height-near.bin': near.bytes,
    'height-far.bin': far.bytes,
    'mask-near.bin': maskBytes,
    'biome.bin': biomeBytes,
    'paths.bin': pathBytes,
    'placements.bin': placementBytes,
  };

  const manifest = {
    version: 1,
    regionId: region.id,
    renderer: opts.renderer || 'unknown',
    bakedAt: opts.bakedAt || new Date().toISOString(),
    worldHash: '',
    counts: {
      trees: placements.trees.length,
      heroOaks: placements.heroOaks.length,
      rocks: placements.rocks.length,
      trailPoints: trail.points.length,
      streamPoints: streamPlan ? streamPlan.points.length : 0,
    },
    files: {
      heightNear: { path: 'height-near.bin', encoding: heightNearEnc, res: region.res, min: near.min, max: near.max },
      heightFar: { path: 'height-far.bin', encoding: heightFarEnc, res: region.farRes, min: far.min, max: far.max },
      maskNear: { path: 'mask-near.bin', encoding: 'sparse-i16', res: region.res },
      biome: { path: 'biome.bin', encoding: 'rgb8-delta2d-f16', res: region.biomeRes, forestMin: fMin, forestMax: fMax },
      paths: { path: 'paths.bin', encoding: 'f32-v1' },
      placements: { path: 'placements.bin', encoding: 'compact-v2' },
    },
  };

  // Compute canonical worldHash from the decoded baked buffers so manifest matches runtime load bit-for-bit.
  const decoded = decodeBakedWorld(manifest, files, region);
  manifest.worldHash = decoded.hash;
  return { manifest, files, decoded };
}

/** Transparently gunzip a buffer when gzip magic (0x1f 0x8b) is present. */
export async function maybeGunzip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  const ds = new DecompressionStream('gzip');
  const stream = new Response(u8).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode manifest + binary buffers into a canonical WorldData instance. */
export function decodeBakedWorld(manifest, fileBuffers, region) {
  if (!manifest || manifest.version !== 1) throw new Error(`Unsupported world manifest version: ${manifest?.version}`);
  if (manifest.regionId !== region.id) {
    throw new Error(`Region mismatch: manifest is "${manifest.regionId}", requested "${region.id}"`);
  }
  const f = manifest.files;
  const getBuf = (name) => {
    const raw = fileBuffers[name];
    if (!raw) throw new Error(`Missing baked file buffer: ${name}`);
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  };

  const heights = decodeHeightByName(getBuf(f.heightNear.path), f.heightNear.res, f.heightNear.encoding, f.heightNear.min, f.heightNear.max);
  const farHeights = decodeHeightByName(getBuf(f.heightFar.path), f.heightFar.res, f.heightFar.encoding, f.heightFar.min, f.heightFar.max);
  const mask = decodeMaskSparseI16(getBuf(f.maskNear.path), f.maskNear.res);
  const hf = new HeightField(heights, mask, region.res, region.size);
  const biome = decodeBiomeData(getBuf(f.biome.path), f.biome.res, region.size, f.biome.forestMin ?? 0, f.biome.forestMax ?? 1);
  const { trail, streamPlan } = decodePaths(getBuf(f.paths.path));
  const { placements, anchors, forestIdx } = decodePlacements(getBuf(f.placements.path), hf);

  return new WorldData({
    region,
    heights,
    mask,
    farHeights,
    trail,
    streamPlan,
    biome,
    placements,
    anchors,
    forestIdx,
    source: 'baked',
  });
}

/**
 * Load canonical baked world data for `region` from `worlds/<region.id>/`.
 * No module-level single-world singleton: each call returns a fresh WorldData.
 */
export async function loadWorld(region, opts = {}) {
  const baseUrl = (opts.baseUrl ?? import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');
  const root = `${baseUrl}worlds/${encodeURIComponent(region.id)}/`;
  const fetchFn = opts.fetch || globalThis.fetch;

  const mRes = await fetchFn(`${root}manifest.json`);
  if (!mRes.ok) throw new Error(`Failed to load world manifest for "${region.id}" (${mRes.status})`);
  const manifest = await mRes.json();

  const fileEntries = Object.values(manifest.files);
  const buffers = {};
  await Promise.all(
    fileEntries.map(async (entry) => {
      const res = await fetchFn(`${root}${entry.path}`);
      if (!res.ok) throw new Error(`Failed to load baked world file "${entry.path}" (${res.status})`);
      buffers[entry.path] = await maybeGunzip(new Uint8Array(await res.arrayBuffer()));
    }),
  );

  return decodeBakedWorld(manifest, buffers, region);
}
