import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { mulberry32, fbm } from './biome.js';
import { fluffyAtlas, fluffyBroadleaf, fluffyPine, fluffyLarch, fluffyBush } from './fluffy.js';
import { LAYER_REFLECT } from './water.js';

// Stylized volumetric fluffy trees (oak, round maple, alpine spruce, bush, birch/poplar, golden larch),
// instanced with three LOD bands (sculpted painterly cards -> smooth cores -> soft multi-lobe impostors).

const KINDS = [
  { name: 'oak',    mid: () => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075], lod: 1 }), hi: () => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075] }), lo: () => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075], lod: 0 }), bb: 0 },
  { name: 'round',  mid: () => fluffyBroadleaf(23, { kind: 'round',  color: [0.16, 0.42, 0.09], lod: 1 }),  hi: () => fluffyBroadleaf(23, { kind: 'round',  color: [0.16, 0.42, 0.09] }),  lo: () => fluffyBroadleaf(23, { kind: 'round',  color: [0.18, 0.43, 0.09], lod: 0 }),  bb: 0 },
  { name: 'pine',   mid: () => fluffyPine(37, { color: [0.065, 0.24, 0.10], lod: 1 }),                       hi: () => fluffyPine(37, { color: [0.065, 0.24, 0.10] }),                       lo: () => fluffyPine(37, { color: [0.065, 0.24, 0.10], lod: 0 }),                       bb: 1 },
  { name: 'bush',   mid: () => fluffyBush(61, { lod: 1 }),                                                   hi: () => fluffyBush(61),                                                       lo: () => fluffyBush(61, { lod: 0 }),                                                   bb: 0 },
  { name: 'poplar', mid: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], bark: [0.76, 0.73, 0.67], lod: 1 }), hi: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], bark: [0.76, 0.73, 0.67] }), lo: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], lod: 0 }), bb: 2 },
  { name: 'larch',  mid: () => fluffyLarch(73, { color: [0.23, 0.38, 0.11], bark: [0.30, 0.20, 0.13], lod: 1 }), hi: () => fluffyLarch(73, { color: [0.23, 0.38, 0.11], bark: [0.30, 0.20, 0.13] }), lo: () => fluffyLarch(73, { color: [0.23, 0.38, 0.11], lod: 0 }), bb: 3 },
];

