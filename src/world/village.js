import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../patch.js';
import { WORLD } from '../config.js';
import { mulberry32 } from './biome.js';
import { buildStorybookCottage } from './cottage.js';
import { U } from '../uniforms.js';
import { fluffyBush, fluffyBroadleaf } from './fluffy.js';
import { Herd, sheepGeometry } from './animals.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { LAYER_NO_REFLECT } from './water.js';
import { makeGlintSprite } from '../game/proto/protoCreek.js';

const U_AO = U.uAOSpot;

// Cozy alpine trailhead village: storybook cottage, warm dusk/night glow halos & light spill,
// framing oak tree behind the house, garden, rail fences, path lanterns, daytime+dusk chimney smoke, sheep herds.

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
    fragment: [
      ['#include <color_fragment>', `#include <color_fragment>
        {
          vec4 nn = texture(uNoiseTex, vWPos.xz * 0.21 + vWPos.y * 0.13);
          diffuseColor.rgb *= 0.9 + 0.2 * nn.g;
        }`],
      ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // fences, steps, stonework, garden & flagstones catch the warm cottage lantern & window spill at dusk/night!
        totalEmissiveRadiance += (diffuseColor.rgb * 0.85 + vec3(0.03, 0.018, 0.008)) * w_warmSpill(vWPos) * 0.72;`],
    ],
    ...opts,
  });
  return m;
}

const WOOD = [0.38, 0.24, 0.14], WOOD_D = [0.22, 0.14, 0.09];

export class Village {
  constructor(hf, trail, props, trees, biome, region = WORLD) {
    this.group = new THREE.Group();
    this._sharedFoliageMat = trees ? trees.material : null;
    this.mat = propMaterial();
    this.colliders = [];
    const pts = trail.points;
    const rnd = mulberry32(31);
    const wl = region.waterLevel;

    // ---- cottage beside the trailhead
    const cotCfg = region.cottage || { trailIdx: 30, aheadOffset: 6, sideOffset: 19 };
    const i0 = cotCfg.trailIdx;
    const [tx, tz] = pts[i0];
    const [ax, az] = pts[i0 + cotCfg.aheadOffset];
    const dx = ax - tx, dz = az - tz, dl = Math.hypot(dx, dz) || 1;
    const side = [-dz / dl, dx / dl];
    const cx = tx + side[0] * cotCfg.sideOffset, cz = tz + side[1] * cotCfg.sideOffset;
    const ry = Math.atan2(-side[0], -side[1]);
    let gmin = Infinity, gmax = -Infinity;
    for (const [ox, oz] of [[-6, -5], [6, -5], [-6, 5], [6, 5], [0, 0]]) {
      const g = hf.height(cx + ox, cz + oz);
      gmin = Math.min(gmin, g); gmax = Math.max(gmax, g);
    }
    const ck = buildStorybookCottage();
    const house = new THREE.Mesh(ck.geo, this.mat);
    house.position.set(cx, (gmin + gmax) / 2 - 0.2, cz);
    house.scale.setScalar(1.2);
    house.rotation.y = ry;
    house.castShadow = true; house.receiveShadow = true;
    this.group.add(house);
    house.updateMatrixWorld();

    // warm glowing window glass (amber candlelight in dusk & night without clipping mullions!)
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0xffd28a, emissive: 0xff9a34, emissiveIntensity: 0.2, roughness: 0.25 });
    patchMaterial(this.glassMat, {});
    const glass = new THREE.Mesh(ck.glass, this.glassMat);
    glass.position.copy(house.position); glass.rotation.copy(house.rotation); glass.scale.copy(house.scale);
    this.group.add(glass);

    this.chimney = ck.chimney.clone().applyMatrix4(house.matrixWorld);
    this.lanternPos = ck.lantern.clone().applyMatrix4(house.matrixWorld);
    this.hearthLit = 0;

    // Window spill: a centre between the front ground-floor windows plus the vector to one of
    // them (see w_warmSpill), so each window and the ground at the door get their own pool.
    const frontWins = [];
    for (const gp of ck.glows) {
      // ground-floor windows on the door side only (cottage-local +z is the front)
      if (gp.y > 3.6 || gp.z < 1.0 || gp.equals(ck.lantern)) continue;
      frontWins.push(gp.clone().applyMatrix4(house.matrixWorld));
    }
    this.frontGlowPos = new THREE.Vector3();
    this.frontGlowAxis = new THREE.Vector3();
    if (frontWins.length) {
      for (const w of frontWins) this.frontGlowPos.add(w);
      this.frontGlowPos.divideScalar(frontWins.length);
      if (frontWins.length > 1) this.frontGlowAxis.subVectors(frontWins[frontWins.length - 1], frontWins[0]).multiplyScalar(0.5);
    } else {
      this.frontGlowPos.copy(this.lanternPos);
    }
    // the shader takes (-axis.z, axis.x) as the outward wall normal
    if (this.frontGlowAxis.lengthSq() < 1e-6) this.frontGlowAxis.set(side[1], 0, -side[0]).multiplyScalar(1e-3);
    if (-this.frontGlowAxis.z * -side[0] + this.frontGlowAxis.x * -side[1] < 0) this.frontGlowAxis.negate();

    this.house = { x: cx, z: cz, r: 8.5, front: [-side[0], -side[1]], ry };

    // soft warm additive glow halos around lit windows & lanterns at dusk/night!
    const haloPos = [];
    for (const gp of ck.glows) {
      const wp = gp.clone().applyMatrix4(house.matrixWorld);
      haloPos.push(wp.x, wp.y, wp.z);
    }

    // flagstones from the front door down to the trail
    const fx = -side[0], fz = -side[1];
    {
      const fs2 = [];
      const doorX = cx + fx * 4.0, doorZ = cz + fz * 4.0;
      U.uYardPath.value.set(doorX - fx * 0.5, doorZ - fz * 0.5, fx * 12.5, fz * 12.5);
      for (let k = 0; k < 12; k++) {
        const x = doorX + fx * k * 1.0 + Math.sin(k * 1.3) * 0.3 * fz;
        const z = doorZ + fz * k * 1.0 - Math.sin(k * 1.3) * 0.3 * fx;
        const g = new THREE.CylinderGeometry(0.44 + rnd() * 0.12, 0.48 + rnd() * 0.12, 0.16, 7);
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

    this.colliders.push({ x: cx, z: cz, r: 7.4 });
    U_AO.value.set(cx, cz, 7.5, 0.35);

    // lush foundation bushes hugging the cottage + climbing ivy & roof moss
    if (trees) {
      const bushGeo = fluffyBush(97);
      const spots = [];
      const rx2 = -fz, rz2 = fx;
      for (const [a, b] of [[5.8, -4.6], [5.8, 4.8], [3.0, -6.6], [-1.0, -6.6], [-4.4, -6.4], [3.2, 6.6], [-0.6, 6.7], [-4.8, 6.2], [-5.8, -2.5], [-5.9, 2.0]]) {
        spots.push([cx + fx * a * 1.2 + rx2 * b * 1.2, cz + fz * a * 1.2 + rz2 * b * 1.2]);
      }
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

      const bush = fluffyBush(91);
      const im2 = new THREE.InstancedMesh(bush, trees.material, ck.moss.length);
      im2.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ck.moss.length * 3), 3);
      ck.moss.forEach((v, i) => {
        p4.copy(v).applyMatrix4(house.matrixWorld);
        const k = 0.72 + rnd() * 0.26;
        q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
        // hug wall closely as flat vertical creeping ivy (ZERO detached round bush balls sticking off corners!)
        s4.set(k * 0.62, k * 1.18, k * 0.62);
        m4.compose(p4, q4, s4);
        im2.setMatrixAt(i, m4);
        im2.instanceColor.setXYZ(i, 0.76 + rnd() * 0.16, 0.94 + rnd() * 0.12, 0.74);
      });
      im2.castShadow = true; im2.receiveShadow = true;
      this.group.add(im2);

      // charming grand storybook oak tree nestled just behind-right of the cottage (frames cottage against the peaks!)
      const oakGeo = fluffyBroadleaf(108, { kind: 'oak', color: [0.16, 0.42, 0.08] });
      const oakX = cx - fx * 9.5 - rx2 * 10.5, oakZ = cz - fz * 9.5 - rz2 * 10.5;
      const oakM = new THREE.InstancedMesh(oakGeo, trees.material, 1);
      oakM.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1.04, 1.02, 0.94]), 3);
      q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.4);
      m4.compose(p4.set(oakX, hf.height(oakX, oakZ) - 0.3, oakZ), q4, s4.set(17.5, 16.5, 17.5));
      oakM.setMatrixAt(0, m4);
      oakM.castShadow = true; oakM.receiveShadow = true;
      this.group.add(oakM);
    }

    // ---- fences along stretches of the trail (split out 1 two-rail gap right past the cottage for Beat 3)
    const fenceParts = [];
    this.fenceGap = null;
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
        if (py < wl + 0.5) { prev = null; continue; }
        if (Math.hypot(px - cx, pz - cz) < 12) { prev = null; continue; }
        const tilt = (rnd() - 0.5) * 0.08;
        fenceParts.push(box(0.14, 1.25, 0.14, px, py + 0.45, pz, WOOD, rnd() * 3, tilt, tilt));
        if (prev && d - prev.d < 5.5) {
          const isGap = (d0 === 12 && !this.fenceGap && d >= 86);
          const gapRails = [];
          for (const hgt of [0.48, 0.9]) {
            const mx = (px + prev.x) / 2, mz = (pz + prev.z) / 2, my = (py + prev.y) / 2 + hgt;
            const len = Math.hypot(px - prev.x, pz - prev.z, py - prev.y);
            const rz = Math.atan2(py - prev.y, Math.hypot(px - prev.x, pz - prev.z));
            const ryRail = -Math.atan2(pz - prev.z, px - prev.x);
            if (isGap) {
              gapRails.push({ mx, my, mz, len, rz, ry: ryRail });
            } else {
              const g = new THREE.BoxGeometry(len + 0.2, 0.09, 0.07);
              g.rotateZ(rz);
              g.rotateY(ryRail);
              g.translate(mx, my + (rnd() - 0.5) * 0.04, mz);
              fenceParts.push(colored(g, hgt > 0.6 ? WOOD : [0.33, 0.21, 0.13]));
            }
          }
          if (isGap) {
            this.fenceGap = {
              postA: { x: prev.x, y: prev.y, z: prev.z },
              postB: { x: px, y: py, z: pz },
              center: { x: (px + prev.x) / 2, y: (py + prev.y) / 2 + 0.72, z: (pz + prev.z) / 2 },
              tx: ddx / l, tz: ddz / l,
              nx: -ddz / l * s, nz: ddx / l * s,
              rails: gapRails,
            };
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

    // ---- lantern posts along the trail (gate lantern tied to cottage hearth; 6 split trail lamps for Beat 4)
    this.trailLamps = [];
    {
      const lp = [];
      const addPost = (x, z, armX, armZ) => {
        const y = hf.height(x, z);
        lp.push(box(0.14, 2.05, 0.14, x, y + 0.92, z, WOOD_D));
        lp.push(box(0.55, 0.09, 0.09, x + armX * 0.22, y + 1.88, z + armZ * 0.22, WOOD_D, Math.atan2(armZ, armX)));
        const gx = x + armX * 0.45, gz = z + armZ * 0.45;
        lp.push(box(0.28, 0.07, 0.28, gx, y + 1.72, gz, [0.12, 0.12, 0.13]));
        this.colliders.push({ x, z, r: 0.25 });
        return { y, gx, gy: y + 1.54, gz };
      };
      // gate lantern near where cottage flagstones meet the trail & fence (lights with the hearth!)
      const gx0 = cx + fx * 14.5 - fz * 2.2, gz0 = cz + fz * 14.5 + fx * 2.2;
      const gInfo = addPost(gx0, gz0, -fx, -fz);
      this.gateLampPos = new THREE.Vector3(gx0, hf.height(gx0, gz0) + 1.8, gz0);
      this.gateLanternMat = new THREE.MeshBasicMaterial({ color: 0x26323a });
      const gateGlass = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.22), this.gateLanternMat);
      gateGlass.position.set(gInfo.gx, gInfo.gy, gInfo.gz);
      this.group.add(gateGlass);
      haloPos.push(gInfo.gx, gInfo.gy, gInfo.gz);

      // 6 interactive trail lamps evenly spaced from past the fence gap (~145m) to before the stream bridge (~715m)
      const lampDists = [145, 255, 365, 475, 590, 710];
      for (let li = 0; li < lampDists.length; li++) {
        const targetD = lampDists[li];
        let bi = 0;
        for (let i = 0; i < pts.length; i++) {
          if (trail.dist[i] >= targetD) { bi = i; break; }
        }
        const j = Math.min(pts.length - 1, bi + 2);
        const ddx = pts[j][0] - pts[bi][0], ddz = pts[j][1] - pts[bi][1], l = Math.hypot(ddx, ddz) || 1;
        const s = (li % 2 === 0) ? 1 : -1;
        const x = pts[bi][0] - ddz / l * 2.15 * s, z = pts[bi][1] + ddx / l * 2.15 * s;
        // arm reaches slightly toward the trail centerline
        const armX = (ddz / l) * s, armZ = (-ddx / l) * s;
        const info = addPost(x, z, armX, armZ);
        const glassMat = new THREE.MeshBasicMaterial({ color: 0x242e36 });
        const glassMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.30, 0.24), glassMat);
        glassMesh.position.set(info.gx, info.gy, info.gz);
        this.group.add(glassMesh);

        const haloSprite = makeGlintSprite(2.6);
        haloSprite.position.set(info.gx, info.gy, info.gz);
        haloSprite.visible = false;
        this.group.add(haloSprite);

        const glintSprite = makeGlintSprite(0.72);
        glintSprite.position.set(info.gx, info.gy, info.gz);
        glintSprite.material.opacity = 0.26;
        this.group.add(glintSprite);

        this.trailLamps.push({
          x, y: info.y, z,
          gx: info.gx, gy: info.gy, gz: info.gz,
          dist: trail.dist[bi],
          glassMesh, glassMat, haloSprite, glintSprite,
          lit: false, litT: 0,
        });
      }
      if (lp.length) {
        const pm = new THREE.Mesh(mergeGeometries(lp), this.mat); pm.castShadow = true; this.group.add(pm);
      }
    }

    // warm additive glow halos around windows & lanterns (makes cottageDusk & night truly magical!)
    {
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute(haloPos, 3));
      this.haloMat = new THREE.ShaderMaterial({
        uniforms: { uGlow: { value: 0 }, uPix: { value: 900 } },
        vertexShader: `uniform float uPix; void main(){ vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(uPix * 1.9 / max(-mv.z, 1.0), 3.0, 110.0); }`,
        fragmentShader: `uniform float uGlow; void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard; float a = pow(1.0 - r, 2.8) * uGlow * 0.024; gl_FragColor = vec4(vec3(1.0, 0.62, 0.22) * a, a); }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      this.halos = new THREE.Points(hg, this.haloMat);
      this.halos.frustumCulled = false;
      this.halos.layers.set(LAYER_NO_REFLECT);
      this.halos.renderOrder = 18;
      this.group.add(this.halos);
    }

    // ---- chimney smoke (clearly visible cozy white curling plume in daytime, dusk, night & from summit!)
    const smokeN = 26;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(smokeN * 3), 3));
    const seeds = new Float32Array(smokeN);
    for (let i = 0; i < smokeN; i++) seeds[i] = i / smokeN;
    sg.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    this.smokeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOrigin: { value: this.chimney }, uWind: { value: new THREE.Vector2(1, 0) }, uLight: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.5, 0.6, 0.7) }, uPix: { value: 900 }, uTwilight: { value: 0 }, uAlpha: { value: 0 } },
      vertexShader: `
        attribute float aSeed; uniform float uTime; uniform vec3 uOrigin; uniform vec2 uWind; uniform float uPix; uniform float uAlpha;
        varying float vA; varying float vT;
        void main(){
          float t = fract(aSeed + uTime * 0.036);
          vec3 p = uOrigin + vec3(
            uWind.x * t * t * 24.0 + sin(aSeed * 40.0 + uTime * 0.35) * t * 3.0,
            t * 28.0,
            uWind.y * t * t * 24.0 + cos(aSeed * 31.0 + uTime * 0.25) * t * 3.0
          );
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(uPix * (1.4 + t * 6.4) / max(-mv.z, 1.0), 4.0, 195.0);
          vA = smoothstep(0.0, 0.12, t) * pow(1.0 - t, 1.35) * 0.58 * uAlpha;
          vT = t;
        }`,
      fragmentShader: `
        uniform vec3 uLight; uniform vec3 uAmb; uniform float uTwilight; varying float vA; varying float vT;
        void main(){
          vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q);
          if (r > 1.0) discard;
          float a = pow(1.0 - r, 2.0) * vA;
          // exposure-calibrated chimney smoke: cozy bright wisps by day, soft translucent twilight lavender-mist at dusk/night (NEVER a blown-out white blob!)
          vec3 dayS = mix(uAmb * 0.72 + vec3(0.24, 0.26, 0.30), uLight * 0.85 + vec3(0.50, 0.52, 0.55), 0.5 - q.y * 0.35);
          vec3 duskS = mix(vec3(0.025, 0.028, 0.052), vec3(0.055, 0.052, 0.072), 0.5 - q.y * 0.35);
          vec3 baseS = mix(dayS, duskS, uTwilight);
          gl_FragColor = vec4(baseS * a, a * mix(1.0, 0.78, uTwilight));
        }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.smoke = new THREE.Points(sg, this.smokeMat);
    this.smoke.frustumCulled = false;
    this.group.add(this.smoke);

    // ---- sheep herds
    const meadow = (h) => {
      if (!biome) return h;
      let best = h, bs = 1e9;
      for (let r = 0; r <= 120; r += 12) for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2, x = h.x + Math.cos(a) * r, z = h.z + Math.sin(a) * r;
        const y = hf.height(x, z);
        if (y < wl + 2) continue;
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
    ].map(meadow), {
      geo: sheepGeometry(), scale: [1.10, 1.56], speed: 0.5, roam: 13, pivot: [0.75, 0.4], grazeAngle: 0.95, collide: 0.55, tailRoot: [0.72, -0.5], legTop: 0.45,
      tintWool: true,
      coats: [[1.0, 0.99, 0.95], [1.0, 0.94, 0.83], [0.92, 0.91, 0.89], [0.97, 0.92, 0.86], [0.64, 0.60, 0.57]],
    });
    this.group.add(this.sheep.mesh);
    // charming pastoral foreground framing anchor for pasture vista: mossy alpine pasture boulder pair & weathered split-rail corner fence post!
    {
      const flock = this.sheep.list.slice(0, 10);
      let cxP = 0, czP = 0;
      for (const sh of flock) { cxP += sh.x; czP += sh.z; }
      cxP /= flock.length; czP /= flock.length;
      const hp = this.sheep.list[3];
      const px0 = cxP - 11.5, pz0 = czP + 8.5;
      const yawP = Math.atan2(-(cxP * 0.72 + hp.x * 0.28 - px0), -(czP * 0.72 + hp.z * 0.28 - pz0)) - 0.08;
      const fvx = -Math.sin(yawP), fvz = -Math.cos(yawP);
      const lvx = -Math.cos(yawP), lvz = Math.sin(yawP);
      const pStones = [];
      for (const [f, lt, sx, sy, sz, sd] of [
        [5.4, 2.75, 0.78, 0.48, 0.66, 911],
        [4.9, 2.05, 0.44, 0.30, 0.40, 912],
      ]) {
        const bx = px0 + fvx * f + lvx * lt, bz = pz0 + fvz * f + lvz * lt;
        const g = rockGeometry(sd, 2, 0.64);
        g.scale(sx, sy, sz); g.rotateY(sd * 1.1);
        g.translate(bx, hf.height(bx, bz) - sy * 0.16, bz);
        pStones.push(g);
      }
      const sm = new THREE.Mesh(mergeGeometries(pStones), rockMaterial());
      sm.castShadow = true; sm.receiveShadow = true;
      this.group.add(sm);
      // rustic wooden corner fence post & angled split rails tucked at the lower-left edge
      const pfx = px0 + fvx * 6.2 + lvx * 3.4, pfz = pz0 + fvz * 6.2 + lvz * 3.4;
      const pfy = hf.height(pfx, pfz);
      const pfx2 = pfx + lvx * 2.6 - fvx * 0.9, pfz2 = pfz + lvz * 2.6 - fvz * 0.9;
      const pfy2 = hf.height(pfx2, pfz2);
      const fpParts = [
        box(0.16, 1.32, 0.16, pfx, pfy + 0.48, pfz, WOOD, 0.2, 0.04, -0.05),
        box(0.15, 1.26, 0.15, pfx2, pfy2 + 0.46, pfz2, WOOD, -0.3, -0.03, 0.04),
      ];
      for (const hgt of [0.46, 0.88]) {
        const mx = (pfx + pfx2) / 2, mz = (pfz + pfz2) / 2, my = (pfy + pfy2) / 2 + hgt;
        const len = Math.hypot(pfx - pfx2, pfz - pfz2, pfy - pfy2);
        const rg = new THREE.BoxGeometry(len + 0.28, 0.095, 0.075);
        rg.rotateZ(Math.atan2(pfy - pfy2, Math.hypot(pfx - pfx2, pfz - pfz2)));
        rg.rotateY(-Math.atan2(pfz - pfz2, pfx - pfx2));
        rg.translate(mx, my, mz);
        fpParts.push(colored(rg, hgt > 0.6 ? WOOD : [0.33, 0.21, 0.13]));
      }
      const fm = new THREE.Mesh(mergeGeometries(fpParts), this.mat);
      fm.castShadow = true; fm.receiveShadow = true;
      this.group.add(fm);
    }
    this.horsePos = { x: pts[110][0] + side[0] * 26, z: pts[110][1] + side[1] * 26 };
  }

  update(dt, t, U) {
    const night = U.uNight.value, dusk = U.uDusk.value;
    // Gameplay hearth state drives cottage windows, porch lantern, yard spill, halos & chimney smoke directly.
    const hl = this.hearthLit ?? 0;
    this.glassMat.emissiveIntensity = hl * 1.75;
    this.glassMat.color.setRGB(0.14 + hl * 0.86, 0.19 + hl * 0.66, 0.26 + hl * 0.24);
    if (this.gateLanternMat) {
      this.gateLanternMat.color.setRGB(0.16 + hl * 0.84, 0.20 + hl * 0.66, 0.24 + hl * 0.24);
    }
    if (this.haloMat) this.haloMat.uniforms.uGlow.value = hl * 4.2;

    // Broadcast warm yard light spill to terrain, grass, flowers, fences & cottage walls via main's 3-pool spill uniforms.
    const spillCenter = this.lanternPos;
    U.uWarmLight.value.set(spillCenter.x, spillCenter.y - 0.65, spillCenter.z, hl);
    U.uWarmLight3.value.set(this.frontGlowPos.x, this.frontGlowPos.y - 0.4, this.frontGlowPos.z, hl);
    U.uWarmAxis3.value.copy(this.frontGlowAxis);
    if (this.gateLampPos) U.uWarmLight2.value.set(this.gateLampPos.x, this.gateLampPos.y - 0.9, this.gateLampPos.z, hl);

    // Per-lamp glow & warm halos for the 6 trail lamps.
    for (let i = 0; i < this.trailLamps.length; i++) {
      const lm = this.trailLamps[i];
      lm.litT += ((lm.lit ? 1 : 0) - lm.litT) * Math.min(1, dt * 8.0);
      lm.glassMat.color.setRGB(0.15 + lm.litT * 0.85, 0.19 + lm.litT * 0.65, 0.24 + lm.litT * 0.14);
      lm.haloSprite.visible = lm.litT > 0.01;
      lm.haloSprite.material.opacity = lm.litT * (0.86 + 0.10 * Math.sin(t * 7.5 + i * 1.7));
      lm.haloSprite.scale.setScalar(2.0 + lm.litT * 2.4);
      lm.glintSprite.visible = !lm.lit;
      lm.glintSprite.material.opacity = 0.24 + 0.16 * Math.sin(t * 2.5 + i * 1.3);
    }

    this.smoke.visible = hl > 0.01;
    this.smokeMat.uniforms.uAlpha.value = hl;
    this.smokeMat.uniforms.uTime.value = t;
    this.smokeMat.uniforms.uWind.value.copy(U.uWindDir.value);
    this.smokeMat.uniforms.uTwilight.value = Math.max(night, dusk * 0.55);
    const lc = U.uLightColor.value;
    const k = Math.max(lc.r, lc.g, lc.b) || 1;
    this.smokeMat.uniforms.uLight.value.setRGB(0.55 + 0.45 * lc.r / k, 0.55 + 0.45 * lc.g / k, 0.55 + 0.45 * lc.b / k).multiplyScalar(Math.min(1.1, k * 0.22) + 0.24);
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

  dispose() {
    this.sheep.dispose();
    const mats = new Set();
    for (const m of [this.mat, this.glassMat, this.gateLanternMat, this.haloMat, this.smokeMat]) {
      if (m && m !== this._sharedFoliageMat) mats.add(m);
    }
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && obj.material !== this._sharedFoliageMat) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => { if (m !== this._sharedFoliageMat) mats.add(m); });
        else mats.add(obj.material);
      }
      obj.dispose?.();
    });
    for (const m of mats) m.dispose();
    this.group.removeFromParent();
  }
}

export function createVillage(ctx, deps) {
  const { hf, trail, biome, region } = ctx.data;
  const village = new Village(hf, trail, deps.props, deps.trees, biome, region);
  return {
    instance: village,
    update(frame) {
      if (frame.phase !== 'render') {
        village.update(frame.dt, frame.t, frame.U);
        if (frame.onSheepCheck) frame.onSheepCheck(village.sheep);
      }
      if (frame.phase !== 'sim') {
        village.smokeMat.uniforms.uPix.value = frame.pix;
        village.smokeMat.uniforms.uAmb.value.copy(frame.amb.sky).multiplyScalar(1.4);
        if (village.haloMat) village.haloMat.uniforms.uPix.value = frame.pix;
      }
    },
    dispose() {
      village.dispose();
    },
  };
}
