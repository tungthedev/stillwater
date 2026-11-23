// Headless production smoke check.
// Serves dist/ with Vite preview on a free local port (always when --dist is passed,
// or when BASE is not provided in standalone runs), runs real input playtest checks
// under gpu-run, and fails on:
// - pageerror / window.__error
// - console.error (except explicit optional 404s)
// - shader compile/link errors & WebGL INVALID_* warnings (matching warn/warning/error)
// - patchMaterial `token missing` warnings (src/patch.js:37, :98)
// - broken walking (Q autowalk movement and standalone W key movement)
// Always closes the preview server before exiting.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { preview } from 'vite';
import { isOptional404, isSameOriginUrl } from './shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;

export const MIN_WALK_DISTANCE = 0.5;

export const TRAILHEAD_REGIONS = {
  sky: { x0: 0.22, y0: 0.01, x1: 0.48, y1: 0.10, minLum: 70, minB: 110, minBMinusR: 35, minNonBlack: 0.9 },
  farMountain: { x0: 0.10, y0: 0.16, x1: 0.30, y1: 0.28, minLum: 120, minB: 130, minNonBlack: 0.9 },
  ground: { x0: 0.15, y0: 0.75, x1: 0.85, y1: 0.95, minLum: 75, minG: 85, minGMinusB: 20, minNonBlack: 0.9 },
};

/**
 * Sample sky, far-mountain, and near-ground regions of a trailhead PNG to catch
 * black-sky / missing-terrain regressions (e.g. incomplete float textures on iOS).
 */
export function analyzeTrailheadRegions(png, regions = TRAILHEAD_REGIONS) {
  const { width, height, data } = png;
  const stats = {};
  const failures = [];
  for (const [name, r] of Object.entries(regions)) {
    const px0 = Math.max(0, Math.floor(width * r.x0));
    const px1 = Math.min(width, Math.max(px0 + 1, Math.floor(width * r.x1)));
    const py0 = Math.max(0, Math.floor(height * r.y0));
    const py1 = Math.min(height, Math.max(py0 + 1, Math.floor(height * r.y1)));
    let sumR = 0, sumG = 0, sumB = 0, sumLum = 0, nonBlack = 0, count = 0;
    const stepX = Math.max(1, Math.floor((px1 - px0) / 64));
    const stepY = Math.max(1, Math.floor((py1 - py0) / 32));
    for (let y = py0; y < py1; y += stepY) {
      for (let x = px0; x < px1; x += stepX) {
        const i = (y * width + x) * 4;
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        sumR += R; sumG += G; sumB += B; sumLum += lum;
        if (lum > 20) nonBlack++;
        count++;
      }
    }
    const n = Math.max(1, count);
    const meanR = +(sumR / n).toFixed(1);
    const meanG = +(sumG / n).toFixed(1);
    const meanB = +(sumB / n).toFixed(1);
    const meanLum = +(sumLum / n).toFixed(1);
    const nonBlackRatio = +(nonBlack / n).toFixed(3);
    stats[name] = { meanR, meanG, meanB, meanLum, nonBlackRatio };
    if (meanLum < r.minLum || nonBlackRatio < r.minNonBlack) {
      failures.push(`iphone trailhead ${name} appears black/missing (lum=${meanLum}, nonBlack=${nonBlackRatio})`);
    } else if (r.minB !== undefined && meanB < r.minB) {
      failures.push(`iphone trailhead ${name} missing blue sky/snow (meanB=${meanB})`);
    } else if (r.minBMinusR !== undefined && (meanB - meanR) < r.minBMinusR) {
      failures.push(`iphone trailhead ${name} not blue sky (meanR=${meanR}, meanB=${meanB})`);
    } else if (r.minG !== undefined && meanG < r.minG) {
      failures.push(`iphone trailhead ${name} missing lit ground (meanG=${meanG})`);
    } else if (r.minGMinusB !== undefined && (meanG - meanB) < r.minGMinusB) {
      failures.push(`iphone trailhead ${name} ground collapsed/submerged (meanG=${meanG}, meanB=${meanB})`);
    }
  }
  return { ok: failures.length === 0, stats, failures };
}

export function parseSmokeArgs(argv, env = process.env) {
  let browserUrl = null;
  let forceDist = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--browser') {
      if (i + 1 >= argv.length || !argv[i + 1]) {
        throw new Error('--browser requires a URL');
      }
      browserUrl = argv[++i];
    } else if (a === '--dist') {
      forceDist = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  const base = forceDist ? '' : (env.BASE || '').trim();
  const ignoredBase = forceDist && (env.BASE || '').trim() ? (env.BASE || '').trim() : '';
  return { browserUrl, forceDist, base, ignoredBase };
}

