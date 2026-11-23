import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { QUALITY, TIER_NAMES } from '../engine/quality.js';
import { Grass, Flowers } from './grass.js';
import {
  TILE_HEIGHT_MIN,
  TILE_HEIGHT_RANGE,
  tileKey,
  worldToTileCoord,
  tileFlipBits,
  tileNearestDistSq,
  selectTileRing,
  computeTileBounds,
  generateTileScatter,
  packGrassTexelCPU,
  unpackGrassTexelCPU,
  computeAtlasGrid,
  TileRingAtlas,
} from './grassTiles.js';

describe('grassTiles: tile ring selection and LOD classification', () => {
  it('selects every tile intersecting the ring circle and none outside it', () => {
    const tileSize = 12;
    const radius = 30;
    const nearLodDist = 20;
    const camX = 17.3;
    const camZ = -42.8;
    const ring = selectTileRing(camX, camZ, { tileSize, radius, nearLodDist });

    expect(ring.length).toBeGreaterThan(0);
    const seen = new Set();
    for (const t of ring) {
      expect(seen.has(t.key)).toBe(false);
      seen.add(t.key);
      expect(t.ox).toBe(t.tx * tileSize);
      expect(t.oz).toBe(t.tz * tileSize);
      expect(t.nearestDistSq).toBeLessThanOrEqual(radius * radius + 1e-6);
      if (t.lod === 'far') {
        expect(t.nearestDistSq).toBeGreaterThanOrEqual(nearLodDist * nearLodDist);
      } else {
        expect(t.nearestDistSq).toBeLessThan(nearLodDist * nearLodDist);
      }
    }

    // Verify no tile outside the returned list intersects the circle.
    const { tx: cx, tz: cz } = worldToTileCoord(camX, camZ, tileSize);
    for (let tz = cz - 5; tz <= cz + 5; tz++) {
      for (let tx = cx - 5; tx <= cx + 5; tx++) {
        const d2 = tileNearestDistSq(tx, tz, tileSize, camX, camZ);
        expect(seen.has(tileKey(tx, tz))).toBe(d2 <= radius * radius);
      }
    }
  });

  it('sorts tiles front-to-back by distance to camera', () => {
    const ring = selectTileRing(5, 5, { tileSize: 12, radius: 38, nearLodDist: 24 });
    for (let i = 1; i < ring.length; i++) {
      expect(ring[i].centerDistSq).toBeGreaterThanOrEqual(ring[i - 1].centerDistSq);
    }
  });

  it('guarantees every point inside a far tile is at or beyond nearLodDist', () => {
    const tileSize = 12;
    const radius = 38;
    const nearLodDist = 24;
    const camX = 11.9;
    const camZ = 0.1;
    const ring = selectTileRing(camX, camZ, { tileSize, radius, nearLodDist });
    const farTiles = ring.filter((t) => t.lod === 'far');
    expect(farTiles.length).toBeGreaterThan(0);

    for (const t of farTiles) {
      // Sample corners and interior points; every single point must be >= nearLodDist.
      for (const fx of [0, 0.5, 1]) {
        for (const fz of [0, 0.5, 1]) {
          const px = t.ox + fx * tileSize;
          const pz = t.oz + fz * tileSize;
          expect(Math.hypot(px - camX, pz - camZ)).toBeGreaterThanOrEqual(nearLodDist - 1e-9);
        }
      }
    }
  });

  it('keeps atlas capacity larger than the maximum active ring size across offsets', () => {
    for (const [tileSize, radius] of [[12, 30], [12, 38], [12, 46], [20, 96], [16, 44]]) {
      const grid = computeAtlasGrid(tileSize, radius);
      let maxActive = 0;
      for (const ox of [0, tileSize * 0.25, tileSize * 0.5]) {
        for (const oz of [0, tileSize * 0.25, tileSize * 0.5]) {
          const ring = selectTileRing(ox, oz, { tileSize, radius, nearLodDist: radius * 0.6 });
          if (ring.length > maxActive) maxActive = ring.length;
        }
      }
      expect(grid.capacity).toBeGreaterThanOrEqual(maxActive);
    }
  });

  it('validates every QUALITY tier tile ring and atlas capacity', () => {
    for (const name of TIER_NAMES) {
      const q = QUALITY[name];
      expect(q.grassTileSize).toBeGreaterThan(0);
      expect(q.grassTileSlot).toHaveLength(2);
      const nearGrass = q.grassTileSlot[0] * q.grassTileSlot[1];
      expect(q.grassFarBlades).toBeGreaterThan(0);
      expect(q.grassFarBlades).toBeLessThanOrEqual(nearGrass);
      expect(q.grassNearLod).toBeGreaterThan(0);
      expect(q.grassNearLod).toBeLessThan(q.grassRadius);

      const grassGrid = computeAtlasGrid(q.grassTileSize, q.grassRadius);
      const grassRing = selectTileRing(0, 0, {
        tileSize: q.grassTileSize,
        radius: q.grassRadius,
        nearLodDist: q.grassNearLod,
      });
      expect(grassGrid.capacity).toBeGreaterThanOrEqual(grassRing.length);
      expect(grassRing.some((t) => t.lod === 'near')).toBe(true);
      expect(grassRing.some((t) => t.lod === 'far')).toBe(true);

      const fernNear = q.fernTileSlot[0] * q.fernTileSlot[1];
      expect(q.fernFarCount).toBeGreaterThan(0);
      expect(q.fernFarCount).toBeLessThanOrEqual(fernNear);
      const fernGrid = computeAtlasGrid(q.fernTileSize, q.fernRadius);
      const fernRing = selectTileRing(0, 0, {
        tileSize: q.fernTileSize,
        radius: q.fernRadius,
        nearLodDist: q.fernNearLod,
      });
      expect(fernGrid.capacity).toBeGreaterThanOrEqual(fernRing.length);
    }
  });
});

