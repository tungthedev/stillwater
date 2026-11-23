import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { mulberry32 } from './biome.js';
import { buildStorybookCottage } from './cottage.js';
import { U } from '../uniforms.js';
const U_AO = U.uAOSpot;
import { fluffyBush } from './fluffy.js';
import { Herd, sheepGeometry, horseGeometry, ponyGeometry } from './animals.js';

// Cozy set dressing: a timber-and-plaster cottage at the trailhead, rail fences
// along the path, and grazing sheep.

function colored(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function box(w, h, d, x, y, z, rgb, ry = 0, rx = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateZ(rz); g.rotateY(ry);
  g.translate(x, y, z);
  return colored(g, rgb);
}

export function propMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  patchMaterial(m, {
    toonWrap: 0.3,
    fragment: [['#include <color_fragment>', `#include <color_fragment>
      {
        // painterly grain: subtle world-space variation
        vec4 nn = texture(uNoiseTex, vWPos.xz * 0.21 + vWPos.y * 0.13);
        diffuseColor.rgb *= 0.9 + 0.2 * nn.g;
      }`]],
    ...opts,
  });
  return m;
}

const WOOD = [0.38, 0.24, 0.14], WOOD_D = [0.22, 0.14, 0.09], PLASTER = [0.86, 0.79, 0.64];
const STONE = [0.55, 0.52, 0.5], ROOF = [0.24, 0.36, 0.6], ROOF2 = [0.3, 0.44, 0.7];

