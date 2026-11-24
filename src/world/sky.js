import * as THREE from 'three';
import { NOISE, WORLD_PARS, WORLD_FUNCS } from '../glsl/common.js';
import { getCaps } from '../engine/caps.js';
import { U } from '../uniforms.js';
import { fullscreenQuad } from './heightmap.js';
import { isCaptureRenderer, registerAsyncReadback } from '../engine/app.js';

// Physically-inspired stylized sky: single-scattering LUT + vivid azure dome,
// luminous peach-to-indigo dusk/dawn gradient, early stars & Milky Way, crisp high cirrus.

const LUT_W = 192, LUT_H = 108;
const LUT_DIR_THRESHOLD = 0.0015;
const LUT_INTENSITY_THRESHOLD = 0.0005;
const CAPTURE_EPS = 1e-6;
export const AMBIENT_READ_TIMEOUT_MS = 500;
const AMB_MAX_FAILURES = 3;

// Key strictly on the inputs LUT_FRAG reads (sun/moon direction and intensity),
// compared against the last rendered LUT state so small per-frame deltas accumulate.
export function shouldUpdateSkyLUT(prev, next, { force = false, capture = false } = {}) {
  if (force || !prev.valid) return true;
  const dirEps = capture ? CAPTURE_EPS : LUT_DIR_THRESHOLD;
  const intEps = capture ? CAPTURE_EPS : LUT_INTENSITY_THRESHOLD;
  if (next.sunDir.distanceTo(prev.sunDir) >= dirEps) return true;
  if ((next.moonI > 0 || prev.moonI > 0) && next.moonDir.distanceTo(prev.moonDir) >= dirEps) return true;
  if (Math.abs(next.sunI - prev.sunI) >= intEps) return true;
  if (Math.abs(next.moonI - prev.moonI) >= intEps) return true;
  return false;
}

export function decodeRGBE(r, g, b, eByte) {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(eByte)) {
    return null;
  }
  if (eByte <= 0) return [0, 0, 0];
  const scale = Math.pow(2, eByte - 128) / 255;
  return [r * scale, g * scale, b * scale];
}

