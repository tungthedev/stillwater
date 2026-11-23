// Deterministic benchmark driver loaded dynamically only when ?bench is present.
// Runs fixed camera stops + auto-walk at a fixed time of day, optional scale/systems sweeps,
// and presents a touch-friendly, copyable JSON result overlay.

const SOFTWARE_RE = /llvmpipe|SwiftShader|Software/i;

const STOP_POSES = {
  trailhead: 'trailf=0',
  lake: 'bench=0&pitch=-0.02',
  forest: 'poi=forest&pitch=0.03',
  summit: 'bench=2&pitch=-0.07',
};

const ALL_STOPS = ['trailhead', 'lake', 'forest', 'summit'];
const DEFAULT_ROUTE = [...ALL_STOPS, 'walk'];
const PASS_KEYS = ['skyLut', 'terrainShadow', 'reflection', 'main', 'post'];
const DEFAULT_SYSTEMS = [
  'terrain',
  'trees',
  'grass',
  'ferns',
  'clouds',
  'water',
  'refl',
  'shadow',
  'bloom',
  'skyLut',
  'ambRead',
  'msaa',
  'rocks',
  'props',
];

function round(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function percentiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return round(sorted[idx], 2);
  };
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    mean: round(sum / sorted.length, 2),
    min: round(sorted[0], 2),
    max: round(sorted[sorted.length - 1], 2),
  };
}

function hashHeights(heights) {
  const u32 = new Uint32Array(heights.buffer, heights.byteOffset, heights.length);
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  let q1 = 0x811c9dc5 >>> 0;
  let q2 = 0x9e3779b9 >>> 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let nanCount = 0;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (Number.isNaN(v)) {
      nanCount++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    const bits = v === 0 ? 0 : u32[i];
    h1 = Math.imul(h1 ^ bits, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((bits >>> 16) | (bits << 16)), 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h1 >>> 13)) >>> 0;
    const q = Math.round(v * 1000) | 0;
    q1 = Math.imul(q1 ^ q, 0x01000193) >>> 0;
    q2 = Math.imul(q2 ^ ((q >>> 16) | (q << 16)), 0x85ebca6b) >>> 0;
    q2 = (q2 ^ (q1 >>> 13)) >>> 0;
  }
  const hex = (a, b) => a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
  const valid = Math.max(1, heights.length - nanCount);
  return {
    hash: 'fnv64:' + hex(h1, h2),
    quantized1mmHash: 'fnv64:' + hex(q1, q2),
    length: heights.length,
    min: round(min, 4),
    max: round(max, 4),
    mean: round(sum / valid, 4),
    nanCount,
  };
}

function readJsHeap() {
  const m = performance.memory;
  if (!m) return null;
  return {
    used: round(m.usedJSHeapSize / 1048576, 1),
    total: round(m.totalJSHeapSize / 1048576, 1),
    limit: round(m.jsHeapSizeLimit / 1048576, 1),
  };
}

function parseRoute(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v || v === '1' || v === 'default' || v === 'full') return [...DEFAULT_ROUTE];
  if (v === 'stops') return [...ALL_STOPS];
  if (v === 'walk') return ['walk'];
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = parts.filter((s) => s === 'walk' || STOP_POSES[s]);
  return valid.length ? valid : [...DEFAULT_ROUTE];
}

function parseSweeps(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return [];
  if (v === 'all' || v === 'both') return ['scale', 'systems'];
  return [...new Set(v.split(',').map((s) => s.trim()).filter((s) => s === 'scale' || s === 'systems'))];
}

function makePassAccum() {
  const out = {};
  for (const k of [...PASS_KEYS, 'total']) {
    out[k] = { sumCalls: 0, sumTris: 0, maxCalls: 0, maxTris: 0 };
  }
  return out;
}

function recordPasses(acc, passes) {
  let totCalls = 0;
  let totTris = 0;
  for (const k of PASS_KEYS) {
    const p = passes[k] || { calls: 0, tris: 0 };
    const a = acc[k];
    a.sumCalls += p.calls;
    a.sumTris += p.tris;
    if (p.calls > a.maxCalls) a.maxCalls = p.calls;
    if (p.tris > a.maxTris) a.maxTris = p.tris;
    totCalls += p.calls;
    totTris += p.tris;
  }
  const t = acc.total;
  t.sumCalls += totCalls;
  t.sumTris += totTris;
  if (totCalls > t.maxCalls) t.maxCalls = totCalls;
  if (totTris > t.maxTris) t.maxTris = totTris;
}

