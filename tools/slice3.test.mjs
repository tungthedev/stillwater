import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  MANIFEST_FILENAME,
  SHOTS_CONFIG,
  buildCaptureManifest,
  buildShootEnv,
  comparePngBuffers,
  getPinnedCaptureEnv,
  masksFor,
  parseArgs,
  promoteStagedCapture,
  readCurrentRenderers,
  thresholdFor,
  validateCaptureManifest,
  validateImageDimensions,
  validateMaskRects,
  validateRendererMatch,
} from './diff.mjs';
import {
  classifyCaptureConsoleMessage,
  isOptional404,
  isSameOriginUrl,
  isTitleShotQuery,
  parseShootConfig,
  parseStrictInt,
} from './shoot.mjs';
import {
  classifySmokeConsoleMessage,
  measureWalkDistance,
  parseSmokeArgs,
} from './smoke.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  it('diff pins golden capture settings including FONT_TIMEOUT_MS even when shell env provides overrides', () => {
    const opts = parseArgs([], { CONCURRENCY: '4', SEED: '999', FAST_FRAMES: '9', W: '640', H: '480', FONT_TIMEOUT_MS: '50' });
    expect(opts.concurrency).toBe(SHOTS_CONFIG.concurrency ?? 1);

    const env = buildShootEnv(
      { PATH: '/usr/bin', SEED: '999', FAST_FRAMES: '9', W: '640', H: '480', CONCURRENCY: '4', FONT_TIMEOUT_MS: 'typo', Q: 'medium' },
      { base: 'http://127.0.0.1:4444/', tier: 'low', tierOut: '/tmp/out/low', concurrency: opts.concurrency },
    );
    expect(env.W).toBe(String(SHOTS_CONFIG.width));
    expect(env.H).toBe(String(SHOTS_CONFIG.height));
    expect(env.FAST_FRAMES).toBe(String(SHOTS_CONFIG.fastFrames));
    expect(env.SEED).toBe(String(SHOTS_CONFIG.seed ?? 1337));
    expect(env.CONCURRENCY).toBe(String(SHOTS_CONFIG.concurrency ?? 1));
    expect(env.FONT_TIMEOUT_MS).toBe(String(SHOTS_CONFIG.fontTimeoutMs ?? 15000));
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

    // Explicit optional resource 404 (/favicon.ico) is not fatal in either harness.
    const msg404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(classifyCaptureConsoleMessage('error', msg404, 'http://127.0.0.1:4173/favicon.ico', 'http://127.0.0.1:4173').fatal).toBe(false);
    expect(classifySmokeConsoleMessage('error', msg404, 'http://127.0.0.1:4173/favicon.ico', 'http://127.0.0.1:4173')).toBeNull();

    // Non-optional same-origin 404s (fonts, scripts, unknown location) MUST be fatal.
    for (const loc of [
      'http://127.0.0.1:4173/fonts/inter-latin.woff2',
      'http://127.0.0.1:4173/src/missing.js',
      '',
    ]) {
      expect(classifyCaptureConsoleMessage('error', msg404, loc, 'http://127.0.0.1:4173').fatal).toBe(true);
      expect(classifySmokeConsoleMessage('error', msg404, loc, 'http://127.0.0.1:4173')).toBeTruthy();
    }
  });

  it('compares parsed origins rather than string prefixes and restricts optional 404s', () => {
    expect(isSameOriginUrl('http://127.0.0.1:4173/src/main.js', 'http://127.0.0.1:4173')).toBe(true);
    expect(isSameOriginUrl('http://127.0.0.1:41730/src/main.js', 'http://127.0.0.1:4173')).toBe(false);
    expect(isSameOriginUrl('http://localhost.evil.test/a.js', 'http://localhost')).toBe(false);

    const errText = 'Uncaught Error: unrelated host error';
    expect(classifyCaptureConsoleMessage('error', errText, 'http://127.0.0.1:41730/app.js', 'http://127.0.0.1:4173').fatal).toBe(false);
    expect(classifySmokeConsoleMessage('error', errText, 'http://127.0.0.1:41730/app.js', 'http://127.0.0.1:4173')).toBeNull();

    const msg404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
    expect(isOptional404(msg404, 'http://127.0.0.1:4173/favicon.ico', 'http://127.0.0.1:4173')).toBe(true);
    expect(isOptional404(msg404, 'http://127.0.0.1:4173/fonts/inter-latin.woff2', 'http://127.0.0.1:4173')).toBe(false);
    expect(isOptional404(msg404, 'http://127.0.0.1:41730/favicon.ico', 'http://127.0.0.1:4173')).toBe(false);
  });

  it('detects title shot queries cleanly', () => {
    expect(isTitleShotQuery(SHOTS_CONFIG.shots.title)).toBe(true);
    expect(isTitleShotQuery(SHOTS_CONFIG.shots.meadow)).toBe(false);
  });
});

