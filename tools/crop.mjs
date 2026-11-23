// crop a region of a PNG using a headless page canvas: node tools/crop.mjs in.png x y w h scale out.png
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { findChrome } from './chrome.mjs';

const [inp, x, y, w, h, sc, out] = process.argv.slice(2);
const data = fs.readFileSync(inp).toString('base64');
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', args: process.platform === 'win32' ? [] : ['--no-sandbox'] });
const page = await browser.newPage();
const url = await page.evaluate(async (d, x, y, w, h, sc) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
  const c = document.createElement('canvas'); c.width = w * sc; c.height = h * sc;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, w * sc, h * sc);
  return c.toDataURL('image/png');
}, data, +x, +y, +w, +h, +sc);
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
