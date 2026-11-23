import * as THREE from 'three';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { mulberry32 } from './biome.js';

// Big stylized cumulus: clusters of puffs (instanced spheres) with flat bases,
// soft painted shading (warm lit tops, cool blue undersides) and fluffy edges.

const VERT = /* glsl */ `
${COMMON}
attribute vec4 aPuff;   // xyz offset in cluster space, w radius
attribute vec4 aCluster; // xyz cluster centre, w base height (world y)
attribute float aSeed;
uniform vec2 uDrift;
uniform float uWrap;
varying vec3 vN;
varying vec3 vPN;
varying vec3 vW;
varying float vH;
varying float vSeed;
void main(){
  vec3 c = aCluster.xyz;
  c.xz += uDrift;
  c.xz = mod(c.xz + uWrap * 0.5, uWrap) - uWrap * 0.5;
  vec3 n = normalize(position);
  // cauliflower bumps
  float b = texture(uNoiseTex, n.xz * 0.35 + n.y * 0.2 + aSeed).a;
  float b2 = texture(uNoiseTex, n.xy * 0.7 + aSeed * 1.7).b;
  float r = aPuff.w * (0.88 + 0.22 * b + 0.08 * b2);
  vec3 wp = c + aPuff.xyz + n * r;
  // flat bottoms
  float base = aCluster.w;
  float flatB = smoothstep(base + aPuff.w * 0.25, base - aPuff.w * 0.1, wp.y);
  wp.y = max(wp.y, base - 10.0);
  vec3 cc = vec3(c.x, base + (aCluster.y - base) * 0.35, c.z);
  vec3 cn = normalize((wp - cc) * vec3(1.0, 1.8, 1.0));
  vN = normalize(mix(mix(n, cn, 0.8), vec3(0.0, -1.0, 0.0), flatB * 0.85));
  vW = wp;
  vPN = n;
  vH = clamp((wp.y - base) / max(aCluster.y - base + aPuff.w, 1.0), 0.0, 1.0);
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
${COMMON}
varying vec3 vN;
varying vec3 vPN;
varying vec3 vW;
varying float vH;
varying float vSeed;
void main(){
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = uLightDir;
  float ndl = dot(N, L);
  float lit = smoothstep(-0.35, 0.55, ndl);
  lit *= 0.55 + 0.45 * vH;
  vec3 zen = w_sky(vec3(0.0, 1.0, 0.0));
  vec3 hor = w_sky(normalize(vec3(-V.x, 0.08, -V.z)));
  float sunI = max(max(uLightColor.r, uLightColor.g), uLightColor.b);
  vec3 sunC = uLightColor / max(sunI, 1e-4);
  float day = smoothstep(-0.05, 0.15, uLightDir.y);
  vec3 shadowCol = mix(zen, hor, 0.35) * vec3(0.78, 0.86, 1.08) * 1.25 + vec3(0.02, 0.025, 0.04);
  vec3 litCol = sunC * sunI * 0.32 + zen * 0.4;
  // low sun: peach-orange lit tops, lilac bellies
  shadowCol = mix(shadowCol, vec3(0.6, 0.5, 0.78) * max(dot(zen, vec3(0.3, 0.5, 0.2)) * 2.2, 0.08), uGolden * 0.7);
  litCol = mix(litCol, vec3(1.0, 0.74, 0.55) * (0.8 + sunI * 0.32) + zen * 0.4, uGolden * 0.8);
  vec3 col = mix(shadowCol, litCol, lit);
  // silver lining on the side facing the sun when we look toward it
  float fw = pow(max(dot(-V, L), 0.0), 6.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  col += sunC * sunI * rim * (0.12 + fw * 0.9) * 0.4;
  // translucent backlit edges & bright sun-facing rim
  float sunFace = pow(max(dot(N, L), 0.0), 2.0);
  col += sunC * min(sunI, 8.0) * 0.06 * sunFace * (1.0 - uNight);
  col += sunC * min(sunI, 8.0) * 0.12 * pow(rim, 1.5) * fw * (1.0 - uNight);
  // soft fluffy edges
  float en = texture(uNoiseTex, vW.xz * 0.0011 + vW.y * 0.0007 + vSeed).a;
  float en2 = texture(uNoiseTex, vW.xz * 0.004 - vW.y * 0.002).b;
  float facing = dot(N, V);
  float a = smoothstep(0.0, 0.3, dot(normalize(vPN), V) + (en - 0.5) * 0.5 + (en2 - 0.5) * 0.25);
  if (a < 0.02) discard;
  col *= 0.94 + 0.12 * en2;
  // distance haze toward the horizon sky colour
  float dist = length(vW - cameraPosition);
  float haze = 1.0 - exp(-dist * 3.0e-5);
  col = mix(col, hor * 1.05, haze * 0.75);
  col *= mix(0.78, 1.08, vH);
  // night: moonlit soft grey-blue that sits just above the sky, not a black cut-out
  vec3 skyHere = w_sky(normalize(vec3(-V.x, max(-V.y, 0.05), -V.z)));
  vec3 nightC = skyHere * mix(0.95, 1.25, vH) + vec3(0.002, 0.0025, 0.004) * rim;
  col = mix(col, nightC, uNight * 0.97);
  // moonlit silver lining
  float mfw = pow(max(dot(-V, uLightDir), 0.0), 8.0);
  col += vec3(0.55, 0.62, 0.8) * 0.02 * rim * (0.3 + mfw * 3.0) * uNight;
  a *= mix(1.0, 0.5, uNight);
  col *= max(mix(0.55, 1.0, smoothstep(-0.08, 0.12, uSunDir.y)), uNight);
  gl_FragColor = vec4(col, a);
}
`;

