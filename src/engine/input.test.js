import { describe, expect, it, vi } from 'vitest';
import { computeStickVector, createInput } from './input.js';

function createFakeWindow({ width = 844, height = 390, coarse = false, touchPoints = 0, ua = 'Mozilla/5.0' } = {}) {
  const listeners = new Map();
  const win = {
    innerWidth: width,
    innerHeight: height,
    navigator: { userAgent: ua, maxTouchPoints: touchPoints, platform: 'Linux' },
    matchMedia: (q) => ({ matches: coarse && q.includes('coarse') }),
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
  return win;
}

function createFakeDoc() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
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

function touchEvent(changedTouches, target = null, allTouches = changedTouches) {
  let prevented = false;
  return {
    target,
    changedTouches,
    touches: allTouches,
    cancelable: true,
    preventDefault() { prevented = true; },
    get defaultPrevented() { return prevented; },
  };
}

describe('computeStickVector', () => {
  it('returns zero inside deadzone and normalized unit vector at full deflection', () => {
    expect(computeStickVector(0, 0, 50, 0.1)).toEqual({ dx: 0, dy: 0, x: 0, y: 0 });
    const inner = computeStickVector(2, 0, 50, 0.1);
    expect(inner.x).toBe(0);
    expect(inner.y).toBe(0);

    // Up on screen (negative dy) maps to +y forward.
    const up = computeStickVector(0, -100, 50, 0.1);
    expect(up.dx).toBeCloseTo(0, 6);
    expect(up.dy).toBeCloseTo(-50, 6);
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(1, 6);

    // Right on screen (+dx) maps to +x strafe right.
    const right = computeStickVector(50, 0, 50, 0.1);
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.y).toBeCloseTo(0, 6);
  });
});

