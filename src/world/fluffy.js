import * as THREE from 'three';
import { mulberry32 } from './biome.js';

// Stylized "fluffy" Ghibli/BotW painterly trees:
// - High-res 1024x1024 painterly leaf-cluster atlas (crisp even close-up)
// - Volumetric crown-dominant normals + per-vertex aCrown (coreAO, heightGrad, isFoliage)
// - Organic buttress root flare & branches tucked naturally inside lower foliage clumps
//
// Atlas layout: u [0, .74] leaf cluster card, u [.78, .88] solid foliage, u [.9, 1] bark.
const CARD_U = 0.74, SOLID_U = 0.83, BARK_U = 0.9;
// Options shared by the tree builders: lod 2 hero cards, 1 lighter cards, 0 smooth cores; lowPoly uses 20-face cores;
// sparse (lod 0) keeps every hero foliage clump as `cards` leaf cards only (default 9), for the mid-distance level:
// the hero silhouette at about a tenth of the hero cost.

export function fluffyAtlas() {
  const W = 1024, H = 1024;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(5);
  ctx.clearRect(0, 0, W, H);
  // subtle edge bleed background to prevent dark mip fringes
  ctx.fillStyle = 'rgba(180,205,145,0.01)'; ctx.fillRect(0, 0, W, H);
  const FW = W * CARD_U;

  const drawLeaf = (x, y, s, a, col) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.quadraticCurveTo(s * 0.66, -s * 0.18, 0, s);
    ctx.quadraticCurveTo(-s * 0.66, -s * 0.18, 0, -s);
    ctx.fill();
    ctx.restore();
  };

  // 1. Soft painterly organic sprig cluster base (irregular leafy silhouette — zero round disc or square card edges!)
  const deepTones = ['#bccfa9', '#c8dbb6', '#d2e2c2'];
  const midTones  = ['#dfecd2', '#eaf4de', '#f2f7e9'];
  const hiTones   = ['#f8fbf1', '#ffffff', '#fcfef6'];

  const drawPuff = (x, y, rx, ry, a, col) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // irregular billowing inner body built from overlapping soft leaf lobes (hides seams cleanly!)
  for (let i = 0; i < 190; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * 0.68;
    const lobe = 0.84 + 0.14 * Math.sin(a * 5 + 1.1) + 0.08 * Math.sin(a * 7 - 0.6);
    const x = FW / 2 + Math.cos(a) * rr * 0.37 * lobe * FW;
    const y = H / 2 + Math.sin(a) * rr * 0.37 * lobe * H;
    const s = 34 + rnd() * 28;
    const topBias = 1 - y / H;
    const palette = topBias > 0.52 ? midTones : deepTones;
    drawPuff(x, y, s, s * (0.76 + rnd() * 0.24), a + (rnd() - 0.5), palette[Math.floor(rnd() * palette.length)]);
  }
  // dense overlapping individual leaf sprigs forming a delicate, feathery Ghibli foliage silhouette!
  for (let i = 0; i < 820; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 0.42 + Math.pow(rnd(), 0.72) * 0.56;
    const lobe = 0.80 + 0.15 * Math.sin(a * 5 + 1.1) + 0.09 * Math.sin(a * 8 - 0.4) + 0.05 * Math.sin(a * 13);
    const r = rr * 0.46 * lobe;
    const x = FW / 2 + Math.cos(a) * r * FW, y = H / 2 + Math.sin(a) * r * H;
    const s = (rr > 0.78 ? 20 : 26) + rnd() * 18;
    const topBias = 1 - y / H;
    const palette = (rr > 0.82 && topBias > 0.35) || topBias > 0.66 ? hiTones : (topBias > 0.36 ? midTones : deepTones);
    // orient outer leaves fanning naturally outward like real leafy twigs
    const ang = a + Math.PI / 2 + (rnd() - 0.5) * 1.15;
    drawLeaf(x, y, s, ang, palette[Math.floor(rnd() * palette.length)]);
  }
  // luminous sunlit gouache leaf dabs crowning the upper-inner sprig
  for (let i = 0; i < 240; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * 0.70;
    const x = FW / 2 + Math.cos(a) * rr * 0.35 * FW;
    const y = H / 2 + Math.sin(a) * rr * 0.35 * H - H * 0.05;
    const s = 18 + rnd() * 16;
    drawLeaf(x, y, s, rnd() * 6.28, hiTones[Math.floor(rnd() * hiTones.length)]);
  }

  // 3. Solid foliage strip (subtle painterly leaf variation for inner clump cores)
  const sx = W * 0.78, sw = W * 0.1;
  ctx.fillStyle = '#dde8ce'; ctx.fillRect(sx, 0, sw, H);
  for (let i = 0; i < 260; i++) {
    drawLeaf(sx + rnd() * sw, rnd() * H, 12 + rnd() * 14, rnd() * 6.28, (rnd() < 0.45 ? deepTones : midTones)[Math.floor(rnd() * 3)]);
  }

  // 4. Crisp bark strip
  const bx = W * BARK_U;
  ctx.fillStyle = '#756252'; ctx.fillRect(bx, 0, W - bx, H);
  for (let i = 0; i < 360; i++) {
    ctx.strokeStyle = rnd() < 0.55 ? 'rgba(55,36,22,0.65)' : 'rgba(178,148,118,0.45)';
    ctx.lineWidth = 1.5 + rnd() * 4.5;
    const x = bx + rnd() * (W - bx), y = rnd() * H;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 6, y + 26 + rnd() * 75); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.crown = []; this.idx = []; }
  vert(x, y, z, n, u, v, c, cr = [1, 0.5, 1]) {
    this.pos.push(x, y, z); this.nor.push(n.x, n.y, n.z); this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.crown.push(cr[0], cr[1], cr[2]);
    return this.pos.length / 3 - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aCrown', new THREE.Float32BufferAttribute(this.crown, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function addTube(B, p0, p1, r0, r1, segs, col, k0 = 0.68, k1 = 1.0, flute = 0) {
  const axis = p1.clone().sub(p0);
  const len = axis.length();
  if (len < 1e-4) return;
  axis.normalize();
  const t1 = Math.abs(axis.y) < 0.9 ? V(0, 1, 0).cross(axis).normalize() : V(1, 0, 0).cross(axis).normalize();
  const t2 = axis.clone().cross(t1).normalize();
  const base = B.pos.length / 3;
  const rings = 4;
  for (let j = 0; j <= rings; j++) {
    const f = j / rings;
    const rBase = r0 + (r1 - r0) * f;
    const c = p0.clone().addScaledVector(axis, len * f);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      // flared organic root flutes near the bottom of the trunk
      const rootWave = flute > 0 ? 1 + flute * (1 - f) * (1 - f) * (0.55 * Math.cos(a * 5 + 0.4) + 0.35 * Math.sin(a * 3 - 0.8)) : 1;
      const r = rBase * rootWave;
      const n = t1.clone().multiplyScalar(Math.cos(a)).addScaledVector(t2, Math.sin(a));
      const k = k0 + (k1 - k0) * f;
      const vy = c.y + n.y * r;
      // aCrown: x = bark AO, y = local height (for trunk moss!), z = 0 (bark!)
      B.vert(c.x + n.x * r, vy, c.z + n.z * r, n, BARK_U + 0.01 + (i / segs) * (1 - BARK_U - 0.02), 0.05 + f * 0.9, [col[0] * k, col[1] * k, col[2] * k], [k, Math.max(0, vy), 0]);
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
  return verts;
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

// Indexed icosphere (shared corners) for the mid-level crown puffs: a quarter of the vertex work of the soup above.
function icoIndexed(detail) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const verts = [], idx = [], seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let k = seen.get(key);
    if (k === undefined) { k = verts.length; seen.set(key, k); verts.push(V(p.getX(i), p.getY(i), p.getZ(i))); }
    idx.push(k);
  }
  return { verts, idx };
}
// Index = puff detail: 0 (20 faces) for far mid cells, 1 (80 faces) for near ones where facets would show.
const MID_PUFF = [icoIndexed(0), icoIndexed(1)];

