// Visual regression diff harness.
// Usage: node tools/diff.mjs [--tiers ultra,low] [--shots name1,name2] [--base http://127.0.0.1:5178/]
// Reshoots the 16 pinned review shots at ultra and low against captures/golden-ultra/ and
// captures/golden-low/, verifies the WebGL2 renderer matches, runs pixelmatch, and writes
// a side-by-side HTML sheet to captures/diff-report.html.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_PATH = path.join(ROOT, 'tools', 'shots.json');
const SHOTS_CONFIG = JSON.parse(fs.readFileSync(SHOTS_PATH, 'utf8'));

function parseArgs(argv) {
  const opts = {
    tiers: ['ultra', 'low'],
    shots: Object.keys(SHOTS_CONFIG.shots),
    base: process.env.BASE || '',
    outDir: path.join(ROOT, 'captures', 'diff-current'),
    diffDir: path.join(ROOT, 'captures', 'diff-output'),
    reportPath: path.join(ROOT, 'captures', 'diff-report.html'),
    concurrency: Math.max(1, +(process.env.CONCURRENCY || 1)),
    skipShoot: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--tiers') opts.tiers = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--shots') opts.shots = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--base') opts.base = next();
    else if (a === '--out') opts.outDir = path.resolve(next());
    else if (a === '--report') opts.reportPath = path.resolve(next());
    else if (a === '--concurrency') opts.concurrency = Math.max(1, +next());
    else if (a === '--skip-shoot') opts.skipShoot = true;
  }
  return opts;
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

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server still starting
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

async function startDevServer() {
  const port = await getFreePort();
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

let activeGpuChild = null;

function runCommand(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    activeGpuChild = child;
    child.on('error', (err) => {
      if (activeGpuChild === child) activeGpuChild = null;
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (activeGpuChild === child) activeGpuChild = null;
      if (signal) reject(new Error(`${cmd} terminated by signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function runGpuCapture(base, tiers, shots, outDir, goldenRenderers, concurrency) {
  // Run gpucheck + renderer verification + shoot inside ONE gpu-run slot so the
  // renderer check guards the exact GPU session that produces the screenshots.
  const gpuRun = process.env.GPU_RUN_HELD !== '1' && process.platform !== 'win32' ? findGpuRun() : null;
  const payload = JSON.stringify({ base, tiers, shots, outDir, goldenRenderers, concurrency });
  const runnerCode = `
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
fs.writeFileSync(path.join(cfg.outDir, 'renderer.txt'), renderer + '\\n', 'utf8');
for (const tier of cfg.tiers) {
  const tierOut = path.join(cfg.outDir, tier);
  fs.mkdirSync(tierOut, { recursive: true });
  execFileSync(process.execPath, ['tools/shoot.mjs', ...cfg.shots], {
    stdio: 'inherit',
    env: {
      ...process.env,
      BASE: cfg.base,
      Q: tier,
      OUT: tierOut,
      CONCURRENCY: String(cfg.concurrency),
      WRITE_RENDERER: '1',
    },
  });
}
`;
  const env = { ...process.env, __DIFF_CAPTURE_CFG: payload };
  if (gpuRun) {
    return runCommand(gpuRun, [process.execPath, '--input-type=module', '-e', runnerCode], env);
  }
  return runCommand(process.execPath, ['--input-type=module', '-e', runnerCode], env);
}

function thresholdFor(tier, shot) {
  const diffCfg = SHOTS_CONFIG.diff || {};
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
          <span class="stat">${r.mismatchPixels.toLocaleString()} px (${r.mismatchPct.toFixed(4)}%) ${r.pass ? '&le;' : '&gt;'} ${r.thresholdPixels.toLocaleString()} px (${r.thresholdPct.toFixed(4)}%)</span>
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

const opts = parseArgs(process.argv.slice(2));
const goldenRenderers = {};

for (const tier of opts.tiers) {
  const gDir = path.join(ROOT, 'captures', `golden-${tier}`);
  const rFile = path.join(gDir, 'renderer.txt');
  if (!fs.existsSync(rFile)) {
    console.error(`[diff] Missing golden renderer file: ${rFile}`);
    process.exit(1);
  }
  goldenRenderers[tier] = fs.readFileSync(rFile, 'utf8').trim();
  for (const shot of opts.shots) {
    const gPng = path.join(gDir, `${shot}.png`);
    if (!fs.existsSync(gPng)) {
      console.error(`[diff] Missing golden image: ${gPng}`);
      process.exit(1);
    }
  }
}

let server = null;
const cleanupSignal = async (sig) => {
  if (activeGpuChild && activeGpuChild.exitCode === null) {
    try {
      if (process.platform !== 'win32') process.kill(-activeGpuChild.pid, sig);
      else process.kill(activeGpuChild.pid, sig);
    } catch {}
  }
  if (server) await server.stop();
  process.exit(sig === 'SIGINT' ? 130 : 143);
};
process.on('SIGINT', () => cleanupSignal('SIGINT'));
process.on('SIGTERM', () => cleanupSignal('SIGTERM'));

let currentRenderer;
try {
  if (!opts.skipShoot) {
    let base = opts.base;
    if (!base) {
      server = await startDevServer();
      base = server.base;
      console.error(`[diff] started dev server at ${base} (pid ${server.pid})`);
    }
    const code = await runGpuCapture(base, opts.tiers, opts.shots, opts.outDir, goldenRenderers, opts.concurrency);
    if (server) {
      await server.stop();
      server = null;
    }
    if (code !== 0) process.exit(code);
  }
  const rPath = path.join(opts.outDir, 'renderer.txt');
  currentRenderer = fs.existsSync(rPath) ? fs.readFileSync(rPath, 'utf8').trim() : goldenRenderers[opts.tiers[0]];
} finally {
  if (server) await server.stop();
}

const pmThreshold = SHOTS_CONFIG.diff?.pixelmatchThreshold ?? 0.1;
const resultsByTier = {};
let totalFailed = 0;

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
    const gImg = PNG.sync.read(fs.readFileSync(goldenPath));
    const cImg = PNG.sync.read(fs.readFileSync(currentPath));
    if (gImg.width !== cImg.width || gImg.height !== cImg.height) {
      throw new Error(`Dimension mismatch for ${tier}/${shot}: golden ${gImg.width}x${gImg.height} vs current ${cImg.width}x${cImg.height}`);
    }
    const totalPixels = gImg.width * gImg.height;
    const diffImg = new PNG({ width: gImg.width, height: gImg.height });
    const mismatchPixels = pixelmatch(gImg.data, cImg.data, diffImg.data, gImg.width, gImg.height, {
      threshold: pmThreshold,
      includeAA: false,
    });
    fs.writeFileSync(diffPath, PNG.sync.write(diffImg));
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
      pass,
      goldenPath,
      currentPath,
      diffPath,
    });
  }
  resultsByTier[tier] = rows;
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

console.log(JSON.stringify({ renderer: currentRenderer, report: path.relative(ROOT, opts.reportPath), summary }, null, 2));
if (totalFailed > 0) process.exit(1);
