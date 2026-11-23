import * as THREE from 'three';
import { patchMaterial } from '../patch.js';

// Quadtree-LOD terrain rendered as a single instanced grid patch with CDLOD-style
// vertex morphing and skirts. Heights and normals come from the shared heightmaps.

const DEFAULT_N = 32; // grid segments per patch
const ROOT = 32768;
const MIN_SIZE = 64;
const DEFAULT_LOD_K = 3.6;
const DEFAULT_MAX_NODES = 2200;

function buildPatchGeometry(N = DEFAULT_N) {
  const pos = [];
  const skirt = [];
  const idx = [];
  const V = N + 1;
  for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) { pos.push(x / N, 0, z / N); skirt.push(0); }
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const a = z * V + x, b = a + 1, c = a + V, d = c + 1;
    if ((x + z) % 2 === 0) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  const border = [];
  for (let x = 0; x < N; x++) border.push([x, 0]);
  for (let z = 0; z < N; z++) border.push([N, z]);
  for (let x = N; x > 0; x--) border.push([x, N]);
  for (let z = N; z > 0; z--) border.push([0, z]);
  border.push(border[0]);
  let base = pos.length / 3;
  for (let i = 0; i < border.length; i++) {
    const [x, z] = border[i];
    pos.push(x / N, 0, z / N); skirt.push(1);
  }
  for (let i = 0; i < border.length - 1; i++) {
    const [x0, z0] = border[i], [x1, z1] = border[i + 1];
    const a = z0 * V + x0, b = z1 * V + x1, c = base + i, d = base + i + 1;
    idx.push(a, b, c, b, d, c);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
  g.setIndex(idx);
  return g;
}

