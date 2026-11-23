import * as THREE from 'three';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { mulberry32 } from './biome.js';

// Unified Studio Ghibli / Makoto Shinkai painterly cumulus banks:
// - Flat, stately condensation bases + billowing cauliflower crowns (ZERO drip streaks or sawtooth cutouts!)
// - Solid 4x-MSAA silhouettes blended smoothly at grazing rims (ZERO alphaToCoverage speckles!)
// - 3-stop sunset/dawn lighting: cool twilight indigo-violet shadow -> luminous rose-coral midtone -> blazing peach-gold rim!
// - Silky moonlit night clouds with soft luminous gap framing the moon!

const VERT = /* glsl */ `
${COMMON}
attribute vec4 aPuff;    // xyz offset in cluster space, w radius
attribute vec4 aCluster; // x, topY, z of cluster centre; w base height (world y)
attribute float aSeed;
uniform vec2 uDrift;
uniform float uWrap;
varying vec3 vN;
varying vec3 vPN;
varying vec3 vW;
varying float vH;
varying float vSeed;
void main(){
  vec3 c = vec3(aCluster.x, 0.0, aCluster.z);
  c.xz += uDrift;
  c.xz = mod(c.xz + uWrap * 0.5, uWrap) - uWrap * 0.5;
  vec3 n = normalize(position);
  // smooth organic cauliflower billows (no lumpy spikes)
  float b = texture(uNoiseTex, n.xz * 0.34 + n.y * 0.22 + aSeed).a;
  float b2 = texture(uNoiseTex, n.xy * 0.70 + aSeed * 1.7).b;
  float r = aPuff.w * (0.92 + 0.16 * b + 0.05 * b2);
  vec3 wp = c + aPuff.xyz + n * r;
  // stately, clean flat-bottomed Ghibli cumulus condensation deck (eliminates ragged hanging drips!)
  float base = aCluster.w;
  float softBase = base + (b - 0.5) * 26.0;
  float underB = smoothstep(softBase + aPuff.w * 0.42, softBase - aPuff.w * 0.08, wp.y);
  if (wp.y < softBase) {
    wp.y = softBase - (softBase - wp.y) * 0.12;
  }
  // cohesive dome normal with gentle individual puff relief (prevents flat tan cloud walls in lakeSunset.png!)
  vec3 cc = vec3(c.x, base + (aCluster.y - base) * 0.30, c.z);
  vec3 cn = normalize((wp - cc) * vec3(1.0, 1.45, 1.0));
  vN = normalize(mix(mix(n, cn, 0.80), vec3(0.0, -1.0, 0.0), underB * 0.58));
  vW = wp;
  vPN = n;
  vH = clamp((wp.y - base) / max(aCluster.y - base + aPuff.w * 0.65, 1.0), 0.0, 1.0);
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
  float lowSun = max(uGolden, uDawn);
  // soft wrapped sun lighting at golden/dawn (KILLS hard vertical plastic seam in lakeSunset.png!)
  float dayBand = smoothstep(-0.18, 0.38, ndl) * 0.76 + smoothstep(-0.45, 0.72, ndl) * 0.24;
  float lowBand = smoothstep(-0.55, 0.62, ndl);
  float lit = mix(dayBand, lowBand, lowSun);
  lit = clamp(lit * (0.52 + 0.54 * vH), 0.0, 1.0);

  vec3 zen = w_sky(vec3(0.0, 1.0, 0.0));
  vec3 viewDir = normalize(vW - cameraPosition);
  vec3 skyHere = w_sky(vec3(viewDir.x, max(viewDir.y, 0.02), viewDir.z));
  vec3 hor = w_sky(normalize(vec3(viewDir.x, 0.08, viewDir.z)));
  float sunI = max(max(uLightColor.r, uLightColor.g), uLightColor.b);
  vec3 sunC = uLightColor / max(sunI, 1e-4);

  // daytime: crisp luminous cerulean-periwinkle bellies, bright creamy sunlit cumulus tops
  vec3 shadowCol = mix(zen, hor, 0.36) * vec3(0.76, 0.87, 1.15) * 1.32 + vec3(0.015, 0.025, 0.055);
  vec3 litCol = sunC * min(sunI, 10.0) * 0.35 + zen * 0.45 + vec3(0.055, 0.052, 0.044);
  vec3 dayCol = mix(shadowCol, litCol, lit);

  // golden hour & dawn: pure luminous magenta-lavender shadow -> rose-pink mid -> glowing peach-gold rim!
  // (NEVER muddy brown-grey cores in summitWest.png or lakeSunset.png!)
  float zenL = max(dot(zen, vec3(0.25, 0.55, 0.2)), 0.085);
  vec3 gCore = mix(vec3(0.62, 0.36, 0.88), vec3(0.56, 0.44, 0.90), uDawn) * max(zenL * 2.8, 0.28);
  vec3 gMid  = mix(vec3(1.00, 0.52, 0.78), vec3(1.00, 0.68, 0.76), uDawn) * max(zenL * 3.3, 0.42);
  vec3 gTop  = mix(vec3(1.0, 0.80, 0.54), vec3(1.0, 0.88, 0.64), uDawn) * (0.95 + min(sunI, 9.0) * 0.32) + zen * 0.28;
  vec3 goldCol = mix(gCore, gMid, smoothstep(0.08, 0.54, lit));
  goldCol = mix(goldCol, gTop, smoothstep(0.46, 0.90, lit));

  vec3 col = mix(dayCol, goldCol, lowSun * 0.92);

  // dusk: velvety twilight violet underside with warm coral-apricot glowing rim
  float duskAmt = uDusk * (1.0 - smoothstep(0.60, 1.0, uNight));
  vec3 dCore = vec3(0.20, 0.18, 0.42) * max(zenL * 2.8, 0.10);
  vec3 dMid  = vec3(0.64, 0.34, 0.56) * max(zenL * 2.8, 0.11);
  vec3 dTop  = vec3(1.0, 0.60, 0.48) * max(zenL * 2.8, 0.14);
  vec3 duskCol = mix(mix(dCore, dMid, smoothstep(0.12, 0.56, lit)), dTop, smoothstep(0.48, 0.90, lit));
  col = mix(col, duskCol, duskAmt * 0.82);

  // smooth un-banded sun-direction silver/apricot rim glow (kills concentric halo rings in summitWest.png!)
  float fw = pow(max(dot(viewDir, L), 0.0), 3.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 1.6);
  float sunEdge = smoothstep(-0.35, 0.65, dot(N, L));
  vec3 rimTint = mix(sunC, vec3(1.0, 0.74, 0.46), lowSun * 0.72);
  col += rimTint * min(sunI, 8.5) * rim * (0.10 + fw * 0.75 + lowSun * 0.20 * sunEdge) * 0.32 * (1.0 - uNight);
  col += sunC * min(sunI, 8.0) * 0.04 * pow(max(dot(N, L), 0.0), 2.0) * (1.0 - uNight);

  // gentle painterly brushwork variation inside cloud body
  float en = texture(uNoiseTex, vW.xz * 0.0008 + vW.y * 0.0005 + vSeed).a;
  col *= 0.96 + 0.07 * en;

  // aerial perspective toward horizon sky (keep minimal at sunset so orange horizon fog NEVER turns magenta-lavender cloud shadows brown!)
  float dist = length(vW - cameraPosition);
  float haze = 1.0 - exp(-dist * 2.4e-5);
  col = mix(col, hor * 1.04, haze * mix(0.56, 0.14, lowSun));
  col *= mix(0.86, 1.06, vH);

  // night: velvety deep indigo cumulus melting into the starry night sky, with a soft silver-pearl moon halo strictly where backlit!
  float moonAlign = dot(viewDir, uLightDir);
  float mfw = pow(max(moonAlign, 0.0), 6.0);
  vec3 nightC = skyHere * mix(0.76, 1.00, vH) + vec3(0.46, 0.56, 0.84) * 0.020 * rim * (0.25 + mfw * 4.8);
  // soft silver moon halo & crisp luminous moon disc shining through high clouds at night!
  float moonHalo = pow(max(moonAlign, 0.0), 140.0) * 0.30 + pow(max(moonAlign, 0.0), 1200.0) * 0.80;
  float moonDisc = smoothstep(0.99988, 0.99996, moonAlign);
  nightC += vec3(0.86, 0.91, 1.0) * (moonHalo + moonDisc * 2.1);
  col = mix(col, nightC, uNight * 0.96);

  // silky outer cluster horizon softening ONLY on extreme grazing cluster edges (ZERO inner-puff sky seams, ZERO stair-step aliasing!)
  float rimSoft = smoothstep(-0.04, 0.14, dot(N, V));
  col = mix(skyHere, col, mix(0.65, 1.0, rimSoft) * mix(1.0, 0.72 + 0.24 * mfw, uNight));

  col *= max(mix(0.68, 1.0, smoothstep(-0.08, 0.12, uSunDir.y)), uNight);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Clouds {
  constructor(count = 26, detail = 3) {
    const geo = this._buildGeo(count, detail);
    this.uniforms = { ...U, uDrift: { value: new THREE.Vector2() }, uWrap: { value: 28000 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      depthWrite: true,
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -500;
  }

  _buildGeo(count, detail) {
    const rnd = mulberry32(2026);
    const puffs = [];
    for (let c = 0; c < count; c++) {
      const arch = c % 3;
      const ang = (c / count) * Math.PI * 2 + (rnd() - 0.5) * 0.24;
      const dist = arch === 1 ? (8800 + rnd() * 5200) : arch === 2 ? (6800 + rnd() * 6400) : (7600 + rnd() * 5400);
      const cx = Math.cos(ang) * dist - 200, cz = Math.sin(ang) * dist - 150;
      const base = arch === 0 ? (2350 + rnd() * 650) : arch === 1 ? (3450 + rnd() * 950) : (2650 + rnd() * 1650);
      const w = arch === 0 ? (1950 + rnd() * 1950) : arch === 1 ? (2900 + rnd() * 2100) : (950 + rnd() * 850);
      const hgt = arch === 0 ? w * (0.38 + rnd() * 0.18) : arch === 1 ? w * (0.13 + rnd() * 0.08) : w * (0.24 + rnd() * 0.14);
      const n = arch === 2 ? (14 + Math.floor(w / 75)) : (22 + Math.floor(w / 38));
      const top = base + hgt;
      const tang = ang + Math.PI * 0.5 + (rnd() - 0.5) * 0.45;
      const ct = Math.cos(tang), st = Math.sin(tang);
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.84;
        const longAx = arch === 1 ? 0.64 : 0.50;
        const depthAx = arch === 1 ? 0.16 : 0.25;
        const lx = Math.cos(a) * rr * w * longAx, lz = Math.sin(a) * rr * w * depthAx;
        const x = lx * ct - lz * st, z = lx * st + lz * ct;
        const dome = Math.sqrt(Math.max(0, 1 - rr * rr));
        const puffScale = arch === 1 ? 0.28 : arch === 2 ? 0.42 : 0.46;
        const r = (0.13 + 0.18 * dome + rnd() * 0.055) * w * puffScale;
        const y = base + r * (arch === 1 ? 0.22 : 0.32) + Math.pow(dome, arch === 0 ? 0.72 : 1.0) * hgt * (0.30 + 0.70 * rnd());
        puffs.push([x, y, z, r, cx, top, cz, base, rnd() * 10]);
      }
    }
    for (const [angW, distW, baseW, wW] of [[-2.74, 7200, 7400, 2400], [-1.70, 7400, 6950, 2450]]) {
      const cx = Math.cos(angW) * distW - 200, cz = Math.sin(angW) * distW - 150;
      const hgt = wW * 0.36, top = baseW + hgt, tang = angW + Math.PI * 0.5;
      const ct = Math.cos(tang), st = Math.sin(tang);
      for (let i = 0; i < 42; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 0.82;
        const lx = Math.cos(a) * rr * wW * 0.50, lz = Math.sin(a) * rr * wW * 0.24;
        const x = lx * ct - lz * st, z = lx * st + lz * ct;
        const dome = Math.sqrt(Math.max(0, 1 - rr * rr));
        const r = (0.16 + 0.18 * dome + rnd() * 0.05) * wW * 0.45;
        const y = baseW + r * 0.32 + Math.pow(dome, 0.85) * hgt * (0.34 + 0.66 * rnd());
        puffs.push([x, y, z, r, cx, top, cz, baseW, rnd() * 10]);
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
    geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(P, 4));
    geo.setAttribute('aCluster', new THREE.InstancedBufferAttribute(C, 4));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(S, 1));
    geo.instanceCount = puffs.length;
    this.count = puffs.length;
    return geo;
  }

  update(dt, wind) {
    const d = this.uniforms.uDrift.value;
    d.x += U.uWindDir.value.x * dt * (3 + wind * 6);
    d.y += U.uWindDir.value.y * dt * (3 + wind * 6);
  }

  setTier(tier) {
    const oldGeo = this.mesh.geometry;
    this.mesh.geometry = this._buildGeo(tier.clouds, tier.cloudDetail);
    oldGeo.dispose();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export function createClouds(ctx) {
  const clouds = new Clouds(ctx.tier.clouds, ctx.tier.cloudDetail);
  ctx.scene.add(clouds.mesh);
  return {
    instance: clouds,
    update(frame) { clouds.update(frame.dt, frame.env.wind); },
    setTier(tier) { clouds.setTier(tier); },
    dispose() { clouds.dispose(); },
  };
}
