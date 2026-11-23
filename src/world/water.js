import * as THREE from 'three';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { WORLD } from '../config.js';

export const LAYER_REFLECT = 1;
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

// Wet-sample grid used by the visibility and cache-coverage tests.
const WET_SPACING = 6;
const WET_TILE = 8;
// The shader draws water down to 0.15 m below ground; count those cells as wet.
const WET_MARGIN = 0.15;
const BORDER_RAYS = 24;
// Screen edges as NDC corner pairs: left, right, bottom, top.
const SCREEN_EDGES = [[-1, -1, -1, 1], [1, -1, 1, 1], [-1, -1, 1, -1], [-1, 1, 1, 1]];
// Cached reflection is reused only while every on-screen wet point maps inside the range the shader samples.
const COVER_MIN = 0.006, COVER_MAX = 0.994;
// The reflection view is this much wider than the camera's, so small turns between updates stay covered.
const REFL_VIEW_SCALE = 1.1;
// A cached sightline is rechecked once the camera has moved max(1 m, 1% of the distance to the point),
// staggered per point so a walking camera spreads the work over frames.
const OCC_RECHECK_MIN = 1.0, OCC_RECHECK_FRAC = 0.01;
// New sightline marches per scan; past this the water counts as visible for the frame.
const OCC_BUDGET = 400;

