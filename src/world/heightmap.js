import * as THREE from 'three';
import { NOISE } from '../glsl/common.js';
import { WORLD } from '../config.js';
import { getCaps } from '../engine/caps.js';

// Procedural terrain height function, evaluated on the GPU into float textures.
const GEN_FRAG = /* glsl */ `
precision highp float;
uniform vec2 uCenter;
uniform float uSize;
uniform float uRes;
uniform int uOct;
uniform vec2 uLake;
uniform vec2 uLakeR;
uniform vec2 uSummit;
uniform vec2 uValley;
uniform float uWater;
${NOISE}
const mat2 m2 = mat2(0.8, -0.6, 0.6, 0.8);
float fbm4(vec2 p){
  float a = 0.0, b = 0.5;
  for (int i = 0; i < 4; i++){ a += b * n_noised(p).x; b *= 0.5; p = m2 * p * 2.01; }
  return a;
}
// erosion-like fbm: derivative damping makes smooth valleys and sharper ridges
float erodedFbm(vec2 p, int oct){
  float a = 0.0, b = 0.5; vec2 d = vec2(0.0);
  for (int i = 0; i < 12; i++){
    if (i >= oct) break;
    vec3 n = n_noised(p);
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    b *= 0.5; p = m2 * p * 2.0;
  }
  return a;
}
float ridgedFbm(vec2 p, int oct){
  float a = 0.0, b = 0.55, w = 1.0;
  for (int i = 0; i < 12; i++){
    if (i >= oct) break;
    float v = n_noised(p).x;
    float n = 1.0 - sqrt(v * v + 0.015);
    n = max(n, 0.0);
    n = n * n;
    a += b * n * w;
    w = clamp(n * 1.75, 0.0, 1.0);
    b *= 0.5; p = m2 * p * 2.04;
  }
  return a;
}
// clean straight-sided triangular alpine ridges (BotW/Ghibli pyramidal arêtes — ZERO curved U-shaped horseshoe wax bowls!)
float ridgedTri(vec2 p, int oct){
  float a = 0.0, b = 0.64;
  for (int i = 0; i < 4; i++){
    if (i >= oct) break;
    float v = n_noised(p).x;
    float n = max(1.0 - abs(v), 0.0);
    a += b * n;
    b *= 0.44; p = m2 * p * 1.94;
  }
  return a;
}
float terrainRaw(vec2 p){
  vec2 q = p * 0.001;
  vec2 w = vec2(fbm4(q * 0.42 + vec2(1.7, 9.2)), fbm4(q * 0.42 + vec2(8.3, 2.8)));
  vec2 qw = q + w * 0.5;
  float r = length(p - uValley) * 0.001;
  vec2 dl = (p - uLake) / uLakeR;
  float rl = length(dl);
  float hills = erodedFbm(qw * 0.85 + 2.0, uOct);
  // outside the walkable valley (r > 2.1 km), smooth out high-frequency hill wrinkles so mid-distance foothills
  // read as broad, sweeping Ghibli velvet slopes while keeping walkable valley 100% exact!
  float farRing = smoothstep(2.1, 3.8, r);
  float smoothHills = fbm4(q * 0.34 + vec2(2.0, 2.0));
  float hillsUse = mix(hills, smoothHills, farRing);
  float amp = mix(28.0, 120.0, smoothstep(0.9, 2.4, rl));
  float h = 68.0 + hillsUse * amp;
  // secondary hills rising out of the valley
  h += smoothstep(0.55, 2.0, r) * (0.55 + 0.45 * hillsUse) * 240.0;
  // great alpine ranges all around (strictly outside walkable valley: mm = 0 for r < 2.0 km so trail/cottage/lake stay 100% exact!)
  // Clean low-frequency triangular pyramidal peaks + sharp distant horizon sierra (ZERO multi-octave wormy ripples or horseshoe grooves!)
  float mm = smoothstep(2.02, 4.9, r + w.x * 0.42);
  float massif = fbm4(q * 0.16 + vec2(7.0, -2.0)) * 0.5 + 0.5;
  float tri1 = ridgedTri(q * 0.21 + vec2(4.0, 1.3), 3);
  float tri2 = ridgedTri(q * 0.11 + vec2(-3.0, 7.0), 2);
  float peakForm = pow(max(tri1 * 0.86, 0.0), 1.42);
  float spire    = pow(max(tri1 * 0.92, 0.0), 2.35);
  float mountains = massif * 520.0
    + peakForm * 2150.0 * (0.52 + 0.72 * massif)
    + spire * 620.0;
  mountains += pow(max(tri2 * 0.92, 0.0), 1.35) * 1950.0 * smoothstep(4.5, 8.8, r);
  // a deliberate notch in the western range so the sun sets into it
  {
    vec2 fromS = p - uSummit;
    float az = atan(fromS.y, fromS.x);
    float da = az - (-2.77);
    da = atan(sin(da), cos(da));
    float notch = exp(-da * da / (2.0 * 0.16 * 0.16)) * smoothstep(800.0, 2500.0, length(fromS));
    mountains *= 1.0 - 0.72 * notch;
  }
  h += mm * mountains;
  // the summit we hike to (kept exact so trail & benches stay aligned)
  vec2 ds = p - uSummit;
  vec2 dsw = ds + w * 40.0 * smoothstep(60.0, 300.0, length(ds));
  dsw = mat2(0.87, -0.5, 0.5, 0.87) * dsw * vec2(1.0, 1.35);
  float dd = length(dsw);
  float dome = exp(-dot(ds, ds) / (2.0 * 430.0 * 430.0));
  float rid = ridgedFbm(dsw * 0.004 + 3.7, 4);
  float peak = exp(-dd / (150.0 + 60.0 * rid));
  h += (230.0 * dome + 160.0 * peak) * (0.82 + 0.25 * hills) + 60.0 * rid * dome;
  // the lake basin
  float shoreN = fbm4(p * 0.004 + 3.3) * 0.32 + fbm4(p * 0.017) * 0.07;
  float ld = length(dl + 0.18 * w) + shoreN;
  float lakeMask = 1.0 - smoothstep(0.85, 1.75, ld);
  float bed = uWater - 0.8 - 14.0 * smoothstep(1.0, 0.25, ld);
  float beach = uWater + max(0.0, ld - 1.0) * 26.0;
  float basin = ld < 1.0 ? bed : beach;
  h = mix(h, min(h, basin), lakeMask);
  return h;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uCenter + (uv - 0.5) * uSize;
  gl_FragColor = vec4(terrainRaw(p), 0.0, 0.0, 1.0);
}
`;