function crownMetrics(p, crownC, crownR) {
  const up = THREE.MathUtils.clamp((p.y - (crownC.y - crownR.y)) / (2 * crownR.y), 0, 1);
  const radial = V((p.x - crownC.x) / Math.max(crownR.x, 0.05), (p.y - crownC.y) / Math.max(crownR.y, 0.05), (p.z - crownC.z) / Math.max(crownR.x, 0.05)).length();
  const out = THREE.MathUtils.clamp(radial * 0.85, 0, 1);
  // deep interior AO gives sculpted 3D volume instead of flat cutouts!
  const ao = THREE.MathUtils.clamp(0.32 + 0.42 * out + 0.34 * up, 0.28, 1.08);
  return { up, out, ao };
}

function shadeAt(p, crownC, crownR, base, jitter) {
  const { up, out } = crownMetrics(p, crownC, crownR);
  const k = (0.56 + 0.34 * up + 0.18 * out) * jitter;
  return [base[0] * k, base[1] * k, base[2] * k];
}

function blobNormal(p, clumpC, crownC) {
  const a = p.clone().sub(clumpC).normalize();
  const b = p.clone().sub(crownC).normalize();
  // strong outward crown dome normal unifies overlapping leaf cards into soft billowing Ghibli cloud volumes (ZERO crumpled-paper creases!)
  return a.multiplyScalar(0.22).addScaledVector(b, 0.78).add(V(0, 0.24, 0)).normalize();
}

