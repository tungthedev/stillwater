// Minimal, quiet interface: loading, title, compass, place cards, prompts.

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(quality) {
    this.quality = quality;
    this.swell = 0;
    this._swellT = 0;
    this.strip = $('strip');
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
  showHud(on) { $('hud').style.opacity = on ? 1 : 0; }
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
    const W = 420, span = Math.PI * 0.85;
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
    if (s.sitting) this.prompt('E · stand up · T hurries time');
    else if (s.bench) this.prompt('E · sit and rest');
    else this.prompt('');
  }
}
