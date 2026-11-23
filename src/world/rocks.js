import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { mulberry32, vnoise, fbm } from './biome.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function noise3(x, y, z) {
  return (vnoise(x + z * 1.7, y - z * 0.3) + vnoise(y * 1.3 - x * 0.2 + 5.1, z + 2.7)) * 0.5;
}

export function rockGeometry(seed, detail = 2, flat = 0.65) {
  const rnd = mulberry32(seed);
  let g = new THREE.IcosahedronGeometry(1, detail);
  g = g.index ? g : g;
  // merge duplicate vertices so displacement stays watertight
  const p = g.attributes.position;
  const ox = rnd() * 100, oy = rnd() * 100, oz = rnd() * 100;
  const sx = 0.8 + rnd() * 0.6, sz = 0.8 + rnd() * 0.6;
  // facet planes for a chiselled look
  const planes = [];
  for (let i = 0; i < 7; i++) {
    const n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.3, rnd() - 0.5).normalize();
    planes.push({ n, d: 0.72 + rnd() * 0.22 });
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const k = 1 + (noise3(v.x * 1.6 + ox, v.y * 1.6 + oy, v.z * 1.6 + oz) - 0.5) * 0.55
      + (noise3(v.x * 4 + oz, v.y * 4 + ox, v.z * 4 + oy) - 0.5) * 0.18;
    v.multiplyScalar(k);
    for (const pl of planes) {
      const dd = v.dot(pl.n);
      if (dd > pl.d) v.addScaledVector(pl.n, -(dd - pl.d) * 0.6);
    }
    v.x *= sx; v.z *= sz; v.y *= flat;
    if (v.y < -0.25) v.y = -0.25 + (v.y + 0.25) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.normal) g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  g.computeVertexNormals();
  g = g.toNonIndexed();
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

