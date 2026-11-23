// Real-browser touch and desktop input test.
// Drives real CDP touch events (Input.dispatchTouchEvent) and key events at iPhone portrait
// (390x844), iPhone landscape (844x390) and desktop (1280x720). Chrome is launched through
// tools/chrome.mjs, so every run waits for the shared GPU lock.
//
// Usage: BASE=http://127.0.0.1:<port>/ node tools/touchtest.mjs
// Optional SHOTS=<dir> saves touch-portrait.png and touch-landscape.png during play.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './chrome.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const SHOTS = process.env.SHOTS || '';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PORTRAIT = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false };
const LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const checks = {};
const errs = [];

function check(name, cond, detail = '') {
  checks[name] = { ok: !!cond, detail };
  if (!cond) failures.push(`${name}: ${detail}`);
}

// A thrown error inside one scenario fails that scenario only, so older builds still report per item.
async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw: ${String(e?.message || e).split('\n')[0]}`);
  }
}

async function checkLayout(page, label) {
  const report = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const issues = [];
    const c = document.getElementById('c').getBoundingClientRect();
    if (Math.abs(c.width - vw) > 1 || Math.abs(c.height - vh) > 1) issues.push(`canvas ${c.width}x${c.height} != ${vw}x${vh}`);
    if (document.documentElement.scrollWidth > vw) issues.push(`scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
    if (document.documentElement.scrollHeight > vh) issues.push(`scrollHeight ${document.documentElement.scrollHeight} > ${vh}`);
    for (const id of ['compass', 'stats', 'btnPause', 'touchActions']) {
      const el = document.getElementById(id);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) {
        issues.push(`#${id} out of bounds (${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)})`);
      }
    }
    return { vw, vh, issues };
  });
  check(`layout.${label}`, report.issues.length === 0, report.issues.join('; ') || `${report.vw}x${report.vh} ok`);
}

async function center(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
}

const touch = (cdp, type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
async function tap(cdp, x, y) {
  await touch(cdp, 'touchStart', [{ x, y, id: 1 }]);
  await sleep(30);
  await touch(cdp, 'touchEnd', []);
}
const key = (cdp, type, code, keyName, vk, autoRepeat = false) =>
  cdp.send('Input.dispatchKeyEvent', { type, code, key: keyName, windowsVirtualKeyCode: vk, autoRepeat });

const pose = (page) => page.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z, yaw: __game.player.yaw }));

async function dualStickLook(page, cdp, stick, look, label) {
  const before = await pose(page);
  await touch(cdp, 'touchStart', [{ ...stick, id: 10 }]);
  await sleep(40);
  await touch(cdp, 'touchStart', [{ ...stick, id: 10 }, { ...look, id: 11 }]);
  for (let i = 1; i <= 12; i++) {
    await touch(cdp, 'touchMove', [
      { x: stick.x, y: stick.y - Math.min(54, i * 8), id: 10 },
      { x: look.x - i * 9, y: look.y, id: 11 },
    ]);
    await sleep(70);
  }
  await touch(cdp, 'touchEnd', []);
  await sleep(250);
  const after = await pose(page);
  const dist = Math.hypot(after.x - before.x, after.z - before.z);
  const yaw = Math.abs(after.yaw - before.yaw);
  check(`touch.${label}StickAndLook`, dist > 0.5 && yaw > 0.2, `dist=${dist.toFixed(2)}m yawDelta=${yaw.toFixed(3)}`);
}

function watchErrors(page, label) {
  page.on('pageerror', (e) => errs.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errs.push(`${label} console.error: ${m.text().slice(0, 200)}`);
  });
}

async function boot(page) {
  await page.goto(`${BASE}?q=low`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 250 });
  const initErr = await page.evaluate(() => window.__error || null);
  if (initErr) throw new Error(`init: ${initErr}`);
  await sleep(800);
}

const { browser, renderer } = await launchBrowser();