// Downsample the 192x108 sky LUT into an RGBA8 2x1 RGBE target (pixel 0 = sky dome average,
// pixel 1 = horizon band average) so ambient readback needs no EXT_color_buffer_float and transfers 8 bytes async.
const AMB_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uSkyLUT;
// The LUT stores colour / uLutEncode when it falls back to an 8-bit target (no float render targets).
uniform float uLutEncode;
vec4 encodeRGBE(vec3 c) {
  c = max(c, vec3(0.0));
  float v = max(c.r, max(c.g, c.b));
  if (v < 1e-32) return vec4(0.0);
  float e = clamp(floor(log2(v)) + 1.0, -127.0, 127.0);
  float scale = exp2(-e);
  return vec4(clamp(c * scale, 0.0, 1.0), (e + 128.0) / 255.0);
}
void main(){
  vec3 acc = vec3(0.0);
  if (gl_FragCoord.x < 1.0) {
    // Rows [66, 108), even columns (exact texel centers; no float-linear dependency).
    for (int iy = 0; iy < 42; iy++) {
      float v = (66.0 + float(iy) + 0.5) / 108.0;
      for (int ix = 0; ix < 96; ix++) {
        float u = (float(ix) * 2.0 + 0.5) / 192.0;
        vec3 c = texture(uSkyLUT, vec2(u, v)).rgb * uLutEncode;
        if (!any(isnan(c)) && !any(isinf(c))) acc += c;
      }
    }
    acc /= 4032.0;
  } else {
    // Rows [54, 64), even columns.
    for (int iy = 0; iy < 10; iy++) {
      float v = (54.0 + float(iy) + 0.5) / 108.0;
      for (int ix = 0; ix < 96; ix++) {
        float u = (float(ix) * 2.0 + 0.5) / 192.0;
        vec3 c = texture(uSkyLUT, vec2(u, v)).rgb * uLutEncode;
        if (!any(isnan(c)) && !any(isinf(c))) acc += c;
      }
    }
    acc /= 960.0;
  }
  gl_FragColor = encodeRGBE(acc);
}
`;

const LUT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunI;
uniform float uMoonI;
uniform vec2 uRes;
uniform float uLutEncode;
const float PI = 3.14159265;
const float Re = 6360e3;
const float Ra = 6460e3;
const vec3 betaR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const vec3 betaOz = vec3(0.650e-6, 1.881e-6, 0.085e-6);
const float betaM = 8.0e-6;
const float HR = 8000.0;
const float HM = 1200.0;
vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd); float c = dot(ro, ro) - r*r; float d = b*b - c;
  if (d < 0.0) return vec2(-1.0);
  d = sqrt(d); return vec2(-b - d, -b + d);
}
vec3 transmittanceTo(vec3 p, vec3 L){
  float tA = raySphere(p, L, Ra).y;
  float tG = raySphere(p, L, Re).x;
  if (tG > 0.0) return vec3(0.0);
  const int S = 6;
  float ds = tA / float(S);
  float odR = 0.0, odM = 0.0, odO = 0.0;
  for (int i = 0; i < S; i++){
    vec3 q = p + L * (float(i) + 0.5) * ds;
    float h = length(q) - Re;
    odR += exp(-h/HR) * ds; odM += exp(-h/HM) * ds;
    odO += max(0.0, 1.0 - abs(h - 25000.0) / 15000.0) * ds;
  }
  return exp(-(betaR * odR + betaM * 1.11 * odM + betaOz * odO));
}
vec3 scatter(vec3 dir, vec3 L, float I, float g){
  vec3 ro = vec3(0.0, Re + 600.0, 0.0);
  float tA = raySphere(ro, dir, Ra).y;
  vec2 gH = raySphere(ro, dir, Re);
  float tMax = tA;
  if (gH.x > 0.0) tMax = gH.x;
  tMax = min(tMax, 400e3);
  const int S = 20;
  float ds = tMax / float(S);
  float odR = 0.0, odM = 0.0, odO = 0.0;
  vec3 sR = vec3(0.0), sM = vec3(0.0);
  for (int i = 0; i < S; i++){
    float t = (float(i) + 0.5) * ds;
    vec3 q = ro + dir * t;
    float h = length(q) - Re;
    float dR = exp(-h/HR) * ds, dM = exp(-h/HM) * ds;
    odR += dR; odM += dM;
    odO += max(0.0, 1.0 - abs(h - 25000.0) / 15000.0) * ds;
    vec3 Tl = transmittanceTo(q, L);
    vec3 Tv = exp(-(betaR * odR + betaM * 1.11 * odM + betaOz * odO));
    vec3 T = Tv * Tl;
    sR += T * dR; sM += T * dM;
  }
  float mu = dot(dir, L);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu*mu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g*g) * (1.0 + mu*mu)) / ((2.0 + g*g) * pow(max(1.0 + g*g - 2.0*g*mu, 1e-4), 1.5));
  vec3 single = I * (sR * betaR * pR + sM * betaM * pM);
  float sunUp = clamp(L.y * 4.0 + 0.3, 0.0, 1.0);
  vec3 ms = I * (sR * betaR) * 0.06 * sunUp;
  return single + ms;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float az = (uv.x - 0.5) * 6.2831853;
  float vv = uv.y * 2.0 - 1.0;
  float el = sign(vv) * vv * vv * 1.5707963;
  vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 col = scatter(dir, uSunDir, uSunI, 0.8);
  vec3 moon = scatter(dir, uMoonDir, uMoonI, 0.6);
  col += moon * vec3(0.75, 0.85, 1.1);
  col += vec3(0.004, 0.0065, 0.012) * (1.0 - smoothstep(-0.1, 0.25, uSunDir.y)) * (0.6 + 0.4 * (1.0 - abs(dir.y)));
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  col = min(max(col, vec3(0.0)), vec3(60000.0));
  gl_FragColor = vec4(col / uLutEncode, 1.0);
}
`;

