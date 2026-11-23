import * as THREE from 'three';
import { WORLD } from '../config.js';
import { U } from '../uniforms.js';
import { generateNearRaw, generateFar, HeightField } from './heightmap.js';
import { generateNoiseTexture } from './noiseTex.js';
import { planTrail, carveTrail } from './trail.js';
import { buildBiome } from './biome.js';
import { Terrain } from './terrain.js';
import { Sky } from './sky.js';
import { Water, LAYER_NO_REFLECT } from './water.js';
import { TerrainShadows } from './shadows.js';
import { Grass, Flowers } from './grass.js';
import { Trees } from './trees.js';
import { Rocks } from './rocks.js';
import { Props } from './props.js';
import { Birds, Particles } from './fauna.js';
import { Clouds } from './clouds.js';
import { Village } from './village.js';
import { Ferns, Butterflies, buildLogs, LightShafts } from './undergrowth.js';
import { planStream, carveStream, Stream } from './stream.js';
import { Waterfall } from './waterfall.js';
import { Shore } from './shore.js';

// World data generation (heightmaps, trail, stream, biome) and world system construction + scenery edits.

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
    noiseRT,
    farRT,
    heights,
    trail,
    mask,
    streamPlan,
    hTex,
    hf,
    biome,
    dispose() {
      noiseRT.dispose();
      farRT.dispose();
      hTex.dispose();
      biome.tex.dispose();
    },
  };
}

