import * as THREE from 'three';
import { WORLD } from '../config.js';
import { U } from '../uniforms.js';
import { generateNearRaw, generateFar, HeightField } from './heightmap.js';
import { generateNoiseTexture } from './noiseTex.js';
import { planTrail, carveTrail } from './trail.js';
import { buildBiome } from './biome.js';
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

// World data generation, system registration, scenery edits, and world render-pass wiring.

export async function buildWorldData(renderer, step = async () => {}) {
  await step('listening for the mountains…', 0.05);
  const noiseRT = generateNoiseTexture(renderer);
  U.uNoiseTex.value = noiseRT.texture;
  const farRT = generateFar(renderer);
  U.uFarHeightTex.value = farRT.texture;

  await step('raising the ridgelines…', 0.18);
  const heights = generateNearRaw(renderer);

  await step('finding the old trail…', 0.34);
  const trail = planTrail(heights);
  const mask = carveTrail(heights, trail);
  const streamPlan = planStream(heights, trail);
  if (streamPlan) carveStream(heights, mask, streamPlan);
  const R = WORLD.res;
  const rg = new Float32Array(R * R * 2);
  for (let i = 0; i < R * R; i++) { rg[i * 2] = heights[i]; rg[i * 2 + 1] = mask[i]; }
  const hTex = new THREE.DataTexture(rg, R, R, THREE.RGFormat, THREE.FloatType);
  hTex.magFilter = THREE.LinearFilter;
  hTex.minFilter = THREE.LinearFilter;
  hTex.wrapS = hTex.wrapT = THREE.ClampToEdgeWrapping;
  hTex.needsUpdate = true;
  U.uHeightTex.value = hTex;
  const hf = new HeightField(heights, mask, R, WORLD.size);
  hf.trailPoints = trail.points;

  await step('letting the meadows grow…', 0.48);
  const biome = buildBiome(hf);
  U.uBiomeTex.value = biome.tex;

  return {
    noiseRT, farRT, heights, trail, mask, streamPlan, hTex, hf, biome,
    dispose() {
      noiseRT.dispose();
      farRT.dispose();
      hTex.dispose();
      biome.dispose();
    },
  };
}