const SKY_VERT = /* glsl */ `
uniform mat4 uInvProjView;
varying vec3 vDir;
void main(){
  vec4 p = vec4(position.xy, 1.0, 1.0);
  vec4 w = uInvProjView * p;
  vDir = w.xyz / w.w - cameraPosition;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
${NOISE}
${WORLD_PARS}
${WORLD_FUNCS}
uniform vec3 uMoonDir;
uniform float uStarRot;
uniform float uSunSize;
varying vec3 vDir;

vec3 starField(vec3 d, float mwAmt){
  float c = cos(uStarRot), s = sin(uStarRot);
  d = vec3(d.x, c * d.y - s * d.z, s * d.y + c * d.z);
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 4; layer++){
    float sc = 130.0 + float(layer) * 115.0;
    vec3 p = d * sc;
    vec3 ip = floor(p);
    vec3 fp = fract(p) - 0.5;
    float h = n_hash13(ip + float(layer) * 31.7);
    if (h > 0.976){
      vec3 off = vec3(n_hash13(ip + 1.3), n_hash13(ip + 2.7), n_hash13(ip + 5.1)) - 0.5;
      float dd = length(fp - off * 0.58);
      float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 6.0) + h * 80.0);
      float b = min(smoothstep(0.16, 0.0, dd) * (h - 0.976) * 145.0 * tw, 2.2);
      vec3 tint = mix(vec3(1.0, 0.86, 0.68), vec3(0.76, 0.90, 1.0), n_hash13(ip + 9.0));
      col += tint * b;
    }
  }
  if (mwAmt > 0.01) {
    vec3 axis = normalize(vec3(0.3, 0.2, 0.93));
    float band = 1.0 - abs(dot(d, axis));
    band = pow(clamp(band, 0.0, 1.0), 8.0);
    vec3 tw = abs(d); tw /= (tw.x + tw.y + tw.z);
    float dust = textureLod(uNoiseTex, d.yz * 0.4, 1.0).r * tw.x + textureLod(uNoiseTex, d.xz * 0.4, 1.0).r * tw.y + textureLod(uNoiseTex, d.xy * 0.4, 1.0).r * tw.z;
    float clouds = textureLod(uNoiseTex, d.yz * 0.9 + 0.3, 1.0).g * tw.x + textureLod(uNoiseTex, d.xz * 0.9 + 0.3, 1.0).g * tw.y + textureLod(uNoiseTex, d.xy * 0.9 + 0.3, 1.0).g * tw.z;
    float mw = band * smoothstep(0.32, 0.72, clouds) * (1.0 - smoothstep(0.46, 0.64, dust) * 0.75);
    col += vec3(0.58, 0.64, 0.90) * mw * 0.34 * mwAmt;
    float fine = n_hash13(floor(d * 850.0));
    col += vec3(0.84, 0.88, 1.0) * step(0.994, fine) * band * 2.8 * mwAmt;
  }
  return col;
}

// soft, feathery high-altitude cirrus wisps (painterly, never sharp scratches or smeared blobs)
vec4 cirrus(vec3 dir){
  if (dir.y <= 0.06) return vec4(0.0);
  float t = (12000.0 - cameraPosition.y) / max(dir.y, 0.07);
  vec2 xz = cameraPosition.xz + dir.xz * t + uCloudOffset * 1.6;
  vec2 wdir = normalize(uWindDir + 1e-4);
  vec2 wperp = vec2(-wdir.y, wdir.x);
  // sweeping high-altitude Ghibli cirrus ribbons & feathery mare's-tail streaks for true two-layer sky variety!
  vec2 uv = vec2(dot(xz, wdir) * 0.000016, dot(xz, wperp) * 0.000046);
  vec4 n1 = texture(uNoiseTex, uv);
  vec2 warp = vec2(n1.r - 0.5, n1.g - 0.5) * 0.38;
  float wisp = texture(uNoiseTex, uv * vec2(1.1, 1.9) + warp).g * 0.58
             + texture(uNoiseTex, uv * vec2(2.6, 4.4) + warp * 1.4 + 0.31).b * 0.42;
  float macro = smoothstep(0.38, 0.72, n1.r);
  float a = smoothstep(0.50, 0.76, wisp) * macro * 0.22 * smoothstep(0.06, 0.26, dir.y) * (1.0 - smoothstep(0.76, 0.98, dir.y) * 0.42);
  if (a < 0.004) return vec4(0.0);
  float mu = dot(normalize(dir), uLightDir);
  vec3 dayC = w_sky(vec3(0.0, 1.0, 0.0)) * 0.75 + uLightColor * (0.28 + pow(max(mu, 0.0), 5.0) * 0.75);
  vec3 goldC = vec3(1.0, 0.74, 0.56) * (0.65 + 0.55 * max(mu, 0.0));
  vec3 duskC = mix(vec3(0.45, 0.38, 0.68), vec3(1.0, 0.58, 0.48), smoothstep(0.32, 0.08, dir.y)) * 0.14;
  vec3 c = mix(dayC, goldC * max(dot(dayC, vec3(0.3, 0.5, 0.2)) * 1.2, 0.35), max(uGolden, uDawn) * 0.72);
  c = mix(c, duskC, uDusk * (1.0 - uNight) * 0.65);
  vec3 nightC = vec3(0.18, 0.23, 0.35) * (0.14 + 0.25 * pow(max(dot(dir, uMoonDir), 0.0), 6.0));
  c = mix(c, nightC, uNight * 0.92);
  a *= mix(1.0, 0.45, uNight);
  return vec4(c, a);
}

void main(){
  vec3 dir = normalize(vDir);
  vec3 col = w_sky(vec3(dir.x, max(dir.y, -0.02), dir.z));
  // stylized: deeper saturated azure overhead, luminous pale horizon
  float lumS = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lumS), col, 1.40);
  float hz = exp(-max(dir.y, 0.0) * 8.5);
  col = mix(col, vec3(lumS) * vec3(0.96, 1.0, 1.04) * 1.15, hz * 0.32 * (1.0 - uNight));
  col = max(col, vec3(0.0));
  col.g = min(col.g, (col.r + col.b) * 0.6);

  // stylized sunset / dawn / dusk sky gradient (peach horizon -> rose -> deep twilight indigo!)
  {
    vec2 dh = normalize(dir.xz + 1e-5), sh = normalize(uSunDir.xz + 1e-5);
    float toward = clamp(dot(dh, sh) * 0.5 + 0.5, 0.0, 1.0);
    float el = max(dir.y, 0.0);
    float low = exp(-el * 2.7);
    float mid = exp(-el * 1.2);
    // golden hour / dawn
    vec3 warm = mix(vec3(1.0, 0.54, 0.24), vec3(1.0, 0.66, 0.42), uDawn);
    vec3 rose = mix(vec3(0.92, 0.48, 0.68), vec3(0.96, 0.62, 0.74), uDawn);
    vec3 violet = mix(vec3(0.32, 0.34, 0.78), vec3(0.30, 0.46, 0.86), uDawn);
    vec3 band = mix(mix(violet, rose, low), warm, pow(max(toward, 0.0), 2.2) * low);
    float L0 = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float sunset = max(uGolden, uDawn) * smoothstep(0.18, -0.02, uSunDir.y);
    col = mix(col, band * max(L0, 0.03) * 1.95, clamp(sunset * (0.25 + 0.75 * low), 0.0, 0.90));

    // true storybook dusk sky (peach-apricot glow near horizon rising into deep velvety indigo!)
    float duskAmt = uDusk * (1.0 - smoothstep(0.65, 1.0, uNight));
    if (duskAmt > 0.01) {
      vec3 duskIndigo = vec3(0.045, 0.055, 0.16);
      vec3 duskPlum   = vec3(0.22, 0.14, 0.30);
      vec3 duskPeach  = mix(vec3(0.78, 0.40, 0.30), vec3(1.0, 0.54, 0.28), pow(max(toward, 0.0), 1.6));
      vec3 duskGrad = mix(duskIndigo, duskPlum, smoothstep(0.42, 0.10, el));
      duskGrad = mix(duskGrad, duskPeach, pow(max(low, 0.0), 1.65) * (0.45 + 0.55 * toward));
      float scaleD = max(L0 * 1.8, 0.055);
      col = mix(col, duskGrad * scaleD * 2.4, duskAmt * (0.58 + 0.32 * mid));
    }
  }

  float night = uNight;
  // stars: first bright evening stars already appear high in the indigo dusk zenith!
  float earlyStars = uDusk * smoothstep(0.10, 0.42, dir.y) * 0.55;
  float starVis = max(smoothstep(0.30, 0.88, night), earlyStars);
  if (starVis > 0.01 && dir.y > -0.05){
    float ext = exp(-0.24 / max(dir.y + 0.05, 0.02));
    col += starField(dir, smoothstep(0.35, 0.9, night)) * starVis * ext;
  }

  // sun disc with gentle painterly limb softening (avoids harsh clipped white ball at frame edge in lake.png!)
  float mu = dot(dir, uSunDir);
  float sunR = uSunSize;
  float sd = acos(clamp(mu, -1.0, 1.0));
  if (sd < sunR * 2.2){
    float x = clamp(sd / sunR, 0.0, 1.0);
    float limb = 1.0 - 0.55 * (1.0 - sqrt(1.0 - x*x));
    float disc = smoothstep(1.18, 0.72, sd / sunR);
    col += uSunColor * disc * limb * 24.0;
  }
  col += uSunColor * pow(max(mu, 0.0), 140.0) * 0.78 + uSunColor * pow(max(mu, 0.0), 28.0) * 0.24 * (0.45 + uGolden);
  // dramatic golden crepuscular sunbeams fanning cleanly upward & outward from the sunset notch (summitWest.png!)
  if (uGolden > 0.05 && uDawn < 0.5 && mu > 0.55) {
    vec3 sunSide = normalize(cross(vec3(0.0, 1.0, 0.0), uSunDir));
    vec3 sunUp = cross(uSunDir, sunSide);
    vec2 rel = vec2(dot(dir, sunSide), dot(dir, sunUp));
    float rAng = atan(rel.y, rel.x);
    float fan = pow(max(sin(rAng * 7.0 + 0.55) * 0.5 + 0.5, 0.0), 3.0) * 0.65
              + pow(max(sin(rAng * 13.0 - 1.1) * 0.5 + 0.5, 0.0), 4.0) * 0.35;
    float upMask = smoothstep(-0.08, 0.14, rel.y);
    float radFade = smoothstep(0.55, 0.96, mu) * smoothstep(0.999, 0.965, mu);
    col += uSunColor * vec3(1.0, 0.78, 0.44) * fan * upMask * radFade * uGolden * (1.0 - uDawn) * 0.62;
  }

  // moon
  float mm = dot(dir, uMoonDir);
  float md = acos(clamp(mm, -1.0, 1.0));
  float moonR = 0.0105;
  if (md < moonR * 1.2 && uMoonDir.y > -0.05 && night > 0.02){
    vec2 mp = vec2(dot(dir, normalize(cross(uMoonDir, vec3(0.0,1.0,0.0)))), dir.y - uMoonDir.y) / moonR;
    float maria = texture(uNoiseTex, mp * 0.15 + 0.3).r;
    float disc = smoothstep(1.0, 0.94, md / moonR);
    vec3 mcol = vec3(0.9, 0.92, 1.0) * (0.75 + 0.5 * maria) * 1.6;
    col = mix(col, mcol * (0.4 + 0.6 * night), disc * smoothstep(0.02, 0.4, night));
  }
  col += vec3(0.8, 0.85, 1.0) * pow(max(mm, 0.0), 2000.0) * 0.6 * night;

  // crisp high-altitude cirrus wisps (unified with the 3D cumulus layer — no smeary 2D clouds!)
  vec4 ci = cirrus(dir);
  col = mix(col, ci.rgb, ci.a);
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  gl_FragColor = vec4(min(col, vec3(200.0)), 1.0);
}
`;

