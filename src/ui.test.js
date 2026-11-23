import { describe, expect, it } from 'vitest';
import { UI } from './ui.js';

function createNode(initial = {}) {
  const classes = new Set();
  const children = [];
  return {
    textContent: initial.textContent || '',
    innerHTML: initial.innerHTML || '',
    dataset: initial.dataset || {},
    clientWidth: initial.clientWidth ?? 420,
    style: {},
    children,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) { children.push(child); return child; },
    querySelector: () => createNode(),
  };
}

function installFakeDom(compassWidth = 420) {
  const byId = new Map([
    ['compass', createNode({ clientWidth: compassWidth })],
    ['strip', createNode()],
    ['touchStick', createNode()],
    ['touchKnob', createNode()],
    ['btnSit', createNode({ textContent: 'Sit' })],
    ['btnTrail', createNode({ textContent: 'Trail' })],
    ['btnLamp', createNode({ textContent: 'Lamp' })],
    ['btnTimeBoost', createNode({ textContent: 'Time' })],
    ['resumeBtn', createNode({ textContent: 'click to continue' })],
    ['stats', createNode()],
    ['prompt', createNode()],
    ['hud', createNode()],
    ['title', createNode()],
    ['paused', createNode()],
  ]);
  const selectors = new Map([
    ['#title .begin', createNode({ textContent: 'click anywhere to begin' })],
    ['#title .keys', createNode({ innerHTML: '<b>WASD</b> walk' })],
    ['#paused .keys', createNode({ innerHTML: '<div><b>WASD</b> walk</div>' })],
  ]);
  const body = createNode();

  globalThis.document = /** @type {any} */ ({
    body,
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => selectors.get(sel) || null,
    querySelectorAll: () => [],
    createElement: () => createNode(),
  });

  return { byId, selectors, body };
}

describe('UI touch mode and responsive compass', () => {
  it('switches title, pause, button states, and prompts cleanly between desktop and touch', () => {
    const dom = installFakeDom(420);
    const ui = new UI('low');

    ui.setTouchMode(false);
    expect(dom.body.classList.contains('touch')).toBe(false);
    expect(dom.selectors.get('#title .begin').textContent).toBe('click anywhere to begin');
    expect(dom.selectors.get('#title .keys').innerHTML).toBe('<b>WASD</b> walk');

    ui.update(0.016, { yaw: 0, altitude: 150, hours: 15.5, distance: 100, climb: 10, pois: [], pos: { x: 0, z: 0 }, bench: true, sitting: false });
    expect(dom.byId.get('prompt').textContent).toBe('E · sit and rest');

    ui.setTouchMode(true);
    expect(dom.body.classList.contains('touch')).toBe(true);
    expect(dom.selectors.get('#title .begin').textContent).toBe('tap anywhere to begin');
    expect(dom.byId.get('resumeBtn').textContent).toBe('tap to continue');

    ui.update(0.016, { yaw: 0, altitude: 150, hours: 15.5, distance: 100, climb: 10, pois: [], pos: { x: 0, z: 0 }, bench: false, sitting: true, autoWalk: true, headlamp: true, timeBoost: true });
    expect(dom.byId.get('prompt').textContent).toBe('Tap Stand · hold Time to hurry');
    expect(dom.byId.get('btnSit').textContent).toBe('Stand');
    expect(dom.byId.get('btnSit').classList.contains('on')).toBe(true);
    expect(dom.byId.get('btnTrail').classList.contains('on')).toBe(true);
    expect(dom.byId.get('btnLamp').classList.contains('on')).toBe(true);
    expect(dom.byId.get('btnTimeBoost').classList.contains('on')).toBe(true);

    ui.setStick({ active: true, originX: 90, originY: 600, dx: 12, dy: -30, x: 0.2, y: 0.6 });
    expect(dom.byId.get('touchStick').classList.contains('active')).toBe(true);
    expect(dom.byId.get('touchStick').style.left).toBe('90.0px');
    expect(dom.byId.get('touchKnob').style.transform).toBe('translate3d(12.0px, -30.0px, 0px)');

    ui.setStick({ active: false, originX: 0, originY: 0, dx: 0, dy: 0, x: 0, y: 0 });
    expect(dom.byId.get('touchStick').classList.contains('active')).toBe(false);

    ui.paused(true);
    expect(dom.byId.get('paused').classList.contains('open')).toBe(true);
    ui.paused(false);
    expect(dom.byId.get('paused').classList.contains('open')).toBe(false);
  });

  it('centers compass marks using live compass width after viewport resize/rotation', () => {
    const dom = installFakeDom(260);
    const ui = new UI('low');
    ui.update(0.016, { yaw: 0, altitude: 100, hours: 12, distance: 0, climb: 0, pois: [], pos: { x: 0, z: 0 }, bench: false, sitting: false });
    const north = ui.marks.find((m) => m.bearing === 0);
    expect(north.el.style.left).toBe('130.0px');

    dom.byId.get('compass').clientWidth = 420;
    ui.update(0.016, { yaw: 0, altitude: 100, hours: 12, distance: 0, climb: 0, pois: [], pos: { x: 0, z: 0 }, bench: false, sitting: false });
    expect(north.el.style.left).toBe('210.0px');
  });
});