function addCore(B, c, r, crownC, crownR, base, jitter, verts, squash = 1) {
  const start = B.pos.length / 3;
  for (const v of verts) {
    // smooth tucked inner foliage core (NO jagged sine wobble poking outside leaf cards!)
    const p = V(c.x + v.x * r, c.y + v.y * r * squash, c.z + v.z * r);
    const n = blobNormal(p, c, crownC);
    const cm = crownMetrics(p, crownC, crownR);
    B.vert(p.x, p.y, p.z, n, 0.785 + 0.09 * (Math.atan2(v.z, v.x) / (2 * Math.PI) + 0.5), 0.5 + v.y * 0.045 + c.y * 0.3, shadeAt(p, crownC, crownR, base, jitter * 0.88), [cm.ao * 0.86, cm.up, 1]);
  }
  for (let i = start; i < B.pos.length / 3; i += 3) B.idx.push(i, i + 1, i + 2);
}

// One opaque round puff per clump, shaded with the crown-dome normals: the soft round silhouette and sunlit top
// of the hero crown at mid range, with no alpha-tested card edges.
function addPuff(B, c, r, crownC, crownR, base, jitter, squash, detail) {
  const start = B.pos.length / 3;
  const puff = MID_PUFF[detail];
  for (const v of puff.verts) {
    const p = V(c.x + v.x * r, c.y + v.y * r * squash, c.z + v.z * r);
    const cm = crownMetrics(p, crownC, crownR);
    B.vert(p.x, p.y, p.z, blobNormal(p, c, crownC), SOLID_U, 0.5, shadeAt(p, crownC, crownR, base, jitter), [cm.ao, cm.up, 1]);
  }
  for (const i of puff.idx) B.idx.push(start + i);
}

