import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './biome.js';

// Procedurally painted foliage atlases + card-based tree builders.
// Atlas layout: u in [0, 0.75] foliage card, u in [0.8, 1.0] bark strip.

const FOLIAGE_U = 0.75;
const BARK_U0 = 0.8;

function bleed(ctx, w, h, rgb) {
  ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.012)`;
  ctx.fillRect(0, 0, w, h);
}

export function coniferAtlas() {
  const W = 512, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(17);
  bleed(ctx, W, H, [40, 62, 32]);
  const FW = W * FOLIAGE_U;
  const cx = FW / 2;
  const greens = ['#1c2e17', '#22381b', '#2a4220', '#30491f', '#1a2a16', '#375026'];
  const tips = ['#4d6a2c', '#5b7632', '#47622a', '#61803a'];
  ctx.lineCap = 'round';
  const needle = (x, y, ang, len, col, wid) => {
    ctx.strokeStyle = col; ctx.lineWidth = wid;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
  };
  // frond: stem from bottom (base, v=0 at canvas bottom) to top (tip)
  const twig = (x0, y0, ang, len, depth) => {
    const steps = Math.floor(len / 3);
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const x = x0 + Math.cos(ang) * len * f, y = y0 + Math.sin(ang) * len * f;
      const nl = (depth === 0 ? 15 : 11) * (1 - f * 0.45) * (0.8 + rnd() * 0.4);
      const isTip = f > 0.78;
      const col = isTip && rnd() < 0.7 ? tips[Math.floor(rnd() * tips.length)] : greens[Math.floor(rnd() * greens.length)];
      for (const s of [-1, 1]) needle(x, y, ang + s * (0.75 + rnd() * 0.45), nl, col, 2.2);
      if (rnd() < 0.35) needle(x, y, ang + (rnd() - 0.5) * 0.6, nl * 0.8, col, 2.0);
    }
    ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = depth === 0 ? 3 : 1.6;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len); ctx.stroke();
  };
  // side twigs first (behind), then main stem
  for (let y = H - 30; y > 40; y -= 26 + rnd() * 8) {
    const f = 1 - y / H;
    const reach = FW * 0.42 * Math.sin(Math.min(1, (f + 0.12) * 1.25) * Math.PI) + 18;
    for (const s of [-1, 1]) {
      const ang = -Math.PI / 2 + s * (0.95 + rnd() * 0.25);
      twig(cx + s * 2, y, ang, reach * (0.8 + rnd() * 0.3), 1);
    }
  }
  twig(cx, H - 6, -Math.PI / 2, H - 20, 0);
  // bark strip
  const bx = W * BARK_U0;
  ctx.fillStyle = '#4a3526'; ctx.fillRect(bx, 0, W - bx, H);
  for (let i = 0; i < 260; i++) {
    ctx.strokeStyle = rnd() < 0.5 ? 'rgba(25,15,8,0.55)' : 'rgba(110,85,60,0.4)';
    ctx.lineWidth = 1 + rnd() * 3;
    const x = bx + rnd() * (W - bx), y = rnd() * H;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 4, y + 10 + rnd() * 40); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

export function birchAtlas() {
  const W = 512, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(29);
  bleed(ctx, W, H, [90, 110, 30]);
  const FW = W * FOLIAGE_U;
  const cols = ['#5d7a22', '#6d8a28', '#7f9a2e', '#8fa834', '#4e6a1e', '#a0ad3c', '#b5a93e'];
  // twigs
  ctx.strokeStyle = '#3b2d22'; ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    ctx.beginPath(); ctx.moveTo(FW / 2, H * 0.95);
    ctx.quadraticCurveTo(FW * (0.2 + rnd() * 0.6), H * 0.5, FW * (0.1 + rnd() * 0.8), H * (0.05 + rnd() * 0.3)); ctx.stroke();
  }
  for (let i = 0; i < 520; i++) {
    // leaves within a soft rounded cluster
    let x, y;
    do { x = rnd(); y = rnd(); } while ((x - 0.5) ** 2 + (y - 0.48) ** 2 * 0.9 > 0.2 + rnd() * 0.05);
    const px = x * FW, py = y * H;
    const s = 7 + rnd() * 7;
    ctx.save(); ctx.translate(px, py); ctx.rotate(rnd() * Math.PI * 2);
    ctx.fillStyle = cols[Math.floor(rnd() * cols.length)];
    ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.62, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(40,50,15,0.35)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
    ctx.restore();
  }
  // white birch bark with dark lenticels
  const bx = W * BARK_U0;
  ctx.fillStyle = '#dcd8cf'; ctx.fillRect(bx, 0, W - bx, H);
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(20,18,16,${0.5 + rnd() * 0.4})`;
    const y = rnd() * H, w = 8 + rnd() * 40;
    ctx.fillRect(bx + rnd() * (W - bx - w), y, w, 1.5 + rnd() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------- geometry helpers ----------
class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; }
  vert(p, n, uv, c) {
    this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.uv.push(uv[0], uv[1]); this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

function addTrunk(B, r0, r1, h, segs, rnd, colMul = 1, lean = 0) {
  const rings = 6;
  const base = B.pos.length / 3;
  for (let j = 0; j <= rings; j++) {
    const f = j / rings, y = f * h, r = r0 + (r1 - r0) * f;
    const ox = Math.sin(f * 3.1 + lean) * 0.006, oz = Math.cos(f * 2.3 + lean) * 0.006;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const k = (0.55 + 0.45 * f) * colMul;
      B.vert(new THREE.Vector3(ox + n.x * r, y, oz + n.z * r), n, [BARK_U0 + (i / segs) * (1 - BARK_U0), f * h * 3], [k, k, k]);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const a = base + j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    B.tri(a, c, b); B.tri(b, c, d);
  }
}

/** A frond card along a curved branch. pts: centerline points, side: unit width vector. */
function addCard(B, pts, side, width, nrm, colIn, colOut, taper = true) {
  const base = B.pos.length / 3;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const w = width * (taper ? (0.55 + 0.45 * Math.sin(Math.min(1, f * 1.1 + 0.15) * Math.PI)) : 1) * 0.5;
    const c = [colIn[0] + (colOut[0] - colIn[0]) * f, colIn[1] + (colOut[1] - colIn[1]) * f, colIn[2] + (colOut[2] - colIn[2]) * f];
    B.vert(pts[i].clone().addScaledVector(side, -w), nrm[i], [0, f], c);
    B.vert(pts[i].clone().addScaledVector(side, w), nrm[i], [FOLIAGE_U, f], c);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    B.tri(a, a + 2, a + 1); B.tri(a + 1, a + 2, a + 3);
  }
}

