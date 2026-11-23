import './gpulock.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const SOFTWARE_RENDERER_RE = /llvmpipe|SwiftShader|Software/i;
const PROBE_TIMEOUT_MS = 30000;
const SELF_PATH = fileURLToPath(import.meta.url);

// WebGL2 extension profiles for reproducing mobile GPU / browser limits on desktop.
// iPhone Safari (WebKit + ANGLE/Metal on Apple A-series GPUs):
// - OES_texture_float_linear: absent on Apple mobile GPUs (32-bit float textures are not linearly filterable).
// - EXT_color_buffer_float: absent on older/many iOS WebGL2 setups (iOS exposes EXT_color_buffer_half_float instead).
// - EXT_float_blend: absent on Apple mobile GPUs (32-bit float blending is unsupported).
export const GL_PROFILES = {
  iphone: {
    // Passed to Chromium as well as enforced at WebGL2 opt-in (ANGLE Vulkan passthrough only
    // honors --disable-gl-extensions for some extensions like GL_EXT_float_blend, while WebGL2
    // extensions are strictly opt-in so withholding getExtension() keeps them genuinely disabled
    // inside ANGLE/GPU validation).
    disabledGlExtensions: [
      'GL_OES_texture_float_linear',
      'GL_EXT_color_buffer_float',
      'GL_EXT_float_blend',
    ],
    blockedWebglExtensions: [
      'OES_texture_float_linear',
      'EXT_color_buffer_float',
      'EXT_float_blend',
    ],
  },
};

