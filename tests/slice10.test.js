import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY } from '../src/engine/quality.js';
import {
  applyShadowMapType,
  hasPendingAsyncReadback,
  markCaptureRenderer,
  registerAsyncReadback,
  waitForAsyncReadbacks,
} from '../src/engine/app.js';
import { warmRenderPasses } from '../src/engine/renderFrame.js';
import { shouldUpdateSkyLUT, Sky } from '../src/world/sky.js';
import { createLighting, shouldUpdateSunShadow } from '../src/world/lighting.js';
import { U } from '../src/uniforms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Slice 10 quality tier shadow settings', () => {
  it('uses plain PCF on low/medium, PCFSoft on high/ultra, and 2-frame sun-shadow cadence on low', () => {
    expect(QUALITY.low.shadowSoft).toBe(false);
    expect(QUALITY.low.shadowEvery).toBe(2);
    expect(QUALITY.medium.shadowSoft).toBe(false);
    expect(QUALITY.medium.shadowEvery).toBe(1);
    expect(QUALITY.high.shadowSoft).toBe(true);
    expect(QUALITY.high.shadowEvery).toBe(1);
    expect(QUALITY.ultra.shadowSoft).toBe(true);
    expect(QUALITY.ultra.shadowEvery).toBe(1);
  });

  it('applyShadowMapType updates renderer type and invalidates materials only on change', () => {
    const renderer = { shadowMap: { type: THREE.PCFSoftShadowMap } };
    const matA = new THREE.MeshStandardMaterial();
    const matB = new THREE.MeshBasicMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), matA));
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [matB]));
    const vA0 = matA.version;
    const vB0 = matB.version;

    // Switching from PCFSoft -> PCF invalidates materials.
    expect(applyShadowMapType(renderer, scene, QUALITY.low)).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap);
    expect(matA.version).toBeGreaterThan(vA0);
    expect(matB.version).toBeGreaterThan(vB0);

    // Staying on PCF (low -> medium) does not re-invalidate materials.
    const vA1 = matA.version;
    expect(applyShadowMapType(renderer, scene, QUALITY.medium)).toBe(false);
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap);
    expect(matA.version).toBe(vA1);

    // Switching back to PCFSoft (medium -> high) invalidates materials again.
    expect(applyShadowMapType(renderer, scene, QUALITY.high)).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
    expect(matA.version).toBeGreaterThan(vA1);
  });
});

