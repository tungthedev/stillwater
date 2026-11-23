import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { probeCaps, getCaps, clampMsaaSamples } from './caps.js';

function makeMockGl({
  extensions = [],
  completeFormats = new Set(),
  readHalfOk = true,
  readFloatOk = true,
  msaaFormats = new Set(),
  depthFormats = new Set([0x8cac, 0x81a6, 0x81a5]),
  maxSamples = 4,
  maxTextureSize = 16384,
} = {}) {
  const extSet = new Set(extensions);
  let lastError = 0;
  let boundTexFormat = 0;
  let boundRbFormat = 0;
  let attachedColorFormat = 0;
  let attachedDepthFormat = 0;
  let attachedRbFormat = 0;

  const gl = {
    NO_ERROR: 0,
    INVALID_ENUM: 0x0500,
    INVALID_OPERATION: 0x0502,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    NEAREST: 0x2600,
    FRAMEBUFFER: 0x8d40,
    RENDERBUFFER: 0x8d41,
    FRAMEBUFFER_BINDING: 0x8ca6,
    RENDERBUFFER_BINDING: 0x8ca7,
    TEXTURE_BINDING_2D: 0x8069,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8cd6,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    RGBA16F: 0x881a,
    RGBA32F: 0x8814,
    FLOAT: 0x1406,
    HALF_FLOAT: 0x140b,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    DEPTH_COMPONENT: 0x1902,
    DEPTH_COMPONENT32F: 0x8cac,
    DEPTH_COMPONENT24: 0x81a6,
    DEPTH_COMPONENT16: 0x81a5,
    MAX_SAMPLES: 0x8d57,
    MAX_TEXTURE_SIZE: 0x0d33,

    getExtension(name) {
      return extSet.has(name) ? {} : null;
    },
    getError() {
      const e = lastError;
      lastError = 0;
      return e;
    },
    getParameter(p) {
      if (p === gl.MAX_SAMPLES) return maxSamples;
      if (p === gl.MAX_TEXTURE_SIZE) return maxTextureSize;
      return null;
    },
    createFramebuffer: () => ({}),
    deleteFramebuffer: () => {},
    bindFramebuffer: () => {},
    createTexture: () => ({}),
    deleteTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D(_t, _l, internalFormat) {
      boundTexFormat = internalFormat;
    },
    framebufferTexture2D(_t, attachment) {
      if (attachment === gl.COLOR_ATTACHMENT0) {
        attachedColorFormat = boundTexFormat;
        attachedRbFormat = 0;
      } else if (attachment === gl.DEPTH_ATTACHMENT) {
        attachedDepthFormat = boundTexFormat;
      }
    },
    createRenderbuffer: () => ({}),
    deleteRenderbuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorageMultisample(_t, _s, internalFormat) {
      boundRbFormat = internalFormat;
      if (!msaaFormats.has(internalFormat)) lastError = gl.INVALID_OPERATION;
    },
    framebufferRenderbuffer() {
      attachedRbFormat = boundRbFormat;
      attachedColorFormat = 0;
      attachedDepthFormat = 0;
    },
    checkFramebufferStatus() {
      if (attachedRbFormat) {
        return msaaFormats.has(attachedRbFormat)
          ? gl.FRAMEBUFFER_COMPLETE
          : gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      }
      if (attachedDepthFormat) {
        return depthFormats.has(attachedDepthFormat)
          ? gl.FRAMEBUFFER_COMPLETE
          : gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      }
      return completeFormats.has(attachedColorFormat)
        ? gl.FRAMEBUFFER_COMPLETE
        : gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    },
    readPixels(_x, _y, _w, _h, _fmt, type) {
      if (type === gl.HALF_FLOAT && !readHalfOk) lastError = gl.INVALID_OPERATION;
      if (type === gl.FLOAT && !readFloatOk) lastError = gl.INVALID_OPERATION;
    },
  };
  return gl;
}

