import { WORLD } from '../config.js';

// Capture mode driver: deterministic shot placement, overlay reset, fixed-frame completion.
// Loaded dynamically only when ?capture or ?bench is present.

const $ = (id) => document.getElementById(id);

export function createCapture(ctx) {
  const {
    params,
    U,
    clock,
    session,
    env,
    player,
    camera,
    lighting,
    data,
    world,
  } = ctx;
  const { hf, trail, streamPlan } = data;
  const { sky, shadows, trees, rocks, props, village, stream, falls, clouds, terrain, forestIdx } = world;

  let targetFrames = parseInt(params.get('frames') || '45');

  function applyCaptureParams(qp, fastFrames = null) {
    window.__shotReady = false;
    player.enabled = true;
    player.sitting = null;
    player.sitBlend = 0;
    player.vel.set(0, 0, 0);
    player.roll = 0;
    player.pitch = player.pitchT = 0;
    player.placeAtStart();
    session.mode = 'play';
    session.fade = 1;
    session.fadeTarget = 1;
    lighting.setHeadlamp(false);
    env.fixedWeather = null;
    env.hours = qp.get('time') ? parseFloat(qp.get('time')) : 15.8;
    if (qp.get('wind')) {
      env.fixedWeather = true;
      env.wind = parseFloat(qp.get('wind'));
      env.cloud = parseFloat(qp.get('cloud') || '0.42');
    }
    // let daytime afternoon clouds drift naturally across title (16.2), meadow (16.0) & pasture (16.6) while keeping dawn/dusk/night hero cloud compositions!
    const hDrift = (env.hours >= 10.0 && env.hours <= 18.2) ? (env.hours - 16.2) * 4200 : 0;
    U.uCloudOffset.value.set(hDrift * 0.25, hDrift * 0.16);
    clouds.uniforms.uDrift.value.set(hDrift * 0.84, hDrift * 0.54);

    let d = parseFloat(qp.get('trail') || '-1');
    if (qp.get('trailf')) d = parseFloat(qp.get('trailf')) * trail.dist[trail.dist.length - 1];
    if (d >= 0) {
      const dist = trail.dist;
      let i = dist.findIndex((x) => x >= d);
      if (i < 0) i = trail.points.length - 1;
      const p = trail.points[i], q2 = trail.points[Math.min(trail.points.length - 1, i + 8)];
      player.pos.set(p[0], 0, p[1]);
      player.yaw = player.yawT = Math.atan2(-(q2[0] - p[0]), -(q2[1] - p[1])) + parseFloat(qp.get('yaw') || '0');
    }
    if (qp.get('pos')) {
      const [x, z] = qp.get('pos').split(',').map(parseFloat);
      player.pos.set(x, 0, z);
      if (qp.get('yaw')) player.yaw = player.yawT = parseFloat(qp.get('yaw'));
    }
    if (qp.get('poi') === 'cottage') {
      const hx = village.house.x, hz = village.house.z;
      const a = Math.atan2(village.house.front[0], village.house.front[1]) + parseFloat(qp.get('ang') || '0.45');
      const r = parseFloat(qp.get('dist') || '21');
      player.pos.set(hx + Math.sin(a) * r, 0, hz + Math.cos(a) * r);
      player.yaw = player.yawT = Math.atan2(-(hx - player.pos.x), -(hz - player.pos.z)) + parseFloat(qp.get('yaw') || '0');
    }
    if (qp.get('poi') === 'stream' && stream) {
      const sp = streamPlan.points;
      const i = Math.floor(sp.length * parseFloat(qp.get('sf') || '0.5'));
      const p = sp[i], q = sp[Math.max(0, i - 12)];
      const ox = -(q[1] - p[1]), oz = q[0] - p[0], ol = Math.hypot(ox, oz) || 1;
      player.pos.set(p[0] + ox / ol * 14, 0, p[1] + oz / ol * 14);
      player.yaw = player.yawT = Math.atan2(-(q[0] - player.pos.x), -(q[1] - player.pos.z));
    }
    if (qp.get('poi') === 'forest') {
      const p = trail.points[forestIdx], q = trail.points[Math.min(trail.points.length - 1, forestIdx + 10)];
      player.pos.set(p[0], 0, p[1]);
      player.yaw = player.yawT = Math.atan2(-(q[0] - p[0]), -(q[1] - p[1]));
    }
    if (qp.get('poi') === 'sheep') {
      const flock = village.sheep.list.slice(0, 10);
      let cxS = 0, czS = 0;
      for (const sh of flock) { cxS += sh.x; czS += sh.z; }
      cxS /= flock.length; czS /= flock.length;
      let best = null, bd = -1e9;
      for (let k = 0; k < 48; k++) {
        const a = k / 48 * Math.PI * 2, x = cxS + Math.cos(a) * 12.2, z = czS + Math.sin(a) * 12.2;
        const lookYaw = Math.atan2(-(cxS - x), -(czS - z));
        const fvx = -Math.sin(lookYaw), fvz = -Math.cos(lookYaw);
        let minSheep = 1e9, edgePenalty = 0, inFrame = 0;
        for (const sh of village.sheep.list) {
          const dx = sh.x - x, dz = sh.z - z, dd = Math.hypot(dx, dz);
          minSheep = Math.min(minSheep, dd);
          if (dd < 65) {
            const fwd = dx * fvx + dz * fvz;
            if (fwd > 1.5) {
              const ang = Math.abs(Math.atan2(Math.abs(dx * fvz - dz * fvx), fwd));
              if (ang > 0.33 && ang < 0.80) edgePenalty += dd < 28 ? 22 : 14;
              else if (ang <= 0.33 && dd < 30) inFrame++;
            }
          }
        }
        if (minSheep < 5.6) continue;
        let md = 1e9;
        for (const tr of trees.trees) {
          if (tr.hidden) continue;
          const distT = Math.hypot(tr.x - x, tr.z - z) - tr.s * 0.25;
          if (distT < md) md = distT;
        }
        const scS = Math.min(md, 14) + Math.min(minSheep, 9) * 0.5 + inFrame * 2.2 - edgePenalty;
        if (scS > bd) { bd = scS; best = [x, z, lookYaw]; }
      }
      if (!best) best = [cxS + 12, czS + 12, Math.atan2(12, 12)];
      player.pos.set(best[0], 0, best[1]);
      player.yaw = player.yawT = best[2];
    }
    if (qp.get('poi') === 'fallsStream' && falls && falls.foot) {
      const sp = streamPlan.points, k = Math.min(sp.length - 2, falls.footIdx + parseInt(qp.get('dn') || '16'));
      const [px, pz] = sp[k], [qx, qz] = sp[k + 1];
      const tx = qx - px, tz = qz - pz, tl = Math.hypot(tx, tz) || 1;
      const side = parseFloat(qp.get('side') || '3.2');
      player.pos.set(px - tz / tl * side, 0, pz + tx / tl * side);
      const tgx = (falls.foot.x * 0.6 + falls.top.x * 0.4), tgz = (falls.foot.z * 0.6 + falls.top.z * 0.4), tgy = falls.foot.y * 0.55 + falls.top.y * 0.45;
      player.yaw = player.yawT = Math.atan2(-(tgx - player.pos.x), -(tgz - player.pos.z));
      const ey = hf.height(player.pos.x, player.pos.z) + 1.7;
      player.pitch = player.pitchT = Math.atan2(tgy - ey, Math.hypot(tgx - player.pos.x, tgz - player.pos.z));
    }
    if (qp.get('poi') === 'falls' && falls && falls.foot) {
      const base = Math.atan2(falls.down.x, falls.down.z);
      let best = null, bs = -1e9;
      for (let a = -1.4; a <= 1.4; a += 0.1) for (let r = 14; r <= 26; r += 3) {
        const x = falls.foot.x + Math.sin(base + a) * r, z = falls.foot.z + Math.cos(base + a) * r;
        if (hf.height(x, z) < WORLD.waterLevel + 1 || hf.trailAt(x, z) > 0.5) continue;
        let clear = 1e9;
        for (const tr of trees.trees) {
          if (tr.hidden) continue;
          const px = tr.x - x, pz = tr.z - z, vx = falls.foot.x - x, vz = falls.foot.z - z;
          const L = Math.hypot(vx, vz);
          const u = Math.max(-6, Math.min(L, (px * vx + pz * vz) / L));
          const distT = Math.hypot(px - vx / L * u, pz - vz / L * u) - (tr.bush ? 1.5 : tr.s * 0.35);
          if (distT < clear) clear = distT;
        }
        let near = 1e9;
        for (const tr of trees.trees) {
          if (tr.hidden) continue;
          const dd = Math.hypot(tr.x - x, tr.z - z) - (tr.bush ? 1 : tr.s * 0.4);
          if (dd < near) near = dd;
        }
        const gy = hf.height(x, z), slopeHere = 1 - hf.normal(x, z, 3).y;
        const scF = Math.min(clear, 8) + Math.min(near, 6) - Math.abs(a) * 1.2 - Math.abs(r - 20) * 0.1 - slopeHere * 25 - Math.max(0, gy - falls.foot.y - 4) * 0.6;
        if (scF > bs) { bs = scF; best = [x, z]; }
      }
      player.pos.set(best[0], 0, best[1]);
      const tgx = (falls.foot.x + falls.top.x) / 2, tgz = (falls.foot.z + falls.top.z) / 2, tgy = (falls.foot.y + falls.top.y) / 2;
      player.yaw = player.yawT = Math.atan2(-(tgx - player.pos.x), -(tgz - player.pos.z));
      const ey = hf.height(player.pos.x, player.pos.z) + 1.7;
      player.pitch = player.pitchT = Math.atan2(tgy - ey, Math.hypot(tgx - player.pos.x, tgz - player.pos.z)) + 0.05;
    }
    if (qp.get('poi') === 'bridge' && stream && stream.bridge) {
      const b = stream.bridge;
      const a = parseFloat(qp.get('ang') || '0.9');
      player.pos.set(b.x + Math.sin(a) * 16, 0, b.z + Math.cos(a) * 16);
      player.yaw = player.yawT = Math.atan2(-(b.x - player.pos.x), -(b.z - player.pos.z));
    }
    if (qp.get('poi') === 'horses') {
      const flock = village.sheep.list.slice(0, 10);
      let cxP = 0, czP = 0;
      for (const sh of flock) { cxP += sh.x; czP += sh.z; }
      cxP /= flock.length; czP /= flock.length;
      const hp = village.sheep.list[3];
      const px0 = cxP - 11.5, pz0 = czP + 8.5;
      player.pos.set(px0, 0, pz0);
      player.yaw = player.yawT = Math.atan2(-(cxP * 0.72 + hp.x * 0.28 - px0), -(czP * 0.72 + hp.z * 0.28 - pz0)) - 0.08;
    }
    if (qp.get('faceMoon')) {
      env.update(0, 0, null);
      const m = env.moon;
      player.yaw = player.yawT = Math.atan2(-m.x, -m.z) + parseFloat(qp.get('yaw') || '0');
    }
    if (qp.get('pitch')) player.pitch = player.pitchT = parseFloat(qp.get('pitch'));
    if (qp.get('bench')) {
      const b = props.benches[parseInt(qp.get('bench'))];
      player.pos.set(b.x, 0, b.z);
    }
    if (qp.get('sit') || qp.get('bench')) {
      player.toggleSit();
      player.sitBlend = 1;
      player.pitch = player.pitchT = parseFloat(qp.get('pitch') || '-0.05');
      player.yaw = player.yawT = player.yawT + parseFloat(qp.get('byaw') || '0');
    }
    player.eyeY = hf.height(player.pos.x, player.pos.z) + 1.68;
    env.timeScale = 0;

    // UI overlays reset cleanly per shot
    const titleEl = $('title');
    if (qp.get('title')) {
      session.mode = 'title';
      titleEl.style.transition = 'none';
      titleEl.style.opacity = 1;
    } else {
      titleEl.style.transition = 'none';
      titleEl.style.opacity = 0;
    }
    $('hud').style.transition = 'none';
    $('hud').style.opacity = qp.get('hud') ? 1 : 0;
    $('toast').style.opacity = 0;
    $('place').style.opacity = 0;
    $('prompt').style.opacity = 0;
    if (qp.get('lamp')) lighting.setHeadlamp(true);

    const wantFrames = parseInt(qp.get('frames') || '45');
    if (fastFrames != null) {
      clock.t = Math.max(0, (wantFrames - fastFrames) / 30);
      clock.frameNo = 0;
      targetFrames = fastFrames;
    } else {
      clock.t = 0;
      clock.frameNo = 0;
      targetFrames = wantFrames;
    }
    // immediately force LUT + terrain shadows + trees refresh for new time & camera
    env.update(0, clock.t, sky.ambient.sky);
    sky.renderLUT();
    sky.readAmbient();
    shadows.update(true);
    if (session.mode === 'title') session.titleCam(clock.t);
    else player.update(0.001, clock.t);
    trees.update(camera.position, true);
  }

  function startCaptureMode() {
    const fastN = params.get('fast') ? parseInt(params.get('fast')) : null;
    applyCaptureParams(params, fastN);
    $('loading').style.display = 'none';
    window.__applyShot = (queryStr, fast = 4) => {
      applyCaptureParams(new URLSearchParams(queryStr), fast);
    };
  }

  function checkShotReady(frameNo) {
    if (frameNo === targetFrames) {
      window.__shotReady = true;
      window.__info = {
        trailLength: trail.dist[trail.dist.length - 1],
        summit: props.summit,
        trees: trees.trees.length,
        rocks: rocks.items.length,
        nodes: terrain.geometry.instanceCount,
        hours: env.hours,
        exposure: env.exposure,
      };
    }
  }

  return {
    applyCaptureParams,
    startCaptureMode,
    checkShotReady,
  };
}
