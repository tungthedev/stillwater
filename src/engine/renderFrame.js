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
  const reflRendered = !!passes.reflectionPass(frame);
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
      reflection: { calls: reflCalls, tris: reflTris, rendered: reflRendered },
      main: { calls: mainCalls, tris: mainTris },
      post: { calls: postCalls, tris: postTris },
    },
  };
}
