import { WORLD } from '../config.js';

// Session state machine (title / transition / play / pause), input wiring, and POI discovery.
// Must not touch WebGL objects directly; delegates rendering/lighting/tier actions through callbacks.

const $ = (id) => document.getElementById(id);

// Game-owned input bindings and pause policy passed into the generic engine input controller.
// Matches the original desktop keyboard behavior: Escape ignores repeat; Q/E/F/H/M/[/] repeat
// and remain responsive while paused during play, while movement and touch holds clear on pause.
// New actions are added here, not in the engine: a key may list several actions
// (KeyE: [sit, { action: 'interact' }]) and also appear in holdKeys to make the action holdable.
export const GAME_INPUT_BINDINGS = {
  moveKeys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
  },
  keyActions: {
    Escape: { action: 'pause', repeat: false },
    KeyQ: { action: 'autoWalk', repeat: true },
    KeyE: [
      { action: 'interact', repeat: false },
      { action: 'sit', repeat: false },
    ],
    KeyF: { action: 'headlamp', repeat: true },
    KeyH: { action: 'toggleHud', repeat: true },
    KeyM: { action: 'toggleMusic', repeat: true },
    BracketRight: { action: 'timeForward', repeat: true },
    BracketLeft: { action: 'timeBack', repeat: true },
  },
  holdKeys: {
    ShiftLeft: 'stride',
    ShiftRight: 'stride',
    KeyT: 'timeBoost',
    KeyE: 'interact',
  },
  allowWhilePaused: [
    'pause',
    'autoWalk',
    'sit',
    'headlamp',
    'toggleHud',
    'toggleMusic',
    'timeForward',
    'timeBack',
  ],
};

