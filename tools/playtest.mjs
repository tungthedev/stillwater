import fs from 'node:fs';
import { launchBrowser } from './chrome.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const { browser } = await launchBrowser();
const errs = [];
let p0 = null;
let p1 = null;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text().slice(0, 200));
  });
  await page.goto(`${BASE}?q=low`, { waitUntil: 'load' });
  await page.waitForFunction('window.__game || window.__error', { timeout: 300000, polling: 500 });
  const initErr = await page.evaluate(() => window.__error || null);
  if (initErr) {
    errs.push('init ' + String(initErr).slice(0, 200));
  } else {
    await new Promise((r) => setTimeout(r, 2000));
    await page.mouse.click(640, 360);
    await new Promise((r) => setTimeout(r, 4000));
    p0 = await page.evaluate(() => ({ x: __game.player.pos.x, z: __game.player.pos.z, enabled: __game.player.enabled }));
    await page.keyboard.press('KeyQ');
    await new Promise((r) => setTimeout(r, 6000));
    await page.keyboard.down('KeyW');
    await new Promise((r) => setTimeout(r, 1500));
    await page.keyboard.up('KeyW');
    p1 = await page.evaluate(() => ({
      x: __game.player.pos.x,
      z: __game.player.pos.z,
      dist: __game.player.distance,
      hours: __game.env.hours,
      audio: !!document.querySelector('canvas'),
    }));
    fs.mkdirSync('captures', { recursive: true });
    await page.screenshot({ path: 'captures/playtest.png' });
  }
  console.log(JSON.stringify({ p0, p1, errs: errs.slice(0, 10) }, null, 1));
} finally {
  await browser.close();
}

if (errs.length > 0) process.exit(1);
