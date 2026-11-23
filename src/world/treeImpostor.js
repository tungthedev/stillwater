import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { IMPOSTOR_AZ, IMPOSTOR_EL, IMPOSTOR_ELEVATIONS } from './treeChunks.js';

// Far-tree impostors: an atlas of each species seen from IMPOSTOR_AZ x IMPOSTOR_EL directions, baked once at boot
// into two RGBA8 targets (albedo + alpha, view-space normal), and one camera-facing quad per tree that picks the
// nearest baked view for whichever camera renders it (main or lake reflection).
// RGBA8 only: iPhone Safari has no float-linear filtering, and 8-bit targets keep the atlas small.

const VIEWS = IMPOSTOR_AZ * IMPOSTOR_EL;
// Fraction of a tile left empty on each side so mip levels up to MAX_LOD never pull in the neighbouring tile.
const TILE_PAD = 0.04;

const BAKE_VERT = /* glsl */ `
  attribute vec3 aCrown;
  attribute vec3 color;
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec3 vCrown;
  varying vec3 vViewN;
  void main() {
    vUv = uv;
    vCol = color;
    vCrown = aCrown;
    vViewN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Unlit: only what does not depend on the light (texture, vertex colour, crown pockets). The runtime material adds
// sun, sky, toon ramp and atmosphere like the live trees. Albedo is stored gamma-2 encoded so dark greens keep
// precision in 8 bits.
const BAKE_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float uMode;
  varying vec2 vUv;
  varying vec3 vCol;
  varying vec3 vCrown;
  varying vec3 vViewN;
  void main() {
    bool bark = vUv.x > 0.895 || vCrown.z < 0.5;
    vec4 tx = texture2D(map, vUv);
    float a = bark ? 1.0 : tx.a;
    if (a < 0.44) discard;
    vec3 n = normalize(vViewN);
    if (!gl_FrontFacing) n = -n;
    if (uMode > 0.5) {
      gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
      return;
    }
    vec3 col;
    if (bark) {
      // Far trunks sit in crown shade and are a pixel or two wide; baked dark so they do not read as lit sticks.
      col = vec3(0.055, 0.036, 0.022);
      if (vCol.r > 0.25 && vCol.b > 0.2) col = vec3(0.16, 0.15, 0.14);
    } else {
      col = vCol * tx.rgb;
      float coreAO = clamp(vCrown.x, 0.26, 1.08);
      float topG = clamp(vCrown.y, 0.0, 1.0);
      col *= mix(0.30, 1.12, smoothstep(0.20, 0.94, coreAO) * (0.62 + 0.38 * topG));
    }
    gl_FragColor = vec4(sqrt(max(col, 0.0)), 1.0);
  }
`;

/**
 * Bake the atlas for the given species geometries (unit-height trees). Returns the two textures, the per-species
 * frame (centre + radius in tree units) and the grid layout the runtime material needs.
 */
export function bakeImpostorAtlas(renderer, geometries, leafMap, size) {
  const n = geometries.length;
  const tiles = n * VIEWS;
  const cols = Math.ceil(Math.sqrt(tiles));
  const tilePx = Math.floor(size / cols);
  const opts = {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
  };
  const albedoRT = new THREE.WebGLRenderTarget(size, size, opts);
  const normalRT = new THREE.WebGLRenderTarget(size, size, opts);
  const mat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    uniforms: { map: { value: leafMap }, uMode: { value: 0 } },
    side: THREE.DoubleSide,
  });
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  const frames = [];
  const meshes = geometries.map((g) => {
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const c = bb.getCenter(new THREE.Vector3());
    const r = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5).length();
    frames.push(new THREE.Vector4(c.x, c.y, c.z, r));
    const m = new THREE.Mesh(g, mat);
    m.visible = false;
    scene.add(m);
    return m;
  });

  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevScissor = renderer.getScissorTest();
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  const dir = new THREE.Vector3();
  const empty = new THREE.Scene();
  // Clear to transparent black so mip averages stay premultiplied; the runtime shader divides by alpha.
  for (const [rt, mode, clear] of [[albedoRT, 0, 0x000000], [normalRT, 1, 0x000000]]) {
    mat.uniforms.uMode.value = mode;
    // Allocate the mip chain on the first bind, then skip per-tile mip generation until the last tile is in.
    renderer.setRenderTarget(rt);
    rt.texture.generateMipmaps = false;
    renderer.setScissorTest(false);
    renderer.setClearColor(clear, 0);
    renderer.clear(true, true, false);
    renderer.setScissorTest(true);
    for (let s = 0; s < n; s++) {
      meshes.forEach((m, i) => { m.visible = i === s; });
      const f = frames[s];
      for (let el = 0; el < IMPOSTOR_EL; el++) {
        for (let az = 0; az < IMPOSTOR_AZ; az++) {
          const idx = s * VIEWS + el * IMPOSTOR_AZ + az;
          const px = (idx % cols) * tilePx, py = Math.floor(idx / cols) * tilePx;
          const pad = Math.round(tilePx * TILE_PAD);
          rt.viewport.set(px + pad, py + pad, tilePx - 2 * pad, tilePx - 2 * pad);
          rt.scissor.copy(rt.viewport);
          renderer.setRenderTarget(rt);
          renderer.clear(false, true, false);
          const a = (az / IMPOSTOR_AZ) * Math.PI * 2, e = IMPOSTOR_ELEVATIONS[el];
          dir.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
          cam.left = -f.w; cam.right = f.w; cam.top = f.w; cam.bottom = -f.w;
          cam.near = 0.01; cam.far = f.w * 4;
          cam.position.set(f.x, f.y, f.z).addScaledVector(dir, f.w * 2);
          cam.up.set(0, 1, 0);
          cam.lookAt(f.x, f.y, f.z);
          cam.updateProjectionMatrix();
          cam.updateMatrixWorld();
          renderer.render(scene, cam);
        }
      }
    }
    rt.viewport.set(0, 0, size, size);
    rt.scissor.set(0, 0, size, size);
    renderer.setScissorTest(false);
    rt.texture.generateMipmaps = true;
    renderer.setRenderTarget(rt);
    renderer.render(empty, cam);
  }
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAuto;
  renderer.setScissorTest(prevScissor);
  renderer.shadowMap.autoUpdate = prevShadow;
  mat.dispose();
  for (const m of meshes) scene.remove(m);

  const maxLod = Math.max(0, Math.floor(Math.log2(Math.max(1, tilePx * TILE_PAD))) + 1);
  return {
    albedo: albedoRT.texture,
    normal: normalRT.texture,
    frames,
    grid: new THREE.Vector4(cols, tilePx / size, TILE_PAD, maxLod),
    size,
    dispose() { albedoRT.dispose(); normalRT.dispose(); },
  };
}