describe('smoke walking coordinate validation', () => {
  it('accepts finite x/z samples and rejects null, undefined, NaN, Infinity, or non-numeric coords', () => {
    const ok = measureWalkDistance({ x: 1, z: 2 }, { x: 4, z: 6 }, 'KeyW');
    expect(ok.ok).toBe(true);
    expect(ok.distance).toBeCloseTo(5, 6);

    const badCases = [
      [{ x: 10, z: 0 }, { x: null, z: 0 }],
      [{ x: null, z: 0 }, { x: 10, z: 0 }],
      [{ x: 0, z: 0 }, { x: 0, z: null }],
      [{ x: 0, z: 0 }, { x: undefined, z: 5 }],
      [{ x: 0, z: 0 }, { x: Number.NaN, z: 5 }],
      [{ x: 0, z: 0 }, { x: Number.POSITIVE_INFINITY, z: 0 }],
      [{ x: '0', z: 0 }, { x: 5, z: 0 }],
      [null, { x: 5, z: 0 }],
    ];
    for (const [from, to] of badCases) {
      const res = measureWalkDistance(from, to, 'KeyW');
      expect(res.ok).toBe(false);
      expect(res.distance).toBeNull();
      expect(res.error).toMatch(/non-finite|missing/);
    }
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

describe('staged capture manifest and --skip-shoot validation', () => {
  it('promotes staged captures without deleting unrelated files and validates hashes, selection, renderer, and pinned settings', () => {
    const outDir = makeTempDir();
    const stageDir = fs.mkdtempSync(path.join(outDir, '.stage-'));
    const renderer = 'ANGLE (Intel, Vulkan 1.4.318 (Intel(R) Graphics (RKL GT1) (0x00004C8B)), Intel open-source Mesa driver)';
    const pinned = getPinnedCaptureEnv(SHOTS_CONFIG);
    const keepFile = path.join(outDir, 'unrelated-keep.txt');
    fs.writeFileSync(keepFile, 'do not delete', 'utf8');

    fs.mkdirSync(path.join(stageDir, 'low'), { recursive: true });
    fs.writeFileSync(path.join(stageDir, 'low', 'meadow.png'), makeSolidPngBuffer(16, 9, 40, 80, 120));
    fs.writeFileSync(path.join(stageDir, 'low', 'renderer.txt'), renderer + '\n', 'utf8');

    // Before promotion, outDir has no manifest and --skip-shoot validation must fail.
    expect(() => validateCaptureManifest(outDir, {
      tiers: ['low'],
      shots: ['meadow'],
      goldenRenderers: { low: renderer },
      pinned,
      concurrency: pinned.concurrency,
    })).toThrow(/Missing capture manifest/);

    const manifest = buildCaptureManifest({
      renderer,
      tiers: ['low'],
      shots: ['meadow'],
      pinned,
      concurrency: pinned.concurrency,
      stageDir,
    });
    promoteStagedCapture(stageDir, outDir, manifest);

    // Stage dir was removed; unrelated file in outDir was preserved.
    expect(fs.existsSync(stageDir)).toBe(false);
    expect(fs.readFileSync(keepFile, 'utf8')).toBe('do not delete');
    expect(fs.existsSync(path.join(outDir, MANIFEST_FILENAME))).toBe(true);

    // Validated selection passes.
    const ok = validateCaptureManifest(outDir, {
      tiers: ['low'],
      shots: ['meadow'],
      goldenRenderers: { low: renderer },
      pinned,
      concurrency: pinned.concurrency,
    });
    expect(ok.renderer).toBe(renderer);

    // Missing shot or tier from selection fails.
    expect(() => validateCaptureManifest(outDir, {
      tiers: ['low'],
      shots: ['meadow', 'title'],
      goldenRenderers: { low: renderer },
      pinned,
      concurrency: pinned.concurrency,
    })).toThrow(/does not include requested shot title/);

    expect(() => validateCaptureManifest(outDir, {
      tiers: ['ultra', 'low'],
      shots: ['meadow'],
      goldenRenderers: { ultra: renderer, low: renderer },
      pinned,
      concurrency: pinned.concurrency,
    })).toThrow(/does not include requested tier ultra/);

    // Pinned setting mismatch fails.
    expect(() => validateCaptureManifest(outDir, {
      tiers: ['low'],
      shots: ['meadow'],
      goldenRenderers: { low: renderer },
      pinned: { ...pinned, fontTimeoutMs: pinned.fontTimeoutMs + 1 },
      concurrency: pinned.concurrency,
    })).toThrow(/pinned setting mismatch for fontTimeoutMs/);

    // Tampered PNG fails SHA-256 check.
    fs.writeFileSync(path.join(outDir, 'low', 'meadow.png'), makeSolidPngBuffer(16, 9, 41, 80, 120));
    expect(() => validateCaptureManifest(outDir, {
      tiers: ['low'],
      shots: ['meadow'],
      goldenRenderers: { low: renderer },
      pinned,
      concurrency: pinned.concurrency,
    })).toThrow(/SHA-256 mismatch/);
  });
});

describe('real committed golden PNG sensitivity and title mask behavior', () => {
  function applyRedTint(buf, x0, y0, w, h, factor) {
    const img = PNG.sync.read(buf);
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = Math.min(255, Math.round(img.data[i] * factor));
      }
    }
    return PNG.sync.write(img);
  }

  function applyHighContrastSquare(buf, x0, y0, size) {
    const img = PNG.sync.read(buf);
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = img.data[i] > 127 ? 0 : 255;
        img.data[i + 1] = img.data[i + 1] > 127 ? 0 : 255;
        img.data[i + 2] = img.data[i + 2] > 127 ? 0 : 255;
      }
    }
    return PNG.sync.write(img);
  }

  it('passes unchanged goldens and fails on a 3% red tint over 400x300 and a 12x12 high-contrast square on meadow', () => {
    const cutoff = SHOTS_CONFIG.diff.pixelmatchThreshold;
    for (const tier of ['ultra', 'low']) {
      const goldenBuf = fs.readFileSync(path.join(ROOT, 'captures', `golden-${tier}`, 'meadow.png'));
      const budget = thresholdFor(tier, 'meadow');

      const unchanged = comparePngBuffers(goldenBuf, goldenBuf, {
        expectedWidth: SHOTS_CONFIG.width,
        expectedHeight: SHOTS_CONFIG.height,
        pixelmatchThreshold: cutoff,
        masks: masksFor('meadow'),
        label: `${tier}/meadow-unchanged`,
      });
      expect(unchanged.mismatchPixels).toBe(0);
      expect(unchanged.mismatchPixels).toBeLessThanOrEqual(budget);

      const tintedBuf = applyRedTint(goldenBuf, 600, 300, 400, 300, 1.03);
      const tinted = comparePngBuffers(goldenBuf, tintedBuf, {
        expectedWidth: SHOTS_CONFIG.width,
        expectedHeight: SHOTS_CONFIG.height,
        pixelmatchThreshold: cutoff,
        masks: masksFor('meadow'),
        label: `${tier}/meadow-3pct-red`,
      });
      expect(tinted.mismatchPixels).toBeGreaterThan(budget);

      const squareBuf = applyHighContrastSquare(goldenBuf, 700, 400, 12);
      const squared = comparePngBuffers(goldenBuf, squareBuf, {
        expectedWidth: SHOTS_CONFIG.width,
        expectedHeight: SHOTS_CONFIG.height,
        pixelmatchThreshold: cutoff,
        masks: masksFor('meadow'),
        label: `${tier}/meadow-12x12`,
      });
      expect(squared.mismatchPixels).toBeGreaterThan(budget);
    }
  });

  it('masks only #title .begin on title, outlines the mask on diffPng, and fails a 12x12 square outside the mask', () => {
    const cutoff = SHOTS_CONFIG.diff.pixelmatchThreshold;
    const titleMasks = masksFor('title');
    expect(titleMasks.length).toBeGreaterThan(0);
    const [mask] = titleMasks;

    for (const tier of ['ultra', 'low']) {
      const goldenBuf = fs.readFileSync(path.join(ROOT, 'captures', `golden-${tier}`, 'title.png'));
      const budget = thresholdFor(tier, 'title');

      // Edit strictly inside the mask is excluded from the mismatch count, and the outline is drawn.
      const insideBuf = applyHighContrastSquare(goldenBuf, mask.x + 4, mask.y + 4, 8);
      const inside = comparePngBuffers(goldenBuf, insideBuf, {
        expectedWidth: SHOTS_CONFIG.width,
        expectedHeight: SHOTS_CONFIG.height,
        pixelmatchThreshold: cutoff,
        masks: titleMasks,
        label: `${tier}/title-inside-mask`,
      });
      expect(inside.mismatchPixels).toBe(0);
      const diffImg = PNG.sync.read(inside.diffPng);
      const borderIdx = (mask.y * diffImg.width + mask.x) * 4;
      expect([diffImg.data[borderIdx], diffImg.data[borderIdx + 1], diffImg.data[borderIdx + 2]]).toEqual([0, 229, 255]);

      // Same 12x12 high-contrast square outside the mask fails on title.
      const outsideBuf = applyHighContrastSquare(goldenBuf, 800, 200, 12);
      const outside = comparePngBuffers(goldenBuf, outsideBuf, {
        expectedWidth: SHOTS_CONFIG.width,
        expectedHeight: SHOTS_CONFIG.height,
        pixelmatchThreshold: cutoff,
        masks: titleMasks,
        label: `${tier}/title-outside-mask`,
      });
      expect(outside.mismatchPixels).toBeGreaterThan(budget);
    }

    expect(() => validateMaskRects([{ x: 1595, y: 0, width: 10, height: 10 }], 1600, 900, 'title')).toThrow(/out of bounds/);
  });
});
