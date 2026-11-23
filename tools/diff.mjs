// Visual regression diff harness.
// Usage: node tools/diff.mjs [--tiers ultra,low] [--shots name1,name2] [--base http://127.0.0.1:5178/]
// Reshoots the 16 pinned review shots at ultra and low against captures/golden-ultra/ and
// captures/golden-low/, verifies the WebGL2 renderer and pinned dimensions match, runs pixelmatch,
// and writes a side-by-side HTML sheet to captures/diff-report.html.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import { parseStrictInt } from './shoot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_PATH = path.join(ROOT, 'tools', 'shots.json');
export const SHOTS_CONFIG = JSON.parse(fs.readFileSync(SHOTS_PATH, 'utf8'));
export const MANIFEST_FILENAME = 'manifest.json';
export const MANIFEST_VERSION = 1;

export function getPinnedCaptureEnv(config = SHOTS_CONFIG) {
  return {
    width: parseStrictInt(config.width, 'shots.json width', { min: 1 }),
    height: parseStrictInt(config.height, 'shots.json height', { min: 1 }),
    fastFrames: parseStrictInt(config.fastFrames, 'shots.json fastFrames', { min: 1 }),
    seed: parseStrictInt(config.seed ?? 1337, 'shots.json seed', { min: 0 }),
    concurrency: parseStrictInt(config.concurrency ?? 1, 'shots.json concurrency', { min: 1 }),
    fontTimeoutMs: parseStrictInt(config.fontTimeoutMs ?? 15000, 'shots.json fontTimeoutMs', { min: 100 }),
  };
}

