// Captures a full review set every hour into captures/hourly/<timestamp>/ and
// rebuilds captures/hourly/index.html (a contact sheet of every run).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'captures/hourly';
const SHOTS = ['title', 'trailhead', 'meadow', 'lake', 'forest', 'saddle', 'summit', 'night', 'noon', 'dawn'];
const INTERVAL = +(process.env.INTERVAL_MIN || 60) * 60 * 1000;

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
};

function run(out) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/shoot.mjs', ...SHOTS], { env: { ...process.env, OUT: out }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('close', () => { fs.writeFileSync(path.join(out, 'log.txt'), log); resolve(); });
  });
}

function index() {
  const runs = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()).sort().reverse();
  const html = `<!doctype html><meta charset="utf-8"><title>Stillwater hourly</title>
<style>body{background:#111;color:#ddd;font:14px system-ui;margin:24px}h2{margin:32px 0 8px;font-weight:500}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px}figure{margin:0}img{width:100%;border-radius:4px;display:block}
figcaption{font-size:12px;color:#999;margin-top:3px}</style><h1>Stillwater — hourly captures</h1>
${runs.map((r) => `<h2>${r}</h2><div class="g">${SHOTS.filter((s) => fs.existsSync(path.join(ROOT, r, s + '.png'))).map((s) => `<figure><a href="${r}/${s}.png"><img loading="lazy" src="${r}/${s}.png"></a><figcaption>${s}</figcaption></figure>`).join('')}</div>`).join('')}`;
  fs.writeFileSync(path.join(ROOT, 'index.html'), html);
}

fs.mkdirSync(ROOT, { recursive: true });
while (true) {
  const out = path.join(ROOT, stamp());
  fs.mkdirSync(out, { recursive: true });
  await run(out);
  index();
  console.log('captured', out);
  await new Promise((r) => setTimeout(r, INTERVAL));
}
