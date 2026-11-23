// Headless production smoke check.
// Serves dist/ with `vite preview` on a free local port (unless BASE is provided),
// runs the playtest input flow under gpu-run, and fails on:
// - pageerror / window.__error
// - console.error (except benign 404s)
// - shader compile/link errors (THREE.WebGLProgram / GL_INVALID)
// - patchMaterial `token missing` warnings (src/patch.js:37, :98)
// Always stops the preview server by PID before exiting.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_PATH = fileURLToPath(import.meta.url);

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

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server starting
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for preview server at ${url}`);
}

async function startPreviewServer() {
  const distIndex = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    throw new Error('dist/index.html not found; run `npm run build` before smoke check.');
  }
  const port = await getFreePort();
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const base = `http://127.0.0.1:${port}/`;
  const stop = async () => {
    if (child.exitCode !== null || child.killed) return;
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }
    }, 3000);
    await once(child, 'exit').catch(() => {});
    clearTimeout(timer);
  };
  try {
    await waitForHttp(base, 30000);
  } catch (err) {
    await stop();
    throw new Error(`${err.message}\n${stderr}`, { cause: err });
  }
  return { base, stop, pid: child.pid };
}

async function runBrowserSmoke(baseUrl) {
  const { launchBrowser } = await import('./chrome.mjs');
  const base = baseUrl.replace(/\/?$/, '/');
  const baseOrigin = new URL(base).origin;
  const { browser, renderer } = await launchBrowser();
  const errs = [];
  let p0 = null;
  let p1 = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      const type = m.type();
      const text = m.text();
      const loc = m.location()?.url || '';
      const isShaderIssue = /THREE\.WebGLProgram|Shader Error|GL_INVALID|INVALID_OPERATION|compileShader|linkProgram/i.test(text);
      const isTokenMissing = /token missing/i.test(text);
      if (isTokenMissing) {
        errs.push(`console.${type}: ${text.slice(0, 300)}`);
        return;
      }
      if (isShaderIssue && (type === 'error' || type === 'warning')) {
        errs.push(`console.${type}: ${text.slice(0, 300)}`);
        return;
      }
      if (type === 'error') {
        if (/Failed to load resource: the server responded with a status of 404/i.test(text)) return;
        if (loc && !loc.startsWith(baseOrigin)) return;
        errs.push('console.error: ' + text.slice(0, 300));
      }
    });

    await page.goto(`${base}?q=low`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 500 });
    const initErr = await page.evaluate(() => window.__error || null);
    if (initErr) {
      errs.push('init: ' + String(initErr).slice(0, 300));
    } else {
      await new Promise((r) => setTimeout(r, 2000));
      await page.mouse.click(640, 360);
      await new Promise((r) => setTimeout(r, 4000));
      p0 = await page.evaluate(() => ({
        x: window.__game.player.pos.x,
        z: window.__game.player.pos.z,
        enabled: window.__game.player.enabled,
      }));
      await page.keyboard.press('KeyQ');
      await new Promise((r) => setTimeout(r, 6000));
      await page.keyboard.down('KeyW');
      await new Promise((r) => setTimeout(r, 1500));
      await page.keyboard.up('KeyW');
      p1 = await page.evaluate(() => ({
        x: window.__game.player.pos.x,
        z: window.__game.player.pos.z,
        dist: window.__game.player.distance,
        hours: window.__game.env.hours,
        audio: !!document.querySelector('canvas'),
      }));
      const postErr = await page.evaluate(() => window.__error || null);
      if (postErr) errs.push('runtime: ' + String(postErr).slice(0, 300));
      if (!p0?.enabled) errs.push('playtest: player was not enabled after clicking title');
      if (!p1?.audio) errs.push('playtest: canvas missing');
    }
    console.log(JSON.stringify({ renderer, p0, p1, errs: errs.slice(0, 10) }, null, 2));
  } finally {
    await browser.close();
  }
  if (errs.length > 0) process.exit(1);
}

const browserIdx = process.argv.indexOf('--browser');
if (browserIdx !== -1) {
  const url = process.argv[browserIdx + 1];
  if (!url) {
    console.error('[smoke] --browser requires a URL');
    process.exit(1);
  }
  await runBrowserSmoke(url);
} else {
  let server = null;
  let gpuChild = null;
  const onSignal = async (sig) => {
    if (gpuChild && gpuChild.exitCode === null) {
      try {
        if (process.platform !== 'win32') process.kill(-gpuChild.pid, sig);
        else process.kill(gpuChild.pid, sig);
      } catch {}
    }
    if (server) await server.stop();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    let base = process.env.BASE || '';
    if (!base) {
      server = await startPreviewServer();
      base = server.base;
      console.error(`[smoke] started vite preview at ${base} (pid ${server.pid})`);
    }
    const gpuRun = process.env.GPU_RUN_HELD !== '1' && process.platform !== 'win32' ? findGpuRun() : null;
    const cmd = gpuRun || process.execPath;
    const args = gpuRun ? [process.execPath, SELF_PATH, '--browser', base] : [SELF_PATH, '--browser', base];
    gpuChild = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', detached: process.platform !== 'win32' });
    const [code, signal] = await once(gpuChild, 'exit');
    if (signal) process.exitCode = 1;
    else process.exitCode = code ?? 1;
  } finally {
    if (server) {
      await server.stop();
      console.error('[smoke] stopped vite preview server');
    }
  }
}
