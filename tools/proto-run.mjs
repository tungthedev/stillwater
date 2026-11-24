// End-to-end headless verification of the release-1 gameplay loop using REAL keyboard and mouse events.
// Teleports/aims between sites via window.__proto to keep the run short, performs every
// interaction and walk-through with real Puppeteer keyboard/mouse input, verifies desktop E->Sit
// fallback, the creek blocker, all 5 mending beats, radio lines, and the jetty End Card,
// and saves after-completion screenshots at 1600x900 to proto-evidence/release-1/.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './chrome.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const W = +(process.env.W || 1600);
const H = +(process.env.H || 900);
const OUT_DIR = path.resolve(process.env.OUT || 'proto-evidence/release-1');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const { browser, renderer, isSoftware } = await launchBrowser();
const errs = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const baseOrigin = new URL(BASE).origin;

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

  console.log(`[proto-run] renderer=${renderer} software=${isSoftware} viewport=${W}x${H}`);
  await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__proto && window.__game || window.__error', { timeout: 120000, polling: 250 });

  const initErr = await page.evaluate(() => window.__error || null);
  assert(!initErr, `window.__error on boot: ${initErr}`);

  // Start play via real click on title screen
  await sleep(700);
  await page.mouse.click(W / 2, H / 2);
  await page.waitForFunction('window.__proto.state().playerEnabled === true', { timeout: 15000, polling: 100 });
  await sleep(900);

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

  const sites = await getSites();
  const st0 = await getState();
  console.log(`[proto-run] booted · hour=${st0.hours.toFixed(2)} · lamps=${st0.lampsTotal} · planks=${sites.planks.length}`);
  assert(sites.signpost, 'signpost site missing');
  assert(sites.fenceGap, 'fenceGap site missing');
  assert(sites.lamps.length === 6, `expected 6 trail lamps, got ${sites.lamps.length}`);
  assert(sites.planks.length === 3, `expected 3 bridge planks, got ${sites.planks.length}`);
  for (const pl of sites.planks) {
    assert(pl.distFromBridge <= 60, `plank ${pl.id} too far (${pl.distFromBridge.toFixed(1)}m > 60m)`);
  }

  // ---- BEAT 1: SIGNPOST (real KeyE hold; must NOT sit!) ----
  {
    const sp = sites.signpost;
    const sx = sp.x + 1.8, sz = sp.z + 2.6;
    await teleportLook(sx, sz, sp.x, sp.y + 1.25, sp.z);
    await waitFocus('signpost');
    const sBefore = await getState();
    assert(sBefore.focused?.id === 'signpost', `expected focus signpost, got ${JSON.stringify(sBefore.focused)}`);

    await page.keyboard.down('KeyE');
    await page.waitForFunction('window.__proto.state().signpostFixed === true', { timeout: 6000, polling: 100 });
    await page.keyboard.up('KeyE');
    await sleep(900);

    const sAfter = await getState();
    const sitting = await page.evaluate(() => !!__game.player.sitting);
    assert(!sitting, 'holding E on signpost must not sit the player down');
    assert(sAfter.signpostFixed === true, 'signpost should be fixed after holding E');
    assert(sAfter.ui.captionText.length > 0, 'signpost handwritten caption should appear');
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-01-signpost-after.png') });
    console.log(`[proto-run] Beat 1 Signpost OK · caption="${sAfter.ui.captionText}"`);

    // Now that nothing is in focus, verify KeyE falls back to Sit and stands back up.
    assert(sAfter.focused === null, `expected no focus after fixing signpost, got ${JSON.stringify(sAfter.focused)}`);
    const sit0 = await page.evaluate(() => !!__game.player.sitting);
    await page.keyboard.press('KeyE');
    await sleep(200);
    const sit1 = await page.evaluate(() => !!__game.player.sitting);
    await page.keyboard.press('KeyE');
    await sleep(200);
    const sit2 = await page.evaluate(() => !!__game.player.sitting);
    assert(!sit0 && sit1 && !sit2, `desktop KeyE sit fallback failed: ${sit0}->${sit1}->${sit2}`);
    console.log('[proto-run] Desktop KeyE -> Sit fallback OK');
  }

  // ---- BEAT 2: COTTAGE HEARTH (real LMB hold) ----
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

    await page.mouse.move(W / 2, H / 2);
    await page.mouse.down({ button: 'left' });
    await page.waitForFunction('window.__proto.state().hearthFixed === true', { timeout: 6000, polling: 100 });
    await page.mouse.up({ button: 'left' });
    await sleep(450);

    await teleportLook(shotX, shotZ, h.houseX, h.y + 4.8, h.houseZ);
    await sleep(1800);
    const sAfter = await getState();
    assert(sAfter.hearthFixed === true, 'hearth should be fixed after holding LMB');
    assert(sAfter.hearthLit > 0.75, `hearthLit should be >0.75, got ${sAfter.hearthLit}`);
    assert(sAfter.ui.lastRadioFull.includes('smoke'), `expected Maren smoke line, got "${sAfter.ui.lastRadioFull}"`);
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-02-hearth-after.png') });
    console.log(`[proto-run] Beat 2 Hearth OK · hearthLit=${sAfter.hearthLit.toFixed(2)} · radio="${sAfter.ui.lastRadioFull}"`);
  }

  // ---- BEAT 3: FENCE GAP + 2 RAILS + SHEEP ----
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
      if (i === 0) {
        await page.keyboard.press('KeyE');
      } else {
        await page.mouse.click(W / 2, H / 2);
      }
      await page.waitForFunction((want) => window.__proto.state().heldRails === want, { timeout: 5000, polling: 80 }, i + 1);
      const sp = await getState();
      const sitting = await page.evaluate(() => !!__game.player.sitting);
      assert(!sitting, 'picking up fence rail must not sit the player down');
      assert(sp.heldRails === i + 1, `expected heldRails=${i + 1}, got ${sp.heldRails}`);
    }

    await teleportLook(fg.x - fg.nx * 2.6, fg.z - fg.nz * 2.6, fg.x, fg.y, fg.z);
    for (let i = 0; i < 2; i++) {
      await waitFocus('fence-gap');
      const sf = await getState();
      assert(sf.focused?.id === 'fence-gap', `expected focus fence-gap, got ${JSON.stringify(sf.focused)}`);
      await page.keyboard.press('KeyE');
      await page.waitForFunction((want) => window.__proto.state().railsPlaced === want, { timeout: 5000, polling: 80 }, i + 1);
    }

    await teleportLook(shotX, shotZ, fg.x + fg.nx * 3.5, fg.y + 0.15, fg.z + fg.nz * 3.5);
    await sleep(3600);
    const sAfter = await getState();
    assert(sAfter.railsPlaced === 2 && sAfter.fenceFixed === true, 'fence should be fixed with 2 rails');
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-03-fence-after.png') });
    console.log(`[proto-run] Beat 3 Fence OK · rails=${sAfter.railsPlaced}/2 · radio="${sAfter.ui.lastRadioFull}"`);
  }

  // ---- BEAT 4: TRAIL LAMPS (touch in passing with real KeyW) ----
  {
    const lm0 = sites.lamps[0];
    const lm1 = sites.lamps[1];
    const dx0 = lm1.x - lm0.x, dz0 = lm1.z - lm0.z;
    const dl0 = Math.hypot(dx0, dz0) || 1;
    const ux0 = dx0 / dl0, uz0 = dz0 / dl0;

    const shotX = lm0.x - ux0 * 5.2;
    const shotZ = lm0.z - uz0 * 5.2;
    await teleportLook(shotX, shotZ, lm0.gx, lm0.gy - 0.15, lm0.gz);
    await sleep(350);

    await page.keyboard.down('KeyW');
    await page.waitForFunction('window.__proto.state().lampsLitCount >= 1', { timeout: 8000, polling: 100 });
    await page.keyboard.up('KeyW');
    await sleep(350);
    let sl = await getState();
    assert(sl.lampsLitCount === 1, `expected 1 lamp lit after walking past Lamp 0, got ${sl.lampsLitCount}`);

    await teleportLook(shotX, shotZ, lm0.gx, lm0.gy - 0.15, lm0.gz);
    await sleep(450);
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-04-lamp-after.png') });

    for (let i = 1; i < sites.lamps.length; i++) {
      const lm = sites.lamps[i];
      const prev = sites.lamps[i - 1];
      const dx = lm.x - prev.x, dz = lm.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1;
      const ux = dx / dl, uz = dz / dl;
      await teleportLook(lm.x - ux * 3.8, lm.z - uz * 3.8, lm.x, lm.y + 1.4, lm.z);
      await sleep(150);
      await page.keyboard.down('KeyW');
      await page.waitForFunction((want) => window.__proto.state().lampsLitCount >= want, { timeout: 8000, polling: 100 }, i + 1);
      await page.keyboard.up('KeyW');
      await sleep(150);
    }
    sl = await getState();
    assert(sl.lampsLitCount === sites.lamps.length && sl.allLampsDone, `expected all ${sites.lamps.length} lamps lit, got ${sl.lampsLitCount}`);
    console.log(`[proto-run] Beat 4 Trail Lamps OK · lit=${sl.lampsLitCount}/${sl.lampsTotal}`);
  }

  // ---- BEAT 5: STREAM BRIDGE (verify real blocker, find 3 planks, mend, cross to jetty) ----
  {
    const br = sites.bridge;
    const shotX = br.x - br.ux * 7.6;
    const shotZ = br.z - br.uz * 7.6;

    await teleportLook(br.x - br.ux * 3.8, br.z - br.uz * 3.8, br.x + br.ux * 5, br.y, br.z + br.uz * 5);
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await sleep(1400);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    const sBlocked = await getState();
    const acrossBefore = (sBlocked.pos.x - br.x) * br.ux + (sBlocked.pos.z - br.z) * br.uz;
    assert(acrossBefore < -2.2, `bridge blocker failed! player crossed to across=${acrossBefore.toFixed(2)}`);
    console.log(`[proto-run] Bridge blocker verified · stopped at across=${acrossBefore.toFixed(2)}m`);

    for (let i = 0; i < sites.planks.length; i++) {
      const pl = sites.planks[i];
      await teleportLook(pl.x - br.ux * 1.9, pl.z - br.uz * 1.9, pl.x, pl.y, pl.z);
      await waitFocus(pl.id);
      const sf = await getState();
      assert(sf.focused?.id === pl.id, `expected focus ${pl.id}, got ${JSON.stringify(sf.focused)}`);
      await page.keyboard.press('KeyE');
      await page.waitForFunction('window.__proto.state().heldPlanks === 1', { timeout: 5000, polling: 80 });
      const sp = await getState();
      assert(sp.heldPlanks === 1, `expected heldPlanks=1 after picking ${pl.id}, got ${sp.heldPlanks}`);

      await teleportLook(br.approachX - br.ux * 0.4, br.approachZ - br.uz * 0.4, br.x, br.y, br.z);
      await waitFocus('bridge-slot');
      const sfb = await getState();
      assert(sfb.focused?.id === 'bridge-slot', `expected focus bridge-slot, got ${JSON.stringify(sfb.focused)}`);
      await page.keyboard.press('KeyE');
      await page.waitForFunction((want) => window.__proto.state().bridgePlaced === want, { timeout: 5000, polling: 80 }, i + 1);
      const sap = await getState();
      assert(sap.bridgePlaced === i + 1, `expected bridgePlaced=${i + 1}, got ${sap.bridgePlaced}`);
    }

    await teleportLook(shotX, shotZ, br.x, br.y + 0.1, br.z);
    await sleep(1200);
    const sRep = await getState();
    assert(sRep.bridgeFixed === true, 'bridge should be repaired');
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-05-bridge-after.png') });
    console.log(`[proto-run] Beat 5 Bridge OK · placed=${sRep.bridgePlaced}/3 · radio="${sRep.ui.lastRadioFull}"`);

    await teleportLook(br.x - br.ux * 4.5, br.z - br.uz * 4.5, br.x + br.ux * 12, br.y, br.z + br.uz * 12);
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForFunction(
      (b) => {
        const p = window.__proto.state().pos;
        return (p.x - b.x) * b.ux + (p.z - b.z) * b.uz > 2.5;
      },
      { timeout: 10000, polling: 100 },
      br,
    );
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    const sCrossed = await getState();
    const acrossAfter = (sCrossed.pos.x - br.x) * br.ux + (sCrossed.pos.z - br.z) * br.uz;
    assert(acrossAfter > 2.5, `player could not cross repaired bridge (across=${acrossAfter.toFixed(2)})`);
    console.log(`[proto-run] Crossed repaired bridge OK · across=+${acrossAfter.toFixed(2)}m`);
  }

  // ---- JETTY ARRIVAL & END CARD ----
  {
    const jt = sites.jetty;
    assert(jt, 'jetty site missing');
    const jdx = jt.endX - jt.startX, jdz = jt.endZ - jt.startZ;
    const jdl = Math.hypot(jdx, jdz) || 1;
    const jux = jdx / jdl, juz = jdz / jdl;
    await teleportLook(jt.startX - jux * 15.0, jt.startZ - juz * 15.0, jt.endX, jt.deckY + 0.5, jt.endZ);
    await sleep(300);
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await page.waitForFunction('window.__proto.state().jettyReached === true', { timeout: 10000, polling: 100 });
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');

    await page.waitForFunction('window.__proto.state().ui.endCardVisible === true', { timeout: 10000, polling: 150 });
    await sleep(900);
    const sEnd = await getState();
    assert(sEnd.jettyReached === true, 'jettyReached should be true');
    assert(sEnd.ui.endCardVisible === true, 'endCardVisible should be true');
    assert(sEnd.paused === false, 'suppressPause should keep pause menu closed during End Card');
    await page.screenshot({ path: path.join(OUT_DIR, 'desktop-06-end-card.png') });
    console.log(`[proto-run] Jetty & End Card OK · radio="${sEnd.ui.lastRadioFull}"`);

    await page.click('#proto-keep-walking');
    await sleep(400);
    const sResumed = await getState();
    assert(sResumed.ui.endCardVisible === false, 'Keep walking should dismiss End Card');
    assert(sResumed.paused === false, 'Keep walking should leave game unpaused');
    console.log('[proto-run] Keep walking button OK · all 5 beats + end card verified!');
  }

  assert(errs.length === 0, `browser errors: ${errs.join(' | ')}`);
} finally {
  await browser.close();
}
