import * as THREE from 'three';
import { NOISE, WORLD_PARS, WORLD_FUNCS } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { fullscreenQuad } from './heightmap.js';

// Physically-inspired sky: a sky-view LUT (single scattering Rayleigh + Mie + ozone)
// rendered each frame at low res, then a full-screen sky pass adding sun, moon,
// stars, milky way and a lit 2D cloud deck.

const LUT_W = 192, LUT_H = 108;

const LUT_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunI;
uniform float uMoonI;
uniform vec2 uRes;
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
    vec3 up = normalize(q);
    vec3 Tl = transmittanceTo(q, L);
    vec3 Tv = exp(-(betaR * odR + betaM * 1.11 * odM + betaOz * odO));
    // cheap multiple scattering fudge: ambient term proportional to sun height
    vec3 T = Tv * Tl;
    sR += T * dR; sM += T * dM;
  }
  float mu = dot(dir, L);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu*mu);
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g*g) * (1.0 + mu*mu)) / ((2.0 + g*g) * pow(max(1.0 + g*g - 2.0*g*mu, 1e-4), 1.5));
  vec3 single = I * (sR * betaR * pR + sM * betaM * pM);
  // multiple scattering approximation (brightens and blues the sky, softens twilight)
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
  // faint night airglow so night sky isn't pitch black
  col += vec3(0.004, 0.0065, 0.012) * (1.0 - smoothstep(-0.1, 0.25, uSunDir.y)) * (0.6 + 0.4 * (1.0 - abs(dir.y)));
  gl_FragColor = vec4(col, 1.0);
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

vec3 starField(vec3 d){
  // rotate with the sky
  float c = cos(uStarRot), s = sin(uStarRot);
  d = vec3(d.x, c * d.y - s * d.z, s * d.y + c * d.z);
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 3; layer++){
    float sc = 140.0 + float(layer) * 120.0;
    vec3 p = d * sc;
    vec3 ip = floor(p);
    vec3 fp = fract(p) - 0.5;
    float h = n_hash13(ip + float(layer) * 31.7);
    if (h > 0.986){
      vec3 off = vec3(n_hash13(ip + 1.3), n_hash13(ip + 2.7), n_hash13(ip + 5.1)) - 0.5;
      float dd = length(fp - off * 0.6);
      float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 6.0) + h * 80.0);
      float b = min(smoothstep(0.13, 0.0, dd) * (h - 0.986) * 150.0 * tw, 1.4);
      vec3 tint = mix(vec3(1.0, 0.8, 0.6), vec3(0.7, 0.85, 1.0), n_hash13(ip + 9.0));
      col += tint * b;
    }
  }
  // milky way band
  vec3 axis = normalize(vec3(0.3, 0.2, 0.93));
  float band = 1.0 - abs(dot(d, axis));
  band = pow(clamp(band, 0.0, 1.0), 9.0);
  vec3 tw = abs(d); tw /= (tw.x + tw.y + tw.z);
  float dust = textureLod(uNoiseTex, d.yz * 0.4, 1.0).r * tw.x + textureLod(uNoiseTex, d.xz * 0.4, 1.0).r * tw.y + textureLod(uNoiseTex, d.xy * 0.4, 1.0).r * tw.z;
  float clouds = textureLod(uNoiseTex, d.yz * 0.9 + 0.3, 1.0).g * tw.x + textureLod(uNoiseTex, d.xz * 0.9 + 0.3, 1.0).g * tw.y + textureLod(uNoiseTex, d.xy * 0.9 + 0.3, 1.0).g * tw.z;
  float mw = band * smoothstep(0.35, 0.75, clouds) * (1.0 - smoothstep(0.45, 0.62, dust) * 0.8);
  col += vec3(0.55, 0.6, 0.85) * mw * 0.22;
  // dense faint stars inside the band
  float fine = n_hash13(floor(d * 900.0));
  col += vec3(0.8, 0.85, 1.0) * step(0.996, fine) * band * 2.0;
  return col;
}

