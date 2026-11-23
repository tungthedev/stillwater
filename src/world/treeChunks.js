// Pure tree cell grouping and LOD selection (no three.js, no DOM), shared by the tree system and its tests.
// Placements are bucketed once into square world cells; a cell's LOD comes from the distance between the
// LOD centre and the nearest point of the cell square, so every tree inside a radius is drawn at least at that
// level, and CPU batch toggling and the impostor shader's per-instance hide rule use the same number.

export const LOD_HERO = 0;
export const LOD_MID = 1;
export const LOD_FAR = 2;

/** Cell index along one axis for a world coordinate. */
export function cellIndex(v, size) {
  return Math.floor(v / size);
}

export function cellKey(ix, iz) {
  return ix + ',' + iz;
}

/**
 * Group placements into cells of `size` metres. Each cell keeps per-species index lists into `items`
 * (in input order, so the result is deterministic) plus an XZ/Y bound and the largest tree scale.
 * `filter(item)` excludes items (for example bushes from far impostor cells).
 */
export function groupIntoCells(items, size, { species = 6, filter = null } = {}) {
  const cells = new Map();
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    if (filter && !filter(t)) continue;
    const ix = cellIndex(t.x, size), iz = cellIndex(t.z, size);
    const key = cellKey(ix, iz);
    let c = cells.get(key);
    if (!c) {
      c = {
        key, ix, iz,
        cx: (ix + 0.5) * size, cz: (iz + 0.5) * size,
        size,
        count: 0,
        bySpecies: Array.from({ length: species }, () => []),
        minY: Infinity, maxY: -Infinity, maxS: 0,
      };
      cells.set(key, c);
    }
    c.bySpecies[t.v].push(i);
    c.count++;
    if (t.y < c.minY) c.minY = t.y;
    if (t.y > c.maxY) c.maxY = t.y;
    if (t.s > c.maxS) c.maxS = t.s;
  }
  return cells;
}

/**
 * Bounding sphere for a cell's batch: covers the XZ square, the ground spread and the tallest crown,
 * plus `pad` metres for wind sway and crowns that overhang the cell edge.
 */
export function cellBoundingSphere(cell, pad = 2) {
  const cy = (cell.minY + cell.maxY + cell.maxS) * 0.5;
  const halfY = (cell.maxY + cell.maxS - cell.minY) * 0.5;
  const halfXZ = cell.size * Math.SQRT1_2 + cell.maxS * 0.6;
  return { x: cell.cx, y: cy, z: cell.cz, r: Math.hypot(halfXZ, halfY) + pad };
}

/** LOD for a near cell whose nearest point is `dist` metres from the LOD centre. */
export function lodForDistance(dist, heroR, midR) {
  if (dist < heroR) return LOD_HERO;
  if (dist < midR) return LOD_MID;
  return LOD_FAR;
}

/** Distance from (x, z) to the nearest point of the square cell centred on (cx, cz). */
export function cellDistance(cx, cz, size, x, z) {
  const h = size * 0.5;
  const dx = Math.max(Math.abs(x - cx) - h, 0), dz = Math.max(Math.abs(z - cz) - h, 0);
  return Math.hypot(dx, dz);
}

export function cellLod(cell, x, z, heroR, midR) {
  return lodForDistance(cellDistance(cell.cx, cell.cz, cell.size, x, z), heroR, midR);
}

/**
 * Keys of the near cells that need geometry (hero or mid) for an LOD centre, with their LOD.
 * Scans only the square of cells that can be inside `midR`.
 */
export function nearCellsInRange(cells, size, x, z, heroR, midR, out = new Map()) {
  out.clear();
  const r = Math.ceil(midR / size) + 1;
  const ix0 = cellIndex(x, size), iz0 = cellIndex(z, size);
  for (let iz = iz0 - r; iz <= iz0 + r; iz++) {
    for (let ix = ix0 - r; ix <= ix0 + r; ix++) {
      const c = cells.get(cellKey(ix, iz));
      if (!c) continue;
      const lod = cellLod(c, x, z, heroR, midR);
      if (lod !== LOD_FAR) out.set(c.key, lod);
    }
  }
  return out;
}

/**
 * Which level a tree draws at for an LOD centre: 'hero', 'mid', 'impostor' or 'none'. Mirrors the runtime rule
 * (hero by its `heroSize` cell, mid by its `nearSize` cell, bushes have no impostor and stop at `bushR`) so tests
 * can check that every drawn tree has exactly one level.
 */
export function treeLevel(t, nearSize, x, z, heroR, midR, bushR = Infinity, heroSize = nearSize) {
  const cellD = (size) => cellDistance((cellIndex(t.x, size) + 0.5) * size, (cellIndex(t.z, size) + 0.5) * size, size, x, z);
  if (cellD(heroSize) < heroR) return 'hero';
  const dNear = cellD(nearSize);
  if (t.bush) return dNear < midR && dNear < bushR ? 'mid' : 'none';
  return dNear < midR ? 'mid' : 'impostor';
}

/** Number of impostor view columns and rows in an atlas tile set (azimuth x elevation). */
export const IMPOSTOR_AZ = 8;
export const IMPOSTOR_EL = 3;
/** Elevation (radians above the horizon) of each baked view row. */
export const IMPOSTOR_ELEVATIONS = [0, 0.5, 1.05];

/**
 * Nearest baked view for a direction from tree to camera given in the tree's local frame
 * (`lx`, `lz` horizontal, `ly` up). Returns { az, el } indices. The shader uses the same rule.
 */
export function impostorView(lx, ly, lz) {
  let a = Math.atan2(lx, lz);
  if (a < 0) a += Math.PI * 2;
  const az = Math.round(a / (Math.PI * 2 / IMPOSTOR_AZ)) % IMPOSTOR_AZ;
  const elev = Math.atan2(ly, Math.hypot(lx, lz));
  let el = 0;
  for (let i = 1; i < IMPOSTOR_EL; i++) {
    if (elev > (IMPOSTOR_ELEVATIONS[i - 1] + IMPOSTOR_ELEVATIONS[i]) * 0.5) el = i;
  }
  return { az, el };
}
