import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';

// Quadtree-LOD terrain rendered as a single instanced grid patch with CDLOD-style
// vertex morphing and skirts. Heights and normals come from the shared heightmaps.

const N = 32; // grid segments per patch
const ROOT = 32768;
const MIN_SIZE = 64;
const LOD_K = 2.2;
const MAX_NODES = 1400;

function buildPatchGeometry() {
  const pos = [];
  const skirt = [];
  const idx = [];
  const V = N + 1;
  for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) { pos.push(x / N, 0, z / N); skirt.push(0); }
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const a = z * V + x, b = a + 1, c = a + V, d = c + 1;
    // alternate diagonals for nicer shading
    if ((x + z) % 2 === 0) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  // skirts: duplicate border vertices dropped downward
  const border = [];
  for (let x = 0; x < N; x++) border.push([x, 0]);
  for (let z = 0; z < N; z++) border.push([N, z]);
  for (let x = N; x > 0; x--) border.push([x, N]);
  for (let z = N; z > 0; z--) border.push([0, z]);
  border.push(border[0]);
  let base = pos.length / 3;
  for (let i = 0; i < border.length; i++) {
    const [x, z] = border[i];
    pos.push(x / N, 0, z / N); skirt.push(1);
  }
  for (let i = 0; i < border.length - 1; i++) {
    const [x0, z0] = border[i], [x1, z1] = border[i + 1];
    const a = z0 * V + x0, b = z1 * V + x1, c = base + i, d = base + i + 1;
    idx.push(a, b, c, b, d, c);
    idx.push(a, c, b, b, c, d); // both windings so skirts are visible from either side
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
  g.setIndex(idx);
  return g;
}