/**
 * Runtime impostor material. Instances carry aPos (tree base), aScale (width, height scale), aRot, aKind (atlas
 * species), aTint and aCell (centre of the near cell the tree belongs to). Instances whose near cell's nearest
 * point is inside the mid radius around uTreeLodCenter are pushed off-screen: those trees draw as hero or mid geometry instead.
 */
export function makeImpostorMaterial(atlas, lodUniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, side: THREE.DoubleSide });
  const nSpecies = atlas.frames.length;
  patchMaterial(mat, {
    toonWrap: 0.48, toonLo: 0.14, toonHi: 0.56,
    uniforms: {
      uImpAlbedo: { value: atlas.albedo },
      uImpNormal: { value: atlas.normal },
      uImpFrames: { value: atlas.frames },
      uImpGrid: { value: atlas.grid },
      uImpAtlasPx: { value: atlas.size },
      ...lodUniforms,
    },
    vertexPars: /* glsl */ `
      #define IMP_SPECIES ${nSpecies}
      attribute vec3 aPos; attribute vec2 aScale; attribute float aRot; attribute float aKind; attribute vec3 aTint; attribute vec2 aCell;
      uniform vec4 uImpFrames[IMP_SPECIES]; uniform vec4 uImpGrid; uniform vec3 uTreeLodCenter; uniform float uTreeMidR; uniform float uTreeCellHalf;
      varying vec2 vImpUv; varying vec2 vImpTile; varying vec3 vImpTint; varying vec3 vImpRight; varying vec3 vImpUp; varying vec3 vImpToCam;
      varying float vImpY; varying float vImpHide;
    `,
    vertex: [
      ['#include <begin_vertex>', /* glsl */ `
        vec3 transformed;
        {
        vec4 fr = uImpFrames[int(aKind + 0.5)];
        vec3 impC = aPos + vec3(0.0, fr.y * aScale.y, 0.0);
        vec3 impTo = cameraPosition - impC;
        float impDist = length(impTo);
        vec3 toCam = impTo / max(impDist, 1e-3);
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam) + vec3(1e-5, 0.0, 0.0));
        vec3 upv = cross(toCam, right);
        float cr = cos(aRot), sr = sin(aRot);
        vec3 l = vec3(toCam.x * cr - toCam.z * sr, toCam.y, toCam.x * sr + toCam.z * cr);
        float azF = atan(l.x, l.z);
        if (azF < 0.0) azF += 6.2831853;
        float az = mod(floor(azF / (6.2831853 / ${IMPOSTOR_AZ.toFixed(1)}) + 0.5), ${IMPOSTOR_AZ.toFixed(1)});
        float elev = atan(l.y, length(l.xz));
        float el = 0.0;
        ${IMPOSTOR_ELEVATIONS.slice(1).map((e, i) => `if (elev > ${((IMPOSTOR_ELEVATIONS[i] + e) * 0.5).toFixed(4)}) el = ${(i + 1).toFixed(1)};`).join('\n        ')}
        float idx = aKind * ${VIEWS.toFixed(1)} + el * ${IMPOSTOR_AZ.toFixed(1)} + az;
        vImpTile = vec2(mod(idx, uImpGrid.x), floor(idx / uImpGrid.x));
        vImpUv = position.xy + 0.5;
        vImpTint = aTint;
        vImpRight = right; vImpUp = upv; vImpToCam = toCam;
        vImpY = position.y + 0.5;
        // Far forests merge into masses instead of thinning to dots as alpha-tested mips shrink.
        float expand = mix(1.0, 1.22, smoothstep(350.0, 1600.0, impDist));
        float sway = sin(uTime * 0.9 + aPos.x * 0.071 + aPos.z * 0.053) * 0.012 * (0.4 + uWindStrength) * max(position.y + 0.1, 0.0);
        vec3 impW = impC
          + right * (position.x * 2.0 * fr.w * aScale.x * expand + sway * aScale.y)
          + upv * (position.y * 2.0 * fr.w * aScale.y * expand);
        vec2 cellD = max(abs(uTreeLodCenter.xz - aCell) - uTreeCellHalf, 0.0);
        vImpHide = length(cellD) < uTreeMidR ? 1.0 : 0.0;
        transformed = impW;
        }
      `],
      ['#include <project_vertex>', /* glsl */ `
        vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        if (vImpHide > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      `],
      ['vWPos = (modelMatrix * w_wp).xyz;', 'vWPos = transformed;'],
    ],
    fragmentPars: /* glsl */ `
      uniform sampler2D uImpAlbedo; uniform sampler2D uImpNormal; uniform vec4 uImpGrid; uniform float uImpAtlasPx;
      varying vec2 vImpUv; varying vec2 vImpTile; varying vec3 vImpTint; varying vec3 vImpRight; varying vec3 vImpUp; varying vec3 vImpToCam;
      varying float vImpY; varying float vImpHide;
      vec3 impN;
    `,
    fragment: [
      ['#include <color_fragment>', /* glsl */ `#include <color_fragment>
        {
          if (vImpHide > 0.5) discard;
          vec2 tuv = (vImpTile + vImpUv) * uImpGrid.y;
          vec2 px = tuv * uImpAtlasPx;
          vec2 ddx = dFdx(px), ddy = dFdy(px);
          float lod = clamp(0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))), 0.0, uImpGrid.w);
          vec4 alb = textureLod(uImpAlbedo, tuv, lod);
          // keep coverage as the alpha-tested mips average leaves away (same idea as the live leaf cards)
          if (alb.a * (1.0 + lod * 0.45) < 0.5) discard;
          vec4 nrmA = textureLod(uImpNormal, tuv, lod);
          vec3 nrm = nrmA.xyz / max(nrmA.a, 1e-3) * 2.0 - 1.0;
          impN = normalize(vImpRight * nrm.x + vImpUp * nrm.y + vImpToCam * nrm.z);
          vec3 base = alb.rgb / max(alb.a, 1e-3);
          base *= base;
          base *= vImpTint;
          // broad valley-scale hue swells so distant forests read as colour masses, not repeated stamps
          float macH = texture(uNoiseTex, vWPos.xz * 0.0011 + 0.27).r;
          base = mix(base, base * vec3(0.80, 0.97, 1.12), smoothstep(0.48, 0.78, macH) * 0.45);
          base = mix(base, base * vec3(1.14, 1.06, 0.80), smoothstep(0.50, 0.80, 1.0 - macH) * 0.38);
          // light-side crown tone like the live crowns: cool shadow side, warm lit side
          float sunSide = clamp(dot(impN, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
          float litMask = smoothstep(0.20, 0.78, sunSide * 0.62 + vImpY * 0.28);
          vec3 coolGreen = base * vec3(0.46, 0.82, 1.24);
          vec3 warmShift = base * mix(vec3(1.18, 1.22, 0.72), vec3(1.20, 0.98, 0.64), max(uGolden, uDawn));
          diffuseColor.rgb = mix(coolGreen, warmShift, litMask);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.84, 0.68, 0.98), uDawn * 0.5);
        }`],
      ['#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(impN, 0.0)).xyz);`],
      ['#include <emissivemap_fragment>', /* glsl */ `
        #include <emissivemap_fragment>
        {
          vec3 Vw = normalize(vWPos - cameraPosition);
          float lit = w_sunVis * smoothstep(-0.02, 0.08, uLightDir.y);
          float lowSun = max(uGolden, uDawn);
          float back = pow(max(dot(Vw, uLightDir), 0.0), 3.6);
          vec3 transTint = mix(vec3(0.95, 1.02, 0.68), vec3(1.0, 0.76, 0.40), lowSun);
          totalEmissiveRadiance += diffuseColor.rgb * uLightColor * transTint * back * 0.14 * lit;
          totalEmissiveRadiance += diffuseColor.rgb * vec3(0.84, 1.0, 0.74) * 0.036 * length(uLightColor) * (1.0 - uNight) * (1.0 - lowSun * 0.55);
        }
      `],
    ],
  });
  return mat;
}

/** Quad shared by every impostor batch (unit square, origin at its centre). */
export function impostorQuad() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}
