import * as THREE from 'three';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { mulberry32 } from './biome.js';
import { LAYER_NO_REFLECT } from './water.js';

/*
 * ============================================================================
 * Tile Data Layout Note (Slice 9 + Slice 9b Interface)
 * ============================================================================
 *
 * Format: Core WebGL2 GL_RGBA32UI (THREE.RGBAIntegerFormat + THREE.UnsignedIntType),
 *         128 bits (4 x uint32) per blade texel, NEAREST filter, no mipmaps,
 *         no float render target or OES_texture_float_linear extension required.
 * Read:   ONE texelFetch(uTileData, ivec2(slotOrigin + localPx), 0) per vertex.
 *         Always uses highp uint / highp uvec4 / highp usampler2D so 32-bit
 *         packing stays exact on 16-bit-mediump mobile GPUs (iPhone Safari).
 *
 * Blade identity & LOD stability:
 *   Each blade index i in [0, nearCount) owns a fixed tile-local offset
 *   (lx_i, lz_i) in [0, tileSize)^2, with optional per-tile flip (flipX, flipZ).
 *   Its world root xz = (tx * tileSize + fx(lx_i), tz * tileSize + fz(lz_i))
 *   is invariant across frames and across the near/far LOD boundary.
 *   Scatter indices are stratified-shuffled so any prefix [0, farCount)
 *   covers the tile uniformly. Near tiles draw [0, nearCount) (4-seg, 7-tri);
 *   far tiles draw [0, farCount) (2-seg, 3-tri, wider). Extra near blades
 *   (i >= farCount) fade smoothly to 0 height before the tile crosses into
 *   the far ring (tileNearestDist >= nearLodDist), preventing any pop.
 *
 * ---- Grass texel layout (128 bits = uvec4 td) ----
 *   Channel  Bits    Width  Field        Encoding             Range / Precision        Owner
 *   -------  ------  -----  -----------  -------------------  -----------------------  --------
 *   R (td.x)  0..19  20 b   height       UNORM20              [-64, +2048] m (2.0 mm)  Slice 9
 *   R (td.x) 20..27   8 b   dens         UNORM8               [0.0, 1.0] static mask   Slice 9
 *   R (td.x) 28..29   2 b   forestShade  UNORM2               [0.0, 1.0] (4 levels)    Slice 9
 *   R (td.x) 30       1 b   style        UINT1                0=field, 1=painted       Slice 9b
 *   R (td.x) 31       1 b   reedFlag     UINT1                0=normal, 1=shore reed   Slice 9
 *
 *   G (td.y)  0..7    8 b   normalX      UNORM8 -> [-1, 1]    tn.x (step 0.0078)       Slice 9
 *   G (td.y)  8..15   8 b   normalZ      UNORM8 -> [-1, 1]    tn.z (tn.y reconstructed)Slice 9
 *   G (td.y) 16..23   8 b   tallStatic   UNORM8               [0.0, 2.2] m (8.6 mm)    Slice 9
 *   G (td.y) 24..31   8 b   yaw          UNORM8               [0, 2*pi) (1.4 deg)      Slice 9
 *
 *   B (td.z)  0..7    8 b   baseColR     UNORM8 (sqrt-enc)    [0.0, 1.0] linear R      Slice 9+9b
 *   B (td.z)  8..15   8 b   baseColG     UNORM8 (sqrt-enc)    [0.0, 1.0] linear G      Slice 9+9b
 *   B (td.z) 16..23   8 b   baseColB     UNORM8 (sqrt-enc)    [0.0, 1.0] linear B      Slice 9+9b
 *   B (td.z) 24..27   4 b   dryTip       UNORM4               [0.0, 1.0]               Slice 9
 *   B (td.z) 28..31   4 b   hollow       UNORM4               [0.0, 1.0]               Slice 9
 *
 *   A (td.w)  0..7    8 b   bladeId      UNORM8               [0.0, 1.0] world-root    Slice 9+9b
 *                                                             hash (stable across LOD)
 *   A (td.w)  8..13   6 b   seamWeight   UNORM6               [0.0, 1.0] (64 levels)   Slice 9b
 *   A (td.w) 14..19   6 b   secondColR   UNORM6 (sqrt-enc)    [0.0, 1.0] painted R     Slice 9b
 *   A (td.w) 20..25   6 b   secondColG   UNORM6 (sqrt-enc)    [0.0, 1.0] painted G     Slice 9b
 *   A (td.w) 26..31   6 b   secondColB   UNORM6 (sqrt-enc)    [0.0, 1.0] painted B     Slice 9b
 *
 * ---- Flower texel layout (same RGBA32UI atlas) ----
 *   R (td.x)  0..19  20 b   height       UNORM20              [-64, +2048] m (2.0 mm)  Slice 9
 *   R (td.x) 20..27   8 b   dens         UNORM8               [0.0, 1.0]               Slice 9
 *   R (td.x) 28..29   2 b   kind         UINT2                0..3 species index       Slice 9
 *   R (td.x) 30       1 b   flowerStyle  UINT1                0=field, 1=short dot     Slice 9b
 *   R (td.x) 31       1 b   unused       UINT1                0                        Reserved
 *   G/B/A             96 b  unused       0u                                            Reserved
 *
 * ---- Fern texel layout (same RGBA32UI atlas) ----
 *   R (td.x)  0..19  20 b   height       UNORM20              [-64, +2048] m (2.0 mm)  Slice 9
 *   R (td.x) 20..27   8 b   dens         UNORM8               [0.0, 1.0] static mask   Slice 9
 *   R (td.x) 28..31   4 b   unused       0u                                            Reserved
 *   G (td.y)  0..7    8 b   clump        UNORM8               [0.0, 1.0] tint noise    Slice 9
 *   G (td.y)  8..31  24 b   unused       0u                                            Reserved
 *   B/A               64 b  unused       0u                                            Reserved
 */

