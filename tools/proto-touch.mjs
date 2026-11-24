// Real-browser iPhone touch gameplay verification (390x844, touch emulation, GL_PROFILE=iphone).
// Uses real CDP Input.dispatchTouchEvent events to tap-to-start, walk with the floating stick,
// complete all 5 beats (hold tasks via #btnInteract hold, tap tasks via #btnInteract tap,
// trail lamps via stick walk), tap the radio box, reach the jetty End Card without pointer lock
// or pause-screen bleed, and tap "Keep walking". Saves 390x844 screenshots under
// proto-evidence/release-1/.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './chrome.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const OUT_DIR = path.resolve(process.env.OUT || 'proto-evidence/release-1');
fs.mkdirSync(OUT_DIR, { recursive: true });

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PORTRAIT = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextTouchId = 1;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const touch = (cdp, type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });

async function tapAt(cdp, x, y, holdMs = 45) {
  const id = nextTouchId++;
  await touch(cdp, 'touchStart', [{ x, y, id }]);
  await sleep(holdMs);
  await touch(cdp, 'touchEnd', []);
}

async function center(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  });
}

async function tapSelector(page, cdp, selector, holdMs = 45) {
  const pt = await center(page, selector);
  assert(pt.w > 0 && pt.h > 0, `element ${selector} has zero size (${pt.w}x${pt.h})`);
  await tapAt(cdp, pt.x, pt.y, holdMs);
}

async function holdSelectorUntil(page, cdp, selector, fnExpr, timeoutMs = 7000) {
  const pt = await center(page, selector);
  assert(pt.w > 0 && pt.h > 0, `element ${selector} has zero size (${pt.w}x${pt.h})`);
  const id = nextTouchId++;
  await touch(cdp, 'touchStart', [{ x: pt.x, y: pt.y, id }]);
  try {
    await page.waitForFunction(fnExpr, { timeout: timeoutMs, polling: 100 });
  } finally {
    await touch(cdp, 'touchEnd', []);
  }
}

async function walkStickUntil(page, cdp, fnExpr, timeoutMs = 10000, arg = undefined, origin = { x: 95, y: 620 }, dy = -60) {
  const id = nextTouchId++;
  await touch(cdp, 'touchStart', [{ x: origin.x, y: origin.y, id }]);
  await sleep(40);
  await touch(cdp, 'touchMove', [{ x: origin.x, y: Math.round(origin.y + dy), id }]);
  try {
    if (arg === undefined) {
      await page.waitForFunction(fnExpr, { timeout: timeoutMs, polling: 100 });
    } else {
      await page.waitForFunction(fnExpr, { timeout: timeoutMs, polling: 100 }, arg);
    }
  } finally {
    await touch(cdp, 'touchEnd', []);
    await sleep(150);
  }
}

const { browser, renderer, isSoftware, glProfile } = await launchBrowser([], { glProfile: 'iphone' });
const errs = [];

