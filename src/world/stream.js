import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { WORLD } from '../config.js';
import { LAYER_NO_REFLECT } from './water.js';
import { mulberry32 } from './biome.js';

// A sparkling alpine river cascading down the waterfall amphitheatre into Stillwater Lake:
// flow-mapped painterly water, shallow-to-deep color gradient, foaming rapids & bank eddies.

const sample = (h, x, z) => {
  const { res, size } = WORLD;
  const fx = Math.min(res - 1.001, Math.max(0, (x / size + 0.5) * res - 0.5));
  const fz = Math.min(res - 1.001, Math.max(0, (z / size + 0.5) * res - 0.5));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, i = iz * res + ix;
  return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - tz) + (h[i + res] * (1 - tx) + h[i + res + 1] * tx) * tz;
};

export function planStream(heights, trail) {
  const L = WORLD.lake, wl = WORLD.waterLevel;
  const a0 = Math.atan2(L.z - trail.shore.z, L.x - trail.shore.x);
  const rnd = mulberry32(2718);
  let best = null;
  for (let k = 0; k < 2500; k++) {
    const a = a0 + (rnd() - 0.5) * 1.1;
    const r = 2.0 + rnd() * 4.0;
    const x = L.x + Math.cos(a) * L.rx * r, z = L.z + Math.sin(a) * L.rz * r;
    if (Math.max(Math.abs(x), Math.abs(z)) > 1900) continue;
    const h = sample(heights, x, z);
    if (h < wl + 220 || h > wl + 900) continue;
    let drop = 0;
    for (let d = 0; d < 8; d++) { const ang = d / 8 * Math.PI * 2; drop = Math.max(drop, h - sample(heights, x + Math.cos(ang) * 40, z + Math.sin(ang) * 40)); }
    const score = drop * 2 + (h - wl) * 0.25 - Math.hypot(x - L.x, z - L.z) * 0.12;
    if (!best || score > best.score) best = { x, z, score };
  }
  if (!best) return null;
  const G = 340, size = WORLD.size, cell = size / G;
  const toC = (v) => Math.min(G - 1, Math.max(0, Math.floor((v / size + 0.5) * G)));
  const toW = (c) => (c + 0.5) / G * size - size / 2;
  const hgrid = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) hgrid[j * G + i] = sample(heights, toW(i), toW(j));
  const dist = new Float32Array(G * G).fill(Infinity), prev = new Int32Array(G * G).fill(-1), done = new Uint8Array(G * G);
  const start = toC(best.z) * G + toC(best.x);
  dist[start] = 0;
  const heapK = [0], heapV = [start];
  const push = (k, v) => { let i = heapK.length; heapK.push(k); heapV.push(v); while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= k) break; heapK[i] = heapK[p]; heapV[i] = heapV[p]; i = p; } heapK[i] = k; heapV[i] = v; };
  const pop = () => { const top = heapV[0]; const lk = heapK.pop(), lv = heapV.pop(); const n = heapK.length; if (n) { let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i, mk = lk; if (l < n && heapK[l] < mk) { m = l; mk = heapK[l]; } if (r < n && heapK[r] < mk) { m = r; mk = heapK[r]; } if (m === i) break; heapK[i] = heapK[m]; heapV[i] = heapV[m]; i = m; } heapK[i] = lk; heapV[i] = lv; } return top; };
  let goal = -1;
  while (heapK.length) {
    const c = pop();
    if (done[c]) continue; done[c] = 1;
    if (hgrid[c] < wl - 0.8) { goal = c; break; }
    const cx = c % G, cz = (c / G) | 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= G || nz >= G) continue;
      const nc = nz * G + nx;
      const len = Math.hypot(dx, dz) * cell;
      const up = Math.max(0, hgrid[nc] - hgrid[c]);
      const cost = len * (1 + up * 2.5) + up * up * 6;
      if (dist[c] + cost < dist[nc]) { dist[nc] = dist[c] + cost; prev[nc] = c; push(dist[nc], nc); }
    }
  }
  if (goal < 0) return null;
  let cpts = [];
  for (let c = goal; c >= 0; c = prev[c]) cpts.push([toW(c % G), toW((c / G) | 0)]);
  cpts.reverse();
  for (let it = 0; it < 3; it++) {
    const o = [cpts[0]];
    for (let i = 0; i < cpts.length - 1; i++) { const p = cpts[i], q = cpts[i + 1]; o.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25], [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]); }
    o.push(cpts[cpts.length - 1]); cpts = o;
  }
  const pts = [cpts[0]];
  for (let i = 1; i < cpts.length; i++) {
    const l = pts[pts.length - 1];
    const d = Math.hypot(cpts[i][0] - l[0], cpts[i][1] - l[1]);
    if (d >= 2) { const k = Math.floor(d / 2); for (let s = 1; s <= k; s++) pts.push([l[0] + (cpts[i][0] - l[0]) * s / k, l[1] + (cpts[i][1] - l[1]) * s / k]); }
  }
  return { points: pts };
}

