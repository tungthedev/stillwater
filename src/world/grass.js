import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { LAYER_NO_REFLECT } from './water.js';
import { mulberry32 } from './biome.js';

// GPU living meadow grass & botanical species-drifted wildflowers:
// - Clumped non-grid tufts (kills the shag-rug & dawn comb pattern!)
// - Tall path-edge plumes, clover lows, dry sun-kissed tips, wind-gust color waves
// - Per-time-of-day amber tip sheen & warm cottage lantern spill at dusk/night

function bladeGeometry(segs = 4) {
  const pos = [], idx = [];
  for (let i = 0; i < segs; i++) {
    const y = i / segs;
    pos.push(-0.5, y, 0, 0.5, y, 0);
  }
  pos.push(0, 1, 0);
  for (let i = 0; i < segs - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const t = (segs - 1) * 2;
  idx.push(t, t + 1, segs * 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// Organic clumped scatter (eliminates regular grid rows & comb lines on slopes!)
function scatter(geo, count, patch, seed, clumped = true) {
  const rnd = mulberry32(seed);
  const off = new Float32Array(count * 2);
  const r4 = new Float32Array(count * 4);
  const side = Math.ceil(Math.sqrt(count));
  const cell = patch / side;
  for (let i = 0; i < count; i++) {
    let ox, oz;
    if (clumped && (i % 5 !== 0)) {
      // pull 80% of blades into natural soft tufts around randomized anchor points
      const gx = i % side, gz = (i / side) | 0;
      const cx = (gx + 0.5 + (rnd() - 0.5) * 1.9) * cell;
      const cz = (gz + 0.5 + (rnd() - 0.5) * 1.9) * cell;
      const ang = rnd() * Math.PI * 2;
      const rad = Math.sqrt(rnd()) * cell * 0.85;
      ox = ((cx + Math.cos(ang) * rad) % patch + patch) % patch;
      oz = ((cz + Math.sin(ang) * rad) % patch + patch) % patch;
    } else {
      ox = rnd() * patch;
      oz = rnd() * patch;
    }
    off[i * 2] = ox;
    off[i * 2 + 1] = oz;
    r4[i * 4] = rnd(); r4[i * 4 + 1] = rnd(); r4[i * 4 + 2] = rnd(); r4[i * 4 + 3] = rnd();
  }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
  geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(r4, 4));
  geo.instanceCount = count;
}

const GRASS_VERTEX = /* glsl */ `
  vec2 rel = mod(aOff - uCamXZ + uPatch * 0.5, uPatch) - uPatch * 0.5;
  vec2 xz = uCamXZ + rel;
  float dist = length(rel);
  float h = w_height(xz);
  vec3 tn = w_normal(xz, 1.0);
  vec4 bio = w_biome(xz);
  float trail = w_trail(xz);
  float dens = smoothstep(0.30, 0.58, tn.y);
  // organic trampled grass verge creeping unevenly onto soft dirt trail margins (kills smooth oval decal edge in saddle.png!)
  dens *= 1.0 - smoothstep(0.28, 0.60, trail + (aRnd.x - 0.5) * 0.30);
  dens *= 1.0 - 0.92 * w_yard(xz);
  float reedZone = (1.0 - smoothstep(0.2, 0.9, abs(h - uWaterLevel + 0.1))) * smoothstep(0.52, 0.74, texture(uNoiseTex, xz * 0.035 + 0.4).r);
  dens *= max(smoothstep(uWaterLevel + 0.15, uWaterLevel + 1.0, h), reedZone);
  dens *= 1.0 - smoothstep(1050.0, 1300.0, h);
  // keep cottage foreground lawn lush knee-high meadow grass; suppress sparse cone grass shards inside deep shady forest (ferns & moss own forest.png!)
  float cotMeadow = uAOSpot.z > 0.1 ? (1.0 - smoothstep(32.0, 52.0, length(xz - uAOSpot.xy))) : 0.0;
  float forestAmt = smoothstep(0.28, 0.66, bio.r) * (1.0 - cotMeadow);
  dens *= mix(1.0, 0.04, smoothstep(0.36, 0.74, forestAmt));
  float keep = 1.0 - smoothstep(uRadius * 0.68, uRadius, dist);
  // denser rich near-camera grass & short clover tufts filling bare ground cleanly within 28m
  float thin = step(aRnd.w, mix(1.0, 0.46, smoothstep(26.0, uRadius, dist)));

  // organic meadow clumping: 3 distinct clump archetypes (short dense clover tufts, sweeping curved blades & tall swaying golden seed-plumes!)
  vec4 clumpN = texture(uNoiseTex, xz * 0.055 + 0.19);
  vec4 patchN = texture(uNoiseTex, xz * 0.014 + 0.63);
  float clump = smoothstep(0.12, 0.78, clumpN.g * 0.65 + patchN.r * 0.35);
  dens *= max(smoothstep(0.05, 0.30, clumpN.g + 0.28), cotMeadow * 0.85);
  float scale = dens * keep * thin;

  // tall wild tufts along path verges + fuller velvety near-camera grass & low clover fill
  float pathEdge = smoothstep(0.04, 0.22, trail) * (1.0 - smoothstep(0.28, 0.46, trail));
  float plume = step(0.80, aRnd.y) * smoothstep(0.42, 0.72, clumpN.a);
  float isShortUnder = step(aRnd.x, 0.38) * (1.0 - smoothstep(22.0, 38.0, dist));
  float tall = mix(0.20, 0.60, max(bio.b * 0.55 + clump * 0.55, cotMeadow * 0.78)) * mix(0.62, 1.42, aRnd.y);
  tall = mix(tall, 0.14 + 0.15 * aRnd.y, isShortUnder * 0.80);
  tall = mix(tall, 0.14 + 0.14 * aRnd.y, forestAmt * 0.72);
  tall += pathEdge * (0.18 + 0.24 * aRnd.x) + plume * 0.30 * (1.0 - forestAmt * 0.7);
  // keep summit crown alpine turf crisp & low directly on the summit crest so Stillwater Lake gleams unobstructed below!
  tall *= mix(1.0, 0.42, smoothstep(388.0, 412.0, h));
  tall *= mix(1.0, 0.55, smoothstep(700.0, 1050.0, h));
  tall = mix(tall, mix(1.15, 2.0, aRnd.y), reedZone);
  float height = tall * scale;
  float width = mix(0.050, 0.088, isShortUnder) * mix(0.68, 1.42, aRnd.x) * (1.0 + dist * 0.028) * step(0.001, scale);

  float y = position.y;
  float yaw = aRnd.z * 6.2831853 + clumpN.r * 2.5;
  vec2 fwd = vec2(cos(yaw), sin(yaw));
  vec2 sd = vec2(-fwd.y, fwd.x);
  // bold BotW sweeping wind-gust waves + per-blade flutter (creates unmistakable sunlit light/dark rhythm across pasture & trailhead!)
  float gust = texture(uNoiseTex, xz * 0.0082 - uWindDir * uTime * 0.042).r;
  float gust2 = texture(uNoiseTex, xz * 0.024 - uWindDir * uTime * 0.075 + 0.4).g;
  float wave = smoothstep(0.26, 0.76, gust * 0.72 + gust2 * 0.28);
  float flutter = sin(uTime * (2.0 + aRnd.y * 1.6) + aRnd.x * 6.28 + dot(xz, uWindDir) * 0.55) * 0.16;
  float bend = (0.10 + aRnd.y * 0.34) + (wave * 0.82 + flutter) * (0.28 + uWindStrength * 0.82);
  // player pushes grass aside
  vec2 toP = xz - uPlayerXZ;
  float pd = length(toP);
  float push = (1.0 - smoothstep(0.2, 1.1, pd));
  vec2 bendDir = normalize(fwd * 0.48 + uWindDir * (0.25 + wave * 1.45) + (toP / max(pd, 0.01)) * push * 3.0);
  bend += push * 1.2;
  float c = y * y * bend;
  vec3 p;
  p.xz = xz + sd * position.x * width * (1.0 - y * 0.9) + bendDir * c * height * 0.8;
  p.y = h + y * height * (1.0 - min(c, 1.0) * 0.35) - 0.02;
  vec3 transformed = p;
  vGrassY = y;
  vGrassWave = wave;

  // bold painterly BotW value & hue rhythm: deep shaded emerald-clover hollows vs sunlit sweeping golden-green wind crests!
  vec3 gcol = w_grassColor(xz, h);
  float hollow = smoothstep(0.48, 0.78, patchN.b) * (1.0 - wave * 0.55);
  gcol = mix(gcol, vec3(0.036, 0.20, 0.095), hollow * 0.62);
  float dryTip = smoothstep(0.46, 0.82, patchN.g + aRnd.y * 0.35 + plume * 0.52);
  vec3 tipBase = gcol * mix(0.96, 1.36, aRnd.y);
  vec3 tipWarm = mix(tipBase, vec3(0.62, 0.52, 0.16), dryTip * 0.56);
  // sweeping sunlit wind-wave crests roll clearly across big grass fields (kills repetitive flat green plane in pasture & trailhead!)
  tipWarm = mix(tipWarm * vec3(0.84, 0.92, 0.96), tipWarm * vec3(1.28, 1.22, 0.82) + vec3(0.04, 0.04, 0.0), wave);
  // golden hour & dawn amber-honey tips
  tipWarm = mix(tipWarm, tipWarm * vec3(1.18, 0.96, 0.72), max(uGolden, uDawn) * 0.45);
  vec3 baseCol = gcol * mix(0.68, 0.82, max(uDawn, uGolden)) * (0.86 + 0.24 * wave);
  vGrassCol = mix(baseCol, tipWarm, smoothstep(0.0, 1.0, y));
  vGrassCol *= 0.88 + 0.24 * aRnd.x;
  vGrassCol = mix(vGrassCol, mix(vec3(0.11, 0.22, 0.07), vec3(0.46, 0.44, 0.17), y), reedZone);
  vGrassCol *= mix(1.0, 0.74, smoothstep(0.4, 0.85, bio.r));
  vGrassN = normalize(tn + vec3(0.0, 0.42, 0.0));
`;

export class Grass {
  constructor(count, radius) {
    this.radius = radius;
    this.patch = radius * 2;
    const geo = bladeGeometry(4);
    scatter(geo, count, this.patch, 1337, true);
    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uPlayerXZ: { value: new THREE.Vector2(1e5, 1e5) },
      uPatch: { value: this.patch },
      uRadius: { value: radius },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, side: THREE.DoubleSide });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        attribute vec2 aOff; attribute vec4 aRnd;
        uniform vec2 uCamXZ; uniform vec2 uPlayerXZ; uniform float uPatch; uniform float uRadius;
        varying float vGrassY; varying float vGrassWave; varying vec3 vGrassCol; varying vec3 vGrassN;
      `,
      vertex: [
        ['#include <begin_vertex>', GRASS_VERTEX],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: /* glsl */ `
        varying float vGrassY; varying float vGrassWave; varying vec3 vGrassCol; varying vec3 vGrassN;
      `,
      fragment: [
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          diffuseColor.rgb = vGrassCol;
          // softer root darkening prevents harsh dark comb stripes at dawn!
          diffuseColor.rgb *= mix(0.84, 1.0, smoothstep(0.0, 0.45, vGrassY));
        `],
        ['#include <normal_fragment_begin>', /* glsl */ `
          #include <normal_fragment_begin>
          normal = normalize((viewMatrix * vec4(vGrassN, 0.0)).xyz);
        `],
        ['#include <emissivemap_fragment>', /* glsl */ `
          #include <emissivemap_fragment>
          {
            vec3 Vw = normalize(vWPos - cameraPosition);
            float back = pow(max(dot(Vw, uLightDir), 0.0), 3.6);
            float lowSun = max(uGolden, uDawn);
            vec3 sheenTint = mix(vec3(1.0, 1.0, 0.90), vec3(1.08, 0.80, 0.48), lowSun);
            float litK = w_sunVis * smoothstep(-0.02, 0.08, uLightDir.y);
            // translucent sunlit blade tips + wind-gust sparkle
            totalEmissiveRadiance += vGrassCol * uLightColor * sheenTint * (back * 0.75 + 0.03 + vGrassWave * 0.05) * vGrassY * litK;
            // golden hour & dawn warm peach-gold rim light kissing foreground grass tips (unifies dawn foreground with rosy-gold peaks!)
            float fresG = pow(1.0 - abs(dot(normalize(vGrassN), -Vw)), 2.0);
            vec3 dewCol = mix(vec3(0.30, 0.22, 0.16), vec3(0.92, 0.56, 0.34), uDawn);
            totalEmissiveRadiance += (vGrassCol * dewCol + vec3(0.10, 0.055, 0.025) * uDawn) * (0.36 + 0.72 * fresG) * (0.28 + 0.72 * vGrassY) * lowSun * (1.0 - litK * 0.38);
            // cool twilight blue-violet sky sheen on dusk foreground blades + velvety silver-blue moonlight tip sheen at night!
            float duskOnly = uDusk * (1.0 - uNight * 0.75);
            totalEmissiveRadiance += (vGrassCol * vec3(0.18, 0.26, 0.58) + vec3(0.008, 0.012, 0.028)) * (0.25 + 0.75 * fresG) * (0.30 + 0.70 * vGrassY) * duskOnly * 0.14;
            totalEmissiveRadiance += (vGrassCol * vec3(0.20, 0.34, 0.62) + vec3(0.005, 0.010, 0.022)) * (0.20 + 0.80 * fresG) * smoothstep(0.25, 1.0, vGrassY) * uNight * 0.085;
            // forest floor bounce
            float fz = smoothstep(0.4, 0.85, w_biome(vWPos.xz).r);
            totalEmissiveRadiance += vGrassCol * vec3(0.9, 1.0, 0.6) * fz * 0.04 * length(uLightColor) * (1.0 - uNight);
            // warm golden cottage lantern & window light spill on grass at dusk/night!
            totalEmissiveRadiance += (vGrassCol * 1.15 + vec3(0.03, 0.018, 0.008)) * w_warmSpill(vWPos) * (0.55 + 0.65 * vGrassY);
          }
        `],
      ],
    });
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(camPos, playerPos) {
    this.uniforms.uCamXZ.value.set(camPos.x, camPos.z);
    if (playerPos) this.uniforms.uPlayerXZ.value.set(playerPos.x, playerPos.z);
  }
}