export async function buildWorldSystems(ctx, step = async () => {}, opts = {}) {
  const { renderer, scene, camera, data, tier: Q } = ctx;
  const { hf, biome, trail, streamPlan } = data;
  const OFF = opts.off || new Set();
  const noWater = !!opts.noWater;

  await step('planting the forests…', 0.6);
  camera.layers.enable(LAYER_NO_REFLECT);
  const terrain = new Terrain(Q);
  scene.add(terrain.mesh);
  const sky = new Sky(renderer);
  scene.add(sky.mesh);
  const water = new Water();
  if (!noWater) scene.add(water.mesh);
  const shadows = new TerrainShadows(renderer, WORLD.size, WORLD.farSize);
  const trees = new Trees(hf, biome, Q.trees, Q.treeDetail);
  if (Q.treeHi) trees.hiRadius = Q.treeHi;
  if (Q.treeLo) trees.loRadius = Q.treeLo;
  scene.add(trees.group);

  await step('scattering stones…', 0.72);
  const rocks = new Rocks(hf, trail.points, streamPlan ? streamPlan.points : null, biome);
  scene.add(rocks.group);
  const props = new Props(hf, trail);
  scene.add(props.group);
  const shore = new Shore(hf, [...(props.jettyZone || []), ...(props.shoreBench ? [props.shoreBench] : [])]);
  scene.add(shore.group);
  console.log('shore', JSON.stringify(shore.count));
  const village = new Village(hf, trail, props, trees, rocks, biome);

  // keep the trailhead opening sightline wide & inviting (no giant dark bush mass hugging left edge!)
  for (let i = 0; i < Math.min(36, trail.points.length); i += 3) {
    trees.clearArea(trail.points[i][0], trail.points[i][1], i < 16 ? 19 : 14);
  }
  // clear any buried stray stones/bushes right in the meadow wildflower foreground (trailf=0.12)
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
  // clear isolated blocky boulders along summitWest right knoll AND stray lower-left rock near (-770, -790)
  for (let d = 18; d <= 185; d += 24) {
    rocks.clearArea(-770 - 0.61 * d, -790 - 0.79 * d, 34);
  }
  rocks.clearArea(-770, -790, 26);
  rocks.clearArea(-798, -808, 48);
  // clear stray afternoon-shadow-casting trees strictly in front of the cottage lawn (removes flat dark shadow wedge in cottage.png while keeping the grand framing oak behind the house!)
  {
    const hx = village.house.x, hz = village.house.z;
    const [fxC, fzC] = village.house.front;
    const camA = Math.atan2(fxC, fzC) + 0.5;
    const camX = hx + Math.sin(camA) * 28, camZ = hz + Math.cos(camA) * 28;
    // afternoon sun at 16.3 comes from (-0.86, +0.50, +0.09); clear trees along sun rays hitting the front lawn
    for (let f = 10; f <= 34; f += 6) {
      const lxC = hx + fxC * f * 0.65 + Math.sin(camA) * f * 0.35;
      const lzC = hz + fzC * f * 0.65 + Math.cos(camA) * f * 0.35;
      for (let sd = 8; sd <= 84; sd += 9) {
        trees.clearArea(lxC - 0.86 * sd, lzC + 0.09 * sd, 12);
      }
    }
    trees.clearArea(camX, camZ, 12);
  }
  // clear overhanging tree behind-left of saddle bench (removes clipped dark top-left corner leaves in saddle.png!)
  if (props.benches[1]) {
    const sb = props.benches[1];
    const sfx = Math.sin(sb.ry), sfz = Math.cos(sb.ry);
    const slx = sfz, slz = -sfx;
    // open left framing edge of Larch Saddle cleanly so no cropped dark canopy slab cuts across (0-130, 70-380) in saddle.png!
    trees.clearArea(sb.x + slx * 7 - sfx * 3, sb.z + slz * 7 - sfz * 3, 14);
    trees.clearArea(sb.x + slx * 14 + sfx * 6, sb.z + slz * 14 + sfz * 6, 16);
    trees.clearArea(sb.x + slx * 20 + sfx * 14, sb.z + slz * 20 + sfz * 14, 15);
  }
  // clear any tree trunk directly behind the trailhead signpost line of sight (eliminates post/trunk tangency in trailhead.png!)
  {
    const p0 = trail.points[0], p4 = trail.points[4], p8 = trail.points[8];
    const tx = p8[0] - p0[0], tz = p8[1] - p0[1], tl = Math.hypot(tx, tz) || 1;
    const fx = tx / tl, fz = tz / tl, rx = -fz, rz = fx;
    const spx = p4[0] + rx * 1.85, spz = p4[1] + rz * 1.85;
    for (let dd = 6; dd <= 24; dd += 6) {
      trees.clearArea(spx + fx * dd, spz + fz * dd, 6.2);
    }
  }
  // clear BOTH left & right near-camera bush/foliage walls along poi=forest, remove buried foreground rocks (kills floating green card at 140-270, 615-645!),
  // open a radiant sunlit cathedral clearing ahead, and frame both sides with stately gnarled cathedral oaks!
  let forestIdx = 0;
  {
    let bfF = -1;
    trail.points.forEach((p, i) => {
      // stay strictly inside deep cathedral woods (well past the cottage clearing!)
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
    // clear foreground buried rocks in the immediate trail corridor so NO green-topped rock cap reads like a floating leaf card!
    for (let dd = 0; dd <= 18; dd += 4) {
      rocks.clearArea(pF[0] + fux * dd, pF[1] + fuz * dd, 8.8);
    }
    // clear oversized bushes/canopies blocking BOTH left AND right near-camera edges (KILLS flat 35% right-side bush wall at 1050-1600, 0-700!)
    trees.clearArea(pF[0] + fux * 5.0 + lxF * 7.0, pF[1] + fuz * 5.0 + lzF * 7.0, 10.0);
    trees.clearArea(pF[0] + fux * 15.0 + lxF * 8.5, pF[1] + fuz * 15.0 + lzF * 8.5, 11.0);
    trees.clearArea(pF[0] + fux * 5.5 - lxF * 7.0, pF[1] + fuz * 5.5 - lzF * 7.0, 11.2);
    trees.clearArea(pF[0] + fux * 14.0 - lxF * 8.0, pF[1] + fuz * 14.0 - lzF * 8.0, 10.6);
    // open a clear radiant sunlit meadow clearing at the end of the trail framing the crisp alpine peak!
    for (let k = Math.min(trail.points.length - 1, forestIdx + 12); k < Math.min(trail.points.length, forestIdx + 28); k += 2) {
      trees.clearArea(trail.points[k][0], trail.points[k][1], 12.2);
    }
    // frame both sides of the cathedral nave with stately dark-barked overarching oaks!
    trees.addHeroOaks([
      [pF[0] + fux * 11.5 + lxF * 6.8, pF[1] + fuz * 11.5 + lzF * 6.8, 17.5, 0.9, [0.88, 0.98, 0.88]],
      [pF[0] + fux * 12.8 - lxF * 7.2, pF[1] + fuz * 12.8 - lzF * 7.2, 18.2, 2.7, [0.92, 1.02, 0.90]],
      [pF[0] + fux * 22.5 + lxF * 8.6, pF[1] + fuz * 22.5 + lzF * 8.6, 19.0, 4.1, [0.96, 1.04, 0.88]],
      [pF[0] + fux * 23.5 - lxF * 9.0, pF[1] + fuz * 23.5 - lzF * 9.0, 17.8, 5.2, [0.90, 1.00, 0.86]],
    ]);
  }
  // keep the scenic dawn ridge overlook (trailf=0.2) completely clear (no intruding corner leaves or buried foreground rock!)
  {
    const d20 = 0.2 * trail.dist[trail.dist.length - 1];
    const i20 = Math.max(0, trail.dist.findIndex((x) => x >= d20));
    const p20 = trail.points[i20], q20 = trail.points[Math.min(trail.points.length - 1, i20 + 8)];
    const yaw20 = Math.atan2(-(q20[0] - p20[0]), -(q20[1] - p20[1])) + 1.8;
    const fx20 = -Math.sin(yaw20), fz20 = -Math.cos(yaw20);
    rocks.clearArea(p20[0] + fx20 * 10, p20[1] + fz20 * 10, 16);
    for (let dd = 2; dd <= 50; dd += 4) {
      trees.clearArea(p20[0] + fx20 * dd, p20[1] + fz20 * dd, 7.8 + dd * 0.28);
    }
  }
  for (const b of props.benches) {
    const fx = Math.sin(b.ry), fz = Math.cos(b.ry);
    for (let d = 6; d <= 70; d += 6) trees.clearArea(b.x + fx * d, b.z + fz * d, 4 + d * 0.28);
  }
  scene.add(village.group);
  const ferns = new Ferns(Q.ferns, Q.fernRadius);
  scene.add(ferns.mesh);
  const logs = buildLogs(hf, biome, trail, village.mat, props.benches);
  if (logs) scene.add(logs);
  const stream = streamPlan ? new Stream(hf, streamPlan) : null;
  if (stream) scene.add(stream.group);
  const falls = stream ? new Waterfall(hf, streamPlan, trees.material) : null;
  if (falls) scene.add(falls.group);
  if (falls && falls.foot) {
    trees.clearArea(falls.foot.x, falls.foot.z, 20);
    rocks.clearArea(falls.foot.x, falls.foot.z, 19);
  }
  if (falls && falls.foot && streamPlan) {
    const sp = streamPlan.points;
    for (let k = falls.footIdx; k < Math.min(sp.length, falls.footIdx + 28); k++) {
      trees.clearArea(sp[k][0], sp[k][1], 7.5 + (k - falls.footIdx) * 0.14);
      // clear submerged mid-stream rocks that otherwise poke through the foreground river as flat dark-green slabs!
      rocks.clearArea(sp[k][0], sp[k][1], 6.5);
    }
    const kc = Math.min(sp.length - 2, falls.footIdx + 18), [px, pz] = sp[kc], [qx, qz] = sp[kc + 1];
    const tl = Math.hypot(qx - px, qz - pz) || 1, cx = px - (qz - pz) / tl * 5, cz = pz + (qx - px) / tl * 5;
    const tgx = falls.foot.x * 0.6 + falls.top.x * 0.4, tgz = falls.foot.z * 0.6 + falls.top.z * 0.4;
    for (let f = 0.1; f <= 1.0; f += 0.06) trees.clearArea(cx + (tgx - cx) * f, cz + (tgz - cz) * f, 4.8 + f * 7.2);
    // also open up the right foreground bank of falls.png slightly so no giant dark spruce wall blocks 35% of the right frame!
    const rxF = -(qz - pz) / tl, rzF = (qx - px) / tl;
    trees.clearArea(px - rxF * 10, pz - rzF * 10, 12);
    trees.clearArea(falls.top.x, falls.top.z, 15);
  }
  const bridge = stream ? stream.buildBridge(trail, village.mat) : null;
  if (bridge) scene.add(bridge);
  const shafts = new LightShafts(hf, biome, trail, Q.shafts, forestIdx);
  scene.add(shafts.mesh);
  const butterflies = new Butterflies(Q.butterflies);
  scene.add(butterflies.mesh);
  const grass = new Grass(Q.grass, Q.grassRadius);
  scene.add(grass.mesh);
  const flowers = new Flowers(Math.round(Q.grass / 10), Math.min(34, Q.grassRadius * 0.75));
  scene.add(flowers.mesh);
  const clouds = new Clouds(Q.clouds, Q.cloudDetail);
  scene.add(clouds.mesh);
  const birds = new Birds();
  scene.add(birds.mesh);
  const motes = new Particles(Q.motes, 38, 0);
  const fireflies = new Particles(Q.fireflies, 82, 1);
  scene.add(motes.points, fireflies.points);

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
    terrain,
    sky,
    water,
    shadows,
    trees,
    rocks,
    props,
    shore,
    village,
    ferns,
    logs,
    stream,
    falls,
    bridge,
    shafts,
    butterflies,
    grass,
    flowers,
    clouds,
    birds,
    motes,
    fireflies,
    forestIdx,
  };
}
