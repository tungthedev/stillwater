import * as THREE from 'three';
import { mulberry32 } from './biome.js';

// Stylized "fluffy" trees: crowns are clusters of leaf clumps. Each clump is a
// solid core plus alpha leaf cards, all lit with spherical normals so crowns
// shade like soft painted blobs.
//
// Atlas: u [0, .74] leaf cluster card, u [.78, .88] solid foliage, u [.9, 1] bark.
const CARD_U = 0.74, SOLID_U = 0.83, BARK_U = 0.9;

export function fluffyAtlas() {
  const W = 512, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(5);
  ctx.fillStyle = 'rgba(200,215,170,0.012)'; ctx.fillRect(0, 0, W, H);
  const FW = W * CARD_U;
  const tones = ['#ffffff', '#fafcf5', '#f3f7ea', '#f7faef'];
  const leaf = (x, y, s, a, col) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.62, -s * 0.15, 0, s); ctx.quadraticCurveTo(-s * 0.62, -s * 0.15, 0, -s);
    ctx.fill();
    ctx.restore();
  };
  // a soft lobed cluster: dense centre, ragged leafy rim
  // solid lobed body
  ctx.fillStyle = '#f6f9ee';
  ctx.beginPath();
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    const lobe = 0.8 + 0.12 * Math.sin(a * 5 + 1.3) + 0.05 * Math.sin(a * 11);
    const x = FW / 2 + Math.cos(a) * 0.4 * lobe * FW, y = H / 2 + Math.sin(a) * 0.4 * lobe * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.fill();
  for (let i = 0; i < 520; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 0.78 + rnd() * 0.22;
    const lobe = 0.86 + 0.14 * Math.sin(a * 5 + 1.3) + 0.06 * Math.sin(a * 11);
    const r = rr * 0.47 * lobe;
    const x = FW / 2 + Math.cos(a) * r * FW, y = H / 2 + Math.sin(a) * r * H;
    const s = 12 + rnd() * 9;
    const shade = rr > 0.8 ? tones[Math.floor(rnd() * 3)] : tones[Math.floor(rnd() * tones.length)];
    leaf(x, y, s, a + Math.PI / 2 + (rnd() - 0.5) * 1.2, shade);
  }
  // leaf vein darkening so clusters read as many leaves
  for (let i = 0; i < 0; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.42;
    ctx.fillStyle = 'rgba(80,100,60,0.18)';
    leaf(FW / 2 + Math.cos(a) * r * FW, H / 2 + Math.sin(a) * r * H, 6 + rnd() * 4, rnd() * 6.28, 'rgba(70,95,50,0.16)');
  }
  // solid foliage strip
  const sx = W * 0.78, sw = W * 0.1;
  ctx.fillStyle = '#eef3e2'; ctx.fillRect(sx, 0, sw, H);
  for (let i = 0; i < 0; i++) leaf(sx + rnd() * sw, rnd() * H, 6 + rnd() * 6, rnd() * 6.28, tones[Math.floor(rnd() * tones.length)]);
  // bark strip
  const bx = W * BARK_U;
  ctx.fillStyle = '#7d6b5c'; ctx.fillRect(bx, 0, W - bx, H);
  for (let i = 0; i < 200; i++) {
    ctx.strokeStyle = rnd() < 0.5 ? 'rgba(70,48,32,0.6)' : 'rgba(170,140,110,0.45)';
    ctx.lineWidth = 1 + rnd() * 3;
    const x = bx + rnd() * (W - bx), y = rnd() * H;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y + 14 + rnd() * 40); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; }
  vert(x, y, z, n, u, v, c) {
    this.pos.push(x, y, z); this.nor.push(n.x, n.y, n.z); this.uv.push(u, v); this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function addTube(B, p0, p1, r0, r1, segs, col, k0 = 0.7, k1 = 1.0) {
  const axis = p1.clone().sub(p0);
  const len = axis.length();
  axis.normalize();
  const t1 = Math.abs(axis.y) < 0.9 ? V(0, 1, 0).cross(axis).normalize() : V(1, 0, 0).cross(axis).normalize();
  const t2 = axis.clone().cross(t1).normalize();
  const base = B.pos.length / 3;
  const rings = 3;
  for (let j = 0; j <= rings; j++) {
    const f = j / rings;
    const r = r0 + (r1 - r0) * f;
    const c = p0.clone().addScaledVector(axis, len * f);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const n = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
      const k = k0 + (k1 - k0) * f;
      B.vert(c.x + n.x * r, c.y + n.y * r, c.z + n.z * r, n, BARK_U + 0.01 + (i / segs) * (1 - BARK_U - 0.02), 0.05 + f * 0.9, [col[0] * k, col[1] * k, col[2] * k]);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
    const a = base + j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
    B.idx.push(a, c, b, b, c, d);
  }
}

const ICO = (() => {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const verts = [];
  for (let i = 0; i < p.count; i++) verts.push(V(p.getX(i), p.getY(i), p.getZ(i)));
  return verts; // non-indexed triangle list
})();
const ICO2 = (() => {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  const verts = [];
  for (let i = 0; i < p.count; i++) verts.push(V(p.getX(i), p.getY(i), p.getZ(i)));
  return verts;
})();
const ICO0 = (() => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  const verts = [];
  for (let i = 0; i < p.count; i++) verts.push(V(p.getX(i), p.getY(i), p.getZ(i)));
  return verts;
})();

