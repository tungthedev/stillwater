import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createInput } from './engine/input.js';
import { Player } from './player.js';

function createStubEnv() {
  const listeners = new Map();
  const win = {
    innerWidth: 844,
    innerHeight: 390,
    navigator: { userAgent: 'Mozilla/5.0', maxTouchPoints: 0, platform: 'Linux' },
    matchMedia: () => ({ matches: false }),
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
  const doc = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  return { win, doc };
}

function createStubWorld() {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([0, -i * 5]);
  return {
    hf: {
      height: () => 100,
      normal: () => ({ x: 0, y: 1, z: 0 }),
      trailAt: () => 0.8,
    },
    trees: { collide() {} },
    rocks: { collide() {} },
    props: { benches: [{ x: 1, z: -1, y: 100, ry: 0 }], collide() {} },
    trail: { points: pts },
    village: { collide() {} },
  };
}

function createStubAudio() {
  return { footstep() {}, splash() {} };
}

describe('Player action-driven input', () => {
  it('moves identically via keyboard W and full-forward touch stick', () => {
    const runWith = (drive) => {
      const { win, doc } = createStubEnv();
      const input = createInput({ win, doc, touchSurface: win });
      const cam = new THREE.PerspectiveCamera();
      const player = new Player(cam, createStubWorld(), createStubAudio(), input);
      player.placeAtStart();
      player.enabled = true;
      input.setActive(true);
      drive(win);
      for (let i = 0; i < 30; i++) player.update(1 / 60, i / 60);
      const out = { x: player.pos.x, z: player.pos.z, dist: player.distance };
      player.dispose();
      input.dispose();
      return out;
    };

    const kb = runWith((win) => {
      win.dispatch('keydown', { code: 'KeyW', repeat: false });
    });
    const touch = runWith((win) => {
      win.dispatch('touchstart', {
        target: null,
        cancelable: true,
        preventDefault() {},
        changedTouches: [{ identifier: 1, clientX: 120, clientY: 260 }],
      });
      win.dispatch('touchmove', {
        target: null,
        cancelable: true,
        preventDefault() {},
        changedTouches: [{ identifier: 1, clientX: 120, clientY: 160 }],
      });
    });

    expect(kb.dist).toBeGreaterThan(0.5);
    expect(touch.x).toBeCloseTo(kb.x, 5);
    expect(touch.z).toBeCloseTo(kb.z, 5);
    expect(touch.dist).toBeCloseTo(kb.dist, 5);
  });

  it('rotates yaw and pitch from right-half touch look and toggles sit/autoWalk via actions', () => {
    const { win, doc } = createStubEnv();
    const input = createInput({ win, doc, touchSurface: win });
    const cam = new THREE.PerspectiveCamera();
    const player = new Player(cam, createStubWorld(), createStubAudio(), input);
    player.placeAtStart();
    player.enabled = true;
    input.setActive(true);

    const yaw0 = player.yaw;
    win.dispatch('touchstart', {
      target: null,
      cancelable: true,
      preventDefault() {},
      changedTouches: [{ identifier: 2, clientX: 600, clientY: 200 }],
    });
    win.dispatch('touchmove', {
      target: null,
      cancelable: true,
      preventDefault() {},
      changedTouches: [{ identifier: 2, clientX: 700, clientY: 170 }],
    });
    for (let i = 0; i < 20; i++) player.update(1 / 60, i / 60);
    expect(player.yaw).toBeLessThan(yaw0 - 0.3);

    input.trigger('autoWalk');
    expect(player.autoWalk).toBe(true);
    input.trigger('sit');
    expect(player.sitting).not.toBeNull();
    input.trigger('sit');
    expect(player.sitting).toBeNull();

    player.dispose();
    input.dispose();
  });
});
