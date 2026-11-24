// Procedural Web Audio sound effects for the Pass 1 prototype.
// Synthesizes all tactile mending sounds, rising lamp chimes, radio squelch,
// and a spatial cottage hearth crackle loop in the style of src/audio.js.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const LAMP_NOTES = [74, 76, 78, 81, 83, 86, 88, 90]; // D5 major pentatonic ascending

export function createProtoAudio(audio) {
  let hearthNodes = null;
  let crackleTimer = 0;
  let lastClickAt = 0;
  let musicLift = 0;

  function ready() {
    if (!audio || !audio.started || !audio.ctx) return null;
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    return audio.ctx;
  }

  function ensureHearthLoop() {
    if (hearthNodes) return hearthNodes;
    const ctx = ready();
    if (!ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = audio.brown;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;

    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0;

    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = audio.pink;
    hissSrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1450;
    bp.Q.value = 0.9;
    const hissG = ctx.createGain();
    hissG.gain.value = 0;

    src.connect(lp);
    lp.connect(rumbleG);
    rumbleG.connect(audio.master);

    hissSrc.connect(bp);
    bp.connect(hissG);
    hissG.connect(audio.master);

    src.start();
    hissSrc.start();
    hearthNodes = { src, hissSrc, rumbleG, hissG };
    return hearthNodes;
  }

  function cracklePop(vol) {
    const ctx = ready();
    if (!ctx || vol < 0.005) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = audio.white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400 + Math.random() * 2800;
    f.Q.value = 2.6;
    const g = ctx.createGain();
    const dur = 0.014 + Math.random() * 0.025;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * (0.08 + Math.random() * 0.14), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 0.8;
    s.connect(f);
    f.connect(g);
    g.connect(pan);
    pan.connect(audio.master);
    s.start(t, Math.random() * 1.4, dur + 0.02);
  }

  function woodKnock(pitch = 1.0, heavy = false) {
    const ctx = ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const baseF = (heavy ? 128 : 185) * pitch;

    // Resonant timber body
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(baseF * 1.25, t);
    o.frequency.exponentialRampToValueAtTime(baseF * 0.68, t + (heavy ? 0.14 : 0.09));
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(heavy ? 0.34 : 0.24, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0008, t + (heavy ? 0.22 : 0.14));
    o.connect(og);
    og.connect(audio.master);
    if (audio.reverb) og.connect(audio.reverb);
    o.start(t);
    o.stop(t + 0.25);

    // Crisp wood transient slap
    const n = ctx.createBufferSource();
    n.buffer = audio.white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = (heavy ? 750 : 1200) * pitch;
    f.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(heavy ? 0.28 : 0.18, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0008, t + (heavy ? 0.08 : 0.055));
    n.connect(f);
    f.connect(ng);
    ng.connect(audio.master);
    n.start(t, Math.random() * 1.2, 0.1);
  }

  function pickupWood() {
    woodKnock(1.32, false);
  }

  function holdTick(progress = 0) {
    const ctx = ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = audio.pink;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 650 + progress * 700;
    f.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.06);
    n.connect(f);
    f.connect(g);
    g.connect(audio.master);
    n.start(t, Math.random() * 3, 0.08);
  }

  function chimeNote(midi, delay = 0, vel = 1.0, dur = 2.6) {
    const ctx = ready();
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const f = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11 * vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    g.connect(audio.master);
    if (audio.reverb) g.connect(audio.reverb);
    for (const [mul, amp] of [[1, 1], [2.0, 0.28], [3.02, 0.09]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const og = ctx.createGain();
      og.gain.setValueAtTime(amp, t);
      og.gain.exponentialRampToValueAtTime(0.0003, t + dur / mul);
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  function signpostFixed() {
    woodKnock(0.92, true);
    setTimeout(() => woodKnock(1.18, false), 90);
    // Soft moss/dust brush
    const ctx = ready();
    if (ctx) {
      const t = ctx.currentTime;
      const n = ctx.createBufferSource();
      n.buffer = audio.pink;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1800;
      f.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.11, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.38);
      n.connect(f);
      f.connect(g);
      g.connect(audio.master);
      n.start(t, Math.random() * 2, 0.45);
    }
    chimeNote(69, 0.08, 0.7, 1.8);
    chimeNote(74, 0.22, 0.8, 2.2);
  }

  function hearthIgnite() {
    const ctx = ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    // Flint strike spark
    const sp = ctx.createBufferSource();
    sp.buffer = audio.white;
    const sf = ctx.createBiquadFilter();
    sf.type = 'highpass';
    sf.frequency.value = 3800;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.22, t);
    sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    sp.connect(sf);
    sf.connect(sg);
    sg.connect(audio.master);
    sp.start(t, 0.1, 0.06);

    // Warm hearth ignition whoosh
    const w = ctx.createBufferSource();
    w.buffer = audio.brown;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.setValueAtTime(180, t + 0.04);
    wf.frequency.exponentialRampToValueAtTime(620, t + 0.35);
    wf.frequency.exponentialRampToValueAtTime(240, t + 1.2);
    wf.Q.value = 0.8;
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0, t + 0.03);
    wg.gain.linearRampToValueAtTime(0.32, t + 0.22);
    wg.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    w.connect(wf);
    wf.connect(wg);
    wg.connect(audio.master);
    if (audio.reverb) wg.connect(audio.reverb);
    w.start(t + 0.03, Math.random() * 2, 1.4);

    // Warm waking chord
    chimeNote(62, 0.15, 0.9, 3.2);
    chimeNote(66, 0.28, 0.8, 3.0);
    chimeNote(69, 0.42, 0.85, 3.2);
    chimeNote(74, 0.58, 0.9, 3.6);
    setMusicLift(0.5);
  }

  function fenceComplete() {
    woodKnock(1.16, true);
    chimeNote(67, 0.08, 0.75, 2.2);
    chimeNote(71, 0.2, 0.8, 2.4);
    chimeNote(74, 0.32, 0.85, 2.8);
  }

  function lampChime(index) {
    const midi = LAMP_NOTES[Math.min(LAMP_NOTES.length - 1, Math.max(0, index))];
    chimeNote(midi, 0, 0.95, 2.4);
    // Tiny lantern flint/glass ping
    const ctx = ready();
    if (ctx) {
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(mtof(midi + 12), t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.28);
      o.connect(g);
      g.connect(audio.master);
      o.start(t);
      o.stop(t + 0.3);
    }
  }

  function bridgePlank(index) {
    const pitches = [0.84, 1.0, 1.18];
    woodKnock(pitches[index % pitches.length], true);
  }

  function bridgeComplete() {
    woodKnock(0.75, true);
    setTimeout(() => woodKnock(1.12, true), 95);
    chimeNote(62, 0.12, 0.95, 3.5);
    chimeNote(66, 0.22, 0.9, 3.4);
    chimeNote(69, 0.34, 0.9, 3.4);
    chimeNote(74, 0.48, 1.0, 3.8);
    chimeNote(78, 0.64, 0.95, 4.2);
    setMusicLift(1.0);
  }

  function radioSquelch() {
    const ctx = ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = audio.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2100;
    bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.015);
    g.gain.linearRampToValueAtTime(0.05, t + 0.11);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.19);
    n.connect(bp);
    bp.connect(g);
    g.connect(audio.master);
    n.start(t, Math.random() * 1.2, 0.22);

    const pip = ctx.createOscillator();
    pip.type = 'sine';
    pip.frequency.setValueAtTime(1180, t + 0.04);
    pip.frequency.exponentialRampToValueAtTime(920, t + 0.11);
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0, t + 0.04);
    pg.gain.linearRampToValueAtTime(0.032, t + 0.05);
    pg.gain.exponentialRampToValueAtTime(0.0004, t + 0.12);
    pip.connect(pg);
    pg.connect(audio.master);
    pip.start(t + 0.04);
    pip.stop(t + 0.14);
  }

  function radioClick() {
    const ctx = ready();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastClickAt < 0.065) return;
    lastClickAt = now;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 1650 + Math.random() * 350;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.012, now);
    g.gain.exponentialRampToValueAtTime(0.0004, now + 0.016);
    o.connect(g);
    g.connect(audio.master);
    o.start(now);
    o.stop(now + 0.02);
  }

  function setMusicLift(level) {
    musicLift = Math.max(musicLift, level);
    const ctx = ready();
    if (!ctx || !audio.music || !audio.musicOn) return;
    const targetGain = 0.26 + musicLift * 0.16;
    audio.music.gain.setTargetAtTime(targetGain, ctx.currentTime, 2.0);
    if (audio.musicFilter) {
      audio.musicFilter.frequency.setTargetAtTime(1800 + musicLift * 1800, ctx.currentTime, 2.0);
    }
  }

  function updateHearth(dt, distToCottage, litFactor) {
    if (litFactor <= 0.02) return;
    const nodes = ensureHearthLoop();
    if (!nodes || !audio.ctx) return;
    const prox = Math.max(0, 1 - distToCottage / 32);
    const vol = prox * prox * litFactor;
    const t = audio.ctx.currentTime;
    nodes.rumbleG.gain.setTargetAtTime(vol * 0.22, t, 0.25);
    nodes.hissG.gain.setTargetAtTime(vol * 0.05, t, 0.25);
    crackleTimer -= dt;
    if (crackleTimer <= 0 && vol > 0.04) {
      crackleTimer = 0.08 + Math.random() * 0.34;
      cracklePop(vol);
    }
  }

  function dispose() {
    if (hearthNodes) {
      try { hearthNodes.src.stop(); } catch {}
      try { hearthNodes.hissSrc.stop(); } catch {}
      hearthNodes = null;
    }
  }

  return {
    woodKnock,
    pickupWood,
    holdTick,
    signpostFixed,
    hearthIgnite,
    fenceComplete,
    lampChime,
    bridgePlank,
    bridgeComplete,
    radioSquelch,
    radioClick,
    setMusicLift,
    updateHearth,
    dispose,
  };
}