export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    const caps = getCaps(renderer);
    this.lutType = caps.floatFilterableTargetType;
    this.lutEncodeScale = caps.floatFilterableTargetEncodeScale;
    this.lutRT = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
      type: this.lutType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
    });
    this.lutMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: U.uSunDir,
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunI: { value: 22 },
        uMoonI: { value: 0.05 },
        uRes: { value: new THREE.Vector2(LUT_W, LUT_H) },
        uLutEncode: { value: this.lutEncodeScale },
      },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: LUT_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.lutScene = new THREE.Scene();
    this.lutScene.add(fullscreenQuad(this.lutMat));
    this.lutCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    U.uSkyLUT.value = this.lutRT.texture;
    U.uSkyScale.value = this.lutEncodeScale;
    this.moonDir = this.lutMat.uniforms.uMoonDir;

    this.skyUniforms = {
      ...U,
      uInvProjView: { value: new THREE.Matrix4() },
      uMoonDir: this.moonDir,
      uStarRot: { value: 0 },
      uSunSize: { value: 0.02 },
    };
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = fullscreenQuad(this.skyMat);
    this.mesh.renderOrder = -1000;
    const tmp = new THREE.Matrix4();
    this.mesh.onBeforeRender = (r, s, cam) => {
      tmp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.skyUniforms.uInvProjView.value.copy(tmp).invert();
    };
    // Lazy-init downsample target on first readAmbient so constructor does not
    // allocate extra Three.js UUIDs ahead of seeded world construction.
    this.ambRT = null;
    this.ambMat = null;
    this.ambScene = null;

    // Afternoon values measured from the LUT: used until the first readback lands, and kept if it never does.
    this.ambient = { sky: new THREE.Color(0.33, 0.59, 0.97), ground: new THREE.Color(), horizon: new THREE.Color(1.5, 1.78, 1.44) };
    this._stagedSky = new THREE.Color();
    this._stagedHorizon = new THREE.Color();
    this._lutState = {
      valid: false,
      sunDir: new THREE.Vector3(0, -2, 0),
      moonDir: new THREE.Vector3(0, -2, 0),
      sunI: -1,
      moonI: -1,
    };
    this._lutVersion = 0;
    this._ambVersion = 0;
    this._stagedVersion = 0;
    this._ambInFlightVersion = 0;
    this._ambReadToken = 0;
    this._ambTimer = null;
    this.ambientReadTimeoutMs = AMBIENT_READ_TIMEOUT_MS;
    this._ambPending = false;
    this._ambQueued = false;
    this._ambCommitOnResolve = false;
    this._disposed = false;
    this._ambWaiters = [];
    this._ambFailures = 0;
    this._ambDisabled = false;
    this._unregAsync = registerAsyncReadback(renderer, {
      isPending: () => this.isAmbientPending(),
      wait: () => this.waitForAmbient(),
      onContextRestored: () => this.onContextRestored(),
    });
  }

  onContextRestored() {
    if (this._disposed) return;
    this._clearAmbTimer();
    this._ambReadToken++;
    this._lutState.valid = false;
    this._lutVersion = 0;
    this._ambVersion = 0;
    this._stagedVersion = 0;
    this._ambInFlightVersion = 0;
    this._ambPending = false;
    this._ambQueued = false;
    this._ambCommitOnResolve = false;
    this._ambFailures = 0;
    this._ambDisabled = false;
    this._resolveAmbWaiters();
  }

  // A failed, empty or late read keeps the last good ambient. After a few in a row the
  // readback is switched off, so a fence that never settles cannot hold every capture frame.
  _ambReadFailed() {
    this._clearAmbTimer();
    this._ambPending = false;
    this._ambInFlightVersion = 0;
    this._ambQueued = false;
    this._ambCommitOnResolve = false;
    if (++this._ambFailures >= AMB_MAX_FAILURES) this._ambDisabled = true;
    this._resolveAmbWaiters();
  }

  _clearAmbTimer() {
    if (this._ambTimer !== null) {
      clearTimeout(this._ambTimer);
      this._ambTimer = null;
    }
  }

  isAmbientPending() {
    return !this._disposed && (this._ambPending || this._ambQueued);
  }

  waitForAmbient() {
    if (!this.isAmbientPending()) return Promise.resolve(this.ambient);
    return new Promise((resolve) => {
      this._ambWaiters.push(resolve);
    });
  }

  _resolveAmbWaiters() {
    if (!this._ambWaiters.length) return;
    const list = this._ambWaiters.splice(0, this._ambWaiters.length);
    for (let i = 0; i < list.length; i++) list[i](this.ambient);
  }

  renderLUT(force = false) {
    const capture = isCaptureRenderer(this.renderer);
    const next = {
      sunDir: U.uSunDir.value,
      moonDir: this.moonDir.value,
      sunI: this.lutMat.uniforms.uSunI.value,
      moonI: this.lutMat.uniforms.uMoonI.value,
    };
    if (!shouldUpdateSkyLUT(this._lutState, next, { force, capture })) return false;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace?.();
    const prevMip = r.getActiveMipmapLevel?.();
    r.setRenderTarget(this.lutRT);
    r.render(this.lutScene, this.lutCam);
    r.setRenderTarget(prev, prevFace, prevMip);

    this._lutState.valid = true;
    this._lutState.sunDir.copy(next.sunDir);
    this._lutState.moonDir.copy(next.moonDir);
    this._lutState.sunI = next.sunI;
    this._lutState.moonI = next.moonI;
    this._lutVersion++;

    // In capture mode, prefetch ambient async into staging after any LUT change
    // so the next capture frame waits for it and readAmbient() commits it at the exact same point as sync readback.
    if (capture) this._startAmbientRead(false);
    return true;
  }

  _ensureAmbientTarget() {
    if (this.ambRT) return;
    this.ambRT = new THREE.WebGLRenderTarget(2, 1, {
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.ambMat = new THREE.ShaderMaterial({
      uniforms: { uSkyLUT: { value: this.lutRT.texture }, uLutEncode: { value: this.lutEncodeScale } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: AMB_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.ambScene = new THREE.Scene();
    this.ambScene.add(fullscreenQuad(this.ambMat));
  }

  _commitStaged() {
    this.ambient.sky.copy(this._stagedSky);
    this.ambient.horizon.copy(this._stagedHorizon);
    this._ambVersion = this._stagedVersion;
  }

  _unbindPBO(gl) {
    if (gl && gl.PIXEL_PACK_BUFFER !== undefined) {
      try { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); } catch {}
    }
  }

  _startAmbientRead(commitOnResolve) {
    if (this._disposed || !this._lutState.valid) return;
    if (this._ambDisabled) {
      this._ambCommitOnResolve = false;
      this._resolveAmbWaiters();
      return;
    }
    if (commitOnResolve) this._ambCommitOnResolve = true;
    if (this._stagedVersion === this._lutVersion) {
      if (this._ambCommitOnResolve && this._ambVersion !== this._stagedVersion) {
        this._commitStaged();
      }
      this._ambCommitOnResolve = false;
      return;
    }
    if (this._ambPending) {
      if (this._ambInFlightVersion !== this._lutVersion) this._ambQueued = true;
      return;
    }
    const r = this.renderer;
    if (!r || typeof r.readRenderTargetPixelsAsync !== 'function') {
      this._ambDisabled = true;
      this._ambCommitOnResolve = false;
      this._resolveAmbWaiters();
      return;
    }
    const gl = r.getContext?.();
    if (gl?.isContextLost?.()) {
      this._ambCommitOnResolve = false;
      this._resolveAmbWaiters();
      return;
    }

    this._ensureAmbientTarget();
    const prev = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace?.();
    const prevMip = r.getActiveMipmapLevel?.();
    const readBuf = new Uint8Array(2 * 1 * 4);
    let readPromise;
    let pbo = null;
    try {
      r.setRenderTarget(this.ambRT);
      r.render(this.ambScene, this.lutCam);
      r.setRenderTarget(prev, prevFace, prevMip);
      readPromise = r.readRenderTargetPixelsAsync(this.ambRT, 0, 0, 2, 1, readBuf);
      // Capture the temporary PBO before unbinding so we can delete it if Three.js r170's fence wait rejects.
      if (gl && gl.PIXEL_PACK_BUFFER_BINDING !== undefined) {
        try { pbo = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING); } catch {}
      }
      this._unbindPBO(gl);
    } catch {
      try { r.setRenderTarget(prev, prevFace, prevMip); } catch {}
      this._unbindPBO(gl);
      this._ambReadFailed();
      return;
    }

    if (!readPromise || typeof readPromise.then !== 'function') {
      this._ambReadFailed();
      return;
    }

    const token = ++this._ambReadToken;
    const readVersion = this._lutVersion;
    this._ambPending = true;
    this._ambQueued = false;
    this._ambInFlightVersion = readVersion;

    const failRead = (deletePbo) => {
      if (deletePbo && pbo && gl && !gl.isContextLost?.()) {
        try { gl.deleteBuffer(pbo); } catch {}
      }
      this._unbindPBO(gl);
      if (token !== this._ambReadToken) return;
      this._ambReadFailed();
    };

    const timeoutMs = this.ambientReadTimeoutMs;
    if (timeoutMs > 0) {
      this._clearAmbTimer();
      this._ambTimer = setTimeout(() => {
        this._ambTimer = null;
        // Deadline expired: unblock startup/capture with the last good ambient and ignore any late settle.
        if (token !== this._ambReadToken) return;
        this._ambReadToken++;
        this._ambReadFailed();
      }, timeoutMs);
    }

    readPromise.then((buf) => {
      this._unbindPBO(gl);
      if (token !== this._ambReadToken) return;
      this._clearAmbTimer();
      this._ambPending = false;
      this._ambInFlightVersion = 0;
      if (this._disposed) {
        this._ambQueued = false;
        this._ambCommitOnResolve = false;
        this._resolveAmbWaiters();
        return;
      }
      const skyRGB = buf && buf.length >= 8 ? decodeRGBE(buf[0], buf[1], buf[2], buf[3]) : null;
      const horRGB = buf && buf.length >= 8 ? decodeRGBE(buf[4], buf[5], buf[6], buf[7]) : null;
      if (!skyRGB || !horRGB) {
        // An undefined or short result (no framebuffer) is a failure, never data.
        this._ambReadFailed();
        return;
      }
      this._ambFailures = 0;
      this._stagedSky.setRGB(skyRGB[0], skyRGB[1], skyRGB[2]);
      this._stagedHorizon.setRGB(horRGB[0], horRGB[1], horRGB[2]);
      this._stagedVersion = readVersion;
      if (this._ambCommitOnResolve) {
        this._commitStaged();
        if (this._stagedVersion === this._lutVersion) this._ambCommitOnResolve = false;
      }
      if (this._stagedVersion !== this._lutVersion && (this._ambQueued || isCaptureRenderer(r))) {
        this._ambQueued = false;
        this._startAmbientRead(this._ambCommitOnResolve);
        return;
      }
      this._ambQueued = false;
      this._ambCommitOnResolve = false;
      this._resolveAmbWaiters();
    }, () => failRead(true));
  }

  readAmbient(force = false) {
    if (this._disposed || !this._lutState.valid) return this.ambient;
    if (!force && this._ambVersion === this._lutVersion) return this.ambient;
    if (!force && this._stagedVersion === this._lutVersion) {
      this._commitStaged();
      this._ambCommitOnResolve = false;
      return this.ambient;
    }
    if (force) this._stagedVersion = 0;
    this._startAmbientRead(true);
    return this.ambient;
  }

  dispose() {
    this._disposed = true;
    this._clearAmbTimer();
    this._ambReadToken++;
    this._ambPending = false;
    this._ambQueued = false;
    this._ambCommitOnResolve = false;
    this.renderer?.domElement?.removeEventListener?.('webglcontextrestored', this._onContextRestored);
    this._unregAsync?.();
    this._resolveAmbWaiters();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.skyMat.dispose();
    for (const child of this.lutScene.children) child.geometry?.dispose();
    this.lutMat.dispose();
    this.lutRT.dispose();
    if (this.ambScene) {
      for (const child of this.ambScene.children) child.geometry?.dispose();
    }
    this.ambMat?.dispose();
    this.ambRT?.dispose();
  }
}

export function createSky(ctx) {
  const sky = new Sky(ctx.renderer);
  ctx.scene.add(sky.mesh);
  return {
    instance: sky,
    update() {},
    dispose() {
      sky.dispose();
    },
  };
}
