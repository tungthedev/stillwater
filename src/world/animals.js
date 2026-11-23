import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { mulberry32 } from './biome.js';

// Grazing animals. Vertex attribute aPart: 0 body, 1 head/neck (grazes), 2 legs (trot), 3 tail (swish).

function part(geo, rgb, partId) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(partId), 1));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
const sphere = (r, sx, sy, sz, x, y, z, seg = 12) => { const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg * 0.7 | 0)); g.scale(sx, sy, sz); g.translate(x, y, z); return g; };
const limb = (r0, r1, h, x, y, z, rx = 0) => { const g = new THREE.CylinderGeometry(r1, r0, h, 8); g.translate(0, -h / 2, 0); g.rotateX(rx); g.translate(x, y, z); return g; };

export function sheepGeometry() {
  const rnd = mulberry32(3);
  const P = [];
  const wool = [0.97, 0.95, 0.88], woolWarm = [0.94, 0.91, 0.83];
  // continuous organically sculpted storybook wool fleece torso (smoothly scalloped billows — ZERO detached sphere-cluster balls!)
  const fleece = new THREE.SphereGeometry(0.42, 22, 16);
  const fp = fleece.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    let x = fp.getX(i), y = fp.getY(i), z = fp.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;
    // soft multi-wave wool curl scallops across the continuous fleece coat (plump chest, rounded rump, tucked belly!)
    const curl = 1.0
      + 0.085 * Math.sin(nx * 6.5 + ny * 5.2) * Math.cos(nz * 6.0)
      + 0.055 * Math.sin(nz * 10.5 - ny * 7.8 + 1.2)
      + 0.035 * Math.cos(nx * 12.0 + nz * 9.5);
    // organic sheep silhouette: slightly deeper woolly chest & plump rounded hindquarters
    const taperY = ny < -0.2 ? 0.90 : 1.0 + 0.05 * Math.max(0, ny);
    const rump = nz < 0 ? 1.04 : 0.96;
    x *= 1.04 * curl * rump;
    y *= 0.88 * curl * taperY;
    z *= 1.38 * curl;
    fp.setXYZ(i, x, y + 0.80, z);
  }
  fleece.computeVertexNormals();
  P.push(part(fleece, wool, 0));
  // blended wool shoulder ruff & plump chest fleece bib (merges body smoothly into neck!)
  P.push(part(sphere(0.28, 1.08, 0.96, 1.15, 0, 0.84, 0.42, 14), woolWarm, 0));
  P.push(part(sphere(0.24, 1.05, 0.88, 1.05, 0, 0.72, 0.36, 12), woolWarm, 0));

  // sculpted storybook sheep head & expressive character face (graze)
  const faceWarm = [0.21, 0.18, 0.16], muzzleCol = [0.34, 0.29, 0.26], noseCol = [0.16, 0.13, 0.13], earCol = [0.24, 0.20, 0.18], innerEar = [0.56, 0.40, 0.38];
  P.push(part(sphere(0.21, 1.04, 0.98, 1.12, 0, 0.92, 0.49, 14), wool, 1));
  // continuous lofted expressive muzzle & brow (distinct sheep snout profile — NOT a plain ball!)
  const headLoft = loft([
    [0, 0.94, 0.54, 0.13, 0.14],
    [0, 0.94, 0.66, 0.145, 0.15],
    [0, 0.91, 0.77, 0.11, 0.115],
    [0, 0.875, 0.87, 0.082, 0.075],
    [0, 0.865, 0.92, 0.042, 0.036],
  ], 14);
  P.push(part(headLoft, faceWarm, 1));
  P.push(part(sphere(0.068, 1.08, 0.78, 0.85, 0, 0.868, 0.875, 10), muzzleCol, 1));
  P.push(part(sphere(0.036, 1.25, 0.62, 0.68, 0, 0.872, 0.928, 8), noseCol, 1));
  // sculpted fluffy wool crown cap & forehead curl
  P.push(part(sphere(0.145, 1.12, 0.78, 1.10, 0, 1.055, 0.61, 12), wool, 1));
  P.push(part(sphere(0.095, 1.05, 0.70, 0.95, 0, 1.055, 0.70, 10), wool, 1));
  // expressive warm storybook eyes with iris & bright catchlight + cupped drooping ears with pink inner lobe
  for (const sx of [-1, 1]) {
    P.push(part(sphere(0.038, 0.92, 1.02, 0.85, sx * 0.102, 0.958, 0.742, 10), [0.97, 0.96, 0.92], 1));
    P.push(part(sphere(0.024, 0.9, 1.0, 0.8, sx * 0.110, 0.960, 0.764, 8), [0.05, 0.04, 0.03], 1));
    P.push(part(sphere(0.009, 1, 1, 1, sx * 0.118, 0.971, 0.776, 6), [1.0, 1.0, 1.0], 1));
    const earG = new THREE.SphereGeometry(0.082, 10, 8);
    earG.scale(1.75, 0.40, 0.78);
    earG.rotateZ(-sx * 0.40);
    earG.rotateY(-sx * 0.24);
    earG.translate(sx * 0.185, 0.975, 0.62);
    P.push(part(earG, earCol, 1));
    const earIn = new THREE.SphereGeometry(0.058, 8, 6);
    earIn.scale(1.55, 0.26, 0.56);
    earIn.rotateZ(-sx * 0.40);
    earIn.rotateY(-sx * 0.24);
    earIn.translate(sx * 0.182, 0.964, 0.635);
    P.push(part(earIn, innerEar, 1));
  }
  // organic lofted legs: plump woolly upper haunches tapering through sculpted knees & slender ankles into cloven dark hooves (ZERO straight grey sticks!)
  for (const [x, z, front] of [[0.17, 0.30, true], [-0.17, 0.30, true], [0.18, -0.32, false], [-0.18, -0.32, false]]) {
    P.push(part(sphere(0.135, 1.02, 1.15, 1.08, x, 0.58, z, 10), woolWarm, 2));
    const legMesh = loft(front ? [
      [x, 0.58, z, 0.072, 0.076],
      [x, 0.44, z + 0.01, 0.052, 0.055],
      [x, 0.32, z + 0.015, 0.044, 0.046],
      [x, 0.18, z + 0.005, 0.036, 0.038],
      [x, 0.11, z + 0.015, 0.044, 0.048],
    ] : [
      [x, 0.60, z, 0.084, 0.090],
      [x, 0.45, z - 0.045, 0.056, 0.062],
      [x, 0.31, z - 0.055, 0.042, 0.046],
      [x, 0.18, z - 0.015, 0.036, 0.038],
      [x, 0.11, z + 0.005, 0.044, 0.048],
    ], 10);
    P.push(part(legMesh, [0.34, 0.29, 0.25], 2));
    P.push(part(taper(0.044, 0.048, [x, 0.12, z + (front ? 0.015 : 0.005)], [x, 0.02, z + (front ? 0.025 : 0.015)], 8), [0.16, 0.13, 0.12], 2));
  }
  // cute drooping woolly tail
  const sTail = loft([
    [0, 0.80, -0.54, 0.075, 0.075],
    [0, 0.72, -0.60, 0.068, 0.068],
    [0, 0.62, -0.61, 0.046, 0.046],
  ], 8);
  P.push(part(sTail, wool, 3));
  const g = mergeGeometries(P.map((m) => (m.index ? m.toNonIndexed() : m)));
  g.translate(0, -0.04, 0);
  return g;
}

