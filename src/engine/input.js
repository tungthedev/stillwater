// Generic engine input manager: unifies keyboard, pointer-lock mouse, and multi-touch
// (floating left-half move stick + right-half drag look + external holds/triggers/buttons)
// into device-agnostic actions. Game layers supply all action bindings and pause policies.

const DEFAULT_MOUSE_SENSITIVITY = 0.0021;
const DEFAULT_TOUCH_LOOK_SENSITIVITY = 0.0055;
const DEFAULT_STICK_RADIUS = 52;
const DEFAULT_STICK_DEADZONE = 0.08;

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
 * @typedef {Object} KeyActionBinding
 * @property {string} action
 * @property {boolean} [repeat]
 */

/**
 * @typedef {Object} ButtonBindOptions
 * @property {string} action
 * @property {boolean} [tap]
 * @property {boolean} [hold]
 * @property {() => void} [onInteract]
 */

/**
 * @typedef {Object} InputOptions
 * @property {any} [touchSurface]
 * @property {any} [win]
 * @property {any} [doc]
 * @property {number} [mouseSensitivity]
 * @property {number} [touchLookSensitivity]
 * @property {number} [stickRadius]
 * @property {number} [stickDeadzone]
 * @property {Record<string, KeyActionBinding | KeyActionBinding[]>} [keyActions]
 * @property {Record<string, string | string[]>} [holdKeys]
 * @property {{ forward?: string[], back?: string[], left?: string[], right?: string[] }} [moveKeys]
 * @property {Iterable<string>} [allowWhilePaused]
 * @property {(el: EventTarget | null) => boolean} [isControlTarget]
 * @property {(state: { active: boolean, originX: number, originY: number, dx: number, dy: number, x: number, y: number }) => void} [onStickChange]
 * @property {(mode: 'touch' | 'desktop') => void} [onInputModeChange]
 * @property {() => void} [onClear]
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
  const keyActions = opts.keyActions ?? {};
  const holdKeys = opts.holdKeys ?? {};
  const moveKeys = {
    forward: opts.moveKeys?.forward ?? [],
    back: opts.moveKeys?.back ?? [],
    left: opts.moveKeys?.left ?? [],
    right: opts.moveKeys?.right ?? [],
  };
  const anyKey = (codes) => codes.some((c) => keys.has(c));
  const allowWhilePaused = new Set(opts.allowWhilePaused ?? []);
  const isControlTarget = opts.isControlTarget ?? defaultIsControlTarget;

  const ios = detectIOS(win);
  let inputMode = /** @type {'touch' | 'desktop'} */ (detectTouchCapability(win) || ios ? 'touch' : 'desktop');
  let active = false;
  let paused = false;
  let pointerLocked = false;
  let wasLandscape = win ? (win.innerWidth || 0) > (win.innerHeight || 0) : false;

  const keys = new Set();
  /** @type {Map<string, Set<string>>} */
  const externalHolds = new Map();
  /** @type {Set<string>} */
  const heldActive = new Set();
  /** @type {Map<string, Set<() => void>>} */
  const actionListeners = new Map();
  /** @type {Map<string, Set<(held: boolean) => void>>} */
  const holdListeners = new Map();
  /** @type {Set<(mode: 'touch' | 'desktop') => void>} */
  const modeListeners = new Set();
  /** @type {Set<() => void>} */
  const clearListeners = new Set();
  if (opts.onInputModeChange) modeListeners.add(opts.onInputModeChange);
  if (opts.onClear) clearListeners.add(opts.onClear);

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
  let nextButtonSeq = 0;

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

  function emitHoldChange(name, held) {
    const set = holdListeners.get(name);
    if (!set) return;
    for (const fn of set) fn(held);
  }

  function computeHeldNow(action) {
    if (!active || paused) return false;
    const ext = externalHolds.get(action);
    if (ext && ext.size > 0) return true;
    for (const [code, mapped] of Object.entries(holdKeys)) {
      if (!keys.has(code)) continue;
      if (Array.isArray(mapped) ? mapped.includes(action) : mapped === action) return true;
    }
    return false;
  }

  function syncHeldAction(action) {
    const now = computeHeldNow(action);
    const prev = heldActive.has(action);
    if (now === prev) return;
    if (now) heldActive.add(action);
    else heldActive.delete(action);
    emitHoldChange(action, now);
  }

  function releaseAllHeld() {
    if (!heldActive.size) return;
    const released = [...heldActive];
    heldActive.clear();
    for (let i = 0; i < released.length; i++) {
      emitHoldChange(released[i], false);
    }
  }

  function canDispatch(actionName) {
    if (!active) return false;
    return !paused || allowWhilePaused.has(actionName);
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
    releaseAllHeld();
    for (const fn of clearListeners) fn();
  }

  function getViewportWidth() {
    return (win && win.innerWidth) || 1;
  }

  function syncHoldKey(code) {
    const mapped = holdKeys[code];
    if (!mapped) return;
    if (Array.isArray(mapped)) {
      for (let i = 0; i < mapped.length; i++) syncHeldAction(mapped[i]);
    } else {
      syncHeldAction(mapped);
    }
  }

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    const code = e.code;
    const raw = keyActions[code];
    if (raw) {
      const list = Array.isArray(raw) ? raw : [raw];
      for (let i = 0; i < list.length; i++) {
        const binding = list[i];
        if (canDispatch(binding.action) && (!e.repeat || binding.repeat !== false)) {
          emitAction(binding.action);
        }
      }
    }
    if (!active || paused) return;
    keys.add(code);
    syncHoldKey(code);
  };

  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => {
    const code = e.code;
    keys.delete(code);
    syncHoldKey(code);
  };

  /** @param {MouseEvent} e */
  const onMouseMove = (e) => {
    if (!pointerLocked || !active || paused) return;
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

  const onOrientationChange = () => {
    if (win) wasLandscape = (win.innerWidth || 0) > (win.innerHeight || 0);
    clear();
  };

  const onResize = () => {
    if (!win) return;
    const landscape = (win.innerWidth || 0) > (win.innerHeight || 0);
    if (landscape !== wasLandscape) {
      wasLandscape = landscape;
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
    if (!active || paused) return;
    if (isControlTarget(e.target)) return;

    const halfW = getViewportWidth() * 0.5;
    // Claim only newly-started touches from changedTouches whose target is the play surface
    // so held UI button fingers in e.touches are never stolen for stick or look.
    const changed = e.changedTouches || [];
    let touchedSurface = false;
    for (let i = 0; i < changed.length; i++) {
      const t = changed[i];
      const target = /** @type {any} */ (t).target ?? e.target;
      if (isControlTarget(target)) continue;
      if (touchSurface && target && target !== touchSurface) continue;
      touchedSurface = true;
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
    // Block Safari scroll, bounce, pinch-zoom, and double-tap zoom across play-surface touches.
    if (touchedSurface && e.cancelable) e.preventDefault();
  };

  /** @param {TouchEvent} e */
  const onTouchMove = (e) => {
    if (!active || paused) return;
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
    if (handled && active && !paused && e.cancelable) e.preventDefault();
  };

  if (win) {
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('mousemove', onMouseMove);
    win.addEventListener('blur', onBlur);
    win.addEventListener('orientationchange', onOrientationChange);
    win.addEventListener('resize', onResize);
    win.screen?.orientation?.addEventListener?.('change', onOrientationChange);
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
    if (!active || paused) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    if (anyKey(moveKeys.forward)) y += 1;
    if (anyKey(moveKeys.back)) y -= 1;
    if (anyKey(moveKeys.left)) x -= 1;
    if (anyKey(moveKeys.right)) x += 1;
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
    return computeHeldNow(action);
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
      if (!active || paused) return;
      if (!set) {
        set = new Set();
        externalHolds.set(action, set);
      }
      set.add(source);
    } else if (set) {
      set.delete(source);
    }
    syncHeldAction(action);
  }

  /**
   * Trigger a discrete action programmatically (e.g. from an on-screen touch button).
   * @param {string} name
   */
  function trigger(name) {
    if (!canDispatch(name)) return;
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
   * Subscribe to held-state transitions for an action (keyboard, setHold, or clear).
   * @param {string} name
   * @param {(held: boolean) => void} fn
   */
  function onHoldChange(name, fn) {
    let set = holdListeners.get(name);
    if (!set) {
      set = new Set();
      holdListeners.set(name, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Subscribe to the false -> true hold transition for an action.
   * @param {string} name
   * @param {() => void} fn
   */
  function onPress(name, fn) {
    return onHoldChange(name, (held) => { if (held) fn(); });
  }

  /**
   * Subscribe to the true -> false hold transition for an action.
   * @param {string} name
   * @param {() => void} fn
   */
  function onRelease(name, fn) {
    return onHoldChange(name, (held) => { if (!held) fn(); });
  }

  /**
   * Subscribe to input mode changes ('touch' | 'desktop').
   * @param {(mode: 'touch' | 'desktop') => void} fn
   */
  function onModeChange(fn) {
    modeListeners.add(fn);
    return () => modeListeners.delete(fn);
  }

  /**
   * Subscribe to input clear events (blur, orientation change, visibility hidden, pause).
   * @param {() => void} fn
   */
  function onClear(fn) {
    clearListeners.add(fn);
    return () => clearListeners.delete(fn);
  }

  /**
   * Bind a DOM button element to an action supporting tap, hold, or both (tap on press + hold while down).
   * Automatically clears holds and pressed visuals on pause, blur, rotation, and visibility hidden.
   * @param {any} el
   * @param {ButtonBindOptions} cfg
   */
  function bindButton(el, cfg) {
    if (!el || !cfg?.action) return () => {};
    const action = cfg.action;
    const tap = cfg.tap !== false;
    const hold = !!cfg.hold;
    const onInteract = cfg.onInteract;
    const source = `btn:${el.id || ++nextButtonSeq}`;

    let activeTouch = /** @type {number | null} */ (null);
    let lastTouchEnd = -Infinity;

    const reset = () => {
      activeTouch = null;
      el.classList?.remove?.('pressed');
      if (hold) setHold(action, false, source);
    };

    const offClear = onClear(reset);

    /** @param {TouchEvent} e */
    const onTouchStartBtn = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      const t = e.changedTouches?.[0];
      if (!t) return;
      activeTouch = t.identifier;
      el.classList?.add?.('pressed');
      onInteract?.();
      if (hold) {
        if (tap) trigger(action);
        setHold(action, true, source);
      }
    };

    /** @param {TouchEvent} e */
    const onTouchEndBtn = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      for (const t of e.changedTouches || []) {
        if (t.identifier === activeTouch) {
          reset();
          lastTouchEnd = Date.now();
          if (tap && !hold) {
            onInteract?.();
            trigger(action);
          }
          break;
        }
      }
    };

    /** @param {MouseEvent} e */
    const onMouseDownBtn = (e) => {
      e.stopPropagation();
      if (Date.now() - lastTouchEnd < 500) return;
      el.classList?.add?.('pressed');
      onInteract?.();
      if (tap) trigger(action);
      setHold(action, true, source);
    };

    /** @param {MouseEvent} e */
    const onMouseUpBtn = (e) => {
      e.stopPropagation();
      reset();
    };

    /** @param {MouseEvent} e */
    const onClickBtn = (e) => {
      e.stopPropagation();
      if (Date.now() - lastTouchEnd < 500) return;
      onInteract?.();
      trigger(action);
    };

    el.addEventListener('touchstart', onTouchStartBtn, { passive: false });
    el.addEventListener('touchend', onTouchEndBtn, { passive: false });
    el.addEventListener('touchcancel', reset);
    if (hold) {
      el.addEventListener('mousedown', onMouseDownBtn);
      el.addEventListener('mouseup', onMouseUpBtn);
      el.addEventListener('mouseleave', onMouseUpBtn);
    } else if (tap) {
      el.addEventListener('click', onClickBtn);
    }

    return () => {
      offClear();
      reset();
      el.removeEventListener('touchstart', onTouchStartBtn);
      el.removeEventListener('touchend', onTouchEndBtn);
      el.removeEventListener('touchcancel', reset);
      if (hold) {
        el.removeEventListener('mousedown', onMouseDownBtn);
        el.removeEventListener('mouseup', onMouseUpBtn);
        el.removeEventListener('mouseleave', onMouseUpBtn);
      } else if (tap) {
        el.removeEventListener('click', onClickBtn);
      }
    };
  }

  function setActive(next) {
    const flag = !!next;
    if (active === flag) return;
    active = flag;
    if (!active) clear();
  }

  function setPaused(next) {
    const flag = !!next;
    if (paused === flag) return;
    paused = flag;
    if (paused) clear();
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
      win.removeEventListener('orientationchange', onOrientationChange);
      win.removeEventListener('resize', onResize);
      win.screen?.orientation?.removeEventListener?.('change', onOrientationChange);
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
    holdListeners.clear();
    modeListeners.clear();
    clearListeners.clear();
  }

  return {
    get active() { return active; },
    get paused() { return paused; },
    get pointerLocked() { return pointerLocked; },
    get mode() { return inputMode; },
    get isTouch() { return inputMode === 'touch'; },
    get isIOS() { return ios; },
    setActive,
    setPaused,
    setPointerLocked,
    getMove,
    consumeLook,
    isHeld,
    setHold,
    trigger,
    onAction,
    onHoldChange,
    onPress,
    onRelease,
    onModeChange,
    onClear,
    bindButton,
    clear,
    dispose,
  };
}
