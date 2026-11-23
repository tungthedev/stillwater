import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, it, expect } from 'vitest';
import { VALLEY } from '../content/valley.js';
import { QUALITY } from '../engine/quality.js';
import { loadWorld, selectByRank } from './worldData.js';
import {
  groupIntoCells,
  cellBoundingSphere,
  nearCellsInRange,
  lodForDistance,
  treeLevel,
  impostorView,
  cellIndex,
  cellDistance,
  LOD_HERO,
  LOD_MID,
  LOD_FAR,
  IMPOSTOR_AZ,
} from './treeChunks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEAR = 64;
const FAR = 512;
const HERO = 32;

function fsFetch(url) {
  const buf = fs.readFileSync(path.join(ROOT, 'public', url.replace(/^\/+/, '')));
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  });
}

let trees;
beforeAll(async () => {
  const world = await loadWorld(VALLEY, { baseUrl: '/', fetch: fsFetch });
  trees = world.placements.trees;
}, 60000);

describe('tree cell grouping (baked valley)', () => {
  it('puts every tree in exactly one near cell that contains it, per species', () => {
    const cells = groupIntoCells(trees, NEAR);
    const seen = new Uint8Array(trees.length);
    let total = 0;
    for (const c of cells.values()) {
      let n = 0;
      c.bySpecies.forEach((list, v) => {
        for (const i of list) {
          const t = trees[i];
          expect(t.v).toBe(v);
          expect(cellIndex(t.x, NEAR)).toBe(c.ix);
          expect(cellIndex(t.z, NEAR)).toBe(c.iz);
          seen[i]++;
          n++;
        }
      });
      expect(n).toBe(c.count);
      total += n;
    }
    expect(total).toBe(trees.length);
    expect(seen.every((s) => s === 1)).toBe(true);
  }, 30000);

  it('far impostor cells hold every tree except bushes', () => {
    const cells = groupIntoCells(trees, FAR, { filter: (t) => !t.bush });
    let total = 0;
    for (const c of cells.values()) {
      expect(c.bySpecies[3]).toHaveLength(0);
      total += c.count;
    }
    expect(total).toBe(trees.filter((t) => !t.bush).length);
    // 4 km valley in 512 m cells: at most 9 x 9 including edge cells.
    expect(cells.size).toBeLessThanOrEqual(81);
  }, 30000);

  it('cell bounding spheres contain every tree base and crown top they hold', () => {
    for (const size of [NEAR, FAR]) {
      for (const c of groupIntoCells(trees, size).values()) {
        const bs = cellBoundingSphere(c, 0);
        for (const list of c.bySpecies) {
          for (const i of list) {
            const t = trees[i];
            for (const y of [t.y, t.y + t.s]) {
              expect(Math.hypot(t.x - bs.x, y - bs.y, t.z - bs.z)).toBeLessThanOrEqual(bs.r + 1e-6);
            }
          }
        }
      }
    }
  }, 30000);

  it('is deterministic and uses the same rank subsets as the tier table', () => {
    const a = groupIntoCells(selectByRank(trees, QUALITY.low.trees), NEAR);
    const b = groupIntoCells(selectByRank(trees, QUALITY.low.trees), NEAR);
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [k, c] of a) expect(c.bySpecies).toEqual(b.get(k).bySpecies);
  }, 30000);
});

