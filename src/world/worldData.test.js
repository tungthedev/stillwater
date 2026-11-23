import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { VALLEY } from '../content/valley.js';
import { buildBiome } from './biome.js';
import {
  WorldData,
  placementRank,
  treePlacementRank,
  selectByRank,
  generateTreePlacements,
  applySceneryEdits,
  createBiomeData,
  encodePlacements,
  decodePlacements,
  encodeBakedWorld,
  decodeBakedWorld,
  loadWorld,
} from './worldData.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAKED_VALLEY_DIR = path.join(ROOT, 'public', 'worlds', 'valley');

function makeFsFetch() {
  return async (url) => {
    const rel = url.replace(/^\/+/, '');
    const abs = path.join(ROOT, 'public', rel);
    const buf = fs.readFileSync(abs);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(buf.toString('utf8')),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
}

function makeSyntheticWorld() {
  const region = {
    id: 'test-region',
    size: 256,
    res: 64,
    farSize: 1024,
    farRes: 32,
    waterLevel: 10,
    lake: { x: 0, z: 0, rx: 20, rz: 20 },
    valley: { x: 0, z: 0 },
    summit: { x: 80, z: 80 },
    start: { x: -80, z: -80 },
    boundary: 120,
    biomeRes: 32,
  };

  // Tilted heightfield h(x, z) = 50 + 0.25 * x - 0.1 * z so height & normal have exact analytic values.
  const N = region.res * region.res;
  const heights = new Float32Array(N);
  const mask = new Float32Array(N);
  for (let iz = 0; iz < region.res; iz++) {
    for (let ix = 0; ix < region.res; ix++) {
      const wx = ((ix + 0.5) / region.res) * region.size - region.size / 2;
      const wz = ((iz + 0.5) / region.res) * region.size - region.size / 2;
      heights[iz * region.res + ix] = 50 + 0.25 * wx - 0.1 * wz;
      mask[iz * region.res + ix] = Math.abs(wz) < 4 ? 0.8 : 0;
    }
  }
  const farHeights = new Float32Array(region.farRes * region.farRes).fill(50);

  const bN = region.biomeRes * region.biomeRes;
  const bRgba = new Uint8Array(bN * 4);
  const bForest = new Float32Array(bN);
  for (let i = 0; i < bN; i++) {
    bRgba[i * 4] = 180;
    bRgba[i * 4 + 1] = 64;
    bRgba[i * 4 + 2] = 128;
    bRgba[i * 4 + 3] = 255;
    bForest[i] = 0.7;
  }
  const biome = createBiomeData(bRgba, bForest, region.biomeRes, region.size);

  const trailPoints = [];
  const trailHeights = [];
  const trailDist = [];
  for (let i = 0; i <= 20; i++) {
    const x = -50 + i * 5;
    const z = 0;
    trailPoints.push([x, z]);
    trailHeights.push(50 + 0.25 * x);
    trailDist.push(i * 5);
  }
  const trail = {
    points: trailPoints,
    heights: trailHeights,
    dist: trailDist,
    shore: { x: 0, z: 0 },
    ridge: { x: 25, z: 0 },
  };
  const streamPlan = {
    points: [[10, -40], [10, -20], [10, 0], [10, 20]],
    heights: [60, 55, 50, 45],
    brink: 1,
  };

  const trees = [
    { x: 10, y: 52, z: 10, s: 12, rot: 0.5, v: 0, sx: 1.0, tint: [1, 1, 1], bush: false, rank: 0.1 },
    { x: 18, y: 54, z: 12, s: 10, rot: 1.0, v: 2, sx: 0.9, tint: [0.9, 1, 0.9], bush: false, rank: 0.65 },
    { x: 12, y: 52, z: 11, s: 2, rot: 0.2, v: 3, sx: 1.0, tint: [1, 1, 1], bush: true, rank: 0.2 },
    { x: -110, y: 35, z: -110, s: 14, rot: 2.0, v: 1, sx: 1.1, tint: [1, 0.95, 0.9], bush: false, rank: 0.9 },
    { x: 110, y: 65, z: 110, s: 13, rot: 2.5, v: 1, sx: 1.0, tint: [1, 1, 1], bush: false, rank: 0.95 },
  ];
  const rocks = [
    { x: 15, y: 53, z: 15, s: 2.5, v: 0, rot: 0.4, tilt: [0, 0], rank: 0.3 },
    { x: -40, y: 40, z: 30, s: 1.2, v: 1, rot: 1.2, tilt: [0.1, -0.1], rank: 0.85 },
  ];
  const anchors = {
    house: { x: 0, z: 20, r: 8.5, front: [0, -1], ry: Math.PI },
    benches: [{ x: 0, z: 5, y: 50, ry: 0 }],
    falls: null,
    pois: [{ name: 'Test POI', sub: 'sub', x: 0, z: 0, r: 20 }],
    summit: { x: 50, z: 0, h: 63 },
  };

  const world = new WorldData({
    region,
    heights,
    mask,
    farHeights,
    trail,
    streamPlan,
    biome,
    placements: { trees, heroOaks: [[20, 20, 18, 1.0, [0.9, 1.0, 0.9]]], rocks },
    anchors,
    forestIdx: 10,
    source: 'live',
  });
  return { region, world };
}

describe('WorldData queries', () => {
  it('samples height, normal, path mask, biome, and nearest path/stream accurately', () => {
    const { world } = makeSyntheticWorld();

    expect(world.height(20, -10)).toBeCloseTo(50 + 0.25 * 20 - 0.1 * -10, 3);
    const n = world.normal(0, 0, 2.0);
    const invLen = 1 / Math.hypot(-0.25, 1, 0.1);
    expect(n.x).toBeCloseTo(-0.25 * invLen, 3);
    expect(n.y).toBeCloseTo(1 * invLen, 3);
    expect(n.z).toBeCloseTo(0.1 * invLen, 3);

    expect(world.isPath(0, 0)).toBe(true);
    expect(world.isPath(0, 40)).toBe(false);

    const b = world.biomeAt(0, 0);
    expect(b.forest).toBeCloseTo(0.7, 3);
    expect(b.flowers).toBeCloseTo(64 / 255, 3);
    expect(b.meadow).toBeCloseTo(128 / 255, 3);

    const np = world.nearestPath(11, 7);
    expect(np.x).toBe(10);
    expect(np.z).toBe(0);
    expect(np.dist).toBeCloseTo(Math.hypot(1, 7), 4);
    expect(np.along).toBe(60);

    const ns = world.nearestStream(13, -19);
    expect(ns.x).toBe(10);
    expect(ns.z).toBe(-20);
    expect(ns.dist).toBeCloseTo(Math.hypot(3, 1), 4);
  });

  it('queries placementsInRadius across cell boundaries and respects filters', () => {
    const { world } = makeSyntheticWorld();

    const nearTrees = world.placementsInRadius(14, 11, 10, 'trees');
    expect(nearTrees).toHaveLength(3);

    const trunksOnly = world.placementsInRadius(14, 11, 10, 'trees', { includeBushes: false });
    expect(trunksOnly).toHaveLength(2);
    expect(trunksOnly.every((t) => !t.bush)).toBe(true);

    const lowRankOnly = world.placementsInRadius(14, 11, 10, 'trees', { includeBushes: false, maxRank: 0.55 });
    expect(lowRankOnly).toHaveLength(1);
    expect(lowRankOnly[0].x).toBe(10);

    const nearAll = world.placementsInRadius(14, 12, 10, 'all');
    expect(nearAll.some((item) => item.kind === 'tree')).toBe(true);
    expect(nearAll.some((item) => item.kind === 'rock')).toBe(true);
  });

  it('collides against full canonical trees regardless of rank and ignores bushes', () => {
    const { world } = makeSyntheticWorld();

    // Tree at (18, 12) has rank 0.65 (not drawn on low tier 0.55) but MUST still collide.
    const pos = { x: 18.1, z: 12.0 };
    world.collideTrees(pos, 0.4);
    const dist = Math.hypot(pos.x - 18, pos.z - 12);
    expect(dist).toBeCloseTo(10 * 0.03 + 0.4, 4);

    // Bush at (12, 11) must not push the player.
    const bushPos = { x: 12.05, z: 11.0 };
    world.collideTrees(bushPos, 0.4);
    expect(bushPos.x).toBeCloseTo(12.05, 5);
    expect(bushPos.z).toBeCloseTo(11.0, 5);
  });
});

describe('Rank-based tier subset selection', () => {
  it('assigns deterministic ranks in [0, 1) and nests subsets monotonically across tiers', () => {
    const items = [];
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50) * 11.3 - 250;
      const z = Math.floor(i / 50) * 9.7 - 200;
      const r1 = placementRank(x, z, i % 6, 1);
      const r2 = placementRank(x, z, i % 6, 1);
      expect(r1).toBe(r2);
      expect(r1).toBeGreaterThanOrEqual(0);
      expect(r1).toBeLessThan(1);
      items.push({ id: i, x, z, rank: r1 });
    }

    const low = selectByRank(items, 0.55);
    const med = selectByRank(items, 0.8);
    const high = selectByRank(items, 1.0);

    expect(high).toHaveLength(items.length);
    expect(low.length).toBeGreaterThan(items.length * 0.48);
    expect(low.length).toBeLessThan(items.length * 0.62);
    expect(med.length).toBeGreaterThan(low.length);

    const medSet = new Set(med.map((it) => it.id));
    const highSet = new Set(high.map((it) => it.id));
    for (const it of low) expect(medSet.has(it.id)).toBe(true);
    for (const it of med) expect(highSet.has(it.id)).toBe(true);
    expect(selectByRank(items, 0)).toHaveLength(0);
  });
});

