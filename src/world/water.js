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
  float rough = (0.11 + cat * 0.85) * (0.35 + uWindStrength);
  vec2 s = vec2(0.0);
  s += (texture(uNoiseTex, p * 0.031 + wd * t * 0.010).gb - 0.5) * 0.52;
  s += (texture(uNoiseTex, p * 0.093 - wd.yx * t * 0.021 + 0.3).gb - 0.5) * 0.42;
  s += (texture(uNoiseTex, p * 0.27 + wd * t * 0.045 + 0.7).br - 0.5) * 0.32;
  s += (texture(uNoiseTex, p * 0.71 - wd * t * 0.08).gr - 0.5) * 0.20;
  s *= rough;
  s += (texture(uNoiseTex, p * 0.008 + t * 0.002).gb - 0.5) * 0.08;
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
  s *= mix(1.0, 0.35, smoothstep(80.0, 900.0, dist));
  vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
  float cosT = max(dot(N, V), 0.0);
  float highView = smoothstep(220.0, 680.0, cameraPosition.y - uWaterLevel);
  float shoreSoft = smoothstep(0.0, 1.65, depth);
  float F = mix(0.03, 0.26, highView) + (1.0 - mix(0.03, 0.26, highView)) * pow(1.0 - cosT, 4.4);
  F = max(F, uDawn * 0.32 * shoreSoft);
  F = clamp(F, 0.0, 0.92) * mix(0.24, 1.0, shoreSoft);
  vec3 R = reflect(-V, N);
  vec3 refl;
  vec3 skyR = w_sky(normalize(vec3(R.x, max(R.y, 0.02), R.z)));
  if (uHasRefl > 0.5){
    vec2 uv = vReflUV.xy / vReflUV.w;
    float dAmp = mix(0.028, 0.012, smoothstep(60.0, 500.0, dist)) * (0.55 + 0.45 * shoreSoft);
    uv = clamp(uv + N.xz * dAmp, vec2(0.004), vec2(0.996));
    // smooth rippled 9-tap horizontal-anisotropic reflection filter (KILLS hard-edged cloud reflection cutouts & shoreline seam in lakeSunset.png & dawn.png!)
    vec2 px = vec2(0.0026, 0.0038) * mix(0.9, 1.9, smoothstep(80.0, 600.0, dist));
    refl = texture(tRefl, uv).rgb * 0.28
         + (texture(tRefl, clamp(uv + vec2(px.x, 0.0), vec2(0.004), vec2(0.996))).rgb
         +  texture(tRefl, clamp(uv - vec2(px.x, 0.0), vec2(0.004), vec2(0.996))).rgb) * 0.16
         + (texture(tRefl, clamp(uv + vec2(0.0, px.y), vec2(0.004), vec2(0.996))).rgb
         +  texture(tRefl, clamp(uv - vec2(0.0, px.y), vec2(0.004), vec2(0.996))).rgb) * 0.12
         + (texture(tRefl, clamp(uv + vec2(px.x * 1.8, px.y * 0.8), vec2(0.004), vec2(0.996))).rgb
         +  texture(tRefl, clamp(uv - vec2(px.x * 1.8, px.y * 0.8), vec2(0.004), vec2(0.996))).rgb) * 0.08;
    // gently blend reflected clouds near shallow shoreline so reflections dissolve softly into ripples instead of ending with a hard pink cliff!
    refl = mix(mix(refl, skyR * 0.72, 0.35), refl, smoothstep(0.05, 1.85, depth));
  } else refl = skyR;
  // high-altitude summit vista boost: make Stillwater Lake gleam like a bright azure sky-mirror centerpiece in summit.png!
  refl = mix(refl, max(refl, skyR * vec3(0.95, 1.08, 1.24)), highView * 0.56);
  // preserve crisp planar peak & tree reflections at dawn/sunset — only add warm peach glint strictly toward the sun (NO lilac smear!)
  {
    float lowSun = max(uGolden, uDawn);
    float sunAlign = pow(max(dot(normalize(vec3(R.x, 0.0, R.z) + 1e-4), normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4)), 0.0), 3.0);
    vec3 peachGlint = vec3(1.0, 0.72, 0.46) * (0.22 + 0.35 * sunAlign);
    refl = mix(refl, max(refl, peachGlint), lowSun * sunAlign * 0.26);
  }

  // depth-graded crystal turquoise shallows -> deep alpine sapphire water body!
  vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
  float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
  float shallowK = exp(-max(depth, 0.0) * 0.55);
  vec3 shallowCol = vec3(0.04, 0.36, 0.38);
  vec3 deepCol    = vec3(0.02, 0.13, 0.24);
  vec3 waterTint  = mix(deepCol, shallowCol, shallowK);
  vec3 scatterCol = waterTint * (amb * 1.75 + uLightColor * (0.14 + 0.18 * shallowK) * sunUp);

  // translucent crystal shallows let golden pebbled bottom & caustics shine through!
  float T = exp(-max(depth, 0.0) * 0.38);

  // painterly clamped sun glitter: crisp dancing diamond sparkles without blowing out to pure white!
  vec3 H = normalize(uLightDir + V);
  float nh = max(dot(N, H), 0.0);
  float sparkle = pow(nh, 650.0) * 18.0 + pow(nh, 110.0) * 1.65;
  sparkle = min(sparkle, 6.2) * (1.0 + uNight * 4.5);
  vec3 specTint = mix(vec3(1.0, 0.98, 0.90), vec3(1.0, 0.76, 0.48), max(uGolden, uDawn));
  vec3 specCol = uLightColor * specTint * sparkle * w_cloudShadow(wp) * w_terrainShadow(wp) * smoothstep(-0.02, 0.05, uLightDir.y);

  // crisp animated shoreline foam lapping lines
  float foamN = texture(uNoiseTex, wp.xz * 0.24 + t * 0.028).a;
  float foamN2 = texture(uNoiseTex, wp.xz * 0.65 - t * 0.04).g;
  float lap = sin(depth * 18.0 - t * 1.8 + foamN * 6.5) * 0.5 + 0.5;
  float shoreLine = smoothstep(0.42, 0.0, depth) * smoothstep(0.48, 0.80, foamN * 0.55 + lap * 0.55);
  float fineRim = smoothstep(0.14, 0.0, depth) * (0.5 + 0.5 * foamN2);
  float foam = clamp(max(shoreLine * 0.65, fineRim * 0.75), 0.0, 0.85);
  vec3 foamCol = (amb * 1.05 + uLightColor * 0.36 * sunUp) * 0.72;

  // assemble premultiplied
  float a = 1.0 - T * (1.0 - F);
  vec3 prem = refl * F + scatterCol * (1.0 - T) * (1.0 - F) + specCol;
  prem = mix(prem, foamCol, foam);
  a = max(a, foam);
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

  setTier(tier) {
    if (tier.reflEvery === 0) this.uniforms.uHasRefl.value = 0;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.rt) { this.rt.dispose(); this.rt = null; }
  }
}

export function createWater(ctx, noWater = false) {
  ctx.camera.layers.enable(LAYER_NO_REFLECT);
  const water = new Water();
  if (!noWater) ctx.scene.add(water.mesh);
  return {
    instance: water,
    update(frame) {
      const rip = water.update(frame.dt, frame.t, frame.camera.position);
      if (rip) frame.onWaterRipple?.(rip);
    },
    setTier(tier) {
      water.setTier(tier);
    },
    dispose() {
      water.dispose();
    },
  };
}
