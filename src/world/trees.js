import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { selectByRank } from './worldData.js';
import { mulberry32 } from './biome.js';
import { fluffyAtlas, fluffyBroadleaf, fluffyPine, fluffyLarch, fluffyBush } from './fluffy.js';
import { groupIntoCells, cellBoundingSphere, nearCellsInRange, LOD_HERO, LOD_MID } from './treeChunks.js';
import { bakeImpostorAtlas, makeImpostorMaterial, impostorQuad } from './treeImpostor.js';

// Stylized volumetric fluffy trees (oak, round maple, alpine spruce, bush, birch/poplar, golden larch) on a static
// LOD ladder: hero (sculpted painterly cards) and mid (smooth low-poly cores) per species in 64 m near cells, and
// one merged impostor batch per 512 m far cell. Every batch is built once and culled by three.js; walking only
// toggles which near cells are visible and moves the impostor hide radius.

// Far cells are 512 m (not 256 m) so the impostor batches stay near 20-25 draw calls per pass.
export const NEAR_CELL = 64;
export const FAR_CELL = 512;
// Wind sway and crowns that overhang their cell edge.
const SWAY_PAD = 2;
// Re-pick near-cell LODs after the camera moved this far (metres).
const LOD_STEP = 4;

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
  { name: 'oak',    imp: 0, hero: (lod) => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075], lod }), mid: () => fluffyBroadleaf(11, { kind: 'oak',    color: [0.13, 0.39, 0.075], lod: 0, lowPoly: true, sparse: true }) },
  { name: 'round',  imp: 1, hero: (lod) => fluffyBroadleaf(23, { kind: 'round',  color: [0.16, 0.42, 0.09], lod }),  mid: () => fluffyBroadleaf(23, { kind: 'round',  color: [0.18, 0.43, 0.09], lod: 0, lowPoly: true, sparse: true }) },
  { name: 'pine',   imp: 2, hero: (lod) => fluffyPine(37, { color: [0.065, 0.24, 0.10], lod }),                       mid: () => fluffyPine(37, { color: [0.065, 0.24, 0.10], lod: 0, lowPoly: true, sparse: true }) },
  { name: 'bush',   imp: -1, hero: (lod) => fluffyBush(61, { lod }),                                                  mid: () => fluffyBush(61, { lod: 0, lowPoly: true, sparse: true }) },
  { name: 'poplar', imp: 3, hero: (lod) => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], bark: [0.76, 0.73, 0.67], lod }), mid: () => fluffyBroadleaf(51, { kind: 'poplar', color: [0.18, 0.46, 0.10], bark: [0.76, 0.73, 0.67], lod: 0, lowPoly: true, sparse: true }) },
  { name: 'larch',  imp: 4, hero: (lod) => fluffyLarch(73, { color: [0.23, 0.38, 0.11], bark: [0.30, 0.20, 0.13], lod }), mid: () => fluffyLarch(73, { color: [0.23, 0.38, 0.11], bark: [0.30, 0.20, 0.13], lod: 0, lowPoly: true, sparse: true }) },
];

// Static instance data is uploaded once; the CPU copy is not needed afterwards.
function dropArray() {
  this.array = null;
}

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