export function buildCottage() {
  const parts = [];
  const W = 8, D = 6, H = 3.4;
  // stone plinth & steps
  parts.push(box(W + 0.6, 0.9, D + 0.6, 0, 0.25, 0, STONE));
  parts.push(box(1.8, 0.3, 0.8, 0, 0.0, D / 2 + 0.6, STONE));
  // walls
  parts.push(box(W, H, D, 0, 0.7 + H / 2, 0, PLASTER));
  // upper floor overhang
  parts.push(box(W + 0.5, 2.4, D + 0.5, 0, 0.7 + H + 1.2, 0, PLASTER));
  parts.push(box(W + 0.7, 0.22, D + 0.7, 0, 0.7 + H + 0.05, 0, WOOD_D));
  // timber frame
  const y0 = 0.7, y1 = 0.7 + H, y2 = y1 + 2.4;
  for (const x of [-W / 2, -W / 4, 0, W / 4, W / 2]) for (const z of [-D / 2 - 0.02, D / 2 + 0.02]) parts.push(box(0.2, H, 0.12, x, y0 + H / 2, z, WOOD));
  for (const z of [-D / 2, -D / 6, D / 6, D / 2]) for (const x of [-W / 2 - 0.02, W / 2 + 0.02]) parts.push(box(0.12, H, 0.2, x, y0 + H / 2, z, WOOD));
  for (const x of [-(W + 0.5) / 2, -(W + 0.5) / 4, 0, (W + 0.5) / 4, (W + 0.5) / 2]) for (const z of [-(D + 0.5) / 2 - 0.02, (D + 0.5) / 2 + 0.02]) parts.push(box(0.18, 2.4, 0.1, x, y1 + 1.2, z, WOOD));
  for (const z of [-(D + 0.5) / 2 - 0.03, (D + 0.5) / 2 + 0.03]) {
    parts.push(box(W + 0.5, 0.16, 0.1, 0, y2 - 0.08, z, WOOD));
    for (const s of [-1, 1]) parts.push(box(0.14, 2.6, 0.08, s * (W + 0.5) * 0.375, y1 + 1.2, z, WOOD, 0, 0, s * 0.62));
  }
  // door & windows
  parts.push(box(1.2, 2.2, 0.15, 0, y0 + 1.1, D / 2 + 0.06, WOOD_D));
  parts.push(box(0.12, 0.12, 0.08, 0.4, y0 + 1.1, D / 2 + 0.15, [0.75, 0.6, 0.2]));
  const win = (x, y, z, ry) => {
    parts.push(box(1.0, 1.1, 0.12, x, y, z, [0.2, 0.32, 0.45], ry));
    parts.push(box(1.2, 0.12, 0.2, x, y - 0.6, z, WOOD, ry));
    parts.push(box(1.2, 0.12, 0.16, x, y + 0.6, z, WOOD, ry));
    parts.push(box(0.08, 1.1, 0.16, x, y, z, WOOD, ry));
    // flower box
    const fz = ry === 0 ? z + 0.25 * Math.sign(z) : z;
    const fx = ry !== 0 ? x + 0.25 * Math.sign(x) : x;
    parts.push(box(ry === 0 ? 1.1 : 0.3, 0.25, ry === 0 ? 0.3 : 1.1, fx, y - 0.78, fz, WOOD_D));
    for (let k = 0; k < 6; k++) {
      const f = new THREE.IcosahedronGeometry(0.11, 0);
      const o = (k - 2.5) * 0.18;
      f.translate(ry === 0 ? fx + o : fx, y - 0.58, ry === 0 ? fz : fz + o);
      parts.push(colored(f, k % 2 ? [0.85, 0.15, 0.12] : [0.2, 0.5, 0.12]));
    }
  };
  win(-2.4, y0 + 1.7, D / 2 + 0.05, 0); win(2.4, y0 + 1.7, D / 2 + 0.05, 0);
  win(-2.0, y1 + 1.2, (D + 0.5) / 2 + 0.05, 0); win(2.0, y1 + 1.2, (D + 0.5) / 2 + 0.05, 0);
  win(W / 2 + 0.05, y0 + 1.7, 0, Math.PI / 2);
  // gables
  const gable = (z) => {
    const g = new THREE.BufferGeometry();
    const hw = (W + 0.5) / 2, rh = 3.2;
    g.setAttribute('position', new THREE.Float32BufferAttribute([-hw, y2, z, hw, y2, z, 0, y2 + rh, z], 3));
    g.setIndex(z > 0 ? [0, 1, 2] : [0, 2, 1]);
    g.computeVertexNormals();
    return colored(g, PLASTER);
  };
  // roof runs along x; gables at +-x ends -> build gables in the yz plane instead
  const gableX = (x) => {
    const g = new THREE.BufferGeometry();
    const hd = (D + 0.5) / 2, rh = 3.2;
    g.setAttribute('position', new THREE.Float32BufferAttribute([x, y2, -hd, x, y2, hd, x, y2 + rh, 0], 3));
    g.setIndex(x > 0 ? [0, 2, 1] : [0, 1, 2]);
    g.computeVertexNormals();
    return colored(g, PLASTER);
  };
  parts.push(gableX(-(W + 0.5) / 2), gableX((W + 0.5) / 2));
  // roof: rows of overlapping tiles on both slopes
  const rh = 3.2, hd = (D + 0.5) / 2 + 0.7;
  const slope = Math.atan2(rh, hd - 0.7);
  const len = Math.hypot(rh, hd);
  const rows = 9;
  for (const s of [-1, 1]) {
    for (let r = 0; r < rows; r++) {
      const f = (r + 0.5) / rows;
      const zc = s * (hd - f * hd);
      const yc = y2 - 0.35 + f * rh + 0.12;
      const col = r % 2 ? ROOF : ROOF2;
      parts.push(box(W + 1.6, 0.14, len / rows * 1.35, 0, yc, zc, col, 0, s * slope));
    }
  }
  parts.push(box(W + 1.7, 0.3, 0.4, 0, y2 + rh + 0.12, 0, WOOD_D));
  // chimney
  parts.push(box(1.0, 3.0, 1.0, 2.2, y2 + 2.4, -0.9, STONE));
  parts.push(box(1.2, 0.2, 1.2, 2.2, y2 + 3.9, -0.9, [0.4, 0.38, 0.36]));
  // little lean-to woodshed
  parts.push(box(2.2, 0.12, 3.0, -W / 2 - 1.2, 2.3, 0, ROOF, 0, 0, 0.35));
  for (const z of [-1.2, 1.2]) parts.push(box(0.15, 2.1, 0.15, -W / 2 - 2.1, 1.05, z, WOOD));
  for (let i = 0; i < 14; i++) {
    const lg = new THREE.CylinderGeometry(0.13, 0.13, 1.0, 7);
    lg.rotateX(Math.PI / 2);
    lg.translate(-W / 2 - 0.8 - (i % 3) * 0.27, 0.15 + Math.floor(i / 3) * 0.25, ((i * 7) % 5 - 2) * 0.05);
    parts.push(colored(lg, [0.55, 0.38, 0.22]));
  }
  for (const p of parts) { if (!p.attributes.normal) p.computeVertexNormals(); }
  const geo = mergeGeometries(parts);
  return { geo, chimney: new THREE.Vector3(2.2, y2 + 4.1, -0.9) };
}

