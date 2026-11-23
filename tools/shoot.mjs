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

const SELF_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;

if (IS_MAIN) {
  const { launchBrowser } = await import('./chrome.mjs');
  const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
  const OUT = process.env.OUT || 'captures';
  const W = +(process.env.W || SHOTS_CONFIG.width || 1600);
  const H = +(process.env.H || SHOTS_CONFIG.height || 900);
  const Q = process.env.Q || 'ultra';
  const FAST_FRAMES = +(process.env.FAST_FRAMES || SHOTS_CONFIG.fastFrames || 2);
  const CONCURRENCY = Math.max(1, +(process.env.CONCURRENCY || 1));
  const SEED = +(process.env.SEED || 1337);

  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(REVIEW_SHOTS);
  fs.mkdirSync(OUT, { recursive: true });

  const { browser, renderer } = await launchBrowser();
  if (process.env.WRITE_RENDERER === '1') {
    fs.writeFileSync(path.join(OUT, 'renderer.txt'), renderer + '\n', 'utf8');
  }
  console.error(`[shoot] renderer=${renderer} q=${Q} size=${W}x${H} shots=${names.length} concurrency=${CONCURRENCY}`);

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
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`.slice(0, 400));
    });
    page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
    let loaded = false;
    try {
      while (nextIdx < names.length) {
        const name = names[nextIdx++];
        const query = SHOTS[name] || name;
        const t0 = Date.now();
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
          logs.push('timeout waiting for shot ' + name);
        }
        const err = await page.evaluate(() => window.__error || null);
        const info = await page.evaluate(() => window.__info || null);
        await new Promise((r) => setTimeout(r, 80));
        const file = path.join(OUT, `${name}.png`);
        await page.screenshot({ path: file });
        if (err || timedOut) failed++;
        console.log(JSON.stringify({ name, file, ms: Date.now() - t0, err, info, logs: [...new Set(logs)].slice(0, 12) }));
        logs.length = 0;
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
