import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { mulberry32 } from './biome.js';

const woodMat = () => {
  const m = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.85 });
  patchMaterial(m, {
    fragment: [['#include <color_fragment>', `#include <color_fragment>
      { vec4 n = texture(uNoiseTex, vec2(vWPos.x + vWPos.z, vWPos.y) * vec2(0.6, 6.0));
        diffuseColor.rgb *= 0.65 + 0.6 * n.g; }`]],
  });
  return m;
};

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function textTexture(lines, w = 512, h = 128) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5a3d27'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = `rgba(30,18,8,${0.05 + Math.random() * 0.12})`;
    ctx.beginPath(); const y = Math.random() * h; ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.3, y + Math.random() * 6 - 3, w * 0.6, y + Math.random() * 6 - 3, w, y + Math.random() * 4 - 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#efe3c8';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${lines.length > 1 ? 40 : 54}px Georgia, serif`;
  lines.forEach((t, i) => ctx.fillText(t, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 46));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Props {
  constructor(hf, trail) {
    this.group = new THREE.Group();
    this.hf = hf;
    this.wood = woodMat();
    this.rockMat = rockMaterial();
    this.benches = [];
    this.pois = [];
    this.colliders = [];
    const pts = trail.points;
    const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
    const dirAt = (i) => { const a = at(i - 2), b = at(i + 2); const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
    const nearestIdx = (x, z) => { let bi = 0, bd = 1e18; pts.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - z) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
    const total = trail.dist[trail.dist.length - 1];
    const fmtKm = (m) => (m / 1000).toFixed(1) + ' km';

    // --- trailhead signpost
    const i0 = 6;
    const [sx, sz] = at(i0); const sd = dirAt(i0);
    const shoreIdx = nearestIdx(trail.shore.x, trail.shore.z);
    const ridgeIdx = nearestIdx(trail.ridge.x, trail.ridge.z);
    this.signpost(sx - sd[1] * 2.2, sz + sd[0] * 2.2, Math.atan2(sd[0], sd[1]), [
      ['Stillwater Lake', fmtKm(trail.dist[shoreIdx])],
      ['Larch Saddle', fmtKm(trail.dist[ridgeIdx])],
      ['Stillwater Peak', fmtKm(total)],
    ]);
    this.pois.push({ name: 'Stillwater Trailhead', sub: 'the path begins where the road ends', x: sx, z: sz, r: 30 });

    // --- lakeshore bench facing the water
    const L = WORLD.lake;
    const [lx, lz] = at(shoreIdx);
    const toLake = Math.atan2(L.x - lx, L.z - lz);
    const bx = lx + Math.sin(toLake) * 4, bz = lz + Math.cos(toLake) * 4;
    this.bench(bx, bz, toLake);
    // a little jetty and a rowboat off to the left of the bench
    {
      const fwx = Math.sin(toLake), fwz = Math.cos(toLake), rx = Math.cos(toLake), rz = -Math.sin(toLake);
      let sx = bx - rx * 16, sz = bz - rz * 16;
      for (let k = 0; k < 600 && hf.height(sx, sz) > WORLD.waterLevel + 0.2; k++) { sx += fwx; sz += fwz; }
      sx -= fwx * 3; sz -= fwz * 3;
      this.shoreBench = [bx, bz, 10];
      const deckY = WORLD.waterLevel + 0.7, len = 30, w = 2.6;
      this.jettyZone = [[sx, sz, 9], [sx + fwx * len * 0.5, sz + fwz * len * 0.5, 12], [sx + fwx * len, sz + fwz * len, 10]];
      for (let k = -2; k < len; k++) {
        const px = sx + fwx * (k + 0.5), pz = sz + fwz * (k + 0.5);
        const pl = box(w, 0.08, 0.9, 0, 0, 0); pl.rotateY(toLake); pl.translate(px, deckY + (k % 3 === 0 ? 0.01 : 0), pz);
        this._wood.push(pl);
        if (k % 3 === 0) for (const sd of [-1, 1]) {
          const ppx = px + rx * sd * w * 0.48, ppz = pz + rz * sd * w * 0.48;
          const gy = Math.min(hf.height(ppx, ppz), WORLD.waterLevel) - 1.5;
          const post = box(0.16, deckY + 0.5 - gy, 0.16, ppx, (deckY + 0.5 + gy) / 2, ppz);
          this._wood.push(post);
        }
      }
      // rowboat moored at the end
      const ex = sx + fwx * (len - 2) + rx * 2.4, ez = sz + fwz * (len - 2) + rz * 2.4;
      const hull = new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      hull.scale(1.1, 0.6, 2.7);
      const inner = new THREE.SphereGeometry(0.92, 18, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      inner.scale(1.0, 0.5, 2.5); inner.translate(0, 0.05, 0);
      inner.index && inner.setIndex(inner.index.array.slice().reverse ? Array.from(inner.index.array).reverse() : inner.index.array);
      const seat = box(1.4, 0.06, 0.3, 0, -0.15, 0);
      const seat2 = box(1.4, 0.06, 0.3, 0, -0.15, 0.9);
      const boat = new THREE.Group();
      const hullMat = new THREE.MeshStandardMaterial({ color: 0x3f6f8a, roughness: 0.8 }); patchMaterial(hullMat, {});
      const inMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.85, side: THREE.DoubleSide }); patchMaterial(inMat, {});
      const hm = new THREE.Mesh(hull, hullMat), im = new THREE.Mesh(inner, inMat), sm = new THREE.Mesh(mergeGeometries([seat, seat2]), this.wood);
      boat.add(hm, im, sm);
      boat.position.set(ex, WORLD.waterLevel + 0.12, ez);
      boat.rotation.y = toLake + 0.25;
      boat.rotation.z = 0.04;
      hm.castShadow = true;
      this.group.add(boat);
      this.colliders.push({ x: ex, z: ez, r: 1.2 });
    }
    this.pois.push({ name: 'Stillwater Lake', sub: 'still water holds the whole sky', x: lx, z: lz, r: 60 });

    // --- saddle viewpoint
    const [rx, rz] = at(ridgeIdx);
    const rd = dirAt(ridgeIdx);
    const look = Math.atan2(-(L.x - rx), -(L.z - rz)) + Math.PI;
    this.bench(rx - rd[1] * 3.5, rz + rd[0] * 3.5, look);
    this.cairn(rx + rd[1] * 3, rz - rd[0] * 3, 1.0, 5);
    this.pois.push({ name: 'Larch Saddle', sub: 'halfway is its own kind of summit', x: rx, z: rz, r: 45 });

    // --- summit
    const [ex, ez] = at(pts.length - 1);
    this.cairn(ex, ez, 2.2, 11);
    {
      const tl = Math.atan2(L.x - ex, L.z - ez);
      const fwx = Math.sin(tl), fwz = Math.cos(tl), rx = Math.cos(tl), rz = -Math.sin(tl);
      const bx0 = ex + fwx * 9, bz0 = ez + fwz * 9;
      const eye = this.ground(bx0, bz0) + 1.2;
      const pa = { x: bx0 + fwx * 5 - rx * 7, z: bz0 + fwz * 5 - rz * 7 };
      const pb = { x: bx0 + fwx * 16 + rx * 9, z: bz0 + fwz * 16 + rz * 9 };
      this.prayerFlags(ex, ez, pa, pb, eye + 3.2);
      const pc = { x: ex - fwx * 6 + rx * 10, z: ez - fwz * 6 + rz * 10 };
      this.prayerFlags(ex, ez, pb, pc, eye + 2.4);
      this.cairn(pa.x + 0.9, pa.z + 0.4, 1.1, 7);
      for (const [f, sd, sc, seed] of []) {
        const ox = bx0 + fwx * f + rx * sd, oz = bz0 + fwz * f + rz * sd;
        const g = rockGeometry(seed, 2, 0.75);
        g.scale(sc, sc, sc); g.rotateY(seed);
        g.translate(ox, this.ground(ox, oz) - sc * 0.15, oz);
        this._stones.push(g);
      }
      this.cairn(bx0 + fwx * 5 + rx * 2.8, bz0 + fwz * 5 + rz * 2.8, 1.3, 8);
      for (let k = 0; k < 5; k++) {
        const s2 = 0.5 + (k % 3) * 0.35;
        const ox = bx0 + fwx * (3.5 + k * 1.3) + rx * ((k % 2 ? 1 : -1) * (2.2 + k * 0.7));
        const oz = bz0 + fwz * (3.5 + k * 1.3) + rz * ((k % 2 ? 1 : -1) * (2.2 + k * 0.7));
        const g = rockGeometry(300 + k, 2, 0.55);
        g.scale(s2, s2, s2); g.rotateY(k * 2.1);
        g.translate(ox, Math.min(this.ground(ox, oz), this.ground(ox + 0.6, oz), this.ground(ox - 0.6, oz), this.ground(ox, oz + 0.6), this.ground(ox, oz - 0.6)) - s2 * 0.3, oz);
        this._stones.push(g);
      }
    }
    const toLakeS = Math.atan2(L.x - ex, L.z - ez);
    this.bench(ex + Math.sin(toLakeS) * 9, ez + Math.cos(toLakeS) * 9, toLakeS);
    // a scatter of lichen boulders framing the view
    for (let k = 0; k < 9; k++) {
      const a = toLakeS + (k - 4) * 0.28 + Math.sin(k * 7.1) * 0.1;
      const r = 14 + (k % 3) * 4 + Math.cos(k * 3.3) * 2;
      const bx2 = ex + Math.sin(a) * r, bz2 = ez + Math.cos(a) * r;
      const s = 0.7 + ((k * 37) % 10) / 10 * 1.4;
      const g = rockGeometry(200 + k, 2, 0.6);
      g.scale(s, s, s);
      g.rotateY(k * 1.7);
      g.translate(bx2, this.ground(bx2, bz2) - s * 0.25, bz2);
      this._stones.push(g);
      this.colliders.push({ x: bx2, z: bz2, r: s * 0.8 });
    }
    const sumH = Math.round(hf.height(ex, ez));
    this.pois.push({ name: 'Stillwater Peak', sub: `${sumH} m · the world, quietly, all at once`, x: ex, z: ez, r: 40 });
    this.summit = { x: ex, z: ez, h: sumH };

    // --- cairns along the way
    let next = 140;
    for (let i = 0; i < pts.length; i++) {
      if (trail.dist[i] < next) continue;
      next += 150 + (i % 7) * 12;
      if (trail.dist[i] > total - 60) break;
      const d = dirAt(i); const side = (i % 2 ? 1 : -1) * 2.3;
      this.cairn(pts[i][0] - d[1] * side, pts[i][1] + d[0] * side, 0.6 + (i % 3) * 0.12, 4 + (i % 3));
    }

    const woodGeo = mergeGeometries(this._wood);
    const wm = new THREE.Mesh(woodGeo, this.wood);
    wm.castShadow = true; wm.receiveShadow = true;
    this.group.add(wm);
    if (this._stones.length) {
      const sg = mergeGeometries(this._stones);
      const sm = new THREE.Mesh(sg, this.rockMat);
      sm.castShadow = true; sm.receiveShadow = true;
      this.group.add(sm);
    }
  }

  get _wood() { return this.__wood || (this.__wood = []); }
  get _stones() { return this.__stones || (this.__stones = []); }

  ground(x, z) { return this.hf.height(x, z); }

  signpost(x, z, ry, rows) {
    const y = this.ground(x, z) - 0.2;
    const post = box(0.14, 2.6, 0.14, 0, 1.3, 0);
    post.rotateY(ry); post.translate(x, y, z);
    this._wood.push(post.toNonIndexed ? post : post);
    rows.forEach(([name, dist], i) => {
      const tex = textTexture([name, dist]);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
      patchMaterial(mat, {});
      const g = new THREE.BoxGeometry(1.25, 0.32, 0.04);
      const board = new THREE.Mesh(g, [mat, mat, mat, mat, mat, mat]);
      const side = i % 2 === 0 ? 1 : -1;
      board.position.set(0.6 * side, 2.25 - i * 0.42, 0);
      board.rotation.y = (i - 1) * 0.35;
      const holder = new THREE.Group();
      holder.add(board);
      holder.position.set(x, y, z);
      holder.rotation.y = ry;
      board.castShadow = true;
      this.group.add(holder);
    });
    this.colliders.push({ x, z, r: 0.35 });
  }

  bench(x, z, ry) {
    const y = Math.max(this.ground(x - 0.7 * Math.cos(ry), z + 0.7 * Math.sin(ry)), this.ground(x + 0.7 * Math.cos(ry), z - 0.7 * Math.sin(ry))) - 0.05;
    const parts = [];
    for (let k = 0; k < 3; k++) parts.push(box(1.9, 0.06, 0.14, 0, 0.46, -0.16 + k * 0.16));
    parts.push(box(1.9, 0.14, 0.05, 0, 0.75, -0.27));
    parts.push(box(1.9, 0.14, 0.05, 0, 0.95, -0.29));
    for (const sx of [-0.8, 0.8]) {
      parts.push(box(0.1, 0.48, 0.1, sx, 0.22, -0.15));
      parts.push(box(0.1, 0.48, 0.1, sx, 0.22, 0.17));
      parts.push(box(0.08, 0.6, 0.08, sx, 0.75, -0.3));
      parts.push(box(0.1, 0.08, 0.5, sx, 0.4, 0.0));
    }
    // face direction ry (seat looks toward +z after rotation)
    const g = mergeGeometries(parts);
    g.rotateY(ry);
    g.translate(x, y, z);
    this._wood.push(g);
    this.benches.push({ x, z, y: y + 0.46, ry });
    this.colliders.push({ x, z, r: 0.8 });
  }

  cairn(x, z, scale = 1, count = 6) {
    const rnd = mulberry32(Math.floor(x * 13 + z * 7));
    let y = this.ground(x, z) - 0.05 * scale;
    let s = 0.55 * scale;
    for (let i = 0; i < count; i++) {
      const g = rockGeometry(Math.floor(rnd() * 1000), 1, 0.42);
      const ss = s * (0.85 + rnd() * 0.3);
      g.scale(ss, ss, ss);
      g.rotateY(rnd() * 6.28);
      const ox = (rnd() - 0.5) * 0.08 * scale, oz = (rnd() - 0.5) * 0.08 * scale;
      g.translate(x + ox, y + ss * 0.25, z + oz);
      this._stones.push(g);
      y += ss * 0.5;
      s *= 0.8;
    }
    this.colliders.push({ x, z, r: 0.6 * scale });
  }

  prayerFlags(cx, cz, pa, pb, topY) {
    // two poles and a sagging line of flags across the summit
    const a = pa || { x: cx - 9, z: cz + 4 }, b = pb || { x: cx + 7, z: cz - 6 };
    const ya = this.ground(a.x, a.z), yb = this.ground(b.x, b.z);
    const poleA = topY ? Math.max(3, topY - ya) : 5.2, poleB = topY ? Math.max(3, topY - yb) : 5.2;
    const poleH = poleA;
    this._wood.push(box(0.12, poleA, 0.12, a.x, ya + poleA / 2 - 0.2, a.z));
    this._wood.push(box(0.12, poleB, 0.12, b.x, yb + poleB / 2 - 0.2, b.z));
    const nFlags = 22;
    const pos = [], uv = [], fl = [], idx = [], uv2 = [];
    const cols = [[0.15, 0.35, 0.85], [0.95, 0.95, 0.92], [0.85, 0.18, 0.12], [0.12, 0.6, 0.25], [0.95, 0.78, 0.15]];
    const colorArr = [];
    const segU = 4, segV = 3;
    const A = new THREE.Vector3(a.x, ya + poleA - 0.3, a.z), B = new THREE.Vector3(b.x, yb + poleB - 0.3, b.z);
    const dir = B.clone().sub(A);
    const len = dir.length();
    dir.normalize();
    const fw0 = len / nFlags * 0.82, fh0 = 0.46;
    for (let f = 0; f < nFlags; f++) {
      const t0 = (f + 0.09) / nFlags;
      const base = idx.length ? pos.length / 3 : 0;
      const fw = fw0 * (0.8 + 0.25 * ((f * 7) % 3) / 2), fh = fh0 * (0.8 + 0.4 * ((f * 5) % 4) / 3);
      const c = cols[f % 5];
      for (let j = 0; j <= segV; j++) for (let i = 0; i <= segU; i++) {
        const u = i / segU, v = j / segV;
        const t = t0 + u * (fw / len);
        const sag = Math.sin(t * Math.PI) * 1.1;
        const p = A.clone().addScaledVector(dir, t * len);
        p.y -= sag + v * fh;
        pos.push(p.x, p.y, p.z);
        uv.push(u, v);
        fl.push(f * 1.7, v);
        uv2.push(u, v);
        colorArr.push(...c);
      }
      for (let j = 0; j < segV; j++) for (let i = 0; i < segU; i++) {
        const k = base + j * (segU + 1) + i;
        idx.push(k, k + 1, k + segU + 1, k + 1, k + segU + 2, k + segU + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aFlag', new THREE.Float32BufferAttribute(fl, 2));
    g.setAttribute('aUV2', new THREE.Float32BufferAttribute(uv2, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colorArr, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.8 });
    patchMaterial(mat, {
      uniforms: { uPerp: { value: perp } },
      vertexPars: 'attribute vec2 aFlag; attribute vec2 aUV2; uniform vec3 uPerp; varying vec2 vFUV; varying float vFlagId;',
      fragmentPars: 'varying vec2 vFUV; varying float vFlagId;',
      vertex: [['#include <begin_vertex>', `#include <begin_vertex>
        {
          float v = aFlag.y;
          float w = sin(uTime * 5.0 + aFlag.x + position.x * 2.0 + position.z * 2.0) * 0.5 + sin(uTime * 8.3 + aFlag.x * 2.3 + v * 3.0) * 0.25;
          transformed += uPerp * w * v * (0.18 + uWindStrength * 0.3);
          transformed.y += v * v * 0.05 * w;
          vFUV = aUV2; vFlagId = aFlag.x;
        }`]],
      fragment: [['#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vFUV;
          float border = step(0.08, q.x) * step(q.x, 0.92) * step(0.08, q.y) * step(q.y, 0.92);
          float kind = mod(floor(vFlagId * 0.6), 3.0);
          float ring = smoothstep(0.03, 0.0, abs(length((q - vec2(0.5, 0.45)) * vec2(1.0, 1.3)) - 0.2));
          vec2 dq = abs(q - vec2(0.5, 0.5));
          float diamond = smoothstep(0.03, 0.0, abs(dq.x + dq.y * 0.8 - 0.25));
          float wheel = smoothstep(0.03, 0.0, abs(length(q - 0.5) - 0.18)) + step(length(q - 0.5), 0.05);
          float motif = kind < 0.5 ? ring : kind < 1.5 ? diamond : wheel;
          float lines = step(0.5, fract(q.y * 7.0)) * step(0.66, q.y) * step(0.2, q.x) * step(q.x, 0.8) * 0.5;
          diffuseColor.rgb *= mix(0.72, 1.0, border) * (1.0 - 0.45 * max(motif, lines));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.88, 0.82), 0.12 + 0.18 * fract(vFlagId * 0.37));
          diffuseColor.rgb *= 0.92 + 0.12 * texture(uNoiseTex, q * 0.5 + vWPos.xz * 0.01).g;
        }`], ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { vec3 Vw = normalize(vWPos - cameraPosition);
          float back = pow(max(dot(Vw, uLightDir), 0.0), 3.0);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * back * 0.9 * w_sunVis; }`]],
    });
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    this.group.add(m);
    // rope
    const rope = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40; const p = A.clone().addScaledVector(dir, t * len); p.y -= Math.sin(t * Math.PI) * 1.1; rope.push(p);
    }
    const rg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rope), 60, 0.012, 4, false);
    const rm = new THREE.Mesh(rg, this.wood);
    this.group.add(rm);
  }

  collide(pos, radius = 0.35) {
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d = Math.hypot(dx, dz), rr = c.r + radius;
      if (d < rr && d > 1e-4) { pos.x = c.x + dx / d * rr; pos.z = c.z + dz / d * rr; }
    }
  }
}
