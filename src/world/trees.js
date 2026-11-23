import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { mulberry32, fbm } from './biome.js';
import { fluffyAtlas, fluffyBroadleaf, fluffyPine, fluffyBush } from './fluffy.js';

// Stylized fluffy trees, instanced with three LOD bands (cards -> blob cores -> billboards).

const KINDS = [
  { name: 'oak', mid: () => fluffyBroadleaf(11, { kind: 'oak', color: [0.15, 0.40, 0.07], lod: 1 }), hi: () => fluffyBroadleaf(11, { kind: 'oak', color: [0.15, 0.40, 0.07] }), lo: () => fluffyBroadleaf(11, { kind: 'oak', color: [0.15, 0.40, 0.07], lod: 0 }), bb: 0 },
  { name: 'round', mid: () => fluffyBroadleaf(23, { kind: 'round', color: [0.18, 0.4, 0.1], lod: 1 }), hi: () => fluffyBroadleaf(23, { kind: 'round', color: [0.18, 0.4, 0.1] }), lo: () => fluffyBroadleaf(23, { kind: 'round', color: [0.22, 0.47, 0.1], lod: 0 }), bb: 0 },
  { name: 'pine', mid: () => fluffyPine(37, { lod: 1 }), hi: () => fluffyPine(37), lo: () => fluffyPine(37, { lod: 0 }), bb: 1 },
  { name: 'bush', mid: () => fluffyBush(61, { lod: 1 }), hi: () => fluffyBush(61), lo: () => fluffyBush(61, { lod: 0 }), bb: 0 },
  { name: 'poplar', mid: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.22, 0.48, 0.09], bark: [0.7, 0.66, 0.58], lod: 1 }), hi: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.22, 0.48, 0.09], bark: [0.7, 0.66, 0.58] }), lo: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.22, 0.48, 0.09], lod: 0 }), bb: 2 },
];

function makeMaterial(map) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, map, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true });
  patchMaterial(mat, {
    toonWrap: 0.42, toonLo: 0.22, toonHi: 0.46,
    vertex: [['#include <begin_vertex>', /* glsl */ `
      #include <begin_vertex>
      {
        vec3 ip = vec3(instanceMatrix[3]);
        float ph = ip.x * 0.071 + ip.z * 0.053;
        float gust = texture(uNoiseTex, ip.xz * 0.011 - uWindDir * uTime * 0.045).r;
        float amp = (0.005 + gust * 0.02) * (0.4 + uWindStrength);
        float k = max(position.y - 0.25, 0.0); k *= k;
        transformed.x += (sin(uTime * 1.1 + ph) * amp + uWindDir.x * gust * 0.02) * k;
        transformed.z += (cos(uTime * 0.9 + ph * 1.3) * amp + uWindDir.y * gust * 0.02) * k;
        transformed += normal * sin(uTime * 3.0 + position.y * 30.0 + position.x * 20.0 + ph * 5.0) * 0.003 * k;
      }
    `]],
    fragment: [
      ['#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        {
          vec3 Vw = normalize(vWPos - cameraPosition);
          float back = pow(max(dot(Vw, uLightDir), 0.0), 5.0);
          float lit = w_sunVis * smoothstep(-0.02, 0.08, uLightDir.y);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * vec3(1.0, 0.92, 0.7) * back * 0.16 * lit;
          // soft painted rim on crowns
          vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float rim = pow(1.0 - abs(dot(nW, -Vw)), 3.0);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * rim * 0.04 * lit;
          totalEmissiveRadiance += diffuseColor.rgb * vec3(0.85, 1.0, 0.6) * 0.055 * length(uLightColor) * (1.0 - uNight);
        }
      `],
      ['#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);`],
      ['#include <map_fragment>', `#include <map_fragment>
        if (vMapUv.x > 0.895) {
          vec2 bp = vec2(atan(vNormal.x, vNormal.z) * 0.6 + vWPos.x * 0.0, vWPos.y * 0.35);
          float b1 = texture(uNoiseTex, vec2(vWPos.x * 1.3 + vWPos.z * 1.1, vWPos.y * 0.18)).g;
          float b2 = texture(uNoiseTex, vec2(vWPos.x * 3.1 - vWPos.z * 2.7, vWPos.y * 0.6)).b;
          float ridges = smoothstep(0.35, 0.65, b1 * 0.7 + b2 * 0.4);
          diffuseColor.rgb = vec3(0.42, 0.33, 0.26) * mix(0.62, 1.12, ridges);
          diffuseColor.a = 1.0;
        } else {
          vec2 tsz = vMapUv * 512.0;
          vec2 ddx = dFdx(tsz), ddy = dFdy(tsz);
          float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
          diffuseColor.a *= 1.0 + mip * 0.32;
        }`],
      ['#include <alphatest_fragment>', `#include <alphatest_fragment>
        {
          float camD = length(vWPos - cameraPosition);
          if (camD < (vMapUv.x < 0.89 ? 3.4 : 1.2)) discard;
        }`],
    ],
  });
  return mat;
}

function makeBillboardMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide });
  patchMaterial(mat, {
    toonWrap: 0.6,
    vertexPars: 'attribute float aKind; attribute vec3 aTint; varying vec2 vBB; varying float vBBKind; varying vec3 vBBWorld; varying vec3 vBBN; varying vec3 vTint; varying vec3 vRight; varying vec3 vToCam;',
    vertex: [
      ['#include <begin_vertex>', `
        vec3 bbC = vec3(instanceMatrix[3]);
        float bbH = length(instanceMatrix[1].xyz);
        float bbW = bbH * (aKind < 0.5 ? 0.95 : aKind < 1.5 ? 0.7 : 0.55) * 1.15;
        vec3 toCam = cameraPosition - bbC; toCam.y = 0.0; toCam = normalize(toCam);
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vBBWorld = bbC + right * position.x * bbW + vec3(0.0, position.y * bbH, 0.0);
        vBB = vec2(position.x + 0.5, position.y);
        vBBKind = aKind; vTint = aTint; vRight = right; vToCam = toCam;
        vec3 transformed = position;
      `],
      ['#include <project_vertex>', `
        vec4 mvPosition = viewMatrix * vec4(vBBWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      `],
      ['vWPos = (modelMatrix * w_wp).xyz;', 'vWPos = vBBWorld;'],
    ],
    fragmentPars: 'varying vec2 vBB; varying float vBBKind; varying vec3 vTint; varying vec3 vRight; varying vec3 vToCam; vec3 bbN;',
    fragment: [
      ['#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vec2((vBB.x - 0.5) * 2.0, vBB.y);
          float n = texture(uNoiseTex, vBB * 0.9 + vBBKind * 0.31 + vTint.r).a;
          vec2 c; float rx, ry;
          if (vBBKind < 0.5) { c = vec2(0.0, 0.62); rx = 0.95; ry = 0.36; }
          else if (vBBKind < 1.5) { c = vec2(0.0, 0.52); rx = 0.9 * (1.0 - (vBB.y - 0.15) * 0.9); ry = 0.46; }
          else { c = vec2(0.0, 0.58); rx = 0.9; ry = 0.4; }
          vec2 d = (q - c) / vec2(max(rx, 0.05), ry);
          float r = length(d);
          float lobes = 0.88 + 0.12 * sin(atan(d.y, d.x) * 6.0 + vTint.g * 20.0) + (n - 0.5) * 0.25;
          bool trunk = abs(q.x) < 0.06 && vBB.y < c.y;
          if (r > lobes && !trunk) discard;
          vec3 base = vBBKind < 0.5 ? vec3(0.14, 0.37, 0.1) : vBBKind < 1.5 ? vec3(0.08, 0.28, 0.13) : vec3(0.16, 0.4, 0.1);
          float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
          diffuseColor.rgb = trunk && r > lobes ? vec3(0.35, 0.26, 0.18) : base * mix(vec3(1.0), vTint, 0.4) * (0.65 + 0.5 * up);
          vec3 sph = normalize(vec3(d.x, d.y + 0.3, sqrt(max(0.0, 1.0 - min(r * r, 1.0)))));
          bbN = normalize(vRight * sph.x + vec3(0.0, 1.0, 0.0) * sph.y + vToCam * sph.z);
        }`],
      ['#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(bbN, 0.0)).xyz);`],
    ],
  });
  return mat;
}

