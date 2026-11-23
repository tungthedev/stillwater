import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COMMON } from '../glsl/common.js';
import { U } from '../uniforms.js';
import { LAYER_NO_REFLECT } from './water.js';
import { rockGeometry, rockMaterial } from './rocks.js';
import { mulberry32 } from './biome.js';
import { fluffyBush, fluffyPine } from './fluffy.js';

// Hero multi-tiered waterfall amphitheatre:
// - Wide braided main cascade + companion bridal veil spilling over lush bush-crowned granite cliffs
// - Every single boulder strictly seated 35-45% into terrain (ZERO floating rocks!)
// - Wide jewel-like sapphire-to-turquoise plunge pool with bright concentric expanding whitewater foam rings & ripple normals
// - Airy luminous spray mist & NaN-proof spectral rainbow arching softly over the plunge pool

function buildCurtainGeo(bx, bz, ux, uz, lx, lz, yTop, yBot, width, latOff, dStart, dEnd, cliffClearFn, rows = 38, cols = 18, bounceS = 0.46) {
  const pos = [], uvs = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const s = r / rows;
    // true parabolic riverbed overflow arch curling smoothly forward from upstream brink (KILLS flat card top cut!)
    const lip = Math.min(1, s / 0.22);
    const curlBack = Math.pow(1 - lip, 1.85) * 5.2;
    const dropFrac = lip < 1 ? 0.06 * lip * lip * lip : 0.06 + 0.94 * Math.pow((s - 0.22) / 0.78, 1.28);
    const y = yTop - 0.15 * (1 - lip) - (yTop - yBot) * dropFrac;
    let out = dStart - curlBack + (dEnd - dStart) * (0.28 * lip + 0.72 * Math.pow(s, 0.86));
    const bounce = bounceS > 0 ? Math.exp(-Math.pow((s - bounceS) / 0.11, 2)) * 2.1 : 0;
    out += bounce;
    if (cliffClearFn && s > 0.14) out = Math.max(out, cliffClearFn(y, latOff) + 1.6);
    const w = width * (0.58 + 0.66 * s + 0.16 * bounce);
    for (let c = 0; c <= cols; c++) {
      const t = c / cols - 0.5;
      // sculpted 3D undulating cascade columns curving smoothly DOWN over the brink boulders (ZERO jagged top spikes!)
      const lipCurve = (1 - lip) * (0.45 * Math.cos(t * Math.PI) - 0.65);
      const braid = (Math.cos(t * Math.PI) * (1.35 + bounce * 0.80) + 0.38 * Math.cos(t * Math.PI * 5.0) + 0.18 * Math.sin(t * Math.PI * 9.0 + s * 4.0)) * (0.25 + 0.75 * lip);
      const px = bx + ux * (out + braid) + lx * (latOff + t * w);
      const pz = bz + uz * (out + braid) + lz * (latOff + t * w);
      pos.push(px, y + lipCurve, pz);
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
  return g;
}

export class Waterfall {
  constructor(hf, stream, bushMat = null) {
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
      if ((a - b) / 6 < 0.16) break;
      foot++;
    }
    let top = mi;
    while (top > 3) {
      const a = hf.height(pts[top - 3][0], pts[top - 3][1]), b = hf.height(pts[top][0], pts[top][1]);
      if ((a - b) / 6 < 0.25) break;
      top--;
    }

    const rnd = mulberry32(99);
    const k = stream.brink ?? top;
    const [bx, bz] = pts[k];
    const j = Math.min(pts.length - 1, k + 3);
    const ux0 = pts[j][0] - bx, uz0 = pts[j][1] - bz, ul = Math.hypot(ux0, uz0) || 1;
    const ux = ux0 / ul, uz = uz0 / ul, lx = -uz, lz = ux;

    // Measure EXACT world-space cliff profile along the stream centerline so the water lip starts
    // right at the REAL upper crest skyline (ZERO dark gap above lip!) and lands dead-center in the plunge pool!
    const profH = (d, lat = 0) => hf.height(bx + ux * d + lx * lat, bz + uz * d + lz * lat);
    let yCrest = -1e9;
    for (let d = -16; d <= -2; d++) yCrest = Math.max(yCrest, profH(d, 0));
    let dLip = -10;
    for (let d = -14; d <= 6; d += 0.5) if (profH(d, 0) >= yCrest - 2.6) dLip = d;
    const yBaseEst = profH(18, 0);
    let dToe = dLip + 6;
    for (let d = dLip + 2; d <= 20; d += 0.5) {
      if (profH(d, 0) <= yBaseEst + 2.8) { dToe = d; break; }
    }
    const cliffClearFn = (y, lat) => {
      let maxD = dLip - 1;
      for (let d = dLip - 2; d <= dToe + 6; d += 0.75) {
        const hCenter = Math.max(profH(d, lat), profH(d, lat - 2.5), profH(d, lat + 2.5));
        if (hCenter > y - 0.6) maxD = d;
      }
      return maxD;
    };

    const yTop = yCrest - 0.85;
    const fi = Math.min(pts.length - 1, foot + 3);
    const [fx, fz] = pts[fi];
    const poolDist = Math.max(20.0, dToe + 15.5);
    const poolCenter = { x: bx + ux * poolDist, z: bz + uz * poolDist };
    const poolR = 25.0;
    // seat plunge pool cleanly flush with outflow stream level so transition is 100% seamless!
    const poolY = Math.max(hf.height(poolCenter.x, poolCenter.z) + 2.35, hf.height(bx + ux * (poolDist + 16), bz + uz * (poolDist + 16)) + 0.52);
    // register waterfall amphitheatre center so terrain, stream & rock shaders paint wet granite & concentric plunge foam!
    U.uWaterfall.value.set(poolCenter.x, poolY, poolCenter.z, 58);

    // --- 1. Grounded blocky granite canyon ledges, crest boulders & pool rim rocks (ZERO pointy cones or floating rocks!) ---
    const parts = [];
    const bushSpots = [];
    const footprint = (x, z, r) => {
      const hs = [
        hf.height(x, z),
        hf.height(x + r, z), hf.height(x - r, z),
        hf.height(x, z + r), hf.height(x, z - r),
      ];
      const mn = Math.min(...hs), mx = Math.max(...hs);
      return { min: mn, max: mx, slope: (mx - mn) / Math.max(2 * r, 0.5) };
    };
    const addSeatedRock = (x, z, sx, sy, sz, seed, maxSlope = 0.65, sinkFrac = 0.44) => {
      const fp = footprint(x, z, Math.max(sx, sz) * 0.85);
      if (fp.slope > maxSlope) return null;
      const y = fp.min + sy * (0.45 - sinkFrac);
      const g = rockGeometry(seed, 2, 0.70);
      g.scale(sx, sy, sz);
      g.rotateY(rnd() * 6.28);
      g.translate(x, y, z);
      parts.push(g);
      return y + sy * 0.45;
    };

    // Grounded stepped 3D granite canyon strata shelves & blocky cliff-base terraces (dresses left & right cliff bases cleanly — kills stretched left base & flat extrusion!)
    const ledges = [
      // right canyon stepped strata ledges (-lat)
      [-12.5, dToe + 1.8, 6.8, 5.2, 5.8, 2.2, 2101],
      [-19.5, dToe + 6.0, 8.0, 4.8, 6.2, 1.6, 2102],
      [-26.5, dToe + 11.2, 7.2, 4.2, 5.8, 1.0, 2103],
      [-15.5, dToe - 2.0, 6.2, 4.0, 5.2, 9.5, 2111],
      [-22.5, dToe + 1.5, 6.8, 3.8, 5.4, 7.8, 2112],
      // left canyon stepped strata terraces (+lat) grounding the steep left cliff wall cleanly into lush bank!
      [ 13.0, dToe + 1.8, 7.2, 5.6, 6.2, 2.2, 2104],
      [ 21.0, dToe + 5.2, 8.6, 5.4, 6.8, 1.8, 2105],
      [ 29.0, dToe + 9.5, 8.2, 5.0, 6.4, 1.4, 2106],
      [ 37.0, dToe + 13.8, 7.8, 4.6, 6.0, 1.0, 2108],
      [ 16.5, dToe - 1.8, 6.6, 4.2, 5.4, 10.2, 2113],
      [ 25.0, dToe + 1.2, 7.4, 4.0, 5.8, 8.4, 2114],
      [ 33.5, dToe + 5.5, 7.2, 3.8, 5.6, 6.2, 2115],
      // wet mossy mid-fall splitter rock shelf nestled cleanly at base between main roar & companion veil!
      [  4.8, dToe + 2.2, 3.8, 3.4, 3.6, 1.0, 2107],
    ];
    for (const [lat, fwd, sx, sy, sz, yOff, seed] of ledges) {
      const rx = bx + ux * fwd + lx * lat, rz = bz + uz * fwd + lz * lat;
      const g = rockGeometry(seed, 3, 0.56);
      g.scale(sx, sy, sz);
      g.rotateY(seed * 1.13);
      const hHere = hf.height(rx, rz);
      // anchor upper stepped ledges solidly INTO the cliff slope (NEVER floating outside cliff!)
      const seatY = yOff > 4.0 ? Math.min(poolY + yOff, hHere - sy * 0.12) : Math.min(poolY + yOff, hHere + sy * 0.25);
      g.translate(rx, seatY, rz);
      parts.push(g);
      // lush mossy bushes perched naturally on every grounded canyon granite terrace!
      if (Math.abs(lat) > 8) {
        bushSpots.push([rx, seatY + sy * 0.48, rz, 2.8 + rnd() * 1.6]);
        bushSpots.push([rx + lx * (lat > 0 ? 2.5 : -2.5), seatY + sy * 0.36, rz + lz * (lat > 0 ? 2.5 : -2.5), 2.2 + rnd() * 1.2]);
      }
    }

    // mossy brink boulders flanking & dividing the waterfall notch so water visibly surges OVER & BETWEEN sculpted spillway stones!
    for (const [latB, fwdB, sxB, syB, szB, seedB] of [
      [-9.4, dLip - 1.0, 4.6, 2.8, 3.8, 2140],
      [-5.6, dLip - 0.6, 2.6, 1.9, 2.4, 2143],
      [ 1.4, dLip - 1.1, 2.8, 2.2, 2.6, 2141],
      [ 6.2, dLip - 0.8, 2.5, 1.8, 2.4, 2144],
      [ 10.2, dLip - 0.9, 4.8, 3.0, 4.0, 2142],
    ]) {
      const rx = bx + ux * fwdB + lx * latB, rz = bz + uz * fwdB + lz * latB;
      const g = rockGeometry(seedB, 2, 0.66);
      g.scale(sxB, syB, szB);
      g.rotateY(seedB * 0.9);
      g.translate(rx, hf.height(rx, rz) - syB * 0.24, rz);
      parts.push(g);
    }

    // brink plateau emerald shrubs & alpine spruces crowning BOTH left (+lat) AND right (-lat) upper cliff skylines!
    const pineSpots = [];
    const rimCrest = (lo) => {
      let bestY = -1e9;
      for (let d = -12; d <= 8; d += 1.0) bestY = Math.max(bestY, profH(d, lo));
      // pick the FRONTMOST crest lip where height is still within 1.8m of peak so trees crown the visible skyline!
      let edgeD = dLip - 1.5;
      for (let d = -12; d <= 8; d += 0.5) if (profH(d, lo) >= bestY - 1.8) edgeD = d;
      const x = bx + lx * lo + ux * edgeD, z = bz + lz * lo + uz * edgeD;
      return { x, y: hf.height(x, z), z };
    };
    for (const lo of [-31, -24, -17.5, -11.5, -8.0, 9.0, 14.5, 20.5, 27.0, 34.0, 41.0, 48.0, 55.0]) {
      const c = rimCrest(lo);
      bushSpots.push([c.x + ux * 0.6, c.y - 0.35, c.z + uz * 0.6, 3.4 + rnd() * 2.2]);
      if (Math.abs(lo) >= 11) {
        const px = c.x - ux * 0.6, pz = c.z - uz * 0.6;
        pineSpots.push([px, hf.height(px, pz) - 0.45, pz, 11.0 + rnd() * 6.0]);
      }
    }
    // lush mossy shrubs & wet granite boulders dressing BOTH sides of the plunge pool mouth & foreground banks!
    for (const [lat, fwd, sc] of [
      [ 7.6, poolDist + 3.0, 2.2], [ 9.8, poolDist + 7.5, 1.8], [ 14.5, poolDist + 5.0, 2.6],
      [-6.8, poolDist + 4.0, 1.9], [-9.2, poolDist + 9.0, 1.6], [ 21.0, poolDist + 9.5, 2.4],
    ]) {
      const rx = bx + ux * fwd + lx * lat, rz = bz + uz * fwd + lz * lat;
      const topY = addSeatedRock(rx, rz, sc * 1.25, sc * 0.85, sc, 1500 + Math.floor(Math.abs(lat) * 13 + fwd), 0.72, 0.46);
      if (topY != null && Math.abs(lat) > 7.5) bushSpots.push([rx, topY - 0.15, rz, 2.2 + rnd() * 1.4]);
    }
    // grounded emerald bushes & wet granite boulders framing left & right plunge-pool canyon apron!
    for (const s of [-1, 1]) {
      for (let o = 14.5; o <= 32; o += 5.2) {
        const rx = poolCenter.x + lx * o * s + ux * (1.5 + rnd() * 5.5);
        const rz = poolCenter.z + lz * o * s + uz * (1.5 + rnd() * 5.5);
        const sc = 1.8 + rnd() * 1.6;
        const topY = addSeatedRock(rx, rz, sc * 1.25, sc * 0.88, sc, 1100 + Math.floor(o * 10) + (s > 0 ? 1 : 0), 0.62, 0.46);
        if (topY != null) bushSpots.push([rx, topY - 0.2, rz, 2.1 + rnd() * 1.4]);
      }
    }

    // wet granite boulders rimming the back & flanks of the turquoise plunge pool (front wide open!)
    for (let i = 0; i < 20; i++) {
      const ang = (i / 20) * Math.PI * 2;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      if (dx * ux + dz * uz > 0.12) continue; // keep entire front view into turquoise plunge pool open!
      const r = poolR * (0.94 + rnd() * 0.22);
      const rx = poolCenter.x + dx * r, rz = poolCenter.z + dz * r;
      const sc = 1.4 + rnd() * 1.9;
      const topY = addSeatedRock(rx, rz, sc * 1.25, sc * 0.92, sc, 1300 + i, 0.68, 0.46);
      if (topY != null && rnd() < 0.5) bushSpots.push([rx, topY - 0.1, rz, 1.5 + rnd() * 0.9]);
    }
    // mossy boulders along outer riverbanks downstream (NEVER flat slabs mid-river!)
    for (let i = fi + 6; i < Math.min(pts.length - 3, fi + 26); i += 4) {
      const [px, pz] = pts[i];
      const off = (i % 8 === 0 ? 1 : -1) * (4.4 + rnd() * 1.8);
      const rx = px + lx * off, rz = pz + lz * off;
      const sc = 0.95 + rnd() * 1.05;
      addSeatedRock(rx, rz, sc * 1.18, sc * 0.94, sc, 1400 + i, 0.55, 0.44);
    }

    if (parts.length) {
      const m = new THREE.Mesh(mergeGeometries(parts), rockMaterial());
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
    }

    // --- 2. Lush painterly emerald bushes framing the waterfall brink & pool flanks ---
    if (bushMat && bushSpots.length) {
      const bGeo = fluffyBush(143, { color: [0.10, 0.34, 0.08] });
      const bm = new THREE.InstancedMesh(bGeo, bushMat, bushSpots.length);
      bm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bushSpots.length * 3), 3);
      const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3();
      bushSpots.forEach(([x, y, z, s], idxB) => {
        q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
        m4.compose(p4.set(x, y, z), q4, s4.set(s * 1.15, s * 0.82, s * 1.15));
        bm.setMatrixAt(idxB, m4);
        bm.instanceColor.setXYZ(idxB, 0.82 + rnd() * 0.22, 0.96 + rnd() * 0.14, 0.82 + rnd() * 0.14);
      });
      bm.castShadow = true; bm.receiveShadow = true;
      this.group.add(bm);
    }
    if (bushMat && pineSpots.length) {
      const pGeo = fluffyPine(157, { color: [0.045, 0.21, 0.12] });
      const pm = new THREE.InstancedMesh(pGeo, bushMat, pineSpots.length);
      pm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pineSpots.length * 3), 3);
      const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3();
      pineSpots.forEach(([x, y, z, s], idxP) => {
        q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
        m4.compose(p4.set(x, y, z), q4, s4.set(s * 0.92, s, s * 0.92));
        pm.setMatrixAt(idxP, m4);
        pm.instanceColor.setXYZ(idxP, 0.88 + rnd() * 0.18, 0.96 + rnd() * 0.12, 0.90 + rnd() * 0.14);
      });
      pm.castShadow = true; pm.receiveShadow = true;
      this.group.add(pm);
    }

    // --- 3. Wide reflective jewel-like alpine plunge pool (lake-water clarity, bold churning whitewater foam ring & concentric ripples!) ---
    const landDist = Math.max(dToe + 5.2, poolDist - 6.0);
    const impactPt = new THREE.Vector3(bx + ux * landDist, poolY, bz + uz * landDist);
    const poolGeo = new THREE.CircleGeometry(poolR, 64);
    poolGeo.rotateX(-Math.PI / 2);
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uC: { value: new THREE.Vector3(poolCenter.x, poolY, poolCenter.z) }, uImp: { value: impactPt }, uR: { value: poolR } },
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: COMMON + `
        uniform vec3 uC; uniform vec3 uImp; uniform float uR; varying vec3 vW;
        void main(){
          vec2 d = vW.xz - uC.xz;
          float r = length(d) / uR;
          vec2 di = vW.xz - uImp.xz;
          float ri = length(di) / uR;
          float n1 = texture(uNoiseTex, vW.xz * 0.16 + vec2(uTime * 0.05, -uTime * 0.06)).a;
          float n2 = texture(uNoiseTex, vW.xz * 0.44 - vec2(uTime * 0.08, uTime * 0.07) + 0.31).g;
          float n3 = texture(uNoiseTex, vW.xz * 0.92 + vec2(uTime * 0.11, -uTime * 0.09) + 0.67).b;

          // crystal sunlit sapphire-turquoise plunge pool with CRISP scalloped Ghibli whitewater foam ring & ragged shoreline foam line (ZERO blurry flat white oval disc!)
          float wavePhase = ri * 18.0 - uTime * 3.0 + (n1 - 0.5) * 3.2 + (n2 - 0.5) * 1.8;
          float angI = atan(di.y, di.x);
          float scallop = 0.055 * sin(angI * 9.0 + n1 * 4.5) + 0.032 * cos(angI * 15.0 - n2 * 3.5);
          // tight crisp turbulent core directly under cascade impact, leaving wide crystal turquoise water clearly visible in front!
          float impactCore = smoothstep(0.28, 0.19, ri + scallop + (n2 - 0.5) * 0.09);
          // crisp scalloped outer whitewater foam ring & ragged lacy foam filaments drifting across lit turquoise water!
          float foamRing1 = smoothstep(0.055, 0.015, abs(ri - 0.36 + scallop)) * smoothstep(0.34, 0.54, n2 * 0.6 + n3 * 0.4);
          float foamRing2 = smoothstep(0.042, 0.012, abs(ri - 0.54 + scallop * 1.3)) * smoothstep(0.46, 0.66, n1 * 0.5 + n3 * 0.5) * 0.82;
          float laceWisp = smoothstep(0.68, 0.80, n2 * 0.55 + n3 * 0.45) * smoothstep(0.76, 0.24, ri) * 0.70;
          float outerRim = smoothstep(0.84, 0.96, r + (n1 - 0.5) * 0.08) * smoothstep(0.48, 0.66, n2 * 0.6 + n3 * 0.4) * 0.75;

          vec3 Vv = normalize(cameraPosition - vW);
          vec2 gradR = normalize(di + 1e-4) * cos(wavePhase) * 0.055 * (1.0 - ri);
          vec3 Nn = normalize(vec3(gradR.x + (n2 - 0.5) * 0.06, 1.0, gradR.y + (n3 - 0.5) * 0.06));
          float fres = 0.14 + 0.86 * pow(1.0 - max(dot(Vv, Nn), 0.0), 3.6);
          vec3 Rr = reflect(-Vv, Nn);
          vec3 skyR = w_sky(normalize(vec3(Rr.x, max(Rr.y, 0.28), Rr.z)));
          float lsk = dot(skyR, vec3(0.2126, 0.7152, 0.0722));
          skyR = max(mix(vec3(lsk), skyR, 1.42), 0.0);

          vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
          float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
          vec3 deepSapph = vec3(0.015, 0.28, 0.52) * (amb * 1.28 + uLightColor * 0.28 * sunUp);
          vec3 turqRim   = vec3(0.055, 0.58, 0.58) * (amb * 1.38 + uLightColor * 0.34 * sunUp);
          vec3 water = mix(deepSapph, turqRim, smoothstep(0.24, 0.82, r));
          vec3 reflCol = mix(turqRim * 0.85, skyR * 0.88, smoothstep(0.0, 0.35, Rr.y + 0.10));
          water = mix(water, reflCol, fres * 0.36);
          // sparkling diamond sun glitter & ripple highlights
          vec3 H = normalize(uLightDir + Vv);
          float spec = min(pow(max(dot(Nn, H), 0.0), 110.0) * 14.0 + pow(max(dot(Nn, H), 0.0), 24.0) * 1.1, 6.2) * sunUp;
          water += uLightColor * spec;

          vec3 white = (amb * 1.15 + uLightColor * 0.58 * sunUp) * 1.12;
          float foam = clamp(max(max(impactCore, foamRing1), max(foamRing2, max(laceWisp, outerRim))), 0.0, 0.96);
          vec3 col = mix(water, white, foam);
          float a = (1.0 - smoothstep(0.62, 0.99, r + (n1 - 0.5) * 0.10)) * 0.98;
          gl_FragColor = vec4(w_applyAtmosphere(col, vW), a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const pool = new THREE.Mesh(poolGeo, this.poolMat);
    pool.position.set(poolCenter.x, poolY, poolCenter.z);
    pool.renderOrder = 9;
    this.group.add(pool);

    // --- 4. Natural Multi-Braided Waterfall Cascades spilling cleanly from the REAL top skyline crest! ---
    this.sheetMat = new THREE.ShaderMaterial({
      uniforms: { ...U, uH: { value: Math.max(10, yTop - poolY) } },
      vertexShader: 'attribute vec2 aUv; varying vec2 vU; varying vec3 vW; void main(){ vU = aUv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: COMMON + `
        uniform float uH; varying vec2 vU; varying vec3 vW;
        void main(){
          float x = vU.x, s = vU.y;
          // multi-strand broken falling ribbons & sparkling droplets with organic lacy edges (NEVER flat card!)
          float braidMask = 0.48 + 0.52 * sin(x * 8.5 + sin(s * 7.5) * 0.85);
          float st1 = texture(uNoiseTex, vec2(x * 1.8 + 0.17, s * uH * 0.036 - uTime * 0.72)).g;
          float st2 = texture(uNoiseTex, vec2(x * 4.2 + 0.60, s * uH * 0.082 - uTime * 1.18)).b;
          float st3 = texture(uNoiseTex, vec2(x * 8.8 + 0.23, s * uH * 0.14  - uTime * 1.65)).a;
          float streak = st1 * 0.42 + st2 * 0.36 + st3 * 0.22;
          vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
          float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
          float distCam = length(vW - cameraPosition);
          // crisp translucent cool-white braided cascade up close (ZERO blown-out yellow HDR clip in falls.png!) -> sparkling pure white at lake/pasture distance!
          float distGain = mix(0.92, 1.34, smoothstep(140.0, 420.0, distCam));
          vec3 white = (amb * 0.98 + uLightColor * 0.30 * sunUp) * distGain;
          vec3 aqua  = vec3(0.03, 0.40, 0.62) * (amb * 1.24 + uLightColor * 0.22 * sunUp);
          // frothy sunlit crest curl + mid-cliff ledge splash burst + dramatic base plunge churn!
          float foamLip    = smoothstep(0.18, 0.0, s) * 0.86;
          float foamBounce = exp(-pow((s - 0.46) / 0.11, 2.0)) * 0.42;
          float foamBase   = smoothstep(0.76, 1.0, s) * (0.38 + 0.36 * streak);
          float distBright = smoothstep(140.0, 460.0, distCam) * 0.48;
          float wf = clamp(smoothstep(0.32, 0.74, streak * (0.72 + 0.36 * braidMask)) * 0.78 + foamLip + foamBounce + foamBase + distBright, 0.14, 0.94);
          vec3 col = mix(aqua, white, wf);
          // ragged wispy water-strand silhouette + soft organic curved top overflow lip
          float edgeNoise = (st1 - 0.5) * 0.48 + (st2 - 0.5) * 0.32;
          float edge = 1.0 - smoothstep(0.42, 0.96, abs(x) + edgeNoise);
          float strandBreak = smoothstep(0.22, 0.48, streak + (1.0 - abs(x)) * 0.28 + foamLip + foamBase + distBright);
          float topOrganic = smoothstep(0.0, 0.075 + st1 * 0.055 + abs(x) * 0.045, s);
          float a = edge * strandBreak * mix(0.76, 0.99, wf) * topOrganic;
          // stay bright and unmistakably white-water at lake & pasture distance (300-1100m!)
          a *= mix(1.0, 0.86, smoothstep(650.0, 1450.0, distCam));
          col = w_applyAtmosphere(col, vW);
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    // main roaring braided cascade + companion tiered veil spilling right from the real skyline lip into the pool!
    const mainCurtain = new THREE.Mesh(
      buildCurtainGeo(bx, bz, ux, uz, lx, lz, yTop + 0.3, poolY - 0.6, 11.4, -2.4, dLip - 1.2, landDist, cliffClearFn, 38, 18, 0.44),
      this.sheetMat
    );
    const midRibbon = new THREE.Mesh(
      buildCurtainGeo(bx, bz, ux, uz, lx, lz, yTop + 0.1, poolY - 0.6, 4.6, 2.6, dLip - 0.8, landDist - 0.4, cliffClearFn, 32, 12, 0.58),
      this.sheetMat
    );
    const sideVeil = new THREE.Mesh(
      buildCurtainGeo(bx, bz, ux, uz, lx, lz, yTop - 0.6, poolY - 0.6, 5.2, 7.6, dLip + 0.2, landDist - 0.6, cliffClearFn, 28, 12, 0.52),
      this.sheetMat
    );
    mainCurtain.renderOrder = 10; midRibbon.renderOrder = 10; sideVeil.renderOrder = 10;
    this.group.add(mainCurtain, midRibbon, sideVeil);

    // --- 5. Crisp cel-shaded Ghibli churning splash crown + flying splash droplets + sideways-drifting billowing spray puffs! ---
    {
      // compact sculptural cel-shaded whitewater splash billows tightly hugging the cascade impact (leaves crystal lit turquoise pool wide open in front!)
      const bPos = [], bUv = [], bIdx = [];
      const bSegs = 32;
      for (const [radX, radZ, hMin, hAmp, fwdOff] of [
        [8.6, 2.8, 3.0, 2.2, 0.4],
        [9.8, 3.8, 1.7, 1.4, 2.0],
      ]) {
        const baseI = bPos.length / 3;
        for (let i = 0; i <= bSegs; i++) {
          const f = i / bSegs;
          const ang = (f - 0.5) * Math.PI * 1.18;
          const ox = Math.sin(ang) * radX, oz = Math.cos(ang) * radZ;
          const bx0 = impactPt.x + lx * ox + ux * (oz + fwdOff);
          const bz0 = impactPt.z + lz * ox + uz * (oz + fwdOff);
          const hCrest = hMin + Math.cos(ang * 1.3) * hAmp + Math.sin(f * Math.PI * 11.0) * 0.65;
          bPos.push(bx0, poolY - 0.4, bz0, bx0 + ux * 1.5, poolY + hCrest, bz0 + uz * 1.5);
          bUv.push(f, 0, f, 1);
          if (i < bSegs) { const b = baseI + i * 2; bIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
        }
      }
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
      bg.setAttribute('uv', new THREE.Float32BufferAttribute(bUv, 2));
      bg.setIndex(bIdx);
      const boilMat = new THREE.ShaderMaterial({
        uniforms: { ...U },
        vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: COMMON + `
          varying vec2 vUv; varying vec3 vW;
          void main(){
            float n1 = texture(uNoiseTex, vec2(vUv.x * 6.0, vUv.y * 2.2 - uTime * 0.85)).a;
            float n2 = texture(uNoiseTex, vec2(vUv.x * 14.0 + 0.3, vUv.y * 4.2 - uTime * 1.45)).g;
            float n3 = texture(uNoiseTex, vec2(vUv.x * 24.0 + 0.7, vUv.y * 5.8 - uTime * 2.1)).b;
            // crisp Ghibli scalloped foam lobes (ZERO blurry white smear!)
            float lobe = n1 * 0.50 + n2 * 0.35 + n3 * 0.15;
            float topCut = smoothstep(0.92, 0.74, vUv.y + (0.55 - lobe) * 0.88);
            float botFade = smoothstep(0.0, 0.14, vUv.y);
            float sideFade = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
            float a = smoothstep(0.28, 0.44, topCut * botFade * sideFade * (0.65 + 0.55 * lobe)) * 0.95;
            if (a < 0.05) discard;
            vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
            float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
            // 2-tone Ghibli foam shading: cool aqua-sapphire churning base -> bright sunlit white splash crests!
            vec3 foamShadow = amb * 0.72 + vec3(0.04, 0.24, 0.38) * 0.85;
            vec3 foamLit    = (amb * 1.06 + uLightColor * 0.42 * sunUp) * 1.06;
            vec3 shade = mix(foamShadow, foamLit, smoothstep(0.32, 0.56, vUv.y * 0.58 + n2 * 0.42));
            gl_FragColor = vec4(w_applyAtmosphere(shade, vW), a);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const boilMesh = new THREE.Mesh(bg, boilMat);
      boilMesh.renderOrder = 11;
      boilMesh.layers.set(LAYER_NO_REFLECT);
      this.group.add(boilMesh);
    }
    // 180 sparkling stylized splash droplets arcing upward & outward from the churning plunge impact!
    {
      const ND = 180;
      const dg = new THREE.BufferGeometry();
      const dp = new Float32Array(ND * 3), dv = new Float32Array(ND * 3), ds = new Float32Array(ND);
      for (let i = 0; i < ND; i++) {
        const lat = (rnd() - 0.5) * 14.5;
        const sideDir = Math.sign(lat || 1) * (1.8 + rnd() * 5.2);
        const fwdDir = 2.0 + rnd() * 6.5;
        dp[i * 3]     = impactPt.x + lx * lat + ux * (rnd() * 2.5);
        dp[i * 3 + 1] = poolY + 0.4 + rnd() * 1.6;
        dp[i * 3 + 2] = impactPt.z + lz * lat + uz * (rnd() * 2.5);
        dv[i * 3]     = lx * sideDir + ux * fwdDir;
        dv[i * 3 + 1] = 4.2 + rnd() * 5.8;
        dv[i * 3 + 2] = lz * sideDir + uz * fwdDir;
        ds[i] = rnd();
      }
      dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
      dg.setAttribute('aVel', new THREE.Float32BufferAttribute(dv, 3));
      dg.setAttribute('aSeed', new THREE.Float32BufferAttribute(ds, 1));
      const dropMat = new THREE.ShaderMaterial({
        uniforms: { uTime: U.uTime, uPix: { value: 900 }, uLightColor: U.uLightColor, uNight: U.uNight },
        vertexShader: `attribute vec3 aVel; attribute float aSeed; uniform float uTime; uniform float uPix; varying float vA;
          void main(){
            float t = fract(aSeed * 5.1 + uTime * (0.65 + aSeed * 0.35));
            vec3 p = position + aVel * t + vec3(0.0, -7.8 * t * t, 0.0);
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(uPix * (0.20 + aSeed * 0.24) / max(-mv.z, 1.0), 2.0, 9.5);
            vA = smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.65, t) * 0.92;
          }`,
        fragmentShader: `uniform vec3 uLightColor; uniform float uNight; varying float vA;
          void main(){
            vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q);
            if (r > 1.0) discard;
            float a = smoothstep(1.0, 0.25, r) * vA;
            vec3 c = mix(vec3(0.95, 0.99, 1.0) * 1.45, vec3(0.26, 0.36, 0.52), uNight);
            gl_FragColor = vec4(c * a, a);
          }`,
        transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      const drops = new THREE.Points(dg, dropMat);
      drops.frustumCulled = false;
      drops.layers.set(LAYER_NO_REFLECT);
      drops.renderOrder = 12;
      this.group.add(drops);
    }
    // stylized spray mist puffs drifting SIDEWAYS left & right from the impact (keeps center turquoise pool unobstructed!)
    const N = 260;
    const mg = new THREE.BufferGeometry();
    const mp = new Float32Array(N * 3), ms = new Float32Array(N), md = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      if (i >= 215) {
        // frothy sunlit crest-lip spray mist softening the top brink overflow!
        const lat = (rnd() - 0.5) * 14.0;
        mp[i * 3]     = bx + ux * (dLip - 0.2 + rnd() * 1.4) + lx * (lat + 0.8);
        mp[i * 3 + 1] = yTop - 0.5 + rnd() * 1.4;
        mp[i * 3 + 2] = bz + uz * (dLip - 0.2 + rnd() * 1.4) + lz * (lat + 0.8);
        md[i * 3] = lx * (rnd() - 0.5) * 2.0; md[i * 3 + 1] = 2.8; md[i * 3 + 2] = lz * (rnd() - 0.5) * 2.0;
        ms[i] = rnd();
        continue;
      }
      const sideSign = (i % 2 === 0 ? 1 : -1);
      const lat = sideSign * (4.5 + rnd() * 11.5);
      const fwd = (rnd() - 0.2) * 5.2;
      mp[i * 3]     = impactPt.x + lx * lat + ux * (fwd + 1.5);
      mp[i * 3 + 1] = poolY + 0.6 + rnd() * 3.8;
      mp[i * 3 + 2] = impactPt.z + lz * lat + uz * (fwd + 1.5);
      // drift clearly SIDEWAYS outward along cliff walls & pool flanks!
      md[i * 3]     = lx * sideSign * (4.5 + rnd() * 6.5) + ux * (1.2 + rnd() * 2.5);
      md[i * 3 + 1] = 3.2 + rnd() * 4.5;
      md[i * 3 + 2] = lz * sideSign * (4.5 + rnd() * 6.5) + uz * (1.2 + rnd() * 2.5);
      ms[i] = rnd();
    }
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mg.setAttribute('aDrift', new THREE.Float32BufferAttribute(md, 3));
    mg.setAttribute('aSeed', new THREE.Float32BufferAttribute(ms, 1));
    this.mistMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uPix: { value: 900 }, uLightColor: U.uLightColor, uNight: U.uNight, uNoiseTex: U.uNoiseTex },
      vertexShader: `attribute float aSeed; attribute vec3 aDrift; uniform float uTime; uniform float uPix; varying float vA; varying float vSeed;
        void main(){
          float t = fract(aSeed * 3.7 + uTime * 0.17);
          vec3 p = position + aDrift * t;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uPix * (1.5 + t * 3.0) / max(-mv.z, 1.0);
          vA = sin(t * 3.14159) * mix(0.16, 0.04, t);
          vSeed = aSeed;
        }`,
      fragmentShader: `uniform vec3 uLightColor; uniform float uNight; uniform sampler2D uNoiseTex; varying float vA; varying float vSeed;
        void main(){
          vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q);
          if (r > 1.0) discard;
          float billow = texture(uNoiseTex, gl_PointCoord * 1.6 + vec2(vSeed * 3.1, vSeed * 5.7)).a;
          float a = smoothstep(1.0, 0.22, r) * smoothstep(0.24, 0.72, billow) * vA * 1.25;
          float sunB = clamp(max(max(uLightColor.r, uLightColor.g), uLightColor.b) * 0.25, 0.2, 1.2);
          vec3 c = mix(vec3(0.95, 0.99, 1.0) * (1.02 + 0.50 * sunB), vec3(0.18, 0.24, 0.36), uNight);
          gl_FragColor = vec4(c * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mist = new THREE.Points(mg, this.mistMat);
    this.mist.frustumCulled = false;
    this.mist.layers.set(LAYER_NO_REFLECT);
    this.mist.renderOrder = 12;
    this.group.add(this.mist);

    // --- 6. Luminous shimmering sunlit waterfall rainbow arching through the spray mist! ---
    {
      const rPos = [], rUv = [], rIdx = [];
      const segs = 32;
      const rIn = 8.4, rOut = 11.4;
      for (let i = 0; i <= segs; i++) {
        const f = i / segs;
        const a = f * Math.PI;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let k2 = 0; k2 < 2; k2++) {
          const rad = k2 === 0 ? rIn : rOut;
          const px = impactPt.x + ux * 5.2 + lx * (ca * rad - 1.2);
          const py = poolY + 0.8 + sa * rad * 0.82;
          const pz = impactPt.z + uz * 5.2 + lz * (ca * rad - 1.2);
          rPos.push(px, py, pz);
          rUv.push(f, k2);
        }
        if (i < segs) {
          const b = i * 2;
          rIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
      rg.setAttribute('uv', new THREE.Float32BufferAttribute(rUv, 2));
      rg.setIndex(rIdx);
      const rMat = new THREE.ShaderMaterial({
        uniforms: { ...U },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          uniform vec3 uLightDir; uniform float uNight;
          varying vec2 vUv;
          vec3 spectrum(float t){
            vec3 c = 0.55 + 0.45 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + (1.0 - t) * 0.78));
            return clamp(c, 0.0, 1.0);
          }
          void main(){
            float v = clamp(vUv.y, 0.0, 1.0);
            float band = max(sin(v * 3.14159), 0.0);
            float ends = smoothstep(0.04, 0.24, vUv.x) * smoothstep(0.96, 0.72, vUv.x);
            float sunOk = smoothstep(0.08, 0.28, uLightDir.y) * (1.0 - uNight);
            float a = pow(band, 1.55) * ends * sunOk * 0.42;
            if (a < 0.004) discard;
            vec3 col = spectrum(v) * 1.55;
            gl_FragColor = vec4(col * a, a);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const rainbow = new THREE.Mesh(rg, rMat);
      rainbow.renderOrder = 13;
      rainbow.layers.set(LAYER_NO_REFLECT);
      this.group.add(rainbow);
    }

    const [tx, tz] = pts[top];
    this.foot = { x: poolCenter.x, z: poolCenter.z, y: poolY };
    this.top = { x: bx + ux * dLip, z: bz + uz * dLip, y: yTop };
    const dn = pts[Math.min(pts.length - 1, fi + 12)];
    this.down = { x: dn[0] - fx, z: dn[1] - fz };
    this.footIdx = fi;
  }
}