/** Carve the waterfall escarpment, visible plunge pool basin, and stream pebble bed. */
export function carveStream(heights, mask, stream) {
  const { res, size } = WORLD;
  const texel = size / res;
  const n = stream.points.length;
  // --- sculpt a dramatic jagged amphitheatre cliff shelf: brink sits ~68% down the stream
  {
    const pts = stream.points;
    const k = Math.floor(n * 0.68), L0 = 60, H = 42;
    stream.brink = k;
    const t0 = Math.max(0, k - L0);
    const R = 95, rt = Math.ceil(R / texel) + 1;
    const raise = new Float32Array(res * res);
    for (let i = t0; i <= k; i++) {
      const along = (i - t0) / (k - t0);
      const amt = H * (along * along * (3 - 2 * along));
      const [px, pz] = pts[i];
      const cx = Math.round((px / size + 0.5) * res - 0.5), cz = Math.round((pz / size + 0.5) * res - 0.5);
      const j = Math.min(n - 1, i + 2);
      const fx = pts[j][0] - px, fz = pts[j][1] - pz, fl = Math.hypot(fx, fz) || 1;
      for (let dz = -rt; dz <= rt; dz++) for (let dx = -rt; dx <= rt; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= res || iz >= res) continue;
        const wx = (ix + 0.5) / res * size - size / 2, wz = (iz + 0.5) / res * size - size / 2;
        const d = Math.hypot(wx - px, wz - pz);
        if (d > R) continue;
        const [bx, bz] = pts[k];
        const ahead = ((wx - bx) * fx + (wz - bz) * fz) / fl;
        const lateral = ((wx - bx) * -fz + (wz - bz) * fx) / fl, la = Math.abs(lateral);
        // deeply recessed rocky waterfall chute flanked by stepped granite buttresses (waterfall sits CUT INTO the cliff!)
        const notch = Math.exp(-(lateral * lateral) / (2 * 13 * 13)) * -5.2;
        const jag = (0.55 * Math.sin(lateral * 0.23 + 0.7) + 0.3 * Math.sin(lateral * 0.61 + 1.7) + 0.15 * Math.sin(lateral * 1.37)) * Math.min(1, la / 10) * 8.2 + notch;
        const faceW = 4.4 + Math.max(0, la - 16) * 1.15;
        const cliffRaw = 1 - Math.min(1, Math.max(0, (ahead + 1.5 - jag + faceW * 0.5 - 1.5) / faceW));
        // 3 physical rock terrace steps carved directly into the escarpment profile!
        const cliff = Math.min(1, Math.max(0, cliffRaw + 0.075 * Math.sin(cliffRaw * Math.PI * 6.0) * cliffRaw * (1 - cliffRaw) * 4.0));
        const lat = 1 - Math.min(1, Math.max(0, (d - 34) / (R - 34)));
        const v = amt * lat * lat * (3 - 2 * lat) * cliff;
        const idx = iz * res + ix;
        if (v > raise[idx]) raise[idx] = v;
      }
    }
    for (let i = 0; i < res * res; i++) heights[i] += raise[i];

    // carve a wide, deep, unobstructed plunge-pool basin downstream of the brink
    // so the reflective sapphire-turquoise pool & whitewater foam ring sit wide open to the camera!
    const [bx, bz] = pts[k];
    const j2 = Math.min(n - 1, k + 4);
    const ux0 = pts[j2][0] - bx, uz0 = pts[j2][1] - bz, ul = Math.hypot(ux0, uz0) || 1;
    const ux = ux0 / ul, uz = uz0 / ul;
    const px = bx + ux * 15.0, pz = bz + uz * 15.0;
    const baseH = sample(heights, bx + ux * 18, bz + uz * 18);
    const pr = 22.0, prt = Math.ceil(pr / texel) + 1;
    const pcx = Math.round((px / size + 0.5) * res - 0.5), pcz = Math.round((pz / size + 0.5) * res - 0.5);
    for (let dz = -prt; dz <= prt; dz++) for (let dx = -prt; dx <= prt; dx++) {
      const ix = pcx + dx, iz = pcz + dz;
      if (ix < 0 || iz < 0 || ix >= res || iz >= res) continue;
      const wx = (ix + 0.5) / res * size - size / 2, wz = (iz + 0.5) / res * size - size / 2;
      const ahead = (wx - bx) * ux + (wz - bz) * uz;
      if (ahead < 0.8) continue;
      const dd = Math.hypot(wx - px, wz - pz);
      if (dd > pr) continue;
      const t = 1 - dd / pr;
      const w = t * t * (3 - 2 * t) * Math.min(1, (ahead - 0.8) / 3.5);
      const idx = iz * res + ix;
      const targetH = baseH - 3.6 * Math.min(1, t * 1.45);
      heights[idx] = Math.min(heights[idx], heights[idx] * (1 - w) + targetH * w);
    }
    // carve a smooth river channel trough downstream of the falls so ZERO terrain polygons ever poke through the stream water!
    for (let i = k + 3; i < n - 1; i++) {
      const [sx0, sz0] = pts[i];
      const chW = 3.8 + 1.8 * (i / n);
      const crt = Math.ceil((chW + 2) / texel);
      const scx = Math.round((sx0 / size + 0.5) * res - 0.5), scz = Math.round((sz0 / size + 0.5) * res - 0.5);
      const centerH = sample(heights, sx0, sz0);
      for (let dz = -crt; dz <= crt; dz++) for (let dx = -crt; dx <= crt; dx++) {
        const ix = scx + dx, iz = scz + dz;
        if (ix < 0 || iz < 0 || ix >= res || iz >= res) continue;
        const wx = (ix + 0.5) / res * size - size / 2, wz = (iz + 0.5) / res * size - size / 2;
        const dd = Math.hypot(wx - sx0, wz - sz0);
        if (dd > chW) continue;
        const t = 1 - dd / chW;
        const idx = iz * res + ix;
        const goalH = Math.min(heights[idx], centerH - 1.05 * t * t);
        heights[idx] = heights[idx] * (1 - t * t) + goalH * (t * t);
      }
    }
  }
  const hs = stream.points.map((p) => sample(heights, p[0], p[1]));
  for (let i = 1; i < n; i++) hs[i] = Math.min(hs[i], hs[i - 1]);
  stream.heights = hs;
  for (let i = 0; i < n; i++) {
    const [px, pz] = stream.points[i];
    const w = 2.3 + 1.9 * (i / n);
    const R = w + 1.8;
    const cx = Math.round((px / size + 0.5) * res - 0.5), cz = Math.round((pz / size + 0.5) * res - 0.5);
    const rt = Math.ceil(R / texel);
    for (let dz = -rt; dz <= rt; dz++) for (let dx = -rt; dx <= rt; dx++) {
      const ix = cx + dx, iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= res || iz >= res) continue;
      const wx = (ix + 0.5) / res * size - size / 2, wz = (iz + 0.5) / res * size - size / 2;
      const d = Math.hypot(wx - px, wz - pz);
      if (d > R) continue;
      const j = iz * res + ix;
      if (mask[j] < 0.3) mask[j] = Math.min(mask[j], -Math.min(1, (1 - d / (w + 1.3)) * 1.45));
    }
  }
}