describe('Slice 10 sky LUT threshold & async ambient readback', () => {
  it('re-renders LUT only when sun/moon/intensity/weather crosses threshold or forced', () => {
    const base = {
      valid: true,
      sunDir: new THREE.Vector3(0.5, 0.5, 0.7071).normalize(),
      moonDir: new THREE.Vector3(-0.5, -0.5, -0.7071).normalize(),
      sunI: 22,
      moonI: 0,
      cloud: 0.3,
      fogBeta: new THREE.Vector3(2.4e-5, 4.6e-5, 1.18e-4),
    };
    const same = {
      sunDir: base.sunDir.clone(),
      moonDir: base.moonDir.clone(),
      sunI: 22,
      moonI: 0,
      cloud: 0.31,
      fogBeta: base.fogBeta.clone(),
    };

    expect(shouldUpdateSkyLUT(base, same, { force: false, capture: false })).toBe(false);
    expect(shouldUpdateSkyLUT(base, same, { force: true, capture: false })).toBe(true);
    expect(shouldUpdateSkyLUT({ ...base, valid: false }, same, { force: false, capture: false })).toBe(true);

    // Sun direction change past threshold triggers update.
    const sunMoved = { ...same, sunDir: new THREE.Vector3(0.52, 0.5, 0.69).normalize() };
    expect(shouldUpdateSkyLUT(base, sunMoved, { force: false, capture: false })).toBe(true);

    // Moon direction change is ignored while moon intensity is 0 (daytime), and triggers update when moon is active.
    const moonMoved = { ...same, moonDir: new THREE.Vector3(-0.52, -0.5, -0.69).normalize() };
    expect(shouldUpdateSkyLUT(base, moonMoved, { force: false, capture: false })).toBe(false);
    expect(shouldUpdateSkyLUT({ ...base, moonI: 0.05 }, { ...moonMoved, moonI: 0.05 }, { force: false, capture: false })).toBe(true);

    // Moon intensity change triggers update.
    expect(shouldUpdateSkyLUT(base, { ...same, moonI: 0.01 }, { force: false, capture: false })).toBe(true);

    // Weather change past threshold triggers update.
    expect(shouldUpdateSkyLUT(base, { ...same, cloud: 0.40 }, { force: false, capture: false })).toBe(true);
    expect(shouldUpdateSkyLUT(base, { ...same, fogBeta: new THREE.Vector3(5e-5, 4.6e-5, 1.18e-4) }, { force: false, capture: false })).toBe(true);

    // Tiny sun change below play threshold still updates in capture mode.
    const tinySun = { ...same, sunDir: base.sunDir.clone().add(new THREE.Vector3(0.0002, 0, 0)).normalize() };
    expect(shouldUpdateSkyLUT(base, tinySun, { force: false, capture: false })).toBe(false);
    expect(shouldUpdateSkyLUT(base, tinySun, { force: false, capture: true })).toBe(true);
  });

  it('has no synchronous readRenderTargetPixels calls in src/world/sky.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'world', 'sky.js'), 'utf8');
    expect(src).not.toMatch(/readRenderTargetPixels\(/);
    expect(src).toMatch(/readRenderTargetPixelsAsync\(/);
  });

  it('uses a small downsample RT with readRenderTargetPixelsAsync and tracks pending state', async () => {
    let resolveRead;
    const readCalls = [];
    const renderTargets = [];
    let currentRT = null;
    const mockRenderer = {
      getRenderTarget: () => currentRT,
      setRenderTarget: (rt) => { currentRT = rt; },
      render: vi.fn(() => { renderTargets.push(currentRT); }),
      getContext: () => ({ PIXEL_PACK_BUFFER: 0x88eb, bindBuffer: vi.fn() }),
      readRenderTargetPixels: vi.fn(() => { throw new Error('sync readback forbidden'); }),
      readRenderTargetPixelsAsync: vi.fn((rt, x, y, w, h, buf) => {
        readCalls.push({ rt, x, y, w, h, bufLen: buf.length });
        return new Promise((res) => {
          resolveRead = () => {
            buf[0] = 0.25; buf[1] = 0.5; buf[2] = 0.9; buf[3] = 1;
            buf[4] = 0.6; buf[5] = 0.7; buf[6] = 0.85; buf[7] = 1;
            res(buf);
          };
        });
      }),
    };

    U.uSunDir.value.set(0.4, 0.5, 0.7).normalize();
    U.uCloudCover.value = 0.3;
    U.uFogBeta.value.set(2.4e-5, 4.6e-5, 1.18e-4);

    const sky = new Sky(mockRenderer);
    expect(sky.renderLUT()).toBe(true);
    // Second call with unchanged uniforms skips rendering.
    expect(sky.renderLUT()).toBe(false);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    sky.readAmbient();
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(true);
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0].w).toBe(2);
    expect(readCalls[0].h).toBe(1);
    expect(readCalls[0].bufLen).toBe(8);

    // Concurrent call while pending does not start a second readback.
    sky.readAmbient();
    expect(readCalls).toHaveLength(1);

    resolveRead();
    await waitForAsyncReadbacks(mockRenderer);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
    expect(sky.ambient.sky.r).toBeCloseTo(0.25, 5);
    expect(sky.ambient.sky.g).toBeCloseTo(0.5, 5);
    expect(sky.ambient.sky.b).toBeCloseTo(0.9, 5);
    expect(sky.ambient.horizon.r).toBeCloseTo(0.6, 5);
    expect(sky.ambient.horizon.g).toBeCloseTo(0.7, 5);
    expect(sky.ambient.horizon.b).toBeCloseTo(0.85, 5);

    // Calling readAmbient again without a LUT change does nothing.
    sky.readAmbient();
    expect(readCalls).toHaveLength(1);

    sky.dispose();
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
  });

  it('in capture mode, chains follow-up async ambient readback when LUT updates while a read is in flight', async () => {
    const resolvers = [];
    const mockRenderer = {
      _rt: null,
      getRenderTarget() { return this._rt; },
      setRenderTarget(rt) { this._rt = rt; },
      render: vi.fn(),
      getContext: () => ({ PIXEL_PACK_BUFFER: 0x88eb, bindBuffer: vi.fn() }),
      readRenderTargetPixelsAsync: vi.fn((_rt, _x, _y, _w, _h, buf) => new Promise((res) => {
        resolvers.push((skyRGB, horRGB) => {
          buf[0] = skyRGB[0]; buf[1] = skyRGB[1]; buf[2] = skyRGB[2]; buf[3] = 1;
          buf[4] = horRGB[0]; buf[5] = horRGB[1]; buf[6] = horRGB[2]; buf[7] = 1;
          res(buf);
        });
      })),
    };
    markCaptureRenderer(mockRenderer);

    U.uSunDir.value.set(0.3, 0.5, 0.8).normalize();
    U.uCloudCover.value = 0.3;
    U.uFogBeta.value.set(2.4e-5, 4.6e-5, 1.18e-4);

    const sky = new Sky(mockRenderer);
    expect(sky.renderLUT()).toBe(true);
    expect(resolvers).toHaveLength(1);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(true);

    // Update moon direction while readback #1 is still pending -> renderLUT queues follow-up read.
    sky.moonDir.value.set(-0.2, 0.6, -0.7).normalize();
    expect(sky.renderLUT()).toBe(true);
    expect(resolvers).toHaveLength(1);

    let waitDone = false;
    const waitP = waitForAsyncReadbacks(mockRenderer).then(() => { waitDone = true; });

    // Resolve readback #1: follow-up readback #2 must start and waitP must remain pending.
    resolvers[0]([0.1, 0.2, 0.3], [0.4, 0.5, 0.6]);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    expect(waitDone).toBe(false);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(true);

    // Resolve readback #2: staged values wait until readAmbient() commits them, and waitP resolves.
    resolvers[1]([0.02, 0.04, 0.09], [0.05, 0.06, 0.12]);
    await waitP;
    expect(waitDone).toBe(true);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
    expect(sky.ambient.sky.b).toBeCloseTo(1, 5);
    sky.readAmbient();
    expect(sky.ambient.sky.b).toBeCloseTo(0.09, 5);
    expect(sky.ambient.horizon.b).toBeCloseTo(0.12, 5);
    // No extra GPU readback triggered because staged version already matches LUT version.
    expect(resolvers).toHaveLength(2);

    sky.dispose();
  });

  it('registerAsyncReadback hook can wait and unregister cleanly', async () => {
    const r = {};
    let pending = true;
    let done;
    const p = new Promise((res) => { done = res; });
    const unreg = registerAsyncReadback(r, {
      isPending: () => pending,
      wait: () => (pending ? p : Promise.resolve()),
    });
    expect(hasPendingAsyncReadback(r)).toBe(true);
    pending = false;
    done();
    await waitForAsyncReadbacks(r);
    expect(hasPendingAsyncReadback(r)).toBe(false);
    unreg();
  });
});