function addMidClump(B, rnd, o, c, r, crownC, crownR, base, jitter, squash = 1) {
  // Same clump layout as the hero level so the crown keeps its round silhouette; a few leaf cards per clump and no
  // core (a core shows between few cards as a dark flat patch).
  const start = B.pos.length / 3;
  // Puffs (or, without them, larger cards) close the gaps the missing hero cards leave, so the crown stays opaque.
  if (o.puffs !== undefined) addPuff(B, c, r * 0.98, crownC, crownR, base, jitter, squash, o.puffs);
  else addCards(B, rnd, c, r * 1.05, o.cards ?? 9, crownC, crownR, base, jitter, squash, 1.0);
  // With few cards the visible ones stand in for the hero's sunlit outer shell, so they get its pocket AO and tone
  // instead of the darker interior values a lone card would have.
  for (let i = start; i < B.pos.length / 3; i++) {
    B.crown[i * 3] = Math.min(1.08, B.crown[i * 3] + 0.18);
    for (let k = 0; k < 3; k++) B.col[i * 3 + k] *= 1.08;
  }
}

function addCards(B, rnd, c, r, n, crownC, crownR, base, jitter, squash = 1, cardK = 1) {
  for (let k = 0; k < n; k++) {
    // Fibonacci-jittered sphere directions so cards wrap 100% evenly around every puff (zero bare holes or stacked clumps!)
    const y0 = 1 - ((k + 0.5) / n) * 1.85;
    const rad0 = Math.sqrt(Math.max(0, 1 - y0 * y0));
    const phi = k * 2.39996 + rnd() * 0.45;
    const d = V(Math.cos(phi) * rad0 + (rnd() - 0.5) * 0.22, y0 + (rnd() - 0.5) * 0.22, Math.sin(phi) * rad0 + (rnd() - 0.5) * 0.22).normalize();
    const out = c.clone().sub(crownC); out.y = 0;
    if (out.lengthSq() > 1e-4) d.addScaledVector(out.normalize(), 0.25).normalize();
    const shell = 0.68 + rnd() * 0.16;
    const p = c.clone().add(V(d.x * r * shell, d.y * r * shell * squash, d.z * r * shell));
    // orient leaf cards mostly tangent to the outer puff dome so silhouettes read as soft layered foliage clouds (never spiky X-cards!)
    const facing = d.clone().add(V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.55)).normalize();
    const t1 = (Math.abs(facing.y) < 0.95 ? V(0, 1, 0) : V(1, 0, 0)).cross(facing).normalize();
    const t2 = facing.clone().cross(t1).normalize();
    const rot = rnd() * Math.PI * 2;
    const a1 = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot));
    const a2 = facing.clone().cross(a1).normalize();
    // smaller, crisper, richly varied painterly leaf-cluster sprigs (kills giant flat teal cards in forest.png!)
    const s = r * (0.58 + rnd() * 0.26) * cardK;
    const corners = [[-1, -1, 0, 0], [1, -1, CARD_U, 0], [-1, 1, 0, 1], [1, 1, CARD_U, 1]];
    const base0 = B.pos.length / 3;
    for (const [u, v, tu, tv] of corners) {
      const q = p.clone().addScaledVector(a1, u * s * 0.5).addScaledVector(a2, v * s * 0.5);
      const cm = crownMetrics(q, crownC, crownR);
      B.vert(q.x, q.y, q.z, blobNormal(q, c, crownC), tu, tv, shadeAt(q, crownC, crownR, base, jitter), [cm.ao, cm.up, 1]);
    }
    B.idx.push(base0, base0 + 1, base0 + 2, base0 + 1, base0 + 3, base0 + 2);
  }
}