export const TILE_HEIGHT_MIN = -64.0;
export const TILE_HEIGHT_RANGE = 2112.0;
export const TILE_TALL_MAX = 2.2;
const HEIGHT_MAX_Q = 1048575; // (1 << 20) - 1

export const TILE_PACK_GLSL = /* glsl */ `
const float GT_H_MIN = -64.0;
const float GT_H_RANGE = 2112.0;
const float GT_H_MAXQ = 1048575.0;
const float GT_TALL_MAX = 2.2;

highp uint gt_packU(float v, float maxQ) {
  return uint(clamp(v, 0.0, 1.0) * maxQ + 0.5);
}
highp uint gt_packHeight(float h) {
  return gt_packU((h - GT_H_MIN) / GT_H_RANGE, GT_H_MAXQ);
}
float gt_unpackHeight(highp uint r) {
  return GT_H_MIN + (float(r & 0xFFFFFu) / GT_H_MAXQ) * GT_H_RANGE;
}
highp uint gt_packRGB8Sqrt(vec3 c) {
  vec3 s = sqrt(clamp(c, 0.0, 1.0));
  return gt_packU(s.r, 255.0) | (gt_packU(s.g, 255.0) << 8u) | (gt_packU(s.b, 255.0) << 16u);
}
vec3 gt_unpackRGB8Sqrt(highp uint b) {
  vec3 s = vec3(float(b & 0xFFu), float((b >> 8u) & 0xFFu), float((b >> 16u) & 0xFFu)) / 255.0;
  return s * s;
}
highp uint gt_packRGB6Sqrt(vec3 c) {
  vec3 s = sqrt(clamp(c, 0.0, 1.0));
  return gt_packU(s.r, 63.0) | (gt_packU(s.g, 63.0) << 6u) | (gt_packU(s.b, 63.0) << 12u);
}
vec3 gt_unpackRGB6Sqrt(highp uint packed18) {
  vec3 s = vec3(float(packed18 & 0x3Fu), float((packed18 >> 6u) & 0x3Fu), float((packed18 >> 12u) & 0x3Fu)) / 63.0;
  return s * s;
}
vec2 gt_applyFlip(vec2 localXZ, float tileSize, vec2 flip) {
  return vec2(flip.x > 0.5 ? tileSize - localXZ.x : localXZ.x, flip.y > 0.5 ? tileSize - localXZ.y : localXZ.y);
}
`;

export function tileKey(tx, tz) {
  return `${tx},${tz}`;
}

export function worldToTileCoord(x, z, tileSize) {
  return {
    tx: Math.floor(x / tileSize),
    tz: Math.floor(z / tileSize),
  };
}