vec4 cloudLayer(vec3 dir, vec3 skyCol){
  if (dir.y <= 0.0) return vec4(0.0);
  float t = (CLOUD_ALT - cameraPosition.y) / dir.y;
  vec2 xz = cameraPosition.xz + dir.xz * t;
  float dist = t;
  float d = w_cloudDensityAt(xz);
  if (d <= 0.001) return vec4(0.0);
  // light: march toward light along the layer
  vec3 L = uLightDir;
  vec2 ld = normalize(L.xz + 1e-4) * 160.0;
  float occ = 0.0;
  occ += w_cloudDensityAt(xz + ld * 1.0);
  occ += w_cloudDensityAt(xz + ld * 2.5) * 0.7;
  occ += w_cloudDensityAt(xz + ld * 5.0) * 0.4;
  float thick = d * 2.2;
  float light = exp(-occ * 1.5 * (1.2 - clamp(L.y, 0.0, 1.0))) * exp(-thick * 0.35);
  float mu = dot(normalize(dir), L);
  float fwd = pow(clamp(mu, 0.0, 1.0), 12.0) * 2.2 + pow(clamp(mu, 0.0, 1.0), 3.0) * 0.5;
  float edge = (1.0 - smoothstep(0.0, 0.55, d)); // thin edges glow when backlit
  vec3 ambTop = w_sky(vec3(0.0, 1.0, 0.0));
  vec3 ambHor = w_sky(normalize(vec3(dir.x, 0.05, dir.z)));
  vec3 amb = mix(ambHor, ambTop, 0.45);
  float al = dot(amb, vec3(0.2126, 0.7152, 0.0722));
  amb = mix(vec3(al), amb, 0.55) * vec3(0.92, 0.95, 1.08);
  vec3 sunC = uLightColor / max(max(uLightColor.r, max(uLightColor.g, uLightColor.b)), 1e-4);
  float sunI = max(max(uLightColor.r, uLightColor.g), uLightColor.b);
  vec3 sun = sunC * sunI * (light * (0.6 + fwd + edge * fwd * 2.5));
  vec3 c = amb * (0.45 + 0.35 * (1.0 - d)) + sun * 0.32;
  // night: moonlit soft grey
  float alpha = smoothstep(0.0, 0.45, d) * 0.97;
  // fade toward horizon with aerial perspective
  float fade = exp(-dist * 1.3e-5);
  vec3 hz = w_sky(normalize(vec3(dir.x, max(dir.y, 0.02), dir.z)));
  c = mix(hz, c, fade);
  alpha *= smoothstep(0.0, 0.08, dir.y);
  return vec4(c, alpha);
}

vec4 cirrus(vec3 dir){
  if (dir.y <= 0.0) return vec4(0.0);
  float t = (9000.0 - cameraPosition.y) / dir.y;
  vec2 xz = cameraPosition.xz + dir.xz * t + uCloudOffset * 2.5;
  vec2 p = xz * vec2(0.000028, 0.000045);
  float n = texture(uNoiseTex, p).g * 0.6 + texture(uNoiseTex, p * 3.0 + 0.2).r * 0.3 + texture(uNoiseTex, p * 9.0 + 0.7).b * 0.1;
  float a = smoothstep(0.56, 0.72, n) * 0.4 * smoothstep(0.04, 0.25, dir.y);
  float mu = dot(normalize(dir), uLightDir);
  vec3 c = w_sky(vec3(0.0, 1.0, 0.0)) * 0.9 + uLightColor * (0.25 + pow(max(mu, 0.0), 6.0) * 1.2);
  return vec4(c, a);
}