try {
  // ---------- iPhone: portrait, then rotate to landscape ----------
  const page = await browser.newPage();
  watchErrors(page, 'touch');
  await page.emulate({ userAgent: IOS_UA, viewport: PORTRAIT });
  const cdp = await page.createCDPSession();
  await boot(page);
  await checkLayout(page, 'portrait-title');

  await scenario('touch.tapToStart', async () => {
    await tap(cdp, 195, 650);
    await page.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 15000, polling: 100 });
    await sleep(600);
    const s = await page.evaluate(() => ({
      pointerLock: document.pointerLockElement !== null,
      audioStarted: __game.audio?.started,
      audioState: __game.audio?.ctx?.state,
      touchUi: getComputedStyle(document.getElementById('touchControls')).display !== 'none',
    }));
    check('touch.tapToStart', !s.pointerLock && s.audioStarted && s.audioState === 'running' && s.touchUi, JSON.stringify(s));
  });
  await checkLayout(page, 'portrait-play');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'touch-portrait.png') });
  }

  await scenario('touch.portraitStickAndLook', () => dualStickLook(page, cdp, { x: 95, y: 610 }, { x: 310, y: 380 }, 'portrait'));

  // Item 2: a drag that starts where the hidden pause menu's quality options sit must reach the canvas.
  await scenario('item2.dragOverHiddenQualityOptions', async () => {
    const spot = await page.evaluate(() => {
      const r = document.querySelector('#qual span[data-q="ultra"]').getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: `${hit?.tagName}#${hit?.id}`, half: innerWidth / 2 };
    });
    // Start on the right half so the drag must turn the view.
    const x0 = Math.max(spot.x, Math.ceil(spot.half) + 20);
    const q0 = await page.evaluate(() => location.search);
    const yaw0 = (await pose(page)).yaw;
    await touch(cdp, 'touchStart', [{ x: x0, y: spot.y, id: 2 }]);
    for (let i = 1; i <= 12; i++) {
      await touch(cdp, 'touchMove', [{ x: x0 - i * 9, y: spot.y, id: 2 }]);
      await sleep(40);
    }
    await touch(cdp, 'touchEnd', []);
    await sleep(300);
    const yaw1 = (await pose(page)).yaw;
    const q1 = await page.evaluate(() => location.search);
    const dyaw = Math.abs(yaw1 - yaw0);
    check('item2.dragOverHiddenQualityOptions', spot.hit === 'CANVAS#c' && q1 === q0 && dyaw > 0.1, `hit=${spot.hit} search=${q0}->${q1} yawDelta=${dyaw.toFixed(3)}`);
  });

  // Item 1: with Time held, a stick finger lands on the canvas, then a look finger. The Time finger
  // (right half) must not be claimed as the look finger by the stick finger's touchstart.
  await scenario('item1.timeHeldThenLook', async () => {
    const time = await center(page, '#btnTimeBoost');
    const stick = { x: 95, y: 610, id: 21 };
    await touch(cdp, 'touchStart', [{ ...time, id: 20 }]);
    await sleep(80);
    await touch(cdp, 'touchStart', [{ ...time, id: 20 }, stick]);
    await sleep(60);
    const yaw0 = (await pose(page)).yaw;
    await touch(cdp, 'touchStart', [{ ...time, id: 20 }, stick, { x: 300, y: 330, id: 22 }]);
    for (let i = 1; i <= 10; i++) {
      await touch(cdp, 'touchMove', [{ ...time, id: 20 }, stick, { x: 300 - i * 10, y: 330, id: 22 }]);
      await sleep(50);
    }
    const during = await page.evaluate(() => ({ yaw: __game.player.yaw, timeHeld: __game.input.isHeld('timeBoost') }));
    await touch(cdp, 'touchEnd', []);
    await sleep(200);
    const dyaw = Math.abs(during.yaw - yaw0);
    check('item1.timeHeldThenLook', during.timeHeld && dyaw > 0.2, `timeHeld=${during.timeHeld} yawDelta=${dyaw.toFixed(3)}`);
  });

  // Item 7b: a game-defined "interact" action added at createInput time, next to the game's own bindings,
  // with a touch button made through the UI. The engine module is not edited for it.
  await scenario('item7b.gameDefinedInteract', async () => {
    const shown = await page.evaluate(async () => {
      const { createInput } = await import('/src/engine/input.js');
      const { GAME_INPUT_BINDINGS: G } = await import('/src/game/session.js');
      const input = createInput({
        touchSurface: document.getElementById('c'),
        ...G,
        keyActions: { ...G.keyActions, KeyE: [G.keyActions.KeyE, { action: 'interact', repeat: false }] },
        holdKeys: { ...G.holdKeys, KeyE: 'interact' },
      });
      input.setActive(true);
      const stats = { taps: 0, presses: 0, releases: 0 };
      input.onAction('interact', () => stats.taps++);
      input.onPress('interact', () => stats.presses++);
      input.onRelease('interact', () => stats.releases++);
      const btn = __game.ui.addTouchButton({ id: 'btnInteract', label: 'Use', visible: false });
      const hidden = getComputedStyle(btn.el).display;
      btn.setVisible(true);
      const visible = getComputedStyle(btn.el).display;
      input.bindButton(btn.el, { action: 'interact', tap: true, hold: true });
      window.__interactTest = { input, btn, stats };
      return { hidden, visible };
    });
    const pos = await center(page, '#btnInteract');
    const read = () => page.evaluate(() => {
      const t = window.__interactTest;
      return { held: t.input.isHeld('interact'), pressed: t.btn.el.classList.contains('pressed'), ...t.stats };
    });
    await touch(cdp, 'touchStart', [{ ...pos, id: 25 }]);
    await sleep(300);
    const down = await read();
    await touch(cdp, 'touchEnd', []);
    await sleep(80);
    const up = await read();

    const sit0 = await page.evaluate(() => !!__game.player.sitting);
    await key(cdp, 'keyDown', 'KeyE', 'e', 69);
    await sleep(80);
    const keyDown = await read();
    const sit1 = await page.evaluate(() => !!__game.player.sitting);
    await key(cdp, 'keyUp', 'KeyE', 'e', 69);
    await sleep(80);
    const keyUp = await read();
    // Stand back up so later walking checks move.
    await key(cdp, 'keyDown', 'KeyE', 'e', 69);
    await key(cdp, 'keyUp', 'KeyE', 'e', 69);
    await sleep(80);

    const ok =
      shown.hidden === 'none' && shown.visible !== 'none' &&
      down.held && down.pressed && down.taps === 1 && down.presses === 1 && down.releases === 0 &&
      !up.held && !up.pressed && up.taps === 1 && up.releases === 1 &&
      keyDown.held && keyDown.taps === 2 && keyDown.presses === 2 && !keyUp.held && keyUp.releases === 2 &&
      sit0 === false && sit1 === true;
    check('item7b.gameDefinedInteract', ok, JSON.stringify({ shown, down, up, keyDown, keyUp, sitByE: `${sit0}->${sit1}` }));
  });

  // Item 3: rotate with the stick, Time and interact held, without lifting fingers; all must clear.
  await scenario('item3.rotationClearsHolds', async () => {
    const time = await center(page, '#btnTimeBoost');
    const hasInteract = await page.evaluate(() => !!window.__interactTest);
    const use = hasInteract ? await center(page, '#btnInteract') : null;
    await touch(cdp, 'touchStart', [{ x: 95, y: 620, id: 30 }]);
    await sleep(40);
    await touch(cdp, 'touchStart', [{ x: 95, y: 620, id: 30 }, { ...time, id: 31 }]);
    const fingers = [{ x: 95, y: 560, id: 30 }, { ...time, id: 31 }];
    if (use) {
      await touch(cdp, 'touchStart', [{ x: 95, y: 620, id: 30 }, { ...time, id: 31 }, { ...use, id: 32 }]);
      fingers.push({ ...use, id: 32 });
    }
    await touch(cdp, 'touchMove', fingers);
    await sleep(250);
    const state = () => page.evaluate(() => ({
      move: __game.input.getMove(),
      stick: document.getElementById('touchStick').classList.contains('active'),
      timeHeld: __game.input.isHeld('timeBoost'),
      timePressed: document.getElementById('btnTimeBoost').classList.contains('pressed'),
      interactHeld: window.__interactTest ? window.__interactTest.input.isHeld('interact') : null,
      interactPressed: window.__interactTest ? window.__interactTest.btn.el.classList.contains('pressed') : null,
    }));
    const before = await state();
    await page.setViewport(LANDSCAPE);
    await sleep(500);
    const after = await state();
    await touch(cdp, 'touchEnd', []);
    await sleep(200);
    const ok =
      before.move.y > 0.5 && before.stick && before.timeHeld &&
      after.move.x === 0 && after.move.y === 0 && !after.stick && !after.timeHeld && !after.timePressed &&
      (!hasInteract || (before.interactHeld && !after.interactHeld && !after.interactPressed));
    check('item3.rotationClearsHolds', ok, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  });
  await page.evaluate(() => {
    const t = window.__interactTest;
    if (!t) return;
    t.input.dispose();
    t.btn.remove();
    delete window.__interactTest;
  }).catch(() => {});
  await page.setViewport(LANDSCAPE);
  await sleep(300);
  await checkLayout(page, 'landscape-play');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'touch-landscape.png') });

  await scenario('touch.landscapeStickAndLook', () => dualStickLook(page, cdp, { x: 150, y: 260 }, { x: 640, y: 170 }, 'landscape'));

  await scenario('touch.pauseAndResumeByTap', async () => {
    const p = await center(page, '#btnPause');
    await tap(cdp, p.x, p.y);
    await sleep(300);
    const paused = await page.evaluate(() => __game.session.paused);
    await checkLayout(page, 'landscape-paused');
    const r = await center(page, '#resumeBtn');
    await tap(cdp, r.x, r.y);
    await sleep(300);
    const resumed = await page.evaluate(() => ({ paused: __game.session.paused, lock: document.pointerLockElement !== null }));
    check('touch.pauseAndResumeByTap', paused === true && !resumed.paused && !resumed.lock, `paused=${paused} after=${JSON.stringify(resumed)}`);
  });
  await page.close();

  // ---------- Desktop: keyboard rules unchanged from the base game ----------
  const dPage = await browser.newPage();
  watchErrors(dPage, 'desktop');
  await dPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  const dcdp = await dPage.createCDPSession();
  await boot(dPage);
  await dPage.mouse.click(640, 360);
  await dPage.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 15000, polling: 100 });
  await sleep(300);

  await scenario('desktop.walkW', async () => {
    const p0 = await pose(dPage);
    await dPage.keyboard.down('KeyW');
    await sleep(1500);
    await dPage.keyboard.up('KeyW');
    await sleep(150);
    const p1 = await pose(dPage);
    const d = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    check('desktop.walkW', d > 0.5, `dist=${d.toFixed(2)}m`);
  });

  // Item 5a: a held key's auto-repeat toggles again, as in the base game.
  await scenario('item5.keyRepeat', async () => {
    const toast = () => dPage.evaluate(() => document.getElementById('toast').textContent);
    const aw0 = await dPage.evaluate(() => __game.player.autoWalk);
    await key(dcdp, 'keyDown', 'KeyQ', 'q', 81);
    const aw1 = await dPage.evaluate(() => __game.player.autoWalk);
    await key(dcdp, 'keyDown', 'KeyQ', 'q', 81, true);
    const aw2 = await dPage.evaluate(() => __game.player.autoWalk);
    await key(dcdp, 'keyUp', 'KeyQ', 'q', 81);
    await key(dcdp, 'keyDown', 'KeyF', 'f', 70);
    const lamp1 = await toast();
    await key(dcdp, 'keyDown', 'KeyF', 'f', 70, true);
    const lamp2 = await toast();
    await key(dcdp, 'keyUp', 'KeyF', 'f', 70);
    const ok = aw1 === !aw0 && aw2 === aw0 && lamp1 === 'Headlamp on' && lamp2 === 'Headlamp off';
    check('item5.keyRepeat', ok, `autoWalk ${aw0}->${aw1}->${aw2} lamp "${lamp1}"->"${lamp2}"`);
  });

  // Item 5b: Escape pauses and clears held movement; F/H/M/[/] still work while paused.
  await scenario('item5.pausedShortcuts', async () => {
    await dPage.keyboard.down('KeyW');
    await sleep(100);
    await dPage.keyboard.press('Escape');
    await sleep(200);
    const s0 = await dPage.evaluate(() => ({
      paused: __game.session.paused, move: __game.input.getMove(), hours: __game.env.hours,
      music: __game.audio.musicOn, photo: document.body.classList.contains('photo'),
    }));
    await dPage.keyboard.up('KeyW');
    await dPage.keyboard.press('KeyF');
    const lamp = await dPage.evaluate(() => document.getElementById('toast').textContent);
    await dPage.keyboard.press('KeyH');
    const photo = await dPage.evaluate(() => document.body.classList.contains('photo'));
    await dPage.keyboard.press('KeyM');
    const music = await dPage.evaluate(() => __game.audio.musicOn);
    await dPage.keyboard.press('BracketRight');
    const hF = await dPage.evaluate(() => __game.env.hours);
    await dPage.keyboard.press('BracketLeft');
    const hB = await dPage.evaluate(() => __game.env.hours);
    const fwd = (hF - s0.hours + 24) % 24;
    const ok = s0.paused && s0.move.x === 0 && s0.move.y === 0 && lamp === 'Headlamp on' &&
      photo !== s0.photo && music !== s0.music && Math.abs(fwd - 0.5) < 0.05 && Math.abs(hB - s0.hours) < 0.05;
    check('item5.pausedShortcuts', ok, `paused=${s0.paused} move=${JSON.stringify(s0.move)} lamp="${lamp}" photo ${s0.photo}->${photo} music ${s0.music}->${music} hoursFwd=${fwd.toFixed(2)}`);
    await dPage.keyboard.press('KeyH');
    await dPage.keyboard.press('KeyM');
    await dPage.keyboard.press('KeyF');
  });

  await scenario('desktop.resumeByClick', async () => {
    await dPage.mouse.click(640, 360);
    await sleep(400);
    const paused = await dPage.evaluate(() => __game.session.paused);
    check('desktop.resumeByClick', paused === false, `paused=${paused}`);
  });
  await dPage.close();
} catch (e) {
  check('run', false, String(e?.message || e));
} finally {
  await browser.close();
}

check('runtime.errs', errs.length === 0, errs.join('; ') || '[]');
console.log(JSON.stringify({ renderer, checks, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
