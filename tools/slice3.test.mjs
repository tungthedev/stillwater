import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  SHOTS_CONFIG,
  buildShootEnv,
  comparePngBuffers,
  parseArgs,
  readCurrentRenderers,
  validateImageDimensions,
  validateRendererMatch,
} from './diff.mjs';
import {
  classifyCaptureConsoleMessage,
  isTitleShotQuery,
  parseShootConfig,
  parseStrictInt,
} from './shoot.mjs';
import {
  classifySmokeConsoleMessage,
  parseSmokeArgs,
} from './smoke.mjs';

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stillwater-slice3-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeSolidPngBuffer(width, height, r, g, b, a = 255) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('numeric and CLI argument validation', () => {
  it('parseStrictInt accepts valid integers and rejects typos, empty, floats, and out-of-range values', () => {
    expect(parseStrictInt('1', 'CONCURRENCY', { min: 1 })).toBe(1);
    expect(parseStrictInt('4', 'CONCURRENCY', { min: 1 })).toBe(4);
    expect(parseStrictInt('0', 'SEED', { min: 0 })).toBe(0);
    expect(parseStrictInt(undefined, 'CONCURRENCY', { min: 1, fallback: 2 })).toBe(2);

    for (const bad of ['typo', '', '   ', '0', '-1', '1.5', '2abc', 'NaN', 'Infinity']) {
      expect(() => parseStrictInt(bad, 'CONCURRENCY', { min: 1 })).toThrow(/Invalid CONCURRENCY/);
    }
  });

  it('parseShootConfig rejects invalid numeric env vars and empty shot lists', () => {
    expect(() => parseShootConfig([], { CONCURRENCY: 'typo' })).toThrow(/Invalid CONCURRENCY/);
    expect(() => parseShootConfig([], { CONCURRENCY: '0' })).toThrow(/Invalid CONCURRENCY/);
    expect(() => parseShootConfig([], { W: 'abc' })).toThrow(/Invalid W/);
    expect(() => parseShootConfig([], { H: '0' })).toThrow(/Invalid H/);
    expect(() => parseShootConfig([], { FAST_FRAMES: '-2' })).toThrow(/Invalid FAST_FRAMES/);
    expect(() => parseShootConfig([], { SEED: 'nope' })).toThrow(/Invalid SEED/);
    expect(() => parseShootConfig(['   '], {})).toThrow(/No shots selected/);

    const ok = parseShootConfig(['title', 'meadow'], { W: '1600', H: '900', CONCURRENCY: '2', SEED: '1337', FAST_FRAMES: '2' });
    expect(ok.names).toEqual(['title', 'meadow']);
    expect(ok.concurrency).toBe(2);
    expect(ok.seed).toBe(1337);
  });

  it('diff parseArgs rejects invalid CONCURRENCY, empty --tiers, empty --shots, and unknown args', () => {
    expect(() => parseArgs([], { CONCURRENCY: 'typo' })).toThrow(/Invalid CONCURRENCY/);
    expect(() => parseArgs([], { CONCURRENCY: '0' })).toThrow(/Invalid CONCURRENCY/);
    expect(() => parseArgs(['--concurrency', 'typo'], {})).toThrow(/Invalid --concurrency/);
    expect(() => parseArgs(['--concurrency', '0'], {})).toThrow(/Invalid --concurrency/);
    expect(() => parseArgs(['--tiers', ''], {})).toThrow(/at least one tier/);
    expect(() => parseArgs(['--tiers', ' , '], {})).toThrow(/at least one tier/);
    expect(() => parseArgs(['--shots', ''], {})).toThrow(/at least one shot/);
    expect(() => parseArgs(['--shots', ','], {})).toThrow(/at least one shot/);
    expect(() => parseArgs(['--tiers'], {})).toThrow(/Missing value/);
    expect(() => parseArgs(['--unknown-flag'], {})).toThrow(/Unknown argument/);
  });

  it('diff pins golden capture settings even when shell env provides overrides', () => {
    const opts = parseArgs([], { CONCURRENCY: '4', SEED: '999', FAST_FRAMES: '9', W: '640', H: '480' });
    expect(opts.concurrency).toBe(SHOTS_CONFIG.concurrency ?? 1);

    const env = buildShootEnv(
      { PATH: '/usr/bin', SEED: '999', FAST_FRAMES: '9', W: '640', H: '480', CONCURRENCY: '4', Q: 'medium' },
      { base: 'http://127.0.0.1:4444/', tier: 'low', tierOut: '/tmp/out/low', concurrency: opts.concurrency },
    );
    expect(env.W).toBe(String(SHOTS_CONFIG.width));
    expect(env.H).toBe(String(SHOTS_CONFIG.height));
    expect(env.FAST_FRAMES).toBe(String(SHOTS_CONFIG.fastFrames));
    expect(env.SEED).toBe(String(SHOTS_CONFIG.seed ?? 1337));
    expect(env.CONCURRENCY).toBe(String(SHOTS_CONFIG.concurrency ?? 1));
    expect(env.Q).toBe('low');
    expect(env.WRITE_RENDERER).toBe('1');
  });

  it('smoke parseSmokeArgs ignores BASE when --dist is passed, and honors BASE otherwise', () => {
    const distOpts = parseSmokeArgs(['--dist'], { BASE: 'http://127.0.0.1:9999/' });
    expect(distOpts.forceDist).toBe(true);
    expect(distOpts.base).toBe('');
    expect(distOpts.ignoredBase).toBe('http://127.0.0.1:9999/');

    const standaloneOpts = parseSmokeArgs([], { BASE: 'http://127.0.0.1:9999/' });
    expect(standaloneOpts.forceDist).toBe(false);
    expect(standaloneOpts.base).toBe('http://127.0.0.1:9999/');

    expect(() => parseSmokeArgs(['--browser'], {})).toThrow(/--browser requires a URL/);
    expect(() => parseSmokeArgs(['--nope'], {})).toThrow(/Unknown argument/);
  });
});

