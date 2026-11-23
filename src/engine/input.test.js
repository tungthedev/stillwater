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

function touchEvent(touches, target = null) {
  let prevented = false;
  return {
    target,
    changedTouches: touches,
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
  it('maps keyboard move, stride, timeBoost, mouse look, and discrete actions identically to desktop', () => {
    const win = createFakeWindow({ width: 1280, height: 720, coarse: false, touchPoints: 0 });
    const doc = createFakeDoc();
    const input = createInput({ win, doc, touchSurface: win });
    expect(input.isTouch).toBe(false);
    expect(input.isIOS).toBe(false);

    const actions = [];
    for (const name of ['autoWalk', 'sit', 'headlamp', 'pause', 'toggleHud', 'toggleMusic', 'timeForward', 'timeBack']) {
      input.onAction(name, () => actions.push(name));
    }

    // Inactive: gameplay keys ignored, pause still fires for session handling.
    win.dispatch('keydown', { code: 'KeyW', repeat: false });
    win.dispatch('keydown', { code: 'KeyQ', repeat: false });
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    expect(actions).toEqual([]);

    input.setActive(true);
    win.dispatch('keydown', { code: 'KeyW', repeat: false });
    win.dispatch('keydown', { code: 'KeyD', repeat: false });
    expect(input.getMove()).toEqual({ x: 1, y: 1 });

    win.dispatch('keydown', { code: 'ShiftLeft', repeat: false });
    win.dispatch('keydown', { code: 'KeyT', repeat: false });
    expect(input.isHeld('stride')).toBe(true);
    expect(input.isHeld('timeBoost')).toBe(true);

    // Mouse look requires pointerLocked.
    win.dispatch('mousemove', { movementX: 100, movementY: 50 });
    expect(input.consumeLook()).toEqual({ dx: 0, dy: 0 });

    input.setPointerLocked(true);
    win.dispatch('mousemove', { movementX: 100, movementY: -50 });
    const look = input.consumeLook();
    expect(look.dx).toBeCloseTo(0.21, 6);
    expect(look.dy).toBeCloseTo(-0.105, 6);
    expect(input.consumeLook()).toEqual({ dx: 0, dy: 0 });

    win.dispatch('keydown', { code: 'KeyQ', repeat: false });
    win.dispatch('keydown', { code: 'KeyQ', repeat: true }); // repeat ignored
    win.dispatch('keydown', { code: 'KeyE', repeat: false });
    win.dispatch('keydown', { code: 'KeyF', repeat: false });
    win.dispatch('keydown', { code: 'Escape', repeat: false });
    expect(actions).toEqual(['autoWalk', 'sit', 'headlamp', 'pause']);

    // Blur clears held keys.
    win.dispatch('blur');
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    expect(input.isHeld('stride')).toBe(false);
    expect(input.isHeld('timeBoost')).toBe(false);
    input.dispose();
  });

  it('tracks simultaneous left-half move stick and right-half drag look with two touch points', () => {
    const win = createFakeWindow({
      width: 844,
      height: 390,
      coarse: true,
      touchPoints: 5,
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    });
    const doc = createFakeDoc();
    const stickStates = [];
    const input = createInput({
      win,
      doc,
      touchSurface: win,
      onStickChange: (s) => stickStates.push({ ...s }),
    });
    expect(input.isTouch).toBe(true);
    expect(input.isIOS).toBe(true);

    input.setActive(true);

    // Finger 1 on left half (move stick), Finger 2 on right half (drag look).
    const startEv = touchEvent([
      { identifier: 1, clientX: 140, clientY: 260 },
      { identifier: 2, clientX: 620, clientY: 200 },
    ]);
    win.dispatch('touchstart', startEv);
    expect(startEv.defaultPrevented).toBe(true);
    expect(stickStates.at(-1)).toMatchObject({ active: true, originX: 140, originY: 260 });

    const moveEv = touchEvent([
      { identifier: 1, clientX: 140, clientY: 200 }, // drag up 60px -> forward
      { identifier: 2, clientX: 700, clientY: 180 }, // drag right 80px, up 20px
    ]);
    win.dispatch('touchmove', moveEv);
    expect(moveEv.defaultPrevented).toBe(true);

    const mv = input.getMove();
    expect(mv.x).toBeCloseTo(0, 5);
    expect(mv.y).toBeCloseTo(1, 5);

    const look = input.consumeLook();
    expect(look.dx).toBeGreaterThan(0.3);
    expect(look.dy).toBeLessThan(0);

    // Extra finger on same half still prevents Safari pinch-zoom without hijacking tracked fingers.
    const pinchEv = touchEvent([{ identifier: 3, clientX: 650, clientY: 220 }]);
    win.dispatch('touchstart', pinchEv);
    expect(pinchEv.defaultPrevented).toBe(true);

    // Releasing look finger leaves move stick intact.
    win.dispatch('touchend', touchEvent([{ identifier: 2, clientX: 700, clientY: 180 }]));
    expect(input.getMove().y).toBeCloseTo(1, 5);

    // Releasing move finger resets stick and hides visual.
    win.dispatch('touchend', touchEvent([{ identifier: 1, clientX: 140, clientY: 200 }]));
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    expect(stickStates.at(-1).active).toBe(false);

    // Touch buttons feed holds and triggered actions cleanly.
    const onSit = vi.fn();
    input.onAction('sit', onSit);
    input.trigger('sit');
    expect(onSit).toHaveBeenCalledTimes(1);

    input.setHold('timeBoost', true, 'btn');
    expect(input.isHeld('timeBoost')).toBe(true);
    input.setHold('timeBoost', false, 'btn');
    expect(input.isHeld('timeBoost')).toBe(false);

    input.dispose();
  });

  it('ignores touches starting on UI control elements', () => {
    const win = createFakeWindow({ width: 390, height: 844, coarse: true, touchPoints: 5 });
    const doc = createFakeDoc();
    const input = createInput({ win, doc, touchSurface: win });
    input.setActive(true);

    const fakeBtn = { closest: () => true };
    const ev = touchEvent([{ identifier: 9, clientX: 60, clientY: 700 }], fakeBtn);
    win.dispatch('touchstart', ev);
    expect(ev.defaultPrevented).toBe(false);
    win.dispatch('touchmove', touchEvent([{ identifier: 9, clientX: 60, clientY: 600 }], fakeBtn));
    expect(input.getMove()).toEqual({ x: 0, y: 0 });
    input.dispose();
  });
});
