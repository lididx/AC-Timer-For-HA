/**
 * AC Timer For HA — a draggable countdown card for Home Assistant.
 *
 * One card, multiple designs (set via the `design` option):
 *   - bar      : horizontal drag track (default)
 *   - vertical : vertical drag track
 *   - dial     : radial knob (drag around a circle)
 *   - arc      : semicircular gauge
 *   - stepper  : minimal +/- buttons + slider + Start
 *
 * All designs share the same logic: drag/set the minutes, start a server-side
 * `timer` entity (timer.start), show the live countdown, and run a configurable
 * `finish_action` when it ends. Created by Lidor Nahum.
 *
 * No build step required: this is a plain custom element.
 */

const CARD_VERSION = "0.6.0";

const DEFAULT_CONFIG = {
  design: "bar",
  title: "AC Shutoff Timer",
  max_minutes: 120,
  min_minutes: 1,
  step: 1,
};

const COLOR_VARS = {
  accent: "--ac-acc",
  accent2: "--ac-acc2",
  running_from: "--ac-run-from",
  running_to: "--ac-run-to",
  track_bg: "--ac-track",
  handle: "--ac-handle",
  title_color: "--ac-title",
  value: "--ac-value",
  sub: "--ac-sub",
  cancel: "--ac-cancel",
};

function colorToCss(c) {
  if (c == null || c === "") return null;
  if (Array.isArray(c)) return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  return String(c);
}

function clampMinutes(m, c) {
  const step = c.step || 1;
  let v = Math.round(m / step) * step;
  v = Math.max(c.min_minutes, Math.min(c.max_minutes, v));
  return v;
}

function bigText(snap) {
  return snap.mode === "running" || snap.mode === "paused"
    ? snap.hms
    : `${snap.minutes} min`;
}

function subText(snap) {
  if (snap.mode === "running") return "Runs in";
  if (snap.mode === "paused") return "Paused";
  if (snap.mode === "adjusting") return "Release to start";
  return "Drag to set";
}

// ---- SVG geometry helpers (for dial / arc) ----
function polarToCartesian(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startDeg, endDeg) {
  const start = polarToCartesian(cx, cy, r, startDeg);
  const end = polarToCartesian(cx, cy, r, endDeg);
  const delta = endDeg - startDeg;
  const largeArc = delta > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

// Pointer position -> fraction [0..1] along an arc sweep.
function angleToFraction(ev, el, startDeg, sweep, cyFrac) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * (cyFrac == null ? 0.5 : cyFrac);
  let ang = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  const rel = (ang - startDeg + 360) % 360;
  if (rel > sweep) return rel - sweep < 360 - rel ? 1 : 0;
  return rel / sweep;
}

function ticksHtml(config, vertical) {
  const max = config.max_minutes;
  const n = 6;
  let html = "";
  for (let i = 0; i <= n; i++) {
    const minutes = Math.round((max / n) * i);
    const pct = (i / n) * 100;
    // bar is RTL (0 on the right); vertical has 0 at the bottom.
    const pos = vertical ? `bottom:${pct}%` : `right:${pct}%`;
    html += `<span class="tick" style="${pos}">${minutes}</span>`;
  }
  return html;
}

/* ============================================================
 * Design renderers. Each: { label, css, html(config),
 *   wire(shadowRoot, api, config) -> els, paint(els, snap, config) }
 * ============================================================ */
