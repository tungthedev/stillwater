import * as THREE from 'three';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { LAYER_NO_REFLECT } from './water.js';
import { mulberry32 } from './biome.js';

// Birds (flocks + a soaring raptor), sunlit pollen/dust motes, fireflies.

function birdGeometry() {
  // body along +z, wings along +-x. aWing: x = side*span (0 at body), used for flapping
  const pos = [
    // body
    0, 0, 0.35, 0.05, 0, -0.2, -0.05, 0, -0.2,
    0, 0.03, 0.2, 0, 0.0, -0.35, 0.0, -0.02, 0.1,
    // left wing (inner + outer)
    0, 0, 0.15, 0, 0, -0.1, -0.45, 0, 0.0,
    -0.45, 0, 0.0, 0, 0, -0.1, -0.5, 0, -0.18,
    -0.45, 0, 0.0, -0.5, 0, -0.18, -0.95, 0, -0.12,
    // right wing
    0, 0, 0.15, 0.45, 0, 0.0, 0, 0, -0.1,
    0.45, 0, 0.0, 0.5, 0, -0.18, 0, 0, -0.1,
    0.45, 0, 0.0, 0.95, 0, -0.12, 0.5, 0, -0.18,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class Birds {
  constructor() {
    const geo = birdGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1d1a16, roughness: 0.9, side: THREE.DoubleSide });
    patchMaterial(mat, {
      vertexPars: 'attribute float aPhase;',
      vertex: [['#include <begin_vertex>', `#include <begin_vertex>
        {
          float span = abs(position.x);
          float flap = sin(uTime * (aPhase > 50.0 ? 1.2 : 9.0) + aPhase) * (aPhase > 50.0 ? 0.12 : 0.9);
          transformed.y += flap * span * span * 1.1 + flap * span * 0.3;
          transformed.x *= 1.0 - abs(flap) * 0.12;
        }`]],
    });
    this.count = 48;
    this.mesh = new THREE.InstancedMesh(geo, mat, this.count);
    const phases = new Float32Array(this.count);
    const rnd = mulberry32(5);
    for (let i = 0; i < this.count; i++) phases[i] = rnd() * 40;
    phases[this.count - 1] = 77; // raptor: slow soaring
    phases[this.count - 2] = 91;
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    this.mesh.frustumCulled = false;
    this.offsets = Array.from({ length: this.count }, () => new THREE.Vector3((rnd() - 0.5) * 30, (rnd() - 0.5) * 8, (rnd() - 0.5) * 30));
    this.seeds = Array.from({ length: this.count }, () => rnd() * 100);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._prev = Array.from({ length: this.count }, () => new THREE.Vector3());
    this._look = new THREE.Matrix4();
    this.visible = 1;
  }
  update(t, dt, dayAmount) {
    const L = WORLD.lake;
    const m = this._m;
    const flocks = [
      { cx: L.x + 100, cz: L.z - 200, r: 420, h: 150, sp: 0.045, n: 26 },
      { cx: -500, cz: -300, r: 300, h: 260, sp: -0.06, n: 20 },
    ];
    let k = 0;
    const show = dayAmount > 0.05 ? 1 : 0;
    for (const f of flocks) {
      const a = t * f.sp;
      const cx = f.cx + Math.cos(a) * f.r, cz = f.cz + Math.sin(a * 1.3) * f.r * 0.7;
      const cy = WORLD.waterLevel + f.h + Math.sin(a * 2.1) * 30;
      for (let i = 0; i < f.n && k < this.count - 2; i++, k++) {
        const o = this.offsets[k], s = this.seeds[k];
        const p = this._p.set(
          cx + o.x * 1.4 + Math.sin(t * 0.3 + s) * 6,
          cy + o.y + Math.sin(t * 0.5 + s * 2) * 3,
          cz + o.z * 1.4 + Math.cos(t * 0.27 + s) * 6
        );
        this._orient(k, p, show * 1.1);
      }
    }
    // raptors soaring in wide thermals over the summit & ridge
    const rap = [[WORLD.summit.x + 150, WORLD.summit.z + 50, 180, 0.05, 690], [-200, -900, 260, -0.035, 820]];
    rap.forEach(([x, z, r, sp, h], i) => {
      const a = t * sp + i * 2;
      const p = this._p.set(x + Math.cos(a) * r, h + Math.sin(t * 0.07 + i) * 25, z + Math.sin(a) * r);
      this._orient(this.count - 1 - i, p, show * 3.2);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  _orient(i, p, scale) {
    const prev = this._prev[i];
    const dir = p.clone().sub(prev);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    this._look.lookAt(p, prev, new THREE.Vector3(0, 1, 0));
    this._q.setFromRotationMatrix(this._look);
    // bank into turns
    this._s.set(scale, scale, scale);
    this._m.compose(p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
    prev.copy(p);
  }
}

const MOTE_VERT = /* glsl */ `
${COMMON}
attribute vec4 aSeed;
uniform vec3 uCam;
uniform float uBox;
uniform float uMode; // 0 motes, 1 fireflies
uniform float uPix;
varying float vAlpha;
varying vec3 vCol;
void main(){
  vec3 base = aSeed.xyz * uBox;
  vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * uTime * (uMode < 0.5 ? 0.6 : 0.15);
  drift += vec3(sin(uTime * 0.31 + aSeed.w * 30.0), sin(uTime * 0.23 + aSeed.w * 17.0) * 0.6, cos(uTime * 0.27 + aSeed.w * 23.0)) * (uMode < 0.5 ? 1.2 : 2.5);
  vec3 p = mod(base + drift - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  float g = w_height(p.xz);
  if (uMode > 0.5) {
    p.y = g + 0.4 + fract(aSeed.y * 7.0) * 2.4 + sin(uTime * 0.7 + aSeed.w * 9.0) * 0.4;
  } else {
    p.y = g + 0.3 + fract(aSeed.y * 3.7) * 4.0 + sin(uTime * 0.3 + aSeed.w * 11.0) * 0.4;
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  float edge = 1.0 - smoothstep(uBox * 0.35, uBox * 0.5, length(p - uCam));
  if (uMode < 0.5) {
    vec3 V = normalize(p - cameraPosition);
    float fwd = pow(max(dot(V, uLightDir), 0.0), 8.0);
    float lit = w_terrainShadow(p) * w_cloudShadow(p) * smoothstep(0.0, 0.1, uLightDir.y);
    vAlpha = fwd * 0.9 * lit * edge * (1.0 - uNight) * (1.0 - smoothstep(10.0, 16.0, d));
    vCol = uLightColor * 0.35;
    gl_PointSize = clamp(uPix * (0.025 + aSeed.w * 0.02) / d, 1.0, 6.0);
  } else {
    float blink = pow(max(sin(uTime * (0.8 + aSeed.w) + aSeed.x * 40.0), 0.0), 5.0);
    float wet = 1.0 - smoothstep(uWaterLevel + 3.0, uWaterLevel + 40.0, g);
    float duskOrNight = max(uNight, uDusk * 0.85);
    vAlpha = blink * edge * duskOrNight * (0.38 + wet);
    vCol = vec3(0.88, 1.0, 0.38) * 14.0;
    gl_PointSize = clamp(uPix * 0.17 / d, 2.5, 14.0);
  }
}
`;
const MOTE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vCol;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0) discard;
  float a = exp(-r * 3.5) * vAlpha;
  gl_FragColor = vec4(vCol * a, a);
}
`;

export class Particles {
  constructor(count, box, mode) {
    const rnd = mulberry32(mode ? 88 : 66);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = rnd();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    this.uniforms = { ...U, uCam: { value: new THREE.Vector3() }, uBox: { value: box }, uMode: { value: mode }, uPix: { value: 1000 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_NO_REFLECT);
    this.points.renderOrder = 20;
  }
  update(cam, pixelScale) {
    this.uniforms.uCam.value.copy(cam);
    this.uniforms.uPix.value = pixelScale;
  }
}