export class Clouds {
  constructor(count = 26, detail = 3) {
    const rnd = mulberry32(2024);
    const puffs = [];
    const clusters = [];
    for (let c = 0; c < count; c++) {
      // ring around the valley, away from the very centre
      const ang = rnd() * Math.PI * 2;
      const dist = 5200 + rnd() * 7000;
      const cx = Math.cos(ang) * dist - 200, cz = Math.sin(ang) * dist - 150;
      const base = 2900 + rnd() * 700;
      const w = 1400 + rnd() * 2200;
      const hgt = w * (0.45 + rnd() * 0.3);
      const n = 18 + Math.floor(w / 35);
      const top = base + hgt;
      for (let i = 0; i < n; i++) {
        // dome-shaped distribution: big puffs centre-top, small at the rim
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
        const x = Math.cos(a) * rr * w * 0.5, z = Math.sin(a) * rr * w * 0.32;
        const dome = Math.sqrt(Math.max(0, 1 - rr * rr));
        const r = (0.12 + 0.17 * dome + rnd() * 0.08) * w * 0.5;
        const y = base + r * 0.35 + dome * hgt * 0.6 * rnd();
        puffs.push([x, y - base, z, r, cx, top, cz, base, rnd() * 10]);
      }
      clusters.push({ cx, cz, base, top });
    }
    // a few low fair-weather puffs hanging over the valley floor
    for (let c = 0; c < 0; c++) {
      const ang = rnd() * Math.PI * 2, dist = 900 + rnd() * 1400;
      const cx = Math.cos(ang) * dist - 200, cz = Math.sin(ang) * dist - 150;
      const base = 320 + rnd() * 120;
      const w = 160 + rnd() * 160, hgt = w * 0.35;
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
        const x = Math.cos(a) * rr * w * 0.5, z = Math.sin(a) * rr * w * 0.3;
        const dome = Math.sqrt(Math.max(0, 1 - rr * rr));
        const r = (0.14 + 0.18 * dome + rnd() * 0.06) * w * 0.5;
        const y = base + r * 0.35 + dome * hgt * 0.6 * rnd();
        puffs.push([x, y - base, z, r, cx, base + hgt, cz, base, rnd() * 10]);
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    const ico = new THREE.IcosahedronGeometry(1, detail);
    geo.setAttribute('position', ico.attributes.position);
    if (ico.index) geo.setIndex(ico.index);
    const P = new Float32Array(puffs.length * 4), C = new Float32Array(puffs.length * 4), S = new Float32Array(puffs.length);
    puffs.forEach((p, i) => {
      P.set([p[0], p[1], p[2], p[3]], i * 4);
      C.set([p[4], p[5], p[6], p[7]], i * 4);
      S[i] = p[8];
    });
    // offsets were relative to base; store absolute y offset from cluster centre (cx, 0, cz)
    for (let i = 0; i < puffs.length; i++) P[i * 4 + 1] += C[i * 4 + 3];
    // cluster centre y = 0 so world = (cx, 0, cz) + puff
    for (let i = 0; i < puffs.length; i++) { const top = C[i * 4 + 1]; C[i * 4 + 1] = top; }
    geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(P, 4));
    // aCluster: xyz = centre (x, top, z) used for vH, w = base. We need centre y = 0 for placement
    const Cpos = new Float32Array(puffs.length * 4);
    for (let i = 0; i < puffs.length; i++) { Cpos[i * 4] = C[i * 4]; Cpos[i * 4 + 1] = C[i * 4 + 1]; Cpos[i * 4 + 2] = C[i * 4 + 2]; Cpos[i * 4 + 3] = C[i * 4 + 3]; }
    geo.setAttribute('aCluster', new THREE.InstancedBufferAttribute(Cpos, 4));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(S, 1));
    geo.instanceCount = puffs.length;
    this.uniforms = { ...U, uDrift: { value: new THREE.Vector2() }, uWrap: { value: 26000 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT.replace('vec3 c = aCluster.xyz;', 'vec3 c = vec3(aCluster.x, 0.0, aCluster.z);'),
      fragmentShader: FRAG,
      transparent: false,
      depthWrite: true,
      alphaToCoverage: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -500;
    this.count = puffs.length;
  }
  update(dt, wind) {
    const d = this.uniforms.uDrift.value;
    d.x += U.uWindDir.value.x * dt * (3 + wind * 6);
    d.y += U.uWindDir.value.y * dt * (3 + wind * 6);
  }
}
