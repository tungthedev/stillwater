// On-screen diagnostics for devices without a reachable console (iPhone Safari).
// Loaded only with ?diag. Installs before the game module so shader compile
// errors and load failures during world build are captured too.
(function () {
  if (!/[?&]diag\b/.test(location.search)) return;
  const lines = [];
  const seen = new Map();
  let box = null;
  let body = null;

  function fmt(a) {
    if (a instanceof Error) return a.name + ': ' + a.message + (a.stack ? '\n' + String(a.stack).split('\n').slice(0, 3).join('\n') : '');
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }
  function add(kind, text) {
    text = String(text);
    const key = kind + text.slice(0, 160);
    if (seen.has(key)) { seen.get(key).n++; render(); return; }
    const row = { kind, text: text.length > 1400 ? text.slice(0, 1400) + ' …' : text, n: 1 };
    seen.set(key, row);
    lines.push(row);
    render();
  }
  function render() {
    if (!body) return;
    body.textContent = '';
    const order = { ERR: 0, WARN: 1, INFO: 2 };
    const sorted = lines.slice().sort((x, y) => order[x.kind] - order[y.kind]);
    if (!lines.some((r) => r.kind === 'ERR')) {
      const ok = document.createElement('div');
      ok.style.cssText = 'margin:0 0 6px;color:#6ee7b7;font-weight:700';
      ok.textContent = 'no errors so far';
      body.appendChild(ok);
    }
    for (const r of sorted) {
      const d = document.createElement('div');
      d.style.cssText = 'margin:0 0 6px;white-space:pre-wrap;word-break:break-word;color:' +
        (r.kind === 'ERR' ? '#fca5a5' : r.kind === 'WARN' ? '#fcd34d' : '#d1fae5');
      d.textContent = '[' + r.kind + (r.n > 1 ? ' x' + r.n : '') + '] ' + r.text;
      body.appendChild(d);
    }
  }
  function mount() {
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:6px;right:6px;top:6px;max-height:62vh;overflow:auto;z-index:99999;' +
      'background:rgba(6,10,16,0.9);border:1px solid rgba(255,255,255,0.25);border-radius:8px;padding:8px 10px;' +
      'font:10.5px/1.4 ui-monospace,Menlo,monospace;color:#e8eef6;pointer-events:auto;-webkit-user-select:text;user-select:text;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:6px;font-weight:700';
    bar.innerHTML = '<span>STILLWATER DIAG</span>';
    const hide = document.createElement('button');
    hide.textContent = 'hide';
    hide.style.cssText = 'font:inherit;background:#334;color:#fff;border:0;border-radius:4px;padding:2px 8px';
    hide.onclick = (e) => { e.stopPropagation(); box.style.display = 'none'; };
    bar.appendChild(hide);
    body = document.createElement('div');
    box.appendChild(bar); box.appendChild(body);
    document.body.appendChild(box);
    render();
  }

  const oErr = console.error.bind(console), oWarn = console.warn.bind(console);
  console.error = function () { add('ERR', Array.from(arguments).map(fmt).join(' ')); oErr.apply(null, arguments); };
  console.warn = function () { add('WARN', Array.from(arguments).map(fmt).join(' ')); oWarn.apply(null, arguments); };
  addEventListener('error', (e) => add('ERR', (e.message || 'error') + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : '')));
  addEventListener('unhandledrejection', (e) => add('ERR', 'unhandled: ' + fmt(e.reason)));

  // Standalone WebGL2 probe, independent of the game, so it reports even if the game fails to start.
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) add('ERR', 'no WebGL2 context');
    else {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const P = (p) => gl.getParameter(p);
      const pf = (s, t) => { const f = gl.getShaderPrecisionFormat(s, t); return f ? f.precision + '/' + f.rangeMax : '?'; };
      add('INFO', 'UA ' + navigator.userAgent);
      add('INFO', 'GPU ' + (dbg ? P(dbg.UNMASKED_RENDERER_WEBGL) : P(gl.RENDERER)) + ' | ' + P(gl.VERSION) + ' | ' + P(gl.SHADING_LANGUAGE_VERSION));
      add('INFO', 'screen ' + screen.width + 'x' + screen.height + ' dpr ' + devicePixelRatio + ' inner ' + innerWidth + 'x' + innerHeight);
      add('INFO', 'precision frag highp ' + pf(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT) + ' mediump ' + pf(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT) +
        ' | vert highp ' + pf(gl.VERTEX_SHADER, gl.HIGH_FLOAT) + ' | frag highp int ' + pf(gl.FRAGMENT_SHADER, gl.HIGH_INT));
      add('INFO', 'maxTex ' + P(gl.MAX_TEXTURE_SIZE) + ' texUnits frag ' + P(gl.MAX_TEXTURE_IMAGE_UNITS) + ' vert ' + P(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) +
        ' combined ' + P(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) + ' | uniforms frag ' + P(gl.MAX_FRAGMENT_UNIFORM_VECTORS) + ' vert ' + P(gl.MAX_VERTEX_UNIFORM_VECTORS) +
        ' | varyings ' + P(gl.MAX_VARYING_VECTORS) + ' | samples ' + P(gl.MAX_SAMPLES) + ' | drawBuffers ' + P(gl.MAX_DRAW_BUFFERS));
      add('INFO', 'ext ' + (gl.getSupportedExtensions() || []).join(' '));
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch (e) { add('ERR', 'probe failed: ' + fmt(e)); }

  // Game hook: main.js calls this with the app once it exists.
  window.__diagApp = function (app) {
    try {
      add('INFO', 'tier ' + app.qName + ' | caps ' + JSON.stringify(app.caps));
      const r = app.renderer;
      const c = r && r.getContext && r.getContext();
      if (c) c.canvas.addEventListener('webglcontextlost', () => add('ERR', 'WebGL context LOST'));
    } catch (e) { add('ERR', 'diag hook: ' + fmt(e)); }
  };
  window.__diagNote = (t) => add('INFO', t);

  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();