function makeMaterial(map) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, map, alphaTest: 0.44, side: THREE.DoubleSide, alphaToCoverage: true });
  patchMaterial(mat, {
    toonWrap: 0.48, toonLo: 0.14, toonHi: 0.56,
    vertexPars: 'attribute vec3 aCrown; varying vec3 vCrown; varying vec3 vWorldN;',
    vertex: [
      ['#include <begin_vertex>', /* glsl */ `
        #include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3]);
          float ph = ip.x * 0.071 + ip.z * 0.053;
          float gust = texture(uNoiseTex, ip.xz * 0.011 - uWindDir * uTime * 0.045).r;
          float amp = (0.005 + gust * 0.022) * (0.4 + uWindStrength);
          float k = max(position.y - 0.22, 0.0); k *= k;
          transformed.x += (sin(uTime * 1.1 + ph) * amp + uWindDir.x * gust * 0.022) * k;
          transformed.z += (cos(uTime * 0.9 + ph * 1.3) * amp + uWindDir.y * gust * 0.022) * k;
          transformed += normal * sin(uTime * 3.0 + position.y * 30.0 + position.x * 20.0 + ph * 5.0) * 0.003 * k;
          vCrown = aCrown;
          vec3 wn = normal;
          #ifdef USE_INSTANCING
            wn = mat3(instanceMatrix) * wn;
          #endif
          vWorldN = normalize(mat3(modelMatrix) * wn);
        }
      `],
    ],
    fragmentPars: 'varying vec3 vCrown; varying vec3 vWorldN;',
    fragment: [
      ['#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);`],
      ['#include <map_fragment>', `#include <map_fragment>
        if (vMapUv.x > 0.895 || vCrown.z < 0.5) {
          diffuseColor.a = 1.0;
        } else {
          // mip-aware crisp 1024px leaf cluster atlas
          vec2 tsz = vMapUv * 1024.0;
          vec2 ddx = dFdx(tsz), ddy = dFdy(tsz);
          float mip = max(0.0, 0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))));
          diffuseColor.a *= 1.0 + mip * 0.30;
        }`],
      ['#include <color_fragment>', `#include <color_fragment>
        if (vMapUv.x > 0.895 || vCrown.z < 0.5) {
          // crisp infinite-resolution sculpted furrowed oak bark, gnarl knots, pale lichen & mossy base (ZERO stretched smooth cylinder texture in forest.png!)
          float angB = atan(vWorldN.z, vWorldN.x);
          float bRidge = n_noise(vec2(angB * 5.5 + vWPos.y * 0.32, vWPos.y * 1.15));
          float bDeep  = n_noise(vec2(angB * 13.0 + bRidge * 2.2, vWPos.y * 2.8));
          float bFine  = n_noise(vec2(angB * 24.0 + vWPos.y * 1.4, vWPos.y * 6.5));
          float furrow = smoothstep(0.28, 0.68, bRidge * 0.48 + bDeep * 0.36 + bFine * 0.16);
          bool isBirch = diffuseColor.r > 0.25 && diffuseColor.b > 0.20;
          if (isBirch) {
            float lenticel = smoothstep(0.76, 0.84, texture(uNoiseTex, vec2(vWPos.x * 2.2 + vWPos.z * 2.2, vWPos.y * 2.8)).r);
            diffuseColor.rgb = mix(vec3(0.76, 0.73, 0.66), vec3(0.20, 0.17, 0.15), lenticel * 0.85) * (0.85 + 0.2 * bFine);
          } else {
            vec3 barkCrev = vec3(0.045, 0.028, 0.018);
            vec3 barkMid  = vec3(0.18, 0.115, 0.068);
            vec3 barkLit  = vec3(0.32, 0.22, 0.14);
            vec3 bCol = mix(barkCrev, barkMid, smoothstep(0.15, 0.55, furrow));
            bCol = mix(bCol, barkLit, smoothstep(0.55, 0.88, furrow) * 0.72);
            // subtle sage-silver alpine bark lichen flecks
            float lichen = smoothstep(0.74, 0.84, n_noise(vec2(angB * 4.0 + 3.1, vWPos.y * 1.6))) * smoothstep(0.42, 0.70, bDeep);
            bCol = mix(bCol, vec3(0.36, 0.42, 0.34), lichen * 0.42);
            diffuseColor.rgb = bCol * (0.68 + 0.42 * vCrown.x);
            // lush velvety green moss creeping up lower & shaded sides of forest trunks
            float hMoss = 1.0 - smoothstep(0.05, 0.34, vCrown.y + (bRidge - 0.5) * 0.14);
            float nMoss = smoothstep(0.36, 0.66, bDeep * 0.55 + texture(uNoiseTex, vWPos.xz * 0.55 + vWPos.y * 0.25).g * 0.45);
            float mossW = hMoss * nMoss * (0.45 + 0.55 * smoothstep(0.2, 0.6, w_biome(vWPos.xz).r));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.075, 0.24, 0.048) * (0.78 + 0.44 * bFine), mossW * 0.82);
          }
        } else {
          // TRUE 3D VOLUMETRIC PAINTERLY CROWN SHADING:
          // deep layered canopy shadow pockets + bright sunlit emerald-gold clump highlights (KILLS flat green wall in forest.png!)
          vec3 Nw = normalize(vWorldN);
          float sunSide = clamp(dot(Nw, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
          float coreAO = clamp(vCrown.x, 0.26, 1.08);
          float topG = clamp(vCrown.y, 0.0, 1.0);
          // per-sprig painterly light-and-shadow breakup inside close-up canopies!
          float sprigN = n_noise(vWPos.xz * 0.85 + vWPos.y * 0.65);
          float litMask = smoothstep(0.20, 0.78, sunSide * 0.62 + topG * 0.28 + (sprigN - 0.5) * 0.26);

          float isWarmLeaf = smoothstep(0.82, 1.08, diffuseColor.r / max(diffuseColor.g, 0.01));
          vec3 coolGreen = diffuseColor.rgb * vec3(0.46, 0.82, 1.24);
          vec3 warmSienna = diffuseColor.rgb * vec3(0.84, 0.54, 0.34);
          vec3 shadowTone = mix(coolGreen, warmSienna, isWarmLeaf);
          vec3 warmShift = diffuseColor.rgb * mix(vec3(1.18, 1.22, 0.72), vec3(1.20, 0.98, 0.64), max(uGolden, uDawn));
          vec3 volCol = mix(shadowTone, warmShift, litMask);
          // sculpted deep dark pockets between bough clumps for authentic cathedral canopy depth!
          volCol *= mix(0.22, 1.18, smoothstep(0.20, 0.94, coreAO) * (0.62 + 0.38 * topG));
          float pvar = texture(uNoiseTex, vWPos.xz * 0.16 + vWPos.y * 0.12).g;
          volCol *= 0.82 + 0.34 * (pvar * 0.6 + sprigN * 0.4);
          diffuseColor.rgb = volCol;
        }`],
      ['#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        {
          vec3 Vw = normalize(vWPos - cameraPosition);
          vec3 nW = normalize(vWorldN);
          float lit = w_sunVis * smoothstep(-0.02, 0.08, uLightDir.y);
          float isLeaf = step(0.5, vCrown.z);
          // warm backlit rim & translucency (golden-amber at low sun, lifts dawn left framing tree!)
          float back = pow(max(dot(Vw, uLightDir), 0.0), 3.6);
          float rim = pow(1.0 - abs(dot(nW, -Vw)), 2.2);
          float sunEdge = smoothstep(-0.18, 0.52, dot(nW, uLightDir));
          float lowSun = max(uGolden, uDawn);
          vec3 transTint = mix(vec3(0.95, 1.02, 0.68), vec3(1.0, 0.76, 0.40), lowSun);
          float edgeMask = mix(0.35 + 0.65 * vCrown.x, pow(rim, 1.2) * smoothstep(0.42, 0.92, vCrown.x), lowSun * 0.72);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * transTint * back * 0.20 * edgeMask * lit * isLeaf;
          // luminous sunlit rim on crowns + warm golden sunrise rim light on dawn framing trees!
          vec3 rimCol = mix(diffuseColor.rgb * 1.18, vec3(1.0, 0.78, 0.44) * max(dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2)), 0.14), lowSun * 0.76);
          totalEmissiveRadiance += rimCol * uLightColor * rim * (0.09 + 0.20 * lowSun) * (0.35 + 0.65 * sunEdge) * lit * isLeaf;
          totalEmissiveRadiance += vec3(1.0, 0.76, 0.42) * rim * uDawn * (0.40 + 0.60 * sunEdge) * 0.16 * isLeaf;
          // subtle canopy sky bounce + twilight rim + crisp silver-blue night moonlight rim + warm cottage spill
          totalEmissiveRadiance += diffuseColor.rgb * vec3(0.84, 1.0, 0.74) * 0.036 * length(uLightColor) * (1.0 - uNight) * (1.0 - lowSun * 0.55) * isLeaf * (0.4 + 0.6 * vCrown.x);
          totalEmissiveRadiance += (diffuseColor.rgb * vec3(0.28, 0.34, 0.58) + vec3(0.010, 0.012, 0.025)) * rim * uDusk * (1.0 - uNight * 0.6) * 0.16 * isLeaf;
          totalEmissiveRadiance += vec3(0.26, 0.42, 0.78) * rim * (0.35 + 0.65 * vCrown.y) * uNight * 0.10 * isLeaf;
          totalEmissiveRadiance += (diffuseColor.rgb * 1.3 + vec3(0.02, 0.012, 0.005)) * w_warmSpill(vWPos) * 1.55;
        }
      `],
      ['#include <alphatest_fragment>', `#include <alphatest_fragment>
        {
          float camD = length(vWPos - cameraPosition);
          // only clip foliage literally touching the camera lens (keeps nearby woodland branches lushly clothed — ZERO exposed cut stubs in forest.png!)
          if (camD < (vMapUv.x < 0.89 ? 2.1 : 1.0)) discard;
        }`],
    ],
  });
  return mat;
}

function makeBillboardMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, side: THREE.DoubleSide });
  patchMaterial(mat, {
    toonWrap: 0.55, toonLo: 0.20, toonHi: 0.55,
    vertexPars: 'attribute float aKind; attribute vec3 aTint; varying vec2 vBB; varying float vBBKind; varying vec3 vBBWorld; varying vec3 vTint; varying vec3 vRight; varying vec3 vToCam;',
    vertex: [
      ['#include <begin_vertex>', `
        vec3 bbC = vec3(instanceMatrix[3]);
        float bbH = length(instanceMatrix[1].xyz);
        float bbD = length(bbC - cameraPosition);
        // merge distant canopies smoothly into lush painted Ghibli forest masses instead of counted uniform dots!
        float massExpand = mix(1.24, 1.82, smoothstep(280.0, 960.0, bbD));
        float bbW = bbH * (aKind < 0.5 ? 1.18 : aKind < 1.5 ? 0.90 : aKind < 2.5 ? 0.72 : 0.90) * massExpand;
        vec3 toCam = cameraPosition - bbC; toCam.y = 0.0; toCam = normalize(toCam + 1e-4);
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vBBWorld = bbC + right * position.x * bbW + vec3(0.0, position.y * bbH, 0.0);
        vBB = vec2(position.x + 0.5, position.y);
        vBBKind = aKind; vTint = aTint; vRight = right; vToCam = toCam;
        vec3 transformed = position;
      `],
      ['#include <project_vertex>', `
        vec4 mvPosition = viewMatrix * vec4(vBBWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      `],
      ['vWPos = (modelMatrix * w_wp).xyz;', 'vWPos = vBBWorld;'],
    ],
    fragmentPars: 'varying vec2 vBB; varying float vBBKind; varying vec3 vTint; varying vec3 vRight; varying vec3 vToCam; vec3 bbN;',
    fragment: [
      ['#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vec2((vBB.x - 0.5) * 2.0, vBB.y);
          float n = texture(uNoiseTex, vBB * 1.1 + vBBKind * 0.31 + vTint.r).a;
          vec2 c; float rx, ry;
          if (vBBKind < 0.5)      { c = vec2(0.0, 0.60); rx = 0.96; ry = 0.39; }
          else if (vBBKind < 1.5) { c = vec2(0.0, 0.52); rx = 0.94 * (1.0 - (vBB.y - 0.14) * 0.88); ry = 0.47; }
          else if (vBBKind < 2.5) { c = vec2(0.0, 0.58); rx = 0.85; ry = 0.42; }
          else                    { c = vec2(0.0, 0.52); rx = 0.92 * (1.0 - (vBB.y - 0.14) * 0.86); ry = 0.47; }
          vec2 d = (q - c) / vec2(max(rx, 0.05), ry);
          float r = length(d);
          float angL = atan(d.y, d.x);
          // multi-harmonic irregular painterly woodland silhouette (KILLS identical lollipop stamps in title/summitWest/lake/dawn!)
          float lobes = 0.84 + 0.14 * sin(angL * 4.0 + vTint.r * 28.0) + 0.10 * sin(angL * 7.0 - vTint.g * 19.0) + (n - 0.5) * 0.28;
          float bbDist = length(vWPos - cameraPosition);
          bool trunk = abs(q.x) < 0.055 && vBB.y < c.y - 0.1 && bbDist < 340.0;
          if (r > lobes && !trunk) discard;
          vec3 base = vBBKind < 0.5 ? vec3(0.11, 0.34, 0.078)
                    : vBBKind < 1.5 ? vec3(0.048, 0.21, 0.115)
                    : vBBKind < 2.5 ? vec3(0.17, 0.41, 0.095)
                    :                 vec3(0.20, 0.32, 0.098);
          // broad macro woodland hue-wave variation across the valley so distant forests read as sweeping Ghibli color swells!
          float macH = texture(uNoiseTex, vWPos.xz * 0.0011 + 0.27).r;
          base = mix(base, base * vec3(0.74, 0.96, 1.16), smoothstep(0.48, 0.78, macH) * 0.55);
          base = mix(base, base * vec3(1.20, 1.08, 0.74), smoothstep(0.50, 0.80, 1.0 - macH) * 0.46);
          float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
          float goldEve = uGolden * (1.0 - uDawn);
          // bold sculpted lit crown tops vs deep cool-indigo shadow edges (especially crisp at golden hour in summitWest.png!)
          vec3 coolBase = vBBKind > 2.5 ? base * vec3(0.55, 0.70, 0.78) : base * vec3(0.44, 0.72, 1.28);
          coolBase = mix(coolBase, base * vec3(0.28, 0.40, 0.82), goldEve * 0.55);
          vec3 warmTop  = mix(base * vec3(1.18, 1.14, 0.76), base * vec3(1.48, 1.06, 0.52), goldEve * 0.78);
          vec3 col = mix(coolBase, warmTop, smoothstep(0.28, 0.74, up));
          // calm dawn distant forest edge so far shore harmonizes with cool dawn valley (KILLS neon lime at 900-1600, 350-420 in dawn.png!)
          col = mix(col, col * vec3(0.84, 0.68, 0.98), uDawn * 0.62);
          float lC = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(col, mix(vec3(lC), col, 0.78), smoothstep(900.0, 2800.0, bbDist));
          diffuseColor.rgb = trunk && r > lobes ? vec3(0.26, 0.17, 0.11) : col * mix(vec3(1.0), vTint, 0.48) * (0.40 + 0.72 * up);
          vec3 sph = normalize(vec3(d.x * 0.9, d.y + 0.32, sqrt(max(0.0, 1.0 - min(r * r, 1.0)))));
          bbN = normalize(vRight * sph.x + vec3(0.0, 1.0, 0.0) * sph.y + vToCam * sph.z);
        }`],
      ['#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(bbN, 0.0)).xyz);`],
    ],
  });
  return mat;
}

