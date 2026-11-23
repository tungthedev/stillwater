import * as THREE from 'three';
import { getCaps } from '../engine/caps.js';
import { renderToTarget } from './heightmap.js';

// Tileable RGBA fbm texture used everywhere for cheap detail noise.
const FRAG = /* glsl */ `
precision highp float;
uniform float uRes;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pnoise(vec2 x, float P){
  vec2 i = floor(x); vec2 f = fract(x); vec2 u = f*f*(3.0-2.0*f);
  vec2 i0 = mod(i, P), i1 = mod(i + 1.0, P);
  float a = h12(i0), b = h12(vec2(i1.x, i0.y)), c = h12(vec2(i0.x, i1.y)), d = h12(i1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 uv, float P, int oct){
  float a = 0.0, b = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    a += b * pnoise(uv * P, P); n += b; b *= 0.5; P *= 2.0;
  }
  return a / n;
}
float pworley(vec2 uv, float P){
  vec2 x = uv * P; vec2 i = floor(x); vec2 f = fract(x);
  float d = 1.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++){
    vec2 g = vec2(float(xx), float(y));
    vec2 c = mod(i + g, P);
    vec2 o = vec2(h12(c), h12(c + 17.31));
    d = min(d, length(g + o - f));
  }
  return d;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float r = pfbm(uv, 4.0, 7);
  float g = pfbm(uv + 0.37, 8.0, 6);
  float b = pfbm(uv + 0.71, 16.0, 5);
  float w = 1.0 - (pworley(uv, 8.0) * 0.6 + pworley(uv, 16.0) * 0.3 + pworley(uv, 32.0) * 0.1);
  gl_FragColor = vec4(r, g, b, w);
}
`;

export function generateNoiseTexture(renderer, res = 512) {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    type: getCaps(renderer).hdrTargetType,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false,
  });
  const mat = new THREE.ShaderMaterial({
    uniforms: { uRes: { value: res } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FRAG,
  });
  renderToTarget(renderer, mat, rt);
  mat.dispose();
  rt.texture.anisotropy = 4;
  return rt;
}