export class Village {
  constructor(hf, trail, props, trees, rocks, biome) {
    this.group = new THREE.Group();
    this.mat = propMaterial();
    this.colliders = [];
    const pts = trail.points;
    const rnd = mulberry32(31);
    // ---- cottage beside the trailhead
    const i0 = 30;
    const [tx, tz] = pts[i0];
    const [ax, az] = pts[i0 + 6];
    const dx = ax - tx, dz = az - tz, dl = Math.hypot(dx, dz) || 1;
    const side = [-dz / dl, dx / dl];
    const cx = tx + side[0] * 19, cz = tz + side[1] * 19;
    const ry = Math.atan2(-side[0], -side[1]); // front door faces the trail
    let gmin = Infinity;
    let gmax = -Infinity;
    for (const [ox, oz] of [[-6, -5], [6, -5], [-6, 5], [6, 5], [0, 0]]) { const g = hf.height(cx + ox, cz + oz); gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); }
    const ck = buildStorybookCottage();
    const house = new THREE.Mesh(ck.geo, this.mat);
    house.position.set(cx, (gmin + gmax) / 2 - 0.2, cz);
    house.scale.setScalar(1.2);
    house.rotation.y = ry;
    house.castShadow = true; house.receiveShadow = true;
    this.group.add(house);
    house.updateMatrixWorld();
    // warm window glass
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffc46a, emissiveIntensity: 0.3, roughness: 0.3 });
    patchMaterial(this.glassMat, {});
    const glass = new THREE.Mesh(ck.glass, this.glassMat);
    glass.position.copy(house.position); glass.rotation.copy(house.rotation); glass.scale.copy(house.scale);
    this.group.add(glass);
    this.chimney = ck.chimney.clone().applyMatrix4(house.matrixWorld);
    this.lanternPos = ck.lantern.clone().applyMatrix4(house.matrixWorld);
    this.lamp = new THREE.PointLight(0xffb060, 0, 22, 1.6);
    this.lamp.position.copy(this.lanternPos);
    this.group.add(this.lamp);
    this.house = { x: cx, z: cz, r: 8, front: [-side[0], -side[1]], ry };
    // flagstones from the door down to the trail, each sitting on the ground
    {
      const fs2 = [];
      const fx = -side[0], fz = -side[1];
      const doorX = cx + fx * 4.0, doorZ = cz + fz * 4.0;
      U.uYardPath.value.set(doorX - fx * 0.5, doorZ - fz * 0.5, fx * 12.5, fz * 12.5);
      for (let k = 0; k < 12; k++) {
        const x = doorX + fx * k * 1.0 + Math.sin(k * 1.3) * 0.3 * fz, z = doorZ + fz * k * 1.0 - Math.sin(k * 1.3) * 0.3 * fx;
        const g = new THREE.CylinderGeometry(0.42 + rnd() * 0.12, 0.46 + rnd() * 0.12, 0.16, 7);
        g.rotateY(rnd() * 3);
        g.translate(x, hf.height(x, z) + 0.02, z);
        const c = g.index ? g.toNonIndexed() : g; if (c.attributes.uv) c.deleteAttribute('uv');
        const n = c.attributes.position.count, arr = new Float32Array(n * 3), tone = 0.6 + rnd() * 0.12;
        for (let q = 0; q < n; q++) arr.set([tone, tone * 0.95, tone * 0.88], q * 3);
        c.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        fs2.push(c);
      }
      const fm = new THREE.Mesh(mergeGeometries(fs2), this.mat); fm.receiveShadow = true; this.group.add(fm);
    }
    this.porch = new THREE.PointLight(0xffb468, 0, 16, 1.5);
    this.porch.position.set(cx - side[0] * 11.0, gmin + 0.8, cz - side[1] * 11.0);
    this.group.add(this.porch);
    this.colliders.push({ x: cx, z: cz, r: 7.2 });
    if (trees) {
      const bushGeo = fluffyBush(97);
      const spots = [];
      const fx = -side[0], fz = -side[1], rx2 = -fz, rz2 = fx;
      for (const [a, b] of [[5.8, -4.6], [5.8, 4.8], [3.0, -6.6], [-1.0, -6.6], [-4.4, -6.4], [3.2, 6.6], [-0.6, 6.7], [-4.8, 6.2], [-5.8, -2.5], [-5.9, 2.0]]) spots.push([cx + fx * a * 1.2 + rx2 * b * 1.2, cz + fz * a * 1.2 + rz2 * b * 1.2]);
      const im = new THREE.InstancedMesh(bushGeo, trees.material, spots.length);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
      const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3();
      spots.forEach(([x, z], i) => {
        const k = 1.6 + rnd() * 1.0;
        q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
        m4.compose(p4.set(x, hf.height(x, z) - 0.15, z), q4, s4.set(k, k * 0.8, k));
        im.setMatrixAt(i, m4);
        im.instanceColor.setXYZ(i, 0.9 + rnd() * 0.15, 1.0, 0.85);
      });
      im.castShadow = true; im.receiveShadow = true;
      this.group.add(im);
    }
    U_AO.value.set(cx, cz, 7.5, 0.35);
    // clear the plot
    trees?.clearArea(cx, cz, 15);
    rocks?.clearArea(cx, cz, 13);
    // moss on the roof & ivy on the walls: little fluffy clumps
    if (trees) {
      const bush = fluffyBush(91);
      const im = new THREE.InstancedMesh(bush, trees.material, ck.moss.length);
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ck.moss.length * 3), 3);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      ck.moss.forEach((v, i) => {
        p.copy(v).applyMatrix4(house.matrixWorld);
        const k = v.y < 4 ? 1.2 + rnd() * 0.6 : 0.6 + rnd() * 0.5;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
        s.set(k, k * 0.7, k);
        m.compose(p, q, s);
        im.setMatrixAt(i, m);
        im.instanceColor.setXYZ(i, 0.8 + rnd() * 0.2, 0.95 + rnd() * 0.15, 0.8);
      });
      im.castShadow = true; im.receiveShadow = true;
      this.group.add(im);
    }

    // ---- fences along stretches of the trail
    const fenceParts = [];
    const runs = [[12, 180, 1], [40, 150, -1], [560, 720, -1], [900, 1010, 1]];
    for (const [d0, d1, s] of runs) {
      let prev = null;
      for (let i = 0; i < pts.length; i++) {
        const d = trail.dist[i];
        if (d < d0 || d > d1) continue;
        if (prev && d - prev.d < 2.6) continue;
        const j = Math.min(pts.length - 1, i + 2), k = Math.max(0, i - 2);
        const ddx = pts[j][0] - pts[k][0], ddz = pts[j][1] - pts[k][1], l = Math.hypot(ddx, ddz) || 1;
        const px = pts[i][0] - ddz / l * 2.7 * s, pz = pts[i][1] + ddx / l * 2.7 * s;
        const py = hf.height(px, pz);
        if (py < WORLD.waterLevel + 0.5) { prev = null; continue; }
        if (Math.hypot(px - cx, pz - cz) < 12) { prev = null; continue; }
        const tilt = (rnd() - 0.5) * 0.08;
        fenceParts.push(box(0.14, 1.25, 0.14, px, py + 0.45, pz, WOOD, rnd() * 3, tilt, tilt));
        if (prev && d - prev.d < 5.5) {
          for (const hgt of [0.48, 0.9]) {
            const mx = (px + prev.x) / 2, mz = (pz + prev.z) / 2, my = (py + prev.y) / 2 + hgt;
            const len = Math.hypot(px - prev.x, pz - prev.z, py - prev.y);
            const g = new THREE.BoxGeometry(len + 0.2, 0.09, 0.07);
            g.rotateZ(Math.atan2(py - prev.y, Math.hypot(px - prev.x, pz - prev.z)));
            g.rotateY(-Math.atan2(pz - prev.z, px - prev.x));
            g.translate(mx, my + (rnd() - 0.5) * 0.04, mz);
            fenceParts.push(colored(g, hgt > 0.6 ? WOOD : [0.33, 0.21, 0.13]));
          }
        }
        prev = { x: px, y: py, z: pz, d };
      }
    }
    if (fenceParts.length) {
      const fm = new THREE.Mesh(mergeGeometries(fenceParts), this.mat);
      fm.castShadow = true; fm.receiveShadow = true;
      this.group.add(fm);
    }

    // ---- lantern posts along the first stretch of the trail
    {
      const lp = [], lg = [];
      let next = 60;
      for (let i = 0; i < pts.length && trail.dist[i] < 1400; i++) {
        if (trail.dist[i] < next) continue;
        next += 110;
        const j = Math.min(pts.length - 1, i + 2);
        const ddx = pts[j][0] - pts[i][0], ddz = pts[j][1] - pts[i][1], l = Math.hypot(ddx, ddz) || 1;
        const s = (Math.floor(next / 110) % 2) ? 1 : -1;
        const x = pts[i][0] - ddz / l * 2.4 * s, z = pts[i][1] + ddx / l * 2.4 * s;
        const y = hf.height(x, z);
        if (Math.hypot(x - cx, z - cz) < 24) continue;
        lp.push(box(0.12, 1.9, 0.12, x, y + 0.85, z, WOOD_D));
        lp.push(box(0.5, 0.08, 0.08, x + 0.2 * s, y + 1.75, z, WOOD_D));
        lp.push(box(0.26, 0.06, 0.26, x + 0.42 * s, y + 1.6, z, [0.12, 0.12, 0.13]));
        lg.push(box(0.2, 0.26, 0.2, x + 0.42 * s, y + 1.44, z, [1, 1, 1]));
        this.colliders.push({ x, z, r: 0.25 });
      }
      if (lp.length) {
        const pm = new THREE.Mesh(mergeGeometries(lp), this.mat); pm.castShadow = true; this.group.add(pm);
        this.lanternMat = new THREE.MeshBasicMaterial({ color: 0xffd28a });
        const gm = new THREE.Mesh(mergeGeometries(lg), this.lanternMat); this.group.add(gm);
      }
    }
    // ---- chimney smoke
    const smokeN = 18;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(smokeN * 3), 3));
    const seeds = new Float32Array(smokeN);
    for (let i = 0; i < smokeN; i++) seeds[i] = i / smokeN;
    sg.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOrigin: { value: this.chimney }, uWind: { value: new THREE.Vector2(1, 0) }, uLight: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.5, 0.6, 0.7) }, uPix: { value: 900 } },
      vertexShader: `
        attribute float aSeed; uniform float uTime; uniform vec3 uOrigin; uniform vec2 uWind; uniform float uPix;
        varying float vA;
        void main(){
          float t = fract(aSeed + uTime * 0.035);
          vec3 p = uOrigin + vec3(uWind.x * t * t * 22.0 + sin(aSeed * 40.0 + uTime * 0.3) * t * 3.0, t * 14.0, uWind.y * t * t * 22.0 + cos(aSeed * 31.0 + uTime * 0.2) * t * 3.0);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uPix * (1.2 + t * 6.0) / -mv.z;
          vA = smoothstep(0.0, 0.12, t) * pow(1.0 - t, 1.5) * 0.4;
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform vec3 uAmb; varying float vA;
        void main(){
          vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q);
          if (r > 1.0) discard;
          float a = pow(1.0 - r, 2.0) * vA;
          vec3 c = mix(uAmb, uLight, 0.25 - q.y * 0.15) * 0.9;
          gl_FragColor = vec4(c * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.smoke = new THREE.Points(sg, this.smokeMat);
    this.smoke.frustumCulled = false;
    this.group.add(this.smoke);

    // ---- sheep
    const meadow = (h) => {
      if (!biome) return h;
      let best = h, bs = 1e9;
      for (let r = 0; r <= 120; r += 12) for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2, x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
        const y = hf.height(x, z);
        if (y < WORLD.waterLevel + 2) continue;
        const f = biome.sampleForest(x, z) + biome.sampleForest(x + 15, z) + biome.sampleForest(x - 15, z) + biome.sampleForest(x, z + 15) + biome.sampleForest(x, z - 15);
        const sc = f * 10 + r * 0.01 + (1 - hf.normal(x, z, 3).y) * 20;
        if (sc < bs) { bs = sc; best = { x, z, n: h.n }; }
      }
      return best;
    };
    this.sheep = new Herd(hf, [
      { x: pts[70][0] - side[0] * 24, z: pts[70][1] - side[1] * 24, n: 10 },
      { x: cx + side[0] * 32, z: cz + side[1] * 32, n: 7 },
      { x: trail.shore.x + 60, z: trail.shore.z + 70, n: 8 },
      { x: (pts[0][0] + trail.shore.x) / 2 + 40, z: (pts[0][1] + trail.shore.z) / 2 - 40, n: 7 },
    ].map(meadow), { geo: sheepGeometry(), scale: [1.15, 1.45], speed: 0.5, roam: 18, pivot: [0.75, 0.4], grazeAngle: 0.95, collide: 0.55, tailRoot: [0.72, -0.5], legTop: 0.45 });
    this.group.add(this.sheep.mesh);
    // a few horses grazing by the paddock
    const hx = pts[110][0] + side[0] * 26, hz = pts[110][1] + side[1] * 26;
    if (false) this.horses = new Herd(hf, [meadow({ x: hx, z: hz, n: 4 })], { geo: ponyGeometry(), scale: [1.0, 1.2], speed: 0.7, roam: 22, pivot: [1.4, 0.55], grazeAngle: 0.85, collide: 0.9, tailRoot: [1.4, -0.75], legTop: 0.95, coats: [[1, 1, 1], [0.55, 0.45, 0.45], [1.35, 1.25, 1.1]] }, 91);
    // (ponies removed: the sheep carry the pastoral feel better)
    this.horsePos = { x: hx, z: hz };
  }
  update(dt, t, U) {
    const night = U.uNight.value, glow = Math.max(night, U.uGolden.value * 0.4);
    this.glassMat.emissiveIntensity = 0.05 + glow * 2.8;
    this.glassMat.color.setRGB(0.22 + glow * 0.7, 0.34 + glow * 0.5, 0.5 + glow * 0.1);
    this.lamp.intensity = night * 10;
    if (this.porch) this.porch.intensity = night * 5;
    if (this.lanternMat) this.lanternMat.color.setRGB(0.25 + night * 5.5, 0.2 + night * 3.6, 0.12 + night * 1.6);
    this.smokeMat.uniforms.uTime.value = t;
    this.smokeMat.uniforms.uWind.value.copy(U.uWindDir.value);
    const lc = U.uLightColor.value;
    const k = Math.max(lc.r, lc.g, lc.b) || 1;
    this.smokeMat.uniforms.uLight.value.setRGB(0.5 + 0.5 * lc.r / k, 0.5 + 0.5 * lc.g / k, 0.5 + 0.5 * lc.b / k).multiplyScalar(Math.min(1, k * 0.2) + 0.15);
    this.sheep.update(dt, t);

  }
  collide(pos, radius = 0.35) {
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dz = pos.z - c.z;
      const d = Math.hypot(dx, dz), rr = c.r + radius;
      if (d < rr && d > 1e-4) { pos.x = c.x + dx / d * rr; pos.z = c.z + dz / d * rr; }
    }
    this.sheep.collide(pos, radius);

  }
}