export function parseArgs(argv, env = process.env, config = SHOTS_CONFIG) {
  const pinned = getPinnedCaptureEnv(config);
  // Validate env.CONCURRENCY upfront so invalid values like CONCURRENCY=typo fail before launch,
  // while valid shell overrides are still overridden by the pinned golden capture settings.
  if (env.CONCURRENCY !== undefined) {
    parseStrictInt(env.CONCURRENCY, 'CONCURRENCY', { min: 1 });
  }
  const opts = {
    tiers: ['ultra', 'low'],
    shots: Object.keys(config.shots),
    base: env.BASE || '',
    outDir: path.join(ROOT, 'captures', 'diff-current'),
    outExplicit: false,
    diffDir: path.join(ROOT, 'captures', 'diff-output'),
    reportPath: path.join(ROOT, 'captures', 'diff-report.html'),
    concurrency: pinned.concurrency,
    concurrencyExplicit: false,
    skipShoot: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--tiers') {
      opts.tiers = next().split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--shots') {
      opts.shots = next().split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--base') {
      opts.base = next().trim();
      if (!opts.base) throw new Error('--base requires a non-empty URL');
    } else if (a === '--out') {
      const val = next().trim();
      if (!val) throw new Error('--out requires a non-empty path');
      opts.outDir = path.resolve(val);
      opts.outExplicit = true;
    } else if (a === '--report') {
      const val = next().trim();
      if (!val) throw new Error('--report requires a non-empty path');
      opts.reportPath = path.resolve(val);
    } else if (a === '--concurrency') {
      opts.concurrency = parseStrictInt(next(), '--concurrency', { min: 1 });
      opts.concurrencyExplicit = true;
    } else if (a === '--skip-shoot') {
      opts.skipShoot = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (opts.tiers.length === 0) {
    throw new Error('--tiers must select at least one tier');
  }
  if (opts.shots.length === 0) {
    throw new Error('--shots must select at least one shot');
  }
  return opts;
}

export function buildShootEnv(baseEnv, { base, tier, tierOut, concurrency }, config = SHOTS_CONFIG) {
  const pinned = getPinnedCaptureEnv(config);
  return {
    ...baseEnv,
    BASE: base,
    Q: tier,
    OUT: tierOut,
    W: String(pinned.width),
    H: String(pinned.height),
    FAST_FRAMES: String(pinned.fastFrames),
    SEED: String(pinned.seed),
    CONCURRENCY: String(concurrency),
    FONT_TIMEOUT_MS: String(pinned.fontTimeoutMs),
    WRITE_RENDERER: '1',
  };
}

export function hashFileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function buildCaptureManifest({ renderer, tiers, shots, pinned, concurrency, stageDir }) {
  const files = {};
  for (const tier of tiers) {
    for (const shot of shots) {
      const filePath = path.join(stageDir, tier, `${shot}.png`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing staged screenshot for manifest: ${filePath}`);
      }
      const buf = fs.readFileSync(filePath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      files[`${tier}/${shot}.png`] = { sha256, bytes: buf.length };
    }
  }
  return {
    version: MANIFEST_VERSION,
    status: 'ok',
    createdAt: new Date().toISOString(),
    renderer,
    tiers: [...tiers],
    shots: [...shots],
    pinned: {
      width: pinned.width,
      height: pinned.height,
      fastFrames: pinned.fastFrames,
      seed: pinned.seed,
      concurrency,
      fontTimeoutMs: pinned.fontTimeoutMs,
    },
    files,
  };
}

export function promoteStagedCapture(stageDir, outDir, manifest) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const tier of manifest.tiers) {
    const targetTierDir = path.join(outDir, tier);
    fs.mkdirSync(targetTierDir, { recursive: true });
    for (const shot of manifest.shots) {
      const src = path.join(stageDir, tier, `${shot}.png`);
      const dst = path.join(targetTierDir, `${shot}.png`);
      fs.renameSync(src, dst);
    }
    const stagedTierRenderer = path.join(stageDir, tier, 'renderer.txt');
    if (fs.existsSync(stagedTierRenderer)) {
      fs.renameSync(stagedTierRenderer, path.join(targetTierDir, 'renderer.txt'));
    }
  }
  const stagedRenderer = path.join(stageDir, 'renderer.txt');
  fs.writeFileSync(stagedRenderer, manifest.renderer + '\n', 'utf8');
  fs.renameSync(stagedRenderer, path.join(outDir, 'renderer.txt'));

  const stagedManifest = path.join(stageDir, MANIFEST_FILENAME);
  fs.writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(stagedManifest, path.join(outDir, MANIFEST_FILENAME));

  fs.rmSync(stageDir, { recursive: true, force: true });
}

export function validateCaptureManifest(outDir, { tiers, shots, goldenRenderers, pinned, concurrency }) {
  const manifestPath = path.join(outDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing capture manifest: ${manifestPath} (re-run without --skip-shoot to produce a verified capture)`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in capture manifest ${manifestPath}: ${err.message}`, { cause: err });
  }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== MANIFEST_VERSION || manifest.status !== 'ok') {
    throw new Error(`Invalid or incomplete capture manifest: ${manifestPath}`);
  }
  const manifestRenderer = String(manifest.renderer || '').trim();
  const currentRenderers = {};
  for (const tier of tiers) {
    currentRenderers[tier] = manifestRenderer;
  }
  validateRendererMatch({ tiers, goldenRenderers, currentRenderers });

  const fileRenderers = readCurrentRenderers(outDir, tiers);
  for (const tier of tiers) {
    if (fileRenderers[tier] && fileRenderers[tier] !== manifestRenderer) {
      throw new Error(
        `Conflicting renderer metadata for tier ${tier}: manifest (${manifestRenderer}) vs renderer.txt (${fileRenderers[tier]})`,
      );
    }
  }

  const expectedPinned = {
    width: pinned.width,
    height: pinned.height,
    fastFrames: pinned.fastFrames,
    seed: pinned.seed,
    concurrency,
    fontTimeoutMs: pinned.fontTimeoutMs,
  };
  for (const [key, expectedVal] of Object.entries(expectedPinned)) {
    if (manifest.pinned?.[key] !== expectedVal) {
      throw new Error(
        `Capture manifest pinned setting mismatch for ${key}: manifest has ${JSON.stringify(manifest.pinned?.[key])}, expected ${JSON.stringify(expectedVal)}`,
      );
    }
  }

  if (!Array.isArray(manifest.tiers) || !Array.isArray(manifest.shots)) {
    throw new Error(`Capture manifest ${manifestPath} is missing tiers or shots arrays`);
  }
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`Capture manifest ${manifestPath} is missing files hash map`);
  }
  for (const mTier of manifest.tiers) {
    for (const mShot of manifest.shots) {
      const key = `${mTier}/${mShot}.png`;
      if (!manifest.files[key]) {
        throw new Error(`Capture manifest ${manifestPath} is incomplete: missing file entry for ${key}`);
      }
    }
  }
  for (const tier of tiers) {
    if (!manifest.tiers.includes(tier)) {
      throw new Error(`Capture manifest ${manifestPath} does not include requested tier ${tier}`);
    }
  }
  for (const shot of shots) {
    if (!manifest.shots.includes(shot)) {
      throw new Error(`Capture manifest ${manifestPath} does not include requested shot ${shot}`);
    }
  }
  for (const tier of tiers) {
    for (const shot of shots) {
      const key = `${tier}/${shot}.png`;
      const entry = manifest.files[key];
      if (!entry || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`Capture manifest ${manifestPath} has invalid sha256 entry for ${key}`);
      }
      const filePath = path.join(outDir, tier, `${shot}.png`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing screenshot listed in manifest: ${filePath}`);
      }
      const actualHash = hashFileSha256(filePath);
      if (actualHash !== entry.sha256) {
        throw new Error(
          `SHA-256 mismatch for ${key}: expected ${entry.sha256}, got ${actualHash}`,
        );
      }
    }
  }
  return { manifest, renderer: manifestRenderer };
}

