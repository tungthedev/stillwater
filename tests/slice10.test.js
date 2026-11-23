import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { QUALITY } from '../src/engine/quality.js';
import {
  hasPendingAsyncReadback,
  markCaptureRenderer,
  registerAsyncReadback,
  waitForAsyncReadbacks,
} from '../src/engine/app.js';
import { warmRenderPasses } from '../src/engine/renderFrame.js';
import { decodeRGBE, shouldUpdateSkyLUT, Sky } from '../src/world/sky.js';
import { createLighting, shouldUpdateSunShadow } from '../src/world/lighting.js';
import { U } from '../src/uniforms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encodeRGBEBytes(r, g, b) {
  const v = Math.max(r, g, b);
  if (v < 1e-32) return [0, 0, 0, 0];
  const e = Math.max(-127, Math.min(127, Math.floor(Math.log2(v)) + 1));
  const scale = Math.pow(2, -e);
  return [
    Math.min(255, Math.max(0, Math.round(r * scale * 255))),
    Math.min(255, Math.max(0, Math.round(g * scale * 255))),
    Math.min(255, Math.max(0, Math.round(b * scale * 255))),
    e + 128,
  ];
}

describe('Slice 10 quality tier shadow settings', () => {
  it('keeps PCFSoftShadowMap (no shadowSoft override) and 2-frame sun-shadow cadence on low', () => {
    for (const tier of Object.values(QUALITY)) {
      expect('shadowSoft' in tier).toBe(false);
    }
    expect(QUALITY.low.shadowEvery).toBe(2);
    expect(QUALITY.medium.shadowEvery).toBe(1);
    expect(QUALITY.high.shadowEvery).toBe(1);
    expect(QUALITY.ultra.shadowEvery).toBe(1);
  });
});

