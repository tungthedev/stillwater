import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createProtoAudio } from './protoAudio.js';
import { createProtoUI } from './protoUI.js';
import { createProtoCreek, getGlintTexture, makeGlintSprite } from './protoCreek.js';

// Pass 1 playable prototype coordinator ("Trailhead to Lake", 5 mending beats):
// 1. Trailhead signpost (hold ~1s -> straightens, boards rehang, moss puff, handwritten caption)
// 2. Cottage hearth (hold ~1.1s -> windows/porch glow, chimney smoke, crackle loop, radio wakes)
// 3. Pasture fence gap (pick up 2 rails -> carry viewmodel -> place in ghost slots -> 3 sheep trot over)
// 4. Trail lamps (touch-in-passing within 2.5m -> stay lit, rising pitch chime -> Maren radio)
// 5. Stream bridge (real creek blocker -> find 3 planks downstream within 60m -> place each -> bridge snaps whole -> lake jetty end card)

function colored(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = rgb[0];
    c[i * 3 + 1] = rgb[1];
    c[i * 3 + 2] = rgb[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function box(w, h, d, x, y, z, rgb, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return colored(g, rgb);
}

export function createProto({
  scene,
  camera,
  canvas,
  player,
  audio,
  session,
  input,
  env,
  data,
  world,
  creekPlan,
  snapCamera,
}) {
  const { hf, trail } = data;
  const { props, village } = world;
  const root = new THREE.Group();
  scene.add(root);

  const pAudio = createProtoAudio(audio);
  const pUI = createProtoUI({
    onKeepWalking: () => {
      session.suppressPause = false;
      if (session.mode === 'play') {
        session.setPaused(false);
        if (!input?.isTouch && !input?.isIOS && typeof canvas.requestPointerLock === 'function') {
          try {
            const res = canvas.requestPointerLock();
            if (res && typeof res.catch === 'function') res.catch(() => {});
          } catch {}
        }
      }
    },
    onRadioClick: () => pAudio.radioClick(),
  });

  // --- Shared particle puff pool (moss dust, wood chips, embers, lamp sparks) ---
  // Soft radial sprites rather than polygonal meshes so sparks/dust never read as hard discs.
  const puffs = [];
  const puffTex = (() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0.0, 'rgba(255, 255, 255, 0.9)');
    g.addColorStop(0.32, 'rgba(255, 255, 255, 0.42)');
    g.addColorStop(0.68, 'rgba(255, 255, 255, 0.09)');
    g.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  function spawnPuff(pos, { count = 14, color = 0x8ea862, speed = 1.6, rise = 1.4, size = 1.0, life = 0.9 } = {}) {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: puffTex,
          color,
          transparent: true,
          opacity: 0.62,
          depthWrite: false,
        }),
      );
      const a = Math.random() * Math.PI * 2;
      const r = 0.12 + Math.random() * 0.35;
      const baseScale = size * (0.10 + Math.random() * 0.10);
      m.position.set(pos.x + Math.cos(a) * r, pos.y + (Math.random() - 0.3) * 0.3, pos.z + Math.sin(a) * r);
      m.scale.setScalar(baseScale);
      root.add(m);
      puffs.push({
        mesh: m,
        baseScale,
        vx: Math.cos(a) * speed * (0.28 + Math.random() * 0.45),
        vy: rise * (0.35 + Math.random() * 0.55),
        vz: Math.sin(a) * speed * (0.28 + Math.random() * 0.45),
        age: 0,
        life: life * (0.55 + Math.random() * 0.35),
      });
    }
  }

  // --- 3D Carry Viewmodel (bottom-right of camera view, no inventory UI!) ---
  const carryGroup = new THREE.Group();
  camera.add(carryGroup);

  const carryRailGroup = new THREE.Group();
  {
    const rMesh = new THREE.Mesh(
      box(0.11, 0.09, 1.55, 0, 0, 0, [0.56, 0.38, 0.22]),
      village.mat,
    );
    const rMesh2 = new THREE.Mesh(
      box(0.10, 0.08, 1.5, 0.11, -0.05, 0.04, [0.48, 0.32, 0.18], 0.03, 0.04, 0),
      village.mat,
    );
    rMesh2.visible = false;
    carryRailGroup.add(rMesh, rMesh2);
    carryRailGroup.userData.second = rMesh2;
    carryRailGroup.position.set(0.36, -0.34, -0.78);
    carryRailGroup.rotation.set(0.18, -0.34, -0.08);
    carryRailGroup.visible = false;
  }
  carryGroup.add(carryRailGroup);

  const carryPlankGroup = new THREE.Group();
  {
    const mkPlankMesh = (yOff, zOff, col) =>
      new THREE.Mesh(box(0.42, 0.06, 1.38, 0, yOff, zOff, col), village.mat);
    const p1 = mkPlankMesh(0, 0, [0.60, 0.42, 0.24]);
    const p2 = mkPlankMesh(0.075, 0.03, [0.54, 0.37, 0.21]);
    const p3 = mkPlankMesh(0.15, 0.06, [0.62, 0.44, 0.26]);
    p2.visible = false;
    p3.visible = false;
    carryPlankGroup.add(p1, p2, p3);
    carryPlankGroup.userData.extras = [p2, p3];
    carryPlankGroup.position.set(0.38, -0.37, -0.82);
    carryPlankGroup.rotation.set(0.14, -0.26, -0.1);
    carryPlankGroup.visible = false;
  }
  carryGroup.add(carryPlankGroup);

  let carryKick = 0;
  let heldRails = 0;
  let heldPlanks = 0;

  function syncCarryView() {
    carryRailGroup.visible = heldRails > 0;
    carryRailGroup.userData.second.visible = heldRails >= 2;
    carryPlankGroup.visible = heldPlanks > 0 && heldRails === 0;
    carryPlankGroup.userData.extras[0].visible = heldPlanks >= 2;
    carryPlankGroup.userData.extras[1].visible = heldPlanks >= 3;
  }

  // --- BEAT 1: Trailhead Signpost (leaning, boards fallen on ground) ---
  const sp = props.signpostObj;
  let signpostFixed = false;
  let signpostAnim = 0; // 0 = broken, 1 = mended
  const spGlint = makeGlintSprite(0.9);
  const spFallenBoards = [];
  if (sp) {
    sp.postGroup.rotation.z = 0.28;
    sp.postGroup.rotation.x = 0.14;
    sp.boards.forEach((b, i) => {
      // Save upright local transforms, then place fallen on the grass/propped by the post base so they read clearly above grass!
      const origPos = b.mesh.position.clone();
      const origRot = b.mesh.rotation.clone();
      const presets = [
        { pos: new THREE.Vector3(0.55, 0.56, 0.42), rot: new THREE.Euler(0.62, 0.35, -0.42) },
        { pos: new THREE.Vector3(-0.78, 0.38, 0.62), rot: new THREE.Euler(1.18, -0.55, 0.22) },
        { pos: new THREE.Vector3(0.85, 0.36, -0.52), rot: new THREE.Euler(1.22, 0.85, -0.18) },
      ];
      const pr = presets[i % presets.length];
      const fallenPos = pr.pos.clone();
      const fallenRot = pr.rot.clone();
      b.mesh.position.copy(fallenPos);
      b.mesh.rotation.copy(fallenRot);
      spFallenBoards.push({ mesh: b.mesh, origPos, origRot, fallenPos, fallenRot });
    });
    spGlint.position.set(sp.x, sp.y + 1.15, sp.z);
    root.add(spGlint);
  }

  // --- BEAT 2: Cottage Hearth (porch kindling brazier + dark -> glowing cottage & chimney smoke) ---
  village.hearthLit = 0;
  let hearthFixed = false;
  let hearthAnim = 0;
  const house = village.house;
  const hFx = house.front[0], hFz = house.front[1];
  const hRx = -hFz, hRz = hFx;
  // Place hearth kindling stone brazier right beside the front door steps
  const hearthX = house.x + hFx * 7.2 - hRx * 2.1;
  const hearthZ = house.z + hFz * 7.2 - hRz * 2.1;
  const hearthY = hf.height(hearthX, hearthZ);
  const hearthGroup = new THREE.Group();
  hearthGroup.position.set(hearthX, hearthY, hearthZ);
  {
    const hp = [
      box(1.15, 0.56, 1.15, 0, 0.28, 0, [0.46, 0.42, 0.38]),
      box(1.26, 0.12, 1.26, 0, 0.58, 0, [0.36, 0.33, 0.30]),
      box(0.86, 0.16, 0.86, 0, 0.60, 0, [0.14, 0.12, 0.11]),
      // Crossed firewood logs waiting to be lit
      box(0.68, 0.13, 0.13, 0, 0.72, 0, [0.44, 0.28, 0.16], 0, 0.5, 0.16),
      box(0.66, 0.13, 0.13, 0, 0.75, 0, [0.38, 0.24, 0.13], 0, -0.65, -0.14),
      box(0.58, 0.11, 0.11, 0.06, 0.80, -0.04, [0.50, 0.33, 0.18], 0.1, 1.2, 0.08),
    ];
    const hm = new THREE.Mesh(mergeGeometries(hp), village.mat);
    hm.castShadow = true;
    hm.receiveShadow = true;
    hearthGroup.add(hm);
  }
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffae3a, transparent: true, opacity: 0.92 });
  const flameInnerMat = new THREE.MeshBasicMaterial({ color: 0xfff0a8, transparent: true, opacity: 0.95 });
  const flameOuter = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.68, 7), flameMat);
  flameOuter.position.set(0, 0.96, 0);
  flameOuter.visible = false;
  const flameInner = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.44, 6), flameInnerMat);
  flameInner.position.set(0, 0.88, 0);
  flameInner.visible = false;
  const hearthGlowSprite = makeGlintSprite(2.6);
  hearthGlowSprite.position.set(0, 1.08, 0);
  hearthGlowSprite.visible = false;
  const hearthCueGlint = makeGlintSprite(0.95);
  hearthCueGlint.position.set(0, 1.05, 0);
  hearthGroup.add(flameOuter, flameInner, hearthGlowSprite, hearthCueGlint);
  root.add(hearthGroup);

  // --- BEAT 3: Pasture Fence Gap + 2 Loose Rails + Trailhead Sheep Huddle ---
  const gap = village.fenceGap;
  let railsPlaced = 0;
  let fenceFixed = false;
  const fenceGhostRails = [];
  const fenceSolidRails = [];
  const looseRails = [];
  const fenceCenter = new THREE.Vector3();

  if (gap) {
    fenceCenter.set(gap.center.x, gap.center.y, gap.center.z);
    for (let i = 0; i < gap.rails.length; i++) {
      const r = gap.rails[i];
      const gGeo = new THREE.BoxGeometry(r.len + 0.2, 0.10, 0.08);
      gGeo.rotateZ(r.rz);
      gGeo.rotateY(r.ry);
      const gm = new THREE.Mesh(
        gGeo,
        new THREE.MeshBasicMaterial({ color: 0xffd58a, transparent: true, opacity: 0.28, depthWrite: false }),
      );
      gm.position.set(r.mx, r.my, r.mz);
      const gw = new THREE.LineSegments(
        new THREE.EdgesGeometry(gGeo),
        new THREE.LineBasicMaterial({ color: 0xffe4ad, transparent: true, opacity: 0.72 }),
      );
      gw.position.copy(gm.position);
      const gGrp = new THREE.Group();
      gGrp.add(gm, gw);
      root.add(gGrp);
      fenceGhostRails.push({ group: gGrp, fillMat: gm.material, wireMat: gw.material });

      const sGeo = new THREE.BoxGeometry(r.len + 0.22, 0.105, 0.085);
      sGeo.rotateZ(r.rz);
      sGeo.rotateY(r.ry);
      const sm = new THREE.Mesh(colored(sGeo, i === 0 ? [0.42, 0.27, 0.16] : [0.49, 0.32, 0.19]), village.mat);
      sm.position.set(r.mx, r.my, r.mz);
      sm.castShadow = true;
      sm.receiveShadow = true;
      sm.visible = false;
      root.add(sm);
      fenceSolidRails.push({ mesh: sm, anim: 0, baseY: r.my });
    }

    // Place 2 loose wooden rails lying in the grass nearby (clearly visible within 6-10 m!)
    const railOffsets = [
      { fwd: -4.8, lat: 3.8, yaw: 0.55 },
      { fwd: 6.2, lat: -5.4, yaw: -0.78 },
    ];
    for (let i = 0; i < 2; i++) {
      const ro = railOffsets[i];
      // Offset gently toward the trail/meadow side so they are easy to spot in the grass
      const rx = gap.center.x + gap.tx * ro.fwd + gap.nx * ro.lat;
      const rz = gap.center.z + gap.tz * ro.fwd + gap.nz * ro.lat;
      const ryH = hf.height(rx, rz);
      const rGrp = new THREE.Group();
      const rm = new THREE.Mesh(box(2.55, 0.11, 0.09, 0, 0.07, 0, [0.54, 0.36, 0.21]), village.mat);
      rm.castShadow = true;
      rm.receiveShadow = true;
      const gl = makeGlintSprite(0.85);
      gl.position.set(0, 0.34, 0);
      rGrp.add(rm, gl);
      rGrp.position.set(rx, ryH + 0.03, rz);
      rGrp.rotation.y = gap.rails[0].ry + ro.yaw;
      rGrp.rotation.z = 0.05;
      root.add(rGrp);
      looseRails.push({
        id: `fence-rail-${i}`,
        index: i,
        x: rx,
        y: ryH + 0.15,
        z: rz,
        mesh: rGrp,
        glint: gl,
        collected: false,
      });
    }
  }

  // Sheep start huddled near the trailhead; when fence is fixed, 3 trot over to the pasture meadow!
  const migratingSheep = [];
  const trailheadSheepSpot = {
    x: trail.points[12][0] - 11.5,
    z: trail.points[12][1] - 4.0,
  };
  const pastureTargetSpot = gap
    ? { x: gap.center.x + gap.nx * 7.5 - gap.tx * 1.5, z: gap.center.z + gap.nz * 7.5 - gap.tz * 1.5 }
    : { x: house.x - 24, z: house.z - 22 };

  if (village.sheep && village.sheep.list.length >= 10) {
    // Move the first 5 sheep to huddle near the trailhead at start
    for (let i = 0; i < 5; i++) {
      const sh = village.sheep.list[i];
      const ang = (i / 5) * Math.PI * 2 + 0.4;
      const rad = 2.2 + (i % 2) * 1.4;
      sh.hx = trailheadSheepSpot.x;
      sh.hz = trailheadSheepSpot.z;
      sh.x = trailheadSheepSpot.x + Math.cos(ang) * rad;
      sh.z = trailheadSheepSpot.z + Math.sin(ang) * rad;
      sh.tx = sh.x;
      sh.tz = sh.z;
      sh.walking = false;
      sh.timer = 4 + i * 1.2;
      if (i < 3) migratingSheep.push(sh);
    }
    village.sheep.update(0.016, 0);
  }
  let sheepMigrating = false;

  // --- BEAT 4: Trail Lamps (6 lamps along the trailhead-to-bridge stretch, touch in passing!) ---
  const lamps = village.trailLamps || [];
  let lampsLitCount = 0;
  let allLampsDone = false;

  // --- BEAT 5: Valley Creek & Broken Stream Bridge ---
  const creek = createProtoCreek({ scene, hf, material: village.mat, creekPlan });
  let bridgeSeenRadio = false;
  let bridgeFixed = false;

  // --- Jetty End Trigger ---
  const jetty = props.jettyInfo || null;
  let jettyReached = false;
  let endCardDelay = -1;
  let startPlayTime = null;

  // --- Interaction state ---
  let focused = null;
  let holdTargetId = null;
  let holdElapsed = 0;
  let holdTickAccum = 0;
  let interactConsumedThisEvent = false;

  const interactBtn = session.addTouchActionButton({
    id: 'btnInteract',
    label: 'Use',
    action: 'interact',
    tap: true,
    hold: true,
    visible: false,
  });

  function computeFocus() {
    if (!player.enabled || session.paused || pUI.endCardVisible) return null;
    const camPos = camera.position;
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const candidates = [];

    const tryAdd = (id, pos, maxDist, maxCos, label, opts = {}) => {
      const to = new THREE.Vector3(pos.x - camPos.x, pos.y - camPos.y, pos.z - camPos.z);
      const dist = to.length();
      if (dist > maxDist) return;
      to.divideScalar(Math.max(dist, 1e-4));
      const dot = camDir.dot(to);
      if (dot < maxCos) return;
      // Score prefers centered targets and closer distance
      const score = dot * 2.4 - dist * 0.18 + (opts.priority || 0);
      candidates.push({ id, label, dist, dot, score, ...opts });
    };

    // 1. Signpost
    if (sp && !signpostFixed) {
      tryAdd('signpost', { x: sp.x, y: sp.y + 1.15, z: sp.z }, 3.8, 0.72, 'Straighten signpost', {
        isHold: true,
        holdDur: 1.0,
        keyHint: 'Hold E',
      });
    }

    // 2. Cottage hearth
    if (!hearthFixed) {
      tryAdd('hearth', { x: hearthX, y: hearthY + 0.85, z: hearthZ }, 3.8, 0.72, 'Lay & light the hearth', {
        isHold: true,
        holdDur: 1.1,
        keyHint: 'Hold E',
      });
    }

    // 3. Loose fence rails
    for (const r of looseRails) {
      if (r.collected) continue;
      tryAdd(r.id, r, 4.4, 0.68, 'Pick up fence rail', {
        isHold: false,
        keyHint: 'E',
        obj: r,
        kind: 'pickup-rail',
      });
    }

    // 3b. Fence gap (when carrying a rail)
    if (gap && !fenceFixed && heldRails > 0) {
      tryAdd('fence-gap', fenceCenter, 4.2, 0.68, `Set fence rail (${railsPlaced + 1}/2)`, {
        isHold: false,
        keyHint: 'E',
        priority: 0.2,
        kind: 'place-rail',
      });
    }

    // 5a. Washed-away bridge planks
    for (const pl of creek.planks) {
      if (pl.collected) continue;
      tryAdd(pl.id, pl, 4.6, 0.66, 'Pick up bridge plank', {
        isHold: false,
        keyHint: 'E',
        obj: pl,
        kind: 'pickup-plank',
      });
    }

    // 5b. Broken bridge deck slot (when carrying a plank)
    if (!bridgeFixed && heldPlanks > 0) {
      const bayPos = creek.getNextBayWorldPos();
      // Allow interacting from either the approach abutment OR looking at the next missing bay!
      const apDist = Math.hypot(camPos.x - creek.approachPos.x, camPos.z - creek.approachPos.z);
      const bayDist = Math.hypot(camPos.x - bayPos.x, camPos.z - bayPos.z);
      const targetPos = apDist < bayDist ? { x: (creek.approachPos.x + bayPos.x) * 0.5, y: creek.yDeck + 0.1, z: (creek.approachPos.z + bayPos.z) * 0.5 } : bayPos;
      tryAdd('bridge-slot', targetPos, 5.2, 0.62, `Lay bridge plank (${creek.placedCount + 1}/3)`, {
        isHold: false,
        keyHint: 'E',
        priority: 0.25,
        kind: 'place-plank',
      });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  function triggerInstantAction(target) {
    if (!target) return;
    if (target.kind === 'pickup-rail') {
      const r = target.obj;
      if (r.collected) return;
      r.collected = true;
      r.mesh.visible = false;
      heldRails++;
      carryKick = 1.0;
      syncCarryView();
      pAudio.pickupWood();
      spawnPuff(new THREE.Vector3(r.x, r.y + 0.1, r.z), { count: 8, color: 0xb69562, speed: 1.0, rise: 1.0, size: 0.7, life: 0.6 });
    } else if (target.kind === 'place-rail') {
      if (heldRails <= 0 || railsPlaced >= 2) return;
      const idx = railsPlaced;
      heldRails--;
      railsPlaced++;
      carryKick = 1.0;
      syncCarryView();
      fenceGhostRails[idx].group.visible = false;
      fenceSolidRails[idx].mesh.visible = true;
      fenceSolidRails[idx].anim = 1.0;
      pAudio.woodKnock(idx === 0 ? 0.94 : 1.15, true);
      spawnPuff(fenceCenter.clone().add(new THREE.Vector3(0, 0.5, 0)), { count: 14, color: 0xc9a973, speed: 1.4, rise: 1.2, size: 0.85, life: 0.75 });
      if (railsPlaced >= 2) {
        fenceFixed = true;
        pAudio.fenceComplete();
        // Send 3 sheep trotting over to the meadow beside the mended fence!
        sheepMigrating = true;
        audio.bleat?.(0.95);
        setTimeout(() => audio.bleat?.(0.75), 550);
        migratingSheep.forEach((sh, i) => {
          const ang = i * 2.1 + 0.3;
          const r = 2.6 + i * 1.1;
          sh.hx = pastureTargetSpot.x + Math.cos(ang) * r;
          sh.hz = pastureTargetSpot.z + Math.sin(ang) * r;
          sh.tx = sh.hx;
          sh.tz = sh.hz;
          sh.walking = true;
          sh.timer = 60;
        });
        pUI.queueRadio('Bram will be pleased. His sheep are already eating my boots down here.', {
          immediate: true,
          onStart: () => pAudio.radioSquelch(),
        });
      }
    } else if (target.kind === 'pickup-plank') {
      const pl = target.obj;
      if (pl.collected) return;
      pl.collected = true;
      pl.mesh.visible = false;
      heldPlanks++;
      carryKick = 1.0;
      syncCarryView();
      pAudio.woodKnock(1.24, false);
      spawnPuff(new THREE.Vector3(pl.x, pl.y + 0.1, pl.z), { count: 10, color: 0xc29c68, speed: 1.2, rise: 1.1, size: 0.8, life: 0.65 });
    } else if (target.kind === 'place-plank') {
      if (heldPlanks <= 0 || bridgeFixed) return;
      const bayIndex = creek.placedCount;
      heldPlanks--;
      carryKick = 1.0;
      syncCarryView();
      const res = creek.placeNextPlank();
      pAudio.bridgePlank(bayIndex);
      spawnPuff(res.bayWorldPos, { count: 18, color: 0xd0a96e, speed: 1.8, rise: 1.5, size: 1.0, life: 0.85 });
      if (res.completed) {
        bridgeFixed = true;
        pAudio.bridgeComplete();
        spawnPuff(creek.bridgeCenter.clone().add(new THREE.Vector3(0, 0.6, 0)), { count: 28, color: 0xffe2a4, speed: 2.6, rise: 2.0, size: 1.15, life: 1.1 });
        pUI.queueRadio("That's the crossing. The lake is just ahead. Tell me the boat survived.", {
          immediate: true,
          onStart: () => pAudio.radioSquelch(),
        });
      }
    }
  }

  function completeHoldAction(id) {
    if (id === 'signpost' && !signpostFixed) {
      signpostFixed = true;
      spGlint.visible = false;
      pAudio.signpostFixed();
      if (sp) {
        spawnPuff(new THREE.Vector3(sp.x, sp.y + 1.8, sp.z), { count: 22, color: 0x7c9c50, speed: 2.0, rise: 1.7, size: 1.05, life: 1.0 });
      }
      pUI.showCaption('Stillwater Lake · 1.1 km — the boards still remember the way.', 4.8);
    } else if (id === 'hearth' && !hearthFixed) {
      hearthFixed = true;
      hearthCueGlint.visible = false;
      flameOuter.visible = true;
      flameInner.visible = true;
      hearthGlowSprite.visible = true;
      pAudio.hearthIgnite();
      spawnPuff(new THREE.Vector3(hearthX, hearthY + 0.9, hearthZ), { count: 22, color: 0xffb347, speed: 1.6, rise: 2.4, size: 0.9, life: 1.05 });
      pUI.queueRadio("There's my smoke. Good. So someone did go up this year.", {
        delayMs: 800,
        onStart: () => pAudio.radioSquelch(),
      });
      pUI.queueRadio('Bad news first: the creek took the bridge again. See what winter left of it.', {
        delayMs: 4800,
        onStart: () => pAudio.radioSquelch(),
      });
    }
  }

  // --- Unified input bindings: 'interact' action (KeyE, LMB while locked, and touch button) ---
  function startHoldOn(f) {
    holdTargetId = f.id;
    holdElapsed = 0;
    holdTickAccum = 0;
    pAudio.holdTick(0);
  }

  function handleInteractPress() {
    if (!player.enabled || session.paused || pUI.endCardVisible) return false;
    const f = focused || computeFocus();
    if (!f) return false;
    interactConsumedThisEvent = true;
    queueMicrotask(() => { interactConsumedThisEvent = false; });
    if (f.isHold) {
      startHoldOn(f);
    } else {
      triggerInstantAction(f);
    }
    return true;
  }

  function endInteract() {
    holdTargetId = null;
    holdElapsed = 0;
  }

  const offInteractAction = input.onAction('interact', () => {
    handleInteractPress();
  });
  const offInteractPress = input.onPress('interact', () => {
    if (holdTargetId || !player.enabled || session.paused || pUI.endCardVisible) return;
    const f = focused || computeFocus();
    if (f && f.isHold) startHoldOn(f);
  });
  const offInteractRelease = input.onRelease('interact', () => {
    endInteract();
  });

  // Hook into Player's 'sit' action so desktop KeyE only sits when 'interact' did not consume it,
  // while the touch Sit button always sits directly.
  player.onInteractKey = () => {
    if (interactConsumedThisEvent) {
      interactConsumedThisEvent = false;
      return true;
    }
    return false;
  };

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    if (input.isTouch) return;
    if (!player.enabled || session.paused || pUI.endCardVisible) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('button, a, input, select, textarea, [data-ui-control], #debug, #paused, #proto-end')) return;
    // Left mouse button interacts while pointer is locked (or in headless webdriver where pointerLock is a no-op)
    if (player.locked || navigator.webdriver) {
      const f = focused || computeFocus();
      if (!f) return;
      input.trigger('interact');
      input.setHold('interact', true, 'mouse');
    }
  };
  const onMouseUp = (e) => {
    if (e.button === 0) input.setHold('interact', false, 'mouse');
  };
  const onBlur = () => {
    input.setHold('interact', false, 'mouse');
    endInteract();
  };
  const onKeyDownEnd = (e) => {
    if (pUI.endCardVisible && (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape')) {
      pUI.hideEndCard();
      session.suppressPause = false;
      session.setPaused(false);
    }
  };
  addEventListener('mousedown', onMouseDown);
  addEventListener('mouseup', onMouseUp);
  addEventListener('blur', onBlur);
  addEventListener('keydown', onKeyDownEnd);

  // --- Collision & walkable surfaces (bridge deck + lake jetty deck!) ---
  function collide(pos, radius = 0.35) {
    creek.collide(pos, radius);
  }

  function groundY(x, z, curG) {
    let g = creek.groundY(x, z, curG);
    // Walkable lake jetty deck
    if (jetty) {
      const dx = x - jetty.startX, dz = z - jetty.startZ;
      const along = dx * jetty.fwx + dz * jetty.fwz;
      const side = dx * jetty.rx + dz * jetty.rz;
      if (along > -3.5 && along < jetty.len + 1.0 && Math.abs(side) < jetty.w * 0.65) {
        g = Math.max(g, jetty.deckY);
      }
    }
    return g;
  }

  // --- Per-frame update ---
  function update(dt, t) {
    if (session.mode === 'play' && startPlayTime === null) {
      startPlayTime = performance.now();
    }
    pUI.setReticleVisible(session.mode === 'play' && !session.paused && !pUI.endCardVisible);

    // 1. Update focus + hold progress
    focused = computeFocus();
    const holding = input.isHeld('interact');
    if (holding && holdTargetId) {
      if (!focused || focused.id !== holdTargetId) {
        endInteract();
      } else {
        holdElapsed += dt;
        holdTickAccum += dt;
        const p = Math.min(1, holdElapsed / focused.holdDur);
        if (holdTickAccum >= 0.24) {
          holdTickAccum = 0;
          pAudio.holdTick(p);
        }
        if (holdElapsed >= focused.holdDur) {
          const doneId = holdTargetId;
          endInteract();
          completeHoldAction(doneId);
          focused = computeFocus();
        }
      }
    } else if (!holding && holdTargetId) {
      endInteract();
    }
    if (focused) {
      const isHoldingFocused = holding && holdTargetId === focused.id;
      pUI.setFocus({
        label: focused.label,
        keyHint: input.isTouch ? (focused.isHold ? 'Hold' : 'Tap') : focused.keyHint,
        isHold: focused.isHold,
        holdProgress: isHoldingFocused ? holdElapsed / focused.holdDur : 0,
      });
      interactBtn.setVisible(true);
      interactBtn.setLabel(focused.label);
      interactBtn.setHint(true);
      interactBtn.setActive(isHoldingFocused);
    } else {
      pUI.setFocus(null);
      interactBtn.setVisible(false);
      interactBtn.setHint(false);
      interactBtn.setActive(false);
    }

    // 2. Signpost animation & subtle glint
    if (sp) {
      if (signpostFixed && signpostAnim < 1) {
        signpostAnim = Math.min(1, signpostAnim + dt * 2.4);
        const e = 1 - Math.pow(1 - signpostAnim, 3);
        sp.postGroup.rotation.z = 0.28 * (1 - e);
        sp.postGroup.rotation.x = 0.14 * (1 - e);
        spFallenBoards.forEach((b) => {
          b.mesh.position.lerpVectors(b.fallenPos, b.origPos, e);
          b.mesh.rotation.set(
            b.fallenRot.x + (b.origRot.x - b.fallenRot.x) * e,
            b.fallenRot.y + (b.origRot.y - b.fallenRot.y) * e,
            b.fallenRot.z + (b.origRot.z - b.fallenRot.z) * e,
          );
        });
      } else if (!signpostFixed) {
        // Subtle lift tremble while holding!
        const lift = holding && holdTargetId === 'signpost' ? holdElapsed / 1.0 : 0;
        const shake = lift > 0 ? Math.sin(t * 36) * 0.018 * lift : 0;
        sp.postGroup.rotation.z = 0.28 * (1 - lift * 0.35) + shake;
        sp.postGroup.rotation.x = 0.14 * (1 - lift * 0.35);
        const s = 0.72 + 0.3 * Math.sin(t * 2.5);
        spGlint.scale.setScalar(s);
        spGlint.material.opacity = 0.34 + 0.24 * Math.sin(t * 2.5);
      }
    }

    // 3. Cottage hearth glow, flame flicker & spatial crackle
    if (hearthFixed) {
      hearthAnim = Math.min(1, hearthAnim + dt * 1.4);
      village.hearthLit = hearthAnim;
      const flick = 0.88 + 0.18 * Math.sin(t * 14.3) + 0.10 * Math.sin(t * 23.7);
      flameOuter.scale.set(0.95 + 0.08 * Math.sin(t * 11), flick * hearthAnim, 0.95 + 0.08 * Math.cos(t * 13));
      flameInner.scale.set(0.9, (0.85 + 0.22 * Math.cos(t * 19)) * hearthAnim, 0.9);
      hearthGlowSprite.scale.setScalar(2.4 + 0.35 * Math.sin(t * 9.5));
      hearthGlowSprite.material.opacity = 0.55 * hearthAnim;
      const distHouse = Math.hypot(player.pos.x - hearthX, player.pos.z - hearthZ);
      pAudio.updateHearth(dt, distHouse, hearthAnim);
    } else {
      const s = 0.75 + 0.32 * Math.sin(t * 2.4 + 1.1);
      hearthCueGlint.scale.setScalar(s);
      hearthCueGlint.material.opacity = 0.36 + 0.25 * Math.sin(t * 2.4 + 1.1);
    }

    // 4. Fence rails ghost pulse, settle & sheep migration
    for (let i = 0; i < fenceGhostRails.length; i++) {
      if (!fenceGhostRails[i].group.visible) continue;
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.8 + i * 1.2);
      const boost = heldRails > 0 && i === railsPlaced ? 1.8 : 1.0;
      fenceGhostRails[i].fillMat.opacity = (0.14 + pulse * 0.15) * boost;
      fenceGhostRails[i].wireMat.opacity = Math.min(0.95, (0.42 + pulse * 0.28) * boost);
    }
    for (const sr of fenceSolidRails) {
      if (sr.anim > 0) {
        sr.anim = Math.max(0, sr.anim - dt * 5.5);
        sr.mesh.position.y = sr.baseY + sr.anim * sr.anim * 0.25;
      }
    }
    for (let i = 0; i < looseRails.length; i++) {
      const r = looseRails[i];
      if (r.collected) continue;
      const s = 0.7 + 0.32 * Math.sin(t * 2.7 + i * 2.1);
      r.glint.scale.setScalar(s);
      r.glint.material.opacity = 0.36 + 0.26 * Math.sin(t * 2.7 + i * 2.1);
    }
    if (sheepMigrating) {
      // Gently boost migrating sheep trot toward the pasture meadow so the player visibly watches them arrive!
      let anyFar = false;
      for (const sh of migratingSheep) {
        const dx = sh.hx - sh.x, dz = sh.hz - sh.z;
        const d = Math.hypot(dx, dz);
        if (d > 2.2) {
          anyFar = true;
          const spd = d > 18 ? 14.0 : 4.2;
          const step = Math.min(d, dt * spd);
          sh.x += (dx / d) * step;
          sh.z += (dz / d) * step;
          sh.yaw = Math.atan2(dx, dz);
          sh.tx = sh.hx;
          sh.tz = sh.hz;
          sh.walking = true;
          sh.timer = 12;
        }
      }
      if (!anyFar) sheepMigrating = false;
    }

    // 5. Trail lamps: touch-in-passing (walk within 2.6 m, no key press!)
    if (session.mode === 'play' && player.enabled) {
      for (let i = 0; i < lamps.length; i++) {
        const lm = lamps[i];
        if (!lm.lit) {
          const d = Math.hypot(player.pos.x - lm.x, player.pos.z - lm.z);
          if (d < 2.65) {
            lm.lit = true;
            lampsLitCount++;
            pAudio.lampChime(lampsLitCount - 1);
            spawnPuff(new THREE.Vector3(lm.gx, lm.gy, lm.gz), { count: 14, color: 0xffd27a, speed: 1.3, rise: 1.8, size: 0.75, life: 0.85 });
            if (lampsLitCount >= lamps.length && !allLampsDone) {
              allLampsDone = true;
              pUI.queueRadio('I can count your lamps from the gatehouse. Keep going.', {
                immediate: true,
                onStart: () => pAudio.radioSquelch(),
              });
            }
          }
        }
      }
    }

    // 6. Stream bridge approach radio + creek animations
    creek.update(dt, t, heldPlanks > 0);
    if (!bridgeSeenRadio && !bridgeFixed && session.mode === 'play' && player.enabled) {
      const dBridge = Math.hypot(player.pos.x - creek.bridgeCenter.x, player.pos.z - creek.bridgeCenter.z);
      if (dBridge < 16) {
        bridgeSeenRadio = true;
        pUI.queueRadio('Three planks, usually. They never go far. Look downstream.', {
          immediate: true,
          onStart: () => pAudio.radioSquelch(),
        });
      }
    }

    // 7. Jetty arrival -> final radio line + End Card
    if (!jettyReached && jetty && session.mode === 'play' && player.enabled) {
      const dStart = Math.hypot(player.pos.x - jetty.startX, player.pos.z - jetty.startZ);
      const dMid = Math.hypot(player.pos.x - jetty.midX, player.pos.z - jetty.midZ);
      if (dStart < 12 || dMid < 18) {
        jettyReached = true;
        pUI.queueRadio('There she is. Oars are another story. Rest a minute, Opener.', {
          immediate: true,
          onStart: () => pAudio.radioSquelch(),
        });
        endCardDelay = 2.0;
      }
    }
    if (endCardDelay > 0) {
      endCardDelay -= dt;
      if (endCardDelay <= 0) {
        const elapsedSec = startPlayTime ? (performance.now() - startPlayTime) / 1000 : 0;
        input.clear();
        session.suppressPause = true;
        session.setPaused(false);
        pUI.showEndCard({
          elapsedSec,
          items: [
            { name: 'Trailhead signpost', done: signpostFixed, detail: signpostFixed ? 'mended' : 'unmended' },
            { name: 'Cottage hearth', done: hearthFixed, detail: hearthFixed ? 'lit' : 'cold' },
            { name: 'Pasture fence', done: fenceFixed, detail: `${railsPlaced}/2 rails` },
            { name: 'Trail lamps', done: allLampsDone, detail: `${lampsLitCount}/${lamps.length} lit` },
            { name: 'Stream bridge', done: bridgeFixed, detail: `${creek.placedCount}/3 planks` },
          ],
        });
        if (document.pointerLockElement === canvas) {
          document.exitPointerLock?.();
        }
      }
    }

    // 8. Carry viewmodel bob + kick
    if (carryKick > 0) carryKick = Math.max(0, carryKick - dt * 5.0);
    const swayX = Math.sin(player.bob) * 0.016 * player.moving;
    const swayY = Math.abs(Math.cos(player.bob)) * 0.018 * player.moving;
    carryGroup.position.set(swayX, -swayY - carryKick * 0.06, carryKick * 0.05);

    // 9. Particle puffs update
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.mesh.removeFromParent();
        p.mesh.material.dispose();
        puffs.splice(i, 1);
        continue;
      }
      const f = p.age / p.life;
      p.vy -= 2.2 * dt;
      p.mesh.position.x += p.vx * dt * (1 - f * 0.5);
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt * (1 - f * 0.5);
      p.mesh.scale.setScalar(p.baseScale * (1 - f * 0.65));
      p.mesh.material.opacity = (1 - f) * (1 - f) * 0.62;
    }

    pUI.update(dt);
  }

  // --- Debug / automation interface on window.__proto (never triggers actions directly; only reads & moves/aims!) ---
  const protoApi = {
    state: () => ({
      mode: session.mode,
      paused: session.paused,
      playerEnabled: player.enabled,
      hours: env.hours,
      pos: { x: player.pos.x, y: player.eyeY, z: player.pos.z },
      yaw: player.yaw,
      pitch: player.pitch,
      focused: focused ? { id: focused.id, label: focused.label, isHold: !!focused.isHold } : null,
      interactBtn: { visible: !interactBtn.el.hidden, label: interactBtn.el.textContent || '' },
      heldRails,
      heldPlanks,
      signpostFixed,
      hearthFixed,
      hearthLit: village.hearthLit,
      railsPlaced,
      fenceFixed,
      lampsLitCount,
      lampsTotal: lamps.length,
      allLampsDone,
      bridgePlaced: creek.placedCount,
      bridgeFixed,
      jettyReached,
      ui: pUI.getState(),
    }),
    sites: () => ({
      signpost: sp ? { x: sp.x, y: sp.y, z: sp.z, ry: sp.ry } : null,
      hearth: { x: hearthX, y: hearthY, z: hearthZ, houseX: house.x, houseZ: house.z, front: house.front },
      fenceGap: gap ? { x: gap.center.x, y: gap.center.y, z: gap.center.z, nx: gap.nx, nz: gap.nz } : null,
      looseRails: looseRails.map((r) => ({ id: r.id, x: r.x, y: r.y, z: r.z, collected: r.collected })),
      lamps: lamps.map((l, i) => ({ index: i, x: l.x, y: l.y, z: l.z, gx: l.gx, gy: l.gy, gz: l.gz, lit: l.lit })),
      bridge: {
        x: creek.bridgeCenter.x,
        y: creek.bridgeCenter.y,
        z: creek.bridgeCenter.z,
        approachX: creek.approachPos.x,
        approachZ: creek.approachPos.z,
        ux: creek.ux,
        uz: creek.uz,
        downX: creek.downX,
        downZ: creek.downZ,
      },
      planks: creek.planks.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, distFromBridge: p.distFromBridge, collected: p.collected })),
      jetty: jetty ? { startX: jetty.startX, startZ: jetty.startZ, midX: jetty.midX, midZ: jetty.midZ, endX: jetty.endX, endZ: jetty.endZ, deckY: jetty.deckY } : null,
      sheepSample: village.sheep.list.slice(0, 5).map((s) => ({ x: s.x, z: s.z, hx: s.hx, hz: s.hz })),
    }),
    teleport: (x, z, yaw, pitch = -0.08) => {
      player.sitting = null;
      player.sitBlend = 0;
      player.autoWalk = false;
      player.vel.set(0, 0, 0);
      player.pos.set(x, 0, z);
      const g = groundY(x, z, hf.height(x, z));
      player.eyeY = g + 1.68;
      if (typeof yaw === 'number') {
        player.yaw = player.yawT = yaw;
      }
      if (typeof pitch === 'number') {
        player.pitch = player.pitchT = pitch;
      }
      camera.position.set(x, player.eyeY, z);
      camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
      camera.updateMatrixWorld();
      snapCamera?.();
    },
    lookAt: (tx, ty, tz) => {
      const dx = tx - player.pos.x;
      const dy = ty - player.eyeY;
      const dz = tz - player.pos.z;
      const horiz = Math.hypot(dx, dz) || 1e-4;
      player.yaw = player.yawT = Math.atan2(-dx, -dz);
      player.pitch = player.pitchT = Math.max(-1.4, Math.min(1.4, Math.atan2(dy, horiz)));
      camera.position.set(player.pos.x, player.eyeY, player.pos.z);
      camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
      camera.updateMatrixWorld();
      snapCamera?.();
    },
  };
  /** @type {any} */ (window).__proto = protoApi;

  function dispose() {
    offInteractAction();
    offInteractPress();
    offInteractRelease();
    interactBtn.remove();
    removeEventListener('mousedown', onMouseDown);
    removeEventListener('mouseup', onMouseUp);
    removeEventListener('blur', onBlur);
    removeEventListener('keydown', onKeyDownEnd);
    player.onInteractKey = null;
    carryGroup.removeFromParent();
    creek.dispose();
    pAudio.dispose();
    pUI.dispose();
    root.removeFromParent();
    puffs.length = 0;
    const glintTex = getGlintTexture();
    root.traverse((o) => {
      const obj = /** @type {any} */ (o);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && obj.material !== village.mat) {
        if (obj.material.map && obj.material.map !== glintTex && obj.material.map !== puffTex) {
          obj.material.map.dispose();
        }
        obj.material.dispose();
      }
    });
    puffTex.dispose();
  }

  return {
    update,
    collide,
    groundY,
    creek,
    api: protoApi,
    dispose,
  };
}
