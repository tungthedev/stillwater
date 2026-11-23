import * as THREE from 'three';
import { VALLEY } from '../content/valley.js';
import { getCaps } from '../engine/caps.js';
import { U } from '../uniforms.js';
import {
  generateNearRaw,
  generateFarRaw,
  createNearHeightTexture,
  createFarHeightTexture,
  HeightField,
} from './heightmap.js';
import { generateNoiseTexture } from './noiseTex.js';
import { planTrail, carveTrail } from './trail.js';
import { buildBiome } from './biome.js';
import {
  WorldData,
  loadWorld,
  encodeBakedWorld,
  computeAnchors,
  generateTreePlacements,
  generateRockPlacements,
  applySceneryEdits,
} from './worldData.js';
import { createTerrain } from './terrain.js';
import { createSky } from './sky.js';
import { createWater } from './water.js';
import { createTerrainShadows } from './shadows.js';
import { createGrass, createFlowers } from './grass.js';
import { createTrees } from './trees.js';
import { createRocks } from './rocks.js';
import { createProps } from './props.js';
import { createBirds, createParticles } from './fauna.js';
import { createClouds } from './clouds.js';
import { createVillage } from './village.js';
import { createFerns, createButterflies, createLogs, createLightShafts } from './undergrowth.js';
import { planStream, carveStream, createStream } from './stream.js';
import { createWaterfall } from './waterfall.js';
import { createShore } from './shore.js';
import { createLighting } from './lighting.js';

// World data loading/generation, system registration, and world render-pass wiring.

/** Live GPU + CPU world generation (dev/bake path only). */
export async function generateWorldData(renderer, region = VALLEY, step = async () => {}) {
  await step('raising the ridgelines…', 0.18);
  const farHeights = generateFarRaw(renderer, region);
  const heights = generateNearRaw(renderer, region);

  await step('finding the old trail…', 0.34);
  const trail = planTrail(heights, region);
  const mask = carveTrail(heights, trail, region);
  const streamPlan = planStream(heights, trail, region);
  if (streamPlan) carveStream(heights, mask, streamPlan, region);
  const hf = new HeightField(heights, mask, region.res, region.size);
  hf.trailPoints = trail.points;

  await step('letting the meadows grow…', 0.48);
  const biome = buildBiome(hf, region);
  const anchors = computeAnchors({ region, hf, trail, streamPlan });
  const rawTrees = generateTreePlacements(hf, biome, region);
  const rawRocks = generateRockPlacements(hf, trail.points, streamPlan ? streamPlan.points : null, biome, region);
  const edited = applySceneryEdits(
    { trees: rawTrees, rocks: rawRocks, heroOaks: [] },
    region.sceneryEdits,
    { trail, streamPlan, biome, anchors },
  );

  return new WorldData({
    region,
    heights,
    mask,
    farHeights,
    trail,
    streamPlan,
    biome,
    placements: {
      trees: edited.trees,
      rocks: edited.rocks,
      heroOaks: edited.heroOaks,
    },
    anchors,
    forestIdx: edited.forestIdx,
    source: 'live',
  });
}

/** Generate live region data on the GPU and return an encoder handle for tools/bake-world.mjs. */
export async function createBakeContext(renderer, region, gpuName) {
  const data = await generateWorldData(renderer, region);
  return {
    renderer: gpuName,
    regionId: region.id,
    encode: (opts = {}) => encodeBakedWorld(data, { renderer: gpuName, ...opts }),
  };
}

/**
 * Build or load canonical WorldData for `region` and upload its GPU textures.
 * Player sessions load baked files via `loadWorld(region)` (no GPU float readback).
 * Live generation runs only when `opts.live` is true (dev / `tools/bake-world.mjs`).
 */
