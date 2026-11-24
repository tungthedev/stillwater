// Minimal, warm diegetic UI for the Pass 1 prototype:
// - Tiny center reticle that warms when looking at a usable object + radial hold progress
// - Quiet warm interaction prompt (never floating over 3D world)
// - Hand-written style caption for the signpost before the radio wakes
// - Compact monospace Maren radio box at bottom-center (never blocks movement)
// - Calm End Card at the lake jetty with "Keep walking"

const STYLE_CSS = `
#proto-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 32;
  font-family: var(--sans, 'Inter', system-ui, sans-serif);
}
#proto-reticle {
  position: fixed;
  left: 50%;
  top: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.35s ease;
}
#proto-reticle.on { opacity: 1; }
#proto-reticle .dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(248, 240, 224, 0.55);
  box-shadow: 0 0 6px rgba(0,0,0,0.45);
  transform: translate(-50%, -50%);
  transition: transform 0.16s ease, background 0.16s ease;
}
#proto-reticle.focus .dot {
  width: 6px;
  height: 6px;
  background: #ffd38a;
  box-shadow: 0 0 10px rgba(255, 196, 102, 0.85);
}
#proto-reticle svg {
  position: absolute;
  inset: 0;
  width: 28px;
  height: 28px;
  transform: rotate(-90deg);
  opacity: 0;
  transition: opacity 0.18s ease;
}
#proto-reticle.focus svg { opacity: 1; }

#proto-prompt {
  position: fixed;
  left: 50%;
  bottom: 20vh;
  transform: translate(-50%, 6px);
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.18s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
#proto-prompt.show {
  opacity: 1;
  transform: translate(-50%, 0);
}
#proto-prompt .pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px 6px 10px;
  border-radius: 999px;
  background: rgba(16, 20, 18, 0.62);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 224, 170, 0.28);
  color: #f8efde;
  font-size: 13px;
  letter-spacing: 0.03em;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
  white-space: nowrap;
}
#proto-prompt .key {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #161410;
  background: #f6d59c;
  padding: 1px 7px;
  border-radius: 999px;
}
#proto-prompt .hold-bar {
  width: 132px;
  height: 3px;
  border-radius: 999px;
  background: rgba(248, 239, 222, 0.22);
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.12s ease;
}
#proto-prompt .hold-bar.on { opacity: 1; }
#proto-prompt .hold-bar i {
  display: block;
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #f3b562, #ffe3a8);
}

#proto-caption {
  position: fixed;
  left: 50%;
  bottom: 12vh;
  transform: translate(-50%, 8px);
  max-width: min(560px, 84vw);
  text-align: center;
  font-family: 'Cormorant Garamond', 'Segoe Script', Georgia, serif;
  font-style: italic;
  font-weight: 400;
  font-size: clamp(20px, 2.3vw, 27px);
  line-height: 1.35;
  color: #fbf3e1;
  text-shadow: 0 2px 18px rgba(8, 12, 10, 0.85), 0 0 6px rgba(8, 12, 10, 0.7);
  opacity: 0;
  transition: opacity 0.8s ease, transform 0.8s ease;
}
#proto-caption.show {
  opacity: 1;
  transform: translate(-50%, 0);
}

#proto-radio {
  position: fixed;
  left: 50%;
  bottom: 4.5vh;
  transform: translate(-50%, 10px);
  width: min(540px, 86vw);
  padding: 12px 16px 13px;
  border-radius: 10px;
  background: rgba(14, 21, 19, 0.78);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(242, 184, 104, 0.34);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  color: #f3ead6;
  opacity: 0;
  transition: opacity 0.35s ease, transform 0.35s ease;
}
#proto-radio.show {
  opacity: 1;
  transform: translate(-50%, 0);
  pointer-events: auto;
  cursor: pointer;
  touch-action: manipulation;
}
#proto-radio .speaker {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #f2b766;
  margin-bottom: 5px;
}
#proto-radio .led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f5b95c;
  box-shadow: 0 0 8px #f5b95c;
  animation: protoLed 1.3s ease-in-out infinite;
}
@keyframes protoLed { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
#proto-radio .msg {
  font-size: 13.5px;
  line-height: 1.5;
  color: #f7efe0;
  min-height: 1.5em;
}

#proto-end {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 13, 14, 0.44);
  backdrop-filter: blur(6px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.8s ease;
  z-index: 35;
  touch-action: manipulation;
  padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px;
  box-sizing: border-box;
}
#proto-end.show {
  opacity: 1;
  pointer-events: auto;
}
#proto-end .card {
  width: min(440px, 88vw);
  padding: 28px 30px 24px;
  border-radius: 14px;
  background: rgba(18, 25, 22, 0.90);
  border: 1px solid rgba(244, 214, 162, 0.30);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.58);
  color: #f6eedc;
  text-align: center;
}
#proto-end .eyebrow {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #efb86a;
  margin-bottom: 8px;
}
#proto-end h2 {
  font-family: var(--serif, 'Cormorant Garamond', Georgia, serif);
  font-weight: 400;
  font-size: 36px;
  letter-spacing: 0.04em;
  margin: 0 0 4px;
  color: #fbf4e6;
}
#proto-end .sub {
  font-family: var(--serif, 'Cormorant Garamond', Georgia, serif);
  font-style: italic;
  font-size: 17px;
  color: rgba(244, 236, 221, 0.72);
  margin-bottom: 18px;
}
#proto-end .time {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  color: #f7deb0;
  margin-bottom: 14px;
}
#proto-end .list {
  list-style: none;
  padding: 12px 0;
  margin: 0 0 20px;
  border-top: 1px dashed rgba(244, 224, 184, 0.2);
  border-bottom: 1px dashed rgba(244, 224, 184, 0.2);
  text-align: left;
  font-size: 13.5px;
  line-height: 1.9;
}
#proto-end .list li {
  display: flex;
  justify-content: space-between;
  color: rgba(246, 238, 220, 0.92);
}
#proto-end .list li.todo { color: rgba(246, 238, 220, 0.46); }
#proto-end .list li span.st {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: #a9d6a0;
}
#proto-end .list li.todo span.st { color: rgba(246, 238, 220, 0.42); }
#proto-end button {
  cursor: pointer;
  padding: 10px 24px;
  min-height: 44px;
  border-radius: 999px;
  border: 1px solid rgba(246, 212, 152, 0.55);
  background: rgba(242, 188, 108, 0.18);
  color: #fbf3e2;
  font-family: var(--sans, 'Inter', system-ui, sans-serif);
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  transition: background 0.16s ease, transform 0.12s ease;
  touch-action: manipulation;
}
#proto-end button:hover {
  background: rgba(242, 188, 108, 0.34);
}
body.touch #proto-prompt {
  bottom: max(224px, calc(212px + env(safe-area-inset-bottom)));
}
body.touch #proto-caption {
  bottom: max(206px, calc(194px + env(safe-area-inset-bottom)));
  font-size: 19px;
}
body.touch #proto-radio {
  top: max(66px, calc(56px + env(safe-area-inset-top)));
  bottom: auto;
  width: min(362px, calc(100vw - 28px));
  padding: 10px 13px 11px;
  transform: translate(-50%, -10px);
}
body.touch #proto-radio.show {
  transform: translate(-50%, 0);
}
body.touch #proto-radio .msg {
  font-size: 12.5px;
}
@media (max-height: 460px) {
  #proto-end .card {
    max-height: 92vh;
    overflow-y: auto;
    padding: 18px 20px;
  }
  #proto-end h2 { font-size: 26px; }
}
`;