export function measureWalkDistance(from, to, label) {
  for (const [which, sample] of [['start', from], ['end', to]]) {
    if (!sample || typeof sample !== 'object') {
      return { ok: false, distance: null, error: `playtest: ${label} ${which} sample is missing` };
    }
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.z)) {
      return {
        ok: false,
        distance: null,
        error: `playtest: ${label} ${which} has non-finite coordinates (x=${JSON.stringify(sample.x)}, z=${JSON.stringify(sample.z)})`,
      };
    }
  }
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  if (!Number.isFinite(distance)) {
    return { ok: false, distance: null, error: `playtest: ${label} produced non-finite distance` };
  }
  return { ok: true, distance, error: null };
}

export function classifySmokeConsoleMessage(type, text, loc = '', baseOrigin = '') {
  const msgType = String(type || '').toLowerCase();
  const body = String(text || '');
  const isError = msgType === 'error';
  const isWarn = msgType === 'warn' || msgType === 'warning';
  const isShaderIssue = /THREE\.WebGLProgram|Shader Error|GL_INVALID|\bINVALID_[A-Z_]+\b|WebGL:\s*INVALID_|compileShader|linkProgram/i.test(body);
  const isTokenMissing = /token missing/i.test(body);

  if (isTokenMissing) {
    return `console.${msgType}: ${body.slice(0, 300)}`;
  }
  if (isShaderIssue && (isError || isWarn)) {
    return `console.${msgType}: ${body.slice(0, 300)}`;
  }
  if (isError) {
    if (!isSameOriginUrl(loc, baseOrigin)) return null;
    if (isOptional404(body, loc, baseOrigin)) return null;
    return 'console.error: ' + body.slice(0, 300);
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findGpuRun() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, 'gpu-run'))) return path.join(dir, 'gpu-run');
  }
  const fallback = path.join(os.homedir(), '.local', 'bin', 'gpu-run');
  return isExecutable(fallback) ? fallback : null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startPreviewServer(lifecycle) {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    throw new Error('dist/index.html not found; run `npm run build` before smoke check.');
  }
  // Use Vite's own preview server handle with strictPort so the listening socket is guaranteed
  // to belong to this process and SIGTERM during startup cannot leak an orphan server.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (lifecycle.shuttingDown) throw new Error('Aborted during preview server startup');
    const port = await getFreePort();
    let previewServer = null;
    try {
      previewServer = await preview({
        root: ROOT,
        logLevel: 'error',
        preview: {
          host: '127.0.0.1',
          port,
          strictPort: true,
        },
      });
      lifecycle.server = previewServer;
      if (lifecycle.shuttingDown) {
        await previewServer.close();
        lifecycle.server = null;
        throw new Error('Aborted during preview server startup');
      }
      const addr = previewServer.httpServer?.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Vite preview server did not expose a listening TCP port');
      }
      const base = `http://127.0.0.1:${addr.port}/`;
      const stop = async () => {
        if (lifecycle.server === previewServer) lifecycle.server = null;
        await previewServer.close();
      };
      return { base, stop, pid: process.pid };
    } catch (err) {
      lastErr = err;
      if (previewServer) {
        if (lifecycle.server === previewServer) lifecycle.server = null;
        await previewServer.close().catch(() => {});
      }
      const msg = String(err?.message || '');
      if (err?.code === 'EADDRINUSE' || /already in use/i.test(msg)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('Failed to bind a free port for Vite preview server');
}

async function runBrowserSmoke(baseUrl) {
  const { launchBrowser } = await import('./chrome.mjs');
  const base = baseUrl.replace(/\/?$/, '/');
  const baseOrigin = new URL(base).origin;
  const { browser, renderer } = await launchBrowser();
  const errs = [];
  let p0 = null;
  let pAfterQ = null;
  let pBeforeW = null;
  let pAfterW = null;
  let qMoved = null;
  let wMoved = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      const errMsg = classifySmokeConsoleMessage(m.type(), m.text(), m.location()?.url || '', baseOrigin);
      if (errMsg) errs.push(errMsg);
    });

    await page.goto(`${base}?q=low`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 500 });
    const initErr = await page.evaluate(() => window.__error || null);
    if (initErr) {
      errs.push('init: ' + String(initErr).slice(0, 300));
    } else {
      await new Promise((r) => setTimeout(r, 1500));
      await page.mouse.click(640, 360);
      try {
        await page.waitForFunction(() => window.__game?.player?.enabled === true, { timeout: 15000, polling: 100 });
      } catch {
        errs.push('playtest: player was not enabled after clicking title');
      }
      p0 = await page.evaluate(() => ({
        x: window.__game.player.pos.x,
        z: window.__game.player.pos.z,
        enabled: window.__game.player.enabled,
        autoWalk: window.__game.player.autoWalk,
      }));

      // 1. Toggle autowalk ON with real KeyQ event and assert position changes.
      await page.keyboard.press('KeyQ');
      await new Promise((r) => setTimeout(r, 3500));
      pAfterQ = await page.evaluate(() => ({
        x: window.__game.player.pos.x,
        z: window.__game.player.pos.z,
        autoWalk: window.__game.player.autoWalk,
        speedNow: window.__game.player.speedNow,
      }));
      const qWalk = measureWalkDistance(p0, pAfterQ, 'autowalk (KeyQ)');
      qMoved = qWalk.distance;
      if (!pAfterQ.autoWalk) errs.push('playtest: KeyQ did not enable autowalk');
      if (!qWalk.ok) {
        errs.push(qWalk.error);
      } else if (qWalk.distance < MIN_WALK_DISTANCE) {
        errs.push(`playtest: autowalk (KeyQ) moved only ${qWalk.distance.toFixed(3)}m (< ${MIN_WALK_DISTANCE}m)`);
      }

      // 2. Toggle autowalk OFF with KeyQ and wait for velocity to settle to rest.
      await page.keyboard.press('KeyQ');
      try {
        await page.waitForFunction(
          () => !window.__game?.player?.autoWalk && Number.isFinite(window.__game?.player?.speedNow) && window.__game.player.speedNow < 0.05,
          { timeout: 6000, polling: 100 },
        );
      } catch {
        errs.push('playtest: player did not stop after toggling autowalk off with KeyQ');
      }
      pBeforeW = await page.evaluate(() => ({
        x: window.__game.player.pos.x,
        z: window.__game.player.pos.z,
        autoWalk: window.__game.player.autoWalk,
        speedNow: window.__game.player.speedNow,
      }));
      if (pBeforeW.autoWalk) errs.push('playtest: autowalk remained on before KeyW check');

      // 3. Hold W with real keydown/keyup events and assert movement from W alone.
      await page.keyboard.down('KeyW');
      await new Promise((r) => setTimeout(r, 2000));
      await page.keyboard.up('KeyW');
      pAfterW = await page.evaluate(() => ({
        x: window.__game.player.pos.x,
        z: window.__game.player.pos.z,
        dist: window.__game.player.distance,
        hours: window.__game.env.hours,
        audio: !!document.querySelector('canvas'),
        autoWalk: window.__game.player.autoWalk,
      }));
      const wWalk = measureWalkDistance(pBeforeW, pAfterW, 'KeyW');
      wMoved = wWalk.distance;
      if (pAfterW.autoWalk) errs.push('playtest: autowalk was unexpectedly on during KeyW check');
      if (!wWalk.ok) {
        errs.push(wWalk.error);
      } else if (wWalk.distance < MIN_WALK_DISTANCE) {
        errs.push(`playtest: KeyW alone moved only ${wWalk.distance.toFixed(3)}m (< ${MIN_WALK_DISTANCE}m)`);
      }

      const postErr = await page.evaluate(() => window.__error || null);
      if (postErr) errs.push('runtime: ' + String(postErr).slice(0, 300));
      if (!p0?.enabled && !errs.includes('playtest: player was not enabled after clicking title')) {
        errs.push('playtest: player was not enabled after clicking title');
      }
      if (!pAfterW?.audio) errs.push('playtest: canvas missing');
    }
  } finally {
    await browser.close();
  }

  // Second pass: iPhone WebGL2 extension profile (no OES_texture_float_linear / EXT_color_buffer_float / EXT_float_blend).
  const iphoneErrs = [];
  let iphonePixels = null;
  let iphoneCaps = null;
  const { browser: iphoneBrowser } = await launchBrowser([], { glProfile: 'iphone' });
  try {
    const page = await iphoneBrowser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => iphoneErrs.push('iphone pageerror: ' + e.message));
    page.on('console', (m) => {
      const errMsg = classifySmokeConsoleMessage(m.type(), m.text(), m.location()?.url || '', baseOrigin);
      if (errMsg) iphoneErrs.push('iphone ' + errMsg);
    });
    await page.goto(`${base}?capture&q=low&fast=2&trailf=0&time=15.8`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__shotReady || window.__error', { timeout: 300000, polling: 200 });
    const initErr = await page.evaluate(() => window.__error || null);
    if (initErr) {
      iphoneErrs.push('iphone init: ' + String(initErr).slice(0, 300));
    } else {
      iphoneCaps = await page.evaluate(() => {
        const gl = window.__game?.renderer?.getContext?.();
        return {
          floatLinear: gl ? !!gl.getExtension('OES_texture_float_linear') : null,
          colorBufferFloat: gl ? !!gl.getExtension('EXT_color_buffer_float') : null,
          floatBlend: gl ? !!gl.getExtension('EXT_float_blend') : null,
        };
      });
      if (iphoneCaps.floatLinear !== false) {
        iphoneErrs.push('iphone profile failed to disable OES_texture_float_linear');
      }
      const pngBuf = await page.screenshot({ type: 'png' });
      const png = PNG.sync.read(Buffer.from(pngBuf));
      const analysis = analyzeTrailheadRegions(png);
      iphonePixels = analysis.stats;
      if (!analysis.ok) iphoneErrs.push(...analysis.failures);
      const postErr = await page.evaluate(() => window.__error || null);
      if (postErr) iphoneErrs.push('iphone runtime: ' + String(postErr).slice(0, 300));
    }
  } finally {
    await iphoneBrowser.close();
  }

  errs.push(...iphoneErrs);
  const uniqueErrs = [...new Set(errs)];
  console.log(JSON.stringify({
    renderer,
    p0,
    pAfterQ,
    qMoved: qMoved === null ? null : +qMoved.toFixed(3),
    pBeforeW,
    pAfterW,
    wMoved: wMoved === null ? null : +wMoved.toFixed(3),
    iphoneCaps,
    iphonePixels,
    errs: uniqueErrs.slice(0, 10),
  }, null, 2));
  if (uniqueErrs.length > 0) process.exit(1);
}

