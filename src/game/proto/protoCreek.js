import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COMMON } from '../../glsl/common.js';
import { U } from '../../uniforms.js';
import { WORLD } from '../../config.js';
import { rockGeometry, rockMaterial } from '../../world/rocks.js';
import { mulberry32 } from '../../world/biome.js';

// Valley tributary creek & broken timber footbridge across the trailhead-to-lake trail.
// Because the main waterfall stream feeds the far side of Stillwater Lake and never crosses
// the lower trail, this module carves a natural downhill creek crossing at trail index ~430
// (where East is uphill and West drops steadily toward the lake), renders flowing water + bank
// stones, builds a 3-plank broken bridge with ghost deck bays, places 3 washed-away planks
// within 60 m downstream, and enforces a real physical crossing blocker until all 3 planks are set.

const BRIDGE_TRAIL_IDX = 430;
const CREEK_HALF_LEN = 72; // 72m uphill to 72m downhill (covers all 3 planks + full crossing blocker)
const BRIDGE_LEN = 9.4;
const BRIDGE_W = 2.05;

function sampleH(h, x, z, region = WORLD) {
  const { res, size } = region;
  const fx = Math.min(res - 1.001, Math.max(0, (x / size + 0.5) * res - 0.5));
  const fz = Math.min(res - 1.001, Math.max(0, (z / size + 0.5) * res - 0.5));
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz, i = iz * res + ix;
  return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - tz) + (h[i + res] * (1 - tx) + h[i + res + 1] * tx) * tz;
}

