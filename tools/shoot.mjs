// Headless screenshot harness. Usage: node tools/shoot.mjs [shotName ...]
// Reads the 16 pinned review shots (plus extra debug poses) from tools/shots.json.
// Reuses loaded WebGL pages across shots via window.__applyShot() with optional parallel workers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS_PATH = new URL('./shots.json', import.meta.url);
export const SHOTS_CONFIG = JSON.parse(fs.readFileSync(SHOTS_PATH, 'utf8'));
export const REVIEW_SHOTS = SHOTS_CONFIG.shots;
export const DEBUG_SHOTS = SHOTS_CONFIG.debugShots || {};
export const SHOTS = { ...REVIEW_SHOTS, ...DEBUG_SHOTS };

export const TITLE_FONT_CHECKS = [
  { family: 'Cormorant Garamond', weight: '300', style: 'normal', query: '300 16px "Cormorant Garamond"', sample: 'STILLWATER' },
  { family: 'Cormorant Garamond', weight: '400', style: 'italic', query: 'italic 400 16px "Cormorant Garamond"', sample: 'a slow walk into the high country' },
  { family: 'Inter', weight: '400', style: 'normal', query: '400 16px "Inter"', sample: 'click anywhere to begin' },
  { family: 'Inter', weight: '500', style: 'normal', query: '500 16px "Inter"', sample: 'WASD' },
];

