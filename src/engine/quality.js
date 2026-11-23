// Single source of truth for every per-tier rendering and density setting.
// Trees: `trees` is the drawn rank subset; 32 m cells whose nearest point is within treeHeroR (m) of the camera draw
// hero geometry, 64 m cells within treeMidR mid geometry, the rest impostors from a treeAtlas-pixel RGBA8 atlas.
// treeShadows: whether hero/mid trees cast sun shadows; treeShadowR: mid cells cast only inside this radius (shadow
// draw calls); treeBushR: bushes (no impostor) draw only inside this radius.

export const TIER_NAMES = ['low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  low: {
    scale: 0.6,
    grass: 65536,
    grassRadius: 30,
    shadow: 1024,
    reflScale: 0.25,
    trees: 0.55,
    treeDetail: 1,
    treeHeroR: 12,
    treeMidR: 100,
    treeAtlas: 1024,
    treeShadows: false,
    treeBushR: 120,
    treeShadowR: 0,
    reflEvery: 0,
    bloom: true,
    godrays: false,
    msaa: 0,
    ferns: 1800,
    fernRadius: 22,
    shafts: 28,
    butterflies: 35,
    clouds: 12,
    cloudDetail: 1,
    motes: 1200,
    fireflies: 280,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
  },
  medium: {
    scale: 0.75,
    grass: 131072,
    grassRadius: 38,
    shadow: 2048,
    reflScale: 0.35,
    trees: 0.8,
    treeDetail: 2,
    treeHeroR: 16,
    treeMidR: 140,
    treeAtlas: 1024,
    treeShadows: true,
    treeBushR: 240,
    treeShadowR: 90,
    reflEvery: 1,
    bloom: true,
    godrays: true,
    msaa: 0,
    ferns: 22000,
    fernRadius: 44,
    shafts: 96,
    butterflies: 85,
    clouds: 26,
    cloudDetail: 2,
    motes: 2800,
    fireflies: 560,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
  },
  high: {
    scale: 1.0,
    grass: 262144,
    grassRadius: 46,
    shadow: 2048,
    reflScale: 0.75,
    trees: 1.0,
    treeDetail: 2,
    treeHeroR: 16,
    treeMidR: 150,
    treeAtlas: 2048,
    treeShadows: true,
    treeBushR: 240,
    treeShadowR: 110,
    reflEvery: 1,
    bloom: true,
    godrays: true,
    msaa: 4,
    ferns: 22000,
    fernRadius: 44,
    shafts: 96,
    butterflies: 85,
    clouds: 26,
    cloudDetail: 3,
    motes: 2800,
    fireflies: 560,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
  },
  ultra: {
    scale: 1.0,
    grass: 440000,
    grassRadius: 96,
    shadow: 4096,
    reflScale: 1.0,
    trees: 1.0,
    treeDetail: 2,
    treeHeroR: 48,
    treeMidR: 240,
    treeAtlas: 2048,
    treeShadows: true,
    treeBushR: 240,
    treeShadowR: 240,
    reflEvery: 1,
    bloom: true,
    godrays: true,
    msaa: 4,
    ferns: 22000,
    fernRadius: 44,
    shafts: 96,
    butterflies: 85,
    clouds: 26,
    cloudDetail: 3,
    motes: 2800,
    fireflies: 560,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
  },
};

export function detectQuality(renderer, params = new URLSearchParams(location.search)) {
  const stored = (() => { try { return localStorage.getItem('stillwater.q'); } catch { return null; } })();
  if (params.get('q')) return params.get('q');
  if (stored && QUALITY[stored]) return stored;
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
  if (/SwiftShader|llvmpipe|Software/i.test(name)) return 'low';
  if (/Intel/i.test(name) && !/Arc/i.test(name)) return 'low';
  if (/Apple M|Radeon|NVIDIA|GeForce|RTX|Arc/i.test(name)) return 'high';
  return 'medium';
}

export function resolveQuality(name, params = null) {
  const Q = { ...(QUALITY[name] || QUALITY.medium) };
  if (params && params.get('scale')) Q.scale = parseFloat(params.get('scale'));
  return Q;
}