describe('Slice 10 sky LUT threshold, RGBA8 RGBE downsample, and async readback safety', () => {
  it('keys LUT updates strictly on sun/moon direction and intensity accumulated vs last rendered', () => {
    const base = {
      valid: true,
      sunDir: new THREE.Vector3(0.5, 0.5, 0.7071).normalize(),
      moonDir: new THREE.Vector3(-0.5, -0.5, -0.7071).normalize(),
      sunI: 22,
      moonI: 0,
    };
    const same = {
      sunDir: base.sunDir.clone(),
      moonDir: base.moonDir.clone(),
      sunI: 22,
      moonI: 0,
    };

    expect(shouldUpdateSkyLUT(base, same, { force: false, capture: false })).toBe(false);
    expect(shouldUpdateSkyLUT(base, same, { force: true, capture: false })).toBe(true);
    expect(shouldUpdateSkyLUT({ ...base, valid: false }, same, { force: false, capture: false })).toBe(true);

    // Sun direction change past threshold triggers update.
    const sunMoved = { ...same, sunDir: new THREE.Vector3(0.52, 0.5, 0.69).normalize() };
    expect(shouldUpdateSkyLUT(base, sunMoved, { force: false, capture: false })).toBe(true);

    // Moon direction change is ignored when moonI === 0 (daytime), triggers when moonI > 0.
    const moonMoved = { ...same, moonDir: new THREE.Vector3(-0.52, -0.5, -0.69).normalize() };
    expect(shouldUpdateSkyLUT(base, moonMoved, { force: false, capture: false })).toBe(false);
    expect(shouldUpdateSkyLUT({ ...base, moonI: 0.05 }, { ...moonMoved, moonI: 0.05 }, { force: false, capture: false })).toBe(true);

    // Moon or sun intensity change triggers update.
    expect(shouldUpdateSkyLUT(base, { ...same, moonI: 0.01 }, { force: false, capture: false })).toBe(true);
    expect(shouldUpdateSkyLUT(base, { ...same, sunI: 21.9 }, { force: false, capture: false })).toBe(true);

    // Tiny sun change below play threshold still updates in capture mode.
    const tinySun = { ...same, sunDir: base.sunDir.clone().add(new THREE.Vector3(0.0002, 0, 0)).normalize() };
    expect(shouldUpdateSkyLUT(base, tinySun, { force: false, capture: false })).toBe(false);
    expect(shouldUpdateSkyLUT(base, tinySun, { force: false, capture: true })).toBe(true);
  });

  it('encodes/decodes RGBE across night and HDR noon ranges within 1%', () => {
    const night = [0.00368, 0.00618, 0.01165];
    const [nr, ng, nb] = decodeRGBE(...encodeRGBEBytes(...night));
    expect(nr).toBeCloseTo(night[0], 4);
    expect(ng).toBeCloseTo(night[1], 4);
    expect(nb).toBeCloseTo(night[2], 4);

    const noon = [2.4, 4.1, 7.6];
    const [dr, dg, db] = decodeRGBE(...encodeRGBEBytes(...noon));
    expect(Math.abs(dr - noon[0]) / noon[0]).toBeLessThan(0.01);
    expect(Math.abs(dg - noon[1]) / noon[1]).toBeLessThan(0.01);
    expect(Math.abs(db - noon[2]) / noon[2]).toBeLessThan(0.01);

    expect(decodeRGBE(0, 0, 0, 0)).toEqual([0, 0, 0]);
  });

  it('has no synchronous readRenderTargetPixels calls in src/world/sky.js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'world', 'sky.js'), 'utf8');
    expect(src).not.toMatch(/readRenderTargetPixels\(/);
    expect(src).toMatch(/readRenderTargetPixelsAsync\(/);
  });

  it('uses an RGBA8 2x1 downsample RT with Uint8Array and readRenderTargetPixelsAsync', async () => {
    let resolveRead;
    const readCalls = [];
    let currentRT = null;
    const mockRenderer = {
      getRenderTarget: () => currentRT,
      setRenderTarget: (rt) => { currentRT = rt; },
      render: vi.fn(),
      getContext: () => ({
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        getParameter: () => null,
        bindBuffer: vi.fn(),
      }),
      readRenderTargetPixels: vi.fn(() => { throw new Error('sync readback forbidden'); }),
      readRenderTargetPixelsAsync: vi.fn((rt, x, y, w, h, buf) => {
        readCalls.push({ rt, x, y, w, h, buf });
        return new Promise((res) => {
          resolveRead = () => {
            buf.set([...encodeRGBEBytes(0.25, 0.5, 0.9), ...encodeRGBEBytes(0.6, 0.7, 0.85)]);
            res(buf);
          };
        });
      }),
    };

    U.uSunDir.value.set(0.4, 0.5, 0.7).normalize();
    const sky = new Sky(mockRenderer);
    expect(sky.renderLUT()).toBe(true);
    expect(sky.renderLUT()).toBe(false);
    expect(mockRenderer.render).toHaveBeenCalledTimes(1);

    sky.readAmbient();
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(true);
    expect(readCalls).toHaveLength(1);
    expect(readCalls[0].w).toBe(2);
    expect(readCalls[0].h).toBe(1);
    expect(readCalls[0].rt.texture.type).toBe(THREE.UnsignedByteType);
    expect(readCalls[0].buf).toBeInstanceOf(Uint8Array);
    expect(readCalls[0].buf.length).toBe(8);

    // Concurrent call while pending does not start a second readback.
    sky.readAmbient();
    expect(readCalls).toHaveLength(1);

    resolveRead();
    await waitForAsyncReadbacks(mockRenderer);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
    expect(sky.ambient.sky.r).toBeCloseTo(0.25, 2);
    expect(sky.ambient.sky.g).toBeCloseTo(0.5, 2);
    expect(sky.ambient.sky.b).toBeCloseTo(0.9, 2);
    expect(sky.ambient.horizon.r).toBeCloseTo(0.6, 2);
    expect(sky.ambient.horizon.g).toBeCloseTo(0.7, 2);
    expect(sky.ambient.horizon.b).toBeCloseTo(0.85, 2);

    // Unchanged LUT does not trigger another read.
    sky.readAmbient();
    expect(readCalls).toHaveLength(1);

    sky.dispose();
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
  });

  it('in capture mode, chains staged readback on LUT change and never loops on undefined result', async () => {
    const resolvers = [];
    const mockRenderer = {
      _rt: null,
      getRenderTarget() { return this._rt; },
      setRenderTarget(rt) { this._rt = rt; },
      render: vi.fn(),
      getContext: () => ({ PIXEL_PACK_BUFFER: 0x88eb, bindBuffer: vi.fn() }),
      readRenderTargetPixelsAsync: vi.fn((_rt, _x, _y, _w, _h, buf) => new Promise((res) => {
        resolvers.push((skyRGB, horRGB) => {
          if (!skyRGB) { res(undefined); return; }
          buf.set([...encodeRGBEBytes(...skyRGB), ...encodeRGBEBytes(...horRGB)]);
          res(buf);
        });
      })),
    };
    markCaptureRenderer(mockRenderer);

    U.uSunDir.value.set(0.3, 0.5, 0.8).normalize();
    const sky = new Sky(mockRenderer);
    expect(sky.renderLUT()).toBe(true);
    expect(resolvers).toHaveLength(1);

    // Update moon direction while readback #1 is still pending -> chains readback #2.
    sky.moonDir.value.set(-0.2, 0.6, -0.7).normalize();
    expect(sky.renderLUT()).toBe(true);
    expect(resolvers).toHaveLength(1);

    let waitDone = false;
    const waitP = waitForAsyncReadbacks(mockRenderer).then(() => { waitDone = true; });
    resolvers[0]([0.1, 0.2, 0.3], [0.4, 0.5, 0.6]);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    expect(waitDone).toBe(false);

    resolvers[1]([0.02, 0.04, 0.09], [0.05, 0.06, 0.12]);
    await waitP;
    expect(waitDone).toBe(true);
    expect(sky.ambient.sky.b).toBeCloseTo(0.97, 5);
    sky.readAmbient();
    expect(sky.ambient.sky.b).toBeCloseTo(0.09, 2);
    expect(sky.ambient.horizon.b).toBeCloseTo(0.12, 2);

    // Now force a LUT update whose readback resolves to undefined: must NOT retry in a loop.
    U.uSunDir.value.set(0.6, 0.4, 0.6).normalize();
    expect(sky.renderLUT()).toBe(true);
    expect(resolvers).toHaveLength(3);
    resolvers[2](null);
    await waitForAsyncReadbacks(mockRenderer);
    expect(resolvers).toHaveLength(3);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
    // Last good ambient preserved.
    expect(sky.ambient.sky.b).toBeCloseTo(0.09, 2);

    sky.dispose();
  });

  it('handles missing method, sync throw, rejection PBO cleanup, hung fence timeout, and context restore', async () => {
    // 1. Missing readRenderTargetPixelsAsync does not throw or hang.
    const noAsyncRenderer = {
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      render: vi.fn(),
    };
    U.uSunDir.value.set(0.4, 0.6, 0.6).normalize();
    const skyNoAsync = new Sky(noAsyncRenderer);
    expect(skyNoAsync.renderLUT()).toBe(true);
    expect(() => skyNoAsync.readAmbient()).not.toThrow();
    expect(hasPendingAsyncReadback(noAsyncRenderer)).toBe(false);
    skyNoAsync.dispose();

    // 2. Sync throw, rejection PBO cleanup, timeout, and context restore.
    const fakePbo = { id: 'pbo-1' };
    const deleteBuffer = vi.fn();
    const bindBuffer = vi.fn();
    let mode = 'throw';
    const mockRenderer = {
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      render: vi.fn(),
      getContext: () => ({
        PIXEL_PACK_BUFFER: 0x88eb,
        PIXEL_PACK_BUFFER_BINDING: 0x88ed,
        getParameter: () => fakePbo,
        bindBuffer,
        deleteBuffer,
        isContextLost: () => false,
      }),
      readRenderTargetPixelsAsync: vi.fn(() => {
        if (mode === 'throw') throw new Error('boom');
        if (mode === 'reject') return Promise.reject(new Error('WAIT_FAILED'));
        return new Promise(() => {}); // hung fence
      }),
    };

    const sky = new Sky(mockRenderer);
    sky.ambientReadTimeoutMs = 25;
    sky.ambient.sky.setRGB(0.2, 0.3, 0.4);
    expect(sky.renderLUT()).toBe(true);

    // Sync throw resets pending cleanly.
    expect(() => sky.readAmbient()).not.toThrow();
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);

    // Rejection cleans up leaked PBO and resolves waiters cleanly.
    mode = 'reject';
    sky.readAmbient();
    await waitForAsyncReadbacks(mockRenderer);
    expect(deleteBuffer).toHaveBeenCalledWith(fakePbo);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
    expect(sky.ambient.sky.r).toBeCloseTo(0.2, 5);

    // Hung fence expires at deadline and unblocks startup/capture.
    mode = 'hang';
    sky.readAmbient();
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(true);
    await waitForAsyncReadbacks(mockRenderer, 200);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);
    expect(sky.ambient.sky.r).toBeCloseTo(0.2, 5);

    // Three failures in a row switch the readback off: no new read starts, nothing pends.
    const callsBefore = mockRenderer.readRenderTargetPixelsAsync.mock.calls.length;
    U.uSunDir.value.set(0.5, 0.5, 0.6).normalize();
    expect(sky.renderLUT()).toBe(true);
    sky.readAmbient();
    expect(mockRenderer.readRenderTargetPixelsAsync.mock.calls.length).toBe(callsBefore);
    expect(hasPendingAsyncReadback(mockRenderer)).toBe(false);

    // Context restore invalidates the LUT and re-arms the readback.
    expect(sky.renderLUT()).toBe(false);
    sky.onContextRestored();
    expect(sky.renderLUT()).toBe(true);
    sky.readAmbient();
    expect(mockRenderer.readRenderTargetPixelsAsync.mock.calls.length).toBe(callsBefore + 1);

    sky.dispose();
  });

  it('waitForAsyncReadbacks honors its deadline when a hook never resolves', async () => {
    const r = {};
    const unreg = registerAsyncReadback(r, {
      isPending: () => true,
      wait: () => new Promise(() => {}),
    });
    const t0 = Date.now();
    await waitForAsyncReadbacks(r, 25);
    expect(Date.now() - t0).toBeLessThan(200);
    unreg();
  });
});