describe('console warning and error classification', () => {
  it('treats Puppeteer warn messages for shaders, WebGL INVALID_*, and token missing as fatal', () => {
    const cases = [
      ['warn', 'THREE.WebGLProgram: Shader Error 0 - VALIDATE_STATUS false'],
      ['warn', 'WebGL: INVALID_OPERATION: useProgram: program not valid'],
      ['warn', 'GL_INVALID_VALUE in glTexImage2D'],
      ['warn', 'patch: vertex token missing #include <bogus>'],
      ['warning', 'WebGL: INVALID_FRAMEBUFFER_OPERATION'],
      ['error', 'THREE.WebGLProgram: Shader Error 1282'],
    ];
    for (const [type, text] of cases) {
      expect(classifyCaptureConsoleMessage(type, text, 'http://127.0.0.1:4173/src/main.js', 'http://127.0.0.1:4173').fatal).toBe(true);
      expect(classifySmokeConsoleMessage(type, text, 'http://127.0.0.1:4173/src/main.js', 'http://127.0.0.1:4173')).toBeTruthy();
    }

    // Benign 404 is not fatal in either harness.
    const benign = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(classifyCaptureConsoleMessage('error', benign, 'http://127.0.0.1:4173/favicon.ico', 'http://127.0.0.1:4173').fatal).toBe(false);
    expect(classifySmokeConsoleMessage('error', benign, 'http://127.0.0.1:4173/favicon.ico', 'http://127.0.0.1:4173')).toBeNull();
  });

  it('detects title shot queries cleanly', () => {
    expect(isTitleShotQuery(SHOTS_CONFIG.shots.title)).toBe(true);
    expect(isTitleShotQuery(SHOTS_CONFIG.shots.meadow)).toBe(false);
  });
});