describe('Slice 10 sun-shadow cadence', () => {
  it('updates every 2nd frame on low, every frame on medium+, and forces on capture or jump', () => {
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 0, hasRendered: true, wasCasting: true, camJumped: false, isCapture: false })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true, camJumped: false, isCapture: false })).toBe(false);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 2, hasRendered: true, wasCasting: true, camJumped: false, isCapture: false })).toBe(true);

    // Force cases on odd frame.
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: false, wasCasting: true, camJumped: false, isCapture: false })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: false, camJumped: false, isCapture: false })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true, camJumped: true, isCapture: false })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true, camJumped: false, isCapture: true })).toBe(true);

    // Medium/high/ultra update every frame.
    expect(shouldUpdateSunShadow({ shadowEvery: 1, frameIndex: 1, hasRendered: true, wasCasting: true, camJumped: false, isCapture: false })).toBe(true);
  });

  it('createLighting skips moving sunLight and shadow.needsUpdate on skipped low frames, and always updates in capture', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, 20, 30);
    camera.updateMatrixWorld();
    const renderer = {};
    U.uLightDir.value.set(0.3, 0.7, 0.6).normalize();

    const lighting = createLighting({ scene, camera, U, tier: QUALITY.low, renderer });
    expect(lighting.sunLight.shadow.autoUpdate).toBe(false);

    const env = { lightCol: new THREE.Color(1, 1, 1), golden: 0, dusk: 0, dawn: 0 };
    const amb = { sky: new THREE.Color(0.3, 0.5, 0.8), horizon: new THREE.Color(0.5, 0.6, 0.7) };
    const frame = { env, amb, renderFlags: { shadow: true } };

    // Frame 0: updates shadow.
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);
    const pos0 = lighting.sunLight.target.position.clone();
    lighting.sunLight.shadow.needsUpdate = false;

    // Frame 1 (small walk): skips shadow and keeps shadow target locked.
    camera.position.set(11, 20, 30);
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(false);
    expect(lighting.sunLight.target.position.equals(pos0)).toBe(true);

    // Frame 2: updates shadow again.
    camera.position.set(12, 20, 30);
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);
    lighting.sunLight.shadow.needsUpdate = false;

    // Odd frame with capture renderer always updates shadow.
    markCaptureRenderer(renderer);
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);

    lighting.dispose();
  });
});

