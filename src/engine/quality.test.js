import { describe, expect, it } from 'vitest';
import { QUALITY, isMobileDevice, detectQuality, resolveRenderBaseSize, capScaleForPixels } from './quality.js';

describe('isMobileDevice and detectQuality', () => {
  it('detects iPhone, Android, iPad, and touch Apple GPU devices as mobile and picks low', () => {
    const iphoneEnv = {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      coarsePointer: true,
      gpuName: 'Apple GPU',
      screenMin: 393,
      stored: null,
    };
    expect(isMobileDevice(iphoneEnv)).toBe(true);
    expect(detectQuality(null, new URLSearchParams(), iphoneEnv)).toBe('low');

    // Even when a desktop host emulates an iPhone viewport + UA + touch on an RTX GPU, pick low.
    expect(detectQuality(null, new URLSearchParams(), { ...iphoneEnv, gpuName: 'NVIDIA GeForce RTX 3060' })).toBe('low');

    // iPadOS desktop-mode UA reports Macintosh with multi-touch.
    expect(detectQuality(null, new URLSearchParams(), {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
      maxTouchPoints: 5,
      coarsePointer: true,
      gpuName: 'Apple GPU',
      screenMin: 820,
      stored: null,
    })).toBe('low');

    // Android GPU name alone triggers mobile low.
    expect(detectQuality(null, new URLSearchParams(), {
      ua: 'Mozilla/5.0 (Linux; Android 14)',
      maxTouchPoints: 5,
      coarsePointer: true,
      gpuName: 'Adreno (TM) 740',
      screenMin: 412,
      stored: null,
    })).toBe('low');
  });

  it('keeps desktop GPU tier detection and honors explicit ?q= and stored overrides', () => {
    const desktopEnv = {
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      maxTouchPoints: 0,
      coarsePointer: false,
      screenMin: 1080,
      stored: null,
    };
    expect(isMobileDevice({ ...desktopEnv, gpuName: 'Apple M2 Pro' })).toBe(false);
    expect(detectQuality(null, new URLSearchParams(), { ...desktopEnv, gpuName: 'Apple M2 Pro' })).toBe('high');
    expect(detectQuality(null, new URLSearchParams(), { ...desktopEnv, gpuName: 'Intel(R) UHD Graphics 730' })).toBe('low');
    expect(detectQuality(null, new URLSearchParams(), { ...desktopEnv, gpuName: 'Apple GPU' })).toBe('medium');
    expect(detectQuality(null, new URLSearchParams('q=medium'), { ...desktopEnv, ua: 'iPhone', maxTouchPoints: 5 })).toBe('medium');
    expect(detectQuality(null, new URLSearchParams(), { ...desktopEnv, ua: 'iPhone', maxTouchPoints: 5, stored: 'high' })).toBe('high');
  });
});

describe('capScaleForPixels', () => {
  it('preserves scale when already inside budget and caps strictly at or under maxPixels when over', () => {
    expect(capScaleForPixels(1280, 720, 0.6, QUALITY.low.maxPixels)).toBe(0.6);
    expect(capScaleForPixels(1600, 900, 0.6, QUALITY.low.maxPixels)).toBe(0.6);
    expect(capScaleForPixels(852, 393, 0.6, QUALITY.low.maxPixels)).toBe(0.6);
    expect(capScaleForPixels(3840, 2160, 1.0, QUALITY.ultra.maxPixels)).toBe(1.0);

    // 4K or high-res viewport on low must stay strictly <= 0.9 MP.
    for (const [w, h, s] of [[2560, 1440, 0.6], [3840, 2160, 0.6], [1366, 1024, 1.0]]) {
      const capped = capScaleForPixels(w, h, s, QUALITY.low.maxPixels);
      const px = Math.round(w * capped) * Math.round(h * capped);
      expect(px).toBeLessThanOrEqual(QUALITY.low.maxPixels);
      expect(px).toBeGreaterThan(QUALITY.low.maxPixels * 0.95);
    }
  });
});

describe('resolveRenderBaseSize', () => {
  it('uses real device pixels on phones capped by tier maxPixels, while keeping desktop at pixelRatio 1', () => {
    // Desktop ignores DPR (unchanged behavior).
    expect(resolveRenderBaseSize(1280, 720, 2, false)).toEqual({ pixelRatio: 1, width: 1280, height: 720 });
    expect(resolveRenderBaseSize(1600, 900, 3, false)).toEqual({ pixelRatio: 1, width: 1600, height: 900 });

    // iPhone 390x844 CSS at DPR 3 = 1170x2532 (2.96 MP real).
    const base = resolveRenderBaseSize(390, 844, 3, true);
    expect(base).toEqual({ pixelRatio: 3, width: 1170, height: 2532 });

    // Low cap (0.9 MP) yields ~0.55 of DPR-3 resolution (~1.65x sharper than CSS 1x).
    const lowScale = capScaleForPixels(base.width, base.height, QUALITY.low.scale, QUALITY.low.maxPixels);
    expect(lowScale).toBeGreaterThan(0.54);
    expect(lowScale).toBeLessThan(0.56);
    const lowW = Math.round(base.width * lowScale);
    const lowH = Math.round(base.height * lowScale);
    expect(lowW * lowH).toBeLessThanOrEqual(QUALITY.low.maxPixels);
    expect(lowW / 390).toBeGreaterThan(1.6);

    // Medium cap (1.6 MP) yields ~0.735 of DPR-3 resolution.
    const medScale = capScaleForPixels(base.width, base.height, QUALITY.medium.scale, QUALITY.medium.maxPixels);
    const medW = Math.round(base.width * medScale);
    const medH = Math.round(base.height * medScale);
    expect(medW * medH).toBeLessThanOrEqual(QUALITY.medium.maxPixels);
    expect(medW * medH).toBeGreaterThan(1_550_000);
  });
});
