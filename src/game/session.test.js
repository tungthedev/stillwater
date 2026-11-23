import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInput } from '../engine/input.js';
import { createSession } from './session.js';

function createFakeEl(id = '', dataset = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    id,
    dataset,
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    getAttribute: (k) => (k === 'data-q' ? dataset.q ?? null : null),
    closest: () => null,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(ev);
    },
  };
}

function setupSessionEnv({ isTouch = false, isIOS = false } = {}) {
  const elements = new Map();
  for (const id of ['title', 'paused', 'btnPause', 'btnSit', 'btnLamp', 'btnTrail', 'btnTimeBoost', 'resumeBtn']) {
    elements.set(id, createFakeEl(id));
  }
  const winListeners = new Map();
  const docListeners = new Map();
  const bodyClasses = new Set();

  const win = {
    innerWidth: isTouch ? 390 : 1280,
    innerHeight: isTouch ? 844 : 720,
    navigator: {
      userAgent: isIOS ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)',
      maxTouchPoints: isTouch ? 5 : 0,
      platform: isIOS ? 'iPhone' : 'Linux',
    },
    matchMedia: (q) => ({ matches: isTouch && q.includes('coarse') }),
    visualViewport: { addEventListener() {}, removeEventListener() {} },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      for (const fn of [...(winListeners.get(type) || [])]) fn(ev);
    },
  };

  const doc = {
    visibilityState: 'visible',
    pointerLockElement: null,
    body: {
      classList: {
        toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)),
        contains: (c) => bodyClasses.has(c),
      },
    },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    exitPointerLock: vi.fn(() => {
      doc.pointerLockElement = null;
      doc.dispatch('pointerlockchange');
    }),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatch(type, ev = {}) {
      for (const fn of [...(docListeners.get(type) || [])]) fn(ev);
    },
  };

  // Install minimal globals expected by session.js.
  globalThis.window = /** @type {any} */ (win);
  globalThis.document = /** @type {any} */ (doc);
  globalThis.addEventListener = win.addEventListener;
  globalThis.removeEventListener = win.removeEventListener;
  globalThis.HTMLElement = /** @type {any} */ (function HTMLElement() {});

  const canvas = createFakeEl('c');
  canvas.requestPointerLock = vi.fn(() => {
    doc.pointerLockElement = canvas;
    doc.dispatch('pointerlockchange');
  });

  const audio = {
    started: false,
    musicOn: true,
    ctx: null,
    start: vi.fn(function () {
      if (!this.started) {
        this.started = true;
        this.ctx = {
          state: 'suspended',
          resume: vi.fn(() => {
            this.ctx.state = 'running';
            return Promise.resolve();
          }),
          suspend: vi.fn(() => {
            this.ctx.state = 'suspended';
            return Promise.resolve();
          }),
        };
      } else {
        this.ctx.resume();
      }
    }),
    setMusic: vi.fn(function (on) { this.musicOn = on; }),
  };

  const ui = {
    quality: 'low',
    setTouchMode: vi.fn(),
    hideTitle: vi.fn(),
    showHud: vi.fn(),
    paused: vi.fn(),
    toast: vi.fn(),
    clock: () => '12:00',
    update: vi.fn(),
    place: vi.fn(),
  };

  const env = { hours: 15, timeScale: 6 };
  const player = {
    enabled: false,
    locked: false,
    sitting: null,
    autoWalk: false,
    pos: { x: 0, z: 0 },
    yaw: 0,
    distance: 0,
    climb: 0,
    nearestBench: () => null,
    placeAtStart: vi.fn(),
    update: vi.fn(),
  };
  const hf = { height: () => 100 };
  const input = createInput({ win, doc, touchSurface: canvas });
  let lamp = false;
  const callbacks = {
    toggleHeadlamp: vi.fn(() => { lamp = !lamp; return lamp; }),
    onTierChange: vi.fn(),
    onResize: vi.fn(),
    onCameraSnap: vi.fn(),
    setCameraLookAt: vi.fn(),
  };

  const session = createSession({
    canvas, ui, env, player, audio, input, hf, pois: [], callbacks,
  });

  return { session, input, canvas, audio, ui, env, player, elements, win, doc, callbacks };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createSession touch & desktop lifecycle', () => {
  it('starts by tap on iOS, unlocks AudioContext in gesture, never requests pointer lock, and pauses/resumes by tap', () => {
    vi.useFakeTimers();
    const ctx = setupSessionEnv({ isTouch: true, isIOS: true });
    expect(ctx.input.isTouch).toBe(true);
    expect(ctx.ui.setTouchMode).toHaveBeenCalledWith(true);

    // Tap title screen.
    ctx.elements.get('title').dispatch('touchend', { type: 'touchend', cancelable: true, preventDefault() {} });
    expect(ctx.audio.start).toHaveBeenCalled();
    expect(ctx.audio.ctx.resume).toHaveBeenCalled();
    expect(ctx.audio.ctx.state).toBe('running');
    expect(ctx.canvas.requestPointerLock).not.toHaveBeenCalled();
    expect(ctx.session.mode).toBe('transition');

    vi.advanceTimersByTime(2400);
    expect(ctx.session.mode).toBe('play');
    expect(ctx.player.enabled).toBe(true);
    expect(ctx.input.active).toBe(true);

    // Tap Pause button -> pauses without pointer lock.
    const pauseBtn = ctx.elements.get('btnPause');
    pauseBtn.dispatch('touchstart', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: 1 }] });
    pauseBtn.dispatch('touchend', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: 1 }] });
    expect(ctx.session.paused).toBe(true);
    expect(ctx.input.active).toBe(false);

    // Tap pause overlay to resume -> resumes directly without pointer lock.
    ctx.elements.get('paused').dispatch('touchend', { type: 'touchend', target: ctx.elements.get('resumeBtn'), cancelable: true, preventDefault() {} });
    expect(ctx.session.paused).toBe(false);
    expect(ctx.input.active).toBe(true);
    expect(ctx.canvas.requestPointerLock).not.toHaveBeenCalled();

    // Tap Headlamp button -> toggles headlamp.
    const lampBtn = ctx.elements.get('btnLamp');
    lampBtn.dispatch('touchstart', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: 2 }] });
    lampBtn.dispatch('touchend', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: 2 }] });
    expect(ctx.callbacks.toggleHeadlamp).toHaveBeenCalledTimes(1);

    // Hold Time button -> timeBoost held -> env.timeScale increases.
    const timeBtn = ctx.elements.get('btnTimeBoost');
    timeBtn.dispatch('touchstart', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: 3 }] });
    expect(ctx.input.isHeld('timeBoost')).toBe(true);
    ctx.session.stepSim(1, 1);
    expect(ctx.env.timeScale).toBeGreaterThan(200);
    timeBtn.dispatch('touchend', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: 3 }] });
    expect(ctx.input.isHeld('timeBoost')).toBe(false);

    ctx.session.dispose();
    ctx.input.dispose();
  });

  it('preserves desktop pointer lock start, Escape pause, and click-to-resume', () => {
    vi.useFakeTimers();
    const ctx = setupSessionEnv({ isTouch: false, isIOS: false });
    expect(ctx.input.isTouch).toBe(false);

    ctx.elements.get('title').dispatch('click', { type: 'click' });
    expect(ctx.canvas.requestPointerLock).toHaveBeenCalledTimes(1);
    expect(ctx.player.locked).toBe(true);

    vi.advanceTimersByTime(2400);
    expect(ctx.session.mode).toBe('play');
    expect(ctx.session.paused).toBe(false);

    // Escape exits pointer lock and pauses.
    ctx.win.dispatch('keydown', { code: 'Escape', repeat: false });
    expect(ctx.doc.exitPointerLock).toHaveBeenCalledTimes(1);
    expect(ctx.session.paused).toBe(true);

    // Clicking paused overlay re-locks pointer and resumes.
    ctx.elements.get('paused').dispatch('click', { type: 'click', target: ctx.elements.get('paused') });
    expect(ctx.canvas.requestPointerLock).toHaveBeenCalledTimes(2);
    expect(ctx.session.paused).toBe(false);

    ctx.session.dispose();
    ctx.input.dispose();
  });
});