export function readCurrentRenderers(outDir, tiers) {
  const topFile = path.join(outDir, 'renderer.txt');
  const topRenderer = fs.existsSync(topFile) ? fs.readFileSync(topFile, 'utf8').trim() : '';
  const result = {};
  for (const tier of tiers) {
    const tierFile = path.join(outDir, tier, 'renderer.txt');
    const tierRenderer = fs.existsSync(tierFile) ? fs.readFileSync(tierFile, 'utf8').trim() : '';
    if (tierRenderer && topRenderer && tierRenderer !== topRenderer) {
      throw new Error(
        `Conflicting renderer metadata for tier ${tier}: ${tierFile} (${tierRenderer}) vs ${topFile} (${topRenderer})`,
      );
    }
    result[tier] = tierRenderer || topRenderer;
  }
  return result;
}

export function validateRendererMatch({ tiers, goldenRenderers, currentRenderers }) {
  if (!tiers || tiers.length === 0) {
    throw new Error('No tiers provided for renderer validation');
  }
  for (const tier of tiers) {
    const expected = String(goldenRenderers?.[tier] || '').trim();
    const actual = String(currentRenderers?.[tier] || '').trim();
    if (!expected) {
      throw new Error(`Missing or empty golden renderer metadata for tier ${tier}`);
    }
    if (!actual) {
      const err = new Error(`Missing or empty current capture renderer metadata for tier ${tier} (expected renderer.txt)`);
      err.code = 'RENDERER_MISSING';
      throw err;
    }
    if (expected !== actual) {
      const err = new Error(
        `Renderer mismatch for golden-${tier}!\n  golden : ${expected}\n  current: ${actual}\nRefusing to compare screenshots across different GPUs/drivers.`,
      );
      err.code = 'RENDERER_MISMATCH';
      throw err;
    }
  }
  return currentRenderers[tiers[0]];
}

export function validateImageDimensions(label, img, expectedWidth, expectedHeight) {
  if (img.width !== expectedWidth || img.height !== expectedHeight) {
    throw new Error(
      `Invalid dimensions for ${label}: ${img.width}x${img.height} (expected ${expectedWidth}x${expectedHeight})`,
    );
  }
}

