import * as THREE from 'three';
import { fullscreenQuad } from './world/heightmap.js';

// HDR post-processing: physically-based bloom (mip chain), crepuscular rays from
// the sun, anamorphic-free lens ghosts, ACES tonemapping, grading, vignette, grain.

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
    col = min(col, vec3(60.0));
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
  float prox = exp(-dot(dv, dv) * 5.0);
  vec3 m = min(c, vec3(8.0)) * sky * prox;
  gl_FragColor = vec4(m, 1.0);
}`;

const RAYBLUR = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uSun; uniform float uStep;
varying vec2 vUv;
void main(){
  vec2 dir = (uSun - vUv) * uStep;
  vec2 uv = vUv;
  vec3 acc = vec3(0.0);
  float w = 1.0, tw = 0.0;
  float j = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
  uv += dir * j;
  for (int i = 0; i < 40; i++){
    acc += texture(tSrc, uv).rgb * w;
    tw += w;
    w *= 0.965;
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
uniform float uLetterbox;
uniform vec3 uShadowTint;
uniform float uGoldenK;
varying vec2 vUv;
vec3 stylTone(vec3 x){
  float L = dot(x, vec3(0.2126, 0.7152, 0.0722));
  float Lt = L * (1.0 + L / 7.0) / (1.0 + L);
  vec3 c = x * (Lt / max(L, 1e-5));
  float m = max(c.r, max(c.g, c.b));
  if (m > 1.0) c = mix(c / m, vec3(1.0), clamp((m - 1.0) / (m + 0.5), 0.0, 1.0));
  return clamp(c, 0.0, 1.0);
}
vec3 aces(vec3 x){
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = i * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv;
  // subtle chromatic aberration toward the edges
  vec2 cd = (uv - 0.5);
  float ca = dot(cd, cd) * 0.0035;
  vec3 col;
  col.r = texture(tScene, uv - cd * ca).r;
  col.g = texture(tScene, uv).g;
  col.b = texture(tScene, uv + cd * ca).b;
  if (uSharpen > 0.0) {
    vec3 n = texture(tScene, uv + vec2(uSrcTexel.x, 0)).rgb + texture(tScene, uv - vec2(uSrcTexel.x, 0)).rgb
           + texture(tScene, uv + vec2(0, uSrcTexel.y)).rgb + texture(tScene, uv - vec2(0, uSrcTexel.y)).rgb;
    col = max(col + (col * 4.0 - n) * uSharpen * 0.25, 0.0);
  }
  col += texture(tBloom, uv).rgb * uBloom;
  col += texture(tRays, uv).rgb * uRays * uRayColor;
  // lens ghosts from the sun
  if (uSunVis > 0.001) {
    vec2 g = vec2(0.5) - uv;
    vec3 ghosts = vec3(0.0);
    for (int i = 1; i < 5; i++){
      vec2 o = uv + g * (float(i) * 0.42);
      float w = pow(1.0 - length(vec2(0.5) - o) / 0.7071, 6.0);
      vec3 tint = i == 1 ? vec3(0.9, 0.7, 0.5) : i == 2 ? vec3(0.5, 0.8, 0.9) : i == 3 ? vec3(0.8, 0.6, 1.0) : vec3(0.6, 0.9, 0.6);
      ghosts += texture(tGhost, o).rgb * w * tint;
    }
    // halo ring
    vec2 hv = normalize(g + 1e-5) * 0.42;
    float hw = pow(1.0 - length(vec2(0.5) - fract(uv + hv)) / 0.7071, 8.0);
    ghosts += texture(tGhost, uv + hv).rgb * hw * vec3(1.0, 0.85, 0.7) * 0.6;
    col += ghosts * 0.022 * uSunVis;
  }
  col *= uExposure;
  col *= uWB;
  col = stylTone(col);
  // golden hour: chartreuse greens lean back toward green
  {
    float yg = smoothstep(0.0, 0.1, col.g - col.b) * smoothstep(-0.05, 0.12, col.r - col.b) * smoothstep(0.0, 0.08, col.g - col.r + 0.06);
    col.r = mix(col.r, col.r * 0.78, yg * uGoldenK);
    col.g = mix(col.g, col.g * 0.92, yg * uGoldenK);
    col.b = mix(col.b, col.b + (col.g - col.b) * 0.12, yg * uGoldenK);
  }
  {
    float mxg = max(col.r, max(col.g, col.b)), mng = min(col.r, min(col.g, col.b));
    float greenish = smoothstep(0.0, 0.06, col.g - col.b) * smoothstep(-0.02, 0.06, col.g - col.r + 0.05);
    float Lg2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
    // lit greens: more saturated; shaded greens: cool teal
    vec3 satd = mix(vec3(Lg2), col, 1.3);
    col = mix(col, max(satd, 0.0), greenish * uGoldenK * smoothstep(0.15, 0.4, mxg) * 0.8);
    col = mix(col, col * vec3(0.85, 1.0, 1.15), greenish * uGoldenK * (1.0 - smoothstep(0.1, 0.35, mxg)) * 0.6);
  }
  // keep foliage fresh: pull olive (low-sat yellow-green) toward clean yellow-green
  {
    float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
    float isGreen = smoothstep(0.0, 0.08, col.g - max(col.r, col.b) + 0.04) * smoothstep(0.02, 0.15, mx - mn);
    vec3 fresh = col + vec3(-0.02, 0.03, -0.03) * (mx - mn) * 2.0;
    col = mix(col, max(fresh, 0.0), isGreen * 0.8 * smoothstep(0.15, 0.4, mx));
    // shadows stay cool: desaturate & blue-shift dark greens
    float dk = (1.0 - smoothstep(0.08, 0.3, mx)) * isGreen;
    col = mix(col, col * vec3(0.9, 1.0, 1.12), dk * 0.5);
  }
  // split toning: cool shadows, warm highlights
  float Lg = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col *= mix(uShadowTint, vec3(1.05, 1.0, 0.93), smoothstep(0.1, 0.7, Lg));
  col = mix(col, vec3(Lg) * vec3(0.95, 0.96, 1.08), (1.0 - smoothstep(0.05, 0.4, Lg)) * 0.18);
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

export class Post {
  constructor(renderer, opts) {
    this.renderer = renderer;
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
    this.blurMat = mk(RAYBLUR, { tSrc: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 0.02 } });
    this.compMat = mk(COMPOSITE, {
      tScene: { value: null }, tBloom: { value: null }, tRays: { value: null }, tGhost: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0.05 }, uRays: { value: 0 }, uRayColor: { value: new THREE.Color(1, 0.8, 0.6) },
      uTime: { value: 0 }, uRes: { value: new THREE.Vector2() }, uVignette: { value: 0.32 }, uGrain: { value: 0.025 },
      uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1.08 }, uContrast: { value: 0.12 },
      uWB: { value: new THREE.Vector3(1, 1, 1) }, uSun: { value: new THREE.Vector2() }, uSunVis: { value: 0 }, uFade: { value: 1 },
      uSharpen: { value: 0 }, uSrcTexel: { value: new THREE.Vector2() }, uLetterbox: { value: 0 }, uShadowTint: { value: new THREE.Vector3(0.9, 0.95, 1.14) }, uGoldenK: { value: 0 },
    });
    this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.blackTex.needsUpdate = true;
    this.sceneRT = null;
  }

  setSize(w, h, scale) {
    this.w = w; this.h = h;
    const sw = Math.max(16, Math.round(w * scale)), sh = Math.max(16, Math.round(h * scale));
    this.sw = sw; this.sh = sh;
    if (this.sceneRT) this.sceneRT.dispose();
    const depthTex = new THREE.DepthTexture(sw, sh);
    depthTex.type = THREE.FloatType;
    this.sceneRT = new THREE.WebGLRenderTarget(sw, sh, {
      type: THREE.HalfFloatType, samples: this.opts.msaa || 0, depthTexture: depthTex,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    // bloom chain
    if (this.down) this.down.concat(this.up).forEach((r) => r.dispose());
    this.down = []; this.up = [];
    let bw = sw >> 1, bh = sh >> 1;
    for (let i = 0; i < 6; i++) {
      const o = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
      this.down.push(new THREE.WebGLRenderTarget(Math.max(2, bw), Math.max(2, bh), o));
      this.up.push(new THREE.WebGLRenderTarget(Math.max(2, bw), Math.max(2, bh), o));
      bw >>= 1; bh >>= 1;
    }
    if (this.rayA) { this.rayA.dispose(); this.rayB.dispose(); }
    const ro = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.rayA = new THREE.WebGLRenderTarget(Math.max(2, sw >> 2), Math.max(2, sh >> 2), ro);
    this.rayB = new THREE.WebGLRenderTarget(Math.max(2, sw >> 2), Math.max(2, sh >> 2), ro);
    this.compMat.uniforms.uRes.value.set(w, h);
    this.compMat.uniforms.uSrcTexel.value.set(1 / sw, 1 / sh);
    this.compMat.uniforms.uSharpen.value = scale < 0.99 ? 0.6 : 0.15;
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  render(params) {
    const r = this.renderer;
    const src = this.sceneRT.texture;
    // bloom
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
    // god rays
    let rays = this.blackTex;
    if (params.rays > 0.001 && this.opts.godrays) {
      this.maskMat.uniforms.tScene.value = src;
      this.maskMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
      this.maskMat.uniforms.uSun.value.copy(params.sunUV);
      this.maskMat.uniforms.uAspect.value = this.sw / this.sh;
      this._pass(this.maskMat, this.rayA);
      this.blurMat.uniforms.uSun.value.copy(params.sunUV);
      this.blurMat.uniforms.tSrc.value = this.rayA.texture; this.blurMat.uniforms.uStep.value = 0.022;
      this._pass(this.blurMat, this.rayB);
      this.blurMat.uniforms.tSrc.value = this.rayB.texture; this.blurMat.uniforms.uStep.value = 0.008;
      this._pass(this.blurMat, this.rayA);
      rays = this.rayA.texture;
    }
    const u = this.compMat.uniforms;
    u.tScene.value = src;
    u.tBloom.value = this.up[0].texture;
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
    this._pass(this.compMat, null);
  }
}