function colored(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = rgb[0];
    c[i * 3 + 1] = rgb[1];
    c[i * 3 + 2] = rgb[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function box(w, h, d, x, y, z, rgb, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return colored(g, rgb);
}

export function planValleyCreek(heights, trail, region = WORLD) {
  const pts = trail.points;
  const idx = Math.min(pts.length - 10, Math.max(10, BRIDGE_TRAIL_IDX));
  const [cx, cz] = pts[idx];
  const a = pts[idx + 4], b = pts[idx - 4];
  const dx = a[0] - b[0], dz = a[1] - b[1];
  const l = Math.hypot(dx, dz) || 1;
  // ux, uz points forward along the trail toward the lake
  const ux = dx / l, uz = dz / l;
  // perpendicular to trail; pick downhill side as positive downstream direction
  let px = -uz, pz = ux;
  const hPos = sampleH(heights, cx + px * 18, cz + pz * 18, region);
  const hNeg = sampleH(heights, cx - px * 18, cz - pz * 18, region);
  if (hPos > hNeg) { px = -px; pz = -pz; }

  // Build gently winding creek centerline from -CREEK_HALF_LEN (uphill) to +CREEK_HALF_LEN (downstream)
  const creekPts = [];
  for (let s = -CREEK_HALF_LEN; s <= CREEK_HALF_LEN; s += 2.0) {
    // Keep the immediate bridge crossing (+/- 10m) straight, meander gently upstream & downstream
    const bendMask = Math.min(1, Math.max(0, (Math.abs(s) - 9) / 14));
    const sway = Math.sin(s * 0.085) * 4.2 * bendMask;
    const x = cx + px * s + ux * sway;
    const z = cz + pz * s + uz * sway;
    creekPts.push([x, z, s]);
  }

  return {
    bridgeIdx: idx,
    x: cx,
    z: cz,
    ux,
    uz,
    ry: Math.atan2(ux, uz),
    downX: px,
    downZ: pz,
    points: creekPts,
  };
}

export function carveValleyCreek(heights, mask, creek, region = WORLD) {
  if (!creek) return;
  const { res, size } = region;
  const texel = size / res;
  const pts = creek.points;
  const n = pts.length;
  const bankH = pts.map(([x, z]) => sampleH(heights, x, z, region));
  // Keep centerline gently descending from uphill to downhill
  for (let i = 1; i < n; i++) bankH[i] = Math.min(bankH[i], bankH[i - 1] - 0.04);

  const carveW = 4.6;
  const bedDepth = 1.65;
  const rt = Math.ceil((carveW + 2.5) / texel);
  const target = new Float32Array(heights);

  for (let i = 0; i < n; i++) {
    const [sx, sz, sVal] = pts[i];
    const centerBase = bankH[i];
    const endFade = Math.min(1, Math.min((sVal + CREEK_HALF_LEN) / 14, (CREEK_HALF_LEN - sVal) / 14));
    const cx = Math.round((sx / size + 0.5) * res - 0.5);
    const cz = Math.round((sz / size + 0.5) * res - 0.5);
    for (let dz = -rt; dz <= rt; dz++) {
      for (let dx = -rt; dx <= rt; dx++) {
        const ix = cx + dx, iz = cz + dz;
        if (ix < 0 || iz < 0 || ix >= res || iz >= res) continue;
        const wx = (ix + 0.5) / res * size - size / 2;
        const wz = (iz + 0.5) / res * size - size / 2;
        const d = Math.hypot(wx - sx, wz - sz);
        if (d > carveW + 1.5) continue;
        const t = Math.max(0, 1 - d / carveW);
        const w = t * t * (3 - 2 * t) * endFade;
        const j = iz * res + ix;
        const goal = centerBase - bedDepth * w;
        if (goal < target[j]) target[j] = goal;
        if (d < carveW * 0.92 && endFade > 0.25) {
          mask[j] = Math.min(mask[j], -Math.min(1, t * 1.4));
        }
      }
    }
  }
  for (let i = 0; i < heights.length; i++) heights[i] = target[i];
}

const CREEK_VERT = /* glsl */ `
attribute vec2 aFlow;
varying vec2 vFlow;
varying vec3 vWPos;
void main() {
  vFlow = aFlow;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CREEK_FRAG = /* glsl */ `
${COMMON}
varying vec2 vFlow;
varying vec3 vWPos;
void main() {
  float across = abs(vFlow.x);
  vec2 uv1 = vec2(vFlow.x * 0.55, vFlow.y * 0.08 - uTime * 0.22);
  vec2 uv2 = vec2(vFlow.x * 1.25, vFlow.y * 0.16 - uTime * 0.40);
  float n1 = texture(uNoiseTex, uv1).b;
  float n2 = texture(uNoiseTex, uv2 + 0.37).g;
  float foam = smoothstep(0.64, 0.88, n1 * 0.55 + n2 * 0.45) * 0.65;
  foam = max(foam, smoothstep(0.76, 0.95, across + (n2 - 0.5) * 0.18) * 0.55);

  vec3 amb = w_sky(vec3(0.0, 1.0, 0.0));
  float sunUp = clamp(uLightDir.y * 3.0, 0.0, 1.0);
  vec3 shallow = vec3(0.06, 0.52, 0.56);
  vec3 deep = vec3(0.025, 0.23, 0.46);
  float center = 1.0 - smoothstep(0.05, 0.85, across);
  vec3 body = mix(shallow, deep, center) * (amb * 1.3 + uLightColor * 0.28 * sunUp);
  vec3 white = (amb * 1.15 + uLightColor * 0.55 * sunUp) * 1.12;

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 N = normalize(vec3((n1 - 0.5) * 0.14, 1.0, (n2 - 0.5) * 0.14));
  vec3 H = normalize(uLightDir + V);
  float spec = pow(max(dot(N, H), 0.0), 90.0) * 3.5 * sunUp * (1.0 - foam * 0.5);

  vec3 col = mix(body, white, foam * 0.88) + uLightColor * spec;
  float edge = 1.0 - smoothstep(0.68, 1.0, across + (n2 - 0.5) * 0.16);
  float a = edge * mix(0.62, 0.94, max(center * 0.7, foam));
  col = w_applyAtmosphere(col, vWPos);
  gl_FragColor = vec4(col, a);
}
`;

export function createProtoCreek({ scene, hf, material, creekPlan }) {
  const group = new THREE.Group();
  const rnd = mulberry32(812);
  const { x: cx, z: cz, ux, uz, ry, downX, downZ, points } = creekPlan;

  // --- 1. Flowing creek water ribbon ---
  const pos = [], flow = [], idx = [];
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    const [px, pz, sVal] = points[i];
    const j = Math.min(points.length - 1, i + 1);
    const k = Math.max(0, i - 1);
    const tx = points[j][0] - points[k][0], tz = points[j][1] - points[k][1];
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl, sz = tx / tl;
    if (i > 0) dist += Math.hypot(px - points[i - 1][0], pz - points[i - 1][1]);
    const endW = Math.min(1, Math.min((sVal + CREEK_HALF_LEN) / 10, (CREEK_HALF_LEN - sVal) / 10));
    const w = (2.6 + Math.sin(i * 0.35) * 0.35) * (0.4 + 0.6 * endW);
    const yBed = hf.height(px, pz);
    const yWater = Math.max(WORLD.waterLevel + 0.05, yBed + 0.72);
    for (const s of [-1, -0.5, 0, 0.5, 1]) {
      pos.push(px + sx * w * s, yWater, pz + sz * w * s);
      flow.push(s, dist);
    }
    if (i < points.length - 1) {
      const b = i * 5;
      for (let c = 0; c < 4; c++) {
        idx.push(b + c, b + 5 + c, b + c + 1, b + c + 1, b + 5 + c, b + 6 + c);
      }
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  wg.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 2));
  wg.setIndex(idx);
  wg.computeBoundingSphere();
  const waterMat = new THREE.ShaderMaterial({
    uniforms: { ...U },
    vertexShader: CREEK_VERT,
    fragmentShader: CREEK_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const waterMesh = new THREE.Mesh(wg, waterMat);
  waterMesh.renderOrder = 8;
  group.add(waterMesh);

  // --- 2. Natural creek bank boulders (visually grounds the washed-out gully!) ---
  const stones = [];
  for (let i = 3; i < points.length - 3; i += 2) {
    const [px, pz, sVal] = points[i];
    if (Math.abs(sVal) < 4.5) continue; // keep bridge abutments clear
    const j = Math.min(points.length - 1, i + 1);
    const tx = points[j][0] - px, tz = points[j][1] - pz;
    const tl = Math.hypot(tx, tz) || 1;
    const sx = -tz / tl, sz = tx / tl;
    for (const side of [-1, 1]) {
      if (rnd() > 0.72) continue;
      const off = 2.7 + rnd() * 2.2;
      const rx = px + sx * side * off, rz = pz + sz * side * off;
      const sc = 0.55 + rnd() * 0.9;
      const g = rockGeometry(3100 + i * 7 + (side > 0 ? 1 : 0), 1, 0.62);
      g.scale(sc * 1.15, sc * 0.68, sc);
      g.rotateY(rnd() * 6.28);
      g.translate(rx, hf.height(rx, rz) - sc * 0.44, rz);
      stones.push(g);
    }
  }
  const rMat = rockMaterial();
  if (stones.length) {
    const stoneMesh = new THREE.Mesh(mergeGeometries(stones), rMat);
    stoneMesh.receiveShadow = true;
    group.add(stoneMesh);
  }

  // --- 3. Broken timber bridge (abutments + stringers + 3 ghost bays + 3 solid bays + completion rails) ---
  const yA = hf.height(cx - ux * (BRIDGE_LEN * 0.52), cz - uz * (BRIDGE_LEN * 0.52));
  const yB = hf.height(cx + ux * (BRIDGE_LEN * 0.52), cz + uz * (BRIDGE_LEN * 0.52));
  const yBedCenter = hf.height(cx, cz);
  const yDeck = Math.max(yA, yB, yBedCenter + 1.55) + 0.16;

  const bridgeGroup = new THREE.Group();
  bridgeGroup.position.set(cx, 0, cz);
  bridgeGroup.rotation.y = ry;
  group.add(bridgeGroup);

  const WOOD_DARK = [0.30, 0.19, 0.12];
  const WOOD_MID = [0.46, 0.30, 0.17];
  const WOOD_PLANK = [0.56, 0.38, 0.22];
  const STONE_ABUT = [0.46, 0.44, 0.41];

  const baseParts = [];
  // Stone + timber abutments at both ends (z = -BRIDGE_LEN/2 is trailhead side, +BRIDGE_LEN/2 is lake side)
  for (const end of [-1, 1]) {
    const ez = end * (BRIDGE_LEN * 0.5 + 0.1);
    const ey = end < 0 ? yA : yB;
    baseParts.push(box(BRIDGE_W + 0.7, 2.4, 1.5, 0, ey - 0.95, ez, STONE_ABUT));
    // Short intact approach deck planks at each bank
    for (let p = 0; p < 2; p++) {
      const pz = end * (BRIDGE_LEN * 0.5 - 0.28 - p * 0.54);
      baseParts.push(box(BRIDGE_W, 0.12, 0.46, 0, yDeck - 0.06, pz, WOOD_MID));
    }
    // End corner posts
    for (const s of [-1, 1]) {
      baseParts.push(box(0.16, 1.35, 0.16, s * (BRIDGE_W * 0.5), yDeck + 0.48, end * (BRIDGE_LEN * 0.5 - 0.2), WOOD_DARK));
    }
  }
  // Two sturdy timber stringer beams spanning the gap (so the bridge clearly reads as a broken bridge missing its deck!)
  for (const s of [-1, 1]) {
    baseParts.push(box(0.22, 0.26, BRIDGE_LEN + 0.5, s * (BRIDGE_W * 0.35), yDeck - 0.24, 0, WOOD_DARK));
    // One broken jagged stump post in the middle on each side (replaced/extended when repaired)
    baseParts.push(box(0.15, 0.58, 0.15, s * (BRIDGE_W * 0.5), yDeck + 0.08, -1.5, WOOD_DARK, 0.12, 0, s * 0.14));
  }
  const baseMesh = new THREE.Mesh(mergeGeometries(baseParts), material);
  baseMesh.castShadow = true;
  baseMesh.receiveShadow = true;
  bridgeGroup.add(baseMesh);

  // 3 missing deck bays spanning cleanly flush between the approach planks (z from -3.55 to +3.55)
  const bayZs = [-2.38, 0.0, 2.38];
  const bayDepth = 2.36;
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0xffd58a,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  });
  const ghostWireMat = new THREE.LineBasicMaterial({
    color: 0xffe4ad,
    transparent: true,
    opacity: 0.65,
  });

  const ghostBays = [];
  const solidBays = [];
  for (let b = 0; b < 3; b++) {
    const bz = bayZs[b];
    const gGroup = new THREE.Group();
    const gGeo = new THREE.BoxGeometry(BRIDGE_W - 0.04, 0.11, bayDepth - 0.14);
    const gm = new THREE.Mesh(gGeo, ghostMat.clone());
    gm.position.set(0, yDeck - 0.02, bz);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(gGeo), ghostWireMat.clone());
    edges.position.copy(gm.position);
    gGroup.add(gm, edges);
    bridgeGroup.add(gGroup);
    ghostBays.push({ group: gGroup, fillMat: gm.material, wireMat: edges.material });

    // Solid deck bay (4 thick weathered cedar planks bolted together)
    const sParts = [];
    for (let k = 0; k < 4; k++) {
      const pz = bz + (k - 1.5) * (bayDepth / 4);
      const shade = k % 2 === 0 ? WOOD_PLANK : [0.51, 0.34, 0.19];
      sParts.push(box(BRIDGE_W, 0.13, bayDepth / 4 - 0.05, 0, yDeck - 0.02, pz, shade));
    }
    const sm = new THREE.Mesh(mergeGeometries(sParts), material);
    sm.castShadow = true;
    sm.receiveShadow = true;
    sm.visible = false;
    bridgeGroup.add(sm);
    solidBays.push({ mesh: sm, anim: 0, placed: false });
  }

  // Full guardrails that snap whole when the 3rd plank completes the bridge!
  const railParts = [];
  for (const s of [-1, 1]) {
    for (const pz of [-2.2, 0, 2.2]) {
      railParts.push(box(0.14, 1.12, 0.14, s * (BRIDGE_W * 0.5), yDeck + 0.50, pz, WOOD_DARK));
    }
    railParts.push(box(0.12, 0.10, BRIDGE_LEN, s * (BRIDGE_W * 0.5), yDeck + 1.04, 0, WOOD_PLANK));
    railParts.push(box(0.09, 0.08, BRIDGE_LEN, s * (BRIDGE_W * 0.5), yDeck + 0.58, 0, WOOD_MID));
  }
  const railsMesh = new THREE.Mesh(mergeGeometries(railParts), material);
  railsMesh.castShadow = true;
  railsMesh.receiveShadow = true;
  railsMesh.visible = false;
  bridgeGroup.add(railsMesh);

  // --- 4. Three washed-away bridge planks downstream within 60 m (18 m, 34 m, 50 m) ---
  const plankSpecs = [
    { distDown: 17, sideTrail: -3.2, yawOff: 0.45 },
    { distDown: 33, sideTrail: 3.6, yawOff: -0.62 },
    { distDown: 49, sideTrail: -3.5, yawOff: 0.95 },
  ];
  const planks = [];
  for (let i = 0; i < plankSpecs.length; i++) {
    const sp = plankSpecs[i];
    // Find creek centerline point at distDown
    let bestPt = points[points.length - 1];
    let bd = 1e9;
    for (const p of points) {
      const dd = Math.abs(p[2] - sp.distDown);
      if (dd < bd) { bd = dd; bestPt = p; }
    }
    // Place on the TRAILHEAD-side bank (-ux) or near-creek gravel shore so player can reach all 3 planks WITHOUT crossing the broken creek!
    // Wait: make sure ALL 3 planks are on the TRAILHEAD side (-ux) of the creek bank!
    const bankOff = -3.8 - (i % 2) * 0.5;
    const px = bestPt[0] + ux * bankOff;
    const pz = bestPt[1] + uz * bankOff;
    const py = hf.height(px, pz);

    const pGroup = new THREE.Group();
    const pParts = [];
    for (let k = -1; k <= 1; k++) {
      pParts.push(box(2.05, 0.11, 0.36, 0, 0.06, k * 0.40, k === 0 ? [0.64, 0.44, 0.25] : WOOD_PLANK));
    }
    pParts.push(box(0.14, 0.14, 1.24, -0.78, 0.07, 0, WOOD_DARK));
    pParts.push(box(0.14, 0.14, 1.24, 0.78, 0.07, 0, WOOD_DARK));
    const pMesh = new THREE.Mesh(mergeGeometries(pParts), material);
    pMesh.castShadow = true;
    pMesh.receiveShadow = true;
    pGroup.add(pMesh);

    // Subtle warm sun-glint highlight sprite grounded on the plank (readable from downstream without floating UI markers)
    const glint = makeGlintSprite(0.95);
    glint.position.set(0, 0.38, 0);
    pGroup.add(glint);

    pGroup.position.set(px, py + 0.05, pz);
    pGroup.rotation.y = ry + sp.yawOff;
    pGroup.rotation.z = 0.06 * (i % 2 ? 1 : -1);
    group.add(pGroup);

    planks.push({
      id: `bridge-plank-${i}`,
      index: i,
      x: px,
      y: py + 0.2,
      z: pz,
      distFromBridge: Math.hypot(px - cx, pz - cz),
      mesh: pGroup,
      glint,
      collected: false,
    });
  }

  // Approach anchor on the trailhead side of the bridge (where player stands to place planks)
  const approachPos = new THREE.Vector3(cx - ux * (BRIDGE_LEN * 0.46), yDeck, cz - uz * (BRIDGE_LEN * 0.46));
  const bridgeCenter = new THREE.Vector3(cx, yDeck, cz);

  let placedCount = 0;
  let railsAnim = 0;

  function placeNextPlank() {
    if (placedCount >= 3) return { placed: placedCount, completed: false };
    const idxBay = placedCount;
    placedCount++;
    ghostBays[idxBay].group.visible = false;
    solidBays[idxBay].mesh.visible = true;
    solidBays[idxBay].placed = true;
    solidBays[idxBay].anim = 1.0;
    const completed = placedCount >= 3;
    if (completed) {
      railsMesh.visible = true;
      railsAnim = 1.0;
    }
    return { placed: placedCount, completed, bayWorldPos: getBayWorldPos(idxBay) };
  }

  function getBayWorldPos(bayIdx) {
    const bz = bayZs[Math.min(2, Math.max(0, bayIdx))];
    return new THREE.Vector3(cx + ux * bz, yDeck + 0.2, cz + uz * bz);
  }

  // Real physical blocker: prevents crossing the creek anywhere along +/- 62m until all 3 planks are laid!
  function collide(pos, radius = 0.35) {
    const dx = pos.x - cx, dz = pos.z - cz;
    // alongCreek: distance upstream (-) or downstream (+)
    const alongCreek = dx * downX + dz * downZ;
    if (Math.abs(alongCreek) > 64) return false;
    // Find local creek sway at this alongCreek coordinate
    const bendMask = Math.min(1, Math.max(0, (Math.abs(alongCreek) - 9) / 14));
    const sway = Math.sin(alongCreek * 0.085) * 4.2 * bendMask;
    // across: signed distance in trail direction (+ is lake side, - is trailhead side)
    const across = dx * ux + dz * uz - sway;

    if (placedCount < 3) {
      // Block stepping into or past the broken bridge/creek from the trailhead side!
      const stopLine = -2.85 - radius;
      if (across > stopLine && across < 8.0) {
        const push = stopLine - across;
        pos.x += ux * push;
        pos.z += uz * push;
        return true;
      }
      // Also prevent falling down into the narrow bridge slot if somehow approaching from lake side
    } else {
      // Once repaired: allow walking straight across the bridge (|alongCreek| < BRIDGE_W * 0.65),
      // while gently keeping the player inside the bridge railings when on the bridge span
      if (Math.abs(across) < BRIDGE_LEN * 0.48 && Math.abs(alongCreek) < 2.2) {
        const halfRail = BRIDGE_W * 0.42 - radius * 0.5;
        if (Math.abs(alongCreek) > halfRail) {
          const clampA = Math.sign(alongCreek) * halfRail;
          const diff = clampA - alongCreek;
          pos.x += downX * diff;
          pos.z += downZ * diff;
        }
      }
    }
    return false;
  }

  function groundY(x, z, curG) {
    const dx = x - cx, dz = z - cz;
    const across = dx * ux + dz * uz;
    const along = dx * downX + dz * downZ;
    if (Math.abs(along) > BRIDGE_W * 0.72) return curG;
    if (placedCount >= 3) {
      if (Math.abs(across) < BRIDGE_LEN * 0.56) {
        const blend = 1 - Math.max(0, (Math.abs(across) - BRIDGE_LEN * 0.42) / (BRIDGE_LEN * 0.14));
        return Math.max(curG, curG + (yDeck - curG) * blend);
      }
    } else {
      // Trailhead abutment is solid up to the break
      if (across > -BRIDGE_LEN * 0.58 && across < -2.6) {
        return Math.max(curG, yDeck - 0.04);
      }
    }
    return curG;
  }

  function update(dt, t, carryingPlank) {
    // Animate ghost deck outlines (warm pulse, brighter when holding a plank)
    for (let i = 0; i < 3; i++) {
      if (!ghostBays[i].group.visible) continue;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.8 + i * 0.9);
      const isNext = i === placedCount;
      const boost = carryingPlank && isNext ? 1.7 : 1.0;
      ghostBays[i].fillMat.opacity = (0.14 + pulse * 0.14) * boost;
      ghostBays[i].wireMat.opacity = Math.min(0.95, (0.42 + pulse * 0.28) * boost);
    }
    // Snap-down settle animation on placed bays
    for (const bay of solidBays) {
      if (bay.anim > 0) {
        bay.anim = Math.max(0, bay.anim - dt * 5.2);
        const drop = bay.anim * bay.anim * 0.32;
        bay.mesh.position.y = drop;
      }
    }
    if (railsAnim > 0) {
      railsAnim = Math.max(0, railsAnim - dt * 3.8);
      railsMesh.position.y = railsAnim * railsAnim * 0.45;
    }
    // Glint pulse on uncollected planks
    for (let i = 0; i < planks.length; i++) {
      const p = planks[i];
      if (p.collected) continue;
      const s = 0.75 + 0.35 * Math.sin(t * 2.6 + i * 1.9);
      p.glint.scale.setScalar(s);
      p.glint.material.opacity = 0.38 + 0.28 * Math.sin(t * 2.6 + i * 1.9);
    }
  }

  scene.add(group);

  function dispose() {
    group.removeFromParent();
    waterMesh.geometry.dispose();
    waterMat.dispose();
    rMat.dispose();
    ghostMat.dispose();
    ghostWireMat.dispose();
    group.traverse((o) => {
      const obj = /** @type {any} */ (o);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && obj.material !== material) {
        if (obj.material.map && obj.material.map !== sharedGlintTex) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
  }

  return {
    group,
    bridgeCenter,
    approachPos,
    bridgeYaw: ry,
    ux,
    uz,
    downX,
    downZ,
    yDeck,
    planks,
    get placedCount() { return placedCount; },
    get isRepaired() { return placedCount >= 3; },
    getNextBayWorldPos: () => getBayWorldPos(Math.min(2, placedCount)),
    placeNextPlank,
    collide,
    groundY,
    update,
    dispose,
  };
}

let sharedGlintTex = null;
export function getGlintTexture() {
  if (sharedGlintTex) return sharedGlintTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  g.addColorStop(0.0, 'rgba(255, 246, 210, 1.0)');
  g.addColorStop(0.28, 'rgba(255, 210, 128, 0.65)');
  g.addColorStop(0.65, 'rgba(255, 178, 86, 0.16)');
  g.addColorStop(1.0, 'rgba(255, 170, 80, 0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  sharedGlintTex = tex;
  return tex;
}

export function makeGlintSprite(scale = 0.85) {
  const mat = new THREE.SpriteMaterial({
    map: getGlintTexture(),
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sp = new THREE.Sprite(mat);
  sp.scale.setScalar(scale);
  return sp;
}
