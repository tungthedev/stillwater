// Generic engine input manager: unifies keyboard, pointer-lock mouse, and multi-touch
// (floating left-half move stick + right-half drag look + on-screen action triggers)
// into device-agnostic actions. Knows nothing about gameplay or world concepts.

const DEFAULT_MOUSE_SENSITIVITY = 0.0021;
const DEFAULT_TOUCH_LOOK_SENSITIVITY = 0.0055;
const DEFAULT_STICK_RADIUS = 52;
const DEFAULT_STICK_DEADZONE = 0.08;

/**
 * Default key-to-action map for discrete triggered actions.
 * @type {Record<string, { action: string, allowRepeat?: boolean, alwaysActive?: boolean }>}
 */
export const DEFAULT_KEY_ACTIONS = {
  Escape: { action: 'pause', alwaysActive: true },
  KeyQ: { action: 'autoWalk' },
  KeyE: { action: 'sit' },
  KeyF: { action: 'headlamp' },
  KeyH: { action: 'toggleHud' },
  KeyM: { action: 'toggleMusic' },
  BracketRight: { action: 'timeForward', allowRepeat: true },
  BracketLeft: { action: 'timeBack', allowRepeat: true },
};

/**
 * Default key-to-hold map for held boolean actions.
 * @type {Record<string, string>}
 */
export const DEFAULT_HOLD_KEYS = {
  ShiftLeft: 'stride',
  ShiftRight: 'stride',
  KeyT: 'timeBoost',
};

/**
 * Detect whether the current environment is a touch-first device.
 * @param {any} [win]
 * @returns {boolean}
 */
export function detectTouchCapability(win = globalThis.window) {
  if (!win) return false;
  try {
    if (typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches) {
      return true;
    }
  } catch {}
  const nav = win.navigator;
  if (nav && typeof nav.maxTouchPoints === 'number' && nav.maxTouchPoints > 0) {
    return true;
  }
  return 'ontouchstart' in win;
}

/**
 * Detect iOS / iPadOS user agents where Pointer Lock is unsupported or undesirable.
 * @param {any} [win]
 * @returns {boolean}
 */
export function detectIOS(win = globalThis.window) {
  const nav = win?.navigator;
  if (!nav) return false;
  const ua = nav.userAgent || '';
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1;
}

/**
 * Clamp and deadzone a raw stick offset (in CSS pixels) into normalized move axes
 * where +x is right and +y is forward (up on screen).
 * @param {number} rawDx
 * @param {number} rawDy
 * @param {number} [radius]
 * @param {number} [deadzone]
 */
export function computeStickVector(rawDx, rawDy, radius = DEFAULT_STICK_RADIUS, deadzone = DEFAULT_STICK_DEADZONE) {
  const dist = Math.hypot(rawDx, rawDy);
  if (dist <= 1e-6 || radius <= 0) {
    return { dx: 0, dy: 0, x: 0, y: 0 };
  }
  const clampedDist = Math.min(dist, radius);
  const scale = clampedDist / dist;
  const dx = rawDx * scale;
  const dy = rawDy * scale;
  const norm = clampedDist / radius;
  if (norm <= deadzone) {
    return { dx, dy, x: 0, y: 0 };
  }
  const mag = (norm - deadzone) / (1 - deadzone);
  const ux = rawDx / dist;
  const uy = rawDy / dist;
  return {
    dx,
    dy,
    x: ux * mag,
    y: -uy * mag,
  };
}

/**
 * @param {EventTarget | null} el
 */
function defaultIsControlTarget(el) {
  if (!el || typeof /** @type {any} */ (el).closest !== 'function') return false;
  return !!/** @type {Element} */ (el).closest('button, a, input, select, textarea, [data-ui-control]');
}

