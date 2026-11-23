import * as THREE from 'three';
import { WORLD } from './config.js';

// One shared uniform registry. Materials reference these objects directly so a
// single update per frame propagates everywhere.
const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
blank.needsUpdate = true;

export const U = {
  uHeightTex: { value: blank },
  uFarHeightTex: { value: blank },
  uHeightFilter: { value: 0 },
  uBiomeTex: { value: blank },
  uShadowNear: { value: blank },
  uShadowFar: { value: blank },
  uSkyLUT: { value: blank },
  uNoiseTex: { value: blank },
  uWorldSize: { value: WORLD.size },
  uFarSize: { value: WORLD.farSize },
  uWaterLevel: { value: WORLD.waterLevel },
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uLightDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color(1, 1, 1) },
  uLightColor: { value: new THREE.Color(1, 1, 1) },
  uFogBeta: { value: new THREE.Vector3(1.6e-5, 2.2e-5, 3.2e-5) },
  uFogFalloff: { value: 1 / 900 },
  uMist: { value: 0.0 },
  uCloudCover: { value: 0.42 },
  uCloudOffset: { value: new THREE.Vector2() },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uWindStrength: { value: 0.5 },
  uNight: { value: 0 },
  uSkyScale: { value: 1 },
  uHorizonCol: { value: new THREE.Color(0.5, 0.6, 0.7) },
  uGolden: { value: 0 },
  uDusk: { value: 0 },
  uDawn: { value: 0 },
  uAlpenglow: { value: 0 },
  uAOSpot: { value: new THREE.Vector4(0, 0, 0, 0) },
  uYardPath: { value: new THREE.Vector4(0, 0, 0, 0) },
  uWarmLight: { value: new THREE.Vector4(0, 0, 0, 0) },
  uWarmLight2: { value: new THREE.Vector4(0, 0, 0, 0) },
  uWarmLight3: { value: new THREE.Vector4(0, 0, 0, 0) },
  uWaterfall: { value: new THREE.Vector4(0, 0, 0, 0) },
};

export function worldUniforms(extra = {}) {
  return { ...U, ...extra };
}