describe('Scenery edits as data rows', () => {
  it('applies explicit circle rows and named rules without mutating inputs', () => {
    const trees = [
      { x: 0, y: 0, z: 0, s: 10, bush: false, rank: 0.1 },    // cleared by explicit tree circle
      { x: -11, y: 0, z: 0, s: 10, bush: false, rank: 0.2 },  // dist 11 < 10 + 10*0.2 = 12 -> cleared
      { x: -11, y: 0, z: 0, s: 2, bush: true, rank: 0.3 },    // bush pad is 0 -> dist 11 >= 10 -> survives (behind bench)
      { x: 50, y: 0, z: 0, s: 10, bush: false, rank: 0.4 },   // cleared by benchSightlines (+X)
      { x: 200, y: 0, z: 200, s: 10, bush: false, rank: 0.5 }, // survives
    ];
    const rocks = [
      { x: 0, y: 0, z: 0, s: 2, rank: 0.1 },    // untouched by tree edit, cleared by rock edit
      { x: 30, y: 0, z: 0, s: 2, rank: 0.2 },   // cleared by rayClear
      { x: 200, y: 0, z: 200, s: 2, rank: 0.3 }, // survives
    ];

    const edits = [
      { target: 'trees', x: 0, z: 0, r: 10 },
      { target: 'rocks', x: 0, z: 0, r: 5 },
      { rule: 'rayClear', target: 'rocks', x: 10, z: 0, dx: 1, dz: 0, dMin: 10, dMax: 30, dStep: 10, r: 4 },
      { rule: 'benchSightlines', target: 'trees', dMin: 10, dMax: 60, dStep: 10, rBase: 4, rSlope: 0.2 },
    ];
    const anchors = {
      benches: [{ x: 0, z: 0, y: 0, ry: Math.PI / 2 }], // faces +X
    };

    const result = applySceneryEdits({ trees, rocks, heroOaks: [] }, edits, { anchors });
    expect(trees).toHaveLength(5);
    expect(rocks).toHaveLength(3);
    expect(result.trees.map((t) => [t.x, t.bush])).toEqual([[-11, true], [200, false]]);
    expect(result.rocks.map((r) => r.x)).toEqual([200]);
  });
});