/** Deterministic per-tile mirror bits to break cross-tile repetition without moving roots. */
export function tileFlipBits(tx, tz) {
  const h = (Math.imul(tx | 0, 374761393) ^ Math.imul(tz | 0, 668265263)) >>> 0;
  return {
    flipX: (h >>> 16) & 1,
    flipZ: (h >>> 17) & 1,
  };
}

/** Squared horizontal distance from (camX, camZ) to the nearest point of tile (tx, tz). */
export function tileNearestDistSq(tx, tz, tileSize, camX, camZ) {
  const minX = tx * tileSize;
  const maxX = minX + tileSize;
  const minZ = tz * tileSize;
  const maxZ = minZ + tileSize;
  const dx = camX < minX ? minX - camX : camX > maxX ? camX - maxX : 0;
  const dz = camZ < minZ ? minZ - camZ : camZ > maxZ ? camZ - maxZ : 0;
  return dx * dx + dz * dz;
}

/**
 * Select all tiles whose AABB intersects the horizontal circle (camX, camZ, radius).
 * Tiles with nearestDist < nearLodDist are classified 'near'; others are 'far'.
 * Returned sorted closest-first so front-to-back drawing helps early-Z rejection.
 */
export function selectTileRing(camX, camZ, { tileSize, radius, nearLodDist = Infinity }) {
  const minTx = Math.floor((camX - radius) / tileSize);
  const maxTx = Math.floor((camX + radius) / tileSize);
  const minTz = Math.floor((camZ - radius) / tileSize);
  const maxTz = Math.floor((camZ + radius) / tileSize);
  const r2 = radius * radius;
  const lod2 = nearLodDist * nearLodDist;
  const tiles = [];

  for (let tz = minTz; tz <= maxTz; tz++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const d2 = tileNearestDistSq(tx, tz, tileSize, camX, camZ);
      if (d2 > r2) continue;
      const cx = (tx + 0.5) * tileSize - camX;
      const cz = (tz + 0.5) * tileSize - camZ;
      tiles.push({
        tx,
        tz,
        key: tileKey(tx, tz),
        ox: tx * tileSize,
        oz: tz * tileSize,
        nearestDistSq: d2,
        centerDistSq: cx * cx + cz * cz,
        lod: d2 < lod2 ? 'near' : 'far',
      });
    }
  }

  tiles.sort((a, b) => a.centerDistSq - b.centerDistSq || a.tz - b.tz || a.tx - b.tx);
  return tiles;
}

/**
 * Compute tile-local bounding box padded horizontally for blade bend/sway
 * and vertically for terrain curvature and max blade/frond height.
 */
export function computeTileBounds(tx, tz, tileSize, sampleHeight, pad = {}) {
  const padXZ = pad.xz ?? 1.6;
  const padYDown = pad.yDown ?? 0.6;
  const padYUp = pad.yUp ?? 2.4;
  const grid = pad.samples ?? 5;
  const ox = tx * tileSize;
  const oz = tz * tileSize;
  let minY = Infinity;
  let maxY = -Infinity;
  const denom = Math.max(1, grid - 1);

  for (let iz = 0; iz < grid; iz++) {
    const z = oz + (iz / denom) * tileSize;
    for (let ix = 0; ix < grid; ix++) {
      const x = ox + (ix / denom) * tileSize;
      const y = sampleHeight ? sampleHeight(x, z) : 0;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY)) {
    minY = 0;
    maxY = 0;
  }
  return {
    minX: -padXZ,
    minY: minY - padYDown,
    minZ: -padXZ,
    maxX: tileSize + padXZ,
    maxY: maxY + padYUp,
    maxZ: tileSize + padXZ,
    groundMinY: minY,
    groundMaxY: maxY,
  };
}

/**
 * Generate organic clumped scatter inside [0, tileSize)^2 and apply a deterministic
 * Fisher-Yates permutation so any prefix [0, farCount) covers the whole tile evenly.
 * Quantizes to 16-bit and writes both float vertex attributes and packed RGBA32UI data
 * so the GPU bake pass and vertex shader see bit-identical local positions and randoms.
 */
