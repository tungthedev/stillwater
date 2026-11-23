import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { LAYER_NO_REFLECT } from './water.js';
import { mulberry32 } from './biome.js';

// GPU grass: a toroidal patch of blades that follows the camera. Every blade
// samples terrain height, slope, biome and trail masks in the vertex shader.

function bladeGeometry(segs = 4) {
  const pos = [], idx = [];
  for (let i = 0; i < segs; i++) {
    const y = i / segs;
    pos.push(-0.5, y, 0, 0.5, y, 0);
  }
  pos.push(0, 1, 0);
  for (let i = 0; i < segs - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const t = (segs - 1) * 2;
  idx.push(t, t + 1, segs * 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function scatter(geo, count, patch, seed) {
  const rnd = mulberry32(seed);
  const off = new Float32Array(count * 2);
  const r4 = new Float32Array(count * 4);
  const side = Math.ceil(Math.sqrt(count));
  const cell = patch / side;
  for (let i = 0; i < count; i++) {
    const gx = i % side, gz = (i / side) | 0;
    off[i * 2] = (gx + rnd()) * cell;
    off[i * 2 + 1] = (gz + rnd()) * cell;
    r4[i * 4] = rnd(); r4[i * 4 + 1] = rnd(); r4[i * 4 + 2] = rnd(); r4[i * 4 + 3] = rnd();
  }
  // shuffle so LOD thinning by aRnd.w is spatially uniform (already random), keep as is
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
  geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(r4, 4));
  geo.instanceCount = count;
}

const GRASS_VERTEX = /* glsl */ `
  vec2 rel = mod(aOff - uCamXZ + uPatch * 0.5, uPatch) - uPatch * 0.5;
  vec2 xz = uCamXZ + rel;
  float dist = length(rel);
  float h = w_height(xz);
  vec3 tn = w_normal(xz, 1.0);
  vec4 bio = w_biome(xz);
  float trail = w_trail(xz);
  float dens = smoothstep(0.6, 0.8, tn.y);
  dens *= 1.0 - smoothstep(0.18, 0.5, trail + (aRnd.x - 0.5) * 0.2);
  dens *= 1.0 - 0.92 * w_yard(xz);
  float reedZone = (1.0 - smoothstep(0.2, 0.9, abs(h - uWaterLevel + 0.1))) * smoothstep(0.55, 0.75, texture(uNoiseTex, xz * 0.035 + 0.4).r);
  dens *= max(smoothstep(uWaterLevel + 0.15, uWaterLevel + 1.0, h), reedZone);
  dens *= 1.0 - smoothstep(1050.0, 1300.0, h);
  dens *= mix(1.0, 0.08, smoothstep(0.2, 0.6, bio.r));
  float keep = 1.0 - smoothstep(uRadius * 0.6, uRadius, dist);
  float thin = step(aRnd.w, mix(1.0, 0.4, smoothstep(8.0, uRadius, dist)));
  float nz = texture(uNoiseTex, xz * 0.017).r;
  float nz2 = texture(uNoiseTex, xz * 0.09).g;
  dens *= smoothstep(0.15, 0.4, nz2 + 0.25);
  float scale = dens * keep * thin;
  float tall = mix(0.2, 0.62, bio.b * 0.7 + nz * 0.5) * mix(0.6, 1.2, aRnd.y);
  tall *= mix(1.0, 0.55, smoothstep(700.0, 1050.0, h));
  tall = mix(tall, mix(1.1, 1.9, aRnd.y), reedZone);
  float height = tall * scale;
  float width = 0.045 * mix(0.7, 1.3, aRnd.x) * (1.0 + dist * 0.03) * step(0.001, scale);
  float y = position.y;
  float yaw = aRnd.z * 6.2831853;
  vec2 fwd = vec2(cos(yaw), sin(yaw));
  vec2 sd = vec2(-fwd.y, fwd.x);
  // wind: travelling gusts + per-blade flutter
  float gust = texture(uNoiseTex, xz * 0.011 - uWindDir * uTime * 0.045).r;
  gust = smoothstep(0.3, 0.8, gust);
  float flutter = sin(uTime * (2.0 + aRnd.y * 1.5) + aRnd.x * 6.28 + dot(xz, uWindDir) * 0.6) * 0.18;
  float bend = (0.12 + aRnd.y * 0.28) + (gust * 0.7 + flutter) * (0.25 + uWindStrength * 0.8);
  // player pushes grass aside
  vec2 toP = xz - uPlayerXZ;
  float pd = length(toP);
  float push = (1.0 - smoothstep(0.2, 1.1, pd));
  vec2 bendDir = normalize(fwd * 0.4 + uWindDir * (0.3 + gust * 1.4) + (toP / max(pd, 0.01)) * push * 3.0);
  bend += push * 1.2;
  float c = y * y * bend;
  vec3 p;
  p.xz = xz + sd * position.x * width * (1.0 - y * 0.9) + bendDir * c * height * 0.8;
  p.y = h + y * height * (1.0 - min(c, 1.0) * 0.35) - 0.02;
  vec3 transformed = p;
  vGrassY = y;
  vGrassDist = dist;
  // colour variation
  vec3 gcol = w_grassColor(xz, h);
  vec3 tip = gcol * mix(1.0, 1.3, aRnd.y) + vec3(0.02, 0.02, 0.0);
  vec3 base = gcol * 0.62;
  vGrassCol = mix(base, tip, smoothstep(0.0, 1.0, y));
  vGrassCol *= 0.9 + 0.2 * aRnd.x;
  vGrassCol = mix(vGrassCol, mix(vec3(0.1, 0.2, 0.06), vec3(0.42, 0.4, 0.16), y), reedZone);
  vGrassCol *= mix(1.0, 0.72, smoothstep(0.4, 0.85, bio.r));
  vec3 bn = normalize(vec3(fwd.x, 0.0, fwd.y));
  vGrassN = normalize(tn + vec3(0.0, 0.35, 0.0));
`;

export class Grass {
  constructor(count, radius) {
    this.radius = radius;
    this.patch = radius * 2;
    const geo = bladeGeometry(4);
    scatter(geo, count, this.patch, 1337);
    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uPlayerXZ: { value: new THREE.Vector2(1e5, 1e5) },
      uPatch: { value: this.patch },
      uRadius: { value: radius },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        attribute vec2 aOff; attribute vec4 aRnd;
        uniform vec2 uCamXZ; uniform vec2 uPlayerXZ; uniform float uPatch; uniform float uRadius;
        varying float vGrassY; varying float vGrassDist; varying vec3 vGrassCol; varying vec3 vGrassN;
      `,
      vertex: [
        ['#include <begin_vertex>', GRASS_VERTEX],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: /* glsl */ `
        varying float vGrassY; varying float vGrassDist; varying vec3 vGrassCol; varying vec3 vGrassN;
      `,
      fragment: [
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          diffuseColor.rgb = vGrassCol;
          diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, 0.5, vGrassY));
        `],
        ['#include <normal_fragment_begin>', /* glsl */ `
          #include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(vGrassN, 0.0)).xyz);
        `],
        ['#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>
          {
            vec3 Vw = normalize(vWPos - cameraPosition);
            float back = pow(max(dot(Vw, uLightDir), 0.0), 4.0);
            totalEmissiveRadiance += vGrassCol * uLightColor * (back * 0.9 + 0.03) * vGrassY * w_sunVis * smoothstep(-0.02, 0.08, uLightDir.y);
            { float fz = smoothstep(0.4, 0.85, w_biome(vWPos.xz).r); totalEmissiveRadiance += vGrassCol * vec3(0.9, 1.0, 0.6) * fz * 0.042 * length(uLightColor) * (1.0 - uNight); }
          }
        `],
      ],
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(camPos, playerPos) {
    this.uniforms.uCamXZ.value.set(camPos.x, camPos.z);
    if (playerPos) this.uniforms.uPlayerXZ.value.set(playerPos.x, playerPos.z);
  }
}

// ---------------- flowers ----------------
function flowerGeometry() {
  // stem (thin quad) + head (horizontal quad)
  const pos = [], uv = [], part = [], idx = [];
  pos.push(-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0); uv.push(0, 0, 1, 0, 0, 1, 1, 1); part.push(0, 0, 0, 0);
  idx.push(0, 1, 2, 1, 3, 2);
  pos.push(-0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, 1, 0.5, 0.5, 1, 0.5); uv.push(0, 0, 1, 0, 0, 1, 1, 1); part.push(1, 1, 1, 1);
  idx.push(4, 6, 5, 5, 6, 7);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

export class Flowers {
  constructor(count, radius) {
    this.patch = radius * 2;
    const geo = flowerGeometry();
    scatter(geo, count, this.patch, 4242);
    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uPatch: { value: this.patch },
      uRadius: { value: radius },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        attribute vec2 aOff; attribute vec4 aRnd; attribute float aPart; attribute vec2 aUv;
        uniform vec2 uCamXZ; uniform float uPatch; uniform float uRadius;
        varying vec2 vFUv; varying float vFPart; varying vec3 vFCol; varying float vFKind;
      `,
      vertex: [
        ['#include <begin_vertex>', /* glsl */ `
          vec2 rel = mod(aOff - uCamXZ + uPatch * 0.5, uPatch) - uPatch * 0.5;
          vec2 xz = uCamXZ + rel;
          float dist = length(rel);
          float h = w_height(xz);
          vec3 tn = w_normal(xz, 1.0);
          vec4 bio = w_biome(xz);
          float trail = w_trail(xz);
          float clump = texture(uNoiseTex, xz * 0.045 + aRnd.z * 0.1).g;
          float dens = bio.g * smoothstep(0.45, 0.7, clump + bio.g * 0.3);
          dens *= smoothstep(0.75, 0.88, tn.y) * (1.0 - smoothstep(0.1, 0.4, trail));
          dens *= 1.0 - w_yard(xz);
          dens *= smoothstep(uWaterLevel + 0.4, uWaterLevel + 1.5, h);
          float keep = (1.0 - smoothstep(uRadius * 0.6, uRadius, dist)) * step(aRnd.w, dens * 0.9);
          float stemH = mix(0.14, 0.36, aRnd.y) * keep;
          float drift = texture(uNoiseTex, xz * 0.018 + 0.29).b;
          float kind = aRnd.x < 0.8 ? floor(clamp(drift * 1.6 - 0.3, 0.0, 0.999) * 4.0) : floor(aRnd.x * 4.0);
          float headS = (kind == 2.0 ? 0.07 : 0.1) * mix(0.55, 1.35, fract(aRnd.y * 7.3)) * keep * (1.0 + dist * 0.03);
          float gust = smoothstep(0.3, 0.8, texture(uNoiseTex, xz * 0.011 - uWindDir * uTime * 0.045).r);
          vec2 sway = uWindDir * (gust * 0.6 + 0.1) * (0.3 + uWindStrength) + vec2(sin(uTime * 2.3 + aRnd.z * 9.0), cos(uTime * 1.9 + aRnd.x * 7.0)) * 0.05;
          vec3 p;
          if (aPart < 0.5) {
            float y = position.y;
            p = vec3(xz.x + position.x * 0.008 * keep, h + y * stemH, xz.y);
            p.xz += sway * y * y * stemH;
          } else {
            vec3 toC = normalize(cameraPosition - vec3(xz.x, h + stemH, xz.y));
            vec3 hr = normalize(cross(vec3(0.0, 1.0, 0.0), toC));
            vec3 hu = normalize(cross(toC, hr));
            vec3 hn = normalize(mix(vec3(0.0, 1.0, 0.0), toC, 0.45 + 0.35 * fract(aRnd.z * 5.1)) + vec3(sin(aRnd.x * 40.0), 0.0, cos(aRnd.x * 40.0)) * 0.25);
            vec3 hu2 = normalize(cross(hn, hr));
            p = vec3(xz.x, h + stemH, xz.y) + hr * position.x * headS * 1.1 + hu2 * position.z * headS * 1.1;
            p.xz += sway * stemH;
          }
          vec3 transformed = p;
          vFUv = aUv; vFPart = aPart; vFKind = kind;
          vec3 c0 = vec3(0.95, 0.95, 0.9);   // daisy
          vec3 c1 = vec3(1.0, 0.78, 0.12);   // buttercup
          vec3 c2 = vec3(0.35, 0.3, 0.85);   // gentian
          vec3 c3 = vec3(0.85, 0.42, 0.62);  // campion
          vFCol = kind < 0.5 ? c0 : kind < 1.5 ? c1 : kind < 2.5 ? c2 : c3;
        `],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: 'varying vec2 vFUv; varying float vFPart; varying vec3 vFCol; varying float vFKind;',
      fragment: [
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);'],
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          if (vFPart < 0.5) {
            diffuseColor.rgb = vec3(0.16, 0.36, 0.07);
          } else {
            vec2 q = vFUv * 2.0 - 1.0;
            float r = length(q);
            float a = atan(q.y, q.x);
            float petals = vFKind < 0.5 ? 9.0 : vFKind < 1.5 ? 5.0 : vFKind < 2.5 ? 5.0 : 5.0;
            float shape = 0.62 + 0.38 * abs(cos(a * petals * 0.5));
            if (r > shape) discard;
            vec3 col = vFCol;
            float center = smoothstep(0.28, 0.18, r);
            col = mix(col, vFKind < 0.5 ? vec3(1.0, 0.75, 0.1) : col * 0.6, center);
            diffuseColor.rgb = col * (0.75 + 0.25 * r);
          }
        `],
      ],
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(camPos) { this.uniforms.uCamXZ.value.set(camPos.x, camPos.z); }
}
