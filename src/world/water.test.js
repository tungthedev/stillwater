import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY } from '../engine/quality.js';
import { renderFrame } from '../engine/renderFrame.js';
import { WORLD } from '../config.js';
import { Water, LAYER_REFLECT, LAYER_NO_REFLECT } from './water.js';
import { Terrain } from './terrain.js';
import { Trees } from './trees.js';

function makeCamera({ pos, lookAt, aspect = 16 / 9, fov = 60, near = 0.25, far = 60000 }) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, near, far);
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.lookAt(lookAt[0], lookAt[1], lookAt[2]);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

function makeMockRenderer(onRender = null) {
  let rt = null;
  const renderer = {
    clippingPlanes: [],
    shadowMap: { autoUpdate: true },
    getRenderTarget: () => rt,
    setRenderTarget: (next) => { rt = next; },
    clear: vi.fn(),
    render: vi.fn((scene, cam) => {
      if (onRender) onRender(scene, cam);
    }),
  };
  return renderer;
}

function makeFlatLakeHf(ridgeHeight = null) {
  const L = WORLD.lake;
  const wl = WORLD.waterLevel;
  return {
    height(x, z) {
      if (ridgeHeight != null && x > 150 && x < 450 && z > 350 && z < 750) {
        return ridgeHeight;
      }
      const dx = (x - L.x) / L.rx;
      const dz = (z - L.z) / L.rz;
      const d = Math.hypot(dx, dz);
      return d < 1.0 ? wl - 6 * (1 - d) : wl + (d - 1) * 40;
    },
  };
}

describe('Slice 8 reflection quality settings', () => {
  it('keeps low sky-only, makes medium frame-skipping, and defines reflection terrain settings per tier', () => {
    expect(QUALITY.low.reflEvery).toBe(0);
    expect(QUALITY.medium.reflEvery).toBeGreaterThan(1);
    expect(QUALITY.high.reflEvery).toBe(1);
    expect(QUALITY.ultra.reflEvery).toBe(1);
    for (const tier of Object.values(QUALITY)) {
      expect(tier.reflTerrainLodK).toBeGreaterThan(0);
      expect(tier.reflTerrainLodK).toBeLessThan(tier.terrainLodK);
      expect(tier.reflTerrainMinSize).toBeGreaterThanOrEqual(128);
      expect(tier.reflTerrainMaxNodes).toBeGreaterThan(0);
      expect(tier.reflTerrainMaxNodes).toBeLessThan(tier.terrainMaxNodes);
    }
  });
});

