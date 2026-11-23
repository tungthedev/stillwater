// Offline world baker: runs live GPU world generation on this machine's hardware GPU,
// encodes canonical heightmaps, masks, biome, paths, and post-edit placements into
// public/worlds/<regionId>/, and prints exact disk, gzip, and Brotli sizes.
//
// Usage:
//   node tools/bake-world.mjs [--encoding u16-delta2d-planar|u24-delta2d-planar|f32] [--far-encoding ...] [--out public/worlds]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { launchBrowser, isSoftwareRenderer } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    base: process.env.BASE || '',
    outRoot: path.join(ROOT, 'public', 'worlds'),
    heightNearEncoding: 'u22-delta2d-planar',
    heightFarEncoding: 'u14-delta2d-planar',
    gzipFiles: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--base') opts.base = next();
    else if (a === '--out') opts.outRoot = path.resolve(next());
    else if (a === '--encoding') {
      const enc = next();
      opts.heightNearEncoding = enc;
      opts.heightFarEncoding = enc;
    } else if (a === '--near-encoding') opts.heightNearEncoding = next();
    else if (a === '--far-encoding') opts.heightFarEncoding = next();
    else if (a === '--no-gzip') opts.gzipFiles = false;
  }
  return opts;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server starting
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

async function startDevServer() {
  const port = await getFreePort();
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const base = `http://127.0.0.1:${port}/`;
  const stop = async () => {
    if (child.exitCode !== null || child.killed) return;
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }
    }, 3000);
    await once(child, 'exit').catch(() => {});
    clearTimeout(timer);
  };
  try {
    await waitForHttp(base, 30000);
  } catch (err) {
    await stop();
    throw new Error(`${err.message}\n${stderr}`, { cause: err });
  }
  return { base, stop, pid: child.pid };
}

function startUploadReceiver() {
  const received = new Map();
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const name = path.basename(u.searchParams.get('name') || '');
    if (!name) {
      res.writeHead(400);
      res.end('missing name');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.set(name, Buffer.concat(chunks));
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

const opts = parseArgs(process.argv.slice(2));
let devServer = null;
let receiver = null;
let browser = null;

try {
  if (!opts.base) {
    devServer = await startDevServer();
    opts.base = devServer.base;
  }
  receiver = await startUploadReceiver();

  const launched = await launchBrowser();
  browser = launched.browser;
  const renderer = launched.renderer;
  console.log(`[bake] renderer: ${renderer}`);

  if (launched.isSoftware || isSoftwareRenderer(renderer)) {
    console.error(`[bake] Refusing to bake world on software renderer (${renderer}).`);
    process.exit(1);
  }

  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('console.error: ' + m.text());
  });

  const base = opts.base.replace(/\/?$/, '/');
  await page.goto(`${base}?bake=1&q=low`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__bakeReady || window.__error', { timeout: 300000, polling: 200 });

  const initErr = await page.evaluate(() => window.__error || null);
  if (initErr) throw new Error(`Bake page error: ${initErr}`);
  if (errs.length) throw new Error(`Bake console errors: ${errs.join('; ')}`);

  const meta = await page.evaluate(
    async ({ uploadUrl, heightNearEncoding, heightFarEncoding }) => {
      const ctx = window.__bakeContext;
      const { manifest, files } = ctx.encode({ heightNearEncoding, heightFarEncoding });
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
      const all = [['manifest.json', manifestBytes], ...Object.entries(files)];
      for (const [name, bytes] of all) {
        const res = await fetch(`${uploadUrl}/?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          body: bytes,
        });
        if (!res.ok) throw new Error(`Upload failed for ${name}: ${res.status}`);
      }
      return { regionId: ctx.regionId, manifest };
    },
    {
      uploadUrl: receiver.url,
      heightNearEncoding: opts.heightNearEncoding,
      heightFarEncoding: opts.heightFarEncoding,
    },
  );

  const outDir = path.join(opts.outRoot, meta.regionId);
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  let totDisk = 0, totGzip = 0, totBrotli = 0;

  for (const [name, rawBuf] of receiver.received.entries()) {
    const isBin = name.endsWith('.bin');
    const diskBuf = isBin && opts.gzipFiles ? zlib.gzipSync(rawBuf, { level: 9 }) : rawBuf;
    const filePath = path.join(outDir, name);
    fs.writeFileSync(filePath, diskBuf);
    const gz = isBin && opts.gzipFiles ? diskBuf.length : zlib.gzipSync(rawBuf, { level: 9 }).length;
    const br = isBin && opts.gzipFiles
      ? Math.min(diskBuf.length, zlib.brotliCompressSync(diskBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length)
      : zlib.brotliCompressSync(rawBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    totDisk += diskBuf.length;
    totGzip += gz;
    totBrotli += br;
    const fileMeta = Object.values(meta.manifest.files).find((e) => e.path === name);
    rows.push({
      file: name,
      encoding: fileMeta ? (opts.gzipFiles && isBin ? `${fileMeta.encoding}+gzip` : fileMeta.encoding) : 'json',
      diskBytes: diskBuf.length,
      gzipBytes: gz,
      brotliBytes: br,
    });
  }

  console.log(`[bake] region: ${meta.regionId} -> ${outDir}`);
  console.log(`[bake] worldHash: ${meta.manifest.worldHash}`);
  console.log(`[bake] counts: ${JSON.stringify(meta.manifest.counts)}`);
  console.log('');
  console.log('| File | Encoding | Disk | Gzip (-9) | Brotli (-11) |');
  console.log('| --- | --- | ---: | ---: | ---: |');
  for (const r of rows) {
    console.log(
      `| ${r.file} | ${r.encoding} | ${r.diskBytes.toLocaleString()} (${fmtMB(r.diskBytes)}) | ${r.gzipBytes.toLocaleString()} (${fmtMB(r.gzipBytes)}) | ${r.brotliBytes.toLocaleString()} (${fmtMB(r.brotliBytes)}) |`,
    );
  }
  console.log(
    `| **Total** | — | **${totDisk.toLocaleString()} (${fmtMB(totDisk)})** | **${totGzip.toLocaleString()} (${fmtMB(totGzip)})** | **${totBrotli.toLocaleString()} (${fmtMB(totBrotli)})** |`,
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (receiver) await receiver.close().catch(() => {});
  if (devServer) await devServer.stop().catch(() => {});
}