export class Water {
  constructor(opts = {}) {
    const region = opts.region || WORLD;
    this.region = region;
    this.waterLevel = region.waterLevel;
    const L = region.lake;
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
    this.mesh.position.set(L.x, this.waterLevel, L.z);
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.mesh.renderOrder = 10;

    this.rippleIdx = 0;
    this.nextRipple = 2;

    // Opt-in reflection layer: only systems/meshes that explicitly enable LAYER_REFLECT render here.
    this.virtualCamera = new THREE.PerspectiveCamera();
    this.virtualCamera.layers.set(LAYER_REFLECT);
    this.rt = null;
    this.reflValid = false;
    this._lastReflFrame = -Infinity;
    this._hf = opts.hf || null;
    this._registry = opts.registry || null;
    this._layersSynced = false;
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(this.waterLevel - 0.25));
    this._v = new THREE.Vector3(); this._t = new THREE.Vector3(); this._lp = new THREE.Vector3();
    this._rot = new THREE.Matrix4(); this._n = new THREE.Vector3(0, 1, 0);
    this._rp = new THREE.Vector3(0, this.waterLevel, 0);
    this._reflTarget = new THREE.Vector3();
    this._samplePt = new THREE.Vector3();
    this._e0 = new THREE.Vector3(); this._e1 = new THREE.Vector3(); this._ed = new THREE.Vector3();
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._tmNext = new THREE.Matrix4();
    this._cacheCamWorld = new THREE.Matrix4();
    this._cacheCamProj = new THREE.Matrix4();
    // Coarse gate: the whole water mesh, so slivers the wet grid misses are still tested by edge rays.
    this.lakeBounds = new THREE.Box3(
      new THREE.Vector3(L.x - L.rx * 1.7, this.waterLevel - 0.5, L.z - L.rz * 1.7),
      new THREE.Vector3(L.x + L.rx * 1.7, this.waterLevel + 0.5, L.z + L.rz * 1.7),
    );
    this.wetTiles = [];
    this._initWetTiles(this._hf);
  }

  /**
   * Group every wet grid point (lake surface above the ground) into tiles with tight bounds.
   * Without a height field the whole water mesh counts as wet.
   */
  _initWetTiles(hf) {
    const L = this.region.lake;
    const wl = this.waterLevel;
    const x0 = L.x - L.rx * 1.7, z0 = L.z - L.rz * 1.7;
    const nx = Math.ceil((L.rx * 3.4) / WET_SPACING), nz = Math.ceil((L.rz * 3.4) / WET_SPACING);
    const tiles = new Map();
    let count = 0;
    for (let iz = 0; iz <= nz; iz++) {
      const z = z0 + iz * WET_SPACING;
      for (let ix = 0; ix <= nx; ix++) {
        const x = x0 + ix * WET_SPACING;
        if (hf && hf.height(x, z) > wl + WET_MARGIN) continue;
        const key = ((iz / WET_TILE) | 0) * 100000 + ((ix / WET_TILE) | 0);
        let t = tiles.get(key);
        if (!t) {
          t = { pts: [], box: new THREE.Box3(), first: 0 };
          tiles.set(key, t);
        }
        t.pts.push(x, z);
        count++;
      }
    }
    const h = WET_SPACING * 0.5;
    let offset = 0;
    for (const t of tiles.values()) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < t.pts.length; i += 2) {
        minX = Math.min(minX, t.pts[i]); maxX = Math.max(maxX, t.pts[i]);
        minZ = Math.min(minZ, t.pts[i + 1]); maxZ = Math.max(maxZ, t.pts[i + 1]);
      }
      t.box.min.set(minX - h, wl - 0.5, minZ - h);
      t.box.max.set(maxX + h, wl + 0.5, maxZ + h);
      t.first = offset;
      offset += t.pts.length / 2;
      this.wetTiles.push(t);
    }
    // Per point: 0 = unknown, 1 = clear sightline, 2 = blocked, plus the camera position it was found from
    // and a stagger factor for the recheck distance.
    this._occ = new Uint8Array(count);
    this._occPos = new Float32Array(count * 3);
    this._occJit = new Float32Array(count);
    for (let k = 0; k < count; k++) this._occJit[k] = 0.75 + 0.5 * (((k * 2654435761) >>> 0) / 4294967296);
  }

  syncReflectionLayers(registry = this._registry) {
    if (!registry) return;
    const sky = registry.instance('sky');
    if (sky?.mesh) sky.mesh.layers.enable(LAYER_REFLECT);
    const clouds = registry.instance('clouds');
    if (clouds?.mesh) clouds.mesh.layers.enable(LAYER_REFLECT);
    const terrain = registry.instance('terrain');
    if (terrain?.mesh) terrain.mesh.layers.enable(LAYER_REFLECT);
    const lighting = registry.get('lighting');
    if (lighting?.sunLight) lighting.sunLight.layers.enable(LAYER_REFLECT);
    if (lighting?.hemi) lighting.hemi.layers.enable(LAYER_REFLECT);
    this._layersSynced = true;
  }

  invalidateReflection() {
    this.reflValid = false;
    this._lastReflFrame = -Infinity;
    this.uniforms.uHasRefl.value = 0;
  }

  /**
   * Height-field-only sightline from the camera to a water point. Trees are ignored on purpose:
   * a canopy guess can hide real gaps, and a wasted reflection beats a missing one.
   */
  _sightClear(cx, cy, cz, wx, wz) {
    const hf = this._hf;
    if (!hf) return true;
    const wl = this.waterLevel;
    const dx = wx - cx, dz = wz - cz;
    const dist = Math.hypot(dx, dz);
    // The shoreline bank right at the target sits at water level; don't let it block its own water.
    const endF = dist > 4 ? 1 - 3 / dist : 0;
    const steps = Math.min(64, Math.max(8, Math.ceil(dist / 12)));
    for (let s = 1; s < steps; s++) {
      const f = s / steps;
      if (f > endF) break;
      if (hf.height(cx + dx * f, cz + dz * f) > cy + (wl - cy) * f + 0.3) return false;
    }
    return true;
  }

  /**
   * One pass over the water that is on screen now.
   * visible: some on-screen wet point has a clear sightline.
   * covered: every on-screen wet point (occluded or not) maps inside the cached reflection via coverTm.
   */
  _scanWater(camera, coverTm = null) {
    const wl = this.waterLevel;
    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const fr = this._frustum.setFromProjectionMatrix(this._projScreen);
    const res = { visible: false, covered: true };
    if (!fr.intersectsBox(this.lakeBounds)) return res;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const occ = this._occ, occPos = this._occPos, occJit = this._occJit;
    let budget = OCC_BUDGET;
    const te = coverTm ? coverTm.elements : null;
    const inCover = (x, z) => {
      const w = te[3] * x + te[7] * wl + te[11] * z + te[15];
      if (w <= 1e-5) return false;
      const u = (te[0] * x + te[4] * wl + te[8] * z + te[12]) / w;
      const v = (te[1] * x + te[5] * wl + te[9] * z + te[13]) / w;
      return u >= COVER_MIN && u <= COVER_MAX && v >= COVER_MIN && v <= COVER_MAX;
    };
    const pt = this._samplePt;
    for (const t of this.wetTiles) {
      if (!fr.intersectsBox(t.box)) continue;
      const pts = t.pts;
      for (let i = 0, k = t.first; i < pts.length; i += 2, k++) {
        const x = pts[i], z = pts[i + 1];
        pt.set(x, wl, z);
        if (!fr.containsPoint(pt)) continue;
        if (te && res.covered && !inCover(x, z)) res.covered = false;
        if (!res.visible) {
          const k3 = k * 3;
          if (occ[k] !== 0) {
            const mx = cx - occPos[k3], my = cy - occPos[k3 + 1], mz = cz - occPos[k3 + 2];
            const lim = Math.max(OCC_RECHECK_MIN, Math.hypot(x - cx, z - cz) * OCC_RECHECK_FRAC) * occJit[k];
            if (mx * mx + my * my + mz * mz > lim * lim) occ[k] = 0;
          }
          if (occ[k] === 0) {
            if (budget-- <= 0) {
              res.visible = true;
            } else {
              occ[k] = this._sightClear(cx, cy, cz, x, z) ? 1 : 2;
              occPos[k3] = cx; occPos[k3 + 1] = cy; occPos[k3 + 2] = cz;
            }
          }
          if (occ[k] === 1) res.visible = true;
        }
        if (res.visible && (!te || !res.covered)) return res;
      }
    }
    // Screen-edge rays catch slivers of water narrower than the wet grid spacing. Along each edge the
    // directions are blends of its two corner directions; extra samples step geometrically towards the
    // horizon, where a few pixels of screen span many metres of water.
    const hf = this._hf;
    const L = this.region.lake;
    const d0 = this._e0, d1 = this._e1, d = this._ed;
    const edgeHit = (al) => {
      d.copy(d0).lerp(d1, al);
      if (d.y >= -1e-7) return false;
      const f = (wl - cy) / d.y;
      const x = cx + d.x * f, z = cz + d.z * f;
      if (Math.abs(x - L.x) > L.rx * 1.7 || Math.abs(z - L.z) > L.rz * 1.7) return false;
      if (hf && hf.height(x, z) > wl + WET_MARGIN) return false;
      if (te && res.covered && !inCover(x, z)) res.covered = false;
      if (!res.visible && (budget-- <= 0 || this._sightClear(cx, cy, cz, x, z))) res.visible = true;
      return res.visible && (!te || !res.covered);
    };
    for (const [ax, ay, bx, by] of SCREEN_EDGES) {
      d0.set(ax, ay, 0.5).unproject(camera).sub(camera.position);
      d1.set(bx, by, 0.5).unproject(camera).sub(camera.position);
      for (let j = 0; j <= BORDER_RAYS; j++) if (edgeHit(j / BORDER_RAYS)) return res;
      const y0 = d0.y, y1 = d1.y;
      if ((y0 < 0) !== (y1 < 0)) {
        const below = y0 < 0 ? y0 : y1;
        for (let k = 1, dy = below; k <= 50; k++) {
          dy *= 0.9;
          if (edgeHit((dy - y0) / (y1 - y0))) return res;
        }
      }
    }
    return res;
  }

  isLakeVisible(camera) {
    return this._scanWater(camera).visible;
  }

  setReflectionSize(w, h) {
    if (this.rt) this.rt.dispose();
    this.rt = new THREE.WebGLRenderTarget(Math.max(4, w | 0), Math.max(4, h | 0), {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.uniforms.tRefl.value = this.rt.texture;
    this.invalidateReflection();
  }

  update(dt, time, cameraPos) {
    this.nextRipple -= dt;
    if (this.nextRipple <= 0) {
      this.nextRipple = 1.5 + Math.random() * 5;
      const L = this.region.lake;
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.8;
      const r4 = this.uniforms.uRipples.value[this.rippleIdx++ % 6];
      r4.set(L.x + Math.cos(a) * L.rx * r, L.z + Math.sin(a) * L.rz * r, time, 0.6 + Math.random() * 0.8);
      return r4;
    }
    return null;
  }

  renderReflection(renderer, scene, camera, terrain, opts = {}) {
    // No target, no water in the scene, or a lost context (texture contents are gone): nothing to reuse.
    if (!this.rt || !this.mesh.parent || renderer.getContext?.().isContextLost?.()) {
      this.invalidateReflection();
      return false;
    }
    const every = opts.every ?? 1;
    const force = !!opts.force;
    const frameNo = opts.frameNo ?? 0;
    if (every <= 0 && !force) {
      this.invalidateReflection();
      return false;
    }

    const cam = camera;
    const n = this._n, rp = this._rp;
    cam.updateMatrixWorld();
    const camPos = this._lp.setFromMatrixPosition(cam.matrixWorld);
    rp.set(camPos.x, this.waterLevel, camPos.z);
    const view = this._v.subVectors(rp, camPos);
    if (view.dot(n) >= 0) {
      this.invalidateReflection();
      return false;
    }

    const cadenceDue = force || !this.reflValid || every <= 1 || frameNo < this._lastReflFrame || (frameNo - this._lastReflFrame) >= every;
    const camSame = !cadenceDue &&
      cam.matrixWorld.equals(this._cacheCamWorld) && cam.projectionMatrix.equals(this._cacheCamProj);
    const scan = this._scanWater(cam, cadenceDue || camSame ? null : this.uniforms.uTexMatrix.value);
    if (!scan.visible) {
      this.invalidateReflection();
      return false;
    }

    // Reuse the cached texture, matrix and valid flag together while they still cover the visible water.
    if (!cadenceDue && scan.covered) {
      this.uniforms.uHasRefl.value = 1;
      return false;
    }

    if (!this._layersSynced) this.syncReflectionLayers();

    view.reflect(n).negate().add(rp);
    this._rot.extractRotation(cam.matrixWorld);
    const look = this._t.set(0, 0, -1).applyMatrix4(this._rot).add(camPos);
    const target = this._reflTarget.copy(rp).sub(look).reflect(n).negate().add(rp);
    const vc = this.virtualCamera;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(n);
    vc.lookAt(target);
    vc.near = cam.near; vc.far = cam.far; vc.fov = cam.fov; vc.aspect = cam.aspect;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(cam.projectionMatrix);
    vc.projectionMatrix.elements[0] /= REFL_VIEW_SCALE;
    vc.projectionMatrix.elements[5] /= REFL_VIEW_SCALE;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
    const tmNext = this._tmNext;
    tmNext.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    tmNext.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    // The clear below destroys the cached texture, so the cache is invalid until this draw succeeds.
    this.invalidateReflection();
    const prevRT = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.clippingPlanes = [this.clipPlane];
    const reflTerrainOpts = {
      lodK: opts.reflTerrainLodK,
      minSize: opts.reflTerrainMinSize,
      maxNodes: opts.reflTerrainMaxNodes,
      waterLevel: this.waterLevel,
      minY: this.waterLevel - 1,
    };
    try {
      renderer.setRenderTarget(this.rt);
      renderer.clear();
      if (terrain?.beginReflection) terrain.beginReflection(vc, reflTerrainOpts);
      else if (terrain) terrain.uniforms.uSkirt.value = 0;
      renderer.render(scene, vc);
    } finally {
      if (terrain?.endReflection) terrain.endReflection();
      else if (terrain) terrain.uniforms.uSkirt.value = 1;
      renderer.setRenderTarget(prevRT);
      renderer.clippingPlanes = prevClip;
      renderer.shadowMap.autoUpdate = prevShadow;
    }

    this.uniforms.uTexMatrix.value.copy(tmNext);
    this._cacheCamWorld.copy(cam.matrixWorld);
    this._cacheCamProj.copy(cam.projectionMatrix);
    this.reflValid = true;
    this._lastReflFrame = frameNo;
    this.uniforms.uHasRefl.value = 1;
    return true;
  }

  setTier(tier) {
    this.invalidateReflection();
    this._layersSynced = false;
    if (tier && tier.reflEvery === 0) this.uniforms.uHasRefl.value = 0;
  }

  dispose() {
    this.invalidateReflection();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.rt) { this.rt.dispose(); this.rt = null; }
  }
}

export function createWater(ctx, noWater = false) {
  ctx.camera.layers.enable(LAYER_NO_REFLECT);
  const water = new Water({ hf: ctx.data?.hf, region: ctx.data?.region, registry: ctx.registry });
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
