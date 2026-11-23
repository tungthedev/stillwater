import * as THREE from 'three';
import { U } from './uniforms.js';

// Time of day, sun/moon ephemeris, atmosphere-derived light colours and grading.

const LAT = 46 * Math.PI / 180;
const DECL = 17 * Math.PI / 180;

export function sunDirection(hours, out = new THREE.Vector3(), decl = DECL, offset = 0) {
  const h = ((hours - 12) / 24) * Math.PI * 2 + offset;
  const E = -Math.cos(decl) * Math.sin(h);
  const N = Math.cos(LAT) * Math.sin(decl) - Math.sin(LAT) * Math.cos(decl) * Math.cos(h);
  const Up = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(h);
  return out.set(E, Up, -N).normalize();
}

// Kasten-Young air mass based transmittance
const betaR = [5.802e-6 * 8000, 13.558e-6 * 8000, 33.1e-6 * 8000];
const betaM = 8.0e-6 * 1200 * 1.11;
function transmittance(elev, out) {
  const zen = Math.PI / 2 - Math.max(elev, -0.05);
  const zdeg = zen * 180 / Math.PI;
  const m = 1 / (Math.cos(zen) + 0.50572 * Math.pow(Math.max(96.07995 - zdeg, 0.01), -1.6364));
  out.setRGB(Math.exp(-(betaR[0] + betaM) * m), Math.exp(-(betaR[1] + betaM) * m), Math.exp(-(betaR[2] + betaM) * m));
  return out;
}

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export class Environment {
  constructor() {
    this.hours = 15.8;
    this.timeScale = 6; // game seconds per real second
    this.sun = new THREE.Vector3();
    this.moon = new THREE.Vector3();
    this.sunCol = new THREE.Color();
    this.lightCol = new THREE.Color();
    this.wind = 0.5;
    this.cloud = 0.42;
    this.windAngle = 0.6;
    this.exposure = 1;
    this.expTarget = 1;
    this.grade = { wb: new THREE.Vector3(1, 1, 1), lift: new THREE.Vector3(), gain: new THREE.Vector3(1, 1, 1), sat: 1.05, contrast: 0.1 };
    this.fixedWeather = null;
  }

  update(dt, t, skyAmbient) {
    this.hours = (this.hours + dt * this.timeScale / 3600 + 24) % 24;
    sunDirection(this.hours, this.sun);
    sunDirection(this.hours, this.moon, -0.12, Math.PI * 0.93);
    const se = Math.asin(this.sun.y);
    const night = 1 - ss(-0.21, -0.03, this.sun.y);
    const day = ss(-0.02, 0.2, this.sun.y);
    this.night = night; this.day = day;
    this.dusk = ss(-0.18, -0.02, this.sun.y) * (1 - ss(0.0, 0.25, this.sun.y));
    this.golden = ss(-0.04, 0.03, this.sun.y) * (1 - ss(0.1, 0.32, this.sun.y));
    transmittance(se, this.sunCol);
    // stylized: keep low sun golden rather than deep red so greens stay vivid
    { const m = Math.max(this.sunCol.r, 1e-4); const t = this.sunCol.clone().multiplyScalar(1 / m); const gold = new THREE.Color(1.0, 0.7, 0.42); t.lerp(gold, 0.5); this.sunCol.copy(t.multiplyScalar(m)); }
    // which body lights the world
    const useMoon = this.sun.y < -0.035;
    const L = useMoon ? this.moon : this.sun;
    U.uSunDir.value.copy(this.sun);
    U.uLightDir.value.copy(L);
    if (useMoon) {
      const mt = transmittance(Math.asin(this.moon.y), new THREE.Color());
      const k = ss(-0.05, 0.15, this.moon.y) * 0.13;
      this.lightCol.setRGB(0.62 * k * mt.r, 0.72 * k * mt.g, 1.0 * k * mt.b);
    } else {
      const k = 7.5 * ss(-0.035, 0.02, this.sun.y) * (1.0 + 0.65 * ss(0.3, 0.05, this.sun.y));
      this.lightCol.setRGB(this.sunCol.r * k, this.sunCol.g * k, this.sunCol.b * k);
      // stylized: soften the light's chroma so lit greens stay green (warmth lives in sky, rims & shadows)
      { const l = this.lightCol.r * 0.3 + this.lightCol.g * 0.55 + this.lightCol.b * 0.15; this.lightCol.lerp(new THREE.Color(l, l, l * 0.92), 0.4); }
    }
    U.uSunColor.value.copy(this.sunCol);
    U.uLightColor.value.copy(this.lightCol);
    U.uNight.value = night;
    U.uGolden.value = this.golden;
    U.uAlpenglow.value = ss(-0.07, 0.0, this.sun.y) * (1 - ss(0.04, 0.12, this.sun.y));

    // weather drift
    if (!this.fixedWeather) {
      this.wind = 0.45 + 0.3 * Math.sin(t * 0.021) * Math.sin(t * 0.0137 + 1.3) + 0.12 * Math.sin(t * 0.11);
      this.cloud = 0.3 + 0.06 * Math.sin(t * 0.004 + 0.5);
    }
    U.uWindStrength.value = this.wind;
    U.uCloudCover.value = this.cloud;
    const wa = this.windAngle + Math.sin(t * 0.01) * 0.3;
    U.uWindDir.value.set(Math.cos(wa), Math.sin(wa));
    U.uCloudOffset.value.x -= Math.cos(wa) * dt * (6 + this.wind * 10) * Math.max(1, this.timeScale / 6);
    U.uCloudOffset.value.y -= Math.sin(wa) * dt * (6 + this.wind * 10) * Math.max(1, this.timeScale / 6);

    // atmosphere haze: more in the warm low-sun hours
    const haze = (1.0 + this.dusk * 0.1) * (1.0 - this.golden * 0.55);
    U.uFogBeta.value.set(3.0e-5, 6.2e-5, 1.35e-4).multiplyScalar(haze);
    U.uFogFalloff.value = 1 / 1100;
    // evening/morning valley mist
    const hr = this.hours;
    const mistTime = Math.max(ss(19.0, 21.5, hr) * (1 - ss(23, 24, hr)), 1 - ss(5.0, 8.5, hr) * 1.0, hr > 21.5 ? 1 : 0);
    U.uMist.value = 0.04 + mistTime * 0.22;

    // exposure from sky brightness
    if (skyAmbient) {
      const lum = skyAmbient.r * 0.2126 + skyAmbient.g * 0.7152 + skyAmbient.b * 0.0722;
      const direct = (this.lightCol.r * 0.2126 + this.lightCol.g * 0.7152 + this.lightCol.b * 0.0722) * 0.06;
      this.expTarget = THREE.MathUtils.clamp(0.54 / Math.pow(lum + direct + 1e-5, 0.7), 0.6, 90);
    }
    this.expTarget *= 1 - 0.42 * night;
    this.expTarget *= 1 + 0.15 * this.golden + 0.2 * this.dusk * (1 - night);
    this.exposure += (this.expTarget - this.exposure) * (1 - Math.exp(-dt * 1.5));

    // grading
    const g = this.grade;
    const warm = this.golden;
    g.wb.set(lerp(1, 1.1, warm), lerp(1, 0.99, warm), lerp(1, 0.86, warm));
    g.wb.lerp(new THREE.Vector3(0.86, 0.95, 1.15), night);
    g.lift.set(0.004, 0.006, 0.012).multiplyScalar(1 + night * 2);
    g.gain.set(1, 1, 1);
    g.sat = lerp(1.08, 0.85, night) + warm * 0.08 + this.dusk * 0.1;
    g.contrast = lerp(0.1, 0.16, night);
    g.shadowTint = (g.shadowTint || new THREE.Vector3()).set(0.9, 0.95, 1.14)
      .lerp(new THREE.Vector3(0.86, 0.78, 1.25), warm)
      .lerp(new THREE.Vector3(0.8, 0.9, 1.22), night);
  }
}
