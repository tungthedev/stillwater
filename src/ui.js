// Minimal, quiet interface: loading, title, compass, place cards, prompts, and touch HUD.

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(quality) {
    this.quality = quality;
    this.touchMode = false;
    this.swell = 0;
    this._swellT = 0;
    this.compassEl = $('compass');
    this.strip = $('strip');
    this.stickEl = $('touchStick');
    this.knobEl = $('touchKnob');
    this.btnSit = $('btnSit');
    this.btnTrail = $('btnTrail');
    this.btnLamp = $('btnLamp');
    this.btnTimeBoost = $('btnTimeBoost');
    this._desktopTitleKeys = document.querySelector('#title .keys')?.innerHTML || '';
    this._desktopPausedKeys = document.querySelector('#paused .keys')?.innerHTML || '';
    this.marks = [];
    const add = (label, bearing, cls) => {
      const el = document.createElement('div');
      el.className = 'm ' + cls;
      el.textContent = label;
      this.strip.appendChild(el);
      this.marks.push({ el, bearing, cls });
    };
    const card = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = 0; d < 360; d += 15) {
      if (card[d] !== undefined) add(card[d], d * Math.PI / 180, d % 90 === 0 ? 'card' : '');
      else add('', d * Math.PI / 180, 'tick');
    }
    this.poiMarks = new Map();
    document.querySelectorAll('#qual span').forEach((s) => s.classList.toggle('on', s.dataset.q === quality));
  }

  setTouchMode(on) {
    this.touchMode = !!on;
    document.body.classList.toggle('touch', this.touchMode);
    const begin = document.querySelector('#title .begin');
    if (begin) begin.textContent = this.touchMode ? 'tap anywhere to begin' : 'click anywhere to begin';
    const titleKeys = document.querySelector('#title .keys');
    if (titleKeys) {
      titleKeys.innerHTML = this.touchMode
        ? '<b>Left</b> drag to walk &nbsp; <b>Right</b> drag to look &nbsp; <b>Buttons</b> trail · sit · lamp'
        : this._desktopTitleKeys;
    }
    const pausedKeys = document.querySelector('#paused .keys');
    if (pausedKeys) {
      pausedKeys.innerHTML = this.touchMode
        ? '<div><b>Left side</b> drag thumb to walk</div>' +
          '<div><b>Right side</b> drag to look around</div>' +
          '<div><b>Trail</b> follow the path · <b>Sit</b> rest on a bench</div>' +
          '<div><b>Time</b> hold to let the day flow · <b>Lamp</b> headlamp</div>'
        : this._desktopPausedKeys;
    }
    const resume = $('resumeBtn');
    if (resume) resume.textContent = this.touchMode ? 'tap to continue' : 'click to continue';
  }

  setStick(state) {
    if (!this.stickEl || !this.knobEl) return;
    if (!state.active) {
      this.stickEl.classList.remove('active');
      this.knobEl.style.transform = 'translate3d(0px, 0px, 0px)';
      return;
    }
    this.stickEl.classList.add('active');
    this.stickEl.style.left = `${state.originX.toFixed(1)}px`;
    this.stickEl.style.top = `${state.originY.toFixed(1)}px`;
    this.knobEl.style.transform = `translate3d(${state.dx.toFixed(1)}px, ${state.dy.toFixed(1)}px, 0px)`;
  }

  setTouchButtonStates({ sitting = false, bench = false, autoWalk = false, headlamp = false, timeBoost = false }) {
    if (this.btnSit) {
      this.btnSit.classList.toggle('on', sitting);
      this.btnSit.classList.toggle('hint', !sitting && !!bench);
      this.btnSit.textContent = sitting ? 'Stand' : 'Sit';
    }
    if (this.btnTrail) this.btnTrail.classList.toggle('on', autoWalk);
    if (this.btnLamp) this.btnLamp.classList.toggle('on', headlamp);
    if (this.btnTimeBoost) this.btnTimeBoost.classList.toggle('on', timeBoost);
  }

  loading(msg, p) {
    const m = $('loadmsg');
    m.textContent = msg;
    $('loadbar').style.width = Math.round(p * 100) + '%';
  }
  finishLoading() {
    $('loadbar').style.width = '100%';
    const l = $('loading');
    setTimeout(() => { l.style.opacity = 0; setTimeout(() => (l.style.display = 'none'), 2300); }, 200);
  }
  showTitle() { $('title').style.opacity = 1; }
  hideTitle() { const t = $('title'); t.style.opacity = 0; t.style.pointerEvents = 'none'; }
  showHud(on) {
    const h = $('hud');
    h.style.opacity = on ? 1 : 0;
    h.classList.toggle('live', !!on);
  }
  paused(on) { const p = $('paused'); p.style.opacity = on ? 1 : 0; p.style.pointerEvents = on ? 'auto' : 'none'; }
  perf(s) { $('perf').textContent = s; }
  clock(h) {
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.style.opacity = 1;
    clearTimeout(this._tt);
    this._tt = setTimeout(() => (el.style.opacity = 0), 3200);
  }
  prompt(msg) {
    const el = $('prompt');
    if (this._prompt === msg) return;
    this._prompt = msg;
    el.textContent = msg;
    el.style.opacity = msg ? 0.9 : 0;
  }
  place(name, sub) {
    const el = $('place');
    el.querySelector('.n').textContent = name.toUpperCase();
    el.querySelector('.d').textContent = sub;
    el.style.opacity = 1;
    el.classList.add('show');
    this._swellT = 14;
    clearTimeout(this._pt);
    this._pt = setTimeout(() => { el.style.opacity = 0; el.classList.remove('show'); }, 7000);
  }
  update(dt, s) {
    this._swellT = Math.max(0, this._swellT - dt);
    this.swell += ((this._swellT > 0 ? 1 : 0) - this.swell) * (1 - Math.exp(-dt * 0.5));
    // compass: camera bearing (clockwise from north) = -yaw
    const heading = -s.yaw;
    const W = this.compassEl?.clientWidth || 420;
    const span = Math.PI * 0.85;
    const place = (el, bearing) => {
      let rel = bearing - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (Math.abs(rel) > span / 2) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = (W / 2 + rel / span * W).toFixed(1) + 'px';
    };
    for (const m of this.marks) place(m.el, m.bearing);
    for (const p of s.pois) {
      let el = this.poiMarks.get(p.name);
      if (!el) {
        el = document.createElement('div'); el.className = 'm poi'; el.textContent = '◆'; this.strip.appendChild(el); this.poiMarks.set(p.name, el);
      }
      const dx = p.x - s.pos.x, dz = p.z - s.pos.z;
      const d = Math.hypot(dx, dz);
      const b = Math.atan2(dx, -dz);
      place(el, b);
      el.style.opacity = d < p.r ? 0 : Math.min(1, 0.35 + 400 / (d + 200));
      el.title = p.name;
    }
    $('stats').innerHTML = `<span>${Math.round(s.altitude)} m</span> &nbsp;·&nbsp; ${this.clock(s.hours)}<br>${(s.distance / 1000).toFixed(2)} km walked &nbsp;·&nbsp; ${Math.round(s.climb)} m climbed`;
    if (this.touchMode) {
      this.setTouchButtonStates({
        sitting: !!s.sitting,
        bench: !!s.bench,
        autoWalk: !!s.autoWalk,
        headlamp: !!s.headlamp,
        timeBoost: !!s.timeBoost,
      });
      if (s.sitting) this.prompt('Tap Stand · hold Time to hurry');
      else if (s.bench) this.prompt('Tap Sit to rest');
      else this.prompt('');
    } else {
      if (s.sitting) this.prompt('E · stand up · T hurries time');
      else if (s.bench) this.prompt('E · sit and rest');
      else this.prompt('');
    }
  }
}