function finalizePasses(acc, frames) {
  const n = Math.max(1, frames);
  const out = {};
  for (const k of [...PASS_KEYS, 'total']) {
    const a = acc[k];
    const meanTris = a.sumTris / n;
    out[k] = {
      avgCalls: round(a.sumCalls / n, 2),
      avgTris: meanTris < 10 ? round(meanTris, 2) : Math.round(meanTris),
      maxCalls: a.maxCalls,
      maxTris: a.maxTris,
      totalCalls: a.sumCalls,
      totalTris: a.sumTris,
    };
  }
  return out;
}

function summarizeRun(stopsObj, hasGpuTimer) {
  const entries = Object.values(stopsObj);
  const allFrameMs = [];
  const allGpuMs = [];
  let worstHitchMs = 0;
  let totalFrames = 0;
  let totalDurationMs = 0;
  let totalDisjoint = 0;
  const passTotals = {};
  for (const k of [...PASS_KEYS, 'total']) {
    passTotals[k] = { sumCalls: 0, sumTris: 0, maxCalls: 0, maxTris: 0 };
  }
  for (const s of entries) {
    totalFrames += s.frames;
    totalDurationMs += s.durationMs;
    if (s.worstHitchMs > worstHitchMs) worstHitchMs = s.worstHitchMs;
    if (s._frameSamples) allFrameMs.push(...s._frameSamples);
    if (s._gpuSamples) allGpuMs.push(...s._gpuSamples);
    if (s.gpuMs && s.gpuMs.disjoint) totalDisjoint += s.gpuMs.disjoint;
    for (const k of [...PASS_KEYS, 'total']) {
      const p = s.passes[k];
      passTotals[k].sumCalls += p.totalCalls;
      passTotals[k].sumTris += p.totalTris;
      if (p.maxCalls > passTotals[k].maxCalls) passTotals[k].maxCalls = p.maxCalls;
      if (p.maxTris > passTotals[k].maxTris) passTotals[k].maxTris = p.maxTris;
    }
  }
  const fStats = percentiles(allFrameMs);
  const gStats = hasGpuTimer
    ? allGpuMs.length
      ? { ...percentiles(allGpuMs), samples: allGpuMs.length, disjoint: totalDisjoint }
      : { p50: null, p95: null, p99: null, mean: null, min: null, max: null, samples: 0, disjoint: totalDisjoint }
    : null;
  return {
    frames: totalFrames,
    durationMs: round(totalDurationMs, 1),
    fps: round((totalFrames * 1000) / Math.max(1, totalDurationMs), 1),
    frameMs: fStats,
    worstHitchMs: round(worstHitchMs, 2),
    gpuMs: gStats,
    passes: finalizePasses(passTotals, totalFrames),
    jsHeapMB: readJsHeap(),
  };
}

function stripInternal(stopsObj) {
  const clean = {};
  for (const [k, s] of Object.entries(stopsObj)) {
    const { _frameSamples, _gpuSamples, ...rest } = s;
    clean[k] = rest;
  }
  return clean;
}

function isVsyncCapped(ms050, ms075, ms100) {
  if (ms050 == null || ms075 == null || ms100 == null) return false;
  // Common refresh intervals: 60 Hz (16.67 ms), 120 Hz (8.33 ms), 90 Hz (11.11 ms)
  const caps = [16.67, 11.11, 8.33];
  for (const cap of caps) {
    if (
      Math.abs(ms050 - cap) <= 1.2 &&
      Math.abs(ms075 - cap) <= 1.2 &&
      Math.abs(ms100 - cap) <= 1.2
    ) {
      return true;
    }
  }
  return ms050 <= 17.2 && ms075 <= 17.2 && ms100 <= 17.2 && Math.abs(ms100 - ms050) <= 1.2;
}