const DESIGNS = {
  bar: {
    label: "Horizontal bar",
    css: `
      .acd-bar .track { position:relative; height:56px; border-radius:14px;
        background:var(--ac-track, color-mix(in srgb, var(--primary-text-color) 8%, transparent));
        touch-action:none; cursor:pointer; user-select:none; }
      .acd-bar .fill { position:absolute; top:0; right:0; height:100%; width:0%;
        border-radius:14px; transition:width .12s ease-out;
        background:linear-gradient(90deg, var(--ac-acc, var(--primary-color,#3f9eff)), var(--ac-acc2,#7b61ff)); }
      .acd-bar.running .fill { transition:width .5s linear;
        background:linear-gradient(90deg, var(--ac-run-from,#2e7d6b), var(--ac-run-to,#3f9eff)); }
      .acd-bar .handle { position:absolute; top:50%; right:0%; transform:translate(50%,-50%);
        width:8px; height:40px; border-radius:6px; background:var(--ac-handle,#fff);
        box-shadow:0 2px 6px rgba(0,0,0,.4); pointer-events:none; }
      .acd-bar.running .handle { display:none; }
      .acd-bar .ticks { position:relative; height:16px; margin-top:6px; }
      .acd-bar .tick { position:absolute; transform:translateX(50%); font-size:.7rem;
        color:var(--ac-sub, var(--secondary-text-color)); }
    `,
    html(config) {
      return `
        <div class="acd acd-bar">
          <div class="title">${escapeHtml(config.title)}</div>
          <div class="track" id="drag"><div class="fill" id="fill"></div><div class="handle" id="handle"></div></div>
          <div class="ticks">${ticksHtml(config, false)}</div>
          <div class="readout"><div class="big" id="big">--</div><div class="sub" id="sub"></div></div>
          <div class="cancel-wrap"><button class="btn-cancel" id="cancel">Cancel</button></div>
        </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "fill", "handle", "big", "sub", "cancel", "acd:.acd"]);
      api.attachDrag(els.drag, (ev) => {
        const rect = els.drag.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (rect.right - ev.clientX) / rect.width));
        return clampMinutes(ratio * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      const running = snap.mode === "running" || snap.mode === "paused";
      els.acd.classList.toggle("running", running);
      els.fill.style.width = `${snap.frac * 100}%`;
      els.handle.style.right = `${snap.frac * 100}%`;
      els.big.textContent = bigText(snap);
      els.sub.textContent = subText(snap);
      els.cancel.style.display = running ? "" : "none";
    },
  },

  vertical: {
    label: "Vertical bar",
    css: `
      .acd-vertical .vwrap { display:flex; justify-content:center; gap:14px; }
      .acd-vertical .track { position:relative; width:56px; height:190px; border-radius:14px;
        background:var(--ac-track, color-mix(in srgb, var(--primary-text-color) 8%, transparent));
        touch-action:none; cursor:pointer; user-select:none; }
      .acd-vertical .fill { position:absolute; left:0; bottom:0; width:100%; height:0%;
        border-radius:14px; transition:height .12s ease-out;
        background:linear-gradient(0deg, var(--ac-acc, var(--primary-color,#3f9eff)), var(--ac-acc2,#7b61ff)); }
      .acd-vertical.running .fill { transition:height .5s linear;
        background:linear-gradient(0deg, var(--ac-run-from,#2e7d6b), var(--ac-run-to,#3f9eff)); }
      .acd-vertical .handle { position:absolute; left:50%; bottom:0%; transform:translate(-50%,50%);
        width:40px; height:8px; border-radius:6px; background:var(--ac-handle,#fff);
        box-shadow:0 2px 6px rgba(0,0,0,.4); pointer-events:none; }
      .acd-vertical.running .handle { display:none; }
      .acd-vertical .ticks { position:relative; width:24px; height:190px; }
      .acd-vertical .tick { position:absolute; transform:translateY(50%); font-size:.7rem;
        color:var(--ac-sub, var(--secondary-text-color)); }
    `,
    html(config) {
      return `
        <div class="acd acd-vertical">
          <div class="title">${escapeHtml(config.title)}</div>
          <div class="vwrap">
            <div class="ticks">${ticksHtml(config, true)}</div>
            <div class="track" id="drag"><div class="fill" id="fill"></div><div class="handle" id="handle"></div></div>
          </div>
          <div class="readout"><div class="big" id="big">--</div><div class="sub" id="sub"></div></div>
          <div class="cancel-wrap"><button class="btn-cancel" id="cancel">Cancel</button></div>
        </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "fill", "handle", "big", "sub", "cancel", "acd:.acd"]);
      api.attachDrag(els.drag, (ev) => {
        const rect = els.drag.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (rect.bottom - ev.clientY) / rect.height));
        return clampMinutes(ratio * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      const running = snap.mode === "running" || snap.mode === "paused";
      els.acd.classList.toggle("running", running);
      els.fill.style.height = `${snap.frac * 100}%`;
      els.handle.style.bottom = `${snap.frac * 100}%`;
      els.big.textContent = bigText(snap);
      els.sub.textContent = subText(snap);
      els.cancel.style.display = running ? "" : "none";
    },
  },

  dial: {
    label: "Radial dial",
    R: 78,
    START: 135,
    SWEEP: 270,
    CY: 0.5,
    css: `
      .acd-dial .dial-wrap { position:relative; width:100%; max-width:240px; margin:4px auto 0; }
      .acd-dial svg { width:100%; display:block; touch-action:none; cursor:pointer; }
      .acd-dial .track { fill:none; stroke:var(--ac-track, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); stroke-width:16; stroke-linecap:round; }
      .acd-dial .progress { fill:none; stroke:var(--ac-acc, var(--primary-color,#3f9eff)); stroke-width:16; stroke-linecap:round; transition:stroke .2s; }
      .acd-dial.running .progress { stroke:var(--ac-run-from,#2e7d6b); }
      .acd-dial .knob { fill:var(--ac-handle,#fff); stroke:rgba(0,0,0,.25); stroke-width:1; }
      .acd-dial.running .knob { display:none; }
      .acd-dial .center { position:absolute; inset:0; display:flex; flex-direction:column;
        align-items:center; justify-content:center; pointer-events:none; }
    `,
    html(config) {
      const d = describeArc(100, 100, this.R, this.START, this.START + this.SWEEP);
      return `
        <div class="acd acd-dial">
          <div class="title">${escapeHtml(config.title)}</div>
          <div class="dial-wrap" id="drag">
            <svg viewBox="0 0 200 200">
              <path class="track" d="${d}"></path>
              <path class="progress" id="progress" d=""></path>
              <circle class="knob" id="knob" r="11" cx="100" cy="100"></circle>
            </svg>
            <div class="center"><div class="big" id="big">--</div><div class="sub" id="sub"></div></div>
          </div>
          <div class="cancel-wrap"><button class="btn-cancel" id="cancel">Cancel</button></div>
        </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "progress", "knob", "big", "sub", "cancel", "acd:.acd"]);
      const self = this;
      api.attachDrag(els.drag, (ev) => {
        const f = angleToFraction(ev, els.drag, self.START, self.SWEEP, self.CY);
        return clampMinutes(f * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      const running = snap.mode === "running" || snap.mode === "paused";
      els.acd.classList.toggle("running", running);
      const end = this.START + snap.frac * this.SWEEP;
      els.progress.setAttribute("d", describeArc(100, 100, this.R, this.START, end));
      const k = polarToCartesian(100, 100, this.R, end);
      els.knob.setAttribute("cx", k.x);
      els.knob.setAttribute("cy", k.y);
      els.big.textContent = bigText(snap);
      els.sub.textContent = subText(snap);
      els.cancel.style.display = running ? "" : "none";
    },
  },

  arc: {
    label: "Arc gauge",
    R: 82,
    START: 180,
    SWEEP: 180,
    CY: 100 / 120,
    css: `
      .acd-arc .arc-wrap { position:relative; width:100%; max-width:260px; margin:4px auto 0; }
      .acd-arc svg { width:100%; display:block; touch-action:none; cursor:pointer; }
      .acd-arc .track { fill:none; stroke:var(--ac-track, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); stroke-width:14; stroke-linecap:round; }
      .acd-arc .progress { fill:none; stroke:var(--ac-acc, var(--primary-color,#3f9eff)); stroke-width:14; stroke-linecap:round; transition:stroke .2s; }
      .acd-arc.running .progress { stroke:var(--ac-run-from,#2e7d6b); }
      .acd-arc .knob { fill:var(--ac-handle,#fff); stroke:rgba(0,0,0,.25); stroke-width:1; }
      .acd-arc.running .knob { display:none; }
      .acd-arc .center { position:absolute; left:0; right:0; bottom:6%; display:flex; flex-direction:column;
        align-items:center; justify-content:flex-end; pointer-events:none; }
    `,
    html(config) {
      const d = describeArc(100, 100, this.R, this.START, this.START + this.SWEEP);
      return `
        <div class="acd acd-arc">
          <div class="title">${escapeHtml(config.title)}</div>
          <div class="arc-wrap" id="drag">
            <svg viewBox="0 0 200 120">
              <path class="track" d="${d}"></path>
              <path class="progress" id="progress" d=""></path>
              <circle class="knob" id="knob" r="10" cx="18" cy="100"></circle>
            </svg>
            <div class="center"><div class="big" id="big">--</div><div class="sub" id="sub"></div></div>
          </div>
          <div class="cancel-wrap"><button class="btn-cancel" id="cancel">Cancel</button></div>
        </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "progress", "knob", "big", "sub", "cancel", "acd:.acd"]);
      const self = this;
      api.attachDrag(els.drag, (ev) => {
        const f = angleToFraction(ev, els.drag, self.START, self.SWEEP, self.CY);
        return clampMinutes(f * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      const running = snap.mode === "running" || snap.mode === "paused";
      els.acd.classList.toggle("running", running);
      const end = this.START + snap.frac * this.SWEEP;
      els.progress.setAttribute("d", describeArc(100, 100, this.R, this.START, end));
      const k = polarToCartesian(100, 100, this.R, end);
      els.knob.setAttribute("cx", k.x);
      els.knob.setAttribute("cy", k.y);
      els.big.textContent = bigText(snap);
      els.sub.textContent = subText(snap);
      els.cancel.style.display = running ? "" : "none";
    },
  },

  stepper: {
    label: "Minimal stepper",
    css: `
      .acd-stepper .readout { margin-bottom:10px; }
      .acd-stepper .controls { display:flex; align-items:center; gap:12px; margin:8px 0 12px; }
      .acd-stepper .slider { flex:1; accent-color:var(--ac-acc, var(--primary-color,#3f9eff)); }
      .acd-stepper .step-btn { width:42px; height:42px; border-radius:50%; border:none; cursor:pointer;
        font-size:1.4rem; font-weight:700; line-height:1; font-family:inherit;
        background:color-mix(in srgb, var(--ac-acc, var(--primary-color,#3f9eff)) 18%, transparent);
        color:var(--ac-acc, var(--primary-color,#3f9eff)); }
      .acd-stepper .start { display:block; width:100%; border:none; border-radius:12px; padding:12px;
        font-size:1rem; font-weight:600; cursor:pointer; font-family:inherit; color:#fff;
        background:var(--ac-acc, var(--primary-color,#3f9eff)); }
    `,
    html(config) {
      const init = Math.min(Math.max(config.min_minutes, 30), config.max_minutes);
      return `
        <div class="acd acd-stepper">
          <div class="title">${escapeHtml(config.title)}</div>
          <div class="readout"><div class="big" id="big">--</div><div class="sub" id="sub"></div></div>
          <div class="controls" id="controls">
            <button class="step-btn" id="minus" aria-label="less">−</button>
            <input class="slider" id="slider" type="range" min="${config.min_minutes}" max="${config.max_minutes}" step="${config.step}" value="${init}">
            <button class="step-btn" id="plus" aria-label="more">+</button>
          </div>
          <button class="start" id="start">Start</button>
          <div class="cancel-wrap"><button class="btn-cancel" id="cancel">Cancel</button></div>
        </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["big", "sub", "controls", "minus", "plus", "slider", "start", "cancel", "acd:.acd"]);
      const cur = () => clampMinutes(Number(els.slider.value), config);
      els.minus.addEventListener("click", () => {
        els.slider.value = clampMinutes(cur() - config.step, config);
        api.setValue(Number(els.slider.value));
      });
      els.plus.addEventListener("click", () => {
        els.slider.value = clampMinutes(cur() + config.step, config);
        api.setValue(Number(els.slider.value));
      });
      els.slider.addEventListener("input", () => api.setValue(Number(els.slider.value)));
      els.start.addEventListener("click", () => api.commit(cur()));
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      const running = snap.mode === "running" || snap.mode === "paused";
      els.big.textContent = bigText(snap);
      els.sub.textContent = running
        ? subText(snap)
        : "Set the time, then press Start";
      if (!running) els.slider.value = snap.minutes;
      els.controls.style.display = running ? "none" : "";
      els.start.style.display = running ? "none" : "";
      els.cancel.style.display = running ? "" : "none";
    },
  },
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// Grab elements by id; entries like "name:.selector" use querySelector instead.
function grabEls(root, names) {
  const els = {};
  for (const n of names) {
    if (n.includes(":")) {
      const [key, sel] = n.split(":");
      els[key] = root.querySelector(sel);
    } else {
      els[n] = root.getElementById(n);
    }
  }
  return els;
}

const BASE_STYLES = `
  ha-card { padding:16px; }
  .title { font-size:1.05rem; font-weight:600; margin-bottom:12px;
    color:var(--ac-title, var(--primary-text-color)); }
  .readout { text-align:center; }
  .readout .big { font-size:2.1rem; font-weight:700; font-variant-numeric:tabular-nums;
    color:var(--ac-value, var(--primary-text-color)); }
  .readout .sub { font-size:.85rem; margin-top:2px; color:var(--ac-sub, var(--secondary-text-color)); }
  .cancel-wrap { display:flex; justify-content:center; margin-top:12px; }
  .btn-cancel { border:none; border-radius:12px; padding:10px 28px; font-weight:600; cursor:pointer; font-family:inherit;
    background:color-mix(in srgb, var(--ac-cancel,#ff5252) 18%, transparent); color:var(--ac-cancel,#ff5252); }
  .hint { padding:24px 12px; text-align:center; font-size:.95rem;
    color:var(--ac-sub, var(--secondary-text-color)); }
`;

class AcTimerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._adjusting = false;
    this._pendingMinutes = null;
    this._lastIdleMinutes = null;
    this._tickHandle = null;
    this._eventUnsub = null;
  }

  setConfig(config) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._render();
  }

  static getConfigElement() {
    return document.createElement("ac-timer-card-editor");
  }

  static getStubConfig() {
    return { design: "bar", max_minutes: 120 };
  }

  getCardSize() {
    return this._config && (this._config.design === "dial" || this._config.design === "arc") ? 4 : 3;
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeSubscribeFinish();
    this._updateView();
  }

  connectedCallback() {
    this._startTicking();
  }

  disconnectedCallback() {
    this._stopTicking();
    this._unsubscribeFinish();
  }

  // ---- finish_action ----
  _maybeSubscribeFinish() {
    if (this._eventUnsub) return;
    if (!this._config || !this._config.finish_action) return;
    if (!this._hass || !this._hass.connection) return;
    this._hass.connection
      .subscribeEvents((ev) => {
        if (ev.data && ev.data.entity_id === this._config.timer_entity) {
          this._runFinishAction();
        }
      }, "timer.finished")
      .then((unsub) => (this._eventUnsub = unsub))
      .catch(() => {});
  }

  _unsubscribeFinish() {
    if (this._eventUnsub) {
      try {
        this._eventUnsub();
      } catch (e) {
        /* ignore */
      }
      this._eventUnsub = null;
    }
  }

  _runFinishAction() {
    let actions = this._config.finish_action;
    if (!actions) return;
    if (!Array.isArray(actions)) actions = [actions];
    for (const a of actions) {
      if (!a || typeof a !== "object") continue;
      const svc = a.action || a.service;
      if (!svc || !svc.includes(".")) continue;
      const [domain, service] = svc.split(".");
      const data = { ...(a.data || {}) };
      let target = a.target;
      if (!target && a.entity_id) target = { entity_id: a.entity_id };
      this._hass.callService(domain, service, data, target);
    }
  }

  // ---- timer state ----
  _stateObj() {
    if (!this._hass || !this._config || !this._config.timer_entity) return null;
    return this._hass.states[this._config.timer_entity] || null;
  }
  _isActive() {
    const s = this._stateObj();
    return !!(s && s.state === "active");
  }
  _isPaused() {
    const s = this._stateObj();
    return !!(s && s.state === "paused");
  }
  _remainingSeconds() {
    const s = this._stateObj();
    if (!s) return 0;
    if (s.state === "active" && s.attributes.finishes_at) {
      return Math.max(0, Math.round((new Date(s.attributes.finishes_at).getTime() - Date.now()) / 1000));
    }
    if (s.state === "paused" && s.attributes.remaining) {
      return this._toSeconds(s.attributes.remaining);
    }
    return 0;
  }
  _configuredSeconds() {
    const s = this._stateObj();
    if (s && s.attributes.duration) return this._toSeconds(s.attributes.duration);
    return this._config.max_minutes * 60;
  }
  _toSeconds(str) {
    const p = String(str).split(":").map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return Number(str) || 0;
  }
  _secondsToHMS(t) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
  }

  _snapshot() {
    const c = this._config;
    const running = this._isActive();
    const paused = this._isPaused();
    let minutes, frac, remaining = 0, hms = "", mode;
    if (this._adjusting && this._pendingMinutes != null) {
      minutes = this._pendingMinutes;
      frac = minutes / c.max_minutes;
      mode = "adjusting";
    } else if (running || paused) {
      remaining = this._remainingSeconds();
      frac = remaining / Math.max(1, this._configuredSeconds());
      minutes = Math.ceil(remaining / 60);
      hms = this._secondsToHMS(remaining);
      mode = running ? "running" : "paused";
    } else if (this._pendingMinutes != null) {
      minutes = this._pendingMinutes;
      frac = minutes / c.max_minutes;
      mode = "idle";
    } else {
      minutes = this._lastIdleMinutes != null ? this._lastIdleMinutes : Math.min(30, c.max_minutes);
      frac = minutes / c.max_minutes;
      mode = "idle";
    }
    frac = Math.max(0, Math.min(1, frac));
    return { mode, minutes, frac, remaining, hms };
  }

  _makeApi() {
    const card = this;
    return {
      config: card._config,
      attachDrag(el, calcMinutes) {
        const move = (ev) => card._setPending(calcMinutes(ev));
        const up = (ev) => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          card._commit();
        };
        el.addEventListener("pointerdown", (ev) => {
          if (!card._canInteract()) return;
          ev.preventDefault();
          card._adjusting = true;
          card._setPending(calcMinutes(ev));
          try {
            el.setPointerCapture(ev.pointerId);
          } catch (e) {
            /* ignore */
          }
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
          el.addEventListener("pointercancel", up);
        });
      },
      setValue(min) {
        card._pendingMinutes = clampMinutes(min, card._config);
        card._updateView();
      },
      commit(min) {
        if (min != null) card._pendingMinutes = clampMinutes(min, card._config);
        card._commit();
      },
      cancelTimer() {
        card._cancelTimer();
      },
    };
  }

  _canInteract() {
    return !!(this._hass && this._config.timer_entity && this._stateObj());
  }

  _setPending(min) {
    this._pendingMinutes = clampMinutes(min, this._config);
    this._updateView();
  }

  _commit() {
    this._adjusting = false;
    const m = this._pendingMinutes != null ? this._pendingMinutes : this._snapshot().minutes;
    this._lastIdleMinutes = m;
    if (m >= this._config.min_minutes) this._startTimer(m);
    this._updateView();
  }

  _startTimer(minutes) {
    this._hass.callService("timer", "start", {
      entity_id: this._config.timer_entity,
      duration: this._secondsToHMS(minutes * 60),
    });
  }
  _cancelTimer() {
    this._hass.callService("timer", "cancel", { entity_id: this._config.timer_entity });
  }

  // ---- render ----
  _render() {
    const design = DESIGNS[this._config.design] || DESIGNS.bar;
    this._design = design;
    this.shadowRoot.innerHTML = `
      <style>${BASE_STYLES}\n${design.css}</style>
      <ha-card>
        <div class="hint" id="hint" style="display:none"></div>
        <div id="root">${design.html(this._config)}</div>
      </ha-card>`;
    this._applyColors();
    this._hintEl = this.shadowRoot.getElementById("hint");
    this._rootWrap = this.shadowRoot.getElementById("root");
    this._designEls = design.wire(this.shadowRoot, this._makeApi(), this._config);
    this._updateView();
  }

  _applyColors() {
    const colors = this._config.colors || {};
    const host = this.shadowRoot.host;
    for (const [slot, cssVar] of Object.entries(COLOR_VARS)) {
      const css = colorToCss(colors[slot]);
      if (css) host.style.setProperty(cssVar, css);
      else host.style.removeProperty(cssVar);
    }
  }

  _showHint(msg) {
    if (!this._hintEl) return;
    this._hintEl.textContent = msg;
    this._hintEl.style.display = "";
    this._rootWrap.style.display = "none";
  }

  _updateView() {
    if (!this._design || !this._hintEl) return;
    if (!this._config.timer_entity) {
      this._showHint("Open the card editor and set a Timer entity to finish setup.");
      return;
    }
    if (this._hass && !this._stateObj()) {
      this._showHint(`Timer entity not found: ${this._config.timer_entity}`);
      return;
    }
    this._hintEl.style.display = "none";
    this._rootWrap.style.display = "";
    this._design.paint(this._designEls, this._snapshot(), this._config);
  }

  _startTicking() {
    this._stopTicking();
    this._tickHandle = setInterval(() => {
      if (this._isActive() && !this._adjusting) this._updateView();
    }, 1000);
  }
  _stopTicking() {
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
  }
}

customElements.define("ac-timer-card", AcTimerCard);

/* ============================================================
 * Visual config editor
 * ============================================================ */
const DESIGN_OPTIONS = Object.entries(DESIGNS).map(([value, d]) => ({
  value,
  label: d.label,
}));

const EDITOR_SCHEMA = [
  { name: "timer_entity", selector: { entity: { domain: "timer" } } },
  { name: "design", selector: { select: { mode: "dropdown", options: DESIGN_OPTIONS } } },
  { name: "title", selector: { text: {} } },
  { name: "finish_action", selector: { action: {} } },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "max_minutes", selector: { number: { min: 1, max: 1440, mode: "box", unit_of_measurement: "min" } } },
      { name: "min_minutes", selector: { number: { min: 1, max: 240, mode: "box", unit_of_measurement: "min" } } },
      { name: "step", selector: { number: { min: 1, max: 60, mode: "box", unit_of_measurement: "min" } } },
    ],
  },
  {
    name: "colors",
    type: "expandable",
    title: "Colors",
    icon: "mdi:palette",
    schema: [
      { name: "accent", selector: { color_rgb: {} } },
      { name: "accent2", selector: { color_rgb: {} } },
      { name: "running_from", selector: { color_rgb: {} } },
      { name: "running_to", selector: { color_rgb: {} } },
      { name: "track_bg", selector: { color_rgb: {} } },
      { name: "handle", selector: { color_rgb: {} } },
      { name: "value", selector: { color_rgb: {} } },
      { name: "title_color", selector: { color_rgb: {} } },
      { name: "sub", selector: { color_rgb: {} } },
      { name: "cancel", selector: { color_rgb: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  timer_entity: "Timer entity",
  design: "Design",
  title: "Title",
  finish_action: "Action on finish",
  max_minutes: "Max minutes",
  min_minutes: "Min minutes",
  step: "Minute step",
  colors: "Colors",
  accent: "Bar color",
  accent2: "Bar gradient color",
  running_from: "Bar color (running)",
  running_to: "Bar gradient (running)",
  track_bg: "Track background",
  handle: "Drag handle",
  value: "Countdown number",
  title_color: "Title color",
  sub: "Helper text",
  cancel: "Cancel button",
};

const EDITOR_HELPERS = {
  timer_entity: "The countdown timer this card controls. Pick one or create it in Settings → Helpers.",
  design: "Visual style of the timer.",
  title: "Name shown on the card.",
  finish_action: "Runs when the countdown ends.",
  max_minutes: "Longest time you can set.",
  min_minutes: "Shortest time that starts it.",
  step: "Drag snap, in minutes.",
  accent: "Bar/arc color before start.",
  accent2: "Gradient color before start (bar/vertical).",
  running_from: "Bar/arc color while running.",
  running_to: "Gradient color while running (bar/vertical).",
  track_bg: "Empty track behind the bar/arc.",
  handle: "The grip/knob you drag.",
  value: "Big countdown number.",
  title_color: "Title text color.",
  sub: "Small text + minute labels.",
  cancel: "Cancel button color.",
};

class AcTimerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
    this._ensureTimer();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    this._ensureTimer();
  }

  // Best-effort auto-create of a timer helper. Falls back silently to the
  // Timer entity picker (which is now the first field) if not permitted.
  async _ensureTimer() {
    if (!this._hass || !this._config) return;
    if (this._config.timer_entity || this._creatingTimer) return;
    this._creatingTimer = true;
    try {
      const base = (this._config.title || "AC Timer").trim() || "AC Timer";
      const name = `${base} ${Math.random().toString(36).slice(2, 6)}`;
      const created = await this._hass.callWS({ type: "timer/create", name, restore: true });
      let entityId = created && created.entity_id;
      if (!entityId && created && created.id) {
        const reg = await this._hass.callWS({ type: "config/entity_registry/list" });
        const found = reg.find((e) => e.platform === "timer" && e.unique_id === created.id);
        entityId = found && found.entity_id;
      }
      if (entityId) {
        this._config = { ...this._config, timer_entity: entityId };
        if (this._form) this._form.data = this._config;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
          })
        );
      }
    } catch (e) {
      console.warn("ac-timer-card: auto-create timer unavailable; pick one in 'Timer entity'.", e);
    } finally {
      this._creatingTimer = false;
    }
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.computeHelper = (s) => EDITOR_HELPERS[s.name] || "";
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: ev.detail.value },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.shadowRoot.innerHTML = "";
      this.shadowRoot.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

customElements.define("ac-timer-card-editor", AcTimerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ac-timer-card",
  name: "AC Timer Card",
  description:
    "A drag-to-set countdown timer with multiple designs, full color control, and a configurable finish action.",
  preview: false,
});

console.info(
  `%c AC-TIMER-CARD %c v${CARD_VERSION} `,
  "color: white; background: #3f9eff; font-weight: 700;",
  "color: #3f9eff; background: #1c1c1c;"
);
