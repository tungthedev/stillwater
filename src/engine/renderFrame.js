import * as THREE from 'three';

// Per-frame render pass orchestrator: sky LUT, terrain shadows, scene updates,
// planar reflection, main scene render, and post-processing.

export function renderFrame(ctx, frame) {
  const { renderer, scene, camera, post, passes } = ctx;

  const t0Sky = performance.now();
  const skyLut = passes.skyPass(frame);
  const terrainShadow = passes.terrainShadowPass(frame);
  const t0Sim = performance.now();

  passes.simPass(frame);
  const t0Refl = performance.now();

  renderer.info.reset();
  passes.reflectionPass(frame);
  const reflCalls = renderer.info.render.calls;
  const reflTris = renderer.info.render.triangles;
  const t0Main = performance.now();

  renderer.info.reset();
  renderer.setRenderTarget(post.sceneRT);
  renderer.clear();
  renderer.render(scene, camera);
  const mainCalls = renderer.info.render.calls;
  const mainTris = renderer.info.render.triangles;
  const t0Post = performance.now();

  const postParams = passes.getPostParams(frame);
  renderer.info.reset();
  post.render(postParams);
  const postCalls = renderer.info.render.calls;
  const postTris = renderer.info.render.triangles;
  const t1End = performance.now();

  return {
    cpuMs: {
      sky: t0Sim - t0Sky,
      sim: t0Refl - t0Sim,
      refl: t0Main - t0Refl,
      main: t0Post - t0Main,
      post: t1End - t0Post,
      total: t1End - t0Sky,
    },
    passes: {
      skyLut,
      terrainShadow,
      reflection: { calls: reflCalls, tris: reflTris },
      main: { calls: mainCalls, tris: mainTris },
      post: { calls: postCalls, tris: postTris },
    },
  };
}

// Draw one hidden frame through the real render passes (clipped reflection,
// sun-shadow + main, and every post material) so shadow-depth and clipping
// shader variants compile up front instead of hitching on first sight.
export function warmRenderPasses({ renderer, scene, camera, post }) {
  const prevRT = renderer.getRenderTarget();
  const prevClip = renderer.clippingPlanes;
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  const prevShadowNeeds = renderer.shadowMap.needsUpdate;
  const prevAutoClear = renderer.autoClear;

  /** @type {Array<{ obj: any, frustumCulled: boolean, count?: number, instanceCount?: number }>} */
  const savedObjs = [];
  /** @type {Array<{ light: any, castShadow: boolean, autoUpdate: boolean, needsUpdate: boolean }>} */
  const savedLights = [];

  scene.traverse((rawObj) => {
    /** @type {any} */
    const obj = rawObj;
    const rec = { obj, frustumCulled: obj.frustumCulled };
    obj.frustumCulled = false;
    if (obj.isInstancedMesh && obj.visible && obj.count === 0 && obj.instanceMatrix?.count > 0) {
      rec.count = obj.count;
      obj.count = 1;
    }
    if (obj.geometry?.isInstancedBufferGeometry && obj.visible && obj.geometry.instanceCount === 0) {
      rec.instanceCount = obj.geometry.instanceCount;
      obj.geometry.instanceCount = 1;
    }
    savedObjs.push(rec);
    if (obj.isLight && obj.shadow) {
      savedLights.push({
        light: obj,
        castShadow: obj.castShadow,
        autoUpdate: obj.shadow.autoUpdate,
        needsUpdate: obj.shadow.needsUpdate,
      });
    }
  });

  const warmReflRT = new THREE.WebGLRenderTarget(16, 16, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const warmCompRT = new THREE.WebGLRenderTarget(16, 16, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  });

  const prevLayersMask = camera.layers.mask;
  const prevQuadMat = post?.quad ? post.quad.material : null;

  try {
    renderer.autoClear = true;
    camera.updateMatrixWorld();

    // 1. Clipped reflection pass (layer 0 + single clip plane -> NUM_CLIPPING_PLANES 1 variants).
    camera.layers.set(0);
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
    renderer.setRenderTarget(warmReflRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clippingPlanes = prevClip;
    camera.layers.mask = prevLayersMask;

    // 2. Sun-shadow + main pass into offscreen scene target (shadow-depth + all main variants).
    for (let i = 0; i < savedLights.length; i++) {
      const l = savedLights[i].light;
      l.castShadow = true;
      l.shadow.autoUpdate = false;
      l.shadow.needsUpdate = true;
    }
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(post?.sceneRT ?? warmCompRT);
    renderer.clear();
    renderer.render(scene, camera);

    // 3. Every post material rendered offscreen (composite goes into warmCompRT, never screen).
    if (post && post.sceneRT) {
      const src = post.sceneRT.texture;
      post.downMat.uniforms.tSrc.value = src;
      post.downMat.uniforms.uTexel.value.set(1 / post.sw, 1 / post.sh);
      post.downMat.uniforms.uFirst.value = 1;
      post._pass(post.downMat, post.down[0]);

      post.downMat.uniforms.tSrc.value = post.down[0].texture;
      post.downMat.uniforms.uTexel.value.set(1 / post.down[0].width, 1 / post.down[0].height);
      post.downMat.uniforms.uFirst.value = 0;
      post._pass(post.downMat, post.down[1]);

      post.upMat.uniforms.tSrc.value = post.down[1].texture;
      post.upMat.uniforms.tAdd.value = post.down[0].texture;
      post.upMat.uniforms.uTexel.value.set(1 / post.down[1].width, 1 / post.down[1].height);
      post._pass(post.upMat, post.up[0]);

      post.maskMat.uniforms.tScene.value = src;
      post.maskMat.uniforms.tDepth.value = post.sceneRT.depthTexture;
      post.maskMat.uniforms.uAspect.value = post.sw / post.sh;
      post._pass(post.maskMat, post.rayA);

      post.blurMat.uniforms.tSrc.value = post.rayA.texture;
      post.blurMat.uniforms.uStep.value = 0.022;
      post._pass(post.blurMat, post.rayB);

      post.compMat.uniforms.tScene.value = src;
      post.compMat.uniforms.tBloom.value = post.up[0].texture;
      post.compMat.uniforms.tRays.value = post.rayB.texture;
      post.compMat.uniforms.tGhost.value = post.down[1].texture;
      post._pass(post.compMat, warmCompRT);

      renderer.setRenderTarget(post.sceneRT);
      renderer.clear();
    }
  } finally {
    camera.layers.mask = prevLayersMask;
    if (post?.quad) post.quad.material = prevQuadMat;
    for (let i = 0; i < savedObjs.length; i++) {
      const rec = savedObjs[i];
      rec.obj.frustumCulled = rec.frustumCulled;
      if (rec.count !== undefined) rec.obj.count = rec.count;
      if (rec.instanceCount !== undefined) rec.obj.geometry.instanceCount = rec.instanceCount;
    }
    for (let i = 0; i < savedLights.length; i++) {
      const rec = savedLights[i];
      rec.light.castShadow = rec.castShadow;
      rec.light.shadow.autoUpdate = rec.autoUpdate;
      rec.light.shadow.needsUpdate = rec.needsUpdate;
    }
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevRT);
    renderer.info.reset();
    warmReflRT.dispose();
    warmCompRT.dispose();
  }
}