export function cardConifer(seed, o = {}) {
  const rnd = mulberry32(seed);
  const R = o.radius ?? 0.21;
  const whorls = o.whorls ?? 15;
  const per = o.per ?? 6;
  const droop = o.droop ?? 0.55;
  const B = new Builder();
  addTrunk(B, 0.02, 0.004, 0.97, o.trunkSegs ?? 7, rnd);
  const up = new THREE.Vector3(0, 1, 0);
  const tint = o.tint ?? [1, 1, 1];
  for (let k = 0; k < whorls; k++) {
    const t = k / (whorls - 1);
    const y = 0.1 + t * 0.84 + (rnd() - 0.5) * 0.015;
    const L = (R * Math.pow(1 - t, 0.9) * (0.85 + rnd() * 0.3) + 0.04);
    const n = Math.max(3, Math.round(per * (1 - t * 0.45)));
    const bright = 0.55 + 0.45 * t;
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + k * 2.39996 + (rnd() - 0.5) * 0.5;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const pts = [], nrm = [];
      const segs = 4;
      const lift = 0.05 + rnd() * 0.06;
      for (let s = 0; s <= segs; s++) {
        const f = s / segs;
        const p = dir.clone().multiplyScalar(0.012 + f * L);
        p.y = y + lift * L * f * 2 - droop * L * f * f;
        pts.push(p);
        nrm.push(dir.clone().multiplyScalar(0.75).add(up.clone().multiplyScalar(0.65 + f * 0.2)).normalize());
      }
      const side = new THREE.Vector3(-dir.z, (rnd() - 0.5) * 0.5, dir.x).normalize();
      const ci = [0.32 * bright * tint[0], 0.34 * bright * tint[1], 0.3 * bright * tint[2]];
      const co = [1.0 * bright * tint[0], 1.0 * bright * tint[1], 0.95 * bright * tint[2]];
      addCard(B, pts, side, L * 0.95, nrm, ci, co);
      // a second, tilted card for volume
      if (o.double !== false && rnd() < 0.7) {
        const side2 = new THREE.Vector3(-dir.z, 0.9, dir.x).normalize();
        const pts2 = pts.map((p) => p.clone().add(new THREE.Vector3(0, -0.012, 0)));
        addCard(B, pts2, side2, L * 0.6, nrm, ci.map((v) => v * 0.8), co.map((v) => v * 0.85));
      }
    }
  }
  // leader at the top
  for (let i = 0; i < 2; i++) {
    const a = i * Math.PI / 2;
    const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const pts = [], nrm = [];
    for (let s = 0; s <= 2; s++) { pts.push(new THREE.Vector3(0, 0.9 + s * 0.05, 0)); nrm.push(new THREE.Vector3(side.z, 0.6, -side.x).normalize()); }
    addCard(B, pts, side, 0.05, nrm, [0.8, 0.8, 0.8], [1.1, 1.1, 1]);
  }
  return B.build();
}

export function cardBirch(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  addTrunk(B, 0.017, 0.006, 0.92, o.trunkSegs ?? 7, rnd, 1.0, rnd() * 6);
  const cards = o.cards ?? 46;
  const up = new THREE.Vector3(0, 1, 0);
  const center = new THREE.Vector3(0, 0.68, 0);
  for (let i = 0; i < cards; i++) {
    let x, y, z;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1);
    const p = new THREE.Vector3(x * 0.17, 0.68 + y * 0.26, z * 0.17);
    const out = p.clone().sub(center).normalize();
    const s = 0.11 + rnd() * 0.08;
    // random orientation, biased to face outward
    const nrmV = out.clone().multiplyScalar(0.8).add(up.clone().multiplyScalar(0.35)).normalize();
    const tangent = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(nrmV).normalize();
    const along = nrmV.clone().cross(tangent).normalize();
    const pts = [p.clone().addScaledVector(along, -s * 0.5), p.clone(), p.clone().addScaledVector(along, s * 0.5)];
    const nrm = [nrmV, nrmV, nrmV];
    const depth = Math.min(1, p.clone().sub(center).length() / 0.2);
    const k = 0.45 + depth * 0.55;
    addCard(B, pts, tangent, s, nrm, [k, k, k * 0.9], [k * 1.05, k * 1.05, k * 0.95], false);
  }
  return B.build();
}

export const ATLAS = { FOLIAGE_U, BARK_U0 };
