import { U } from './uniforms.js';
import { VALLEY } from './content/valley.js';
import { QUALITY, resolveQuality } from './engine/quality.js';
import { createApp } from './engine/app.js';
import { renderFrame } from './engine/renderFrame.js';
import { buildWorldData, createBakeContext, buildWorldSystems, createRenderFlags, syncRenderFlags, warmupWorld, createWorldPasses } from './world/buildWorld.js';
import { createSession } from './game/session.js';
import { Environment } from './env.js';
import { Player } from './player.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture'), BENCH = params.has('bench'), BAKE = params.has('bake');
const LIVE_WORLD = params.has('liveWorld') || BAKE;
const DEBUG = params.has('debug') && params.get('debug') !== '0';
const OFF = new Set((params.get('no') || '').split(','));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function main() {
  const canvas = document.getElementById('c');
  const app = createApp({ canvas, capture: CAPTURE, params });
  const { renderer, scene, camera, registry, clock } = app;
  if (BAKE) { window.__bakeContext = await createBakeContext(renderer, VALLEY, app.gpuName); window.__bakeReady = true; return; }

  const ui = new UI(app.qName);
  const step = async (msg, p) => { ui.loading(msg, p); await nextFrame(); };
  const data = await buildWorldData(renderer, step, VALLEY, { live: LIVE_WORLD });
  const worldCtx = { renderer, scene, camera, data, tier: app.Q, U, registry };
  const world = await buildWorldSystems(worldCtx, step, { off: OFF, noWater: params.has('nowater') });

  await step('waiting for the light…', 0.86);
  const env = new Environment();
  const audio = new AudioEngine();
  const player = new Player(camera, { hf: data.hf, trees: world.trees, rocks: world.rocks, props: world.props, trail: data.trail, village: world.village }, audio);
  player.world.bridge = world.stream && world.stream.bridge;
  player.placeAtStart();
  player.onToast = (m) => ui.toast(m);
  player.onSit = (on) => { ui.prompt(''); if (on) ui.toast(player.sitting.bench ? 'You sit. The day moves on without you.' : 'You sit in the grass for a while.'); };

  const post = app.initPost();
  app.onResize((w, h, Q) => world.water.setReflectionSize(w * Q.reflScale, h * Q.reflScale));
  app.resize();

  const renderFlags = createRenderFlags(params, OFF, app.Q);
  let captureCtrl = null, benchCtrl = null, debugHud = null, renderCtx = null;
  // Fixed-step work timed into the same buckets the old single loop used: env in sky, world in sim, fade in post.
  const stepMs = { sky: 0, sim: 0, post: 0 };

  const changeTier = (nextName) => {
    if (!QUALITY[nextName]) return;
    const nextQ = resolveQuality(nextName, params);
    try { localStorage.setItem('stillwater.q', nextName); } catch {}
    try { const u = new URL(location.href); u.searchParams.set('q', nextName); history.replaceState(null, '', u); } catch {}
    worldCtx.tier = nextQ;
    registry.setTier(nextQ, worldCtx);
    app.setTier(nextName, nextQ);
    syncRenderFlags(renderFlags, params, OFF, nextQ);
    session.setTierUI(nextName);
    debugHud?.onTierSync(nextName);
    if (session.paused && renderCtx) renderFrame(renderCtx, { dt: 0, t: clock.t, frameNo: clock.frameNo, pix: app.getPixelHeight(), skipEnvUpdate: true, skipFadeStep: true, renderOnly: true });
  };

  const session = createSession({
    canvas, ui, env, player, audio, hf: data.hf, pois: data.pois,
    capture: CAPTURE, bench: BENCH, hudFlag: !!params.get('hud'),
    callbacks: {
      toggleHeadlamp: () => world.lighting.toggleHeadlamp(),
      onTierChange: changeTier,
      onCameraSnap: () => app.snapCamera(),
      setCameraLookAt: (x, y, z, tx, ty, tz) => { camera.position.set(x, y, z); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld(); },
    },
  });

  warmupWorld({ env, world, session, camera });
  const timeToTitleMs = Math.round(performance.now() * 10) / 10;

  if (CAPTURE || BENCH) {
    const [{ createCapture }, bench] = await Promise.all([import('./dev/capture.js'), BENCH && !CAPTURE && import('./dev/bench.js')]);
    captureCtrl = createCapture({ params, U, clock, resetClock: app.resetClock, snapCamera: app.snapCamera, session, env, player, camera, lighting: world.lighting, data, world });
    if (CAPTURE) captureCtrl.startCaptureMode();
    else benchCtrl = bench.createBench({ applyPose: captureCtrl.prepareBenchMode(),
      params, renderer, glCtx: app.glCtx, timerExt: app.timerExt, gpuName: app.gpuName, qName: app.qName, Q: app.Q,
      getScale: app.getScale, setScale: app.setScale, hasPendingGpuQueries: app.hasPendingGpuQueries,
      scene, camera, env, player, trail: data.trail, hf: data.hf, post, dbgState: renderFlags,
      timeToTitleMs, worldHash: data.hash, worldSource: data.source, treeCount: data.placements.trees.length, ...world,
    });
  } else {
    ui.showTitle(); ui.finishLoading();
    if (DEBUG) debugHud = (await import('./dev/debugHud.js')).createDebugHud({ app, world, renderFlags, onTierChange: changeTier });
  }

  const passes = createWorldPasses({ app, data, world, registry, env, player, audio, ui, session, renderFlags, capture: CAPTURE });
  renderCtx = { renderer, scene, camera, post, passes };

  app.start({
    shouldSkip: () => (CAPTURE && window.__shotReady) || (benchCtrl && benchCtrl.done),
    isPaused: () => session.paused,
    onCaptureFrame: ({ dt, t, frameNo }) => {
      session.stepSim(dt, t, false);
      renderFrame(renderCtx, { dt, t, frameNo, pix: app.getPixelHeight() });
      const groundY = data.hf.height(camera.position.x, camera.position.z);
      session.checkPOIs();
      passes.updateAudio(dt, groundY);
      session.updateHud(dt, groundY);
      captureCtrl.checkShotReady(frameNo);
    },
    beforeFrame: (now) => {
      const wantGpuTimer = !!(app.timerExt && (debugHud?.isVisible() || BENCH));
      app.pollGpuTimers(wantGpuTimer, (ms, disjoint, tag) => benchCtrl?.onGpuSample(ms, disjoint, tag));
      const benchFrame = benchCtrl ? benchCtrl.beforeFrame(now) : null;
      if (benchFrame?.skipRender) { if (!benchCtrl.done) app.glCtx.flush(); return { skipRender: true }; }
      stepMs.sky = stepMs.sim = stepMs.post = 0;
      return { skipRender: false, wantGpuTimer, benchFrame, overridePose: !!benchFrame?.overridePose };
    },
    onSimStep: ({ dt, t, overridePose }) => {
      session.stepSim(dt, t, overridePose);
      const t0 = performance.now(); env.update(dt, t, world.sky.ambient.sky);
      const t1 = performance.now(); passes.simPass({ dt, t, pix: app.getPixelHeight(), simOnly: true });
      const t2 = performance.now(); session.stepFade(dt);
      stepMs.sky += t1 - t0; stepMs.sim += t2 - t1; stepMs.post += performance.now() - t2;
      session.checkPOIs();
    },
    onRenderFrame: ({ now, rawMs, dt, t, frameNo, pre }) => {
      const queryTag = pre.benchFrame ? pre.benchFrame.queryTag : null;
      const gpuQ = (!benchCtrl || queryTag != null) ? app.beginGpuTimer(pre.wantGpuTimer, queryTag, BENCH ? 8 : 4) : null;
      const stats = renderFrame(renderCtx, { dt, t, frameNo, pix: app.getPixelHeight(), skipEnvUpdate: true, skipFadeStep: true, renderOnly: true });
      app.endGpuTimer(gpuQ, queryTag);
      for (const k in stepMs) { stats.cpuMs[k] += stepMs[k]; stats.cpuMs.total += stepMs[k]; }
      if (benchCtrl) benchCtrl.onFrame({ now, rawMs, dt, cpuMs: stats.cpuMs, passes: stats.passes });
      if (debugHud) debugHud.onFrame({ now, rawMs, cpuMs: stats.cpuMs, passes: stats.passes });
      const groundY = data.hf.height(camera.position.x, camera.position.z);
      passes.updateAudio(dt, groundY);
      session.updateHud(dt, groundY);
      if (!BENCH) app.updateDynamicScale(dt, (s) => ui.perf(s));
    },
  });

  const inst = Object.fromEntries(['sky', 'terrain', 'water', 'trees', 'grass', 'village', 'stream'].map((k) => [k, registry.instance(k)]));
  window.__game = { env, player, trail: data.trail, hf: data.hf, worldData: data, worldHash: data.hash, worldSource: data.source, treeCount: data.placements.trees.length, timeToTitleMs, camera, U, renderer, post, scene, streamPlan: data.streamPlan, registry, setTier: changeTier, ...inst };
}

main().catch((e) => {
  console.error(e);
  const m = document.getElementById('loadmsg');
  if (m) m.textContent = 'Something went wrong: ' + e.message;
  window.__error = String(e && e.stack || e);
});