function genMaterial(center, size, res, oct, region = WORLD) {
  const W = region;
  return new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: new THREE.Vector2(center.x, center.y) },
      uSize: { value: size },
      uRes: { value: res },
      uOct: { value: oct },
      uLake: { value: new THREE.Vector2(W.lake.x, W.lake.z) },
      uLakeR: { value: new THREE.Vector2(W.lake.rx, W.lake.rz) },
      uSummit: { value: new THREE.Vector2(W.summit.x, W.summit.z) },
      uValley: { value: new THREE.Vector2(W.valley.x, W.valley.z) },
      uWater: { value: W.waterLevel },
    },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: GEN_FRAG,
    depthTest: false,
    depthWrite: false,
  });
}

export function fullscreenQuad(material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const m = new THREE.Mesh(geo, material);
  m.frustumCulled = false;
  return m;
}

export function renderToTarget(renderer, material, target) {
  const scene = new THREE.Scene();
  const quad = fullscreenQuad(material);
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  quad.geometry.dispose();
}

function generateGridRaw(renderer, size, res, oct, region = WORLD) {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
  });
  const mat = genMaterial({ x: 0, y: 0 }, size, res, oct, region);
  renderToTarget(renderer, mat, rt);
  const buf = new Float32Array(res * res * 4);
  const strip = 256;
  const tmp = new Float32Array(res * strip * 4);
  for (let y = 0; y < res; y += strip) {
    renderer.readRenderTargetPixels(rt, 0, y, res, strip, tmp);
    buf.set(tmp, y * res * 4);
  }
  const h = new Float32Array(res * res);
  for (let i = 0; i < res * res; i++) h[i] = buf[i * 4];
  rt.dispose();
  mat.dispose();
  return h;
}

