// Global world configuration. All distances in meters.
export const WORLD = {
  size: 4096,          // near (walkable) heightmap extent
  res: 2048,           // near heightmap resolution (2 m texels)
  farSize: 32768,      // far heightmap extent
  farRes: 2048,        // far heightmap resolution (16 m texels)
  waterLevel: 22,
  lake: { x: -150, z: 200, rx: 340, rz: 230 },
  valley: { x: -200, z: -150 },
  summit: { x: -760, z: -780 },
  start: { x: 640, z: 860 },
  boundary: 1850,      // soft walkable radius (square-ish)
  biomeRes: 512,
};
