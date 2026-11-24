import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { LAYER_NO_REFLECT } from './water.js';
import { TILE_PACK_GLSL, TileRingAtlas } from './grassTiles.js';

// Tiled GPU meadow grass & botanical species-drifted wildflowers:
// - Static per-blade fields (height, normal, density, clump, base colour) bake once
//   on tile entry into an RGBA32UI atlas (no float-linear or float-RT extension needed)
// - Vertex shader reads all static fields with one texelFetch and evaluates live wind,
//   bend, player push, smooth near/far LOD fade, and time-of-day tint
// - Tiles carry padded bounds for frustum culling; far tiles draw fewer, wider, 3-tri blades

function bladeGeometry(segs = 4) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < segs; i++) {
    const y = i / segs;
    pos.push(-0.5, y, 0, 0.5, y, 0);
  }
  pos.push(0, 1, 0);
  for (let i = 0; i < segs - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const t = (segs - 1) * 2;
  idx.push(t, t + 1, segs * 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const GRASS_BAKE_FRAG = /* glsl */ `
void main() {
  ivec2 localPx = gt_bakeTexel();
  highp uvec4 sc = texelFetch(uBakeScatter, localPx, 0);
  vec2 rawLocal = vec2(float(sc.x & 0xFFFFu), float(sc.x >> 16u)) / 65535.0 * uTileSize;
  vec2 localXZ = gt_applyFlip(rawLocal, uTileSize, uTileFlip);
  vec2 xz = uTileOrigin + localXZ;
  vec4 rnd = vec4(
    float(sc.y & 0xFFFFu), float(sc.y >> 16u),
    float(sc.z & 0xFFFFu), float(sc.z >> 16u)
  ) / 65535.0;

  float h = w_height(xz);
  vec3 tn = w_normal(xz, 1.0);
  vec4 bio = w_biome(xz);
  float trail = w_trail(xz);

  float dens = smoothstep(0.30, 0.58, tn.y);
  // Uneven trampled verge creeping onto soft dirt trail margins.
  dens *= 1.0 - smoothstep(0.28, 0.60, trail + (rnd.x - 0.5) * 0.30);
  dens *= 1.0 - 0.92 * w_yard(xz);
  float reedZone = (1.0 - smoothstep(0.2, 0.9, abs(h - uWaterLevel + 0.1))) * smoothstep(0.52, 0.74, textureLod(uNoiseTex, xz * 0.035 + 0.4, 0.0).r);
  dens *= max(smoothstep(uWaterLevel + 0.15, uWaterLevel + 1.0, h), reedZone);
  dens *= 1.0 - smoothstep(1050.0, 1300.0, h);
  // Keep cottage lawn lush while suppressing sparse blades under dense forest canopy.
  float cotMeadow = uAOSpot.z > 0.1 ? (1.0 - smoothstep(32.0, 52.0, length(xz - uAOSpot.xy))) : 0.0;
  float forestAmt = smoothstep(0.28, 0.66, bio.r) * (1.0 - cotMeadow);
  dens *= mix(1.0, 0.04, smoothstep(0.36, 0.74, forestAmt));

  vec4 clumpN = textureLod(uNoiseTex, xz * 0.055 + 0.19, 0.0);
  vec4 patchN = textureLod(uNoiseTex, xz * 0.014 + 0.63, 0.0);
  float clump = smoothstep(0.12, 0.78, clumpN.g * 0.65 + patchN.r * 0.35);
  dens *= max(smoothstep(0.05, 0.30, clumpN.g + 0.28), cotMeadow * 0.85);

  float pathEdge = smoothstep(0.04, 0.22, trail) * (1.0 - smoothstep(0.28, 0.46, trail));
  float plume = step(0.80, rnd.y) * smoothstep(0.42, 0.72, clumpN.a);
  float tall = mix(0.20, 0.60, max(bio.b * 0.55 + clump * 0.55, cotMeadow * 0.78)) * mix(0.62, 1.42, rnd.y);
  tall = mix(tall, 0.14 + 0.14 * rnd.y, forestAmt * 0.72);
  tall += pathEdge * (0.18 + 0.24 * rnd.x) + plume * 0.30 * (1.0 - forestAmt * 0.7);
  // Keep summit crest turf low so the lake vista stays clear.
  tall *= mix(1.0, 0.42, smoothstep(388.0, 412.0, h));
  tall *= mix(1.0, 0.55, smoothstep(700.0, 1050.0, h));
  tall = mix(tall, mix(1.15, 2.0, rnd.y), reedZone);

  float yaw = rnd.z * 6.2831853 + clumpN.r * 2.5;
  vec3 gcol = w_grassColor(xz, h);
  float hollow = smoothstep(0.48, 0.78, patchN.b);
  float dryTip = smoothstep(0.46, 0.82, patchN.g + rnd.y * 0.35 + plume * 0.52);
  float forestShade = smoothstep(0.4, 0.85, bio.r);
  highp uint reedBit = reedZone > 0.35 ? 1u : 0u;
  float bladeId = n_hash12(floor(xz * 100.0 + 0.5) * 0.01);

  highp uint w0 = gt_packHeight(h)
    | (gt_packU(dens, 255.0) << 20u)
    | (gt_packU(forestShade, 3.0) << 28u)
    | (0u << 30u)
    | (reedBit << 31u);
  highp uint w1 = gt_packU(tn.x * 0.5 + 0.5, 255.0)
    | (gt_packU(tn.z * 0.5 + 0.5, 255.0) << 8u)
    | (gt_packU(tall / GT_TALL_MAX, 255.0) << 16u)
    | ((gt_packU(fract(yaw / 6.2831853), 255.0) & 0xFFu) << 24u);
  highp uint w2 = gt_packRGB8Sqrt(gcol)
    | (gt_packU(dryTip, 15.0) << 24u)
    | (gt_packU(hollow, 15.0) << 28u);
  // Reserve seamWeight (6b) and secondCol (18b) as 0u for Slice 9b.
  highp uint w3 = gt_packU(bladeId, 255.0);

  outData = uvec4(w0, w1, w2, w3);
}
`;

const GRASS_VERTEX = /* glsl */ `
  vec2 localXZ = gt_applyFlip(aLocal, uTileSize, aTileInfo.zw);
  vec2 tileOrig = modelMatrix[3].xz;
  vec2 xz = tileOrig + localXZ;
  vec2 rel = xz - uCamXZ;
  float dist = length(rel);

  int lxIdx = gl_InstanceID % uSlotW;
  int lyIdx = gl_InstanceID / uSlotW;
  highp uvec4 td = texelFetch(uTileData, ivec2(int(aTileInfo.x + 0.5) + lxIdx, int(aTileInfo.y + 0.5) + lyIdx), 0);

  float h = gt_unpackHeight(td.x);
  float dens = float((td.x >> 20u) & 0xFFu) / 255.0;
  float forestShade = float((td.x >> 28u) & 0x3u) / 3.0;
  float reedFlag = float((td.x >> 31u) & 1u);

  float keep = 1.0 - smoothstep(uRadius * 0.68, uRadius, dist);
  // Fade near-only blades smoothly to 0 before the tile switches to the far 3-tri mesh.
  float isExtra = step(float(uFarCount) - 0.5, float(gl_InstanceID));
  float lodFade = 1.0 - isExtra * smoothstep(uLodStart, uLodEnd, dist);
  float scale = dens * keep * lodFade;

  vec3 transformed;
  if (scale <= 0.001) {
    transformed = vec3(localXZ.x, h - 1.0, localXZ.y);
    vGrassY = 0.0;
    vGrassWave = 0.0;
    vGrassForest = 0.0;
    vGrassCol = vec3(0.0);
    vGrassN = vec3(0.0, 1.0, 0.0);
  } else {
    float nx = (float(td.y & 0xFFu) / 255.0) * 2.0 - 1.0;
    float nz = (float((td.y >> 8u) & 0xFFu) / 255.0) * 2.0 - 1.0;
    vec3 tn = vec3(nx, sqrt(max(0.0, 1.0 - nx * nx - nz * nz)), nz);
    float tallStatic = (float((td.y >> 16u) & 0xFFu) / 255.0) * GT_TALL_MAX;
    float yaw = (float((td.y >> 24u) & 0xFFu) / 255.0) * 6.2831853;

    float isShortUnder = step(aRnd.x, 0.38) * (1.0 - smoothstep(22.0, 38.0, dist));
    float tall = mix(tallStatic, 0.14 + 0.15 * aRnd.y, isShortUnder * 0.80 * (1.0 - reedFlag));
    float height = tall * scale;
    float farWide = mix(1.0, uFarWidthScale, (1.0 - isExtra) * smoothstep(uLodStart, uLodEnd, dist));
    float width = mix(0.050, 0.088, isShortUnder) * mix(0.68, 1.42, aRnd.x) * (1.0 + dist * 0.028) * farWide;

    float y = position.y;
    vec2 fwd = vec2(cos(yaw), sin(yaw));
    vec2 sd = vec2(-fwd.y, fwd.x);
    float gust = texture(uNoiseTex, xz * 0.0082 - uWindDir * uTime * 0.042).r;
    float gust2 = texture(uNoiseTex, xz * 0.024 - uWindDir * uTime * 0.075 + 0.4).g;
    float wave = smoothstep(0.26, 0.76, gust * 0.72 + gust2 * 0.28);
    float flutter = sin(uTime * (2.0 + aRnd.y * 1.6) + aRnd.x * 6.28 + dot(xz, uWindDir) * 0.55) * 0.16;
    float bend = (0.10 + aRnd.y * 0.34) + (wave * 0.82 + flutter) * (0.28 + uWindStrength * 0.82);

    vec2 toP = xz - uPlayerXZ;
    float pd = length(toP);
    float push = 1.0 - smoothstep(0.2, 1.1, pd);
    vec2 bendDir = normalize(fwd * 0.48 + uWindDir * (0.25 + wave * 1.45) + (toP / max(pd, 0.01)) * push * 3.0);
    bend += push * 1.2;
    float c = y * y * bend;
    vec3 p;
    p.xz = localXZ + sd * position.x * width * (1.0 - y * 0.9) + bendDir * c * height * 0.8;
    p.y = h + y * height * (1.0 - min(c, 1.0) * 0.35) - 0.02;
    transformed = p;
    vGrassY = y;
    vGrassWave = wave;
    vGrassForest = forestShade;

    vec3 gcol = gt_unpackRGB8Sqrt(td.z);
    float dryTip = float((td.z >> 24u) & 0xFu) / 15.0;
    float hollow = (float((td.z >> 28u) & 0xFu) / 15.0) * (1.0 - wave * 0.55);
    gcol = mix(gcol, vec3(0.036, 0.20, 0.095), hollow * 0.62);
    vec3 tipBase = gcol * mix(0.96, 1.36, aRnd.y);
    vec3 tipWarm = mix(tipBase, vec3(0.62, 0.52, 0.16), dryTip * 0.56);
    tipWarm = mix(tipWarm * vec3(0.84, 0.92, 0.96), tipWarm * vec3(1.28, 1.22, 0.82) + vec3(0.04, 0.04, 0.0), wave);
    tipWarm = mix(tipWarm, tipWarm * vec3(1.18, 0.96, 0.72), max(uGolden, uDawn) * 0.45);
    vec3 baseCol = gcol * mix(0.68, 0.82, max(uDawn, uGolden)) * (0.86 + 0.24 * wave);
    vGrassCol = mix(baseCol, tipWarm, smoothstep(0.0, 1.0, y));
    vGrassCol *= 0.88 + 0.24 * aRnd.x;
    vGrassCol = mix(vGrassCol, mix(vec3(0.11, 0.22, 0.07), vec3(0.46, 0.44, 0.17), y), reedFlag);
    vGrassCol *= mix(1.0, 0.74, forestShade);
    vGrassN = normalize(tn + vec3(0.0, 0.42, 0.0));
  }
`;

// Fixed for every tier so a blade's root depends only on its tile and rank: switching tier
// changes how many ranks draw, never where a blade stands.
export const GRASS_LAYOUT = { tileSize: 8, slotW: 64, maxCount: 2432, seed: 1337 };
export const FLOWER_LAYOUT = { tileSize: 12, slotW: 32, maxCount: 1440, seed: 4242 };

function grassConfigFromTier(tier) {
  const radius = tier.grassRadius;
  const nearCount = Math.min(GRASS_LAYOUT.maxCount, tier.grassNear);
  const farCount = Math.min(nearCount, tier.grassFar);
  const nearLodDist = tier.grassNearLod;
  const lodStart = Math.max(8, nearLodDist - 6);
  const farWidthScale = tier.grassFarWidthScale;
  return { ...GRASS_LAYOUT, radius, nearCount, farCount, nearLodDist, lodStart, farWidthScale, bakeBudget: tier.vegBakeBudget };
}

export class Grass {
  constructor(renderer, tier, hf) {
    this.renderer = renderer;
    this.hf = hf || null;
    this.nearBaseGeo = bladeGeometry(4);
    this.farBaseGeo = bladeGeometry(2);
    this.mesh = new THREE.Group();
    this.mesh.layers.set(LAYER_NO_REFLECT);

    const cfg = grassConfigFromTier(tier);
    this.radius = cfg.radius;
    this.patch = cfg.radius * 2;
    this.cfg = cfg;
    this._lastCam = null;

    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uPlayerXZ: { value: new THREE.Vector2(1e5, 1e5) },
      uTileData: { value: null },
      uTileSize: { value: cfg.tileSize },
      uSlotW: { value: cfg.slotW },
      uFarCount: { value: cfg.farCount },
      uRadius: { value: cfg.radius },
      uLodStart: { value: cfg.lodStart },
      uLodEnd: { value: cfg.nearLodDist },
      uFarWidthScale: { value: cfg.farWidthScale },
    };

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        precision highp int;
        precision highp usampler2D;
        ${TILE_PACK_GLSL}
        attribute vec2 aLocal;
        attribute vec4 aRnd;
        attribute vec4 aTileInfo;
        uniform highp usampler2D uTileData;
        uniform vec2 uCamXZ;
        uniform vec2 uPlayerXZ;
        uniform float uTileSize;
        uniform int uSlotW;
        uniform int uFarCount;
        uniform float uRadius;
        uniform float uLodStart;
        uniform float uLodEnd;
        uniform float uFarWidthScale;
        varying float vGrassY;
        varying float vGrassWave;
        varying float vGrassForest;
        varying vec3 vGrassCol;
        varying vec3 vGrassN;
      `,
      vertex: [
        ['#include <begin_vertex>', GRASS_VERTEX],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: /* glsl */ `
        varying float vGrassY;
        varying float vGrassWave;
        varying float vGrassForest;
        varying vec3 vGrassCol;
        varying vec3 vGrassN;
      `,
      fragment: [
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          diffuseColor.rgb = vGrassCol;
          diffuseColor.rgb *= mix(0.84, 1.0, smoothstep(0.0, 0.45, vGrassY));
        `],
        ['#include <normal_fragment_begin>', /* glsl */ `
          #include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(vGrassN, 0.0)).xyz);
        `],
        ['#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>
          {
            vec3 Vw = normalize(vWPos - cameraPosition);
            float back = pow(max(dot(Vw, uLightDir), 0.0), 3.6);
            float lowSun = max(uGolden, uDawn);
            vec3 sheenTint = mix(vec3(1.0, 1.0, 0.90), vec3(1.08, 0.80, 0.48), lowSun);
            float litK = w_sunVis * smoothstep(-0.02, 0.08, uLightDir.y);
            totalEmissiveRadiance += vGrassCol * uLightColor * sheenTint * (back * 0.75 + 0.03 + vGrassWave * 0.05) * vGrassY * litK;
            float fresG = pow(1.0 - abs(dot(normalize(vGrassN), -Vw)), 2.0);
            vec3 dewCol = mix(vec3(0.30, 0.22, 0.16), vec3(0.92, 0.56, 0.34), uDawn);
            totalEmissiveRadiance += (vGrassCol * dewCol + vec3(0.10, 0.055, 0.025) * uDawn) * (0.36 + 0.72 * fresG) * (0.28 + 0.72 * vGrassY) * lowSun * (1.0 - litK * 0.38);
            float duskOnly = uDusk * (1.0 - uNight * 0.75);
            totalEmissiveRadiance += (vGrassCol * vec3(0.18, 0.26, 0.58) + vec3(0.008, 0.012, 0.028)) * (0.25 + 0.75 * fresG) * (0.30 + 0.70 * vGrassY) * duskOnly * 0.14;
            totalEmissiveRadiance += (vGrassCol * vec3(0.20, 0.34, 0.62) + vec3(0.005, 0.010, 0.022)) * (0.20 + 0.80 * fresG) * smoothstep(0.25, 1.0, vGrassY) * uNight * 0.085;
            totalEmissiveRadiance += vGrassCol * vec3(0.9, 1.0, 0.6) * vGrassForest * 0.04 * length(uLightColor) * (1.0 - uNight);
            totalEmissiveRadiance += (vGrassCol * 1.15 + vec3(0.03, 0.018, 0.008)) * w_warmSpill(vWPos) * (0.55 + 0.65 * vGrassY);
          }
        `],
      ],
    });
    this.material = mat;
    this.atlas = null;
    this._buildAtlas(cfg);
  }

  _buildAtlas(cfg) {
    if (this.atlas) this.atlas.dispose();
    this.cfg = cfg;
    this.radius = cfg.radius;
    this.patch = cfg.radius * 2;
    this.atlas = new TileRingAtlas({
      renderer: this.renderer,
      hf: this.hf,
      tileSize: cfg.tileSize,
      radius: cfg.radius,
      nearLodDist: cfg.nearLodDist,
      slotW: cfg.slotW,
      maxCount: cfg.maxCount,
      nearCount: cfg.nearCount,
      farCount: cfg.farCount,
      offscreenBakeBudget: cfg.bakeBudget,
      seed: cfg.seed,
      clumped: true,
      boundsPad: { xz: 1.8, yDown: 0.6, yUp: 2.5 },
      isTileEmpty: (_tx, _tz, _s, b) => b.groundMaxY < WORLD.waterLevel - 1.0,
      receiveShadow: true,
      material: this.material,
      nearBaseGeo: this.nearBaseGeo,
      farBaseGeo: this.farBaseGeo,
      bakeFragBody: GRASS_BAKE_FRAG,
    });
    this.mesh.add(this.atlas.group);
    this.uniforms.uTileData.value = this.atlas.texture;
    this.uniforms.uTileSize.value = cfg.tileSize;
    this.uniforms.uSlotW.value = cfg.slotW;
    this.uniforms.uFarCount.value = cfg.farCount;
    this.uniforms.uRadius.value = cfg.radius;
    this.uniforms.uLodStart.value = cfg.lodStart;
    this.uniforms.uLodEnd.value = cfg.nearLodDist;
    this.uniforms.uFarWidthScale.value = cfg.farWidthScale;
  }

  update(cameraOrPos, playerPos) {
    const camPos = cameraOrPos && cameraOrPos.isCamera ? cameraOrPos.position : cameraOrPos;
    this.uniforms.uCamXZ.value.set(camPos.x, camPos.z);
    if (playerPos) this.uniforms.uPlayerXZ.value.set(playerPos.x, playerPos.z);
    this._lastCam = cameraOrPos;
    if (this.mesh.visible && this.atlas) this.atlas.update(cameraOrPos);
  }

  setTier(tier) {
    const cfg = grassConfigFromTier(tier);
    this._buildAtlas(cfg);
    if (this._lastCam && this.mesh.visible) this.atlas.update(this._lastCam);
  }

  dispose() {
    if (this.atlas) this.atlas.dispose();
    this.mesh.removeFromParent();
    this.nearBaseGeo.dispose();
    this.farBaseGeo.dispose();
    this.material.dispose();
  }
}

export function createGrass(ctx) {
  const grass = new Grass(ctx.renderer, ctx.tier, ctx.data?.hf);
  ctx.scene.add(grass.mesh);
  return {
    instance: grass,
    update(frame) {
      grass.update(frame.camera, frame.playerPos);
    },
    setTier(tier) {
      grass.setTier(tier);
    },
    dispose() {
      grass.dispose();
    },
  };
}

// ---------------- botanical species-drifted wildflowers ----------------
function flowerGeometry() {
  const pos = [];
  const uv = [];
  const part = [];
  const idx = [];
  pos.push(-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0);
  uv.push(0, 0, 1, 0, 0, 1, 1, 1);
  part.push(0, 0, 0, 0);
  idx.push(0, 1, 2, 1, 3, 2);
  pos.push(-0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, 1, 0.5, 0.5, 1, 0.5);
  uv.push(0, 0, 1, 0, 0, 1, 1, 1);
  part.push(1, 1, 1, 1);
  idx.push(4, 6, 5, 5, 6, 7);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

const FLOWER_BAKE_FRAG = /* glsl */ `
void main() {
  ivec2 localPx = gt_bakeTexel();
  highp uvec4 sc = texelFetch(uBakeScatter, localPx, 0);
  vec2 rawLocal = vec2(float(sc.x & 0xFFFFu), float(sc.x >> 16u)) / 65535.0 * uTileSize;
  vec2 localXZ = gt_applyFlip(rawLocal, uTileSize, uTileFlip);
  vec2 xz = uTileOrigin + localXZ;
  vec4 rnd = vec4(
    float(sc.y & 0xFFFFu), float(sc.y >> 16u),
    float(sc.z & 0xFFFFu), float(sc.z >> 16u)
  ) / 65535.0;

  float h = w_height(xz);
  vec3 tn = w_normal(xz, 1.0);
  vec4 bio = w_biome(xz);
  float trail = w_trail(xz);

  vec4 driftTex = textureLod(uNoiseTex, xz * 0.011 + 0.29, 0.0);
  float clump = textureLod(uNoiseTex, xz * 0.058 + rnd.z * 0.05, 0.0).g;
  float bouquet = textureLod(uNoiseTex, xz * 0.22 + 0.41, 0.0).r;
  float clMask = smoothstep(0.46, 0.76, clump * 0.68 + bouquet * 0.32);
  float cotFl = uAOSpot.z > 0.1 ? (1.0 - smoothstep(26.0, 44.0, length(xz - uAOSpot.xy))) * smoothstep(0.48, 0.76, clump) * 0.58 : 0.0;
  float pastureDaisy = bio.b * (1.0 - smoothstep(0.15, 0.45, bio.r)) * smoothstep(0.54, 0.80, clump) * 0.48;
  float alpineBloom = smoothstep(320.0, 405.0, h) * (1.0 - smoothstep(0.20, 0.55, bio.r)) * smoothstep(0.46, 0.76, clump) * 0.65;
  float flowerField = max(max(bio.g * clMask * (0.85 + 0.35 * driftTex.r), cotFl), max(pastureDaisy, alpineBloom));
  float dens = flowerField;
  dens *= smoothstep(0.48, 0.74, tn.y) * (1.0 - smoothstep(0.06, 0.34, trail));
  dens *= 1.0 - w_yard(xz);
  dens *= smoothstep(uWaterLevel + 0.4, uWaterLevel + 1.5, h);

  float spVal = clamp(driftTex.b * 1.45 - 0.22 + (driftTex.g - 0.5) * 0.35, 0.0, 0.999);
  float kind = rnd.x < 0.88 ? floor(spVal * 4.0) : floor(fract(rnd.x * 9.3) * 4.0);
  highp uint kindQ = uint(clamp(kind, 0.0, 3.0) + 0.5) & 3u;
  // Typical drawn grass-blade height at this root, so heads can clear the sward. A copy of the
  // per-spot terms of GRASS_BAKE_FRAG with per-blade randoms at their mean; reeds and plumes are
  // left out (they are sparse, and reeds would lift shore flowers to 2 m). Kept as a copy, not a
  // shared helper, so the grass bake stays byte-identical.
  float gCot = uAOSpot.z > 0.1 ? (1.0 - smoothstep(32.0, 52.0, length(xz - uAOSpot.xy))) : 0.0;
  float gForest = smoothstep(0.28, 0.66, bio.r) * (1.0 - gCot);
  vec4 gClumpN = textureLod(uNoiseTex, xz * 0.055 + 0.19, 0.0);
  vec4 gPatchN = textureLod(uNoiseTex, xz * 0.014 + 0.63, 0.0);
  float gClump = smoothstep(0.12, 0.78, gClumpN.g * 0.65 + gPatchN.r * 0.35);
  float gDens = smoothstep(0.30, 0.58, tn.y);
  gDens *= 1.0 - smoothstep(0.28, 0.60, trail);
  gDens *= 1.0 - 0.92 * w_yard(xz);
  gDens *= smoothstep(uWaterLevel + 0.15, uWaterLevel + 1.0, h);
  gDens *= mix(1.0, 0.04, smoothstep(0.36, 0.74, gForest));
  gDens *= max(smoothstep(0.05, 0.30, gClumpN.g + 0.28), gCot * 0.85);
  float gPathEdge = smoothstep(0.04, 0.22, trail) * (1.0 - smoothstep(0.28, 0.46, trail));
  float gTall = mix(0.20, 0.60, max(bio.b * 0.55 + gClump * 0.55, gCot * 0.78)) * 1.02;
  gTall = mix(gTall, 0.21, gForest * 0.72);
  gTall += gPathEdge * 0.30;
  gTall *= mix(1.0, 0.42, smoothstep(388.0, 412.0, h));
  gTall *= mix(1.0, 0.55, smoothstep(700.0, 1050.0, h));
  float grassTop = clamp(gTall * gDens, 0.0, 0.8);

  highp uint w0 = gt_packHeight(h)
    | (gt_packU(dens, 255.0) << 20u)
    | (kindQ << 28u);
  highp uint w1 = gt_packU(grassTop / GT_TALL_MAX, 255.0);
  outData = uvec4(w0, w1, 0u, 0u);
}
`;

const FLOWER_VERTEX = /* glsl */ `
  vec2 localXZ = gt_applyFlip(aLocal, uTileSize, aTileInfo.zw);
  vec2 tileOrig = modelMatrix[3].xz;
  vec2 xz = tileOrig + localXZ;
  float dist = length(xz - uCamXZ);

  int lxIdx = gl_InstanceID % uSlotW;
  int lyIdx = gl_InstanceID / uSlotW;
  highp uvec4 td = texelFetch(uTileData, ivec2(int(aTileInfo.x + 0.5) + lxIdx, int(aTileInfo.y + 0.5) + lyIdx), 0);

  float h = gt_unpackHeight(td.x);
  float dens = float((td.x >> 20u) & 0xFFu) / 255.0;
  float kind = float((td.x >> 28u) & 3u);
  float keep = (1.0 - smoothstep(uRadius * 0.62, uRadius, dist)) * step(aRnd.w, dens * 0.94);

  vec3 transformed;
  if (keep <= 0.001) {
    transformed = vec3(localXZ.x, h - 1.0, localXZ.y);
    vFUv = aUv;
    vFPart = aPart;
    vFKind = kind;
    vFAo = 1.0;
    vFCol = vec3(0.0);
  } else {
    float sizeVar = mix(0.55, 1.40, fract(aRnd.y * 7.3));
    float baseH = (kind < 0.5 ? mix(0.22, 0.44, aRnd.y)
                : kind < 1.5 ? mix(0.16, 0.32, aRnd.y)
                : kind < 2.5 ? mix(0.28, 0.54, aRnd.y)
                :              mix(0.20, 0.40, aRnd.y));
    // Lift heads just clear of the local grass tops: the tallest blades reach ~1.4x the baked mean,
    // and from eye height a head level with the sward is hidden by the blades in front of it.
    // Lupin spikes stand well above, campion a little, buttercup sits lowest.
    float grassTop = (float(td.y & 0xFFu) / 255.0) * GT_TALL_MAX;
    float kindLift = kind < 0.5 ? 1.0 : kind < 1.5 ? 0.95 : kind < 2.5 ? 1.32 : 1.10;
    float clearH = (grassTop * 1.4 + 0.06) * kindLift * mix(0.92, 1.12, aRnd.y);
    float stemH = max(baseH, clearH) * keep;
    float headS = (kind < 0.5 ? 0.095 : kind < 1.5 ? 0.082 : kind < 2.5 ? 0.098 : 0.072)
                * sizeVar * keep * (1.0 + dist * 0.022);

    float gust = smoothstep(0.3, 0.8, texture(uNoiseTex, xz * 0.010 - uWindDir * uTime * 0.042).r);
    vec2 sway = uWindDir * (gust * 0.6 + 0.1) * (0.3 + uWindStrength) + vec2(sin(uTime * 2.3 + aRnd.z * 9.0), cos(uTime * 1.9 + aRnd.x * 7.0)) * 0.05;
    vec3 toC = normalize(cameraPosition - vec3(xz.x, h + stemH, xz.y));
    vec3 hr = normalize(cross(vec3(0.0, 1.0, 0.0), toC));
    vec3 p;
    if (aPart < 0.5) {
      float y = position.y;
      float sw = mix(0.022, 0.012, y) * keep;
      p = vec3(localXZ.x, h + y * stemH - 0.02, localXZ.y) + hr * position.x * sw;
      p.xz += sway * y * y * stemH;
    } else {
      if (kind > 1.5 && kind < 2.5) {
        vec3 upV = vec3(0.0, 1.0, 0.0);
        p = vec3(localXZ.x, h + stemH * 0.88, localXZ.y) + hr * position.x * headS * 0.42 + upV * (position.z + 0.15) * headS * 1.55;
      } else {
        float tiltA = aRnd.z * 6.2831;
        vec3 tiltDir = vec3(cos(tiltA), 0.0, sin(tiltA));
        vec3 hn = normalize(vec3(0.0, 0.72 + 0.28 * aRnd.y, 0.0) + tiltDir * (0.36 + 0.34 * fract(aRnd.x * 13.7)) + toC * (0.16 + 0.22 * fract(aRnd.z * 5.1)));
        vec3 hr3 = normalize(cross(hn, abs(hn.x) < 0.85 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
        vec3 hu3 = normalize(cross(hn, hr3));
        float rotH = aRnd.x * 6.2831;
        vec3 ax1 = hr3 * cos(rotH) + hu3 * sin(rotH);
        vec3 ax2 = -hr3 * sin(rotH) + hu3 * cos(rotH);
        p = vec3(localXZ.x, h + stemH, localXZ.y) + ax1 * position.x * headS * 1.12 + ax2 * position.z * headS * 1.12;
      }
      p.xz += sway * stemH;
    }
    transformed = p;
    vFUv = aUv;
    vFPart = aPart;
    vFKind = kind;
    vFAo = mix(0.68, 1.06, smoothstep(0.14, 0.44, baseH)) * (0.86 + 0.24 * fract(aRnd.z * 17.3));
    vec3 c0 = vec3(0.97, 0.96, 0.91);
    vec3 c1 = vec3(1.0, 0.78, 0.12);
    vec3 c2 = mix(vec3(0.34, 0.34, 0.92), vec3(0.56, 0.36, 0.92), fract(aRnd.z * 11.3));
    vec3 c3 = mix(vec3(0.84, 0.40, 0.60), vec3(0.96, 0.58, 0.74), fract(aRnd.y * 5.7));
    vFCol = kind < 0.5 ? c0 : kind < 1.5 ? c1 : kind < 2.5 ? c2 : c3;
  }
`;

function flowerConfigFromTier(tier) {
  const radius = Math.min(34, tier.grassRadius * 0.75);
  const nearCount = Math.min(FLOWER_LAYOUT.maxCount, tier.flowers);
  return { ...FLOWER_LAYOUT, radius, nearCount, bakeBudget: tier.vegBakeBudget };
}

export class Flowers {
  constructor(renderer, tier, hf) {
    this.renderer = renderer;
    this.hf = hf || null;
    this.baseGeo = flowerGeometry();
    this.mesh = new THREE.Group();
    this.mesh.layers.set(LAYER_NO_REFLECT);

    const cfg = flowerConfigFromTier(tier);
    this.patch = cfg.radius * 2;
    this._lastCam = null;

    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uTileData: { value: null },
      uTileSize: { value: cfg.tileSize },
      uSlotW: { value: cfg.slotW },
      uRadius: { value: cfg.radius },
    };

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, side: THREE.DoubleSide });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        precision highp int;
        precision highp usampler2D;
        ${TILE_PACK_GLSL}
        attribute vec2 aLocal;
        attribute vec4 aRnd;
        attribute vec4 aTileInfo;
        attribute float aPart;
        attribute vec2 aUv;
        uniform highp usampler2D uTileData;
        uniform vec2 uCamXZ;
        uniform float uTileSize;
        uniform int uSlotW;
        uniform float uRadius;
        varying vec2 vFUv;
        varying float vFPart;
        varying vec3 vFCol;
        varying float vFKind;
        varying float vFAo;
      `,
      vertex: [
        ['#include <begin_vertex>', FLOWER_VERTEX],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: 'varying vec2 vFUv; varying float vFPart; varying vec3 vFCol; varying float vFKind; varying float vFAo;',
      fragment: [
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);'],
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          if (vFPart < 0.5) {
            diffuseColor.rgb = vec3(0.12, 0.32, 0.06) * mix(0.65, 1.05, vFUv.y);
          } else if (vFKind > 1.5 && vFKind < 2.5) {
            vec2 q = vFUv * 2.0 - 1.0;
            float env = sin(clamp((q.y + 1.0) * 0.5, 0.0, 1.0) * 3.14159);
            float tier = abs(sin((q.y + 1.0) * 9.5));
            float wLim = (0.36 + 0.52 * pow(env, 0.7)) * (0.55 + 0.45 * tier);
            if (abs(q.x) > wLim || abs(q.y) > 0.94) discard;
            vec3 tipCol = mix(vFCol * 0.80, vec3(0.86, 0.82, 1.0), smoothstep(-0.2, 0.85, q.y) * 0.42);
            diffuseColor.rgb = tipCol * (0.74 + 0.28 * tier) * vFAo;
          } else {
            vec2 q = vFUv * 2.0 - 1.0;
            float r = length(q);
            float a = atan(q.y, q.x);
            float petals = vFKind < 0.5 ? 10.0 : 5.0;
            float shape = (vFKind < 0.5 ? 0.54 : 0.56) + (vFKind < 0.5 ? 0.46 : 0.44) * abs(cos(a * petals * 0.5));
            if (r > shape) discard;
            vec3 col = mix(vFCol * 0.72, vFCol * 1.12, smoothstep(0.18, 0.88, r));
            float center = smoothstep(0.28, 0.14, r);
            col = mix(col, vFKind < 0.5 ? vec3(1.0, 0.76, 0.10) : vFKind < 1.5 ? vec3(0.84, 0.46, 0.04) : vec3(0.95, 0.78, 0.22), center);
            diffuseColor.rgb = col * vFAo;
          }
        `],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += (diffuseColor.rgb * 1.2 + vec3(0.05, 0.03, 0.01)) * w_warmSpill(vWPos) * 1.15;`],
      ],
    });
    this.material = mat;
    this.atlas = null;
    this._buildAtlas(cfg);
  }

  _buildAtlas(cfg) {
    if (this.atlas) this.atlas.dispose();
    this.patch = cfg.radius * 2;
    this.atlas = new TileRingAtlas({
      renderer: this.renderer,
      hf: this.hf,
      tileSize: cfg.tileSize,
      radius: cfg.radius,
      nearLodDist: Infinity,
      slotW: cfg.slotW,
      maxCount: cfg.maxCount,
      nearCount: cfg.nearCount,
      farCount: cfg.nearCount,
      offscreenBakeBudget: cfg.bakeBudget,
      seed: cfg.seed,
      clumped: true,
      boundsPad: { xz: 0.9, yDown: 0.5, yUp: 2.0 },
      isTileEmpty: (_tx, _tz, _s, b) => b.groundMaxY < WORLD.waterLevel + 0.2,
      receiveShadow: false,
      material: this.material,
      nearBaseGeo: this.baseGeo,
      farBaseGeo: this.baseGeo,
      bakeFragBody: FLOWER_BAKE_FRAG,
    });
    this.mesh.add(this.atlas.group);
    this.uniforms.uTileData.value = this.atlas.texture;
    this.uniforms.uTileSize.value = cfg.tileSize;
    this.uniforms.uSlotW.value = cfg.slotW;
    this.uniforms.uRadius.value = cfg.radius;
  }

  update(cameraOrPos) {
    const camPos = cameraOrPos && cameraOrPos.isCamera ? cameraOrPos.position : cameraOrPos;
    this.uniforms.uCamXZ.value.set(camPos.x, camPos.z);
    this._lastCam = cameraOrPos;
    if (this.mesh.visible && this.atlas) this.atlas.update(cameraOrPos);
  }

  setTier(tier) {
    const cfg = flowerConfigFromTier(tier);
    this._buildAtlas(cfg);
    if (this._lastCam && this.mesh.visible) this.atlas.update(this._lastCam);
  }

  dispose() {
    if (this.atlas) this.atlas.dispose();
    this.mesh.removeFromParent();
    this.baseGeo.dispose();
    this.material.dispose();
  }
}

export function createFlowers(ctx) {
  const flowers = new Flowers(ctx.renderer, ctx.tier, ctx.data?.hf);
  ctx.scene.add(flowers.mesh);
  return {
    instance: flowers,
    update(frame) {
      flowers.update(frame.camera);
    },
    setTier(tier) {
      flowers.setTier(tier);
    },
    dispose() {
      flowers.dispose();
    },
  };
}