const VERT = /* glsl */ `
attribute vec2 aFlow; // x: across [-1,1], y: distance along (m)
attribute float aSteep;
varying vec2 vFlow; varying float vSteep; varying vec3 vWPos;
void main(){
  vFlow = aFlow; vSteep = aSteep;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
${COMMON}
varying vec2 vFlow; varying float vSteep; varying vec3 vWPos;
void main(){
  float distCam = length(vWPos - cameraPosition);
  float speed = 1.4 + vSteep * 5.2;
  // dual-octave flow-mapped ripples warped slightly outward around boulders/banks
  float across = abs(vFlow.x);
  vec2 base = vec2(vFlow.x * 0.48, vFlow.y * 0.055);
  vec2 warp = (texture(uNoiseTex, base * 0.7 - vec2(0.0, uTime * speed * 0.03)).rg - 0.5) * 0.14;
  float n1 = texture(uNoiseTex, base + warp - vec2(0.0, uTime * speed * 0.06)).b;
  float n2 = texture(uNoiseTex, base * vec2(2.4, 2.8) - warp - vec2(0.0, uTime * speed * 0.11) + 0.37).g;
  float n3 = texture(uNoiseTex, base * vec2(5.2, 4.4) - vec2(0.0, uTime * speed * 0.17) + 0.71).a;

  // organic cellular foam lace & gentle concentric water ripples (ZERO horizontal white zebra stripe bands in falls.png!)
  float rapid = clamp(vSteep * 1.8 - 0.18, 0.0, 1.0);
  float streakFoam = smoothstep(0.72, 0.90, n1 * 0.50 + n2 * 0.50) * (0.14 + 0.68 * rapid);
  float eddy = smoothstep(0.76, 0.92, n3 * 0.62 + n2 * 0.38) * smoothstep(0.24, 0.88, across) * 0.28;
  float bankFoam = smoothstep(0.84, 0.97, across + (n2 - 0.5) * 0.14) * smoothstep(0.45, 0.78, n1 * 0.5 + n3 * 0.5) * 0.48;
  float wfRings = 0.0;
  float wfRippleGrad = 0.0;
  float wfd = 999.0;
  if (uWaterfall.w > 0.1) {
    wfd = length(vWPos.xz - uWaterfall.xz);
    float ringPhase = wfd * 1.55 - uTime * 3.6 + (n1 - 0.5) * 3.8 + (n2 - 0.5) * 1.8;
    wfRippleGrad = cos(ringPhase) * (1.0 - smoothstep(10.0, 42.0, wfd)) * 0.65;
    float lace = smoothstep(0.42, 0.82, n2 * 0.52 + n3 * 0.48);
    // delicate broken lacy froth drifting down from plunge boil (NEVER hard horizontal white bars!)
    float softRipple = smoothstep(0.76, 0.96, sin(ringPhase) * 0.5 + 0.5) * lace * (1.0 - smoothstep(12.0, 28.0, wfd)) * 0.36;
    float boilTrail = smoothstep(0.60, 0.84, n1 * 0.45 + n2 * 0.35 + n3 * 0.20) * (1.0 - smoothstep(8.0, 22.0, wfd)) * 0.52;
    wfRings = max(softRipple, boilTrail);
  }
  // keep steep cascade whitewater BRIGHT & sparkling STRICTLY at distance (lake/pasture), while foreground stream in falls.png stays crystal sapphire-turquoise with delicate foam lace!
  float distWhite = smoothstep(0.10, 0.30, vSteep) * smoothstep(140.0, 380.0, distCam) * 0.88;
  float foam = clamp(max(max(max(streakFoam, eddy), bankFoam), max(wfRings, distWhite)), 0.0, 0.96);
  foam *= mix(1.0 - 0.38 * smoothstep(120.0, 420.0, distCam), 1.0, smoothstep(0.10, 0.28, vSteep));

  // Stillwater-Lake-quality jewel alpine sapphire center -> luminous crystal turquoise shallow banks (ZERO dark asphalt!)
  vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
  float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
  float centerDepth = 1.0 - smoothstep(0.08, 0.84, across);
  vec3 shallowCol = vec3(0.060, 0.56, 0.58);
  vec3 deepCol    = vec3(0.025, 0.24, 0.48);
  vec3 bodyCol    = mix(shallowCol, deepCol, centerDepth) * (amb * 1.32 + uLightColor * 0.24 * sunUp);
  vec3 whiteCol   = (amb * 1.15 + uLightColor * 0.60 * sunUp) * 1.14;

  // calm readable alpine river & plunge-pool outflow with delicate concentric foam rings & soft sky sheen (ZERO zebra-striped reflection bands!)
  vec3 Vv = normalize(cameraPosition - vWPos);
  vec2 radDir = uWaterfall.w > 0.1 ? normalize(vWPos.xz - uWaterfall.xz + 1e-4) : vec2(0.0, 1.0);
  vec3 Nn = normalize(vec3(radDir.x * wfRippleGrad * 0.07 + (n1 - 0.5) * 0.07 + (n2 - 0.5) * 0.05, 1.0, radDir.y * wfRippleGrad * 0.07 + (n2 - 0.5) * 0.07 - (n3 - 0.5) * 0.05));
  float fres = 0.12 + 0.88 * pow(1.0 - max(dot(Vv, Nn), 0.0), 3.8);
  vec3 Rr = reflect(-Vv, Nn);
  vec3 skyR = w_sky(normalize(vec3(Rr.x, max(Rr.y, 0.28), Rr.z)));
  float lsk = dot(skyR, vec3(0.2126, 0.7152, 0.0722));
  skyR = max(mix(vec3(lsk), skyR, 1.36), 0.0);
  vec3 reflCol = mix(shallowCol * (amb * 0.95 + 0.08), skyR * 0.86, smoothstep(0.0, 0.35, Rr.y + 0.10));

  vec3 col = mix(bodyCol, reflCol, fres * (1.0 - foam * 0.85) * 0.36);
  col = mix(col, whiteCol * (0.94 + 0.10 * n2), foam * 0.94);
  // delicate sparkling sun glints across the current
  vec3 H = normalize(uLightDir + Vv);
  float spec = min(pow(max(dot(Nn, H), 0.0), 140.0) * 10.0 + pow(max(dot(Nn, H), 0.0), 32.0) * 0.65, 4.2) * sunUp * (1.0 - foam * 0.55);
  col += uLightColor * spec;

  // visible sparkling river ribbon from the summit (summit.png landmark!)
  vec3 farRiver = mix(vec3(0.10, 0.34, 0.48), skyR * 0.92, 0.52) * (0.65 + 0.35 * sunUp);
  col = mix(col, farRiver, smoothstep(180.0, 520.0, distCam) * 0.72);

  // translucent crystal shallows let wet river cobbles peek through along banks!
  float edge = 1.0 - smoothstep(0.66, 1.0, across + (n2 - 0.5) * 0.20);
  float a = edge * mix(mix(0.42, 0.84, centerDepth), 0.96, foam);
  // hide steep vertical ribbon where waterfall takes over, AND seamlessly hand off inside the circular plunge pool (ZERO y=790 seam!)
  a *= 1.0 - smoothstep(0.52, 0.78, vSteep);
  if (uWaterfall.w > 0.1) a *= smoothstep(11.0, 21.0, wfd);
  col = w_applyAtmosphere(col, vWPos);
  gl_FragColor = vec4(col, a);
}`;