/** Generate the raw near heightmap on the GPU and read it back (dev/bake path). */
export function generateNearRaw(renderer, region = WORLD) {
  return generateGridRaw(renderer, region.size, region.res, 9, region);
}

/** Generate the raw far heightmap on the GPU and read it back (dev/bake path). */
export function generateFarRaw(renderer, region = WORLD) {
  return generateGridRaw(renderer, region.farSize, region.farRes, 8, region);
}

/** Generate the far heightmap directly into a GPU texture (dev path). */
export function generateFar(renderer, region = WORLD) {
  const { farRes, farSize } = region;
  const caps = getCaps(renderer);
  const useFloat = caps.floatRenderable;
  const filter = useFloat ? caps.floatTexFilter : THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(farRes, farRes, {
    type: useFloat ? THREE.FloatType : caps.hdrTargetType,
    format: THREE.RGFormat,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
  const mat = genMaterial({ x: 0, y: 0 }, farSize, farRes, 8, region);
  renderToTarget(renderer, mat, rt);
  mat.dispose();
  return rt;
}

/** Upload near height + trail/stream mask arrays into the shared RG32F height texture. */
export function createNearHeightTexture(heights, mask, res, caps = null) {
  const rg = new Float32Array(res * res * 2);
  for (let i = 0; i < res * res; i++) {
    rg[i * 2] = heights[i];
    rg[i * 2 + 1] = mask[i];
  }
  // Keep 32-bit float storage for sub-centimetre precision; switch to NearestFilter
  // when OES_texture_float_linear is missing so shaders run manual bilinear texelFetch.
  const filter = caps ? caps.floatTexFilter : THREE.LinearFilter;
  const tex = new THREE.DataTexture(rg, res, res, THREE.RGFormat, THREE.FloatType);
  tex.magFilter = filter;
  tex.minFilter = filter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Upload a baked far height array into the shared R32F far height texture. */
export function createFarHeightTexture(farHeights, farRes, caps = null) {
  const filter = caps ? caps.floatTexFilter : THREE.LinearFilter;
  const tex = new THREE.DataTexture(farHeights, farRes, farRes, THREE.RedFormat, THREE.FloatType);
  tex.magFilter = filter;
  tex.minFilter = filter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** CPU-side height field with bilinear sampling, matching GPU texture sampling. */
export class HeightField {
  constructor(heights, trail, res, size) {
    this.h = heights;
    this.trail = trail;
    this.res = res;
    this.size = size;
  }
  _sample(arr, x, z) {
    const { res, size } = this;
    let fx = (x / size + 0.5) * res - 0.5;
    let fz = (z / size + 0.5) * res - 0.5;
    fx = Math.min(Math.max(fx, 0), res - 1.001);
    fz = Math.min(Math.max(fz, 0), res - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const i = iz * res + ix;
    const a = arr[i], b = arr[i + 1], c = arr[i + res], d = arr[i + res + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  height(x, z) { return this._sample(this.h, x, z); }
  trailAt(x, z) { return Math.abs(this._sample(this.trail, x, z)); }
  isPath(x, z) { return this._sample(this.trail, x, z) > 0.4; }
  normal(x, z, e = 1.0, out = { x: 0, y: 1, z: 0 }) {
    const hx = this.height(x - e, z) - this.height(x + e, z);
    const hz = this.height(x, z - e) - this.height(x, z + e);
    const l = Math.hypot(hx, 2 * e, hz);
    out.x = hx / l; out.y = (2 * e) / l; out.z = hz / l;
    return out;
  }
}