export async function buildWorldSystems(ctx, step = async () => {}, opts = {}) {
  const { scene, data, registry } = ctx;
  const { biome, trail, streamPlan } = data;
  const OFF = opts.off || new Set();
  const noWater = !!opts.noWater;

  await step('planting the forests…', 0.6);
  const terrainSys = registry.register('terrain', createTerrain(ctx), { phase: 'render' });
  const skySys = registry.register('sky', createSky(ctx), { phase: 'static' });
  const waterSys = registry.register('water', createWater(ctx, noWater), { phase: 'sim' });
  const shadowsSys = registry.register('shadows', createTerrainShadows(ctx, WORLD.size, WORLD.farSize), { phase: 'static' });
  const treesSys = registry.register('trees', createTrees(ctx), { phase: 'render' });

  await step('scattering stones…', 0.72);
  const rocksSys = registry.register('rocks', createRocks(ctx), { phase: 'static' });
  const propsSys = registry.register('props', createProps(ctx), { phase: 'static' });
  const props = propsSys.instance;
  const trees = treesSys.instance;
  const rocks = rocksSys.instance;

  const shoreSys = registry.register(
    'shore',
    createShore(ctx, [...(props.jettyZone || []), ...(props.shoreBench ? [props.shoreBench] : [])]),
    { phase: 'static' },
  );
  console.log('shore', JSON.stringify(shoreSys.instance.count));

  const villageSys = registry.register('village', createVillage(ctx, { props, trees, rocks }), { phase: 'both' });
  const village = villageSys.instance;

  // Scenery edits: clear sightlines around trailhead, meadow, summitWest, cottage, saddle, signpost, forest cathedral, dawn overlook, benches.
  for (let i = 0; i < Math.min(36, trail.points.length); i += 3) {
    trees.clearArea(trail.points[i][0], trail.points[i][1], i < 16 ? 19 : 14);
  }
  {
    const d12 = 0.12 * trail.dist[trail.dist.length - 1];
    const i12 = Math.max(0, trail.dist.findIndex((x) => x >= d12));
    const p12 = trail.points[i12], q12 = trail.points[Math.min(trail.points.length - 1, i12 + 8)];
    const yaw12 = Math.atan2(-(q12[0] - p12[0]), -(q12[1] - p12[1])) + 0.5;
    const fx12 = -Math.sin(yaw12), fz12 = -Math.cos(yaw12);
    for (let dd = 4; dd <= 26; dd += 5) {
      rocks.clearArea(p12[0] + fx12 * dd, p12[1] + fz12 * dd, 8);
      trees.clearArea(p12[0] + fx12 * dd, p12[1] + fz12 * dd, 5);
    }
  }
  for (let d = 18; d <= 185; d += 24) rocks.clearArea(-770 - 0.61 * d, -790 - 0.79 * d, 34);
  rocks.clearArea(-770, -790, 26);
  rocks.clearArea(-798, -808, 48);
  {
    const hx = village.house.x, hz = village.house.z;
    const [fxC, fzC] = village.house.front;
    const camA = Math.atan2(fxC, fzC) + 0.5;
    const camX = hx + Math.sin(camA) * 28, camZ = hz + Math.cos(camA) * 28;
    for (let f = 10; f <= 34; f += 6) {
      const lxC = hx + fxC * f * 0.65 + Math.sin(camA) * f * 0.35;
      const lzC = hz + fzC * f * 0.65 + Math.cos(camA) * f * 0.35;
      for (let sd = 8; sd <= 84; sd += 9) trees.clearArea(lxC - 0.86 * sd, lzC + 0.09 * sd, 12);
    }
    trees.clearArea(camX, camZ, 12);
  }
  if (props.benches[1]) {
    const sb = props.benches[1];
    const sfx = Math.sin(sb.ry), sfz = Math.cos(sb.ry);
    const slx = sfz, slz = -sfx;
    trees.clearArea(sb.x + slx * 7 - sfx * 3, sb.z + slz * 7 - sfz * 3, 14);
    trees.clearArea(sb.x + slx * 14 + sfx * 6, sb.z + slz * 14 + sfz * 6, 16);
    trees.clearArea(sb.x + slx * 20 + sfx * 14, sb.z + slz * 20 + sfz * 14, 15);
  }
  {
    const p0 = trail.points[0], p4 = trail.points[4], p8 = trail.points[8];
    const tx = p8[0] - p0[0], tz = p8[1] - p0[1], tl = Math.hypot(tx, tz) || 1;
    const fx = tx / tl, fz = tz / tl, rx = -fz, rz = fx;
    const spx = p4[0] + rx * 1.85, spz = p4[1] + rz * 1.85;
    for (let dd = 6; dd <= 24; dd += 6) trees.clearArea(spx + fx * dd, spz + fz * dd, 6.2);
  }
  let forestIdx = 0;
  {
    let bfF = -1;
    trail.points.forEach((p, i) => {
      if (i < 90 || i > trail.points.length - 120) return;
      const f = biome.sampleForest(p[0], p[1]) + biome.sampleForest(p[0] + 15, p[1]) + biome.sampleForest(p[0] - 15, p[1]);
      if (f < 2.15) return;
      let near = 1e9;
      for (const tr of trees.trees) {
        if (tr.bush || tr.hidden) continue;
        const distT = Math.hypot(tr.x - p[0], tr.z - p[1]);
        if (distT < near) near = distT;
      }
      const scF = f + Math.min(near, 7) * 0.4;
      if (scF > bfF) { bfF = scF; forestIdx = i; }
    });
    for (let k = Math.max(0, forestIdx - 2); k < Math.min(trail.points.length, forestIdx + 30); k += 2) {
      trees.clearArea(trail.points[k][0], trail.points[k][1], 5.2);
    }
    const pF = trail.points[forestIdx], qF = trail.points[Math.min(trail.points.length - 1, forestIdx + 10)];
    const fdx = qF[0] - pF[0], fdz = qF[1] - pF[1], fl = Math.hypot(fdx, fdz) || 1;
    const fux = fdx / fl, fuz = fdz / fl;
    const lxF = fuz, lzF = -fux;
    for (let dd = 0; dd <= 18; dd += 4) rocks.clearArea(pF[0] + fux * dd, pF[1] + fuz * dd, 8.8);
    trees.clearArea(pF[0] + fux * 5.0 + lxF * 7.0, pF[1] + fuz * 5.0 + lzF * 7.0, 10.0);
    trees.clearArea(pF[0] + fux * 15.0 + lxF * 8.5, pF[1] + fuz * 15.0 + lzF * 8.5, 11.0);
    trees.clearArea(pF[0] + fux * 5.5 - lxF * 7.0, pF[1] + fuz * 5.5 - lzF * 7.0, 11.2);
    trees.clearArea(pF[0] + fux * 14.0 - lxF * 8.0, pF[1] + fuz * 14.0 - lzF * 8.0, 10.6);
    for (let k = Math.min(trail.points.length - 1, forestIdx + 12); k < Math.min(trail.points.length, forestIdx + 28); k += 2) {
      trees.clearArea(trail.points[k][0], trail.points[k][1], 12.2);
    }
    trees.addHeroOaks([
      [pF[0] + fux * 11.5 + lxF * 6.8, pF[1] + fuz * 11.5 + lzF * 6.8, 17.5, 0.9, [0.88, 0.98, 0.88]],
      [pF[0] + fux * 12.8 - lxF * 7.2, pF[1] + fuz * 12.8 - lzF * 7.2, 18.2, 2.7, [0.92, 1.02, 0.90]],
      [pF[0] + fux * 22.5 + lxF * 8.6, pF[1] + fuz * 22.5 + lzF * 8.6, 19.0, 4.1, [0.96, 1.04, 0.88]],
      [pF[0] + fux * 23.5 - lxF * 9.0, pF[1] + fuz * 23.5 - lzF * 9.0, 17.8, 5.2, [0.90, 1.00, 0.86]],
    ]);
  }
  {
    const d20 = 0.2 * trail.dist[trail.dist.length - 1];
    const i20 = Math.max(0, trail.dist.findIndex((x) => x >= d20));
    const p20 = trail.points[i20], q20 = trail.points[Math.min(trail.points.length - 1, i20 + 8)];
    const yaw20 = Math.atan2(-(q20[0] - p20[0]), -(q20[1] - p20[1])) + 1.8;
    const fx20 = -Math.sin(yaw20), fz20 = -Math.cos(yaw20);
    rocks.clearArea(p20[0] + fx20 * 10, p20[1] + fz20 * 10, 16);
    for (let dd = 2; dd <= 50; dd += 4) trees.clearArea(p20[0] + fx20 * dd, p20[1] + fz20 * dd, 7.8 + dd * 0.28);
  }
  for (const b of props.benches) {
    const fx = Math.sin(b.ry), fz = Math.cos(b.ry);
    for (let d = 6; d <= 70; d += 6) trees.clearArea(b.x + fx * d, b.z + fz * d, 4 + d * 0.28);
  }

  scene.add(village.group);
  const fernsSys = registry.register('ferns', createFerns(ctx), { phase: 'render' });
  const logsSys = registry.register('logs', createLogs(ctx, village.mat, props.benches), { phase: 'static' });
  const streamSys = streamPlan ? registry.register('stream', createStream(ctx), { phase: 'render' }) : null;
  const stream = streamSys ? streamSys.instance : null;
  const fallsSys = stream ? registry.register('falls', createWaterfall(ctx, trees.material), { phase: 'render' }) : null;
  const falls = fallsSys ? fallsSys.instance : null;
  if (falls && falls.foot) {
    trees.clearArea(falls.foot.x, falls.foot.z, 20);
    rocks.clearArea(falls.foot.x, falls.foot.z, 19);
  }
  if (falls && falls.foot && streamPlan) {
    const sp = streamPlan.points;
    for (let k = falls.footIdx; k < Math.min(sp.length, falls.footIdx + 28); k++) {
      trees.clearArea(sp[k][0], sp[k][1], 7.5 + (k - falls.footIdx) * 0.14);
      rocks.clearArea(sp[k][0], sp[k][1], 6.5);
    }
    const kc = Math.min(sp.length - 2, falls.footIdx + 18), [px, pz] = sp[kc], [qx, qz] = sp[kc + 1];
    const tl = Math.hypot(qx - px, qz - pz) || 1, cx = px - (qz - pz) / tl * 5, cz = pz + (qx - px) / tl * 5;
    const tgx = falls.foot.x * 0.6 + falls.top.x * 0.4, tgz = falls.foot.z * 0.6 + falls.top.z * 0.4;
    for (let f = 0.1; f <= 1.0; f += 0.06) trees.clearArea(cx + (tgx - cx) * f, cz + (tgz - cz) * f, 4.8 + f * 7.2);
    const rxF = -(qz - pz) / tl, rzF = (qx - px) / tl;
    trees.clearArea(px - rxF * 10, pz - rzF * 10, 12);
    trees.clearArea(falls.top.x, falls.top.z, 15);
  }
  const bridge = stream ? stream.buildBridge(trail, village.mat) : null;
  if (bridge) scene.add(bridge);

  const shaftsSys = registry.register('shafts', createLightShafts(ctx, forestIdx), { phase: 'render' });
  const butterfliesSys = registry.register('butterflies', createButterflies(ctx), { phase: 'render' });
  const grassSys = registry.register('grass', createGrass(ctx), { phase: 'render' });
  const flowersSys = registry.register('flowers', createFlowers(ctx), { phase: 'render' });
  const cloudsSys = registry.register('clouds', createClouds(ctx), { phase: 'sim' });
  const birdsSys = registry.register('birds', createBirds(ctx), { phase: 'sim' });
  const motesSys = registry.register('motes', createParticles(ctx, { box: 38, mode: 0 }), { phase: 'render' });
  const firefliesSys = registry.register('fireflies', createParticles(ctx, { box: 82, mode: 1 }), { phase: 'render' });
  const lighting = registry.register('lighting', createLighting(ctx), { phase: 'render' });

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

export function createWorldPasses({ app, data, world, registry, env, player, audio, session, renderFlags, capture }) {
  const { renderer, scene, camera } = app;
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
    simPass({ dt, t, simOnly = false, renderOnly = false }) {
      lastDt = dt;
      const groundY = data.hf.height(camera.position.x, camera.position.z);
      const pix = renderer.domElement.height * app.getScale();
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
      const lakeD = Math.hypot(camera.position.x - WORLD.lake.x, camera.position.z - WORLD.lake.z);
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
  };
}