export class Stream {
  constructor(hf, stream) {
    this.stream = stream;
    this.hf = hf;
    const pts = stream.points;
    const n = pts.length;
    const pos = [], flow = [], steep = [], idx = [];
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const [x, z] = pts[i];
      const j = Math.min(n - 1, i + 1), k = Math.max(0, i - 1);
      const tx = pts[j][0] - pts[k][0], tz = pts[j][1] - pts[k][1], tl = Math.hypot(tx, tz) || 1;
      const sx = -tz / tl, sz = tx / tl;
      if (i > 0) dist += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      const hA0 = hf.height(pts[k][0], pts[k][1]), hB0 = hf.height(pts[j][0], pts[j][1]);
      const g0 = Math.max(0, (hA0 - hB0) / (Math.hypot(pts[j][0] - pts[k][0], pts[j][1] - pts[k][1]) || 1));
      const w = (2.1 + 1.9 * (i / n) + Math.min(4.8, g0 * 6.0)) * (0.78 + 0.45 * (Math.sin(i * 0.11) * 0.5 + 0.5) * (Math.sin(i * 0.037 + 1.3) * 0.5 + 0.5));
      const grade = g0;
      const hc = hf.height(x, z);
      // compute flat level water surface across entire cross-section (kills straight center-ridge seam in falls.png!)
      let yFlat = hc + 0.42;
      for (const s of [-0.6, 0, 0.6]) yFlat = Math.max(yFlat, hf.height(x + sx * w * s, z + sz * w * s) + 0.36);
      yFlat = Math.max(yFlat, WORLD.waterLevel + 0.02);
      for (const s of [-1, -0.5, 0, 0.5, 1]) {
        const px = x + sx * w * s, pz = z + sz * w * s;
        pos.push(px, yFlat, pz);
        flow.push(s, dist);
        steep.push(Math.min(1, grade * 1.6));
      }
      if (i < n - 1) {
        const b = i * 5;
        for (let c = 0; c < 4; c++) idx.push(b + c, b + 5 + c, b + c + 1, b + c + 1, b + 5 + c, b + 6 + c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
    g.setAttribute('aSteep', new THREE.Float32BufferAttribute(steep, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.material = new THREE.ShaderMaterial({ uniforms: { ...U }, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.renderOrder = 8;

    // fine luminous splash spray on rapids
    const spray = [];
    for (let i = 2; i < n - 2; i += 2) if (steep[i * 5] > 0.55 || i > n - 6) spray.push(pts[i][0], hf.height(pts[i][0], pts[i][1]) + 0.4, pts[i][1]);
    const sg = new THREE.BufferGeometry();
    const cnt = Math.min(spray.length / 3, 120) * 5;
    const sp = new Float32Array(cnt * 3), seed = new Float32Array(cnt);
    for (let i = 0; i < cnt; i++) { const k = (i % (spray.length / 3)) * 3; sp[i * 3] = spray[k]; sp[i * 3 + 1] = spray[k + 1]; sp[i * 3 + 2] = spray[k + 2]; seed[i] = Math.random(); }
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
    this.sprayMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uPix: { value: 900 }, uLightColor: U.uLightColor },
      vertexShader: `attribute float aSeed; uniform float uTime; uniform float uPix; varying float vA;
        void main(){ float t = fract(aSeed * 7.3 + uTime * (0.4 + aSeed * 0.3));
          vec3 p = position + vec3(sin(aSeed * 50.0) * 1.4 * t, t * 2.0, cos(aSeed * 31.0) * 1.4 * t);
          vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = uPix * (0.9 + t * 2.0) / -mv.z; vA = (1.0 - t) * 0.14; }`,
      fragmentShader: `uniform vec3 uLightColor; varying float vA; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; float a = (1.0 - r) * (1.0 - r) * vA; vec3 c = vec3(0.95, 0.98, 1.0) * (0.65 + 0.12 * max(max(uLightColor.r, uLightColor.g), uLightColor.b)); gl_FragColor = vec4(c * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.spray = new THREE.Points(sg, this.sprayMat);
    this.spray.frustumCulled = false;
    this.spray.layers.set(LAYER_NO_REFLECT);
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.spray);
  }

  buildBridge(trail, material) {
    const sp = this.stream.points, tp = trail.points;
    let best = null, bd = 1e9;
    for (let i = 0; i < sp.length; i += 2) for (let j = 0; j < tp.length; j += 2) {
      const d = Math.hypot(sp[i][0] - tp[j][0], sp[i][1] - tp[j][1]);
      if (d < bd) { bd = d; best = [i, j]; }
    }
    if (!best || bd > 6) return null;
    const [, tj] = best;
    const [cx, cz] = tp[tj];
    const a = tp[Math.min(tp.length - 1, tj + 3)], b = tp[Math.max(0, tj - 3)];
    const dx = a[0] - b[0], dz = a[1] - b[1], l = Math.hypot(dx, dz) || 1;
    const ux = dx / l, uz = dz / l, ry = Math.atan2(ux, uz);
    const len = 9, w = 1.7;
    const yA = this.hf.height(cx - ux * len / 2, cz - uz * len / 2), yB = this.hf.height(cx + ux * len / 2, cz + uz * len / 2);
    const yMid = Math.max(yA, yB, this.hf.height(cx, cz) + 0.9) + 0.25;
    const parts = [];
    const col = (g, c) => { const n = g.attributes.position.count, arr = new Float32Array(n * 3); for (let k = 0; k < n; k++) arr.set(c, k * 3); g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); if (g.attributes.uv) g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; };
    const planks = 14;
    for (let k = 0; k < planks; k++) {
      const t = (k + 0.5) / planks - 0.5;
      const arch = Math.cos(t * Math.PI) * 0.45;
      const y = yA + (yB - yA) * (t + 0.5);
      const g = new THREE.BoxGeometry(w, 0.1, len / planks * 0.92);
      g.translate(0, Math.max(y, yMid - 0.45) + arch * 0.6, t * len);
      parts.push(col(g, [0.5 + (k % 3) * 0.04, 0.34, 0.2]));
    }
    for (const s of [-1, 1]) {
      for (let k = 0; k <= 4; k++) {
        const t = k / 4 - 0.5;
        const y = Math.max(yA + (yB - yA) * (t + 0.5), yMid - 0.45) + Math.cos(t * Math.PI) * 0.27;
        const post = new THREE.BoxGeometry(0.12, 1.0, 0.12);
        post.translate(s * w / 2, y + 0.5, t * len);
        parts.push(col(post, [0.36, 0.24, 0.14]));
      }
      const rail = new THREE.CylinderGeometry(0.05, 0.05, len, 6);
      rail.rotateX(Math.PI / 2);
      rail.translate(s * w / 2, yMid + 0.55, 0);
      parts.push(col(rail, [0.42, 0.28, 0.16]));
    }
    for (const p of parts) if (!p.attributes.normal) p.computeVertexNormals();
    const m = new THREE.Mesh(mergeGeometries(parts), material);
    m.position.set(cx, 0, cz);
    m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    this.bridge = { x: cx, z: cz, y: yMid };
    this.bridgeMesh = m;
    return m;
  }

  distanceTo(p) {
    let bd = 1e9;
    const pts = this.stream.points;
    for (let i = 0; i < pts.length; i += 4) bd = Math.min(bd, Math.hypot(pts[i][0] - p.x, pts[i][1] - p.z));
    return bd;
  }

  dispose() {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.spray.geometry.dispose();
    this.sprayMat.dispose();
    if (this.bridgeMesh) {
      this.bridgeMesh.removeFromParent();
      this.bridgeMesh.geometry.dispose();
      this.bridgeMesh = null;
    }
  }
}

export function createStream(ctx) {
  const { hf, streamPlan } = ctx.data;
  if (!streamPlan) return null;
  const stream = new Stream(hf, streamPlan);
  ctx.scene.add(stream.group);
  return {
    instance: stream,
    update(frame) { stream.sprayMat.uniforms.uPix.value = frame.pix; },
    dispose() { stream.dispose(); },
  };
}
