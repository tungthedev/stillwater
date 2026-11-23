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

// Half-float split textures (coarse + remainder, summed after filtering) are only exact when
// the filter unit returns its result at float32 precision. Some GPUs may filter half-float
// at half precision, which would round a filtered 4 km value to ~2 m. This self-test filters
// two texel pairs whose coarse parts differ, at weights exact in 8-bit filter fixed point,
// and reports the worst error against the exact lerp, in the same units as the texel values.
const SPLIT_PROBE_PAIRS = [
  [4096, 1.5, 4100, 0.25], // coarse step 4, as on a ~4 km far map
  [384, 0.75, 385, 0.25], // coarse step 1, valley range
];
const SPLIT_PROBE_WEIGHTS = [0.25, 0.375, 0.5, 0.75];
const SPLIT_PROBE_RANGE = 0.05;
export const SPLIT_MAX_ERROR = 0.01;

const SPLIT_PROBE_VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const SPLIT_PROBE_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uT;
uniform vec4 uH[2];
uniform vec4 uW;
out vec4 o;
void main(){
  int i = int(gl_FragCoord.x);
  int row = i / 4;
  float f = uW[i - row * 4];
  vec4 s = texture(uT, vec2((0.5 + f) * 0.5, row == 0 ? 0.25 : 0.75));
  vec4 h = uH[row];
  float exact = mix(h.x + h.y, h.z + h.w, f);
  o = vec4(clamp(abs(s.r + s.g - exact) / ${SPLIT_PROBE_RANGE.toFixed(3)}, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/**
 * Worst error of hardware-filtered half-float split sums, or null when the probe cannot run.
 * Restores every piece of GL state it touches, since three.js caches that state.
 * @param {WebGL2RenderingContext} gl
 */
function probeHalfSplitFilterError(gl) {
  if (typeof gl.createShader !== 'function' || typeof gl.createVertexArray !== 'function') return null;
  const caps = [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD];
  const saved = {
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    active: gl.getParameter(gl.ACTIVE_TEXTURE),
    fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT),
    mask: gl.getParameter(gl.COLOR_WRITEMASK),
    flipY: gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL),
    premul: gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),
    align: gl.getParameter(gl.UNPACK_ALIGNMENT),
    enabled: caps.map((c) => gl.isEnabled(c)),
  };
  gl.activeTexture(gl.TEXTURE0);
  saved.tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
  const made = { shaders: [], prog: null, tex: null, out: null, fbo: null, vao: null };
  try {
    clearGlErrors(gl);
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      made.shaders.push(sh);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    };
    if (!compile(gl.VERTEX_SHADER, SPLIT_PROBE_VS) || !compile(gl.FRAGMENT_SHADER, SPLIT_PROBE_FS)) return null;
    made.prog = gl.createProgram();
    for (const sh of made.shaders) gl.attachShader(made.prog, sh);
    gl.linkProgram(made.prog);
    if (!gl.getProgramParameter(made.prog, gl.LINK_STATUS)) return null;

    const toHalf = THREE.DataUtils.toHalfFloat;
    const texels = new Uint16Array(SPLIT_PROBE_PAIRS.flat().map(toHalf));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    made.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, made.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 2, 2, 0, gl.RG, gl.HALF_FLOAT, texels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const n = SPLIT_PROBE_PAIRS.length * SPLIT_PROBE_WEIGHTS.length;
    made.out = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, made.out);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    made.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, made.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, made.out, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;

    gl.bindTexture(gl.TEXTURE_2D, made.tex);
    made.vao = gl.createVertexArray();
    gl.bindVertexArray(made.vao);
    gl.useProgram(made.prog);
    gl.uniform1i(gl.getUniformLocation(made.prog, 'uT'), 0);
    gl.uniform4fv(gl.getUniformLocation(made.prog, 'uH'), SPLIT_PROBE_PAIRS.flat());
    gl.uniform4fv(gl.getUniformLocation(made.prog, 'uW'), SPLIT_PROBE_WEIGHTS);
    for (const c of caps) gl.disable(c);
    gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, n, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (gl.getError() !== gl.NO_ERROR) return null;
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, px[i * 4]);
    return (worst / 255) * SPLIT_PROBE_RANGE;
  } catch {
    return null;
  } finally {
    clearGlErrors(gl);
    gl.useProgram(saved.program);
    gl.bindVertexArray(saved.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, saved.fbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, saved.tex0);
    gl.activeTexture(saved.active);
    gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);
    gl.colorMask(saved.mask[0], saved.mask[1], saved.mask[2], saved.mask[3]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, saved.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, saved.premul);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, saved.align);
    caps.forEach((c, i) => (saved.enabled[i] ? gl.enable(c) : gl.disable(c)));
    if (made.vao) gl.deleteVertexArray(made.vao);
    if (made.fbo) gl.deleteFramebuffer(made.fbo);
    if (made.out) gl.deleteTexture(made.out);
    if (made.tex) gl.deleteTexture(made.tex);
    if (made.prog) gl.deleteProgram(made.prog);
    for (const sh of made.shaders) gl.deleteShader(sh);
  }
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
      floatFilterableTargetType: THREE.UnsignedByteType,
      floatFilterableTargetEncodeScale: 8,
      floatFilterableTargetReadMode: 'ubyte',
      hdrTargetType: THREE.UnsignedByteType,
      hdrMaxSamples: 0,
      depthTextureType: THREE.UnsignedIntType,
      maxTextureSize: 4096,
      halfSplitFilterError: null,
      halfSplitManualFilter: true,
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

  // Only GPUs without float-linear filtering use split textures, so only they pay for the test.
  const halfSplitFilterError = floatLinear ? null : probeHalfSplitFilterError(gl);
  const halfSplitManualFilter = !floatLinear && !(halfSplitFilterError !== null && halfSplitFilterError <= SPLIT_MAX_ERROR);

  return {
    floatLinear,
    colorBufferFloat,
    colorBufferHalfFloat,
    floatBlend,
    floatRenderable,
    halfFloatRenderable,
    floatFilterableTargetType,
    floatFilterableTargetEncodeScale,
    floatFilterableTargetReadMode,
    hdrTargetType,
    hdrMaxSamples,
    depthTextureType,
    maxTextureSize,
    halfSplitFilterError,
    halfSplitManualFilter,
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