export function generateTileScatter(slotW, slotH, tileSize, seed, clumped = true) {
  const count = slotW * slotH;
  const rnd = mulberry32(seed);
  const rawX = new Float32Array(count);
  const rawZ = new Float32Array(count);
  const rawR = new Float32Array(count * 4);
  const side = Math.ceil(Math.sqrt(count));
  const cell = tileSize / side;

  for (let i = 0; i < count; i++) {
    let ox;
    let oz;
    if (clumped && i % 5 !== 0) {
      const gx = i % side;
      const gz = (i / side) | 0;
      const cx = (gx + 0.5 + (rnd() - 0.5) * 1.9) * cell;
      const cz = (gz + 0.5 + (rnd() - 0.5) * 1.9) * cell;
      const ang = rnd() * Math.PI * 2;
      const rad = Math.sqrt(rnd()) * cell * 0.85;
      ox = (((cx + Math.cos(ang) * rad) % tileSize) + tileSize) % tileSize;
      oz = (((cz + Math.sin(ang) * rad) % tileSize) + tileSize) % tileSize;
    } else {
      ox = rnd() * tileSize;
      oz = rnd() * tileSize;
    }
    rawX[i] = ox;
    rawZ[i] = oz;
    rawR[i * 4] = rnd();
    rawR[i * 4 + 1] = rnd();
    rawR[i * 4 + 2] = rnd();
    rawR[i * 4 + 3] = rnd();
  }

  // Permute blade order so prefixes [0, farCount) remain evenly distributed across the tile.
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }

  const localXZ = new Float32Array(count * 2);
  const rnd4 = new Float32Array(count * 4);
  const packed = new Uint32Array(count * 4);
  const q16 = (u) => Math.max(0, Math.min(65535, Math.round(u * 65535)));

  for (let i = 0; i < count; i++) {
    const src = order[i];
    const ux = q16(rawX[src] / tileSize);
    const uz = q16(rawZ[src] / tileSize);
    const r0 = q16(rawR[src * 4]);
    const r1 = q16(rawR[src * 4 + 1]);
    const r2 = q16(rawR[src * 4 + 2]);
    const r3 = q16(rawR[src * 4 + 3]);

    localXZ[i * 2] = (ux / 65535) * tileSize;
    localXZ[i * 2 + 1] = (uz / 65535) * tileSize;
    rnd4[i * 4] = r0 / 65535;
    rnd4[i * 4 + 1] = r1 / 65535;
    rnd4[i * 4 + 2] = r2 / 65535;
    rnd4[i * 4 + 3] = r3 / 65535;

    packed[i * 4] = (ux | (uz << 16)) >>> 0;
    packed[i * 4 + 1] = (r0 | (r1 << 16)) >>> 0;
    packed[i * 4 + 2] = (r2 | (r3 << 16)) >>> 0;
    packed[i * 4 + 3] = 0;
  }

  return { count, localXZ, rnd: rnd4, packed };
}

/** CPU mirror of the GLSL 128-bit grass texel packing (used in unit tests). */
export function packGrassTexelCPU(f) {
  const qU = (v, maxQ) => Math.max(0, Math.min(maxQ, Math.round(Math.max(0, Math.min(1, v)) * maxQ)));
  const hQ = qU((f.height - TILE_HEIGHT_MIN) / TILE_HEIGHT_RANGE, HEIGHT_MAX_Q);
  const dQ = qU(f.dens, 255);
  const fQ = qU(f.forestShade ?? 0, 3);
  const styleBit = f.style ? 1 : 0;
  const reedBit = f.reedFlag ? 1 : 0;
  const w0 = (hQ | (dQ << 20) | (fQ << 28) | (styleBit << 30) | (reedBit << 31)) >>> 0;

  const nxQ = qU((f.normalX ?? 0) * 0.5 + 0.5, 255);
  const nzQ = qU((f.normalZ ?? 0) * 0.5 + 0.5, 255);
  const tallQ = qU((f.tallStatic ?? 0) / TILE_TALL_MAX, 255);
  const yawFrac = (((f.yaw ?? 0) / (Math.PI * 2)) % 1 + 1) % 1;
  const yawQ = qU(yawFrac, 255) & 255;
  const w1 = (nxQ | (nzQ << 8) | (tallQ << 16) | (yawQ << 24)) >>> 0;

  const br = qU(Math.sqrt(Math.max(0, f.baseCol?.[0] ?? 0)), 255);
  const bg = qU(Math.sqrt(Math.max(0, f.baseCol?.[1] ?? 0)), 255);
  const bb = qU(Math.sqrt(Math.max(0, f.baseCol?.[2] ?? 0)), 255);
  const dryQ = qU(f.dryTip ?? 0, 15);
  const holQ = qU(f.hollow ?? 0, 15);
  const w2 = (br | (bg << 8) | (bb << 16) | (dryQ << 24) | (holQ << 28)) >>> 0;

  const idQ = qU(f.bladeId ?? 0, 255);
  const seamQ = qU(f.seamWeight ?? 0, 63);
  const sr = qU(Math.sqrt(Math.max(0, f.secondCol?.[0] ?? 0)), 63);
  const sg = qU(Math.sqrt(Math.max(0, f.secondCol?.[1] ?? 0)), 63);
  const sb = qU(Math.sqrt(Math.max(0, f.secondCol?.[2] ?? 0)), 63);
  const sec18 = (sr | (sg << 6) | (sb << 12)) >>> 0;
  const w3 = (idQ | (seamQ << 8) | (sec18 << 14)) >>> 0;

  return new Uint32Array([w0, w1, w2, w3]);
}

