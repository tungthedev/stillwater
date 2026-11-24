import * as THREE from 'three';
import { WORLD } from './config.js';

const EYE = 1.68;
const ZERO_MOVE = { x: 0, y: 0 };

export class Player {
  constructor(camera, world, audio, input = null) {
    this.camera = camera;
    this.world = world; // { hf, trees, rocks, props, trail }
    this.audio = audio;
    this.input = input;
    this.pos = new THREE.Vector3(WORLD.start.x, 0, WORLD.start.z);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.yawT = 0; this.pitchT = 0;
    this.roll = 0;
    this.eyeY = 0;
    this.bob = 0;
    this.lastStepSign = 1;
    this.locked = false;
    this.enabled = false;
    this.sitting = null; // bench or ground seat
    this.sitBlend = 0;
    this.autoWalk = false;
    this.lastMouse = -10;
    this.distance = 0;
    this.climb = 0;
    this.lastY = null;
    this.moving = 0;
    this.speedNow = 0;
    this.surface = 'grass';
    this.t = 0;
    this.trailIdx = 0;
    this.onInteractKey = null;
    this._unsubs = [];
    this._bindInput();
  }

  _bindInput() {
    if (!this.input) return;
    this._unsubs.push(
      this.input.onAction('autoWalk', () => {
        if (!this.enabled) return;
        this.autoWalk = !this.autoWalk;
        const hint = this.input.isTouch ? 'Following the trail · tap Trail to stop' : 'Following the trail · Q to stop';
        this.onToast?.(this.autoWalk ? hint : 'Free walking');
      }),
      this.input.onAction('sit', () => {
        if (!this.enabled) return;
        if (this.onInteractKey?.()) return;
        this.toggleSit();
      }),
    );
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }

  placeAtStart() {
    const pts = this.world.trail.points;
    const [x, z] = pts[2];
    const [x2, z2] = pts[14];
    this.pos.set(x, 0, z);
    this.yaw = this.yawT = Math.atan2(-(x2 - x), -(z2 - z));
    this.pitch = this.pitchT = -0.02;
    this.eyeY = this.world.hf.height(x, z) + EYE;
  }

  nearestBench() {
    let best = null, bd = 1e9;
    for (const b of this.world.props.benches) {
      const d = Math.hypot(b.x - this.pos.x, b.z - this.pos.z);
      if (d < bd) { bd = d; best = b; }
    }
    return bd < 4 ? best : null;
  }

  toggleSit() {
    if (this.sitting) { this.sitting = null; this.onSit?.(false); return; }
    const b = this.nearestBench();
    const g = this.world.hf.height(this.pos.x, this.pos.z);
    if (b) {
      // seat faces direction ry: forward (sin ry, cos ry)
      this.sitting = { x: b.x, z: b.z, y: b.y + 0.72, yaw: Math.atan2(-Math.sin(b.ry), -Math.cos(b.ry)), bench: true, from: this.pos.clone() };
    } else {
      this.sitting = { x: this.pos.x, z: this.pos.z, y: g + 0.95, yaw: this.yaw, bench: false, from: this.pos.clone() };
    }
    this.yawT = this.sitting.yaw;
    this.pitchT = -0.05;
    this.onSit?.(true);
  }

  surfaceAt(x, z, g) {
    const hf = this.world.hf;
    if (g < WORLD.waterLevel - 0.05) return 'water';
    if (hf.isPath ? hf.isPath(x, z) : hf.trailAt(x, z) > 0.4) return 'gravel';
    if (g > 1500) return 'snow';
    const n = hf.normal(x, z, 1.5);
    if (n.y < 0.75) return 'rock';
    return 'grass';
  }