/** Broadleaf tree (unit height). kind: 'oak' | 'round' | 'poplar' */
export function fluffyBroadleaf(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2;
  const kind = o.kind ?? 'oak';
  const base = o.color ?? [0.16, 0.42, 0.08];
  const bark = o.bark ?? [0.32, 0.21, 0.14];
  const tall = kind === 'poplar';
  const crownC = tall ? V(0, 0.62, 0) : kind === 'oak' ? V(0, 0.64, 0) : V(0, 0.66, 0);
  const crownR = tall ? V(0.18, 0.36, 0) : kind === 'round' ? V(0.35, 0.26, 0) : V(0.43, 0.25, 0);

  // sculpted gnarled cathedral oak trunk with organic root fluting & gentle twist (ZERO plain straight cylinders in forest.png!)
  const lean = V((rnd() - 0.5) * 0.075, 0, (rnd() - 0.5) * 0.075);
  const kink = V((rnd() - 0.5) * 0.042, 0, (rnd() - 0.5) * 0.042);
  const mid = V(lean.x * 0.45 + kink.x, 0.30, lean.z * 0.45 + kink.z);
  const top = crownC.clone().add(lean).add(V(0, tall ? -0.12 : -0.05, 0));
  addTube(B, V(0, -0.12, 0), V(lean.x * 0.14 + kink.x * 0.4, 0.13, lean.z * 0.14 + kink.z * 0.4), tall ? 0.042 : 0.048, tall ? 0.032 : 0.034, lod > 0 ? 10 : 4, bark, 0.56, 0.78, lod > 0 && !tall ? 0.24 : 0);
  addTube(B, V(lean.x * 0.14 + kink.x * 0.4, 0.13, lean.z * 0.14 + kink.z * 0.4), mid, tall ? 0.032 : 0.034, tall ? 0.022 : 0.024, lod > 0 ? 9 : 4, bark, 0.78, 0.88, lod > 0 && !tall ? 0.10 : 0);
  addTube(B, mid, top, tall ? 0.022 : 0.024, 0.010, lod > 0 ? 7 : 4, bark, 0.88, 0.94, 0);

  // 5 compact, grounded root knuckles hugging the soil cleanly (ZERO tall tripod legs sticking out on slopes!)
  if (lod === 2 && !tall) {
    for (let r = 0; r < 5; r++) {
      const ra = (r / 5) * Math.PI * 2 + rnd() * 0.55;
      const rootStart = V(Math.cos(ra) * 0.022, 0.048, Math.sin(ra) * 0.022);
      const rootMid = V(Math.cos(ra) * 0.044, 0.008, Math.sin(ra) * 0.044);
      const rootEnd = V(Math.cos(ra) * 0.064, -0.12, Math.sin(ra) * 0.064);
      addTube(B, rootStart, rootMid, 0.018, 0.014, 6, bark, 0.62, 0.52, 0);
      addTube(B, rootMid, rootEnd, 0.014, 0.007, 5, bark, 0.52, 0.42, 0);
    }
  }

  // multi-tiered asymmetric spreading Ghibli canopy clumps anchored solidly onto visible rising boughs (ZERO floating canopies!)
  const clumps = [];
  const n = tall ? 11 : kind === 'round' ? 12 : 15;
  for (let i = 0; i < n; i++) {
    let p;
    if (tall) {
      const f = i / (n - 1);
      const a = i * 2.4 + rnd() * 0.5;
      p = V(Math.cos(a) * 0.072, crownC.y - crownR.y * 0.78 + f * crownR.y * 1.68, Math.sin(a) * 0.072);
      clumps.push({ c: p, r: 0.11 + 0.058 * Math.sin(f * Math.PI) + rnd() * 0.025 });
    } else {
      const a = i * 2.39996 + rnd() * 0.42;
      const tier = i < 2 ? 2 : i < 7 ? 1 : 0; // top dome, mid spreading boughs, lifted overhanging skirt revealing real branches!
      const ring = tier === 2 ? 0.14 + rnd() * 0.16 : tier === 1 ? 0.46 + rnd() * 0.36 : 0.58 + rnd() * 0.34;
      const yOff = tier === 2 ? crownR.y * (0.50 + rnd() * 0.22)
                 : tier === 1 ? crownR.y * (0.06 + (rnd() - 0.5) * 0.34)
                 :              crownR.y * (-0.34 + (rnd() - 0.5) * 0.24);
      const asym = 0.85 + 0.30 * Math.sin(a + seed * 1.7);
      p = V(Math.cos(a) * crownR.x * ring * asym, crownC.y + yOff, Math.sin(a) * crownR.x * ring * asym);
      clumps.push({ c: p, r: (tier === 2 ? 0.152 : tier === 1 ? 0.160 : 0.142) + rnd() * 0.044 });
    }
  }
  for (let ci = 0; ci < clumps.length; ci++) {
    const cl = clumps[ci];
    const j = 0.88 + rnd() * 0.24;
    // 5 clearly visible gnarled primary boughs & secondary forks spreading upward from trunk right into lower & mid foliage clumps!
    if (lod >= 1 && !tall && ci >= 2 && ci < 7) {
      const y0 = 0.24 + (ci - 2) * 0.032;
      const startB = V(lean.x * (0.35 + y0), y0, lean.z * (0.35 + y0));
      const endB = cl.c.clone().lerp(V(0, cl.c.y - 0.04, 0), 0.14);
      const midB = startB.clone().lerp(endB, 0.48); midB.y += 0.025;
      addTube(B, startB, midB, 0.026, 0.018, lod === 2 ? 6 : 4, bark, 0.78, 0.72);
      addTube(B, midB, endB, 0.018, 0.010, lod === 2 ? 5 : 4, bark, 0.72, 0.62);
      if (lod === 2) {
        const subEnd = endB.clone().add(V((rnd() - 0.5) * 0.14, 0.08, (rnd() - 0.5) * 0.14));
        addTube(B, midB, subEnd, 0.013, 0.007, 4, bark, 0.70, 0.58);
      }
    }
    if (lod === 0) {
      if (o.sparse) addMidClump(B, rnd, o, cl.c, cl.r, crownC, crownR, base, j);
      else addCore(B, cl.c, cl.r * 1.05, crownC, crownR, base, j, o.lowPoly ? ICO0 : ICO);
    }
    else {
      addCore(B, cl.c, cl.r * 0.56, crownC, crownR, base, j, ICO);
      addCards(B, rnd, cl.c, cl.r * 1.08, lod === 2 ? 30 : 10, crownC, crownR, base, j);
    }
  }
  return B.build();
}

