import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const SOFTWARE_RENDERER_RE = /llvmpipe|SwiftShader|Software/i;

export function isSoftwareRenderer(renderer) {
  return SOFTWARE_RENDERER_RE.test(String(renderer || ''));
}

function assertHardwareRenderer(renderer) {
  if (process.env.ALLOW_SOFTWARE === '1') return;
  if (isSoftwareRenderer(renderer)) {
    console.error(
      `Refusing to run with software WebGL renderer (${renderer}). Set ALLOW_SOFTWARE=1 to run anyway.`,
    );
    process.exit(1);
  }
}

function probeRendererSync() {
  const gpucheckPath = fileURLToPath(new URL('./gpucheck.mjs', import.meta.url));
  try {
    const out = execFileSync(process.execPath, [gpucheckPath], {
      env: { ...process.env, __STILLWATER_GPU_PROBED: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    }).trim();
    const lastLine = out.split(/\r?\n/).filter(Boolean).pop() || '';
    const info = JSON.parse(lastLine);
    return typeof info === 'object' && info ? info.renderer || '' : String(info);
  } catch {
    return '';
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

export function launchOpts(extraArgs = [], opts = {}) {
  const caller = path.basename(process.argv[1] || '');
  const skipCheck =
    opts.skipSoftwareCheck ||
    process.env.ALLOW_SOFTWARE === '1' ||
    process.env.__STILLWATER_GPU_PROBED === '1' ||
    caller === 'gpucheck.mjs';
  if (!skipCheck) {
    const renderer = probeRendererSync();
    if (renderer) assertHardwareRenderer(renderer);
  }

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
    args: [...baseArgs, ...extraArgs],
    protocolTimeout: 600000,
  };
}

export async function probeBrowserRenderer(browser) {
  const page = await browser.newPage();
  try {
    await page.setContent('<canvas id="c"></canvas>');
    return await page.evaluate(() => {
      const gl = document.getElementById('c').getContext('webgl2');
      if (!gl) return 'no webgl2';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
    });
  } finally {
    await page.close();
  }
}

export async function launchBrowser(extraArgs = []) {
  const browser = await puppeteer.launch(launchOpts(extraArgs, { skipSoftwareCheck: true }));
  const renderer = await probeBrowserRenderer(browser);
  const isSoftware = isSoftwareRenderer(renderer);
  if (isSoftware && process.env.ALLOW_SOFTWARE !== '1') {
    await browser.close();
    assertHardwareRenderer(renderer);
  }
  return { browser, renderer, isSoftware };
}
