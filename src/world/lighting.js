import * as THREE from 'three';

// Directional sun/moon shadow light, hemisphere sky/ground bounce, and player headlamp.

export function createLighting({ scene, camera, U, tier }) {
  let curTier = tier;

  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(curTier.shadow, curTier.shadow);
  const sc = sunLight.shadow.camera;
  sc.left = -95;
  sc.right = 95;
  sc.top = 95;
  sc.bottom = -95;
  sc.near = 1;
  sc.far = 1200;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.06;
  sunLight.shadow.radius = 5;
  scene.add(sunLight, sunLight.target);

  const hemi = new THREE.HemisphereLight(0x8899aa, 0x334422, Math.PI);
  scene.add(hemi);

  const headlamp = new THREE.SpotLight(0xfff1dc, 0, 70, 0.5, 0.65, 1.6);
  headlamp.position.set(0.1, -0.08, 0);
  headlamp.target.position.set(0, -0.25, -1);
  camera.add(headlamp, headlamp.target);
  scene.add(camera);

  const camDir = new THREE.Vector3();
  const shadowCenter = new THREE.Vector3();
  const lowTint = new THREE.Color();

  function update(frame) {
    const { env, amb, renderFlags } = frame;
    sunLight.color.copy(env.lightCol);
    sunLight.intensity = 1;
    const L = U.uLightDir.value;
    camera.getWorldDirection(camDir);
    shadowCenter.copy(camera.position).addScaledVector(camDir.setY(0).normalize(), 50);
    const texel = 190 / curTier.shadow;
    shadowCenter.x = Math.round(shadowCenter.x / texel) * texel;
    shadowCenter.z = Math.round(shadowCenter.z / texel) * texel;
    sunLight.target.position.copy(shadowCenter);
    sunLight.position.copy(shadowCenter).addScaledVector(L, 600);
    sunLight.castShadow = L.y > 0.01 && renderFlags.shadow;

    const s = amb.sky;
    const l = s.r * 0.2126 + s.g * 0.7152 + s.b * 0.0722;
    hemi.color.setRGB(l + (s.r - l) * 0.78, l + (s.g - l) * 0.78, l + (s.b - l) * 0.78).multiplyScalar(1.06);
    const gk = Math.max(env.golden, env.dusk * 0.75);
    if (env.dawn > 0.2) lowTint.setRGB(l * 1.12, l * 0.94, l * 1.18);
    else lowTint.setRGB(l * 0.92, l * 0.85, l * 1.36);
    hemi.color.lerp(lowTint, gk * 0.58).multiplyScalar(1 + gk * 0.34);

    U.uHorizonCol.value.copy(amb.horizon);
    hemi.groundColor.setRGB(
      amb.sky.r * 0.26 + env.lightCol.r * Math.max(L.y, 0) * 0.045,
      amb.sky.g * 0.26 + env.lightCol.g * Math.max(L.y, 0) * 0.046,
      amb.sky.b * 0.18 + env.lightCol.b * Math.max(L.y, 0) * 0.025
    );
  }

  function setTier(nextTier) {
    curTier = nextTier;
    sunLight.shadow.mapSize.set(curTier.shadow, curTier.shadow);
    if (sunLight.shadow.map) {
      sunLight.shadow.map.dispose();
      sunLight.shadow.map = null;
    }
  }

  function dispose() {
    if (sunLight.shadow.map) {
      sunLight.shadow.map.dispose();
      sunLight.shadow.map = null;
    }
    scene.remove(sunLight, sunLight.target, hemi);
    camera.remove(headlamp, headlamp.target);
    sunLight.dispose();
    hemi.dispose();
    headlamp.dispose();
  }

  return {
    sunLight,
    hemi,
    headlamp,
    setHeadlamp(on) { headlamp.intensity = on ? 38 : 0; },
    toggleHeadlamp() {
      headlamp.intensity = headlamp.intensity > 0 ? 0 : 38;
      return headlamp.intensity > 0;
    },
    update,
    setTier,
    dispose,
  };
}
