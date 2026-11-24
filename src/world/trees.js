import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { selectByRank } from './worldData.js';
import { mulberry32 } from './biome.js';
import { fluffyAtlas, fluffyBroadleaf, fluffyPine, fluffyLarch, fluffyBush } from './fluffy.js';
import { groupIntoCells, cellBoundingSphere, cellDistance, cellsInRadius, lodExitRadius, partitionInFrustum } from './treeChunks.js';
import { bakeImpostorAtlas, makeImpostorMaterial, impostorQuad } from './treeImpostor.js';
import { LAYER_REFLECT } from './water.js';

// Stylized volumetric fluffy trees (oak, round maple, alpine spruce, bush, birch/poplar, golden larch) on a static
// LOD ladder: hero (sculpted painterly cards) per species in 32 m cells, mid (a few leaf cards per hero clump) per species in
// 64 m cells, and one merged impostor batch per 1024 m far cell. Every batch is built once and culled by three.js;
// walking only toggles which cells are in the scene and rewrites the small cell-flag texture the shaders hide by.

// Far cells are 1024 m: impostors cost 2 triangles each, so coarse culling is cheap and the batches stay near 10
// draw calls per pass.
export const NEAR_CELL = 64;
// Hero trees switch in finer cells: one 64 m cell of dense forest holds about 60 trees, too many at hero cost.
export const HERO_CELL = 32;
export const FAR_CELL = 1024;
// Wind sway and crowns that overhang their cell edge.
const SWAY_PAD = 2;
// Re-pick near-cell LODs after the camera moved this far (metres).
const LOD_STEP = 4;
// Metres beyond the lake's outer radius within which far tree cells draw into the lake reflection.
const REFL_TREE_REACH = 700;
// Per-tree screen cull inside hero and mid batches: redone after the camera moved or turned this much, so each
// tree's sphere grows by the same amount (plus a distance share for the turn) to stay valid until the next pass.
const CULL_MOVE = 0.5;
const CULL_TURN = 0.01;
const CULL_MARGIN = CULL_MOVE + 0.25;
const CULL_SLOPE = CULL_TURN * 1.5;
const UP = new THREE.Vector3(0, 1, 0);

// three.js object ids consume Math.random, which capture mode seeds per page. Tree objects are built with a
// private generator, then the page generator is advanced by what the previous tree system used at the same
// boot point, so everything built later (herds, birds, water ripples) keeps its seeded layout.
const RNG_CALLS_CTOR = 132;
const RNG_CALLS_HERO_OAKS = 8;
const localRandom = mulberry32(0x7ee5);
function withLocalRandom(fn, outerCalls = 0) {
  const outer = Math.random;
  Math.random = localRandom;
  try {
    return fn();
  } finally {
    Math.random = outer;
    for (let i = 0; i < outerCalls; i++) outer();
  }
}

// imp: index into the impostor atlas (-1: no impostor, bushes are not drawn past the mid radius).
const KINDS = [
  { name: 'oak',    imp: 0, hero: (lod) => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075], lod }), mid: (d) => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075], lod: 0, lowPoly: true, sparse: true, puffs: d, fringe: d * 10, trunkLod: d }) },
  { name: 'round',  imp: 1, hero: (lod) => fluffyBroadleaf(23, { kind: 'round',  color: [0.16, 0.42, 0.09], lod }),  mid: (d) => fluffyBroadleaf(23, { kind: 'round',  color: [0.18, 0.43, 0.09], lod: 0, lowPoly: true, sparse: true, puffs: d, fringe: d * 10, trunkLod: d }) },
  { name: 'pine',   imp: 2, hero: (lod) => fluffyPine(37, { color: [0.065, 0.24, 0.10], lod }),                       mid: (d) => fluffyPine(37, { color: [0.065, 0.24, 0.10], lod: 0, lowPoly: true, sparse: true, puffs: d, fringe: d * 10, trunkLod: d }) },
  { name: 'bush',   imp: -1, hero: (lod) => fluffyBush(61, { lod }),                                                  mid: (d) => fluffyBush(61, { lod: 0, lowPoly: true, sparse: true, puffs: d, fringe: d * 10, trunkLod: d }) },
  { name: 'poplar', imp: 3, hero: (lod) => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], bark: [0.76, 0.73, 0.67], lod }), mid: (d) => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], bark: [0.76, 0.73, 0.67], lod: 0, lowPoly: true, sparse: true, puffs: d, fringe: d * 10, trunkLod: d }) },
  { name: 'larch',  imp: 4, hero: (lod) => fluffyLarch(73, { color: [0.23, 0.38, 0.11], bark: [0.30, 0.20, 0.13], lod }), mid: (d) => fluffyLarch(73, { color: [0.23, 0.38, 0.11], bark: [0.30, 0.20, 0.13], lod: 0, lowPoly: true, sparse: true, puffs: d, fringe: d * 10, trunkLod: d }) },
];