void main(){
  vec3 dir = normalize(vDir);
  vec3 col = w_sky(vec3(dir.x, max(dir.y, -0.02), dir.z));
  // stylized: deeper azure overhead, luminous pale horizon
  float lumS = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lumS), col, 1.38);
  float hz = exp(-max(dir.y, 0.0) * 9.0);
  col = mix(col, vec3(lumS) * vec3(0.96, 1.0, 1.04) * 1.15, hz * 0.3 * (1.0 - uNight));
  col = max(col, vec3(0.0));
  col.g = min(col.g, (col.r + col.b) * 0.6);
  // stylized sunset/sunrise: warm band toward the sun, rose band opposite
  {
    vec2 dh = normalize(dir.xz + 1e-5), sh = normalize(uSunDir.xz + 1e-5);
    float toward = dot(dh, sh) * 0.5 + 0.5;
    float el = max(dir.y, 0.0);
    float low = exp(-el * 2.6);
    vec3 warm = vec3(1.0, 0.52, 0.22), rose = vec3(0.9, 0.48, 0.72), violet = vec3(0.42, 0.38, 0.8);
    vec3 band = mix(mix(violet, rose, low), warm, pow(toward, 2.5) * low);
    float L0 = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float sunset = uGolden * smoothstep(0.16, 0.0, uSunDir.y);
    col = mix(col, band * max(L0, 0.03) * 2.0, clamp(sunset * (0.25 + 0.75 * low), 0.0, 0.92));
  }
  float night = uNight;
  // stars + milky way, attenuated by atmosphere
  if (night > 0.35 && dir.y > -0.05){
    float ext = exp(-0.25 / max(dir.y + 0.05, 0.02));
    col += starField(dir) * smoothstep(0.35, 0.9, night) * ext;
  }
  // sun disc with limb darkening
  float mu = dot(dir, uSunDir);
  float sunR = uSunSize;
  float sd = acos(clamp(mu, -1.0, 1.0));
  if (sd < sunR * 1.6){
    float x = clamp(sd / sunR, 0.0, 1.0);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - x*x));
    float disc = smoothstep(1.0, 0.92, sd / sunR);
    col += uSunColor * disc * limb * 60.0;
  }
  col += uSunColor * pow(max(mu, 0.0), 300.0) * 1.2 + uSunColor * pow(max(mu, 0.0), 40.0) * 0.25 * (0.4 + uGolden);
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
  col += vec3(0.8, 0.85, 1.0) * pow(max(mm, 0.0), 2000.0) * 0.6 * night; // moon halo
  vec4 ci = cirrus(dir);
  col = mix(col, ci.rgb, ci.a);
  vec4 cl = cloudLayer(dir, col);
  col = mix(col, cl.rgb, cl.a);
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  gl_FragColor = vec4(min(col, vec3(200.0)), 1.0);
}
`;

export class Sky {
  constructor(renderer) {
    this.renderer = renderer;
    this.lutRT = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
      type: THREE.FloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
    });
    this.lutMat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: U.uSunDir,
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uSunI: { value: 22 },
        uMoonI: { value: 0.05 },
        uRes: { value: new THREE.Vector2(LUT_W, LUT_H) },
      },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: LUT_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.lutScene = new THREE.Scene();
    this.lutScene.add(fullscreenQuad(this.lutMat));
    this.lutCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    U.uSkyLUT.value = this.lutRT.texture;
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
    this.readBuf = new Float32Array(LUT_W * LUT_H * 4);
    this.ambient = { sky: new THREE.Color(), ground: new THREE.Color(), horizon: new THREE.Color() };
  }

  renderLUT() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.lutRT);
    r.render(this.lutScene, this.lutCam);
    r.setRenderTarget(prev);
  }

  /** Read the LUT back (small) to derive hemisphere ambient colours. */
  readAmbient() {
    const r = this.renderer;
    r.readRenderTargetPixels(this.lutRT, 0, 0, LUT_W, LUT_H, this.readBuf);
    const b = this.readBuf;
    const acc = (rowA, rowB) => {
      let R = 0, G = 0, B = 0, n = 0;
      for (let y = rowA; y < rowB; y++) for (let x = 0; x < LUT_W; x += 2) {
        const i = (y * LUT_W + x) * 4; R += b[i]; G += b[i + 1]; B += b[i + 2]; n++;
      }
      return [R / n, G / n, B / n];
    };
    const sky = acc(Math.floor(LUT_H * 0.62), LUT_H);
    const hor = acc(Math.floor(LUT_H * 0.5), Math.floor(LUT_H * 0.6));
    this.ambient.sky.setRGB(sky[0], sky[1], sky[2]);
    this.ambient.horizon.setRGB(hor[0], hor[1], hor[2]);
    return this.ambient;
  }
}