describe('Slice 10 sun-shadow cadence and light direction tracking', () => {
  it('forces shadow update on capture, first frame, shadow re-enable, center shift, or light turn', () => {
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 0, hasRendered: true, wasCasting: true })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true })).toBe(false);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 2, hasRendered: true, wasCasting: true })).toBe(true);

    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: false, wasCasting: true })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: false })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true, centerMoved: true })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true, lightTurned: true })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 2, frameIndex: 1, hasRendered: true, wasCasting: true, isCapture: true })).toBe(true);
    expect(shouldUpdateSunShadow({ shadowEvery: 1, frameIndex: 1, hasRendered: true, wasCasting: true })).toBe(true);
  });

  it('tracks uLightDir with shadows off, and refreshes shadows on stationary turn or time jump on low', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(10, 20, 30);
    camera.rotation.set(0, 0, 0);
    camera.updateMatrixWorld();
    const renderer = {};
    U.uLightDir.value.set(0.3, 0.7, 0.6).normalize();

    const lighting = createLighting({ scene, camera, U, tier: QUALITY.low, renderer });
    expect(lighting.sunLight.shadow.autoUpdate).toBe(false);
    expect(lighting.sunLight.shadow.radius).toBe(5);

    const env = { lightCol: new THREE.Color(1, 1, 1), golden: 0, dusk: 0, dawn: 0 };
    const amb = { sky: new THREE.Color(0.3, 0.5, 0.8), horizon: new THREE.Color(0.5, 0.6, 0.7) };
    const frame = { env, amb, renderFlags: { shadow: true } };

    // Frame 0: initial shadow render.
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);
    lighting.sunLight.shadow.needsUpdate = false;

    // Frame 1 (small forward walk): skips shadow on odd low frame.
    camera.position.set(11, 20, 30);
    camera.updateMatrixWorld();
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(false);

    // Frame 2: cadence update.
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);
    lighting.sunLight.shadow.needsUpdate = false;

    // Frame 3 (odd frame, stationary 90-deg camera turn): projected shadow center moves > 8m -> forces shadow refresh.
    camera.rotation.set(0, Math.PI / 2, 0);
    camera.updateMatrixWorld();
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);
    lighting.sunLight.shadow.needsUpdate = false;

    // Frame 4: cadence update.
    lighting.update(frame);
    lighting.sunLight.shadow.needsUpdate = false;

    // Frame 5 (odd frame, half-hour time jump changes uLightDir): forces shadow refresh.
    U.uLightDir.value.set(0.6, 0.5, 0.6).normalize();
    lighting.update(frame);
    expect(lighting.sunLight.shadow.needsUpdate).toBe(true);
    lighting.sunLight.shadow.needsUpdate = false;

    // Shadows disabled (?no=shadow): sunLight still follows uLightDir every frame.
    U.uLightDir.value.set(-0.7, 0.5, 0.4).normalize();
    lighting.update({ env, amb, renderFlags: { shadow: false } });
    expect(lighting.sunLight.shadow.needsUpdate).toBe(false);
    const actualDir = lighting.sunLight.position.clone().sub(lighting.sunLight.target.position).normalize();
    expect(actualDir.distanceTo(U.uLightDir.value)).toBeLessThan(1e-5);

    lighting.dispose();
  });
});