// orient a capsule (along +y) from p0 to p1
function capsule(r, p0, p1, seg = 10) {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1);
  const d = b.clone().sub(a); const len = d.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 4, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}
function taper(r0, r1, p0, p1, seg = 10) {
  const a = new THREE.Vector3(...p0), b = new THREE.Vector3(...p1);
  const d = b.clone().sub(a); const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return g;
}

// sweep a circle-ish cross-section along a spine: spine = [[x,y,z, rx, ry], ...]
function loft(spine, seg = 14) {
  const pos = [], idx = [];
  const n = spine.length;
  const P = spine.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  for (let i = 0; i < n; i++) {
    const t = P[Math.min(n - 1, i + 1)].clone().sub(P[Math.max(0, i - 1)]).normalize();
    const side = new THREE.Vector3(1, 0, 0);
    const up = t.clone().cross(side).normalize().negate();
    const s2 = up.clone().cross(t).normalize();
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const v = P[i].clone().addScaledVector(s2, Math.cos(a) * spine[i][3]).addScaledVector(up, Math.sin(a) * spine[i][4]);
      pos.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < seg; k++) {
    const a = i * (seg + 1) + k, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // caps
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function horseGeometry(coat = [0.5, 0.27, 0.13]) {
  const P = [];
  const dark = [0.2, 0.12, 0.07], hoof = [0.12, 0.1, 0.09], white = [0.95, 0.93, 0.88];

  // body: rump -> barrel -> chest, smooth loft
  const body = loft([
    [0, 1.36, -1.02, 0.12, 0.14],
    [0, 1.42, -0.88, 0.34, 0.38],
    [0, 1.45, -0.6, 0.44, 0.47],
    [0, 1.4, -0.2, 0.42, 0.46],
    [0, 1.38, 0.2, 0.42, 0.45],
    [0, 1.42, 0.55, 0.42, 0.47],
    [0, 1.5, 0.82, 0.34, 0.42],
    [0, 1.62, 0.95, 0.12, 0.16],
  ], 18);
  P.push(part(body, coat, 0));
  // arched neck + head as one loft (grazes)
  const neck = loft([
    [0, 1.5, 0.62, 0.26, 0.34],
    [0, 1.78, 0.86, 0.22, 0.28],
    [0, 2.05, 1.04, 0.17, 0.2],
    [0, 2.25, 1.18, 0.15, 0.17],
    [0, 2.28, 1.3, 0.15, 0.17],
    [0, 2.14, 1.48, 0.13, 0.15],
    [0, 1.98, 1.64, 0.11, 0.13],
    [0, 1.9, 1.72, 0.1, 0.11],
    [0, 1.86, 1.76, 0.03, 0.03],
  ], 14);
  P.push(part(neck, coat, 1));
  for (const sx of [-1, 1]) {
    const e = new THREE.ConeGeometry(0.05, 0.17, 6); e.rotateX(-0.25); e.translate(sx * 0.08, 2.44, 1.22); P.push(part(e, coat, 1));
    P.push(part(sphere(0.028, 1, 1, 1, sx * 0.135, 2.24, 1.38, 6), [0.03, 0.02, 0.02], 1));
    P.push(part(sphere(0.012, 1, 1, 1, sx * 0.145, 2.25, 1.39, 4), [0.9, 0.9, 0.9], 1));
  }
  // mane: a thin crest ribbon
  const mane = loft([
    [0, 2.34, 1.2, 0.03, 0.04],
    [0, 2.2, 1.04, 0.035, 0.06],
    [0, 1.98, 0.86, 0.035, 0.065],
    [0, 1.76, 0.68, 0.03, 0.05],
    [0, 1.64, 0.56, 0.01, 0.015],
  ], 8);
  P.push(part(mane, dark, 1));
  // legs with knees and fetlocks
  const legs = [[0.22, 0.66, true, true], [-0.22, 0.66, false, true], [0.21, -0.68, false, false], [-0.21, -0.68, true, false]];
  for (const [x, z, sock, front] of legs) {
    const leg = loft(front ? [
      [x, 1.25, z, 0.15, 0.16], [x, 0.95, z + 0.02, 0.11, 0.12], [x, 0.72, z + 0.02, 0.08, 0.09], [x, 0.62, z + 0.02, 0.085, 0.09], [x, 0.2, z, 0.065, 0.07], [x, 0.12, z + 0.02, 0.075, 0.08],
    ] : [
      [x, 1.3, z, 0.18, 0.2], [x, 1.0, z - 0.1, 0.13, 0.14], [x, 0.72, z - 0.12, 0.08, 0.09], [x, 0.6, z - 0.08, 0.085, 0.09], [x, 0.2, z - 0.02, 0.065, 0.07], [x, 0.12, z, 0.075, 0.08],
    ], 10);
    P.push(part(leg, coat, 2));
    P.push(part(taper(0.09, 0.08, [x, 0.13, z + 0.01], [x, 0.0, z + 0.03], 10), hoof, 2));
  }
  // tail: flowing curve
  const tail = loft([
    [0, 1.5, -0.98, 0.07, 0.07], [0, 1.45, -1.12, 0.09, 0.09], [0, 1.2, -1.22, 0.12, 0.11], [0, 0.95, -1.24, 0.13, 0.11], [0, 0.72, -1.2, 0.09, 0.08], [0, 0.6, -1.16, 0.02, 0.02],
  ], 10);
  P.push(part(tail, dark, 3));
  const merged = mergeGeometries(P.map((g) => (g.index ? g.toNonIndexed() : g)));
  // markings: white socks on two legs, a blaze down the face
  const pa = merged.attributes.position, ca = merged.attributes.color, pp = merged.attributes.aPart;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    if (pp.getX(i) > 1.5 && pp.getX(i) < 2.5 && y < 0.42 && y > 0.12 && ((x > 0 && z > 0) || (x < 0 && z < 0))) ca.setXYZ(i, 0.95, 0.93, 0.88);
    if (pp.getX(i) > 0.5 && pp.getX(i) < 1.5 && Math.abs(x) < 0.05 && z > 1.25 && y > 1.85 && y < 2.3) ca.setXYZ(i, 0.95, 0.93, 0.88);
  }
  return merged;
}

export function ponyGeometry() {
  const P = [];
  const coat = [0.62, 0.38, 0.2], belly = [0.82, 0.62, 0.42], mane = [0.32, 0.2, 0.12], hoof = [0.16, 0.12, 0.1], muzzle = [0.86, 0.72, 0.58];
  // round barrel body
  P.push(part(sphere(0.52, 1.0, 0.95, 1.45, 0, 1.2, 0.0, 18), coat, 0));
  P.push(part(sphere(0.42, 0.95, 0.7, 1.2, 0, 1.0, 0.0, 14), belly, 0));
  // short neck + big round head (grazes)
  P.push(part(capsule(0.27, [0, 1.42, 0.55], [0, 1.82, 0.85], 14), coat, 1));
  P.push(part(sphere(0.32, 0.95, 1.0, 1.15, 0, 1.95, 1.0, 16), coat, 1));
  P.push(part(sphere(0.22, 1.05, 0.85, 1.0, 0, 1.82, 1.28, 14), muzzle, 1));
  for (const sx of [-1, 1]) {
    P.push(part(sphere(0.055, 1, 1, 1, sx * 0.2, 2.02, 1.18, 10), [0.05, 0.04, 0.04], 1));
    P.push(part(sphere(0.02, 1, 1, 1, sx * 0.215, 2.04, 1.22, 6), [0.95, 0.95, 0.95], 1));
    const ear = new THREE.ConeGeometry(0.09, 0.24, 10); ear.rotateZ(-sx * 0.35); ear.translate(sx * 0.17, 2.3, 0.92);
    P.push(part(ear, coat, 1));
    P.push(part(sphere(0.025, 1, 1, 1, sx * 0.07, 1.82, 1.48, 6), [0.25, 0.15, 0.12], 1));
  }
  // puffy mane & forelock, like the sheep wool
  const tufts = [[0, 2.22, 1.0, 0.16], [0, 2.12, 0.8, 0.17], [0, 1.98, 0.66, 0.17], [0, 1.82, 0.56, 0.15], [0, 1.66, 0.48, 0.13], [0, 2.18, 1.16, 0.12]];
  for (const [x, y, z, r] of tufts) P.push(part(sphere(r, 0.8, 1, 1, x + 0.03, y, z, 12), mane, 1));
  // stubby legs
  for (const [x, z] of [[0.26, 0.48], [-0.26, 0.48], [0.26, -0.48], [-0.26, -0.48]]) {
    P.push(part(taper(0.14, 0.075, [x, 0.98, z], [x, 0.2, z + (z > 0 ? 0.02 : -0.04)], 12), coat, 2));
    P.push(part(sphere(0.12, 1, 1, 1, x, 0.98, z, 12), coat, 2));
    P.push(part(taper(0.09, 0.105, [x, 0.22, z], [x, 0.0, z + 0.02], 12), hoof, 2));
  }
  // puffy tail
  for (const [y, z, r] of [[1.38, -0.78, 0.14], [1.18, -0.86, 0.15], [0.98, -0.88, 0.13], [0.8, -0.86, 0.1]]) P.push(part(sphere(r, 0.85, 1, 0.85, 0, y, z, 12), mane, 3));
  return mergeGeometries(P.map((g) => (g.index ? g.toNonIndexed() : g)));
}

export class Herd {
  /** spec: { geo, scale:[min,max], speed, roam, pivot:[y,z], grazeAngle, collide, tailRoot:[y,z] } */
  constructor(hf, herds, spec, seed = 77) {
    this.hf = hf;
    this.spec = spec;
    const rnd = mulberry32(seed);
    this.list = [];
    for (const hd of herds) for (let i = 0; i < hd.n; i++) {
      const a = rnd() * 6.28, r = 3 + rnd() * (spec.roam * 0.6);
      const isLamb = i % 4 === 1;
      const scBase = isLamb ? (0.56 + rnd() * 0.14) : (0.94 + rnd() * 0.26);
      this.list.push({
        x: hd.x + Math.cos(a) * r, z: hd.z + Math.sin(a) * r, hx: hd.x, hz: hd.z,
        yaw: rnd() * 6.28, tx: 0, tz: 0, walking: i % 3 === 0, timer: rnd() * 8,
        graze: (i % 3 === 0) ? 0.08 : (i % 2 === 0 ? 0.95 : 0.48),
        phase: rnd() * 10,
        s: scBase * (spec.scale[0] + rnd() * (spec.scale[1] - spec.scale[0])) * 0.92,
        sx: 0.90 + rnd() * 0.22,
        sz: 0.92 + rnd() * 0.18,
      });
    }
    const geo = spec.geo;
    this.graze = new Float32Array(this.list.length);
    this.walk = new Float32Array(this.list.length);
    geo.setAttribute('aGraze', new THREE.InstancedBufferAttribute(this.graze, 1));
    geo.setAttribute('aWalk', new THREE.InstancedBufferAttribute(this.walk, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(this.list.map((s) => s.phase)), 1));
    const coats = spec.coats || [[1, 1, 1]];
    const ct = new Float32Array(this.list.length * 3);
    this.list.forEach((s, i) => ct.set(coats[i % coats.length], i * 3));
    geo.setAttribute('aCoat', new THREE.InstancedBufferAttribute(ct, 3));
    const [py, pz] = spec.pivot, [ty, tz] = spec.tailRoot;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    patchMaterial(mat, {
      toonWrap: 0.7, toonLo: 0.1, toonHi: 0.6,
      vertexPars: 'attribute float aPart; attribute float aGraze; attribute float aWalk; attribute float aPhase; attribute vec3 aCoat; varying float vWool; varying vec3 vCoat; varying float vLegY;',
      vertex: [['#include <begin_vertex>', `#include <begin_vertex>
        {
          vWool = aPart < 0.5 ? 1.0 : 0.0;
          vCoat = aCoat; vLegY = aPart > 1.5 && aPart < 2.5 ? position.y : 9.0;
          if (aPart > 0.5 && aPart < 1.5) {
            // rich per-sheep head pose variety: alert curious head-ups, half-lifted glances, deep grazers & varied left/right head turns!
            float ang = aGraze * ${spec.grazeAngle.toFixed(3)} + sin(uTime * 1.7 + aPhase) * 0.06 * aGraze + sin(uTime * 0.6 + aPhase) * 0.08 * (1.0 - aGraze);
            float headYaw = sin(aPhase * 3.7 + 1.1) * 0.42 + sin(uTime * 0.45 + aPhase * 2.1) * 0.14;
            vec3 piv = vec3(0.0, ${py.toFixed(3)}, ${pz.toFixed(3)});
            vec3 q = transformed - piv;
            float c = cos(ang), s = sin(ang);
            q = vec3(q.x, q.y * c - q.z * s, q.y * s + q.z * c);
            float cy = cos(headYaw), sy = sin(headYaw);
            q = vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
            transformed = piv + q;
          } else if (aPart > 1.5 && aPart < 2.5) {
            // natural relaxed standing leg stagger + trotting stride (breaks identical parallel grey-cylinder legs!)
            float side = sign(position.x) * sign(position.z + 0.001);
            float legFrac = clamp(1.0 - position.y / ${(spec.legTop || 0.6).toFixed(2)}, 0.0, 1.0);
            float stance = sin(aPhase * 2.7 + side * 1.4) * 0.065;
            transformed.z += (stance + sin(uTime * 7.0 + aPhase + side * 1.57) * 0.13 * aWalk) * legFrac;
            transformed.x += sign(position.x) * 0.022 * legFrac;
          } else if (aPart > 2.5) {
            vec3 piv = vec3(0.0, ${ty.toFixed(3)}, ${tz.toFixed(3)});
            vec3 q = transformed - piv;
            float a = sin(uTime * 2.3 + aPhase) * 0.35;
            float c = cos(a), s = sin(a);
            q = vec3(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
            transformed = piv + q;
          }
        }`],
        ['#include <beginnormal_vertex>', '#include <beginnormal_vertex>'],
      ],
      fragmentPars: 'varying float vWool; varying vec3 vCoat; varying float vLegY;',
      fragment: [['#include <color_fragment>', `#include <color_fragment>
        { vec4 nn = texture(uNoiseTex, vWPos.xz * 4.1 + vWPos.y * 3.0); diffuseColor.rgb *= 1.0 - vWool * 0.12 * nn.a;
          bool isEye = diffuseColor.r > 0.94 && diffuseColor.g > 0.94 && diffuseColor.b > 0.90 && vWool < 0.5;
          if (${spec.tintWool ? '!isEye' : '!(diffuseColor.r > 0.8 && diffuseColor.b > 0.7)'}) diffuseColor.rgb *= vCoat;
          if (vLegY < 5.0) diffuseColor.rgb *= mix(0.84, 1.0, smoothstep(0.18, 0.55, vLegY)); }`],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { vec3 Vw = normalize(cameraPosition - vWPos); vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float rim = pow(1.0 - max(dot(Nw, Vw), 0.0), 2.6);
          float topM = smoothstep(0.05, 0.72, Nw.y);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * rim * 0.14 * w_sunVis * (0.3 + vWool);
          // crisp silver-blue moonlight rim on wool backs at night (makes night.png midground sheep clearly readable!)
          totalEmissiveRadiance += vec3(0.55, 0.72, 1.0) * (rim * 0.22 + topM * 0.05) * (0.35 + vWool) * uNight; }`]],
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.list.length);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3();
    for (let it = 0; it < 65; it++) this.update(0.016, 0);
  }
  update(dt, t) {
    const hf = this.hf, sp0 = this.spec.speed, roam = this.spec.roam;
    this.list.forEach((s, i) => {
      s.timer -= dt;
      if (s.timer <= 0) {
        if (s.walking || Math.random() < 0.5) { s.walking = false; s.timer = 5 + Math.random() * 12; }
        else { const a = Math.random() * 6.28, r = Math.random() * roam; s.tx = s.hx + Math.cos(a) * r; s.tz = s.hz + Math.sin(a) * r; s.walking = true; s.timer = 14; }
      }
      if (s.walking) {
        const dx = s.tx - s.x, dz = s.tz - s.z, d = Math.hypot(dx, dz);
        if (d < 0.6) { s.walking = false; s.timer = 4 + Math.random() * 8; }
        else {
          let dy = Math.atan2(dx, dz) - s.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          s.yaw += dy * Math.min(1, dt * 1.6);
          const sp = sp0 * dt * Math.max(0, Math.cos(dy));
          const nx = s.x + Math.sin(s.yaw) * sp, nz = s.z + Math.cos(s.yaw) * sp;
          if (hf.height(nx, nz) > WORLD.waterLevel + 0.6 && hf.trailAt(nx, nz) < 0.5) { s.x = nx; s.z = nz; } else s.timer = 0;
        }
      }
      for (let k = 0; k < this.list.length; k++) {
        if (k === i) continue;
        const o = this.list[k], ex = s.x - o.x, ez = s.z - o.z, d = Math.hypot(ex, ez), md = this.spec.collide * 3.8 * Math.max(s.s, o.s);
        if (d < md && d > 1e-4) { s.x += ex / d * (md - d) * 0.55; s.z += ez / d * (md - d) * 0.55; }
      }
      const targetGraze = s.walking ? 0.0 : (i % 3 === 0 ? 0.10 : (i % 3 === 1 ? 0.52 : 0.96));
      s.graze += (targetGraze - s.graze) * Math.min(1, dt * 1.2);
      this.graze[i] = s.graze;
      this.walk[i] = s.walking ? 1 : 0;
      const y = hf.height(s.x, s.z);
      const n = hf.normal(s.x, s.z, 1.0);
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
      this.e.set((n.x * fx + n.z * fz) * 0.8, s.yaw, (n.x * fz - n.z * fx) * 0.8, 'YXZ');
      this.q.setFromEuler(this.e);
      this.sc.set(s.s * (s.sx || 1), s.s, s.s * (s.sz || 1));
      this.m.compose(this.v.set(s.x, y - 0.04, s.z), this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aGraze.needsUpdate = true;
    this.mesh.geometry.attributes.aWalk.needsUpdate = true;
  }
  collide(pos, radius) {
    const cr = this.spec.collide;
    for (const s of this.list) {
      const dx = pos.x - s.x, dz = pos.z - s.z, d = Math.hypot(dx, dz), rr = cr * s.s + radius;
      if (d < rr && d > 1e-4) { pos.x = s.x + dx / d * rr; pos.z = s.z + dz / d * rr; s.x -= dx / d * 0.04; s.z -= dz / d * 0.04; }
    }
  }
  nearest(pos) { let bd = 1e9; for (const s of this.list) bd = Math.min(bd, Math.hypot(pos.x - s.x, pos.z - s.z)); return bd; }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose?.();
  }
}