export function masksFor(shot, config = SHOTS_CONFIG) {
  const raw = config.diff?.masks?.[shot];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((rect, idx) => {
    if (!rect || typeof rect !== 'object') {
      throw new Error(`Invalid mask #${idx} for shot ${shot}: expected object`);
    }
    const x = parseStrictInt(rect.x, `mask[${idx}].x`, { min: 0 });
    const y = parseStrictInt(rect.y, `mask[${idx}].y`, { min: 0 });
    const width = parseStrictInt(rect.width, `mask[${idx}].width`, { min: 1 });
    const height = parseStrictInt(rect.height, `mask[${idx}].height`, { min: 1 });
    return { x, y, width, height, ...(rect.reason ? { reason: String(rect.reason) } : {}) };
  });
}

export function validateMaskRects(masks, expectedWidth, expectedHeight, label) {
  for (let i = 0; i < masks.length; i++) {
    const r = masks[i];
    if (
      !Number.isSafeInteger(r.x) || !Number.isSafeInteger(r.y) ||
      !Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) ||
      r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 ||
      r.x + r.width > expectedWidth || r.y + r.height > expectedHeight
    ) {
      throw new Error(
        `Mask #${i} out of bounds for ${label}: (${r.x},${r.y} ${r.width}x${r.height}) exceeds ${expectedWidth}x${expectedHeight}`,
      );
    }
  }
}

function drawMaskOutline(diffData, width, height, rect) {
  // Draw a 2px cyan border around the excluded mask rectangle so it stands out on the diff sheet.
  const setPixel = (px, py) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const i = (py * width + px) * 4;
    diffData[i] = 0;
    diffData[i + 1] = 229;
    diffData[i + 2] = 255;
    diffData[i + 3] = 255;
  };
  const x0 = Math.max(0, rect.x - 1);
  const x1 = Math.min(width - 1, rect.x + rect.width);
  const y0 = Math.max(0, rect.y - 1);
  const y1 = Math.min(height - 1, rect.y + rect.height);
  for (let x = x0; x <= x1; x++) {
    setPixel(x, y0);
    setPixel(x, rect.y);
    setPixel(x, rect.y + rect.height - 1);
    setPixel(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    setPixel(x0, y);
    setPixel(rect.x, y);
    setPixel(rect.x + rect.width - 1, y);
    setPixel(x1, y);
  }
}

export function comparePngBuffers(goldenBuf, currentBuf, { expectedWidth, expectedHeight, pixelmatchThreshold, masks = [], label }) {
  const gImg = PNG.sync.read(goldenBuf);
  const cImg = PNG.sync.read(currentBuf);
  validateImageDimensions(`golden ${label}`, gImg, expectedWidth, expectedHeight);
  validateImageDimensions(`current ${label}`, cImg, expectedWidth, expectedHeight);
  validateMaskRects(masks, expectedWidth, expectedHeight, label);

  let currentData = cImg.data;
  let maskedPixels = 0;
  if (masks.length > 0) {
    currentData = Buffer.from(cImg.data);
    const maskedFlag = new Uint8Array(expectedWidth * expectedHeight);
    for (const rect of masks) {
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
          const pIdx = y * expectedWidth + x;
          if (!maskedFlag[pIdx]) {
            maskedFlag[pIdx] = 1;
            maskedPixels++;
          }
          const bIdx = pIdx * 4;
          currentData[bIdx] = gImg.data[bIdx];
          currentData[bIdx + 1] = gImg.data[bIdx + 1];
          currentData[bIdx + 2] = gImg.data[bIdx + 2];
          currentData[bIdx + 3] = gImg.data[bIdx + 3];
        }
      }
    }
  }

  const totalPixels = expectedWidth * expectedHeight;
  const diffImg = new PNG({ width: expectedWidth, height: expectedHeight });
  const mismatchPixels = pixelmatch(gImg.data, currentData, diffImg.data, expectedWidth, expectedHeight, {
    threshold: pixelmatchThreshold,
    includeAA: false,
  });
  for (const rect of masks) {
    drawMaskOutline(diffImg.data, expectedWidth, expectedHeight, rect);
  }
  return {
    mismatchPixels,
    totalPixels,
    maskedPixels,
    diffPng: PNG.sync.write(diffImg),
  };
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

