import * as THREE from 'three';
import { patchMaterial } from '../patch.js';
import { mulberry32, vnoise } from './biome.js';
import { selectByRank } from './worldData.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function noise3(x, y, z) {
  return (vnoise(x + z * 1.7, y - z * 0.3) + vnoise(y * 1.3 - x * 0.2 + 5.1, z + 2.7)) * 0.5;
}

export function rockGeometry(seed, detail = 2, flat = 0.65) {
  const rnd = mulberry32(seed);
  let g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const ox = rnd() * 100, oy = rnd() * 100, oz = rnd() * 100;
  const sx = 0.8 + rnd() * 0.6, sz = 0.8 + rnd() * 0.6;
  const planes = [];
  for (let i = 0; i < 10; i++) {
    const n = new THREE.Vector3(rnd() - 0.5, rnd() - 0.25, rnd() - 0.5).normalize();
    planes.push({ n, d: 0.64 + rnd() * 0.24 });
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const k = 1 + (noise3(v.x * 1.6 + ox, v.y * 1.6 + oy, v.z * 1.6 + oz) - 0.5) * 0.48
      + (noise3(v.x * 4 + oz, v.y * 4 + ox, v.z * 4 + oy) - 0.5) * 0.16;
    v.multiplyScalar(k);
    for (const pl of planes) {
      const dd = v.dot(pl.n);
      if (dd > pl.d) v.addScaledVector(pl.n, -(dd - pl.d) * 0.84);
    }
    v.x *= sx; v.z *= sz; v.y *= flat;
    if (v.y < -0.25) v.y = -0.25 + (v.y + 0.25) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.normal) g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  g.computeVertexNormals();
  g = g.toNonIndexed();
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

export function rockMaterial(farCull = false) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0 });
  const vertexPatches = [
    ['#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      {
        vec3 nn = objectNormal;
        #ifdef USE_INSTANCING
          nn = mat3(instanceMatrix) * nn;
        #endif
        vRockN = normalize(mat3(modelMatrix) * nn);
      }`],
  ];
  if (farCull) {
    vertexPatches.push(['#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
      {
        vec3 ip = vec3(instanceMatrix[3]);
        float sc = length(instanceMatrix[0].xyz);
        // keep big scenic cliff outcrops visible from the summit; cull tiny pebbles far away
        float maxD = sc > 3.0 ? 1500.0 : 520.0;
        float d = length(ip - cameraPosition);
        transformed *= 1.0 - smoothstep(maxD * 0.72, maxD, d);
      }
      #endif`]);
  }
  patchMaterial(mat, {
    toonWrap: 0.22, toonLo: 0.20, toonHi: 0.48,
    fragmentPars: 'varying vec3 vRockN; float r_wet = 0.0;',
    vertexPars: 'varying vec3 vRockN;',
    vertex: vertexPatches,
    fragment: [
      ['#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        {
          vec3 wp = vWPos;
          vec3 rn = normalize(vRockN);
          vec3 an = pow(abs(rn), vec3(4.0));
          an /= max(an.x + an.y + an.z, 1e-4);
          // multi-scale triplanar painterly granite grain + layered strata cracks
          vec4 nM = texture(uNoiseTex, wp.yz * 0.28) * an.x + texture(uNoiseTex, wp.xz * 0.28) * an.y + texture(uNoiseTex, wp.xy * 0.28) * an.z;
          vec4 nF = texture(uNoiseTex, wp.yz * 1.35 + 0.31) * an.x + texture(uNoiseTex, wp.xz * 1.35 + 0.31) * an.y + texture(uNoiseTex, wp.xy * 1.35 + 0.31) * an.z;
          vec4 nD = texture(uNoiseTex, wp.yz * 4.2 + 0.67) * an.x + texture(uNoiseTex, wp.xz * 4.2 + 0.67) * an.y + texture(uNoiseTex, wp.xy * 4.2 + 0.67) * an.z;

          // 100% clean stylized BotW/Ghibli flat-shaded warm alpine granite planes + crisp solid cel-shaded moss cap (ZERO camo noise or cobalt-blue shade cast!)
          float up = rn.y;
          vec3 shadowSide = vec3(0.30, 0.30, 0.31);
          vec3 midGranite = vec3(0.47, 0.45, 0.42);
          vec3 sunlitTop  = vec3(0.62, 0.58, 0.50);
          // crisp 3-step planar value shading based on face orientation (lit top / mid bevel / shadowed side)
          float stepMid = smoothstep(0.12, 0.24, up);
          float stepTop = smoothstep(0.56, 0.68, up);
          vec3 base = mix(shadowSide, midGranite, stepMid);
          base = mix(base, sunlitTop, stepTop);
          // ultra-subtle mineral brush warmth (zero camo blotches!)
          base *= 0.95 + 0.10 * nD.b;

          // lush emerald moss on lower woodland/valley boulders (natural organic patchiness so buried rocks never read like flat floating green leaf cards!)
          float mossField = up + (nM.g - 0.5) * 0.20 + (nF.r - 0.5) * 0.10;
          float lowMoss = smoothstep(0.80, 0.90, mossField) * smoothstep(395.0, 320.0, wp.y);
          float highLichen = smoothstep(0.68, 0.84, up * 0.65 + nF.g * 0.35) * smoothstep(330.0, 390.0, wp.y) * smoothstep(1150.0, 650.0, wp.y);
          vec3 mossCol = mix(vec3(0.085, 0.24, 0.055), vec3(0.15, 0.33, 0.072), smoothstep(0.36, 0.64, nM.b * 0.6 + nF.g * 0.4));
          vec3 lichenCol = mix(vec3(0.38, 0.41, 0.25), vec3(0.52, 0.49, 0.30), nF.r);
          base = mix(base, mossCol, lowMoss * 0.78);
          base = mix(base, lichenCol, highLichen * 0.52);

          // wet dark glistening rock near water level & waterfall spray
          float nearWater = 1.0 - smoothstep(0.0, 1.1, abs(wp.y - uWaterLevel));
          float nearFall = uWaterfall.w > 0.1 ? (1.0 - smoothstep(uWaterfall.w * 0.35, uWaterfall.w, length(wp.xz - uWaterfall.xz))) : 0.0;
          r_wet = clamp(max(nearWater, nearFall * 0.85), 0.0, 1.0);
          base *= mix(1.0, 0.58, r_wet);

          // snow dusting on high peaks
          base = mix(base, vec3(0.92, 0.94, 0.98), smoothstep(1450.0, 1650.0, wp.y) * smoothstep(0.3, 0.7, up));
          diffuseColor.rgb = base;
        }
      `],
      ['#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(0.88, 0.26, r_wet);'],
      ['#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 wp = vWPos;
          float b1 = texture(uNoiseTex, wp.xz * 1.4 + wp.y * 0.9).g - 0.5;
          float b2 = texture(uNoiseTex, wp.xy * 1.8 - wp.z * 1.1).b - 0.5;
          normal = normalize(normal + vec3(b1, b2 * 0.5, -b1 * 0.7) * 0.28);
        }`],
      // Cottage and gate lantern warmth comes from the shared spill term, not real-time lights.
      ['#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * w_warmSpill(vWPos) * 0.85;`],
    ],
  });
  return mat;
}