function classifyScaleSweep(scaleRuns, isSoftware) {
  const r050 = scaleRuns['0.5'];
  const r075 = scaleRuns['0.75'];
  const r100 = scaleRuns['1'];
  if (!r050 || !r075 || !r100) {
    return { verdict: 'inconclusive', reason: 'missing-scale-runs' };
  }
  const s050 = r050.summary;
  const s075 = r075.summary;
  const s100 = r100.summary;
  const useGpu =
    s050.gpuMs && s050.gpuMs.p50 != null &&
    s075.gpuMs && s075.gpuMs.p50 != null &&
    s100.gpuMs && s100.gpuMs.p50 != null;

  const t050 = useGpu ? s050.gpuMs.p50 : s050.frameMs.p50;
  const t075 = useGpu ? s075.gpuMs.p50 : s075.frameMs.p50;
  const t100 = useGpu ? s100.gpuMs.p50 : s100.frameMs.p50;
  const ratio100to050 = round(t100 / Math.max(0.01, t050), 3);
  const ratio075to050 = round(t075 / Math.max(0.01, t050), 3);
  const metric = useGpu ? 'gpuMs.p50' : 'frameMs.p50';

  const base = {
    metric,
    scale050Ms: t050,
    scale075Ms: t075,
    scale100Ms: t100,
    ratio075to050,
    ratio100to050,
  };

  if (isSoftware) {
    return { ...base, verdict: 'inconclusive', reason: 'software-renderer' };
  }

  // If frame time is vsync-capped and we have no GPU timer to see beneath vsync
  if (!useGpu && isVsyncCapped(s050.frameMs.p50, s075.frameMs.p50, s100.frameMs.p50)) {
    return { ...base, verdict: 'inconclusive', reason: 'vsync-capped' };
  }

  // Check if CPU-bound (frame time far exceeds GPU time at 1.0 scale)
  if (useGpu && s100.frameMs.p50 > s100.gpuMs.p50 * 1.45 && s100.frameMs.p50 > 18) {
    return { ...base, verdict: 'inconclusive', reason: 'cpu-bound' };
  }

  // Pixel count scales 4x from 0.5 -> 1.0 while triangle/draw counts stay constant.
  if (ratio100to050 >= 1.45 && t100 > t050 + 1.5) {
    return { ...base, verdict: 'pixel-limited', reason: `1.0/0.5 ratio ${ratio100to050}x (>= 1.45x)` };
  }
  if (ratio100to050 <= 1.2) {
    // Also guard against vsync floor when using frameMs
    if (!useGpu && s100.frameMs.p50 <= 17.5) {
      return { ...base, verdict: 'inconclusive', reason: 'vsync-capped' };
    }
    return { ...base, verdict: 'geometry-limited', reason: `1.0/0.5 ratio ${ratio100to050}x (<= 1.20x)` };
  }
  if (t050 < t075 && t075 < t100 && t100 - t050 >= 2.0) {
    return {
      ...base,
      verdict: 'pixel-limited',
      reason: `monotonic pixel scaling ${ratio100to050}x (${t050} -> ${t075} -> ${t100} ms)`,
    };
  }
  return {
    ...base,
    verdict: 'inconclusive',
    reason: `ambiguous scaling ratio ${ratio100to050}x`,
  };
}

