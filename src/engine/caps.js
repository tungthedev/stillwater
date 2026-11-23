import * as THREE from 'three';

// WebGL2 texture, filtering, and render-target capability probe.
// Runs once per renderer and supplies one format policy for float/half-float
// textures, HDR targets, MSAA sample counts, and depth textures.

const _capsCache = new WeakMap();

/**
 * Drain any pending WebGL error flags before/after a capability probe so
 * probe failures never leak into application error checks.
 * @param {WebGL2RenderingContext} gl
 */
function clearGlErrors(gl) {
  if (typeof gl.getError !== 'function') return;
  for (let i = 0; i < 8; i++) {
    if (gl.getError() === gl.NO_ERROR) break;
  }
}

/**
 * Probe whether a 2D texture format is color-renderable via a tiny scratch FBO,
 * and optionally test readPixels compatibility on that attachment.
 * @param {WebGL2RenderingContext} gl
 * @param {number} internalFormat
 * @param {number} format
 * @param {number} type
 */
function probeColorTarget(gl, internalFormat, format, type) {
  const result = { renderable: false, readAsType: false, readAsFloat: false };
  if (
    typeof gl.createFramebuffer !== 'function' ||
    typeof gl.createTexture !== 'function' ||
    typeof gl.checkFramebufferStatus !== 'function'
  ) {
    return result;
  }
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  try {
    clearGlErrors(gl);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    if (gl.getError() !== gl.NO_ERROR) return result;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (gl.getError() !== gl.NO_ERROR || status !== gl.FRAMEBUFFER_COMPLETE) return result;
    result.renderable = true;

    if (typeof gl.readPixels === 'function') {
      const readBuf = type === gl.FLOAT
        ? new Float32Array(4)
        : type === gl.HALF_FLOAT
          ? new Uint16Array(4)
          : new Uint8Array(4);
      clearGlErrors(gl);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, type, readBuf);
      result.readAsType = gl.getError() === gl.NO_ERROR;

      if (type === gl.HALF_FLOAT) {
        clearGlErrors(gl);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
        result.readAsFloat = gl.getError() === gl.NO_ERROR;
      } else if (type === gl.FLOAT) {
        result.readAsFloat = result.readAsType;
      }
    }
  } catch {
    // Keep partial result on unexpected driver exception.
  } finally {
    clearGlErrors(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
  }
  return result;
}

/**
 * Probe whether a color internal format supports multisampled renderbuffers
 * (e.g. WebGL2 RGBA16F MSAA requires EXT_color_buffer_float, not just EXT_color_buffer_half_float).
 * @param {WebGL2RenderingContext} gl
 * @param {number} internalFormat
 * @param {number} maxSamples
 */
function probeMultisampleFormat(gl, internalFormat, maxSamples) {
  if (!maxSamples || maxSamples < 2) return 0;
  if (
    typeof gl.createFramebuffer !== 'function' ||
    typeof gl.createRenderbuffer !== 'function' ||
    typeof gl.renderbufferStorageMultisample !== 'function'
  ) {
    return 0;
  }
  const testSamples = Math.min(4, maxSamples);
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
  const fbo = gl.createFramebuffer();
  const rb = gl.createRenderbuffer();
  let ok = false;
  try {
    clearGlErrors(gl);
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, testSamples, internalFormat, 4, 4);
    if (gl.getError() === gl.NO_ERROR) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      ok = gl.getError() === gl.NO_ERROR && status === gl.FRAMEBUFFER_COMPLETE;
    }
  } catch {
    ok = false;
  } finally {
    clearGlErrors(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
    gl.deleteFramebuffer(fbo);
    gl.deleteRenderbuffer(rb);
  }
  return ok ? maxSamples : 0;
}

/**
 * Probe the highest-precision supported depth texture attachment type.
 * @param {WebGL2RenderingContext} gl
 */
function probeDepthTextureType(gl) {
  if (
    typeof gl.createFramebuffer !== 'function' ||
    typeof gl.createTexture !== 'function' ||
    typeof gl.checkFramebufferStatus !== 'function'
  ) {
    return THREE.FloatType;
  }
  const candidates = [
    { threeType: THREE.FloatType, internalFormat: gl.DEPTH_COMPONENT32F, type: gl.FLOAT },
    { threeType: THREE.UnsignedIntType, internalFormat: gl.DEPTH_COMPONENT24, type: gl.UNSIGNED_INT },
    { threeType: THREE.UnsignedShortType, internalFormat: gl.DEPTH_COMPONENT16, type: gl.UNSIGNED_SHORT },
  ];
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const fbo = gl.createFramebuffer();
  const colorTex = gl.createTexture();
  const depthTex = gl.createTexture();
  let chosen = THREE.UnsignedIntType;
  try {
    clearGlErrors(gl);
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);

    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    for (const c of candidates) {
      if (!c.internalFormat || !c.type) continue;
      clearGlErrors(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, c.internalFormat, 4, 4, 0, gl.DEPTH_COMPONENT, c.type, null);
      if (gl.getError() !== gl.NO_ERROR) continue;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (gl.getError() === gl.NO_ERROR && status === gl.FRAMEBUFFER_COMPLETE) {
        chosen = c.threeType;
        break;
      }
    }
  } catch {
    chosen = THREE.UnsignedIntType;
  } finally {
    clearGlErrors(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(colorTex);
    gl.deleteTexture(depthTex);
  }
  return chosen;
}

