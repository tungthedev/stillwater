import { TIER_NAMES } from '../engine/quality.js';

// On-screen performance debug HUD and live pass toggles.
// Loaded dynamically only when ?debug is present.

const $ = (id) => document.getElementById(id);

export function createDebugHud({
  app,
  world,
  renderFlags,
  onTierChange,
}) {
  const { renderer, camera, post, timerExt, gpuName } = app;
  const { terrain, trees, grass, flowers, ferns, clouds } = world;

  let dbgOn = true;
  const dbgEl = $('debug');
  const dbgFpsEl = $('dbgFps');
  const dbgMsEl = $('dbgMs');
  const dbgGpuEl = $('dbgGpu');
  const dbgBodyEl = $('dbgBody');
  const dbgCanvas = $('dbgGraph');
  const dbgCtx = dbgCanvas ? dbgCanvas.getContext('2d') : null;

  const toggleBtns = new Map();
  const qualBtns = new Map();

  const stopProp = (e) => e.stopPropagation();
  const onKeyDown = (e) => {
    if (e.code === 'KeyG') {
      dbgOn = !dbgOn;
      dbgEl?.classList.toggle('on', dbgOn);
    }
  };
  addEventListener('keydown', onKeyDown);

  if (dbgEl) {
    dbgEl.classList.toggle('on', dbgOn);
    dbgGpuEl.textContent = gpuName;
    dbgEl.addEventListener('click', stopProp);
    dbgEl.addEventListener('mousedown', stopProp);

    const toggleDefs = [
      ['shadow', 'Shadows'], ['refl', 'Refl'], ['grass', 'Grass'], ['ferns', 'Ferns'],
      ['trees', 'Trees'], ['clouds', 'Clouds'], ['bloom', 'Bloom'], ['ambRead', 'ReadAmb'],
      ['skyLut', 'SkyLUT'], ['msaa', 'MSAA'],
    ];
    const tWrap = $('dbgToggles');
    tWrap.textContent = '';
    for (const [key, label] of toggleDefs) {
      const b = document.createElement('span');
      b.className = 'pill' + (renderFlags[key] ? '' : ' off');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        renderFlags[key] = !renderFlags[key];
        b.classList.toggle('off', !renderFlags[key]);
        if (key === 'grass') { grass.mesh.visible = renderFlags.grass; flowers.mesh.visible = renderFlags.grass; }
        if (key === 'ferns') { ferns.mesh.visible = renderFlags.ferns; }
        if (key === 'trees') { trees.group.visible = renderFlags.trees; }
        if (key === 'clouds') { clouds.mesh.visible = renderFlags.clouds; }
        if (key === 'msaa') { post.opts.msaa = renderFlags.msaa ? 4 : 0; post.setSize(innerWidth, innerHeight, app.getScale()); }
      });
      tWrap.appendChild(b);
      toggleBtns.set(key, b);
    }

    const qWrap = $('dbgQuals');
    qWrap.textContent = '';
    for (const qk of TIER_NAMES) {
      const b = document.createElement('span');
      b.className = 'pill q' + (qk === app.qName ? ' cur' : '');
      b.textContent = qk;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onTierChange(qk);
      });
      qWrap.appendChild(b);
      qualBtns.set(qk, b);
    }
  }

  const dbgHist = new Float32Array(68);
  let dbgHistIdx = 0;
  let dbgLastUi = 0;
  let dbgMaxMs = 0;
  let dbgFrameEma = 16.7;
  const pEma = { sky: 0, sim: 0, refl: 0, main: 0, post: 0, reflTris: 0, mainTris: 0, totalCalls: 0, totalTris: 0 };

  function onFrame({ now, rawMs, cpuMs, passes }) {
    dbgFrameEma = dbgFrameEma * 0.90 + rawMs * 0.10;
    dbgMaxMs = Math.max(dbgMaxMs, rawMs);
    dbgHist[dbgHistIdx = (dbgHistIdx + 1) % dbgHist.length] = rawMs;

    pEma.sky = pEma.sky * 0.85 + cpuMs.sky * 0.15;
    pEma.sim = pEma.sim * 0.85 + cpuMs.sim * 0.15;
    pEma.refl = pEma.refl * 0.85 + cpuMs.refl * 0.15;
    pEma.main = pEma.main * 0.85 + cpuMs.main * 0.15;
    pEma.post = pEma.post * 0.85 + cpuMs.post * 0.15;
    pEma.reflTris = passes.reflection.tris;
    pEma.mainTris = passes.main.tris;
    pEma.totalCalls = passes.reflection.calls + passes.main.calls + passes.post.calls;
    pEma.totalTris = passes.reflection.tris + passes.main.tris + passes.post.tris;

    if (!dbgOn || !dbgEl || now - dbgLastUi <= 220) return;
    dbgLastUi = now;
    const fps = Math.round(1000 / Math.max(dbgFrameEma, 0.1));
    dbgFpsEl.textContent = `${fps} fps`;
    dbgFpsEl.className = 'fps ' + (fps >= 48 ? 'good' : fps >= 26 ? 'mid' : 'bad');
    dbgMsEl.textContent = `${dbgFrameEma.toFixed(1)}ms (max ${dbgMaxMs.toFixed(0)}ms)`;
    dbgMaxMs = 0;
    const fmtT = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
    const ts = trees.stats;
    const gpuRow = timerExt ? `<div class="row"><span>GPU time</span><b>${app.getGpuMsEma().toFixed(1)} ms</b></div>` : '';
    const memRow = performance.memory ? `<div class="row"><span>JS Heap</span><b>${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB</b></div>` : '';
    const scale = app.getScale();
    const Q = app.Q;
    dbgBodyEl.innerHTML =
      `<div class="row"><span>Target</span><b>${post.sw}×${post.sh} (${Math.round(scale * 100)}%) · ${post.opts.msaa || 0}×MSAA</b></div>` +
      `<div class="row"><span>Preset / DPR</span><b>${app.qName} · dpr ${devicePixelRatio.toFixed(1)} · ${innerWidth}×${innerHeight}</b></div>` +
      `<div class="row"><span>Draws / Tris</span><b>${pEma.totalCalls} calls · ${fmtT(pEma.totalTris)} tris</b></div>` +
      `<div class="row"><span>Tris (Refl/Main)</span><b>${fmtT(pEma.reflTris)} / ${fmtT(pEma.mainTris)}</b></div>` +
      `<div class="sec">` +
      gpuRow +
      `<div class="row"><span>CPU sky+amb / sim</span><b>${pEma.sky.toFixed(1)} / ${pEma.sim.toFixed(1)} ms</b></div>` +
      `<div class="row"><span>CPU refl / main / post</span><b>${pEma.refl.toFixed(1)} / ${pEma.main.toFixed(1)} / ${pEma.post.toFixed(1)} ms</b></div>` +
      memRow +
      `</div><div class="sec">` +
      `<div class="row"><span>Terrain / Trees</span><b>${terrain.geometry.instanceCount} nodes · ${ts.hero}/${ts.mid}/${ts.impostor}</b></div>` +
      `<div class="row"><span>Grass / Ferns</span><b>${fmtT(Q.grass)} / ${fmtT(ferns.mesh.geometry.instanceCount)}</b></div>` +
      `<div class="row"><span>Pos / Geo·Tex</span><b>${Math.round(camera.position.x)},${Math.round(camera.position.y)},${Math.round(camera.position.z)} · ${renderer.info.memory.geometries}g/${renderer.info.memory.textures}t</b></div>` +
      `</div>`;
    if (dbgCtx) {
      const W = dbgCanvas.width, H = dbgCanvas.height;
      dbgCtx.clearRect(0, 0, W, H);
      dbgCtx.fillStyle = 'rgba(110,231,183,0.22)'; dbgCtx.fillRect(0, H - (16.7 / 66) * H, W, 1);
      dbgCtx.fillStyle = 'rgba(252,211,77,0.22)'; dbgCtx.fillRect(0, H - (33.3 / 66) * H, W, 1);
      const bw = W / dbgHist.length;
      for (let i = 0; i < dbgHist.length; i++) {
        const v = dbgHist[(dbgHistIdx + 1 + i) % dbgHist.length];
        const bh = Math.min(H, (v / 66) * H);
        dbgCtx.fillStyle = v <= 20 ? '#6ee7b7' : v <= 36 ? '#fcd34d' : '#fca5a5';
        dbgCtx.fillRect(i * bw, H - bh, Math.max(1, bw - 1), bh);
      }
    }
  }

  function onTierSync(qName) {
    for (const [qk, btn] of qualBtns) btn.classList.toggle('cur', qk === qName);
    for (const [key, btn] of toggleBtns) btn.classList.toggle('off', !renderFlags[key]);
  }

  function dispose() {
    removeEventListener('keydown', onKeyDown);
    dbgEl?.removeEventListener('click', stopProp);
    dbgEl?.removeEventListener('mousedown', stopProp);
  }

  return {
    isVisible: () => dbgOn,
    onFrame,
    onTierSync,
    dispose,
  };
}