const RING_CIRC = 2 * Math.PI * 11;

export function createProtoUI({ onKeepWalking, onRadioClick }) {
  const styleEl = document.createElement('style');
  styleEl.id = 'proto-style';
  styleEl.textContent = STYLE_CSS;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.id = 'proto-layer';
  root.innerHTML = `
    <div id="proto-reticle">
      <div class="dot"></div>
      <svg viewBox="0 0 28 28">
        <circle cx="14" cy="14" r="11" fill="none" stroke="rgba(255,222,168,0.3)" stroke-width="1.6" />
        <circle id="proto-ring" cx="14" cy="14" r="11" fill="none" stroke="#ffd27d" stroke-width="2.1"
          stroke-dasharray="${RING_CIRC.toFixed(2)}" stroke-dashoffset="${RING_CIRC.toFixed(2)}" stroke-linecap="round" />
      </svg>
    </div>
    <div id="proto-prompt">
      <div class="pill"><span class="key" id="proto-key">E</span><span id="proto-label"></span></div>
      <div class="hold-bar" id="proto-hold-bar"><i id="proto-hold-fill"></i></div>
    </div>
    <div id="proto-caption"></div>
    <div id="proto-radio" data-ui-control="1">
      <div class="speaker"><span class="led"></span><span>MAREN · radio</span></div>
      <div class="msg" id="proto-radio-msg"></div>
    </div>
    <div id="proto-end" data-ui-control="1">
      <div class="card">
        <div class="eyebrow">Stillwater · Pass 1</div>
        <h2>End of the test walk</h2>
        <div class="sub">The trail to the lake is open again.</div>
        <div class="time" id="proto-end-time"></div>
        <ul class="list" id="proto-end-list"></ul>
        <button id="proto-keep-walking" type="button" data-ui-control="1">Keep walking</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const $el = (sel) => /** @type {HTMLElement} */ (root.querySelector(sel));
  const reticleEl = $el('#proto-reticle');
  const ringEl = $el('#proto-ring');
  const promptEl = $el('#proto-prompt');
  const keyEl = $el('#proto-key');
  const labelEl = $el('#proto-label');
  const holdBarEl = $el('#proto-hold-bar');
  const holdFillEl = $el('#proto-hold-fill');
  const captionEl = $el('#proto-caption');
  const radioEl = $el('#proto-radio');
  const radioMsgEl = $el('#proto-radio-msg');
  const endEl = $el('#proto-end');
  const endTimeEl = $el('#proto-end-time');
  const endListEl = $el('#proto-end-list');
  const keepBtn = $el('#proto-keep-walking');

  let captionTimer = 0;
  let captionText = '';
  let promptText = '';
  let endCardVisible = false;

  // Radio typewriter state
  const pendingDelayed = [];
  const radioQueue = [];
  let activeRadio = null; // { text, shown, holdTimer, onStart }
  let radioHideTimer = 0;
  let lastRadioFull = '';

  const onKeepActivate = (e) => {
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (!endCardVisible) return;
    hideEndCard();
    onKeepWalking?.();
  };
  keepBtn.addEventListener('click', onKeepActivate);
  keepBtn.addEventListener('touchend', onKeepActivate, { passive: false });

  const onRadioTap = (e) => {
    if (!radioEl.classList.contains('show')) return;
    if (e.type === 'touchend' && e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (!activeRadio) {
      radioEl.classList.remove('show');
      return;
    }
    if (!activeRadio.done) {
      activeRadio.chars = activeRadio.text.length;
      radioMsgEl.textContent = activeRadio.text;
      activeRadio.done = true;
      activeRadio.hold = radioQueue.length > 0 ? 2.4 : 4.6;
    } else {
      activeRadio = null;
      if (radioQueue.length === 0) {
        radioEl.classList.remove('show');
      }
    }
  };
  radioEl.addEventListener('click', onRadioTap);
  radioEl.addEventListener('touchend', onRadioTap, { passive: false });

  function setReticleVisible(on) {
    reticleEl.classList.toggle('on', !!on);
  }

  function setFocus(focus) {
    if (!focus) {
      reticleEl.classList.remove('focus');
      promptEl.classList.remove('show');
      holdBarEl.classList.remove('on');
      ringEl.style.strokeDashoffset = RING_CIRC.toFixed(2);
      promptText = '';
      return;
    }
    reticleEl.classList.add('focus');
    promptEl.classList.add('show');
    keyEl.textContent = focus.keyHint || 'E';
    labelEl.textContent = focus.label || '';
    promptText = `${focus.keyHint || 'E'} · ${focus.label || ''}`;
    const p = Math.max(0, Math.min(1, focus.holdProgress || 0));
    holdBarEl.classList.toggle('on', !!focus.isHold && p > 0.001);
    holdFillEl.style.width = `${(p * 100).toFixed(1)}%`;
    ringEl.style.strokeDashoffset = (RING_CIRC * (1 - p)).toFixed(2);
  }

  function showCaption(text, durationSec = 4.6) {
    captionText = text;
    captionEl.textContent = text;
    captionEl.classList.add('show');
    captionTimer = durationSec;
  }

  function queueRadio(text, opts = {}) {
    const delaySec = (opts.delayMs || 0) / 1000;
    const item = { text, onStart: opts.onStart || null, immediate: !!opts.immediate };
    if (delaySec > 0) {
      pendingDelayed.push({ wait: delaySec, item });
    } else if (item.immediate) {
      pendingDelayed.length = 0;
      radioQueue.length = 0;
      activeRadio = null;
      radioQueue.push(item);
    } else {
      radioQueue.push(item);
    }
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function showEndCard({ elapsedSec, items }) {
    endCardVisible = true;
    endTimeEl.textContent = `Time walked · ${formatTime(elapsedSec)}`;
    endListEl.innerHTML = items
      .map(
        (it) =>
          `<li class="${it.done ? '' : 'todo'}"><span>${it.name}</span><span class="st">${it.detail}</span></li>`,
      )
      .join('');
    endEl.classList.add('show');
  }

  function hideEndCard() {
    endCardVisible = false;
    endEl.classList.remove('show');
  }

  function update(dt) {
    if (captionTimer > 0) {
      captionTimer -= dt;
      if (captionTimer <= 0) {
        captionEl.classList.remove('show');
        captionText = '';
      }
    }

    for (let i = pendingDelayed.length - 1; i >= 0; i--) {
      pendingDelayed[i].wait -= dt;
      if (pendingDelayed[i].wait <= 0) {
        radioQueue.push(pendingDelayed[i].item);
        pendingDelayed.splice(i, 1);
      }
    }

    if (!activeRadio && radioQueue.length > 0) {
      const next = radioQueue.shift();
      activeRadio = { text: next.text, chars: 0, done: false, hold: 4.5 };
      lastRadioFull = next.text;
      radioMsgEl.textContent = '';
      radioEl.classList.add('show');
      radioHideTimer = 0;
      next.onStart?.();
    }

    if (activeRadio) {
      if (!activeRadio.done) {
        const prev = Math.floor(activeRadio.chars);
        activeRadio.chars += dt * 44; // brisk readable radio typing
        const cur = Math.min(activeRadio.text.length, Math.floor(activeRadio.chars));
        if (cur !== prev) {
          radioMsgEl.textContent = activeRadio.text.slice(0, cur);
          if (cur % 3 === 0) onRadioClick?.();
        }
        if (cur >= activeRadio.text.length) {
          activeRadio.done = true;
          activeRadio.hold = radioQueue.length > 0 ? 2.4 : 4.6;
        }
      } else {
        activeRadio.hold -= dt;
        if (activeRadio.hold <= 0) {
          activeRadio = null;
          if (radioQueue.length === 0) {
            radioEl.classList.remove('show');
          }
        }
      }
    } else if (radioHideTimer > 0) {
      radioHideTimer -= dt;
      if (radioHideTimer <= 0) radioEl.classList.remove('show');
    }
  }

  function getState() {
    return {
      promptText,
      captionText,
      radioVisible: radioEl.classList.contains('show'),
      radioText: radioMsgEl.textContent || '',
      lastRadioFull,
      endCardVisible,
    };
  }

  function dispose() {
    keepBtn.removeEventListener('click', onKeepActivate);
    keepBtn.removeEventListener('touchend', onKeepActivate);
    radioEl.removeEventListener('click', onRadioTap);
    radioEl.removeEventListener('touchend', onRadioTap);
    root.remove();
    styleEl.remove();
  }

  return {
    setReticleVisible,
    setFocus,
    showCaption,
    queueRadio,
    showEndCard,
    hideEndCard,
    update,
    getState,
    get endCardVisible() { return endCardVisible; },
    dispose,
  };
}
