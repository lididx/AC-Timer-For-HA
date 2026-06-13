/**
 * AC Timer For HA — a premium draggable countdown card for Home Assistant.
 *
 * One card, four designs (set via the `design` option):
 *   - bar      : horizontal premium capsule
 *   - vertical : glass liquid vessel
 *   - dial     : countdown ring
 *   - stepper  : compact control panel
 *
 * Shared logic: drag/set minutes, start a server-side `timer` entity, show the
 * live countdown + end time + status, and run a configurable `finish_action`.
 *
 * Theming: every color comes from CSS variables (a central dark/green theme by
 * default). Any color is overridable from the card editor (`colors:` config) —
 * nothing is hardcoded inside the components. No percentages are ever shown.
 *
 * Created by Lidor Nahum. No build step required (plain custom element).
 */

const CARD_VERSION = "1.2.0";

const DEFAULT_CONFIG = {
  design: "bar",
  title: "AC Shutoff Timer",
  label: "Runs in",
  direction: "rtl", // rtl = 0 on the right (default), ltr = 0 on the left
  max_minutes: 120,
  min_minutes: 1,
  step: 1,
  ends_show: true,
  ends_width: "chip", // "chip" (small) or "full" (full-width row)
  ends_size: 13, // px
};

// config.colors.<slot> -> CSS variable. All optional; theme defaults live in CSS.
const COLOR_VARS = {
  accent: "--act-accent",
  accent_strong: "--act-accent-strong",
  accent_glow: "--act-accent-glow",
  card_grad_start: "--act-card-grad-start",
  card_grad_end: "--act-card-grad-end",
  card_border: "--act-card-border",
  text: "--act-text",
  text_secondary: "--act-text-2",
  track: "--act-track",
  warning: "--act-warning",
  danger: "--act-danger",
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

function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtHMS(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}
function fmtCoarse(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ---- SVG geometry helpers ----
function polarToCartesian(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startDeg, endDeg) {
  const start = polarToCartesian(cx, cy, r, startDeg);
  const end = polarToCartesian(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function grabEls(root, names) {
  const els = {};
  for (const n of names) {
    if (n.includes("|")) {
      const [key, sel] = n.split("|");
      els[key] = root.querySelector(sel);
    } else {
      els[n] = root.getElementById(n);
    }
  }
  return els;
}

// Shared UI fragments -------------------------------------------------------
function headHtml(config) {
  return `<div class="head">
      <div class="title">${escapeHtml(config.title)}</div>
      <div class="label" id="label">${escapeHtml(config.label || "")}</div>
    </div>`;
}
function endsHtml(config) {
  if (config && config.ends_show === false) return "";
  return `<div class="ends" id="ends"></div>`;
}
// Horizontal-bar "Ends at" element with user-chosen size and width.
function barEndsHtml(config) {
  if (config.ends_show === false) return "";
  const full = config.ends_width === "full";
  const fs = Number(config.ends_size) || 13;
  return `<div class="ends-row"><div class="ends-box${full ? " full" : ""}" id="endsbox" style="font-size:${fs}px">
      <span class="ic"><ha-icon icon="mdi:calendar-clock"></ha-icon></span><span id="endsv">—</span>
    </div></div>`;
}
function statusHtml() {
  return `<div class="status"><span class="dot" id="sdot"></span><span id="stext"></span></div>`;
}
function cancelHtml() {
  return `<div class="cancel-wrap"><button class="btn-cancel" id="cancel" aria-label="Cancel timer">Cancel</button></div>`;
}

function paintShared(els, snap) {
  if (els.big) els.big.textContent = snap.hms;
  if (els.ends) els.ends.textContent = snap.endsAt ? `Ends at ${snap.endsAt}` : "";
  if (els.stext) els.stext.textContent = snap.status;
  if (els.cancel) els.cancel.style.display = snap.running || snap.paused ? "" : "none";
}

/* ============================================================
 * Design renderers
 * ============================================================ */
const DESIGNS = {
  bar: {
    label: "Horizontal bar",
    css: `
      .acd-bar .cap { position:relative; height:42px; border-radius:999px; margin:18px 0 22px;
        touch-action:none; cursor:pointer; user-select:none; }
      .acd-bar .cap-track { position:absolute; inset:0; border-radius:999px; background:var(--act-track-dark);
        box-shadow:inset 0 2px 6px rgba(0,0,0,.55), inset 0 -1px 2px rgba(255,255,255,.05); }
      .acd-bar .cap-fill { position:absolute; top:0; bottom:0; border-radius:999px; overflow:hidden;
        background:linear-gradient(90deg, color-mix(in srgb, var(--act-active) 75%, black), var(--act-active));
        box-shadow:0 0 16px var(--act-accent-glow); transition:width .45s ease, right .45s ease, left .45s ease; }
      .acd-bar .cap-hl { position:absolute; top:3px; left:8px; right:8px; height:42%; border-radius:999px;
        background:linear-gradient(180deg, rgba(255,255,255,.35), rgba(255,255,255,0)); }
      .acd-bar .cap-dot { position:absolute; top:50%; width:22px; height:22px; border-radius:50%;
        background:var(--act-accent-strong); box-shadow:0 0 14px var(--act-accent-glow), 0 0 5px var(--act-accent-strong);
        transition:right .45s ease, left .45s ease; }
      .acd-bar.running .cap-dot { width:18px; height:18px; }
      .acd-bar .ends-row { display:flex; justify-content:center; margin-top:14px; }
      .acd-bar .ends-box { display:inline-flex; align-items:center; gap:10px; padding:9px 16px; border-radius:16px;
        background:var(--act-btn-bg); border:1px solid var(--act-btn-border); color:var(--act-text-2); }
      .acd-bar .ends-box.full { display:flex; width:100%; justify-content:center; }
      .acd-bar .ends-box .ic { width:28px; height:28px; border-radius:50%; background:rgba(0,0,0,.3);
        display:flex; align-items:center; justify-content:center; color:var(--act-accent); --mdc-icon-size:16px; flex:none; }
    `,
    html(config) {
      return `<div class="acd acd-bar">
        ${headHtml(config)}
        <div class="cap" id="drag">
          <div class="cap-track"></div>
          <div class="cap-fill" id="fill"><div class="cap-hl"></div></div>
          <div class="cap-dot" id="dot"></div>
        </div>
        <div class="time" id="big">00:00:00</div>
        ${barEndsHtml(config)}
        ${cancelHtml()}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "fill", "dot", "big", "endsv", "cancel", "acd|.acd"]);
      const rtl = config.direction !== "ltr";
      api.attachDrag(els.drag, (ev) => {
        const rect = els.drag.getBoundingClientRect();
        const raw = rtl ? rect.right - ev.clientX : ev.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, raw / rect.width));
        return clampMinutes(ratio * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap, config) {
      const rtl = config.direction !== "ltr";
      els.acd.classList.toggle("running", snap.running || snap.paused);
      els.acd.classList.toggle("pulse", snap.pulse);
      const pct = `${snap.frac * 100}%`;
      if (rtl) {
        els.fill.style.right = "0";
        els.fill.style.left = "auto";
        els.dot.style.right = pct;
        els.dot.style.left = "auto";
        els.dot.style.transform = "translate(50%,-50%)";
      } else {
        els.fill.style.left = "0";
        els.fill.style.right = "auto";
        els.dot.style.left = pct;
        els.dot.style.right = "auto";
        els.dot.style.transform = "translate(-50%,-50%)";
      }
      els.fill.style.width = pct;
      if (els.endsv) els.endsv.textContent = snap.endsAt ? `Ends at ${snap.endsAt}` : "—";
      paintShared(els, snap);
    },
  },

  vertical: {
    label: "Vertical bar",
    css: `
      .acd-vertical .vstage { display:flex; justify-content:center; gap:16px; margin:16px 0 18px; }
      .acd-vertical .vessel { position:relative; width:64px; height:210px; border-radius:32px; overflow:hidden;
        background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
        border:1px solid var(--act-card-border);
        box-shadow:inset 0 2px 10px rgba(0,0,0,.5), 0 0 18px var(--act-accent-glow);
        backdrop-filter:blur(4px); touch-action:none; cursor:pointer; }
      .acd-vertical .liquid { position:absolute; left:0; right:0; bottom:0; height:0%;
        background:linear-gradient(180deg, color-mix(in srgb, var(--act-active) 78%, black), var(--act-active));
        box-shadow:0 0 16px var(--act-accent-glow); transition:height .5s ease; }
      .acd-vertical .liquid::before { content:""; position:absolute; top:-9px; left:-25%; width:150%; height:18px;
        border-radius:45%; background:var(--act-active); animation:actwave 4s linear infinite; }
      .acd-vertical .bubble { position:absolute; bottom:6px; width:6px; height:6px; border-radius:50%;
        background:rgba(255,255,255,.5); animation:actbub 4.5s ease-in infinite; }
      .acd-vertical .b2 { left:40%; width:4px; height:4px; animation-delay:1.4s; animation-duration:5.5s; }
      .acd-vertical .b3 { left:65%; width:5px; height:5px; animation-delay:2.6s; animation-duration:6s; }
      .acd-vertical .vscale { display:flex; flex-direction:column; justify-content:space-between;
        padding:6px 0; font-size:.72rem; color:var(--act-text-muted); }
      .acd-vertical .vscale span { display:flex; align-items:center; gap:6px; }
      .acd-vertical .vscale span::before { content:""; width:10px; height:1px; background:var(--act-track); }
    `,
    html(config) {
      return `<div class="acd acd-vertical">
        ${headHtml(config)}
        <div class="vstage">
          <div class="vessel" id="drag">
            <div class="liquid" id="fill">
              <span class="bubble b1"></span><span class="bubble b2"></span><span class="bubble b3"></span>
            </div>
          </div>
          <div class="vscale"><span>Full</span><span>Half</span><span>Low</span></div>
        </div>
        <div class="time" id="big">00:00:00</div>
        ${endsHtml(config)}
        ${cancelHtml()}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "fill", "big", "ends", "cancel", "acd|.acd"]);
      api.attachDrag(els.drag, (ev) => {
        const rect = els.drag.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (rect.bottom - ev.clientY) / rect.height));
        return clampMinutes(ratio * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      els.acd.classList.toggle("running", snap.running || snap.paused);
      els.acd.classList.toggle("pulse", snap.pulse);
      els.fill.style.height = `${snap.frac * 100}%`;
      paintShared(els, snap);
    },
  },

  dial: {
    label: "Radial dial",
    R: 76,
    START: 135,
    SWEEP: 270,
    CY: 0.5,
    css: `
      .acd-dial .dial-wrap { position:relative; width:100%; max-width:250px; margin:8px auto 4px; }
      .acd-dial svg { width:100%; display:block; touch-action:none; cursor:pointer; overflow:visible; }
      .acd-dial .d-track { fill:none; stroke:var(--act-track); stroke-width:14; stroke-linecap:round; }
      .acd-dial .d-prog { fill:none; stroke:var(--act-active); stroke-width:14; stroke-linecap:round;
        transition:stroke-dashoffset .45s ease, stroke .3s; filter:drop-shadow(0 0 6px var(--act-accent-glow)); }
      .acd-dial .tickline { stroke:var(--act-track); stroke-width:2; }
      .acd-dial .d-knob { fill:var(--act-accent-strong); filter:drop-shadow(0 0 6px var(--act-accent-glow)); }
      .acd-dial.running .d-knob { r:7; }
      .acd-dial .center { position:absolute; inset:0; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:6px; pointer-events:none; }
    `,
    html(config) {
      const d = describeArc(100, 100, this.R, this.START, this.START + this.SWEEP);
      let ticks = "";
      const n = 40;
      for (let i = 0; i <= n; i++) {
        const a = this.START + (this.SWEEP * i) / n;
        const p1 = polarToCartesian(100, 100, this.R + 12, a);
        const p2 = polarToCartesian(100, 100, this.R + (i % 5 === 0 ? 18 : 15), a);
        ticks += `<line class="tickline" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"></line>`;
      }
      return `<div class="acd acd-dial">
        ${headHtml(config)}
        <div class="dial-wrap" id="drag">
          <svg viewBox="0 0 200 200">
            ${ticks}
            <path class="d-track" d="${d}"></path>
            <path class="d-prog" id="prog" d="${d}"></path>
            <circle class="d-knob" id="knob" r="9" cx="100" cy="100"></circle>
          </svg>
          <div class="center">
            <div class="time" id="big">00:00:00</div>
            ${statusHtml()}
            ${endsHtml(config)}
          </div>
        </div>
        ${cancelHtml()}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "prog", "knob", "big", "ends", "sdot", "stext", "cancel", "acd|.acd"]);
      const self = this;
      els.progLen = 0;
      try {
        els.progLen = els.prog.getTotalLength();
      } catch (e) {
        els.progLen = (2 * Math.PI * self.R * self.SWEEP) / 360;
      }
      els.prog.style.strokeDasharray = els.progLen;
      api.attachDrag(els.drag, (ev) => {
        const f = angleToFraction(ev, els.drag, self.START, self.SWEEP, self.CY);
        return clampMinutes(f * config.max_minutes, config);
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      els.acd.classList.toggle("running", snap.running || snap.paused);
      els.acd.classList.toggle("pulse", snap.pulse);
      els.prog.style.strokeDashoffset = els.progLen * (1 - snap.frac);
      const end = this.START + snap.frac * this.SWEEP;
      const k = polarToCartesian(100, 100, this.R, end);
      els.knob.setAttribute("cx", k.x);
      els.knob.setAttribute("cy", k.y);
      paintShared(els, snap);
    },
  },

  stepper: {
    label: "Minimal stepper",
    PRESETS: [5, 15, 25, 60],
    css: `
      .acd-stepper .time { font-size:3rem; margin:6px 0 14px; }
      .acd-stepper .sline { position:relative; height:6px; border-radius:999px; background:var(--act-track-dark);
        margin:0 0 18px; box-shadow:inset 0 1px 3px rgba(0,0,0,.5); }
      .acd-stepper .sline-fill { position:absolute; top:0; bottom:0; left:0; border-radius:999px;
        background:var(--act-active); box-shadow:0 0 10px var(--act-accent-glow); transition:width .4s ease; }
      .acd-stepper .sline-dot { position:absolute; top:50%; width:14px; height:14px; border-radius:50%;
        background:var(--act-accent-strong); transform:translate(-50%,-50%); box-shadow:0 0 10px var(--act-accent-glow);
        transition:left .4s ease; }
      .acd-stepper .controls { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
      .acd-stepper .slider { flex:1; accent-color:var(--act-accent); }
      .acd-stepper .step-btn { width:46px; height:46px; border-radius:16px; cursor:pointer; font-size:1.5rem;
        line-height:1; font-family:inherit; color:var(--act-text); background:var(--act-btn-bg);
        border:1px solid var(--act-btn-border); box-shadow:0 2px 6px rgba(0,0,0,.3); }
      .acd-stepper .presets { display:flex; gap:8px; margin-bottom:16px; }
      .acd-stepper .preset { flex:1; padding:9px 0; border-radius:14px; cursor:pointer; font-size:.85rem;
        font-family:inherit; color:var(--act-text-2); background:var(--act-btn-bg); border:1px solid var(--act-btn-border); }
      .acd-stepper .preset.sel { color:var(--act-accent); border-color:var(--act-accent);
        background:color-mix(in srgb, var(--act-accent) 14%, transparent); }
      .acd-stepper .start { display:flex; align-items:center; justify-content:center; gap:8px; width:100%;
        border:none; border-radius:18px; padding:14px; font-size:1rem; font-weight:600; cursor:pointer;
        font-family:inherit; color:#08120A;
        background:linear-gradient(135deg, var(--act-accent-strong), var(--act-accent));
        box-shadow:0 6px 18px var(--act-accent-glow); }
      .acd-stepper .start ha-icon { --mdc-icon-size:20px; }
    `,
    html(config) {
      const init = clampMinutes(Math.min(Math.max(config.min_minutes, 30), config.max_minutes), config);
      const presets = this.PRESETS.filter((p) => p >= config.min_minutes && p <= config.max_minutes)
        .map((p) => `<button class="preset" data-min="${p}" aria-label="${p} minutes">${p}</button>`)
        .join("");
      return `<div class="acd acd-stepper">
        ${headHtml(config)}
        <div class="time" id="big">00:00:00</div>
        <div class="sline"><div class="sline-fill" id="fill"></div><div class="sline-dot" id="dot"></div></div>
        <div class="controls">
          <button class="step-btn" id="minus" aria-label="Decrease time">−</button>
          <input class="slider" id="slider" type="range" min="${config.min_minutes}" max="${config.max_minutes}" step="${config.step}" value="${init}" aria-label="Set minutes">
          <button class="step-btn" id="plus" aria-label="Increase time">+</button>
        </div>
        <div class="presets" id="presets">${presets}</div>
        <button class="start" id="start" aria-label="Start session"><ha-icon icon="mdi:play"></ha-icon><span id="startlbl">Start session</span></button>
        ${endsHtml(config)}
        ${cancelHtml()}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["big", "fill", "dot", "slider", "minus", "plus", "presets", "start", "startlbl", "ends", "cancel", "acd|.acd"]);
      const cur = () => clampMinutes(Number(els.slider.value), config);
      const setVal = (m) => {
        els.slider.value = clampMinutes(m, config);
        api.setValue(Number(els.slider.value));
      };
      els.minus.addEventListener("click", () => setVal(cur() - config.step));
      els.plus.addEventListener("click", () => setVal(cur() + config.step));
      els.slider.addEventListener("input", () => api.setValue(cur()));
      els.presets.querySelectorAll(".preset").forEach((b) =>
        b.addEventListener("click", () => setVal(Number(b.dataset.min)))
      );
      els.start.addEventListener("click", () => {
        if (api.isRunning()) api.pause();
        else if (api.isPaused()) api.resume();
        else api.commit(cur());
      });
      els.cancel.addEventListener("click", () => api.cancelTimer());
      return els;
    },
    paint(els, snap) {
      els.acd.classList.toggle("pulse", snap.pulse);
      els.fill.style.width = `${snap.frac * 100}%`;
      els.dot.style.left = `${snap.frac * 100}%`;
      if (!snap.running && !snap.paused) els.slider.value = snap.minutes;
      els.presets.querySelectorAll(".preset").forEach((b) =>
        b.classList.toggle("sel", Number(b.dataset.min) === snap.minutes && !snap.running)
      );
      const running = snap.running;
      els.startlbl.textContent = running ? "Pause session" : snap.paused ? "Resume" : "Start session";
      els.start.querySelector("ha-icon").setAttribute("icon", running ? "mdi:pause" : "mdi:play");
      els.start.setAttribute("aria-label", running ? "Pause session" : "Start session");
      paintShared(els, snap);
    },
  },
};

// Theme defaults + shared styles -------------------------------------------
const BASE_STYLES = `
  :host {
    --act-card-grad-start:#1D211D;
    --act-card-grad-end:#101310;
    --act-card-border:rgba(255,255,255,0.12);
    --act-text:#F5F7F2;
    --act-text-2:#9EA69A;
    --act-text-muted:#6F776E;
    --act-accent:#7ED957;
    --act-accent-strong:#A6FF4D;
    --act-accent-glow:color-mix(in srgb, var(--act-accent) 45%, transparent);
    --act-track:rgba(255,255,255,0.12);
    --act-track-dark:rgba(255,255,255,0.07);
    --act-btn-bg:rgba(255,255,255,0.06);
    --act-btn-border:rgba(255,255,255,0.14);
    --act-warning:#FFD166;
    --act-danger:#FF5C5C;
    --act-active:var(--act-accent);
  }
  ha-card {
    background:linear-gradient(160deg, var(--act-card-grad-start), var(--act-card-grad-end));
    border:1px solid var(--act-card-border);
    border-radius:24px;
    padding:26px;
    box-shadow:0 10px 34px rgba(0,0,0,0.38);
    color:var(--act-text);
  }
  .head { margin-bottom:4px; }
  .title { font-size:1.05rem; font-weight:700; color:var(--act-text); }
  .label { font-size:.82rem; font-weight:500; color:var(--act-text-2); margin-top:2px; }
  .time { text-align:center; font-size:2.6rem; font-weight:800; letter-spacing:.5px;
    font-variant-numeric:tabular-nums; color:var(--act-text); }
  .ends { text-align:center; font-size:.85rem; color:var(--act-text-2); margin-top:8px; }
  .status { display:flex; align-items:center; justify-content:center; gap:8px; font-size:.85rem; color:var(--act-text-2); }
  .status .dot { width:9px; height:9px; border-radius:50%; background:var(--act-active);
    box-shadow:0 0 8px var(--act-accent-glow); }
  .chips { display:flex; gap:10px; justify-content:center; margin-top:14px; }
  .chip { display:flex; align-items:center; gap:10px; padding:8px 14px; border-radius:16px;
    background:var(--act-btn-bg); border:1px solid var(--act-btn-border); }
  .chip .ic { width:30px; height:30px; border-radius:50%; background:rgba(0,0,0,0.3);
    display:flex; align-items:center; justify-content:center; --mdc-icon-size:17px; color:var(--act-accent); }
  .chip-l { display:block; font-size:.68rem; color:var(--act-text-muted); }
  .chip-v { display:block; font-size:.9rem; font-weight:600; color:var(--act-text); }
  .cancel-wrap { display:flex; justify-content:center; margin-top:16px; }
  .btn-cancel { border:1px solid var(--act-btn-border); border-radius:14px; padding:9px 28px; font-weight:600;
    cursor:pointer; font-family:inherit; background:transparent; color:var(--act-danger); }
  .hint { padding:26px 14px; text-align:center; font-size:.95rem; color:var(--act-text-2); }
  .acd.dragging .cap-fill, .acd.dragging .cap-dot, .acd.dragging .liquid,
  .acd.dragging .d-prog, .acd.dragging .d-knob,
  .acd.dragging .sline-fill, .acd.dragging .sline-dot { transition:none !important; }
  .acd.pulse .cap-dot, .acd.pulse .cap-fill, .acd.pulse .liquid,
  .acd.pulse .d-prog, .acd.pulse .d-knob, .acd.pulse .a-prog, .acd.pulse .a-dot,
  .acd.pulse .sline-fill, .acd.pulse .sline-dot { animation:actpulse 1s ease-in-out infinite; }
  @keyframes actpulse { 0%,100%{opacity:1} 50%{opacity:.55} }
  @keyframes actwave { 0%{transform:translateX(0)} 100%{transform:translateX(33%)} }
  @keyframes actbub { 0%{transform:translateY(0); opacity:0} 15%{opacity:.7} 100%{transform:translateY(-180px); opacity:0} }
  @media (prefers-reduced-motion: reduce) {
    .cap-fill,.cap-dot,.liquid,.d-prog,.a-prog,.sline-fill,.sline-dot { transition:none !important; }
    .acd.pulse *, .liquid::before, .bubble { animation:none !important; }
  }
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
    const d = this._config && this._config.design;
    return d === "dial" || d === "stepper" ? 5 : 4;
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
        if (ev.data && ev.data.entity_id === this._config.timer_entity) this._runFinishAction();
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
      let target = a.target;
      if (!target && a.entity_id) target = { entity_id: a.entity_id };
      this._hass.callService(domain, service, { ...(a.data || {}) }, target);
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
    if (s.state === "active" && s.attributes.finishes_at)
      return Math.max(0, Math.round((new Date(s.attributes.finishes_at).getTime() - Date.now()) / 1000));
    if (s.state === "paused" && s.attributes.remaining) return this._toSeconds(s.attributes.remaining);
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

  _snapshot() {
    const c = this._config;
    const running = this._isActive();
    const paused = this._isPaused();
    let minutes, frac, remainingSec, endsAtMs, mode;

    if (this._adjusting && this._pendingMinutes != null) {
      minutes = this._pendingMinutes;
      remainingSec = minutes * 60;
      frac = minutes / c.max_minutes;
      endsAtMs = Date.now() + remainingSec * 1000;
      mode = "adjusting";
    } else if (running || paused) {
      remainingSec = this._remainingSeconds();
      frac = remainingSec / Math.max(1, this._configuredSeconds());
      minutes = Math.ceil(remainingSec / 60);
      endsAtMs = running ? Date.now() + remainingSec * 1000 : null;
      mode = running ? "running" : "paused";
    } else {
      minutes = this._pendingMinutes != null ? this._pendingMinutes : this._lastIdleMinutes != null ? this._lastIdleMinutes : Math.min(30, c.max_minutes);
      remainingSec = minutes * 60;
      frac = minutes / c.max_minutes;
      endsAtMs = Date.now() + remainingSec * 1000;
      mode = "idle";
    }
    frac = Math.max(0, Math.min(1, frac));

    let status;
    if (mode === "running") status = remainingSec <= 10 ? "Almost done" : remainingSec <= 60 ? "Finishes soon" : "Running";
    else if (mode === "paused") status = "Paused";
    else if (mode === "adjusting") status = "Release to start";
    else status = "Ready";

    // active color (warning / danger thresholds) — all from the theme.
    let active = "var(--act-accent)";
    if (running && remainingSec <= 10) active = "var(--act-danger)";
    else if (running && remainingSec <= 60) active = "var(--act-warning)";
    this.shadowRoot.host.style.setProperty("--act-active", active);

    return {
      mode,
      running,
      paused,
      minutes,
      frac,
      remainingSec,
      hms: fmtHMS(remainingSec),
      endsAt: endsAtMs ? fmtClock(endsAtMs) : "",
      status,
      pulse: running && remainingSec <= 10,
    };
  }

  _makeApi() {
    const card = this;
    return {
      config: card._config,
      isRunning: () => card._isActive(),
      isPaused: () => card._isPaused(),
      attachDrag(el, calcMinutes) {
        const move = (ev) => card._setPending(calcMinutes(ev));
        const up = () => {
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
      pause() {
        card._hass.callService("timer", "pause", { entity_id: card._config.timer_entity });
      },
      resume() {
        card._hass.callService("timer", "start", { entity_id: card._config.timer_entity });
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
      duration: fmtHMS(minutes * 60),
    });
  }
  _cancelTimer() {
    this._hass.callService("timer", "cancel", { entity_id: this._config.timer_entity });
  }

  // ---- render ----
  _render() {
    const design = DESIGNS[this._config.design] || DESIGNS.bar;
    this._design = design;
    this.shadowRoot.innerHTML = `<style>${BASE_STYLES}\n${design.css}</style>
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
    const snap = this._snapshot();
    // Disable CSS transitions while dragging so the fill/handle tracks the
    // pointer with zero lag (important on touch). Transitions stay on for the
    // live countdown.
    if (this._designEls && this._designEls.acd) {
      this._designEls.acd.classList.toggle("dragging", snap.mode === "adjusting");
    }
    this._design.paint(this._designEls, snap, this._config);
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
const DESIGN_OPTIONS = Object.entries(DESIGNS).map(([value, d]) => ({ value, label: d.label }));

const EDITOR_SCHEMA = [
  { name: "timer_entity", selector: { entity: { domain: "timer" } } },
  { name: "design", selector: { select: { mode: "dropdown", options: DESIGN_OPTIONS } } },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "title", selector: { text: {} } },
      { name: "label", selector: { text: {} } },
    ],
  },
  { name: "direction", selector: { select: { mode: "dropdown", options: [
    { value: "rtl", label: "Right → Left" },
    { value: "ltr", label: "Left → Right" },
  ] } } },
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
    type: "expandable",
    title: "“Ends at” display",
    icon: "mdi:calendar-clock",
    schema: [
      { name: "ends_show", selector: { boolean: {} } },
      { name: "ends_width", selector: { select: { mode: "dropdown", options: [
        { value: "chip", label: "Small chip" },
        { value: "full", label: "Full width" },
      ] } } },
      { name: "ends_size", selector: { number: { min: 10, max: 48, mode: "slider", unit_of_measurement: "px" } } },
    ],
  },
  {
    name: "colors",
    type: "expandable",
    title: "Colors",
    icon: "mdi:palette",
    schema: [
      { name: "accent", selector: { color_rgb: {} } },
      { name: "accent_strong", selector: { color_rgb: {} } },
      { name: "card_grad_start", selector: { color_rgb: {} } },
      { name: "card_grad_end", selector: { color_rgb: {} } },
      { name: "card_border", selector: { color_rgb: {} } },
      { name: "text", selector: { color_rgb: {} } },
      { name: "text_secondary", selector: { color_rgb: {} } },
      { name: "track", selector: { color_rgb: {} } },
      { name: "warning", selector: { color_rgb: {} } },
      { name: "danger", selector: { color_rgb: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  timer_entity: "Timer entity",
  design: "Design",
  title: "Title",
  label: "Label",
  direction: "Direction",
  finish_action: "Action on finish",
  max_minutes: "Max minutes",
  min_minutes: "Min minutes",
  step: "Minute step",
  ends_show: "Show “Ends at”",
  ends_width: "“Ends at” width",
  ends_size: "“Ends at” text size",
  colors: "Colors",
  accent: "Timer color",
  accent_strong: "Glowing dot color",
  card_grad_start: "Card background — top",
  card_grad_end: "Card background — bottom",
  card_border: "Card outline",
  text: "Big time + title color",
  text_secondary: "Small text color",
  track: "Empty (unfilled) color",
  warning: "Last-minute color",
  danger: "Last-10-seconds color",
};

const EDITOR_HELPERS = {
  timer_entity: "The countdown timer this card controls. Pick one or create it in Settings → Helpers.",
  design: "Visual style of the timer.",
  title: "Name shown on the card.",
  label: "Small label under the title (e.g. Runs in).",
  direction: "Which side is zero for the bar fill.",
  finish_action: "Runs when the countdown ends.",
  max_minutes: "Longest time you can set.",
  min_minutes: "Shortest time that starts it.",
  step: "Drag snap, in minutes.",
  ends_show: "Show the end time under the bar.",
  ends_width: "A small chip, or a full-width row.",
  ends_size: "Font size of the end time, in pixels.",
  accent: "The main filled part — the bar fill, the ring, or the liquid.",
  accent_strong: "The bright dot at the tip of the fill, and its glow.",
  card_grad_start: "Top color of the card background.",
  card_grad_end: "Bottom color of the card background (makes the gradient).",
  card_border: "The thin line around the whole card.",
  text: "The big countdown digits and the card title.",
  text_secondary: "The label under the title, “Ends at”, and the status text.",
  track: "The empty part of the bar/ring that isn't filled yet.",
  warning: "The fill turns this color when under 1 minute is left.",
  danger: "The fill turns this color when under 10 seconds are left.",
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
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: this._config },
          bubbles: true,
          composed: true,
        }));
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
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: ev.detail.value },
          bubbles: true,
          composed: true,
        }));
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
  description: "A premium drag-to-set countdown timer with multiple designs, full color control, and a configurable finish action.",
  preview: false,
});

console.info(
  `%c AC-TIMER-CARD %c v${CARD_VERSION} `,
  "color: white; background: #7ED957; font-weight: 700;",
  "color: #7ED957; background: #1c1c1c;"
);
