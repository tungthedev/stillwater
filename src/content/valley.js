// Region data for Stillwater Valley (pure data, no logic).
// All distances in meters.

export const VALLEY = {
  id: 'valley',
  name: 'Stillwater Valley',
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

  trailWaypoints: {
    shoreAngle: -0.35,
    shoreRadiusScale: 1.12,
    ridge: { x: -330, z: -470 },
  },

  cottage: {
    trailIdx: 30,
    aheadOffset: 6,
    sideOffset: 19,
  },

  pois: [
    {
      id: 'trailhead',
      name: 'Stillwater Trailhead',
      sub: 'the path begins where the road ends',
      anchor: 'trailhead',
      r: 30,
    },
    {
      id: 'lake',
      name: 'Stillwater Lake',
      sub: 'still water holds the whole sky',
      anchor: 'lake',
      r: 60,
    },
    {
      id: 'saddle',
      name: 'Larch Saddle',
      sub: 'halfway is its own kind of summit',
      anchor: 'saddle',
      r: 45,
    },
    {
      id: 'summit',
      name: 'Stillwater Peak',
      subTemplate: '{h} m · the world, quietly, all at once',
      anchor: 'summit',
      r: 40,
    },
  ],

  // Landmark glacial erratics placed in the valley.
  rockErratics: [
    [260, 520, 7],
    [-520, 380, 9],
    [40, -160, 6.5],
    [-980, -260, 11],
    [420, 120, 5.5],
    [-340, -180, 8],
    [-480, -420, 9.5],
  ],

  // Ordered scenery edits applied to canonical placements before draw buffers are built.
  // Each row is either an explicit { target, x, z, r } circle or a named rule row.
  sceneryEdits: [
    { rule: 'cottageClear', target: 'trees', r: 15 },
    { rule: 'cottageClear', target: 'rocks', r: 13 },
    { rule: 'trailStartClear', target: 'trees', count: 36, step: 3, nearCount: 16, nearR: 19, farR: 14 },
    { rule: 'trailSightline', target: 'rocks', trailFrac: 0.12, yawOffset: 0.5, dMin: 4, dMax: 26, dStep: 5, r: 8 },
    { rule: 'trailSightline', target: 'trees', trailFrac: 0.12, yawOffset: 0.5, dMin: 4, dMax: 26, dStep: 5, r: 5 },
    { rule: 'rayClear', target: 'rocks', x: -770, z: -790, dx: -0.61, dz: -0.79, dMin: 18, dMax: 185, dStep: 24, r: 34 },
    { target: 'rocks', x: -770, z: -790, r: 26 },
    { target: 'rocks', x: -798, z: -808, r: 48 },
    {
      rule: 'cottageSightline',
      target: 'trees',
      fMin: 10,
      fMax: 34,
      fStep: 6,
      sdMin: 8,
      sdMax: 84,
      sdStep: 9,
      dirX: -0.86,
      dirZ: 0.09,
      r: 12,
      camDist: 28,
      camAngleOffset: 0.5,
      camR: 12,
    },
    {
      rule: 'benchOffsetClear',
      target: 'trees',
      benchIndex: 1,
      offsets: [
        [7, -3, 14],
        [14, 6, 16],
        [20, 14, 15],
      ],
    },
    { rule: 'signpostSightline', target: 'trees', dMin: 6, dMax: 24, dStep: 6, r: 6.2 },
    {
      rule: 'forestCathedral',
      target: 'trees',
      minTrailIdx: 90,
      endMargin: 120,
      minForest: 2.15,
      corridorBack: 2,
      corridorAhead: 30,
      corridorStep: 2,
      corridorR: 5.2,
      rockDMin: 0,
      rockDMax: 18,
      rockDStep: 4,
      rockR: 8.8,
      sideClears: [
        [5.0, 7.0, 10.0],
        [15.0, 8.5, 11.0],
        [5.5, -7.0, 11.2],
        [14.0, -8.0, 10.6],
      ],
      wideStart: 12,
      wideEnd: 28,
      wideStep: 2,
      wideR: 12.2,
      heroOaks: [
        { fwd: 11.5, lat: 6.8, s: 17.5, rot: 0.9, tint: [0.88, 0.98, 0.88] },
        { fwd: 12.8, lat: -7.2, s: 18.2, rot: 2.7, tint: [0.92, 1.02, 0.90] },
        { fwd: 22.5, lat: 8.6, s: 19.0, rot: 4.1, tint: [0.96, 1.04, 0.88] },
        { fwd: 23.5, lat: -9.0, s: 17.8, rot: 5.2, tint: [0.90, 1.00, 0.86] },
      ],
    },
    { rule: 'trailSightline', target: 'rocks', trailFrac: 0.2, yawOffset: 1.8, dMin: 10, dMax: 10, dStep: 1, r: 16 },
    { rule: 'trailSightline', target: 'trees', trailFrac: 0.2, yawOffset: 1.8, dMin: 2, dMax: 50, dStep: 4, rBase: 7.8, rSlope: 0.28 },
    { rule: 'benchSightlines', target: 'trees', dMin: 6, dMax: 70, dStep: 6, rBase: 4, rSlope: 0.28 },
    { rule: 'waterfallClear', target: 'trees' },
    { rule: 'waterfallClear', target: 'rocks' },
  ],
};
