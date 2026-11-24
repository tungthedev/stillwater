// Single source of truth for every per-tier rendering and density setting.
// Trees: `trees` is the drawn rank subset; 32 m cells whose nearest point is within treeHeroR (m) of the camera draw
// hero geometry, 64 m cells within treeMidR mid geometry, the rest impostors from a treeAtlas-pixel RGBA8 atlas.
// treeShadows: whether hero/mid trees cast sun shadows (the shadow pass keeps only batches inside the shadow-camera
// box); treeBushR: bushes (no impostor) draw only inside this radius.

// Vegetation counts are per tile: grassNear/grassFar blades per 8 m grass tile, flowers per 12 m
// flower tile, fernNear/fernFar per 16 m fern tile. Tiles and roots are the same on every tier;
// a tier draws the first N ranks of each tile. vegBakeBudget caps off-screen tile bakes per frame.
// bloomLevels is the bloom mip-chain depth (at least 2); godrays is the light-shaft blur tap count,
// 0 = off. msaa 0 tiers get FXAA in the composite and plain alpha test on foliage instead.
export const TIER_NAMES = ['low', 'medium', 'high', 'ultra'];

export const QUALITY = {
  low: {
    scale: 0.6,
    maxPixels: 900_000,
    grassRadius: 30,
    grassNear: 1664,
    grassFar: 1024,
    flowers: 576,
    grassNearLod: 16,
    grassFarWidthScale: 1.32,
    shadow: 1024,
    shadowEvery: 2,
    reflScale: 0.25,
    trees: 0.55,
    treeDetail: 1,
    treeHeroR: 12,
    treeMidR: 100,
    treeAtlas: 1024,
    treeShadows: false,
    treeBushR: 120,
    reflEvery: 0,
    bloom: true,
    bloomLevels: 3,
    godrays: 0,
    msaa: 0,
    fernRadius: 22,
    fernNear: 240,
    fernFar: 144,
    fernNearLod: 20,
    shafts: 28,
    butterflies: 35,
    clouds: 12,
    cloudDetail: 1,
    motes: 1200,
    fireflies: 280,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
    vegBakeBudget: 6,
    reflTerrainLodK: 1.2,
    reflTerrainMinSize: 256,
    reflTerrainMaxNodes: 160,
  },
  medium: {
    scale: 0.75,
    maxPixels: 1_600_000,
    grassRadius: 38,
    grassNear: 1792,
    grassFar: 1216,
    flowers: 576,
    grassNearLod: 18,
    grassFarWidthScale: 1.32,
    shadow: 2048,
    shadowEvery: 1,
    reflScale: 0.35,
    trees: 0.8,
    treeDetail: 2,
    treeHeroR: 16,
    treeMidR: 140,
    treeAtlas: 1024,
    treeShadows: true,
    treeBushR: 240,
    reflEvery: 2,
    bloom: true,
    bloomLevels: 4,
    godrays: 24,
    msaa: 0,
    fernRadius: 44,
    fernNear: 768,
    fernFar: 384,
    fernNearLod: 28,
    shafts: 96,
    butterflies: 85,
    clouds: 26,
    cloudDetail: 2,
    motes: 2800,
    fireflies: 560,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
    vegBakeBudget: 6,
    reflTerrainLodK: 1.3,
    reflTerrainMinSize: 256,
    reflTerrainMaxNodes: 160,
  },
  high: {
    scale: 1.0,
    maxPixels: 3_700_000,
    grassRadius: 46,
    grassNear: 2432,
    grassFar: 1664,
    flowers: 896,
    grassNearLod: 20,
    grassFarWidthScale: 1.3,
    shadow: 2048,
    shadowEvery: 1,
    reflScale: 0.75,
    trees: 1.0,
    treeDetail: 2,
    treeHeroR: 16,
    treeMidR: 150,
    treeAtlas: 2048,
    treeShadows: true,
    treeBushR: 240,
    reflEvery: 1,
    bloom: true,
    bloomLevels: 6,
    godrays: 40,
    msaa: 4,
    fernRadius: 44,
    fernNear: 768,
    fernFar: 384,
    fernNearLod: 28,
    shafts: 96,
    butterflies: 85,
    clouds: 26,
    cloudDetail: 3,
    motes: 2800,
    fireflies: 560,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
    vegBakeBudget: 6,
    reflTerrainLodK: 1.6,
    reflTerrainMinSize: 256,
    reflTerrainMaxNodes: 220,
  },
  ultra: {
    scale: 1.0,
    maxPixels: null,
    grassRadius: 96,
    grassNear: 2432,
    grassFar: 1024,
    flowers: 1440,
    grassNearLod: 24,
    grassFarWidthScale: 1.32,
    shadow: 4096,
    shadowEvery: 1,
    reflScale: 1.0,
    trees: 1.0,
    treeDetail: 2,
    treeHeroR: 48,
    treeMidR: 240,
    treeAtlas: 2048,
    treeShadows: true,
    treeBushR: 240,
    reflEvery: 1,
    bloom: true,
    bloomLevels: 6,
    godrays: 40,
    msaa: 4,
    fernRadius: 44,
    fernNear: 768,
    fernFar: 384,
    fernNearLod: 28,
    shafts: 96,
    butterflies: 85,
    clouds: 26,
    cloudDetail: 3,
    motes: 2800,
    fireflies: 560,
    terrainN: 32,
    terrainLodK: 3.6,
    terrainMaxNodes: 2200,
    vegBakeBudget: 6,
    reflTerrainLodK: 1.8,
    reflTerrainMinSize: 128,
    reflTerrainMaxNodes: 280,
  },
};

