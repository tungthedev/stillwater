import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { LAYER_NO_REFLECT } from './water.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { mulberry32 } from './biome.js';

// Waterfall dressing on the stream's steepest stretch: flanking wet rocks,
// a churning plunge pool and a drifting mist cloud.
export class Waterfall {
  constructor(hf, stream) {
    const pts = stream.points;
    this.group = new THREE.Group();
    let mi = 0, maxG = 0;
    for (let i = 4; i < pts.length - 4; i++) {
      const a = hf.height(pts[i - 3][0], pts[i - 3][1]), b = hf.height(pts[i + 3][0], pts[i + 3][1]);
      const g = (a - b) / 12;
      if (g > maxG) { maxG = g; mi = i; }
    }
    if (maxG < 0.35) return;
    let foot = mi;
    while (foot < pts.length - 4) {
      const a = hf.height(pts[foot][0], pts[foot][1]), b = hf.height(pts[foot + 3][0], pts[foot + 3][1]);
      if ((a - b) / 6 < 0.18) break;
      foot++;
    }
    let top = mi;
    while (top > 3) {
      const a = hf.height(pts[top - 3][0], pts[top - 3][1]), b = hf.height(pts[top][0], pts[top][1]);
      if ((a - b) / 6 < 0.25) break;
      top--;
    }
    const rnd = mulberry32(99);
    const parts = [];
    for (let i = Math.max(0, top - 4); i <= foot; i += 2) {
      const [px, pz] = pts[i];
      const j = Math.min(pts.length - 1, i + 1);
      const dx = pts[j][0] - px, dz = pts[j][1] - pz, l = Math.hypot(dx, dz) || 1;
      for (const s of [-1, 1]) {
        const off = 8.0 + rnd() * 3.0;
        const x = px - dz / l * off * s, z = pz + dx / l * off * s;
        if (hf.normal(x, z, 1.5).y < 0.55) continue;
        const sc = 1.6 + rnd() * 2.6;
        const g = rockGeometry(500 + i * 3 + (s > 0 ? 1 : 0), 2, 0.95);
        g.scale(sc, sc * 1.35, sc);
        g.rotateY(rnd() * 6.28);
        g.translate(x, hf.height(x, z) - sc * 0.35, z);
        parts.push(g);
      }
    }
    // chunky stylized rock buttresses dressing the cliff face on both sides of the fall
    if (stream.brink) {
      const k = stream.brink;
      const [bx, bz] = pts[k];
      const j = Math.min(pts.length - 1, k + 3);
      const fx0 = pts[j][0] - bx, fz0 = pts[j][1] - bz, fl = Math.hypot(fx0, fz0) || 1;
      const ux = fx0 / fl, uz = fz0 / fl, lx = -uz, lz = ux;
      const yTop = hf.height(bx, bz);
      for (const s of [-1, 1]) for (let o = 9.0; o < 26; o += 3.2 + rnd() * 1.5) {
        const x = bx + lx * o * s + ux * (1.0 + rnd() * 2.0), z = bz + lz * o * s + uz * (1.0 + rnd() * 2.0);
        const yb = hf.height(x + ux * 6, z + uz * 6);
        const hgt = Math.max(4, (yTop - yb) * (1 - o / 34));
        const g = rockGeometry(900 + Math.floor(o * 10) + (s > 0 ? 1 : 0), 2, 1.0);
        const sc = 2.6 + rnd() * 1.6;
        g.scale(sc, hgt * 0.6, sc * 0.9);
        g.rotateY(rnd() * 6.28);
        g.translate(x, yb + hgt * 0.45, z);
        parts.push(g);
      }
    }
    const [tx, tz] = pts[top];

    if (parts.length) {
      const m = new THREE.Mesh(mergeGeometries(parts), rockMaterial());
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
    }
    const fi = Math.min(pts.length - 1, foot + 2);
    const [fx, fz] = pts[fi];
    const fy = hf.height(fx, fz) + 0.4;
    const poolGeo = new THREE.CircleGeometry(7, 48); poolGeo.rotateX(-Math.PI / 2);
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uC: { value: new THREE.Vector3(fx, fy, fz) } },
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: COMMON + `
        uniform vec3 uC; varying vec3 vW;
        void main(){
          vec2 d = vW.xz - uC.xz; float r = length(d) / 7.0;
          float n = texture(uNoiseTex, vW.xz * 0.2 + vec2(uTime * 0.05, -uTime * 0.04)).a;
          float rings = smoothstep(0.55, 0.9, sin(r * 22.0 - uTime * 3.0 + n * 4.0) * 0.5 + 0.5) * (1.0 - r);
          vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
          vec3 deep = vec3(0.03, 0.32, 0.44) * (amb * 1.2 + uLightColor * 0.12);
          vec3 white = amb * 1.1 + uLightColor * 0.3;
          float foam = max(smoothstep(0.45, 0.0, r) * 0.85, rings * 0.5);
          vec3 col = mix(deep, white, clamp(foam + n * 0.15, 0.0, 1.0));
          float a = (1.0 - smoothstep(0.8, 1.0, r + (n - 0.5) * 0.14)) * 0.94;
          gl_FragColor = vec4(w_applyAtmosphere(col, vW), a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const pool = new THREE.Mesh(poolGeo, this.poolMat);
    pool.position.set(fx, fy, fz);
    pool.renderOrder = 9;
    this.group.add(pool);
    const N = 190;
    const mg = new THREE.BufferGeometry();
    const mp = new Float32Array(N * 3), ms = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const k = Math.floor(rnd() * Math.max(1, fi - top)) + top;
      const src = i < N * 0.6 ? [fx, fz] : pts[Math.min(pts.length - 1, k)];
      mp[i * 3] = src[0] + (rnd() - 0.5) * 6; mp[i * 3 + 1] = hf.height(src[0], src[1]) + rnd() * 2.5; mp[i * 3 + 2] = src[1] + (rnd() - 0.5) * 6; ms[i] = rnd();
    }
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mg.setAttribute('aSeed', new THREE.Float32BufferAttribute(ms, 1));
    this.mistMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uPix: { value: 900 }, uLightColor: U.uLightColor },
      vertexShader: `attribute float aSeed; uniform float uTime; uniform float uPix; varying float vA;
        void main(){ float t = fract(aSeed * 3.7 + uTime * 0.12);
          vec3 p = position + vec3(sin(aSeed * 40.0 + uTime * 0.3) * 2.0 * t, t * 6.0, cos(aSeed * 25.0) * 2.0 * t);
          vec4 mv = viewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = uPix * (1.8 + t * 4.0) / -mv.z; vA = sin(t * 3.14159) * 0.11; }`,
      fragmentShader: `uniform vec3 uLightColor; varying float vA; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; float a = (1.0 - r) * (1.0 - r) * vA; vec3 c = vec3(0.95, 0.98, 1.0) * min(1.25, 0.55 + 0.1 * max(max(uLightColor.r, uLightColor.g), uLightColor.b)); gl_FragColor = vec4(c * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mist = new THREE.Points(mg, this.mistMat);
    this.mist.frustumCulled = false;
    this.mist.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.mist);
    this.foot = { x: fx, z: fz, y: fy };
    // --- the falling sheet: curved ribbon arcing out from the brink
    {
      const k = stream.brink ?? top;
      const [bx, bz] = pts[k];
      let f2 = k + 1;
      while (f2 < pts.length - 4 && (hf.height(pts[f2][0], pts[f2][1]) - hf.height(pts[f2 + 3][0], pts[f2 + 3][1])) / 6 > 0.18) f2++;
      const yTop = hf.height(pts[Math.max(0, k - 2)][0], pts[Math.max(0, k - 2)][1]) + 0.3;
      const yBot = hf.height(pts[f2][0], pts[f2][1]) + 0.2;
      const j = Math.min(pts.length - 1, k + 3);
      const ux0 = pts[j][0] - bx, uz0 = pts[j][1] - bz, ul = Math.hypot(ux0, uz0) || 1;
      const ux = ux0 / ul, uz = uz0 / ul, lx = -uz, lz = ux;
      const W = 10.5, rows = 24, cols = 8;
      const pos = [], uvs = [], idx = [];
      for (let r = 0; r <= rows; r++) {
        const s = r / rows;
        const lip = Math.min(1, s / 0.07);
        const out = -2.2 + 3.1 * (lip * lip * (3 - 2 * lip)) + 3.2 * Math.pow(s, 1.4);
        const y = yTop + 0.25 * (1 - lip) - (yTop - yBot) * (s * s * 0.35 + s * 0.65);
        const w = W * (0.8 + 0.35 * s);
        for (let c = 0; c <= cols; c++) {
          const t = c / cols - 0.5;
          const bulge = Math.cos(t * Math.PI) * 0.6;
          pos.push(bx + ux * (out + bulge) + lx * t * w, y, bz + uz * (out + bulge) + lz * t * w);
          uvs.push(t * 2.0, s);
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c, b2 = a + 1, cc = a + cols + 1, d = cc + 1;
        idx.push(a, cc, b2, b2, cc, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aUv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      this.sheetMat = new THREE.ShaderMaterial({
        uniforms: { ...U, uH: { value: yTop - yBot } },
        vertexShader: 'attribute vec2 aUv; varying vec2 vU; varying vec3 vW; void main(){ vU = aUv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: COMMON + `
          uniform float uH; varying vec2 vU; varying vec3 vW;
          void main(){
            float x = vU.x, s = vU.y;
            float st1 = texture(uNoiseTex, vec2(x * 1.3 + 0.17, s * uH * 0.03 - uTime * 0.55)).g;
            float st2 = texture(uNoiseTex, vec2(x * 3.1 + 0.6, s * uH * 0.07 - uTime * 0.9)).b;
            float streak = st1 * 0.6 + st2 * 0.4;
            vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
            float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
            vec3 white = amb * 1.15 + uLightColor * 0.42 * sunUp;
            vec3 blue = vec3(0.12, 0.45, 0.6) * (amb * 1.3 + uLightColor * 0.15 * sunUp);
            float foamLip = smoothstep(0.12, 0.0, s), foamBase = smoothstep(0.8, 1.0, s);
            float wf = clamp(smoothstep(0.38, 0.62, streak) + foamLip + foamBase * 0.7, 0.0, 1.0);
            vec3 col = mix(blue, white, wf);
            float edge = 1.0 - smoothstep(0.65, 1.0, abs(x) + (st2 - 0.5) * 0.35);
            float a = edge * mix(0.7, 0.97, wf) * smoothstep(0.0, 0.025 + (st1 - 0.5) * 0.03, s);
            col = w_applyAtmosphere(col, vW);
            gl_FragColor = vec4(col, a);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const sheet = new THREE.Mesh(g, this.sheetMat);
      sheet.renderOrder = 9;
      this.group.add(sheet);
    }
    this.top = { x: tx, z: tz, y: hf.height(tx, tz) };
    const dn = pts[Math.min(pts.length - 1, fi + 12)];
    this.down = { x: dn[0] - fx, z: dn[1] - fz };
    this.footIdx = fi;
  }
}
