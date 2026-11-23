// Headless benchmark runner. Drives ?bench=... with real browser navigation
// and waits for the on-page copyable JSON result.
//
// Usage:
//   BASE=http://127.0.0.1:5175/ node tools/bench.mjs --q low --out docs/perf/results/out.json
//   node tools/bench.mjs --q low --route stops --sweep scale,systems
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './chrome.mjs';

function parseArgs(argv) {
  const opts = {
    base: process.env.BASE || 'http://127.0.0.1:5173/',
    route: 'default',
    q: 'low',
    sweep: '',
    systems: '',
    dur: '',
    stopDur: '',
    stopFrames: '',
    minFrames: '',
    warmup: '',
    time: '',
    scale: '',
    width: +(process.env.W || 1280),
    height: +(process.env.H || 720),
    out: '',
    timeoutMs: 1200000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base') opts.base = next();
    else if (a === '--route') opts.route = next();
    else if (a === '--q' || a === '--tier') opts.q = next();
    else if (a === '--sweep') opts.sweep = next();
    else if (a === '--systems') opts.systems = next();
    else if (a === '--dur') opts.dur = next();
    else if (a === '--stop-dur') opts.stopDur = next();
    else if (a === '--stop-frames') opts.stopFrames = next();
    else if (a === '--min-frames') opts.minFrames = next();
    else if (a === '--warmup') opts.warmup = next();
    else if (a === '--time') opts.time = next();
    else if (a === '--scale') opts.scale = next();
    else if (a === '--width') opts.width = +next();
    else if (a === '--height') opts.height = +next();
    else if (a === '--out' || a === '-o') opts.out = next();
    else if (a === '--timeout') opts.timeoutMs = +next() * 1000;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const base = opts.base.replace(/\/?$/, '/');
const qp = new URLSearchParams();
qp.set('bench', opts.route);
if (opts.q) qp.set('q', opts.q);
if (opts.sweep) qp.set('sweep', opts.sweep);
if (opts.systems) qp.set('systems', opts.systems);
if (opts.dur) qp.set('dur', opts.dur);
if (opts.stopDur) qp.set('stopDur', opts.stopDur);
if (opts.stopFrames) qp.set('stopFrames', opts.stopFrames);
if (opts.minFrames) qp.set('minFrames', opts.minFrames);
if (opts.warmup) qp.set('warmup', opts.warmup);
if (opts.time) qp.set('time', opts.time);
if (opts.scale) qp.set('scale', opts.scale);

const targetUrl = `${base}?${qp.toString()}`;
const { browser, renderer, isSoftware } = await launchBrowser();
const errs = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
  const baseOrigin = new URL(base).origin;
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const loc = m.location()?.url || '';
    if (text.includes('404')) return;
    if (loc && !loc.startsWith(baseOrigin)) {
      console.error(`[bench] ignoring external console.error (${loc}): ${text.slice(0, 200)}`);
      return;
    }
    if (/Failed to load resource: net::ERR_/i.test(text) && !loc.startsWith(baseOrigin)) {
      console.error(`[bench] ignoring external resource error: ${text.slice(0, 200)}`);
      return;
    }
    errs.push('console.error: ' + text.slice(0, 300));
  });

  console.error(`[bench] renderer=${renderer} software=${isSoftware}`);
  console.error(`[bench] navigating to ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'load', timeout: 120000 });

  // Wait for the page to complete the bench route on its own and render #bench-json.
  const pollStart = Date.now();
  let lastLog = 0;
  while (true) {
    const state = await page.evaluate(() => {
      const ta = document.getElementById('bench-json');
      return {
        done: !!window.__benchDone && !!(ta && ta.value && ta.value.length > 2),
        error: window.__error || null,
        progress: window.__benchProgress || null,
      };
    });
    if (state.error) {
      errs.push('window.__error: ' + String(state.error));
      break;
    }
    if (state.done) break;
    if (Date.now() - pollStart > opts.timeoutMs) {
      errs.push(`timeout after ${Math.round(opts.timeoutMs / 1000)}s`);
      break;
    }
    if (state.progress && Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      const p = state.progress;
      console.error(`[bench] ${p.run} · ${p.stage} (${p.step}/${p.totalSteps}) ${p.pct}% (${p.frames} frames)`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (errs.length > 0) {
    console.error('[bench] errors:', errs);
    process.exitCode = 1;
  } else {
    const rawJson = await page.evaluate(() => document.getElementById('bench-json')?.value || '');
    const parsed = JSON.parse(rawJson);
    const formatted = JSON.stringify(parsed, null, 2) + '\n';
    if (opts.out) {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, formatted, 'utf8');
      console.error(`[bench] wrote ${opts.out}`);
      console.log(
        JSON.stringify(
          {
            out: opts.out,
            renderer: parsed.device.renderer,
            tier: parsed.tier,
            internal: parsed.outputSize.internal,
            heightHash: parsed.heightHash,
            summary: parsed.summary,
            scaleVerdict: parsed.sweeps?.scale?.classification || null,
            systemsTop: parsed.sweeps?.systems?.ranking?.slice(0, 6) || null,
          },
          null,
          2,
        ),
      );
    } else {
      process.stdout.write(formatted);
    }
  }
} finally {
  await browser.close();
}
