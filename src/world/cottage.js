import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './biome.js';

// A chunky storybook cottage built from primitives with vertex colours.
// Front faces +z. Returns the solid geometry, window-glass geometry (lit warm at dusk),
// moss clump anchors for the roof, and the chimney top.

function colored(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
function box(w, h, d, x, y, z, rgb, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateZ(rz); g.rotateY(ry);
  g.translate(x, y, z);
  return colored(g, rgb);
}
function cyl(r0, r1, h, x, y, z, rgb, segs = 10, rx = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(r0, r1, h, segs);
  g.rotateX(rx); g.rotateZ(rz);
  g.translate(x, y, z);
  return colored(g, rgb);
}
const vary = (c, rnd, k = 0.12) => { const f = 1 - k / 2 + rnd() * k; return [c[0] * f, c[1] * f, c[2] * f]; };

const STONE = [0.62, 0.56, 0.49], STONE_D = [0.44, 0.4, 0.36], PLASTER = [0.96, 0.84, 0.6];
const BEAM = [0.3, 0.19, 0.11], WOOD = [0.46, 0.3, 0.17], SHUTTER = [0.18, 0.45, 0.52], DOOR = [0.4, 0.22, 0.12];
const TILE = [[0.25, 0.37, 0.62], [0.3, 0.44, 0.7], [0.21, 0.32, 0.55], [0.34, 0.47, 0.72]];
const IRON = [0.12, 0.12, 0.13], FLOWER = [[0.9, 0.2, 0.15], [0.95, 0.75, 0.2], [0.85, 0.4, 0.65], [0.95, 0.95, 0.9]];

export function buildStorybookCottage(seed = 7) {
  const rnd = mulberry32(seed);
  const P = [], G = [], moss = [];
  const W = 10, D = 7.5;
  const g0 = 0.6, H1 = 3.4, H2 = 2.9;
  const y1 = g0 + H1, y2 = y1 + H2;
  // plinth & ground-floor stone walls
  P.push(box(W + 0.9, 1.0, D + 0.9, 0, g0 - 0.4, 0, STONE_D));
  P.push(box(W, H1, D, 0, g0 + H1 / 2, 0, STONE));
  // individual stones for a cobbled look
  for (let i = 0; i < 170; i++) {
    const side = Math.floor(rnd() * 4);
    const w = 0.35 + rnd() * 0.45, h = 0.22 + rnd() * 0.18;
    const y = g0 + 0.15 + rnd() * (H1 - 0.3);
    const c = vary(rnd() < 0.3 ? STONE_D : STONE, rnd, 0.25);
    if (side < 2) {
      const z = (side ? 1 : -1) * (D / 2 + 0.03);
      const x = (rnd() - 0.5) * (W - 0.6);
      if (side === 1 && Math.abs(x) < 1.0 && y < g0 + 2.6) continue; // door
      P.push(box(w, h, 0.1, x, y, z, c));
    } else {
      const x = (side === 2 ? 1 : -1) * (W / 2 + 0.03);
      P.push(box(0.1, h, w, x, y, (rnd() - 0.5) * (D - 0.6), c));
    }
  }
  // corner quoins
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 6; k++) {
    const big = k % 2 === 0;
    P.push(box(big ? 0.7 : 0.45, 0.42, big ? 0.45 : 0.7, sx * (W / 2 - 0.15), g0 + 0.3 + k * 0.55, sz * (D / 2 - 0.15), vary([0.7, 0.66, 0.6], rnd)));
  }
  // jettied upper storey
  const W2 = W + 0.6, D2 = D + 0.6;
  P.push(box(W2 + 0.2, 0.3, D2 + 0.2, 0, y1 + 0.05, 0, BEAM));
  P.push(box(W2, H2, D2, 0, y1 + H2 / 2 + 0.1, 0, PLASTER));
  for (const z of [-D2 / 2 - 0.03, D2 / 2 + 0.03]) {
    for (const x of [-W2 / 2, -W2 / 4, 0, W2 / 4, W2 / 2]) P.push(box(0.24, H2, 0.12, x, y1 + H2 / 2 + 0.1, z, BEAM));
    P.push(box(W2, 0.2, 0.12, 0, y2 + 0.05, z, BEAM));
    P.push(box(W2, 0.16, 0.12, 0, y1 + 1.0, z, BEAM));
    for (const s of [-1, 1]) for (const k of [0, 1]) P.push(box(0.16, 1.9, 0.1, s * (W2 * (k ? 0.125 : 0.375)), y1 + 1.6, z, BEAM, 0, 0, s * (k ? -0.6 : 0.6)));
  }
  for (const x of [-W2 / 2 - 0.03, W2 / 2 + 0.03]) {
    for (const z of [-D2 / 2, 0, D2 / 2]) P.push(box(0.12, H2, 0.24, x, y1 + H2 / 2 + 0.1, z, BEAM));
    P.push(box(0.12, 0.2, D2, x, y2 + 0.05, 0, BEAM));
  }
  // windows with shutters & flower boxes
  const glass = (w, h, x, y, z, ry) => G.push(box(ry ? 0.06 : w, h, ry ? w : 0.06, x, y, z, [1, 1, 1]));
  const windowF = (x, y, z, face, w = 1.1, h = 1.2, shutters = true, flowers = true) => {
    const ry = face === 'x';
    const n = ry ? Math.sign(x) : Math.sign(z);
    const off = (v) => (ry ? [x + n * v, z] : [x, z + n * v]);
    const [gx, gz] = off(0.02);
    glass(w, h, gx, y, gz, ry);
    const fr = (ww, hh, dx, dy) => { const [fx, fz] = off(0.08); P.push(ry ? box(0.12, hh, ww, fx, y + dy, fz + dx, BEAM) : box(ww, hh, 0.12, fx + dx, y + dy, fz, BEAM)); };
    fr(w + 0.3, 0.16, 0, h / 2 + 0.08); fr(w + 0.4, 0.18, 0, -h / 2 - 0.08); fr(0.12, h, -w / 2 - 0.06, 0); fr(0.12, h, w / 2 + 0.06, 0); fr(0.08, h, 0, 0); fr(w, 0.07, 0, 0);
    if (shutters) for (const s of [-1, 1]) {
      const [sx, sz] = off(0.25);
      const lateral = s * (w / 2 + 0.38);
      P.push(ry ? box(0.07, h + 0.1, 0.62, sx, y, sz + lateral, SHUTTER, 0, s * 0.5 * n, 0) : box(0.62, h + 0.1, 0.07, sx + lateral, y, sz, SHUTTER, 0, s * 0.5 * n, 0));
    }
    if (flowers) {
      const [bx, bz] = off(0.3);
      P.push(ry ? box(0.35, 0.3, w + 0.2, bx, y - h / 2 - 0.3, bz, WOOD) : box(w + 0.2, 0.3, 0.35, bx, y - h / 2 - 0.3, bz, WOOD));
      for (let k = 0; k < 7; k++) {
        const t = (k / 6 - 0.5) * w;
        const f = new THREE.IcosahedronGeometry(0.13 + rnd() * 0.05, 0);
        const [fx, fz] = off(0.32);
        f.translate(ry ? fx : fx + t, y - h / 2 - 0.08 + rnd() * 0.08, ry ? fz + t : fz);
        P.push(colored(f, k % 3 === 1 ? [0.2, 0.5, 0.12] : FLOWER[Math.floor(rnd() * FLOWER.length)]));
      }
    }
  };
  windowF(-2.8, g0 + 1.9, D / 2 + 0.05, 'z'); windowF(2.8, g0 + 1.9, D / 2 + 0.05, 'z');
  windowF(-3.2, y1 + 1.5, D2 / 2 + 0.05, 'z', 1.0, 1.1, true, true); windowF(0, y1 + 1.5, D2 / 2 + 0.05, 'z', 0.9, 1.1, false, false); windowF(3.2, y1 + 1.5, D2 / 2 + 0.05, 'z', 1.0, 1.1, true, true);
  windowF(W / 2 + 0.05, g0 + 1.9, 0, 'x'); windowF(W2 / 2 + 0.05, y1 + 1.5, -1.2, 'x', 1.0, 1.1, true, false);
  windowF(-W / 2 - 0.05, g0 + 1.9, 1.5, 'x', 1.0, 1.1, true, true);
  windowF(-2.8, g0 + 1.9, -D / 2 - 0.05, 'z', 1.0, 1.1, false, false);
  // arched front door with awning
  const dz = D / 2 + 0.06;
  P.push(box(1.5, 2.3, 0.18, 0, g0 + 1.15, dz, DOOR));
  const arch = new THREE.CylinderGeometry(0.75, 0.75, 0.18, 14, 1, false, 0, Math.PI);
  arch.rotateX(Math.PI / 2); arch.rotateZ(Math.PI / 2); arch.rotateY(Math.PI / 2);
  arch.translate(0, g0 + 2.3, dz);
  P.push(colored(arch, DOOR));
  for (const x of [-0.4, 0, 0.4]) P.push(box(0.06, 2.2, 0.05, x, g0 + 1.15, dz + 0.1, [0.3, 0.16, 0.08]));
  for (const y of [0.5, 1.7]) P.push(box(1.3, 0.1, 0.05, 0, g0 + y, dz + 0.12, IRON));
  P.push(box(0.1, 0.1, 0.12, 0.5, g0 + 1.15, dz + 0.16, [0.8, 0.65, 0.25]));
  P.push(box(2.6, 0.12, 1.4, 0, g0 + 3.0, dz + 0.6, TILE[0], 0.45));
  for (const s of [-1, 1]) P.push(box(0.1, 0.9, 0.1, s * 1.2, g0 + 2.6, dz + 0.5, BEAM, 0, 0, 0));
  P.push(box(2.2, 0.25, 1.2, 0, g0 - 0.05, dz + 0.7, STONE_D));
  P.push(box(1.6, 0.25, 0.8, 0, g0 - 0.3, dz + 1.3, STONE_D));
  // steep tiled roof (ridge along x)
  const rh = 4.8, eave = 0.9, over = 0.9;
  const hd = D2 / 2 + eave;
  const slope = Math.atan2(rh, hd);
  const slen = Math.hypot(rh, hd);
  const rows = 12, cols = 9;
  const RW = W2 + over * 2;
  for (const s of [-1, 1]) {
    for (let r = 0; r < rows; r++) {
      const f = (r + 0.5) / rows;
      const zc = s * (hd - f * hd);
      const yc = y2 + 0.15 - eave * Math.tan(slope) * 0 + f * rh - 0.35 * (1 - f) * 0;
      for (let c = 0; c < cols; c++) {
        const xw = RW / cols;
        const xc = -RW / 2 + (c + 0.5) * xw + (r % 2 ? xw * 0.25 : -xw * 0.25);
        const x0 = Math.max(-RW / 2, xc - xw * 0.51), x1 = Math.min(RW / 2, xc + xw * 0.51);
        const col = vary(TILE[r % 2 ? 0 : 1], rnd, 0.06);
        const sag = -0.12 * Math.cos(((x0 + x1) / 2) / RW * Math.PI) * f;
        P.push(box(x1 - x0, 0.2, slen / rows * 1.3, (x0 + x1) / 2, yc + sag + (rnd() - 0.5) * 0.03, zc, col, s * slope, 0, 0));
      }
      if (rnd() < 0.5) moss.push(new THREE.Vector3(-RW / 2 + rnd() * RW, yc + 0.3, zc));
    }
  }
  // thick eave fascia boards
  for (const s of [-1, 1]) P.push(box(RW + 0.1, 0.42, 0.22, 0, y2 - 0.25, s * (hd + 0.05), BEAM));
  // ridge cap and barge boards
  P.push(box(RW + 0.2, 0.35, 0.55, 0, y2 + rh + 0.15, 0, [0.2, 0.28, 0.45]));

  // gable infill (plaster with timber)
  for (const x of [-W2 / 2, W2 / 2]) {
    const g = new THREE.BufferGeometry();
    const hz = D2 / 2;
    g.setAttribute('position', new THREE.Float32BufferAttribute([x, y2 + 0.1, -hz, x, y2 + 0.1, hz, x, y2 + rh - 0.1, 0], 3));
    g.setIndex(x > 0 ? [0, 2, 1] : [0, 1, 2]);
    g.computeVertexNormals();
    P.push(colored(g, PLASTER));
    const sx = x + Math.sign(x) * 0.04;
    P.push(box(0.1, rh * 0.8, 0.2, sx, y2 + rh * 0.4, 0, BEAM));
    P.push(box(0.1, 0.18, D2 * 0.6, sx, y2 + rh * 0.35, 0, BEAM));
    windowF(sx + Math.sign(x) * 0.02, y2 + 1.4, 0, 'x', 0.7, 0.8, false, false);
  }
  // dormer on the front slope
  {
    const dx = -2.2, dzz = hd * 0.45, dy = y2 + rh * 0.55;
    P.push(box(1.8, 1.6, 1.8, dx, dy + 0.3, dzz + 0.3, PLASTER));
    P.push(box(1.9, 0.12, 1.9, dx, dy + 1.15, dzz + 0.3, BEAM));
    for (const s of [-1, 1]) P.push(box(1.25, 0.12, 2.2, dx + s * 0.55, dy + 1.5, dzz + 0.4, TILE[1], 0, 0, -s * 0.75));
    windowF(dx, dy + 0.4, dzz + 1.25, 'z', 0.8, 0.8, false, false);
  }
  // chimney
  P.push(box(1.2, 6.5, 1.2, 3.0, y2 + 2.6, -1.6, STONE));
  for (let k = 0; k < 14; k++) P.push(box(0.45, 0.25, 0.08, 3.0 + (rnd() - 0.5) * 0.8, y2 + 0.5 + rnd() * 5.5, -1.6 + 0.62, vary(STONE_D, rnd, 0.3)));
  P.push(box(1.45, 0.25, 1.45, 3.0, y2 + 5.9, -1.6, STONE_D));
  P.push(box(0.5, 0.5, 0.5, 3.0, y2 + 6.2, -1.6, [0.25, 0.22, 0.2]));
  // woodshed lean-to
  P.push(box(2.6, 0.14, D - 0.5, -W / 2 - 1.3, 2.8, 0, TILE[2], 0, 0, 0.35));
  for (const z of [-D / 2 + 0.6, D / 2 - 0.6]) P.push(box(0.18, 2.4, 0.18, -W / 2 - 2.4, 1.2, z, BEAM));
  for (let i = 0; i < 24; i++) {
    const lg = new THREE.CylinderGeometry(0.15, 0.15, 1.1, 7);
    lg.rotateX(Math.PI / 2);
    lg.translate(-W / 2 - 0.5 - (i % 4) * 0.31, 0.2 + Math.floor(i / 4) * 0.27, -1.5 + ((i * 7) % 5) * 0.05 + (i % 2) * 2.6);
    P.push(colored(lg, vary([0.62, 0.44, 0.26], rnd, 0.2)));
  }
  // barrels, crates, bench, potted flowers, lantern
  const barrel = (x, z) => {
    P.push(cyl(0.38, 0.38, 0.95, x, 0.48, z, [0.5, 0.32, 0.18], 12));
    for (const y of [0.18, 0.78]) P.push(cyl(0.4, 0.4, 0.07, x, y, z, IRON, 12));
  };
  barrel(3.9, D / 2 + 1.0); barrel(4.7, D / 2 + 0.6);
  for (const [x, z, s, r] of [[-4.0, D / 2 + 0.9, 0.8, 0.2], [-4.2, D / 2 + 1.9, 0.6, -0.3], [-4.1, D / 2 + 0.95, 0.55, 0.5]]) {
    const yy = (x === -4.1) ? 1.08 : s / 2;
    P.push(box(s, s, s, x, yy, z, [0.62, 0.45, 0.26], 0, r, 0));
    P.push(box(s + 0.02, 0.08, s * 0.2, x, yy, z, [0.45, 0.3, 0.17], 0, r, 0));
  }
  P.push(box(2.0, 0.1, 0.45, 1.9, 0.55, D / 2 + 0.75, WOOD));
  for (const x of [1.1, 2.7]) P.push(box(0.1, 0.55, 0.4, x, 0.28, D / 2 + 0.75, BEAM));
  for (const [x, z] of [[-1.3, D / 2 + 0.9], [1.3, D / 2 + 1.5]]) {
    P.push(cyl(0.25, 0.18, 0.4, x, 0.2, z, [0.65, 0.33, 0.2], 10));
    for (let k = 0; k < 5; k++) {
      const f = new THREE.IcosahedronGeometry(0.16, 0);
      f.translate(x + (rnd() - 0.5) * 0.3, 0.5 + rnd() * 0.2, z + (rnd() - 0.5) * 0.3);
      P.push(colored(f, k < 2 ? [0.2, 0.48, 0.12] : FLOWER[Math.floor(rnd() * 3)]));
    }
  }
  // flagstone path from the door

  // stones and a watering can along the wall base
  for (let k = 0; k < 16; k++) {
    const side = k % 2 ? 1 : -1;
    const g = new THREE.IcosahedronGeometry(0.18 + rnd() * 0.18, 0);
    g.scale(1.2, 0.6, 1);
    g.translate(side * (W / 2 + 0.25 + rnd() * 0.3), 0.05, -D / 2 + rnd() * D);
    P.push(colored(g, vary([0.55, 0.53, 0.5], rnd, 0.3)));
  }
  P.push(cyl(0.16, 0.2, 0.34, 2.7, 0.17, D / 2 + 1.0, [0.35, 0.5, 0.55], 10));
  // lantern post by the path
  const lp = new THREE.Vector3(3.6, 0, D / 2 + 1.8);
  P.push(box(0.16, 2.6, 0.16, lp.x, 1.3, lp.z, BEAM));
  P.push(box(0.7, 0.1, 0.1, lp.x + 0.3, 2.5, lp.z, BEAM));
  P.push(box(0.34, 0.08, 0.34, lp.x + 0.6, 2.38, lp.z, IRON));
  P.push(box(0.36, 0.08, 0.36, lp.x + 0.6, 1.98, lp.z, IRON));
  G.push(box(0.26, 0.36, 0.26, lp.x + 0.6, 2.18, lp.z, [1, 1, 1]));
  // hanging sign over the door
  P.push(box(0.08, 0.08, 1.0, 1.6, g0 + 3.1, dz + 0.5, IRON));
  P.push(box(0.06, 0.6, 0.9, 1.6, g0 + 2.7, dz + 0.9, [0.55, 0.36, 0.2], 0, Math.PI / 2, 0));
  // ivy anchors on the walls (fluffy clumps placed by caller)
  for (const [x, y, z] of [[-W / 2 - 0.2, 1.4, -D / 2 - 0.1], [-W / 2 - 0.2, 2.6, -D / 2 + 0.4], [W / 2 + 0.2, 1.2, D / 2 - 0.4], [W / 2 + 0.25, 2.4, D / 2 - 0.2], [-W / 2 + 0.3, 0.9, D / 2 + 0.3]]) moss.push(new THREE.Vector3(x, y, z));
  return {
    geo: mergeGeometries(P),
    glass: mergeGeometries(G),
    moss,
    chimney: new THREE.Vector3(3.0, y2 + 6.5, -1.6),
    lantern: new THREE.Vector3(lp.x + 0.6, 2.18, lp.z),
    radius: 8,
  };
}
