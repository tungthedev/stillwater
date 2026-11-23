import * as THREE from 'three';
import { WORLD, QUALITY } from './config.js';
import { U } from './uniforms.js';
import { generateNearRaw, generateFar, HeightField } from './world/heightmap.js';
import { generateNoiseTexture } from './world/noiseTex.js';
import { planTrail, carveTrail } from './world/trail.js';
import { buildBiome } from './world/biome.js';
import { Terrain } from './world/terrain.js';
import { Sky } from './world/sky.js';
import { Water, LAYER_NO_REFLECT } from './world/water.js';
import { TerrainShadows } from './world/shadows.js';
import { Grass, Flowers } from './world/grass.js';
import { Trees } from './world/trees.js';
import { Rocks } from './world/rocks.js';
import { Props } from './world/props.js';
import { Birds, Particles } from './world/fauna.js';
import { Clouds } from './world/clouds.js';
import { Village } from './world/village.js';
import { Ferns, Butterflies, buildLogs, LightShafts } from './world/undergrowth.js';
import { planStream, carveStream, Stream } from './world/stream.js';
import { Waterfall } from './world/waterfall.js';
import { Shore } from './world/shore.js';
import { Post } from './post.js';
import { Environment } from './env.js';
import { Player } from './player.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const BENCH = params.has('bench');
const $ = (id) => document.getElementById(id);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function detectQuality(renderer) {
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

async function main() {
  const canvas = $('c');
  const probe = document.createElement('canvas').getContext('webgl2');
  const clipControl = params.has('rd') && !!(probe && probe.getExtension('EXT_clip_control'));
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance',
    reverseDepthBuffer: clipControl, preserveDrawingBuffer: CAPTURE, stencil: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = true;
  const qName = detectQuality(renderer);
  const Q = { ...QUALITY[qName] || QUALITY.medium };
  if (params.get('scale')) Q.scale = parseFloat(params.get('scale'));

  const ui = new UI(qName);
  const step = async (msg, p) => { ui.loading(msg, p); await nextFrame(); };

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
  hTex.magFilter = THREE.LinearFilter; hTex.minFilter = THREE.LinearFilter;
  hTex.wrapS = hTex.wrapT = THREE.ClampToEdgeWrapping;
  hTex.needsUpdate = true;
  U.uHeightTex.value = hTex;
  const hf = new HeightField(heights, mask, R, WORLD.size);
  hf.trailPoints = trail.points;

  await step('letting the meadows grow…', 0.48);
  const biome = buildBiome(hf);
  U.uBiomeTex.value = biome.tex;

  await step('planting the forests…', 0.6);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.25, 60000);
  camera.layers.enable(LAYER_NO_REFLECT);
  const terrain = new Terrain();
  scene.add(terrain.mesh);
  const sky = new Sky(renderer);
  scene.add(sky.mesh);
  const water = new Water();
  if (!params.has('nowater')) scene.add(water.mesh);
  const shadows = new TerrainShadows(renderer, WORLD.size, WORLD.farSize);
  const trees = new Trees(hf, biome, Q.trees, qName === 'low' ? 1 : 2);
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
      let near = 1e9; for (const tr of trees.trees) { if (tr.bush || tr.hidden) continue; const distT = Math.hypot(tr.x - p[0], tr.z - p[1]); if (distT < near) near = distT; }
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
    trees.clearArea(pF[0] + fux * 5.0  + lxF * 7.0, pF[1] + fuz * 5.0  + lzF * 7.0, 10.0);
    trees.clearArea(pF[0] + fux * 15.0 + lxF * 8.5, pF[1] + fuz * 15.0 + lzF * 8.5, 11.0);
    trees.clearArea(pF[0] + fux * 5.5  - lxF * 7.0, pF[1] + fuz * 5.5  - lzF * 7.0, 11.2);
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
  const ferns = new Ferns(qName === 'low' ? 1800 : 22000, qName === 'low' ? 22 : 44);
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
  const shafts = new LightShafts(hf, biome, trail, qName === 'low' ? 28 : 96, forestIdx);
  scene.add(shafts.mesh);
  const butterflies = new Butterflies(qName === 'low' ? 35 : 85);
  scene.add(butterflies.mesh);
  const grass = new Grass(Q.grass, Q.grassRadius);
  scene.add(grass.mesh);
  const flowers = new Flowers(Math.round(Q.grass / 10), Math.min(34, Q.grassRadius * 0.75));
  scene.add(flowers.mesh);
  const clouds = new Clouds(qName === 'low' ? 12 : 26, qName === 'low' ? 1 : qName === 'medium' ? 2 : 3);
  scene.add(clouds.mesh);
  const birds = new Birds();
  scene.add(birds.mesh);
  const motes = new Particles(qName === 'low' ? 1200 : 2800, 38, 0);
  const fireflies = new Particles(qName === 'low' ? 280 : 560, 82, 1);
  scene.add(motes.points, fireflies.points);

  const OFF = new Set((params.get('no') || '').split(','));
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

  // lights
  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(Q.shadow, Q.shadow);
  const sc = sunLight.shadow.camera;
  sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 1; sc.far = 1200;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.06;
  sunLight.shadow.radius = 5;
  scene.add(sunLight, sunLight.target);
  const hemi = new THREE.HemisphereLight(0x8899aa, 0x334422, Math.PI);
  scene.add(hemi);
  const headlamp = new THREE.SpotLight(0xfff1dc, 0, 70, 0.5, 0.65, 1.6);
  headlamp.position.set(0.1, -0.08, 0);
  headlamp.target.position.set(0, -0.25, -1);
  camera.add(headlamp, headlamp.target);
  scene.add(camera);

  await step('waiting for the light…', 0.86);
  const env = new Environment();
  const audio = new AudioEngine();
  const player = new Player(camera, { hf, trees, rocks, props, trail, village }, audio);
  player.world.bridge = stream && stream.bridge;
  player.placeAtStart();
  player.onToast = (m) => ui.toast(m);
  player.onSit = (on) => {
    ui.prompt('');
    if (on) ui.toast(player.sitting.bench ? 'You sit. The day moves on without you.' : 'You sit in the grass for a while.');
  };

  const post = new Post(renderer, { reverse: clipControl, msaa: Q.msaa, godrays: Q.godrays });
  let scale = Q.scale;
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight, scale);
    water.setReflectionSize(innerWidth * Q.reflScale, innerHeight * Q.reflScale);
  };
  resize();
  addEventListener('resize', resize);

  // warm-up: one LUT + shadows
  env.update(0, 0, null);
  sky.renderLUT();
  let amb = sky.readAmbient();
  shadows.update(true);
  trees.update(camera.position, true);

  // ---------------- state & input ----------------
  let mode = CAPTURE ? 'play' : 'title';
  let t = 0, last = performance.now();
  let fade = CAPTURE ? 1 : 0, fadeTarget = 1;
  let hudOn = true;
  let timeBoost = 0;
  let visited = new Set();
  let frameNo = 0;
  let targetFrames = parseInt(params.get('frames') || '45');
  let paused = false;

  const titleCam = (tt) => {
    const L = WORLD.lake;
    const a = 0.25 + tt * 0.012;
    const x = L.x + Math.cos(a) * 520, z = L.z + Math.sin(a) * 420;
    const g = hf.height(x, z);
    camera.position.set(x, Math.max(g, WORLD.waterLevel) + 38 + Math.sin(tt * 0.05) * 6, z);
    const tx = WORLD.summit.x * 0.6 + L.x * 0.4, tz = WORLD.summit.z * 0.6 + L.z * 0.4;
    camera.lookAt(tx, hf.height(tx, tz) + 40, tz);
    camera.updateMatrixWorld();
  };

  const startGame = () => {
    if (mode !== 'title') return;
    mode = 'transition';
    audio.start();
    fadeTarget = 0;
    ui.hideTitle();
    setTimeout(() => {
      mode = 'play';
      player.enabled = true;
      fadeTarget = 1;
      ui.showHud(true);
      setTimeout(() => ui.toast('Q follows the trail · E to sit and rest'), 4000);
    }, 2300);
  };

  canvas.addEventListener('click', () => {
    if (mode === 'title') startGame();
    if (mode === 'play' && !CAPTURE && !BENCH) canvas.requestPointerLock?.();
  });
  $('title').style.pointerEvents = 'auto';
  $('title').addEventListener('click', () => { startGame(); canvas.requestPointerLock?.(); });
  $('paused').addEventListener('click', (e) => {
    const q = e.target.dataset?.q;
    if (q) { try { localStorage.setItem('stillwater.q', q); } catch {} location.search = '?q=' + q; return; }
    canvas.requestPointerLock?.();
  });
  document.addEventListener('pointerlockchange', () => {
    player.locked = document.pointerLockElement === canvas;
    paused = !player.locked && mode === 'play' && !CAPTURE && !BENCH;
    ui.paused(paused);
    if (audio.ctx) { if (paused) audio.ctx.suspend(); else audio.ctx.resume(); }
  });
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyG' && !CAPTURE && !BENCH) {
      dbgOn = !dbgOn;
      $('debug').classList.toggle('on', dbgOn);
      return;
    }
    if (mode !== 'play') return;
    if (e.code === 'KeyF') { headlamp.intensity = headlamp.intensity > 0 ? 0 : 38; ui.toast(headlamp.intensity ? 'Headlamp on' : 'Headlamp off'); }
    if (e.code === 'KeyH') { hudOn = !hudOn; document.body.classList.toggle('photo', !hudOn); }
    if (e.code === 'KeyM') { audio.setMusic(!audio.musicOn); ui.toast(audio.musicOn ? 'Music on' : 'Music off'); }
    if (e.code === 'BracketRight') { env.hours = (env.hours + 0.5) % 24; ui.toast(ui.clock(env.hours)); }
    if (e.code === 'BracketLeft') { env.hours = (env.hours + 23.5) % 24; ui.toast(ui.clock(env.hours)); }
  });

  // ---------------- on-screen performance debug HUD ----------------
  let dbgOn = !CAPTURE && !BENCH && params.get('debug') !== '0';
  const dbgState = {
    shadow: !OFF.has('shadow'),
    refl: !params.has('norefl') && !OFF.has('refl') && Q.reflEvery !== 0,
    grass: !OFF.has('grass'),
    ferns: true,
    trees: !OFF.has('trees'),
    clouds: !OFF.has('clouds'),
    bloom: true,
    ambRead: true,
    skyLut: true,
    msaa: (Q.msaa || 0) > 0,
  };
  const dbgEl = $('debug');
  const dbgFpsEl = $('dbgFps'), dbgMsEl = $('dbgMs'), dbgGpuEl = $('dbgGpu'), dbgBodyEl = $('dbgBody');
  const dbgCanvas = $('dbgGraph'), dbgCtx = dbgCanvas ? dbgCanvas.getContext('2d') : null;
  const gpuName = (() => {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || 'WebGL2';
  })();
  const glCtx = renderer.getContext();
  const timerExt = !CAPTURE ? glCtx.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const gpuQueries = [];
  let gpuMsEma = 0;
  if (dbgEl && !CAPTURE && !BENCH) {
    dbgEl.classList.toggle('on', dbgOn);
    dbgGpuEl.textContent = gpuName;
    dbgEl.addEventListener('click', (e) => e.stopPropagation());
    dbgEl.addEventListener('mousedown', (e) => e.stopPropagation());
    const toggleDefs = [
      ['shadow', 'Shadows'], ['refl', 'Refl'], ['grass', 'Grass'], ['ferns', 'Ferns'],
      ['trees', 'Trees'], ['clouds', 'Clouds'], ['bloom', 'Bloom'], ['ambRead', 'ReadAmb'],
      ['skyLut', 'SkyLUT'], ['msaa', 'MSAA'],
    ];
    const tWrap = $('dbgToggles');
    for (const [key, label] of toggleDefs) {
      const b = document.createElement('span');
      b.className = 'pill' + (dbgState[key] ? '' : ' off');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        dbgState[key] = !dbgState[key];
        b.classList.toggle('off', !dbgState[key]);
        if (key === 'grass') { grass.mesh.visible = dbgState.grass; flowers.mesh.visible = dbgState.grass; }
        if (key === 'ferns') { ferns.mesh.visible = dbgState.ferns; }
        if (key === 'trees') { trees.group.visible = dbgState.trees; }
        if (key === 'clouds') { clouds.mesh.visible = dbgState.clouds; }
        if (key === 'msaa') { post.opts.msaa = dbgState.msaa ? 4 : 0; post.setSize(innerWidth, innerHeight, scale); }
      });
      tWrap.appendChild(b);
    }
    const qWrap = $('dbgQuals');
    for (const qk of ['low', 'medium', 'high', 'ultra']) {
      const b = document.createElement('span');
      b.className = 'pill q' + (qk === qName ? ' cur' : '');
      b.textContent = qk;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        try { localStorage.setItem('stillwater.q', qk); } catch {}
        location.search = '?q=' + qk;
      });
      qWrap.appendChild(b);
    }
  }
  const dbgHist = new Float32Array(68);
  let dbgHistIdx = 0, dbgLastUi = 0, dbgMaxMs = 0, dbgFrameEma = 16.7;
  const pEma = { sky: 0, sim: 0, refl: 0, main: 0, post: 0, reflTris: 0, mainTris: 0, totalCalls: 0, totalTris: 0 };
  renderer.info.autoReset = false;

  // ---------------- capture state application (reusable across shots!) ----------------
  function applyCaptureParams(qp, fastFrames = null) {
    window.__shotReady = false;
    player.enabled = true;
    player.sitting = null;
    player.sitBlend = 0;
    player.vel.set(0, 0, 0);
    player.roll = 0;
    player.pitch = player.pitchT = 0;
    player.placeAtStart();
    mode = 'play';
    fade = 1; fadeTarget = 1;
    headlamp.intensity = 0;
    env.fixedWeather = null;
    env.hours = qp.get('time') ? parseFloat(qp.get('time')) : 15.8;
    if (qp.get('wind')) { env.fixedWeather = true; env.wind = parseFloat(qp.get('wind')); env.cloud = parseFloat(qp.get('cloud') || '0.42'); }
    // let daytime afternoon clouds drift naturally across title (16.2), meadow (16.0) & pasture (16.6) while keeping dawn/dusk/night hero cloud compositions!
    const hDrift = (env.hours >= 10.0 && env.hours <= 18.2) ? (env.hours - 16.2) * 4200 : 0;
    U.uCloudOffset.value.set(hDrift * 0.25, hDrift * 0.16);
    clouds.uniforms.uDrift.value.set(hDrift * 0.84, hDrift * 0.54);

    let d = parseFloat(qp.get('trail') || '-1');
    if (qp.get('trailf')) d = parseFloat(qp.get('trailf')) * trail.dist[trail.dist.length - 1];
    if (d >= 0) {
      const dist = trail.dist;
      let i = dist.findIndex((x) => x >= d); if (i < 0) i = trail.points.length - 1;
      const p = trail.points[i], q2 = trail.points[Math.min(trail.points.length - 1, i + 8)];
      player.pos.set(p[0], 0, p[1]);
      player.yaw = player.yawT = Math.atan2(-(q2[0] - p[0]), -(q2[1] - p[1])) + parseFloat(qp.get('yaw') || '0');
    }
    if (qp.get('pos')) {
      const [x, z] = qp.get('pos').split(',').map(parseFloat);
      player.pos.set(x, 0, z);
      if (qp.get('yaw')) player.yaw = player.yawT = parseFloat(qp.get('yaw'));
    }
    if (qp.get('poi') === 'cottage') {
      const hx = village.house.x, hz = village.house.z;
      const a = Math.atan2(village.house.front[0], village.house.front[1]) + parseFloat(qp.get('ang') || '0.45'), r = parseFloat(qp.get('dist') || '21');
      player.pos.set(hx + Math.sin(a) * r, 0, hz + Math.cos(a) * r);
      player.yaw = player.yawT = Math.atan2(-(hx - player.pos.x), -(hz - player.pos.z)) + parseFloat(qp.get('yaw') || '0');
    }
    if (qp.get('poi') === 'stream' && stream) {
      const sp = streamPlan.points; const i = Math.floor(sp.length * parseFloat(qp.get('sf') || '0.5'));
      const p = sp[i], q = sp[Math.max(0, i - 12)];
      const ox = -(q[1] - p[1]), oz = q[0] - p[0], ol = Math.hypot(ox, oz) || 1;
      player.pos.set(p[0] + ox / ol * 14, 0, p[1] + oz / ol * 14);
      player.yaw = player.yawT = Math.atan2(-(q[0] - player.pos.x), -(q[1] - player.pos.z));
    }
    if (qp.get('poi') === 'forest') {
      const p = trail.points[forestIdx], q = trail.points[Math.min(trail.points.length - 1, forestIdx + 10)];
      player.pos.set(p[0], 0, p[1]);
      player.yaw = player.yawT = Math.atan2(-(q[0] - p[0]), -(q[1] - p[1]));
    }
    if (qp.get('poi') === 'sheep') {
      // center framing cleanly on the first sheep flock with ZERO close-lens clipping & ZERO sheep cut off on the left/right frame edges!
      const flock = village.sheep.list.slice(0, 10);
      let cxS = 0, czS = 0;
      for (const sh of flock) { cxS += sh.x; czS += sh.z; }
      cxS /= flock.length; czS /= flock.length;
      let best = null, bd = -1e9;
      for (let k = 0; k < 48; k++) {
        const a = k / 48 * Math.PI * 2, x = cxS + Math.cos(a) * 12.2, z = czS + Math.sin(a) * 12.2;
        const lookYaw = Math.atan2(-(cxS - x), -(czS - z));
        const fvx = -Math.sin(lookYaw), fvz = -Math.cos(lookYaw);
        let minSheep = 1e9, edgePenalty = 0, inFrame = 0;
        for (const sh of village.sheep.list) {
          const dx = sh.x - x, dz = sh.z - z, dd = Math.hypot(dx, dz);
          minSheep = Math.min(minSheep, dd);
          if (dd < 65) {
            const fwd = dx * fvx + dz * fvz;
            if (fwd > 1.5) {
              const ang = Math.abs(Math.atan2(Math.abs(dx * fvz - dz * fvx), fwd));
              // penalize ANY near or mid-distance sheep sitting on the horizontal frame crop boundary (kills right-edge cut sheep at 1535-1600!)
              if (ang > 0.33 && ang < 0.80) edgePenalty += dd < 28 ? 22 : 14;
              else if (ang <= 0.33 && dd < 30) inFrame++;
            }
          }
        }
        if (minSheep < 5.6) continue;
        let md = 1e9;
        for (const tr of trees.trees) { if (tr.hidden) continue; const distT = Math.hypot(tr.x - x, tr.z - z) - tr.s * 0.25; if (distT < md) md = distT; }
        const scS = Math.min(md, 14) + Math.min(minSheep, 9) * 0.5 + inFrame * 2.2 - edgePenalty;
        if (scS > bd) { bd = scS; best = [x, z, lookYaw]; }
      }
      if (!best) best = [cxS + 12, czS + 12, Math.atan2(12, 12)];
      player.pos.set(best[0], 0, best[1]);
      player.yaw = player.yawT = best[2];
    }
    if (qp.get('poi') === 'fallsStream' && falls && falls.foot) {
      const sp = streamPlan.points, k = Math.min(sp.length - 2, falls.footIdx + parseInt(qp.get('dn') || '16'));
      const [px, pz] = sp[k], [qx, qz] = sp[k + 1];
      const tx = qx - px, tz = qz - pz, tl = Math.hypot(tx, tz) || 1;
      const side = parseFloat(qp.get('side') || '3.2');
      player.pos.set(px - tz / tl * side, 0, pz + tx / tl * side);
      const tgx = (falls.foot.x * 0.6 + falls.top.x * 0.4), tgz = (falls.foot.z * 0.6 + falls.top.z * 0.4), tgy = falls.foot.y * 0.55 + falls.top.y * 0.45;
      player.yaw = player.yawT = Math.atan2(-(tgx - player.pos.x), -(tgz - player.pos.z));
      const ey = hf.height(player.pos.x, player.pos.z) + 1.7;
      player.pitch = player.pitchT = Math.atan2(tgy - ey, Math.hypot(tgx - player.pos.x, tgz - player.pos.z));
    }
    if (qp.get('poi') === 'falls' && falls && falls.foot) {
      const base = Math.atan2(falls.down.x, falls.down.z);
      let best = null, bs = -1e9;
      for (let a = -1.4; a <= 1.4; a += 0.1) for (let r = 14; r <= 26; r += 3) {
        const x = falls.foot.x + Math.sin(base + a) * r, z = falls.foot.z + Math.cos(base + a) * r;
        if (hf.height(x, z) < WORLD.waterLevel + 1 || hf.trailAt(x, z) > 0.5) continue;
        let clear = 1e9;
        for (const tr of trees.trees) { if (tr.hidden) continue; const px = tr.x - x, pz = tr.z - z, vx = falls.foot.x - x, vz = falls.foot.z - z; const L = Math.hypot(vx, vz); const u = Math.max(-6, Math.min(L, (px * vx + pz * vz) / L)); const distT = Math.hypot(px - vx / L * u, pz - vz / L * u) - (tr.bush ? 1.5 : tr.s * 0.35); if (distT < clear) clear = distT; }
        let near = 1e9; for (const tr of trees.trees) { if (tr.hidden) continue; const dd = Math.hypot(tr.x - x, tr.z - z) - (tr.bush ? 1 : tr.s * 0.4); if (dd < near) near = dd; }
        const gy = hf.height(x, z), slopeHere = 1 - hf.normal(x, z, 3).y;
        const scF = Math.min(clear, 8) + Math.min(near, 6) - Math.abs(a) * 1.2 - Math.abs(r - 20) * 0.1 - slopeHere * 25 - Math.max(0, gy - falls.foot.y - 4) * 0.6;
        if (scF > bs) { bs = scF; best = [x, z]; }
      }
      player.pos.set(best[0], 0, best[1]);
      const tgx = (falls.foot.x + falls.top.x) / 2, tgz = (falls.foot.z + falls.top.z) / 2, tgy = (falls.foot.y + falls.top.y) / 2;
      player.yaw = player.yawT = Math.atan2(-(tgx - player.pos.x), -(tgz - player.pos.z));
      const ey = hf.height(player.pos.x, player.pos.z) + 1.7;
      player.pitch = player.pitchT = Math.atan2(tgy - ey, Math.hypot(tgx - player.pos.x, tgz - player.pos.z)) + 0.05;
    }
    if (qp.get('poi') === 'bridge' && stream && stream.bridge) {
      const b = stream.bridge;
      const a = parseFloat(qp.get('ang') || '0.9');
      player.pos.set(b.x + Math.sin(a) * 16, 0, b.z + Math.cos(a) * 16);
      player.yaw = player.yawT = Math.atan2(-(b.x - player.pos.x), -(b.z - player.pos.z));
    }
    if (qp.get('poi') === 'horses') {
      // compose pasture.png cleanly: mossy foreground pasture boulder + rustic corner post on lower-left, 4-5 clear grazing sheep in mid-foreground, painted peaks behind!
      const flock = village.sheep.list.slice(0, 10);
      let cxP = 0, czP = 0;
      for (const sh of flock) { cxP += sh.x; czP += sh.z; }
      cxP /= flock.length; czP /= flock.length;
      const hp = village.sheep.list[3];
      const px0 = cxP - 11.5, pz0 = czP + 8.5;
      player.pos.set(px0, 0, pz0);
      player.yaw = player.yawT = Math.atan2(-(cxP * 0.72 + hp.x * 0.28 - px0), -(czP * 0.72 + hp.z * 0.28 - pz0)) - 0.08;
    }
    if (qp.get('faceMoon')) { env.update(0, 0, null); const m = env.moon; player.yaw = player.yawT = Math.atan2(-m.x, -m.z) + parseFloat(qp.get('yaw') || '0'); }
    if (qp.get('pitch')) player.pitch = player.pitchT = parseFloat(qp.get('pitch'));
    if (qp.get('bench')) { const b = props.benches[parseInt(qp.get('bench'))]; player.pos.set(b.x, 0, b.z); }
    if (qp.get('sit') || qp.get('bench')) {
      player.toggleSit(); player.sitBlend = 1;
      player.pitch = player.pitchT = parseFloat(qp.get('pitch') || '-0.05');
      player.yaw = player.yawT = player.yawT + parseFloat(qp.get('byaw') || '0');
    }
    player.eyeY = hf.height(player.pos.x, player.pos.z) + 1.68;
    env.timeScale = 0;

    // UI overlays reset cleanly per shot
    const titleEl = $('title');
    if (qp.get('title')) {
      mode = 'title';
      titleEl.style.transition = 'none';
      titleEl.style.opacity = 1;
    } else {
      titleEl.style.transition = 'none';
      titleEl.style.opacity = 0;
    }
    $('hud').style.transition = 'none';
    $('hud').style.opacity = qp.get('hud') ? 1 : 0;
    $('toast').style.opacity = 0;
    $('place').style.opacity = 0;
    $('prompt').style.opacity = 0;
    if (qp.get('lamp')) headlamp.intensity = 38;

    const wantFrames = parseInt(qp.get('frames') || '45');
    if (fastFrames != null) {
      // advance deterministic simulation clock to the exact target timestamp, then render `fastFrames` full frames!
      t = Math.max(0, (wantFrames - fastFrames) / 30);
      frameNo = 0;
      targetFrames = fastFrames;
    } else {
      t = 0;
      frameNo = 0;
      targetFrames = wantFrames;
    }
    // immediately force LUT + terrain shadows + trees refresh for new time & camera
    env.update(0, t, amb.sky);
    sky.renderLUT();
    amb = sky.readAmbient();
    shadows.update(true);
    if (mode === 'title') titleCam(t); else player.update(0.001, t);
    trees.update(camera.position, true);
  }

  let benchCtrl = null;
  if (CAPTURE) {
    const fastN = params.get('fast') ? parseInt(params.get('fast')) : null;
    applyCaptureParams(params, fastN);
    $('loading').style.display = 'none';
    window.__applyShot = (queryStr, fast = 4) => {
      applyCaptureParams(new URLSearchParams(queryStr), fast);
    };
  } else if (BENCH) {
    $('loading').style.display = 'none';
    $('title').style.transition = 'none';
    $('title').style.opacity = 0;
    $('title').style.pointerEvents = 'none';
    mode = 'play';
    fade = 1; fadeTarget = 1;
    const { createBench } = await import('./dev/bench.js');
    benchCtrl = createBench({
      params, renderer, glCtx, timerExt, gpuName, qName, Q,
      getScale: () => scale,
      setScale: (s) => { scale = s; post.setSize(innerWidth, innerHeight, scale); },
      getGpuQueueLen: () => gpuQueries.length,
      applyPose: (queryStr) => {
        applyCaptureParams(new URLSearchParams(queryStr), null);
        env.exposure = env.expTarget;
        fade = 1; fadeTarget = 1;
      },
      scene, camera, env, player, trail, hf, sky, shadows, water, terrain,
      trees, grass, flowers, ferns, clouds, rocks, props, village, post,
      dbgState,
    });
  } else {
    ui.showTitle();
    ui.finishLoading();
  }

  // ---------------- frame loop ----------------
  const sunNDC = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let perfAcc = 0, perfN = 0, perfT = 0;
  const shadowCenter = new THREE.Vector3();

  function frame(now) {
    requestAnimationFrame(frame);
    if ((CAPTURE && window.__shotReady) || (benchCtrl && benchCtrl.done)) return;
    const rawMs = Math.max(0.1, now - last);
    let dt = Math.min(0.05, rawMs / 1000);
    last = now;
    if (CAPTURE) dt = 1 / 30;
    if (paused) return;
    t += dt;
    frameNo++;
    perfAcc += dt; perfN++; perfT += dt;
    dbgFrameEma = dbgFrameEma * 0.90 + rawMs * 0.10;
    dbgMaxMs = Math.max(dbgMaxMs, rawMs);
    dbgHist[dbgHistIdx = (dbgHistIdx + 1) % dbgHist.length] = rawMs;

    // poll any completed WebGL2 GPU disjoint timer queries
    const wantGpuTimer = timerExt && (dbgOn || BENCH);
    if (wantGpuTimer) {
      while (gpuQueries.length) {
        const q = gpuQueries[0];
        if (!glCtx.getQueryParameter(q, glCtx.QUERY_RESULT_AVAILABLE)) break;
        const disjoint = glCtx.getParameter(timerExt.GPU_DISJOINT_EXT);
        const ns = glCtx.getQueryParameter(q, glCtx.QUERY_RESULT);
        glCtx.deleteQuery(q);
        gpuQueries.shift();
        if (!disjoint && ns > 0) {
          const ms = ns / 1e6;
          gpuMsEma = gpuMsEma ? gpuMsEma * 0.85 + ms * 0.15 : ms;
          benchCtrl?.onGpuSample(ms, false);
        } else if (disjoint) {
          benchCtrl?.onGpuSample(null, true);
        }
      }
    }
    let gpuQ = null;
    if (wantGpuTimer && gpuQueries.length < 4) {
      gpuQ = glCtx.createQuery();
      glCtx.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQ);
    }

    const keysT = player.keys.has('KeyT');
    const sitBoost = player.sitting ? (player.sitting.bench ? 220 : 60) : 0;
    const target = keysT ? 900 : sitBoost;
    timeBoost += (target - timeBoost) * (1 - Math.exp(-dt * (target > timeBoost ? 0.6 : 2.5)));
    if (!CAPTURE && !BENCH) env.timeScale = 6 + timeBoost;

    if (mode === 'title' || mode === 'transition') {
      if (fade < 0.05 && mode === 'transition') player.update(dt, t); else titleCam(t);
    } else {
      player.update(dt, t);
    }
    if (mode === 'transition' && fadeTarget === 0 && fade < 0.02) { player.placeAtStart(); player.update(0.016, t); }

    const t0Sky = performance.now();
    U.uTime.value = t;
    env.update(dt, t, amb.sky);
    if ((dbgState.ambRead && frameNo % 12 === 0) || CAPTURE) amb = sky.readAmbient();
    sky.skyUniforms.uStarRot.value = (env.hours / 24) * Math.PI * 2;
    sky.lutMat.uniforms.uMoonI.value = 0.05 * env.night;
    sky.moonDir.value.copy(env.moon);
    renderer.info.reset();
    if (dbgState.skyLut || CAPTURE) sky.renderLUT();
    const skyLutCalls = renderer.info.render.calls, skyLutTris = renderer.info.render.triangles;
    renderer.info.reset();
    shadows.update(CAPTURE && frameNo < 3);
    const terrainShadowCalls = renderer.info.render.calls, terrainShadowTris = renderer.info.render.triangles;
    const t0Sim = performance.now();

    const groundY = hf.height(camera.position.x, camera.position.z);
    terrain.update(camera, groundY);
    trees.update(camera.position);
    grass.update(camera.position, player.pos);
    flowers.update(camera.position);
    birds.update(t, dt, env.day + env.golden);
    clouds.update(dt, env.wind);
    ferns.update(camera.position);
    shafts.update(U, t, env.day);
    butterflies.update(camera.position, env.day * (1 - env.golden) * (1 - env.dusk) * (1 - env.night));
    village.update(dt, t, U);
    village.smokeMat.uniforms.uPix.value = renderer.domElement.height * scale;
    village.smokeMat.uniforms.uAmb.value.copy(amb.sky).multiplyScalar(1.4);
    if (village.haloMat) village.haloMat.uniforms.uPix.value = renderer.domElement.height * scale;
    if (audio.started && Math.random() < dt * 0.12) {
      const d = village.sheep.nearest(camera.position);
      if (d < 60) audio.bleat(Math.max(0.05, 1 - d / 60));
    }
    motes.update(camera.position, renderer.domElement.height * scale);
    fireflies.update(camera.position, renderer.domElement.height * scale);
    if (stream) stream.sprayMat.uniforms.uPix.value = renderer.domElement.height * scale;
    if (falls && falls.mistMat) falls.mistMat.uniforms.uPix.value = renderer.domElement.height * scale;
    const rip = water.update(dt, t, camera.position);
    if (rip && audio.started) {
      const d = Math.hypot(rip.x - camera.position.x, rip.y - camera.position.z);
      if (d < 90) audio.splash(Math.max(0.05, 1 - d / 90) * 0.5);
    }

    // lights
    sunLight.color.copy(env.lightCol);
    sunLight.intensity = 1;
    const L = U.uLightDir.value;
    camera.getWorldDirection(camDir);
    shadowCenter.copy(camera.position).addScaledVector(camDir.setY(0).normalize(), 50);
    const texel = 190 / Q.shadow;
    shadowCenter.x = Math.round(shadowCenter.x / texel) * texel;
    shadowCenter.z = Math.round(shadowCenter.z / texel) * texel;
    sunLight.target.position.copy(shadowCenter);
    sunLight.position.copy(shadowCenter).addScaledVector(L, 600);
    sunLight.castShadow = L.y > 0.01 && dbgState.shadow;
    {
      const s = amb.sky;
      const l = s.r * 0.2126 + s.g * 0.7152 + s.b * 0.0722;
      hemi.color.setRGB(l + (s.r - l) * 0.78, l + (s.g - l) * 0.78, l + (s.b - l) * 0.78).multiplyScalar(1.06);
      const gk = Math.max(env.golden, env.dusk * 0.75);
      const lowTint = env.dawn > 0.2
        ? new THREE.Color(l * 1.12, l * 0.94, l * 1.18)
        : new THREE.Color(l * 0.92, l * 0.85, l * 1.36);
      hemi.color.lerp(lowTint, gk * 0.58).multiplyScalar(1 + gk * 0.34);
    }
    U.uHorizonCol.value.copy(amb.horizon);
    hemi.groundColor.setRGB(
      amb.sky.r * 0.26 + env.lightCol.r * Math.max(L.y, 0) * 0.045,
      amb.sky.g * 0.26 + env.lightCol.g * Math.max(L.y, 0) * 0.046,
      amb.sky.b * 0.18 + env.lightCol.b * Math.max(L.y, 0) * 0.025
    );
    const t0Refl = performance.now();

    // reflections
    renderer.info.reset();
    const lakeD = Math.hypot(camera.position.x - WORLD.lake.x, camera.position.z - WORLD.lake.z);
    if (lakeD < 3500 && dbgState.refl && (frameNo % (Q.reflEvery || 1) === 0 || CAPTURE)) water.renderReflection(renderer, scene, camera, terrain);
    else water.uniforms.uHasRefl.value = 0;
    const reflCalls = renderer.info.render.calls, reflTris = renderer.info.render.triangles;
    const t0Main = performance.now();

    renderer.info.reset();
    renderer.setRenderTarget(post.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);
    const mainCalls = renderer.info.render.calls, mainTris = renderer.info.render.triangles;
    const t0Post = performance.now();

    // sun on screen
    camera.getWorldDirection(camDir);
    tmpV.copy(camera.position).addScaledVector(U.uSunDir.value, 10000);
    sunNDC.copy(tmpV).project(camera);
    const facing = camDir.dot(U.uSunDir.value);
    const onScreen = facing > 0 && Math.abs(sunNDC.x) < 1.3 && Math.abs(sunNDC.y) < 1.3;
    const sunUp = THREE.MathUtils.smoothstep(U.uSunDir.value.y, -0.03, 0.04);
    const sunVis = onScreen ? sunUp * THREE.MathUtils.smoothstep(facing, 0.3, 0.8) : 0;
    const rays = sunVis * (0.08 + env.golden * 0.14) * (Q.godrays ? 1 : 0);
    if (CAPTURE) env.exposure = env.expTarget;
    fade += (fadeTarget - fade) * (1 - Math.exp(-dt * (fadeTarget > fade ? 0.9 : 2.2)));
    renderer.info.reset();
    post.render({
      exposure: env.exposure,
      bloom: 0.055,
      bloomThreshold: 0.95,
      rays,
      skipBloom: !dbgState.bloom,
      rayColor: env.sunCol,
      sunUV: new THREE.Vector2(sunNDC.x * 0.5 + 0.5, sunNDC.y * 0.5 + 0.5),
      sunVis,
      time: t,
      fade,
      wb: env.grade.wb, lift: env.grade.lift, gain: env.grade.gain, sat: env.grade.sat, contrast: env.grade.contrast,
      letterbox: 0,
      shadowTint: env.grade.shadowTint,
      golden: Math.max(env.golden, env.dusk * 0.6),
      dawn: env.dawn,
    });
    const postCalls = renderer.info.render.calls, postTris = renderer.info.render.triangles;
    const t1End = performance.now();
    if (gpuQ) { glCtx.endQuery(timerExt.TIME_ELAPSED_EXT); gpuQueries.push(gpuQ); }
    pEma.sky = pEma.sky * 0.85 + (t0Sim - t0Sky) * 0.15;
    pEma.sim = pEma.sim * 0.85 + (t0Refl - t0Sim) * 0.15;
    pEma.refl = pEma.refl * 0.85 + (t0Main - t0Refl) * 0.15;
    pEma.main = pEma.main * 0.85 + (t0Post - t0Main) * 0.15;
    pEma.post = pEma.post * 0.85 + (t1End - t0Post) * 0.15;
    pEma.reflTris = reflTris; pEma.mainTris = mainTris;
    pEma.totalCalls = reflCalls + mainCalls + postCalls;
    pEma.totalTris = reflTris + mainTris + postTris;
    if (benchCtrl) {
      benchCtrl.onFrame({
        now,
        rawMs,
        dt,
        cpuMs: {
          sky: t0Sim - t0Sky,
          sim: t0Refl - t0Sim,
          refl: t0Main - t0Refl,
          main: t0Post - t0Main,
          post: t1End - t0Post,
          total: t1End - t0Sky,
        },
        passes: {
          skyLut: { calls: skyLutCalls, tris: skyLutTris },
          terrainShadow: { calls: terrainShadowCalls, tris: terrainShadowTris },
          reflection: { calls: reflCalls, tris: reflTris },
          main: { calls: mainCalls, tris: mainTris },
          post: { calls: postCalls, tris: postTris },
        },
      });
    }

    if (dbgOn && dbgEl && now - dbgLastUi > 220) {
      dbgLastUi = now;
      const fps = Math.round(1000 / Math.max(dbgFrameEma, 0.1));
      dbgFpsEl.textContent = `${fps} fps`;
      dbgFpsEl.className = 'fps ' + (fps >= 48 ? 'good' : fps >= 26 ? 'mid' : 'bad');
      dbgMsEl.textContent = `${dbgFrameEma.toFixed(1)}ms (max ${dbgMaxMs.toFixed(0)}ms)`;
      dbgMaxMs = 0;
      const fmtT = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
      const tHi = trees.hi.reduce((a, m) => a + m.count, 0);
      const tLo = trees.lo.reduce((a, m) => a + m.count, 0);
      const gpuRow = timerExt ? `<div class="row"><span>GPU time</span><b>${gpuMsEma.toFixed(1)} ms</b></div>` : '';
      const memRow = performance.memory ? `<div class="row"><span>JS Heap</span><b>${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB</b></div>` : '';
      dbgBodyEl.innerHTML =
        `<div class="row"><span>Target</span><b>${post.sw}×${post.sh} (${Math.round(scale * 100)}%) · ${post.opts.msaa || 0}×MSAA</b></div>` +
        `<div class="row"><span>Preset / DPR</span><b>${qName} · dpr ${devicePixelRatio.toFixed(1)} · ${innerWidth}×${innerHeight}</b></div>` +
        `<div class="row"><span>Draws / Tris</span><b>${pEma.totalCalls} calls · ${fmtT(pEma.totalTris)} tris</b></div>` +
        `<div class="row"><span>Tris (Refl/Main)</span><b>${fmtT(pEma.reflTris)} / ${fmtT(pEma.mainTris)}</b></div>` +
        `<div class="sec">` +
        gpuRow +
        `<div class="row"><span>CPU sky+amb / sim</span><b>${pEma.sky.toFixed(1)} / ${pEma.sim.toFixed(1)} ms</b></div>` +
        `<div class="row"><span>CPU refl / main / post</span><b>${pEma.refl.toFixed(1)} / ${pEma.main.toFixed(1)} / ${pEma.post.toFixed(1)} ms</b></div>` +
        memRow +
        `</div><div class="sec">` +
        `<div class="row"><span>Terrain / Trees</span><b>${terrain.geometry.instanceCount} nodes · ${tHi}/${tLo}/${trees.bb.count}</b></div>` +
        `<div class="row"><span>Grass / Ferns</span><b>${fmtT(Q.grass)} / ${fmtT(ferns.mesh.geometry.instanceCount)}</b></div>` +
        `<div class="row"><span>Pos / Geo·Tex</span><b>${Math.round(camera.position.x)},${Math.round(camera.position.y)},${Math.round(camera.position.z)} · ${renderer.info.memory.geometries}g/${renderer.info.memory.textures}t</b></div>` +
        `</div>`;
      if (dbgCtx) {
        const W = dbgCanvas.width, H = dbgCanvas.height;
        dbgCtx.clearRect(0, 0, W, H);
        // 16.7ms (60fps) and 33.3ms (30fps) reference lines
        dbgCtx.fillStyle = 'rgba(110,231,183,0.22)'; dbgCtx.fillRect(0, H - (16.7 / 66) * H, W, 1);
        dbgCtx.fillStyle = 'rgba(252,211,77,0.22)';  dbgCtx.fillRect(0, H - (33.3 / 66) * H, W, 1);
        const bw = W / dbgHist.length;
        for (let i = 0; i < dbgHist.length; i++) {
          const v = dbgHist[(dbgHistIdx + 1 + i) % dbgHist.length];
          const bh = Math.min(H, (v / 66) * H);
          dbgCtx.fillStyle = v <= 20 ? '#6ee7b7' : v <= 36 ? '#fcd34d' : '#fca5a5';
          dbgCtx.fillRect(i * bw, H - bh, Math.max(1, bw - 1), bh);
        }
      }
    }

    // audio
    const lakeDist = Math.max(0, Math.hypot((camera.position.x - WORLD.lake.x) / WORLD.lake.rx, (camera.position.z - WORLD.lake.z) / WORLD.lake.rz) - 1) * WORLD.lake.rx;
    audio.update(dt, {
      wind: env.wind, altitude: groundY, lake: Math.max(0, 1 - lakeDist / 120), day: env.day, dusk: env.dusk, night: env.night,
      moving: player.moving, sitting: player.sitting ? 1 : 0, forest: biome.sampleForest(camera.position.x, camera.position.z),
      swell: ui.swell,
      stream: stream ? Math.max(0, 1 - stream.distanceTo(camera.position) / 70) : 0,
    }, camera);

    // UI
    if (mode === 'play') {
      ui.update(dt, {
        yaw: player.yaw, altitude: groundY, hours: env.hours, distance: player.distance, climb: player.climb,
        pois: props.pois, pos: player.pos, bench: !player.sitting && player.nearestBench(), sitting: !!player.sitting,
      });
      for (const p of props.pois) {
        if (visited.has(p.name)) continue;
        if (Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < p.r) { visited.add(p.name); if ((!CAPTURE && !BENCH) || params.get('hud')) ui.place(p.name, p.sub); }
      }
    }

    // dynamic resolution
    if (perfT > 1.5 && !CAPTURE && !BENCH) {
      const avg = perfAcc / perfN;
      ui.perf(`${Math.round(1 / avg)} fps · ${qName} · ${Math.round(scale * 100)}%`);
      if (avg > 1 / 27 && scale > 0.55) { scale = Math.max(0.55, scale - 0.05); post.setSize(innerWidth, innerHeight, scale); }
      else if (avg < 1 / 45 && scale < Q.scale) { scale = Math.min(Q.scale, scale + 0.05); post.setSize(innerWidth, innerHeight, scale); }
      perfAcc = 0; perfN = 0; perfT = 0;
    }
    if (CAPTURE && frameNo === targetFrames) {
      window.__shotReady = true;
      window.__info = { trailLength: trail.dist[trail.dist.length - 1], summit: props.summit, trees: trees.trees.length, rocks: rocks.items.length, nodes: terrain.geometry.instanceCount, hours: env.hours, exposure: env.exposure };
    }
  }
  requestAnimationFrame(frame);
  window.__game = { env, player, trail, hf, camera, U, sky, renderer, post, terrain, scene, water, trees, grass, streamPlan, village, stream };
}

main().catch((e) => {
  console.error(e);
  const m = document.getElementById('loadmsg');
  if (m) m.textContent = 'Something went wrong: ' + e.message;
  window.__error = String(e && e.stack || e);
});