/** Stylized alpine spruce/pine or golden larch: full drooping painterly tiers. */
export function fluffyPine(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2;
  const base = o.color ?? [0.05, 0.22, 0.12];
  const bark = o.bark ?? [0.29, 0.22, 0.17];
  addTube(B, V(0, -0.06, 0), V(0, 0.94, 0), 0.042, 0.009, lod > 0 ? 7 : 4, bark, 0.6, 0.9, lod > 0 ? 0.18 : 0);
  const crownC = V(0, 0.54, 0), crownR = V(0.26, 0.44, 0);
  const tiers = 7;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = 0.25 + f * 0.69;
    const R = 0.25 * (1 - f * 0.80) + 0.026;
    const cnt = t === tiers - 1 ? 1 : Math.max(3, Math.round(6.5 - f * 3.2));
    for (let i = 0; i < cnt; i++) {
      const a = (i / cnt) * Math.PI * 2 + t * 1.15 + rnd() * 0.4;
      const droop = cnt === 1 ? 0 : -0.024 * (1 - f);
      const c = cnt === 1 ? V(0, y, 0) : V(Math.cos(a) * R * 0.56, y + droop + (rnd() - 0.5) * 0.02, Math.sin(a) * R * 0.56);
      const r = cnt === 1 ? 0.08 : R * 0.65 + 0.026;
      const j = 0.88 + rnd() * 0.24;
      if (lod === 0) {
        if (o.sparse) addMidClump(B, rnd, o, c, r, crownC, crownR, base, j, 0.66);
        else addCore(B, c, r * 1.06, crownC, crownR, base, j, o.lowPoly ? ICO0 : ICO, 0.66);
      }
      else {
        addCore(B, c, r * 0.56, crownC, crownR, base, j, ICO, 0.66);
        addCards(B, rnd, c, r * 1.08, lod === 2 ? 14 : 6, crownC, crownR, base, j, 0.66);
      }
    }
  }
  return B.build();
}