describe('createInput', () => {
  it('uses caller-supplied bindings, repeat rules, and allowWhilePaused policy with no hardcoded game actions', () => {
    const win = createFakeWindow({ width: 1280, height: 720, coarse: false, touchPoints: 0 });
    const doc = createFakeDoc();
    const input = createInput({
      win,
      doc,
      touchSurface: win,
      moveKeys: { forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'] },
      keyActions: {
        Escape: { action: 'menu', repeat: false },
        KeyQ: { action: 'actionA', repeat: true },
        KeyF: { action: 'actionB', repeat: true },
      },
      holdKeys: {
        ShiftLeft: 'fast',
        KeyT: 'boost',
      },
      allowWhilePaused: ['menu', 'actionB'],
    });
    expect(input.isTouch).toBe(false);
    expect(input.isIOS).toBe(false);

    const actions = [];
    for (const name of ['menu', 'actionA', 'actionB']) {
      input.onAction(name, () => actions.push(name));
    }

    // Inactive: nothing fires.
    win.dispatch('keydown', { code: 'KeyW', repeat: false });
    win.dispatch('keydown', { code: 'KeyQ', repeat: false });
    win.dispatch('keydown', { code: 'Escape', repeat: false });
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    expect(actions).toEqual([]);

    input.setActive(true);
    win.dispatch('keydown', { code: 'KeyW', repeat: false });
    win.dispatch('keydown', { code: 'KeyD', repeat: false });
    expect(input.getMove()).toEqual({ x: 1, y: 1 });

    win.dispatch('keydown', { code: 'ShiftLeft', repeat: false });
    win.dispatch('keydown', { code: 'KeyT', repeat: false });
    expect(input.isHeld('fast')).toBe(true);
    expect(input.isHeld('boost')).toBe(true);

    // Mouse look requires pointerLocked.
    win.dispatch('mousemove', { movementX: 100, movementY: 50 });
    expect(input.consumeLook()).toEqual({ dx: 0, dy: 0 });

    input.setPointerLocked(true);
    win.dispatch('mousemove', { movementX: 100, movementY: -50 });
    const look = input.consumeLook();
    expect(look.dx).toBeCloseTo(0.21, 6);
    expect(look.dy).toBeCloseTo(-0.105, 6);
    expect(input.consumeLook()).toEqual({ dx: 0, dy: 0 });

    // Repeat honors binding.repeat.
    win.dispatch('keydown', { code: 'KeyQ', repeat: false });
    win.dispatch('keydown', { code: 'KeyQ', repeat: true });
    win.dispatch('keydown', { code: 'Escape', repeat: false });
    win.dispatch('keydown', { code: 'Escape', repeat: true });
    expect(actions).toEqual(['actionA', 'actionA', 'menu']);

    // While paused: movement and holds clear, allowed actions still fire, others do not.
    input.setPaused(true);
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    expect(input.isHeld('fast')).toBe(false);
    expect(input.isHeld('boost')).toBe(false);
    win.dispatch('keydown', { code: 'KeyQ', repeat: false });
    win.dispatch('keydown', { code: 'KeyF', repeat: false });
    expect(actions).toEqual(['actionA', 'actionA', 'menu', 'actionB']);

    input.dispose();
  });

  it('tracks simultaneous stick + look, never steals held button touches from e.touches, and clears on orientationchange', () => {
    const win = createFakeWindow({
      width: 390,
      height: 844,
      coarse: true,
      touchPoints: 5,
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    });
    const doc = createFakeDoc();
    const surface = createFakeWindow({ width: 390, height: 844 });
    const fakeBtn = { closest: () => true };
    const stickStates = [];
    const onClear = vi.fn();
    const input = createInput({
      win,
      doc,
      touchSurface: surface,
      onStickChange: (s) => stickStates.push({ ...s }),
      onClear,
    });
    expect(input.isTouch).toBe(true);
    expect(input.isIOS).toBe(true);

    input.setActive(true);
    input.setHold('boost', true, 'btn');

    // Held button finger on right half (id 99) is present in e.touches when left-half canvas finger (id 1) starts.
    const heldBtnTouch = { identifier: 99, clientX: 330, clientY: 740, target: fakeBtn };
    const stickTouch = { identifier: 1, clientX: 95, clientY: 600, target: surface };
    const start1 = touchEvent([stickTouch], surface, [heldBtnTouch, stickTouch]);
    surface.dispatch('touchstart', start1);
    expect(start1.defaultPrevented).toBe(true);

    // Moving the button finger must NOT turn look; adding a real right-half canvas finger (id 2) must turn look.
    surface.dispatch('touchmove', touchEvent([{ identifier: 99, clientX: 280, clientY: 740, target: fakeBtn }], surface));
    expect(input.consumeLook()).toEqual({ dx: 0, dy: 0 });

    const lookTouch = { identifier: 2, clientX: 300, clientY: 360, target: surface };
    surface.dispatch('touchstart', touchEvent([lookTouch], surface, [heldBtnTouch, stickTouch, lookTouch]));
    surface.dispatch('touchmove', touchEvent([
      { identifier: 1, clientX: 95, clientY: 540, target: surface },
      { identifier: 2, clientX: 380, clientY: 340, target: surface },
    ], surface));

    expect(input.getMove().y).toBeCloseTo(1, 5);
    const look = input.consumeLook();
    expect(look.dx).toBeGreaterThan(0.3);
    expect(look.dy).toBeLessThan(0);

    // Orientation change clears stick, look, external holds, and notifies onClear.
    win.innerWidth = 844;
    win.innerHeight = 390;
    win.dispatch('orientationchange');
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    expect(input.isHeld('boost')).toBe(false);
    expect(stickStates.at(-1).active).toBe(false);
    expect(onClear).toHaveBeenCalled();

    input.dispose();
  });

  it('ignores touches starting on UI control elements', () => {
    const win = createFakeWindow({ width: 390, height: 844, coarse: true, touchPoints: 5 });
    const doc = createFakeDoc();
    const input = createInput({ win, doc, touchSurface: win });
    input.setActive(true);

    const fakeBtn = { closest: () => true };
    const ev = touchEvent([{ identifier: 9, clientX: 60, clientY: 700, target: fakeBtn }], fakeBtn);
    win.dispatch('touchstart', ev);
    expect(ev.defaultPrevented).toBe(false);
    win.dispatch('touchmove', touchEvent([{ identifier: 9, clientX: 60, clientY: 600, target: fakeBtn }], fakeBtn));
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    input.dispose();
  });

  it('supports a game-defined tap+hold action via keyboard and bindButton with press/release callbacks cleared on pause/blur/rotation/hidden', () => {
    const win = createFakeWindow({ width: 390, height: 844, coarse: true, touchPoints: 5 });
    const doc = createFakeDoc();
    const input = createInput({
      win,
      doc,
      touchSurface: win,
      keyActions: { KeyE: { action: 'interact', repeat: false } },
      holdKeys: { KeyE: 'interact' },
    });
    input.setActive(true);

    let taps = 0, presses = 0, releases = 0;
    input.onAction('interact', () => { taps++; });
    input.onPress('interact', () => { presses++; });
    input.onRelease('interact', () => { releases++; });

    // Keyboard press fires tap once + transitions held false -> true; repeat does not re-fire tap.
    win.dispatch('keydown', { code: 'KeyE', repeat: false });
    win.dispatch('keydown', { code: 'KeyE', repeat: true });
    expect({ taps, presses, releases, held: input.isHeld('interact') }).toEqual({ taps: 1, presses: 1, releases: 0, held: true });
    win.dispatch('keyup', { code: 'KeyE' });
    expect({ taps, presses, releases, held: input.isHeld('interact') }).toEqual({ taps: 1, presses: 1, releases: 1, held: false });

    // bindButton with tap+hold fires tap on press, holds while down, clears on pause/blur/rotation/hidden.
    const btnListeners = new Map();
    const classes = new Set();
    const btn = {
      id: 'btnUse',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      addEventListener(type, fn) { if (!btnListeners.has(type)) btnListeners.set(type, new Set()); btnListeners.get(type).add(fn); },
      removeEventListener(type, fn) { btnListeners.get(type)?.delete(fn); },
      dispatch(type, ev) { for (const fn of [...(btnListeners.get(type) || [])]) fn(ev); },
    };
    const unbind = input.bindButton(btn, { action: 'interact', tap: true, hold: true });

    const pressBtn = (id) => btn.dispatch('touchstart', { stopPropagation() {}, preventDefault() {}, cancelable: true, changedTouches: [{ identifier: id }] });
    for (const clearFn of [
      () => { input.setPaused(true); input.setPaused(false); },
      () => win.dispatch('blur'),
      () => win.dispatch('orientationchange'),
      () => { doc.visibilityState = 'hidden'; doc.dispatch('visibilitychange'); doc.visibilityState = 'visible'; },
    ]) {
      pressBtn(1);
      expect(input.isHeld('interact')).toBe(true);
      expect(classes.has('pressed')).toBe(true);
      clearFn();
      expect(input.isHeld('interact')).toBe(false);
      expect(classes.has('pressed')).toBe(false);
    }
    expect(taps).toBe(5);
    expect(presses).toBe(5);
    expect(releases).toBe(5);

    unbind();
    input.dispose();
  });
});