export function resolveGlProfile(profileName = process.env.GL_PROFILE) {
  const key = String(profileName || '').trim().toLowerCase();
  if (!key || key === 'default' || key === 'desktop') return null;
  const profile = GL_PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown GL_PROFILE=${JSON.stringify(profileName)} (expected one of: ${Object.keys(GL_PROFILES).join(', ')})`);
  }
  return { name: key, ...profile };
}

export function getGlProfileArgs(profileName = process.env.GL_PROFILE) {
  const profile = resolveGlProfile(profileName);
  if (!profile || !profile.disabledGlExtensions.length) return [];
  return [`--disable-gl-extensions=${profile.disabledGlExtensions.join(',')}`];
}

export async function applyGlProfileToPage(page, profileName = process.env.GL_PROFILE) {
  const profile = typeof profileName === 'object' && profileName !== null
    ? profileName
    : resolveGlProfile(profileName);
  if (!profile || !profile.blockedWebglExtensions?.length) return;
  await page.evaluateOnNewDocument((blockedList) => {
    const blocked = new Set(blockedList);
    for (const Ctor of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
      if (!Ctor || !Ctor.prototype) continue;
      const origGetExt = Ctor.prototype.getExtension;
      const origGetSup = Ctor.prototype.getSupportedExtensions;
      if (typeof origGetExt === 'function') {
        Ctor.prototype.getExtension = function getExtension(name) {
          if (blocked.has(name)) return null;
          return origGetExt.call(this, name);
        };
      }
      if (typeof origGetSup === 'function') {
        Ctor.prototype.getSupportedExtensions = function getSupportedExtensions() {
          const list = origGetSup.call(this);
          return list ? list.filter((n) => !blocked.has(n)) : list;
        };
      }
    }
  }, profile.blockedWebglExtensions);
}

export function isSoftwareRenderer(renderer) {
  return SOFTWARE_RENDERER_RE.test(String(renderer || ''));
}

function failSoftwareOrProbe(message) {
  console.error(`${message} Set ALLOW_SOFTWARE=1 to run anyway.`);
  process.exit(1);
}

function assertHardwareRenderer(renderer) {
  if (process.env.ALLOW_SOFTWARE === '1') return;
  if (!renderer) {
    failSoftwareOrProbe('Failed to verify hardware WebGL2 renderer (empty renderer string).');
  }
  if (isSoftwareRenderer(renderer)) {
    failSoftwareOrProbe(`Refusing to run with software WebGL renderer (${renderer}).`);
  }
}

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/brave-browser',
      ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium binary not found; set CHROME_PATH');
}

function buildLaunchOpts(extraArgs = [], profileName = process.env.GL_PROFILE) {
  const profileArgs = getGlProfileArgs(profileName);
  const isWin = process.platform === 'win32';
  const baseArgs = isWin
    ? [
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--use-angle=d3d11',
        '--enable-webgl',
        '--disable-gpu-watchdog',
        '--disable-features=CalculateNativeWinOcclusion',
        '--autoplay-policy=no-user-gesture-required',
      ]
    : [
        '--no-sandbox',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        `--use-angle=${process.env.ANGLE || 'vulkan'}`,
        '--enable-features=Vulkan',
        '--enable-webgl',
        '--disable-gpu-watchdog',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--autoplay-policy=no-user-gesture-required',
      ];
  return {
    executablePath: findChrome(),
    headless: 'new',
    args: [...baseArgs, ...profileArgs, ...extraArgs],
    protocolTimeout: 600000,
  };
}

export async function probeBrowserRenderer(browser, timeoutMs = PROBE_TIMEOUT_MS) {
  let timer = null;
  const pagePromise = (async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<canvas id="c"></canvas>');
      return await page.evaluate(() => {
        const gl = document.getElementById('c').getContext('webgl2', {
          antialias: false,
          powerPreference: 'high-performance',
          stencil: false,
        });
        if (!gl) return { ok: false, renderer: '', error: 'WebGL2 context creation failed' };
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        // Without the debug extension the renderer string is masked (e.g. "WebKit WebGL"),
        // so a software renderer cannot be ruled out: treat it as a probe failure.
        if (!ext) return { ok: false, renderer: '', error: 'renderer identity masked (WEBGL_debug_renderer_info unavailable)' };
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
        if (!renderer) return { ok: false, renderer: '', error: 'Empty WebGL2 renderer string' };
        return { ok: true, renderer, error: null };
      });
    } finally {
      await page.close().catch(() => {});
    }
  })();

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`WebGL2 renderer probe timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([pagePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function probeRendererSync(extraArgs = []) {
  try {
    const out = execFileSync(process.execPath, [SELF_PATH], {
      env: {
        ...process.env,
        __STILLWATER_GPU_PROBE_SUBPROCESS: '1',
        __STILLWATER_GPU_PROBE_ARGS: JSON.stringify(extraArgs),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    const lastLine = out.split(/\r?\n/).filter(Boolean).pop() || '';
    const info = JSON.parse(lastLine);
    if (!info || !info.ok || !info.renderer) {
      failSoftwareOrProbe(`WebGL2 renderer probe failed (${info?.error || 'no renderer returned'}).`);
    }
    return info.renderer;
  } catch (err) {
    let detail = null;
    if (err?.killed || err?.code === 'ETIMEDOUT') {
      detail = `timed out after ${PROBE_TIMEOUT_MS}ms`;
    } else if (err?.stdout) {
      const lastOut = String(err.stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(lastOut);
        if (parsed?.error) detail = parsed.error;
      } catch {}
    }
    if (!detail) {
      detail = err?.stderr ? String(err.stderr).trim().split(/\r?\n/).pop() : err?.message || String(err);
    }
    failSoftwareOrProbe(`WebGL2 renderer probe failed (${detail}).`);
  }
}

export function launchOpts(extraArgs = [], opts = {}) {
  const caller = path.basename(process.argv[1] || '');
  const skipCheck =
    opts.skipSoftwareCheck ||
    process.env.ALLOW_SOFTWARE === '1' ||
    process.env.__STILLWATER_GPU_PROBE_SUBPROCESS === '1' ||
    caller === 'gpucheck.mjs';
  if (!skipCheck) {
    const renderer = probeRendererSync(extraArgs);
    assertHardwareRenderer(renderer);
  }
  return buildLaunchOpts(extraArgs);
}

export async function launchBrowser(extraArgs = [], opts = {}) {
  const profileName = opts.glProfile !== undefined ? opts.glProfile : process.env.GL_PROFILE;
  const profile = resolveGlProfile(profileName);
  const browser = await puppeteer.launch(buildLaunchOpts(extraArgs, profileName));
  let probe;
  try {
    probe = await probeBrowserRenderer(browser);
  } catch (err) {
    if (process.env.ALLOW_SOFTWARE !== '1') {
      await browser.close().catch(() => {});
      failSoftwareOrProbe(`WebGL2 renderer probe failed (${err?.message || String(err)}).`);
    }
    return { browser, renderer: `probe-failed: ${err?.message || String(err)}`, isSoftware: false };
  }

  const renderer = probe?.renderer || '';
  const isSoftware = isSoftwareRenderer(renderer);
  if (process.env.ALLOW_SOFTWARE !== '1') {
    if (!probe?.ok || !renderer) {
      await browser.close().catch(() => {});
      failSoftwareOrProbe(`WebGL2 renderer probe failed (${probe?.error || 'no renderer returned'}).`);
    }
    if (isSoftware) {
      await browser.close().catch(() => {});
      assertHardwareRenderer(renderer);
    }
  }
  if (profile) {
    const origNewPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await origNewPage(...args);
      await applyGlProfileToPage(page, profile);
      return page;
    };
  }
  return { browser, renderer: renderer || probe?.error || 'unknown', isSoftware, glProfile: profile?.name || null };
}

if (
  process.env.__STILLWATER_GPU_PROBE_SUBPROCESS === '1' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === SELF_PATH
) {
  let extraArgs = [];
  try {
    extraArgs = JSON.parse(process.env.__STILLWATER_GPU_PROBE_ARGS || '[]');
  } catch {}
  let browser = null;
  try {
    browser = await puppeteer.launch(buildLaunchOpts(extraArgs));
    const res = await probeBrowserRenderer(browser, PROBE_TIMEOUT_MS - 3000);
    process.stdout.write(JSON.stringify(res) + '\n');
    await browser.close();
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    process.stdout.write(JSON.stringify({ ok: false, renderer: '', error: err?.message || String(err) }) + '\n');
    process.exit(1);
  }
}