function shadeAt(p, crownC, crownR, base, jitter) {
  const up = THREE.MathUtils.clamp((p.y - (crownC.y - crownR.y)) / (2 * crownR.y), 0, 1);
  const out = THREE.MathUtils.clamp(V((p.x - crownC.x) / crownR.x, 0, (p.z - crownC.z) / crownR.x).length(), 0, 1);
  const k = (0.5 + 0.38 * up + 0.22 * out) * jitter;
  return [base[0] * k, base[1] * k, base[2] * k];
}
function blobNormal(p, clumpC, crownC) {
  const a = p.clone().sub(clumpC).normalize();
  const b = p.clone().sub(crownC).normalize();
  return a.multiplyScalar(0.35).addScaledVector(b, 0.65).add(V(0, 0.12, 0)).normalize();
}

function addCore(B, c, r, crownC, crownR, base, jitter, verts, squash = 1) {
  const start = B.pos.length / 3;
  for (const v of verts) {
    const wob = 1 + 0.12 * Math.sin(v.x * 7.1 + v.y * 5.3 + c.x * 31) ;
    const p = V(c.x + v.x * r * wob, c.y + v.y * r * squash * wob, c.z + v.z * r * wob);
    const n = blobNormal(p, c, crownC);
    B.vert(p.x, p.y, p.z, n, 0.785 + 0.09 * (Math.atan2(v.z, v.x) / (2 * Math.PI) + 0.5), 0.5 + v.y * 0.045 + c.y * 0.3, shadeAt(p, crownC, crownR, base, jitter * 0.92));
  }
  for (let i = start; i < B.pos.length / 3; i += 3) B.idx.push(i, i + 1, i + 2);
}

function addCards(B, rnd, c, r, n, crownC, crownR, base, jitter, squash = 1) {
  for (let k = 0; k < n; k++) {
    // point on the clump surface, biased up & outward
    let d;
    do { d = V(rnd() * 2 - 1, rnd() * 2 - 0.6, rnd() * 2 - 1); } while (d.lengthSq() > 1 || d.lengthSq() < 0.05);
    d.normalize();
    const out = c.clone().sub(crownC); out.y = 0;
    if (out.lengthSq() > 1e-4) d.addScaledVector(out.normalize(), 0.35).normalize();
    const p = c.clone().add(V(d.x * r * 0.82, d.y * r * 0.82 * squash, d.z * r * 0.82));
    const facing = d.clone().add(V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(1.1)).normalize();
    const t1 = (Math.abs(facing.y) < 0.95 ? V(0, 1, 0) : V(1, 0, 0)).cross(facing).normalize();
    const t2 = facing.clone().cross(t1).normalize();
    const rot = rnd() * Math.PI * 2;
    const a1 = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot));
    const a2 = facing.clone().cross(a1).normalize();
    const s = r * (0.8 + rnd() * 0.35);
    const corners = [[-1, -1, 0, 0], [1, -1, CARD_U, 0], [-1, 1, 0, 1], [1, 1, CARD_U, 1]];
    const base0 = B.pos.length / 3;
    for (const [u, v, tu, tv] of corners) {
      const q = p.clone().addScaledVector(a1, u * s * 0.5).addScaledVector(a2, v * s * 0.5);
      B.vert(q.x, q.y, q.z, blobNormal(q, c, crownC), tu, tv, shadeAt(q, crownC, crownR, base, jitter));
    }
    B.idx.push(base0, base0 + 1, base0 + 2, base0 + 1, base0 + 3, base0 + 2);
  }
}

