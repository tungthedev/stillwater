import fs from 'node:fs';
import os from 'node:os';

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

export function launchOpts(extraArgs = []) {
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
