// Headless screenshot harness. Usage: node tools/shoot.mjs [shotName ...]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5173/';
const OUT = process.env.OUT || 'captures';
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const Q = process.env.Q || 'ultra';

export const SHOTS = {
  title: 'title=1&time=16.2&frames=70',
  trailhead: 'trailf=0&time=15.8',
  meadow: 'trailf=0.12&time=16.0&yaw=0.5',
  lake: 'bench=0&time=16.4&pitch=-0.02',
  lakeLow: 'bench=0&time=18.9&pitch=0.02&byaw=0.6',
  forest: 'poi=forest&time=16.0&pitch=0.03',
  saddle: 'bench=1&time=17.6',
  summit: 'bench=2&time=17.3&pitch=-0.07',
  summitSunset: 'bench=2&time=18.9&pitch=-0.1',
  lakeSunset: 'bench=0&time=18.85&byaw=0.9&pitch=-0.02',
  summitWest: 'bench=2&time=18.75&byaw=2.75&pitch=0.06',
  summitWest: 'pos=-770,-790&yaw=1.12&time=18.75&pitch=-0.03',
  summitBack: 'trailf=0.985&time=19.1&yaw=3.1&pitch=-0.12',
  night: 'trailf=0.06&time=22.3&faceMoon=1&pitch=0.18',
  noon: 'trailf=0.3&time=12.5&yaw=0.8',
  dawn: 'trailf=0.2&time=5.35&yaw=1.8',
  hud: 'trailf=0.05&time=18.4&hud=1',
  cottage: 'poi=cottage&time=16.3&pitch=0.12&ang=0.5&dist=28',
  cottageDusk: 'poi=cottage&time=19.6&pitch=0.12&ang=0.5&dist=28',
  sheep: 'poi=sheep&time=16.4&pitch=-0.1',
  pasture: 'poi=horses&time=16.6&pitch=-0.04',
  stream: 'poi=stream&sf=0.3&time=16.2&pitch=-0.05',
  streamLow: 'poi=stream&sf=0.8&time=16.2&pitch=-0.12',
  falls: 'poi=fallsStream&time=16.3&dn=18&side=5',
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-webgl', '--disable-gpu-watchdog', '--disable-features=CalculateNativeWinOcclusion', '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 600000,
});
const results = {};
for (const name of names) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`.slice(0, 400)); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  const url = `${BASE}?capture&q=${Q}&${SHOTS[name] || name}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  try {
    await page.waitForFunction('window.__shotReady || window.__error', { timeout: 300000, polling: 500 });
  } catch (e) { logs.push('timeout waiting for shot'); }
  const err = await page.evaluate(() => window.__error);
  const info = await page.evaluate(() => window.__info);
  await new Promise((r) => setTimeout(r, 300));
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  results[name] = { file, ms: Date.now() - t0, err, info, logs: [...new Set(logs)].slice(0, 12) };
  console.log(JSON.stringify({ name, ...results[name] }));
  await page.close();
}
await browser.close();
