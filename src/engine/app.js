import * as THREE from 'three';
import { Post } from '../post.js';
import { detectQuality, resolveQuality } from './quality.js';
import { warmRenderPasses } from './renderFrame.js';
import { SystemRegistry } from './systems.js';

// Engine application shell: WebGL2 renderer, camera, post chain, resize,
// GPU timer query polling, dynamic resolution, and fixed-step 60 Hz frame loop
// with render interpolation (capture keeps its fixed 1/30 step).

export const FIXED_DT = 1 / 60;
const CAPTURE_DT = 1 / 30;
const MAX_FRAME_DT = 0.05;

const captureRenderers = new WeakSet();
/** @type {WeakMap<object, Set<{ isPending: () => boolean, wait: () => Promise<any> }>>} */
const asyncReadbackHooks = new WeakMap();

export function markCaptureRenderer(renderer) {
  if (renderer) captureRenderers.add(renderer);
}

export function isCaptureRenderer(renderer) {
  return !!(renderer && captureRenderers.has(renderer));
}

export function registerAsyncReadback(renderer, hook) {
  if (!renderer || !hook) return () => {};
  let set = asyncReadbackHooks.get(renderer);
  if (!set) {
    set = new Set();
    asyncReadbackHooks.set(renderer, set);
  }
  set.add(hook);
  return () => {
    set.delete(hook);
    if (set.size === 0) asyncReadbackHooks.delete(renderer);
  };
}

export function hasPendingAsyncReadback(renderer) {
  const set = renderer ? asyncReadbackHooks.get(renderer) : null;
  if (!set) return false;
  for (const hook of set) {
    if (hook.isPending()) return true;
  }
  return false;
}

export async function waitForAsyncReadbacks(renderer) {
  const set = renderer ? asyncReadbackHooks.get(renderer) : null;
  if (!set || set.size === 0) return;
  await Promise.all(Array.from(set, (hook) => hook.wait()));
}

