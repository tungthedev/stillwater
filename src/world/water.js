import * as THREE from 'three';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { WORLD } from '../config.js';

export const LAYER_NO_REFLECT = 2;

const VERT = /* glsl */ `
uniform mat4 uTexMatrix;
varying vec4 vReflUV;
varying vec3 vWPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vReflUV = uTexMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${COMMON}
uniform sampler2D tRefl;
uniform float uHasRefl;
uniform vec4 uRipples[6];
varying vec4 vReflUV;
varying vec3 vWPos;

vec2 slopeAt(vec2 p, float t){
  vec2 wd = uWindDir;
  float gust = texture(uNoiseTex, p * 0.0021 - wd * t * 0.004).r;
  float gust2 = texture(uNoiseTex, p * 0.0063 + wd.yx * t * 0.006).g;
  float cat = smoothstep(0.42, 0.72, gust * 0.7 + gust2 * 0.45);
  float rough = (0.12 + cat * 0.95) * (0.35 + uWindStrength);
  vec2 s = vec2(0.0);
  s += (texture(uNoiseTex, p * 0.031 + wd * t * 0.010).gb - 0.5) * 0.55;
  s += (texture(uNoiseTex, p * 0.093 - wd.yx * t * 0.021 + 0.3).gb - 0.5) * 0.45;
  s += (texture(uNoiseTex, p * 0.27 + wd * t * 0.045 + 0.7).br - 0.5) * 0.35;
  s += (texture(uNoiseTex, p * 0.71 - wd * t * 0.08).gr - 0.5) * 0.22;
  s *= rough;
  // gentle long swell (always present)
  s += (texture(uNoiseTex, p * 0.008 + t * 0.002).gb - 0.5) * 0.08;
  // expanding rings from rising fish / drops
  for (int i = 0; i < 6; i++){
    vec4 r = uRipples[i];
    float age = t - r.z;
    if (age < 0.0 || age > 7.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d);
    float front = age * 0.9;
    float x = dist - front;
    float env = exp(-x * x * 1.2) * exp(-age * 0.55) * r.w / (1.0 + dist * 0.6);
    s += (d / max(dist, 1e-3)) * cos(x * 9.0) * env * 0.9;
  }
  return s;
}

void main(){
  float t = uTime;
  vec3 wp = vWPos;
  float ground = w_height(wp.xz);
  float depth = uWaterLevel - ground;
  if (depth < -0.15) discard;
  vec3 V = normalize(cameraPosition - wp);
  float dist = length(cameraPosition - wp);
  vec2 s = slopeAt(wp.xz, t);
  // flatten detail with distance to avoid aliasing
  s *= mix(1.0, 0.35, smoothstep(80.0, 900.0, dist));
  vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
  float cosT = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  F = clamp(F, 0.0, 1.0);
  vec3 R = reflect(-V, N);
  vec3 refl;
  vec3 skyR = w_sky(normalize(vec3(R.x, max(R.y, 0.01), R.z)));
  if (uHasRefl > 0.5){
    vec2 uv = vReflUV.xy / vReflUV.w;
    uv += N.xz * 0.045;
    refl = texture(tRefl, uv).rgb;
  } else refl = skyR;
  // water body scattering colour lit by sky and sun
  vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
  float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
  vec3 scatterCol = vec3(0.03, 0.16, 0.2) * (amb * 1.6 + uLightColor * 0.15 * sunUp);
  float T = exp(-max(depth, 0.0) * 0.32);
  // sun glitter
  vec3 H = normalize(uLightDir + V);
  float nh = max(dot(N, H), 0.0);
  float spec = (pow(nh, 900.0) * 140.0 + pow(nh, 120.0) * 4.0) * (1.0 + uNight * 6.0);
  vec3 specCol = uLightColor * spec * w_cloudShadow(wp) * w_terrainShadow(wp) * smoothstep(-0.02, 0.05, uLightDir.y);
  // shoreline foam/lapping
  float foamN = texture(uNoiseTex, wp.xz * 0.25 + t * 0.03).a;
  float lap = sin(depth * 14.0 - t * 1.6 + foamN * 6.0) * 0.5 + 0.5;
  float foam = smoothstep(0.3, 0.0, depth) * smoothstep(0.55, 0.85, foamN * 0.6 + lap * 0.5) * 0.55;
  vec3 foamCol = (amb * 0.9 + uLightColor * 0.35 * sunUp) * 0.6;
  // assemble (premultiplied)
  float a = 1.0 - T * (1.0 - F);
  vec3 prem = refl * F + scatterCol * (1.0 - T) * (1.0 - F) + specCol;
  prem = mix(prem, foamCol, foam);
  a = max(a, foam);
  // soft edge
  float edge = smoothstep(-0.15, 0.06, depth);
  a *= edge; prem *= edge;
  vec3 col = prem / max(a, 1e-3);
  col = w_applyAtmosphere(col, wp);
  gl_FragColor = vec4(col * a, a);
}
`;