// Static instance data is uploaded once; the CPU copy is not needed afterwards.
function dropArray() {
  this.array = null;
}

// Mid instances whose 32 m hero cell is active (red channel of the cell-flag texture) draw as hero instead:
// pushed off-screen here.
const HERO_HIDE_PARS = /* glsl */ `
  attribute vec2 aHeroCell;
  uniform sampler2D uTreeCells; uniform vec2 uTreeCellOrigin;
`;
const HERO_HIDE = ['#include <project_vertex>', /* glsl */ `#include <project_vertex>
  if (texelFetch(uTreeCells, ivec2(floor(aHeroCell / ${HERO_CELL.toFixed(1)}) - uTreeCellOrigin), 0).r > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`];

/** Shadow depth for mid batches: same leaf alpha cut-out as the default, plus the hero hide rule. */
function makeMidDepthMaterial(map, lodUniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.5, side: THREE.DoubleSide });
  mat.customProgramCacheKey = () => 'treeMidDepth';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, lodUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + HERO_HIDE_PARS)
      .replace(HERO_HIDE[0], HERO_HIDE[1]);
  };
  return mat;
}

// Alpha to coverage only smooths card edges with MSAA; without it the plain alpha test is cheaper.
function makeMaterial(map, tier, heroHide = null) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, map, alphaTest: 0.44, side: THREE.DoubleSide, alphaToCoverage: tier.msaa > 0 });
  patchMaterial(mat, {
    toonWrap: 0.48, toonLo: 0.14, toonHi: 0.56,
    uniforms: heroHide || undefined,
    vertexPars: 'attribute vec3 aCrown; varying vec3 vCrown; varying vec3 vWorldN;' + (heroHide ? HERO_HIDE_PARS : ''),
    vertex: [
      ...(heroHide ? [HERO_HIDE] : []),
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


export class Trees {
  constructor(worldData, tier, renderer) {
    this.worldData = worldData;
    this.hf = worldData.hf;
    this.renderer = renderer;
    this._heroMeshes = [];
    this.group = new THREE.Group();
    this.lodCenter = new THREE.Vector3(1e9, 0, 1e9);
    // Shared by the mid, mid-depth and impostor materials: the cell-flag texture says which cells draw as hero or
    // mid, so each tree draws at exactly one level. The lake reflection draws impostors only (hero and mid stay out
    // of it for draw calls), so there uTreeReflect turns the hide off and nearby trees reflect as impostors.
    this.lodUniforms = {
      uTreeCells: { value: null },
      uTreeCellOrigin: { value: new THREE.Vector2() },
      uTreeReflect: { value: 0 },
    };
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._sc = new THREE.Vector3(); this._p = new THREE.Vector3();
    this.stats = { hero: 0, mid: 0, impostor: 0, nearCells: 0, farCells: 0, cullShown: 0, cullTotal: 0, cullMs: 0, cullRuns: 0 };
    // Set by the system: the view the per-tree cull keeps instances for.
    this.camera = null;
    this._cullPos = new THREE.Vector3(1e9, 0, 1e9);
    this._cullQuat = new THREE.Quaternion();
    this._cullProj = new Float32Array(16);
    this._cullDirty = true;
    this._frustum = new THREE.Frustum();
    this._planes = new Float32Array(24);
    this._pm = new THREE.Matrix4();
    withLocalRandom(() => {
      this.atlas = fluffyAtlas();
      this.material = makeMaterial(this.atlas, tier);
      this._build(tier);
    }, RNG_CALLS_CTOR);
  }

  buildHeroOaks() {
    if (this._heroMeshes.length) return;
    withLocalRandom(() => this._buildHeroOaks(this.worldData.placements.heroOaks || []), RNG_CALLS_HERO_OAKS);
  }

  get drawnCount() {
    return this.trees.length;
  }

  get canonicalCount() {
    return this.worldData.placements.trees.length;
  }

  /** Far impostor batches (one Mesh per far cell); the lake reflection puts these on its layer. */
  get impostorBatches() {
    return this._far;
  }

  _build(tier) {
    // Draw a rank-based subset of the canonical post-edit tree placements; collision uses the full canonical list in WorldData.
    this.trees = selectByRank(this.worldData.placements.trees, tier.trees);
    this.heroR = tier.treeHeroR;
    this.midR = tier.treeMidR;
    this.bushR = tier.treeBushR ?? this.midR;
    this.castShadows = tier.treeShadows !== false;
    const heroLod = tier.treeDetail >= 2 ? 2 : 1;
    this.heroGeo = KINDS.map((k) => k.hero(heroLod));
    this.midGeo = KINDS.map((k) => k.mid(0));
    this.midGeoFine = KINDS.map((k) => k.mid(1));
    this.midFineR = tier.treeMidFineR ?? 0;

    this.midMaterial = makeMaterial(this.atlas, tier, this.lodUniforms);
    this.midDepth = makeMidDepthMaterial(this.atlas, this.lodUniforms);
    this.nearCells = groupIntoCells(this.trees, NEAR_CELL);
    this.heroCells = groupIntoCells(this.trees, HERO_CELL);
    this._hero = new Map();
    this._mid = new Map();
    this._heroActive = new Map();
    this._midActive = new Map();
    this._heroWant = new Map();
    this._midWant = new Map();
    this.lodCenter.set(1e9, 0, 1e9);
    this._buildCellFlags();

    const impKinds = KINDS.filter((k) => k.imp >= 0);
    this.impAtlas = bakeImpostorAtlas(this.renderer, impKinds.map((k) => this.midGeoFine[KINDS.indexOf(k)]), this.atlas, tier.treeAtlas);
    this.impMaterial = makeImpostorMaterial(this.impAtlas, this.lodUniforms);
    this._buildFar();
  }

  // One texel per 32 m cell over the tree bounds (plus a border so 64 m cell centres stay inside): red = hero cell
  // active, green = the 64 m mid cell around it active. The mid and impostor shaders hide instances by these flags,
  // so the GPU hide rule always matches the batches the CPU shows, hysteresis included.
  _buildCellFlags() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const c of this.heroCells.values()) {
      x0 = Math.min(x0, c.ix); z0 = Math.min(z0, c.iz); x1 = Math.max(x1, c.ix); z1 = Math.max(z1, c.iz);
    }
    if (x0 > x1) { x0 = z0 = 0; x1 = z1 = 0; }
    x0 -= 2; z0 -= 2; x1 += 2; z1 += 2;
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    const tex = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._cellFlags = { tex, x0, z0, w, h };
    this.lodUniforms.uTreeCells.value = tex;
    this.lodUniforms.uTreeCellOrigin.value.set(x0, z0);
  }

  _writeCellFlags() {
    const { tex, x0, z0, w } = this._cellFlags;
    const data = tex.image.data;
    data.fill(0);
    for (const b of this._heroActive.values()) {
      data[((Math.floor(b.cz / HERO_CELL) - z0) * w + Math.floor(b.cx / HERO_CELL) - x0) * 4] = 255;
    }
    const k = NEAR_CELL / HERO_CELL;
    for (const b of this._midActive.values()) {
      const ix = Math.floor(b.cx / NEAR_CELL) * k - x0, iz = Math.floor(b.cz / NEAR_CELL) * k - z0;
      for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) data[((iz + a) * w + ix + c) * 4 + 1] = 255;
    }
    tex.needsUpdate = true;
  }

  _buildFar() {
    const quad = impostorQuad();
    this._quad = quad;
    this._far = [];
    this._farTotal = 0;
    const cells = groupIntoCells(this.trees, FAR_CELL, { filter: (t) => !t.bush });
    for (const cell of cells.values()) {
      const n = cell.count;
      const pos = new Float32Array(n * 3), scl = new Float32Array(n * 2), rot = new Float32Array(n);
      const kind = new Float32Array(n), tint = new Float32Array(n * 3), near = new Float32Array(n * 2);
      let j = 0;
      for (let v = 0; v < KINDS.length; v++) {
        for (const i of cell.bySpecies[v]) {
          const t = this.trees[i];
          pos[j * 3] = t.x; pos[j * 3 + 1] = t.y; pos[j * 3 + 2] = t.z;
          scl[j * 2] = t.s * t.sx; scl[j * 2 + 1] = t.s;
          rot[j] = t.rot;
          kind[j] = KINDS[v].imp;
          tint.set(t.tint, j * 3);
          near[j * 2] = (Math.floor(t.x / NEAR_CELL) + 0.5) * NEAR_CELL;
          near[j * 2 + 1] = (Math.floor(t.z / NEAR_CELL) + 0.5) * NEAR_CELL;
          j++;
        }
      }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', quad.attributes.position);
      g.setAttribute('normal', quad.attributes.normal);
      g.setIndex(quad.index);
      const add = (name, arr, size) => g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size).onUpload(dropArray));
      add('aPos', pos, 3); add('aScale', scl, 2); add('aRot', rot, 1); add('aKind', kind, 1); add('aTint', tint, 3); add('aCell', near, 2);
      g.instanceCount = n;
      const bs = cellBoundingSphere(cell, SWAY_PAD);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(bs.x, bs.y, bs.z), bs.r);
      const mesh = new THREE.Mesh(g, this.impMaterial);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      this._far.push(mesh);
      this.group.add(mesh);
      this._farTotal += n;
    }
    this.stats.farCells = this._far.length;
    this.setReflectionTrees();
  }

  // Instance attributes keep a source copy: the per-tree cull rewrites the live buffers with on-screen trees first.
  _instanceData(idx, geoSphere) {
    const n = idx.length;
    const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3), hcell = new Float32Array(n * 2);
    const spheres = new Float32Array(n * 4);
    const m = this._m4, q = this._q, sc = this._sc, p = this._p;
    const gc = geoSphere.center;
    for (let j = 0; j < n; j++) {
      const t = this.trees[idx[j]];
      q.setFromAxisAngle(UP, t.rot);
      m.compose(p.set(t.x, t.y, t.z), q, sc.set(t.s * t.sx, t.s, t.s * t.sx));
      m.toArray(mats, j * 16);
      cols.set(t.tint, j * 3);
      hcell[j * 2] = (Math.floor(t.x / HERO_CELL) + 0.5) * HERO_CELL;
      hcell[j * 2 + 1] = (Math.floor(t.z / HERO_CELL) + 0.5) * HERO_CELL;
      p.copy(gc).applyMatrix4(m);
      spheres[j * 4] = p.x; spheres[j * 4 + 1] = p.y; spheres[j * 4 + 2] = p.z;
      spheres[j * 4 + 3] = geoSphere.radius * t.s * Math.max(t.sx, 1) + SWAY_PAD;
    }
    const live = (arr, size) => new THREE.InstancedBufferAttribute(arr.slice(), size).setUsage(THREE.DynamicDrawUsage);
    return {
      n,
      spheres,
      src: [mats, cols, hcell],
      matrix: live(mats, 16),
      color: live(cols, 3),
      heroCell: live(hcell, 2),
    };
  }

  _makeBatch(cell, hero) {
    const batch = { meshes: [], on: false, bushOn: true, shadow: false, fine: false, cx: cell.cx, cz: cell.cz, size: cell.size, count: cell.count, bushes: 0 };
    const bs = cellBoundingSphere(cell, SWAY_PAD);
    const sphere = new THREE.Sphere(new THREE.Vector3(bs.x, bs.y, bs.z), bs.r);
    for (let v = 0; v < KINDS.length; v++) {
      const idx = cell.bySpecies[v];
      if (!idx.length) continue;
      const d = this._instanceData(idx, (hero ? this.heroGeo[v] : this.midGeoFine[v]).boundingSphere);
      let geo, midViews = null;
      if (hero) {
        geo = this.heroGeo[v];
      } else {
        // Per-batch geometry views (coarse and fine puffs): the shared mid mesh plus which 32 m hero cell each
        // instance sits in.
        const view = (src) => {
          const g = new THREE.BufferGeometry();
          for (const name in src.attributes) g.setAttribute(name, src.attributes[name]);
          g.setIndex(src.index);
          g.setAttribute('aHeroCell', d.heroCell);
          return g;
        };
        geo = view(this.midGeo[v]);
        midViews = [geo, view(this.midGeoFine[v])];
      }
      const mesh = new THREE.InstancedMesh(geo, hero ? this.material : this.midMaterial, d.n);
      mesh.instanceMatrix = d.matrix;
      mesh.instanceColor = d.color;
      mesh.boundingSphere = sphere;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      if (!hero) {
        mesh.customDepthMaterial = this.midDepth;
        mesh.userData.views = midViews;
      }
      mesh.userData.bush = v === 3;
      this._initCull(mesh, d, hero);
      if (v === 3) batch.bushes = d.n;
      batch.meshes.push(mesh);
    }
    return batch;
  }

  _initCull(mesh, d, hero) {
    const attrs = hero ? [d.matrix, d.color] : [d.matrix, d.color, d.heroCell];
    const cull = { n: d.n, shown: d.n, spheres: d.spheres, src: d.src, attrs, order: new Int32Array(d.n), sameUpTo: d.n };
    mesh.userData.cull = cull;
    // The shadow pass draws every instance (casters off screen still shade what is on it); the main and depth
    // passes draw only the on-screen head of the buffer.
    mesh.onBeforeShadow = () => { mesh.count = cull.n; };
    mesh.onAfterShadow = () => { mesh.count = cull.shown; };
  }

  // Partitions each shown hero/mid instanced mesh so its on-screen trees come first and draws only those.
  _cull(force) {
    const cam = this.camera;
    if (!cam) return;
    cam.updateMatrixWorld();
    const pe = cam.projectionMatrix.elements, cp = this._cullProj;
    let projChanged = false;
    for (let i = 0; i < 16; i++) if (pe[i] !== cp[i]) { projChanged = true; cp[i] = pe[i]; }
    const moved = cam.position.distanceToSquared(this._cullPos) > CULL_MOVE * CULL_MOVE;
    const turned = cam.quaternion.angleTo(this._cullQuat) > CULL_TURN;
    if (!force && !this._cullDirty && !projChanged && !moved && !turned) return;
    const t0 = performance.now();
    this._cullDirty = false;
    this._cullPos.copy(cam.position);
    this._cullQuat.copy(cam.quaternion);
    this._frustum.setFromProjectionMatrix(this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const planes = this._planes;
    this._frustum.planes.forEach((pl, k) => {
      planes[k * 4] = pl.normal.x; planes[k * 4 + 1] = pl.normal.y; planes[k * 4 + 2] = pl.normal.z; planes[k * 4 + 3] = pl.constant;
    });
    const ex = cam.position.x, ey = cam.position.y, ez = cam.position.z;
    let shown = 0, total = 0;
    for (const active of [this._heroActive, this._midActive]) {
      for (const batch of active.values()) {
        for (const mesh of batch.meshes) {
          if (!mesh.parent) continue;
          const c = mesh.userData.cull;
          c.shown = partitionInFrustum(c.spheres, c.n, planes, ex, ey, ez, CULL_MARGIN, CULL_SLOPE, c.order);
          this._writeOrder(mesh, c);
          mesh.count = c.shown;
          shown += c.shown;
          total += c.n;
        }
      }
    }
    const st = this.stats;
    st.cullShown = shown;
    st.cullTotal = total;
    st.cullMs += performance.now() - t0;
    st.cullRuns++;
  }

  _writeOrder(mesh, c) {
    const { order, n, shown } = c;
    // Casting meshes need the whole buffer (shadow pass); the others only draw, so only upload, the on-screen head.
    const upto = mesh.castShadow ? n : shown;
    let lead = 0;
    while (lead < upto && order[lead] === lead) lead++;
    // The live buffer already matches the source this far: nothing to write.
    if (lead === upto && upto <= c.sameUpTo) return;
    for (let a = 0; a < c.attrs.length; a++) {
      const attr = c.attrs[a], src = c.src[a], dst = attr.array, size = attr.itemSize;
      for (let k = 0; k < upto; k++) {
        const j = order[k] * size, o = k * size;
        for (let e = 0; e < size; e++) dst[o + e] = src[j + e];
      }
      attr.clearUpdateRanges();
      if (upto < n) attr.addUpdateRange(0, upto * size);
      attr.needsUpdate = true;
    }
    c.sameUpTo = lead === upto ? Math.max(upto, c.sameUpTo) : lead;
  }

  _setFine(batch, fine) {
    if (batch.fine === fine) return;
    batch.fine = fine;
    for (const mesh of batch.meshes) mesh.geometry = mesh.userData.views[fine ? 1 : 0];
  }

  _show(batch, on, bushOn, shadow, midShadow) {
    if (batch.on === on && batch.bushOn === bushOn && batch.shadow === shadow) return;
    this._cullDirty = true;
    batch.on = on;
    batch.bushOn = bushOn;
    batch.shadow = shadow;
    for (const mesh of batch.meshes) {
      const vis = on && (bushOn || !mesh.userData.bush);
      // Hidden batches leave the scene graph so they cost no per-frame matrix update or cull test.
      if (vis && !mesh.parent) this.group.add(mesh);
      else if (!vis && mesh.parent) this.group.remove(mesh);
      // Mid bushes are too small to show a shadow at that range but cost a shadow draw call per cell.
      mesh.castShadow = shadow && (!midShadow || !mesh.userData.bush);
    }
  }

  // Opts the impostor batches near the lake into the planar reflection pass (far cells beyond REFL_TREE_REACH of the
  // shore barely show in it but cost a draw call each). The reflection camera sees only LAYER_REFLECT, so a camera
  // without layer 0 is the reflection. Every far mesh carries the hook: three.js re-uploads material uniforms at the
  // first draw of the shared material in each render() call, so whichever impostor batch draws first must set the flag.
  setReflectionTrees() {
    const u = this.lodUniforms.uTreeReflect;
    const lake = this.worldData.region?.lake;
    const onBefore = (renderer, scene, camera) => {
      u.value = camera.layers.isEnabled(0) ? 0 : 1;
    };
    for (const mesh of this._far) {
      mesh.onBeforeRender = onBefore;
      const s = mesh.geometry.boundingSphere;
      if (lake && Math.hypot(s.center.x - lake.x, s.center.z - lake.z) - s.radius > Math.max(lake.rx, lake.rz) + REFL_TREE_REACH) continue;
      mesh.layers.enable(LAYER_REFLECT);
    }
  }

  _disposeInstances() {
    for (const map of [this._hero, this._mid]) {
      for (const batch of map?.values() || []) {
        for (const mesh of batch.meshes) {
          mesh.removeFromParent();
          for (const g of mesh.userData.views || []) g.dispose();
          mesh.dispose();
        }
      }
    }
    this._hero = new Map();
    this._mid = new Map();
    for (const mesh of this._far || []) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this._far = [];
    for (const g of [...(this.heroGeo || []), ...(this.midGeo || []), ...(this.midGeoFine || [])]) g.dispose();
    this._quad?.dispose();
    this.impMaterial?.dispose();
    this.midMaterial?.dispose();
    this.midDepth?.dispose();
    this.impAtlas?.dispose();
    this._cellFlags?.tex.dispose();
    for (const im of this._heroMeshes) {
      this.group.remove(im);
      im.geometry.dispose();
      im.dispose();
    }
    this._heroMeshes = [];
  }

  _sync(cells, batches, active, want, hero, x, z) {
    for (const [key, batch] of active) {
      if (!want.has(key)) this._show(batch, false, true, false, false);
    }
    active.clear();
    let count = 0, imp = 0;
    for (const key of want.keys()) {
      let batch = batches.get(key);
      if (!batch) {
        const cell = cells.get(key);
        batch = withLocalRandom(() => this._makeBatch(cell, hero));
        batches.set(key, batch);
      }
      const d = cellDistance(batch.cx, batch.cz, batch.size, x, z);
      // The shadow pass culls casters against the shadow camera's own box, so every active batch may cast.
      const shadow = this.castShadows;
      const bushOn = d < this.bushR;
      // Mid cells near the camera use the rounder puffs; same hysteresis as the levels.
      if (!hero) this._setFine(batch, d < this.midFineR || (batch.fine && d < lodExitRadius(this.midFineR)));
      this._show(batch, true, bushOn, shadow, !hero);
      active.set(key, batch);
      count += bushOn ? batch.count : batch.count - batch.bushes;
      imp += batch.count - batch.bushes;
    }
    return { count, imp };
  }

  update(camPos, force = false) {
    this._updateLod(camPos, force);
    this._cull(force);
  }

  _updateLod(camPos, force) {
    const dx = camPos.x - this.lodCenter.x, dz = camPos.z - this.lodCenter.z;
    if (!force && dx * dx + dz * dz < LOD_STEP * LOD_STEP) return;
    this.lodCenter.copy(camPos);
    const x = camPos.x, z = camPos.z;
    // Hero: 32 m cells inside heroR. Mid: 64 m cells inside midR; their instances that sit in an active hero cell
    // are hidden in the mid shader. Impostors: everything else, hidden in the impostor shader in active mid cells.
    // Each level enters at its radius and leaves at lodExitRadius (hysteresis).
    const heroWant = cellsInRadius(this.heroCells, HERO_CELL, x, z, this.heroR, lodExitRadius(this.heroR), this._heroActive, this._heroWant);
    const midWant = cellsInRadius(this.nearCells, NEAR_CELL, x, z, this.midR, lodExitRadius(this.midR), this._midActive, this._midWant);
    const h = this._sync(this.heroCells, this._hero, this._heroActive, heroWant, true, x, z);
    const m = this._sync(this.nearCells, this._mid, this._midActive, midWant, false, x, z);
    this._writeCellFlags();
    const st = this.stats;
    st.hero = h.count;
    st.mid = m.count - h.count;
    st.nearCells = midWant.size;
    st.impostor = this._farTotal - m.imp;
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
    im.computeBoundingSphere();
    im.boundingSphere.radius += SWAY_PAD;
    im.castShadow = this.castShadows; im.receiveShadow = true;
    this._heroMeshes.push(im);
    this.group.add(im);
  }

  setTier(tier) {
    const a2c = tier.msaa > 0;
    if (this.material.alphaToCoverage !== a2c) {
      this.material.alphaToCoverage = a2c;
      this.material.needsUpdate = true;
    }
    withLocalRandom(() => {
      this._disposeInstances();
      this._build(tier);
      this._buildHeroOaks(this.worldData.placements.heroOaks || []);
    });
  }

  dispose() {
    this._disposeInstances();
    this.group.removeFromParent();
    this.material.dispose();
    this.atlas.dispose();
  }

  collide(pos, radius = 0.4) {
    this.worldData.collideTrees(pos, radius);
  }
}

export function createTrees(ctx) {
  const trees = new Trees(ctx.data, ctx.tier, ctx.renderer);
  trees.camera = ctx.camera;
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