describe('image dimension checks and gray-shift sensitivity on real PNG files', () => {
  it('rejects non-pinned image dimensions (including 1x1 current or 1x1 golden+current)', () => {
    const dir = makeTempDir();
    const fullPath = path.join(dir, 'full.png');
    const tinyPath = path.join(dir, 'tiny.png');
    fs.writeFileSync(fullPath, makeSolidPngBuffer(1600, 900, 128, 128, 128));
    fs.writeFileSync(tinyPath, makeSolidPngBuffer(1, 1, 128, 128, 128));

    const fullBuf = fs.readFileSync(fullPath);
    const tinyBuf = fs.readFileSync(tinyPath);

    expect(() => validateImageDimensions('tiny', PNG.sync.read(tinyBuf), 1600, 900)).toThrow(/1x1 \(expected 1600x900\)/);
    expect(() => comparePngBuffers(fullBuf, tinyBuf, {
      expectedWidth: 1600,
      expectedHeight: 900,
      pixelmatchThreshold: SHOTS_CONFIG.diff.pixelmatchThreshold,
      label: 'ultra/title',
    })).toThrow(/current ultra\/title: 1x1 \(expected 1600x900\)/);

    expect(() => comparePngBuffers(tinyBuf, tinyBuf, {
      expectedWidth: 1600,
      expectedHeight: 900,
      pixelmatchThreshold: SHOTS_CONFIG.diff.pixelmatchThreshold,
      label: 'ultra/title',
    })).toThrow(/golden ultra\/title: 1x1 \(expected 1600x900\)/);
  });

  it('catches uniform 128->152 and 128->136 gray shifts at the configured pixelmatch cutoff', () => {
    const dir = makeTempDir();
    const w = 64;
    const h = 36;
    const basePath = path.join(dir, 'gray128.png');
    const shift24Path = path.join(dir, 'gray152.png');
    const shift8Path = path.join(dir, 'gray136.png');

    fs.writeFileSync(basePath, makeSolidPngBuffer(w, h, 128, 128, 128));
    fs.writeFileSync(shift24Path, makeSolidPngBuffer(w, h, 152, 152, 152));
    fs.writeFileSync(shift8Path, makeSolidPngBuffer(w, h, 136, 136, 136));

    const baseBuf = fs.readFileSync(basePath);
    const shift24Buf = fs.readFileSync(shift24Path);
    const shift8Buf = fs.readFileSync(shift8Path);
    const cutoff = SHOTS_CONFIG.diff.pixelmatchThreshold;

    // Sanity: the old 0.1 cutoff missed a uniform 128->152 shift completely.
    const oldResult = comparePngBuffers(baseBuf, shift24Buf, {
      expectedWidth: w,
      expectedHeight: h,
      pixelmatchThreshold: 0.1,
      label: 'synthetic/old-cutoff',
    });
    expect(oldResult.mismatchPixels).toBe(0);

    // Configured cutoff must catch every pixel of both 128->152 and 128->136 shifts.
    const res152 = comparePngBuffers(baseBuf, shift24Buf, {
      expectedWidth: w,
      expectedHeight: h,
      pixelmatchThreshold: cutoff,
      label: 'synthetic/128-to-152',
    });
    expect(res152.mismatchPixels).toBe(w * h);

    const res136 = comparePngBuffers(baseBuf, shift8Buf, {
      expectedWidth: w,
      expectedHeight: h,
      pixelmatchThreshold: cutoff,
      label: 'synthetic/128-to-136',
    });
    expect(res136.mismatchPixels).toBe(w * h);

    const resIdentical = comparePngBuffers(baseBuf, baseBuf, {
      expectedWidth: w,
      expectedHeight: h,
      pixelmatchThreshold: cutoff,
      label: 'synthetic/identical',
    });
    expect(resIdentical.mismatchPixels).toBe(0);
  });
});

describe('renderer metadata verification', () => {
  it('reads renderer.txt from capture directories and rejects missing, conflicting, or mismatched renderers', () => {
    const dir = makeTempDir();
    const rendererA = 'ANGLE (Intel, Vulkan 1.4.318 (Intel(R) Graphics (RKL GT1) (0x00004C8B)), Intel open-source Mesa driver)';
    const rendererB = 'ANGLE (NVIDIA, Vulkan 1.3 (RTX 3060))';

    // Missing renderer.txt fails (e.g. --skip-shoot without metadata).
    const missing = readCurrentRenderers(dir, ['ultra', 'low']);
    expect(() => validateRendererMatch({
      tiers: ['ultra', 'low'],
      goldenRenderers: { ultra: rendererA, low: rendererA },
      currentRenderers: missing,
    })).toThrow(/Missing or empty current capture renderer/);

    // Matching top-level renderer.txt passes.
    fs.writeFileSync(path.join(dir, 'renderer.txt'), rendererA + '\n', 'utf8');
    const matched = readCurrentRenderers(dir, ['ultra', 'low']);
    expect(validateRendererMatch({
      tiers: ['ultra', 'low'],
      goldenRenderers: { ultra: rendererA, low: rendererA },
      currentRenderers: matched,
    })).toBe(rendererA);

    // Mismatched renderer fails with RENDERER_MISMATCH.
    let mismatchErr = null;
    try {
      validateRendererMatch({
        tiers: ['ultra', 'low'],
        goldenRenderers: { ultra: rendererA, low: rendererA },
        currentRenderers: { ultra: rendererB, low: rendererB },
      });
    } catch (e) {
      mismatchErr = e;
    }
    expect(mismatchErr).toBeTruthy();
    expect(mismatchErr.code).toBe('RENDERER_MISMATCH');

    // Conflicting per-tier renderer.txt fails when read.
    fs.mkdirSync(path.join(dir, 'low'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'low', 'renderer.txt'), rendererB + '\n', 'utf8');
    expect(() => readCurrentRenderers(dir, ['ultra', 'low'])).toThrow(/Conflicting renderer metadata/);
  });
});