export class Rocks {
  constructor(worldData, tier = null) {
    this.worldData = worldData;
    this.geos = [rockGeometry(1, 2), rockGeometry(2, 2, 0.72), rockGeometry(3, 2, 0.8), rockGeometry(4, 3, 0.62)];
    this.material = rockMaterial(true);
    const items = selectByRank(worldData.placements.rocks, tier?.rocks ?? 1);
    this.items = items;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    this.meshes = this.geos.map((g, vi) => {
      const list = items.filter((it) => it.v === vi);
      const im = new THREE.InstancedMesh(g, this.material, Math.max(1, list.length));
      list.forEach((it, i) => {
        e.set(it.tilt[1] * 0.45, it.rot, -it.tilt[0] * 0.45);
        q.setFromEuler(e);
        sc.set(it.s, it.s, it.s);
        p.set(it.x, it.y, it.z);
        m.compose(p, q, sc);
        im.setMatrixAt(i, m);
      });
      im.count = list.length;
      im.castShadow = true; im.receiveShadow = true;
      im.computeBoundingSphere();
      return im;
    });
    this.group = new THREE.Group();
    this.meshes.forEach((im) => this.group.add(im));
  }
  collide(pos, ground, radius = 0.35) {
    this.worldData.collideRocks(pos, ground, radius);
  }
  dispose() {
    this.group.removeFromParent();
    for (const m of this.meshes) m.dispose?.();
    for (const g of this.geos) g.dispose();
    this.material.dispose();
  }
}

export function createRocks(ctx) {
  const rocks = new Rocks(ctx.data, ctx.tier);
  ctx.scene.add(rocks.group);
  return {
    instance: rocks,
    update() {},
    dispose() {
      rocks.dispose();
    },
  };
}
