import puppeteer from 'puppeteer-core';
const url = process.argv[2];
const expr = process.argv[3];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--enable-gpu','--ignore-gpu-blocklist','--use-angle=d3d11','--disable-gpu-watchdog'], protocolTimeout: 600000 });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url()));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__shotReady || window.__error', { timeout: 300000, polling: 500 }).catch(()=>console.log('timeout'));
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
