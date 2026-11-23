// Real-browser touch and desktop input regression test.
// Drives real CDP touch events (Input.dispatchTouchEvent) and keyboard/mouse input
// at iPhone portrait (390x844), iPhone landscape (844x390), and desktop (1280x720).
// Launches Chrome via tools/chrome.mjs so every run goes through the shared GPU lock.
//
// Usage:
//   BASE=http://127.0.0.1:5242/ node tools/touchtest.mjs
import { launchBrowser } from './chrome.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PORTRAIT = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false };
const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const checks = {};

function check(name, cond, detail = '') {
  checks[name] = { ok: !!cond, detail };
  if (!cond) failures.push(`${name}: ${detail}`);
}

async function checkLayout(page, label) {
  const report = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const canvas = document.getElementById('c');
    const cRect = canvas.getBoundingClientRect();
    const issues = [];
    if (Math.abs(cRect.width - vw) > 1 || Math.abs(cRect.height - vh) > 1) {
      issues.push(`canvas CSS ${cRect.width}x${cRect.height} != ${vw}x${vh}`);
    }
    if (canvas.width !== vw || canvas.height !== vh) {
      issues.push(`canvas backing ${canvas.width}x${canvas.height} != ${vw}x${vh}`);
    }
    if (document.documentElement.scrollWidth > vw) {
      issues.push(`scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    }
    if (document.documentElement.scrollHeight > vh) {
      issues.push(`scrollHeight ${document.documentElement.scrollHeight} > ${vh}`);
    }
    for (const id of ['compass', 'stats', 'btnPause', 'touchActions', 'perf']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) {
        issues.push(`#${id} out of bounds (${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}) vs ${vw}x${vh}`);
      }
    }
    return { vw, vh, issues };
  });
  check(`layout.${label}`, report.issues.length === 0, report.issues.join('; ') || `${report.vw}x${report.vh} ok`);
}

async function getCenter(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
}