export class Trees {
  constructor(worldData, tier, renderer) {
    this.worldData = worldData;
    this.hf = worldData.hf;
    this.renderer = renderer;
    this._heroMeshes = [];
    this.group = new THREE.Group();
    this.lodCenter = new THREE.Vector3(1e9, 0, 1e9);
    // Shared with the impostor material: impostors hide inside the mid radius around the main camera's LOD centre,
    // also in the reflection pass, so each tree draws at exactly one level whichever camera renders.
    this.lodUniforms = { uTreeLodCenter: { value: new THREE.Vector3(1e9, 0, 1e9) }, uTreeMidR: { value: 0 } };
    this.stats = { hero: 0, mid: 0, impostor: 0, nearCells: 0, farCells: 0 };
    withLocalRandom(() => {
      this.atlas = fluffyAtlas();
      this.material = makeMaterial(this.atlas);
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
    this.lodUniforms.uTreeMidR.value = this.midR;
    const heroLod = tier.treeDetail >= 2 ? 2 : 1;
    this.heroGeo = KINDS.map((k) => k.hero(heroLod));
    this.midGeo = KINDS.map((k) => k.mid());

    this.nearCells = groupIntoCells(this.trees, NEAR_CELL);
    this._near = new Map();
    this._active = new Map();
    this._want = new Map();
    this.lodCenter.set(1e9, 0, 1e9);

    const impKinds = KINDS.filter((k) => k.imp >= 0);
    this.impAtlas = bakeImpostorAtlas(this.renderer, impKinds.map((k) => this.heroGeo[KINDS.indexOf(k)]), this.atlas, tier.treeAtlas);
    this.impMaterial = makeImpostorMaterial(this.impAtlas, this.lodUniforms);
    this._buildFar();
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
  }

  _makeNear(cell) {
    const batch = { hero: [], mid: [], lod: -1, bushOn: true, cx: cell.cx, cz: cell.cz };
    const bs = cellBoundingSphere(cell, SWAY_PAD);
    const sphere = new THREE.Sphere(new THREE.Vector3(bs.x, bs.y, bs.z), bs.r);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let v = 0; v < KINDS.length; v++) {
      const idx = cell.bySpecies[v];
      if (!idx.length) continue;
      const n = idx.length;
      const mats = new Float32Array(n * 16), cols = new Float32Array(n * 3);
      for (let j = 0; j < n; j++) {
        const t = this.trees[idx[j]];
        q.setFromAxisAngle(up, t.rot);
        m.compose(p.set(t.x, t.y, t.z), q, sc.set(t.s * t.sx, t.s, t.s * t.sx));
        m.toArray(mats, j * 16);
        cols.set(t.tint, j * 3);
      }
      // Hero and mid meshes share one instance buffer, so it is uploaded once.
      const im = new THREE.InstancedBufferAttribute(mats, 16).onUpload(dropArray);
      const ic = new THREE.InstancedBufferAttribute(cols, 3).onUpload(dropArray);
      for (const [list, geo] of [[batch.hero, this.heroGeo[v]], [batch.mid, this.midGeo[v]]]) {
        const mesh = new THREE.InstancedMesh(geo, this.material, n);
        mesh.instanceMatrix = im;
        mesh.instanceColor = ic;
        mesh.boundingSphere = sphere;
        mesh.castShadow = this.castShadows;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.userData.bush = v === 3;
        list.push(mesh);
      }
      if (v === 3) batch.bushes = n;
    }
    batch.count = cell.count;
    batch.imp = cell.count - (batch.bushes || 0);
    return batch;
  }

  _setLod(batch, lod, bushOn = true) {
    if (batch.lod === lod && batch.bushOn === bushOn) return;
    batch.lod = lod;
    batch.bushOn = bushOn;
    // Hidden batches leave the scene graph so they cost no per-frame matrix update or cull test.
    const show = (mesh, on) => {
      if (on && !mesh.parent) this.group.add(mesh);
      else if (!on && mesh.parent) this.group.remove(mesh);
    };
    for (const mesh of batch.hero) show(mesh, lod === LOD_HERO && (bushOn || !mesh.userData.bush));
    for (const mesh of batch.mid) show(mesh, lod === LOD_MID && (bushOn || !mesh.userData.bush));
  }

  _disposeInstances() {
    for (const batch of this._near?.values() || []) {
      for (const mesh of [...batch.hero, ...batch.mid]) {
        mesh.removeFromParent();
        mesh.dispose();
      }
    }
    this._near = new Map();
    for (const mesh of this._far || []) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this._far = [];
    for (const g of [...(this.heroGeo || []), ...(this.midGeo || [])]) g.dispose();
    this._quad?.dispose();
    this.impMaterial?.dispose();
    this.impAtlas?.dispose();
    for (const im of this._heroMeshes) {
      this.group.remove(im);
      im.geometry.dispose();
      im.dispose();
    }
    this._heroMeshes = [];
  }

  update(camPos, force = false) {
    const dx = camPos.x - this.lodCenter.x, dz = camPos.z - this.lodCenter.z;
    if (!force && dx * dx + dz * dz < LOD_STEP * LOD_STEP) return;
    this.lodCenter.copy(camPos);
    this.lodUniforms.uTreeLodCenter.value.copy(camPos);
    const want = nearCellsInRange(this.nearCells, NEAR_CELL, camPos.x, camPos.z, this.heroR, this.midR, this._want);
    for (const [key, batch] of this._active) {
      if (!want.has(key)) this._setLod(batch, -1);
    }
    this._active.clear();
    const st = this.stats;
    st.hero = 0; st.mid = 0; st.nearCells = want.size;
    let nearImp = 0;
    for (const [key, lod] of want) {
      let batch = this._near.get(key);
      if (!batch) {
        const cell = this.nearCells.get(key);
        batch = withLocalRandom(() => this._makeNear(cell));
        this._near.set(key, batch);
      }
      const bushOn = Math.hypot(batch.cx - camPos.x, batch.cz - camPos.z) < this.bushR;
      this._setLod(batch, lod, bushOn);
      this._active.set(key, batch);
      const drawn = bushOn ? batch.count : batch.imp;
      if (lod === LOD_HERO) st.hero += drawn; else st.mid += drawn;
      nearImp += batch.imp;
    }
    st.impostor = this._farTotal - nearImp;
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