export class Water {
  constructor() {
    const L = WORLD.lake;
    const geo = new THREE.PlaneGeometry(L.rx * 3.4, L.rz * 3.4, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.uniforms = {
      ...U,
      tRefl: { value: null },
      uHasRefl: { value: 0 },
      uTexMatrix: { value: new THREE.Matrix4() },
      uRipples: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, -100, 0)) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.set(L.x, WORLD.waterLevel, L.z);
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.mesh.renderOrder = 10;

    this.rippleIdx = 0;
    this.nextRipple = 2;

    // planar reflection
    this.virtualCamera = new THREE.PerspectiveCamera();
    this.virtualCamera.layers.set(0);
    this.rt = null;
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(WORLD.waterLevel - 0.25));
    this._v = new THREE.Vector3(); this._t = new THREE.Vector3(); this._lp = new THREE.Vector3();
    this._rot = new THREE.Matrix4(); this._n = new THREE.Vector3(0, 1, 0);
    this._rp = new THREE.Vector3(0, WORLD.waterLevel, 0);
  }

  setReflectionSize(w, h) {
    if (this.rt) this.rt.dispose();
    this.rt = new THREE.WebGLRenderTarget(Math.max(4, w | 0), Math.max(4, h | 0), {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.uniforms.tRefl.value = this.rt.texture;
  }

  update(dt, time, cameraPos) {
    // occasional fish rises near the player
    this.nextRipple -= dt;
    if (this.nextRipple <= 0) {
      this.nextRipple = 1.5 + Math.random() * 5;
      const L = WORLD.lake;
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.8;
      const r4 = this.uniforms.uRipples.value[this.rippleIdx++ % 6];
      r4.set(L.x + Math.cos(a) * L.rx * r, L.z + Math.sin(a) * L.rz * r, time, 0.6 + Math.random() * 0.8);
      return r4;
    }
    return null;
  }

  renderReflection(renderer, scene, camera, terrain) {
    if (!this.rt) return;
    const cam = camera;
    const n = this._n, rp = this._rp;
    rp.set(cam.position.x, WORLD.waterLevel, cam.position.z);
    const camPos = this._lp.setFromMatrixPosition(cam.matrixWorld);
    const view = this._v.subVectors(rp, camPos);
    if (view.dot(n) > 0) { this.uniforms.uHasRefl.value = 0; return; }
    this.uniforms.uHasRefl.value = 1;
    view.reflect(n).negate().add(rp);
    this._rot.extractRotation(cam.matrixWorld);
    const look = this._t.set(0, 0, -1).applyMatrix4(this._rot).add(camPos);
    const target = rp.clone().sub(look).reflect(n).negate().add(rp);
    const vc = this.virtualCamera;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(n);
    vc.lookAt(target);
    vc.near = cam.near; vc.far = cam.far; vc.fov = cam.fov; vc.aspect = cam.aspect;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(cam.projectionMatrix);
    vc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    const tm = this.uniforms.uTexMatrix.value;
    tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tm.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    const prevRT = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.clippingPlanes = [this.clipPlane];
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    if (terrain) terrain.uniforms.uSkirt.value = 0;
    renderer.render(scene, vc);
    if (terrain) terrain.uniforms.uSkirt.value = 1;
    renderer.setRenderTarget(prevRT);
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.autoUpdate = prevShadow;
  }
}
