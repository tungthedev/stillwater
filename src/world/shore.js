import * as THREE from 'three';
import { WORLD } from '../config.js';
import { mulberry32 } from './biome.js';
import { patchMaterial } from '../patch.js';

// Lake-edge dressing: reed clumps along the waterline and lily-pad rafts in the shallows.

function reedGeometry(seed) {
  const rnd = mulberry32(seed);
  const pos = [], col = [], nor = [];
  const blade = (x, z, h, w, lean, ang, c) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const segs = 4;
    let prevL = null, prevR = null;
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const bend = lean * f * f;
      const cx = x + ca * bend, cz = z + sa * bend, y = h * f;
      const hw = w * (1 - f * 0.92);
      const L = [cx - sa * hw, y, cz + ca * hw], R = [cx + sa * hw, y, cz - ca * hw];
      const k = 0.55 + 0.5 * f;
      const Lo = { v: L, c: [c[0] * k, c[1] * k, c[2] * k] }, Ro = { v: R, c: [c[0] * k, c[1] * k, c[2] * k] };
      if (prevL) {
        for (const p of [prevL, prevR, Lo, prevR, Ro, Lo]) { pos.push(...p.v); col.push(...p.c); nor.push(ca, 0.35, sa); }
      }
      prevL = Lo; prevR = Ro;
    }
  };
  const n = 11 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28, r = Math.sqrt(rnd()) * 0.45;
    const h = 1.0 + rnd() * 1.1;
    const tone = rnd();
    const c = tone < 0.7 ? [0.2 + rnd() * 0.08, 0.42 + rnd() * 0.1, 0.1] : [0.48, 0.5, 0.2];
    blade(Math.cos(a) * r, Math.sin(a) * r, h, 0.035 + rnd() * 0.02, (rnd() - 0.3) * 0.5, rnd() * 6.28, c);
    // a few cattail heads
    if (rnd() < 0.28) {
      const hx = Math.cos(a) * r, hz = Math.sin(a) * r, hy = h * 0.82;
      const hc = [0.33, 0.2, 0.12];
      const s = 0.04, L = 0.2;
      for (const [dx, dz] of [[s, 0], [0, s], [-s, 0], [0, -s]]) {
        const ex = -dz, ez = dx;
        const q = [[hx + dx + ex * 0, hy, hz + dz], [hx + dx, hy + L, hz + dz]];
        pos.push(hx + dx, hy, hz + dz, hx + ez, hy, hz - ex, hx + dx, hy + L, hz + dz);
        pos.push(hx + ez, hy, hz - ex, hx + ez, hy + L, hz - ex, hx + dx, hy + L, hz + dz);
        for (let k = 0; k < 6; k++) { col.push(...hc); nor.push(dx / s, 0, dz / s); }
        void q;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

function padGeometry(seed) {
  const rnd = mulberry32(seed);
  const pos = [], col = [], nor = [];
  const pad = (x, z, r, notch, c) => {
    const segs = 14;
    for (let i = 0; i < segs; i++) {
      const a0 = notch + 0.35 + (i / segs) * (6.283 - 0.7), a1 = notch + 0.35 + ((i + 1) / segs) * (6.283 - 0.7);
      const k = 0.85 + 0.2 * rnd();
      pos.push(x, 0.02, z, x + Math.cos(a1) * r, 0, z + Math.sin(a1) * r, x + Math.cos(a0) * r, 0, z + Math.sin(a0) * r);
      for (let j = 0; j < 3; j++) { col.push(c[0] * (j === 0 ? 0.8 : k), c[1] * (j === 0 ? 0.8 : k), c[2] * (j === 0 ? 0.8 : k)); nor.push(0, 1, 0); }
    }
  };
  const flower = (x, z, s, c) => {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * 6.283;
      const tx = x + Math.cos(a) * s, tz = z + Math.sin(a) * s;
      const lx = x + Math.cos(a + 0.4) * s * 0.35, lz = z + Math.sin(a + 0.4) * s * 0.35;
      const rx = x + Math.cos(a - 0.4) * s * 0.35, rz = z + Math.sin(a - 0.4) * s * 0.35;
      pos.push(lx, 0.04, lz, tx, 0.04 + s * 0.6, tz, rx, 0.04, rz);
      for (let j = 0; j < 3; j++) { col.push(...(j === 1 ? [1, 0.95, 0.97] : c)); nor.push(0, 1, 0); }
    }
    pos.push(x - 0.02, 0.05, x * 0 + z, x + 0.02, 0.05, z, x, 0.09, z);
    for (let j = 0; j < 3; j++) { col.push(1, 0.85, 0.2); nor.push(0, 1, 0); }
  };
  const n = 4 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.28, r = Math.sqrt(rnd()) * 1.4;
    const tone = rnd();
    const c = tone < 0.6 ? [0.16, 0.4, 0.1] : tone < 0.9 ? [0.24, 0.47, 0.12] : [0.4, 0.46, 0.14];
    pad(Math.cos(a) * r, Math.sin(a) * r, 0.28 + rnd() * 0.3, rnd() * 6.28, c);
  }
  if (rnd() < 0.6) flower((rnd() - 0.5) * 1.2, (rnd() - 0.5) * 1.2, 0.13, rnd() < 0.6 ? [0.98, 0.62, 0.78] : [0.98, 0.96, 0.92]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

export class Shore {
  constructor(hf, avoid = []) {
    this.group = new THREE.Group();
    const L = WORLD.lake, wl = WORLD.waterLevel;
    const rnd = mulberry32(4242);
    const reedSpots = [], padSpots = [];
    const blocked = (x, z) => avoid.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) < ar);
    for (let i = 0; i < 9000 && (reedSpots.length < 1400 || padSpots.length < 260); i++) {
      const a = rnd() * 6.283, r = 0.7 + rnd() * 0.5;
      const x = L.x + Math.cos(a) * L.rx * r, z = L.z + Math.sin(a) * L.rz * r;
      if (blocked(x, z) || hf.isPath(x, z)) continue;
      const h = hf.height(x, z);
      // reeds come in drifts: gate by a slow angular wave so stretches of shore stay open
      const drift = Math.sin(a * 5.0 + 1.3) * 0.6 + Math.sin(a * 11.0) * 0.4;
      if (h > wl - 0.7 && h < wl + 0.5 && drift > 0.05 && reedSpots.length < 1400) {
        reedSpots.push([x, h, z, 1.6 + rnd() * 0.9]);
        // dense beds
        for (let k = 0; k < 6; k++) {
          const ox = x + (rnd() - 0.5) * 5, oz = z + (rnd() - 0.5) * 5, oh = hf.height(ox, oz);
          if (oh > wl - 0.9 && oh < wl + 0.5) reedSpots.push([ox, oh, oz, 1.3 + rnd() * 0.9]);
        }
      } else if (h > wl - 2.2 && h < wl - 0.6 && drift > 0.15 && padSpots.length < 260) {
        padSpots.push([x, wl + 0.03, z, 1.8 + rnd() * 1.2]);
      }
    }
    this.reedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    patchMaterial(this.reedMat, {
      toonWrap: 0.5,
      vertex: [['#include <begin_vertex>', `
        #include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3]);
          float ph = ip.x * 0.37 + ip.z * 0.29;
          float k = position.y * position.y;
          transformed.x += (sin(uTime * 1.6 + ph) * 0.05 + uWindDir.x * 0.04) * k * (0.5 + uWindStrength);
          transformed.z += (cos(uTime * 1.3 + ph) * 0.05 + uWindDir.y * 0.04) * k * (0.5 + uWindStrength);
        }
      `]],
    });
    this.padMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
    patchMaterial(this.padMat, {
      toonWrap: 0.5,
      vertex: [['#include <begin_vertex>', `
        #include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3]);
          transformed.y += sin(uTime * 0.9 + ip.x * 0.3 + position.x * 2.0) * 0.012;
        }
      `]],
    });
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const build = (geos, spots, mat, sink) => {
      geos.forEach((g, gi) => {
        const list = spots.filter((_, i) => i % geos.length === gi);
        if (!list.length) return;
        const im = new THREE.InstancedMesh(g, mat, list.length);
        list.forEach(([x, y, z, sc], i) => {
          q.setFromAxisAngle(up, rnd() * 6.283);
          m.compose(p.set(x, y - sink, z), q, s.set(sc, sc, sc));
          im.setMatrixAt(i, m);
        });
        im.castShadow = mat === this.reedMat; im.receiveShadow = true;
        im.computeBoundingSphere();
        this.group.add(im);
      });
    };
    build([reedGeometry(1), reedGeometry(2), reedGeometry(3)], reedSpots, this.reedMat, 0.05);
    build([padGeometry(7), padGeometry(8), padGeometry(9)], padSpots, this.padMat, 0);
    this.count = { reeds: reedSpots.length, pads: padSpots.length };
  }
}