export function rockMaterial(farCull = false) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  patchMaterial(mat, {
    vertex: farCull ? [['#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
      { vec3 ip = vec3(instanceMatrix[3]); float d = length(ip - cameraPosition); transformed *= 1.0 - smoothstep(450.0, 650.0, d); }
      #endif`]] : [],
    fragmentPars: 'varying vec3 vRockN;',
    vertexPars: 'varying vec3 vRockN;',
    vertex: [['#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      {
        vec3 nn = objectNormal;
        #ifdef USE_INSTANCING
          nn = mat3(instanceMatrix) * nn;
        #endif
        vRockN = normalize(mat3(modelMatrix) * nn);
      }`]],
    fragment: [['#include <color_fragment>', /* glsl */ `
      #include <color_fragment>
      {
        vec3 wp = vWPos;
        vec3 an = abs(normalize(vRockN));
        an /= (an.x + an.y + an.z);
        vec4 nx = texture(uNoiseTex, wp.yz * 0.35);
        vec4 ny = texture(uNoiseTex, wp.xz * 0.35);
        vec4 nzz = texture(uNoiseTex, wp.xy * 0.35);
        vec4 n = nx * an.x + ny * an.y + nzz * an.z;
        vec4 nf = texture(uNoiseTex, wp.xz * 2.1 + wp.y * 0.7);
        vec3 base = mix(vec3(0.30, 0.29, 0.27), vec3(0.52, 0.50, 0.46), n.r);
        base *= 0.8 + 0.4 * nf.g;
        // lichen spots
        float lichen = smoothstep(0.72, 0.78, nf.a) * 0.8;
        base = mix(base, vec3(0.62, 0.58, 0.32), lichen * 0.5);
        // moss on top
        float up = normalize(vRockN).y;
        float moss = smoothstep(0.35, 0.8, up + (n.g - 0.5) * 0.6) * smoothstep(1100.0, 700.0, wp.y);
        base = mix(base, vec3(0.13, 0.19, 0.05) * (0.8 + 0.4 * n.b), moss * 0.8);
        // snow cap at altitude
        base = mix(base, vec3(0.9, 0.92, 0.96), smoothstep(1450.0, 1650.0, wp.y) * smoothstep(0.3, 0.7, up));
        diffuseColor.rgb = base * vec3(1.1, 1.0, 0.86);
      }
    `]],
  });
  return mat;
}

export class Rocks {
  constructor(hf, trailPts, streamPts) {
    const rnd = mulberry32(99);
    this.geos = [rockGeometry(1, 2), rockGeometry(2, 2, 0.72), rockGeometry(3, 2, 0.8), rockGeometry(4, 3, 0.6)];
    this.material = rockMaterial(true);
    const S = WORLD.size;
    const items = [];
    const n = { x: 0, y: 1, z: 0 };
    const add = (x, z, s, sink = 0.3, v = -1) => {
      const h = hf.height(x, z);
      if (h < WORLD.waterLevel - 3) return;
      hf.normal(x, z, 1.5, n);
      items.push({ x, z, y: h - s * sink, s, v: v < 0 ? Math.floor(rnd() * 3) : v, rot: rnd() * Math.PI * 2, tilt: [n.x, n.z] });
    };
    // slope talus + scattered field stones
    for (let i = 0; i < 26000 && items.length < 4200; i++) {
      const x = (rnd() - 0.5) * (S - 100), z = (rnd() - 0.5) * (S - 100);
      const h = hf.height(x, z);
      hf.normal(x, z, 3, n);
      const slope = 1 - n.y;
      if (hf.trailAt(x, z) > 0.1) continue;
      let p = 0;
      if (slope > 0.22 && slope < 0.6) p = 0.5;
      else if (slope <= 0.22) p = 0.015 * (0.5 + fbm(x * 0.01, z * 0.01, 2));
      if (h > 900) p *= 1.6;
      if (rnd() > p) continue;
      const big = rnd() < 0.08;
      add(x, z, big ? 2 + rnd() * 3 : 0.7 + rnd() * 1.1, slope <= 0.22 ? 0.12 : 0.3);
    }
    // lakeshore pebbles & stones
    const L = WORLD.lake;
    for (let i = 0; i < 700; i++) {
      const a = rnd() * Math.PI * 2, r = 0.95 + rnd() * 0.35;
      const x = L.x + Math.cos(a) * L.rx * r, z = L.z + Math.sin(a) * L.rz * r;
      const h = hf.height(x, z);
      if (Math.abs(h - WORLD.waterLevel) > 2.5) continue;
      add(x, z, 0.25 + rnd() * rnd() * 1.4, 0.35);
    }
    // trail-side stones
    if (trailPts) for (let i = 0; i < trailPts.length; i += 3) {
      if (rnd() > 0.22) continue;
      const [px, pz] = trailPts[i];
      const j = Math.min(trailPts.length - 1, i + 1);
      const dx = trailPts[j][0] - px, dz = trailPts[j][1] - pz;
      const l = Math.hypot(dx, dz) || 1;
      const side = rnd() < 0.5 ? -1 : 1;
      const off = 2.0 + rnd() * 2.5;
      add(px - dz / l * off * side, pz + dx / l * off * side, 0.2 + rnd() * 0.6, 0.35);
    }
    // mossy stones along the stream banks
    if (streamPts) for (let i = 2; i < streamPts.length - 2; i += 2) {
      if (rnd() > 0.92) continue;
      const [px, pz] = streamPts[i];
      const [qx, qz] = streamPts[i + 1];
      const dx = qx - px, dz = qz - pz, l = Math.hypot(dx, dz) || 1;
      const side = rnd() < 0.5 ? -1 : 1;
      const off = 1.8 + rnd() * 1.6;
      add(px - dz / l * off * side, pz + dx / l * off * side, 0.35 + rnd() * 0.9, 0.3);
      if (rnd() < 0.15) add(px + (rnd() - 0.5) * 1.5, pz + (rnd() - 0.5) * 1.5, 0.3 + rnd() * 0.4, 0.35);
    }
    // a few glacial erratics in the meadows: landmarks
    const erratics = [[260, 520, 7], [-520, 380, 9], [40, -160, 6], [-980, -260, 11], [420, 120, 5]];
    for (const [x, z, s] of erratics) add(x, z, s, 0.25, 3);
    this.items = items;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    this.meshes = this.geos.map((g, vi) => {
      const list = items.filter((it) => it.v === vi);
      const im = new THREE.InstancedMesh(g, this.material, Math.max(1, list.length));
      list.forEach((it, i) => {
        it.mesh = im; it.idx = i;
        e.set(it.tilt[1] * 0.45, it.rot, -it.tilt[0] * 0.45);
        q.setFromEuler(e);
        sc.set(it.s, it.s, it.s);
        p.set(it.x, it.y, it.z);
        m.compose(p, q, sc);
        im.setMatrixAt(i, m);
      });
      im.count = list.length;
      im.castShadow = true; im.receiveShadow = true;
      im.computeBoundingSphere();
      return im;
    });
    this.group = new THREE.Group();
    this.meshes.forEach((m) => this.group.add(m));
    // collision list (only big ones)
    this.colliders = items.filter((it) => it.s > 0.9).map((it) => ({ x: it.x, z: it.z, r: it.s * 0.85, top: it.y + it.s * 0.6 }));
  }
  clearArea(x, z, r) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const it of this.items) if (it.mesh && Math.hypot(it.x - x, it.z - z) < r) { it.mesh.setMatrixAt(it.idx, zero); it.mesh.instanceMatrix.needsUpdate = true; it.gone = true; }
    this.colliders = this.colliders.filter((c) => Math.hypot(c.x - x, c.z - z) >= r);
  }

  collide(pos, ground, radius = 0.35) {
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      if (Math.abs(dx) > c.r + 1 || Math.abs(dz) > c.r + 1) continue;
      const d = Math.hypot(dx, dz), rr = c.r + radius;
      if (d < rr && c.top > ground + 0.6 && d > 1e-4) { pos.x = c.x + dx / d * rr; pos.z = c.z + dz / d * rr; }
    }
  }
}