export class Terrain {
  constructor() {
    this.geometry = buildPatchGeometry();
    this.nodeArr = new Float32Array(MAX_NODES * 4);
    this.nodeAttr = new THREE.InstancedBufferAttribute(this.nodeArr, 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aNode', this.nodeAttr);
    this.geometry.instanceCount = 0;
    this.uniforms = {
      uLodK: { value: LOD_K },
      uCamDY: { value: 0 },
      uCamXZ: { value: new THREE.Vector2() },
      uSkirt: { value: 1 },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    patchMaterial(mat, {
      toonWrap: 0.12, toonLo: 0.26, toonHi: 0.36,
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        attribute vec4 aNode;
        attribute float aSkirt;
        uniform float uLodK;
        uniform float uCamDY;
        uniform vec2 uCamXZ;
        uniform float uSkirt;
        varying float vDist;
      `,
      vertex: [
        ['#include <begin_vertex>', /* glsl */ `
          float size = aNode.z;
          vec2 grid = floor(position.xz * ${N.toFixed(1)} + 0.5);
          vec2 xz = aNode.xy + position.xz * size;
          float h0 = w_height(xz);
          float d = length(vec2(length(xz - uCamXZ), uCamDY));
          float morph = clamp((d / (uLodK * size) - 1.55) / 0.35, 0.0, 1.0);
          if (size >= 16384.0) morph = 0.0;
          vec2 frac = fract(grid * 0.5) * 2.0;
          xz -= frac * (size / ${N.toFixed(1)}) * morph;
          float h = w_height(xz);
          h -= aSkirt * (2.0 + size * 0.015) * uSkirt;
          vec3 transformed = vec3(xz.x, h, xz.y);
          vDist = d;
        `],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: /* glsl */ `
        varying float vDist;
        vec3 t_albedo; float t_rough; vec3 t_normal; float t_wet; float t_glow = 0.0; float t_snowFar = 0.0; float t_glowWarm = 0.0;
        float t_noise(vec2 p){ return texture(uNoiseTex, p).r; }
        void terrainSurface(vec3 wp, float dist){
          vec2 xz = wp.xz;
          float e = max(1.0, dist * 0.0025);
          float fb = w_nearBlend(xz);
          e = mix(e, max(e, 18.0), fb);
          vec3 n = w_normal(xz, e);
          // multi-scale, rotated lookups to hide tiling
          const mat2 R1 = mat2(0.8, -0.6, 0.6, 0.8);
          const mat2 R2 = mat2(0.28, 0.96, -0.96, 0.28);
          vec4 nH = texture(uNoiseTex, R2 * xz * 0.00031 + 0.21);
          vec4 nz = texture(uNoiseTex, R1 * xz * 0.0019);
          float fadeM = 1.0 - smoothstep(600.0, 2500.0, dist);
          float fadeD = 1.0 - smoothstep(80.0, 450.0, dist);
          float fadeF = 1.0 - smoothstep(15.0, 90.0, dist);
          vec4 nm = mix(vec4(0.5), texture(uNoiseTex, xz * 0.013), fadeM);
          vec4 nd = mix(vec4(0.5), texture(uNoiseTex, R2 * xz * 0.11), fadeD);
          vec4 nf = mix(vec4(0.5), texture(uNoiseTex, xz * 0.63), fadeF);
          float slopeFine = 1.0 - n.y;
          vec3 t_normalPre = n;
          float broadE = mix(e, max(e * 4.0, 30.0), smoothstep(500.0, 2500.0, dist));
          float slope = mix(slopeFine, 1.0 - w_normal(xz, broadE).y, smoothstep(500.0, 2500.0, dist));
          float h = wp.y;
          vec4 bio = w_biome(xz);
          float trailRaw = w_trailRaw(xz);
          float trail = max(trailRaw, 0.0);
          float bed = max(-trailRaw, 0.0);
          // anisotropic noise running down the fall line: gullies, couloirs, streaks
          vec2 fall = normalize(n.xz + 1e-4);
          vec2 across = vec2(-fall.y, fall.x);
          vec2 gp = vec2(dot(xz, across) * 0.02, dot(xz, fall) * 0.0025);
          float gully = texture(uNoiseTex, gp).g * 0.6 + texture(uNoiseTex, gp * 3.1 + 0.4).b * 0.4;
          // --- palettes (linear albedo) ---
          vec3 forestF= vec3(0.05, 0.17, 0.05);
          vec3 rockA  = vec3(0.40, 0.38, 0.42);
          vec3 rockB  = vec3(0.70, 0.63, 0.55);
          vec3 rockW_ = vec3(0.72, 0.56, 0.42);
          vec3 dirt   = vec3(0.66, 0.47, 0.28);
          vec3 sand   = vec3(0.80, 0.70, 0.50);
          vec3 snow   = vec3(1.0, 1.0, 1.0);
          vec3 mud    = vec3(0.30, 0.34, 0.22);

          vec3 grass = w_grassColor(xz, h) * (0.92 + 0.12 * nd.b);
          {
            float tuftK = smoothstep(25.0, 60.0, dist) * (1.0 - smoothstep(600.0, 1500.0, dist));
            vec4 tf = texture(uNoiseTex, xz * 0.21 + 0.77);
            grass *= mix(1.0, 0.72 + 0.45 * smoothstep(0.3, 0.75, tf.a), tuftK);
            grass = mix(grass, grass * vec3(1.12, 1.08, 0.8), smoothstep(0.6, 0.8, texture(uNoiseTex, xz * 0.05 + 0.13).b) * tuftK * 0.6);
            // distant wildflower specks so far meadows keep their colour
            float flK = smoothstep(30.0, 60.0, dist) * (1.0 - smoothstep(500.0, 1200.0, dist)) * smoothstep(0.15, 0.5, bio.g + bio.b * 0.25);
            vec4 fs1 = texture(uNoiseTex, xz * 0.9 + 0.41);
            float speck = smoothstep(0.7, 0.76, fs1.a);
            vec3 fcol = fs1.r < 0.45 ? vec3(0.95, 0.75, 0.2) : fs1.r < 0.55 ? vec3(0.9, 0.55, 0.75) : vec3(0.92, 0.92, 0.88);
            grass = mix(grass, fcol, speck * flK * 0.8);
          }
          vec3 col = grass;
          float forest = smoothstep(0.12, 0.55, bio.r);
          // beyond the walkable map, paint forest bands on the lower mountain slopes
          float farF = fb * smoothstep(1050.0, 900.0, h + (nH.g - 0.5) * 120.0) * smoothstep(0.42, 0.25, slope) * smoothstep(250.0, 450.0, h);
          forest = max(forest * (1.0 - fb), farF);
          // canopy texture: blobby crowns
          float crowns = texture(uNoiseTex, xz * 0.045).a * 0.6 + texture(uNoiseTex, xz * 0.011).a * 0.4;
          vec3 forestHue = mix(forestF, vec3(0.1, 0.26, 0.06), smoothstep(0.35, 0.75, nH.r)) ;
          forestHue = mix(forestHue, vec3(0.03, 0.14, 0.09), smoothstep(0.55, 0.8, nz.b) * 0.7);
          // near: dark floor under trees; far: the canopy itself, sunlit tops & shaded gaps
          vec3 canopy = mix(vec3(0.07, 0.24, 0.08), vec3(0.12, 0.33, 0.09), smoothstep(0.35, 0.75, nH.r));
          canopy *= 0.6 + 0.6 * smoothstep(0.3, 0.75, crowns);
          vec3 fCol = mix(forestHue * (0.6 + 0.8 * crowns), canopy, smoothstep(250.0, 900.0, dist));
          col = mix(col, fCol, forest);
          col *= mix(1.0, 0.9, smoothstep(0.4, 0.85, bio.r) * (1.0 - fb));
          {
            float ff = smoothstep(0.45, 0.8, bio.r) * fadeD;
            vec4 lf = texture(uNoiseTex, xz * 0.37 + 0.13);
            col = mix(col, vec3(0.34, 0.22, 0.1) * (0.8 + 0.4 * nf.r), smoothstep(0.58, 0.7, lf.a) * ff * 0.7);
            col = mix(col, vec3(0.16, 0.34, 0.08), smoothstep(0.6, 0.75, lf.g) * ff * 0.6);
          }
          // rock with strata & warm/cold variation
          float strata = smoothstep(0.3, 0.7, sin(h * 0.05 + nz.g * 3.0 + gully * 3.0) * 0.5 + 0.5);
          vec3 rock = mix(rockA, rockB, strata * 0.12 + gully * 0.6 + nH.b * 0.2);
          rock = mix(rock, rockW_, smoothstep(0.55, 0.8, nH.g) * 0.5 * (1.0 - smoothstep(600.0, 2000.0, dist)));
          // far: one coherent warm stone colour, value from height
          rock = mix(rock, mix(vec3(0.46, 0.46, 0.47), vec3(0.62, 0.62, 0.63), smoothstep(900.0, 2200.0, h)), smoothstep(800.0, 2600.0, dist));
          rock *= 0.9 + 0.15 * nf.g;
          // vertical cliff faces: sample along the face so texture never stretches
          {
            float cliffW = smoothstep(0.4, 0.65, slopeFine);
            vec3 tw = pow(abs(t_normalPre), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
            #define TRI(S, O) (texture(uNoiseTex, vec2(wp.z, wp.y) * (S) + (O)) * tw.x + texture(uNoiseTex, vec2(wp.x, wp.z) * (S) + (O)) * tw.y + texture(uNoiseTex, vec2(wp.x, wp.y) * (S) + (O)) * tw.z)
            vec2 vp = vec2(dot(xz, across), h);
            vec4 vn = TRI(0.07, 0.0);
            vec4 vf = TRI(0.3, 0.3);
            // columns: stretched vertically along the face
            vec2 hx = vec2(wp.z, wp.x);
            float horiz = tw.x / max(tw.x + tw.z, 1e-3);
            float hc = mix(wp.x, wp.z, horiz);
            float col1 = texture(uNoiseTex, vec2(hc * 0.11, wp.y * 0.008) + 0.13).g;
            float col2 = texture(uNoiseTex, vec2(hc * 0.17, wp.y * 0.011) + 0.57).b;
            float colF = smoothstep(0.38, 0.62, col1 * 0.7 + col2 * 0.45);
            vec3 cliffC = mix(vec3(0.3, 0.29, 0.32), vec3(0.58, 0.54, 0.5), colF);
            // dark vertical cracks between columns
            cliffC *= mix(0.55, 1.0, smoothstep(0.04, 0.12, abs(col2 - 0.5)));
            // horizontal ledges catching light + moss on top
            float brk = texture(uNoiseTex, vec2(hc * 0.025, h * 0.02) + 0.21).r;
            float lp = h * 0.085 + col1 * 2.2 + hc * 0.012 + brk * 1.5;
            float ledge = smoothstep(0.88, 0.97, fract(lp)) * smoothstep(0.42, 0.58, brk);
            cliffC = mix(cliffC, vec3(0.2, 0.38, 0.1), ledge * 0.75);
            cliffC *= mix(1.0, 0.8, smoothstep(0.0, 0.1, fract(lp)) * (1.0 - smoothstep(0.1, 0.25, fract(lp))) * smoothstep(0.42, 0.58, brk));
            // moss streaks running down the cliff
            float mossS = smoothstep(0.55, 0.75, texture(uNoiseTex, vp * vec2(0.18, 0.02) + 0.6).g);
            cliffC = mix(cliffC, vec3(0.14, 0.32, 0.08), mossS * 0.55);
            rock = mix(rock, cliffC, cliffW);
          }
          // painted crevices running down the fall line
          rock *= mix(0.62, 1.08, smoothstep(0.3, 0.62, gully));
          float altR = smoothstep(1000.0, 1500.0, h + (nH.g - 0.5) * 300.0);
          float noiseK = 1.0 - smoothstep(700.0, 2200.0, dist);
          float rockEdge = mix(0.06, 0.015, 1.0 - noiseK);
          float rockW = smoothstep(0.46 - altR * 0.18, 0.46 - altR * 0.18 + rockEdge, slope + ((nz.b - 0.5) * 0.04 + (gully - 0.5) * 0.04) * noiseK);
          float scree = smoothstep(0.2, 0.32, slope) * (1.0 - rockW) * smoothstep(0.5, 0.68, gully + nz.r * 0.25) * smoothstep(500.0, 900.0, h);
          col = mix(col, mix(rockB, col, 0.45) * (0.85 + 0.3 * nf.r), scree * (1.0 - smoothstep(300.0, 900.0, dist)));
          col = mix(col, rock, rockW);
          // snow: settles on gentle slopes, streaks down couloirs
          float snowLine = 1900.0 + (nH.r - 0.5) * 220.0 - n.z * 80.0;
          float slopeCap = smoothstep(0.55, 0.4, slope);
          float snowEdge = (nz.g - 0.5) * 90.0 + (nm.a - 0.5) * 50.0;
          float snowW = smoothstep(snowLine + snowEdge * noiseK, snowLine + snowEdge * noiseK + 18.0, h) * smoothstep(0.0, 0.05, slopeCap - 0.45);
          snowW = max(snowW, smoothstep(snowLine + 350.0, snowLine + 550.0, h) * smoothstep(0.75, 0.6, slope));
          vec3 snowC = snow * (0.9 + 0.1 * nd.b);
          col = mix(col, snowC, snowW);
          // shoreline & lake bed
          float wl = uWaterLevel;
          float shore = 1.0 - smoothstep(0.2, 0.9, abs(h - wl - 0.2) + (nd.r - 0.5) * 0.6);
          float sandPatch = smoothstep(0.35, 0.6, texture(uNoiseTex, xz * 0.012 + 0.9).g);
          col = mix(col, sand * (0.85 + 0.25 * nf.b), shore * (1.0 - rockW) * 0.9 * sandPatch);
          col = mix(col, vec3(0.42, 0.4, 0.38) * (0.8 + 0.4 * nf.a), shore * (1.0 - sandPatch) * smoothstep(0.55, 0.7, nf.a) * 0.7);
          float under = smoothstep(wl + 0.1, wl - 0.6, h);
          col = mix(col, mix(sand * 0.8, mud, smoothstep(wl - 0.5, wl - 5.0, h)), under);
          t_wet = 1.0 - smoothstep(wl, wl + 0.7, h);
          // trail
          float trailEdge = trail + (nd.g - 0.5) * 0.45 + (nf.r - 0.5) * 0.3;
          float tw = smoothstep(0.32, 0.62, trailEdge);
          float trailEdge2 = trail + (nd.g - 0.5) * 0.3 + (nf.r - 0.5) * 0.2;
          tw = smoothstep(0.42, 0.5, trailEdge2);
          // cobbles & pebbles
          vec4 cb = texture(uNoiseTex, xz * 2.3);
          vec4 cb2 = texture(uNoiseTex, xz * 0.7 + 0.31);
          vec3 tcol = dirt * (0.84 + 0.24 * nf.b) * (0.92 + 0.16 * nz.r);
          float stones = max(smoothstep(0.66, 0.72, cb.a), smoothstep(0.74, 0.78, cb2.a) * 0.9);
          tcol = mix(tcol, vec3(0.74, 0.68, 0.6) * (0.85 + 0.3 * cb.r), stones * 0.6);
          // forest floor path: brown earth and leaf litter
          {
            float fpath = smoothstep(0.3, 0.7, bio.r);
            vec3 earth = vec3(0.46, 0.29, 0.14) * (0.85 + 0.35 * nf.b);
            earth = mix(earth, vec3(0.55, 0.36, 0.14), smoothstep(0.6, 0.75, texture(uNoiseTex, xz * 1.9 + 0.2).a) * 0.6);
            tcol = mix(tcol, earth, fpath);
          }
          // damp, darker margins
          tcol *= mix(0.78, 1.0, smoothstep(0.5, 0.75, trailEdge2));
          tcol = mix(tcol, dirt * 0.7, smoothstep(0.8, 1.0, trail) * 0.25 * (1.0 - stones));
          // worn grass fringe lightens the verge so the path reads from afar
          col = mix(col, col * 1.18 + vec3(0.04, 0.03, 0.0), smoothstep(0.1, 0.4, trailEdge2) * (1.0 - tw));
          col = mix(col, tcol, tw);
          // wet pebble stream bed
          {
            vec4 pb = texture(uNoiseTex, xz * 1.7 + 0.5);
            // rounded river pebbles: cell-like blobs in warm greys and ochres
            vec4 pc = texture(uNoiseTex, xz * 0.55 + 0.17);
            float peb = smoothstep(0.5, 0.62, pc.a) * smoothstep(0.35, 0.5, pb.r);
            vec3 pebC = mix(vec3(0.52, 0.47, 0.4), vec3(0.62, 0.55, 0.42), pc.g);
            vec3 bedC = mix(vec3(0.3, 0.3, 0.24), pebC, peb);
            bedC *= mix(0.78, 1.05, smoothstep(0.3, 0.7, pb.b));
            bedC = mix(bedC, vec3(0.16, 0.3, 0.08), smoothstep(0.55, 0.3, bed) * 0.6);
            bedC = mix(bedC, vec3(0.08, 0.2, 0.2), smoothstep(120.0, 420.0, dist) * 0.8);
            col = mix(col, bedC * 0.8, smoothstep(0.2, 0.5, bed));
            t_wet = max(t_wet, smoothstep(0.1, 0.4, bed));
          }
          col *= 0.93 + 0.14 * nH.a;
          {
            float cvK = smoothstep(250.0, 900.0, dist);
            if (cvK > 0.0) {
              float ce = max(10.0, dist * 0.008);
              float lap = (w_height(xz + vec2(ce, 0.0)) + w_height(xz - vec2(ce, 0.0)) + w_height(xz + vec2(0.0, ce)) + w_height(xz - vec2(0.0, ce)) - 4.0 * w_height(xz)) / ce;
              float concave = smoothstep(0.0, 0.9, lap), convex = smoothstep(0.0, 0.9, -lap);
              col *= 1.0 - concave * 0.28 * cvK;
              col = mix(col, col * 1.18 + vec3(0.03), convex * 0.5 * cvK * (1.0 - snowW));
            }
          }
          // far ranges: clean painted zones (lower slopes green, single-tone rock, crisp snow)
          {
            float farZ = smoothstep(1100.0, 2600.0, dist);
            if (farZ > 0.0) {
              float sB = 1.0 - w_normal(xz, max(e * 4.0, 60.0)).y;
              vec3 lowG = mix(vec3(0.08, 0.25, 0.08), vec3(0.22, 0.38, 0.12), smoothstep(150.0, 1100.0, h));
              lowG = mix(lowG, vec3(0.06, 0.2, 0.08), smoothstep(0.3, 0.7, forest));
              float strata = smoothstep(0.4, 0.6, sin(h * 0.03 + nH.g * 9.0 + nz.r * 4.0) * 0.5 + 0.5) * smoothstep(0.35, 0.6, nz.b);
              vec3 stone = mix(vec3(0.42, 0.4, 0.41), vec3(0.47, 0.44, 0.42), smoothstep(0.35, 0.65, nH.g)) * (0.95 + 0.1 * smoothstep(1100.0, 2200.0, h));
              float rk = max(smoothstep(1050.0, 1300.0, h + (sB - 0.3) * 600.0), smoothstep(0.46, 0.52, sB) * smoothstep(500.0, 850.0, h));
              vec3 zc = mix(lowG, stone, rk);
              float sl = 1700.0 + (nH.r - 0.5) * 160.0;
              float sn = smoothstep(sl, sl + 12.0, h) * smoothstep(0.62, 0.55, sB);
              sn = max(sn, smoothstep(sl + 450.0, sl + 470.0, h) * smoothstep(0.78, 0.7, sB));
              zc = mix(zc, vec3(0.97, 0.98, 1.0), sn);
              t_snowFar = sn * farZ;
              col = mix(col, zc, farZ);
              t_rough = mix(t_rough, 0.95, farZ);
            }
          }
          t_albedo = col;
          t_rough = mix(0.95, 0.5, snowW);
          t_rough = mix(t_rough, 0.3, t_wet);
          // detail normal
          vec2 gd = vec2(nf.g - texture(uNoiseTex, xz * 0.63 + vec2(0.002, 0.0)).g,
                         nf.g - texture(uNoiseTex, xz * 0.63 + vec2(0.0, 0.002)).g);
          float bump = mix(0.5, 2.0, rockW) * fadeF;
          // far cliffs: painted flat planes (faceted normals) for crisp stylized rock faces
          {
            vec3 fn = normalize(cross(dFdx(wp), dFdy(wp)));
            if (fn.y < 0.0) fn = -fn;
            float facet = smoothstep(1200.0, 3000.0, dist) * max(rockW, snowW * 0.6) * 0.4;
            n = normalize(mix(n, fn, facet));
          }
          // far away: light the big forms, not every wrinkle
          n = normalize(mix(n, w_normal(xz, max(broadE * 2.0, 48.0)), smoothstep(1100.0, 3200.0, dist) * 0.9));
          vec2 gdm = vec2(nm.r - texture(uNoiseTex, xz * 0.013 + vec2(0.002, 0.0)).r,
                          nm.r - texture(uNoiseTex, xz * 0.013 + vec2(0.0, 0.002)).r);
          n = normalize(n + vec3(gd.x, 0.0, gd.y) * bump + vec3(gdm.x, 0.0, gdm.y) * 3.0 * rockW * fadeM);
          t_normal = n;
        }
      `,
      fragment: [
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          terrainSurface(vWPos, length(vWPos - cameraPosition));
          diffuseColor.rgb = t_albedo;
          // caustics on the lake bed
          float depthW = uWaterLevel - vWPos.y;
          if (depthW > 0.0) {
            vec2 cp = vWPos.xz * 0.35;
            float c1 = texture(uNoiseTex, cp * 0.11 + uTime * 0.012).a;
            float c2 = texture(uNoiseTex, cp * 0.13 - uTime * 0.010 + 0.5).a;
            float caust = pow(clamp(1.0 - abs(c1 - c2) * 3.5, 0.0, 1.0), 6.0);
            diffuseColor.rgb *= exp(-depthW * vec3(0.30, 0.10, 0.07));
            diffuseColor.rgb += caust * 0.35 * exp(-depthW * 0.25) * max(uSunDir.y, 0.0);
          }
          diffuseColor.rgb *= mix(1.0, 0.55, t_wet);
          if (uAOSpot.z > 0.0) {
            float dA = length(vWPos.xz - uAOSpot.xy);
            diffuseColor.rgb *= 1.0 - uAOSpot.w * (1.0 - smoothstep(uAOSpot.z * 0.75, uAOSpot.z * 1.35, dA));
            t_glowWarm = 1.0 - smoothstep(uAOSpot.z * 0.6, uAOSpot.z * 3.2, dA);
            t_glowWarm *= t_glowWarm;
          }
          // alpenglow on high snow and rock around sunset/sunrise
          t_glow = uAlpenglow * smoothstep(1100.0, 1900.0, vWPos.y);
        `],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.42, 0.5) * t_glow * 0.55 * w_sunVis;
          totalEmissiveRadiance += (diffuseColor.rgb * 0.4 + vec3(0.05, 0.03, 0.01)) * vec3(1.0, 0.55, 0.25) * t_glowWarm * max(uNight, uGolden * 0.25) * 0.22;
          { float fz = smoothstep(0.4, 0.85, w_biome(vWPos.xz).r) * (1.0 - w_nearBlend(vWPos.xz)); totalEmissiveRadiance += diffuseColor.rgb * vec3(0.9, 1.0, 0.6) * fz * 0.35 * length(uLightColor) * 0.12 * (1.0 - uNight);
            vec2 dp = vWPos.xz * 0.33 + uWindDir * sin(uTime * 0.4) * 0.05;
            vec2 dp2 = vWPos.xz * 0.16 + uWindDir * sin(uTime * 0.3) * 0.03;
            float dap = smoothstep(0.56, 0.72, texture(uNoiseTex, dp2).a) * smoothstep(0.42, 0.6, texture(uNoiseTex, dp2 * 0.37 + 0.2).g);
            totalEmissiveRadiance += diffuseColor.rgb * uLightColor * vec3(0.95, 1.05, 0.75) * dap * fz * 0.26 * smoothstep(0.05, 0.2, uLightDir.y); }
          {
            // rim light along distant ridgelines
            vec3 Vw = normalize(cameraPosition - vWPos);
            vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            float rim = pow(1.0 - max(dot(Nw, Vw), 0.0), 4.0) * smoothstep(400.0, 2500.0, length(vWPos - cameraPosition));
            totalEmissiveRadiance += uLightColor * rim * 0.06 * w_sunVis * smoothstep(-0.02, 0.1, uLightDir.y);
          }`],
        ['#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = t_rough;'],
        ['#include <normal_fragment_begin>', /* glsl */ `
          #include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(t_normal, 0.0)).xyz);
        `],
      ],
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
  }

  /** Rebuild the quadtree around the camera. hf gives ground height for culling boxes. */
  update(camera, groundY) {
    const cx = camera.position.x, cz = camera.position.z;
    const dy = Math.max(0, camera.position.y - groundY);
    this.uniforms.uCamDY.value = dy;
    this.uniforms.uCamXZ.value.set(cx, cz);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    let count = 0;
    const arr = this.nodeArr;
    const box = this._box;
    const frustum = this._frustum;
    const visit = (x0, z0, size) => {
      if (count >= MAX_NODES) return;
      // generous vertical bounds
      box.min.set(x0, -200, z0);
      box.max.set(x0 + size, 4200, z0 + size);
      if (!frustum.intersectsBox(box)) return;
      const ddx = Math.max(x0 - cx, 0, cx - (x0 + size));
      const ddz = Math.max(z0 - cz, 0, cz - (z0 + size));
      const d = Math.hypot(Math.hypot(ddx, ddz), dy);
      if (size > MIN_SIZE && d < LOD_K * size) {
        const h = size / 2;
        visit(x0, z0, h); visit(x0 + h, z0, h); visit(x0, z0 + h, h); visit(x0 + h, z0 + h, h);
      } else {
        const i = count * 4;
        arr[i] = x0; arr[i + 1] = z0; arr[i + 2] = size; arr[i + 3] = 0;
        count++;
      }
    };
    visit(-ROOT / 2, -ROOT / 2, ROOT);
    this.geometry.instanceCount = count;
    this.nodeAttr.needsUpdate = true;
    this.nodeAttr.clearUpdateRanges();
    this.nodeAttr.addUpdateRange(0, count * 4);
    return count;
  }
}
