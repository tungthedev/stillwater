import { WORLD } from './config.js';
import { U } from './uniforms.js';
import { QUALITY, resolveQuality } from './engine/quality.js';
import { createApp } from './engine/app.js';
import { renderFrame } from './engine/renderFrame.js';
import { buildWorldData, buildWorldSystems, createWorldPasses } from './world/buildWorld.js';
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
  const worldCtx = { renderer, scene, camera, data, tier: app.Q, U, registry };
  const world = await buildWorldSystems(worldCtx, step, { off: OFF, noWater: params.has('nowater') });
  const { lighting } = world;

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

  let captureCtrl = null, benchCtrl = null, debugHud = null;
  let renderCtx = null;

  const changeTier = (nextName) => {
    if (!QUALITY[nextName]) return;
    const nextQ = resolveQuality(nextName, params);
    try { localStorage.setItem('stillwater.q', nextName); } catch {}
    try { const u = new URL(location.href); u.searchParams.set('q', nextName); history.replaceState(null, '', u); } catch {}
    worldCtx.tier = nextQ;
    registry.setTier(nextQ, worldCtx);
    app.setTier(nextName, nextQ);
    renderFlags.refl = !params.has('norefl') && !OFF.has('refl') && nextQ.reflEvery !== 0;
    renderFlags.msaa = (nextQ.msaa || 0) > 0;
    session.setTierUI(nextName);
    debugHud?.onTierSync(nextName);
    if (session.paused && renderCtx) renderFrame(renderCtx, { dt: 0, t: clock.t, frameNo: clock.frameNo });
  };

  const session = createSession({
    canvas, ui, env, player, audio, hf: data.hf, pois: world.props.pois,
    capture: CAPTURE, bench: BENCH, hudFlag: !!params.get('hud'),
    callbacks: {
      toggleHeadlamp: () => lighting.toggleHeadlamp(),
      onTierChange: changeTier,
      setCameraLookAt: (x, y, z, tx, ty, tz) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld(); },
    },
  });

  // warm-up: one LUT + shadows + trees
  env.update(0, 0, null);
  world.sky.renderLUT();
  world.sky.readAmbient();
  world.shadows.update(true);
  world.trees.update(camera.position, true);

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
      debugHud = createDebugHud({ app, world, renderFlags, onTierChange: changeTier });
    }
  }

  renderCtx = {
    renderer, scene, camera, post,
    passes: createWorldPasses({ app, data, world, registry, env, player, audio, session, renderFlags, capture: CAPTURE }),
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
        const sc = app.getScale();
        ui.perf(`${Math.round(1 / avg)} fps · ${app.qName} · ${Math.round(sc * 100)}%`);
        if (avg > 1 / 27 && sc > 0.55) app.setScale(Math.max(0.55, sc - 0.05));
        else if (avg < 1 / 45 && sc < app.Q.scale) app.setScale(Math.min(app.Q.scale, sc + 0.05));
        clock.perfAcc = clock.perfN = clock.perfT = 0;
      }
      if (CAPTURE) captureCtrl.checkShotReady(frameNo);
    },
  });

  window.__game = {
    env, player, trail: data.trail, hf: data.hf, camera, U, renderer, post, scene, streamPlan: data.streamPlan, registry, setTier: changeTier,
    sky: registry.instance('sky'), terrain: registry.instance('terrain'), water: registry.instance('water'),
    trees: registry.instance('trees'), grass: registry.instance('grass'), village: registry.instance('village'), stream: registry.instance('stream'),
  };
}

main().catch((e) => {
  console.error(e);
  const m = document.getElementById('loadmsg');
  if (m) m.textContent = 'Something went wrong: ' + e.message;
  window.__error = String(e && e.stack || e);
});
