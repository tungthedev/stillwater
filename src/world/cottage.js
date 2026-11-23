import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './biome.js';

// A charming storybook alpine cottage built procedurally with vertex colours:
// - Organic roof sag, chunky carved gable bargeboards (no LEGO stair-steps!)
// - Stone plinth & quoins, half-timbered jettied upper storey, blue shutters, flower boxes
// - Cozy yard: stone wishing well, chopping block & firewood, garden patch with pumpkins & sunflowers,
//   barrels, crates, bench, watering can, lantern post, moss & climbing ivy anchors, window glow points.

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

const STONE = [0.62, 0.56, 0.49], STONE_D = [0.43, 0.39, 0.35], PLASTER = [0.96, 0.85, 0.62];
const BEAM = [0.28, 0.17, 0.10], WOOD = [0.46, 0.30, 0.17], SHUTTER = [0.16, 0.46, 0.54], DOOR = [0.40, 0.22, 0.12];
const TILE = [[0.23, 0.35, 0.60], [0.29, 0.43, 0.68], [0.19, 0.30, 0.52], [0.33, 0.46, 0.72]];
const IRON = [0.12, 0.12, 0.13], FLOWER = [[0.92, 0.20, 0.16], [0.96, 0.76, 0.18], [0.88, 0.40, 0.66], [0.96, 0.96, 0.92]];