export function parseStrictInt(raw, name, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required integer parameter ${name}`);
  }
  const s = String(raw).trim();
  if (s === '' || !/^-?\d+$/.test(s)) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected an integer >= ${min})`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} (expected an integer between ${min} and ${max})`);
  }
  return n;
}

export function parseShootConfig(argv = [], env = process.env, config = SHOTS_CONFIG) {
  const base = (env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
  const out = env.OUT || 'captures';
  const width = parseStrictInt(env.W, 'W', { min: 1, fallback: config.width || 1600 });
  const height = parseStrictInt(env.H, 'H', { min: 1, fallback: config.height || 900 });
  const q = env.Q || 'ultra';
  const fastFrames = parseStrictInt(env.FAST_FRAMES, 'FAST_FRAMES', { min: 1, fallback: config.fastFrames || 2 });
  const concurrency = parseStrictInt(env.CONCURRENCY, 'CONCURRENCY', { min: 1, fallback: config.concurrency || 1 });
  const seed = parseStrictInt(env.SEED, 'SEED', { min: 0, fallback: config.seed ?? 1337 });
  const fontTimeoutMs = parseStrictInt(env.FONT_TIMEOUT_MS, 'FONT_TIMEOUT_MS', { min: 100, fallback: 15000 });
  const names = argv.length ? argv.map((s) => s.trim()).filter(Boolean) : Object.keys(config.shots);
  if (names.length === 0) {
    throw new Error('No shots selected for capture');
  }
  return { base, out, width, height, q, fastFrames, concurrency, seed, fontTimeoutMs, names };
}

export function isTitleShotQuery(query) {
  return Boolean(new URLSearchParams(String(query || '')).get('title'));
}

export function classifyCaptureConsoleMessage(type, text, loc = '', baseOrigin = '') {
  const msgType = String(type || '').toLowerCase();
  const body = String(text || '');
  const isError = msgType === 'error';
  const isWarn = msgType === 'warn' || msgType === 'warning';
  const isTokenMissing = /token missing/i.test(body);
  const isShaderIssue = /THREE\.WebGLProgram|Shader Error|compileShader|linkProgram/i.test(body);
  const isWebglInvalid = /\b(?:GL_)?INVALID_[A-Z_]+\b|WebGL:\s*INVALID_/i.test(body);

  if (isTokenMissing) {
    return { record: true, fatal: true, reason: `console.${msgType}: ${body.slice(0, 400)}` };
  }
  if ((isError || isWarn) && (isShaderIssue || isWebglInvalid)) {
    return { record: true, fatal: true, reason: `console.${msgType}: ${body.slice(0, 400)}` };
  }
  if (isError) {
    const isBenign404 = /Failed to load resource: the server responded with a status of 404/i.test(body);
    const sameOrigin = !loc || !baseOrigin || loc.startsWith(baseOrigin);
    if (!isBenign404 && sameOrigin) {
      return { record: true, fatal: true, reason: `console.${msgType}: ${body.slice(0, 400)}` };
    }
    return { record: true, fatal: false, reason: `console.${msgType}: ${body.slice(0, 400)}` };
  }
  if (isWarn) {
    return { record: true, fatal: false, reason: `console.${msgType}: ${body.slice(0, 400)}` };
  }
  return { record: false, fatal: false, reason: null };
}

async function waitForTitleFonts(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastMissing = [];
  let stylesheetRetries = 0;
  let lastRetryAt = 0;
  while (Date.now() < deadline) {
    const remaining = Math.max(100, deadline - Date.now());
    let timer = null;
    try {
      const state = await Promise.race([
        page.evaluate(async (checks) => {
          await document.fonts.ready;
          await Promise.all(
            checks.map((c) => document.fonts.load(c.query, c.sample).catch(() => [])),
          );
          await document.fonts.ready;
          const faces = Array.from(document.fonts);
          const norm = (f) => String(f || '').replace(/^['"]+|['"]+$/g, '').trim().toLowerCase();
          const weightMatches = (faceWeight, wantWeight) => {
            const w = String(faceWeight || '').trim();
            const target = Number(wantWeight);
            if (w === String(wantWeight)) return true;
            if (w === 'normal' && target === 400) return true;
            if (w === 'bold' && target === 700) return true;
            const parts = w.split(/\s+/).map(Number);
            if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
              return target >= parts[0] && target <= parts[1];
            }
            return false;
          };
          const missing = [];
          for (const c of checks) {
            const wantFamily = c.family.toLowerCase();
            const hasLoadedFace = faces.some((f) => {
              if (f.status !== 'loaded') return false;
              if (norm(f.family) !== wantFamily) return false;
              const styleMatch = !c.style || f.style === c.style;
              const weightMatch = !c.weight || weightMatches(f.weight, c.weight);
              return styleMatch && weightMatch;
            });
            const checkOk = document.fonts.check(c.query, c.sample);
            if (!hasLoadedFace || !checkOk) {
              missing.push(`${c.query} (loadedFace=${hasLoadedFace}, check=${checkOk})`);
            }
          }
          return { ok: missing.length === 0, missing, faceCount: faces.length };
        }, TITLE_FONT_CHECKS),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Title fonts timed out after ${timeoutMs}ms`)), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (state.ok) {
        // Wait two animation frames so the DOM repaints with the loaded web fonts before capture.
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        return { ok: true, missing: [] };
      }
      lastMissing = state.missing;
      // If a transient network hiccup (e.g. ERR_NETWORK_CHANGED) dropped the Google Fonts
      // stylesheet on initial load, Chromium does not retry <link rel="stylesheet"> automatically;
      // re-attaching it up to twice recovers transient blips while still failing within timeoutMs.
      if (state.faceCount === 0 && stylesheetRetries < 2 && Date.now() - lastRetryAt >= 1000) {
        stylesheetRetries++;
        lastRetryAt = Date.now();
        await page.evaluate(() => {
          const existing = document.querySelector('link[rel="stylesheet"][href*="fonts.googleapis.com"]');
          if (!existing) return;
          const fresh = document.createElement('link');
          fresh.rel = 'stylesheet';
          fresh.href = existing.href;
          document.head.appendChild(fresh);
        }).catch(() => {});
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: err?.message || String(err) };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const detail = lastMissing.length ? `: ${lastMissing.join('; ')}` : '';
  return { ok: false, error: `Title fonts did not load within ${timeoutMs}ms${detail}` };
}

const SELF_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;