try {
  const page = await browser.newPage();
  const baseOrigin = new URL(BASE).origin;
  await page.emulate({ userAgent: IOS_UA, viewport: PORTRAIT });
  const cdp = await page.createCDPSession();

  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const loc = m.location()?.url || '';
    if (text.includes('404')) return;
    if (loc && !loc.startsWith(baseOrigin)) return;
    if (/Failed to load resource: net::ERR_/i.test(text) && !loc.startsWith(baseOrigin)) return;
    errs.push('console.error: ' + text.slice(0, 300));
  });

  console.log(`[proto-touch] renderer=${renderer} software=${isSoftware} glProfile=${glProfile} viewport=${PORTRAIT.width}x${PORTRAIT.height}`);
  await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__proto && window.__game || window.__error', { timeout: 120000, polling: 250 });

  const initErr = await page.evaluate(() => window.__error || null);
  assert(!initErr, `window.__error on boot: ${initErr}`);

  // Start play by real touch tap on title screen (no pointer lock!)
  await sleep(700);
  await tapAt(cdp, 195, 650);
  await page.waitForFunction('window.__proto.state().playerEnabled === true', { timeout: 15000, polling: 100 });
  await sleep(700);

  const bootState = await page.evaluate(() => ({
    pointerLock: document.pointerLockElement !== null,
    isTouch: __game.input.isTouch,
    touchUi: getComputedStyle(document.getElementById('touchControls')).display !== 'none',
    audioStarted: __game.audio.started,
    focused: window.__proto.state().focused,
    interactBtn: window.__proto.state().interactBtn,
  }));
  assert(!bootState.pointerLock, 'touch start must not acquire pointer lock');
  assert(bootState.isTouch && bootState.touchUi, `touch UI not active: ${JSON.stringify(bootState)}`);
  assert(
    bootState.interactBtn.visible === !!bootState.focused,
    `interact button visibility must match focus at start: ${JSON.stringify(bootState)}`,
  );

  const getState = () => page.evaluate(() => window.__proto.state());
  const getSites = () => page.evaluate(() => window.__proto.sites());
  const teleportLook = (x, z, tx, ty, tz) =>
    page.evaluate(
      ({ x, z, tx, ty, tz }) => {
        window.__proto.teleport(x, z);
        window.__proto.lookAt(tx, ty, tz);
      },
      { x, z, tx, ty, tz },
    );
  const waitFocus = (id, timeout = 5000) =>
    page.waitForFunction((want) => window.__proto.state().focused?.id === want, { timeout, polling: 80 }, id);

  // Move with the floating left-half touch stick
  {
    const before = (await getState()).pos;
    await walkStickUntil(
      page,
      cdp,
      (p0) => {
        const p = window.__proto.state().pos;
        return Math.hypot(p.x - p0.x, p.z - p0.z) > 0.8;
      },
      8000,
      before,
    );
    const after = (await getState()).pos;
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    assert(moved > 0.5, `stick walk moved only ${moved.toFixed(2)}m`);
    console.log(`[proto-touch] Stick walk OK · moved=${moved.toFixed(2)}m`);
  }

  const sites = await getSites();

  // ---- BEAT 1: SIGNPOST (HOLD task via #btnInteract) ----
  {
    const sp = sites.signpost;
    await teleportLook(sp.x + 1.8, sp.z + 2.6, sp.x, sp.y + 1.25, sp.z);
    await waitFocus('signpost');
    const sBefore = await getState();
    assert(sBefore.focused?.id === 'signpost', `expected focus signpost, got ${JSON.stringify(sBefore.focused)}`);
    assert(sBefore.interactBtn.visible && sBefore.interactBtn.label === 'Straighten signpost', `unexpected touch btn: ${JSON.stringify(sBefore.interactBtn)}`);

    await holdSelectorUntil(page, cdp, '#btnInteract', 'window.__proto.state().signpostFixed === true');
    await sleep(900);

    const sAfter = await getState();
    assert(sAfter.signpostFixed === true, 'signpost should be fixed after holding #btnInteract');
    assert(!sAfter.interactBtn.visible, 'interact button should hide once signpost is fixed');
    await page.screenshot({ path: path.join(OUT_DIR, 'touch-01-signpost-after.png') });
    console.log(`[proto-touch] Beat 1 Signpost (hold) OK · caption="${sAfter.ui.captionText}"`);
  }

  // ---- BEAT 2: COTTAGE HEARTH (HOLD task via #btnInteract + radio tap) ----
  {
    const h = sites.hearth;
    const [fx, fz] = h.front;
    const rx = -fz, rz = fx;
    const shotX = h.houseX + fx * 17.5 + rx * 4.5;
    const shotZ = h.houseZ + fz * 17.5 + rz * 4.5;

    await teleportLook(h.x + fx * 2.2, h.z + fz * 2.2, h.x, h.y + 0.85, h.z);
    await waitFocus('hearth');
    const sFocus = await getState();
    assert(sFocus.focused?.id === 'hearth', `expected focus hearth, got ${JSON.stringify(sFocus.focused)}`);
    assert(sFocus.interactBtn.visible && sFocus.interactBtn.label === 'Lay & light the hearth', `unexpected touch btn: ${JSON.stringify(sFocus.interactBtn)}`);

    await holdSelectorUntil(page, cdp, '#btnInteract', 'window.__proto.state().hearthFixed === true');
    await sleep(450);

    await teleportLook(shotX, shotZ, h.houseX, h.y + 4.8, h.houseZ);
    await sleep(1600);
    const sAfter = await getState();
    assert(sAfter.hearthFixed === true, 'hearth should be fixed after holding #btnInteract');
    assert(sAfter.hearthLit > 0.7, `hearthLit should be >0.7, got ${sAfter.hearthLit}`);
    assert(sAfter.ui.radioVisible, 'Maren radio should be visible after lighting hearth');
    await page.screenshot({ path: path.join(OUT_DIR, 'touch-02-hearth-after.png') });

    // Verify radio works by tap (reveals full line or advances cleanly without opening pause)
    await tapSelector(page, cdp, '#proto-radio', 40);
    await sleep(200);
    const sRadioTap = await getState();
    assert(sRadioTap.paused === false, 'tapping radio must not pause');
    assert(sRadioTap.ui.radioText.length >= sAfter.ui.radioText.length || !sRadioTap.ui.radioVisible, 'tapping radio should finish typing or advance');
    console.log(`[proto-touch] Beat 2 Hearth (hold) + radio tap OK · hearthLit=${sAfter.hearthLit.toFixed(2)}`);
  }

  // ---- BEAT 3: FENCE GAP + 2 RAILS (TAP tasks via #btnInteract) ----
  {
    const fg = sites.fenceGap;
    const shotX = fg.x - fg.nx * 5.2;
    const shotZ = fg.z - fg.nz * 5.2;

    for (let i = 0; i < 2; i++) {
      const r = sites.looseRails[i];
      await teleportLook(r.x - fg.nx * 1.9, r.z - fg.nz * 1.9, r.x, r.y, r.z);
      await waitFocus(r.id);
      const sf = await getState();
      assert(sf.focused?.id === r.id, `expected focus ${r.id}, got ${JSON.stringify(sf.focused)}`);
      assert(sf.interactBtn.visible && sf.interactBtn.label === 'Pick up fence rail', `unexpected touch btn: ${JSON.stringify(sf.interactBtn)}`);
      await tapSelector(page, cdp, '#btnInteract', 50);
      await page.waitForFunction((want) => window.__proto.state().heldRails === want, { timeout: 5000, polling: 80 }, i + 1);
      const sp = await getState();
      assert(sp.heldRails === i + 1, `expected heldRails=${i + 1}, got ${sp.heldRails}`);
    }

    await teleportLook(fg.x - fg.nx * 2.6, fg.z - fg.nz * 2.6, fg.x, fg.y, fg.z);
    for (let i = 0; i < 2; i++) {
      await waitFocus('fence-gap');
      const sf = await getState();
      assert(sf.focused?.id === 'fence-gap', `expected focus fence-gap, got ${JSON.stringify(sf.focused)}`);
      assert(sf.interactBtn.visible && sf.interactBtn.label === `Set fence rail (${i + 1}/2)`, `unexpected touch btn: ${JSON.stringify(sf.interactBtn)}`);
      await tapSelector(page, cdp, '#btnInteract', 50);
      await page.waitForFunction((want) => window.__proto.state().railsPlaced === want, { timeout: 5000, polling: 80 }, i + 1);
    }

    await teleportLook(shotX, shotZ, fg.x + fg.nx * 3.5, fg.y + 0.15, fg.z + fg.nz * 3.5);
    await sleep(3400);
    const sAfter = await getState();
    assert(sAfter.railsPlaced === 2 && sAfter.fenceFixed === true, 'fence should be fixed with 2 rails via touch');
    await page.screenshot({ path: path.join(OUT_DIR, 'touch-03-fence-after.png') });
    console.log(`[proto-touch] Beat 3 Fence (tap) OK · rails=${sAfter.railsPlaced}/2`);
  }

  // ---- BEAT 4: TRAIL LAMPS (walk past with touch stick) ----
  {
    const lm0 = sites.lamps[0];
    const lm1 = sites.lamps[1];
    const dx0 = lm1.x - lm0.x, dz0 = lm1.z - lm0.z;
    const dl0 = Math.hypot(dx0, dz0) || 1;
    const ux0 = dx0 / dl0, uz0 = dz0 / dl0;

    const shotX = lm0.x - ux0 * 5.2;
    const shotZ = lm0.z - uz0 * 5.2;
    await teleportLook(shotX, shotZ, lm0.gx, lm0.gy - 0.15, lm0.gz);
    await sleep(300);

    await walkStickUntil(page, cdp, 'window.__proto.state().lampsLitCount >= 1', 10000);
    let sl = await getState();
    assert(sl.lampsLitCount === 1, `expected 1 lamp lit after walking past Lamp 0, got ${sl.lampsLitCount}`);

    await teleportLook(shotX, shotZ, lm0.gx, lm0.gy - 0.15, lm0.gz);
    await sleep(450);
    await page.screenshot({ path: path.join(OUT_DIR, 'touch-04-lamp-after.png') });

    for (let i = 1; i < sites.lamps.length; i++) {
      const lm = sites.lamps[i];
      const prev = sites.lamps[i - 1];
      const dx = lm.x - prev.x, dz = lm.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1;
      const ux = dx / dl, uz = dz / dl;
      await teleportLook(lm.x - ux * 3.5, lm.z - uz * 3.5, lm.x, lm.y + 1.4, lm.z);
      await sleep(150);
      await walkStickUntil(page, cdp, (want) => window.__proto.state().lampsLitCount >= want, 10000, i + 1);
    }
    sl = await getState();
    assert(sl.lampsLitCount === sites.lamps.length && sl.allLampsDone, `expected all ${sites.lamps.length} lamps lit, got ${sl.lampsLitCount}`);
    console.log(`[proto-touch] Beat 4 Trail Lamps OK · lit=${sl.lampsLitCount}/${sl.lampsTotal}`);
  }

  // ---- BEAT 5: STREAM BRIDGE (3 planks via #btnInteract tap) ----
  {
    const br = sites.bridge;
    const shotX = br.x - br.ux * 7.6;
    const shotZ = br.z - br.uz * 7.6;

    for (let i = 0; i < sites.planks.length; i++) {
      const pl = sites.planks[i];
      await teleportLook(pl.x - br.ux * 1.9, pl.z - br.uz * 1.9, pl.x, pl.y, pl.z);
      await waitFocus(pl.id);
      const sf = await getState();
      assert(sf.focused?.id === pl.id, `expected focus ${pl.id}, got ${JSON.stringify(sf.focused)}`);
      assert(sf.interactBtn.visible && sf.interactBtn.label === 'Pick up bridge plank', `unexpected touch btn: ${JSON.stringify(sf.interactBtn)}`);
      await tapSelector(page, cdp, '#btnInteract', 50);
      await page.waitForFunction('window.__proto.state().heldPlanks === 1', { timeout: 5000, polling: 80 });
      const sp = await getState();
      assert(sp.heldPlanks === 1, `expected heldPlanks=1 after picking ${pl.id}, got ${sp.heldPlanks}`);

      await teleportLook(br.approachX - br.ux * 0.4, br.approachZ - br.uz * 0.4, br.x, br.y, br.z);
      await waitFocus('bridge-slot');
      const sfb = await getState();
      assert(sfb.focused?.id === 'bridge-slot', `expected focus bridge-slot, got ${JSON.stringify(sfb.focused)}`);
      assert(sfb.interactBtn.visible && sfb.interactBtn.label === `Lay bridge plank (${i + 1}/3)`, `unexpected touch btn: ${JSON.stringify(sfb.interactBtn)}`);
      await tapSelector(page, cdp, '#btnInteract', 50);
      await page.waitForFunction((want) => window.__proto.state().bridgePlaced === want, { timeout: 5000, polling: 80 }, i + 1);
      const sap = await getState();
      assert(sap.bridgePlaced === i + 1, `expected bridgePlaced=${i + 1}, got ${sap.bridgePlaced}`);
    }

    await teleportLook(shotX, shotZ, br.x, br.y + 0.1, br.z);
    await sleep(1100);
    const sRep = await getState();
    assert(sRep.bridgeFixed === true, 'bridge should be repaired via touch');
    await page.screenshot({ path: path.join(OUT_DIR, 'touch-05-bridge-after.png') });
    console.log(`[proto-touch] Beat 5 Bridge OK · placed=${sRep.bridgePlaced}/3`);
  }

  // ---- JETTY ARRIVAL & END CARD (tap "Keep walking", no pointer lock) ----
  {
    const jt = sites.jetty;
    assert(jt, 'jetty site missing');
    const jdx = jt.endX - jt.startX, jdz = jt.endZ - jt.startZ;
    const jdl = Math.hypot(jdx, jdz) || 1;
    const jux = jdx / jdl, juz = jdz / jdl;
    await teleportLook(jt.startX - jux * 13.0, jt.startZ - juz * 13.0, jt.endX, jt.deckY + 0.5, jt.endZ);
    await sleep(250);
    await walkStickUntil(page, cdp, 'window.__proto.state().jettyReached === true', 10000);

    await page.waitForFunction('window.__proto.state().ui.endCardVisible === true', { timeout: 10000, polling: 150 });
    await sleep(900);
    const sEnd = await getState();
    const lockAtEnd = await page.evaluate(() => document.pointerLockElement !== null);
    assert(sEnd.jettyReached === true, 'jettyReached should be true');
    assert(sEnd.ui.endCardVisible === true, 'endCardVisible should be true');
    assert(sEnd.paused === false, 'suppressPause should keep pause hidden during End Card');
    assert(!lockAtEnd, 'no pointer lock at End Card on touch');
    await page.screenshot({ path: path.join(OUT_DIR, 'touch-06-end-card.png') });
    console.log('[proto-touch] Jetty & End Card OK');

    await tapSelector(page, cdp, '#proto-keep-walking', 45);
    await sleep(400);
    const sResumed = await getState();
    const lockAfter = await page.evaluate(() => document.pointerLockElement !== null);
    assert(sResumed.ui.endCardVisible === false, 'tapping Keep walking should dismiss End Card');
    assert(sResumed.paused === false, 'game should stay unpaused after Keep walking');
    assert(!lockAfter, 'Keep walking on touch must not acquire pointer lock');
    console.log('[proto-touch] Keep walking tap OK · all 5 beats + end card verified on iPhone touch!');
  }

  assert(errs.length === 0, `browser errors: ${errs.join(' | ')}`);
} finally {
  await browser.close();
}