if (IS_MAIN) {
  let opts;
  try {
    opts = parseSmokeArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`[smoke] ${err.message}`);
    process.exit(1);
  }

  if (opts.browserUrl) {
    await runBrowserSmoke(opts.browserUrl);
  } else {
    const lifecycle = { server: null, gpuChild: null, shuttingDown: false };
    const onSignal = async (sig) => {
      if (lifecycle.shuttingDown) return;
      lifecycle.shuttingDown = true;
      const exitCode = sig === 'SIGINT' ? 130 : 143;
      process.exitCode = exitCode;
      if (lifecycle.gpuChild && lifecycle.gpuChild.exitCode === null) {
        try {
          if (process.platform !== 'win32') process.kill(-lifecycle.gpuChild.pid, sig);
          else process.kill(lifecycle.gpuChild.pid, sig);
        } catch {}
      }
      if (lifecycle.server) {
        const srv = lifecycle.server;
        lifecycle.server = null;
        await srv.close().catch(() => {});
      }
      process.exit(exitCode);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    let server = null;
    try {
      if (opts.ignoredBase) {
        console.error(`[smoke] --dist set: ignoring BASE=${opts.ignoredBase} and serving dist/ via vite preview`);
      }
      let base = opts.base;
      if (!base) {
        server = await startPreviewServer(lifecycle);
        base = server.base;
        console.error(`[smoke] started vite preview of dist/ at ${base} (in-process pid ${server.pid})`);
      }
      const gpuRun = process.env.GPU_RUN_HELD !== '1' && process.platform !== 'win32' ? findGpuRun() : null;
      const cmd = gpuRun || process.execPath;
      const args = gpuRun ? [process.execPath, SELF_PATH, '--browser', base] : [SELF_PATH, '--browser', base];
      lifecycle.gpuChild = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', detached: process.platform !== 'win32' });
      const [code, signal] = await once(lifecycle.gpuChild, 'exit');
      lifecycle.gpuChild = null;
      if (signal) process.exitCode = 1;
      else process.exitCode = code ?? 1;
    } finally {
      if (server) {
        await server.stop().catch(() => {});
        console.error('[smoke] stopped vite preview server');
      }
    }
  }
}
