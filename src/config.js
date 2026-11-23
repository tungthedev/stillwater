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

export const QUALITY = {
  low: { scale: 0.6, grass: 65536, grassRadius: 30, shadow: 1024, reflScale: 0.25, trees: 0.55, treeHi: 70, treeLo: 380, reflEvery: 0, bloom: true, godrays: false, msaa: 0 },
  medium: { scale: 0.75, grass: 131072, grassRadius: 38, shadow: 2048, reflScale: 0.35, trees: 0.8, treeHi: 120, treeLo: 600, reflEvery: 1, bloom: true, godrays: true, msaa: 0 },
  high: { scale: 1.0, grass: 262144, grassRadius: 46, shadow: 2048, reflScale: 0.75, trees: 1.0, bloom: true, godrays: true, msaa: 4 },
  ultra: { scale: 1.0, grass: 440000, grassRadius: 96, shadow: 4096, reflScale: 1.0, trees: 1.0, bloom: true, godrays: true, msaa: 4 },
};
