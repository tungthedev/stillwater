// Opens BASE with ?diag in the iPhone profile and saves a screenshot of the overlay.
import { launchBrowser, applyGlProfileToPage } from './chrome.mjs';
const BASE = (process.env.BASE || 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const OUT = process.env.OUT || 'diag.png';
const { browser } = await launchBrowser([], { glProfile: 'iphone' });
try {
  const page = await browser.newPage();
  await applyGlProfileToPage(page, 'iphone');
  await page.emulate({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  });
  await page.goto(BASE + '?diag&q=low', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => document.body.innerText.includes('world ready'), { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: OUT });
  console.log(await page.evaluate(() => document.body.innerText.split('STILLWATER DIAG')[1]?.slice(0, 1500)));
} finally { await browser.close(); }
