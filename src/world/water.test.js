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

  it('skips reflection when looking away, below water, occluded, or over dry ground only', () => {
    const hf = makeFlatLakeHf(260);
    const water = new Water({ hf });
    water.setReflectionSize(128, 128);
    const renderer = makeMockRenderer();
    const scene = new THREE.Scene();
    scene.add(water.mesh);

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

    // Behind a tall ridge occluding the lake. Sightlines are marched under a per-frame budget and the
    // water counts as visible until every on-screen point has been checked, so it settles within frames.
    const camOccluded = makeCamera({ pos: [640, 80, 860], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    let settledAt = -1;
    for (let f = 0; f < 60 && settledAt < 0; f++) {
      if (!water.renderReflection(renderer, scene, camOccluded, null, { frameNo: 3, every: 1 })) settledAt = f;
    }
    expect(settledAt).toBeGreaterThanOrEqual(0);
    expect(settledAt).toBeLessThan(40);
    expect(water.renderReflection(renderer, scene, camOccluded, null, { frameNo: 3, every: 1 })).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);
    renderer.render.mockClear();

    // Standing on the dry bank just outside the shore, looking steeply down and away from the water.
    const bankX = WORLD.lake.x + WORLD.lake.rx + 60;
    const bankY = hf.height(bankX, WORLD.lake.z) + 1.7;
    const camDown = makeCamera({ pos: [bankX, bankY, WORLD.lake.z], lookAt: [bankX + 3, bankY - 12, WORLD.lake.z] });
    expect(water.renderReflection(renderer, scene, camDown, null, { frameNo: 4, every: 1 })).toBe(false);
    expect(renderer.render).not.toHaveBeenCalled();

    // Clear view looking directly at the lake.
    const camVisible = makeCamera({ pos: [220, 45, 220], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    expect(water.renderReflection(renderer, scene, camVisible, null, { frameNo: 5, every: 1 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(water.uniforms.uHasRefl.value).toBe(1);
    expect(water.reflValid).toBe(true);

    // Without the water mesh in the scene (?nowater) the pass never runs.
    water.mesh.removeFromParent();
    expect(water.renderReflection(renderer, scene, camVisible, null, { frameNo: 6, every: 1 })).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(water.reflValid).toBe(false);
    water.dispose();
  });

  it('treats a sightline over a forested slope as clear (trees never hide water)', () => {
    const L = WORLD.lake;
    const water = new Water({
      hf: {
        height(x, z) {
          const d = Math.hypot((x - L.x) / L.rx, (z - L.z) / L.rz);
          if (d < 1.0) return WORLD.waterLevel - 4;
          const t = Math.max(0, Math.min(1, (x - L.x) / (648 - L.x)));
          return WORLD.waterLevel + t * (148 - WORLD.waterLevel) - 2.2;
        },
      },
    });
    const cam = makeCamera({ pos: [648, 148, 856], lookAt: [L.x, WORLD.waterLevel, L.z] });
    expect(water.isLakeVisible(cam)).toBe(true);
    water.dispose();
  });

  it('sees a channel narrower than the wet grid that only enters a phone-aspect view at its edge', () => {
    const L = WORLD.lake;
    const wl = WORLD.waterLevel;
    // A 3.6 m channel between wet-grid columns (x = 100 and 106); the camera walks the bank facing +z.
    const hf = { height: (x) => (x > 100.2 && x < 103.8 ? wl - 1 : wl + 0.6) };
    const water = new Water({ hf });
    const cam = makeCamera({ pos: [125, wl + 1.7, L.z - 300], lookAt: [125, wl + 1.0, L.z - 200], aspect: 9 / 16 });
    // No wet grid point exists in the channel: only the screen-edge rays can find it.
    const pt = new THREE.Vector3();
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const gridOnScreen = water.wetTiles.some((t) => {
      for (let i = 0; i < t.pts.length; i += 2) if (fr.containsPoint(pt.set(t.pts[i], wl, t.pts[i + 1]))) return true;
      return false;
    });
    expect(gridOnScreen).toBe(false);
    expect(water.isLakeVisible(cam)).toBe(true);
    water.dispose();
  });

  it('reuses the cached reflection on skipped frames only while it covers the visible water', () => {
    const hf = makeFlatLakeHf();
    const water = new Water({ hf });
    water.setReflectionSize(128, 128);
    const renderer = makeMockRenderer();
    const scene = new THREE.Scene();
    scene.add(water.mesh);

    const shore = [WORLD.lake.x + WORLD.lake.rx - 20, WORLD.waterLevel + 2, WORLD.lake.z];
    const camAt = (yawDeg) => {
      const a = THREE.MathUtils.degToRad(180 + yawDeg);
      return makeCamera({ pos: shore, lookAt: [shore[0] + Math.cos(a) * 100, WORLD.waterLevel - 3, shore[2] + Math.sin(a) * 100] });
    };

    // Frame 1 renders; frame 2 with the same camera reuses texture, matrix and valid flag together.
    expect(water.renderReflection(renderer, scene, camAt(0), null, { frameNo: 1, every: 2 })).toBe(true);
    const mat1 = water.uniforms.uTexMatrix.value.elements.slice();
    const tex1 = water.uniforms.tRefl.value;
    expect(water.renderReflection(renderer, scene, camAt(0), null, { frameNo: 2, every: 2 })).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(water.reflValid).toBe(true);
    expect(water.uniforms.uHasRefl.value).toBe(1);
    expect(water.uniforms.tRefl.value).toBe(tex1);
    expect(water.uniforms.uTexMatrix.value.elements).toEqual(mat1);

    // Frame 3 is due and renders.
    expect(water.renderReflection(renderer, scene, camAt(0), null, { frameNo: 3, every: 2 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);

    // A 5.7 deg turn on a skipped frame uncovers water outside the cached view, so it renders now.
    const turned = camAt(5.7);
    expect(water._scanWater(turned, water.uniforms.uTexMatrix.value).covered).toBe(false);
    expect(water.renderReflection(renderer, scene, turned, null, { frameNo: 4, every: 2 })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(3);
    expect(water._scanWater(turned, water.uniforms.uTexMatrix.value).covered).toBe(true);

    // Force renders even on an otherwise skipped frame.
    expect(water.renderReflection(renderer, scene, turned, null, { frameNo: 5, every: 2, force: true })).toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(4);

    // Turning away invalidates; re-entering renders immediately regardless of parity.
    const camAway = makeCamera({ pos: [400, 45, 500], lookAt: [800, 45, 900] });
    expect(water.renderReflection(renderer, scene, camAway, null, { frameNo: 6, every: 2 })).toBe(false);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);
    expect(water.renderReflection(renderer, scene, turned, null, { frameNo: 7, every: 2 })).toBe(true);
    expect(water.reflValid).toBe(true);

    // Resize and tier change both invalidate.
    water.setReflectionSize(256, 256);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);
    expect(water.renderReflection(renderer, scene, turned, null, { frameNo: 8, every: 2 })).toBe(true);
    water.setTier(QUALITY.low);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);

    // every === 0 (low tier) never renders when unforced.
    const calls = renderer.render.mock.calls.length;
    expect(water.renderReflection(renderer, scene, turned, null, { frameNo: 9, every: 0 })).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(calls);
    expect(water.reflValid).toBe(false);
    water.dispose();
  });

  it('drops the cache when a draw fails or the context is lost, and redraws afterwards', () => {
    const water = new Water({ hf: makeFlatLakeHf() });
    water.setReflectionSize(128, 128);
    const scene = new THREE.Scene();
    scene.add(water.mesh);
    const cam = makeCamera({ pos: [220, 45, 220], lookAt: [WORLD.lake.x, WORLD.waterLevel, WORLD.lake.z] });
    const good = makeMockRenderer();
    expect(water.renderReflection(good, scene, cam, null, { frameNo: 1, every: 2 })).toBe(true);
    expect(water.reflValid).toBe(true);

    const bad = makeMockRenderer(() => { throw new Error('boom'); });
    expect(() => water.renderReflection(bad, scene, cam, null, { frameNo: 3, every: 2 })).toThrow('boom');
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);
    expect(bad.getRenderTarget()).toBe(null);

    // Not due by cadence, but the cache is invalid, so the next frame draws.
    expect(water.renderReflection(good, scene, cam, null, { frameNo: 4, every: 2 })).toBe(true);
    expect(water.reflValid).toBe(true);

    let lost = true;
    good.getContext = () => ({ isContextLost: () => lost });
    expect(water.renderReflection(good, scene, cam, null, { frameNo: 5, every: 2 })).toBe(false);
    expect(water.reflValid).toBe(false);
    expect(water.uniforms.uHasRefl.value).toBe(0);
    lost = false;
    expect(water.renderReflection(good, scene, cam, null, { frameNo: 6, every: 2 })).toBe(true);
    expect(water.reflValid).toBe(true);
    water.dispose();
  });

  it('places the mesh, bounds and mirror plane from the region it is given', () => {
    const region = { waterLevel: 40, lake: { x: 1000, z: -500, rx: 100, rz: 80 } };
    const water = new Water({ region });
    expect(water.mesh.position.toArray()).toEqual([1000, 40, -500]);
    expect(water.clipPlane.constant).toBeCloseTo(-(40 - 0.25));
    expect(water.lakeBounds.min.y).toBeCloseTo(39.5);
    expect(water.lakeBounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(1000, -1);
    expect(water.lakeBounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(-500, -1);
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
    scene.add(water.mesh);

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

  it('Trees.setReflectionTrees puts only the impostor batches on LAYER_REFLECT and unhides them there', () => {
    const fakeTrees = Object.create(Trees.prototype);
    const hero = new THREE.Mesh(), mid = new THREE.Mesh(), far = new THREE.Mesh();
    fakeTrees._far = [far];
    fakeTrees.impMaterial = new THREE.MeshBasicMaterial();
    fakeTrees.lodUniforms = { uTreeReflect: { value: 0 } };
    fakeTrees.worldData = {};

    fakeTrees.setReflectionTrees();

    expect(far.layers.isEnabled(0)).toBe(true);
    expect(far.layers.isEnabled(LAYER_REFLECT)).toBe(true);
    expect(hero.layers.isEnabled(LAYER_REFLECT)).toBe(false);
    expect(mid.layers.isEnabled(LAYER_REFLECT)).toBe(false);

    const reflCam = new THREE.PerspectiveCamera();
    reflCam.layers.set(LAYER_REFLECT);
    far.onBeforeRender(null, null, reflCam);
    expect(fakeTrees.lodUniforms.uTreeReflect.value).toBe(1);
    far.onBeforeRender(null, null, new THREE.PerspectiveCamera());
    expect(fakeTrees.lodUniforms.uTreeReflect.value).toBe(0);
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