async function startDevServer(lifecycle) {
  // Use Vite's own programmatic server handle with strictPort so we always talk to our own
  // listening socket (never another process that grabbed the port) and never orphan a child.
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (lifecycle.shuttingDown) throw new Error('Aborted during dev server startup');
    const port = await getFreePort();
    let viteServer = null;
    try {
      viteServer = await createServer({
        root: ROOT,
        logLevel: 'error',
        server: {
          host: '127.0.0.1',
          port,
          strictPort: true,
          watch: null,
          hmr: false,
        },
      });
      lifecycle.server = viteServer;
      if (lifecycle.shuttingDown) {
        await viteServer.close();
        lifecycle.server = null;
        throw new Error('Aborted during dev server startup');
      }
      await viteServer.listen();
      if (lifecycle.shuttingDown) {
        await viteServer.close();
        lifecycle.server = null;
        throw new Error('Aborted during dev server startup');
      }
      const addr = viteServer.httpServer?.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Vite dev server did not expose a listening TCP port');
      }
      const base = `http://127.0.0.1:${addr.port}/`;
      const stop = async () => {
        if (lifecycle.server === viteServer) lifecycle.server = null;
        await viteServer.close();
      };
      return { base, stop, pid: process.pid };
    } catch (err) {
      lastErr = err;
      if (viteServer) {
        if (lifecycle.server === viteServer) lifecycle.server = null;
        await viteServer.close().catch(() => {});
      }
      const msg = String(err?.message || '');
      if (err?.code === 'EADDRINUSE' || /already in use/i.test(msg)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('Failed to bind a free port for Vite dev server');
}

function createFreshRunDirs() {
  const runsRoot = path.join(ROOT, 'captures', 'diff-runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = fs.mkdtempSync(path.join(runsRoot, `${stamp}-`));
  return {
    outDir: path.join(runDir, 'current'),
    diffDir: path.join(runDir, 'diff'),
  };
}

function runCommand(cmd, args, env, lifecycle) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    lifecycle.gpuChild = child;
    child.on('error', (err) => {
      if (lifecycle.gpuChild === child) lifecycle.gpuChild = null;
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (lifecycle.gpuChild === child) lifecycle.gpuChild = null;
      if (signal) reject(new Error(`${cmd} terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function runGpuCapture(base, tiers, shots, outDir, goldenRenderers, concurrency, lifecycle) {
  // Run gpucheck + renderer verification + staged shoot inside ONE gpu-run slot so the
  // renderer check guards the exact GPU session that produces the screenshots, nothing is
  // deleted outside the run's own staging directory, and manifest.json is written only after
  // every selected shot succeeds.
  const gpuRun = process.env.GPU_RUN_HELD !== '1' && process.platform !== 'win32' ? findGpuRun() : null;
  const payload = JSON.stringify({ base, tiers, shots, outDir, goldenRenderers, concurrency });
  const runnerCode = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildCaptureManifest,
  buildShootEnv,
  getPinnedCaptureEnv,
  promoteStagedCapture,
} from './tools/diff.mjs';
const cfg = JSON.parse(process.env.__DIFF_CAPTURE_CFG);
const raw = execFileSync(process.execPath, ['tools/gpucheck.mjs'], { encoding: 'utf8' }).trim();
const info = JSON.parse(raw.split(/\\r?\\n/).filter(Boolean).pop());
const renderer = info && typeof info === 'object' ? info.renderer : '';
if (!renderer) {
  console.error('[diff] gpucheck returned empty renderer string:', raw);
  process.exit(1);
}
if (/llvmpipe|SwiftShader|Software/i.test(renderer) && process.env.ALLOW_SOFTWARE !== '1') {
  console.error('[diff] Refusing to diff on software renderer: ' + renderer);
  process.exit(1);
}
for (const tier of cfg.tiers) {
  const expected = cfg.goldenRenderers[tier];
  if (expected !== renderer) {
    console.error('[diff] Renderer mismatch for golden-' + tier + '!');
    console.error('  golden : ' + expected);
    console.error('  current: ' + renderer);
    console.error('Refusing to compare screenshots across different GPUs/drivers.');
    console.error('Recapture goldens on this machine from the last approved commit before diffing.');
    process.exit(2);
  }
}
fs.mkdirSync(cfg.outDir, { recursive: true });
const stageDir = fs.mkdtempSync(path.join(cfg.outDir, '.stage-'));
const cleanupStage = () => {
  fs.rmSync(stageDir, { recursive: true, force: true });
};
try {
  for (const tier of cfg.tiers) {
    const tierOut = path.join(stageDir, tier);
    fs.mkdirSync(tierOut, { recursive: true });
    execFileSync(process.execPath, ['tools/shoot.mjs', ...cfg.shots], {
      stdio: 'inherit',
      env: buildShootEnv(process.env, {
        base: cfg.base,
        tier,
        tierOut,
        concurrency: cfg.concurrency,
      }),
    });
  }
  const pinned = getPinnedCaptureEnv();
  const manifest = buildCaptureManifest({
    renderer,
    tiers: cfg.tiers,
    shots: cfg.shots,
    pinned,
    concurrency: cfg.concurrency,
    stageDir,
  });
  promoteStagedCapture(stageDir, cfg.outDir, manifest);
} catch (err) {
  cleanupStage();
  if (err && typeof err.status === 'number') process.exit(err.status);
  console.error('[diff] ' + (err?.message || String(err)));
  process.exit(1);
}
`;
  const env = { ...process.env, __DIFF_CAPTURE_CFG: payload };
  if (gpuRun) {
    return runCommand(gpuRun, [process.execPath, '--input-type=module', '-e', runnerCode], env, lifecycle);
  }
  return runCommand(process.execPath, ['--input-type=module', '-e', runnerCode], env, lifecycle);
}

export function thresholdFor(tier, shot, config = SHOTS_CONFIG) {
  const diffCfg = config.diff || {};
  const tierCfg = diffCfg.thresholds?.[tier];
  if (tierCfg && typeof tierCfg === 'object') {
    if (typeof tierCfg.perShot?.[shot] === 'number') return tierCfg.perShot[shot];
    if (typeof tierCfg.default === 'number') return tierCfg.default;
  }
  if (typeof diffCfg.thresholds?.default === 'number') return diffCfg.thresholds.default;
  return 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function writeReport(reportPath, { renderer, timestamp, pixelmatchThreshold, resultsByTier }) {
  const reportDir = path.dirname(reportPath);
  const rel = (p) => path.relative(reportDir, p).split(path.sep).join('/');
  const sections = Object.entries(resultsByTier).map(([tier, rows]) => {
    const failed = rows.filter((r) => !r.pass).length;
    const worst = rows.reduce((a, b) => (b.mismatchPixels > a.mismatchPixels ? b : a), rows[0]);
    const cards = rows.map((r) => `
      <div class="row ${r.pass ? 'pass' : 'fail'}">
        <div class="meta">
          <span class="badge ${r.pass ? 'ok' : 'bad'}">${r.pass ? 'PASS' : 'FAIL'}</span>
          <strong>${escapeHtml(r.shot)}</strong>
          <span class="stat">${r.mismatchPixels.toLocaleString()} px (${r.mismatchPct.toFixed(4)}%) ${r.pass ? '&le;' : '&gt;'} ${r.thresholdPixels.toLocaleString()} px (${r.thresholdPct.toFixed(4)}%)${r.masks?.length ? ` · masked (cyan outline): ${escapeHtml(r.masks.map((m) => `${m.x},${m.y} ${m.width}×${m.height}`).join(', '))}` : ''}</span>
        </div>
        <div class="imgs">
          <figure><a href="${escapeHtml(rel(r.goldenPath))}"><img loading="lazy" src="${escapeHtml(rel(r.goldenPath))}" alt="golden ${escapeHtml(r.shot)}"></a><figcaption>Golden</figcaption></figure>
          <figure><a href="${escapeHtml(rel(r.currentPath))}"><img loading="lazy" src="${escapeHtml(rel(r.currentPath))}" alt="current ${escapeHtml(r.shot)}"></a><figcaption>Current</figcaption></figure>
          <figure><a href="${escapeHtml(rel(r.diffPath))}"><img loading="lazy" src="${escapeHtml(rel(r.diffPath))}" alt="diff ${escapeHtml(r.shot)}"></a><figcaption>Diff</figcaption></figure>
        </div>
      </div>`).join('\n');
    return `
      <section>
        <h2>Tier: ${escapeHtml(tier)} — ${rows.length - failed}/${rows.length} passed (worst: ${escapeHtml(worst.shot)} ${worst.mismatchPixels.toLocaleString()} px / ${worst.mismatchPct.toFixed(4)}%)</h2>
        ${cards}
      </section>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Stillwater Visual Diff Report</title>
<style>
  body { background: #111317; color: #e6e8ec; font: 14px/1.45 system-ui, sans-serif; margin: 24px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  h2 { margin: 28px 0 12px; font-size: 16px; color: #cbd5e1; }
  .summary { color: #94a3b8; margin-bottom: 18px; }
  .row { border: 1px solid #262b35; border-radius: 8px; padding: 12px; margin-bottom: 14px; background: #171a21; }
  .row.fail { border-color: #dc2626; background: #231517; }
  .meta { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .badge { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 4px; }
  .badge.ok { background: #14532d; color: #86efac; }
  .badge.bad { background: #7f1d1d; color: #fecaca; }
  .stat { color: #94a3b8; font-family: ui-monospace, monospace; font-size: 12px; }
  .imgs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  figure { margin: 0; }
  img { width: 100%; display: block; border-radius: 4px; background: #000; }
  figcaption { font-size: 12px; color: #94a3b8; margin-top: 4px; text-align: center; }
</style>
<h1>Stillwater Visual Diff Report</h1>
<div class="summary">
  <div>Generated: ${escapeHtml(timestamp)}</div>
  <div>Renderer: <code>${escapeHtml(renderer)}</code></div>
  <div>pixelmatch threshold: ${pixelmatchThreshold} · size: ${SHOTS_CONFIG.width}×${SHOTS_CONFIG.height}</div>
  ${SHOTS_CONFIG.diff?.noiseNote ? `<div>Noise calibration: ${escapeHtml(SHOTS_CONFIG.diff.noiseNote)}</div>` : ''}
</div>
${sections}
</html>
`;
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, html, 'utf8');
}

const SELF_PATH = fileURLToPath(import.meta.url);
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH;

if (IS_MAIN) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), process.env, SHOTS_CONFIG);
  } catch (err) {
    console.error(`[diff] ${err.message}`);
    process.exit(1);
  }

  const pinned = getPinnedCaptureEnv(SHOTS_CONFIG);
  const goldenRenderers = {};

  for (const tier of opts.tiers) {
    const gDir = path.join(ROOT, 'captures', `golden-${tier}`);
    const rFile = path.join(gDir, 'renderer.txt');
    if (!fs.existsSync(rFile)) {
      console.error(`[diff] Missing golden renderer file: ${rFile}`);
      process.exit(1);
    }
    goldenRenderers[tier] = fs.readFileSync(rFile, 'utf8').trim();
    if (!goldenRenderers[tier]) {
      console.error(`[diff] Empty golden renderer file: ${rFile}`);
      process.exit(1);
    }
    for (const shot of opts.shots) {
      const gPng = path.join(gDir, `${shot}.png`);
      if (!fs.existsSync(gPng)) {
        console.error(`[diff] Missing golden image: ${gPng}`);
        process.exit(1);
      }
    }
  }

  if (!opts.skipShoot && !opts.outExplicit) {
    const fresh = createFreshRunDirs();
    opts.outDir = fresh.outDir;
    opts.diffDir = fresh.diffDir;
  }

  const lifecycle = { server: null, gpuChild: null, shuttingDown: false };
  const cleanupSignal = async (sig) => {
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
  process.on('SIGINT', () => cleanupSignal('SIGINT'));
  process.on('SIGTERM', () => cleanupSignal('SIGTERM'));

  let server = null;
  try {
    if (!opts.skipShoot) {
      let base = opts.base;
      if (!base) {
        server = await startDevServer(lifecycle);
        base = server.base;
        console.error(`[diff] started dev server at ${base} (in-process pid ${server.pid})`);
      }
      const code = await runGpuCapture(
        base,
        opts.tiers,
        opts.shots,
        opts.outDir,
        goldenRenderers,
        opts.concurrency,
        lifecycle,
      );
      if (server) {
        await server.stop();
        server = null;
      }
      if (code !== 0) process.exit(code);
    }
  } finally {
    if (server) await server.stop().catch(() => {});
  }

  let currentRenderer;
  try {
    const verified = validateCaptureManifest(opts.outDir, {
      tiers: opts.tiers,
      shots: opts.shots,
      goldenRenderers,
      pinned,
      concurrency: opts.concurrency,
    });
    currentRenderer = verified.renderer;
  } catch (err) {
    console.error(`[diff] ${err.message}`);
    process.exit(err?.code === 'RENDERER_MISMATCH' ? 2 : 1);
  }

  const pmThreshold = SHOTS_CONFIG.diff?.pixelmatchThreshold ?? 0.025;
  const resultsByTier = {};
  let totalFailed = 0;

  try {
    for (const tier of opts.tiers) {
      const gDir = path.join(ROOT, 'captures', `golden-${tier}`);
      const cDir = path.join(opts.outDir, tier);
      const dDir = path.join(opts.diffDir, tier);
      fs.mkdirSync(dDir, { recursive: true });
      const rows = [];
      for (const shot of opts.shots) {
        const goldenPath = path.join(gDir, `${shot}.png`);
        const currentPath = path.join(cDir, `${shot}.png`);
        const diffPath = path.join(dDir, `${shot}.png`);
        if (!fs.existsSync(currentPath)) {
          throw new Error(`Missing current screenshot: ${currentPath}`);
        }
        const shotMasks = masksFor(shot);
        const { mismatchPixels, totalPixels, diffPng } = comparePngBuffers(
          fs.readFileSync(goldenPath),
          fs.readFileSync(currentPath),
          {
            expectedWidth: pinned.width,
            expectedHeight: pinned.height,
            pixelmatchThreshold: pmThreshold,
            masks: shotMasks,
            label: `${tier}/${shot}`,
          },
        );
        fs.writeFileSync(diffPath, diffPng);
        const thresholdPixels = thresholdFor(tier, shot);
        const mismatchPct = (mismatchPixels / totalPixels) * 100;
        const thresholdPct = (thresholdPixels / totalPixels) * 100;
        const pass = mismatchPixels <= thresholdPixels;
        if (!pass) totalFailed++;
        rows.push({
          shot,
          mismatchPixels,
          mismatchPct,
          thresholdPixels,
          thresholdPct,
          masks: shotMasks,
          pass,
          goldenPath,
          currentPath,
          diffPath,
        });
      }
      resultsByTier[tier] = rows;
    }
  } catch (err) {
    console.error(`[diff] ${err.message}`);
    process.exit(1);
  }

  writeReport(opts.reportPath, {
    renderer: currentRenderer,
    timestamp: new Date().toISOString(),
    pixelmatchThreshold: pmThreshold,
    resultsByTier,
  });

  const summary = {};
  for (const [tier, rows] of Object.entries(resultsByTier)) {
    const failed = rows.filter((r) => !r.pass);
    const worst = rows.reduce((a, b) => (b.mismatchPixels > a.mismatchPixels ? b : a), rows[0]);
    summary[tier] = {
      passed: rows.length - failed.length,
      total: rows.length,
      worstShot: worst.shot,
      worstPixels: worst.mismatchPixels,
      worstPct: +worst.mismatchPct.toFixed(5),
      worstThresholdPixels: worst.thresholdPixels,
      failedShots: failed.map((r) => ({ shot: r.shot, mismatchPixels: r.mismatchPixels, thresholdPixels: r.thresholdPixels })),
    };
  }

  console.log(JSON.stringify({ renderer: currentRenderer, outDir: path.relative(ROOT, opts.outDir), report: path.relative(ROOT, opts.reportPath), summary }, null, 2));
  if (totalFailed > 0) process.exit(1);
}