export function applyShadowMapType(renderer, scene, tier) {
  const nextType = tier?.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (renderer.shadowMap.type === nextType) return false;
  renderer.shadowMap.type = nextType;
  if (scene) {
    // Three.js caches shadow filter defines per program without tracking shadowMap.type changes.
    scene.traverse((rawObj) => {
      /** @type {any} */
      const obj = rawObj;
      const mat = obj.material;
      if (!mat) return;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) if (mat[i]) mat[i].needsUpdate = true;
      } else {
        mat.needsUpdate = true;
      }
    });
  }
  return true;
}

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
  if (capture) markCaptureRenderer(renderer);
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = true;
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
  renderer.shadowMap.type = Q.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.25, 60000);
  let post = null;
  const registry = new SystemRegistry();

  function initPost() {
    if (!post) post = new Post(renderer, { reverse: clipControl, msaa: Q.msaa, godrays: Q.godrays });
    return post;
  }

  const resizeListeners = [];
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post?.setSize(innerWidth, innerHeight, scale);
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
    simTime: 0,
    accumulator: 0,
    frameNo: 0,
    last: performance.now(),
    perfAcc: 0,
    perfN: 0,
    perfT: 0,
  };

  // Previous and current simulation camera poses for render interpolation.
  const prevCamPos = new THREE.Vector3();
  const currCamPos = new THREE.Vector3();
  const prevCamQuat = new THREE.Quaternion();
  const currCamQuat = new THREE.Quaternion();
  let hasStepped = false;
  let snappedThisStep = false;

  function snapCamera() {
    prevCamPos.copy(camera.position);
    currCamPos.copy(camera.position);
    prevCamQuat.copy(camera.quaternion);
    currCamQuat.copy(camera.quaternion);
    snappedThisStep = true;
  }

  function resetClock(t = 0) {
    clock.t = t;
    clock.simTime = t;
    clock.accumulator = 0;
    clock.frameNo = 0;
    hasStepped = false;
  }

  function updateDynamicScale(dt, onPerf) {
    clock.perfAcc += dt;
    clock.perfN++;
    clock.perfT += dt;
    if (clock.perfT <= 1.5) return;
    const avg = clock.perfAcc / clock.perfN;
    onPerf?.(`${Math.round(1 / avg)} fps · ${qName} · ${Math.round(scale * 100)}%`);
    if (avg > 1 / 27 && scale > 0.55) {
      scale = Math.max(0.55, scale - 0.05);
      post?.setSize(innerWidth, innerHeight, scale);
    } else if (avg < 1 / 45 && scale < Q.scale) {
      scale = Math.min(Q.scale, scale + 0.05);
      post?.setSize(innerWidth, innerHeight, scale);
    }
    clock.perfAcc = clock.perfN = clock.perfT = 0;
  }

  let rafId = 0;
  let disposed = false;
  let warmed = false;

  async function warmShaders() {
    if (warmed || disposed) return;
    warmed = true;
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(scene, camera);
    }
    if (disposed) return;
    warmRenderPasses({ renderer, scene, camera, post });
    await waitForAsyncReadbacks(renderer);
  }

  function start(callbacks) {
    snapCamera();
    clock.last = performance.now();
    const tick = (now) => {
      if (disposed) return;
      rafId = requestAnimationFrame(tick);
      if (callbacks.shouldSkip?.()) return;
      const rawMs = Math.max(0.1, now - clock.last);
      const frameDt = Math.min(MAX_FRAME_DT, rawMs / 1000);
      clock.last = now;
      if (callbacks.isPaused?.()) return;

      if (capture) {
        // Hold capture frame progression until pending async readbacks settle
        // so every captured frame renders with deterministic lighting and exposure.
        if (hasPendingAsyncReadback(renderer)) return;
        const dt = CAPTURE_DT;
        clock.t += dt;
        clock.simTime = clock.t;
        clock.frameNo++;
        callbacks.onCaptureFrame({ now, rawMs, dt, t: clock.t, frameNo: clock.frameNo });
        return;
      }

      const pre = callbacks.beforeFrame?.(now);
      if (pre?.skipRender) return;

      clock.frameNo++;
      clock.accumulator += frameDt;
      const overridePose = !!pre?.overridePose;
      while (clock.accumulator >= FIXED_DT) {
        snappedThisStep = false;
        prevCamPos.copy(currCamPos);
        prevCamQuat.copy(currCamQuat);
        clock.simTime += FIXED_DT;
        callbacks.onSimStep?.({ dt: FIXED_DT, t: clock.simTime, overridePose });
        if (!overridePose && !snappedThisStep) {
          currCamPos.copy(camera.position);
          currCamQuat.copy(camera.quaternion);
        }
        clock.accumulator -= FIXED_DT;
        hasStepped = true;
      }

      const alpha = clock.accumulator / FIXED_DT;
      if (!overridePose) {
        camera.position.lerpVectors(prevCamPos, currCamPos, alpha);
        camera.quaternion.slerpQuaternions(prevCamQuat, currCamQuat, alpha);
        camera.updateMatrixWorld();
      }
      clock.t = hasStepped ? Math.max(0, clock.simTime - FIXED_DT * (1 - alpha)) : clock.accumulator;
      callbacks.onRenderFrame({
        now,
        rawMs,
        dt: frameDt,
        t: clock.t,
        alpha,
        frameNo: clock.frameNo,
        pre,
      });
    };

    const launchLoop = () => {
      if (disposed) return;
      snapCamera();
      clock.last = performance.now();
      rafId = requestAnimationFrame(tick);
    };

    warmShaders().then(launchLoop, (err) => {
      console.error('warmShaders failed:', err);
      launchLoop();
    });
  }

  function setTier(nextName, nextQ) {
    qName = nextName;
    Q = nextQ;
    scale = Q.scale;
    applyShadowMapType(renderer, scene, Q);
    if (post) {
      post.opts.msaa = Q.msaa;
      post.opts.godrays = Q.godrays;
    }
    resize();
  }

  function dispose() {
    disposed = true;
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
    get post() { return post; },
    initPost,
    registry,
    clock,
    get qName() { return qName; },
    get Q() { return Q; },
    getScale: () => scale,
    getPixelHeight: () => renderer.domElement.height * scale,
    setScale: (s) => { scale = s; post?.setSize(innerWidth, innerHeight, scale); },
    onResize: (fn) => resizeListeners.push(fn),
    resize,
    setTier,
    snapCamera,
    resetClock,
    updateDynamicScale,
    pollGpuTimers,
    beginGpuTimer,
    endGpuTimer,
    hasPendingGpuQueries: (tag) => gpuQueries.some((item) => item.tag === tag),
    getGpuMsEma: () => gpuMsEma,
    warmShaders,
    start,
    dispose,
  };
}
