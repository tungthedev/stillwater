// Imported first by tools/chrome.mjs, so every tool that launches Chrome passes through it.
// Why: the reference machine's single iGPU is shared by many agents and worktrees; two
// headless browsers at once make frame timings meaningless. `gpu-run` serialises GPU use with
// one machine-wide lock. If it is installed and we are not already inside it, re-run this exact
// command under it and exit with its code. Without gpu-run (CI, other machines) do nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findGpuRun() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, 'gpu-run'))) return path.join(dir, 'gpu-run');
  }
  const fallback = path.join(os.homedir(), '.local', 'bin', 'gpu-run');
  return isExecutable(fallback) ? fallback : null;
}

if (process.env.GPU_RUN_HELD !== '1' && process.platform !== 'win32') {
  const gpuRun = findGpuRun();
  if (gpuRun) {
    const r = spawnSync(gpuRun, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
    });
    process.exit(r.status ?? 1);
  }
}
