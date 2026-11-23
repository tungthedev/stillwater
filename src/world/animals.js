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
  const wool = [0.97, 0.95, 0.88], face = [0.13, 0.11, 0.1], ear = [0.2, 0.16, 0.15];
  // woolly body: many small soft puffs around an ellipsoid
  P.push(part(sphere(0.36, 1.0, 0.85, 1.35, 0, 0.78, 0), wool, 0));
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2, b = (rnd() - 0.3) * 1.2;
    const x = Math.cos(a) * 0.3 * Math.cos(b), y = 0.8 + Math.sin(b) * 0.27, z = Math.sin(a) * 0.42 * Math.cos(b);
    P.push(part(sphere(0.15 + rnd() * 0.07, 1, 0.9, 1, x, y, z, 10), wool.map((v) => v * (0.95 + rnd() * 0.06)), 0));
  }
  // woolly neck & head (graze)
  P.push(part(sphere(0.19, 1, 1, 1.1, 0, 0.92, 0.47), wool, 1));
  P.push(part(sphere(0.13, 0.85, 0.95, 1.35, 0, 0.9, 0.66), face, 1));
  P.push(part(sphere(0.075, 1.1, 0.8, 1.0, 0, 0.86, 0.8), [0.36, 0.3, 0.28], 1));
  for (const sx of [-1, 1]) {
    P.push(part(sphere(0.03, 1, 1, 1, sx * 0.085, 0.95, 0.74, 8), [0.98, 0.97, 0.95], 1));
    P.push(part(sphere(0.016, 1, 1, 1, sx * 0.095, 0.952, 0.765, 6), [0.03, 0.03, 0.03], 1));
  }
  P.push(part(sphere(0.12, 1.1, 0.8, 1, 0, 1.02, 0.6), wool, 1));
  for (const s of [-1, 1]) P.push(part(sphere(0.07, 1.7, 0.45, 0.8, s * 0.15, 0.97, 0.6), ear, 1));
  for (const s of [-1, 1]) P.push(part(sphere(0.018, 1, 1, 1, s * 0.07, 0.95, 0.8, 6), [0.95, 0.95, 0.9], 1));
  // short tapered legs
  for (const [x, z] of [[0.15, 0.3], [-0.15, 0.3], [0.15, -0.3], [-0.15, -0.3]]) { P.push(part(limb(0.06, 0.045, 0.2, x, 0.62, z), [0.88, 0.85, 0.78], 2)); P.push(part(limb(0.045, 0.036, 0.3, x, 0.44, z), [0.34, 0.29, 0.26], 2)); P.push(part(sphere(0.042, 1, 0.7, 1.2, x, 0.14, z + 0.01, 8), [0.12, 0.1, 0.09], 2)); }
  P.push(part(sphere(0.08, 1, 1, 1.2, 0, 0.82, -0.56), wool, 3));
  const g = mergeGeometries(P);
  g.translate(0, -0.1, 0);
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
      this.list.push({ x: hd.x + Math.cos(a) * r, z: hd.z + Math.sin(a) * r, hx: hd.x, hz: hd.z, yaw: rnd() * 6.28, tx: 0, tz: 0, walking: false, timer: rnd() * 8, graze: rnd(), phase: rnd() * 10, s: (rnd() < 0.22 ? 0.62 : 1.0) * (spec.scale[0] + rnd() * (spec.scale[1] - spec.scale[0])) });
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
            float ang = aGraze * ${spec.grazeAngle.toFixed(3)} + sin(uTime * 1.7 + aPhase) * 0.06 * aGraze + sin(uTime * 0.6 + aPhase) * 0.08 * (1.0 - aGraze);
            vec3 piv = vec3(0.0, ${py.toFixed(3)}, ${pz.toFixed(3)});
            vec3 q = transformed - piv;
            float c = cos(ang), s = sin(ang);
            q = vec3(q.x, q.y * c - q.z * s, q.y * s + q.z * c);
            transformed = piv + q;
          } else if (aPart > 1.5 && aPart < 2.5) {
            float side = sign(position.x) * sign(position.z + 0.001);
            transformed.z += sin(uTime * 7.0 + aPhase + side * 1.57) * 0.12 * aWalk * clamp(1.0 - position.y / ${(spec.legTop || 0.6).toFixed(2)}, 0.0, 1.0);
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
          bool isWhite = diffuseColor.r > 0.8 && diffuseColor.b > 0.7;
          if (!isWhite) diffuseColor.rgb *= vCoat;
          if (!isWhite) diffuseColor.rgb *= mix(0.45, 1.0, smoothstep(0.35, 0.75, vLegY)); }`],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { vec3 Vw = normalize(cameraPosition - vWPos); vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float rim = pow(1.0 - max(dot(Nw, Vw), 0.0), 3.0);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * rim * 0.12 * w_sunVis * (0.3 + vWool); }`]],
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.list.length);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.v = new THREE.Vector3(); this.sc = new THREE.Vector3();
    for (let it = 0; it < 30; it++) this.update(0.016, 0);
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
        const o = this.list[k], ex = s.x - o.x, ez = s.z - o.z, d = Math.hypot(ex, ez), md = this.spec.collide * 2.6 * s.s;
        if (d < md && d > 1e-4) { s.x += ex / d * (md - d) * 0.5; s.z += ez / d * (md - d) * 0.5; }
      }
      s.graze += ((s.walking ? 0 : 1) - s.graze) * Math.min(1, dt * 1.2);
      this.graze[i] = s.graze;
      this.walk[i] = s.walking ? 1 : 0;
      const y = hf.height(s.x, s.z);
      const n = hf.normal(s.x, s.z, 1.0);
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
      this.e.set((n.x * fx + n.z * fz) * 0.8, s.yaw, (n.x * fz - n.z * fx) * 0.8, 'YXZ');
      this.q.setFromEuler(this.e);
      this.sc.set(s.s, s.s, s.s);
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
}