export class Terrain {
  constructor(opts = {}) {
    this.uniforms = {
      uLodK: { value: opts.terrainLodK ?? DEFAULT_LOD_K },
      uCamDY: { value: 0 },
      uCamXZ: { value: new THREE.Vector2() },
      uSkirt: { value: 1 },
    };
    this._frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._buildResources(opts);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  _buildResources(opts = {}) {
    this.N = opts.terrainN ?? DEFAULT_N;
    this.lodK = opts.terrainLodK ?? DEFAULT_LOD_K;
    this.maxNodes = opts.terrainMaxNodes ?? DEFAULT_MAX_NODES;
    this.uniforms.uLodK.value = this.lodK;
    this.geometry = buildPatchGeometry(this.N);
    this.nodeArr = new Float32Array(this.maxNodes * 4);
    this.nodeAttr = new THREE.InstancedBufferAttribute(this.nodeArr, 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aNode', this.nodeAttr);
    this.geometry.instanceCount = 0;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    const nStr = this.N.toFixed(1);
    patchMaterial(mat, {
      toonWrap: 0.14, toonLo: 0.24, toonHi: 0.40,
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        attribute vec4 aNode;
        attribute float aSkirt;
        uniform float uLodK;
        uniform float uCamDY;
        uniform vec2 uCamXZ;
        uniform float uSkirt;
        varying float vDist;
      `,
      vertex: [
        ['#include <begin_vertex>', /* glsl */ `
          float size = aNode.z;
          vec2 grid = floor(position.xz * ${nStr} + 0.5);
          vec2 xz = aNode.xy + position.xz * size;
          float d = length(vec2(length(xz - uCamXZ), uCamDY));
          float morph = clamp((d / (uLodK * size) - 1.55) / 0.35, 0.0, 1.0);
          if (size >= 16384.0) morph = 0.0;
          vec2 frac = fract(grid * 0.5) * 2.0;
          xz -= frac * (size / ${nStr}) * morph;
          float h = w_height(xz);
          h -= aSkirt * (2.0 + size * 0.015) * uSkirt;
          vec3 transformed = vec3(xz.x, h, xz.y);
          vDist = d;
        `],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: /* glsl */ `
        varying float vDist;
        vec3 t_albedo; float t_rough; vec3 t_normal; float t_wet; float t_glow = 0.0; float t_snowFar = 0.0; float t_glowWarm = 0.0;
        float t_noise(vec2 p){ return texture(uNoiseTex, p).r; }
        // crisp graphic stepped horizontal BotW/Ghibli granite cliff ledge bands with flat top planes & deep dark undercuts (ZERO wobbly clay ripples!)
        vec4 cliffPlane(vec2 p){
          vec4 vn = texture(uNoiseTex, p * 0.022);
          vec4 vf = texture(uNoiseTex, p * 0.14 + 0.37);
          float hi1 = n_noise(p * 0.45 + vec2(3.1, 7.4));
          float hi2 = n_noise(p * 1.35 + vec2(9.2, 1.8));
          // tight controlled ledge warp -> crisp flat horizontal strata shelves instead of melted wavy clay!
          float yWarp = p.y + (vn.r - 0.5) * 0.78 + (hi1 - 0.5) * 0.32;
          float xWarp = p.x + (vn.g - 0.5) * 1.25 + (hi1 - 0.5) * 0.42;
          float strataBand = fract(yWarp * 0.18 + vn.b * 0.10);
          float strataTop  = smoothstep(0.68, 0.78, strataBand);
          float strataUnder = smoothstep(0.18, 0.04, strataBand);
          float b1 = texture(uNoiseTex, vec2(xWarp * 0.055 + 0.13, floor(yWarp * 0.18) * 0.27)).r;
          float b2 = texture(uNoiseTex, vec2(xWarp * 0.11 + 0.47, yWarp * 0.085)).g;
          float facetVal = b1 * 0.52 + b2 * 0.32 + hi1 * 0.16;
          // crisp 3-step graphic tonal granite planes + flat lit horizontal ledge tops
          float planeStep = smoothstep(0.32, 0.37, facetVal) * 0.50 + smoothstep(0.60, 0.65, facetVal) * 0.50;
          float shelfEdge = max(strataTop * 0.88, smoothstep(0.62, 0.72, b2 * 0.7 + hi1 * 0.3) * smoothstep(0.36, 0.66, vn.b));
          float jointH = smoothstep(0.0, 0.055, abs(strataBand - 0.04));
          float jointV = smoothstep(0.0, 0.045, abs(fract(xWarp * 0.095 + floor(yWarp * 0.18) * 0.41 + vn.a * 0.22) - 0.5));
          float crevice = mix(0.28, 1.0, min(jointH, jointV) * 0.78 + 0.22 * smoothstep(0.24, 0.68, vf.b * 0.6 + hi2 * 0.4));
          vec3 darkCrevice = vec3(0.10, 0.13, 0.21);
          vec3 midGranite  = vec3(0.35, 0.36, 0.40);
          vec3 litGranite  = vec3(0.60, 0.56, 0.48);
          vec3 c = mix(darkCrevice, midGranite, smoothstep(0.0, 0.50, planeStep));
          c = mix(c, litGranite, smoothstep(0.46, 1.0, planeStep) * 0.82 + strataTop * 0.52);
          c *= mix(1.0, 0.42, strataUnder * 0.85);
          c *= crevice * (0.88 + 0.22 * hi2);
          float mossSpot = shelfEdge * smoothstep(0.36, 0.60, vn.g * 0.6 + hi1 * 0.4);
          return vec4(c, (mossSpot * 1.25 + strataTop * 0.62) - strataUnder * 0.92 - (1.0 - crevice) * 0.80);
        }
        void terrainSurface(vec3 wp, float dist){
          vec2 xz = wp.xz;
          float fb = w_nearBlend(xz);
          float h = wp.y;
          // clean broad macro normals on far mountains so graphic 3-step shading & hard-edged shapes replace melted-wax ripples!
          float eNear = clamp(dist * 0.0018, 1.0, 10.0);
          float eMtn  = clamp(dist * 0.0062, 28.0, 74.0);
          float e = mix(eNear, max(eNear, eMtn), max(fb, smoothstep(1150.0, 2300.0, dist)));
          vec3 n = w_normal(xz, e);
          const mat2 R1 = mat2(0.8, -0.6, 0.6, 0.8);
          const mat2 R2 = mat2(0.28, 0.96, -0.96, 0.28);
          vec4 nH = texture(uNoiseTex, R2 * xz * 0.00031 + 0.21);
          vec4 nz = texture(uNoiseTex, R1 * xz * 0.0019);
          float fadeM = 1.0 - smoothstep(600.0, 2600.0, dist);
          float fadeD = 1.0 - smoothstep(80.0, 450.0, dist);
          float fadeF = 1.0 - smoothstep(18.0, 100.0, dist);
          vec4 nm = mix(vec4(0.5), texture(uNoiseTex, xz * 0.013), fadeM);
          vec4 nd = mix(vec4(0.5), texture(uNoiseTex, R2 * xz * 0.11), fadeD);
          vec4 nf = mix(vec4(0.5), texture(uNoiseTex, xz * 0.63), fadeF);
          float slopeFine = 1.0 - n.y;
          vec3 t_normalPre = n;
          float broadE = mix(e, max(e * 2.0, 32.0), smoothstep(600.0, 2800.0, dist));
          float slope = mix(slopeFine, 1.0 - w_normal(xz, broadE).y, smoothstep(700.0, 2800.0, dist) * 0.72);
          vec4 bio = w_biome(xz);
          float trailRaw = w_trailRaw(xz);
          float trail = max(trailRaw, 0.0);
          float bed = max(-trailRaw, 0.0);
          // anisotropic fall-line gullies (kept strictly on high near/mid rock, NOT swirly foothill carpets!)
          vec2 fall = normalize(n.xz + 1e-4);
          vec2 across = vec2(-fall.y, fall.x);
          vec2 gp = vec2(dot(xz, across) * 0.018, dot(xz, fall) * 0.0024);
          float gully = texture(uNoiseTex, gp).g * 0.58 + texture(uNoiseTex, gp * 3.1 + 0.4).b * 0.42;

          // --- palettes (linear albedo) ---
          vec3 forestF = vec3(0.045, 0.155, 0.055);
          vec3 rockA   = vec3(0.32, 0.31, 0.34);
          vec3 rockB   = vec3(0.58, 0.53, 0.48);
          vec3 rockW_  = vec3(0.56, 0.46, 0.37);
          vec3 dirt    = vec3(0.74, 0.50, 0.26);
          vec3 sand    = vec3(0.76, 0.66, 0.47);
          vec3 snow    = vec3(0.99, 0.995, 1.0);
          vec3 mud     = vec3(0.28, 0.31, 0.22);

          vec3 grass = w_grassColor(xz, h) * (0.90 + 0.18 * nd.b);
          {
            // infinite-resolution near-ground painted clover clumps, rich emerald shadow pockets, warm hay-gold tufts & subtle root thatch (ZERO flat green AND ZERO white specks in sheep.png!)
            float nearK = 1.0 - smoothstep(26.0, 96.0, dist);
            if (nearK > 0.005) {
              float gMacro  = n_noise(xz * 0.42 + vec2(1.9, 7.3));
              float gClover = n_noise(xz * 1.45 + vec2(4.2, 1.9));
              float gTuft   = n_noise(xz * 4.8  + vec2(8.7, 3.3));
              float gStroke = n_noise(vec2(xz.x * 9.5 + gClover * 1.6, xz.y * 4.2));
              // deep rich clover-emerald clumps & sunlit warm chartreuse-gold meadow tufts
              grass = mix(grass, grass * vec3(0.56, 0.78, 0.68), smoothstep(0.46, 0.76, gClover * 0.6 + gMacro * 0.4) * nearK * 0.68);
              grass = mix(grass, grass * vec3(1.24, 1.12, 0.72), smoothstep(0.52, 0.80, (1.0 - gClover) * 0.55 + gMacro * 0.45) * nearK * 0.54);
              grass *= mix(1.0, 0.76 + 0.44 * smoothstep(0.20, 0.80, gTuft * 0.55 + gStroke * 0.45), nearK);
              // subtle warm dark root-thatch & soil depth tucked inside dense tufts (NO pale white dots!)
              float soilPeek = smoothstep(0.72, 0.88, gTuft) * smoothstep(0.50, 0.78, nd.r) * nearK;
              grass = mix(grass, vec3(0.16, 0.15, 0.08), soilPeek * 0.55);
            }
            // rich painterly mid-range meadow tapestry & sunlit hay drifts (KILLS flat green slab in title.png right meadow & lake.png!)
            float tuftK = smoothstep(12.0, 38.0, dist) * (1.0 - smoothstep(550.0, 1450.0, dist));
            vec4 tf = texture(uNoiseTex, xz * 0.24 + 0.77);
            vec4 tf2 = texture(uNoiseTex, xz * 0.78 + 0.19);
            grass *= mix(1.0, 0.84 + 0.30 * smoothstep(0.24, 0.76, tf.a * 0.65 + tf2.g * 0.35), tuftK);
            grass = mix(grass, grass * vec3(1.20, 1.10, 0.74), smoothstep(0.46, 0.76, texture(uNoiseTex, xz * 0.032 + 0.13).b) * tuftK * 0.64);
            grass = mix(grass, grass * vec3(0.70, 0.90, 0.80), smoothstep(0.48, 0.76, texture(uNoiseTex, xz * 0.018 + 0.61).r) * tuftK * 0.54);
            // near-to-mid wildflower drifts faded cleanly before distant hills (KILLS sparkly white band at 1060-1240, 345-380 in lakeSunset.png!)
            float flK = smoothstep(26.0, 58.0, dist) * (1.0 - smoothstep(160.0, 320.0, dist)) * smoothstep(0.18, 0.52, bio.g + bio.b * 0.18) * (1.0 - max(uGolden, uDawn) * 0.55);
            vec4 fs1 = texture(uNoiseTex, xz * 0.85 + 0.41);
            float speck = smoothstep(0.70, 0.78, fs1.a);
            vec3 fcol = fs1.r < 0.45 ? vec3(0.92, 0.72, 0.20) : fs1.r < 0.65 ? vec3(0.86, 0.52, 0.72) : vec3(0.84, 0.84, 0.78);
            grass = mix(grass, fcol, speck * flK * 0.68);
          }
          vec3 col = grass;
          float forest = smoothstep(0.12, 0.55, bio.r);
          // beyond walkable map: calm unified deep alpine conifer forest climbing smoothly to timberline (ZERO yellow-green lumps!)
          float farF = fb * smoothstep(1040.0, 860.0, h + (nH.g - 0.5) * 90.0) * smoothstep(0.48, 0.28, slope) * smoothstep(160.0, 340.0, h);
          forest = max(forest * (1.0 - fb), farF);
          float crowns = texture(uNoiseTex, xz * 0.042).a * 0.6 + texture(uNoiseTex, xz * 0.014).a * 0.4;
          vec3 forestHue = mix(forestF, vec3(0.068, 0.20, 0.062), smoothstep(0.32, 0.78, nH.r));
          forestHue = mix(forestHue, vec3(0.032, 0.14, 0.095), smoothstep(0.52, 0.80, nz.b) * 0.65);
          // calm cohesive deep conifer canopy on distant hills (no noisy lumpy blobs!)
          vec3 canopy = mix(vec3(0.042, 0.165, 0.072), vec3(0.078, 0.225, 0.074), smoothstep(0.30, 0.78, nH.r));
          canopy *= 0.80 + 0.32 * smoothstep(0.26, 0.76, crowns);
          vec3 fCol = mix(forestHue * (0.72 + 0.54 * crowns), canopy, smoothstep(260.0, 920.0, dist));
          col = mix(col, fCol, forest);
          // grounded cool forest shadow pool directly beneath tree groves (prevents hillside groves reading as floating chess pieces on bright lawn!)
          col *= mix(1.0, 0.68, smoothstep(0.28, 0.74, bio.r) * (1.0 - fb));
          // crisp infinite-resolution Princess Mononoke woodland floor: dark rich humus, fallen russet oak leaves, velvety moss cushions, roots & stones (ZERO blurry mip mush in forest.png!)
          {
            float cotClear = uAOSpot.z > 0.1 ? smoothstep(26.0, 48.0, length(xz - uAOSpot.xy)) : 1.0;
            float ff = smoothstep(0.44, 0.80, bio.r) * cotClear * fadeD;
            if (ff > 0.005) {
              vec4 lf = texture(uNoiseTex, xz * 0.14 + 0.13);
              float mossCushion = n_noise(xz * 1.45 + vec2(2.3, 5.7));
              float leafLarge   = n_noise(xz * 5.8  + vec2(7.1, 1.4));
              float leafCrisp   = n_noise(xz * 14.5 + vec2(3.9, 8.2));
              float rootStreak  = n_noise(vec2(xz.x * 2.2 + mossCushion * 1.4, xz.y * 7.5));
              float fPebble     = smoothstep(0.84, 0.91, n_noise(xz * 8.2 + vec2(11.3, 4.1))) * smoothstep(0.45, 0.75, lf.b);
              // deep rich shaded woodland humus base (strong value separation from sunlit glades!)
              vec3 fBase = vec3(0.036, 0.088, 0.032) * (0.78 + 0.42 * mossCushion);
              // velvety emerald moss cushions with crisp micro-tuft grain
              float mossMask = smoothstep(0.36, 0.66, mossCushion * 0.65 + lf.g * 0.35);
              vec3 mossC = mix(vec3(0.042, 0.175, 0.038), vec3(0.115, 0.285, 0.058), smoothstep(0.35, 0.75, leafLarge));
              fBase = mix(fBase, mossC * (0.82 + 0.36 * leafCrisp), mossMask * 0.85);
              // dark rich forest soil & gnarled surface roots
              float soilMask = smoothstep(0.45, 0.74, lf.r * 0.6 + (1.0 - mossCushion) * 0.4);
              fBase = mix(fBase, vec3(0.088, 0.058, 0.036) * (0.76 + 0.44 * leafCrisp), soilMask * 0.82);
              fBase = mix(fBase, vec3(0.16, 0.11, 0.068), smoothstep(0.76, 0.88, rootStreak) * soilMask * 0.55);
              // crisp individual fallen oak leaves (amber, russet & warm gold flecks with dark micro-shadow edges!)
              float leafBed = smoothstep(0.44, 0.68, leafLarge * 0.6 + lf.b * 0.4);
              float leafFleck = smoothstep(0.54, 0.76, leafCrisp) * leafBed;
              vec3 leafCol = mix(vec3(0.24, 0.125, 0.048), vec3(0.38, 0.22, 0.072), smoothstep(0.58, 0.86, leafCrisp));
              fBase = mix(fBase, leafCol, leafFleck * 0.88);
              // small crisp mossy woodland stones
              fBase = mix(fBase, vec3(0.34, 0.33, 0.31) * (0.85 + 0.3 * leafCrisp), fPebble * 0.78);
              col = mix(col, fBase, ff * 0.94);
            }
          }

          // --- rock, crisp faceted blocky granite cliffs & waterfall amphitheatre ---
          float strata = smoothstep(0.28, 0.72, sin(h * 0.045 + nz.g * 3.4 + gully * 3.2) * 0.5 + 0.5);
          vec3 rock = mix(rockA, rockB, strata * 0.22 + gully * 0.52 + nH.b * 0.22);
          rock = mix(rock, rockW_, smoothstep(0.55, 0.8, nH.g) * 0.42 * (1.0 - smoothstep(600.0, 2000.0, dist)));
          rock *= 0.88 + 0.22 * nf.g;

          // true triplanar faceted blocky alpine granite cliff faces (ZERO wood-grain swirls, moss ONLY on upward top ledges!)
          vec3 cliffNAdd = vec3(0.0);
          float cliffW = smoothstep(0.26, 0.50, slopeFine);
          float wfZone = uWaterfall.w > 0.1 ? (1.0 - smoothstep(uWaterfall.w * 0.55, uWaterfall.w * 1.45, length(wp.xz - uWaterfall.xz))) : 0.0;
          {
            vec3 tw = pow(abs(t_normalPre), vec3(6.0)); tw /= max(tw.x + tw.y + tw.z, 1e-4);
            vec4 cX = cliffPlane(vec2(wp.z, wp.y));
            vec4 cZ = cliffPlane(vec2(wp.x, wp.y));
            vec4 cY = cliffPlane(vec2(wp.x, wp.z));
            vec3 cliffC = cX.rgb * tw.x + cZ.rgb * tw.z + cY.rgb * tw.y;
            float shelfStep = cX.a * tw.x + cZ.a * tw.z;
            vec4 vf = texture(uNoiseTex, vec2(wp.z, wp.y) * 0.26 + 0.37) * tw.x
                    + texture(uNoiseTex, vec2(wp.x, wp.z) * 0.26 + 0.37) * tw.y
                    + texture(uNoiseTex, vec2(wp.x, wp.y) * 0.26 + 0.37) * tw.z;
            // lush velvety emerald moss on horizontal rock shelves & ledges (NEVER smeared vertically!)
            float topFace = smoothstep(0.52, 0.82, t_normalPre.y);
            float ledgeMoss = smoothstep(0.28, 0.78, shelfStep) * (0.45 + 0.55 * smoothstep(0.12, 0.46, t_normalPre.y));
            float shelfMoss = clamp(topFace + ledgeMoss * (0.55 + 0.45 * wfZone), 0.0, 1.0) * smoothstep(0.26, 0.66, vf.g + nd.r * 0.26) * smoothstep(950.0, 500.0, h);
            vec3 mossCol = mix(vec3(0.065, 0.24, 0.055), vec3(0.17, 0.39, 0.075), vf.b);
            cliffC = mix(cliffC, mossCol, shelfMoss * 0.90);
            // deep dark glistening wet charcoal-slate rock immediately behind & beside the falling water (makes the falls feel CUT INTO a dark wet rock recess!)
            if (wfZone > 0.01) {
              float wfd = length(wp.xz - uWaterfall.xz);
              float wfWet = (1.0 - smoothstep(uWaterfall.w * 0.14, uWaterfall.w * 0.56, wfd));
              cliffC = mix(cliffC, cliffC * vec3(0.36, 0.42, 0.52), wfWet * 0.76);
              t_wet = max(t_wet, wfWet * cliffW * 0.34);
            }
            rock = mix(rock, cliffC, cliffW * (1.0 - smoothstep(550.0, 1500.0, dist)));
            cliffNAdd = vec3((vf.r - 0.5) * 0.24, shelfStep * 0.96, (vf.b - 0.5) * 0.24) * cliffW * fadeM;
          }

          // painted crevices running down the fall line (DISABLED on wfZone so waterfall granite cliff stays 100% crisp triplanar with ZERO vertical streaking!)
          rock *= mix(mix(0.66, 1.08, smoothstep(0.28, 0.65, gully)), 1.0, wfZone);
          float altR = smoothstep(980.0, 1480.0, h + (nH.g - 0.5) * 260.0);
          float noiseK = 1.0 - smoothstep(800.0, 2400.0, dist);
          float rockEdge = mix(0.06, 0.025, 1.0 - noiseK);
          // rugged rock across ALL steep cliff faces near waterfall; keep grassy summit mounds clothed (KILLS pink rock blotch at 1360,620 in summitWest.png!)
          float steepThresh = mix(0.68, 0.44, smoothstep(540.0, 920.0, h)) - altR * 0.18;
          steepThresh = mix(steepThresh, 0.20, wfZone);
          float rockW = smoothstep(steepThresh, steepThresh + rockEdge, max(slope, slopeFine * wfZone) + ((nz.b - 0.5) * 0.035 + (gully - 0.5) * 0.03) * noiseK);
          // keep mid-altitude open slopes lush warm alpine grassland (kills dull brown-grey mud flats in summitWest.png!)
          float scree = smoothstep(0.38, 0.54, slope) * (1.0 - rockW) * smoothstep(0.60, 0.82, gully + nz.r * 0.22) * smoothstep(760.0, 1180.0, h);
          col = mix(col, mix(rockB * 0.72, vec3(0.14, 0.24, 0.085), 0.72) * (0.88 + 0.22 * nf.r), scree * 0.14 * (1.0 - smoothstep(450.0, 1500.0, dist)));
          // warm toasted-gold & emerald valley floor bounce at golden hour/sunset (KILLS flat grey-green plane in summitWest.png!)
          {
            vec3 sunMeadow = mix(vec3(0.10, 0.26, 0.055), vec3(0.27, 0.35, 0.080), smoothstep(0.28, 0.74, nH.g * 0.55 + nz.r * 0.45));
            col = mix(col, sunMeadow * (0.84 + 0.30 * nd.b), smoothstep(55.0, 130.0, h) * (1.0 - smoothstep(520.0, 780.0, h)) * (1.0 - rockW) * (1.0 - forest * 0.78) * uGolden * (1.0 - uDawn) * 0.78);
          }
          col = mix(col, rock, rockW);

          // snow: settles on gentler high slopes & streaks into alpine couloirs
          float snowLine = 1780.0 + (nH.r - 0.5) * 220.0 - n.z * 90.0;
          float slopeCap = smoothstep(0.56, 0.38, slope);
          float snowEdge = (nz.g - 0.5) * 110.0 + (nm.a - 0.5) * 60.0;
          float snowW = smoothstep(snowLine + snowEdge * noiseK, snowLine + snowEdge * noiseK + 22.0, h) * smoothstep(0.0, 0.08, slopeCap - 0.42);
          snowW = max(snowW, smoothstep(snowLine + 320.0, snowLine + 520.0, h) * smoothstep(0.76, 0.58, slope));
          vec3 snowC = snow * (0.92 + 0.08 * nd.b);
          col = mix(col, snowC, snowW);

          // --- organic varied lake shoreline & lake bed (no uniform bathtub ring!) ---
          float wl = uWaterLevel;
          vec4 shN = texture(uNoiseTex, xz * 0.009 + 0.42);
          vec4 shN2 = texture(uNoiseTex, xz * 0.045 + 0.19);
          // beach width varies from near-zero (grass right to water) up to cozy pebble coves
          float beachWidth = mix(0.18, 1.35, smoothstep(0.32, 0.72, shN.r));
          float shore = (1.0 - smoothstep(0.05, beachWidth, abs(h - wl - 0.15) + (shN2.g - 0.5) * 0.35)) * smoothstep(0.28, 0.55, shN.g + 0.15);
          float pebbleMask = smoothstep(0.45, 0.68, shN2.a);
          vec3 beachCol = mix(sand * (0.85 + 0.25 * nf.b), vec3(0.48, 0.45, 0.40) * (0.8 + 0.38 * nf.a), pebbleMask * 0.75);
          col = mix(col, beachCol, shore * (1.0 - rockW) * 0.88);
          float under = smoothstep(wl + 0.12, wl - 0.55, h);
          col = mix(col, mix(sand * 0.78, mud, smoothstep(wl - 0.6, wl - 4.5, h)), under);
          // rich wet-sand darkening right along the waterline
          t_wet = max(t_wet, 1.0 - smoothstep(wl - 0.1, wl + 0.55, h));

          // --- hiking trail (organic trampled grass verges, visible worn tread ruts, darker damp rim & crisp alpine gravel — ZERO flat beige decals in saddle.png!) ---
          float trHi1 = n_noise(xz * 2.1 + vec2(1.7, 5.2));
          float trHi2 = n_noise(xz * 7.2 + vec2(6.3, 2.9));
          float trGrit = n_noise(xz * 22.0 + vec2(2.1, 8.4));
          float trMicro = n_noise(xz * 44.0 + vec2(7.7, 1.3));
          // dramatically narrower organic footpath on saddle & summit ridges + grass-island breakup on wide clearings!
          float summitNarrow = smoothstep(210.0, 345.0, h) * 0.36;
          float trTuftTongue = smoothstep(0.46, 0.78, trHi1 * 0.62 + trHi2 * 0.38) * (1.0 - smoothstep(0.68, 0.94, trail)) * 0.28;
          float trailEdge2 = trail + (nd.g - 0.5) * 0.16 + (trHi1 - 0.5) * 0.26 + (trHi2 - 0.5) * 0.15 - summitNarrow - trTuftTongue;
          float twTrail = smoothstep(0.48, 0.515, trailEdge2);
          vec4 cb = texture(uNoiseTex, xz * 2.3);
          vec4 cb2 = texture(uNoiseTex, xz * 0.85 + 0.31);
          vec3 tcol = dirt * (0.82 + 0.24 * trHi2) * (0.90 + 0.20 * nz.r);
          // twin worn hiker tread ruts + exposed path pebbles & gnarled earth-root veins
          float rut = exp(-pow((trail - 0.74) * 8.5, 2.0)) * 0.32 + exp(-pow((trail - 0.91) * 9.5, 2.0)) * 0.22;
          tcol *= 1.0 - rut;
          float pebbles = smoothstep(0.70, 0.81, trGrit * 0.65 + trMicro * 0.35) * smoothstep(0.32, 0.74, trHi2);
          float pebShadow = smoothstep(0.62, 0.74, trGrit) * (1.0 - pebbles);
          tcol *= 1.0 - pebShadow * 0.26;
          tcol = mix(tcol, vec3(0.64, 0.58, 0.49) * (0.86 + 0.28 * trMicro), pebbles * 0.58);
          // forest floor path: rich damp woodland chocolate-loam soil, fine scattered amber/russet oak leaves & gnarly root streaks
          {
            float fpath = smoothstep(0.28, 0.68, bio.r);
            float fRoot = smoothstep(0.74, 0.86, n_noise(vec2(xz.x * 2.4 + trHi1 * 1.5, xz.y * 8.2)));
            float fLeaf = smoothstep(0.64, 0.80, trGrit * 0.55 + trMicro * 0.45) * smoothstep(0.32, 0.70, trHi1);
            vec3 earth = vec3(0.155, 0.105, 0.062) * (0.80 + 0.32 * trHi2) * (0.88 + 0.24 * trMicro);
            earth = mix(earth, vec3(0.095, 0.065, 0.038), smoothstep(0.45, 0.78, cb2.r) * 0.50);
            earth = mix(earth, vec3(0.22, 0.145, 0.082), fRoot * 0.68);
            earth = mix(earth, mix(vec3(0.34, 0.175, 0.055), vec3(0.46, 0.26, 0.078), trMicro), fLeaf * 0.84);
            earth *= 1.0 - rut * 0.85;
            tcol = mix(tcol, earth, fpath);
            // alpine saddle & summit footpath: crisp fine granite grit, dark worn center tread, mossy turf islands & gnarled roots!
            float aCrack = smoothstep(0.0, 0.14, abs(n_noise(xz * 6.5 + vec2(3.1, 8.2)) - 0.5));
            float aRock  = smoothstep(0.56, 0.72, trHi2 * 0.55 + trGrit * 0.45);
            float aMoss  = smoothstep(0.46, 0.70, trHi1) * (1.0 - smoothstep(0.50, 0.76, trailEdge2));
            vec3 alpinePath = vec3(0.28, 0.24, 0.20) * (0.70 + 0.40 * aCrack) * (0.82 + 0.34 * trMicro);
            alpinePath = mix(alpinePath, vec3(0.50, 0.46, 0.40) * (0.84 + 0.30 * trMicro), aRock * 0.68);
            alpinePath = mix(alpinePath, vec3(0.58, 0.54, 0.47), pebbles * 0.64);
            alpinePath = mix(alpinePath, vec3(0.24, 0.16, 0.09), fRoot * 0.42);
            alpinePath = mix(alpinePath, vec3(0.095, 0.24, 0.055), aMoss * 0.84);
            alpinePath *= 1.0 - rut * 0.90;
            tcol = mix(tcol, alpinePath, smoothstep(195.0, 320.0, h) * 0.92);
          }
          // distinct darker damp earth rim & trampled mossy verge framing both borders of the path (kills blurred decal look!)
          tcol *= mix(0.62, 1.04, smoothstep(0.49, 0.62, trailEdge2));
          float vergeLip = smoothstep(0.32, 0.48, trailEdge2) * (1.0 - twTrail);
          col = mix(col, col * 0.60 + vec3(0.018, 0.022, 0.008), vergeLip * 0.76);
          col = mix(col, tcol, twTrail);

          // --- crisp multi-scale river cobble & pebble stream bed (no blurry mud smears!) ---
          {
            vec4 pbLarge = texture(uNoiseTex, xz * 0.95 + 0.17);
            vec4 pbMed   = texture(uNoiseTex, xz * 2.6 + 0.51);
            vec4 pbFine  = texture(uNoiseTex, xz * 6.4 + 0.83);
            float cobble = smoothstep(0.44, 0.64, pbLarge.a);
            float peb = smoothstep(0.46, 0.66, pbMed.a);
            vec3 cWarm = vec3(0.55, 0.48, 0.38);
            vec3 cCool = vec3(0.38, 0.40, 0.42);
            vec3 cOchre = vec3(0.62, 0.50, 0.34);
            vec3 gravel = mix(vec3(0.28, 0.26, 0.22), mix(cCool, cWarm, pbLarge.g), cobble);
            gravel = mix(gravel, mix(cWarm, cOchre, pbMed.r), peb * 0.65);
            gravel *= 0.82 + 0.34 * pbFine.b;
            // lush mossy grass fringe creeping over the dry upper stream bank
            float bankMoss = smoothstep(0.58, 0.22, bed) * smoothstep(0.32, 0.68, pbLarge.r);
            gravel = mix(gravel, vec3(0.12, 0.32, 0.08), bankMoss * 0.75);
            // keep visible river ribbon tone from the summit!
            gravel = mix(gravel, vec3(0.10, 0.28, 0.34), smoothstep(140.0, 520.0, dist) * 0.75);
            col = mix(col, gravel * 0.85, smoothstep(0.18, 0.48, bed));
            t_wet = max(t_wet, smoothstep(0.25, 0.55, bed) * 0.85);
          }

          col *= 0.93 + 0.14 * nH.a;

          // --- HAND-PAINTED GRAPHIC BotW / Firewatch / Studio Ghibli ALPINE MOUNTAIN SHADER ---
          // Zero noise-bump wax ripples! Low-frequency planar macro form + graphic 3-value rock strata,
          // sharp dark crevice ink pass & hard-edged bright snow caps!
          vec3 mtnNAdd = vec3(0.0);
          {
            float farZ = smoothstep(1150.0, 2250.0, dist);
            if (farZ > 0.0) {
              float sB = 1.0 - n.y;
              // bold graphic geological rock strata shelves & sharp crevice ink fractures (painted as FLAT SHAPES, NEVER bump!)
              float strataArg = h * 0.018 + wp.x * 0.00055 - wp.z * 0.00045 + nH.g * 2.2;
              float strataFlat = smoothstep(0.44, 0.56, sin(strataArg) * 0.5 + 0.5);
              float strataCrack = smoothstep(0.0, 0.085, abs(fract(strataArg * 0.31831) - 0.5));
              // steep diagonal rock fracture ink lines cutting crisply across exposed cliff faces
              float diagA = fract((wp.x * 0.0011 + wp.z * 0.0008 - h * 0.0032) + nH.b * 0.55);
              float diagB = fract((wp.x * 0.0007 - wp.z * 0.0012 + h * 0.0024) + nz.r * 0.32);
              float crevInk = min(
                smoothstep(0.0, 0.055, abs(diagA - 0.5)),
                mix(0.45, 1.0, smoothstep(0.0, 0.065, abs(diagB - 0.5)))
              );
              float inkPass = mix(0.56, 1.0, min(strataCrack, crevInk));

              // clean forested alpine pine foothills with flat painted elevation tone
              vec3 lowPine = mix(vec3(0.055, 0.175, 0.082), vec3(0.115, 0.235, 0.095), smoothstep(0.38, 0.62, nH.r));
              lowPine = mix(lowPine, vec3(0.145, 0.225, 0.105), smoothstep(520.0, 920.0, h) * 0.45);

              // bold high-contrast dark alpine slate-granite in 3 graphic value steps (pops unmistakably against hard-edged white snow!)
              vec3 stoneDeep  = vec3(0.11, 0.14, 0.24);
              vec3 stoneMid   = vec3(0.24, 0.27, 0.37);
              vec3 stoneLit   = vec3(0.40, 0.40, 0.46);
              float facVal = nH.b * 0.55 + nz.r * 0.45;
              float facBand = smoothstep(0.38, 0.46, facVal) * 0.5 + smoothstep(0.62, 0.70, facVal) * 0.5;
              vec3 stone = mix(stoneDeep, stoneMid, smoothstep(0.0, 0.5, facBand));
              stone = mix(stone, stoneLit, smoothstep(0.5, 1.0, facBand) * 0.75 + strataFlat * 0.38);
              // crisp dark crevice ink lines strictly on steep exposed rock faces!
              stone *= mix(1.0, inkPass, smoothstep(0.26, 0.44, sB));

              // crisp painterly timberline break (ZERO washed-out green/lavender gradient wall!)
              float timberAlt = 960.0 + (nH.g - 0.5) * 240.0 - sB * 1350.0;
              float rockMask = smoothstep(timberAlt - 65.0, timberAlt + 70.0, h);
              rockMask = max(rockMask, smoothstep(0.30, 0.37, sB) * smoothstep(460.0, 680.0, h));
              vec3 zc = mix(lowPine, stone, rockMask);

              // HARD-EDGED BotW / Studio Ghibli snow caps clinging crisply to high, flatter-ish faces & ridges
              // -> steep dark granite walls slice razor-clean through the snow (ZERO marshmallow fade, ZERO melted wax!)
              float sl = 1160.0 + (nH.r - 0.5) * 190.0 - n.z * 110.0;
              float edgeJ = (nz.g - 0.5) * 0.045;
              float snSlope   = smoothstep(0.38, 0.34, sB + edgeJ) * smoothstep(sl - 18.0, sl + 18.0, h);
              float snHighCap = smoothstep(0.50, 0.46, sB + edgeJ) * smoothstep(sl + 230.0, sl + 265.0, h);
              float snLedge   = strataFlat * smoothstep(0.45, 0.36, sB) * smoothstep(sl + 20.0, sl + 80.0, h) * 0.75;
              float sn = smoothstep(0.35, 0.55, max(max(snSlope, snHighCap), snLedge));
              // crisp bright white sunlit snow vs clean cool glacier-blue shadow snow (handled by 3-step toon lighting!)
              vec3 snowFarCol = mix(vec3(0.88, 0.93, 1.0), vec3(0.995, 0.998, 1.0), smoothstep(sl + 60.0, sl + 360.0, h));
              zc = mix(zc, snowFarCol, sn);
              t_snowFar = sn * farZ;
              col = mix(col, zc, farZ);
            }
          }

          t_albedo = col;
          // 100% MATTE painterly rock & snow (roughness >= 0.90 -> ZERO glossy plastic highlights!)
          t_rough = mix(0.96, 0.90, max(snowW, t_snowFar));
          t_rough = mix(t_rough, 0.66, t_wet * smoothstep(0.1, 0.5, wfZone));

          // Near detail bump + sculpted mountain ridge & strata normals (ZERO blobby normal-quantize rings!)
          vec2 gd = vec2(nf.g - texture(uNoiseTex, xz * 0.63 + vec2(0.002, 0.0)).g,
                         nf.g - texture(uNoiseTex, xz * 0.63 + vec2(0.0, 0.002)).g);
          float bump = mix(0.35, 1.8, max(rockW, bed * 0.6)) * fadeF;
          vec2 gdm = vec2(nm.r - texture(uNoiseTex, xz * 0.013 + vec2(0.002, 0.0)).r,
                          nm.r - texture(uNoiseTex, xz * 0.013 + vec2(0.0, 0.002)).r);
          n = normalize(n + vec3(gd.x, 0.0, gd.y) * bump + vec3(gdm.x, 0.0, gdm.y) * 1.4 * rockW * fadeM * (1.0 - fb) + cliffNAdd + mtnNAdd);
          t_normal = n;
        }
      `,
      fragment: [
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          terrainSurface(vWPos, length(vWPos - cameraPosition));
          diffuseColor.rgb = t_albedo;
          // caustics & emerald-turquoise absorption on the lake bed
          float depthW = uWaterLevel - vWPos.y;
          if (depthW > 0.0) {
            vec2 cp = vWPos.xz * 0.35;
            float c1 = texture(uNoiseTex, cp * 0.11 + uTime * 0.012).a;
            float c2 = texture(uNoiseTex, cp * 0.13 - uTime * 0.010 + 0.5).a;
            float caust = pow(clamp(1.0 - abs(c1 - c2) * 3.5, 0.0, 1.0), 5.0);
            diffuseColor.rgb *= exp(-depthW * vec3(0.32, 0.09, 0.07));
            diffuseColor.rgb += vec3(0.65, 0.98, 1.0) * caust * 0.42 * exp(-depthW * 0.24) * max(uSunDir.y, 0.0);
          }
          diffuseColor.rgb *= mix(1.0, 0.56, t_wet);
          if (uAOSpot.z > 0.0) {
            float dA = length(vWPos.xz - uAOSpot.xy);
            diffuseColor.rgb *= 1.0 - uAOSpot.w * (1.0 - smoothstep(uAOSpot.z * 0.75, uAOSpot.z * 1.35, dA));
            t_glowWarm = 1.0 - smoothstep(uAOSpot.z * 0.55, uAOSpot.z * 1.85, dA);
            t_glowWarm *= t_glowWarm;
          }
          // alpenglow strictly on high alpine snow & rock peaks (never lower hills)
          t_glow = uAlpenglow * smoothstep(1250.0, 1950.0, vWPos.y);
        `],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            // alpenglow strictly on SUN-FACING high peaks (shadow faces stay crisp deep alpine indigo-violet in dawn.png & lakeSunset.png!)
            vec3 NwA = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            float sunPeakFace = smoothstep(0.02, 0.32, dot(NwA, uLightDir));
            totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.46, 0.50) * t_glow * 0.68 * sunPeakFace * w_sunVis;
          }
          // localized cozy cottage window & porch glow strictly around cottage yard (keeps foreground road cool twilight blue!)
          totalEmissiveRadiance += (diffuseColor.rgb * 0.90 + vec3(0.03, 0.018, 0.008)) * w_warmSpill(vWPos) * 1.05;
          totalEmissiveRadiance += (diffuseColor.rgb * 0.45 + vec3(0.03, 0.018, 0.008)) * vec3(1.0, 0.56, 0.22) * t_glowWarm * max(uNight, uDusk * 0.92) * 0.012;
          // daytime ochre trail bounce STRICTLY gated to open meadow daytime (ZERO at golden/dusk/night or deep shaded forest!)
          {
            float trM = smoothstep(0.35, 0.60, max(w_trailRaw(vWPos.xz), 0.0));
            float openPath = 1.0 - smoothstep(0.32, 0.68, w_biome(vWPos.xz).r) * 0.85;
            float dayTrail = smoothstep(0.08, 0.24, uLightDir.y) * (1.0 - max(uGolden, uDawn) * 0.90) * (1.0 - uDusk) * (1.0 - uNight) * openPath;
            totalEmissiveRadiance += vec3(0.12, 0.08, 0.035) * trM * dayTrail;
          }
          // bold high-contrast golden dappled sunlight pools & radiant sunlit clearing at the end of the forest trail (forest.png!)
          {
            float cotClear = uAOSpot.z > 0.1 ? smoothstep(26.0, 48.0, length(vWPos.xz - uAOSpot.xy)) : 1.0;
            float fz = smoothstep(0.46, 0.82, w_biome(vWPos.xz).r) * cotClear * (1.0 - w_nearBlend(vWPos.xz));
            float sunH = smoothstep(0.05, 0.22, uLightDir.y) * (1.0 - uNight);
            vec2 sunProj = vWPos.xz - uLightDir.xz / max(uLightDir.y, 0.25) * 6.0;
            vec2 dp1 = sunProj * 0.028 + uWindDir * sin(uTime * 0.28) * 0.02;
            vec2 dp2 = mat2(0.8, -0.6, 0.6, 0.8) * sunProj * 0.064;
            float n1 = texture(uNoiseTex, dp1).r;
            float n2 = texture(uNoiseTex, dp2 + 0.31).g;
            // crisp sunlit dappled patches splashing across shaded forest trail & mossy banks!
            float pool = smoothstep(0.50, 0.70, n1 * 0.60 + n2 * 0.40);
            float dCam = length(vWPos - cameraPosition);
            float midGlade = smoothstep(14.0, 26.0, dCam) * (1.0 - smoothstep(38.0, 58.0, dCam));
            float gladePool = max(pool * 0.95, midGlade * smoothstep(0.24, 0.58, n1 * 0.65 + n2 * 0.35) * 1.35);
            float trailBoost = 1.0 + 0.38 * smoothstep(0.12, 0.55, max(w_trailRaw(vWPos.xz), 0.0));
            totalEmissiveRadiance += diffuseColor.rgb * uLightColor * vec3(1.18, 0.98, 0.52) * gladePool * fz * 0.96 * trailBoost * sunH;
            // warm first-light dawn bounce strictly on near sunlit foreground hillside (dawn.png!)
            float nearDawn = uDawn * smoothstep(180.0, 20.0, dCam) * (1.0 - smoothstep(0.35, 0.75, w_biome(vWPos.xz).r));
            totalEmissiveRadiance += diffuseColor.rgb * vec3(0.46, 0.28, 0.12) * nearDawn * 0.48;
            // warm sunset valley bounce light on open evening meadows (summitWest.png!)
            float goldValley = uGolden * (1.0 - uDawn) * smoothstep(450.0, 120.0, vWPos.y) * (1.0 - smoothstep(0.25, 0.68, w_biome(vWPos.xz).r)) * (1.0 - w_nearBlend(vWPos.xz));
            totalEmissiveRadiance += diffuseColor.rgb * vec3(0.36, 0.22, 0.06) * goldValley * 0.22 * sunH;
          }
          {
            // dramatic golden-apricot backlit ridge rim on mountains flanking the setting sun (summitWest.png!) & crisp high peak silhouette rim!
            vec3 Vw = normalize(cameraPosition - vWPos);
            vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
            float distM = length(vWPos - cameraPosition);
            float highPeakOnly = smoothstep(1050.0, 1620.0, vWPos.y) * smoothstep(1400.0, 3400.0, distM);
            float rim = pow(1.0 - max(dot(Nw, Vw), 0.0), 2.8) * highPeakOnly;
            float sunSide = smoothstep(0.02, 0.58, dot(Nw, uLightDir));
            vec3 rimTint = mix(vec3(1.0, 0.95, 0.86), vec3(1.0, 0.74, 0.36), max(uGolden, uDawn));
            totalEmissiveRadiance += uLightColor * rimTint * rim * sunSide * 0.08 * w_sunVis * smoothstep(0.0, 0.12, uLightDir.y) * (1.0 - uNight);
            // Firewatch/Ghibli golden backlit rim blazing along mountain ridges facing the setting sun notch!
            float backSun = pow(max(dot(-Vw, uSunDir), 0.0), 4.0);
            float ridgeBack = pow(1.0 - max(dot(Nw, Vw), 0.0), 2.2) * smoothstep(650.0, 1450.0, vWPos.y) * smoothstep(1800.0, 4200.0, distM);
            totalEmissiveRadiance += uSunColor * vec3(1.0, 0.68, 0.28) * ridgeBack * backSun * uGolden * (1.0 - uDawn) * 0.95;
          }`],
        ['#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = t_rough;'],
        ['#include <normal_fragment_begin>', /* glsl */ `
          #include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(t_normal, 0.0)).xyz);
        `],
      ],
    });
    this.material = mat;
  }

  setTier(tier) {
    const nextN = tier.terrainN ?? DEFAULT_N;
    const nextLodK = tier.terrainLodK ?? DEFAULT_LOD_K;
    const nextMax = tier.terrainMaxNodes ?? DEFAULT_MAX_NODES;
    if (nextN === this.N && nextMax === this.maxNodes) {
      this.lodK = nextLodK;
      this.uniforms.uLodK.value = nextLodK;
      return;
    }
    const oldGeo = this.geometry;
    const oldMat = this.material;
    this._buildResources(tier);
    this.mesh.geometry = this.geometry;
    this.mesh.material = this.material;
    oldGeo.dispose();
    oldMat.dispose();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  update(camera, groundY) {
    const cx = camera.position.x, cz = camera.position.z;
    const dy = Math.max(0, camera.position.y - groundY);
    this.uniforms.uCamDY.value = dy;
    this.uniforms.uCamXZ.value.set(cx, cz);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    let count = 0;
    const arr = this.nodeArr;
    const box = this._box;
    const frustum = this._frustum;
    const maxNodes = this.maxNodes;
    const lodK = this.lodK;
    const visit = (x0, z0, size) => {
      if (count >= maxNodes) return;
      box.min.set(x0, -200, z0);
      box.max.set(x0 + size, 4200, z0 + size);
      if (!frustum.intersectsBox(box)) return;
      const ddx = Math.max(x0 - cx, 0, cx - (x0 + size));
      const ddz = Math.max(z0 - cz, 0, cz - (z0 + size));
      const d = Math.hypot(Math.hypot(ddx, ddz), dy);
      if (size > MIN_SIZE && d < lodK * size) {
        const h = size / 2;
        visit(x0, z0, h); visit(x0 + h, z0, h); visit(x0, z0 + h, h); visit(x0 + h, z0 + h, h);
      } else {
        const i = count * 4;
        arr[i] = x0; arr[i + 1] = z0; arr[i + 2] = size; arr[i + 3] = 0;
        count++;
      }
    };
    visit(-ROOT / 2, -ROOT / 2, ROOT);
    this.geometry.instanceCount = count;
    this.nodeAttr.needsUpdate = true;
    this.nodeAttr.clearUpdateRanges();
    this.nodeAttr.addUpdateRange(0, count * 4);
    return count;
  }
}

export function createTerrain(ctx) {
  const terrain = new Terrain(ctx.tier);
  ctx.scene.add(terrain.mesh);
  return {
    instance: terrain,
    update(frame) {
      terrain.update(frame.camera, frame.groundY);
    },
    setTier(tier) {
      terrain.setTier(tier);
    },
    dispose() {
      terrain.dispose();
    },
  };
}