/**
 * Probe WebGL2 texture/render-target capabilities and derive one format policy.
 * @param {WebGL2RenderingContext | null | undefined} gl
 */
export function probeCaps(gl) {
  // A context without getExtension (test stubs, lost contexts) gets the safest formats.
  if (!gl || typeof gl.getExtension !== 'function') {
    return {
      floatLinear: false,
      colorBufferFloat: false,
      colorBufferHalfFloat: false,
      floatBlend: false,
      floatRenderable: false,
      halfFloatRenderable: false,
      floatTexFilter: THREE.NearestFilter,
      needsManualFloatFilter: true,
      floatFilterableTargetType: THREE.UnsignedByteType,
      floatFilterableTargetEncodeScale: 8,
      floatFilterableTargetReadMode: 'ubyte',
      hdrTargetType: THREE.UnsignedByteType,
      hdrMaxSamples: 0,
      depthTextureType: THREE.UnsignedIntType,
      maxTextureSize: 4096,
    };
  }

  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
  const colorBufferHalfFloat = !!gl.getExtension('EXT_color_buffer_half_float');
  const floatBlend = !!gl.getExtension('EXT_float_blend');

  // Probe actual FBO completeness rather than trusting extension presence alone.
  const f32 = colorBufferFloat
    ? probeColorTarget(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT)
    : { renderable: false, readAsType: false, readAsFloat: false };
  const f16 = (colorBufferFloat || colorBufferHalfFloat)
    ? probeColorTarget(gl, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
    : { renderable: false, readAsType: false, readAsFloat: false };

  const floatRenderable = f32.renderable;
  const halfFloatRenderable = f16.renderable;

  // Targets that need both rendering and hardware linear filtering:
  // prefer FloatType when both renderable and linearly filterable (desktop),
  // then HalfFloatType (core linear-filterable in WebGL2, iOS Safari),
  // then UnsignedByteType with range encoding as last resort.
  let floatFilterableTargetType = THREE.UnsignedByteType;
  let floatFilterableTargetEncodeScale = 8;
  let floatFilterableTargetReadMode = 'ubyte';
  if (floatRenderable && floatLinear) {
    floatFilterableTargetType = THREE.FloatType;
    floatFilterableTargetEncodeScale = 1;
    floatFilterableTargetReadMode = f32.readAsType ? 'float' : 'none';
  } else if (halfFloatRenderable) {
    floatFilterableTargetType = THREE.HalfFloatType;
    floatFilterableTargetEncodeScale = 1;
    if (f16.readAsType) floatFilterableTargetReadMode = 'half';
    else if (f16.readAsFloat) floatFilterableTargetReadMode = 'float-from-half';
    else floatFilterableTargetReadMode = 'none';
  }

  const hdrTargetType = halfFloatRenderable ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const glMaxSamples = typeof gl.getParameter === 'function' && gl.MAX_SAMPLES
    ? (Number(gl.getParameter(gl.MAX_SAMPLES)) || 0)
    : 0;
  const hdrInternalFormat = hdrTargetType === THREE.HalfFloatType ? gl.RGBA16F : gl.RGBA8;
  // WebGL2 requires EXT_color_buffer_float for multisampled RGBA16F renderbuffers.
  const hdrMaxSamples = hdrTargetType === THREE.HalfFloatType && !colorBufferFloat
    ? 0
    : probeMultisampleFormat(gl, hdrInternalFormat, glMaxSamples);

  const depthTextureType = probeDepthTextureType(gl);
  const maxTextureSize = typeof gl.getParameter === 'function' && gl.MAX_TEXTURE_SIZE
    ? (Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096)
    : 4096;

  return {
    floatLinear,
    colorBufferFloat,
    colorBufferHalfFloat,
    floatBlend,
    floatRenderable,
    halfFloatRenderable,
    floatTexFilter: floatLinear ? THREE.LinearFilter : THREE.NearestFilter,
    needsManualFloatFilter: !floatLinear,
    floatFilterableTargetType,
    floatFilterableTargetEncodeScale,
    floatFilterableTargetReadMode,
    hdrTargetType,
    hdrMaxSamples,
    depthTextureType,
    maxTextureSize,
  };
}

/**
 * Probe (and cache) capabilities for a Three.js WebGLRenderer.
 * @param {THREE.WebGLRenderer | null | undefined} renderer
 */
export function getCaps(renderer) {
  if (!renderer) return probeCaps(null);
  const cached = _capsCache.get(renderer);
  if (cached) return cached;
  const gl = typeof renderer.getContext === 'function'
    ? /** @type {WebGL2RenderingContext} */ (renderer.getContext())
    : null;
  const caps = probeCaps(gl);
  _capsCache.set(renderer, caps);
  return caps;
}

/**
 * Clamp requested MSAA sample count to what the HDR color target format supports.
 * @param {number | undefined} requested
 * @param {{ hdrMaxSamples?: number } | null | undefined} caps
 */
export function clampMsaaSamples(requested, caps) {
  const req = Math.max(0, Math.floor(requested || 0));
  if (req < 2) return 0;
  const max = caps && typeof caps.hdrMaxSamples === 'number' ? caps.hdrMaxSamples : 0;
  if (max < 2) return 0;
  return Math.min(req, max);
}
