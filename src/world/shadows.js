import * as THREE from 'three';
import { WORLD_PARS, WORLD_FUNCS, NOISE } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { fullscreenQuad } from './heightmap.js';

// Heightfield ray-marched soft shadows (mountains shadowing valleys at low sun).
const FRAG = /* glsl */ `
${NOISE}
${WORLD_PARS}
${WORLD_FUNCS}
uniform float uRegion;
uniform float uRes;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - 0.5) * uRegion;
  vec3 L = uLightDir;
  if (L.y <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float lxz = max(length(L.xz), 1e-4);
  vec2 d2 = L.xz / lxz;
  float tanE = L.y / lxz;
  float h0 = w_height(p) + 0.8;
  float res = 1.0;
  float t = uRegion > 10000.0 ? 40.0 : 3.0;
  for (int i = 0; i < 84; i++){
    vec2 q = p + d2 * t;
    float ry = h0 + t * tanE;
    if (ry > 4400.0 || t > 2600.0) break;
    float th = w_height(q);
    float dh = ry - th;
    res = min(res, 18.0 * dh / t);
    if (res < -0.2) break;
    t = t * 1.085 + 1.5;
  }
  res = clamp(res, 0.0, 1.0);
  res = res * res * (3.0 - 2.0 * res);
  gl_FragColor = vec4(res, res, res, 1.0);
}
`;

export class TerrainShadows {
  constructor(renderer, worldSize, farSize) {
    this.renderer = renderer;
    const mk = (res) => new THREE.WebGLRenderTarget(res, res, {
      type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.nearRT = mk(1024);
    this.farRT = mk(512);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uRegion: { value: worldSize }, uRes: { value: 1024 } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FRAG,
      depthTest: false, depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.scene.add(fullscreenQuad(this.mat));
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.worldSize = worldSize; this.farSize = farSize;
    U.uShadowNear.value = this.nearRT.texture;
    U.uShadowFar.value = this.farRT.texture;
    this.lastDir = new THREE.Vector3(0, -2, 0);
    this.toggle = 0;
  }
  update(force = false) {
    const L = U.uLightDir.value;
    if (!force && L.distanceTo(this.lastDir) < 0.0015) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    // alternate near/far updates to spread cost, unless forced
    const doNear = force || this.toggle % 2 === 0;
    const doFar = force || this.toggle % 2 === 1;
    this.toggle++;
    if (doNear) {
      this.mat.uniforms.uRegion.value = this.worldSize; this.mat.uniforms.uRes.value = 1024;
      r.setRenderTarget(this.nearRT); r.render(this.scene, this.cam);
    }
    if (doFar) {
      this.mat.uniforms.uRegion.value = this.farSize; this.mat.uniforms.uRes.value = 512;
      r.setRenderTarget(this.farRT); r.render(this.scene, this.cam);
    }
    if (force || doFar) this.lastDir.copy(L);
    r.setRenderTarget(prev);
  }

  dispose() {
    for (const child of this.scene.children) child.geometry?.dispose();
    this.mat.dispose();
    this.nearRT.dispose();
    this.farRT.dispose();
  }
}

export function createTerrainShadows(ctx, worldSize, farSize) {
  const shadows = new TerrainShadows(ctx.renderer, worldSize, farSize);
  return {
    instance: shadows,
    update() {},
    dispose() {
      shadows.dispose();
    },
  };
}
