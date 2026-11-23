import { WORLD } from '../config.js';

// Session state machine (title / transition / play / pause), input listeners, and POI discovery.
// Must not touch WebGL objects directly; delegates rendering/lighting/tier actions through callbacks.

const $ = (id) => document.getElementById(id);

export function createSession({
  canvas,
  ui,
  env,
  player,
  audio,
  hf,
  pois,
  capture = false,
  bench = false,
  hudFlag = false,
  callbacks,
}) {
  let mode = capture ? 'play' : 'title';
  let fade = capture ? 1 : 0;
  let fadeTarget = 1;
  let hudOn = true;
  let timeBoost = 0;
  let paused = false;
  const visited = new Set();
  const pendingPlaces = [];

  function titleCam(tt) {
    const L = WORLD.lake;
    const a = 0.25 + tt * 0.012;
    const x = L.x + Math.cos(a) * 520;
    const z = L.z + Math.sin(a) * 420;
    const g = hf.height(x, z);
    const y = Math.max(g, WORLD.waterLevel) + 38 + Math.sin(tt * 0.05) * 6;
    const tx = WORLD.summit.x * 0.6 + L.x * 0.4;
    const tz = WORLD.summit.z * 0.6 + L.z * 0.4;
    const ty = hf.height(tx, tz) + 40;
    callbacks.setCameraLookAt(x, y, z, tx, ty, tz);
  }

  function setPaused(next) {
    paused = !!next;
    ui.paused(paused);
    if (audio.ctx) {
      if (paused) audio.ctx.suspend();
      else audio.ctx.resume();
    }
  }

  function startGame() {
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
  }

  const onCanvasClick = () => {
    if (mode === 'title') startGame();
    if (mode === 'play' && !capture && !bench) canvas.requestPointerLock?.();
  };
  const onTitleClick = () => {
    startGame();
    canvas.requestPointerLock?.();
  };
  const onPausedClick = (e) => {
    const q = e.target instanceof HTMLElement ? e.target.dataset.q : null;
    if (q) {
      e.stopPropagation();
      callbacks.onTierChange?.(q);
      return;
    }
    canvas.requestPointerLock?.();
  };
  const onPointerLockChange = () => {
    player.locked = document.pointerLockElement === canvas;
    setPaused(!player.locked && mode === 'play' && !capture && !bench);
  };
  const onKeyDown = (e) => {
    if (e.code === 'Escape' && mode === 'play' && !capture && !bench) {
      if (e.repeat) return;
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock?.();
      }
      setPaused(true);
      return;
    }
    if (mode !== 'play') return;
    if (e.code === 'KeyF') {
      const on = callbacks.toggleHeadlamp();
      ui.toast(on ? 'Headlamp on' : 'Headlamp off');
    }
    if (e.code === 'KeyH') {
      hudOn = !hudOn;
      document.body.classList.toggle('photo', !hudOn);
    }
    if (e.code === 'KeyM') {
      audio.setMusic(!audio.musicOn);
      ui.toast(audio.musicOn ? 'Music on' : 'Music off');
    }
    if (e.code === 'BracketRight') {
      env.hours = (env.hours + 0.5) % 24;
      ui.toast(ui.clock(env.hours));
    }
    if (e.code === 'BracketLeft') {
      env.hours = (env.hours + 23.5) % 24;
      ui.toast(ui.clock(env.hours));
    }
  };

  canvas.addEventListener('click', onCanvasClick);
  const titleEl = $('title');
  titleEl.style.pointerEvents = 'auto';
  titleEl.addEventListener('click', onTitleClick);
  const pausedEl = $('paused');
  pausedEl.addEventListener('click', onPausedClick);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  addEventListener('keydown', onKeyDown);

  function stepSim(dt, t, overridePose = false) {
    const keysT = player.keys.has('KeyT');
    const sitBoost = player.sitting ? (player.sitting.bench ? 220 : 60) : 0;
    const target = keysT ? 900 : sitBoost;
    timeBoost += (target - timeBoost) * (1 - Math.exp(-dt * (target > timeBoost ? 0.6 : 2.5)));
    if (!capture && !bench) env.timeScale = 6 + timeBoost;

    if (mode === 'title' || mode === 'transition') {
      if (fade < 0.05 && mode === 'transition') player.update(dt, t);
      else titleCam(t);
    } else if (!overridePose) {
      player.update(dt, t);
    }
    if (mode === 'transition' && fadeTarget === 0 && fade < 0.02) {
      player.placeAtStart();
      player.update(0.016, t);
      callbacks.onCameraSnap?.();
    }
  }

  function stepFade(dt) {
    fade += (fadeTarget - fade) * (1 - Math.exp(-dt * (fadeTarget > fade ? 0.9 : 2.2)));
    return fade;
  }

  function checkPOIs() {
    if (mode !== 'play') return;
    for (const p of pois) {
      if (visited.has(p.name)) continue;
      if (Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < p.r) {
        visited.add(p.name);
        if ((!capture && !bench) || hudFlag) pendingPlaces.push(p);
      }
    }
  }

  function updateHud(dt, groundY) {
    if (mode !== 'play') return;
    // Discovery happens on the sim tick; the card is shown after the HUD update, as in the original frame order.
    const places = pendingPlaces.splice(0);
    ui.update(dt, {
      yaw: player.yaw,
      altitude: groundY,
      hours: env.hours,
      distance: player.distance,
      climb: player.climb,
      pois,
      pos: player.pos,
      bench: !player.sitting && player.nearestBench(),
      sitting: !!player.sitting,
    });
    for (const p of places) ui.place(p.name, p.sub);
  }

  function setTierUI(qName) {
    ui.quality = qName;
    document.querySelectorAll('#qual span').forEach((s) => s.classList.toggle('on', s.getAttribute('data-q') === qName));
  }

  function dispose() {
    canvas.removeEventListener('click', onCanvasClick);
    titleEl.removeEventListener('click', onTitleClick);
    pausedEl.removeEventListener('click', onPausedClick);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    removeEventListener('keydown', onKeyDown);
  }

  return {
    get mode() { return mode; },
    set mode(v) { mode = v; },
    get paused() { return paused; },
    set paused(v) { setPaused(v); },
    get fade() { return fade; },
    set fade(v) { fade = v; },
    get fadeTarget() { return fadeTarget; },
    set fadeTarget(v) { fadeTarget = v; },
    visited,
    titleCam,
    startGame,
    setPaused,
    stepSim,
    stepFade,
    checkPOIs,
    updateHud,
    setTierUI,
    dispose,
  };
}