/**
 * Detect phones and touch-first mobile GPUs so they default to the `low` tier
 * rather than falling through to desktop `medium` (which runs planar reflections).
 * @param {{ ua?: string, maxTouchPoints?: number, coarsePointer?: boolean, gpuName?: string, screenMin?: number }} [env]
 */
export function isMobileDevice(env = {}) {
  const ua = env.ua !== undefined
    ? String(env.ua || '')
    : (typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '');
  const maxTouchPoints = env.maxTouchPoints !== undefined
    ? Number(env.maxTouchPoints || 0)
    : (typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints || 0) : 0);
  const coarsePointer = env.coarsePointer !== undefined
    ? Boolean(env.coarsePointer)
    : (typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false);
  const gpuName = String(env.gpuName || '');
  const screenMin = env.screenMin !== undefined
    ? Number(env.screenMin)
    : (typeof screen !== 'undefined' && screen.width && screen.height
      ? Math.min(screen.width, screen.height)
      : (typeof innerWidth === 'number' && typeof innerHeight === 'number'
        ? Math.min(innerWidth, innerHeight)
        : Infinity));

  if (/iPhone|iPod|iPad|Android|Mobile/i.test(ua)) return true;
  // iPadOS Safari desktop-mode UA reports Macintosh while exposing multi-touch.
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return true;
  if (/Adreno|Mali|PowerVR|Immortalis|Xclipse/i.test(gpuName)) return true;
  if ((coarsePointer || maxTouchPoints > 0) && (/Apple GPU/i.test(gpuName) || screenMin <= 900)) return true;
  return false;
}

/**
 * Compute base pixel ratio and backing dimensions for internal render target sizing.
 * Desktop keeps pixelRatio 1 (existing behavior); phones scale against real device
 * pixels so the tier's maxPixels cap budgets physical screen resolution instead of DPR 1.
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @param {number} [devicePixelRatio]
 * @param {boolean} [mobile]
 */
export function resolveRenderBaseSize(cssWidth, cssHeight, devicePixelRatio = 1, mobile = false) {
  const w = Math.max(1, Math.round(cssWidth || 1));
  const h = Math.max(1, Math.round(cssHeight || 1));
  const pixelRatio = mobile ? Math.max(1, Number(devicePixelRatio) || 1) : 1;
  return {
    pixelRatio,
    width: Math.max(1, Math.round(w * pixelRatio)),
    height: Math.max(1, Math.round(h * pixelRatio)),
  };
}

/**
 * Clamp render scale so internal pixels (round(w*s) * round(h*s)) stay at or under maxPixels.
 * @param {number} width
 * @param {number} height
 * @param {number} scale
 * @param {number | null | undefined} maxPixels
 */
export function capScaleForPixels(width, height, scale, maxPixels) {
  if (!maxPixels || maxPixels <= 0 || !width || !height || width <= 0 || height <= 0) return scale;
  const maxScale = Math.sqrt(maxPixels / (width * height));
  if (scale <= maxScale) return scale;
  let s = maxScale;
  while (s > 0.1 && Math.round(width * s) * Math.round(height * s) > maxPixels) {
    s -= 0.001;
  }
  return Math.max(0.1, s);
}

/**
 * Pick the initial quality tier from URL flag, stored preference, device class, or GPU name.
 * @param {import('three').WebGLRenderer | null | undefined} renderer
 * @param {URLSearchParams} [params]
 * @param {{ ua?: string, maxTouchPoints?: number, coarsePointer?: boolean, gpuName?: string, screenMin?: number, stored?: string | null }} [env]
 */
export function detectQuality(renderer, params = new URLSearchParams(location.search), env = {}) {
  const stored = env.stored !== undefined
    ? env.stored
    : (() => { try { return localStorage.getItem('stillwater.q'); } catch { return null; } })();
  if (params.get('q')) return params.get('q');
  if (stored && QUALITY[stored]) return stored;
  let name = env.gpuName !== undefined ? String(env.gpuName || '') : '';
  if (!name && renderer && typeof renderer.getContext === 'function') {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
  }
  if (isMobileDevice({ ...env, gpuName: name })) return 'low';
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