describe('Slice 10 hidden shader warmup pass', () => {
  it('draws clipped reflection, sun-shadow+main, and all post materials offscreen, then restores all state', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 1000);
    camera.layers.enable(2);
    camera.updateMatrixWorld();

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = false;
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = false;
    scene.add(light);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.frustumCulled = true;
    scene.add(mesh);

    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 4);
    im.count = 0;
    im.frustumCulled = true;
    scene.add(im);

    const ibg = new THREE.InstancedBufferGeometry();
    ibg.instanceCount = 0;
    const ibgMesh = new THREE.Mesh(ibg, new THREE.MeshStandardMaterial());
    scene.add(ibgMesh);

    const calls = [];
    let currentRT = null;
    const renderer = {
      clippingPlanes: [],
      autoClear: true,
      shadowMap: { autoUpdate: true, needsUpdate: false },
      info: { reset: vi.fn() },
      getRenderTarget: () => currentRT,
      setRenderTarget: (rt) => { currentRT = rt; },
      clear: vi.fn(),
      render: vi.fn((s, c) => {
        calls.push({
          scene: s,
          target: currentRT,
          clipCount: renderer.clippingPlanes.length,
          shadowAuto: renderer.shadowMap.autoUpdate,
          shadowNeeds: renderer.shadowMap.needsUpdate,
          camMask: c.layers.mask,
          imCount: im.count,
          ibgCount: ibg.instanceCount,
          frustumCulled: mesh.frustumCulled,
          quadMat: s === post.scene ? post.quad.material : null,
          uFirst: s === post.scene && post.quad.material === post.downMat ? post.downMat.uniforms.uFirst.value : null,
        });
      }),
    };

    const mkRT = (w, h) => ({ width: w, height: h, texture: { id: `${w}x${h}` }, depthTexture: { id: 'depth' } });
    const post = {
      sw: 640,
      sh: 360,
      sceneRT: mkRT(640, 360),
      down: [mkRT(320, 180), mkRT(160, 90)],
      up: [mkRT(320, 180), mkRT(160, 90)],
      rayA: mkRT(160, 90),
      rayB: mkRT(160, 90),
      quad: { material: null },
      scene: new THREE.Scene(),
      cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      downMat: { uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } } },
      upMat: { uniforms: { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } } },
      maskMat: { uniforms: { tScene: { value: null }, tDepth: { value: null }, uAspect: { value: 1 } } },
      blurMat: { uniforms: { tSrc: { value: null }, uStep: { value: 0.02 } } },
      compMat: { uniforms: { tScene: { value: null }, tBloom: { value: null }, tRays: { value: null }, tGhost: { value: null } } },
      _pass(mat, target) {
        this.quad.material = mat;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.cam);
      },
    };

    warmRenderPasses({ renderer, scene, camera, post });

    // Never drew to screen (null render target).
    expect(calls.every((c) => c.target !== null)).toBe(true);

    // 1. Clipped reflection pass on layer 0.
    expect(calls[0].scene).toBe(scene);
    expect(calls[0].clipCount).toBe(1);
    expect(calls[0].camMask).toBe(1);
    expect(calls[0].imCount).toBe(1);
    expect(calls[0].ibgCount).toBe(1);
    expect(calls[0].frustumCulled).toBe(false);

    // 2. Sun-shadow + main pass into post.sceneRT.
    expect(calls[1].scene).toBe(scene);
    expect(calls[1].target).toBe(post.sceneRT);
    expect(calls[1].clipCount).toBe(0);
    expect(calls[1].shadowNeeds).toBe(true);

    // 3. All 5 post materials (downMat first=1 & first=0, upMat, maskMat, blurMat, compMat).
    const postCalls = calls.slice(2);
    expect(postCalls.map((c) => c.quadMat)).toEqual([
      post.downMat,
      post.downMat,
      post.upMat,
      post.maskMat,
      post.blurMat,
      post.compMat,
    ]);
    expect(postCalls[0].uFirst).toBe(1);
    expect(postCalls[1].uFirst).toBe(0);

    // All scene/renderer state restored after warmup.
    expect(mesh.frustumCulled).toBe(true);
    expect(im.count).toBe(0);
    expect(ibg.instanceCount).toBe(0);
    expect(light.castShadow).toBe(false);
    expect(light.shadow.needsUpdate).toBe(false);
    expect(renderer.clippingPlanes).toEqual([]);
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    expect(renderer.shadowMap.needsUpdate).toBe(false);
    expect(renderer.getRenderTarget()).toBe(null);
  });
});
