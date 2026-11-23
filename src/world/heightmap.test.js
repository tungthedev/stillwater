import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createNearHeightTexture, createFarHeightTexture } from './heightmap.js';

const fromHalf = THREE.DataUtils.fromHalfFloat;

describe('half-float height split (no OES_texture_float_linear)', () => {
  it('stores heights to within half a millimetre and keeps desktop float storage unchanged', () => {
    const res = 64;
    const heights = new Float32Array(res * res);
    const mask = new Float32Array(res * res);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = -40 + ((i * 7919) % 100003) / 100003 * 1100;
      mask[i] = ((i % 13) - 6) / 6;
    }
    const near = createNearHeightTexture(heights, mask, res, { floatLinear: false });
    expect(near.type).toBe(THREE.HalfFloatType);
    let worst = 0;
    for (let i = 0; i < heights.length; i++) {
      const d = near.image.data;
      worst = Math.max(worst, Math.abs(fromHalf(d[i * 4]) + fromHalf(d[i * 4 + 1]) - heights[i]));
      expect(Math.abs(fromHalf(d[i * 4 + 2]) - mask[i])).toBeLessThan(0.001);
    }
    expect(worst).toBeLessThan(0.0005);

    const far = createFarHeightTexture(heights, res, { floatLinear: false });
    expect(far.format).toBe(THREE.RGFormat);
    expect(createFarHeightTexture(heights, res, { floatLinear: true }).type).toBe(THREE.FloatType);
    expect(createNearHeightTexture(heights, mask, res, { floatLinear: true }).image.data[0]).toBe(heights[0]);
  });

  it('keeps sub-millimetre precision on far mountains above 2048 m and refuses heights it cannot hold', () => {
    const src = new Float32Array([2556.1824, -3.25, 0.0004, 4095.9]);
    const far = createFarHeightTexture(src, 2, { floatLinear: false }).image.data;
    src.forEach((h, i) => expect(Math.abs(fromHalf(far[i * 2]) + fromHalf(far[i * 2 + 1]) - h)).toBeLessThan(0.0005));
    expect(() => createFarHeightTexture(new Float32Array([9000]), 1, { floatLinear: false })).toThrow(/split range/);
  });
});