/**
 * @typedef {Object} InputOptions
 * @property {any} [touchSurface]
 * @property {any} [win]
 * @property {any} [doc]
 * @property {number} [mouseSensitivity]
 * @property {number} [touchLookSensitivity]
 * @property {number} [stickRadius]
 * @property {number} [stickDeadzone]
 * @property {Record<string, { action: string, allowRepeat?: boolean, alwaysActive?: boolean }>} [keyActions]
 * @property {Record<string, string>} [holdKeys]
 * @property {(el: EventTarget | null) => boolean} [isControlTarget]
 * @property {(state: { active: boolean, originX: number, originY: number, dx: number, dy: number, x: number, y: number }) => void} [onStickChange]
 * @property {(mode: 'touch' | 'desktop') => void} [onInputModeChange]
 */

/**
 * Create the unified engine input controller.
 * @param {InputOptions} [opts]
 */
export function createInput(opts = {}) {
  const win = opts.win ?? globalThis.window;
  const doc = opts.doc ?? globalThis.document;
  const touchSurface = opts.touchSurface ?? win;
  const mouseSensitivity = opts.mouseSensitivity ?? DEFAULT_MOUSE_SENSITIVITY;
  const touchLookSensitivity = opts.touchLookSensitivity ?? DEFAULT_TOUCH_LOOK_SENSITIVITY;
  const stickRadius = opts.stickRadius ?? DEFAULT_STICK_RADIUS;
  const stickDeadzone = opts.stickDeadzone ?? DEFAULT_STICK_DEADZONE;
  const keyActions = opts.keyActions ?? DEFAULT_KEY_ACTIONS;
  const holdKeys = opts.holdKeys ?? DEFAULT_HOLD_KEYS;
  const isControlTarget = opts.isControlTarget ?? defaultIsControlTarget;

  const ios = detectIOS(win);
  let inputMode = /** @type {'touch' | 'desktop'} */ (detectTouchCapability(win) || ios ? 'touch' : 'desktop');
  let active = false;
  let pointerLocked = false;

  const keys = new Set();
  /** @type {Map<string, Set<string>>} */
  const externalHolds = new Map();
  /** @type {Map<string, Set<() => void>>} */
  const actionListeners = new Map();
  /** @type {Set<(mode: 'touch' | 'desktop') => void>} */
  const modeListeners = new Set();
  if (opts.onInputModeChange) modeListeners.add(opts.onInputModeChange);

  let lookDx = 0;
  let lookDy = 0;

  let moveTouchId = /** @type {number | null} */ (null);
  let stickOriginX = 0;
  let stickOriginY = 0;
  let stickMoveX = 0;
  let stickMoveY = 0;

  let lookTouchId = /** @type {number | null} */ (null);
  let lookLastX = 0;
  let lookLastY = 0;

  let lastTouchTs = -Infinity;

  function emitStick(state) {
    opts.onStickChange?.(state);
  }

  function setInputMode(next) {
    if (inputMode === next) return;
    inputMode = next;
    for (const fn of modeListeners) fn(next);
  }

  function emitAction(name) {
    const set = actionListeners.get(name);
    if (!set) return;
    for (const fn of set) fn();
  }

  function clearTouches() {
    const hadStick = moveTouchId !== null;
    moveTouchId = null;
    stickOriginX = 0;
    stickOriginY = 0;
    stickMoveX = 0;
    stickMoveY = 0;
    lookTouchId = null;
    lookLastX = 0;
    lookLastY = 0;
    if (hadStick) {
      emitStick({ active: false, originX: 0, originY: 0, dx: 0, dy: 0, x: 0, y: 0 });
    }
  }

  function clear() {
    keys.clear();
    externalHolds.clear();
    lookDx = 0;
    lookDy = 0;
    clearTouches();
  }

  function getViewportWidth() {
    return (win && win.innerWidth) || 1;
  }

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    const code = e.code;
    const binding = keyActions[code];
    if (binding) {
      if (binding.alwaysActive || active) {
        if (!e.repeat || binding.allowRepeat) {
          emitAction(binding.action);
        }
      }
    }
    if (!active) return;
    keys.add(code);
  };

  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => {
    keys.delete(e.code);
  };

  /** @param {MouseEvent} e */
  const onMouseMove = (e) => {
    if (!pointerLocked || !active) return;
    lookDx += (e.movementX || 0) * mouseSensitivity;
    lookDy += (e.movementY || 0) * mouseSensitivity;
  };

  const onBlur = () => {
    clear();
  };

  const onVisibilityChange = () => {
    if (doc && doc.visibilityState === 'hidden') {
      clear();
    }
  };

  // Detect touch anywhere on the window so title/pause UI switches cleanly even before play starts.
  const onAnyTouchStart = () => {
    lastTouchTs = Date.now();
    setInputMode('touch');
  };

  /** @param {PointerEvent} e */
  const onAnyPointerDown = (e) => {
    if (e.pointerType === 'touch') {
      lastTouchTs = Date.now();
      setInputMode('touch');
    } else if (e.pointerType === 'mouse' && !ios && Date.now() - lastTouchTs > 800) {
      setInputMode('desktop');
    }
  };

  /** @param {TouchEvent} e */
  const onTouchStart = (e) => {
    lastTouchTs = Date.now();
    setInputMode('touch');
    if (!active) return;
    if (isControlTarget(e.target)) return;

    const halfW = getViewportWidth() * 0.5;
    const claim = (list) => {
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.identifier === moveTouchId || t.identifier === lookTouchId) continue;
        if (t.clientX < halfW && moveTouchId === null) {
          moveTouchId = t.identifier;
          stickOriginX = t.clientX;
          stickOriginY = t.clientY;
          stickMoveX = 0;
          stickMoveY = 0;
          emitStick({ active: true, originX: stickOriginX, originY: stickOriginY, dx: 0, dy: 0, x: 0, y: 0 });
        } else if (t.clientX >= halfW && lookTouchId === null) {
          lookTouchId = t.identifier;
          lookLastX = t.clientX;
          lookLastY = t.clientY;
        }
      }
    };
    claim(e.changedTouches || []);
    if (e.touches) claim(e.touches);
    // Block Safari scroll, bounce, pinch-zoom, and double-tap zoom across all play-surface touches.
    if (e.cancelable) e.preventDefault();
  };

  /** @param {TouchEvent} e */
  const onTouchMove = (e) => {
    if (!active) return;
    if (isControlTarget(e.target)) return;
    const changed = e.changedTouches || [];
    for (let i = 0; i < changed.length; i++) {
      const t = changed[i];
      if (t.identifier === moveTouchId) {
        const v = computeStickVector(t.clientX - stickOriginX, t.clientY - stickOriginY, stickRadius, stickDeadzone);
        stickMoveX = v.x;
        stickMoveY = v.y;
        emitStick({ active: true, originX: stickOriginX, originY: stickOriginY, dx: v.dx, dy: v.dy, x: v.x, y: v.y });
      } else if (t.identifier === lookTouchId) {
        const dx = t.clientX - lookLastX;
        const dy = t.clientY - lookLastY;
        lookLastX = t.clientX;
        lookLastY = t.clientY;
        lookDx += dx * touchLookSensitivity;
        lookDy += dy * touchLookSensitivity;
      }
    }
    if (e.cancelable) e.preventDefault();
  };

  /** @param {TouchEvent} e */
  const onTouchEnd = (e) => {
    let handled = false;
    const changed = e.changedTouches || [];
    for (let i = 0; i < changed.length; i++) {
      const t = changed[i];
      if (t.identifier === moveTouchId) {
        moveTouchId = null;
        stickMoveX = 0;
        stickMoveY = 0;
        handled = true;
        emitStick({ active: false, originX: 0, originY: 0, dx: 0, dy: 0, x: 0, y: 0 });
      } else if (t.identifier === lookTouchId) {
        lookTouchId = null;
        handled = true;
      }
    }
    if (handled && active && e.cancelable) e.preventDefault();
  };

  if (win) {
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('mousemove', onMouseMove);
    win.addEventListener('blur', onBlur);
    win.addEventListener('touchstart', onAnyTouchStart, { passive: true, capture: true });
    win.addEventListener('pointerdown', onAnyPointerDown, { passive: true, capture: true });
  }
  if (doc) {
    doc.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (touchSurface) {
    touchSurface.addEventListener('touchstart', onTouchStart, { passive: false });
    touchSurface.addEventListener('touchmove', onTouchMove, { passive: false });
    touchSurface.addEventListener('touchend', onTouchEnd, { passive: false });
    touchSurface.addEventListener('touchcancel', onTouchEnd, { passive: false });
  }

  function getMove() {
    if (!active) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (moveTouchId !== null) {
      x += stickMoveX;
      y += stickMoveY;
    }
    return {
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
    };
  }

  function consumeLook() {
    const dx = lookDx;
    const dy = lookDy;
    lookDx = 0;
    lookDy = 0;
    return { dx, dy };
  }

  /** @param {string} action */
  function isHeld(action) {
    if (!active) return false;
    const ext = externalHolds.get(action);
    if (ext && ext.size > 0) return true;
    for (const [code, mapped] of Object.entries(holdKeys)) {
      if (mapped === action && keys.has(code)) return true;
    }
    return false;
  }

  /**
   * Hold or release a continuous action from a non-keyboard source (e.g. touch button).
   * @param {string} action
   * @param {boolean} held
   * @param {string} [source]
   */
  function setHold(action, held, source = 'touch') {
    let set = externalHolds.get(action);
    if (held) {
      if (!set) {
        set = new Set();
        externalHolds.set(action, set);
      }
      set.add(source);
    } else if (set) {
      set.delete(source);
    }
  }

  /**
   * Trigger a discrete action programmatically (e.g. from an on-screen touch button).
   * @param {string} name
   */
  function trigger(name) {
    const isAlways = name === 'pause';
    if (!active && !isAlways) return;
    emitAction(name);
  }

  /**
   * Subscribe to a discrete action. Returns an unsubscribe function.
   * @param {string} name
   * @param {() => void} fn
   */
  function onAction(name, fn) {
    let set = actionListeners.get(name);
    if (!set) {
      set = new Set();
      actionListeners.set(name, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Subscribe to input mode changes ('touch' | 'desktop').
   * @param {(mode: 'touch' | 'desktop') => void} fn
   */
  function onModeChange(fn) {
    modeListeners.add(fn);
    return () => modeListeners.delete(fn);
  }

  function setActive(next) {
    const flag = !!next;
    if (active === flag) return;
    active = flag;
    if (!active) clear();
  }

  function setPointerLocked(next) {
    pointerLocked = !!next;
  }

  function dispose() {
    clear();
    if (win) {
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('mousemove', onMouseMove);
      win.removeEventListener('blur', onBlur);
      win.removeEventListener('touchstart', onAnyTouchStart, { capture: true });
      win.removeEventListener('pointerdown', onAnyPointerDown, { capture: true });
    }
    if (doc) {
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }
    if (touchSurface) {
      touchSurface.removeEventListener('touchstart', onTouchStart);
      touchSurface.removeEventListener('touchmove', onTouchMove);
      touchSurface.removeEventListener('touchend', onTouchEnd);
      touchSurface.removeEventListener('touchcancel', onTouchEnd);
    }
    actionListeners.clear();
    modeListeners.clear();
  }

  return {
    get active() { return active; },
    get pointerLocked() { return pointerLocked; },
    get mode() { return inputMode; },
    get isTouch() { return inputMode === 'touch'; },
    get isIOS() { return ios; },
    setActive,
    setPointerLocked,
    getMove,
    consumeLook,
    isHeld,
    setHold,
    trigger,
    onAction,
    onModeChange,
    clear,
    dispose,
  };
}