export async function buildWorldData(renderer, step = async () => {}, region = VALLEY, opts = {}) {
  U.uWorldSize.value = region.size;
  U.uFarSize.value = region.farSize;
  U.uWaterLevel.value = region.waterLevel;

  await step('listening for the mountains…', 0.08);
  const noiseRT = generateNoiseTexture(renderer);
  U.uNoiseTex.value = noiseRT.texture;

  let worldData;
  if (opts.live) {
    worldData = await generateWorldData(renderer, region, step);
  } else {
    await step('reading the valley map…', 0.28);
    worldData = await loadWorld(region, { baseUrl: opts.baseUrl, fetch: opts.fetch });
    // Keep the seeded capture Math.random stream aligned when skipping the two GPU heightmap passes (2*36 - 8 = 64 UUID calls).
    for (let i = 0; i < 64; i++) Math.random();
  }

  const caps = getCaps(renderer);
  U.uHeightSplit.value = caps.floatLinear ? 0 : 1;

  const hTex = createNearHeightTexture(worldData.heights, worldData.mask, region.res, caps);
  U.uHeightTex.value = hTex;
  const farTex = createFarHeightTexture(worldData.farHeights, region.farRes, caps);
  U.uFarHeightTex.value = farTex;

  if (!worldData.biome.tex) {
    const bTex = new THREE.DataTexture(
      worldData.biome.data,
      region.biomeRes,
      region.biomeRes,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    bTex.magFilter = THREE.LinearFilter;
    bTex.minFilter = THREE.LinearFilter;
    bTex.wrapS = bTex.wrapT = THREE.ClampToEdgeWrapping;
    bTex.needsUpdate = true;
    worldData.biome.tex = bTex;
  }
  U.uBiomeTex.value = worldData.biome.tex;

  worldData.noiseRT = noiseRT;
  worldData.hTex = hTex;
  worldData.farTex = farTex;
  worldData.trackDisposable(noiseRT);
  worldData.trackDisposable(hTex);
  worldData.trackDisposable(farTex);
  return worldData;
}

export async function buildWorldSystems(ctx, step = async () => {}, opts = {}) {
  const { scene, data, registry } = ctx;
  const { region, trail, streamPlan } = data;
  const OFF = opts.off || new Set();
  const noWater = !!opts.noWater;

  await step('planting the forests…', 0.6);
  // Construct systems in deterministic RNG/UUID order, then register in per-frame update order.
  const terrainSys = createTerrain(ctx);
  const skySys = createSky(ctx);
  const waterSys = createWater(ctx, noWater);
  const shadowsSys = createTerrainShadows(ctx, region.size, region.farSize);
  const treesSys = createTrees(ctx);

  await step('scattering stones…', 0.72);
  const rocksSys = createRocks(ctx);
  const propsSys = createProps(ctx);
  const props = propsSys.instance;
  const trees = treesSys.instance;
  const rocks = rocksSys.instance;

  const shoreSys = createShore(ctx, [...(props.jettyZone || []), ...(props.shoreBench ? [props.shoreBench] : [])]);
  console.log('shore', JSON.stringify(shoreSys.instance.count));

  const villageSys = createVillage(ctx, { props, trees });
  const village = villageSys.instance;
  // Build hero oak geometry after Village so seeded Math.random consumption order stays identical for herds.
  trees.buildHeroOaks();

  scene.add(village.group);
  const fernsSys = createFerns(ctx);
  const logsSys = createLogs(ctx, village.mat, props.benches);
  const streamSys = streamPlan ? createStream(ctx) : null;
  const stream = streamSys ? streamSys.instance : null;
  const fallsSys = stream ? createWaterfall(ctx, trees.material) : null;
  const falls = fallsSys ? fallsSys.instance : null;
  const bridge = stream ? stream.buildBridge(trail, village.mat) : null;
  if (bridge) scene.add(bridge);

  const forestIdx = data.forestIdx;
  const shaftsSys = createLightShafts(ctx, forestIdx);
  const butterfliesSys = createButterflies(ctx);
  const grassSys = createGrass(ctx);
  const flowersSys = createFlowers(ctx);
  const cloudsSys = createClouds(ctx);
  const birdsSys = createBirds(ctx);
  const motesSys = createParticles(ctx, { box: 38, mode: 0 });
  const firefliesSys = createParticles(ctx, { box: 82, mode: 1 });
  const lighting = createLighting(ctx);

  // Register in exact per-frame update order so seeded Math.random consumers (herd before water) stay deterministic.
  registry.register('terrain', terrainSys, { phase: 'render' });
  registry.register('sky', skySys, { phase: 'static' });
  registry.register('shadows', shadowsSys, { phase: 'static' });
  registry.register('trees', treesSys, { phase: 'render' });
  registry.register('rocks', rocksSys, { phase: 'static' });
  registry.register('props', propsSys, { phase: 'static' });
  registry.register('shore', shoreSys, { phase: 'static' });
  registry.register('grass', grassSys, { phase: 'render' });
  registry.register('flowers', flowersSys, { phase: 'render' });
  registry.register('birds', birdsSys, { phase: 'sim' });
  registry.register('clouds', cloudsSys, { phase: 'sim' });
  registry.register('ferns', fernsSys, { phase: 'render' });
  registry.register('shafts', shaftsSys, { phase: 'render' });
  registry.register('butterflies', butterfliesSys, { phase: 'render' });
  registry.register('village', villageSys, { phase: 'both' });
  registry.register('logs', logsSys, { phase: 'static' });
  registry.register('motes', motesSys, { phase: 'render' });
  registry.register('fireflies', firefliesSys, { phase: 'render' });
  if (streamSys) registry.register('stream', streamSys, { phase: 'render' });
  if (fallsSys) registry.register('falls', fallsSys, { phase: 'render' });
  registry.register('water', waterSys, { phase: 'sim' });
  registry.register('lighting', lighting, { phase: 'render' });

  const grass = grassSys.instance, flowers = flowersSys.instance, clouds = cloudsSys.instance;
  const birds = birdsSys.instance, motes = motesSys.instance, fireflies = firefliesSys.instance;
  const butterflies = butterfliesSys.instance, terrain = terrainSys.instance, sky = skySys.instance;
  if (OFF.has('grass')) { grass.mesh.visible = false; flowers.mesh.visible = false; }
  if (OFF.has('trees')) trees.group.visible = false;
  if (OFF.has('clouds')) clouds.mesh.visible = false;
  if (OFF.has('rocks')) rocks.group.visible = false;
  if (OFF.has('terrain')) terrain.mesh.visible = false;
  if (OFF.has('birds')) birds.mesh.visible = false;
  if (OFF.has('motes')) { motes.points.visible = false; fireflies.points.visible = false; }
  if (OFF.has('fly')) butterflies.mesh.visible = false;
  if (OFF.has('props')) { props.group.visible = false; village.group.visible = false; }
  if (OFF.has('sky')) sky.mesh.visible = false;
  if (OFF.has('spray') && stream) stream.spray.visible = false;
  if (OFF.has('mist') && falls && falls.mist) falls.mist.visible = false;

  return {
    terrain, sky, water: waterSys.instance, shadows: shadowsSys.instance, trees, rocks, props,
    shore: shoreSys.instance, village, ferns: fernsSys.instance, logs: logsSys.instance, stream,
    falls, bridge, shafts: shaftsSys.instance, butterflies, grass, flowers, clouds, birds, motes,
    fireflies, lighting, forestIdx,
  };
}

export function createRenderFlags(params, off, tier) {
  return {
    shadow: !off.has('shadow'),
    refl: !params.has('norefl') && !off.has('refl') && tier.reflEvery !== 0,
    grass: !off.has('grass'),
    ferns: true,
    trees: !off.has('trees'),
    clouds: !off.has('clouds'),
    bloom: true,
    ambRead: true,
    skyLut: true,
    msaa: (tier.msaa || 0) > 0,
  };
}

export function syncRenderFlags(flags, params, off, tier) {
  flags.refl = !params.has('norefl') && !off.has('refl') && tier.reflEvery !== 0;
  flags.msaa = (tier.msaa || 0) > 0;
}

export function warmupWorld({ env, world, session, camera }) {
  env.update(0, 0, null);
  world.sky.renderLUT();
  world.sky.readAmbient();
  world.shadows.update(true);
  if (session.mode === 'title') session.titleCam(0);
  world.trees.update(camera.position, true);
}

export function createWorldPasses({ app, data, world, registry, env, player, audio, ui, session, renderFlags, capture }) {
  const { renderer, scene, camera } = app;
  const lake = data.region.lake;
  const sunNDC = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const sunUV = new THREE.Vector2();

  const onSheepCheck = (sheep) => {
    if (audio.started && Math.random() < lastDt * 0.12) {
      const d = sheep.nearest(camera.position);
      if (d < 60) audio.bleat(Math.max(0.05, 1 - d / 60));
    }
  };
  const onWaterRipple = (rip) => {
    if (!audio.started) return;
    const d = Math.hypot(rip.x - camera.position.x, rip.y - camera.position.z);
    if (d < 90) audio.splash(Math.max(0.05, 1 - d / 90) * 0.5);
  };
  let lastDt = 0;

  return {
    skyPass({ dt, t, frameNo, skipEnvUpdate = false }) {
      U.uTime.value = t;
      if (!skipEnvUpdate) env.update(dt, t, world.sky.ambient.sky);
      if ((renderFlags.ambRead && frameNo % 12 === 0) || capture) world.sky.readAmbient();
      world.sky.skyUniforms.uStarRot.value = (env.hours / 24) * Math.PI * 2;
      world.sky.lutMat.uniforms.uMoonI.value = 0.05 * env.night;
      world.sky.moonDir.value.copy(env.moon);
      renderer.info.reset();
      if (renderFlags.skyLut || capture) world.sky.renderLUT();
      return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    },
    terrainShadowPass({ frameNo }) {
      renderer.info.reset();
      world.shadows.update(capture && frameNo < 3);
      return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    },
    simPass({ dt, t, pix = 0, simOnly = false, renderOnly = false }) {
      lastDt = dt;
      const groundY = data.height(camera.position.x, camera.position.z);
      const frame = {
        dt, t, camera, groundY, pix, U, env, amb: world.sky.ambient,
        playerPos: player.pos, renderFlags, onSheepCheck, onWaterRipple,
        phase: simOnly ? 'sim' : renderOnly ? 'render' : 'all',
      };
      if (simOnly) {
        registry.update(frame, 'sim');
      } else if (renderOnly) {
        registry.update(frame, 'render');
      } else {
        registry.update(frame);
      }
      return groundY;
    },
    reflectionPass({ frameNo }) {
      const lakeD = Math.hypot(camera.position.x - lake.x, camera.position.z - lake.z);
      if (lakeD < 3500 && renderFlags.refl && (frameNo % (app.Q.reflEvery || 1) === 0 || capture)) {
        world.water.renderReflection(renderer, scene, camera, world.terrain);
      } else {
        world.water.uniforms.uHasRefl.value = 0;
      }
    },
    getPostParams({ dt, t, skipFadeStep = false }) {
      camera.getWorldDirection(camDir);
      tmpV.copy(camera.position).addScaledVector(U.uSunDir.value, 10000);
      sunNDC.copy(tmpV).project(camera);
      const facing = camDir.dot(U.uSunDir.value);
      const onScreen = facing > 0 && Math.abs(sunNDC.x) < 1.3 && Math.abs(sunNDC.y) < 1.3;
      const sunUp = THREE.MathUtils.smoothstep(U.uSunDir.value.y, -0.03, 0.04);
      const sunVis = onScreen ? sunUp * THREE.MathUtils.smoothstep(facing, 0.3, 0.8) : 0;
      const rays = sunVis * (0.08 + env.golden * 0.14) * (app.Q.godrays ? 1 : 0);
      if (capture) env.exposure = env.expTarget;
      const fadeVal = skipFadeStep ? session.fade : session.stepFade(dt);
      return {
        exposure: env.exposure, bloom: 0.055, bloomThreshold: 0.95, rays,
        skipBloom: !renderFlags.bloom, rayColor: env.sunCol,
        sunUV: sunUV.set(sunNDC.x * 0.5 + 0.5, sunNDC.y * 0.5 + 0.5), sunVis,
        time: t, fade: fadeVal,
        wb: env.grade.wb, lift: env.grade.lift, gain: env.grade.gain, sat: env.grade.sat, contrast: env.grade.contrast,
        letterbox: 0, shadowTint: env.grade.shadowTint,
        golden: Math.max(env.golden, env.dusk * 0.6), dawn: env.dawn,
      };
    },
    updateAudio(dt, groundY) {
      const lakeDist = Math.max(0, Math.hypot((camera.position.x - lake.x) / lake.rx, (camera.position.z - lake.z) / lake.rz) - 1) * lake.rx;
      audio.update(dt, {
        wind: env.wind,
        altitude: groundY,
        lake: Math.max(0, 1 - lakeDist / 120),
        day: env.day,
        dusk: env.dusk,
        night: env.night,
        moving: player.moving,
        sitting: player.sitting ? 1 : 0,
        forest: data.biome.sampleForest(camera.position.x, camera.position.z),
        swell: ui.swell,
        stream: world.stream ? Math.max(0, 1 - world.stream.distanceTo(camera.position) / 70) : 0,
      }, camera);
    },
  };
}
