import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { LAYER_NO_REFLECT } from './water.js';
import { mulberry32 } from './biome.js';
import { WORLD } from '../config.js';

// Forest-floor life: ferns (GPU patch around the camera), fallen mossy logs with
// red mushrooms, and butterflies over the flower meadows.

function fernTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 256;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(9);
  ctx.fillStyle = 'rgba(120,160,70,0.01)'; ctx.fillRect(0, 0, 128, 256);
  ctx.strokeStyle = '#5d7d2c'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(64, 256); ctx.quadraticCurveTo(66, 120, 64, 6); ctx.stroke();
  for (let y = 240; y > 10; y -= 9) {
    const f = 1 - y / 256;
    const len = 52 * Math.sin(Math.min(1, (1 - f) * 1.15) * Math.PI * 0.95) + 6;
    for (const s of [-1, 1]) {
      const cols = ['#5f8a34', '#557d2e', '#6c9640', '#4b7229'];
      ctx.fillStyle = cols[Math.floor(rnd() * cols.length)];
      ctx.beginPath();
      ctx.moveTo(64, y);
      ctx.quadraticCurveTo(64 + s * len * 0.6, y - 10, 64 + s * len, y - 14);
      ctx.quadraticCurveTo(64 + s * len * 0.5, y - 2, 64, y + 3);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function fernGeometry() {
  const fronds = 7;
  const pos = [], uv = [], idx = [], nrm = [];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.3;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const base = pos.length / 3;
    const segs = 4;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const p = dir.clone().multiplyScalar(t * 0.9).add(new THREE.Vector3(0, Math.sin(t * Math.PI * 0.85) * 0.55 + 0.02, 0));
      const w = 0.24;
      for (const k of [-1, 1]) {
        const q = p.clone().addScaledVector(side, k * w);
        pos.push(q.x, q.y, q.z); uv.push(k < 0 ? 0 : 1, t);
        nrm.push(0, 1, 0);
      }
    }
    for (let s = 0; s < segs; s++) { const i = base + s * 2; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export class Ferns {
  constructor(count = 9000, radius = 42) {
    this.patch = radius * 2;
    const geo = fernGeometry();
    const rnd = mulberry32(55);
    const off = new Float32Array(count * 2), r4 = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { off[i * 2] = rnd() * this.patch; off[i * 2 + 1] = rnd() * this.patch; for (let k = 0; k < 4; k++) r4[i * 4 + k] = rnd(); }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(r4, 4));
    geo.instanceCount = count;
    this.uniforms = { uCamXZ: { value: new THREE.Vector2() }, uPatch: { value: this.patch }, uRadius: { value: radius } };
    const mat = new THREE.MeshStandardMaterial({ map: fernTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8 });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      toonWrap: 0.6,
      vertexPars: 'attribute vec2 aOff; attribute vec4 aRnd; attribute vec2 aUv; uniform vec2 uCamXZ; uniform float uPatch; uniform float uRadius; varying vec2 vFernUv; varying float vFernShade;',
      vertex: [['#include <begin_vertex>', `
        vec2 rel = mod(aOff - uCamXZ + uPatch * 0.5, uPatch) - uPatch * 0.5;
        vec2 xz = uCamXZ + rel;
        float dist = length(rel);
        float h = w_height(xz);
        vec4 bio = w_biome(xz);
        vec3 tn = w_normal(xz, 1.0);
        float dens = smoothstep(0.42, 0.75, bio.r) * (1.0 - smoothstep(0.15, 0.35, bio.g)) * smoothstep(0.75, 0.9, tn.y) * (1.0 - smoothstep(0.05, 0.3, w_trail(xz)));
        dens *= step(aRnd.w, 0.85) * (1.0 - smoothstep(uRadius * 0.6, uRadius, dist));
        float s = dens * mix(0.6, 1.3, aRnd.y);
        float ang = aRnd.z * 6.2831;
        float c = cos(ang), sn = sin(ang);
        vec3 p = position;
        p.xz = mat2(c, -sn, sn, c) * p.xz;
        float sway = sin(uTime * 1.7 + aRnd.x * 20.0) * 0.04 * p.y;
        vec3 transformed = vec3(xz.x + p.x * s + sway, h + p.y * s - 0.02, xz.y + p.z * s);
        vFernUv = aUv; vFernShade = 0.75 + 0.35 * aRnd.x;
      `]],
      fragmentPars: 'varying vec2 vFernUv; varying float vFernShade;',
      fragment: [
        ['#include <map_fragment>', `
          vec4 texelColor = texture2D( map, vFernUv );
          diffuseColor *= texelColor;
          diffuseColor.rgb *= vFernShade * 1.05;
        `],
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'],
      ],
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(cam) { this.uniforms.uCamXZ.value.set(cam.x, cam.z); }
}

function colored(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Fallen logs with moss caps and red toadstools, scattered in forests near the trail. */
export function buildLogs(hf, biome, trail, material) {
  const rnd = mulberry32(404);
  const parts = [];
  const pts = trail.points;
  let placed = 0;
  for (let k = 0; k < 4000 && placed < 70; k++) {
    const i = Math.floor(rnd() * pts.length);
    const [px, pz] = pts[i];
    const a = rnd() * 6.28, r = 5 + rnd() * 30;
    const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
    if (biome.sampleForest(x, z) < 0.25 && rnd() < 0.85) continue;
    if (hf.trailAt(x, z) > 0.01) continue;
    const y = hf.height(x, z);
    if (y < WORLD.waterLevel + 1) continue;
    const len = 2.5 + rnd() * 4, rad = 0.22 + rnd() * 0.18;
    const ry = rnd() * Math.PI;
    const log = new THREE.CylinderGeometry(rad, rad * 1.1, len, 9, 1);
    log.rotateZ(Math.PI / 2); log.rotateY(ry); log.translate(x, y + rad * 0.7, z);
    parts.push(colored(log, [0.4, 0.29, 0.2]));
    const moss = new THREE.CylinderGeometry(rad * 1.04, rad * 1.14, len * 0.8, 9, 1, false, -Math.PI * 0.45, Math.PI * 0.9);
    moss.rotateZ(Math.PI / 2); moss.rotateY(ry); moss.translate(x, y + rad * 0.72, z);
    parts.push(colored(moss, [0.22, 0.46, 0.1]));
    for (const e of [-1, 1]) {
      const cap = new THREE.CircleGeometry(rad * 0.98, 9);
      cap.rotateY(Math.PI / 2 * e); cap.rotateY(ry);
      const ex = Math.cos(ry) * len / 2 * e, ez = -Math.sin(ry) * len / 2 * e;
      cap.translate(x + ex, y + rad * 0.7, z + ez);
      parts.push(colored(cap, [0.72, 0.58, 0.4]));
    }
    // toadstools
    const n = 2 + Math.floor(rnd() * 5);
    for (let m = 0; m < n; m++) {
      const mx = x + (rnd() - 0.5) * 2.2, mz = z + (rnd() - 0.5) * 2.2;
      const my = hf.height(mx, mz);
      const sh = 0.12 + rnd() * 0.12;
      const stem = new THREE.CylinderGeometry(0.035, 0.045, sh, 6); stem.translate(mx, my + sh / 2, mz);
      parts.push(colored(stem, [0.92, 0.88, 0.8]));
      const capG = new THREE.SphereGeometry(0.09 + rnd() * 0.05, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      capG.scale(1, 0.7, 1); capG.translate(mx, my + sh, mz);
      parts.push(colored(capG, [0.85, 0.16, 0.1]));
      for (let d = 0; d < 3; d++) {
        const dot = new THREE.SphereGeometry(0.018, 4, 3);
        const da = rnd() * 6.28;
        dot.translate(mx + Math.cos(da) * 0.05, my + sh + 0.045, mz + Math.sin(da) * 0.05);
        parts.push(colored(dot, [0.98, 0.96, 0.92]));
      }
    }
    placed++;
  }
  if (!parts.length) return null;
  for (const p of parts) if (!p.attributes.normal) p.computeVertexNormals();
  const mesh = new THREE.Mesh(mergeGeometries(parts), material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

// ---------------- butterflies ----------------
export class Butterflies {
  constructor(count = 70) {
    const g = new THREE.InstancedBufferGeometry();
    // two wings, each a quad hinged on the body axis (x = 0)
    const pos = [0, 0, -0.5, 1, 0, -0.6, 0, 0, 0.5, 1, 0, 0.7, 0, 0, -0.5, -1, 0, -0.6, 0, 0, 0.5, -1, 0, 0.7];
    const uv = [0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7]);
    const rnd = mulberry32(12);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seed[i] = rnd();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = count;
    this.uniforms = { uCamXZ: { value: new THREE.Vector2() }, uDay: { value: 1 } };
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: 'attribute vec4 aSeed; attribute vec2 aUv; uniform vec2 uCamXZ; uniform float uDay; varying vec2 vBUv; varying vec3 vBCol;',
      vertex: [['#include <begin_vertex>', `
        float P = 60.0;
        vec2 base = aSeed.xy * P;
        float t = uTime * (0.25 + aSeed.z * 0.2) + aSeed.w * 30.0;
        vec2 wander = vec2(sin(t * 1.3) + sin(t * 0.7 + 2.0), cos(t * 1.1) + sin(t * 0.5)) * 3.5;
        vec2 rel = mod(base + wander - uCamXZ + P * 0.5, P) - P * 0.5;
        vec2 xz = uCamXZ + rel;
        float h = w_height(xz);
        vec4 bio = w_biome(xz);
        float show = uDay * smoothstep(0.15, 0.5, bio.g + bio.b * 0.4) * step(uWaterLevel + 0.5, h) * (1.0 - smoothstep(22.0, 30.0, length(rel)));
        float y = h + 0.5 + abs(sin(t * 2.1)) * 0.6 + aSeed.x * 0.5;
        float flap = sin(uTime * 22.0 + aSeed.w * 40.0);
        vec3 p = position;
        float ang = flap * 1.1 * sign(p.x);
        p = vec3(p.x * cos(ang) * 0.07, abs(p.x) * sin(abs(ang)) * 0.07 + p.y, p.z * 0.06);
        vec2 vel = vec2(cos(t * 1.3) * 1.3 + cos(t * 0.7 + 2.0) * 0.7, -sin(t * 1.1) * 1.1 + cos(t * 0.5) * 0.5);
        float yaw = atan(vel.x, vel.y);
        float cy = cos(yaw), sy = sin(yaw);
        p.xz = mat2(cy, -sy, sy, cy) * p.xz;
        vec3 transformed = vec3(xz.x, y, xz.y) + p * show;
        vBUv = aUv;
        float k = floor(aSeed.z * 4.0);
        vBCol = k < 1.0 ? vec3(0.98, 0.95, 0.85) : k < 2.0 ? vec3(1.0, 0.8, 0.15) : k < 3.0 ? vec3(0.35, 0.55, 1.0) : vec3(0.95, 0.6, 0.85);
      `]],
      fragmentPars: 'varying vec2 vBUv; varying vec3 vBCol;',
      fragment: [['#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vBUv;
          float r = length(vec2(q.x * 0.9, (q.y - 0.5) * 1.2));
          if (r > 0.72 || (q.y < 0.5 && q.x > 0.9)) discard;
          diffuseColor.rgb = mix(vBCol, vec3(0.08), smoothstep(0.55, 0.68, r) + step(q.x, 0.06));
        }`],
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'],
      ],
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(cam, day) { this.uniforms.uCamXZ.value.set(cam.x, cam.z); this.uniforms.uDay.value = day; }
}

// ---------------- light shafts through the forest canopy ----------------
export class LightShafts {
  constructor(hf, biome, trail, count = 40) {
    const rnd = mulberry32(808);
    const pts = trail.points;
    const centers = [];
    for (let k = 0; k < 3000 && centers.length < count; k++) {
      const i = Math.floor(rnd() * pts.length);
      const [px, pz] = pts[i];
      if (biome.sampleForest(px + 10, pz) + biome.sampleForest(px - 10, pz) < 0.8) continue;
      const x = px + (rnd() - 0.5) * 24, z = pz + (rnd() - 0.5) * 24;
      centers.push([x, hf.height(x, z), z, 2.0 + rnd() * 3.0, rnd()]);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    const C = new Float32Array(Math.max(1, centers.length) * 5);
    centers.forEach((c, i) => C.set(c, i * 5));
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(new Float32Array(centers.flatMap((c) => [c[0], c[1], c[2], c[3]])), 4));
    g.setAttribute('aS', new THREE.InstancedBufferAttribute(new Float32Array(centers.map((c) => c[4])), 1));
    g.instanceCount = centers.length;
    this.uniforms = { uLightDir: { value: new THREE.Vector3() }, uCol: { value: new THREE.Color() }, uTime: { value: 0 }, uStrength: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `attribute vec4 aC; attribute float aS; uniform vec3 uLightDir; uniform float uTime; varying vec2 vQ; varying float vS; varying float vFade; varying float vDepth;
        void main(){
          vec3 A = normalize(uLightDir);
          vec3 base = aC.xyz + vec3(0.0, 0.2, 0.0);
          float len = 22.0;
          vec3 toCam = normalize(cameraPosition - base);
          vec3 side = normalize(cross(A, toCam));
          vec3 p = base + A * position.y * len + side * position.x * aC.w * (1.0 + position.y * 0.6);
          vQ = vec2(position.x + 0.5, position.y); vS = aS;
          float d = length(cameraPosition - base);
          vFade = smoothstep(4.0, 10.0, d) * (1.0 - smoothstep(60.0, 120.0, d));
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uCol; uniform float uStrength; uniform float uTime; varying vec2 vQ; varying float vS; varying float vFade; varying float vDepth;
        void main(){
          float across = sin(vQ.x * 3.14159);
          float along = smoothstep(0.0, 0.15, vQ.y) * (1.0 - smoothstep(0.55, 1.0, vQ.y));
          float flick = 0.75 + 0.25 * sin(uTime * 0.7 + vS * 30.0);
          float a = across * across * along * flick * vFade * uStrength * 0.42 * smoothstep(6.0, 16.0, vDepth);
          gl_FragColor = vec4(uCol * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.mesh.renderOrder = 15;
  }
  update(U, t, day) {
    this.uniforms.uLightDir.value.copy(U.uLightDir.value);
    const lc = U.uLightColor.value, k = Math.max(lc.r, lc.g, lc.b) || 1;
    this.uniforms.uCol.value.setRGB(lc.r / k, lc.g / k, lc.b / k);
    this.uniforms.uTime.value = t;
    this.uniforms.uStrength.value = day * Math.min(1, Math.max(0, U.uLightDir.value.y * 3));
  }
}