/** Graceful asymmetric golden alpine larch (painterly irregular cloud-clusters, NEVER stacked beehives!). */
export function fluffyLarch(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2;
  const base = o.color ?? [0.46, 0.34, 0.08];
  const bark = o.bark ?? [0.34, 0.24, 0.16];
  const lean = V((rnd() - 0.5) * 0.05, 0, (rnd() - 0.5) * 0.05);
  addTube(B, V(0, -0.06, 0), V(lean.x * 0.5, 0.52, lean.z * 0.5), 0.048, 0.022, lod > 0 ? 7 : 4, bark, 0.58, 0.88, lod > 0 ? 0.20 : 0);
  addTube(B, V(lean.x * 0.5, 0.52, lean.z * 0.5), V(lean.x, 0.86, lean.z), 0.022, 0.008, lod > 0 ? 6 : 4, bark, 0.85, 0.94);
  const crownC = V(0, 0.60, 0), crownR = V(0.28, 0.36, 0);
  const n = 13;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const a = i * 2.3999 + rnd() * 0.55;
    const rad = (1 - f * 0.72) * (0.14 + rnd() * 0.12);
    const y = 0.30 + f * 0.64 + (rnd() - 0.5) * 0.06;
    const c = V(Math.cos(a) * rad + lean.x * f, y, Math.sin(a) * rad + lean.z * f);
    const r = (0.14 - f * 0.055) + rnd() * 0.045;
    const j = 0.84 + rnd() * 0.28;
    const colMix = [base[0] * (0.90 + rnd() * 0.22), base[1] * (0.86 + rnd() * 0.22), base[2] * (0.82 + rnd() * 0.22)];
    if (lod === 0) {
      if (o.sparse) addMidClump(B, rnd, o, c, r, crownC, crownR, colMix, j, 0.88);
      else addCore(B, c, r * 1.06, crownC, crownR, colMix, j, o.lowPoly ? ICO0 : ICO, 0.88);
    }
    else {
      addCore(B, c, r * 0.56, crownC, crownR, colMix, j, ICO, 0.88);
      addCards(B, rnd, c, r * 1.08, lod === 2 ? 15 : 6, crownC, crownR, colMix, j, 0.88);
    }
  }
  return B.build();
}

export const FLUFFY = { CARD_U, SOLID_U, BARK_U };

/** Low rounded bush: lush clumps hugging the ground. */
export function fluffyBush(seed, o = {}) {
  const rnd = mulberry32(seed);
  const B = new Builder();
  const lod = o.lod ?? 2;
  const base = o.color ?? [0.13, 0.38, 0.07];
  const crownC = V(0, 0.42, 0), crownR = V(0.5, 0.42, 0);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
    const ring = i === 0 ? 0 : 0.28 + rnd() * 0.14;
    const c = V(Math.cos(a) * ring, i === 0 ? 0.54 : 0.32 + rnd() * 0.12, Math.sin(a) * ring);
    const r = (i === 0 ? 0.34 : 0.26) + rnd() * 0.06;
    const j = 0.88 + rnd() * 0.24;
    if (lod === 0) {
      if (o.sparse) addMidClump(B, rnd, o, c, r, crownC, crownR, base, j, 0.85);
      else addCore(B, c, r * 1.04, crownC, crownR, base, j, o.lowPoly ? ICO0 : ICO, 0.85);
    }
    else {
      addCore(B, c, r * 0.56, crownC, crownR, base, j, ICO, 0.85);
      addCards(B, rnd, c, r * 1.08, lod === 2 ? 14 : 6, crownC, crownR, base, j, 0.85);
    }
  }
  return B.build();
}
