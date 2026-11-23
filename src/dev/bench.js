// Deterministic benchmark driver loaded dynamically only when ?bench is present.
// Runs fixed camera stops + time-parameterized auto-walk at a fixed time of day,
// optional scale/systems sweeps, and presents a touch-friendly, copyable JSON result overlay.

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
  'sky',
  'skyLut',
  'ambRead',
  'msaa',
  'rocks',
  'props',
];

const WALK_SPEED_MPS = 2.0;
const WALK_EYE_HEIGHT = 1.68;
const WALK_PITCH = -0.04;
const MIN_P99_SAMPLES = 100;
const MIN_SCALE_SAMPLES = 20;
const MIN_SCALE_STAGE_SAMPLES = 5;
const DRAIN_MAX_FRAMES = 600;
const DRAIN_MAX_MS = 10000;

// Common display refresh / rAF intervals (ms)
const RAF_CAP_INTERVALS_MS = [30, 40, 48, 50, 60, 72, 75, 90, 120, 144, 165, 240].map((hz) => 1000 / hz);

function round(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function meanOf(arr) {
  if (!arr.length) return null;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

function percentiles(values, minTailSamples = MIN_P99_SAMPLES, forceInsufficient = false) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return round(sorted[idx], 2);
  };
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i];
  const insufficientSamples = forceInsufficient || sorted.length < minTailSamples;
  return {
    p50: at(0.5),
    p95: insufficientSamples ? null : at(0.95),
    p99: insufficientSamples ? null : at(0.99),
    mean: round(sum / sorted.length, 2),
    min: round(sorted[0], 2),
    max: round(sorted[sorted.length - 1], 2),
    samples: sorted.length,
    insufficientSamples,
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

function sampleTrailXY(trail, d) {
  const dist = trail.dist;
  const pts = trail.points;
  const maxD = dist[dist.length - 1];
  const clamped = Math.max(0, Math.min(maxD, d));
  if (clamped <= 0) return [pts[0][0], pts[0][1]];
  if (clamped >= maxD) return [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  let lo = 0;
  let hi = dist.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const span = Math.max(1e-6, dist[hi] - dist[lo]);
  const u = (clamped - dist[lo]) / span;
  return [
    pts[lo][0] + (pts[hi][0] - pts[lo][0]) * u,
    pts[lo][1] + (pts[hi][1] - pts[lo][1]) * u,
  ];
}

function sampleTrailGroundY(hf, bridge, x, z) {
  let g = hf.height(x, z);
  if (bridge && Math.hypot(x - bridge.x, z - bridge.z) < 4.6) {
    g = Math.max(g, bridge.y - 0.1);
  }
  return g;
}

function computeTrailClimb(trail, hf, bridge, targetDist) {
  const steps = Math.max(1, Math.ceil(targetDist));
  let climb = 0;
  let prevY = null;
  for (let i = 0; i <= steps; i++) {
    const d = (i / steps) * targetDist;
    const [x, z] = sampleTrailXY(trail, d);
    const y = sampleTrailGroundY(hf, bridge, x, z);
    if (prevY !== null && y > prevY) climb += y - prevY;
    prevY = y;
  }
  return round(climb, 1);
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
  let setupPoseCalls = 0;
  let setupPoseTris = 0;
  const passTotals = {};
  for (const k of [...PASS_KEYS, 'total']) {
    passTotals[k] = { sumCalls: 0, sumTris: 0, maxCalls: 0, maxTris: 0 };
  }
  const insufficientStops = [];
  for (const [stageName, s] of Object.entries(stopsObj)) {
    totalFrames += s.frames;
    totalDurationMs += s.durationMs;
    if (s.worstHitchMs > worstHitchMs) worstHitchMs = s.worstHitchMs;
    if (s._frameSamples) allFrameMs.push(...s._frameSamples);
    if (s._gpuSamples) allGpuMs.push(...s._gpuSamples);
    if (s.gpuMs && s.gpuMs.disjoint) totalDisjoint += s.gpuMs.disjoint;
    if (s.insufficientSamples) insufficientStops.push(stageName);
    if (s.setupPoseRender) {
      setupPoseCalls += s.setupPoseRender.calls;
      setupPoseTris += s.setupPoseRender.tris;
    }
    for (const k of [...PASS_KEYS, 'total']) {
      const p = s.passes[k];
      passTotals[k].sumCalls += p.totalCalls;
      passTotals[k].sumTris += p.totalTris;
      if (p.maxCalls > passTotals[k].maxCalls) passTotals[k].maxCalls = p.maxCalls;
      if (p.maxTris > passTotals[k].maxTris) passTotals[k].maxTris = p.maxTris;
    }
  }
  const fStats = percentiles(allFrameMs, MIN_P99_SAMPLES, false);
  const gStats = hasGpuTimer
    ? allGpuMs.length
      ? { ...percentiles(allGpuMs, MIN_P99_SAMPLES, false), disjoint: totalDisjoint }
      : {
          p50: null,
          p95: null,
          p99: null,
          mean: null,
          min: null,
          max: null,
          samples: 0,
          insufficientSamples: true,
          disjoint: totalDisjoint,
        }
    : null;
  return {
    frames: totalFrames,
    durationMs: round(totalDurationMs, 1),
    fps: round((totalFrames * 1000) / Math.max(1, totalDurationMs), 1),
    frameMs: fStats,
    worstHitchMs: round(worstHitchMs, 2),
    insufficientSamples: fStats ? fStats.insufficientSamples : true,
    insufficientStops,
    gpuMs: gStats,
    passes: finalizePasses(passTotals, totalFrames),
    // Forced sky-LUT + near/far terrain-shadow refresh done once per stage at pose setup.
    setupPoseRender: {
      totalCalls: setupPoseCalls,
      totalTris: setupPoseTris,
    },
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

function isNearRafCap(ms050, ms075, ms100) {
  if (ms050 == null || ms075 == null || ms100 == null) return false;
  for (const cap of RAF_CAP_INTERVALS_MS) {
    const tol = Math.max(1.0, cap * 0.08);
    if (
      Math.abs(ms050 - cap) <= tol &&
      Math.abs(ms075 - cap) <= tol &&
      Math.abs(ms100 - cap) <= tol
    ) {
      return true;
    }
  }
  return ms050 <= 17.5 && ms075 <= 17.5 && ms100 <= 17.5 && Math.abs(ms100 - ms050) <= 1.5;
}

function equalWeightedStageStats(run, stages) {
  const frameVals = [];
  const gpuVals = [];
  const cpuVals = [];
  let frameCount = 0;
  let gpuCount = 0;
  let allStagesHaveMinFrames = true;
  let allStagesHaveMinGpu = true;

  for (const st of stages) {
    const s = run.stops?.[st];
    if (!s || !s.frameMs || s.frameMs.p50 == null) {
      allStagesHaveMinFrames = false;
      allStagesHaveMinGpu = false;
      continue;
    }
    frameCount += s.frames;
    if (s.frames < MIN_SCALE_STAGE_SAMPLES) allStagesHaveMinFrames = false;
    frameVals.push(s.frameMs.p50);
    if (s.cpuPassMs && s.cpuPassMs.total != null) cpuVals.push(s.cpuPassMs.total);

    if (s.gpuMs && s.gpuMs.p50 != null && s.gpuMs.samples >= MIN_SCALE_STAGE_SAMPLES) {
      gpuCount += s.gpuMs.samples;
      gpuVals.push(s.gpuMs.p50);
    } else {
      allStagesHaveMinGpu = false;
    }
  }

  return {
    frameP50: frameVals.length === stages.length ? round(meanOf(frameVals), 2) : null,
    gpuP50: allStagesHaveMinGpu && gpuVals.length === stages.length ? round(meanOf(gpuVals), 2) : null,
    cpuTotalMs: cpuVals.length === stages.length ? round(meanOf(cpuVals), 2) : null,
    frameSamples: frameCount,
    gpuSamples: gpuCount,
    validFrameSamples: allStagesHaveMinFrames && frameCount >= MIN_SCALE_SAMPLES,
    validGpuSamples: allStagesHaveMinGpu && gpuCount >= MIN_SCALE_SAMPLES,
  };
}

function classifyScaleSweep(scaleRuns, stages, isSoftware) {
  const r050 = scaleRuns['0.5'];
  const r075 = scaleRuns['0.75'];
  const r100 = scaleRuns['1'];
  if (!r050 || !r075 || !r100) {
    return { verdict: 'inconclusive', reason: 'missing-scale-runs', weighting: 'equal-per-stage' };
  }

  const e050 = equalWeightedStageStats(r050, stages);
  const e075 = equalWeightedStageStats(r075, stages);
  const e100 = equalWeightedStageStats(r100, stages);

  const hasValidFrames = e050.validFrameSamples && e075.validFrameSamples && e100.validFrameSamples;
  const useGpu = e050.validGpuSamples && e075.validGpuSamples && e100.validGpuSamples;

  const t050 = useGpu ? e050.gpuP50 : e050.frameP50;
  const t075 = useGpu ? e075.gpuP50 : e075.frameP50;
  const t100 = useGpu ? e100.gpuP50 : e100.frameP50;
  const ratio100to050 = t050 != null && t100 != null ? round(t100 / Math.max(0.01, t050), 3) : null;
  const ratio075to050 = t050 != null && t075 != null ? round(t075 / Math.max(0.01, t050), 3) : null;
  const metric = useGpu ? 'gpuMs.p50' : 'frameMs.p50';

  const perStage = {};
  for (const st of stages) {
    const s050 = r050.stops[st];
    const s075 = r075.stops[st];
    const s100 = r100.stops[st];
    const v050 = useGpu ? s050?.gpuMs?.p50 : s050?.frameMs?.p50;
    const v075 = useGpu ? s075?.gpuMs?.p50 : s075?.frameMs?.p50;
    const v100 = useGpu ? s100?.gpuMs?.p50 : s100?.frameMs?.p50;
    perStage[st] = {
      scale050Ms: v050 ?? null,
      scale075Ms: v075 ?? null,
      scale100Ms: v100 ?? null,
      ratio075to050: v050 != null && v075 != null ? round(v075 / Math.max(0.01, v050), 3) : null,
      ratio100to050: v050 != null && v100 != null ? round(v100 / Math.max(0.01, v050), 3) : null,
    };
  }

  const base = {
    metric,
    weighting: 'equal-per-stage',
    minSamplesPerScale: MIN_SCALE_SAMPLES,
    samples: {
      '0.5': useGpu ? e050.gpuSamples : e050.frameSamples,
      '0.75': useGpu ? e075.gpuSamples : e075.frameSamples,
      '1': useGpu ? e100.gpuSamples : e100.frameSamples,
    },
    scale050Ms: t050,
    scale075Ms: t075,
    scale100Ms: t100,
    ratio075to050,
    ratio100to050,
    perStage,
  };

  if (isSoftware) {
    return { ...base, verdict: 'inconclusive', reason: 'software-renderer' };
  }

  if (!hasValidFrames || t050 == null || t075 == null || t100 == null) {
    return { ...base, verdict: 'inconclusive', reason: 'insufficient-samples' };
  }

  // Reject inverse / non-monotonic downward trends before making any bottleneck claim
  if (
    ratio100to050 < 0.95 ||
    t100 < t050 - 0.5 ||
    ratio075to050 < 0.92 ||
    t100 < t075 * 0.92
  ) {
    return {
      ...base,
      verdict: 'inconclusive',
      reason: `inverse-trend (${t050} -> ${t075} -> ${t100} ms)`,
    };
  }

  // If frame-only and sitting flat near a display refresh / rAF cap
  if (!useGpu && isNearRafCap(e050.frameP50, e075.frameP50, e100.frameP50)) {
    return { ...base, verdict: 'inconclusive', reason: 'vsync-or-raf-capped' };
  }

  // Check if CPU-bound (frame time far exceeds GPU time at 1.0 scale, or CPU pass dominates frame-only)
  if (useGpu && e100.frameP50 != null && e100.frameP50 > e100.gpuP50 * 1.45 && e100.frameP50 > 18) {
    return { ...base, verdict: 'inconclusive', reason: 'cpu-bound' };
  }
  if (!useGpu && ratio100to050 <= 1.2 && e100.cpuTotalMs != null && e100.cpuTotalMs >= t100 * 0.65) {
    return { ...base, verdict: 'inconclusive', reason: 'cpu-bound' };
  }

  // Pixel count scales 4x from 0.5 -> 1.0 while triangle/draw counts stay constant.
  if (ratio100to050 >= 1.45 && t100 > t050 + 1.5) {
    return { ...base, verdict: 'pixel-limited', reason: `1.0/0.5 ratio ${ratio100to050}x (>= 1.45x)` };
  }
  if (t050 < t075 && t075 < t100 && ratio100to050 > 1.2 && t100 - t050 >= 2.0) {
    return {
      ...base,
      verdict: 'pixel-limited',
      reason: `monotonic pixel scaling ${ratio100to050}x (${t050} -> ${t075} -> ${t100} ms)`,
    };
  }
  if (ratio100to050 >= 0.95 && ratio100to050 <= 1.2) {
    if (!useGpu) {
      // Without GPU timer evidence, flat frame time could still be an unrecognised rAF/throttling cap
      return {
        ...base,
        verdict: 'inconclusive',
        reason: `flat frame-only scaling without GPU timer (${ratio100to050}x)`,
      };
    }
    return { ...base, verdict: 'geometry-limited', reason: `1.0/0.5 GPU ratio ${ratio100to050}x (<= 1.20x)` };
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
    #bench-panel .bp-title.aborted { color: #fca5a5; }
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
    '<div class="bp-head"><span class="bp-title" id="bench-title">Stillwater Benchmark Complete</span></div>' +
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
  const titleEl = panel.querySelector('#bench-title');
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

  function fmtMs(v) {
    return v == null ? 'N/A' : `${v}ms`;
  }

  return {
    update(stepText, detailText, pct) {
      stepEl.textContent = stepText;
      detailEl.textContent = detailText;
      barEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    },
    showResult(result, jsonStr) {
      status.style.display = 'none';
      if (result.aborted) {
        titleEl.textContent = 'Stillwater Benchmark Aborted';
        titleEl.classList.add('aborted');
        metaEl.textContent = result.abortMessage || `Aborted: ${result.abortReason}`;
      } else {
        titleEl.textContent = 'Stillwater Benchmark Complete';
        titleEl.classList.remove('aborted');
        const s = result.summary;
        const parts = [
          `tier=${result.tier}`,
          `size=${result.outputSize.internal[0]}x${result.outputSize.internal[1]} (${Math.round(result.outputSize.scale * 100)}%)`,
          `p50=${fmtMs(s.frameMs?.p50)}`,
          `p95=${fmtMs(s.frameMs?.p95)}`,
          `p99=${fmtMs(s.frameMs?.p99)}`,
          `hitch=${fmtMs(s.worstHitchMs)}`,
        ];
        if (s.gpuMs && s.gpuMs.p50 != null) parts.push(`gpu_p50=${s.gpuMs.p50}ms`);
        if (result.sweeps?.scale?.classification?.verdict) {
          parts.push(`scale=${result.sweeps.scale.classification.verdict}`);
        }
        parts.push(`height=${result.heightHash}`);
        metaEl.textContent = `${result.device.renderer} · ${parts.join(' · ')}`;
      }
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
    hasPendingGpuQueries,
    applyPose,
    camera,
    env,
    player,
    trail,
    hf,
    sky,
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
  const stopMaxDur = Math.max(stopDur, parseFloat(params.get('stopMaxDur') || '30'));
  const stopFramesParam = params.get('stopFrames') ? Math.max(2, parseInt(params.get('stopFrames'), 10)) : null;
  const minStopFrames = stopFramesParam || Math.max(2, parseInt(params.get('minFrames') || String(MIN_P99_SAMPLES), 10));
  const warmupFrames = Math.max(0, parseInt(params.get('warmup') || '6', 10));
  const requestedSystems = params.get('systems')
    ? params.get('systems').split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SYSTEMS;

  const totalTrailDist = trail.dist[trail.dist.length - 1];
  const walkTargetDist = Math.min(totalTrailDist, walkDur * WALK_SPEED_MPS);
  const walkExpectedClimb = computeTrailClimb(trail, hf, player.world.bridge, walkTargetDist);

  const isSoftware = SOFTWARE_RE.test(gpuName);
  const vendorExt = glCtx.getExtension('WEBGL_debug_renderer_info');
  const gpuVendor = vendorExt ? glCtx.getParameter(vendorExt.UNMASKED_VENDOR_WEBGL) : glCtx.getParameter(glCtx.VENDOR);
  const heightData = hashHeights(hf.h);

  const baseScale = getScale();
  const baseMsaa = post.opts.msaa || 0;
  const baseRefl = !!dbgState.refl;

  const lockedViewport = [innerWidth, innerHeight];
  const lockedCanvas = [renderer.domElement.width, renderer.domElement.height];
  const lockedDpr = window.devicePixelRatio || 1;

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
    sky: {
      isActive: () => sky.mesh.visible,
      set: (on) => { sky.mesh.visible = on; },
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
  let stageToken = 0;
  let phase = 'warmup'; // 'warmup' | 'measure' | 'drain'
  let warmupLeft = warmupFrames;
  let warmupRendered = 0;
  let warmupPassAcc = makePassAccum();
  let setupPose = null;
  let freshStage = false;
  let measureStarted = false;
  let stageStartNow = 0;
  let stageEndNow = 0;
  let prevFrameNow = 0;
  let pendingFrame = null;
  let stopCapHit = false;
  let walkEndRendered = false;
  let walkStartPos = null;
  let walkEndPos = null;
  let drainStartNow = 0;
  let drainFrames = 0;
  let frameSamples = [];
  let gpuSamples = [];
  let gpuDisjoint = 0;
  let cpuSums = { sky: 0, sim: 0, refl: 0, main: 0, post: 0, total: 0 };
  let passAcc = makePassAccum();
  let currentStops = {};
  const completedRuns = {};
  let lastOverlayUpdate = 0;

  function applyWalkPoseAtDist(dist) {
    const clamped = Math.max(0, Math.min(walkTargetDist, dist));
    const [x, z] = sampleTrailXY(trail, clamped);
    const lookDist = Math.min(totalTrailDist, clamped + 8.0);
    let ax, az;
    if (lookDist > clamped + 0.1) {
      [ax, az] = sampleTrailXY(trail, lookDist);
    } else {
      const [bx, bz] = sampleTrailXY(trail, Math.max(0, clamped - 8.0));
      ax = x + (x - bx);
      az = z + (z - bz);
    }
    const yaw = Math.atan2(-(ax - x), -(az - z));
    const g = sampleTrailGroundY(hf, player.world.bridge, x, z);
    const eyeY = g + WALK_EYE_HEIGHT;

    player.sitting = null;
    player.sitBlend = 0;
    player.autoWalk = false;
    player.vel.set(0, 0, 0);
    player.pos.set(x, 0, z);
    player.yaw = player.yawT = yaw;
    player.pitch = player.pitchT = WALK_PITCH;
    player.roll = 0;
    player.eyeY = eyeY;
    player.distance = clamped;
    player.moving = clamped > 0 && clamped < walkTargetDist ? 1 : 0;
    player.speedNow = WALK_SPEED_MPS;

    camera.position.set(x, eyeY, z);
    camera.rotation.set(WALK_PITCH, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    return [round(x, 3), round(eyeY, 3), round(z, 3)];
  }

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
      applyWalkPoseAtDist(0);
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
    // Pose setup forces one sky-LUT render and a near+far terrain-shadow refresh
    // (applyCaptureParams). Count those draws as setup so they never land in a measured frame.
    renderer.info.reset();
    applyStagePose(stageName);
    setupPose = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
    freshStage = true;
    stageToken++;
    warmupLeft = warmupFrames;
    warmupRendered = 0;
    warmupPassAcc = makePassAccum();
    phase = warmupLeft > 0 ? 'warmup' : 'measure';
    measureStarted = false;
    stageStartNow = 0;
    stageEndNow = 0;
    prevFrameNow = 0;
    pendingFrame = null;
    stopCapHit = false;
    walkEndRendered = false;
    walkStartPos = null;
    walkEndPos = null;
    drainStartNow = 0;
    drainFrames = 0;
    frameSamples = [];
    gpuSamples = [];
    gpuDisjoint = 0;
    cpuSums = { sky: 0, sim: 0, refl: 0, main: 0, post: 0, total: 0 };
    passAcc = makePassAccum();

    const stepNo = runIdx * routeStages.length + stageIdx + 1;
    overlay.update(
      `${run.label} · ${stageName} (${stepNo}/${totalSteps})`,
      phase === 'warmup' ? `warming up (${warmupFrames} frames)…` : 'measuring…',
      ((stepNo - 1) / totalSteps) * 100,
    );
  }

  function commitPendingFrame(now) {
    if (!pendingFrame) return;
    const intervalMs = Math.max(0.1, now - prevFrameNow);
    frameSamples.push(intervalMs);
    cpuSums.sky += pendingFrame.cpuMs.sky;
    cpuSums.sim += pendingFrame.cpuMs.sim;
    cpuSums.refl += pendingFrame.cpuMs.refl;
    cpuSums.main += pendingFrame.cpuMs.main;
    cpuSums.post += pendingFrame.cpuMs.post;
    cpuSums.total += pendingFrame.cpuMs.total;
    recordPasses(passAcc, pendingFrame.passes);
    pendingFrame = null;
    prevFrameNow = now;
  }

  function finishCurrentStage(endNow) {
    const run = runs[runIdx];
    const stageName = routeStages[stageIdx];
    const n = frameSamples.length;
    const durationMs = Math.max(0.1, endNow - stageStartNow);
    const tailMin = stageName === 'walk' ? MIN_P99_SAMPLES : Math.max(MIN_P99_SAMPLES, minStopFrames);
    const fStats = percentiles(frameSamples, tailMin, stopCapHit);
    const gStats = timerExt
      ? gpuSamples.length
        ? { ...percentiles(gpuSamples, tailMin, stopCapHit), disjoint: gpuDisjoint }
        : {
            p50: null,
            p95: null,
            p99: null,
            mean: null,
            min: null,
            max: null,
            samples: 0,
            insufficientSamples: true,
            disjoint: gpuDisjoint,
          }
      : null;

    const stopRec = {
      frames: n,
      durationMs: round(durationMs, 1),
      fps: round((n * 1000) / durationMs, 1),
      insufficientSamples: fStats ? fStats.insufficientSamples : true,
      capHit: stopCapHit,
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
      setupPasses: warmupRendered > 0 ? finalizePasses(warmupPassAcc, warmupRendered) : null,
      setupPoseRender: setupPose,
      jsHeapMB: readJsHeap(),
      _frameSamples: frameSamples,
      _gpuSamples: gpuSamples,
    };
    if (stageName === 'walk') {
      stopRec.walkDistanceM = round(walkTargetDist, 1);
      stopRec.walkClimbM = walkExpectedClimb;
      stopRec.walkStartPos = walkStartPos;
      stopRec.walkEndPos = walkEndPos;
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

  function buildCommonMeta() {
    return {
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
      url: location.href,
      route: routeName,
      stages: routeStages,
      fixedTime,
      walkDurationS: routeStages.includes('walk') ? walkDur : null,
      stopConfig: {
        minFrames: minStopFrames,
        minDurationS: stopDur,
        maxDurationS: stopMaxDur,
        exactFrames: stopFramesParam,
        warmupFrames,
        p99MinSamples: MIN_P99_SAMPLES,
      },
      notes: {
        mainPass:
          'main pass draw call and triangle counts include the directional sun-shadow map render performed inside renderer.render(scene, camera).',
        terrainShadowPass:
          'terrainShadow is the heightfield ray-marched shadow cache. Each stage pose setup forces one sky-LUT render and one near+far terrain-shadow refresh, reported per stage in setupPoseRender; normal cache behavior applies during warmup and measurement.',
      },
      device: {
        renderer: gpuName,
        vendor: gpuVendor || '',
        userAgent: navigator.userAgent,
        isSoftware,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        devicePixelRatio: lockedDpr,
        hasGpuTimer: !!timerExt,
      },
      tier: qName,
      quality: { ...Q },
      heightHash: heightData.hash,
      heightData,
    };
  }

  function abortOnResize(reasonDetail) {
    if (ctrl.done) return;
    ctrl.done = true;
    removeEventListener('resize', onResize);
    player.autoWalk = false;
    const activeRun = runs[runIdx];
    const activeStage = routeStages[stageIdx] || null;
    try {
      activeRun?.teardown?.();
    } catch {}

    const abortMessage =
      `Benchmark aborted due to viewport resize during ${activeRun?.label || 'run'} · ${activeStage || 'init'}: ` +
      `${reasonDetail}. Keep window size and orientation fixed for the full run.`;

    const result = {
      ...buildCommonMeta(),
      status: 'aborted',
      aborted: true,
      abortReason: 'viewport-resized',
      abortMessage,
      outputSize: {
        viewport: lockedViewport,
        canvas: lockedCanvas,
        internal: [post.sw, post.sh],
        scale: baseScale,
        msaa: baseMsaa,
        resizedViewport: [innerWidth, innerHeight],
        resizedCanvas: [renderer.domElement.width, renderer.domElement.height],
        resizedDpr: window.devicePixelRatio || 1,
      },
      stops: completedRuns.main ? completedRuns.main.stops : stripInternal(currentStops),
      summary: completedRuns.main ? completedRuns.main.summary : null,
    };

    const jsonStr = JSON.stringify(result, null, 2);
    window.__benchResult = result;
    window.__benchDone = true;
    overlay.showResult(result, jsonStr);
  }

  function checkViewportUnchanged() {
    const curDpr = window.devicePixelRatio || 1;
    if (
      innerWidth !== lockedViewport[0] ||
      innerHeight !== lockedViewport[1] ||
      renderer.domElement.width !== lockedCanvas[0] ||
      renderer.domElement.height !== lockedCanvas[1] ||
      curDpr !== lockedDpr
    ) {
      abortOnResize(
        `${lockedViewport[0]}x${lockedViewport[1]} (dpr ${lockedDpr}) -> ${innerWidth}x${innerHeight} (dpr ${curDpr})`,
      );
      return false;
    }
    return true;
  }

  const onResize = () => {
    checkViewportUnchanged();
  };
  addEventListener('resize', onResize);

  function finalizeAll() {
    ctrl.done = true;
    removeEventListener('resize', onResize);
    player.autoWalk = false;
    const mainRun = completedRuns.main;
    const result = {
      ...buildCommonMeta(),
      status: 'ok',
      aborted: false,
      outputSize: {
        viewport: lockedViewport,
        canvas: lockedCanvas,
        internal: mainRun.internal,
        scale: baseScale,
        msaa: baseMsaa,
      },
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
              equalWeighted: equalWeightedStageStats(r, routeStages),
              summary: r.summary,
              stops: r.stops,
            };
          }
        }
        result.sweeps.scale = {
          scales: [0.5, 0.75, 1.0],
          classification: classifyScaleSweep(scaleRuns, routeStages, isSoftware),
          runs: scaleRuns,
        };
      }

      if (sweeps.includes('systems')) {
        const baseRun = completedRuns['systems:baseline'] || mainRun;
        const baseEw = equalWeightedStageStats(baseRun, routeStages);
        const activeSysRuns = [];
        for (const sysName of requestedSystems) {
          const r = completedRuns[`systems:${sysName}`];
          if (r) activeSysRuns.push({ sysName, run: r });
        }

        // Single metric for the entire systems ranking: GPU ms if baseline AND every
        // active variant have valid gpuMs.p50 on every stage, else frame ms.
        const allVariantsHaveGpu =
          baseEw.gpuP50 != null &&
          activeSysRuns.every(({ run }) => routeStages.every((st) => run.stops[st]?.gpuMs?.p50 != null));
        const rankingMetric = allVariantsHaveGpu ? 'gpuMs.p50' : 'frameMs.p50';

        const systemsOut = { ...skippedSystems };
        const ranking = [];

        for (const { sysName, run: r } of activeSysRuns) {
          const perStage = {};
          const dFrames = [];
          const dGpus = [];
          const dTriss = [];
          const dCallss = [];
          let sysHasAllGpu = baseEw.gpuP50 != null;

          for (const st of routeStages) {
            const bs = baseRun.stops[st];
            const vs = r.stops[st];
            const df = bs.frameMs.p50 - vs.frameMs.p50;
            const dg =
              bs.gpuMs && bs.gpuMs.p50 != null && vs.gpuMs && vs.gpuMs.p50 != null
                ? bs.gpuMs.p50 - vs.gpuMs.p50
                : null;
            if (dg == null) sysHasAllGpu = false;
            const dt = bs.passes.total.avgTris - vs.passes.total.avgTris;
            const dc = bs.passes.total.avgCalls - vs.passes.total.avgCalls;
            dFrames.push(df);
            if (dg != null) dGpus.push(dg);
            dTriss.push(dt);
            dCallss.push(dc);
            perStage[st] = {
              deltaFrameMs: round(df, 2),
              deltaGpuMs: round(dg, 2),
              deltaTris: Math.round(dt),
              deltaCalls: round(dc, 2),
            };
          }

          const deltaFrameMs = round(meanOf(dFrames), 2);
          const deltaGpuMs = sysHasAllGpu && dGpus.length === routeStages.length ? round(meanOf(dGpus), 2) : null;
          const deltaTris = Math.round(meanOf(dTriss));
          const deltaCalls = round(meanOf(dCallss), 2);
          const pctFrameSaved = round((deltaFrameMs / Math.max(0.01, baseEw.frameP50)) * 100, 1);
          const pctGpuSaved =
            deltaGpuMs != null && baseEw.gpuP50 != null
              ? round((deltaGpuMs / Math.max(0.01, baseEw.gpuP50)) * 100, 1)
              : null;

          systemsOut[sysName] = {
            deltaFrameMs,
            deltaGpuMs,
            pctFrameSaved,
            pctGpuSaved,
            deltaTris,
            deltaCalls,
            perStage,
            summary: r.summary,
            stops: r.stops,
          };
          ranking.push({
            system: sysName,
            metric: rankingMetric,
            deltaMetricMs: rankingMetric === 'gpuMs.p50' ? deltaGpuMs : deltaFrameMs,
            pctMetricSaved: rankingMetric === 'gpuMs.p50' ? pctGpuSaved : pctFrameSaved,
            deltaFrameMs,
            deltaGpuMs,
            pctFrameSaved,
            pctGpuSaved,
            deltaTris,
            deltaCalls,
          });
        }

        ranking.sort((a, b) => b.deltaMetricMs - a.deltaMetricMs);

        let status = 'ok';
        let reason = null;
        if (isSoftware) {
          status = 'inconclusive';
          reason = 'software-renderer';
        } else if (rankingMetric === 'frameMs.p50' && isNearRafCap(baseEw.frameP50, baseEw.frameP50, baseEw.frameP50)) {
          status = 'inconclusive';
          reason = 'vsync-or-raf-capped';
        } else if (
          rankingMetric === 'gpuMs.p50' &&
          baseEw.frameP50 != null &&
          baseEw.frameP50 > baseEw.gpuP50 * 1.45 &&
          baseEw.frameP50 > 18
        ) {
          status = 'inconclusive';
          reason = 'cpu-bound';
        }

        result.sweeps.systems = {
          status,
          reason,
          metric: rankingMetric,
          weighting: 'equal-per-stage',
          baselineEqualWeighted: baseEw,
          baseline: baseRun.summary,
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

  function updateProgressOverlay(now, stageName, elapsed, force = false) {
    if (!force && now - lastOverlayUpdate <= 250) return;
    lastOverlayUpdate = now;
    const run = runs[runIdx];
    const stepNo = runIdx * routeStages.length + stageIdx + 1;
    const fracInStage =
      stageName === 'walk'
        ? Math.min(1, elapsed / (walkDur * 1000))
        : stopFramesParam != null
          ? Math.min(1, frameSamples.length / stopFramesParam)
          : Math.min(
              1,
              Math.max(
                elapsed / (stopMaxDur * 1000),
                Math.min(elapsed / (stopDur * 1000), frameSamples.length / minStopFrames),
              ),
            );
    const pct = ((stepNo - 1 + fracInStage) / totalSteps) * 100;
    const fps = round((frameSamples.length * 1000) / Math.max(1, elapsed), 1);
    const detail =
      stageName === 'walk'
        ? `${(elapsed / 1000).toFixed(1)}s / ${walkDur}s · ${frameSamples.length} frames · ${fps} fps`
        : `${frameSamples.length}/${minStopFrames} frames · ${(elapsed / 1000).toFixed(1)}s/${stopMaxDur}s · ${fps} fps`;
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

  const ctrl = {
    done: false,
    onGpuSample(ms, disjoint, tag) {
      if (ctrl.done) return;
      if (tag == null || tag !== stageToken) return;
      if (phase !== 'measure' && phase !== 'drain') return;
      if (disjoint) {
        gpuDisjoint++;
      } else if (ms != null && ms > 0) {
        gpuSamples.push(ms);
      }
    },
    beforeFrame(now) {
      if (ctrl.done) return { skipRender: true, queryTag: null, overridePose: false };
      if (!checkViewportUnchanged()) return { skipRender: true, queryTag: null, overridePose: false };

      if (phase === 'drain') {
        const pending = timerExt && hasPendingGpuQueries && hasPendingGpuQueries(stageToken);
        if (pending && drainFrames < DRAIN_MAX_FRAMES && now - drainStartNow < DRAIN_MAX_MS) {
          drainFrames++;
          return { skipRender: true, queryTag: null, overridePose: false };
        }
        finishCurrentStage(stageEndNow || now);
        if (ctrl.done) return { skipRender: true, queryTag: null, overridePose: false };
        // New stage started; proceed immediately into its warmup/first frame below.
      }

      const stageName = routeStages[stageIdx];

      if (phase === 'warmup') {
        freshStage = false;
        if (stageName === 'walk') {
          applyWalkPoseAtDist(0);
        }
        return { skipRender: false, queryTag: null, overridePose: stageName === 'walk' };
      }

      // phase === 'measure'
      if (!measureStarted) {
        // With warmup=0 the stage was set up inside this callback, so `now` predates the
        // setup work. Skip this frame and start measuring on the next animation frame.
        if (freshStage) {
          freshStage = false;
          return { skipRender: true, queryTag: null, overridePose: false };
        }
        measureStarted = true;
        stageStartNow = now;
        prevFrameNow = now;
        pendingFrame = null;
        if (stageName === 'walk') {
          walkStartPos = applyWalkPoseAtDist(0);
          walkEndPos = walkStartPos;
        }
        return { skipRender: false, queryTag: stageToken, overridePose: stageName === 'walk' };
      }

      // Commit the previous measured render using its exact frame interval (now - prevFrameNow)
      commitPendingFrame(now);
      const elapsed = now - stageStartNow;

      let doneStage = false;
      if (stageName === 'walk') {
        if (walkEndRendered) {
          doneStage = true;
        }
      } else if (stopFramesParam != null) {
        doneStage = frameSamples.length >= stopFramesParam;
      } else {
        const hitCount = frameSamples.length >= minStopFrames && elapsed >= stopDur * 1000;
        const hitCap = elapsed >= stopMaxDur * 1000 && frameSamples.length >= 2;
        if (hitCap && !hitCount) stopCapHit = true;
        doneStage = hitCount || hitCap;
      }

      updateProgressOverlay(now, stageName, elapsed, doneStage);

      if (doneStage) {
        stageEndNow = now;
        phase = 'drain';
        drainStartNow = now;
        drainFrames = 0;
        const pending = timerExt && hasPendingGpuQueries && hasPendingGpuQueries(stageToken);
        if (pending) {
          return { skipRender: true, queryTag: null, overridePose: false };
        }
        finishCurrentStage(stageEndNow);
        if (ctrl.done) return { skipRender: true, queryTag: null, overridePose: false };
        return ctrl.beforeFrame(now);
      }

      // Advance time-parameterized walk pose for the frame about to render
      if (stageName === 'walk') {
        const progress = Math.min(1, Math.max(0, elapsed / (walkDur * 1000)));
        const pos = applyWalkPoseAtDist(progress * walkTargetDist);
        if (elapsed >= walkDur * 1000 && frameSamples.length >= 1) {
          walkEndPos = pos;
          walkEndRendered = true;
        }
      }

      return { skipRender: false, queryTag: stageToken, overridePose: stageName === 'walk' };
    },
    onFrame({ cpuMs, passes }) {
      if (ctrl.done) return;
      if (phase === 'warmup') {
        recordPasses(warmupPassAcc, passes);
        warmupRendered++;
        warmupLeft--;
        if (warmupLeft <= 0) {
          phase = 'measure';
          measureStarted = false;
        }
        return;
      }
      if (phase === 'measure') {
        pendingFrame = { cpuMs, passes };
      }
    },
  };

  window.__benchDone = false;
  window.__benchResult = null;
  startCurrentStage();
  return ctrl;
}