export function unpackGrassTexelCPU(td) {
  const w0 = td[0] >>> 0;
  const w1 = td[1] >>> 0;
  const w2 = td[2] >>> 0;
  const w3 = td[3] >>> 0;
  const height = TILE_HEIGHT_MIN + ((w0 & HEIGHT_MAX_Q) / HEIGHT_MAX_Q) * TILE_HEIGHT_RANGE;
  const dens = ((w0 >>> 20) & 255) / 255;
  const forestShade = ((w0 >>> 28) & 3) / 3;
  const style = (w0 >>> 30) & 1;
  const reedFlag = (w0 >>> 31) & 1;

  const normalX = ((w1 & 255) / 255) * 2 - 1;
  const normalZ = (((w1 >>> 8) & 255) / 255) * 2 - 1;
  const normalY = Math.sqrt(Math.max(0, 1 - normalX * normalX - normalZ * normalZ));
  const tallStatic = (((w1 >>> 16) & 255) / 255) * TILE_TALL_MAX;
  const yaw = (((w1 >>> 24) & 255) / 255) * Math.PI * 2;

  const sq = (u) => u * u;
  const baseCol = [
    sq((w2 & 255) / 255),
    sq(((w2 >>> 8) & 255) / 255),
    sq(((w2 >>> 16) & 255) / 255),
  ];
  const dryTip = ((w2 >>> 24) & 15) / 15;
  const hollow = ((w2 >>> 28) & 15) / 15;

  const bladeId = (w3 & 255) / 255;
  const seamWeight = ((w3 >>> 8) & 63) / 63;
  const sec = w3 >>> 14;
  const secondCol = [
    sq((sec & 63) / 63),
    sq(((sec >>> 6) & 63) / 63),
    sq(((sec >>> 12) & 63) / 63),
  ];

  return {
    height, dens, forestShade, style, reedFlag,
    normalX, normalY, normalZ, tallStatic, yaw,
    baseCol, dryTip, hollow,
    bladeId, seamWeight, secondCol,
  };
}

/** Choose a compact 2D atlas grid (cols x rows) that fits the active ring plus LRU headroom. */
export function computeAtlasGrid(tileSize, radius, extraMargin = 1.3) {
  const maxSpan = Math.ceil((radius * 2) / tileSize) + 2;
  const approxCircle = Math.ceil(Math.PI * Math.pow(radius / tileSize + 1.1, 2));
  const needed = Math.max(9, Math.min(maxSpan * maxSpan, Math.ceil(approxCircle * extraMargin)));
  const cols = Math.ceil(Math.sqrt(needed));
  const rows = Math.ceil(needed / cols);
  return { cols, rows, capacity: cols * rows };
}

function makeBakeQuad() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return geo;
}

const BAKE_VERT_GLSL3 = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Reusable tiled vegetation ring + RGBA32UI atlas baker.
 * Each active tile gets a persistent atlas slot baked once on ring entry,
 * per-tile padded world bounds for frustum culling, and near/far LOD meshes
 * sharing the same blade roots and static attributes.
 */
