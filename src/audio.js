// Fully procedural soundscape: wind, lake lapping, birdsong, crickets, owls,
// surface-aware footsteps, and a slow generative ambient score.

function noiseBuffer(ctx, seconds, type = 'white') {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else if (type === 'pink') { b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056; d[i] = (b0 + b1 + b2 + w * 0.05) * 0.9; }
      else d[i] = w;
    }
  }
  return buf;
}

function impulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 40 ? i / 40 : 1);
    }
  }
  return buf;
}

const SCALE = [0, 2, 4, 7, 9, 11, 14, 16, 19, 21]; // lydian-ish pentatonic colours
const CHORDS = [
  [50, 57, 62, 66, 69], // D maj9 colour
  [47, 54, 59, 62, 66], // Bm
  [43, 50, 55, 59, 62, 69], // G maj7
  [45, 52, 57, 61, 64], // A
  [48, 55, 59, 64, 67], // Cmaj7 (modal)
];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.musicOn = true;
    this.state = { wind: 0.5, altitude: 0, lake: 0, day: 1, dusk: 0, night: 0, moving: 0, sitting: 0, swell: 0 };
  }

  start() {
    if (this.started) { this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.started = true;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.02; comp.release.value = 0.4;
    this.master = ctx.createGain(); this.master.gain.value = 0;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 4);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = impulse(ctx, 4.5, 3.2);
    this.revGain = ctx.createGain(); this.revGain.gain.value = 0.5;
    this.reverb.connect(this.revGain); this.revGain.connect(this.master);
    this.white = noiseBuffer(ctx, 2, 'white');
    this.pink = noiseBuffer(ctx, 6, 'pink');
    this.brown = noiseBuffer(ctx, 6, 'brown');

    // wind: two bands, slowly modulated
    const mkLoop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(ctx.currentTime + Math.random()); return s; };
    this.windLow = ctx.createBiquadFilter(); this.windLow.type = 'lowpass'; this.windLow.frequency.value = 380;
    this.windHigh = ctx.createBiquadFilter(); this.windHigh.type = 'bandpass'; this.windHigh.frequency.value = 900; this.windHigh.Q.value = 0.7;
    this.windGainL = ctx.createGain(); this.windGainL.gain.value = 0;
    this.windGainH = ctx.createGain(); this.windGainH.gain.value = 0;
    mkLoop(this.brown).connect(this.windLow); this.windLow.connect(this.windGainL); this.windGainL.connect(this.master);
    mkLoop(this.pink).connect(this.windHigh); this.windHigh.connect(this.windGainH); this.windGainH.connect(this.master);
    // leaves / grass rustle
    this.rustleF = ctx.createBiquadFilter(); this.rustleF.type = 'highpass'; this.rustleF.frequency.value = 3500;
    this.rustleG = ctx.createGain(); this.rustleG.gain.value = 0;
    mkLoop(this.white).connect(this.rustleF); this.rustleF.connect(this.rustleG); this.rustleG.connect(this.master);
    // lake lapping
    this.lakeF = ctx.createBiquadFilter(); this.lakeF.type = 'lowpass'; this.lakeF.frequency.value = 700;
    this.lakeG = ctx.createGain(); this.lakeG.gain.value = 0;
    this.lakeLfo = ctx.createGain(); this.lakeLfo.gain.value = 0;
    mkLoop(this.pink).connect(this.lakeF); this.lakeF.connect(this.lakeG); this.lakeG.connect(this.master);
    // stream babble
    this.streamF = ctx.createBiquadFilter(); this.streamF.type = 'bandpass'; this.streamF.frequency.value = 1300; this.streamF.Q.value = 0.5;
    this.streamG = ctx.createGain(); this.streamG.gain.value = 0;
    mkLoop(this.white).connect(this.streamF); this.streamF.connect(this.streamG); this.streamG.connect(this.master);
    // crickets
    this.crickets = ctx.createGain(); this.crickets.gain.value = 0;
    this.crickets.connect(this.master); this.crickets.connect(this.reverb);
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 4200 + i * 330;
      const am = ctx.createGain(); am.gain.value = 0;
      const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 26 + i * 3.3;
      const lfoG = ctx.createGain(); lfoG.gain.value = 0.5;
      const slow = ctx.createOscillator(); slow.frequency.value = 0.7 + i * 0.23;
      const slowG = ctx.createGain(); slowG.gain.value = 0.5;
      lfo.connect(lfoG); lfoG.connect(am.gain); slow.connect(slowG); slowG.connect(am.gain);
      const pan = ctx.createStereoPanner(); pan.pan.value = -0.7 + i * 0.7;
      o.connect(am); am.connect(pan); pan.connect(this.crickets);
      o.start(); lfo.start(); slow.start();
    }
    this.crickets.gain.value = 0;
    // music bus
    this.music = ctx.createGain(); this.music.gain.value = 0.0;
    this.musicFilter = ctx.createBiquadFilter(); this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = 2400;
    this.music.connect(this.musicFilter);
    this.musicFilter.connect(this.master);
    const mSend = ctx.createGain(); mSend.gain.value = 0.9; this.music.connect(mSend); mSend.connect(this.reverb);
    this.music.gain.linearRampToValueAtTime(0.32, ctx.currentTime + 10);
    this.nextChord = ctx.currentTime + 2;
    this.chordIdx = 0;
    this.nextNote = ctx.currentTime + 5;
    this.nextBird = ctx.currentTime + 1;
    this.nextOwl = ctx.currentTime + 20;
  }

  setMusic(on) {
    this.musicOn = on;
    if (!this.ctx) return;
    this.music.gain.cancelScheduledValues(this.ctx.currentTime);
    this.music.gain.setTargetAtTime(on ? 0.32 : 0, this.ctx.currentTime, 1.5);
  }

  _pad(notes, t, dur) {
    const ctx = this.ctx;
    for (const n of notes) {
      const f = mtof(n);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05 / Math.sqrt(notes.length), t + dur * 0.35);
      g.gain.setValueAtTime(0.05 / Math.sqrt(notes.length), t + dur * 0.6);
      g.gain.linearRampToValueAtTime(0, t + dur + 3);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700 + Math.random() * 500; lp.Q.value = 0.5;
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.linearRampToValueAtTime(1300, t + dur * 0.5);
      lp.frequency.linearRampToValueAtTime(600, t + dur + 3);
      g.connect(lp); lp.connect(this.music);
      for (const det of [-6, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = det === 0 ? 'triangle' : 'sawtooth';
        o.frequency.value = f; o.detune.value = det + (Math.random() - 0.5) * 3;
        const og = ctx.createGain(); og.gain.value = det === 0 ? 0.9 : 0.18;
        o.connect(og); og.connect(g);
        o.start(t); o.stop(t + dur + 3.5);
      }
    }
  }

  _bell(midi, t, vel = 1) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() - 0.5) * 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.07 * vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 5.5);
    g.connect(pan); pan.connect(this.music);
    [[1, 1], [2.0, 0.25], [3.01, 0.08], [4.2, 0.03]].forEach(([m, a]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m;
      const og = ctx.createGain(); og.gain.value = a;
      og.gain.setValueAtTime(a, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 5.5 / m);
      o.connect(og); og.connect(g); o.start(t); o.stop(t + 6);
    });
  }

  _bird(t) {
    const ctx = this.ctx;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 8; pan.rolloffFactor = 1;
    const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 40;
    const lp = this.listenerPos || { x: 0, y: 0, z: 0 };
    pan.positionX.value = lp.x + Math.cos(a) * r; pan.positionY.value = lp.y + 3 + Math.random() * 10; pan.positionZ.value = lp.z + Math.sin(a) * r;
    const g = ctx.createGain(); g.gain.value = 0.0;
    g.connect(pan); pan.connect(this.master);
    const send = ctx.createGain(); send.gain.value = 0.25; pan.connect(send); send.connect(this.reverb);
    const type = Math.floor(Math.random() * 3);
    const notes = 2 + Math.floor(Math.random() * 5);
    let tt = t;
    const base = 2200 + Math.random() * 2400;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator(); o.type = 'sine';
      const d = type === 0 ? 0.08 + Math.random() * 0.06 : type === 1 ? 0.18 : 0.05;
      const f0 = base * (type === 1 ? 1 : 0.8 + Math.random() * 0.5);
      o.frequency.setValueAtTime(f0, tt);
      if (type === 0) o.frequency.exponentialRampToValueAtTime(f0 * (1.3 + Math.random() * 0.4), tt + d);
      else if (type === 1) { o.frequency.exponentialRampToValueAtTime(f0 * 0.7, tt + d); }
      else o.frequency.exponentialRampToValueAtTime(f0 * 1.6, tt + d);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, tt); og.gain.linearRampToValueAtTime(0.06, tt + 0.01); og.gain.exponentialRampToValueAtTime(0.0005, tt + d);
      // vibrato for warbling
      const vib = ctx.createOscillator(); vib.frequency.value = 30 + Math.random() * 40;
      const vg = ctx.createGain(); vg.gain.value = type === 2 ? 0 : f0 * 0.04;
      vib.connect(vg); vg.connect(o.frequency);
      o.connect(og); og.connect(g);
      o.start(tt); o.stop(tt + d + 0.02); vib.start(tt); vib.stop(tt + d + 0.02);
      tt += d + 0.03 + Math.random() * 0.08;
    }
    g.gain.setValueAtTime(1, t);
  }

  _owl(t) {
    const ctx = this.ctx;
    const g = ctx.createGain(); const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() - 0.5) * 1.6;
    g.connect(pan); pan.connect(this.reverb); pan.connect(this.master);
    const hoot = (tt, d, f) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(f, tt); o.frequency.linearRampToValueAtTime(f * 0.94, tt + d);
      const og = ctx.createGain(); og.gain.setValueAtTime(0, tt); og.gain.linearRampToValueAtTime(0.025, tt + 0.05); og.gain.linearRampToValueAtTime(0, tt + d);
      o.connect(og); og.connect(g); o.start(tt); o.stop(tt + d + 0.05);
    };
    hoot(t, 0.35, 390); hoot(t + 0.6, 0.18, 400); hoot(t + 0.85, 0.5, 385);
  }

  /** surface: 'grass' | 'gravel' | 'rock' | 'water' | 'snow' */
  footstep(surface, intensity = 1) {
    if (!this.started) return;
    const ctx = this.ctx; const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.white;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); const g = ctx.createGain();
    const off = Math.random() * 1.5;
    let dur = 0.12, vol = 0.12;
    if (surface === 'gravel') {
      f.type = 'bandpass'; f.frequency.value = 2400 + Math.random() * 800; f.Q.value = 0.6; dur = 0.16; vol = 0.22;
      // crunchy grains
      g.gain.setValueAtTime(0, t);
      for (let i = 0; i < 6; i++) { const tt = t + i * 0.022 + Math.random() * 0.01; g.gain.linearRampToValueAtTime(vol * (1 - i * 0.12) * (0.5 + Math.random() * 0.5), tt); g.gain.linearRampToValueAtTime(vol * 0.15, tt + 0.012); }
      g.gain.linearRampToValueAtTime(0, t + dur);
    } else if (surface === 'water') {
      f.type = 'bandpass'; f.frequency.value = 800 + Math.random() * 400; f.Q.value = 0.9; dur = 0.35; vol = 0.25;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    } else if (surface === 'rock') {
      f.type = 'lowpass'; f.frequency.value = 900; dur = 0.08; vol = 0.25;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    } else if (surface === 'snow') {
      f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.4; dur = 0.25; vol = 0.14;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.08); g.gain.linearRampToValueAtTime(0, t + dur);
    } else {
      f.type = 'bandpass'; f.frequency.value = 1700 + Math.random() * 1200; f.Q.value = 0.5; dur = 0.2; vol = 0.09;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.04); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    }
    g.gain.value; // keep
    const thud = ctx.createOscillator(); thud.type = 'sine'; thud.frequency.setValueAtTime(90, t); thud.frequency.exponentialRampToValueAtTime(45, t + 0.08);
    const tg = ctx.createGain(); tg.gain.setValueAtTime(0.12 * intensity, t); tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    thud.connect(tg); tg.connect(this.master); thud.start(t); thud.stop(t + 0.12);
    const master = ctx.createGain(); master.gain.value = intensity;
    src.connect(f); f.connect(g); g.connect(master); master.connect(this.master);
    src.start(t, off, dur + 0.05);
  }

  bleat(vol = 1) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.05;
    const f0 = 190 + Math.random() * 90;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * 1.08, t + 0.15); o.frequency.linearRampToValueAtTime(f0 * 0.9, t + 0.7);
    const vib = ctx.createOscillator(); vib.frequency.value = 7 + Math.random() * 3;
    const vg = ctx.createGain(); vg.gain.value = f0 * 0.05; vib.connect(vg); vg.connect(o.frequency);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 750; f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1500; f2.Q.value = 5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09 * vol, t + 0.06); g.gain.setValueAtTime(0.08 * vol, t + 0.45); g.gain.linearRampToValueAtTime(0, t + 0.75);
    const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() - 0.5) * 1.4;
    o.connect(f1); o.connect(f2); f1.connect(g); f2.connect(g); g.connect(pan); pan.connect(this.master); pan.connect(this.reverb);
    o.start(t); vib.start(t); o.stop(t + 0.8); vib.stop(t + 0.8);
  }

  splash(strength = 1) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.white;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 1.2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05 * strength, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.4);
    src.connect(f); f.connect(g); g.connect(this.master); g.connect(this.reverb); src.start(t, Math.random(), 0.5);
  }

  update(dt, s, camera) {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    Object.assign(this.state, s);
    const st = this.state;
    const L = ctx.listener;
    const p = camera.position;
    this.listenerPos = p;
    const fwd = camera.getWorldDirection(this._fwd || (this._fwd = camera.position.clone()));
    if (L.positionX) {
      L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    }
    const alt = Math.min(1, Math.max(0, (st.altitude - 50) / 500));
    const w = st.wind;
    this.windGainL.gain.setTargetAtTime((0.12 + alt * 0.35) * (0.4 + w), t, 0.5);
    this.windGainH.gain.setTargetAtTime((0.02 + alt * 0.08) * (0.3 + w * w * 1.5), t, 0.3);
    this.windHigh.frequency.setTargetAtTime(600 + w * 900 + alt * 300, t, 0.6);
    this.rustleG.gain.setTargetAtTime(0.012 * w * (1 - alt) * (st.forest + 0.3), t, 0.4);
    this.lakeG.gain.setTargetAtTime(0.16 * st.lake * (0.6 + 0.4 * Math.sin(t * 0.9) * Math.sin(t * 0.37)), t, 0.2);
    this.streamG.gain.setTargetAtTime(0.09 * (st.stream || 0) * (st.stream || 0), t, 0.3);
    this.crickets.gain.setTargetAtTime(0.012 * (st.dusk * 0.6 + st.night) * (1 - alt * 0.7), t, 2);
    this.musicFilter.frequency.setTargetAtTime(1400 + st.swell * 3200 + st.day * 600, t, 2);
    this.revGain.gain.setTargetAtTime(0.4 + alt * 0.3, t, 2);

    if (t > this.nextBird && st.day > 0.15) {
      this.nextBird = t + 1.5 + Math.random() * 6 / (0.3 + st.day) * (1 + alt * 3) * (1.2 - st.forest * 0.5);
      if (Math.random() < 0.8) this._bird(t + 0.05);
    }
    if (t > this.nextOwl) {
      this.nextOwl = t + 25 + Math.random() * 40;
      if (st.night > 0.6) this._owl(t + 0.1);
    }
    if (this.musicOn) {
      if (t > this.nextChord - 1) {
        const ch = CHORDS[this.chordIdx % CHORDS.length];
        this.chordIdx += 1 + (Math.random() < 0.3 ? 1 : 0);
        const dur = 14 + Math.random() * 6;
        this._pad(ch, this.nextChord, dur);
        this.currentChord = ch;
        this.nextChord += dur;
      }
      if (t > this.nextNote) {
        const density = 0.25 + st.swell * 0.5 + st.sitting * 0.3;
        this.nextNote = t + (2 + Math.random() * 5) / (0.4 + density);
        const ch = this.currentChord || CHORDS[0];
        const root = ch[0] + 12;
        const phrase = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < phrase; i++) {
          const m = root + SCALE[Math.floor(Math.random() * 7)] + (Math.random() < 0.3 ? 12 : 0);
          this._bell(m, t + 0.1 + i * (0.35 + Math.random() * 0.4), 0.6 + Math.random() * 0.4);
        }
      }
    }
  }
}