// ---------------- botanical species-drifted wildflowers ----------------
function flowerGeometry() {
  // stem (thin quad) + head (facing quad)
  const pos = [], uv = [], part = [], idx = [];
  pos.push(-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0); uv.push(0, 0, 1, 0, 0, 1, 1, 1); part.push(0, 0, 0, 0);
  idx.push(0, 1, 2, 1, 3, 2);
  pos.push(-0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, 1, 0.5, 0.5, 1, 0.5); uv.push(0, 0, 1, 0, 0, 1, 1, 1); part.push(1, 1, 1, 1);
  idx.push(4, 6, 5, 5, 6, 7);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

export class Flowers {
  constructor(count, radius) {
    this.patch = radius * 2;
    const geo = flowerGeometry();
    scatter(geo, count, this.patch, 4242, true);
    this.uniforms = {
      uCamXZ: { value: new THREE.Vector2() },
      uPatch: { value: this.patch },
      uRadius: { value: radius },
    };
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, side: THREE.DoubleSide });
    patchMaterial(mat, {
      uniforms: this.uniforms,
      vertexPars: /* glsl */ `
        attribute vec2 aOff; attribute vec4 aRnd; attribute float aPart; attribute vec2 aUv;
        uniform vec2 uCamXZ; uniform float uPatch; uniform float uRadius;
        varying vec2 vFUv; varying float vFPart; varying vec3 vFCol; varying float vFKind; varying float vFAo;
      `,
      vertex: [
        ['#include <begin_vertex>', /* glsl */ `
          vec2 rel = mod(aOff - uCamXZ + uPatch * 0.5, uPatch) - uPatch * 0.5;
          vec2 xz = uCamXZ + rel;
          float dist = length(rel);
          float h = w_height(xz);
          vec3 tn = w_normal(xz, 1.0);
          vec4 bio = w_biome(xz);
          float trail = w_trail(xz);
          // natural clumped botanical bouquets (rich organic flower clusters separated by grassy pockets — NOT evenly spaced stickers!)
          vec4 driftTex = texture(uNoiseTex, xz * 0.011 + 0.29);
          float clump = texture(uNoiseTex, xz * 0.058 + aRnd.z * 0.05).g;
          float bouquet = texture(uNoiseTex, xz * 0.22 + 0.41).r;
          float clMask = smoothstep(0.46, 0.76, clump * 0.68 + bouquet * 0.32);
          float cotFl = uAOSpot.z > 0.1 ? (1.0 - smoothstep(26.0, 44.0, length(xz - uAOSpot.xy))) * smoothstep(0.48, 0.76, clump) * 0.58 : 0.0;
          float pastureDaisy = bio.b * (1.0 - smoothstep(0.15, 0.45, bio.r)) * smoothstep(0.54, 0.80, clump) * 0.48;
          float alpineBloom  = smoothstep(320.0, 405.0, h) * (1.0 - smoothstep(0.20, 0.55, bio.r)) * smoothstep(0.46, 0.76, clump) * 0.65;
          float flowerField = max(max(bio.g * clMask * (0.85 + 0.35 * driftTex.r), cotFl), max(pastureDaisy, alpineBloom));
          float dens = flowerField;
          dens *= smoothstep(0.48, 0.74, tn.y) * (1.0 - smoothstep(0.06, 0.34, trail));
          dens *= 1.0 - w_yard(xz);
          dens *= smoothstep(uWaterLevel + 0.4, uWaterLevel + 1.5, h);
          float keep = (1.0 - smoothstep(uRadius * 0.62, uRadius, dist)) * step(aRnd.w, dens * 0.94);

          // strong single-species regional drifting (88% follows drift patch, 12% accent scatter)
          float spVal = clamp(driftTex.b * 1.45 - 0.22 + (driftTex.g - 0.5) * 0.35, 0.0, 0.999);
          float kind = aRnd.x < 0.88 ? floor(spVal * 4.0) : floor(fract(aRnd.x * 9.3) * 4.0);
          // wide botanical height & bloom size variation; keep pink campion compact & nestled inside grass (NEVER pasted-on stickers in trailhead.png!)
          float sizeVar = mix(0.55, 1.40, fract(aRnd.y * 7.3));
          float baseH = (kind < 0.5 ? mix(0.22, 0.44, aRnd.y)
                      : kind < 1.5 ? mix(0.16, 0.32, aRnd.y)
                      : kind < 2.5 ? mix(0.28, 0.54, aRnd.y)
                      :              mix(0.20, 0.40, aRnd.y));
          float stemH = baseH * keep;
          float headS = (kind < 0.5 ? 0.095 : kind < 1.5 ? 0.082 : kind < 2.5 ? 0.098 : 0.072)
                      * sizeVar * keep * (1.0 + dist * 0.022);

          float gust = smoothstep(0.3, 0.8, texture(uNoiseTex, xz * 0.010 - uWindDir * uTime * 0.042).r);
          vec2 sway = uWindDir * (gust * 0.6 + 0.1) * (0.3 + uWindStrength) + vec2(sin(uTime * 2.3 + aRnd.z * 9.0), cos(uTime * 1.9 + aRnd.x * 7.0)) * 0.05;
          vec3 toC = normalize(cameraPosition - vec3(xz.x, h + stemH, xz.y));
          vec3 hr = normalize(cross(vec3(0.0, 1.0, 0.0), toC));
          vec3 p;
          if (aPart < 0.5) {
            // visibly sculpted tapered green stem facing camera cleanly in XZ (NEVER invisible sub-pixel hairline!)
            float y = position.y;
            float sw = mix(0.022, 0.012, y) * keep;
            p = vec3(xz.x, h + y * stemH - 0.02, xz.y) + hr * position.x * sw;
            p.xz += sway * y * y * stemH;
          } else {
            if (kind > 1.5 && kind < 2.5) {
              vec3 upV = vec3(0.0, 1.0, 0.0);
              p = vec3(xz.x, h + stemH * 0.88, xz.y) + hr * position.x * headS * 0.42 + upV * (position.z + 0.15) * headS * 1.55;
            } else {
              // naturally tilted 3D blossom cups (facing sky/sun/sideways — NEVER flat identical camera stickers!)
              float tiltA = aRnd.z * 6.2831;
              vec3 tiltDir = vec3(cos(tiltA), 0.0, sin(tiltA));
              vec3 hn = normalize(vec3(0.0, 0.72 + 0.28 * aRnd.y, 0.0) + tiltDir * (0.36 + 0.34 * fract(aRnd.x * 13.7)) + toC * (0.16 + 0.22 * fract(aRnd.z * 5.1)));
              vec3 hr3 = normalize(cross(hn, abs(hn.x) < 0.85 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
              vec3 hu3 = normalize(cross(hn, hr3));
              float rotH = aRnd.x * 6.2831;
              vec3 ax1 = hr3 * cos(rotH) + hu3 * sin(rotH);
              vec3 ax2 = -hr3 * sin(rotH) + hu3 * cos(rotH);
              p = vec3(xz.x, h + stemH, xz.y) + ax1 * position.x * headS * 1.12 + ax2 * position.z * headS * 1.12;
            }
            p.xz += sway * stemH;
          }
          vec3 transformed = p;
          vFUv = aUv; vFPart = aPart; vFKind = kind;
          // ambient-occlusion depth tint where low blooms nestle deep in grass!
          vFAo = mix(0.68, 1.06, smoothstep(0.14, 0.44, baseH)) * (0.86 + 0.24 * fract(aRnd.z * 17.3));
          vec3 c0 = vec3(0.97, 0.96, 0.91);  // white alpine daisy
          vec3 c1 = vec3(1.0, 0.78, 0.12);   // golden buttercup
          vec3 c2 = mix(vec3(0.34, 0.34, 0.92), vec3(0.56, 0.36, 0.92), fract(aRnd.z * 11.3)); // lupin / gentian spire
          vec3 c3 = mix(vec3(0.84, 0.40, 0.60), vec3(0.96, 0.58, 0.74), fract(aRnd.y * 5.7));  // wild rose campion
          vFCol = kind < 0.5 ? c0 : kind < 1.5 ? c1 : kind < 2.5 ? c2 : c3;
        `],
        ['#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);'],
      ],
      fragmentPars: 'varying vec2 vFUv; varying float vFPart; varying vec3 vFCol; varying float vFKind; varying float vFAo;',
      fragment: [
        ['#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);'],
        ['#include <color_fragment>', /* glsl */ `
          #include <color_fragment>
          if (vFPart < 0.5) {
            diffuseColor.rgb = vec3(0.12, 0.32, 0.06) * mix(0.65, 1.05, vFUv.y);
          } else if (vFKind > 1.5 && vFKind < 2.5) {
            // delicate rounded lupin / lavender blossom cluster spike
            vec2 q = vFUv * 2.0 - 1.0;
            float env = sin(clamp((q.y + 1.0) * 0.5, 0.0, 1.0) * 3.14159);
            float tier = abs(sin((q.y + 1.0) * 9.5));
            float wLim = (0.36 + 0.52 * pow(env, 0.7)) * (0.55 + 0.45 * tier);
            if (abs(q.x) > wLim || abs(q.y) > 0.94) discard;
            vec3 tipCol = mix(vFCol * 0.80, vec3(0.86, 0.82, 1.0), smoothstep(-0.2, 0.85, q.y) * 0.42);
            diffuseColor.rgb = tipCol * (0.74 + 0.28 * tier) * vFAo;
          } else {
            vec2 q = vFUv * 2.0 - 1.0;
            float r = length(q);
            float a = atan(q.y, q.x);
            float petals = vFKind < 0.5 ? 10.0 : vFKind < 1.5 ? 5.0 : 5.0;
            float shape = (vFKind < 0.5 ? 0.54 : 0.56) + (vFKind < 0.5 ? 0.46 : 0.44) * abs(cos(a * petals * 0.5));
            if (r > shape) discard;
            // cupped 3D petal shading: rich deeper throat -> sunlit outer petal tips + soft grass contact AO!
            vec3 col = mix(vFCol * 0.72, vFCol * 1.12, smoothstep(0.18, 0.88, r));
            float center = smoothstep(0.28, 0.14, r);
            col = mix(col, vFKind < 0.5 ? vec3(1.0, 0.76, 0.10) : vFKind < 1.5 ? vec3(0.84, 0.46, 0.04) : vec3(0.95, 0.78, 0.22), center);
            diffuseColor.rgb = col * vFAo;
          }
        `],
        ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          // cottage lantern warm glow catches foreground wildflowers in cottageDusk & night!
          totalEmissiveRadiance += (diffuseColor.rgb * 1.2 + vec3(0.05, 0.03, 0.01)) * w_warmSpill(vWPos) * 1.15;`],
      ],
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
  }
  update(camPos) { this.uniforms.uCamXZ.value.set(camPos.x, camPos.z); }
}