describe('Slice 8 Water reflection gating, layers, and frame-skip cache', () => {
  it('configures opt-in LAYER_REFLECT on virtualCamera and syncs sky, clouds, terrain, and lights', () => {
    const skyMesh = new THREE.Mesh();
    const cloudsMesh = new THREE.Mesh();
    const terrainMesh = new THREE.Mesh();
    const sunLight = new THREE.DirectionalLight();
    const hemi = new THREE.HemisphereLight();
    const rockMesh = new THREE.Mesh();
    const registry = {
      instance(name) {
        if (name === 'sky') return { mesh: skyMesh };
        if (name === 'clouds') return { mesh: cloudsMesh };
        if (name === 'terrain') return { mesh: terrainMesh };
        return null;
      },
      get(name) {
        if (name === 'lighting') return { sunLight, hemi };
        return null;
      },
    };

    const water = new Water({ registry });
    const vc = water.virtualCamera;
    expect(vc.layers.isEnabled(LAYER_REFLECT)).toBe(true);
    expect(vc.layers.isEnabled(0)).toBe(false);
    expect(vc.layers.isEnabled(LAYER_NO_REFLECT)).toBe(false);
    expect(water.mesh.layers.isEnabled(LAYER_NO_REFLECT)).toBe(true);
    expect(water.mesh.layers.isEnabled(LAYER_REFLECT)).toBe(false);

    water.syncReflectionLayers();
    for (const obj of [skyMesh, cloudsMesh, terrainMesh, sunLight, hemi]) {
      expect(obj.layers.isEnabled(0)).toBe(true);
      expect(obj.layers.isEnabled(LAYER_REFLECT)).toBe(true);
    }
    expect(rockMesh.layers.isEnabled(LAYER_REFLECT)).toBe(false);
    water.dispose();
  });

  it('skips reflection when looking away, below water, or occluded behind terrain', () => {
    const hf = makeFlatLakeHf(260);
    const water = new Water({ hf });
    water.setReflectionSize(128, 128);
    const renderer = makeMockRenderer();
    const scene = new THREE.Scene();

    // Looking away from the lake.
    const camAway = makeCamera({ pos: [500, 60, 800], lookAt: [900, 60, 1200] });
    expect(water.renderReflection(renderer, scene, camAway, null, { frameNo: 1, every: 1 })).toBe(false);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(water.uniforms.uHasRefl.value).toBe(0);
    expect(water.reflValid).toBe(false);

    // Below water level while facing the lake.
    const camUnder = makeCamera({ pos: [200, WORLD.waterLevel - 1, 200], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    expect(water.renderReflection(renderer, scene, camUnder, null, { frameNo: 2, every: 1 })).toBe(false);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(water.uniforms.uHasRefl.value).toBe(0);

    // Behind a tall ridge occluding the lake.
    const camOccluded = makeCamera({ pos: [640, 80, 860], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    expect(water.renderReflection(renderer, scene, camOccluded, null, { frameNo: 3, every: 1 })).toBe(false);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(water.uniforms.uHasRefl.value).toBe(0);

    // Clear view above the ridge looking directly at the lake.
    const camVisible = makeCamera({ pos: [220, 45, 220], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    expect(water.renderReflection(renderer, scene, camVisible, null, { frameNo: 4, every: 1 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(water.uniforms.uHasRefl.value).toBe(1);
    expect(water.reflValid).toBe(true);

    // Grazing view over a distant wooded ridge (forest canopy blocks sightline) also skips.
    const woodedWater = new Water({
      hf: {
        height(x, z) {
          const d = Math.hypot((x - WORLD.lake.x) / WORLD.lake.rx, (z - WORLD.lake.z) / WORLD.lake.rz);
          if (d < 1.0) return WORLD.waterLevel - 4;
          // Gently sloping hillside 2 m below the direct line from (648,148,856) to lake.
          const t = Math.max(0, Math.min(1, (x - WORLD.lake.x) / (648 - WORLD.lake.x)));
          return WORLD.waterLevel + t * (148 - WORLD.waterLevel) - 2.2;
        },
      },
      biome: { sampleForest: () => 0.8 },
    });
    woodedWater.setReflectionSize(128, 128);
    const camTrailheadLike = makeCamera({ pos: [648, 148, 856], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    expect(woodedWater.isLakeVisible(camTrailheadLike)).toBe(false);
    woodedWater.dispose();
    water.dispose();
  });

  it('reuses texture, texture matrix, and valid flag on skipped frames without flipping to sky-only', () => {
    const water = new Water({ hf: makeFlatLakeHf() });
    water.setReflectionSize(128, 128);
    const renderer = makeMockRenderer();
    const scene = new THREE.Scene();

    const cam1 = makeCamera({ pos: [220, 45, 220], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    const cam2 = makeCamera({ pos: [215, 45, 218], lookAt: [WORLD.lake.x + 15, WORLD.waterLevel, WORLD.lake.z] });
    const cam3 = makeCamera({ pos: [210, 45, 216], lookAt: [WORLD.lake.x + 30, WORLD.waterLevel, WORLD.lake.z] });

    // Frame 1 (odd, initial invalid): must render immediately.
    expect(water.renderReflection(renderer, scene, cam1, null, { frameNo: 1, every: 2 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(water.reflValid).toBe(true);
    expect(water.uniforms.uHasRefl.value).toBe(1);
    const matFrame1 = water.uniforms.uTexMatrix.value.elements.slice();
    const texFrame1 = water.uniforms.tRefl.value;

    // Frame 2 (skipped): must NOT render, must keep uHasRefl = 1, reflValid = true, and exact uTexMatrix + tRefl.
    expect(water.renderReflection(renderer, scene, cam2, null, { frameNo: 2, every: 2 })).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(water.reflValid).toBe(true);
    expect(water.uniforms.uHasRefl.value).toBe(1);
    expect(water.uniforms.tRefl.value).toBe(texFrame1);
    expect(water.uniforms.uTexMatrix.value.elements).toEqual(matFrame1);

    // Frame 3 (due): renders fresh and updates uTexMatrix.
    expect(water.renderReflection(renderer, scene, cam3, null, { frameNo: 3, every: 2 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(water.reflValid).toBe(true);
    expect(water.uniforms.uHasRefl.value).toBe(1);
    expect(water.uniforms.uTexMatrix.value.elements).not.toEqual(matFrame1);

    // Force renders even on an otherwise skipped frame.
    expect(water.renderReflection(renderer, scene, cam3, null, { frameNo: 4, every: 2, force: true })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(3);

    // Turning away invalidates; re-entering renders immediately on the next frame regardless of parity.
    const camAway = makeCamera({ pos: [400, 45, 500], lookAt: [800, 45, 900] });
    expect(water.renderReflection(renderer, scene, camAway, null, { frameNo: 5, every: 2 })).toBe(false);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);

    expect(water.renderReflection(renderer, scene, cam3, null, { frameNo: 6, every: 2 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(4);
    expect(water.reflValid).toBe(true);
    expect(water.uniforms.uHasRefl.value).toBe(1);

    // Explicit invalidation (e.g. !renderFlags.refl or resize) clears cache.
    water.invalidateReflection();
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);

    // Resize reallocates the render target and invalidates cached reflection.
    expect(water.renderReflection(renderer, scene, cam3, null, { frameNo: 7, every: 2 })).toBe(true);
    expect(water.reflValid).toBe(true);
    water.setReflectionSize(256, 256);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);

    // Tier change invalidates cached reflection and re-triggers layer sync.
    expect(water.renderReflection(renderer, scene, cam3, null, { frameNo: 8, every: 2 })).toBe(true);
    expect(water.reflValid).toBe(true);
    water.setTier(QUALITY.low);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);

    // every === 0 (low tier) never renders when unforced.
    expect(water.renderReflection(renderer, scene, cam3, null, { frameNo: 9, every: 0 })).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(6);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);
    water.dispose();
  });
});

describe('Slice 8 coarse reflection terrain selection and restore', () => {
  it('selects a coarser node list for the reflection camera and restores main state after render (even on throw)', () => {
    const terrain = new Terrain(QUALITY.medium);
    expect(terrain.mesh.layers.isEnabled(LAYER_REFLECT)).toBe(true);
    expect(terrain.mesh.layers.isEnabled(0)).toBe(true);

    const cam = makeCamera({ pos: [220, 45, 220], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    const mainCount = terrain.update(cam, 43);
    expect(mainCount).toBeGreaterThan(50);
    const savedNodes = terrain.nodeArr.slice(0, mainCount * 4);
    const savedCamX = terrain.uniforms.uCamXZ.value.x;
    const savedCamZ = terrain.uniforms.uCamXZ.value.y;
    const savedCamDY = terrain.uniforms.uCamDY.value;

    const water = new Water({ hf: makeFlatLakeHf() });
    water.setReflectionSize(128, 128);
    const scene = new THREE.Scene();

    let reflNodeCount = 0;
    let reflLodK = 0;
    let reflSkirt = -1;
    let reflGeo = null;
    let reflAttr = null;
    let reflMinNodeSize = Infinity;
    const renderer = makeMockRenderer(() => {
      reflGeo = terrain.mesh.geometry;
      reflNodeCount = reflGeo.instanceCount;
      reflLodK = terrain.uniforms.uLodK.value;
      reflSkirt = terrain.uniforms.uSkirt.value;
      reflAttr = reflGeo.getAttribute('aNode');
      for (let i = 0; i < reflNodeCount; i++) {
        reflMinNodeSize = Math.min(reflMinNodeSize, terrain.reflNodeArr[i * 4 + 2]);
      }
    });

    const rendered = water.renderReflection(renderer, scene, cam, terrain, {
      frameNo: 1,
      every: 2,
      reflTerrainLodK: QUALITY.medium.reflTerrainLodK,
      reflTerrainMinSize: QUALITY.medium.reflTerrainMinSize,
      reflTerrainMaxNodes: QUALITY.medium.reflTerrainMaxNodes,
    });
    expect(rendered).toBe(true);
    expect(reflGeo).toBe(terrain.reflGeometry);
    expect(reflGeo).not.toBe(terrain.geometry);
    expect(reflAttr).toBe(terrain.reflNodeAttr);
    expect(reflNodeCount).toBeGreaterThan(0);
    expect(reflNodeCount).toBeLessThan(mainCount);
    expect(reflNodeCount).toBeLessThanOrEqual(QUALITY.medium.reflTerrainMaxNodes);
    expect(reflMinNodeSize).toBeGreaterThanOrEqual(QUALITY.medium.reflTerrainMinSize);
    expect(reflLodK).toBe(QUALITY.medium.reflTerrainLodK);
    expect(reflSkirt).toBe(0);

    // Main terrain geometry, selection, and uniforms must be restored identically.
    expect(terrain.mesh.geometry).toBe(terrain.geometry);
    expect(terrain.geometry.getAttribute('aNode')).toBe(terrain.nodeAttr);
    expect(terrain.geometry.instanceCount).toBe(mainCount);
    expect(terrain.uniforms.uLodK.value).toBe(QUALITY.medium.terrainLodK);
    expect(terrain.uniforms.uSkirt.value).toBe(1);
    expect(terrain.uniforms.uCamXZ.value.x).toBe(savedCamX);
    expect(terrain.uniforms.uCamXZ.value.y).toBe(savedCamZ);
    expect(terrain.uniforms.uCamDY.value).toBe(savedCamDY);
    expect(terrain.nodeArr.slice(0, mainCount * 4)).toEqual(savedNodes);

    // Even if renderer.render throws, terrain and renderer states are restored.
    const throwingRenderer = makeMockRenderer(() => { throw new Error('boom'); });
    expect(() => water.renderReflection(throwingRenderer, scene, cam, terrain, { frameNo: 3, every: 2 })).toThrow('boom');
    expect(terrain.mesh.geometry).toBe(terrain.geometry);
    expect(terrain.geometry.getAttribute('aNode')).toBe(terrain.nodeAttr);
    expect(terrain.geometry.instanceCount).toBe(mainCount);
    expect(terrain.uniforms.uSkirt.value).toBe(1);
    expect(throwingRenderer.clippingPlanes).toEqual([]);
    expect(throwingRenderer.shadowMap.autoUpdate).toBe(true);

    // Switching tiers updates reflection LOD limits without rebuilding geometry/material.
    const prevGeo = terrain.geometry;
    const prevMat = terrain.material;
    terrain.setTier(QUALITY.ultra);
    expect(terrain.geometry).toBe(prevGeo);
    expect(terrain.material).toBe(prevMat);
    expect(terrain.reflLodK).toBe(QUALITY.ultra.reflTerrainLodK);
    expect(terrain.reflMinSize).toBe(QUALITY.ultra.reflTerrainMinSize);
    expect(terrain.reflMaxNodes).toBe(QUALITY.ultra.reflTerrainMaxNodes);

    water.dispose();
    terrain.dispose();
  });

  it('Trees.setReflectionTrees enables LAYER_REFLECT on far billboard batch only', () => {
    const fakeTrees = Object.create(Trees.prototype);
    fakeTrees.hi = [new THREE.Mesh()];
    fakeTrees.lo = [new THREE.Mesh()];
    fakeTrees._heroMeshes = [new THREE.Mesh()];
    fakeTrees.bb = new THREE.Mesh();

    fakeTrees.setReflectionTrees();

    expect(fakeTrees.bb.layers.isEnabled(0)).toBe(true);
    expect(fakeTrees.bb.layers.isEnabled(LAYER_REFLECT)).toBe(true);
    expect(fakeTrees.hi[0].layers.isEnabled(LAYER_REFLECT)).toBe(false);
    expect(fakeTrees.lo[0].layers.isEnabled(LAYER_REFLECT)).toBe(false);
    expect(fakeTrees._heroMeshes[0].layers.isEnabled(LAYER_REFLECT)).toBe(false);
  });

  it('renderFrame records reflection rendered flag and zero triangles when pass skips', () => {
    const renderer = {
      info: {
        render: { calls: 0, triangles: 0 },
        reset() { this.render.calls = 0; this.render.triangles = 0; },
      },
      setRenderTarget: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(() => {
        renderer.info.render.calls = 12;
        renderer.info.render.triangles = 50000;
      }),
    };
    const ctx = {
      renderer,
      scene: {},
      camera: {},
      post: { sceneRT: {}, render: vi.fn() },
      passes: {
        skyPass: () => ({ calls: 1, tris: 1 }),
        terrainShadowPass: () => ({ calls: 0, tris: 0 }),
        simPass: () => 50,
        reflectionPass: () => false,
        getPostParams: () => ({}),
      },
    };
    const res = renderFrame(ctx, { frameNo: 1 });
    expect(res.passes.reflection).toEqual({ calls: 0, tris: 0, rendered: false });
    expect(res.passes.main).toEqual({ calls: 12, tris: 50000 });
  });
});