function createOverlay() {
  const style = document.createElement('style');
  style.textContent = `
    #bench-status {
      position: fixed; top: 12px; left: 12px; z-index: 100;
      max-width: min(92vw, 380px); padding: 10px 14px; border-radius: 10px;
      background: rgba(8, 12, 18, 0.84); border: 1px solid rgba(244, 236, 221, 0.2);
      color: #edf2f7; font: 12px/1.45 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45); pointer-events: auto;
    }
    #bench-status .b-title { font-weight: 700; color: #93c5fd; margin-bottom: 4px; }
    #bench-status .b-bar { height: 5px; background: rgba(255,255,255,0.12); border-radius: 999px; overflow: hidden; margin-top: 7px; }
    #bench-status .b-bar i { display: block; height: 100%; width: 0%; background: #6ee7b7; transition: width 0.15s; }
    #bench-panel {
      position: fixed; inset: 12px; z-index: 110; display: none; flex-direction: column;
      max-width: 820px; max-height: calc(100vh - 24px); margin: auto;
      padding: 14px; border-radius: 12px; background: rgba(9, 13, 20, 0.94);
      border: 1px solid rgba(244, 236, 221, 0.25); color: #edf2f7;
      font: 12px/1.45 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      box-shadow: 0 18px 50px rgba(0,0,0,0.65); pointer-events: auto;
      user-select: text; -webkit-user-select: text;
    }
    #bench-panel.open { display: flex; }
    #bench-panel .bp-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    #bench-panel .bp-title { font-size: 14px; font-weight: 700; color: #6ee7b7; }
    #bench-panel .bp-meta { font-size: 11px; color: rgba(237,242,247,0.78); margin-bottom: 10px; word-break: break-word; }
    #bench-panel .bp-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    #bench-panel button {
      min-height: 40px; padding: 8px 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid rgba(147,197,253,0.4); background: rgba(59,130,246,0.22);
      color: #fff; font: 600 12px/1 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      touch-action: manipulation;
    }
    #bench-panel button.primary { background: #10b981; border-color: #34d399; color: #052e16; }
    #bench-panel button.sec { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); }
    #bench-json {
      flex: 1 1 auto; min-height: 220px; width: 100%; box-sizing: border-box;
      padding: 10px; border-radius: 8px; resize: none;
      background: #06090f; color: #d1fae5; border: 1px solid rgba(255,255,255,0.16);
      font: 11px/1.4 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      user-select: text; -webkit-user-select: text;
    }
    #bench-reopen {
      position: fixed; bottom: 14px; right: 14px; z-index: 110; display: none;
      min-height: 40px; padding: 8px 14px; border-radius: 8px; cursor: pointer;
      background: #10b981; color: #052e16; border: none; font: 700 12px ui-monospace, monospace;
      pointer-events: auto; touch-action: manipulation;
    }
  `;
  document.head.appendChild(style);

  const status = document.createElement('div');
  status.id = 'bench-status';
  status.innerHTML =
    '<div class="b-title">Stillwater Bench</div>' +
    '<div class="b-step">initializing…</div>' +
    '<div class="b-detail" style="opacity:.72;margin-top:2px"></div>' +
    '<div class="b-bar"><i></i></div>';
  document.body.appendChild(status);

  const panel = document.createElement('div');
  panel.id = 'bench-panel';
  panel.innerHTML =
    '<div class="bp-head"><span class="bp-title">Stillwater Benchmark Complete</span></div>' +
    '<div class="bp-meta" id="bench-meta"></div>' +
    '<div class="bp-btns">' +
    '  <button type="button" class="primary" id="bench-copy">Copy JSON</button>' +
    '  <button type="button" id="bench-select">Select All</button>' +
    '  <button type="button" id="bench-download">Download JSON</button>' +
    '  <button type="button" class="sec" id="bench-hide">Hide</button>' +
    '</div>' +
    '<textarea id="bench-json" readonly spellcheck="false"></textarea>';
  document.body.appendChild(panel);

  const reopen = document.createElement('button');
  reopen.id = 'bench-reopen';
  reopen.type = 'button';
  reopen.textContent = 'Show Bench JSON';
  document.body.appendChild(reopen);

  const stepEl = status.querySelector('.b-step');
  const detailEl = status.querySelector('.b-detail');
  const barEl = status.querySelector('.b-bar i');
  const metaEl = panel.querySelector('#bench-meta');
  const textEl = panel.querySelector('#bench-json');
  const copyBtn = panel.querySelector('#bench-copy');
  const selectBtn = panel.querySelector('#bench-select');
  const dlBtn = panel.querySelector('#bench-download');
  const hideBtn = panel.querySelector('#bench-hide');

  // Keep clicks/touches inside overlay from triggering canvas listeners
  for (const el of [status, panel, reopen]) {
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  }

  hideBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    reopen.style.display = 'block';
  });
  reopen.addEventListener('click', () => {
    panel.classList.add('open');
    reopen.style.display = 'none';
  });

  function selectAllText() {
    textEl.focus();
    textEl.select();
    try {
      textEl.setSelectionRange(0, textEl.value.length);
    } catch {}
  }

  selectBtn.addEventListener('click', selectAllText);

  copyBtn.addEventListener('click', async () => {
    const text = textEl.value;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {}
    if (!ok) {
      selectAllText();
      try {
        ok = document.execCommand('copy');
      } catch {}
    }
    copyBtn.textContent = ok ? 'Copied!' : 'Tap Copy (selected)';
    setTimeout(() => {
      copyBtn.textContent = 'Copy JSON';
    }, 2000);
  });

  return {
    update(stepText, detailText, pct) {
      stepEl.textContent = stepText;
      detailEl.textContent = detailText;
      barEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    },
    showResult(result, jsonStr) {
      status.style.display = 'none';
      const s = result.summary;
      const parts = [
        `tier=${result.tier}`,
        `size=${result.outputSize.internal[0]}x${result.outputSize.internal[1]} (${Math.round(result.outputSize.scale * 100)}%)`,
        `p50=${s.frameMs?.p50}ms`,
        `p95=${s.frameMs?.p95}ms`,
        `p99=${s.frameMs?.p99}ms`,
        `hitch=${s.worstHitchMs}ms`,
      ];
      if (s.gpuMs && s.gpuMs.p50 != null) parts.push(`gpu_p50=${s.gpuMs.p50}ms`);
      if (result.sweeps?.scale?.classification?.verdict) {
        parts.push(`scale=${result.sweeps.scale.classification.verdict}`);
      }
      parts.push(`height=${result.heightHash}`);
      metaEl.textContent = `${result.device.renderer} · ${parts.join(' · ')}`;
      textEl.value = jsonStr;
      panel.classList.add('open');

      dlBtn.onclick = () => {
        const day = new Date().toISOString().slice(0, 10);
        const slug = (result.device.renderer || 'device')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 32);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${day}-${slug}-${result.tier}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      };
    },
  };
}

