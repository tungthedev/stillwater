import * as THREE from 'three';
import { Post } from '../post.js';
import { detectQuality, resolveQuality } from './quality.js';
import { SystemRegistry } from './systems.js';

// Engine application shell: WebGL2 renderer, camera, post chain, resize,
// GPU timer query polling, and frame loop.

export function createApp({ canvas, capture = false, params = new URLSearchParams(location.search) }) {
  const probe = document.createElement('canvas').getContext('webgl2');
  const clipControl = params.has('rd') && !!(probe && probe.getExtension('EXT_clip_control'));
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    reverseDepthBuffer: clipControl,
    preserveDrawingBuffer: capture,
    stencil: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = true;
  renderer.info.autoReset = false;

  const glCtx = renderer.getContext();
  const gpuName = (() => {
    const ext = glCtx.getExtension('WEBGL_debug_renderer_info');
    return (ext ? glCtx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : glCtx.getParameter(glCtx.RENDERER)) || 'WebGL2';
  })();
  const timerExt = !capture ? glCtx.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  const gpuQueries = [];
  let gpuMsEma = 0;

  let qName = detectQuality(renderer, params);
  let Q = resolveQuality(qName, params);
  let scale = Q.scale;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.25, 60000);
  const post = new Post(renderer, { reverse: clipControl, msaa: Q.msaa, godrays: Q.godrays });
  const registry = new SystemRegistry();

  const resizeListeners = [];
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight, scale);
    for (let i = 0; i < resizeListeners.length; i++) {
      resizeListeners[i](innerWidth, innerHeight, Q, scale);
    }
  };
  addEventListener('resize', resize);

  function pollGpuTimers(wantGpuTimer, onSample) {
    if (!wantGpuTimer || !timerExt || !gpuQueries.length) return;
    if (!glCtx.getQueryParameter(gpuQueries[0].q, glCtx.QUERY_RESULT_AVAILABLE)) return;
    const pollDisjoint = !!glCtx.getParameter(timerExt.GPU_DISJOINT_EXT);
    if (pollDisjoint) {
      for (const item of gpuQueries) item.disjoint = true;
    }
    while (gpuQueries.length) {
      const item = gpuQueries[0];
      if (!glCtx.getQueryParameter(item.q, glCtx.QUERY_RESULT_AVAILABLE)) break;
      const ns = glCtx.getQueryParameter(item.q, glCtx.QUERY_RESULT);
      glCtx.deleteQuery(item.q);
      gpuQueries.shift();
      const isDisjoint = pollDisjoint || item.disjoint;
      if (!isDisjoint && ns > 0) {
        const ms = ns / 1e6;
        gpuMsEma = gpuMsEma ? gpuMsEma * 0.85 + ms * 0.15 : ms;
        onSample?.(ms, false, item.tag);
      } else if (isDisjoint) {
        onSample?.(null, true, item.tag);
      }
    }
  }

  function beginGpuTimer(wantGpuTimer, tag, maxPending) {
    if (!wantGpuTimer || !timerExt || gpuQueries.length >= maxPending) return null;
    const q = glCtx.createQuery();
    glCtx.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
    return q;
  }

  function endGpuTimer(q, tag) {
    if (!q || !timerExt) return;
    glCtx.endQuery(timerExt.TIME_ELAPSED_EXT);
    gpuQueries.push({ q, tag, disjoint: false });
  }

  const clock = {
    t: 0,
    frameNo: 0,
    last: performance.now(),
    perfAcc: 0,
    perfN: 0,
    perfT: 0,
  };

  let rafId = 0;

  function start(callbacks) {
    clock.last = performance.now();
    const tick = (now) => {
      rafId = requestAnimationFrame(tick);
      if (callbacks.shouldSkip?.()) return;
      const rawMs = Math.max(0.1, now - clock.last);
      let dt = Math.min(0.05, rawMs / 1000);
      clock.last = now;
      if (capture) dt = 1 / 30;
      if (callbacks.isPaused?.()) return;
      clock.t += dt;
      clock.frameNo++;
      clock.perfAcc += dt;
      clock.perfN++;
      clock.perfT += dt;
      callbacks.onFrame({
        now,
        rawMs,
        dt,
        t: clock.t,
        frameNo: clock.frameNo,
      });
    };
    rafId = requestAnimationFrame(tick);
  }

  function setTier(nextName, nextQ) {
    qName = nextName;
    Q = nextQ;
    scale = Q.scale;
    post.opts.msaa = Q.msaa;
    post.opts.godrays = Q.godrays;
    resize();
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    removeEventListener('resize', resize);
    while (gpuQueries.length) {
      const item = gpuQueries.pop();
      glCtx.deleteQuery(item.q);
    }
    registry.dispose();
  }

  return {
    renderer,
    glCtx,
    timerExt,
    gpuName,
    scene,
    camera,
    post,
    registry,
    clock,
    get qName() { return qName; },
    get Q() { return Q; },
    getScale: () => scale,
    setScale: (s) => { scale = s; post.setSize(innerWidth, innerHeight, scale); },
    onResize: (fn) => resizeListeners.push(fn),
    resize,
    setTier,
    pollGpuTimers,
    beginGpuTimer,
    endGpuTimer,
    hasPendingGpuQueries: (tag) => gpuQueries.some((item) => item.tag === tag),
    getGpuMsEma: () => gpuMsEma,
    start,
    dispose,
  };
}