describe('probeCaps', () => {
  it('keeps FloatType linear height & LUT + 4x MSAA on desktop GPUs with full extensions', () => {
    const gl = makeMockGl({
      extensions: ['OES_texture_float_linear', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend'],
      completeFormats: new Set([0x8814, 0x881a]),
      msaaFormats: new Set([0x881a, 0x8058]),
      maxSamples: 4,
    });
    const caps = probeCaps(/** @type {any} */ (gl));
    expect(caps.floatLinear).toBe(true);
    expect(caps.floatRenderable).toBe(true);
    expect(caps.halfFloatRenderable).toBe(true);
    expect(caps.floatTexFilter).toBe(THREE.LinearFilter);
    expect(caps.needsManualFloatFilter).toBe(false);
    expect(caps.floatFilterableTargetType).toBe(THREE.FloatType);
    expect(caps.floatFilterableTargetEncodeScale).toBe(1);
    expect(caps.floatFilterableTargetReadMode).toBe('float');
    expect(caps.hdrTargetType).toBe(THREE.HalfFloatType);
    expect(caps.hdrMaxSamples).toBe(4);
    expect(caps.depthTextureType).toBe(THREE.FloatType);
    expect(clampMsaaSamples(4, caps)).toBe(4);
  });

  it('falls back cleanly for iPhone profile (no OES_texture_float_linear, no EXT_color_buffer_float, has EXT_color_buffer_half_float)', () => {
    const gl = makeMockGl({
      extensions: ['EXT_color_buffer_half_float'],
      completeFormats: new Set([0x881a]),
      readHalfOk: false,
      readFloatOk: true,
      msaaFormats: new Set([0x8058]),
      maxSamples: 4,
    });
    const caps = probeCaps(/** @type {any} */ (gl));
    expect(caps.floatLinear).toBe(false);
    expect(caps.floatRenderable).toBe(false);
    expect(caps.halfFloatRenderable).toBe(true);
    expect(caps.floatTexFilter).toBe(THREE.NearestFilter);
    expect(caps.needsManualFloatFilter).toBe(true);
    expect(caps.floatFilterableTargetType).toBe(THREE.HalfFloatType);
    expect(caps.floatFilterableTargetEncodeScale).toBe(1);
    expect(caps.floatFilterableTargetReadMode).toBe('float-from-half');
    expect(caps.hdrTargetType).toBe(THREE.HalfFloatType);
    expect(caps.hdrMaxSamples).toBe(0);
    expect(clampMsaaSamples(4, caps)).toBe(0);
  });

  it('falls back to 8-bit targets when neither float nor half-float is color-renderable', () => {
    const gl = makeMockGl({
      extensions: [],
      completeFormats: new Set(),
      msaaFormats: new Set([0x8058]),
      depthFormats: new Set([0x81a6]),
      maxSamples: 4,
    });
    const caps = probeCaps(/** @type {any} */ (gl));
    expect(caps.floatRenderable).toBe(false);
    expect(caps.halfFloatRenderable).toBe(false);
    expect(caps.floatFilterableTargetType).toBe(THREE.UnsignedByteType);
    expect(caps.floatFilterableTargetEncodeScale).toBe(8);
    expect(caps.floatFilterableTargetReadMode).toBe('ubyte');
    expect(caps.hdrTargetType).toBe(THREE.UnsignedByteType);
    expect(caps.hdrMaxSamples).toBe(4);
    expect(caps.depthTextureType).toBe(THREE.UnsignedIntType);
  });

  it('caches per renderer via getCaps', () => {
    let calls = 0;
    const gl = makeMockGl({ extensions: ['EXT_color_buffer_half_float'], completeFormats: new Set([0x881a]) });
    const renderer = /** @type {any} */ ({ getContext: () => { calls++; return gl; } });
    const a = getCaps(renderer);
    const b = getCaps(renderer);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});
