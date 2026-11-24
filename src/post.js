import * as THREE from 'three';
import { getCaps, clampMsaaSamples } from './engine/caps.js';
import { fullscreenQuad } from './world/heightmap.js';

// HDR post-processing: physically-based bloom (mip chain), crepuscular rays from
// the sun, anamorphic-free lens ghosts, stylized tonemapping, clean per-time grading,
// vignette, grain, letterbox.

const VERT = 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const DOWN = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst; uniform float uThreshold;
varying vec2 vUv;
vec3 s(vec2 o){ vec3 c = texture(tSrc, vUv + o * uTexel).rgb; return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : c; }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 c){ return c / (1.0 + lum(c)); }
void main(){
  vec3 a = s(vec2(-2,2)), b = s(vec2(0,2)), c = s(vec2(2,2));
  vec3 d = s(vec2(-2,0)), e = s(vec2(0,0)), f = s(vec2(2,0));
  vec3 g = s(vec2(-2,-2)), h = s(vec2(0,-2)), i = s(vec2(2,-2));
  vec3 j = s(vec2(-1,1)), k = s(vec2(1,1)), l = s(vec2(-1,-1)), m = s(vec2(1,-1));
  vec3 col;
  if (uFirst > 0.5) {
    vec3 g0 = (a+b+d+e)*0.25, g1 = (b+c+e+f)*0.25, g2 = (d+e+g+h)*0.25, g3 = (e+f+h+i)*0.25, g4 = (j+k+l+m)*0.25;
    col = karis(g0)*0.125 + karis(g1)*0.125 + karis(g2)*0.125 + karis(g3)*0.125 + karis(g4)*0.5;
    col = col / max(1.0 - lum(col), 1e-3);
    float L = lum(col);
    float knee = uThreshold * 0.6;
    float soft = clamp(L - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float w = max(soft, L - uThreshold) / max(L, 1e-4);
    col *= w;
    col = min(col, vec3(45.0));
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UP = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tAdd; uniform vec2 uTexel; uniform float uRadius;
varying vec2 vUv;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 c = texture(tSrc, vUv).rgb * 4.0;
  c += (texture(tSrc, vUv + vec2(-t.x, 0)).rgb + texture(tSrc, vUv + vec2(t.x, 0)).rgb + texture(tSrc, vUv + vec2(0, -t.y)).rgb + texture(tSrc, vUv + vec2(0, t.y)).rgb) * 2.0;
  c += texture(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture(tSrc, vUv + vec2(t.x, t.y)).rgb;
  c /= 16.0;
  gl_FragColor = vec4(c + texture(tAdd, vUv).rgb, 1.0);
}`;

const RAYMASK = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tDepth; uniform float uReverse; uniform vec2 uSun; uniform float uAspect;
varying vec2 vUv;
void main(){
  float d = texture(tDepth, vUv).r;
  float sky = uReverse > 0.5 ? step(d, 0.0) : step(1.0, d);
  vec3 c = texture(tScene, vUv).rgb;
  vec2 dv = (vUv - uSun) * vec2(uAspect, 1.0);
  float prox = exp(-dot(dv, dv) * 6.5);
  vec3 m = min(c, vec3(6.5)) * sky * prox;
  gl_FragColor = vec4(m, 1.0);
}`;

const RAYBLUR = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uSun; uniform float uStep; uniform int uTaps; uniform float uDecay;
varying vec2 vUv;
void main(){
  vec2 dir = (uSun - vUv) * uStep;
  vec2 uv = vUv;
  vec3 acc = vec3(0.0);
  float w = 1.0, tw = 0.0;
  float j = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
  uv += dir * j;
  for (int i = 0; i < uTaps; i++){
    acc += texture(tSrc, uv).rgb * w;
    tw += w;
    w *= uDecay;
    uv += dir;
  }
  gl_FragColor = vec4(acc / tw, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tRays; uniform sampler2D tGhost;
uniform float uExposure; uniform float uBloom; uniform float uRays; uniform vec3 uRayColor;
uniform float uTime; uniform vec2 uRes; uniform float uVignette; uniform float uGrain;
uniform vec3 uLift; uniform vec3 uGain; uniform float uSat; uniform float uContrast; uniform vec3 uWB;
uniform vec2 uSun; uniform float uSunVis; uniform float uFade; uniform float uSharpen; uniform vec2 uSrcTexel;
uniform float uLetterbox; uniform float uFxaa;
uniform vec3 uShadowTint;
uniform float uGoldenK;
uniform float uDawnK;
varying vec2 vUv;
vec3 stylTone(vec3 x){
  float L = dot(x, vec3(0.2126, 0.7152, 0.0722));
  float Lt = L * (1.0 + L / 7.5) / (1.0 + L);
  vec3 c = x * (Lt / max(L, 1e-5));
  float m = max(c.r, max(c.g, c.b));
  if (m > 1.0) c = mix(c / m, vec3(1.0), clamp((m - 1.0) / (m + 0.55), 0.0, 1.0));
  return clamp(c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// FXAA works on display-like values: each tap gets exposure and white balance, then a reversible
// tonemap x / (1 + L) close to stylTone's luminance curve. Edges are found on the perceptual luma of
// that and the blend happens there too, so a bright sky or sun next to a dark ridge blends as it will
// look on screen instead of the HDR value swamping the darker side. fxDecode returns to scene HDR.
float fxL(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 fxEncode(vec3 c){ vec3 x = c * uExposure * uWB; return x / (1.0 + fxL(x)); }
vec3 fxDecode(vec3 t){ return t / max(1.0 - fxL(t), 1e-3) / max(uExposure * uWB, vec3(1e-4)); }
float fxLuma(vec3 t){ return sqrt(fxL(t)); }
void main(){
  vec2 uv = vUv;
  vec3 col;
  if (uFxaa > 0.5) {
    // FXAA-class edge blend for tiers without MSAA. The four cross taps double as the sharpen
    // neighbourhood, and sharpening is skipped on the edges FXAA just smoothed.
    vec3 rgbM = texture(tScene, uv).rgb;
    vec3 rgbE = texture(tScene, uv + vec2(uSrcTexel.x, 0)).rgb, rgbW = texture(tScene, uv - vec2(uSrcTexel.x, 0)).rgb;
    vec3 rgbN = texture(tScene, uv + vec2(0, uSrcTexel.y)).rgb, rgbS = texture(tScene, uv - vec2(0, uSrcTexel.y)).rgb;
    float lM = fxLuma(fxEncode(rgbM)), lE = fxLuma(fxEncode(rgbE)), lW = fxLuma(fxEncode(rgbW));
    float lN = fxLuma(fxEncode(rgbN)), lS = fxLuma(fxEncode(rgbS));
    float lMin = min(lM, min(min(lE, lW), min(lN, lS)));
    float lMax = max(lM, max(max(lE, lW), max(lN, lS)));
    col = rgbM;
    if (lMax - lMin >= max(0.0312, lMax * 0.125)) {
      // blur along the edge, i.e. perpendicular to the luma gradient
      vec2 dir = vec2(lS - lN, lE - lW);
      float reduce = max((lE + lW + lN + lS) * 0.03125, 1.0 / 128.0);
      dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uSrcTexel;
      vec3 tA = 0.5 * (fxEncode(texture(tScene, uv - dir * (1.0 / 6.0)).rgb) + fxEncode(texture(tScene, uv + dir * (1.0 / 6.0)).rgb));
      vec3 tB = tA * 0.5 + 0.25 * (fxEncode(texture(tScene, uv - dir * 0.5).rgb) + fxEncode(texture(tScene, uv + dir * 0.5).rgb));
      float lB = fxLuma(tB);
      col = fxDecode((lB < lMin || lB > lMax) ? tA : tB);
    } else if (uSharpen > 0.0) {
      col = max(col + (col * 4.0 - (rgbE + rgbW + rgbN + rgbS)) * uSharpen * 0.25, 0.0);
    }
  } else {
    // ultra-subtle edge chromatic aberration (kills cyan fringe on close foreground objects in sheep.png!)
    vec2 cd = (uv - 0.5);
    float ca = dot(cd, cd) * 0.0008;
    col.r = texture(tScene, uv - cd * ca).r;
    col.g = texture(tScene, uv).g;
    col.b = texture(tScene, uv + cd * ca).b;
    if (uSharpen > 0.0) {
      vec3 n = texture(tScene, uv + vec2(uSrcTexel.x, 0)).rgb + texture(tScene, uv - vec2(uSrcTexel.x, 0)).rgb
             + texture(tScene, uv + vec2(0, uSrcTexel.y)).rgb + texture(tScene, uv - vec2(0, uSrcTexel.y)).rgb;
      col = max(col + (col * 4.0 - n) * uSharpen * 0.25, 0.0);
    }
  }
  col += texture(tBloom, uv).rgb * uBloom;
  col += texture(tRays, uv).rgb * uRays * uRayColor;
  // subtle warm sun-side optical veil ONLY (NO green/cyan floating lens-flare circles across mountain flanks!)
  if (uSunVis > 0.001) {
    vec2 sd = (uv - uSun) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
    float veil = exp(-dot(sd, sd) * 5.2) * 0.045 * uSunVis;
    col += uRayColor * vec3(1.0, 0.86, 0.66) * veil;
  }
  col *= uExposure;
  col *= uWB;
  col = stylTone(col);

  // painterly low-sun green grade:
  // shift sunlit golden-hour grass toward warm toasted ochre-amber (NEVER neon lime/chartreuse!)
  {
    float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
    float chroma = mx - mn;
    float isGreen = smoothstep(0.01, 0.09, col.g - max(col.r * 0.84, col.b)) * smoothstep(0.02, 0.14, chroma);
    float lowSun = max(uGoldenK, uDawnK);
    float goldEvening = uGoldenK * (1.0 - uDawnK);
    float warmMask = isGreen * smoothstep(0.08, 0.36, mx) * lowSun;
    // warm sunlit morning gold-emerald at dawn & luminous warm honey-emerald grassland at evening sunset (NEVER muddy brown clearings in summitWest.png!)
    float lumG = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 goldSage = mix(vec3(lumG), col * vec3(1.00, 1.04, 0.76), 0.92);
    vec3 warmDawn = mix(vec3(lumG), col * vec3(1.14, 0.98, 0.86), 0.88);
    vec3 warmG = mix(warmDawn, goldSage, goldEvening);
    // calm over-saturated yellow-ochre at evening sunset while preserving lively green grassland chroma
    float isYellow = smoothstep(0.08, 0.26, min(col.r, col.g) - col.b) * smoothstep(0.20, 0.50, mx) * goldEvening;
    col = mix(col, max(warmG, 0.0), clamp(warmMask * mix(0.60, 0.68, goldEvening) + isYellow * 0.46, 0.0, 0.85));
    // daytime lush freshness on mid-bright foliage (restrained, never neon)
    float dayFresh = isGreen * smoothstep(0.16, 0.45, mx) * (1.0 - lowSun);
    col = mix(col, max(col + vec3(-0.008, 0.018, -0.018) * chroma * 1.4, 0.0), dayFresh * 0.45);
    // shaded greens at dawn & sunset: lift softly toward luminous lavender-violet (NEVER cold teal!)
    float dkG = isGreen * (1.0 - smoothstep(0.06, 0.30, mx)) * lowSun;
    vec3 shLift = mix(vec3(1.14, 0.90, 1.16), vec3(1.10, 0.94, 1.08), goldEvening);
    col = mix(col, col * shLift, dkG * 0.56);
  }

  // split toning: cool/violet luminous shadows, warm creamy highlights
  float Lg = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 hiTint = mix(vec3(1.04, 1.0, 0.94), vec3(1.08, 0.97, 0.88), max(uGoldenK, uDawnK));
  col *= mix(uShadowTint, hiTint, smoothstep(0.08, 0.68, Lg));
  vec3 deepLift = mix(vec3(0.95, 0.96, 1.08), vec3(1.04, 0.92, 1.12), max(uGoldenK, uDawnK));
  col = mix(col, vec3(Lg) * deepLift, (1.0 - smoothstep(0.04, 0.36, Lg)) * 0.16);

  // grading
  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(L), col, uSat);
  col = col * uGain + uLift * (1.0 - col);
  col = clamp(col, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
  // vignette
  vec2 vv = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float vig = 1.0 - dot(vv, vv) * uVignette;
  col *= clamp(vig, 0.0, 1.0);
  col = toSRGB(col);
  // film grain + dithering
  float n = hash(uv * uRes + fract(uTime * 7.13) * 100.0) - 0.5;
  col += n * uGrain * (1.0 - col * 0.5);
  col += (hash(uv * uRes * 1.3 + 3.1) - 0.5) / 255.0;
  col *= uFade;
  // cinematic bars
  float bar = step(uLetterbox, uv.y) * step(uv.y, 1.0 - uLetterbox);
  col *= bar;
  gl_FragColor = vec4(col, 1.0);
}`;

const RAY_TAPS_MAX = 40;
const RAY_DECAY = 0.962;

export class Post {
  constructor(renderer, opts) {
    this.renderer = renderer;
    this.caps = getCaps(renderer);
    this.opts = opts;
    this.reverse = !!opts.reverse;
    this.quad = fullscreenQuad(null);
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this.downMat = mk(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 1.2 } });
    this.upMat = mk(UP, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
    this.maskMat = mk(RAYMASK, { tScene: { value: null }, tDepth: { value: null }, uReverse: { value: this.reverse ? 1 : 0 }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.blurMat = mk(RAYBLUR, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 0.02 }, uTaps: { value: RAY_TAPS_MAX }, uDecay: { value: RAY_DECAY } });
    this.compMat = mk(COMPOSITE, {
      tScene: { value: null }, tBloom: { value: null }, tRays: { value: null }, tGhost: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0.05 }, uRays: { value: 0 }, uRayColor: { value: new THREE.Color(1, 0.8, 0.6) },
      uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uVignette: { value: 0.28 }, uGrain: { value: 0.022 },
      uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1.08 }, uContrast: { value: 0.12 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uSun: { value: new THREE.Vector2() }, uSunVis: { value: 0 }, uFade: { value: 1 },
      uSharpen: { value: 0 }, uSrcTexel: { value: new THREE.Vector2() }, uLetterbox: { value: 0 }, uFxaa: { value: 0 }, uShadowTint: { value: new THREE.Vector3(0.9, 0.95, 1.14) }, uGoldenK: { value: 0 }, uDawnK: { value: 0 },
    });
    this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.blackTex.needsUpdate = true;
    this.sceneRT = null;
  }

  setSize(w, h, scale) {
    this.w = w; this.h = h;
    const sw = Math.max(16, Math.round(w * scale)), sh = Math.max(16, Math.round(h * scale));
    this.sw = sw; this.sh = sh;
    if (this.sceneRT) this.sceneRT.dispose();
    const hdrType = this.caps.hdrTargetType;
    const samples = clampMsaaSamples(this.opts.msaa, this.caps);
    const depthTex = new THREE.DepthTexture(sw, sh);
    depthTex.type = this.caps.depthTextureType;
    this.sceneRT = new THREE.WebGLRenderTarget(sw, sh, {
      type: hdrType, samples, depthTexture: depthTex,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.compMat.uniforms.uFxaa.value = samples > 0 ? 0 : 1;
    // bloom chain; the lens ghost and the loading-screen warm-up read down[1], so keep at least two levels
    if (this.down) this.down.concat(this.up).forEach((r) => r.dispose());
    this.down = []; this.up = [];
    let bw = sw >> 1, bh = sh >> 1;
    const levels = Math.max(2, Math.round(this.opts.bloomLevels ?? 6));
    for (let i = 0; i < levels; i++) {
      const o = { type: hdrType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
      this.down.push(new THREE.WebGLRenderTarget(Math.max(2, bw), Math.max(2, bh), o));
      this.up.push(new THREE.WebGLRenderTarget(Math.max(2, bw), Math.max(2, bh), o));
      bw >>= 1; bh >>= 1;
    }
    if (this.rayA) { this.rayA.dispose(); this.rayB.dispose(); }
    const ro = { type: hdrType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.rayA = new THREE.WebGLRenderTarget(Math.max(2, sw >> 2), Math.max(2, sh >> 2), ro);
    this.rayB = new THREE.WebGLRenderTarget(Math.max(2, sw >> 2), Math.max(2, sh >> 2), ro);
    this.compMat.uniforms.uRes.value.set(w, h);
    this.compMat.uniforms.uSrcTexel.value.set(1 / sw, 1 / sh);
    this.compMat.uniforms.uSharpen.value = scale < 0.99 ? 0.6 : 0.18;
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  render(params) {
    const src = this.sceneRT.texture;
    // bloom
    let bloomTex = this.blackTex;
    if (!params.skipBloom) {
      let input = src;
      for (let i = 0; i < this.down.length; i++) {
        const t = this.down[i];
        this.downMat.uniforms.tSrc.value = input;
        const iw = i === 0 ? this.sw : this.down[i - 1].width, ih = i === 0 ? this.sh : this.down[i - 1].height;
        this.downMat.uniforms.uTexel.value.set(1 / iw, 1 / ih);
        this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
        this.downMat.uniforms.uThreshold.value = params.bloomThreshold ?? 1.0;
        this._pass(this.downMat, t);
        input = t.texture;
      }
      let prev = this.down[this.down.length - 1].texture;
      for (let i = this.down.length - 2; i >= 0; i--) {
        this.upMat.uniforms.tSrc.value = prev;
        this.upMat.uniforms.tAdd.value = this.down[i].texture;
        this.upMat.uniforms.uTexel.value.set(1 / this.down[i + 1].width, 1 / this.down[i + 1].height);
        this._pass(this.upMat, this.up[i]);
        prev = this.up[i].texture;
      }
      bloomTex = this.up[0].texture;
    }
    // god rays
    let rays = this.blackTex;
    if (!params.skipBloom && params.rays > 0.001 && this.opts.godrays) {
      // A tier gives the tap count; fewer taps take longer steps and decay faster so the
      // streaks keep the same reach and falloff.
      const taps = Math.max(4, Math.min(RAY_TAPS_MAX, this.opts.godrays === true ? RAY_TAPS_MAX : Math.round(this.opts.godrays)));
      const stretch = RAY_TAPS_MAX / taps;
      this.blurMat.uniforms.uTaps.value = taps;
      this.blurMat.uniforms.uDecay.value = Math.pow(RAY_DECAY, stretch);
      this.maskMat.uniforms.tScene.value = src;
      this.maskMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
      this.maskMat.uniforms.uSun.value.copy(params.sunUV);
      this.maskMat.uniforms.uAspect.value = this.sw / this.sh;
      this._pass(this.maskMat, this.rayA);
      this.blurMat.uniforms.uSun.value.copy(params.sunUV);
      this.blurMat.uniforms.tSrc.value = this.rayA.texture; this.blurMat.uniforms.uStep.value = 0.022 * stretch;
      this._pass(this.blurMat, this.rayB);
      this.blurMat.uniforms.tSrc.value = this.rayB.texture; this.blurMat.uniforms.uStep.value = 0.008 * stretch;
      this._pass(this.blurMat, this.rayA);
      rays = this.rayA.texture;
    }
    const u = this.compMat.uniforms;
    u.tScene.value = src;
    u.tBloom.value = bloomTex;
    u.tRays.value = rays;
    u.tGhost.value = this.down[1].texture;
    u.uExposure.value = params.exposure;
    u.uBloom.value = params.bloom;
    u.uRays.value = params.rays;
    u.uRayColor.value.copy(params.rayColor);
    u.uTime.value = params.time;
    u.uSun.value.copy(params.sunUV);
    u.uSunVis.value = params.sunVis;
    u.uFade.value = params.fade;
    u.uWB.value.copy(params.wb);
    u.uLift.value.copy(params.lift);
    u.uGain.value.copy(params.gain);
    u.uSat.value = params.sat;
    u.uContrast.value = params.contrast;
    u.uLetterbox.value = params.letterbox || 0;
    if (params.shadowTint) u.uShadowTint.value.copy(params.shadowTint);
    u.uGoldenK.value = params.golden || 0;
    u.uDawnK.value = params.dawn || 0;
    this._pass(this.compMat, null);
  }
}
