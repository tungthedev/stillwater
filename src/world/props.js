import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { mulberry32 } from './biome.js';
import { LAYER_REFLECT } from './water.js';

const woodMat = () => {
  const m = new THREE.MeshStandardMaterial({ color: 0x6e4b30, roughness: 0.85 });
  patchMaterial(m, {
    fragment: [
      ['#include <color_fragment>', `#include <color_fragment>
        { vec4 n = texture(uNoiseTex, vec2(vWPos.x + vWPos.z, vWPos.y) * vec2(0.6, 6.0));
          diffuseColor.rgb *= 0.65 + 0.6 * n.g; }`],
      ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * w_warmSpill(vWPos) * 0.85;`],
    ],
  });
  return m;
};

function box(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

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

// Crisp storybook wooden trailhead signpost (light weathered cream cedar plank with bold dark carved serif lettering -> 5x sharper readability!)
function textTexture(lines, w = 640, h = 160) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f0ddb8'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 65; i++) {
    ctx.strokeStyle = `rgba(110,74,38,${0.05 + Math.random() * 0.11})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); const y = Math.random() * h; ctx.moveTo(0, y);
    ctx.bezierCurveTo(w * 0.3, y + Math.random() * 6 - 3, w * 0.6, y + Math.random() * 6 - 3, w, y + Math.random() * 4 - 2);
    ctx.stroke();
  }
  // dark walnut carved border frame
  ctx.strokeStyle = '#5c3b1e';
  ctx.lineWidth = 7;
  ctx.strokeRect(7, 7, w - 14, h - 14);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(255,248,232,0.55)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  lines.forEach((t, i) => {
    ctx.fillStyle = i === 0 ? '#231308' : '#4a2b13';
    ctx.font = i === 0 ? '700 60px Georgia, serif' : '700 42px Georgia, serif';
    ctx.fillText(t, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 54);
  });
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

    // --- trailhead signpost (placed cleanly to the right of the trailhead so it NEVER blocks the cottage door!)
    const i0 = 4;
    const [sx, sz] = at(i0); const sd = dirAt(i0);
    const shoreIdx = nearestIdx(trail.shore.x, trail.shore.z);
    const ridgeIdx = nearestIdx(trail.ridge.x, trail.ridge.z);
    this.signpost(sx - sd[1] * 1.85, sz + sd[0] * 1.85, Math.atan2(sd[0], sd[1]) - 0.18, [
      ['Stillwater Lake', fmtKm(trail.dist[shoreIdx])],
      ['Larch Saddle', fmtKm(trail.dist[ridgeIdx])],
      ['Stillwater Peak', fmtKm(total)],
    ]);
    this.pois.push({ name: 'Stillwater Trailhead', sub: 'the path begins where the road ends', x: sx, z: sz, r: 30 });

    // --- lakeshore bench, rustic pier with lantern, detailed rowboat & lakeside foreground dressing!
    const L = WORLD.lake;
    const [lx, lz] = at(shoreIdx);
    const toLake = Math.atan2(L.x - lx, L.z - lz);
    const bx = lx + Math.sin(toLake) * 4, bz = lz + Math.cos(toLake) * 4;
    this.bench(bx, bz, toLake);
    {
      const fwx = Math.sin(toLake), fwz = Math.cos(toLake), rx = Math.cos(toLake), rz = -Math.sin(toLake);
      let jx = bx - rx * 14, jz = bz - rz * 14;
      for (let k = 0; k < 600 && hf.height(jx, jz) > WORLD.waterLevel + 0.2; k++) { jx += fwx; jz += fwz; }
      jx -= fwx * 4; jz -= fwz * 4;
      this.shoreBench = [bx, bz, 10];
      const deckY = WORLD.waterLevel + 0.78, len = 36, w = 3.2;
      this.jettyZone = [[jx, jz, 10], [jx + fwx * len * 0.5, jz + fwz * len * 0.5, 13], [jx + fwx * len, jz + fwz * len, 12]];
      for (let k = -3; k < len; k++) {
        const px = jx + fwx * (k + 0.5), pz = jz + fwz * (k + 0.5);
        const pl = box(w, 0.10, 0.92, 0, 0, 0); pl.rotateY(toLake); pl.translate(px, deckY + (k % 3 === 0 ? 0.015 : 0), pz);
        this._wood.push(pl);
        if (k % 3 === 0 || k === len - 1) for (const s of [-1, 1]) {
          const ppx = px + rx * s * w * 0.48, ppz = pz + rz * s * w * 0.48;
          const gy = Math.min(hf.height(ppx, ppz), WORLD.waterLevel) - 1.6;
          const topOff = (k === len - 1 || k % 9 === 0) ? 0.85 : 0.45;
          const post = box(0.22, deckY + topOff - gy, 0.22, ppx, (deckY + topOff + gy) / 2, ppz);
          this._wood.push(post);
        }
      }
      // pier lantern post at the end of the jetty!
      const lpx = jx + fwx * (len - 0.5) - rx * w * 0.48, lpz = jz + fwz * (len - 0.5) - rz * w * 0.48;
      this._wood.push(box(0.18, 2.3, 0.18, lpx, deckY + 1.15, lpz));
      this._wood.push(box(0.7, 0.10, 0.10, lpx + rx * 0.28, deckY + 2.25, lpz + rz * 0.28, toLake));
      const jLantern = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.36, 0.28), new THREE.MeshBasicMaterial({ color: 0xffd080 }));
      jLantern.position.set(lpx + rx * 0.55, deckY + 1.98, lpz + rz * 0.55);
      jLantern.layers.enable(LAYER_REFLECT);
      this.group.add(jLantern);

      // detailed storybook painted wooden rowboat with oars moored beside the pier!
      const ex = jx + fwx * (len - 3.5) + rx * 3.8, ez = jz + fwz * (len - 3.5) + rz * 3.8;
      const hull = new THREE.SphereGeometry(1, 20, 9, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      hull.scale(1.55, 0.82, 3.85);
      const inner = new THREE.SphereGeometry(0.92, 20, 9, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
      inner.scale(1.42, 0.70, 3.60); inner.translate(0, 0.06, 0);
      if (inner.index) inner.setIndex(Array.from(inner.index.array).reverse());
      const seat1 = box(2.1, 0.08, 0.42, 0, -0.18, -0.4);
      const seat2 = box(2.0, 0.08, 0.42, 0, -0.18, 1.15);
      const seatBow = box(1.3, 0.08, 0.65, 0, -0.14, 2.45);
      // pair of wooden oars resting across the seats
      const oar1 = box(0.08, 0.06, 3.2, 0.35, -0.06, 0.4, 0.18);
      const oar2 = box(0.08, 0.06, 3.2, -0.35, -0.06, 0.2, -0.12);
      const boat = new THREE.Group();
      const hullMat = new THREE.MeshStandardMaterial({ color: 0xb84a36, roughness: 0.72 }); patchMaterial(hullMat, {});
      const trimMat = new THREE.MeshStandardMaterial({ color: 0xf0e4c8, roughness: 0.78 }); patchMaterial(trimMat, {});
      const inMat = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.85, side: THREE.DoubleSide }); patchMaterial(inMat, {});
      // cream gunwale ring along boat rim
      const rimG = new THREE.TorusGeometry(1.0, 0.065, 8, 28);
      rimG.rotateX(Math.PI / 2); rimG.scale(1.52, 1.0, 3.78);
      const hm = new THREE.Mesh(hull, hullMat);
      const im = new THREE.Mesh(inner, inMat);
      const rm = new THREE.Mesh(rimG, trimMat);
      const sm = new THREE.Mesh(mergeGeometries([seat1, seat2, seatBow, oar1, oar2]), this.wood);
      for (const part of [hm, im, rm, sm]) part.layers.enable(LAYER_REFLECT);
      boat.add(hm, im, rm, sm);
      boat.position.set(ex, WORLD.waterLevel + 0.16, ez);
      boat.rotation.y = toLake + 0.35;
      boat.rotation.z = 0.04;
      hm.castShadow = true;
      this.group.add(boat);
      this.colliders.push({ x: ex, z: ez, r: 1.8 });

      // natural shoreline dressing in the lower-right foreground headland of the lake bench view (-rx is camera RIGHT!)
      const lakeRocks = [
        [24, 16, 1.9], [28, 13, 1.2], [32, 21, 2.4], [20, 23, 1.4],
        [44, 26, 2.2], [48, 22, 1.3], [58, 16, 1.8], [38, 10, 1.3],
      ];
      for (let i = 0; i < lakeRocks.length; i++) {
        const [f, sd, sc] = lakeRocks[i];
        const ox = bx + fwx * f - rx * sd, oz = bz + fwz * f - rz * sd;
        const g = rockGeometry(1600 + i, 2, 0.62);
        g.scale(sc * 1.2, sc * 0.78, sc); g.rotateY(i * 1.9);
        g.translate(ox, this.ground(ox, oz) - sc * 0.22, oz);
        this._stones.push(g);
      }
      // weathered driftwood log resting on the lower-right lakeside lawn (camera RIGHT = -rx!)
      const dlx = bx + fwx * 22 - rx * 14, dlz = bz + fwz * 22 - rz * 14;
      const dlog = new THREE.CylinderGeometry(0.24, 0.34, 5.2, 9);
      dlog.rotateZ(Math.PI / 2); dlog.rotateY(toLake + 0.55);
      dlog.translate(dlx, this.ground(dlx, dlz) + 0.16, dlz);
      this._wood.push(dlog);
    }
    this.pois.push({ name: 'Stillwater Lake', sub: 'still water holds the whole sky', x: lx, z: lz, r: 60 });

    // --- saddle viewpoint
    const [rx, rz] = at(ridgeIdx);
    const rd = dirAt(ridgeIdx);
    const look = Math.atan2(-(L.x - rx), -(L.z - rz)) + Math.PI;
    this.bench(rx - rd[1] * 3.5, rz + rd[0] * 3.5, look);
    this.cairn(rx + rd[1] * 3, rz - rd[0] * 3, 1.0, 5);
    // grounded alpine verge stones & weathered root hugging Larch Saddle clearing border (grounds the dirt path organically!)
    for (const [fS, latS, sxS, syS, szS, sdS] of [
      [3.6, -2.2, 0.62, 0.34, 0.52, 411],
      [5.2, -3.4, 0.44, 0.26, 0.38, 412],
      [2.8,  2.8, 0.56, 0.32, 0.48, 413],
      [6.4,  1.6, 0.48, 0.28, 0.42, 414],
    ]) {
      const fxS = Math.sin(look), fzS = Math.cos(look), lxS = fzS, lzS = -fxS;
      const sx0 = rx - rd[1] * 3.5 + fxS * fS + lxS * latS;
      const sz0 = rz + rd[0] * 3.5 + fzS * fS + lzS * latS;
      const gS = rockGeometry(sdS, 2, 0.62);
      gS.scale(sxS, syS, szS); gS.rotateY(sdS * 1.4);
      gS.translate(sx0, this.ground(sx0, sz0) - syS * 0.22, sz0);
      this._stones.push(gS);
    }
    this.pois.push({ name: 'Larch Saddle', sub: 'halfway is its own kind of summit', x: rx, z: rz, r: 45 });

    // --- summit: unforgettable foreground composition (rooted granite crag + hero cairn in lower-left, alpine flowers & dynamic diagonal prayer flags!)
    const [ex, ez] = at(pts.length - 1);
    this.cairn(ex, ez, 2.2, 11);
    {
      const tl = Math.atan2(L.x - ex, L.z - ez);
      // fwx,fwz = camera forward; rvx,rvz = camera LEFT!
      const fwx = Math.sin(tl), fwz = Math.cos(tl), rvx = Math.cos(tl), rvz = -Math.sin(tl);
      const bx0 = ex + fwx * 9, bz0 = ez + fwz * 9;
      const eye = this.ground(bx0, bz0) + 1.25;

      // Dynamic asymmetric diagonal prayer flag poles (pLeft closer & higher -> pRight further & lower!)
      const pLeft  = { x: bx0 + fwx * 8.4  + rvx * 5.6,  z: bz0 + fwz * 8.4  + rvz * 5.6 };
      const pRight = { x: bx0 + fwx * 15.0 - rvx * 10.6, z: bz0 + fwz * 15.0 - rvz * 10.6 };
      const pMidR  = { x: bx0 + fwx * 11.2 - rvx * 11.4, z: bz0 + fwz * 11.2 - rvz * 11.4 };
      const pBack  = { x: bx0 - fwx * 3.5  + rvx * 7.8,  z: bz0 - fwz * 3.5  + rvz * 7.8 };

      // 3 sweeping diagonal fluttering prayer flag catenaries cleanly framing the open blue sky!
      this.prayerFlags(ex, ez, pLeft, pRight, [eye + 3.55, eye + 2.05], 22, 1.65, 0.44);
      this.prayerFlags(ex, ez, pLeft, pMidR,  [eye + 2.85, eye + 1.45], 16, 1.25, 0.36);
      this.prayerFlags(ex, ez, pBack, pLeft,  [eye + 3.20, eye + 3.45], 12, 0.95, 0.38);

      // stone cairn bases anchoring the poles
      this.cairn(pLeft.x, pLeft.z, 1.45, 7);
      this.cairn(pRight.x, pRight.z, 1.4, 7);

      // Compact mossy alpine boulder nest & hero stacked summit cairn on lower-left crest + sculptural foreground ledge rocks on lower-right!
      {
        const ox = bx0 + fwx * 3.8 + rvx * 2.55, oz = bz0 + fwz * 3.8 + rvz * 2.55;
        const gy = this.ground(ox, oz);
        for (const [dxR, dzR, sxR, syR, szR, sdR] of [
          [ 0.0,  0.0,  0.76, 0.52, 0.72, 304],
          [ 0.56, 0.22, 0.48, 0.38, 0.44, 306],
          [-0.48, 0.28, 0.44, 0.34, 0.42, 307],
        ]) {
          const rx0 = ox + rvx * dxR + fwx * dzR, rz0 = oz + rvz * dxR + fwz * dzR;
          const g = rockGeometry(sdR, 2, 0.62);
          g.scale(sxR, syR, szR);
          g.rotateY(sdR * 1.3);
          g.translate(rx0, this.ground(rx0, rz0) - syR * 0.18, rz0);
          this._stones.push(g);
        }
        this.cairnAtY(ox, gy + 0.24, oz, 0.86, 6);
        // natural angular alpine summit granite outcrops grounding the lower-right foreground edge (replaces bare blurry dirt corner!)
        for (const [latR, fwdR, sxR, syR, szR, sdR] of [
          [-2.35, 3.6, 0.92, 0.46, 0.74, 311],
          [-3.25, 4.4, 0.68, 0.42, 0.62, 312],
          [-1.55, 4.9, 0.56, 0.32, 0.50, 313],
          [-3.90, 5.4, 0.84, 0.50, 0.68, 314],
        ]) {
          const rx0 = bx0 + rvx * latR + fwx * fwdR, rz0 = bz0 + rvz * latR + fwz * fwdR;
          const g = rockGeometry(sdR, 2, 0.58);
          g.scale(sxR, syR, szR);
          g.rotateY(sdR * 1.7);
          g.rotateZ((sdR % 2 ? 1 : -1) * 0.09);
          g.translate(rx0, this.ground(rx0, rz0) - syR * 0.26, rz0);
          this._stones.push(g);
        }
      }
    }
    const toLakeS = Math.atan2(L.x - ex, L.z - ez);
    this.bench(ex + Math.sin(toLakeS) * 9, ez + Math.cos(toLakeS) * 9, toLakeS);
    // broader scatter of lichen boulders around the summit crown
    for (let k = 0; k < 9; k++) {
      const a = toLakeS + (k - 4) * 0.28 + Math.sin(k * 7.1) * 0.1;
      const r = 16 + (k % 3) * 4 + Math.cos(k * 3.3) * 2;
      const bx2 = ex + Math.sin(a) * r, bz2 = ez + Math.cos(a) * r;
      const s = 0.8 + ((k * 37) % 10) / 10 * 1.5;
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

    const woodGeo = mergeGeometries(this._wood.map((g) => (g.index ? g.toNonIndexed() : g)));
    const wm = new THREE.Mesh(woodGeo, this.wood);
    wm.castShadow = true; wm.receiveShadow = true;
    wm.layers.enable(LAYER_REFLECT);
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
    const post = box(0.18, 2.8, 0.18, 0, 1.4, 0);
    post.rotateY(ry); post.translate(x, y, z);
    this._wood.push(post);
    // little wooden weather cap on top of post
    const cap = box(0.26, 0.08, 0.26, 0, 2.82, 0);
    cap.rotateY(ry); cap.translate(x, y, z);
    this._wood.push(cap);
    rows.forEach(([name, dist], i) => {
      const tex = textTexture([name, dist]);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.76 });
      patchMaterial(mat, { toonWrap: 0.58 });
      const g = new THREE.BoxGeometry(1.78, 0.44, 0.06);
      const board = new THREE.Mesh(g, [mat, mat, mat, mat, mat, mat]);
      const side = i % 2 === 0 ? 1 : -1;
      board.position.set(0.80 * side, 2.38 - i * 0.50, 0);
      // gentle cohesive fan angle so ALL three cedar planks catch warm afternoon sunlight uniformly (KILLS blue-grey bottom sign mismatch!)
      board.rotation.y = (i - 1) * 0.11;
      const holder = new THREE.Group();
      holder.add(board);
      holder.position.set(x, y, z);
      holder.rotation.y = ry;
      board.castShadow = true;
      this.group.add(holder);
    });
    this.colliders.push({ x, z, r: 0.38 });
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
    const g = mergeGeometries(parts);
    g.rotateY(ry);
    g.translate(x, y, z);
    this._wood.push(g);
    this.benches.push({ x, z, y: y + 0.46, ry });
    this.colliders.push({ x, z, r: 0.8 });
  }

  cairn(x, z, scale = 1, count = 6) {
    this.cairnAtY(x, this.ground(x, z) - 0.05 * scale, z, scale, count);
  }

  cairnAtY(x, y0, z, scale = 1, count = 6) {
    const rnd = mulberry32(Math.floor(x * 13 + z * 7));
    let y = y0;
    let s = 0.54 * scale;
    // authentic hand-stacked chunky angular alpine boulders seated tightly via exact bounding boxes (ZERO floating gaps or flat burger discs!)
    const shapes = [
      [1.18, 0.78, 0.96],
      [0.92, 0.84, 1.10],
      [1.08, 0.70, 0.86],
      [0.86, 0.86, 0.94],
      [1.02, 0.68, 0.84],
      [0.82, 0.88, 0.82],
      [0.90, 0.76, 0.80],
    ];
    for (let i = 0; i < count; i++) {
      const sh = shapes[i % shapes.length];
      const flatVal = 0.64 + (i % 3) * 0.08;
      const g = rockGeometry(Math.floor(rnd() * 1000) + i * 37, 2, flatVal);
      const ss = s * (0.88 + rnd() * 0.20);
      g.scale(ss * sh[0], ss * sh[1], ss * sh[2]);
      g.rotateX((rnd() - 0.5) * 0.08);
      g.rotateZ((rnd() - 0.5) * 0.08);
      g.rotateY(rnd() * 6.28);
      g.computeBoundingBox();
      const minY = g.boundingBox.min.y, maxY = g.boundingBox.max.y;
      const hStone = Math.max(0.05, maxY - minY);
      const ox = (rnd() - 0.5) * 0.05 * scale, oz = (rnd() - 0.5) * 0.05 * scale;
      const dy = y - minY - hStone * (i === 0 ? 0.26 : 0.30);
      g.translate(x + ox, dy, z + oz);
      this._stones.push(g);
      y = dy + maxY;
      s *= 0.82;
    }
    this.colliders.push({ x, z, r: 0.6 * scale });
  }

  prayerFlags(cx, cz, pa, pb, topY, nFlags = 22, sagAmt = 1.35, fh0 = 0.48) {
    const a = pa || { x: cx - 9, z: cz + 4 }, b = pb || { x: cx + 7, z: cz - 6 };
    const ya = this.ground(a.x, a.z), yb = this.ground(b.x, b.z);
    const topYA = Array.isArray(topY) ? topY[0] : topY;
    const topYB = Array.isArray(topY) ? topY[1] : topY;
    const poleA = topYA ? Math.max(3.2, topYA - ya) : 5.2, poleB = topYB ? Math.max(3.2, topYB - yb) : 5.2;
    const seedId = (topYA || 0) * 0.3 + (topYB || 0) * 0.17;
    // sturdy hand-hewn weathered alpine timber poles with slightly wider base
    const mkPole = (px, py, pz, ph) => {
      const g = new THREE.CylinderGeometry(0.085, 0.145, ph, 8);
      g.translate(px, py + ph / 2 - 0.30, pz);
      return g;
    };
    this._wood.push(mkPole(a.x, ya, a.z, poleA));
    this._wood.push(mkPole(b.x, yb, b.z, poleB));

    const pos = [], fl = [], idx = [], uv2 = [];
    // rich sun-weathered Tibetan prayer-flag colors (cobalt, ivory, cinnabar, pine, saffron)
    const cols = [[0.14, 0.34, 0.80], [0.94, 0.92, 0.86], [0.84, 0.19, 0.14], [0.12, 0.55, 0.26], [0.95, 0.74, 0.14]];
    const colorArr = [];
    const segU = 6, segV = 5;
    const A = new THREE.Vector3(a.x, ya + poleA - 0.35, a.z), B = new THREE.Vector3(b.x, yb + poleB - 0.35, b.z);
    const dir = B.clone().sub(A);
    const len = dir.length();
    dir.normalize();
    const fw0 = len / nFlags * 0.84;
    for (let f = 0; f < nFlags; f++) {
      const t0 = (f + 0.08) / nFlags;
      const base = pos.length / 3;
      const fw = fw0 * (0.82 + 0.28 * ((f * 7) % 3) / 2), fh = fh0 * (0.82 + 0.42 * ((f * 5) % 4) / 3);
      const c = cols[f % 5];
      for (let j = 0; j <= segV; j++) for (let i = 0; i <= segU; i++) {
        const u = i / segU, v = j / segV;
        const t = t0 + u * (fw / len);
        const sag = Math.sin(t * Math.PI) * sagAmt;
        const p = A.clone().addScaledVector(dir, t * len);
        p.y -= sag + v * fh;
        pos.push(p.x, p.y, p.z);
        fl.push(f * 1.9 + seedId, v);
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
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.78 });
    patchMaterial(mat, {
      uniforms: { uPerp: { value: perp } },
      vertexPars: 'attribute vec2 aFlag; attribute vec2 aUV2; uniform vec3 uPerp; varying vec2 vFUV; varying float vFlagId; varying float vRipple;',
      fragmentPars: 'varying vec2 vFUV; varying float vFlagId; varying float vRipple;',
      vertex: [['#include <begin_vertex>', `#include <begin_vertex>
        {
          float v = aFlag.y;
          float u = aUV2.x;
          float ph = aFlag.x;
          // lively multi-frequency alpine wind cloth motion: billowing lift + travelling ripples!
          float billow = 0.24 + 0.22 * sin(uTime * 2.4 + ph * 0.9);
          float ripple = sin(uTime * 6.5 + ph + u * 5.2 + v * 4.5) * 0.55
                       + sin(uTime * 10.5 + ph * 1.7 + u * 9.0 - v * 6.0) * 0.25;
          float amp = (0.28 + uWindStrength * 0.42);
          transformed += uPerp * (billow + ripple * 0.52) * pow(v, 1.25) * amp;
          transformed.y += pow(v, 1.5) * (0.14 * billow + 0.08 * ripple) * amp;
          vFUV = aUV2; vFlagId = ph; vRipple = ripple;
        }`]],
      fragment: [
        ['#include <color_fragment>', `#include <color_fragment>
          {
            vec2 q = vFUV;
            // natural wind-frayed bottom cloth edge!
            float fray = texture(uNoiseTex, vec2(q.x * 3.5 + vFlagId * 0.37, 0.2)).r;
            if (q.y > 0.88 + (fray - 0.5) * 0.16) discard;
            float border = step(0.08, q.x) * step(q.x, 0.92) * step(0.08, q.y) * step(q.y, 0.88);
            float kind = mod(floor(vFlagId * 0.6), 3.0);
            float ring = smoothstep(0.03, 0.0, abs(length((q - vec2(0.5, 0.45)) * vec2(1.0, 1.3)) - 0.2));
            vec2 dq = abs(q - vec2(0.5, 0.5));
            float diamond = smoothstep(0.03, 0.0, abs(dq.x + dq.y * 0.8 - 0.25));
            float wheel = smoothstep(0.03, 0.0, abs(length(q - 0.5) - 0.18)) + step(length(q - 0.5), 0.05);
            float motif = kind < 0.5 ? ring : kind < 1.5 ? diamond : wheel;
            float lines = step(0.5, fract(q.y * 7.0)) * step(0.64, q.y) * step(0.2, q.x) * step(q.x, 0.8) * 0.5;
            // cloth fold shading from wave ripple + sun-bleached weave variation
            diffuseColor.rgb *= mix(0.74, 1.0, border) * (1.0 - 0.46 * max(motif, lines));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.89, 0.82), 0.14 + 0.22 * fract(vFlagId * 0.41));
            diffuseColor.rgb *= 0.88 + 0.18 * vRipple * q.y + 0.10 * texture(uNoiseTex, q * 0.7 + vWPos.xz * 0.02).g;
          }`],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          { vec3 Vw = normalize(vWPos - cameraPosition);
            float back = pow(max(dot(Vw, uLightDir), 0.0), 2.5);
            totalEmissiveRadiance += diffuseColor.rgb * uLightColor * (back * 0.85 + 0.08) * w_sunVis; }`],
      ],
    });
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    this.group.add(m);
    // braided rope following exact catenary sag
    const rope = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40; const p = A.clone().addScaledVector(dir, t * len); p.y -= Math.sin(t * Math.PI) * sagAmt; rope.push(p);
    }
    const rg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rope), 60, 0.015, 5, false);
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

  dispose() {
    const mats = new Set([this.wood, this.rockMat]);
    const texs = new Set();
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of list) {
          if (m.map) texs.add(m.map);
          mats.add(m);
        }
      }
    });
    for (const t of texs) t.dispose();
    for (const m of mats) m.dispose();
    this.group.removeFromParent();
  }
}

export function createProps(ctx) {
  const props = new Props(ctx.data.hf, ctx.data.trail);
  ctx.scene.add(props.group);
  return {
    instance: props,
    update() {},
    dispose() {
      props.dispose();
    },
  };
}
