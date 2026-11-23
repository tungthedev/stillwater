import * as THREE from 'three';
import { WORLD } from './config.js';
import { U } from './uniforms.js';
import { createApp } from './engine/app.js';
import { renderFrame } from './engine/renderFrame.js';
import { buildWorldData, buildWorldSystems } from './world/buildWorld.js';
import { createLighting } from './world/lighting.js';
import { createSession } from './game/session.js';
import { Environment } from './env.js';
import { Player } from './player.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const BENCH = params.has('bench');
const DEBUG = params.has('debug') && params.get('debug') !== '0';
const OFF = new Set((params.get('no') || '').split(','));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function main() {
  const canvas = document.getElementById('c');
  const app = createApp({ canvas, capture: CAPTURE, params });
  const { renderer, scene, camera, post, registry, clock } = app;

  const ui = new UI(app.qName);
  const step = async (msg, p) => { ui.loading(msg, p); await nextFrame(); };
  const data = await buildWorldData(renderer, step);
  const world = await buildWorldSystems({ renderer, scene, camera, data, tier: app.Q, U }, step, { off: OFF, noWater: params.has('nowater') });
  const lighting = createLighting({ scene, camera, U, tier: app.Q });

  await step('waiting for the light…', 0.86);
  const env = new Environment();
  const audio = new AudioEngine();
  const player = new Player(camera, { hf: data.hf, trees: world.trees, rocks: world.rocks, props: world.props, trail: data.trail, village: world.village }, audio);
  player.world.bridge = world.stream && world.stream.bridge;
  player.placeAtStart();
  player.onToast = (m) => ui.toast(m);
  player.onSit = (on) => {
    ui.prompt('');
    if (on) ui.toast(player.sitting.bench ? 'You sit. The day moves on without you.' : 'You sit in the grass for a while.');
  };

  app.onResize((w, h, Q) => world.water.setReflectionSize(w * Q.reflScale, h * Q.reflScale));
  app.resize();

  const renderFlags = {
    shadow: !OFF.has('shadow'), refl: !params.has('norefl') && !OFF.has('refl') && app.Q.reflEvery !== 0,
    grass: !OFF.has('grass'), ferns: true, trees: !OFF.has('trees'), clouds: !OFF.has('clouds'),
    bloom: true, ambRead: true, skyLut: true, msaa: (app.Q.msaa || 0) > 0,
  };

  const session = createSession({
    canvas, ui, env, player, audio, hf: data.hf, pois: world.props.pois,
    capture: CAPTURE, bench: BENCH, hudFlag: !!params.get('hud'),
    callbacks: {
      toggleHeadlamp: () => lighting.toggleHeadlamp(),
      onTierChange: (q) => { try { localStorage.setItem('stillwater.q', q); } catch {} location.search = '?q=' + q; },
      setCameraLookAt: (x, y, z, tx, ty, tz) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld(); },
    },
  });

  // warm-up: one LUT + shadows + trees
  env.update(0, 0, null);
  world.sky.renderLUT();
  world.sky.readAmbient();
  world.shadows.update(true);
  world.trees.update(camera.position, true);

  let captureCtrl = null, benchCtrl = null, debugHud = null;
  if (CAPTURE) {
    const { createCapture } = await import('./dev/capture.js');
    captureCtrl = createCapture({ params, U, clock, session, env, player, camera, lighting, data, world });
    captureCtrl.startCaptureMode();
  } else if (BENCH) {
    document.getElementById('loading').style.display = 'none';
    const titleEl = document.getElementById('title');
    titleEl.style.transition = 'none'; titleEl.style.opacity = 0; titleEl.style.pointerEvents = 'none';
    session.mode = 'play'; session.fade = 1; session.fadeTarget = 1;
    const [{ createCapture }, { createBench }] = await Promise.all([import('./dev/capture.js'), import('./dev/bench.js')]);
    captureCtrl = createCapture({ params, U, clock, session, env, player, camera, lighting, data, world });
    benchCtrl = createBench({
      params, renderer, glCtx: app.glCtx, timerExt: app.timerExt, gpuName: app.gpuName, qName: app.qName, Q: app.Q,
      getScale: app.getScale, setScale: app.setScale, hasPendingGpuQueries: app.hasPendingGpuQueries,
      applyPose: (queryStr) => { captureCtrl.applyCaptureParams(new URLSearchParams(queryStr), null); env.exposure = env.expTarget; session.fade = 1; session.fadeTarget = 1; },
      scene, camera, env, player, trail: data.trail, hf: data.hf, sky: world.sky, shadows: world.shadows, water: world.water,
      terrain: world.terrain, trees: world.trees, grass: world.grass, flowers: world.flowers, ferns: world.ferns,
      clouds: world.clouds, rocks: world.rocks, props: world.props, village: world.village, post, dbgState: renderFlags,
    });
  } else {
    ui.showTitle();
    ui.finishLoading();
    if (DEBUG) {
      const { createDebugHud } = await import('./dev/debugHud.js');
      debugHud = createDebugHud({ app, world, renderFlags, onTierChange: (q) => { try { localStorage.setItem('stillwater.q', q); } catch {} location.search = '?q=' + q; } });
    }
  }

  const sunNDC = new THREE.Vector3(), tmpV = new THREE.Vector3(), camDir = new THREE.Vector3(), sunUV = new THREE.Vector2();
  const renderCtx = {
    renderer, scene, camera, post,
    passes: {
      skyPass: ({ dt, t, frameNo }) => {
        U.uTime.value = t;
        env.update(dt, t, world.sky.ambient.sky);
        if ((renderFlags.ambRead && frameNo % 12 === 0) || CAPTURE) world.sky.readAmbient();
        world.sky.skyUniforms.uStarRot.value = (env.hours / 24) * Math.PI * 2;
        world.sky.lutMat.uniforms.uMoonI.value = 0.05 * env.night;
        world.sky.moonDir.value.copy(env.moon);
        renderer.info.reset();
        if (renderFlags.skyLut || CAPTURE) world.sky.renderLUT();
        return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
      },
      terrainShadowPass: ({ frameNo }) => {
        renderer.info.reset();
        world.shadows.update(CAPTURE && frameNo < 3);
        return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
      },
      simPass: ({ dt, t }) => {
        const groundY = data.hf.height(camera.position.x, camera.position.z);
        const pix = renderer.domElement.height * app.getScale();
        world.terrain.update(camera, groundY);
        world.trees.update(camera.position);
        world.grass.update(camera.position, player.pos);
        world.flowers.update(camera.position);
        world.birds.update(t, dt, env.day + env.golden);
        world.clouds.update(dt, env.wind);
        world.ferns.update(camera.position);
        world.shafts.update(U, t, env.day);
        world.butterflies.update(camera.position, env.day * (1 - env.golden) * (1 - env.dusk) * (1 - env.night));
        world.village.update(dt, t, U);
        world.village.smokeMat.uniforms.uPix.value = pix;
        world.village.smokeMat.uniforms.uAmb.value.copy(world.sky.ambient.sky).multiplyScalar(1.4);
        if (world.village.haloMat) world.village.haloMat.uniforms.uPix.value = pix;
        if (audio.started && Math.random() < dt * 0.12) { const d = world.village.sheep.nearest(camera.position); if (d < 60) audio.bleat(Math.max(0.05, 1 - d / 60)); }
        world.motes.update(camera.position, pix);
        world.fireflies.update(camera.position, pix);
        if (world.stream) world.stream.sprayMat.uniforms.uPix.value = pix;
        if (world.falls && world.falls.mistMat) world.falls.mistMat.uniforms.uPix.value = pix;
        const rip = world.water.update(dt, t, camera.position);
        if (rip && audio.started) { const d = Math.hypot(rip.x - camera.position.x, rip.y - camera.position.z); if (d < 90) audio.splash(Math.max(0.05, 1 - d / 90) * 0.5); }
        lighting.update({ env, amb: world.sky.ambient, renderFlags });
      },
      reflectionPass: ({ frameNo }) => {
        const lakeD = Math.hypot(camera.position.x - WORLD.lake.x, camera.position.z - WORLD.lake.z);
        if (lakeD < 3500 && renderFlags.refl && (frameNo % (app.Q.reflEvery || 1) === 0 || CAPTURE)) world.water.renderReflection(renderer, scene, camera, world.terrain);
        else world.water.uniforms.uHasRefl.value = 0;
      },
      getPostParams: ({ dt, t }) => {
        camera.getWorldDirection(camDir);
        tmpV.copy(camera.position).addScaledVector(U.uSunDir.value, 10000);
        sunNDC.copy(tmpV).project(camera);
        const facing = camDir.dot(U.uSunDir.value);
        const onScreen = facing > 0 && Math.abs(sunNDC.x) < 1.3 && Math.abs(sunNDC.y) < 1.3;
        const sunVis = onScreen ? THREE.MathUtils.smoothstep(U.uSunDir.value.y, -0.03, 0.04) * THREE.MathUtils.smoothstep(facing, 0.3, 0.8) : 0;
        if (CAPTURE) env.exposure = env.expTarget;
        return {
          exposure: env.exposure, bloom: 0.055, bloomThreshold: 0.95, rays: sunVis * (0.08 + env.golden * 0.14) * (app.Q.godrays ? 1 : 0),
          skipBloom: !renderFlags.bloom, rayColor: env.sunCol, sunUV: sunUV.set(sunNDC.x * 0.5 + 0.5, sunNDC.y * 0.5 + 0.5), sunVis,
          time: t, fade: session.stepFade(dt), wb: env.grade.wb, lift: env.grade.lift, gain: env.grade.gain, sat: env.grade.sat, contrast: env.grade.contrast,
          letterbox: 0, shadowTint: env.grade.shadowTint, golden: Math.max(env.golden, env.dusk * 0.6), dawn: env.dawn,
        };
      },
    },
  };

  app.start({
    shouldSkip: () => (CAPTURE && window.__shotReady) || (benchCtrl && benchCtrl.done),
    isPaused: () => session.paused,
    onFrame: ({ now, rawMs, dt, t, frameNo }) => {
      const wantGpuTimer = !!(app.timerExt && (debugHud?.isVisible() || BENCH));
      app.pollGpuTimers(wantGpuTimer, (ms, disjoint, tag) => benchCtrl?.onGpuSample(ms, disjoint, tag));
      const benchFrame = benchCtrl ? benchCtrl.beforeFrame(now) : null;
      if (benchFrame?.skipRender) { if (!benchCtrl.done) app.glCtx.flush(); return; }
      const queryTag = benchFrame ? benchFrame.queryTag : null;
      const gpuQ = (!benchCtrl || queryTag != null) ? app.beginGpuTimer(wantGpuTimer, queryTag, BENCH ? 8 : 4) : null;
      session.stepSim(dt, t, !!benchFrame?.overridePose);
      const stats = renderFrame(renderCtx, { dt, t, frameNo });
      app.endGpuTimer(gpuQ, queryTag);
      if (benchCtrl) benchCtrl.onFrame({ now, rawMs, dt, cpuMs: stats.cpuMs, passes: stats.passes });
      if (debugHud) debugHud.onFrame({ now, rawMs, cpuMs: stats.cpuMs, passes: stats.passes });
      const groundY = data.hf.height(camera.position.x, camera.position.z);
      const lakeDist = Math.max(0, Math.hypot((camera.position.x - WORLD.lake.x) / WORLD.lake.rx, (camera.position.z - WORLD.lake.z) / WORLD.lake.rz) - 1) * WORLD.lake.rx;
      audio.update(dt, {
        wind: env.wind, altitude: groundY, lake: Math.max(0, 1 - lakeDist / 120), day: env.day, dusk: env.dusk, night: env.night,
        moving: player.moving, sitting: player.sitting ? 1 : 0, forest: data.biome.sampleForest(camera.position.x, camera.position.z),
        swell: ui.swell, stream: world.stream ? Math.max(0, 1 - world.stream.distanceTo(camera.position) / 70) : 0,
      }, camera);
      session.updateHudAndPOIs(dt, groundY);
      if (clock.perfT > 1.5 && !CAPTURE && !BENCH) {
        const avg = clock.perfAcc / clock.perfN;
        let sc = app.getScale();
        ui.perf(`${Math.round(1 / avg)} fps · ${app.qName} · ${Math.round(sc * 100)}%`);
        if (avg > 1 / 27 && sc > 0.55) app.setScale(Math.max(0.55, sc - 0.05));
        else if (avg < 1 / 45 && sc < app.Q.scale) app.setScale(Math.min(app.Q.scale, sc + 0.05));
        clock.perfAcc = clock.perfN = clock.perfT = 0;
      }
      if (CAPTURE) captureCtrl.checkShotReady(frameNo);
    },
  });
  window.__game = { env, player, trail: data.trail, hf: data.hf, camera, U, sky: world.sky, renderer, post, terrain: world.terrain, scene, water: world.water, trees: world.trees, grass: world.grass, streamPlan: data.streamPlan, village: world.village, stream: world.stream, registry };
}

main().catch((e) => {
  console.error(e);
  const m = document.getElementById('loadmsg');
  if (m) m.textContent = 'Something went wrong: ' + e.message;
  window.__error = String(e && e.stack || e);
});
