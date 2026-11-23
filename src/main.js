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
  const rocks = new Rocks(hf, trail.points, streamPlan ? streamPlan.points : null);
  scene.add(rocks.group);
  const props = new Props(hf, trail);
  scene.add(props.group);
  const shore = new Shore(hf, [...(props.jettyZone || []), ...(props.shoreBench ? [props.shoreBench] : [])]);
  scene.add(shore.group);
  console.log("shore", JSON.stringify(shore.count));
  const village = new Village(hf, trail, props, trees, rocks, biome);
  for (const b of props.benches) {
    const fx = Math.sin(b.ry), fz = Math.cos(b.ry);
    for (let d = 6; d <= 70; d += 6) trees.clearArea(b.x + fx * d, b.z + fz * d, 4 + d * 0.28);
  }
  scene.add(village.group);
  const ferns = new Ferns(qName === 'low' ? 1800 : 9000, qName === 'low' ? 22 : 42);
  scene.add(ferns.mesh);
  const logs = buildLogs(hf, biome, trail, village.mat);
  if (logs) scene.add(logs);
  const stream = streamPlan ? new Stream(hf, streamPlan) : null;
  if (stream) scene.add(stream.group);
  const falls = stream ? new Waterfall(hf, streamPlan) : null;
  if (falls) scene.add(falls.group);
  if (falls && falls.foot) trees.clearArea(falls.foot.x, falls.foot.z, 16);
  // keep the view up the stream to the falls open (no trees standing in the water's line)
  if (falls && falls.foot && streamPlan) {
    const sp = streamPlan.points;
    for (let k = falls.footIdx; k < Math.min(sp.length, falls.footIdx + 26); k++) trees.clearArea(sp[k][0], sp[k][1], 5.5 + (k - falls.footIdx) * 0.12);
    // the classic view from the right bank, 18 points downstream
    const kc = Math.min(sp.length - 2, falls.footIdx + 18), [px, pz] = sp[kc], [qx, qz] = sp[kc + 1];
    const tl = Math.hypot(qx - px, qz - pz) || 1, cx = px - (qz - pz) / tl * 5, cz = pz + (qx - px) / tl * 5;
    const tgx = falls.foot.x * 0.6 + falls.top.x * 0.4, tgz = falls.foot.z * 0.6 + falls.top.z * 0.4;
    for (let f = 0.1; f <= 1.0; f += 0.06) trees.clearArea(cx + (tgx - cx) * f, cz + (tgz - cz) * f, 3.5 + f * 6);
    trees.clearArea(falls.top.x, falls.top.z, 12);
  }
  const bridge = stream ? stream.buildBridge(trail, village.mat) : null;
  if (bridge) scene.add(bridge);
  const shafts = new LightShafts(hf, biome, trail, qName === 'low' ? 24 : 70);
  scene.add(shafts.mesh);
  const butterflies = new Butterflies(qName === 'low' ? 30 : 70);
  scene.add(butterflies.mesh);
  const grass = new Grass(Q.grass, Q.grassRadius);
  scene.add(grass.mesh);
  const flowers = new Flowers(Math.round(Q.grass / 10), Math.min(34, Q.grassRadius * 0.75));
  scene.add(flowers.mesh);
  const clouds = new Clouds(qName === 'low' ? 12 : 22, qName === 'low' ? 1 : qName === 'medium' ? 2 : 3);
  scene.add(clouds.mesh);
  const birds = new Birds();
  scene.add(birds.mesh);
  const motes = new Particles(qName === 'low' ? 1200 : 2600, 36, 0);
  const fireflies = new Particles(qName === 'low' ? 250 : 500, 80, 1);
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
  if (OFF.has('fly')) butterflies.mesh.visible = false;
  if (OFF.has('mist') && falls && falls.mist) falls.mist.visible = false;
  // lights
  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(Q.shadow, Q.shadow);
  const sc = sunLight.shadow.camera;
  sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 1; sc.far = 1200;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.06;
  sunLight.shadow.radius = 3;
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
  if (params.get('time')) env.hours = parseFloat(params.get('time'));
  if (params.get('wind')) { env.fixedWeather = true; env.wind = parseFloat(params.get('wind')); env.cloud = parseFloat(params.get('cloud') || '0.42'); }
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
  let paused = false;

  const titleCam = (tt) => {
    // slow drone drift across the lake toward the peak
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
    if (mode === 'play' && !CAPTURE) canvas.requestPointerLock?.();
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
    paused = !player.locked && mode === 'play' && !CAPTURE;
    ui.paused(paused);
    if (audio.ctx) { if (paused) audio.ctx.suspend(); else audio.ctx.resume(); }
  });
  addEventListener('keydown', (e) => {
    if (mode !== 'play') return;
    if (e.code === 'KeyF') { headlamp.intensity = headlamp.intensity > 0 ? 0 : 38; ui.toast(headlamp.intensity ? 'Headlamp on' : 'Headlamp off'); }
    if (e.code === 'KeyH') { hudOn = !hudOn; document.body.classList.toggle('photo', !hudOn); }
    if (e.code === 'KeyM') { audio.setMusic(!audio.musicOn); ui.toast(audio.musicOn ? 'Music on' : 'Music off'); }
    if (e.code === 'BracketRight') { env.hours = (env.hours + 0.5) % 24; ui.toast(ui.clock(env.hours)); }
    if (e.code === 'BracketLeft') { env.hours = (env.hours + 23.5) % 24; ui.toast(ui.clock(env.hours)); }
  });

  // ---------------- capture mode ----------------
  if (CAPTURE) {
    player.enabled = true;
    let d = parseFloat(params.get('trail') || '-1');
    if (params.get('trailf')) d = parseFloat(params.get('trailf')) * trail.dist[trail.dist.length - 1];
    if (d >= 0) {
      const dist = trail.dist;
      let i = dist.findIndex((x) => x >= d); if (i < 0) i = trail.points.length - 1;
      const p = trail.points[i], q2 = trail.points[Math.min(trail.points.length - 1, i + 8)];
      player.pos.set(p[0], 0, p[1]);
      player.yaw = player.yawT = Math.atan2(-(q2[0] - p[0]), -(q2[1] - p[1])) + parseFloat(params.get('yaw') || '0');
    }
    if (params.get('pos')) {
      const [x, z] = params.get('pos').split(',').map(parseFloat);
      player.pos.set(x, 0, z);
      if (params.get('yaw')) player.yaw = player.yawT = parseFloat(params.get('yaw'));
    }
    if (params.get('poi') === 'cottage') {
      const hx = village.house.x, hz = village.house.z;
      const a = Math.atan2(village.house.front[0], village.house.front[1]) + parseFloat(params.get('ang') || '0.45'), r = parseFloat(params.get('dist') || '21');
      player.pos.set(hx + Math.sin(a) * r, 0, hz + Math.cos(a) * r);
      player.yaw = player.yawT = Math.atan2(-(hx - player.pos.x), -(hz - player.pos.z)) + parseFloat(params.get('yaw') || '0');
    }
    if (params.get('poi') === 'stream' && stream) {
      const sp = streamPlan.points; const i = Math.floor(sp.length * parseFloat(params.get('sf') || '0.5'));
      const p = sp[i], q = sp[Math.max(0, i - 12)];
      const ox = -(q[1] - p[1]), oz = q[0] - p[0], ol = Math.hypot(ox, oz) || 1;
      player.pos.set(p[0] + ox / ol * 14, 0, p[1] + oz / ol * 14);
      player.yaw = player.yawT = Math.atan2(-(q[0] - player.pos.x), -(q[1] - player.pos.z));
    }
    if (params.get('poi') === 'forest') {
      let bi = 0, bf = -1;
      trail.points.forEach((p, i) => {
        const f = biome.sampleForest(p[0], p[1]) + biome.sampleForest(p[0] + 15, p[1]) + biome.sampleForest(p[0] - 15, p[1]);
        if (f < 1.2) return;
        let near = 1e9; for (const t of trees.trees) { if (t.bush) continue; const d = Math.hypot(t.x - p[0], t.z - p[1]); if (d < near) near = d; }
        const sc = f + Math.min(near, 7) * 0.4;
        if (sc > bf) { bf = sc; bi = i; }
      });
      const p = trail.points[bi], q = trail.points[Math.min(trail.points.length - 1, bi + 10)];
      player.pos.set(p[0], 0, p[1]);
      player.yaw = player.yawT = Math.atan2(-(q[0] - p[0]), -(q[1] - p[1]));
    }
    if (params.get('poi') === 'sheep') {
      const sp = village.sheep.list[0];
      let best = null, bd = -1;
      for (let k = 0; k < 24; k++) {
        const a = k / 24 * Math.PI * 2, x = sp.x + Math.cos(a) * 8, z = sp.z + Math.sin(a) * 8;
        let md = 1e9;
        for (const t of trees.trees) { if (t.hidden) continue; const d = Math.hypot(t.x - x, t.z - z) - t.s * 0.25; if (d < md) md = d; }
        if (md > bd) { bd = md; best = [x, z]; }
      }
      player.pos.set(best[0], 0, best[1]);
      player.yaw = player.yawT = Math.atan2(-(sp.x - player.pos.x), -(sp.z - player.pos.z));
    }
    if (params.get('poi') === 'fallsStream' && falls && falls.foot) {
      const sp = streamPlan.points, k = Math.min(sp.length - 2, falls.footIdx + parseInt(params.get('dn') || '16'));
      const [px, pz] = sp[k], [qx, qz] = sp[k + 1];
      const tx = qx - px, tz = qz - pz, tl = Math.hypot(tx, tz) || 1;
      const side = parseFloat(params.get('side') || '3.2');
      player.pos.set(px - tz / tl * side, 0, pz + tx / tl * side);
      const tgx = (falls.foot.x * 0.6 + falls.top.x * 0.4), tgz = (falls.foot.z * 0.6 + falls.top.z * 0.4), tgy = falls.foot.y * 0.55 + falls.top.y * 0.45;
      player.yaw = player.yawT = Math.atan2(-(tgx - player.pos.x), -(tgz - player.pos.z));
      const ey = hf.height(player.pos.x, player.pos.z) + 1.7;
      player.pitch = player.pitchT = Math.atan2(tgy - ey, Math.hypot(tgx - player.pos.x, tgz - player.pos.z));
    }
    if (params.get('poi') === 'falls' && falls && falls.foot) {
      const base = Math.atan2(falls.down.x, falls.down.z);
      let best = null, bs = -1e9;
      for (let a = -1.4; a <= 1.4; a += 0.1) for (let r = 14; r <= 26; r += 3) {
        const x = falls.foot.x + Math.sin(base + a) * r, z = falls.foot.z + Math.cos(base + a) * r;
        if (hf.height(x, z) < WORLD.waterLevel + 1 || hf.trailAt(x, z) > 0.5) continue;
        let clear = 1e9;
        for (const t of trees.trees) { if (t.hidden) continue; const px = t.x - x, pz = t.z - z, vx = falls.foot.x - x, vz = falls.foot.z - z; const L = Math.hypot(vx, vz); const u = Math.max(-6, Math.min(L, (px * vx + pz * vz) / L)); const d = Math.hypot(px - vx / L * u, pz - vz / L * u) - (t.bush ? 1.5 : t.s * 0.35); if (d < clear) clear = d; }
        let near = 1e9; for (const t of trees.trees) { if (t.hidden) continue; const dd = Math.hypot(t.x - x, t.z - z) - (t.bush ? 1 : t.s * 0.4); if (dd < near) near = dd; }
        const gy = hf.height(x, z), slopeHere = 1 - hf.normal(x, z, 3).y;
        const sc = Math.min(clear, 8) + Math.min(near, 6) - Math.abs(a) * 1.2 - Math.abs(r - 20) * 0.1 - slopeHere * 25 - Math.max(0, gy - falls.foot.y - 4) * 0.6;
        if (sc > bs) { bs = sc; best = [x, z]; }
      }
      player.pos.set(best[0], 0, best[1]);
      const tgx = (falls.foot.x + falls.top.x) / 2, tgz = (falls.foot.z + falls.top.z) / 2, tgy = (falls.foot.y + falls.top.y) / 2;
      player.yaw = player.yawT = Math.atan2(-(tgx - player.pos.x), -(tgz - player.pos.z));
      const ey = hf.height(player.pos.x, player.pos.z) + 1.7;
      player.pitch = player.pitchT = Math.atan2(tgy - ey, Math.hypot(tgx - player.pos.x, tgz - player.pos.z)) + 0.05;
    }
    if (params.get('poi') === 'bridge' && stream && stream.bridge) {
      const b = stream.bridge;
      const a = parseFloat(params.get('ang') || '0.9');
      player.pos.set(b.x + Math.sin(a) * 16, 0, b.z + Math.cos(a) * 16);
      player.yaw = player.yawT = Math.atan2(-(b.x - player.pos.x), -(b.z - player.pos.z));
    }
    if (params.get('poi') === 'horses') {
      const hp = village.sheep.list[3];
      player.pos.set(hp.x + 5, 0, hp.z + 6);
      player.yaw = player.yawT = Math.atan2(-(hp.x - player.pos.x), -(hp.z - player.pos.z));
    }
    if (params.get('faceMoon')) { env.update(0, 0, null); const m = env.moon; player.yaw = player.yawT = Math.atan2(-m.x, -m.z) + parseFloat(params.get('yaw') || '0'); }
    if (params.get('pitch')) player.pitch = player.pitchT = parseFloat(params.get('pitch'));
    if (params.get('bench')) { const b = props.benches[parseInt(params.get('bench'))]; player.pos.set(b.x, 0, b.z); }
    if (params.get('sit') || params.get('bench')) { player.toggleSit(); player.sitBlend = 1; player.yaw = player.yawT; player.pitch = player.pitchT = parseFloat(params.get('pitch') || '-0.05'); player.yaw = player.yawT = player.yawT + parseFloat(params.get('byaw') || '0'); }
    player.eyeY = hf.height(player.pos.x, player.pos.z) + 1.68;
    env.timeScale = 0;
    if (params.get('hud')) ui.showHud(true);
    if (params.get('title')) { mode = 'title'; ui.showTitle(); }
    if (params.get('lamp')) headlamp.intensity = 38;
  } else {
    ui.showTitle();
  }
  ui.finishLoading();

  // ---------------- frame loop ----------------
  const sunNDC = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let perfAcc = 0, perfN = 0, perfT = 0;
  const shadowCenter = new THREE.Vector3();

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (CAPTURE) dt = 1 / 30;
    if (paused) return;
    t += dt;
    frameNo++;
    perfAcc += dt; perfN++; perfT += dt;

    // time flow: hold T, or rest on a bench
    const keysT = player.keys.has('KeyT');
    const sitBoost = player.sitting ? (player.sitting.bench ? 220 : 60) : 0;
    const target = keysT ? 900 : sitBoost;
    timeBoost += (target - timeBoost) * (1 - Math.exp(-dt * (target > timeBoost ? 0.6 : 2.5)));
    if (!CAPTURE) env.timeScale = 6 + timeBoost;

    if (mode === 'title' || mode === 'transition') {
      if (fade < 0.05 && mode === 'transition') player.update(dt, t); else titleCam(t);
    } else {
      player.update(dt, t);
    }
    if (mode === 'transition' && fadeTarget === 0 && fade < 0.02) { player.placeAtStart(); player.update(0.016, t); }

    U.uTime.value = t;
    env.update(dt, t, amb.sky);
    if (frameNo % 12 === 0 || CAPTURE) amb = sky.readAmbient();
    sky.skyUniforms.uStarRot.value = (env.hours / 24) * Math.PI * 2;
    sky.lutMat.uniforms.uMoonI.value = 0.05 * env.night;
    sky.moonDir.value.copy(env.moon);
    sky.renderLUT();
    shadows.update(CAPTURE && frameNo < 3);

    const groundY = hf.height(camera.position.x, camera.position.z);
    terrain.update(camera, groundY);
    trees.update(camera.position);
    grass.update(camera.position, player.pos);
    flowers.update(camera.position);
    birds.update(t, dt, env.day + env.golden);
    clouds.update(dt, env.wind);
    ferns.update(camera.position);
    shafts.update(U, t, env.day);
    butterflies.update(camera.position, env.day * (1 - env.night));
    village.update(dt, t, U);
    village.smokeMat.uniforms.uPix.value = renderer.domElement.height * scale;
    village.smokeMat.uniforms.uAmb.value.copy(amb.sky).multiplyScalar(1.4);
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
    sunLight.castShadow = L.y > 0.01 && !OFF.has('shadow');
    { const s = amb.sky; const l = s.r * 0.2126 + s.g * 0.7152 + s.b * 0.0722; hemi.color.setRGB(l + (s.r - l) * 0.75, l + (s.g - l) * 0.75, l + (s.b - l) * 0.75).multiplyScalar(1.05);
      const gk = Math.max(env.golden, env.dusk * 0.7);
      hemi.color.lerp(new THREE.Color(l * 0.85, l * 0.88, l * 1.35), gk * 0.6).multiplyScalar(1 + gk * 0.35); }
    U.uHorizonCol.value.copy(amb.horizon);
    hemi.groundColor.setRGB(
      amb.sky.r * 0.18 + env.lightCol.r * Math.max(L.y, 0) * 0.03,
      amb.sky.g * 0.22 + env.lightCol.g * Math.max(L.y, 0) * 0.035,
      amb.sky.b * 0.14 + env.lightCol.b * Math.max(L.y, 0) * 0.02
    );

    // reflections (only when the lake could be in view)
    const lakeD = Math.hypot(camera.position.x - WORLD.lake.x, camera.position.z - WORLD.lake.z);
    if (lakeD < 3500 && !params.has('norefl') && !OFF.has('refl') && Q.reflEvery !== 0 && (frameNo % (Q.reflEvery || 1) === 0 || CAPTURE)) water.renderReflection(renderer, scene, camera, terrain);
    else if (Q.reflEvery === 0) water.uniforms.uHasRefl.value = 0;
    else water.uniforms.uHasRefl.value = 0;

    renderer.setRenderTarget(post.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

    // sun on screen
    camera.getWorldDirection(camDir);
    tmpV.copy(camera.position).addScaledVector(U.uSunDir.value, 10000);
    sunNDC.copy(tmpV).project(camera);
    const facing = camDir.dot(U.uSunDir.value);
    const onScreen = facing > 0 && Math.abs(sunNDC.x) < 1.3 && Math.abs(sunNDC.y) < 1.3;
    const sunUp = THREE.MathUtils.smoothstep(U.uSunDir.value.y, -0.03, 0.04);
    const sunVis = onScreen ? sunUp * THREE.MathUtils.smoothstep(facing, 0.3, 0.8) : 0;
    const rays = sunVis * (0.1 + env.golden * 0.18) * (Q.godrays ? 1 : 0);
    if (CAPTURE) env.exposure = env.expTarget;
    fade += (fadeTarget - fade) * (1 - Math.exp(-dt * (fadeTarget > fade ? 0.9 : 2.2)));
    post.render({
      exposure: env.exposure,
      bloom: 0.07,
      bloomThreshold: 0.85,
      rays,
      rayColor: env.sunCol,
      sunUV: new THREE.Vector2(sunNDC.x * 0.5 + 0.5, sunNDC.y * 0.5 + 0.5),
      sunVis,
      time: t,
      fade: fade,
      wb: env.grade.wb, lift: env.grade.lift, gain: env.grade.gain, sat: env.grade.sat, contrast: env.grade.contrast,
      letterbox: player.sitBlend * 0.07,
      shadowTint: env.grade.shadowTint,
      golden: Math.max(env.golden, env.dusk * 0.6),
    });

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
        if (Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < p.r) { visited.add(p.name); if (!CAPTURE || params.get('hud')) ui.place(p.name, p.sub); }
      }
    }

    // dynamic resolution
    if (perfT > 1.5 && !CAPTURE) {
      const avg = perfAcc / perfN;
      ui.perf(`${Math.round(1 / avg)} fps · ${qName} · ${Math.round(scale * 100)}%`);
      if (avg > 1 / 27 && scale > 0.55) { scale = Math.max(0.55, scale - 0.05); post.setSize(innerWidth, innerHeight, scale); }
      else if (avg < 1 / 45 && scale < Q.scale) { scale = Math.min(Q.scale, scale + 0.05); post.setSize(innerWidth, innerHeight, scale); }
      perfAcc = 0; perfN = 0; perfT = 0;
    }
    if (CAPTURE && frameNo === parseInt(params.get('frames') || '45')) {
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
