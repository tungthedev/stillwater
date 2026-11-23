import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { LAYER_NO_REFLECT } from './water.js';
import { mulberry32 } from './biome.js';
import { WORLD } from '../config.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { TILE_PACK_GLSL, TileRingAtlas } from './grassTiles.js';

// Enchanted cathedral forest undergrowth:
// - Crisp 256x512 multi-tone sunlit ferns with varied scale & warm translucency
// - Hero mossy nurse logs, ancient tree stumps, gnarled roots, vibrant toadstools & chanterelles
// - Volumetric sunlit god-rays concentrated in forest glades along the trail
// - Butterflies dancing over flower meadows & sunny forest clearings

function fernTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 512;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(9);
  ctx.clearRect(0, 0, 256, 512);
  ctx.fillStyle = 'rgba(130,175,75,0.01)'; ctx.fillRect(0, 0, 256, 512);
  // soft, stylized Ghibli botanical fern fronds (wider rounded painterly leaflets — ZERO high-contrast pixelated aliasing!)
  ctx.strokeStyle = '#527834'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(128, 512); ctx.quadraticCurveTo(132, 240, 128, 16); ctx.stroke();
  for (let y = 478; y > 26; y -= 24) {
    const f = 1 - y / 512;
    const len = 102 * Math.sin(Math.min(1, (1 - f) * 1.15) * Math.PI * 0.94) + 16;
    for (const s of [-1, 1]) {
      const cols = ['#56843a', '#4b7833', '#628f42', '#446e2e', '#6c9848'];
      ctx.fillStyle = cols[Math.floor(rnd() * cols.length)];
      ctx.beginPath();
      ctx.moveTo(128, y + 6);
      ctx.quadraticCurveTo(128 + s * len * 0.55, y - 24, 128 + s * len, y - 22);
      ctx.quadraticCurveTo(128 + s * len * 0.58, y + 10, 128, y + 14);
      ctx.fill();
      // soft warm sunlit leaflet highlight
      ctx.fillStyle = 'rgba(170,210,120,0.28)';
      ctx.beginPath();
      ctx.moveTo(128 + s * 6, y);
      ctx.quadraticCurveTo(128 + s * len * 0.48, y - 16, 128 + s * len * 0.84, y - 16);
      ctx.quadraticCurveTo(128 + s * len * 0.46, y + 2, 128 + s * 6, y + 6);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function fernGeometry(fronds = 8, segs = 5, widthScale = 1.0) {
  const pos = [];
  const uv = [];
  const idx = [];
  const nrm = [];
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.32;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const base = pos.length / 3;
    const reach = f % 2 === 0 ? 1.0 : 0.78;
    const archH = f % 2 === 0 ? 0.58 : 0.72;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const p = dir.clone().multiplyScalar(t * 0.96 * reach).add(new THREE.Vector3(0, Math.sin(t * Math.PI * 0.86) * archH + 0.02, 0));
      const w = 0.26 * widthScale * (1 - t * 0.25);
      for (const k of [-1, 1]) {
        const q = p.clone().addScaledVector(side, k * w);
        pos.push(q.x, q.y, q.z);
        uv.push(k < 0 ? 0 : 1, t);
        nrm.push(dir.x * 0.25, 0.95, dir.z * 0.25);
      }
    }
    for (let s = 0; s < segs; s++) {
      const i = base + s * 2;
      idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

const FERN_BAKE_FRAG = /* glsl */ `
void main() {
  ivec2 localPx = clamp(ivec2(floor(gl_FragCoord.xy)) - ivec2(uSlotOrigin + 0.5), ivec2(0), ivec2(uSlotW - 1, uSlotH - 1));
  highp uvec4 sc = texelFetch(uBakeScatter, localPx, 0);
  vec2 rawLocal = vec2(float(sc.x & 0xFFFFu), float(sc.x >> 16u)) / 65535.0 * uTileSize;
  vec2 localXZ = gt_applyFlip(rawLocal, uTileSize, uTileFlip);
  vec2 xz = uTileOrigin + localXZ;
  vec4 rnd = vec4(
    float(sc.y & 0xFFFFu), float(sc.y >> 16u),
    float(sc.z & 0xFFFFu), float(sc.z >> 16u)
  ) / 65535.0;

  float h = w_height(xz);
  vec4 bio = w_biome(xz);
  vec3 tn = w_normal(xz, 1.0);
  float clump = textureLod(uNoiseTex, xz * 0.095 + 0.21, 0.0).g;
  float clump2 = textureLod(uNoiseTex, xz * 0.26 + 0.63, 0.0).r;
  float cottageClear = uAOSpot.z > 0.1 ? smoothstep(28.0, 48.0, length(xz - uAOSpot.xy)) : 1.0;
  float trV = w_trail(xz);
  float trailEdge = smoothstep(0.01, 0.14, trV) * (1.0 - smoothstep(0.24, 0.42, trV));
  float dens = smoothstep(0.44, 0.78, bio.r) * (1.0 - smoothstep(0.08, 0.24, bio.g)) * cottageClear * smoothstep(0.64, 0.86, tn.y) * (1.0 - smoothstep(0.18, 0.36, trV));
  float pocket = smoothstep(0.38, 0.64, clump * 0.68 + clump2 * 0.32 + trailEdge * 0.38);
  dens *= pocket * step(rnd.w, 0.94);

  highp uint w0 = gt_packHeight(h) | (gt_packU(dens, 255.0) << 20u);
  highp uint w1 = gt_packU(clump, 255.0);
  outData = uvec4(w0, w1, 0u, 0u);
}
`;

const FERN_VERTEX = /* glsl */ `
  vec2 localXZ = gt_applyFlip(aLocal, uTileSize, aTileInfo.zw);
  vec2 tileOrig = modelMatrix[3].xz;
  vec2 xz = tileOrig + localXZ;
  float dist = length(xz - uCamXZ);

  int lxIdx = gl_InstanceID % uSlotW;
  int lyIdx = gl_InstanceID / uSlotW;
  highp uvec4 td = texelFetch(uTileData, ivec2(int(aTileInfo.x + 0.5) + lxIdx, int(aTileInfo.y + 0.5) + lyIdx), 0);

  float h = gt_unpackHeight(td.x);
  float dens = float((td.x >> 20u) & 0xFFu) / 255.0;
  float clump = float(td.y & 0xFFu) / 255.0;

  float keep = 1.0 - smoothstep(uRadius * 0.62, uRadius, dist);
  float isExtra = step(float(uFarCount) - 0.5, float(gl_InstanceID));
  float lodFade = 1.0 - isExtra * smoothstep(uLodStart, uLodEnd, dist);
  dens *= keep * lodFade;

  vec3 transformed;
  vFernUv = aUv;
  if (dens <= 0.001) {
    transformed = vec3(localXZ.x, h - 1.0, localXZ.y);
    vFernTint = vec3(0.0);
  } else {
    float farBoost = mix(1.0, 1.15, (1.0 - isExtra) * smoothstep(uLodStart, uLodEnd, dist));
    float s = dens * mix(0.24, 1.72, aRnd.y * aRnd.y * 0.58 + aRnd.y * 0.42) * farBoost;
    float morphTall = step(0.54, aRnd.x);
    float sRad = s * mix(1.32, 0.82, morphTall) * mix(0.80, 1.22, fract(aRnd.z * 5.3));
    float sy = s * mix(0.58, 1.44, morphTall) * mix(0.78, 1.24, aRnd.z);
    float ang = aRnd.z * 6.2831;
    float c = cos(ang);
    float sn = sin(ang);
    vec3 p = position;
    p.xz = mat2(c, -sn, sn, c) * p.xz;
    float sway = sin(uTime * 1.6 + aRnd.x * 20.0 + xz.x * 0.4) * 0.045 * p.y;
    transformed = vec3(localXZ.x + p.x * sRad + sway, h + p.y * sy - 0.02, localXZ.y + p.z * sRad);
    vec3 tWarm = vec3(0.98, 1.05, 0.72);
    vec3 tDeep = vec3(0.52, 0.84, 0.74);
    vec3 tMid = vec3(0.76, 0.94, 0.74);
    vFernTint = aRnd.x < 0.28 ? tWarm : aRnd.x < 0.66 ? tMid : tDeep;
    vFernTint *= 0.70 + 0.48 * clump;
  }
`;

function fernConfigFromTier(tier) {
  const radius = tier.fernRadius ?? 44;
  const tileSize = tier.fernTileSize ?? 16;
  const [slotW, slotH] = tier.fernTileSlot ?? [32, 24];
  const nearCount = slotW * slotH;
  const farCount = Math.min(nearCount, tier.fernFarCount ?? Math.floor(nearCount * 0.5));
  const nearLodDist = tier.fernNearLod ?? Math.min(24, radius * 0.6);
  const lodStart = Math.max(8, nearLodDist - 6);
  return { radius, tileSize, slotW, slotH, nearCount, farCount, nearLodDist, lodStart };
}

function isFernTileEmpty(biome) {
  return (tx, tz, tileSize, b) => {
    if (b.groundMaxY < WORLD.waterLevel) return true;
    if (!biome || typeof biome.sampleForest !== 'function') return false;
    const ox = tx * tileSize;
    const oz = tz * tileSize;
    // Ferns only appear where bio.r > 0.44; skip non-forest tiles before GPU baking or drawing.
    for (let iz = 0; iz <= 4; iz++) {
      const z = oz + (iz / 4) * tileSize;
      for (let ix = 0; ix <= 4; ix++) {
        if (biome.sampleForest(ox + (ix / 4) * tileSize, z) > 0.36) return false;
      }
    }
    return true;
  };
}

export class Ferns {
  constructor(renderer, tier, hf, biome) {
    this.renderer = renderer;
    this.hf = hf || null;
    this.biome = biome || null;
    this.nearBaseGeo = fernGeometry(8, 5, 1.0);
    // Same 8 frond directions as the near mesh so the LOD switch only drops arch segments.
    this.farBaseGeo = fernGeometry(8, 2, 1.1);
    this.mesh = new THREE.Group();
    this.mesh.layers.set(LAYER_NO_REFLECT);
    Object.defineProperty(this.mesh, 'geometry', {
      get: () => ({ instanceCount: this.atlas ? this.atlas.totalVisibleInstances : 0 }),
      configurable: true,
    });

    const cfg = fernConfigFromTier(tier);
    this.patch = cfg.radius * 2;
    this._lastCam = null;

    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uTileData: { value: null },
      uTileSize: { value: cfg.tileSize },
      uSlotW: { value: cfg.slotW },
      uFarCount: { value: cfg.farCount },
      uRadius: { value: cfg.radius },
      uLodStart: { value: cfg.lodStart },
      uLodEnd: { value: cfg.nearLodDist },
    };
    this.map = fernTexture();
    const mat = new THREE.MeshStandardMaterial({ map: this.map, alphaTest: 0.34, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.82 });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      toonWrap: 0.55,
      vertexPars: /* glsl */ `
        precision highp int;
        precision highp usampler2D;
        ${TILE_PACK_GLSL}
        attribute vec2 aLocal;
        attribute vec4 aRnd;
        attribute vec4 aTileInfo;
        attribute vec2 aUv;
        uniform highp usampler2D uTileData;
        uniform vec2 uCamXZ;
        uniform float uTileSize;
        uniform int uSlotW;
        uniform int uFarCount;
        uniform float uRadius;
        uniform float uLodStart;
        uniform float uLodEnd;
        varying vec2 vFernUv;
        varying vec3 vFernTint;
      `,
      vertex: [['#include <begin_vertex>', FERN_VERTEX]],
      fragmentPars: 'varying vec2 vFernUv; varying vec3 vFernTint;',
      fragment: [
        ['#include <map_fragment>', `
          vec4 texelColor = texture2D( map, vFernUv );
          diffuseColor *= texelColor;
          diffuseColor.rgb *= vFernTint * (0.76 + 0.36 * vFernUv.y);
        `],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec2 dp1 = vWPos.xz * 0.055 + uWindDir * sin(uTime * 0.32) * 0.04;
            vec2 dp2 = mat2(0.8, -0.6, 0.6, 0.8) * vWPos.xz * 0.13;
            float pool = smoothstep(0.46, 0.72, texture(uNoiseTex, dp1).r * 0.55 + texture(uNoiseTex, dp2 + 0.31).g * 0.45);
            float sunH = smoothstep(0.05, 0.22, uLightDir.y) * (1.0 - uNight);
            totalEmissiveRadiance += diffuseColor.rgb * uLightColor * vec3(1.04, 0.98, 0.68) * (0.02 + pool * 0.24) * sunH * (0.4 + 0.6 * vFernUv.y);
          }`],
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'],
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
      nearLodDist: cfg.nearLodDist,
      slotW: cfg.slotW,
      slotH: cfg.slotH,
      farCount: cfg.farCount,
      seed: 55,
      clumped: false,
      boundsPad: { xz: 2.2, yDown: 0.6, yUp: 2.2 },
      isTileEmpty: isFernTileEmpty(this.biome),
      receiveShadow: true,
      material: this.material,
      nearBaseGeo: this.nearBaseGeo,
      farBaseGeo: this.farBaseGeo,
      bakeFragBody: FERN_BAKE_FRAG,
    });
    this.mesh.add(this.atlas.group);
    this.uniforms.uTileData.value = this.atlas.texture;
    this.uniforms.uTileSize.value = cfg.tileSize;
    this.uniforms.uSlotW.value = cfg.slotW;
    this.uniforms.uFarCount.value = cfg.farCount;
    this.uniforms.uRadius.value = cfg.radius;
    this.uniforms.uLodStart.value = cfg.lodStart;
    this.uniforms.uLodEnd.value = cfg.nearLodDist;
  }

  update(cameraOrPos) {
    const camPos = cameraOrPos && cameraOrPos.isCamera ? cameraOrPos.position : cameraOrPos;
    this.uniforms.uCamXZ.value.set(camPos.x, camPos.z);
    this._lastCam = cameraOrPos;
    if (this.mesh.visible && this.atlas) this.atlas.update(cameraOrPos);
  }

  setTier(tier) {
    const cfg = fernConfigFromTier(tier);
    this._buildAtlas(cfg);
    if (this._lastCam && this.mesh.visible) this.atlas.update(this._lastCam);
  }

  dispose() {
    if (this.atlas) this.atlas.dispose();
    this.mesh.removeFromParent();
    this.nearBaseGeo.dispose();
    this.farBaseGeo.dispose();
    this.material.dispose();
    this.map.dispose();
  }
}

export function createFerns(ctx) {
  const ferns = new Ferns(ctx.renderer, ctx.tier, ctx.data?.hf, ctx.data?.biome);
  ctx.scene.add(ferns.mesh);
  return {
    instance: ferns,
    update(frame) { ferns.update(frame.camera); },
    setTier(tier) { ferns.setTier(tier); },
    dispose() { ferns.dispose(); },
  };
}

function colored(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function addMushroomCluster(parts, rnd, hf, cx, cz, count, golden = false) {
  for (let m = 0; m < count; m++) {
    const a = rnd() * 6.28, r = 0.08 + rnd() * 0.85;
    const mx = cx + Math.cos(a) * r, mz = cz + Math.sin(a) * r;
    const my = hf.height(mx, mz);
    const sc = 0.8 + rnd() * 0.9;
    const sh = (0.14 + rnd() * 0.14) * sc;
    const stem = new THREE.CylinderGeometry(0.035 * sc, 0.052 * sc, sh + 0.08, 7);
    stem.rotateZ((rnd() - 0.5) * 0.22);
    stem.translate(mx, my + sh * 0.45 - 0.04, mz);
    parts.push(colored(stem, golden ? [0.95, 0.78, 0.30] : [0.95, 0.91, 0.83]));
    const capR = (0.10 + rnd() * 0.06) * sc;
    // subtle mossy humus contact shadow pad grounding each mushroom solidly to the forest floor!
    const pad = new THREE.CylinderGeometry(capR * 1.15, capR * 1.35, 0.04, 7);
    pad.translate(mx, my + 0.01, mz);
    parts.push(colored(pad, [0.06, 0.14, 0.04]));
    const capG = new THREE.SphereGeometry(capR, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.56);
    capG.scale(1, golden ? 0.48 : 0.72, 1);
    capG.translate(mx, my + sh * 0.88, mz);
    parts.push(colored(capG, golden ? [0.95, 0.62, 0.10] : [0.88, 0.14, 0.10]));
    if (!golden) {
      for (let d = 0; d < 5; d++) {
        const dot = new THREE.SphereGeometry(0.022 * sc, 5, 4);
        const da = (d / 5) * 6.28 + rnd() * 0.6;
        const dr = capR * (0.35 + rnd() * 0.4);
        dot.translate(mx + Math.cos(da) * dr, my + sh * 0.88 + capR * 0.58, mz + Math.sin(da) * dr);
        parts.push(colored(dot, [0.98, 0.97, 0.92]));
      }
    }
  }
}

function addMossyLog(parts, rnd, hf, x, z, ry, len, rad) {
  // sample BOTH log ends and center so the log sinks solidly into sloping ground (ZERO floating logs!)
  const ex0 = Math.cos(ry) * len * 0.48, ez0 = -Math.sin(ry) * len * 0.48;
  const yC = hf.height(x, z), yA = hf.height(x + ex0, z + ez0), yB = hf.height(x - ex0, z - ez0);
  const y = Math.min(yC, yA, yB) + rad * 0.36;
  const log = new THREE.CylinderGeometry(rad, rad * 1.15, len, 10, 1);
  log.rotateZ(Math.PI / 2); log.rotateY(ry); log.translate(x, y, z);
  parts.push(colored(log, [0.28, 0.18, 0.11]));
  // lush velvety emerald moss blanket draping the top & wrapping down into the ground
  const moss = new THREE.CylinderGeometry(rad * 1.07, rad * 1.18, len * 0.88, 10, 1, false, -Math.PI * 0.48, Math.PI * 0.96);
  moss.rotateZ(Math.PI / 2); moss.rotateY(ry); moss.translate(x, y + 0.04, z);
  parts.push(colored(moss, [0.14, 0.40, 0.08]));
  // grounded dark earth contact shadow bed cradling the log
  const bed = new THREE.BoxGeometry(len * 0.96, rad * 0.8, rad * 2.4);
  bed.rotateY(ry); bed.translate(x, y - rad * 0.55, z);
  parts.push(colored(bed, [0.09, 0.10, 0.05]));
  // cut / broken wood end-grain caps
  for (const e of [-1, 1]) {
    const cap = new THREE.CircleGeometry(rad * 0.98, 10);
    cap.rotateY(Math.PI / 2 * e); cap.rotateY(ry);
    const ex = Math.cos(ry) * len / 2 * e, ez = -Math.sin(ry) * len / 2 * e;
    cap.translate(x + ex, y, z + ez);
    parts.push(colored(cap, [0.68, 0.52, 0.34]));
  }
  // shelf polypore fungi along log side
  for (let s = 0; s < 4; s++) {
    const t = (s / 3 - 0.5) * len * 0.7;
    const fx = x + Math.cos(ry) * t, fz = z - Math.sin(ry) * t;
    const shelf = new THREE.CylinderGeometry(0.16 + rnd() * 0.08, 0.08, 0.045, 7);
    shelf.scale(1.2, 1, 0.8);
    shelf.translate(fx + Math.sin(ry) * rad * 0.95, y + rad * (0.25 + rnd() * 0.35), fz + Math.cos(ry) * rad * 0.95);
    parts.push(colored(shelf, [0.85, 0.68, 0.42]));
  }
  addMushroomCluster(parts, rnd, hf, x + (rnd() - 0.5) * 1.2, z + (rnd() - 0.5) * 1.2, 3 + Math.floor(rnd() * 3), rnd() < 0.35);
}

function addMossyStump(parts, rnd, hf, x, z, rad = 0.48) {
  const y = hf.height(x, z);
  const h = 0.55 + rnd() * 0.45;
  const st = new THREE.CylinderGeometry(rad * 0.85, rad * 1.25, h, 9);
  st.translate(x, y + h * 0.45, z);
  parts.push(colored(st, [0.34, 0.23, 0.15]));
  const top = new THREE.CircleGeometry(rad * 0.84, 9);
  top.rotateX(-Math.PI / 2); top.translate(x, y + h * 0.95, z);
  parts.push(colored(top, [0.72, 0.58, 0.38]));
  // moss cap & root flares
  const moss = new THREE.SphereGeometry(rad * 0.72, 7, 5);
  moss.scale(1.1, 0.35, 0.9); moss.translate(x + rad * 0.2, y + h * 0.94, z);
  parts.push(colored(moss, [0.16, 0.46, 0.09]));
  for (let r = 0; r < 4; r++) {
    const a = (r / 4) * 6.28 + rnd() * 0.5;
    const rt = new THREE.CylinderGeometry(0.08, 0.16, rad * 1.6, 6);
    rt.rotateZ(Math.PI / 2 - 0.35); rt.rotateY(a);
    rt.translate(x + Math.cos(a) * rad * 1.0, y + 0.14, z - Math.sin(a) * rad * 1.0);
    parts.push(colored(rt, [0.30, 0.21, 0.13]));
  }
  addMushroomCluster(parts, rnd, hf, x + rad * 1.3, z + rad * 0.6, 3 + Math.floor(rnd() * 3), rnd() < 0.4);
}

function addWoodlandFlowerCluster(parts, rnd, hf, cx, cz, count = 8) {
  for (let i = 0; i < count; i++) {
    const a = rnd() * 6.28, r = 0.2 + rnd() * 1.2;
    const fx = cx + Math.cos(a) * r, fz = cz + Math.sin(a) * r;
    const fy = hf.height(fx, fz);
    const sh = 0.22 + rnd() * 0.28;
    const stem = new THREE.CylinderGeometry(0.015, 0.02, sh, 5);
    stem.translate(fx, fy + sh * 0.5, fz);
    parts.push(colored(stem, [0.16, 0.42, 0.10]));
    const bloom = new THREE.IcosahedronGeometry(0.08 + rnd() * 0.04, 0);
    bloom.translate(fx, fy + sh + 0.04, fz);
    const col = rnd() < 0.55 ? [0.97, 0.96, 0.90] : rnd() < 0.8 ? [0.68, 0.42, 0.95] : [0.98, 0.78, 0.20];
    parts.push(colored(bloom, col));
  }
}

/** Fallen mossy logs, ancient stumps, gnarly path roots, toadstools & woodland flowers strictly inside deep shaded forest stretches. */
export function buildLogs(hf, biome, trail, material, benches = []) {
  const rnd = mulberry32(404);
  const parts = [];
  const stoneParts = [];
  const pts = trail.points;
  const nearBench = (x, z) => benches.some((b) => Math.hypot(x - b.x, z - b.z) < 42);

  // 1. Identify deep forest trail stretches (including poi=forest!) and dress them lovingly — NEVER in sunny cottage lawn or saddle meadows!
  let heroPlaced = 0;
  for (let i = 10; i < pts.length - 10; i += 6) {
    const [px, pz] = pts[i];
    if (i < 55) continue; // keep cottage front lawn & trailhead meadow completely clean of fallen woodland logs!
    const f = biome.sampleForest(px + 12, pz) + biome.sampleForest(px - 12, pz) + biome.sampleForest(px, pz);
    if (f < 2.05 || nearBench(px, pz)) continue;
    const [qx, qz] = pts[Math.min(pts.length - 1, i + 4)];
    const tx = qx - px, tz = qz - pz, tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl, sz = tx / tl;
    const side = (i % 12 === 0) ? 1 : -1;
    const off = 2.0 + rnd() * 3.0;
    const x = px + sx * off * side, z = pz + sz * off * side;
    if (hf.height(x, z) < WORLD.waterLevel + 1.5) continue;
    const kind = heroPlaced % 4;
    if (kind === 0) {
      addMossyLog(parts, rnd, hf, x, z, Math.atan2(tz, tx) + (rnd() - 0.5) * 0.9, 2.8 + rnd() * 3.0, 0.24 + rnd() * 0.14);
    } else if (kind === 1) {
      addMossyStump(parts, rnd, hf, x, z, 0.38 + rnd() * 0.24);
      addMushroomCluster(parts, rnd, hf, x - sx * side * 0.9, z - sz * side * 0.9, 4, true);
    } else if (kind === 2) {
      // solidly grounded mossy woodland stump + nestled toadstool cluster (replaces floating horizontal root stick in forest.png!)
      addMossyStump(parts, rnd, hf, x, z, 0.44 + rnd() * 0.22);
      addMushroomCluster(parts, rnd, hf, x - sx * side * 0.7, z - sz * side * 0.7, 4, false);
    } else {
      // faceted moss-capped granite woodland outcrop cluster + toadstools (NO polygonal ball-on-stick flowers in forest.png!)
      for (let b = 0; b < 3; b++) {
        const g = rockGeometry(700 + heroPlaced * 3 + b, 2, 0.68);
        const sc = (b === 0 ? 1.15 : 0.62) + rnd() * 0.75;
        g.scale(sc * 1.15, sc * 0.78, sc); g.rotateY(rnd() * 6.28);
        const bx = x + (b === 0 ? 0 : (rnd() - 0.5) * 2.6), bz = z + (b === 0 ? 0 : (rnd() - 0.5) * 2.6);
        g.translate(bx, hf.height(bx, bz) - sc * 0.24, bz);
        stoneParts.push(g);
      }
      addMushroomCluster(parts, rnd, hf, x - sx * side * 1.1, z - sz * side * 1.1, 4, false);
    }
    heroPlaced++;
    if (heroPlaced >= 110) break;
  }

  // 2. General scattered forest logs deeper in the woods
  let placed = 0;
  for (let k = 0; k < 2400 && placed < 50; k++) {
    const i = Math.floor(rnd() * pts.length);
    const [px, pz] = pts[i];
    const a = rnd() * 6.28, r = 7 + rnd() * 26;
    const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
    if (biome.sampleForest(x, z) < 0.55 || nearBench(x, z)) continue;
    if (hf.trailAt(x, z) > 0.01) continue;
    if (hf.height(x, z) < WORLD.waterLevel + 1) continue;
    addMossyLog(parts, rnd, hf, x, z, rnd() * Math.PI, 2.6 + rnd() * 3.8, 0.22 + rnd() * 0.18);
    placed++;
  }

  const group = new THREE.Group();
  if (parts.length) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (stoneParts.length) {
    const sm = new THREE.Mesh(mergeGeometries(stoneParts), rockMaterial());
    sm.castShadow = true; sm.receiveShadow = true;
    group.add(sm);
  }
  return group;
}

export function createLogs(ctx, material, benches) {
  const { hf, biome, trail } = ctx.data;
  const group = buildLogs(hf, biome, trail, material, benches);
  if (group) ctx.scene.add(group);
  return {
    instance: group,
    update() {},
    dispose() {
      if (!group) return;
      group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material && obj.material !== material) obj.material.dispose();
      });
      group.removeFromParent();
    },
  };
}

// ---------------- butterflies ----------------
export class Butterflies {
  constructor(count = 85) {
    const g = this._buildGeo(count);
    this.uniforms = { uCamXZ: { value: new THREE.Vector2() }, uDay: { value: 1 } };
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: 'attribute vec4 aSeed; attribute vec2 aUv; uniform vec2 uCamXZ; uniform float uDay; varying vec2 vBUv; varying vec3 vBCol;',
      vertex: [['#include <begin_vertex>', `
        float P = 58.0;
        vec2 base = aSeed.xy * P;
        float t = uTime * (0.25 + aSeed.z * 0.2) + aSeed.w * 30.0;
        vec2 wander = vec2(sin(t * 1.3) + sin(t * 0.7 + 2.0), cos(t * 1.1) + sin(t * 0.5)) * 3.5;
        vec2 rel = mod(base + wander - uCamXZ + P * 0.5, P) - P * 0.5;
        vec2 xz = uCamXZ + rel;
        float h = w_height(xz);
        vec4 bio = w_biome(xz);
        // butterflies appear in both flower meadows AND sunlit forest glades!
        float habitat = max(smoothstep(0.15, 0.5, bio.g + bio.b * 0.4), smoothstep(0.4, 0.8, bio.r) * 0.85);
        float show = uDay * habitat * step(uWaterLevel + 0.5, h) * (1.0 - smoothstep(22.0, 29.0, length(rel)));
        float y = h + 0.55 + abs(sin(t * 2.1)) * 0.75 + aSeed.x * 0.6;
        float flap = sin(uTime * 22.0 + aSeed.w * 40.0);
        vec3 p = position;
        float ang = flap * 1.1 * sign(p.x);
        p = vec3(p.x * cos(ang) * 0.08, abs(p.x) * sin(abs(ang)) * 0.08 + p.y, p.z * 0.07);
        vec2 vel = vec2(cos(t * 1.3) * 1.3 + cos(t * 0.7 + 2.0) * 0.7, -sin(t * 1.1) * 1.1 + cos(t * 0.5) * 0.5);
        float yaw = atan(vel.x, vel.y);
        float cy = cos(yaw), sy = sin(yaw);
        p.xz = mat2(cy, -sy, sy, cy) * p.xz;
        vec3 transformed = vec3(xz.x, y, xz.y) + p * show;
        vBUv = aUv;
        float k = floor(aSeed.z * 4.0);
        vBCol = k < 1.0 ? vec3(0.98, 0.95, 0.85) : k < 2.0 ? vec3(1.0, 0.82, 0.18) : k < 3.0 ? vec3(0.38, 0.62, 1.0) : vec3(0.98, 0.62, 0.86);
      `]],
      fragmentPars: 'varying vec2 vBUv; varying vec3 vBCol;',
      fragment: [['#include <color_fragment>', `#include <color_fragment>
        {
          vec2 q = vBUv;
          float r = length(vec2(q.x * 0.9, (q.y - 0.5) * 1.2));
          if (r > 0.72 || (q.y < 0.5 && q.x > 0.9)) discard;
          diffuseColor.rgb = mix(vBCol, vec3(0.08), smoothstep(0.55, 0.68, r) + step(q.x, 0.06));
        }`],
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'],
      ],
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }

  _buildGeo(count) {
    const g = new THREE.InstancedBufferGeometry();
    const pos = [0, 0, -0.5, 1, 0, -0.6, 0, 0, 0.5, 1, 0, 0.7, 0, 0, -0.5, -1, 0, -0.6, 0, 0, 0.5, -1, 0, 0.7];
    const uv = [0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1];
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7]);
    const rnd = mulberry32(12);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seed[i] = rnd();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = count;
    return g;
  }

  update(cam, day) { this.uniforms.uCamXZ.value.set(cam.x, cam.z); this.uniforms.uDay.value = day; }

  setTier(tier) {
    const oldGeo = this.mesh.geometry;
    this.mesh.geometry = this._buildGeo(tier.butterflies);
    oldGeo.dispose();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export function createButterflies(ctx) {
  const butterflies = new Butterflies(ctx.tier.butterflies);
  ctx.scene.add(butterflies.mesh);
  return {
    instance: butterflies,
    update(frame) {
      const env = frame.env;
      butterflies.update(frame.camera.position, env.day * (1 - env.golden) * (1 - env.dusk) * (1 - env.night));
    },
    setTier(tier) { butterflies.setTier(tier); },
    dispose() { butterflies.dispose(); },
  };
}

// ---------------- volumetric golden light shafts through the forest canopy ----------------
export class LightShafts {
  constructor(hf, biome, trail, count = 90, heroIdx = -1) {
    this._hf = hf;
    this._biome = biome;
    this._trail = trail;
    this._heroIdx = heroIdx;
    const g = this._buildGeo(count);
    this.uniforms = { uLightDir: { value: new THREE.Vector3() }, uCol: { value: new THREE.Color() }, uTime: { value: 0 }, uStrength: { value: 0 }, uAOSpot: { value: new THREE.Vector4() } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `attribute vec4 aC; attribute float aS; uniform vec3 uLightDir; uniform float uTime; uniform vec4 uAOSpot; varying vec2 vQ; varying float vS; varying float vFade; varying float vDepth;
        void main(){
          vec3 A = normalize(uLightDir);
          vec3 base = aC.xyz + vec3(0.0, -0.5, 0.0);
          float len = 32.0;
          vec3 toCam = normalize(cameraPosition - base);
          vec3 side = normalize(cross(A, toCam));
          // true flaring conical sunbeam (narrow where light pierces upper canopy, fanning softly wider onto forest floor — ZERO rectangular billboard cards!)
          float coneW = aC.w * (0.42 + (1.0 - position.y) * 1.65);
          vec3 p = base + A * position.y * len + side * position.x * coneW;
          vQ = vec2(position.x + 0.5, position.y); vS = aS;
          float d = length(cameraPosition - base);
          float cotClear = uAOSpot.z > 0.1 ? smoothstep(82.0, 120.0, length(base.xz - uAOSpot.xy)) : 1.0;
          vFade = cotClear * smoothstep(3.5, 9.5, d) * (1.0 - smoothstep(55.0, 110.0, d));
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uCol; uniform float uStrength; uniform float uTime; varying vec2 vQ; varying float vS; varying float vFade; varying float vDepth;
        void main(){
          // silky Gaussian cross-section + delicate internal sunbeam striations + ultra-soft feathered top & bottom!
          float dx = (vQ.x - 0.5) * 2.0;
          float gauss = exp(-dx * dx * 4.2) * smoothstep(1.0, 0.62, abs(dx));
          float rays = 0.68 + 0.32 * sin(vQ.x * 13.0 + vS * 25.0) * sin(vQ.x * 6.0 - vS * 12.0);
          float along = smoothstep(0.0, 0.30, vQ.y) * smoothstep(1.0, 0.30, vQ.y);
          float flick = 0.88 + 0.12 * sin(uTime * 0.65 + vS * 30.0);
          vec3 warmBeam = mix(uCol, vec3(1.0, 0.91, 0.56), 0.82);
          float a = gauss * rays * along * flick * vFade * uStrength * 0.68 * smoothstep(4.0, 12.0, vDepth);
          gl_FragColor = vec4(warmBeam * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.mesh.renderOrder = 15;
  }

  _buildGeo(count) {
    const hf = this._hf, biome = this._biome, trail = this._trail, heroIdx = this._heroIdx;
    const rnd = mulberry32(808);
    const pts = trail.points;
    const centers = [];
    if (heroIdx >= 0 && heroIdx < pts.length - 18) {
      for (const [stepOff, latOff, wB] of [
        [6, -1.2, 4.2], [11, 0.8, 4.8], [16, -0.6, 5.2], [21, 1.4, 5.4], [26, 0.0, 6.0], [32, -1.0, 5.8],
      ]) {
        const idx = Math.min(pts.length - 2, heroIdx + stepOff);
        const [px, pz] = pts[idx], [qx, qz] = pts[idx + 1];
        const dx = qx - px, dz = qz - pz, dl = Math.hypot(dx, dz) || 1;
        const x = px - dz / dl * latOff, z = pz + dx / dl * latOff;
        centers.push([x, hf.height(x, z), z, wB, rnd()]);
      }
    }
    for (let i = 0; i < pts.length && centers.length < count * 0.72; i += 7) {
      const [px, pz] = pts[i];
      if (biome.sampleForest(px + 10, pz) + biome.sampleForest(px - 10, pz) + biome.sampleForest(px, pz) < 1.75) continue;
      for (let b = 0; b < 2 && centers.length < count * 0.72; b++) {
        const x = px + (rnd() - 0.5) * 16, z = pz + (rnd() - 0.5) * 16;
        if (biome.sampleForest(x, z) < 0.58) continue;
        centers.push([x, hf.height(x, z), z, 3.0 + rnd() * 3.4, rnd()]);
      }
    }
    for (let k = 0; k < 2500 && centers.length < count; k++) {
      const i = Math.floor(rnd() * pts.length);
      const [px, pz] = pts[i];
      if (biome.sampleForest(px + 10, pz) + biome.sampleForest(px - 10, pz) < 1.35) continue;
      const x = px + (rnd() - 0.5) * 26, z = pz + (rnd() - 0.5) * 26;
      if (biome.sampleForest(x, z) < 0.58) continue;
      centers.push([x, hf.height(x, z), z, 2.8 + rnd() * 3.6, rnd()]);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(new Float32Array(centers.flatMap((c) => [c[0], c[1], c[2], c[3]])), 4));
    g.setAttribute('aS', new THREE.InstancedBufferAttribute(new Float32Array(centers.map((c) => c[4])), 1));
    g.instanceCount = centers.length;
    return g;
  }

  update(U, t, day) {
    this.uniforms.uLightDir.value.copy(U.uLightDir.value);
    this.uniforms.uAOSpot.value.copy(U.uAOSpot.value);
    const lc = U.uLightColor.value, k = Math.max(lc.r, lc.g, lc.b) || 1;
    this.uniforms.uCol.value.setRGB(lc.r / k, lc.g / k, lc.b / k);
    this.uniforms.uTime.value = t;
    this.uniforms.uStrength.value = day * Math.min(1, Math.max(0, U.uLightDir.value.y * 3));
  }

  setTier(tier) {
    const oldGeo = this.mesh.geometry;
    this.mesh.geometry = this._buildGeo(tier.shafts);
    oldGeo.dispose();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export function createLightShafts(ctx, heroIdx = -1) {
  const { hf, biome, trail } = ctx.data;
  const shafts = new LightShafts(hf, biome, trail, ctx.tier.shafts, heroIdx);
  ctx.scene.add(shafts.mesh);
  return {
    instance: shafts,
    update(frame) { shafts.update(frame.U, frame.t, frame.env.day); },
    setTier(tier) { shafts.setTier(tier); },
    dispose() { shafts.dispose(); },
  };
}