export function buildStorybookCottage(seed = 7) {
  const rnd = mulberry32(seed);
  const P = [], G = [], moss = [], glows = [];
  const W = 10, D = 7.5;
  const g0 = 0.6, H1 = 3.4, H2 = 2.9;
  const y1 = g0 + H1, y2 = y1 + H2;

  // deep stone plinth (sinks 2.2m into sloped hillside so foundation NEVER floats!) & cobbled stone ground floor
  P.push(box(W + 0.9, 2.8, D + 0.9, 0, g0 - 1.3, 0, STONE_D));
  P.push(box(W, H1, D, 0, g0 + H1 / 2, 0, STONE));
  for (let i = 0; i < 185; i++) {
    const side = Math.floor(rnd() * 4);
    const w = 0.36 + rnd() * 0.48, h = 0.22 + rnd() * 0.18;
    const y = g0 + 0.15 + rnd() * (H1 - 0.3);
    const c = vary(rnd() < 0.32 ? STONE_D : STONE, rnd, 0.26);
    if (side < 2) {
      const z = (side ? 1 : -1) * (D / 2 + 0.035);
      const x = (rnd() - 0.5) * (W - 0.6);
      if (side === 1 && Math.abs(x) < 1.05 && y < g0 + 2.65) continue;
      P.push(box(w, h, 0.11, x, y, z, c));
    } else {
      const x = (side === 2 ? 1 : -1) * (W / 2 + 0.035);
      P.push(box(0.11, h, w, x, y, (rnd() - 0.5) * (D - 0.6), c));
    }
  }
  // chunky stone corner quoins
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let k = 0; k < 6; k++) {
    const big = k % 2 === 0;
    P.push(box(big ? 0.75 : 0.48, 0.44, big ? 0.48 : 0.75, sx * (W / 2 - 0.14), g0 + 0.3 + k * 0.55, sz * (D / 2 - 0.14), vary([0.70, 0.66, 0.60], rnd)));
  }

  // jettied upper storey with chunky timber brackets & hand-hewn beams
  const W2 = W + 0.7, D2 = D + 0.7;
  P.push(box(W2 + 0.24, 0.34, D2 + 0.24, 0, y1 + 0.05, 0, BEAM));
  // sculpted corbel brackets under overhang
  for (const x of [-4.2, -1.8, 1.8, 4.2]) {
    P.push(box(0.26, 0.55, 0.42, x, y1 - 0.25, D / 2 + 0.18, BEAM, -0.35, 0, 0));
  }
  P.push(box(W2, H2, D2, 0, y1 + H2 / 2 + 0.1, 0, PLASTER));
  for (const z of [-D2 / 2 - 0.04, D2 / 2 + 0.04]) {
    for (const x of [-W2 / 2, -W2 / 4, 0, W2 / 4, W2 / 2]) P.push(box(0.28, H2, 0.14, x, y1 + H2 / 2 + 0.1, z, BEAM, 0, 0, (rnd() - 0.5) * 0.018));
    P.push(box(W2 + 0.1, 0.24, 0.14, 0, y2 + 0.05, z, BEAM));
    P.push(box(W2 + 0.1, 0.18, 0.14, 0, y1 + 1.0, z, BEAM));
    for (const s of [-1, 1]) for (const k of [0, 1]) P.push(box(0.18, 1.95, 0.12, s * (W2 * (k ? 0.125 : 0.375)), y1 + 1.6, z, BEAM, 0, 0, s * (k ? -0.6 : 0.6)));
  }
  for (const x of [-W2 / 2 - 0.04, W2 / 2 + 0.04]) {
    for (const z of [-D2 / 2, 0, D2 / 2]) P.push(box(0.14, H2, 0.28, x, y1 + H2 / 2 + 0.1, z, BEAM));
    P.push(box(0.14, 0.24, D2 + 0.1, x, y2 + 0.05, 0, BEAM));
  }

  // windows with shutters, mullions, flower boxes & dusk glow anchors
  const glass = (w, h, x, y, z, ry) => G.push(box(ry ? 0.06 : w, h, ry ? w : 0.06, x, y, z, [1, 1, 1]));
  const windowF = (x, y, z, face, w = 1.1, h = 1.2, shutters = true, flowers = true, addGlow = false) => {
    const ry = face === 'x';
    const n = ry ? Math.sign(x) : Math.sign(z);
    const off = (v) => (ry ? [x + n * v, z] : [x, z + n * v]);
    const [gx, gz] = off(0.02);
    glass(w, h, gx, y, gz, ry);
    if (addGlow) {
      const [hx, hz] = off(0.32);
      glows.push(new THREE.Vector3(hx, y, hz));
    }
    const fr = (ww, hh, dx, dy) => { const [fx, fz] = off(0.09); P.push(ry ? box(0.14, hh, ww, fx, y + dy, fz + dx, BEAM) : box(ww, hh, 0.14, fx + dx, y + dy, fz, BEAM)); };
    fr(w + 0.34, 0.18, 0, h / 2 + 0.08); fr(w + 0.44, 0.20, 0, -h / 2 - 0.08);
    fr(0.14, h, -w / 2 - 0.06, 0); fr(0.14, h, w / 2 + 0.06, 0); fr(0.08, h, 0, 0); fr(w, 0.07, 0, 0);
    if (shutters) for (const s of [-1, 1]) {
      const [sx, sz] = off(0.26);
      const lateral = s * (w / 2 + 0.38);
      P.push(ry ? box(0.08, h + 0.12, 0.64, sx, y, sz + lateral, SHUTTER, 0, s * 0.5 * n, 0) : box(0.64, h + 0.12, 0.08, sx + lateral, y, sz, SHUTTER, 0, s * 0.5 * n, 0));
    }
    if (flowers) {
      const [bx, bz] = off(0.32);
      P.push(ry ? box(0.36, 0.30, w + 0.24, bx, y - h / 2 - 0.3, bz, WOOD) : box(w + 0.24, 0.30, 0.36, bx, y - h / 2 - 0.3, bz, WOOD));
      // lush dark trailing cottage foliage bed + delicate clustered blossoms (kills geometric candy-ball spheres!)
      const leafPalette = [[0.10, 0.34, 0.08], [0.15, 0.42, 0.10], [0.08, 0.28, 0.07]];
      const bloomPalette = [[0.84, 0.22, 0.20], [0.95, 0.82, 0.34], [0.92, 0.68, 0.72], [0.96, 0.94, 0.88]];
      for (let k = 0; k < 12; k++) {
        const t = (k / 11 - 0.5) * (w + 0.08);
        const [fx, fz] = off(0.36 + (k % 2) * 0.06);
        const lf = new THREE.IcosahedronGeometry(0.11 + rnd() * 0.04, 0);
        lf.scale(1.15, 0.58 + rnd() * 0.25, 0.95);
        lf.rotateY(rnd() * 3.14);
        lf.translate(ry ? fx : fx + t, y - h / 2 - 0.14 + (k % 3 === 0 ? -0.06 : rnd() * 0.06), ry ? fz + t : fz);
        P.push(colored(lf, leafPalette[k % leafPalette.length]));
        if (k % 2 === 0) {
          for (let b = 0; b < 3; b++) {
            const fl = new THREE.IcosahedronGeometry(0.045 + rnd() * 0.02, 0);
            fl.scale(1.1, 0.75, 1.1);
            const [bx2, bz2] = off(0.36 + (rnd() - 0.4) * 0.14);
            fl.translate(ry ? bx2 : bx2 + t + (rnd() - 0.5) * 0.12, y - h / 2 - 0.05 + rnd() * 0.09, ry ? bz2 + t + (rnd() - 0.5) * 0.12 : bz2);
            P.push(colored(fl, bloomPalette[(k + b) % bloomPalette.length]));
          }
        }
      }
    }
  };
  windowF(-2.8, g0 + 1.9, D / 2 + 0.05, 'z', 1.15, 1.25, true, true, true);
  windowF(2.8, g0 + 1.9, D / 2 + 0.05, 'z', 1.15, 1.25, true, true, true);
  windowF(-3.2, y1 + 1.5, D2 / 2 + 0.05, 'z', 1.05, 1.15, true, true, true);
  windowF(0, y1 + 1.5, D2 / 2 + 0.05, 'z', 0.92, 1.15, false, false, true);
  windowF(3.2, y1 + 1.5, D2 / 2 + 0.05, 'z', 1.05, 1.15, true, true, true);
  windowF(W / 2 + 0.05, g0 + 1.9, 0, 'x', 1.1, 1.2, true, true, true);
  windowF(W2 / 2 + 0.05, y1 + 1.5, -1.2, 'x', 1.0, 1.1, true, false, false);
  windowF(-W / 2 - 0.05, g0 + 1.9, 1.5, 'x', 1.0, 1.1, true, true, false);
  windowF(-2.8, g0 + 1.9, -D / 2 - 0.05, 'z', 1.0, 1.1, false, false, false);

  // arched front door with timber awning & steps
  const dz = D / 2 + 0.06;
  P.push(box(1.55, 2.35, 0.18, 0, g0 + 1.17, dz, DOOR));
  const arch = new THREE.CylinderGeometry(0.77, 0.77, 0.18, 14, 1, false, 0, Math.PI);
  arch.rotateX(Math.PI / 2); arch.rotateZ(Math.PI / 2); arch.rotateY(Math.PI / 2);
  arch.translate(0, g0 + 2.35, dz);
  P.push(colored(arch, DOOR));
  for (const x of [-0.42, 0, 0.42]) P.push(box(0.06, 2.25, 0.05, x, g0 + 1.15, dz + 0.1, [0.28, 0.15, 0.08]));
  for (const y of [0.5, 1.75]) P.push(box(1.35, 0.11, 0.05, 0, g0 + y, dz + 0.12, IRON));
  P.push(box(0.11, 0.11, 0.13, 0.52, g0 + 1.15, dz + 0.17, [0.85, 0.68, 0.25]));
  P.push(box(2.75, 0.14, 1.5, 0, g0 + 3.05, dz + 0.62, TILE[0], 0.45));
  for (const s of [-1, 1]) P.push(box(0.14, 0.95, 0.14, s * 1.22, g0 + 2.6, dz + 0.55, BEAM));
  P.push(box(2.3, 0.26, 1.25, 0, g0 - 0.05, dz + 0.72, STONE_D));
  P.push(box(1.7, 0.26, 0.85, 0, g0 - 0.3, dz + 1.35, STONE_D));

  // steep storybook tiled roof with organic sway/sag, solid warm-timber roof soffit & chunky bargeboards (ZERO blue-tile underside peeking in right gable!)
  const rh = 4.9, eave = 0.95, over = 0.56;
  const hd = D2 / 2 + eave;
  const slope = Math.atan2(rh, hd);
  const slen = Math.hypot(rh, hd);
  const rows = 12, cols = 10;
  const RW = W2 + over * 2;
  for (const s of [-1, 1]) {
    // solid warm-wood roof soffit / under-decking tucked cleanly beneath sagging slate tiles (fixes blue underside AND never pokes through roof sag!)
    P.push(box(RW - 0.08, 0.16, slen + 0.16, 0, y2 + rh * 0.5 - 0.34, s * hd * 0.5, WOOD, s * slope, 0, 0));
    for (let r = 0; r < rows; r++) {
      const f = (r + 0.5) / rows;
      const zc = s * (hd - f * hd);
      const yc = y2 + 0.12 + f * rh;
      for (let c = 0; c < cols; c++) {
        const xw = RW / cols;
        const xc = -RW / 2 + (c + 0.5) * xw + (r % 2 ? xw * 0.18 : -xw * 0.18);
        const x0 = Math.max(-RW / 2 + 0.08, xc - xw * 0.50), x1 = Math.min(RW / 2 - 0.08, xc + xw * 0.50);
        const cxm = (x0 + x1) / 2;
        const col = vary(TILE[r % 2 ? 0 : 1], rnd, 0.08);
        // organic storybook roof ridge sag in the middle + gentle flared eaves!
        const sag = -0.26 * Math.cos((cxm / RW) * Math.PI) * (0.35 + 0.65 * f) + 0.14 * Math.pow(1 - f, 2.2);
        P.push(box(x1 - x0, 0.20, slen / rows * 1.28, cxm, yc + sag + (rnd() - 0.5) * 0.03, zc, col, s * slope, 0, 0));
        // organic clustered velvety moss cushions tucked naturally into shaded lower eave seams (ZERO pasted-on green rectangular quads!)
        if (r <= 1 && (c <= 4 || rnd() < 0.22) && rnd() < 0.36) {
          const blobs = 3 + Math.floor(rnd() * 3);
          const baseZ = zc + s * 0.16;
          const baseY = yc + sag + 0.08 - 0.16 * Math.sin(slope);
          for (let mb = 0; mb < blobs; mb++) {
            const radM = 0.14 + rnd() * 0.16;
            const mg = new THREE.IcosahedronGeometry(radM, 1);
            mg.scale(1.15 + rnd() * 0.45, 0.24 + rnd() * 0.12, 0.90 + rnd() * 0.35);
            mg.rotateX(s * slope);
            mg.rotateY((rnd() - 0.5) * 0.8);
            const oxM = (rnd() - 0.5) * 0.52, ozM = (rnd() - 0.5) * 0.26;
            mg.translate(cxm + oxM, baseY - s * ozM * Math.sin(slope), baseZ + ozM);
            P.push(colored(mg, vary([0.11, 0.29, 0.068], rnd, 0.24)));
          }
        }
      }
    }
    // chunky timber bargeboards capping both gable ends cleanly (ZERO stepped tile overhang!)
    for (const sx of [-1, 1]) {
      const bx = sx * (RW / 2 + 0.06);
      P.push(box(0.28, 0.44, slen + 0.45, bx, y2 + rh * 0.5 + 0.12, s * hd * 0.5, BEAM, s * slope, 0, 0));
    }
  }
  // thick eave fascia boards & storybook sagging ridge beam
  for (const s of [-1, 1]) P.push(box(RW + 0.25, 0.46, 0.24, 0, y2 - 0.18, s * (hd + 0.05), BEAM));
  for (let i = 0; i < 8; i++) {
    const f0 = i / 8 - 0.5, f1 = (i + 1) / 8 - 0.5;
    const xm = (f0 + f1) * 0.5 * (RW + 0.35);
    const sag = -0.26 * Math.cos((xm / RW) * Math.PI);
    P.push(box((RW + 0.45) / 8 + 0.06, 0.38, 0.58, xm, y2 + rh + 0.18 + sag, 0, [0.18, 0.26, 0.44]));
  }

  // solid gable infill (warm plaster wall + rich half-timber truss & attic window cleanly sealed to roof peak!)
  for (const x of [-W2 / 2, W2 / 2]) {
    const hz = D2 / 2 + 0.05;
    for (const rev of [false, true]) {
      const g = new THREE.BufferGeometry();
      const ox = x + (rev ? -Math.sign(x) * 0.03 : 0);
      g.setAttribute('position', new THREE.Float32BufferAttribute([ox, y2 + 0.06, -hz, ox, y2 + 0.06, hz, ox, y2 + rh + 0.08, 0], 3));
      g.setIndex((x > 0) !== rev ? [0, 2, 1] : [0, 1, 2]);
      g.computeVertexNormals();
      P.push(colored(g, PLASTER));
    }
    const sx = x + Math.sign(x) * 0.05;
    P.push(box(0.14, rh * 0.88, 0.24, sx, y2 + rh * 0.44, 0, BEAM));
    P.push(box(0.14, 0.22, D2 * 0.68, sx, y2 + rh * 0.36, 0, BEAM));
    for (const s of [-1, 1]) P.push(box(0.12, 2.35, 0.18, sx, y2 + rh * 0.26, s * D2 * 0.22, BEAM, s * 0.55, 0, 0));
    windowF(sx + Math.sign(x) * 0.02, y2 + 1.45, 0, 'x', 0.72, 0.82, false, false, false);
  }
  // cozy front dormer with warm glow
  {
    const dx = -2.2, dzz = hd * 0.45, dy = y2 + rh * 0.54;
    P.push(box(1.85, 1.65, 1.85, dx, dy + 0.3, dzz + 0.3, PLASTER));
    P.push(box(1.98, 0.14, 1.98, dx, dy + 1.15, dzz + 0.3, BEAM));
    for (const s of [-1, 1]) P.push(box(1.32, 0.14, 2.28, dx + s * 0.56, dy + 1.52, dzz + 0.4, TILE[1], 0, 0, -s * 0.75));
    windowF(dx, dy + 0.4, dzz + 1.28, 'z', 0.82, 0.82, false, false, true);
  }
  // cobbled stone chimney
  P.push(box(1.3, 6.6, 1.3, 3.0, y2 + 2.6, -1.6, STONE));
  for (let k = 0; k < 18; k++) P.push(box(0.48, 0.26, 0.10, 3.0 + (rnd() - 0.5) * 0.85, y2 + 0.5 + rnd() * 5.6, -1.6 + 0.66, vary(STONE_D, rnd, 0.3)));
  P.push(box(1.55, 0.28, 1.55, 3.0, y2 + 5.95, -1.6, STONE_D));
  P.push(box(0.55, 0.52, 0.55, 3.0, y2 + 6.3, -1.6, [0.24, 0.21, 0.19]));

  // woodshed lean-to + chopping block with split logs (posts extend deep into slope)
  P.push(box(2.7, 0.15, D - 0.4, -W / 2 - 1.35, 2.85, 0, TILE[2], 0, 0, 0.35));
  for (const z of [-D / 2 + 0.6, D / 2 - 0.6]) P.push(box(0.20, 4.2, 0.20, -W / 2 - 2.45, 0.35, z, BEAM));
  for (let i = 0; i < 28; i++) {
    const lg = new THREE.CylinderGeometry(0.15, 0.15, 1.15, 7);
    lg.rotateX(Math.PI / 2);
    lg.translate(-W / 2 - 0.5 - (i % 4) * 0.31, 0.2 + Math.floor(i / 4) * 0.27, -1.5 + ((i * 7) % 5) * 0.05 + (i % 2) * 2.6);
    P.push(colored(lg, vary([0.62, 0.44, 0.26], rnd, 0.2)));
  }
  // chopping stump in front of woodshed (grounded deep)
  P.push(cyl(0.32, 0.38, 1.6, -W / 2 - 1.8, -0.22, D / 2 + 1.2, [0.42, 0.28, 0.16], 10));
  P.push(cyl(0.30, 0.30, 0.04, -W / 2 - 1.8, 0.59, D / 2 + 1.2, [0.76, 0.62, 0.42], 10));

  // cozy stone wishing well to the right of the cottage (deep stone foundation into slope!)
  {
    const wx = W / 2 + 3.4, wz = D / 2 - 0.6;
    P.push(cyl(0.95, 1.08, 2.6, wx, -0.36, wz, STONE, 12));
    P.push(cyl(1.06, 1.06, 0.16, wx, 0.96, wz, STONE_D, 12));
    P.push(cyl(0.75, 0.75, 0.05, wx, 0.84, wz, [0.08, 0.22, 0.30], 10)); // water inside well
    for (const s of [-1, 1]) P.push(box(0.14, 1.62, 0.14, wx + s * 0.85, 1.72, wz, BEAM));
    P.push(cyl(0.06, 0.06, 1.8, wx, 1.84, wz, WOOD, 8, 0, Math.PI / 2)); // windlass axle
    P.push(cyl(0.18, 0.14, 0.30, wx, 1.38, wz, [0.48, 0.30, 0.16], 8)); // hanging wooden bucket
    // charming steep pitched shingle rooflet with overhanging eaves
    for (const s of [-1, 1]) P.push(box(2.35, 0.12, 1.26, wx, 2.74, wz + s * 0.46, TILE[0], s * 0.68, 0, 0));
    P.push(box(2.42, 0.16, 0.22, wx, 3.12, wz, BEAM));
  }

  // sunny terraced storybook garden bed beside the front-left corner (deep stone retaining wall into slope — ZERO floating!)
  {
    const gx = -W / 2 - 1.55, gz = D / 2 + 2.35;
    // solid cobbled stone retaining plinth extending 2.4m down into hillside
    P.push(box(3.35, 2.45, 2.15, gx, -1.10, gz, STONE_D));
    for (const sx of [-1.62, 1.62]) for (const sz of [-1.02, 1.02]) {
      P.push(box(0.18, 2.65, 0.18, gx + sx, -1.04, gz + sz, BEAM));
    }
    // rich dark soil bed & rustic timber coping
    P.push(box(3.16, 0.22, 1.96, gx, 0.12, gz, [0.24, 0.16, 0.10]));
    P.push(box(3.38, 0.22, 0.14, gx, 0.18, gz + 1.0, WOOD));
    P.push(box(3.38, 0.22, 0.14, gx, 0.18, gz - 1.0, WOOD));
    P.push(box(0.14, 0.22, 2.12, gx - 1.62, 0.18, gz, WOOD));
    P.push(box(0.14, 0.22, 2.12, gx + 1.62, 0.18, gz, WOOD));
    // plump orange pumpkins nestled on green squash leaves!
    for (const [px, pz, pr] of [[-0.88, 0.35, 0.32], [-0.18, 0.48, 0.26], [0.62, 0.32, 0.35]]) {
      const leaf = new THREE.CylinderGeometry(pr * 1.45, pr * 1.45, 0.05, 8);
      leaf.translate(gx + px, 0.24, gz + pz);
      P.push(colored(leaf, [0.16, 0.42, 0.10]));
      const pmp = new THREE.SphereGeometry(pr, 9, 7);
      pmp.scale(1.15, 0.78, 1.15);
      pmp.translate(gx + px, 0.24 + pr * 0.65, gz + pz);
      P.push(colored(pmp, [0.92, 0.42, 0.08]));
      P.push(cyl(0.03, 0.05, 0.14, gx + px, 0.24 + pr * 1.38, gz + pz, [0.18, 0.38, 0.10], 5));
    }
    // cheerful organic leafy sunflowers (varied heights, slight bends & foliage leaves — not lollipop sticks!)
    for (const [sx, sz, sh, tilt] of [[-1.08, -0.42, 1.38, -0.09], [-0.36, -0.52, 1.72, 0.06], [0.34, -0.45, 1.54, -0.05], [0.98, -0.50, 1.24, 0.10]]) {
      P.push(cyl(0.035, 0.05, sh, gx + sx + tilt * sh * 0.3, 0.22 + sh * 0.5, gz + sz, [0.16, 0.42, 0.10], 6, 0, -tilt));
      // leafy clusters up the sunflower stalk
      for (const lh of [0.32, 0.62]) {
        const lf = new THREE.IcosahedronGeometry(0.18, 0);
        lf.scale(1.3, 0.45, 0.9);
        lf.translate(gx + sx + (lh > 0.5 ? 0.14 : -0.14), 0.22 + sh * lh, gz + sz + 0.06);
        P.push(colored(lf, [0.18, 0.46, 0.10]));
      }
      const hx = gx + sx + tilt * sh * 0.65, hy = 0.22 + sh;
      const head = new THREE.CylinderGeometry(0.22, 0.22, 0.07, 10);
      head.rotateX(Math.PI / 2 - 0.30); head.rotateY(tilt * 2.0); head.translate(hx, hy, gz + sz + 0.05);
      P.push(colored(head, [0.98, 0.78, 0.08]));
      const ctr = new THREE.CylinderGeometry(0.11, 0.11, 0.09, 8);
      ctr.rotateX(Math.PI / 2 - 0.30); ctr.rotateY(tilt * 2.0); ctr.translate(hx, hy, gz + sz + 0.07);
      P.push(colored(ctr, [0.22, 0.14, 0.07]));
    }
  }

  // barrels, crates, front bench, potted flowers, watering can & lantern post
  const barrel = (x, z) => {
    P.push(cyl(0.38, 0.38, 0.95, x, 0.48, z, [0.50, 0.32, 0.18], 12));
    for (const y of [0.18, 0.78]) P.push(cyl(0.41, 0.41, 0.07, x, y, z, IRON, 12));
  };
  barrel(3.9, D / 2 + 1.0); barrel(4.7, D / 2 + 0.6);
  for (const [x, z, s, r] of [[-4.0, D / 2 + 0.9, 0.8, 0.2], [-4.2, D / 2 + 1.9, 0.6, -0.3], [-4.1, D / 2 + 0.95, 0.55, 0.5]]) {
    const yy = (x === -4.1) ? 1.08 : s / 2;
    P.push(box(s, s, s, x, yy, z, [0.62, 0.45, 0.26], 0, r, 0));
    P.push(box(s + 0.02, 0.08, s * 0.2, x, yy, z, [0.45, 0.30, 0.17], 0, r, 0));
  }
  P.push(box(2.0, 0.1, 0.45, 1.9, 0.55, D / 2 + 0.75, WOOD));
  for (const x of [1.1, 2.7]) P.push(box(0.1, 0.55, 0.4, x, 0.28, D / 2 + 0.75, BEAM));
  for (const [x, z] of [[-1.3, D / 2 + 0.9], [1.3, D / 2 + 1.5]]) {
    P.push(cyl(0.25, 0.18, 0.4, x, 0.2, z, [0.65, 0.33, 0.20], 10));
    for (let k = 0; k < 5; k++) {
      const f = new THREE.IcosahedronGeometry(0.16, 0);
      f.translate(x + (rnd() - 0.5) * 0.3, 0.5 + rnd() * 0.2, z + (rnd() - 0.5) * 0.3);
      P.push(colored(f, k < 2 ? [0.20, 0.48, 0.12] : FLOWER[Math.floor(rnd() * 3)]));
    }
  }
  for (let k = 0; k < 16; k++) {
    const side = k % 2 ? 1 : -1;
    const g = new THREE.IcosahedronGeometry(0.18 + rnd() * 0.18, 0);
    g.scale(1.2, 0.6, 1);
    g.translate(side * (W / 2 + 0.25 + rnd() * 0.3), 0.05, -D / 2 + rnd() * D);
    P.push(colored(g, vary([0.55, 0.53, 0.50], rnd, 0.3)));
  }
  P.push(cyl(0.16, 0.20, 0.34, 2.7, 0.17, D / 2 + 1.0, [0.35, 0.50, 0.55], 10));

  // charming porch lantern post by the path
  const lp = new THREE.Vector3(3.6, 0, D / 2 + 1.8);
  P.push(box(0.18, 2.65, 0.18, lp.x, 1.32, lp.z, BEAM));
  P.push(box(0.75, 0.11, 0.11, lp.x + 0.32, 2.52, lp.z, BEAM));
  P.push(box(0.36, 0.09, 0.36, lp.x + 0.62, 2.40, lp.z, IRON));
  P.push(box(0.38, 0.09, 0.38, lp.x + 0.62, 1.98, lp.z, IRON));
  G.push(box(0.28, 0.38, 0.28, lp.x + 0.62, 2.19, lp.z, [1, 1, 1]));
  glows.push(new THREE.Vector3(lp.x + 0.62, 2.19, lp.z));

  // hanging wooden inn sign over the door
  P.push(box(0.08, 0.08, 1.05, 1.6, g0 + 3.12, dz + 0.5, IRON));
  P.push(box(0.06, 0.62, 0.92, 1.6, g0 + 2.72, dz + 0.92, [0.55, 0.36, 0.20], 0, Math.PI / 2, 0));

  // flush wall-hugging climbing ivy anchored solidly into corner masonry & timber (ZERO floating green tufts!)
  for (const [x, y, z] of [
    [-W / 2 - 0.02, 1.1, -D / 2 + 0.1], [-W / 2 - 0.02, 2.0, -D / 2 + 0.3], [-W / 2 - 0.02, 2.9, -D / 2 + 0.5],
    [W / 2 - 0.02, 0.9, D / 2 - 0.35], [W / 2 - 0.02, 1.75, D / 2 - 0.25], [W / 2 - 0.02, 2.6, D / 2 - 0.15], [W / 2 - 0.02, 3.45, D / 2 - 0.20],
    [-W / 2 + 0.22, 0.85, D / 2 - 0.02], [-W / 2 + 0.18, 1.65, D / 2 - 0.02],
  ]) moss.push(new THREE.Vector3(x, y, z));

  return {
    geo: mergeGeometries(P),
    glass: mergeGeometries(G),
    moss,
    glows,
    chimney: new THREE.Vector3(3.0, y2 + 6.6, -1.6),
    lantern: new THREE.Vector3(lp.x + 0.62, 2.19, lp.z),
    radius: 8.5,
  };
}