describe('tree LOD selection (baked valley)', () => {
  const poses = [
    ['trailhead', VALLEY.start.x, VALLEY.start.z],
    ['lake shore', VALLEY.lake.x + VALLEY.lake.rx + 30, VALLEY.lake.z],
    ['summit', VALLEY.summit.x, VALLEY.summit.z],
  ];

  it('measures cell distance to the nearest point of the cell square', () => {
    expect(cellDistance(32, 32, 64, 10, 50)).toBe(0);
    expect(cellDistance(32, 32, 64, 74, 32)).toBe(10);
    expect(cellDistance(32, 32, 64, 67, 68)).toBeCloseTo(5, 9);
  });

  it('picks hero, mid, far by distance', () => {
    expect(lodForDistance(10, 40, 130)).toBe(LOD_HERO);
    expect(lodForDistance(40, 40, 130)).toBe(LOD_MID);
    expect(lodForDistance(129.9, 40, 130)).toBe(LOD_MID);
    expect(lodForDistance(130, 40, 130)).toBe(LOD_FAR);
  });

  for (const tierName of ['low', 'medium', 'high', 'ultra']) {
    it(`draws each tree at exactly one level on ${tierName}, matching the active cells`, () => {
      const tier = QUALITY[tierName];
      const drawn = selectByRank(trees, tier.trees);
      const midCells = groupIntoCells(drawn, NEAR);
      const heroCells = groupIntoCells(drawn, HERO);
      for (const [, x, z] of poses) {
        const heroOn = nearCellsInRange(heroCells, HERO, x, z, tier.treeHeroR, tier.treeHeroR);
        const midOn = nearCellsInRange(midCells, NEAR, x, z, 0, tier.treeMidR);
        const counts = { hero: 0, mid: 0, impostor: 0, none: 0 };
        const bad = [];
        for (const t of drawn) {
          const level = treeLevel(t, NEAR, x, z, tier.treeHeroR, tier.treeMidR, tier.treeBushR, HERO);
          counts[level]++;
          const hk = cellIndex(t.x, HERO) + ',' + cellIndex(t.z, HERO);
          const mk = cellIndex(t.x, NEAR) + ',' + cellIndex(t.z, NEAR);
          const d = Math.hypot(t.x - x, t.z - z);
          if (level === 'hero') {
            if (!heroOn.has(hk) || d >= tier.treeHeroR + HERO * Math.SQRT2) bad.push(['hero', t]);
          } else if (level === 'mid') {
            // the mid batch is in the scene and its shader does not hide this instance
            if (!midOn.has(mk) || heroOn.has(hk) || d >= tier.treeMidR + NEAR * Math.SQRT2) bad.push(['mid', t]);
          } else if (level === 'impostor') {
            // the impostor shader hides instances inside active mid cells
            if (t.bush || midOn.has(mk) || d < tier.treeMidR) bad.push(['impostor', t]);
          } else if (!t.bush) {
            bad.push(['tree not drawn', t]);
          }
          // nothing inside the hero radius ever draws below hero detail
          if (d < tier.treeHeroR && level !== 'hero') bad.push(['close not hero', t]);
        }
        expect(bad.slice(0, 3)).toEqual([]);
        expect(counts.hero + counts.mid + counts.impostor + counts.none).toBe(drawn.length);
        expect(counts.impostor).toBeGreaterThan(drawn.length * 0.8);
      }
    }, 30000);
  }

  it('keeps hero trees a small share near the forested trailhead on high', () => {
    const tier = QUALITY.high;
    const drawn = selectByRank(trees, tier.trees);
    const [x, z] = [VALLEY.start.x, VALLEY.start.z];
    const level = (t) => treeLevel(t, NEAR, x, z, tier.treeHeroR, tier.treeMidR, tier.treeBushR, HERO);
    const hero = drawn.filter((t) => level(t) === 'hero').length;
    const mid = drawn.filter((t) => level(t) === 'mid').length;
    expect(hero + mid).toBeGreaterThan(hero);
    expect(hero).toBeGreaterThan(0);
    expect(hero).toBeLessThan(150);
    expect(mid).toBeLessThan(3000);
  }, 30000);
});

describe('impostor view selection', () => {
  it('maps directions to the nearest azimuth column and elevation row', () => {
    expect(impostorView(0, 0, 1)).toEqual({ az: 0, el: 0 });
    expect(impostorView(1, 0, 0)).toEqual({ az: 2, el: 0 });
    expect(impostorView(0, 0, -1)).toEqual({ az: 4, el: 0 });
    expect(impostorView(-1, 0, 0)).toEqual({ az: 6, el: 0 });
    expect(impostorView(Math.sin(-0.1), 0, Math.cos(-0.1))).toEqual({ az: 0, el: 0 });
    expect(impostorView(0, Math.tan(0.6), 1).el).toBe(1);
    expect(impostorView(0, 10, 1).el).toBe(2);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const { az } = impostorView(Math.sin(a), 0.1, Math.cos(a));
      expect(az).toBeGreaterThanOrEqual(0);
      expect(az).toBeLessThan(IMPOSTOR_AZ);
    }
  });
});