export function createSession({
  canvas,
  ui,
  env,
  player,
  audio,
  input,
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
  let headlampOn = false;
  let timeBoost = 0;
  let paused = false;
  let suppressPause = false;
  const visited = new Set();
  const pendingPlaces = [];
  const cleanups = [];

  function syncInputState() {
    input.setActive(mode === 'play');
    input.setPaused(paused);
  }

  function canUsePointerLock() {
    return !capture && !bench && !input.isTouch && !input.isIOS && typeof canvas.requestPointerLock === 'function';
  }

  function requestDesktopPointerLock(onFail) {
    try {
      const res = canvas.requestPointerLock?.();
      if (res && typeof res.catch === 'function') {
        res.catch(() => onFail?.());
      }
    } catch {
      onFail?.();
    }
  }

  // iOS Safari only unlocks an AudioContext created or resumed synchronously inside a user gesture.
  // One call per gesture: create on first use, otherwise resume only if still suspended.
  function unlockAudio() {
    if (!audio.started) audio.start();
    const ctx = audio.ctx;
    if (!ctx || ctx.state !== 'suspended' || paused) return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }

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
    syncInputState();
    ui.paused(paused);
    if (audio.ctx) {
      if (paused) audio.ctx.suspend();
      else audio.ctx.resume();
    }
  }

  function startGame() {
    if (mode !== 'title') return;
    mode = 'transition';
    syncInputState();
    unlockAudio();
    fadeTarget = 0;
    ui.hideTitle();
    setTimeout(() => {
      mode = 'play';
      player.enabled = true;
      syncInputState();
      fadeTarget = 1;
      ui.showHud(true);
    }, 2300);
  }

  const onCanvasClick = () => {
    if (mode === 'title') {
      startGame();
      return;
    }
    unlockAudio();
    if (mode === 'play' && canUsePointerLock()) requestDesktopPointerLock();
  };

  const onTitleStart = (e) => {
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    startGame();
    if (canUsePointerLock()) requestDesktopPointerLock();
  };

  const onPausedActivate = (e) => {
    if (!paused) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const q = target?.dataset?.q || null;
    if (q) {
      if (e.type === 'touchend' && e.cancelable) e.preventDefault();
      e.stopPropagation();
      callbacks.onTierChange?.(q);
      return;
    }
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    unlockAudio();
    if (canUsePointerLock()) {
      requestDesktopPointerLock(() => setPaused(false));
    } else {
      setPaused(false);
    }
  };

  const onPointerLockChange = () => {
    const locked = document.pointerLockElement === canvas;
    input.setPointerLocked(locked);
    player.locked = locked;
    if (suppressPause) return;
    if (!input.isTouch && !input.isIOS) {
      setPaused(!locked && mode === 'play' && !capture && !bench);
    }
  };

  ui.setTouchMode(input.isTouch);
  cleanups.push(
    input.onModeChange((nextMode) => ui.setTouchMode(nextMode === 'touch')),
  );

  cleanups.push(
    input.onAction('pause', () => {
      if (mode !== 'play' || capture || bench || suppressPause) return;
      if (document.pointerLockElement === canvas) {
        document.exitPointerLock?.();
      }
      setPaused(true);
    }),
    input.onAction('headlamp', () => {
      if (mode !== 'play') return;
      headlampOn = !!callbacks.toggleHeadlamp();
      ui.toast(headlampOn ? 'Headlamp on' : 'Headlamp off');
    }),
    input.onAction('toggleHud', () => {
      if (mode !== 'play') return;
      hudOn = !hudOn;
      document.body.classList.toggle('photo', !hudOn);
    }),
    input.onAction('toggleMusic', () => {
      if (mode !== 'play') return;
      audio.setMusic(!audio.musicOn);
      ui.toast(audio.musicOn ? 'Music on' : 'Music off');
    }),
    input.onAction('timeForward', () => {
      if (mode !== 'play') return;
      env.hours = (env.hours + 0.5) % 24;
      ui.toast(ui.clock(env.hours));
    }),
    input.onAction('timeBack', () => {
      if (mode !== 'play') return;
      env.hours = (env.hours + 23.5) % 24;
      ui.toast(ui.clock(env.hours));
    }),
  );

  cleanups.push(
    input.bindButton($('btnPause'), { action: 'pause', tap: true, hold: false, onInteract: unlockAudio }),
    input.bindButton($('btnSit'), { action: 'sit', tap: true, hold: false, onInteract: unlockAudio }),
    input.bindButton($('btnLamp'), { action: 'headlamp', tap: true, hold: false, onInteract: unlockAudio }),
    input.bindButton($('btnTrail'), { action: 'autoWalk', tap: true, hold: false, onInteract: unlockAudio }),
    input.bindButton($('btnTimeBoost'), { action: 'timeBoost', tap: false, hold: true, onInteract: unlockAudio }),
  );

  function addTouchActionButton({ id, label, action, tap = true, hold = false, visible = true }) {
    const handle = ui.addTouchButton({ id, label, visible });
    const unbind = input.bindButton(handle.el, { action, tap, hold, onInteract: unlockAudio });
    const remove = () => {
      unbind();
      handle.remove();
    };
    cleanups.push(remove);
    return { ...handle, remove };
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let resizeTimer = null;
  const onViewportChange = () => {
    requestAnimationFrame(() => callbacks.onResize?.());
    if (resizeTimer) clearTimeout(resizeTimer);
    // iOS Safari settles final innerWidth/innerHeight slightly after orientationchange fires.
    resizeTimer = setTimeout(() => callbacks.onResize?.(), 150);
  };
  addEventListener('orientationchange', onViewportChange);
  window.visualViewport?.addEventListener('resize', onViewportChange);
  cleanups.push(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    removeEventListener('orientationchange', onViewportChange);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
  });

  canvas.addEventListener('click', onCanvasClick);
  const titleEl = $('title');
  titleEl.style.pointerEvents = 'auto';
  titleEl.addEventListener('click', onTitleStart);
  titleEl.addEventListener('touchend', onTitleStart, { passive: false });
  const pausedEl = $('paused');
  pausedEl.addEventListener('click', onPausedActivate);
  pausedEl.addEventListener('touchend', onPausedActivate, { passive: false });
  document.addEventListener('pointerlockchange', onPointerLockChange);
  syncInputState();

  function stepSim(dt, t, overridePose = false) {
    const keysT = input.isHeld('timeBoost');
    const sitBoost = player.sitting ? (player.sitting.bench ? 220 : 60) : 0;
    const target = keysT ? 900 : sitBoost;
    timeBoost += (target - timeBoost) * (1 - Math.exp(-dt * (target > timeBoost ? 0.6 : 2.5)));
    if (!capture && !bench) env.timeScale = 4 + timeBoost;

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
      autoWalk: !!player.autoWalk,
      headlamp: headlampOn,
      timeBoost: input.isHeld('timeBoost'),
    });
    for (const p of places) ui.place(p.name, p.sub);
  }

  function setTierUI(qName) {
    ui.quality = qName;
    document.querySelectorAll('#qual span').forEach((s) => s.classList.toggle('on', s.getAttribute('data-q') === qName));
  }

  function dispose() {
    canvas.removeEventListener('click', onCanvasClick);
    titleEl.removeEventListener('click', onTitleStart);
    titleEl.removeEventListener('touchend', onTitleStart);
    pausedEl.removeEventListener('click', onPausedActivate);
    pausedEl.removeEventListener('touchend', onPausedActivate);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  }

  return {
    get mode() { return mode; },
    set mode(v) { mode = v; syncInputState(); },
    get paused() { return paused; },
    set paused(v) { setPaused(v); },
    get suppressPause() { return suppressPause; },
    set suppressPause(v) { suppressPause = !!v; },
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
    addTouchActionButton,
    dispose,
  };
}