export class Trees {
  constructor(hf, biome, density = 1, detail = 2) {
    this.hf = hf;
    const rnd = mulberry32(777);
    const S = WORLD.size;
    const trees = [];
    const n = { x: 0, y: 1, z: 0 };
    const L = WORLD.lake;
    const step = 8.5 / Math.sqrt(density);
    for (let z = -S / 2 + 40; z < S / 2 - 40; z += step) {
      for (let x = -S / 2 + 40; x < S / 2 - 40; x += step) {
        const px = x + (rnd() - 0.5) * step * 0.95, pz = z + (rnd() - 0.5) * step * 0.95;
        const f = biome.sampleForest(px, pz);
        const lone = 0.012 * fbm(px * 0.01 + 3, pz * 0.01, 2);
        if (rnd() > f * (f > 0.6 ? 0.72 : 0.5) + lone) continue;
        const h = hf.height(px, pz);
        if (h < WORLD.waterLevel + 1.6) continue;
        if (hf.trailAt(px, pz) > 0.02) continue;
        hf.normal(px, pz, 2, n);
        if (n.y < 0.8) continue;
        if (h > 1150 + fbm(px * 0.01, pz * 0.01, 2) * 120) continue;
        const dl = Math.hypot((px - L.x) / L.rx, (pz - L.z) / L.rz);
        const alt = (h - 150) / 600;
        let v;
        const r = rnd();
        if (dl < 1.8 && dl > 1.02 && r < 0.45) v = 4;
        else if (rnd() < 0.15 + Math.max(0, alt) * 0.9 + f * 0.25) v = 2;
        else v = rnd() < 0.55 ? 0 : 1;
        const scale = (v === 2 ? 13 + rnd() * 9 : v === 4 ? 13 + rnd() * 6 : 9 + rnd() * 7) * (1 - Math.max(0, h - 700) / 1500);
        const hue = 0.88 + rnd() * 0.24;
        const grove = fbm(px * 0.004 + 31, pz * 0.004 - 7, 3);
        const warmG = grove > 0.55 ? 1.12 : 1.0, coolG = grove < 0.42 ? 1.1 : 1.0;
        trees.push({ x: px, z: pz, y: h - 0.2, s: scale, rot: rnd() * Math.PI * 2, v, sx: 0.85 + rnd() * 0.3, tint: [hue * (0.95 + rnd() * 0.1) * warmG, hue, hue * (0.9 + rnd() * 0.2) * coolG] });
      }
    }
    // trail-side trees inside forests: a closed canopy over the path
    if (hf.trailPoints) for (let i = 0; i < hf.trailPoints.length; i += 3) {
      const [tx, tz] = hf.trailPoints[i];
      if (biome.sampleForest(tx + 12, tz) + biome.sampleForest(tx - 12, tz) < 0.7) continue;
      const j = Math.min(hf.trailPoints.length - 1, i + 2);
      const dx = hf.trailPoints[j][0] - tx, dz = hf.trailPoints[j][1] - tz, l = Math.hypot(dx, dz) || 1;
      for (const s of [-1, 1]) {
        if (rnd() > 0.55 * density) continue;
        const off = 3.6 + rnd() * 3;
        const px = tx - dz / l * off * s, pz = tz + dx / l * off * s;
        if (hf.trailAt(px, pz) > 0.02) continue;
        const h = hf.height(px, pz);
        const v = rnd() < 0.6 ? 0 : 2;
        const hue = 0.85 + rnd() * 0.25;
        trees.push({ x: px, z: pz, y: h - 0.2, s: 11 + rnd() * 8, rot: rnd() * 6.28, v, sx: 0.9 + rnd() * 0.3, tint: [hue * 0.95, hue, hue * 0.92] });
      }
    }
    // bushes: forest edges, meadow clumps and along the trail
    for (let i = 0; i < 60000 * density; i++) {
      const px = (rnd() - 0.5) * (S - 120), pz = (rnd() - 0.5) * (S - 120);
      const f = biome.sampleForest(px, pz);
      const dlk = Math.hypot((px - WORLD.lake.x) / WORLD.lake.rx, (pz - WORLD.lake.z) / WORLD.lake.rz);
      const lakeRing = dlk > 1.15 && dlk < 2.2 ? 0.07 * (0.4 + fbm(px * 0.015, pz * 0.015, 2)) : 0;
      const edge = f > 0.05 && f < 0.55 ? 0.5 : 0.04 * fbm(px * 0.02, pz * 0.02, 2) + lakeRing;
      if (rnd() > edge) continue;
      const h = hf.height(px, pz);
      if (h < WORLD.waterLevel + 1.2 || h > 1050) continue;
      if (hf.trailAt(px, pz) > 0.01) continue;
      hf.normal(px, pz, 2, n);
      if (n.y < 0.82) continue;
      const hue = 0.85 + rnd() * 0.3;
      trees.push({ x: px, z: pz, y: h - 0.15, s: 1.4 + rnd() * 2.2, rot: rnd() * 6.28, v: 3, sx: 0.8 + rnd() * 0.5, tint: [hue * (0.9 + rnd() * 0.2), hue, hue * 0.9], bush: true });
    }
    this.trees = trees;
    this.cell = 16;
    this.grid = new Map();
    for (const t of trees) {
      const k = Math.floor(t.x / this.cell) + ',' + Math.floor(t.z / this.cell);
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(t);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.mats = new Float32Array(trees.length * 16);
    this.cols = new Float32Array(trees.length * 3);
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      sc.set(t.s * t.sx, t.s, t.s * t.sx);
      p.set(t.x, t.y, t.z);
      m.compose(p, q, sc);
      m.toArray(this.mats, i * 16);
      this.cols.set(t.tint, i * 3);
    });
    this.atlas = fluffyAtlas();
    this.material = makeMaterial(this.atlas);
    this.group = new THREE.Group();
    const N = trees.length;
    const mk = (geo, shadow) => {
      const im = new THREE.InstancedMesh(geo, this.material, N);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
      im.count = 0; im.castShadow = shadow; im.receiveShadow = true; im.frustumCulled = false;
      this.group.add(im);
      return im;
    };
    this.hi = KINDS.map((k) => mk(detail >= 2 ? k.hi() : k.mid(), true));
    this.lo = KINDS.map((k) => mk(k.lo(), false));
    const bbGeo = new THREE.PlaneGeometry(1, 1);
    bbGeo.translate(0, 0.5, 0);
    this.bbKind = new Float32Array(N);
    this.bbTint = new Float32Array(N * 3);
    bbGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(this.bbKind, 1));
    bbGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.bbTint, 3));
    this.bb = new THREE.InstancedMesh(bbGeo, makeBillboardMaterial(), N);
    this.bb.count = 0; this.bb.frustumCulled = false;
    this.group.add(this.bb);
    this.hiRadius = 170 * Math.sqrt(density);
    this.loRadius = 750;
    this.lastUpdate = new THREE.Vector3(1e9, 0, 0);
  }

  update(camPos, force = false) {
    if (!force && camPos.distanceTo(this.lastUpdate) < 6) return;
    this.lastUpdate.copy(camPos);
    const hc = [0, 0, 0, 0, 0], lc = [0, 0, 0, 0, 0];
    let bb = 0;
    const r2 = this.hiRadius * this.hiRadius, lr2 = this.loRadius * this.loRadius;
    const M = this.mats, C = this.cols;
    const bbArr = this.bb.instanceMatrix.array;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const dx = t.x - camPos.x, dz = t.z - camPos.z;
      const d2 = dx * dx + dz * dz;
      const v = t.v;
      if (t.hidden || (t.bush && d2 > 90000)) continue;
      if (d2 < r2 || d2 < lr2) {
        const im = d2 < r2 ? this.hi[v] : this.lo[v];
        const cnt = d2 < r2 ? hc : lc;
        im.instanceMatrix.array.set(M.subarray(i * 16, i * 16 + 16), cnt[v] * 16);
        im.instanceColor.array.set(C.subarray(i * 3, i * 3 + 3), cnt[v] * 3);
        cnt[v]++;
      } else {
        bbArr.set(M.subarray(i * 16, i * 16 + 16), bb * 16);
        this.bbKind[bb] = KINDS[v].bb;
        this.bbTint.set(C.subarray(i * 3, i * 3 + 3), bb * 3);
        bb++;
      }
    }
    const fin = (im, c) => { im.count = c; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; };
    this.hi.forEach((im, k) => fin(im, hc[k]));
    this.lo.forEach((im, k) => fin(im, lc[k]));
    this.bb.count = bb; this.bb.instanceMatrix.needsUpdate = true;
    this.bb.geometry.attributes.aKind.needsUpdate = true;
    this.bb.geometry.attributes.aTint.needsUpdate = true;
  }

  clearArea(x, z, r) {
    for (const t of this.trees) if (Math.hypot(t.x - x, t.z - z) < r + (t.bush ? 0 : t.s * 0.2)) t.hidden = true;
    this.update(this.lastUpdate.clone().add(new THREE.Vector3(1e4, 0, 0)), true);
  }

  collide(pos, radius = 0.4) {
    const cx = Math.floor(pos.x / this.cell), cz = Math.floor(pos.z / this.cell);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = this.grid.get((cx + dx) + ',' + (cz + dz));
      if (!list) continue;
      for (const t of list) {
        if (t.bush || t.hidden) continue;
        const tr = t.s * 0.03 + radius;
        const ex = pos.x - t.x, ez = pos.z - t.z;
        const d = Math.hypot(ex, ez);
        if (d < tr && d > 1e-4) { pos.x = t.x + ex / d * tr; pos.z = t.z + ez / d * tr; }
      }
    }
  }
}