async function cdpTap(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(30);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const { browser, renderer } = await launchBrowser();
const errs = [];

try {
  // ===== 1. iPhone Touch Tests (Portrait 390x844 -> Rotate -> Landscape 844x390) =====
  const page = await browser.newPage();
  await page.emulate({ userAgent: IOS_UA, viewport: PORTRAIT });
  const cdp = await page.createCDPSession();

  page.on('pageerror', (e) => errs.push('touch pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errs.push('touch console.error: ' + m.text());
  });

  await page.goto(`${BASE}?q=low`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 250 });
  const touchInitErr = await page.evaluate(() => window.__error || null);
  check('touch.init', !touchInitErr, String(touchInitErr || 'ok'));

  await sleep(1000);
  await checkLayout(page, 'portrait-title');

  // Tap to start via real CDP touch event (no pointer lock, audio unlocked).
  await cdpTap(cdp, 195, 650);
  await page.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 15000, polling: 100 });
  await sleep(400);

  const started = await page.evaluate(() => ({
    enabled: __game.player.enabled,
    pointerLock: document.pointerLockElement !== null,
    audioStarted: __game.audio?.started,
    audioState: __game.audio?.ctx?.state,
  }));
  check('touch.start', started.enabled && !started.pointerLock && started.audioStarted && started.audioState === 'running', JSON.stringify(started));
  await checkLayout(page, 'portrait-play');

  // Item 2: hidden pause overlay quality options must NOT catch touches or switch tier.
  const hiddenQual = await page.evaluate(() => {
    const el = document.querySelector('#qual span[data-q="ultra"]');
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return { cx, cy, hitTag: hit?.tagName, hitId: hit?.id, hitDataQ: hit?.getAttribute?.('data-q') || null };
  });
  const tierBeforeHidden = await page.evaluate(() => new URLSearchParams(location.search).get('q'));
  const yawBeforeHidden = await page.evaluate(() => __game.player.yaw);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: hiddenQual.cx, y: hiddenQual.cy, id: 2 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: hiddenQual.cx + i * 10, y: hiddenQual.cy, id: 2 }],
    });
    await sleep(35);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  const afterHidden = await page.evaluate(() => ({
    q: new URLSearchParams(location.search).get('q'),
    yaw: __game.player.yaw,
  }));
  const hiddenOk = hiddenQual.hitId === 'c' && !hiddenQual.hitDataQ && afterHidden.q === tierBeforeHidden;
  check(
    'item2.hiddenPauseOverlay',
    hiddenOk,
    `hit=${hiddenQual.hitTag}#${hiddenQual.hitId}[data-q=${hiddenQual.hitDataQ}] q=${tierBeforeHidden}->${afterHidden.q} yawDelta=${Math.abs(afterHidden.yaw - yawBeforeHidden).toFixed(3)}`,
  );

  // Simultaneous two-finger touch (left stick + right drag look) in portrait.
  const beforeDual = await page.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z, yaw: __game.player.yaw }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 95, y: 610, id: 10 }] });
  await sleep(40);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 95, y: 610, id: 10 },
      { x: 310, y: 380, id: 11 },
    ],
  });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: 95, y: 610 - Math.min(54, i * 8), id: 10 },
        { x: 310 - i * 8, y: 380, id: 11 },
      ],
    });
    await sleep(70);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: 95, y: 556, id: 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  const afterDual = await page.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z, yaw: __game.player.yaw }));
  const dualDist = Math.hypot(afterDual.x - beforeDual.x, afterDual.z - beforeDual.z);
  const dualYaw = Math.abs(afterDual.yaw - beforeDual.yaw);
  check('touch.portraitDualStickLook', dualDist > 0.5 && dualYaw > 0.2, `dist=${dualDist.toFixed(3)}m yawDelta=${dualYaw.toFixed(3)}rad`);

  // Item 1: holding Time button must NOT be stolen as look finger when canvas is touched,
  // and a subsequent right-half canvas finger must still drive look.
  const timeBtn = await getCenter(page, '#btnTimeBoost');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: timeBtn.x, y: timeBtn.y, id: 20 }] });
  await sleep(80);
  // Touch left canvas while Time is held: on buggy code, canvas touchstart scans e.touches and steals id 20 as lookTouchId.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: timeBtn.x, y: timeBtn.y, id: 20 },
      { x: 95, y: 610, id: 21 },
    ],
  });
  await sleep(60);
  const yawBeforeLookWithTime = await page.evaluate(() => __game.player.yaw);
  // Add a third finger on the right canvas half to look while Time (id 20) and stick (id 21) are held.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: timeBtn.x, y: timeBtn.y, id: 20 },
      { x: 95, y: 610, id: 21 },
      { x: 310, y: 360, id: 22 },
    ],
  });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: timeBtn.x, y: timeBtn.y, id: 20 },
        { x: 95, y: 610, id: 21 },
        { x: 310 - i * 10, y: 360, id: 22 },
      ],
    });
    await sleep(50);
  }
  const duringTimeLook = await page.evaluate(() => ({
    yaw: __game.player.yaw,
    timeBoostHeld: __game.input.isHeld('timeBoost'),
    timeScale: __game.env.timeScale,
  }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  const timeLookYaw = Math.abs(duringTimeLook.yaw - yawBeforeLookWithTime);
  check(
    'item1.timeHeldThenLook',
    duringTimeLook.timeBoostHeld && timeLookYaw > 0.2,
    `timeBoostHeld=${duringTimeLook.timeBoostHeld} timeScale=${duringTimeLook.timeScale.toFixed(1)} yawDelta=${timeLookYaw.toFixed(3)}rad`,
  );

  // Item 7 extension: a game-defined action ("interact") bound at createInput time supports
  // both tap (fires once on press) and hold (isHeld true while real touch is down, with press/release
  // callbacks), plus dynamic add/show/hide touch button cleared on rotation.
  const customHidden = await page.evaluate(async () => {
    const { createInput } = await import('/src/engine/input.js');
    const canvas = document.getElementById('c');
    const extInput = createInput({
      touchSurface: canvas,
      keyActions: { KeyE: { action: 'interact', repeat: false } },
      holdKeys: { KeyE: 'interact' },
    });
    extInput.setActive(true);
    const stats = { taps: 0, presses: 0, releases: 0 };
    extInput.onAction('interact', () => { stats.taps++; });
    extInput.onPress('interact', () => { stats.presses++; });
    extInput.onRelease('interact', () => { stats.releases++; });
    const btn = __game.ui.addTouchButton({ id: 'btnCustomInteract', label: 'Use', visible: false });
    const hiddenDisplay = getComputedStyle(btn.el).display;
    btn.setVisible(true);
    const visibleDisplay = getComputedStyle(btn.el).display;
    const unbind = extInput.bindButton(btn.el, { action: 'interact', tap: true, hold: true });
    window.__customActionTest = { extInput, btn, unbind, stats };
    return { hiddenDisplay, visibleDisplay };
  });
  const customPos = await getCenter(page, '#btnCustomInteract');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: customPos.x, y: customPos.y, id: 25 }] });
  await sleep(60);
  const customDown = await page.evaluate(() => {
    const t = window.__customActionTest;
    return { held: t.extInput.isHeld('interact'), pressed: t.btn.el.classList.contains('pressed'), ...t.stats };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(50);
  const customUp = await page.evaluate(() => {
    const t = window.__customActionTest;
    return { held: t.extInput.isHeld('interact'), pressed: t.btn.el.classList.contains('pressed'), ...t.stats };
  });
  // Hold again and clear via blur to confirm press/release + hold clear on lifecycle events.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: customPos.x, y: customPos.y, id: 26 }] });
  await sleep(40);
  const customAfterBlur = await page.evaluate(() => {
    const t = window.__customActionTest;
    const heldBefore = t.extInput.isHeld('interact');
    window.dispatchEvent(new Event('blur'));
    const out = {
      heldBefore,
      heldAfter: t.extInput.isHeld('interact'),
      pressedAfter: t.btn.el.classList.contains('pressed'),
      ...t.stats,
    };
    t.unbind();
    t.btn.remove();
    t.extInput.dispose();
    delete window.__customActionTest;
    return out;
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const customOk =
    customHidden.hiddenDisplay === 'none' &&
    customHidden.visibleDisplay !== 'none' &&
    customDown.taps === 1 &&
    customDown.presses === 1 &&
    customDown.releases === 0 &&
    customDown.held === true &&
    customDown.pressed === true &&
    customUp.held === false &&
    customUp.pressed === false &&
    customUp.releases === 1 &&
    customAfterBlur.heldBefore === true &&
    customAfterBlur.heldAfter === false &&
    customAfterBlur.pressedAfter === false &&
    customAfterBlur.releases === 2;
  check(
    'item7.customActionTapHold',
    customOk,
    JSON.stringify({ customHidden, customDown, customUp, customAfterBlur }),
  );

  // Item 3: rotation while stick and Time button are held must clear stick, look, held buttons, and button visuals.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 95, y: 620, id: 30 }] });
  await sleep(40);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 95, y: 620, id: 30 },
      { x: timeBtn.x, y: timeBtn.y, id: 31 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 95, y: 560, id: 30 },
      { x: timeBtn.x, y: timeBtn.y, id: 31 },
    ],
  });
  await sleep(250);
  const beforeRotate = await page.evaluate(() => ({
    moveY: __game.input.getMove().y,
    stickActive: document.getElementById('touchStick').classList.contains('active'),
    timeHeld: __game.input.isHeld('timeBoost'),
    timePressed: document.getElementById('btnTimeBoost').classList.contains('pressed'),
  }));
  // Rotate viewport to landscape (844x390) and fire orientationchange WITHOUT touchEnd.
  await page.setViewport(LANDSCAPE);
  await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
  await sleep(450);
  const afterRotate = await page.evaluate(() => ({
    move: __game.input.getMove(),
    stickActive: document.getElementById('touchStick').classList.contains('active'),
    timeHeld: __game.input.isHeld('timeBoost'),
    timePressed: document.getElementById('btnTimeBoost').classList.contains('pressed'),
  }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(200);
  const rotOk =
    beforeRotate.moveY > 0.5 &&
    beforeRotate.stickActive &&
    afterRotate.move.x === 0 &&
    afterRotate.move.y === 0 &&
    !afterRotate.stickActive &&
    !afterRotate.timeHeld &&
    !afterRotate.timePressed;
  check('item3.rotationClearsHeld', rotOk, `before=${JSON.stringify(beforeRotate)} after=${JSON.stringify(afterRotate)}`);
  await checkLayout(page, 'landscape-play');

  // Simultaneous two-finger touch in landscape (844x390).
  const beforeLand = await page.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z, yaw: __game.player.yaw }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 240, id: 40 }] });
  await sleep(40);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 150, y: 240, id: 40 },
      { x: 640, y: 170, id: 41 },
    ],
  });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: 150, y: 240 - Math.min(54, i * 8), id: 40 },
        { x: 640 - i * 10, y: 170, id: 41 },
      ],
    });
    await sleep(70);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: 150, y: 186, id: 40 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(250);
  const afterLand = await page.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z, yaw: __game.player.yaw }));
  const landDist = Math.hypot(afterLand.x - beforeLand.x, afterLand.z - beforeLand.z);
  const landYaw = Math.abs(afterLand.yaw - beforeLand.yaw);
  check('touch.landscapeDualStickLook', landDist > 0.5 && landYaw > 0.2, `dist=${landDist.toFixed(3)}m yawDelta=${landYaw.toFixed(3)}rad`);

  // Pause and resume by tap in landscape without pointer lock.
  const pauseBtn = await getCenter(page, '#btnPause');
  await cdpTap(cdp, pauseBtn.x, pauseBtn.y);
  await sleep(250);
  const pausedLand = await page.evaluate(() => __game.session.paused);
  check('touch.pauseByTap', pausedLand === true, `paused=${pausedLand}`);
  await checkLayout(page, 'landscape-paused');
  const resumeBtn = await getCenter(page, '#resumeBtn');
  await cdpTap(cdp, resumeBtn.x, resumeBtn.y);
  await sleep(250);
  const resumedLand = await page.evaluate(() => ({ paused: __game.session.paused, pointerLock: document.pointerLockElement !== null }));
  check('touch.resumeByTap', !resumedLand.paused && !resumedLand.pointerLock, JSON.stringify(resumedLand));

  await page.close();

  // ===== 2. Desktop Regression (1280x720: WASD, Q, repeat, paused shortcuts, Escape) =====
  const dPage = await browser.newPage();
  await dPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  const dCdp = await dPage.createCDPSession();

  dPage.on('pageerror', (e) => errs.push('desktop pageerror: ' + e.message));
  dPage.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errs.push('desktop console.error: ' + m.text());
  });

  await dPage.goto(`${BASE}?q=low`, { waitUntil: 'load', timeout: 120000 });
  await dPage.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 250 });
  await sleep(800);

  await dPage.mouse.click(640, 360);
  await dPage.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 15000, polling: 100 });
  await sleep(250);

  // WASD movement.
  const dP0 = await dPage.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z }));
  await dPage.keyboard.down('KeyW');
  await sleep(2000);
  await dPage.keyboard.up('KeyW');
  await sleep(150);
  const dP1 = await dPage.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z }));
  const dWDist = Math.hypot(dP1.x - dP0.x, dP1.z - dP0.z);
  check('desktop.wasd', dWDist > 0.5, `wDist=${dWDist.toFixed(3)}m`);

  // Item 5a: held key repeat for Q (autoWalk) and F (headlamp) via real CDP Input.dispatchKeyEvent.
  const repeatBefore = await dPage.evaluate(() => ({ autoWalk: __game.player.autoWalk, toast: document.getElementById('toast').textContent }));
  await dCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, autoRepeat: false });
  await dCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, autoRepeat: true });
  await dCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81 });
  const autoWalkAfterRepeat = await dPage.evaluate(() => __game.player.autoWalk);
  // First press toggled false->true; autoRepeat toggled true->false back to initial state.
  await dCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, autoRepeat: false });
  const lampToast1 = await dPage.evaluate(() => document.getElementById('toast').textContent);
  await dCdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, autoRepeat: true });
  const lampToast2 = await dPage.evaluate(() => document.getElementById('toast').textContent);
  await dCdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
  const repeatOk =
    repeatBefore.autoWalk === false &&
    autoWalkAfterRepeat === false &&
    lampToast1 === 'Headlamp on' &&
    lampToast2 === 'Headlamp off';
  check('item5.keyRepeat', repeatOk, `autoWalk=${repeatBefore.autoWalk}->${autoWalkAfterRepeat} lamp=${lampToast1}->${lampToast2}`);

  // Item 5b: Escape pauses; while paused, F/H/M/[/] still work while movement/holds stay cleared.
  await dPage.keyboard.down('KeyW');
  await dPage.keyboard.press('Escape');
  await sleep(200);
  const pausedState = await dPage.evaluate(() => ({
    paused: __game.session.paused,
    move: __game.input.getMove(),
    hours0: __game.env.hours,
    music0: __game.audio.musicOn,
    photo0: document.body.classList.contains('photo'),
  }));
  await dPage.keyboard.up('KeyW');

  await dPage.keyboard.press('KeyF');
  const pausedLamp = await dPage.evaluate(() => document.getElementById('toast').textContent);
  await dPage.keyboard.press('KeyH');
  const pausedPhoto = await dPage.evaluate(() => document.body.classList.contains('photo'));
  await dPage.keyboard.press('KeyM');
  const pausedMusic = await dPage.evaluate(() => __game.audio.musicOn);
  await dPage.keyboard.press('BracketRight');
  const hoursAfterRight = await dPage.evaluate(() => __game.env.hours);
  await dPage.keyboard.press('BracketLeft');
  const hoursAfterLeft = await dPage.evaluate(() => __game.env.hours);

  const dHourFwd = ((hoursAfterRight - pausedState.hours0) + 24) % 24;
  const dHourBack = Math.abs(hoursAfterLeft - pausedState.hours0);
  const pausedShortcutsOk =
    pausedState.paused &&
    pausedState.move.x === 0 &&
    pausedState.move.y === 0 &&
    pausedLamp === 'Headlamp on' &&
    pausedPhoto !== pausedState.photo0 &&
    pausedMusic !== pausedState.music0 &&
    Math.abs(dHourFwd - 0.5) < 0.05 &&
    dHourBack < 0.05;
  check(
    'item5.pausedShortcuts',
    pausedShortcutsOk,
    `paused=${pausedState.paused} move=${JSON.stringify(pausedState.move)} lamp=${pausedLamp} photo=${pausedState.photo0}->${pausedPhoto} music=${pausedState.music0}->${pausedMusic} dHourFwd=${dHourFwd.toFixed(2)}`,
  );

  // Restore toggles and click pause overlay to resume.
  await dPage.keyboard.press('KeyH');
  await dPage.keyboard.press('KeyM');
  await dPage.keyboard.press('KeyF');
  await dPage.mouse.click(640, 360);
  await sleep(300);
  const dResumed = await dPage.evaluate(() => __game.session.paused);
  check('desktop.resume', dResumed === false, `paused=${dResumed}`);

  await dPage.close();
} finally {
  await browser.close();
}

check('runtime.errs', errs.length === 0, errs.join('; ') || '[]');
console.log(JSON.stringify({ renderer, checks, failures, errs }, null, 2));

if (failures.length > 0 || errs.length > 0) {
  process.exit(1);
}