export class TileRingAtlas {
  constructor(opts) {
    this.renderer = opts.renderer;
    this.hf = opts.hf || null;
    this.tileSize = opts.tileSize;
    this.radius = opts.radius;
    this.nearLodDist = opts.nearLodDist ?? Infinity;
    this.slotW = opts.slotW;
    this.slotH = opts.slotH;
    this.nearCount = this.slotW * this.slotH;
    this.farCount = Math.min(this.nearCount, opts.farCount ?? this.nearCount);
    this.seed = opts.seed ?? 1337;
    this.clumped = opts.clumped ?? true;
    this.boundsPad = opts.boundsPad || { xz: 1.6, yDown: 0.6, yUp: 2.4 };
    this.isTileEmpty = opts.isTileEmpty || null;
    this.receiveShadow = opts.receiveShadow ?? false;
    this.material = opts.material;
    this.nearBaseGeo = opts.nearBaseGeo;
    this.farBaseGeo = opts.farBaseGeo || opts.nearBaseGeo;

    this.group = new THREE.Group();
    this.group.layers.set(LAYER_NO_REFLECT);

    const grid = computeAtlasGrid(this.tileSize, this.radius);
    this.atlasCols = grid.cols;
    this.atlasRows = grid.rows;
    this.capacity = grid.capacity;

    this.atlasRT = new THREE.WebGLRenderTarget(
      this.atlasCols * this.slotW,
      this.atlasRows * this.slotH,
      {
        format: THREE.RGBAIntegerFormat,
        type: THREE.UnsignedIntType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
      },
    );

    const scatter = generateTileScatter(this.slotW, this.slotH, this.tileSize, this.seed, this.clumped);
    this.scatter = scatter;
    this._localAttr = new THREE.InstancedBufferAttribute(scatter.localXZ, 2);
    this._rndAttr = new THREE.InstancedBufferAttribute(scatter.rnd, 4);

    this.scatterTex = new THREE.DataTexture(
      scatter.packed,
      this.slotW,
      this.slotH,
      THREE.RGBAIntegerFormat,
      THREE.UnsignedIntType,
    );
    this.scatterTex.minFilter = THREE.NearestFilter;
    this.scatterTex.magFilter = THREE.NearestFilter;
    this.scatterTex.generateMipmaps = false;
    this.scatterTex.needsUpdate = true;

    this._bakeUniforms = {
      ...U,
      uBakeScatter: { value: this.scatterTex },
      uTileOrigin: { value: new THREE.Vector2() },
      uTileSize: { value: this.tileSize },
      uSlotOrigin: { value: new THREE.Vector2() },
      uSlotW: { value: this.slotW },
      uSlotH: { value: this.slotH },
      uTileFlip: { value: new THREE.Vector2() },
      ...(opts.bakeUniforms || {}),
    };
    this._bakeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this._bakeUniforms,
      vertexShader: BAKE_VERT_GLSL3,
      fragmentShader: /* glsl */ `
        precision highp float;
        precision highp int;
        precision highp usampler2D;
        // Shuffled per-blade scatter jumps arbitrarily between adjacent pixels, so force
        // mip 0 inside shared world noise helpers to match vertex-stage sampling exactly.
        #define texture(s, uv) textureLod(s, uv, 0.0)
        ${COMMON}
        #undef texture
        ${TILE_PACK_GLSL}
        uniform highp usampler2D uBakeScatter;
        uniform vec2 uTileOrigin;
        uniform float uTileSize;
        uniform vec2 uSlotOrigin;
        uniform int uSlotW;
        uniform int uSlotH;
        uniform vec2 uTileFlip;
        layout(location = 0) out highp uvec4 outData;
        ${opts.bakeFragBody}
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._bakeQuadGeo = makeBakeQuad();
    this._bakeScene = new THREE.Scene();
    const bakeQuad = new THREE.Mesh(this._bakeQuadGeo, this._bakeMat);
    bakeQuad.frustumCulled = false;
    this._bakeScene.add(bakeQuad);
    this._bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Pre-allocate slot meshes so walking never allocates Three.js objects or GPU buffers.
    this.slots = [];
    this.tileMap = new Map();
    this._stamp = 0;
    this.lastBakeCount = 0;
    this.totalBakeCount = 0;
    this.visibleNearTiles = 0;
    this.visibleFarTiles = 0;
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._worldBox = new THREE.Box3();

    const makeSlotGeo = (baseGeo, instanceCount, tileInfoAttr) => {
      const g = new THREE.InstancedBufferGeometry();
      for (const name in baseGeo.attributes) g.setAttribute(name, baseGeo.attributes[name]);
      if (baseGeo.index) g.setIndex(baseGeo.index);
      g.setAttribute('aLocal', this._localAttr);
      g.setAttribute('aRnd', this._rndAttr);
      g.setAttribute('aTileInfo', tileInfoAttr);
      g.instanceCount = instanceCount;
      g.boundingBox = new THREE.Box3();
      g.boundingSphere = new THREE.Sphere();
      return g;
    };

    for (let s = 0; s < this.capacity; s++) {
      const col = s % this.atlasCols;
      const row = (s / this.atlasCols) | 0;
      const sx = col * this.slotW;
      const sy = row * this.slotH;
      const infoArr = new Float32Array([sx, sy, 0, 0]);
      // Divisor = nearCount stays well below mobile maxVertexAttribDivisor while reading index 0 for every instance.
      const infoAttr = new THREE.InstancedBufferAttribute(infoArr, 4, false, Math.max(1, this.nearCount));
      const nearGeo = makeSlotGeo(this.nearBaseGeo, this.nearCount, infoAttr);
      const farGeo = this.farBaseGeo !== this.nearBaseGeo || this.farCount !== this.nearCount
        ? makeSlotGeo(this.farBaseGeo, this.farCount, infoAttr)
        : nearGeo;

      const mesh = new THREE.Mesh(nearGeo, this.material);
      mesh.visible = false;
      mesh.frustumCulled = true;
      mesh.receiveShadow = this.receiveShadow;
      mesh.layers.set(LAYER_NO_REFLECT);
      this.group.add(mesh);

      this.slots.push({
        index: s,
        col,
        row,
        sx,
        sy,
        infoArr,
        infoAttr,
        nearGeo,
        farGeo,
        mesh,
        key: null,
        tx: 0,
        tz: 0,
        ox: 0,
        oz: 0,
        flipX: 0,
        flipZ: 0,
        empty: false,
        lastUsed: 0,
        localBox: new THREE.Box3(),
        worldBox: new THREE.Box3(),
        lod: 'near',
      });
    }
  }

  get texture() {
    return this.atlasRT.texture;
  }

  _pickEvictSlot(activeKeys, camX, camZ) {
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      if (sl.key === null) return sl;
      if (activeKeys.has(sl.key)) continue;
      const cx = sl.ox + this.tileSize * 0.5 - camX;
      const cz = sl.oz + this.tileSize * 0.5 - camZ;
      const d2 = cx * cx + cz * cz;
      if (d2 > bestDist) {
        bestDist = d2;
        best = sl;
      }
    }
    // Fallback if capacity were ever saturated: oldest slot.
    if (!best) {
      best = this.slots[0];
      for (let i = 1; i < this.slots.length; i++) {
        if (this.slots[i].lastUsed < best.lastUsed) best = this.slots[i];
      }
    }
    return best;
  }

  _bakeSlots(toBake) {
    if (!toBake.length || !this.renderer) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevShadow = r.shadowMap.enabled;
    r.autoClear = false;
    r.shadowMap.enabled = false;

    for (let i = 0; i < toBake.length; i++) {
      const sl = toBake[i];
      this.atlasRT.viewport.set(sl.sx, sl.sy, this.slotW, this.slotH);
      this.atlasRT.scissor.set(sl.sx, sl.sy, this.slotW, this.slotH);
      this.atlasRT.scissorTest = true;
      this._bakeUniforms.uTileOrigin.value.set(sl.ox, sl.oz);
      this._bakeUniforms.uSlotOrigin.value.set(sl.sx, sl.sy);
      this._bakeUniforms.uTileFlip.value.set(sl.flipX, sl.flipZ);
      r.setRenderTarget(this.atlasRT);
      r.render(this._bakeScene, this._bakeCam);
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    r.shadowMap.enabled = prevShadow;
  }

  update(camera) {
    const camPos = camera && camera.isCamera ? camera.position : camera;
    const camX = camPos.x;
    const camZ = camPos.z;
    const ring = selectTileRing(camX, camZ, {
      tileSize: this.tileSize,
      radius: this.radius,
      nearLodDist: this.nearLodDist,
    });

    const activeKeys = new Set();
    for (let i = 0; i < ring.length; i++) activeKeys.add(ring[i].key);
    this._stamp++;

    // Hide all slots first; active visible slots in frustum are re-enabled below.
    for (let i = 0; i < this.slots.length; i++) this.slots[i].mesh.visible = false;

    const toBake = [];
    const activeSlots = [];
    const sampleH = this.hf ? (x, z) => this.hf.height(x, z) : null;

    for (let i = 0; i < ring.length; i++) {
      const t = ring[i];
      let sl = this.tileMap.get(t.key);
      if (!sl) {
        sl = this._pickEvictSlot(activeKeys, camX, camZ);
        if (sl.key !== null) this.tileMap.delete(sl.key);
        const { flipX, flipZ } = tileFlipBits(t.tx, t.tz);
        sl.key = t.key;
        sl.tx = t.tx;
        sl.tz = t.tz;
        sl.ox = t.ox;
        sl.oz = t.oz;
        sl.flipX = flipX;
        sl.flipZ = flipZ;
        sl.infoArr[2] = flipX;
        sl.infoArr[3] = flipZ;
        sl.infoAttr.needsUpdate = true;

        const b = computeTileBounds(t.tx, t.tz, this.tileSize, sampleH, this.boundsPad);
        sl.localBox.min.set(b.minX, b.minY, b.minZ);
        sl.localBox.max.set(b.maxX, b.maxY, b.maxZ);
        sl.worldBox.min.set(t.ox + b.minX, b.minY, t.oz + b.minZ);
        sl.worldBox.max.set(t.ox + b.maxX, b.maxY, t.oz + b.maxZ);

        sl.nearGeo.boundingBox.copy(sl.localBox);
        sl.localBox.getBoundingSphere(sl.nearGeo.boundingSphere);
        if (sl.farGeo !== sl.nearGeo) {
          sl.farGeo.boundingBox.copy(sl.localBox);
          sl.farGeo.boundingSphere.copy(sl.nearGeo.boundingSphere);
        }
        sl.mesh.position.set(t.ox, 0, t.oz);
        sl.mesh.updateMatrixWorld();

        sl.empty = this.isTileEmpty ? !!this.isTileEmpty(t.tx, t.tz, this.tileSize, b) : false;
        this.tileMap.set(t.key, sl);
        if (!sl.empty) toBake.push(sl);
      }

      sl.lastUsed = this._stamp;
      sl.lod = t.lod;
      if (!sl.empty) activeSlots.push(sl);
    }

    if (toBake.length) {
      this._bakeSlots(toBake);
      this.totalBakeCount += toBake.length;
    }
    this.lastBakeCount = toBake.length;

    // Tight AABB frustum culling on CPU when given a Camera (keeps Three.js mesh.frustumCulled = true).
    const useFrustum = !!(camera && camera.isCamera);
    if (useFrustum) {
      camera.updateMatrixWorld();
      this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._projScreen);
    }

    let nearVis = 0;
    let farVis = 0;
    for (let i = 0; i < activeSlots.length; i++) {
      const sl = activeSlots[i];
      if (useFrustum && !this._frustum.intersectsBox(sl.worldBox)) continue;
      if (sl.lod === 'near') {
        sl.mesh.geometry = sl.nearGeo;
        nearVis++;
      } else {
        sl.mesh.geometry = sl.farGeo;
        farVis++;
      }
      sl.mesh.visible = true;
    }
    this.visibleNearTiles = nearVis;
    this.visibleFarTiles = farVis;
  }

  get totalVisibleInstances() {
    return this.visibleNearTiles * this.nearCount + this.visibleFarTiles * this.farCount;
  }

  dispose() {
    for (let i = 0; i < this.slots.length; i++) {
      const sl = this.slots[i];
      sl.mesh.removeFromParent();
      sl.nearGeo.dispose();
      if (sl.farGeo !== sl.nearGeo) sl.farGeo.dispose();
    }
    this.group.removeFromParent();
    this.slots.length = 0;
    this.tileMap.clear();
    this._bakeQuadGeo.dispose();
    this._bakeMat.dispose();
    this.scatterTex.dispose();
    this.atlasRT.dispose();
  }
}