describe('Baked world encoding & region loader', () => {
  it('round-trips encodeBakedWorld -> decodeBakedWorld with stable hash and region validation', () => {
    const { region, world } = makeSyntheticWorld();
    const { manifest, files, decoded } = encodeBakedWorld(world, { renderer: 'test-gpu' });
    const decoded2 = decodeBakedWorld(manifest, files, region);

    expect(decoded.hash).toBe(manifest.worldHash);
    expect(decoded2.hash).toBe(manifest.worldHash);
    expect(decoded2.placements.trees).toHaveLength(world.placements.trees.length);
    for (let i = 0; i < world.placements.trees.length; i++) {
      expect(decoded2.placements.trees[i].x).toBeCloseTo(world.placements.trees[i].x, 2);
      expect(decoded2.placements.trees[i].z).toBeCloseTo(world.placements.trees[i].z, 2);
    }
    expect(decoded2.placements.rocks).toHaveLength(world.placements.rocks.length);
    expect(decoded2.placements.heroOaks).toHaveLength(1);
    expect(decoded2.height(20, -10)).toBeCloseTo(world.height(20, -10), 2);
    expect(decoded2.nearestPath(11, 7).x).toBe(10);

    expect(() => decodeBakedWorld(manifest, files, { ...region, id: 'other-region' })).toThrow(/Region mismatch/);
  });

  it('loads the real baked valley region files when present on disk', async () => {
    const manifestPath = path.join(BAKED_VALLEY_DIR, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const loaded = await loadWorld(VALLEY, { baseUrl: '/', fetch: makeFsFetch() });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(loaded.region.id).toBe('valley');
    expect(loaded.hash).toBe(manifest.worldHash);
    expect(loaded.placements.trees.length).toBe(manifest.counts.trees);
    expect(loaded.placements.trees.length).toBeGreaterThan(100000);
    expect(loaded.placements.rocks.length).toBe(manifest.counts.rocks);
    expect(loaded.placements.heroOaks.length).toBe(4);
    expect(loaded.pois.length).toBe(4);

    // Check monotonic tier rank subset ratios on real canonical trees
    const lowTrees = selectByRank(loaded.placements.trees, 0.55);
    const medTrees = selectByRank(loaded.placements.trees, 0.8);
    const ratioLow = lowTrees.length / loaded.placements.trees.length;
    const ratioMed = medTrees.length / loaded.placements.trees.length;
    expect(ratioLow).toBeGreaterThan(0.53);
    expect(ratioLow).toBeLessThan(0.57);
    expect(ratioMed).toBeGreaterThan(0.78);
    expect(ratioMed).toBeLessThan(0.82);

    // Check scenery edit actually cleared the cottage yard in baked data
    const house = loaded.anchors.house;
    const treesInYard = loaded.placementsInRadius(house.x, house.z, 14.5, 'trees');
    expect(treesInYard.length).toBe(0);
  });

  it('preserves every tree rank bit-exactly from generation through encode/decode on the real baked valley', async () => {
    const loaded = await loadWorld(VALLEY, { baseUrl: '/', fetch: makeFsFetch() });

    // 1. Every tree already in the real baked placements.bin matches the quantized-coord rank
    //    and survives re-encode/decode without any rank changing.
    let bakedMismatches = 0;
    for (let i = 0; i < loaded.placements.trees.length; i++) {
      const t = loaded.placements.trees[i];
      if (t.rank !== treePlacementRank(t.x, t.z, t.v, t.salt, VALLEY.size)) bakedMismatches++;
    }
    expect(bakedMismatches).toBe(0);

    const reEncoded = encodePlacements(loaded.placements, loaded.anchors, loaded.forestIdx, VALLEY.size);
    const reDecoded = decodePlacements(reEncoded, loaded.hf);
    expect(reDecoded.placements.trees).toHaveLength(loaded.placements.trees.length);
    let reDecodeMismatches = 0;
    for (let i = 0; i < loaded.placements.trees.length; i++) {
      if (reDecoded.placements.trees[i].rank !== loaded.placements.trees[i].rank) reDecodeMismatches++;
    }
    expect(reDecodeMismatches).toBe(0);

    // 2. Fresh generation on the real valley heightfield + biome: every single generated tree's
    //    rank before encode equals its rank after decode (0 mismatches across ~160k trees).
    const rawTrees = generateTreePlacements(loaded.hf, loaded.biome, VALLEY);
    const edited = applySceneryEdits(
      { trees: rawTrees, rocks: loaded.placements.rocks, heroOaks: [] },
      VALLEY.sceneryEdits,
      { trail: loaded.trail, streamPlan: loaded.streamPlan, biome: loaded.biome, anchors: loaded.anchors },
    );
    expect(edited.trees.length).toBeGreaterThan(100000);
    const encoded = encodePlacements(
      { trees: edited.trees, rocks: edited.rocks, heroOaks: edited.heroOaks },
      loaded.anchors,
      edited.forestIdx,
      VALLEY.size,
    );
    const decoded = decodePlacements(encoded, loaded.hf);
    expect(decoded.placements.trees).toHaveLength(edited.trees.length);
    let genMismatches = 0;
    for (let i = 0; i < edited.trees.length; i++) {
      if (decoded.placements.trees[i].rank !== edited.trees[i].rank) genMismatches++;
    }
    expect(genMismatches).toBe(0);

    // 3. Explicit-rank fallback: if a tree carries a non-derived rank even with salt 1..3,
    //    encodePlacements stores explicit u16 ranks so decode still preserves it exactly.
    const customRank = 12345 / 65536;
    const customTrees = [
      { x: 10.0049, y: 50, z: -20.0051, s: 12, rot: 1.0, sx: 1.0, tint: [1, 1, 1], v: 0, salt: 1, bush: false, rank: customRank },
    ];
    const customEnc = encodePlacements({ trees: customTrees, rocks: [], heroOaks: [] }, {}, 0, VALLEY.size);
    const customDec = decodePlacements(customEnc, loaded.hf);
    expect(customDec.placements.trees[0].rank).toBe(customRank);
  });

  it('returns matching query results from live (buildBiome) and baked WorldData on valley sample points', async () => {
    const baked = await loadWorld(VALLEY, { baseUrl: '/', fetch: makeFsFetch() });

    // Construct a live-equivalent WorldData using the real live buildBiome() on the same valley heightfield.
    const liveBiome = buildBiome(baked.hf, VALLEY);
    const rawTrees = generateTreePlacements(baked.hf, liveBiome, VALLEY);
    const edited = applySceneryEdits(
      { trees: rawTrees, rocks: baked.placements.rocks, heroOaks: [] },
      VALLEY.sceneryEdits,
      { trail: baked.trail, streamPlan: baked.streamPlan, biome: liveBiome, anchors: baked.anchors },
    );
    const liveWorld = new WorldData({
      region: VALLEY,
      heights: baked.heights,
      mask: baked.mask,
      farHeights: baked.farHeights,
      trail: baked.trail,
      streamPlan: baked.streamPlan,
      biome: liveBiome,
      placements: { trees: edited.trees, rocks: edited.rocks, heroOaks: edited.heroOaks },
      anchors: baked.anchors,
      forestIdx: edited.forestIdx,
      source: 'live',
    });

    // Encode -> decode the liveWorld and compare live vs baked-from-live AND live vs real baked-on-disk.
    const { manifest, files } = encodeBakedWorld(liveWorld, { renderer: 'test-live-vs-baked' });
    const roundTripped = decodeBakedWorld(manifest, files, VALLEY);

    const trailStart = baked.trail.points[0];
    const forestPt = baked.trail.points[baked.forestIdx];
    const streamMid = baked.streamPlan.points[Math.floor(baked.streamPlan.points.length / 2)];
    const samplePoints = [
      { label: 'trailStart', x: trailStart[0], z: trailStart[1] },
      { label: 'valleyStart', x: VALLEY.start.x, z: VALLEY.start.z },
      { label: 'cottage', x: baked.anchors.house.x, z: baked.anchors.house.z },
      { label: 'lakeBench', x: baked.anchors.benches[0].x, z: baked.anchors.benches[0].z },
      { label: 'saddleBench', x: baked.anchors.benches[1].x, z: baked.anchors.benches[1].z },
      { label: 'summit', x: baked.anchors.summit.x, z: baked.anchors.summit.z },
      { label: 'forestCathedral', x: forestPt[0], z: forestPt[1] },
      { label: 'streamMid', x: streamMid[0], z: streamMid[1] },
    ];

    // Trail start must report the same non-zero meadow value on BOTH live and baked paths
    // (regression: live buildBiome previously omitted sampleMeadow, returning meadow: 0).
    const startLiveBiome = liveWorld.biomeAt(trailStart[0], trailStart[1]);
    const startBakedBiome = baked.biomeAt(trailStart[0], trailStart[1]);
    expect(startBakedBiome.meadow).toBeGreaterThan(0.1);
    expect(startLiveBiome.meadow).toBe(startBakedBiome.meadow);
    const valleyStartLive = liveWorld.biomeAt(VALLEY.start.x, VALLEY.start.z);
    const valleyStartBaked = baked.biomeAt(VALLEY.start.x, VALLEY.start.z);
    expect(valleyStartBaked.meadow).toBeGreaterThan(0.1);
    expect(valleyStartLive.meadow).toBe(valleyStartBaked.meadow);

    for (const pt of samplePoints) {
      const lb = liveWorld.biomeAt(pt.x, pt.z);
      const rb = roundTripped.biomeAt(pt.x, pt.z);
      const db = baked.biomeAt(pt.x, pt.z);

      // Live vs round-tripped baked: flowers & meadow are lossless RGB8, forest is u16-quantized.
      expect(lb.flowers).toBe(rb.flowers);
      expect(lb.meadow).toBe(rb.meadow);
      expect(lb.forest).toBeCloseTo(rb.forest, 4);

      // Live (on real valley hf) vs real baked files on disk.
      expect(lb.flowers).toBeCloseTo(db.flowers, 2);
      expect(lb.meadow).toBeCloseTo(db.meadow, 2);
      expect(lb.forest).toBeCloseTo(db.forest, 2);

      // Other WorldData queries match between live and baked.
      expect(liveWorld.height(pt.x, pt.z)).toBeCloseTo(roundTripped.height(pt.x, pt.z), 3);
      const ln = liveWorld.normal(pt.x, pt.z);
      const rn = roundTripped.normal(pt.x, pt.z);
      expect(ln.x).toBeCloseTo(rn.x, 3);
      expect(ln.y).toBeCloseTo(rn.y, 3);
      expect(ln.z).toBeCloseTo(rn.z, 3);
      expect(liveWorld.trailAt(pt.x, pt.z)).toBeCloseTo(roundTripped.trailAt(pt.x, pt.z), 4);
      expect(liveWorld.isPath(pt.x, pt.z)).toBe(roundTripped.isPath(pt.x, pt.z));
      expect(liveWorld.nearestPath(pt.x, pt.z).index).toBe(roundTripped.nearestPath(pt.x, pt.z).index);
      expect(liveWorld.nearestStream(pt.x, pt.z).index).toBe(roundTripped.nearestStream(pt.x, pt.z).index);

      const liveLow = liveWorld.placementsInRadius(pt.x, pt.z, 40, 'trees', { maxRank: 0.55 });
      const rtLow = roundTripped.placementsInRadius(pt.x, pt.z, 40, 'trees', { maxRank: 0.55 });
      expect(rtLow.map((t) => t.rank)).toEqual(liveLow.map((t) => t.rank));
    }

    liveWorld.dispose();
    roundTripped.dispose();
    baked.dispose();
  });
});