/** Broadleaf tree (unit height). kind: 'oak' | 'round' | 'poplar' */
export function fluffyBroadleaf(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2; // 2 hi, 1 mid (cores + few cards), 0 low (cores ico0)
  const kind = o.kind ?? 'oak';
  const base = o.color ?? [0.16, 0.42, 0.08];
  const bark = o.bark ?? [0.34, 0.27, 0.22];
  const tall = kind === 'poplar';
  const crownC = tall ? V(0, 0.6, 0) : V(0, 0.64, 0);
  const crownR = tall ? V(0.17, 0.36, 0) : kind === 'round' ? V(0.3, 0.26, 0) : V(0.34, 0.25, 0);
  // trunk
  const lean = V((rnd() - 0.5) * 0.06, 0, (rnd() - 0.5) * 0.06);
  const top = crownC.clone().add(lean).add(V(0, tall ? -0.18 : -0.16, 0));
  addTube(B, V(0, -0.05, 0), V(lean.x * 0.08, 0.05, lean.z * 0.08), 0.085, 0.05, lod > 0 ? 8 : 4, bark, 0.62, 0.7);
  addTube(B, V(lean.x * 0.08, 0.05, lean.z * 0.08), V(lean.x * 0.4, 0.3, lean.z * 0.4), 0.05, 0.036, lod > 0 ? 8 : 4, bark, 0.7, 0.86);
  addTube(B, V(lean.x * 0.4, 0.3, lean.z * 0.4), top, 0.036, 0.018, lod > 0 ? 7 : 4, bark, 0.86, 0.95);
  // clumps
  const clumps = [];
  const n = tall ? 9 : kind === 'round' ? 8 : 10;
  for (let i = 0; i < n; i++) {
    let p;
    if (tall) {
      const f = i / (n - 1);
      const a = rnd() * 6.28;
      p = V(Math.cos(a) * 0.06, crownC.y - crownR.y * 0.8 + f * crownR.y * 1.7, Math.sin(a) * 0.06);
      clumps.push({ c: p, r: 0.1 + 0.05 * Math.sin(f * Math.PI) + rnd() * 0.02 });
    } else {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
      const ring = i === 0 ? 0 : 0.55 + rnd() * 0.4;
      p = V(Math.cos(a) * crownR.x * ring, crownC.y + (i === 0 ? crownR.y * 0.45 : (rnd() - 0.45) * crownR.y * 1.1), Math.sin(a) * crownR.x * ring);
      clumps.push({ c: p, r: (kind === 'round' ? 0.15 : 0.14) + rnd() * 0.05 });
    }
  }
  for (const cl of clumps) {
    const j = 0.9 + rnd() * 0.2;
    // branch to clump
    if (lod === 2 && !tall && cl.c.y < crownC.y) { const tip = cl.c.clone().lerp(V(0, cl.c.y, 0), 0.35); tip.y -= 0.03; const y0 = 0.34 + rnd() * 0.06; addTube(B, V(lean.x * (0.4 + y0), y0, lean.z * (0.4 + y0)), tip, 0.02, 0.009, 5, bark, 0.85, 0.75); }
    if (lod === 0) addCore(B, cl.c, cl.r * 1.05, crownC, crownR, base, j, o.lowPoly ? ICO0 : ICO);
    else {
      addCore(B, cl.c, cl.r * 0.74, crownC, crownR, base, j, lod === 2 ? ICO2 : ICO);
      addCards(B, rnd, cl.c, cl.r * 1.08, lod === 2 ? 13 : 5, crownC, crownR, base, j);
    }
  }
  return B.build();
}

/** Stylized pine: tiers of flattened blobs. */
export function fluffyPine(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2;
  const base = o.color ?? [0.05, 0.22, 0.11];
  const bark = [0.3, 0.24, 0.2];
  addTube(B, V(0, -0.05, 0), V(0, 0.95, 0), 0.03, 0.008, lod > 0 ? 7 : 4, bark);
  const crownC = V(0, 0.55, 0), crownR = V(0.24, 0.42, 0);
  const tiers = 6;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = 0.2 + f * 0.72;
    const R = 0.23 * (1 - f * 0.78) + 0.02;
    const cnt = t === tiers - 1 ? 1 : Math.max(3, Math.round(6 - f * 3));
    for (let i = 0; i < cnt; i++) {
      const a = (i / cnt) * Math.PI * 2 + t * 1.1 + rnd() * 0.4;
      const c = cnt === 1 ? V(0, y, 0) : V(Math.cos(a) * R * 0.55, y + (rnd() - 0.5) * 0.02, Math.sin(a) * R * 0.55);
      const r = cnt === 1 ? 0.07 : R * 0.6 + 0.02;
      const j = 0.9 + rnd() * 0.2;
      if (lod === 0) addCore(B, c, r * 1.05, crownC, crownR, base, j, o.lowPoly ? ICO0 : ICO, 0.6);
      else {
        addCore(B, c, r * 0.82, crownC, crownR, base, j, ICO, 0.6);
        addCards(B, rnd, c, r, lod === 2 ? 9 : 4, crownC, crownR, base, j, 0.6);
      }
    }
  }
  return B.build();
}

export const FLUFFY = { CARD_U, SOLID_U, BARK_U };

/** Low rounded bush: a few clumps hugging the ground. */
export function fluffyBush(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2;
  const base = o.color ?? [0.13, 0.38, 0.07];
  const crownC = V(0, 0.42, 0), crownR = V(0.5, 0.42, 0);
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
    const ring = i === 0 ? 0 : 0.28 + rnd() * 0.12;
    const c = V(Math.cos(a) * ring, i === 0 ? 0.55 : 0.32 + rnd() * 0.12, Math.sin(a) * ring);
    const r = (i === 0 ? 0.34 : 0.26) + rnd() * 0.06;
    const j = 0.9 + rnd() * 0.2;
    if (lod === 0) addCore(B, c, r * 1.05, crownC, crownR, base, j, o.lowPoly ? ICO0 : ICO, 0.85);
    else {
      addCore(B, c, r * 0.8, crownC, crownR, base, j, ICO, 0.85);
      addCards(B, rnd, c, r, lod === 2 ? 10 : 4, crownC, crownR, base, j, 0.85);
    }
  }
  return B.build();
}