  update(dt, t) {
    this.t = t;
    const hf = this.world.hf;
    if (this.enabled && this.input) {
      const look = this.input.consumeLook();
      if (look.dx || look.dy) {
        this.yawT -= look.dx;
        this.pitchT = Math.max(-1.45, Math.min(1.45, this.pitchT - look.dy));
        this.lastMouse = this.t;
      }
    }
    // look smoothing
    const sm = 1 - Math.exp(-dt * 18);
    this.yaw += (this.yawT - this.yaw) * sm;
    this.pitch += (this.pitchT - this.pitch) * sm;

    const mv = (!this.sitting && this.enabled && this.input) ? this.input.getMove() : ZERO_MOVE;
    const fwd = mv.y;
    const side = mv.x;
    const moveMag = Math.min(1, Math.hypot(side, fwd));
    const jog = !!(this.enabled && this.input?.isHeld('stride'));
    let dirX = 0, dirZ = 0;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    if (this.autoWalk && !this.sitting && moveMag === 0) {
      // walk along the trail toward the summit
      const pts = this.world.trail.points;
      let bi = this.trailIdx, bd = 1e9;
      for (let i = Math.max(0, this.trailIdx - 40); i < Math.min(pts.length, this.trailIdx + 60); i++) {
        const d = (pts[i][0] - this.pos.x) ** 2 + (pts[i][1] - this.pos.z) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      if (bd > 400) { // far from trail: global search
        for (let i = 0; i < pts.length; i++) { const d = (pts[i][0] - this.pos.x) ** 2 + (pts[i][1] - this.pos.z) ** 2; if (d < bd) { bd = d; bi = i; } }
      }
      this.trailIdx = bi;
      const ti = Math.min(pts.length - 1, bi + 4);
      if (bi >= pts.length - 3) { this.autoWalk = false; this.onToast?.('You have reached the summit'); }
      const tx = pts[ti][0] - this.pos.x, tz = pts[ti][1] - this.pos.z;
      const l = Math.hypot(tx, tz) || 1;
      dirX = tx / l; dirZ = tz / l;
      // gently steer the view unless the player is looking around
      if (t - this.lastMouse > 3.5) {
        const desired = Math.atan2(-dirX, -dirZ);
        let d = desired - this.yawT;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.yawT += d * (1 - Math.exp(-dt * 1.2));
        this.pitchT += (-0.04 - this.pitchT) * (1 - Math.exp(-dt * 0.8));
      }
    } else if (moveMag > 0) {
      dirX = -sy * fwd + cy * side;
      dirZ = -cy * fwd - sy * side;
      const l = Math.hypot(dirX, dirZ) || 1; dirX /= l; dirZ /= l;
    }
    const g0 = hf.height(this.pos.x, this.pos.z);
    const analog = (this.autoWalk && !this.sitting && moveMag === 0) ? 1 : moveMag;
    let speed = (jog ? 4.6 : 2.1) * (analog || 1);
    const moving = (dirX || dirZ) ? 1 : 0;
    // terrain grade affects pace
    if (moving) {
      const ax = this.pos.x + dirX * 1.5, az = this.pos.z + dirZ * 1.5;
      const aheadRaw = hf.height(ax, az);
      const ahead = this.world.proto ? this.world.proto.groundY(ax, az, aheadRaw) : aheadRaw;
      const gCur = this.world.proto ? this.world.proto.groundY(this.pos.x, this.pos.z, g0) : g0;
      const grade = (ahead - gCur) / 1.5;
      speed *= Math.max(0.42, Math.min(1.15, 1 - grade * 1.3));
      if (grade > 0.95) speed = 0; // too steep to climb
      if (ahead < WORLD.waterLevel - 0.85) speed = 0; // don't wade into deep water
      if (gCur < WORLD.waterLevel) speed *= 0.55;
    }
    const target = new THREE.Vector3(dirX * speed, 0, dirZ * speed);
    const acc = moving ? 6 : 8;
    this.vel.lerp(target, 1 - Math.exp(-dt * acc));
    if (!this.sitting) {
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      // collisions
      this.world.trees.collide(this.pos, 0.35);
      this.world.rocks.collide(this.pos, g0, 0.35);
      this.world.props.collide(this.pos, 0.3);
      this.world.village?.collide(this.pos, 0.3);
      this.world.proto?.collide(this.pos, 0.35);
      // soft world boundary
      const B = WORLD.boundary;
      const e = Math.max(Math.abs(this.pos.x), Math.abs(this.pos.z));
      if (e > B) { const f = B / e; this.pos.x *= f; this.pos.z *= f; if (!this._warned) { this._warned = true; this.onToast?.('The mountains turn you gently back'); setTimeout(() => (this._warned = false), 8000); } }
    }
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.speedNow = sp;
    this.moving = sp > 0.3 ? 1 : 0;
    this.distance += sp * dt;
    let g = hf.height(this.pos.x, this.pos.z);
    const br = this.world.bridge;
    if (br && Math.hypot(this.pos.x - br.x, this.pos.z - br.z) < 4.6) g = Math.max(g, br.y - 0.1);
    if (this.world.proto) g = this.world.proto.groundY(this.pos.x, this.pos.z, g);
    if (this.lastY !== null && g > this.lastY) this.climb += g - this.lastY;
    this.lastY = g;
    this.surface = this.surfaceAt(this.pos.x, this.pos.z, g);

    // head bob & footsteps
    const stride = jog ? 1.25 : 0.78;
    this.bob += sp * dt / stride * Math.PI;
    const bobAmp = Math.min(1, sp / 2.0) * (jog ? 0.055 : 0.035);
    const s2 = Math.sin(this.bob * 2);
    const bobY = -Math.abs(Math.sin(this.bob)) * bobAmp * 1.4 + bobAmp * 0.7;
    const bobX = Math.sin(this.bob) * bobAmp * 0.6;
    const stepSign = Math.sign(Math.sin(this.bob));
    if (stepSign !== this.lastStepSign && sp > 0.5) {
      this.audio.footstep(this.surface, Math.min(1.2, sp / 2.2));
      if (this.surface === 'water' && Math.random() < 0.5) this.audio.splash(0.6);
    }
    this.lastStepSign = stepSign;
    // breathing when idle
    const breath = Math.sin(t * 1.6) * 0.008 * (1 - Math.min(1, sp));

    // smooth eye height to soften terrain steps
    const eyeTarget = g + EYE + Math.max(0, WORLD.waterLevel - g) * 0.0;
    this.eyeY += (eyeTarget - this.eyeY) * (1 - Math.exp(-dt * 12));
    if (Math.abs(eyeTarget - this.eyeY) > 3) this.eyeY = eyeTarget;

    // sitting blend
    this.sitBlend += ((this.sitting ? 1 : 0) - this.sitBlend) * (1 - Math.exp(-dt * 2.2));
    let px = this.pos.x, py = this.eyeY + bobY + breath, pz = this.pos.z;
    if (this.sitting || this.sitBlend > 0.001) {
      const s = this.sitting || this._lastSit;
      if (s) {
        this._lastSit = s;
        const b = this.sitBlend;
        px = px + (s.x - px) * b; pz = pz + (s.z - pz) * b; py = py + (s.y - py) * b;
        if (this.sitting) { this.pos.x += (s.x - this.pos.x) * 0.02; this.pos.z += (s.z - this.pos.z) * 0.02; }
      }
    }
    // strafe/turn lean
    const turnRate = (this.yawT - this.yaw);
    const rollT = -side * 0.012 - turnRate * 0.05;
    this.roll += (rollT - this.roll) * (1 - Math.exp(-dt * 4));

    const cam = this.camera;
    cam.position.set(px + Math.cos(this.yaw) * bobX, py, pz - Math.sin(this.yaw) * bobX);
    cam.rotation.set(this.pitch + bobY * 0.15, this.yaw, this.roll, 'YXZ');
    cam.updateMatrixWorld();
  }
}