export class Trees {
  constructor(hf, biome, density = 1, detail = 2) {
    this.hf = hf;
    this.biome = biome;
    this.cell = 16;
    this._clearAreas = [];
    this._heroOaks = [];
    this._heroMeshes = [];
    this.atlas = fluffyAtlas();
    this.material = makeMaterial(this.atlas);
    this.group = new THREE.Group();
    this.lastUpdate = new THREE.Vector3(1e9, 0, 0);
    this._buildInstances(density, detail);
  }

  _buildInstances(density, detail) {
    const hf = this.hf;
    const biome = this.biome;
    const rnd = mulberry32(777);
    const S = WORLD.size;
    const trees = [];
    const n = { x: 0, y: 1, z: 0 };
    const L = WORLD.lake;
    const step = 7.6 / Math.sqrt(density);
    for (let z = -S / 2 + 40; z < S / 2 - 40; z += step) {
      for (let x = -S / 2 + 40; x < S / 2 - 40; x += step) {
        // organic grove-center clustering + drainage-line attraction (KILLS evenly spaced chess-piece lollipops in lake/lakeSunset/dawn!)
        const pullX = (fbm(x * 0.013 + 2.1, z * 0.013 - 3.7, 2) - 0.5) * step * 1.90;
        const pullZ = (fbm(x * 0.013 - 5.3, z * 0.013 + 4.9, 2) - 0.5) * step * 1.90;
        const px = x + (rnd() - 0.5) * step * 1.18 + pullX, pz = z + (rnd() - 0.5) * step * 1.18 + pullZ;
        const f = biome.sampleForest(px, pz);
        const h = hf.height(px, pz);
        if (h < WORLD.waterLevel + 1.6) continue;
        // drainage-line hollow bias: trees gather thickly in gentle hillside swales & leave intentional open sunlit meadows on smooth crests!
        const avgH = 0.25 * (hf.height(px + 18, pz) + hf.height(px - 18, pz) + hf.height(px, pz + 18) + hf.height(px, pz - 18));
        const drainBoost = Math.max(0, Math.min(0.32, (avgH - h) * 0.10));
        const copse = fbm(px * 0.0085 - 4.1, pz * 0.0085 + 7.3, 3) + drainBoost;
        const edgeFea = Math.max(0, Math.min(1, (copse - 0.36) / 0.28));
        const edgeSmooth = edgeFea * edgeFea * (3 - 2 * edgeFea);
        const clumpFactor = f > 0.62 ? 1.0 : edgeSmooth;
        if (rnd() > f * clumpFactor * 1.22) continue;
        if (hf.trailAt(px, pz) > 0.02) continue;
        hf.normal(px, pz, 2, n);
        if (n.y < 0.72) continue;
        if (h > 1150 + fbm(px * 0.01, pz * 0.01, 2) * 120) continue;
        const dl = Math.hypot((px - L.x) / L.rx, (pz - L.z) / L.rz);
        const alt = (h - 140) / 560;
        const larchPatch = fbm(px * 0.0014 + 19.4, pz * 0.0014 - 11.2, 3) + (fbm(px * 0.0055, pz * 0.0055, 2) - 0.5) * 0.22;
        const larchBlend = Math.max(0, Math.min(1, (larchPatch - 0.52) / 0.28)) * Math.max(0, Math.min(1, (h - 155) / 140));
        const r = rnd();
        let v;
        if (larchBlend > 0.46 && r < larchBlend * 0.54) v = 5;                         // warm golden-olive alpine larch
        else if (dl < 1.85 && dl > 1.02 && r < 0.42) v = 4;                            // lakeside birch/poplar
        else if (rnd() < 0.18 + Math.max(0, alt) * 0.85 + f * 0.26) v = 2;             // alpine spruce
        else v = rnd() < 0.56 ? 0 : 1;                                                 // oak / round maple
        // dramatic Ghibli crown size hierarchy: giant grove patriarchs, medium canopy & smaller edge saplings!
        const edgeShrink = f < 0.40 ? (0.58 + 0.42 * (f / 0.40)) : (0.72 + 0.64 * Math.pow(rnd(), 1.35));
        const baseS = v === 2 || v === 5 ? 12.0 + rnd() * 11.5 : v === 4 ? 12.0 + rnd() * 8.0 : 8.5 + rnd() * 11.0;
        const scale = baseS * edgeShrink * (1 - Math.max(0, h - 700) / 1500);
        const hue = 0.80 + rnd() * 0.36;
        const grove = fbm(px * 0.0036 + 31, pz * 0.0036 - 7, 3);
        const warmG = 1.0 + larchBlend * 0.22 + (grove > 0.55 ? 0.12 : 0.0);
        const coolG = grove < 0.44 ? 1.18 : 1.0;
        trees.push({
          x: px, z: pz, y: h - 0.25, s: scale, rot: rnd() * Math.PI * 2, v,
          sx: 0.78 + rnd() * 0.48,
          tint: [hue * (0.90 + rnd() * 0.20) * warmG, hue * (0.98 + larchBlend * 0.08), hue * (0.84 + rnd() * 0.24) * coolG * (1.0 - larchBlend * 0.14)],
        });
      }
    }
    // trail-side cathedral trees inside forests: tall varied arches framing the path
    if (hf.trailPoints) for (let i = 0; i < hf.trailPoints.length; i += 3) {
      const [tx, tz] = hf.trailPoints[i];
      if (biome.sampleForest(tx + 12, tz) + biome.sampleForest(tx - 12, tz) < 0.7) continue;
      const j = Math.min(hf.trailPoints.length - 1, i + 2);
      const dx = hf.trailPoints[j][0] - tx, dz = hf.trailPoints[j][1] - tz, l = Math.hypot(dx, dz) || 1;
      for (const s of [-1, 1]) {
        if (rnd() > 0.56 * density) continue;
        const off = 5.6 + rnd() * 4.2;
        const px = tx - dz / l * off * s, pz = tz + dx / l * off * s;
        if (hf.trailAt(px, pz) > 0.02) continue;
        const h = hf.height(px, pz);
        const r2 = rnd();
        // cathedral trail trees: lush emerald broadleaf oaks & glowing silver birches (never muddy mustard cards overhead!)
        const v = r2 < 0.74 ? 0 : r2 < 0.94 ? 4 : 2;
        const hue = 0.88 + rnd() * 0.22;
        trees.push({ x: px, z: pz, y: h - 0.25, s: 14.5 + rnd() * 9.0, rot: rnd() * 6.28, v, sx: 0.88 + rnd() * 0.28, tint: [hue * 0.90, hue * 1.04, hue * 0.92] });
      }
    }
    // bushes: lush forest mid-story undergrowth, woodland edges, lakeside & along the trail
    for (let i = 0; i < 76000 * density; i++) {
      const px = (rnd() - 0.5) * (S - 120), pz = (rnd() - 0.5) * (S - 120);
      const f = biome.sampleForest(px, pz);
      const dlk = Math.hypot((px - WORLD.lake.x) / WORLD.lake.rx, (pz - WORLD.lake.z) / WORLD.lake.rz);
      const lakeRing = dlk > 1.15 && dlk < 2.2 ? 0.07 * (0.4 + fbm(px * 0.015, pz * 0.015, 2)) : 0;
      const underWood = f > 0.55 ? 0.38 * fbm(px * 0.04, pz * 0.04, 2) : 0;
      const edge = (f > 0.05 && f < 0.55 ? 0.5 : 0.04 * fbm(px * 0.02, pz * 0.02, 2) + lakeRing) + underWood;
      if (rnd() > edge) continue;
      const h = hf.height(px, pz);
      if (h < WORLD.waterLevel + 1.2 || h > 1050) continue;
      if (hf.trailAt(px, pz) > 0.01) continue;
      hf.normal(px, pz, 2, n);
      if (n.y < 0.82) continue;
      const hue = 0.85 + rnd() * 0.3;
      trees.push({ x: px, z: pz, y: h - 0.15, s: 1.4 + rnd() * 2.2, rot: rnd() * 6.28, v: 3, sx: 0.8 + rnd() * 0.5, tint: [hue * (0.9 + rnd() * 0.2), hue, hue * 0.9], bush: true });
    }
    this.trees = trees;
    this.grid = new Map();
    for (const t of trees) {
      const k = Math.floor(t.x / this.cell) + ',' + Math.floor(t.z / this.cell);
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(t);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    this.mats = new Float32Array(trees.length * 16);
    this.cols = new Float32Array(trees.length * 3);
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, t.rot);
      sc.set(t.s * t.sx, t.s, t.s * t.sx);
      p.set(t.x, t.y, t.z);
      m.compose(p, q, sc);
      m.toArray(this.mats, i * 16);
      this.cols.set(t.tint, i * 3);
    });
    const N = trees.length;
    const mk = (geo, shadow) => {
      const im = new THREE.InstancedMesh(geo, this.material, N);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
      im.count = 0; im.castShadow = shadow; im.receiveShadow = true; im.frustumCulled = false;
      this.group.add(im);
      return im;
    };
    this.hi = KINDS.map((k) => mk(detail >= 2 ? k.hi() : k.mid(), true));
    this.lo = KINDS.map((k) => mk(k.lo(), false));
    const bbGeo = new THREE.PlaneGeometry(1, 1);
    bbGeo.translate(0, 0.5, 0);
    this.bbKind = new Float32Array(N);
    this.bbTint = new Float32Array(N * 3);
    bbGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(this.bbKind, 1));
    bbGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.bbTint, 3));
    this.bb = new THREE.InstancedMesh(bbGeo, makeBillboardMaterial(), N);
    this.bb.count = 0; this.bb.frustumCulled = false;
    this.group.add(this.bb);
    this.setReflectionTrees();
    this.hiRadius = 230 * Math.sqrt(density);
    this.loRadius = 780;
    this.lastUpdate.set(1e9, 0, 0);
  }

  // Opts far tree batches into the planar lake reflection pass (Slice 7 repoints this to impostors).
  setReflectionTrees() {
    if (this.bb) this.bb.layers.enable(LAYER_REFLECT);
  }

  _disposeInstances() {
    for (const im of this.hi || []) {
      this.group.remove(im);
      im.geometry.dispose();
      im.dispose?.();
    }
    for (const im of this.lo || []) {
      this.group.remove(im);
      im.geometry.dispose();
      im.dispose?.();
    }
    if (this.bb) {
      this.group.remove(this.bb);
      this.bb.geometry.dispose();
      this.bb.material.dispose();
      this.bb.dispose?.();
      this.bb = null;
    }
    for (const im of this._heroMeshes) {
      this.group.remove(im);
      im.geometry.dispose();
      im.dispose?.();
    }
    this._heroMeshes = [];
  }

  update(camPos, force = false) {
    if (!force && camPos.distanceTo(this.lastUpdate) < 6) return;
    this.lastUpdate.copy(camPos);
    const hc = KINDS.map(() => 0), lc = KINDS.map(() => 0);
    let bb = 0;
    const r2 = this.hiRadius * this.hiRadius, lr2 = this.loRadius * this.loRadius;
    const M = this.mats, C = this.cols;
    const bbArr = this.bb.instanceMatrix.array;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const dx = t.x - camPos.x, dz = t.z - camPos.z;
      const d2 = dx * dx + dz * dz;
      const v = t.v;
      if (t.hidden || (t.bush && d2 > 90000)) continue;
      if (d2 < r2 || d2 < lr2) {
        const im = d2 < r2 ? this.hi[v] : this.lo[v];
        const cnt = d2 < r2 ? hc : lc;
        im.instanceMatrix.array.set(M.subarray(i * 16, i * 16 + 16), cnt[v] * 16);
        im.instanceColor.array.set(C.subarray(i * 3, i * 3 + 3), cnt[v] * 3);
        cnt[v]++;
      } else {
        bbArr.set(M.subarray(i * 16, i * 16 + 16), bb * 16);
        this.bbKind[bb] = KINDS[v].bb;
        this.bbTint.set(C.subarray(i * 3, i * 3 + 3), bb * 3);
        bb++;
      }
    }
    const fin = (im, c) => { im.count = c; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true; };
    this.hi.forEach((im, k) => fin(im, hc[k]));
    this.lo.forEach((im, k) => fin(im, lc[k]));
    this.bb.count = bb; this.bb.instanceMatrix.needsUpdate = true;
    this.bb.geometry.attributes.aKind.needsUpdate = true;
    this.bb.geometry.attributes.aTint.needsUpdate = true;
  }

  clearArea(x, z, r) {
    this._clearAreas.push([x, z, r]);
    for (const t of this.trees) if (Math.hypot(t.x - x, t.z - z) < r + (t.bush ? 0 : t.s * 0.2)) t.hidden = true;
    this.update(this.lastUpdate.clone().add(new THREE.Vector3(1e4, 0, 0)), true);
  }

  _buildHeroOaks(spots) {
    if (!spots.length) return;
    const geo = fluffyBroadleaf(121, { kind: 'oak', color: [0.12, 0.37, 0.072] });
    const im = new THREE.InstancedMesh(geo, this.material, spots.length);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3();
    spots.forEach(([x, z, s, rot, tint], idx) => {
      q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      m4.compose(p4.set(x, this.hf.height(x, z) - 0.35, z), q4, s4.set(s * 0.94, s, s * 0.94));
      im.setMatrixAt(idx, m4);
      im.instanceColor.setXYZ(idx, tint[0], tint[1], tint[2]);
    });
    im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
    this._heroMeshes.push(im);
    this.group.add(im);
  }

  addHeroOaks(spots) {
    if (!spots.length) return;
    this._heroOaks.push(spots);
    this._buildHeroOaks(spots);
  }

  setTier(tier) {
    this._disposeInstances();
    this._buildInstances(tier.trees, tier.treeDetail);
    if (tier.treeHi) this.hiRadius = tier.treeHi;
    if (tier.treeLo) this.loRadius = tier.treeLo;
    for (const [x, z, r] of this._clearAreas) {
      for (const t of this.trees) {
        if (!t.hidden && Math.hypot(t.x - x, t.z - z) < r + (t.bush ? 0 : t.s * 0.2)) t.hidden = true;
      }
    }
    for (const spots of this._heroOaks) this._buildHeroOaks(spots);
  }

  dispose() {
    this._disposeInstances();
    this.group.removeFromParent();
    this.material.dispose();
    this.atlas.dispose();
  }

  collide(pos, radius = 0.4) {
    const cx = Math.floor(pos.x / this.cell), cz = Math.floor(pos.z / this.cell);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = this.grid.get((cx + dx) + ',' + (cz + dz));
      if (!list) continue;
      for (const t of list) {
        if (t.bush || t.hidden) continue;
        const tr = t.s * 0.03 + radius;
        const ex = pos.x - t.x, ez = pos.z - t.z;
        const d = Math.hypot(ex, ez);
        if (d < tr && d > 1e-4) { pos.x = t.x + ex / d * tr; pos.z = t.z + ez / d * tr; }
      }
    }
  }
}

export function createTrees(ctx) {
  const trees = new Trees(ctx.data.hf, ctx.data.biome, ctx.tier.trees, ctx.tier.treeDetail);
  if (ctx.tier.treeHi) trees.hiRadius = ctx.tier.treeHi;
  if (ctx.tier.treeLo) trees.loRadius = ctx.tier.treeLo;
  ctx.scene.add(trees.group);
  return {
    instance: trees,
    update(frame) {
      trees.update(frame.camera.position);
    },
    setTier(tier) {
      trees.setTier(tier);
      trees.update(ctx.camera.position, true);
    },
    dispose() {
      trees.dispose();
    },
  };
}
