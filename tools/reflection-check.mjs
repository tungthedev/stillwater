// Baked-valley browser verification for Slice 8 lake reflections.
// Tests:
//  1a. Phone aspect (9:16) at trailf=0.216, yaw=2.825, pitch=-0.128: visible water near viewport edge must render reflection.
//  1b. Lake bench looking steeply down over dry ground: reflection pass must skip (0 tris).
//  2.  Medium tier at lake bench: reflection tris <= 15% of main or <= 0.8 M absolute, steady-state frame-skip cache reuse without sky-only flip,
//      and a 5.7 deg yaw turn must keep all visible water inside cached UV [0.004, 0.996] (no clamped edge-texel smear).
//  3.  Disabled water (?nowater) and low tier (reflEvery === 0, even after clicking debug HUD Refl toggle) must never render reflection.
//
// Usage:
//   BASE=http://127.0.0.1:5288/ node tools/reflection-check.mjs [--allow-live]
import { launchBrowser } from './chrome.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const ALLOW_LIVE = process.argv.includes('--allow-live');

async function openPlayPage(browser, url, width, height) {
  const page = await browser.newPage();
  const errs = [];
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) {
      errs.push('console.error: ' + m.text().slice(0, 200));
    }
  });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 250 });
  const initErr = await page.evaluate(() => window.__error || null);
  if (initErr) throw new Error('init error: ' + initErr);
  await new Promise((r) => setTimeout(r, 400));
  await page.mouse.click(Math.floor(width / 2), Math.floor(height / 2));
  await page.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 20000, polling: 100 });
  await new Promise((r) => setTimeout(r, 300));

  // Count reflection and main renders per frame from renderer.render itself, so frames where the
  // reflection pass returns early (no renderReflection call at all) are still recorded.
  await page.evaluate(() => {
    const g = window.__game;
    const w = g.water;
    const origRender = g.renderer.render.bind(g.renderer);
    const pending = { reflRenders: 0, reflTris: 0, reflCalls: 0 };
    window.__reflStats = { frames: [] };

    g.renderer.render = function (scene, cam) {
      const beforeTris = this.info.render.triangles;
      const beforeCalls = this.info.render.calls;
      const res = origRender(scene, cam);
      const dTris = this.info.render.triangles - beforeTris;
      const dCalls = this.info.render.calls - beforeCalls;
      if (cam === w.virtualCamera) {
        pending.reflRenders++;
        pending.reflTris += dTris;
        pending.reflCalls += dCalls;
      } else if (cam === g.camera) {
        window.__reflStats.frames.push({
          rendered: pending.reflRenders > 0,
          reflTris: pending.reflTris,
          reflCalls: pending.reflCalls,
          mainTris: dTris,
          mainCalls: dCalls,
          uHasRefl: w.uniforms.uHasRefl.value,
          reflValid: !!w.reflValid,
        });
        if (window.__reflStats.frames.length > 60) window.__reflStats.frames.shift();
        pending.reflRenders = 0; pending.reflTris = 0; pending.reflCalls = 0;
      }
      return res;
    };
  });

  await page.evaluate(() => {
    const g = window.__game;
    const w = g.water;
    // Helper: cast dense screen-space rays to the lake plane, filter to unoccluded wet pixels,
    // and project them through water.uniforms.uTexMatrix.
    window.__probeVisibleWaterUVs = (cols = 48, rows = 36) => {
      const cam = g.camera;
      const hf = g.hf;
      const wl = g.worldData?.region?.waterLevel ?? g.U?.uWaterLevel?.value ?? 22;
      const lake = g.worldData?.region?.lake ?? { x: -150, z: 200, rx: 340, rz: 230 };
      const hx = lake.rx * 1.7, hz = lake.rz * 1.7;
      cam.updateMatrixWorld();
      const invProj = cam.projectionMatrixInverse;
      const matW = cam.matrixWorld;
      const tm = w.uniforms.uTexMatrix.value.elements;
      const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
      let wetPixels = 0;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      let badW = 0;
      let maxDepth = 0;

      const projInv = invProj.elements;
      const mw = matW.elements;
      for (let r = 0; r < rows; r++) {
        const ndcY = 1 - ((r + 0.5) / rows) * 2;
        for (let c = 0; c < cols; c++) {
          const ndcX = ((c + 0.5) / cols) * 2 - 1;
          // Unproject point on near plane in view space
          const vx = projInv[0] * ndcX + projInv[4] * ndcY + projInv[8] * -1 + projInv[12];
          const vy = projInv[1] * ndcX + projInv[5] * ndcY + projInv[9] * -1 + projInv[13];
          const vz = projInv[2] * ndcX + projInv[6] * ndcY + projInv[10] * -1 + projInv[14];
          const vw = projInv[3] * ndcX + projInv[7] * ndcY + projInv[11] * -1 + projInv[15];
          const lx = vx / vw, ly = vy / vw, lz = vz / vw;
          // Direction in world space
          const dx = mw[0] * lx + mw[4] * ly + mw[8] * lz;
          const dy = mw[1] * lx + mw[5] * ly + mw[9] * lz;
          const dz = mw[2] * lx + mw[6] * ly + mw[10] * lz;
          if (dy >= -1e-4) continue;
          const t = (wl - cy) / dy;
          if (t <= 0.25 || t > 5000) continue;
          const wx = cx + dx * t;
          const wz = cz + dz * t;
          if (Math.abs(wx - lake.x) > hx || Math.abs(wz - lake.z) > hz) continue;
          const depth = wl - hf.height(wx, wz);
          if (depth <= 0.05) continue;

          // Check terrain occlusion along the ray
          const dist = Math.hypot(wx - cx, wz - cz);
          const steps = Math.min(80, Math.max(12, Math.ceil(dist / 10)));
          let blocked = false;
          for (let s = 1; s < steps; s++) {
            const f = s / steps;
            const sx = cx + (wx - cx) * f;
            const sz = cz + (wz - cz) * f;
            const ry = cy + (wl - cy) * f;
            if (hf.height(sx, sz) > ry) { blocked = true; break; }
          }
          if (blocked) continue;

          wetPixels++;
          if (depth > maxDepth) maxDepth = depth;
          const ux = tm[0] * wx + tm[4] * wl + tm[8] * wz + tm[12];
          const uy = tm[1] * wx + tm[5] * wl + tm[9] * wz + tm[13];
          const uw = tm[3] * wx + tm[7] * wl + tm[11] * wz + tm[15];
          if (uw <= 1e-5) {
            badW++;
          } else {
            const u = ux / uw;
            const v = uy / uw;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
          }
        }
      }
      return {
        wetPixels,
        maxDepth: Math.round(maxDepth * 100) / 100,
        badW,
        minU: Number.isFinite(minU) ? Math.round(minU * 10000) / 10000 : null,
        maxU: Number.isFinite(maxU) ? Math.round(maxU * 10000) / 10000 : null,
        minV: Number.isFinite(minV) ? Math.round(minV * 10000) / 10000 : null,
        maxV: Number.isFinite(maxV) ? Math.round(maxV * 10000) / 10000 : null,
        uHasRefl: w.uniforms.uHasRefl.value,
        reflValid: !!w.reflValid,
      };
    };

    window.__waitRafs = (n = 3) => new Promise((resolve) => {
      let left = n;
      const tick = () => {
        if (--left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

  return { page, errs };
}

const { browser, renderer } = await launchBrowser();
const failures = [];
const results = { renderer, base: BASE, checks: {} };

try {
  // --- Check 1a: Phone aspect (9:16), trailf=0.216, yaw=2.825, pitch=-0.128 ---
  {
    const { page, errs } = await openPlayPage(browser, `${BASE}?q=medium`, 390, 693);
    const meta = await page.evaluate(() => ({
      worldSource: window.__game.worldSource ?? 'live',
      worldHash: window.__game.worldHash ?? null,
    }));
    results.worldSource = meta.worldSource;
    if (!ALLOW_LIVE && meta.worldSource !== 'baked') {
      failures.push(`expected baked world, got ${meta.worldSource}`);
    }

    const probe = await page.evaluate(async () => {
      const g = window.__game;
      const trail = g.trail;
      const d = 0.216 * trail.dist[trail.dist.length - 1];
      let idx = trail.dist.findIndex((x) => x >= d);
      if (idx < 0) idx = trail.points.length - 1;
      const p = trail.points[idx];
      g.player.sitting = null;
      g.player.sitBlend = 0;
      g.player.vel.set(0, 0, 0);
      g.player.pos.set(p[0], 0, p[1]);
      g.player.yaw = g.player.yawT = 2.825;
      g.player.pitch = g.player.pitchT = -0.128;
      g.player.eyeY = g.hf.height(p[0], p[1]) + 1.68;
      window.__reflStats.frames.length = 0;
      await window.__waitRafs(5);
      const uv = window.__probeVisibleWaterUVs(56, 48);
      const frames = window.__reflStats.frames.slice(-4);
      return { uv, frames };
    });

    const ok =
      errs.length === 0 &&
      probe.uv.wetPixels > 0 &&
      probe.uv.uHasRefl === 1 &&
      probe.uv.reflValid === true &&
      probe.uv.badW === 0 &&
      probe.uv.minU >= 0.004 && probe.uv.maxU <= 0.996 &&
      probe.uv.minV >= 0.004 && probe.uv.maxV <= 0.996 &&
      probe.frames.some((f) => f.rendered && f.reflTris > 0);
    results.checks.phoneEdgeWater = { ok, ...probe, errs };
    if (!ok) failures.push(`phoneEdgeWater failed: wetPixels=${probe.uv.wetPixels} uHasRefl=${probe.uv.uHasRefl} reflValid=${probe.uv.reflValid} uv=[${probe.uv.minU},${probe.uv.maxU}]x[${probe.uv.minV},${probe.uv.maxV}]`);
    await page.close();
  }

  // --- Check 1b & Check 2: Desktop (1280x720) lake bench steep-down + medium 5.7 deg turn + tri ratio ---
  {
    const { page, errs } = await openPlayPage(browser, `${BASE}?q=medium`, 1280, 720);

    // 1b: Lake bench looking steeply down over dry ground
    const steepDown = await page.evaluate(async () => {
      const g = window.__game;
      const b0 = g.player.world.props.benches[0];
      g.player.sitting = null;
      g.player.sitBlend = 0;
      g.player.vel.set(0, 0, 0);
      g.player.pos.set(b0.x, 0, b0.z);
      g.player.toggleSit();
      g.player.sitBlend = 1;
      g.player.pitch = g.player.pitchT = -1.25;
      await window.__waitRafs(3);
      window.__reflStats.frames.length = 0;
      await window.__waitRafs(4);
      const uv = window.__probeVisibleWaterUVs(48, 36);
      const frames = window.__reflStats.frames.slice();
      return { uv, frames };
    });
    const okSteep =
      errs.length === 0 &&
      steepDown.uv.wetPixels === 0 &&
      steepDown.frames.length > 0 &&
      steepDown.frames.every((f) => !f.rendered && f.reflTris === 0 && f.uHasRefl === 0);
    results.checks.benchSteepDown = { ok: okSteep, ...steepDown, errs };
    if (!okSteep) failures.push(`benchSteepDown failed: wetPixels=${steepDown.uv.wetPixels} renderedFrames=${steepDown.frames.filter((f) => f.rendered).length}`);

    // 2: Standing at the lake bench facing the lake -> active tri ratio, steady-state cache reuse, and
    //    turns made right after a drawn frame (so the next frame may reuse the cache) must keep every
    //    visible wet pixel inside the cached reflection's UV range.
    const benchTurn = await page.evaluate(async () => {
      const g = window.__game;
      const b0 = g.player.world.props.benches[0];
      const lake = g.worldData.region.lake;
      g.player.sitting = null;
      g.player.sitBlend = 0;
      g.player.vel.set(0, 0, 0);
      g.player.pos.set(b0.x, 0, b0.z);
      const baseYaw = Math.atan2(-(lake.x - b0.x), -(lake.z - b0.z));
      g.player.yaw = g.player.yawT = baseYaw;
      g.player.pitch = g.player.pitchT = -0.15;
      await window.__waitRafs(6);
      window.__reflStats.frames.length = 0;
      await window.__waitRafs(6);
      const steadyFrames = window.__reflStats.frames.slice();

      const turnSamples = [];
      const deltas = [0.10, -0.10, 0.14, 0.24]; // 5.7 deg left, right, 8 deg, 13.7 deg
      for (const dy of deltas) {
        g.player.yaw = g.player.yawT = baseYaw;
        await window.__waitRafs(3);
        let waited = 0;
        while (waited++ < 8) {
          const last = window.__reflStats.frames[window.__reflStats.frames.length - 1];
          if (last && last.rendered) break;
          await window.__waitRafs(1);
        }
        g.player.yaw = g.player.yawT = baseYaw + dy;
        await window.__waitRafs(1);
        const last = window.__reflStats.frames[window.__reflStats.frames.length - 1];
        const uv = window.__probeVisibleWaterUVs(64, 36);
        turnSamples.push({ deltaRad: dy, deltaDeg: Math.round((dy * 180) / Math.PI * 10) / 10, frame: last, uv });
      }
      return { steadyFrames, turnSamples };
    });

    const activeFrames = benchTurn.steadyFrames.filter((f) => f.rendered && f.mainTris > 0);
    const skippedFrames = benchTurn.steadyFrames.filter((f) => !f.rendered);
    const activeFrame = activeFrames[0] || null;
    const ratio = activeFrame ? activeFrame.reflTris / activeFrame.mainTris : Infinity;
    // A cheap main view (tree impostors) inflates the ratio, so a small absolute cost also passes.
    const REFL_TRIS_BUDGET = 800_000;
    const budgetOk = ratio <= 0.15 || (activeFrame !== null && activeFrame.reflTris <= REFL_TRIS_BUDGET);
    const steadyOk =
      activeFrames.length >= 2 &&
      skippedFrames.length >= 2 &&
      skippedFrames.every((f) => f.uHasRefl === 1 && f.reflValid && f.reflTris === 0) &&
      budgetOk;

    const turnsOk = benchTurn.turnSamples.every((s) => (
      s.uv.wetPixels > 0 &&
      s.uv.uHasRefl === 1 &&
      s.uv.reflValid === true &&
      s.uv.badW === 0 &&
      s.uv.minU >= 0.004 && s.uv.maxU <= 0.996 &&
      s.uv.minV >= 0.004 && s.uv.maxV <= 0.996
    ));
    const okTurn = errs.length === 0 && steadyOk && turnsOk;
    results.checks.benchTurnAndBudget = {
      ok: okTurn,
      activeReflTris: activeFrame?.reflTris ?? null,
      activeMainTris: activeFrame?.mainTris ?? null,
      reflToMainRatio: Number.isFinite(ratio) ? Math.round(ratio * 10000) / 10000 : null,
      steadyActiveCount: activeFrames.length,
      steadySkippedValidCount: skippedFrames.filter((f) => f.uHasRefl === 1 && f.reflValid).length,
      turnSamples: benchTurn.turnSamples,
      errs,
    };
    if (!okTurn) {
      const badTurns = benchTurn.turnSamples.filter((s) => !(s.uv.minU >= 0.004 && s.uv.maxU <= 0.996 && s.uv.minV >= 0.004 && s.uv.maxV <= 0.996 && s.uv.badW === 0 && s.uv.uHasRefl === 1));
      failures.push(`benchTurnAndBudget failed: steadyOk=${steadyOk} ratio=${ratio} badTurns=${JSON.stringify(badTurns.map((t) => ({ deg: t.deltaDeg, rendered: t.frame?.rendered, uv: [t.uv.minU, t.uv.maxU, t.uv.minV, t.uv.maxV] })))}`);
    }
    await page.close();
  }

  // --- Check 3a: ?nowater skips reflection ---
  {
    const { page, errs } = await openPlayPage(browser, `${BASE}?q=medium&nowater`, 1280, 720);
    const noWaterRes = await page.evaluate(async () => {
      const g = window.__game;
      const b0 = g.player.world.props.benches[0];
      g.player.pos.set(b0.x, 0, b0.z);
      g.player.toggleSit();
      g.player.sitBlend = 1;
      g.player.pitch = g.player.pitchT = -0.02;
      window.__reflStats.frames.length = 0;
      await window.__waitRafs(4);
      return {
        meshParent: !!g.water.mesh.parent,
        meshVisible: g.water.mesh.visible,
        uHasRefl: g.water.uniforms.uHasRefl.value,
        reflValid: !!g.water.reflValid,
        frames: window.__reflStats.frames.slice(),
      };
    });
    const ok =
      errs.length === 0 &&
      !noWaterRes.meshParent &&
      noWaterRes.uHasRefl === 0 &&
      !noWaterRes.reflValid &&
      noWaterRes.frames.length >= 3 &&
      noWaterRes.frames.every((f) => !f.rendered && f.reflTris === 0 && f.reflCalls === 0);
    results.checks.noWaterSkips = { ok, ...noWaterRes, errs };
    if (!ok) failures.push(`noWaterSkips failed: uHasRefl=${noWaterRes.uHasRefl} frames=${noWaterRes.frames.length}`);
    await page.close();
  }

  // --- Check 3b: low tier (reflEvery 0) stays off even if debug HUD Refl toggle is clicked ---
  {
    const { page, errs } = await openPlayPage(browser, `${BASE}?q=low&debug=1`, 1280, 720);
    // Click the "Refl" pill in debug HUD using real click
    await page.evaluate(async () => {
      const g = window.__game;
      const b0 = g.player.world.props.benches[0];
      g.player.pos.set(b0.x, 0, b0.z);
      g.player.toggleSit();
      g.player.sitBlend = 1;
      g.player.pitch = g.player.pitchT = -0.02;
    });
    const reflBtn = await page.evaluateHandle(() => {
      const pills = Array.from(document.querySelectorAll('#dbgToggles .pill'));
      return pills.find((el) => el.textContent.trim() === 'Refl') || null;
    });
    const el = reflBtn.asElement();
    const pillFound = !!el;
    // Pointer lock swallows mouse clicks, so release it before clicking the HUD.
    await page.evaluate(() => document.exitPointerLock());
    await new Promise((r) => setTimeout(r, 200));
    if (el) await el.click();
    const pillOn = pillFound && await page.evaluate((e) => !e.classList.contains('off'), el);
    // Releasing pointer lock pauses play; click back into the view to resume rendering.
    await page.mouse.click(400, 600);
    await page.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 20000, polling: 100 });
    const lowRes = await page.evaluate(async () => {
      window.__reflStats.frames.length = 0;
      await window.__waitRafs(5);
      return {
        uHasRefl: window.__game.water.uniforms.uHasRefl.value,
        reflValid: !!window.__game.water.reflValid,
        frames: window.__reflStats.frames.slice(),
      };
    });
    const ok =
      errs.length === 0 &&
      pillOn &&
      lowRes.uHasRefl === 0 &&
      !lowRes.reflValid &&
      lowRes.frames.length >= 3 &&
      lowRes.frames.every((f) => !f.rendered && f.reflTris === 0 && f.reflCalls === 0);
    results.checks.lowDebugToggleStaysOff = { ok, pillFound, pillOn, ...lowRes, errs };
    if (!ok) failures.push(`lowDebugToggleStaysOff failed: pillFound=${pillFound} pillOn=${pillOn} uHasRefl=${lowRes.uHasRefl} rendered=${lowRes.frames.filter((f) => f.rendered).length}`);
    await page.close();
  }
} finally {
  await browser.close();
}

results.ok = failures.length === 0;
results.failures = failures;
console.log(JSON.stringify(results, null, 2));
if (!results.ok) process.exit(1);