describe('grassTiles: bounds, scatter stability, and 128-bit texel packing', () => {
  it('pads tile bounds for blade height, curvature, and bend', () => {
    const sampleH = (x, z) => 100 + 0.2 * x - 0.1 * z;
    const b = computeTileBounds(2, -3, 12, sampleH, { xz: 1.8, yDown: 0.6, yUp: 2.5 });
    expect(b.minX).toBeCloseTo(-1.8);
    expect(b.maxX).toBeCloseTo(13.8);
    expect(b.minZ).toBeCloseTo(-1.8);
    expect(b.maxZ).toBeCloseTo(13.8);
    expect(b.minY).toBeCloseTo(b.groundMinY - 0.6);
    expect(b.maxY).toBeCloseTo(b.groundMaxY + 2.5);
  });

  it('produces stratified tile scatter whose far prefix covers all quadrants evenly', () => {
    const s = generateTileScatter(64, 64, 12, 1337, true);
    expect(s.count).toBe(4096);
    const farCount = 2048;
    const quads = [0, 0, 0, 0];
    for (let i = 0; i < farCount; i++) {
      const lx = s.localXZ[i * 2];
      const lz = s.localXZ[i * 2 + 1];
      expect(lx).toBeGreaterThanOrEqual(0);
      expect(lx).toBeLessThanOrEqual(12);
      expect(lz).toBeGreaterThanOrEqual(0);
      expect(lz).toBeLessThanOrEqual(12);
      const q = (lx >= 6 ? 1 : 0) + (lz >= 6 ? 2 : 0);
      quads[q]++;
    }
    // Each quadrant should receive roughly 25% (~512) of the far prefix blades.
    for (const q of quads) {
      expect(q).toBeGreaterThan(420);
      expect(q).toBeLessThan(610);
    }

    // Packed scatter matches float attributes bit-for-bit.
    for (let i = 0; i < 32; i++) {
      const w0 = s.packed[i * 4];
      const ux = w0 & 0xffff;
      const uz = w0 >>> 16;
      expect(s.localXZ[i * 2]).toBeCloseTo((ux / 65535) * 12, 6);
      expect(s.localXZ[i * 2 + 1]).toBeCloseTo((uz / 65535) * 12, 6);
    }
  });

  it('produces deterministic per-tile flip bits', () => {
    const a = tileFlipBits(3, -7);
    const b = tileFlipBits(3, -7);
    expect(a).toEqual(b);
    expect([0, 1]).toContain(a.flipX);
    expect([0, 1]).toContain(a.flipZ);
  });

  it('round-trips every Slice 9 and Slice 9b field in 128-bit RGBA32UI with sub-cm height precision', () => {
    const input = {
      height: 412.347,
      dens: 0.78,
      forestShade: 0.67,
      style: 1,
      reedFlag: 1,
      normalX: -0.32,
      normalZ: 0.44,
      tallStatic: 1.62,
      yaw: 4.12,
      baseCol: [0.135, 0.375, 0.072],
      dryTip: 0.6,
      hollow: 0.4,
      bladeId: 0.53,
      seamWeight: 0.71,
      secondCol: [0.012, 0.070, 0.042],
    };
    const packed = packGrassTexelCPU(input);
    const out = unpackGrassTexelCPU(packed);

    // Height precision: 2112 / 1048575 = 2.01 mm (well under 1 cm!)
    expect(Math.abs(out.height - input.height)).toBeLessThan(0.0025);
    expect(Math.abs(out.dens - input.dens)).toBeLessThan(0.005);
    expect(Math.abs(out.forestShade - input.forestShade)).toBeLessThan(0.2);
    expect(out.style).toBe(1);
    expect(out.reedFlag).toBe(1);
    expect(Math.abs(out.normalX - input.normalX)).toBeLessThan(0.01);
    expect(Math.abs(out.normalZ - input.normalZ)).toBeLessThan(0.01);
    expect(Math.hypot(out.normalX, out.normalY, out.normalZ)).toBeCloseTo(1, 5);
    expect(Math.abs(out.tallStatic - input.tallStatic)).toBeLessThan(0.01);
    expect(Math.abs(out.yaw - input.yaw)).toBeLessThan(0.03);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(out.baseCol[c] - input.baseCol[c])).toBeLessThan(0.004);
      // Dark Slice 9b painted tones stay accurate via sqrt-encoded RGB666
      expect(Math.abs(out.secondCol[c] - input.secondCol[c])).toBeLessThan(0.004);
    }
    expect(Math.abs(out.dryTip - input.dryTip)).toBeLessThan(0.07);
    expect(Math.abs(out.hollow - input.hollow)).toBeLessThan(0.07);
    expect(Math.abs(out.bladeId - input.bladeId)).toBeLessThan(0.005);
    expect(Math.abs(out.seamWeight - input.seamWeight)).toBeLessThan(0.02);

    // Verify full height range endpoints.
    expect(unpackGrassTexelCPU(packGrassTexelCPU({ ...input, height: TILE_HEIGHT_MIN })).height).toBeCloseTo(TILE_HEIGHT_MIN, 2);
    expect(unpackGrassTexelCPU(packGrassTexelCPU({ ...input, height: TILE_HEIGHT_MIN + TILE_HEIGHT_RANGE })).height).toBeCloseTo(TILE_HEIGHT_MIN + TILE_HEIGHT_RANGE, 2);
  });

  it('keeps every 128-bit field isolated without bit overlap', () => {
    const zero = {
      height: TILE_HEIGHT_MIN,
      dens: 0,
      forestShade: 0,
      style: 0,
      reedFlag: 0,
      normalX: -1,
      normalZ: -1,
      tallStatic: 0,
      yaw: 0,
      baseCol: [0, 0, 0],
      dryTip: 0,
      hollow: 0,
      bladeId: 0,
      seamWeight: 0,
      secondCol: [0, 0, 0],
    };
    expect(Array.from(packGrassTexelCPU(zero))).toEqual([0, 0, 0, 0]);

    // Flip only Slice 9b fields and verify Slice 9 fields stay untouched.
    const with9b = packGrassTexelCPU({
      ...zero,
      style: 1,
      bladeId: 1,
      seamWeight: 1,
      secondCol: [1, 1, 1],
    });
    const out = unpackGrassTexelCPU(with9b);
    expect(out.style).toBe(1);
    expect(out.bladeId).toBeCloseTo(1, 5);
    expect(out.seamWeight).toBeCloseTo(1, 5);
    expect(out.secondCol).toEqual([1, 1, 1]);
    expect(out.height).toBeCloseTo(TILE_HEIGHT_MIN, 5);
    expect(out.dens).toBe(0);
    expect(out.reedFlag).toBe(0);
    expect(out.baseCol).toEqual([0, 0, 0]);
  });

  it('reuses cached tiles without re-baking on small moves and frustum-culls tiles outside view', () => {
    const nearGeo = new THREE.BufferGeometry();
    nearGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const farGeo = new THREE.BufferGeometry();
    farGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mat = new THREE.MeshBasicMaterial();

    const atlas = new TileRingAtlas({
      renderer: null, // CPU-only test: skips WebGL bake render call while tracking tile entries
      hf: { height: () => 50 },
      tileSize: 12,
      radius: 30,
      nearLodDist: 18,
      slotW: 8,
      slotH: 8,
      farCount: 32,
      nearBaseGeo: nearGeo,
      farBaseGeo: farGeo,
      material: mat,
      bakeFragBody: 'void main() { outData = uvec4(0u); }',
    });

    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 1000);
    cam.position.set(6, 52, 6);
    cam.lookAt(6, 52, -50);
    cam.updateMatrixWorld();

    atlas.update(cam);
    const initialBakes = atlas.lastBakeCount;
    expect(initialBakes).toBeGreaterThan(10);
    const visibleTotal = atlas.visibleNearTiles + atlas.visibleFarTiles;
    expect(visibleTotal).toBeGreaterThan(0);
    expect(visibleTotal).toBeLessThan(initialBakes); // frustum culling drops tiles behind camera

    // Moving 0.5 m across the outer ring edge may enter a new tile once,
    // then stepping back and forth reuses cached slots with zero re-bakes.
    cam.position.set(6.5, 52, 5.5);
    cam.lookAt(6.5, 52, -50);
    cam.updateMatrixWorld();
    atlas.update(cam);

    cam.position.set(6, 52, 6);
    cam.lookAt(6, 52, -50);
    cam.updateMatrixWorld();
    atlas.update(cam);
    expect(atlas.lastBakeCount).toBe(0);

    cam.position.set(6.5, 52, 5.5);
    cam.lookAt(6.5, 52, -50);
    cam.updateMatrixWorld();
    atlas.update(cam);
    expect(atlas.lastBakeCount).toBe(0);

    // Every visible tile has valid padded bounds and frustumCulled = true.
    for (const sl of atlas.slots) {
      if (!sl.mesh.visible) continue;
      expect(sl.mesh.frustumCulled).toBe(true);
      expect(sl.mesh.geometry.boundingSphere.radius).toBeGreaterThan(6);
    }

    atlas.dispose();
    nearGeo.dispose();
    farGeo.dispose();
    mat.dispose();
  });

  it('preserves Grass and Flowers group identity across setTier and counts frustum blades', () => {
    const hf = { height: () => 80, trailAt: () => 0 };
    const grass = new Grass(null, QUALITY.low, hf);
    const flowers = new Flowers(null, QUALITY.low, hf);
    const grassGroup = grass.mesh;
    const flowerGroup = flowers.mesh;

    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 1000);
    cam.position.set(100, 81.7, 100);
    cam.lookAt(100, 81.2, 60);
    cam.updateMatrixWorld();

    grass.update(cam, cam.position);
    flowers.update(cam);
    const lowStats = grass.countBladesInFrustum(cam, hf);
    expect(lowStats.visibleNearTiles).toBeGreaterThan(0);
    expect(lowStats.visibleFarTiles).toBeGreaterThan(0);
    expect(lowStats.inFrustumSurviving).toBeGreaterThan(10000);
    expect(lowStats.submittedTris).toBeLessThan(250000);

    grass.setTier(QUALITY.medium);
    flowers.setTier(QUALITY.medium);
    expect(grass.mesh).toBe(grassGroup);
    expect(flowers.mesh).toBe(flowerGroup);
    const medStats = grass.countBladesInFrustum(cam, hf);
    expect(medStats.inFrustumSurviving).toBeGreaterThan(lowStats.inFrustumSurviving);

    grass.dispose();
    flowers.dispose();
  });
});