describe('Slice 10 hidden shader warmup pass', () => {
  it('uses live light config (no forced headlamp shadow), compiles canvas composite, and restores RT face/mip and uniforms', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 1000);
    camera.layers.enable(2);
    camera.updateMatrixWorld();

    const sunLight = new THREE.DirectionalLight(0xffffff, 1);
    sunLight.castShadow = true;
    sunLight.shadow.autoUpdate = false;
    sunLight.shadow.needsUpdate = false;
    scene.add(sunLight);

    const headlamp = new THREE.SpotLight(0xffffff, 0);
    headlamp.castShadow = false;
    headlamp.shadow.autoUpdate = true;
    headlamp.shadow.needsUpdate = false;
    scene.add(headlamp);

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.frustumCulled = true;
    scene.add(mesh);

    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 4);
    im.count = 0;
    scene.add(im);

    const ibg = new THREE.InstancedBufferGeometry();
    ibg.instanceCount = 0;
    scene.add(new THREE.Mesh(ibg, new THREE.MeshStandardMaterial()));

    const prevTarget = { id: 'prev-cube-rt' };
    let currentRT = prevTarget;
    let currentFace = 3;
    let currentMip = 2;
    const calls = [];
    const renderer = {
      clippingPlanes: [],
      autoClear: true,
      shadowMap: { autoUpdate: true, needsUpdate: false },
      info: { reset: vi.fn() },
      getRenderTarget: () => currentRT,
      getActiveCubeFace: () => currentFace,
      getActiveMipmapLevel: () => currentMip,
      setRenderTarget: (rt, face = 0, mip = 0) => {
        currentRT = rt;
        currentFace = face;
        currentMip = mip;
      },
      clear: vi.fn(),
      render: vi.fn((s, c) => {
        calls.push({
          scene: s,
          target: currentRT,
          clipCount: renderer.clippingPlanes.length,
          shadowNeeds: renderer.shadowMap.needsUpdate,
          sunNeeds: sunLight.shadow.needsUpdate,
          headlampCast: headlamp.castShadow,
          camMask: c.layers.mask,
          imCount: im.count,
          ibgCount: ibg.instanceCount,
          quadMat: s === post.scene ? post.quad.material : null,
          uFade: s === post.scene && post.quad.material === post.compMat ? post.compMat.uniforms.uFade.value : null,
        });
      }),
    };

    const mkRT = (w, h) => ({ width: w, height: h, texture: { id: `${w}x${h}` }, depthTexture: { id: 'depth' } });
    const post = {
      opts: { godrays: true },
      sw: 640,
      sh: 360,
      sceneRT: mkRT(640, 360),
      down: [mkRT(320, 180), mkRT(160, 90)],
      up: [mkRT(320, 180), mkRT(160, 90)],
      rayA: mkRT(160, 90),
      rayB: mkRT(160, 90),
      blackTex: { id: 'black' },
      quad: { material: null },
      scene: new THREE.Scene(),
      cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      downMat: { uniforms: { tSrc: { value: 'origDown' }, uTexel: { value: new THREE.Vector2(1, 2) }, uFirst: { value: 9 } } },
      upMat: { uniforms: { tSrc: { value: 'origUp' }, tAdd: { value: 'origAdd' }, uTexel: { value: new THREE.Vector2(3, 4) } } },
      maskMat: { uniforms: { tScene: { value: 'origMask' }, tDepth: { value: 'origDepth' }, uAspect: { value: 1.5 } } },
      blurMat: { uniforms: { tSrc: { value: 'origBlur' }, uStep: { value: 0.05 } } },
      compMat: { uniforms: { tScene: { value: 'origComp' }, tBloom: { value: 'origBloom' }, tRays: { value: 'origRays' }, tGhost: { value: 'origGhost' }, uFade: { value: 0.75 } } },
      _pass(mat, target) {
        this.quad.material = mat;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.cam);
      },
    };

    warmRenderPasses({ renderer, scene, camera, post, warmReflection: true });

    // 1. Clipped reflection pass on layer 0.
    expect(calls[0].clipCount).toBe(1);
    expect(calls[0].camMask).toBe(1);
    expect(calls[0].headlampCast).toBe(false);

    // 2. Live sun-shadow + main pass: sun shadow updates, headlamp stays non-casting.
    expect(calls[1].target).toBe(post.sceneRT);
    expect(calls[1].sunNeeds).toBe(true);
    expect(calls[1].headlampCast).toBe(false);

    // 3. Post materials end with compMat drawn to real canvas (target === null) with uFade === 0.
    const postCalls = calls.slice(2);
    expect(postCalls.map((c) => c.quadMat)).toEqual([
      post.downMat,
      post.downMat,
      post.upMat,
      post.maskMat,
      post.blurMat,
      post.compMat,
    ]);
    expect(postCalls[5].target).toBe(null);
    expect(postCalls[5].uFade).toBe(0);

    // All scene, light, post uniform, and RT (target + face + mip) state restored.
    expect(mesh.frustumCulled).toBe(true);
    expect(im.count).toBe(0);
    expect(ibg.instanceCount).toBe(0);
    expect(headlamp.castShadow).toBe(false);
    expect(headlamp.shadow.autoUpdate).toBe(true);
    expect(sunLight.shadow.needsUpdate).toBe(false);
    expect(post.compMat.uniforms.uFade.value).toBe(0.75);
    expect(post.compMat.uniforms.tScene.value).toBe('origComp');
    expect(post.downMat.uniforms.tSrc.value).toBe('origDown');
    expect(post.downMat.uniforms.uTexel.value.x).toBe(1);
    expect(post.blurMat.uniforms.uStep.value).toBe(0.05);
    expect(renderer.getRenderTarget()).toBe(prevTarget);
    expect(renderer.getActiveCubeFace()).toBe(3);
    expect(renderer.getActiveMipmapLevel()).toBe(2);

    // With warmReflection: false and godrays: false, skips clipped reflection and ray passes.
    calls.length = 0;
    post.opts.godrays = false;
    warmRenderPasses({ renderer, scene, camera, post, warmReflection: false });
    expect(calls.some((c) => c.clipCount > 0)).toBe(false);
    expect(calls.some((c) => c.quadMat === post.maskMat || c.quadMat === post.blurMat)).toBe(false);
  });
});