export function createBench(ctx) {
  const {
    params,
    renderer,
    glCtx,
    timerExt,
    gpuName,
    qName,
    Q,
    getScale,
    setScale,
    getGpuQueueLen,
    applyPose,
    env,
    player,
    hf,
    shadows,
    water,
    terrain,
    trees,
    grass,
    flowers,
    ferns,
    clouds,
    rocks,
    props,
    village,
    post,
    dbgState,
  } = ctx;

  const routeName = (params.get('bench') || 'default').trim() || 'default';
  const routeStages = parseRoute(routeName);
  const sweeps = parseSweeps(params.get('sweep'));
  const fixedTime = parseFloat(params.get('time') || '16.0');
  const walkDur = Math.max(0.5, parseFloat(params.get('dur') || '60'));
  const stopDur = Math.max(0.2, parseFloat(params.get('stopDur') || '3'));
  const stopFramesParam = params.get('stopFrames') ? Math.max(2, parseInt(params.get('stopFrames'), 10)) : null;
  const minStopFrames = stopFramesParam || Math.max(2, parseInt(params.get('minFrames') || '10', 10));
  const warmupFrames = Math.max(0, parseInt(params.get('warmup') || '6', 10));
  const requestedSystems = params.get('systems')
    ? params.get('systems').split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SYSTEMS;

  const isSoftware = SOFTWARE_RE.test(gpuName);
  const vendorExt = glCtx.getExtension('WEBGL_debug_renderer_info');
  const gpuVendor = vendorExt ? glCtx.getParameter(vendorExt.UNMASKED_VENDOR_WEBGL) : glCtx.getParameter(glCtx.VENDOR);
  const heightData = hashHeights(hf.h);

  const baseScale = getScale();
  const baseMsaa = post.opts.msaa || 0;
  const baseRefl = !!dbgState.refl;

  const systemDefs = {
    terrain: {
      isActive: () => terrain.mesh.visible,
      set: (on) => { terrain.mesh.visible = on; },
    },
    trees: {
      isActive: () => trees.group.visible,
      set: (on) => { trees.group.visible = on; },
    },
    grass: {
      isActive: () => grass.mesh.visible,
      set: (on) => {
        grass.mesh.visible = on;
        flowers.mesh.visible = on;
        dbgState.grass = on;
      },
    },
    ferns: {
      isActive: () => ferns.mesh.visible,
      set: (on) => {
        ferns.mesh.visible = on;
        dbgState.ferns = on;
      },
    },
    clouds: {
      isActive: () => clouds.mesh.visible,
      set: (on) => {
        clouds.mesh.visible = on;
        dbgState.clouds = on;
      },
    },
    water: {
      isActive: () => water.mesh.visible,
      set: (on) => {
        water.mesh.visible = on;
        dbgState.refl = on && baseRefl;
      },
    },
    refl: {
      isActive: () => baseRefl,
      set: (on) => { dbgState.refl = on && baseRefl; },
    },
    shadow: {
      isActive: () => !!dbgState.shadow,
      set: (on) => { dbgState.shadow = on; },
    },
    bloom: {
      isActive: () => !!dbgState.bloom,
      set: (on) => { dbgState.bloom = on; },
    },
    skyLut: {
      isActive: () => !!dbgState.skyLut,
      set: (on) => { dbgState.skyLut = on; },
    },
    ambRead: {
      isActive: () => !!dbgState.ambRead,
      set: (on) => { dbgState.ambRead = on; },
    },
    msaa: {
      isActive: () => baseMsaa > 0,
      set: (on) => {
        post.opts.msaa = on ? baseMsaa : 0;
        post.setSize(innerWidth, innerHeight, getScale());
      },
    },
    rocks: {
      isActive: () => rocks.group.visible,
      set: (on) => { rocks.group.visible = on; },
    },
    props: {
      isActive: () => props.group.visible,
      set: (on) => {
        props.group.visible = on;
        village.group.visible = on;
      },
    },
  };

  // Build execution plan: array of { runId, label, kind, scale?, sysOff?, setup(), teardown() }
  const runs = [];
  runs.push({
    runId: 'main',
    label: `main (${qName})`,
    kind: 'main',
    setup: () => setScale(baseScale),
    teardown: () => {},
  });

  if (sweeps.includes('scale')) {
    for (const s of [0.5, 0.75, 1.0]) {
      runs.push({
        runId: `scale:${s}`,
        label: `sweep scale ${s}`,
        kind: 'scale',
        scaleKey: String(s),
        scaleVal: s,
        setup: () => setScale(s),
        teardown: () => setScale(baseScale),
      });
    }
  }

  const skippedSystems = {};
  if (sweeps.includes('systems')) {
    if (sweeps.includes('scale')) {
      runs.push({
        runId: 'systems:baseline',
        label: 'sweep systems baseline',
        kind: 'systems-baseline',
        setup: () => setScale(baseScale),
        teardown: () => {},
      });
    }
    for (const sysName of requestedSystems) {
      const def = systemDefs[sysName];
      if (!def) continue;
      if (!def.isActive()) {
        skippedSystems[sysName] = { skipped: true, reason: 'disabled-in-tier' };
        continue;
      }
      runs.push({
        runId: `systems:${sysName}`,
        label: `sweep no-${sysName}`,
        kind: 'systems',
        sysName,
        setup: () => {
          setScale(baseScale);
          def.set(false);
        },
        teardown: () => {
          def.set(true);
        },
      });
    }
  }

  const totalSteps = runs.length * routeStages.length;
  const overlay = createOverlay();

  let runIdx = 0;
  let stageIdx = 0;
  let phase = 'warmup'; // 'warmup' | 'measure'
  let warmupLeft = warmupFrames;
  let skipGpuSamples = 0;
  let stageStartNow = 0;
  let frameSamples = [];
  let gpuSamples = [];
  let gpuDisjoint = 0;
  let cpuSums = { sky: 0, sim: 0, refl: 0, main: 0, post: 0, total: 0 };
  let passAcc = makePassAccum();
  let currentStops = {};
  const completedRuns = {};
  let lastOverlayUpdate = 0;

  function applyStagePose(stageName) {
    player.autoWalk = false;
    if (stageName === 'walk') {
      applyPose(`trailf=0&time=${fixedTime}`);
      player.sitting = null;
      player.sitBlend = 0;
      player.trailIdx = 0;
      player.distance = 0;
      player.climb = 0;
      player.lastMouse = -1000;
      player.autoWalk = true;
    } else {
      applyPose(`${STOP_POSES[stageName]}&time=${fixedTime}`);
    }
    env.timeScale = 0;
  }

  function startCurrentStage() {
    const run = runs[runIdx];
    const stageName = routeStages[stageIdx];
    if (stageIdx === 0) {
      currentStops = {};
      run.setup();
    }
    applyStagePose(stageName);
    phase = warmupFrames > 0 ? 'warmup' : 'measure';
    warmupLeft = warmupFrames;
    frameSamples = [];
    gpuSamples = [];
    gpuDisjoint = 0;
    cpuSums = { sky: 0, sim: 0, refl: 0, main: 0, post: 0, total: 0 };
    passAcc = makePassAccum();
    if (phase === 'measure') {
      beginMeasure(performance.now());
    }
    const stepNo = runIdx * routeStages.length + stageIdx + 1;
    overlay.update(
      `${run.label} · ${stageName} (${stepNo}/${totalSteps})`,
      phase === 'warmup' ? `warming up (${warmupFrames} frames)…` : 'measuring…',
      ((stepNo - 1) / totalSteps) * 100,
    );
  }

  function beginMeasure(now) {
    phase = 'measure';
    stageStartNow = now;
    // Invalidate terrain shadow cache once per measured stage so the terrain-shadow pass
    // executes once (near + far across 2 frames) and is accurately counted without running every frame.
    shadows.lastDir.set(0, -2, 0);
    skipGpuSamples = getGpuQueueLen ? getGpuQueueLen() : 0;
  }

  function finishCurrentStage(now) {
    const run = runs[runIdx];
    const stageName = routeStages[stageIdx];
    const n = frameSamples.length;
    const durationMs = Math.max(0.1, now - stageStartNow);
    const fStats = percentiles(frameSamples);
    const gStats = timerExt
      ? gpuSamples.length
        ? { ...percentiles(gpuSamples), samples: gpuSamples.length, disjoint: gpuDisjoint }
        : { p50: null, p95: null, p99: null, mean: null, min: null, max: null, samples: 0, disjoint: gpuDisjoint }
      : null;

    const stopRec = {
      frames: n,
      durationMs: round(durationMs, 1),
      fps: round((n * 1000) / durationMs, 1),
      frameMs: fStats,
      worstHitchMs: fStats ? fStats.max : null,
      gpuMs: gStats,
      cpuPassMs: {
        sky: round(cpuSums.sky / Math.max(1, n), 2),
        sim: round(cpuSums.sim / Math.max(1, n), 2),
        refl: round(cpuSums.refl / Math.max(1, n), 2),
        main: round(cpuSums.main / Math.max(1, n), 2),
        post: round(cpuSums.post / Math.max(1, n), 2),
        total: round(cpuSums.total / Math.max(1, n), 2),
      },
      passes: finalizePasses(passAcc, n),
      jsHeapMB: readJsHeap(),
      _frameSamples: frameSamples,
      _gpuSamples: gpuSamples,
    };
    if (stageName === 'walk') {
      stopRec.walkDistanceM = round(player.distance, 1);
      stopRec.walkClimbM = round(player.climb, 1);
      player.autoWalk = false;
    }
    currentStops[stageName] = stopRec;

    stageIdx++;
    if (stageIdx < routeStages.length) {
      startCurrentStage();
      return;
    }

    // Completed all stages in this run
    const summary = summarizeRun(currentStops, !!timerExt);
    completedRuns[run.runId] = {
      ...run,
      internal: [post.sw, post.sh],
      scale: getScale(),
      stops: stripInternal(currentStops),
      summary,
    };
    run.teardown();

    runIdx++;
    stageIdx = 0;
    if (runIdx < runs.length) {
      startCurrentStage();
      return;
    }

    finalizeAll();
  }

  function finalizeAll() {
    ctrl.done = true;
    player.autoWalk = false;
    const mainRun = completedRuns.main;
    const result = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      url: location.href,
      route: routeName,
      stages: routeStages,
      fixedTime,
      walkDurationS: routeStages.includes('walk') ? walkDur : null,
      device: {
        renderer: gpuName,
        vendor: gpuVendor || '',
        userAgent: navigator.userAgent,
        isSoftware,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        devicePixelRatio: window.devicePixelRatio || 1,
        hasGpuTimer: !!timerExt,
      },
      tier: qName,
      quality: { ...Q },
      outputSize: {
        viewport: [innerWidth, innerHeight],
        canvas: [renderer.domElement.width, renderer.domElement.height],
        internal: mainRun.internal,
        scale: baseScale,
        msaa: baseMsaa,
      },
      heightHash: heightData.hash,
      heightData,
      stops: mainRun.stops,
      summary: mainRun.summary,
    };

    if (sweeps.length) {
      result.sweeps = {};
      if (sweeps.includes('scale')) {
        const scaleRuns = {};
        for (const s of [0.5, 0.75, 1.0]) {
          const r = completedRuns[`scale:${s}`];
          if (r) {
            scaleRuns[String(s)] = {
              scale: s,
              internal: r.internal,
              summary: r.summary,
              stops: r.stops,
            };
          }
        }
        result.sweeps.scale = {
          scales: [0.5, 0.75, 1.0],
          classification: classifyScaleSweep(scaleRuns, isSoftware),
          runs: scaleRuns,
        };
      }

      if (sweeps.includes('systems')) {
        const baseRun = completedRuns['systems:baseline'] || mainRun;
        const baseSum = baseRun.summary;
        const useGpu = !!(baseSum.gpuMs && baseSum.gpuMs.p50 != null);
        const systemsOut = { ...skippedSystems };
        const ranking = [];

        for (const sysName of requestedSystems) {
          const r = completedRuns[`systems:${sysName}`];
          if (!r) continue;
          const s = r.summary;
          const deltaFrameMs = round(baseSum.frameMs.p50 - s.frameMs.p50, 2);
          const deltaGpuMs =
            useGpu && s.gpuMs && s.gpuMs.p50 != null
              ? round(baseSum.gpuMs.p50 - s.gpuMs.p50, 2)
              : null;
          const deltaTris = baseSum.passes.total.avgTris - s.passes.total.avgTris;
          const deltaCalls = round(baseSum.passes.total.avgCalls - s.passes.total.avgCalls, 2);
          const pctFrameSaved = round((deltaFrameMs / Math.max(0.01, baseSum.frameMs.p50)) * 100, 1);
          const pctGpuSaved =
            deltaGpuMs != null ? round((deltaGpuMs / Math.max(0.01, baseSum.gpuMs.p50)) * 100, 1) : null;

          systemsOut[sysName] = {
            deltaFrameMs,
            deltaGpuMs,
            pctFrameSaved,
            pctGpuSaved,
            deltaTris,
            deltaCalls,
            summary: s,
            stops: r.stops,
          };
          ranking.push({
            system: sysName,
            deltaFrameMs,
            deltaGpuMs,
            pctFrameSaved,
            pctGpuSaved,
            deltaTris,
            deltaCalls,
          });
        }

        ranking.sort((a, b) => {
          const av = useGpu && a.deltaGpuMs != null ? a.deltaGpuMs : a.deltaFrameMs;
          const bv = useGpu && b.deltaGpuMs != null ? b.deltaGpuMs : b.deltaFrameMs;
          return bv - av;
        });

        let status = 'ok';
        let reason = null;
        if (isSoftware) {
          status = 'inconclusive';
          reason = 'software-renderer';
        } else if (!useGpu && baseSum.frameMs.p50 <= 17.2) {
          status = 'inconclusive';
          reason = 'vsync-capped';
        } else if (useGpu && baseSum.frameMs.p50 > baseSum.gpuMs.p50 * 1.45 && baseSum.frameMs.p50 > 18) {
          status = 'inconclusive';
          reason = 'cpu-bound';
        }

        result.sweeps.systems = {
          status,
          reason,
          metric: useGpu ? 'gpuMs.p50' : 'frameMs.p50',
          baseline: baseSum,
          ranking,
          systems: systemsOut,
        };
      }
    }

    const jsonStr = JSON.stringify(result, null, 2);
    window.__benchResult = result;
    window.__benchDone = true;
    overlay.showResult(result, jsonStr);
  }

  const ctrl = {
    done: false,
    onGpuSample(ms, disjoint) {
      if (ctrl.done || phase !== 'measure') return;
      if (skipGpuSamples > 0) {
        skipGpuSamples--;
        return;
      }
      if (disjoint) {
        gpuDisjoint++;
      } else if (ms != null && ms > 0) {
        gpuSamples.push(ms);
      }
    },
    onFrame({ now, rawMs, cpuMs, passes }) {
      if (ctrl.done) return;
      if (phase === 'warmup') {
        warmupLeft--;
        if (warmupLeft <= 0) {
          beginMeasure(now);
        }
        return;
      }

      frameSamples.push(rawMs);
      cpuSums.sky += cpuMs.sky;
      cpuSums.sim += cpuMs.sim;
      cpuSums.refl += cpuMs.refl;
      cpuSums.main += cpuMs.main;
      cpuSums.post += cpuMs.post;
      cpuSums.total += cpuMs.total;
      recordPasses(passAcc, passes);

      const stageName = routeStages[stageIdx];
      const elapsed = now - stageStartNow;
      const doneStage =
        stageName === 'walk'
          ? elapsed >= walkDur * 1000 && frameSamples.length >= 2
          : stopFramesParam != null
            ? frameSamples.length >= stopFramesParam
            : elapsed >= stopDur * 1000 && frameSamples.length >= minStopFrames;

      if (now - lastOverlayUpdate > 250 || doneStage) {
        lastOverlayUpdate = now;
        const run = runs[runIdx];
        const stepNo = runIdx * routeStages.length + stageIdx + 1;
        const fracInStage =
          stageName === 'walk'
            ? Math.min(1, elapsed / (walkDur * 1000))
            : stopFramesParam != null
              ? Math.min(1, frameSamples.length / stopFramesParam)
              : Math.min(1, Math.min(elapsed / (stopDur * 1000), frameSamples.length / minStopFrames));
        const pct = ((stepNo - 1 + fracInStage) / totalSteps) * 100;
        const fps = round((frameSamples.length * 1000) / Math.max(1, elapsed), 1);
        const detail =
          stageName === 'walk'
            ? `${(elapsed / 1000).toFixed(1)}s / ${walkDur}s · ${frameSamples.length} frames · ${fps} fps`
            : `${frameSamples.length} frames · ${(elapsed / 1000).toFixed(1)}s · ${fps} fps`;
        overlay.update(`${run.label} · ${stageName} (${stepNo}/${totalSteps})`, detail, pct);
        window.__benchProgress = {
          run: run.runId,
          stage: stageName,
          step: stepNo,
          totalSteps,
          frames: frameSamples.length,
          elapsedMs: round(elapsed, 0),
          pct: round(pct, 1),
        };
      }

      if (doneStage) {
        finishCurrentStage(now);
      }
    },
  };

  window.__benchDone = false;
  window.__benchResult = null;
  startCurrentStage();
  return ctrl;
}