if (IS_MAIN) {
  let cfg;
  try {
    cfg = parseShootConfig(process.argv.slice(2), process.env, SHOTS_CONFIG);
  } catch (err) {
    console.error(`[shoot] ${err.message}`);
    process.exit(1);
  }

  const { launchBrowser } = await import('./chrome.mjs');
  const { base: BASE, out: OUT, width: W, height: H, q: Q, fastFrames: FAST_FRAMES, concurrency: CONCURRENCY, seed: SEED, fontTimeoutMs: FONT_TIMEOUT_MS, names } = cfg;
  const baseOrigin = new URL(BASE).origin;
  fs.mkdirSync(OUT, { recursive: true });

  const { browser, renderer } = await launchBrowser();
  if (process.env.WRITE_RENDERER === '1') {
    fs.writeFileSync(path.join(OUT, 'renderer.txt'), renderer + '\n', 'utf8');
  }
  console.error(`[shoot] renderer=${renderer} q=${Q} size=${W}x${H} shots=${names.length} concurrency=${CONCURRENCY} seed=${SEED} fast=${FAST_FRAMES}`);

  const workers = Math.min(CONCURRENCY, names.length);
  let nextIdx = 0;
  let failed = 0;

  async function runWorker() {
    const page = await browser.newPage();
    // Seed Math.random deterministically per capture page so unseeded runtime randomness
    // (herd wandering in animals.js, wood grain in props.js, water ripples) stays repeatable
    // across visual diff runs without altering game code.
    await page.evaluateOnNewDocument((seed) => {
      let s = seed >>> 0;
      Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }, SEED);
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const logs = [];
    const shotErrors = [];
    page.on('console', (m) => {
      const cls = classifyCaptureConsoleMessage(m.type(), m.text(), m.location()?.url || '', baseOrigin);
      if (cls.record && cls.reason) logs.push(cls.reason);
      if (cls.fatal && cls.reason) shotErrors.push(cls.reason);
    });
    page.on('pageerror', (e) => {
      const msg = 'pageerror: ' + (e?.message || String(e));
      logs.push(msg);
      shotErrors.push(msg);
    });
    let loaded = false;
    try {
      while (nextIdx < names.length) {
        const name = names[nextIdx++];
        const query = SHOTS[name] || name;
        const t0 = Date.now();
        logs.length = 0;
        shotErrors.length = 0;
        if (!loaded) {
          await page.goto(`${BASE}?capture&q=${Q}&fast=${FAST_FRAMES}&${query}`, { waitUntil: 'load', timeout: 120000 });
          loaded = true;
        } else {
          await page.evaluate((q, f) => window.__applyShot(q, f), query, FAST_FRAMES);
        }
        let timedOut = false;
        try {
          await page.waitForFunction('window.__shotReady || window.__error', { timeout: 300000, polling: 200 });
        } catch {
          timedOut = true;
          const msg = 'timeout waiting for shot ' + name;
          logs.push(msg);
          shotErrors.push(msg);
        }
        if (!timedOut && isTitleShotQuery(query)) {
          const fontResult = await waitForTitleFonts(page, FONT_TIMEOUT_MS);
          if (!fontResult.ok) {
            logs.push(fontResult.error);
            shotErrors.push(fontResult.error);
          }
        }
        const info = await page.evaluate(() => window.__info || null);
        await new Promise((r) => setTimeout(r, 80));
        const file = path.join(OUT, `${name}.png`);
        await page.screenshot({ path: file });
        // Re-check window.__error after screenshot so post-__shotReady errors are never dropped.
        const err = await page.evaluate(() => window.__error || null);
        if (err) shotErrors.push('window.__error: ' + String(err));
        const uniqueErrors = [...new Set(shotErrors)];
        if (uniqueErrors.length > 0 || timedOut) failed++;
        console.log(JSON.stringify({
          name,
          file,
          ms: Date.now() - t0,
          err,
          errors: uniqueErrors.slice(0, 12),
          info,
          logs: [...new Set(logs)].slice(0, 12),
        }));
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  try {
    await Promise.all(Array.from({ length: workers }, runWorker));
  } finally {
    await browser.close();
  }
  if (failed > 0) process.exit(1);
}
