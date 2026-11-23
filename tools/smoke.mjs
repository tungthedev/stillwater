// Headless production smoke check.
// Serves dist/ with Vite preview on a free local port (always when --dist is passed,
// or when BASE is not provided in standalone runs), runs real input playtest checks
// under gpu-run, and fails on:
// - pageerror / window.__error
// - console.error (except benign 404s)
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
import { preview } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;

export const MIN_WALK_DISTANCE = 0.5;

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
    if (/Failed to load resource: the server responded with a status of 404/i.test(body)) return null;
    if (loc && baseOrigin && !loc.startsWith(baseOrigin)) return null;
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
  let qMoved = 0;
  let wMoved = 0;

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
      qMoved = Math.hypot(pAfterQ.x - p0.x, pAfterQ.z - p0.z);
      if (!pAfterQ.autoWalk) errs.push('playtest: KeyQ did not enable autowalk');
      if (qMoved < MIN_WALK_DISTANCE) {
        errs.push(`playtest: autowalk (KeyQ) moved only ${qMoved.toFixed(3)}m (< ${MIN_WALK_DISTANCE}m)`);
      }

      // 2. Toggle autowalk OFF with KeyQ and wait for velocity to settle to rest.
      await page.keyboard.press('KeyQ');
      try {
        await page.waitForFunction(
          () => !window.__game?.player?.autoWalk && window.__game?.player?.speedNow < 0.05,
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
      wMoved = Math.hypot(pAfterW.x - pBeforeW.x, pAfterW.z - pBeforeW.z);
      if (pAfterW.autoWalk) errs.push('playtest: autowalk was unexpectedly on during KeyW check');
      if (wMoved < MIN_WALK_DISTANCE) {
        errs.push(`playtest: KeyW alone moved only ${wMoved.toFixed(3)}m (< ${MIN_WALK_DISTANCE}m)`);
      }

      const postErr = await page.evaluate(() => window.__error || null);
      if (postErr) errs.push('runtime: ' + String(postErr).slice(0, 300));
      if (!p0?.enabled && !errs.includes('playtest: player was not enabled after clicking title')) {
        errs.push('playtest: player was not enabled after clicking title');
      }
      if (!pAfterW?.audio) errs.push('playtest: canvas missing');
    }
    console.log(JSON.stringify({
      renderer,
      p0,
      pAfterQ,
      qMoved: +qMoved.toFixed(3),
      pBeforeW,
      pAfterW,
      wMoved: +wMoved.toFixed(3),
      errs: errs.slice(0, 10),
    }, null, 2));
  } finally {
    await browser.close();
  }
  if (errs.length > 0) process.exit(1);
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
