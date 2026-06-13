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

const CARD_VERSION = "1.14.1";

const DEFAULT_CONFIG = {
  design: "bar",
  style: "none",
  title: "AC Shutoff Timer",
  label: "Runs in",
  label_show: true,
  direction: "rtl", // rtl = 0 on the right (default), ltr = 0 on the left
  handle_style: "pill", // bar leading-edge marker: none|line|pill|dot|ring|diamond|glow
  scale: "even", // position<->minutes mapping: even|short|strong
  slide_hint: "Slide ←",
  slide_hint_show: true,
  max_minutes: 120,
  min_minutes: 1,
  step: 1,
  presets: ["15", "30", "45", "60"],
  presets_show: true,
  ends_show: true,
  ends_label: "Ends at",
  ends_icon: "mdi:calendar-clock",
  ends_icon_show: true,
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
  ends_time: "--act-ends-time",
  ends_icon_color: "--act-ends-icon",
  preset_text: "--act-preset-text",
  preset_bg: "--act-preset-bg",
  preset_border: "--act-preset-border",
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

// Non-linear position<->minutes mapping. `minutes = max * pos^k`, so larger k
// makes short durations occupy more of the bar (and 3-4h compress at the end).
const SCALE_CURVES = { even: 1, short: 2.2, strong: 3 };
function curveK(c) {
  return SCALE_CURVES[c.scale] || 1;
}
function posToMinutes(ratio, c) {
  ratio = Math.max(0, Math.min(1, ratio));
  return c.max_minutes * Math.pow(ratio, curveK(c));
}
function minutesToPos(minutes, c) {
  const max = c.max_minutes || 1;
  return Math.pow(Math.max(0, Math.min(1, minutes / max)), 1 / curveK(c));
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
  const show = config.label_show !== false && config.label;
  const label = show ? `<div class="label" dir="auto">${escapeHtml(config.label)}</div>` : "";
  return `<div class="head"><div class="title" dir="auto">${escapeHtml(config.title)}</div>${label}</div>`;
}
// "<label> HH:MM" with a custom prefix and the time in its own color.
// dir="auto" on the container makes Hebrew labels flow right-to-left correctly.
function endsMarkup(endsAt, config) {
  if (!endsAt) return "";
  const label = config && config.ends_label != null ? config.ends_label : "Ends at";
  const prefix = label ? `${escapeHtml(label)} ` : "";
  return `${prefix}<span class="ends-time">${endsAt}</span>`;
}
function endsHtml(config) {
  if (config && config.ends_show === false) return "";
  return `<div class="ends" id="ends" dir="auto"></div>`;
}
// Horizontal-bar "Ends at" element with user-chosen size, width, and icon.
function barEndsHtml(config) {
  if (config.ends_show === false) return "";
  const full = config.ends_width === "full";
  const fs = Number(config.ends_size) || 13;
  const icon =
    config.ends_icon_show !== false && config.ends_icon
      ? `<span class="ic"><ha-icon icon="${escapeHtml(config.ends_icon)}"></ha-icon></span>`
      : "";
  return `<div class="ends-row"><div class="ends-box${full ? " full" : ""}" id="endsbox" dir="auto" style="font-size:${fs}px">${icon}<span id="endsv">—</span></div></div>`;
}
function statusHtml() {
  return `<div class="status"><span class="dot" id="sdot"></span><span id="stext"></span></div>`;
}

// Ambient animation styles, layered behind the timer for ANY design.
const STYLES = ["none", "bubbles", "air", "aurora", "particles", "frost"];
const STYLE_LABELS = {
  none: "None",
  bubbles: "Bubbles",
  air: "Flowing air",
  aurora: "Aurora glow",
  particles: "Floating particles",
  frost: "Frost",
};
function fxHtml(config) {
  const s = config.style || "none";
  if (s === "none" || !STYLES.includes(s)) return "";
  const span = (style) => `<span class="p" style="${style}"></span>`;
  let inner = "";
  if (s === "bubbles") {
    for (let i = 0; i < 7; i++)
      inner += span(`left:${8 + i * 13}%;animation-delay:${(i * 0.7).toFixed(1)}s;animation-duration:${4 + (i % 3)}s`);
  } else if (s === "air") {
    for (let i = 0; i < 7; i++)
      inner += span(`top:${8 + i * 12}%;width:${40 + (i % 3) * 12}%;animation-delay:${(i * 0.5).toFixed(1)}s;animation-duration:${3.5 + (i % 3) * 0.8}s`);
  } else if (s === "aurora") {
    inner = `${span("")}${span("")}${span("")}`;
  } else if (s === "particles") {
    for (let i = 0; i < 12; i++)
      inner += span(`left:${(i * 8.3) % 100}%;top:${(i * 17) % 100}%;animation-delay:${(i * 0.5).toFixed(1)}s;animation-duration:${6 + (i % 4)}s`);
  } else if (s === "frost") {
    for (let i = 0; i < 9; i++)
      inner += span(`left:${(i * 11) % 100}%;animation-delay:${(i * 0.6).toFixed(1)}s;animation-duration:${6 + (i % 3)}s`);
  }
  return `<div class="fx fx-${s}">${inner}</div>`;
}
function cancelHtml() {
  return `<div class="cancel-wrap"><button class="btn-cancel" id="cancel" aria-label="Cancel timer">Cancel</button></div>`;
}

// User-defined favorite times -> a clean, deduped, in-range list of minutes.
function parsePresets(config) {
  let list = config.presets;
  if (typeof list === "string") list = list.split(/[^0-9.]+/);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const v = Math.round(Number(raw));
    if (!isNaN(v) && v > 0) out.push(clampMinutes(v, config));
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}
// A symmetric row of quick-start "favorite time" chips, shared by every design.
function presetsHtml(config) {
  if (config.presets_show === false) return "";
  const list = parsePresets(config);
  if (!list.length) return "";
  return `<div class="presets" id="presets">${list
    .map((m) => `<button class="preset" data-min="${m}" aria-label="${m} minutes">${m}<span class="preset-u">m</span></button>`)
    .join("")}</div>`;
}

function paintShared(els, snap, config) {
  if (els.big) els.big.textContent = snap.hms;
  if (els.ends) els.ends.innerHTML = endsMarkup(snap.endsAt, config);
  if (els.stext) els.stext.textContent = snap.status;
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
      .acd-bar .cap-handle { position:absolute; top:50%; transform:translateY(-50%); z-index:3;
        pointer-events:none; transition:right .45s ease, left .45s ease; }
      .acd-bar .h-none { display:none; }
      .acd-bar .h-line { width:3px; height:66%; border-radius:3px; background:var(--act-accent-strong);
        box-shadow:0 0 10px var(--act-accent-glow); }
      .acd-bar .h-pill { width:8px; height:84%; border-radius:999px; background:var(--act-accent-strong);
        box-shadow:0 0 12px var(--act-accent-glow); }
      .acd-bar .h-dot { width:22px; height:22px; border-radius:50%;
        background:radial-gradient(circle at 35% 35%, var(--act-accent-strong), var(--act-active));
        box-shadow:0 0 10px var(--act-accent-glow); }
      .acd-bar .h-ring { width:20px; height:20px; border-radius:50%; background:transparent; box-sizing:border-box;
        border:3px solid var(--act-accent-strong); box-shadow:0 0 10px var(--act-accent-glow); }
      .acd-bar .h-diamond { width:15px; height:15px; background:var(--act-accent-strong);
        box-shadow:0 0 10px var(--act-accent-glow); transform:translateY(-50%) rotate(45deg); }
      .acd-bar .h-glow { width:32px; height:32px; border-radius:50%; background:radial-gradient(circle,
        var(--act-accent-strong) 0%, color-mix(in srgb, var(--act-accent-strong) 30%, transparent) 45%, transparent 72%); }
      .acd-bar .cap-hint { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
        pointer-events:none; z-index:2; opacity:0; transition:opacity .3s; }
      .acd-bar.idle .cap-hint { opacity:1; }
      .acd-bar .cap-hint span { font-size:.78rem; letter-spacing:4px; font-weight:600;
        background:linear-gradient(90deg, color-mix(in srgb, var(--act-text-2) 25%, transparent) 0%,
          var(--act-text) 50%, color-mix(in srgb, var(--act-text-2) 25%, transparent) 100%);
        background-size:220% 100%; -webkit-background-clip:text; background-clip:text; color:transparent;
        animation:cap-shim 1.5s linear infinite; }
      @keyframes cap-shim { 0%{background-position:220% 0} 100%{background-position:-220% 0} }
      .acd-bar .ends-row { display:flex; justify-content:center; margin-top:14px; }
      .acd-bar .ends-box { display:inline-flex; align-items:center; gap:10px; padding:9px 16px; border-radius:16px;
        background:var(--act-btn-bg); border:1px solid var(--act-btn-border); color:var(--act-text-2); }
      .acd-bar .ends-box.full { display:flex; width:100%; justify-content:center; }
      .acd-bar .ends-box .ic { width:28px; height:28px; border-radius:50%; background:rgba(0,0,0,.3);
        display:flex; align-items:center; justify-content:center; color:var(--act-ends-icon); --mdc-icon-size:16px; flex:none; }
    `,
    html(config) {
      return `<div class="acd acd-bar">
        ${headHtml(config)}
        <div class="cap" id="drag">
          <div class="cap-track"></div>
          <div class="cap-fill" id="fill"><div class="cap-hl"></div>${fxHtml(config)}</div>
          <div class="cap-handle h-${config.handle_style || "pill"}" id="dot"></div>
          ${
            config.slide_hint_show !== false && config.slide_hint
              ? `<div class="cap-hint"><span dir="auto">${escapeHtml(config.slide_hint)}</span></div>`
              : ""
          }
        </div>
        <div class="time" id="big">00:00:00</div>
        ${barEndsHtml(config)}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "fill", "dot", "big", "endsv", "acd|.acd"]);
      const rtl = config.direction !== "ltr";
      api.attachDrag(els.drag, (ev) => {
        const rect = els.drag.getBoundingClientRect();
        const raw = rtl ? rect.right - ev.clientX : ev.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, raw / rect.width));
        return clampMinutes(posToMinutes(ratio, config), config);
      });
      return els;
    },
    paint(els, snap, config) {
      const rtl = config.direction !== "ltr";
      els.acd.classList.toggle("running", snap.running || snap.paused);
      els.acd.classList.toggle("pulse", snap.pulse);
      els.acd.classList.toggle("idle", snap.mode === "idle");
      els.fill.style.width = `${snap.frac * 100}%`;

      // Center the chosen handle on the fill's leading edge, clamped so it stays
      // fully inside the track — at 0 it rests exactly on the zero line.
      const capW = els.drag.getBoundingClientRect().width || 1;
      const half = (els.dot.offsetWidth || 0) / 2;
      const center = Math.max(half, Math.min(capW - half, snap.frac * capW));
      const edge = center - half;
      if (rtl) {
        els.fill.style.right = "0";
        els.fill.style.left = "auto";
        els.dot.style.right = `${edge}px`;
        els.dot.style.left = "auto";
      } else {
        els.fill.style.left = "0";
        els.fill.style.right = "auto";
        els.dot.style.left = `${edge}px`;
        els.dot.style.right = "auto";
      }
      if (els.endsv) els.endsv.innerHTML = snap.endsAt ? endsMarkup(snap.endsAt, config) : "—";
      paintShared(els, snap, config);
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
              <div class="liquid" id="fill">${fxHtml(config)}</div>
          </div>
          <div class="vscale"><span>Full</span><span>Half</span><span>Low</span></div>
        </div>
        <div class="time" id="big">00:00:00</div>
        ${endsHtml(config)}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "fill", "big", "ends", "acd|.acd"]);
      api.attachDrag(els.drag, (ev) => {
        const rect = els.drag.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (rect.bottom - ev.clientY) / rect.height));
        return clampMinutes(posToMinutes(ratio, config), config);
      });
      return els;
    },
    paint(els, snap, config) {
      els.acd.classList.toggle("running", snap.running || snap.paused);
      els.acd.classList.toggle("pulse", snap.pulse);
      els.fill.style.height = `${snap.frac * 100}%`;
      paintShared(els, snap, config);
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
          ${fxHtml(config)}
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
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["drag", "prog", "knob", "big", "ends", "sdot", "stext", "acd|.acd"]);
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
        return clampMinutes(posToMinutes(f, config), config);
      });
      return els;
    },
    paint(els, snap, config) {
      els.acd.classList.toggle("running", snap.running || snap.paused);
      els.acd.classList.toggle("pulse", snap.pulse);
      els.prog.style.strokeDashoffset = els.progLen * (1 - snap.frac);
      const end = this.START + snap.frac * this.SWEEP;
      const k = polarToCartesian(100, 100, this.R, end);
      els.knob.setAttribute("cx", k.x);
      els.knob.setAttribute("cy", k.y);
      paintShared(els, snap, config);
    },
  },

  stepper: {
    label: "Minimal stepper",
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
      .acd-stepper .start { display:flex; align-items:center; justify-content:center; gap:8px; width:100%;
        border:none; border-radius:18px; padding:14px; font-size:1rem; font-weight:600; cursor:pointer;
        font-family:inherit; color:#0B1020;
        background:linear-gradient(135deg, var(--act-accent-strong), var(--act-accent));
        box-shadow:0 6px 18px var(--act-accent-glow); }
      .acd-stepper .start ha-icon { --mdc-icon-size:20px; }
    `,
    html(config) {
      const init = clampMinutes((config.min_minutes + config.max_minutes) / 2, config);
      return `<div class="acd acd-stepper">
        ${headHtml(config)}
        <div class="time" id="big">00:00:00</div>
        <div class="sline"><div class="sline-fill" id="fill">${fxHtml(config)}</div><div class="sline-dot" id="dot"></div></div>
        <div class="controls">
          <button class="step-btn" id="minus" aria-label="Decrease time">−</button>
          <input class="slider" id="slider" type="range" min="${config.min_minutes}" max="${config.max_minutes}" step="${config.step}" value="${init}" aria-label="Set minutes">
          <button class="step-btn" id="plus" aria-label="Increase time">+</button>
        </div>
        <button class="start" id="start" aria-label="Start session"><ha-icon icon="mdi:play"></ha-icon><span id="startlbl">Start session</span></button>
        ${endsHtml(config)}
      </div>`;
    },
    wire(root, api, config) {
      const els = grabEls(root, ["big", "fill", "dot", "slider", "minus", "plus", "start", "startlbl", "ends", "acd|.acd"]);
      const cur = () => clampMinutes(Number(els.slider.value), config);
      const setVal = (m) => {
        els.slider.value = clampMinutes(m, config);
        api.setValue(Number(els.slider.value));
      };
      els.minus.addEventListener("click", () => setVal(cur() - config.step));
      els.plus.addEventListener("click", () => setVal(cur() + config.step));
      els.slider.addEventListener("input", () => api.setValue(cur()));
      els.start.addEventListener("click", () => {
        if (api.isRunning()) api.pause();
        else if (api.isPaused()) api.resume();
        else api.commit(cur());
      });
      return els;
    },
    paint(els, snap, config) {
      els.acd.classList.toggle("pulse", snap.pulse);
      els.fill.style.width = `${snap.frac * 100}%`;
      els.dot.style.left = `${snap.frac * 100}%`;
      // Keep the slider resting at its middle default until the user picks a
      // value; only mirror snap.minutes once there's a pending selection.
      if (!snap.running && !snap.paused && snap.hasPending) els.slider.value = snap.minutes;
      const running = snap.running;
      els.startlbl.textContent = running ? "Pause session" : snap.paused ? "Resume" : "Start session";
      els.start.querySelector("ha-icon").setAttribute("icon", running ? "mdi:pause" : "mdi:play");
      els.start.setAttribute("aria-label", running ? "Pause session" : "Start session");
      paintShared(els, snap, config);
    },
  },
};

// Theme defaults + shared styles -------------------------------------------
const BASE_STYLES = `
  :host {
    /* Default theme — Blue Gray gradient matching the "turn off AC" button. */
    --act-card-grad-start:#202434;
    --act-card-grad-end:#465878;
    --act-card-border:rgba(255,255,255,0.12);
    --act-text:#EBEBF3;
    --act-text-2:#AEB6C6;
    --act-text-muted:#7E879A;
    --act-accent:#9B6FD4;
    --act-accent-strong:#C9A8FF;
    --act-accent-glow:color-mix(in srgb, var(--act-accent) 45%, transparent);
    --act-track:rgba(255,255,255,0.10);
    --act-track-dark:rgba(255,255,255,0.05);
    --act-btn-bg:rgba(255,255,255,0.05);
    --act-btn-border:rgba(255,255,255,0.12);
    --act-warning:#F2C14E;
    --act-danger:#E2685F;
    --act-ends-time:var(--act-accent);
    --act-ends-icon:var(--act-accent);
    --act-preset-text:var(--act-text);
    --act-preset-bg:var(--act-btn-bg);
    --act-preset-border:var(--act-btn-border);
    --act-active:var(--act-accent);
  }
  ha-card {
    position:relative;
    background:linear-gradient(135deg, var(--act-card-grad-start), var(--act-card-grad-end));
    border:1px solid var(--act-card-border);
    border-radius:24px;
    padding:26px;
    box-shadow:0 10px 34px rgba(0,0,0,0.38);
    color:var(--act-text);
    overflow:hidden;
  }
  #root { position:relative; z-index:1; }
  .head { margin-bottom:4px; }
  .title { font-size:1.05rem; font-weight:700; color:var(--act-text); }
  .label { font-size:.82rem; font-weight:500; color:var(--act-text-2); margin-top:2px; }
  .time { text-align:center; font-size:2.6rem; font-weight:800; letter-spacing:.5px;
    font-variant-numeric:tabular-nums; color:var(--act-text); }
  .ends { text-align:center; font-size:.85rem; color:var(--act-text-2); margin-top:8px; }
  .ends-time { color:var(--act-ends-time); font-weight:700; }
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
  .presets { display:flex; gap:8px; margin-top:14px; }
  .preset { flex:1; display:flex; align-items:baseline; justify-content:center; gap:2px; padding:10px 0;
    border-radius:14px; cursor:pointer; font-size:1rem; font-weight:700; font-family:inherit;
    color:var(--act-preset-text); background:var(--act-preset-bg); border:1px solid var(--act-preset-border); transition:all .15s; }
  .preset:hover { border-color:var(--act-accent); }
  .preset .preset-u { font-size:.62rem; font-weight:500; opacity:.7; }
  .preset.sel { color:var(--act-accent); border-color:var(--act-accent);
    background:color-mix(in srgb, var(--act-accent) 14%, transparent); }
  .preset.sel .preset-u { color:var(--act-accent); }
  .cancel-wrap { display:flex; justify-content:center; margin-top:16px; }
  .btn-cancel { border:1px solid var(--act-btn-border); border-radius:14px; padding:9px 28px; font-weight:600;
    cursor:pointer; font-family:inherit; background:transparent; color:var(--act-danger); }
  .hint { padding:26px 14px; text-align:center; font-size:.95rem; color:var(--act-text-2); }
  .acd.dragging .cap-fill, .acd.dragging .cap-handle, .acd.dragging .liquid,
  .acd.dragging .d-prog, .acd.dragging .d-knob,
  .acd.dragging .sline-fill, .acd.dragging .sline-dot { transition:none !important; }
  .acd.pulse .cap-handle, .acd.pulse .cap-fill, .acd.pulse .liquid,
  .acd.pulse .d-prog, .acd.pulse .d-knob, .acd.pulse .a-prog, .acd.pulse .a-dot,
  .acd.pulse .sline-fill, .acd.pulse .sline-dot { animation:actpulse 1s ease-in-out infinite; }
  @keyframes actpulse { 0%,100%{opacity:1} 50%{opacity:.55} }
  @keyframes actwave { 0%{transform:translateX(0)} 100%{transform:translateX(33%)} }

  /* ---- Ambient style overlays (apply to any design) ---- */
  /* The FX layer lives INSIDE each design's slider/track element and is
     clipped to its shape. Effects are host-relative so they fit any size. */
  .fx { position:absolute; inset:0; overflow:hidden; border-radius:inherit; pointer-events:none; }
  .fx .p { position:absolute; }
  /* Bubbles — accent bubbles rising through the slider */
  .fx-bubbles .p { width:8px; height:8px; border-radius:50%; background:var(--act-accent);
    opacity:.22; filter:blur(.4px); animation:fxrise linear infinite; }
  @keyframes fxrise { 0%{bottom:-20%;opacity:0} 20%{opacity:.28} 100%{bottom:120%;opacity:0} }
  /* Flowing air — bright breeze streaks (AC running). Uses a lighter tint than
     the fill so it stays visible against the accent-colored fill. */
  .fx-air .p { height:4px; border-radius:4px; opacity:.7; filter:blur(.4px);
    background:linear-gradient(90deg, transparent, var(--act-accent-strong), #ffffff 50%, var(--act-accent-strong), transparent);
    mix-blend-mode:screen; animation:fxair linear infinite; }
  @keyframes fxair { 0%{left:-45%;opacity:0} 15%{opacity:.85} 85%{opacity:.85} 100%{left:120%;opacity:0} }
  /* Aurora — slow shifting gradient sheen */
  .fx-aurora .p { width:80%; height:170%; border-radius:50%; filter:blur(18px); opacity:.25; animation:fxaurora ease-in-out infinite; }
  .fx-aurora .p:nth-child(1){ top:-35%; left:-12%; background:var(--act-accent); animation-duration:11s; }
  .fx-aurora .p:nth-child(2){ bottom:-40%; right:-12%; background:var(--act-accent-strong); animation-duration:14s; animation-delay:-3s; }
  .fx-aurora .p:nth-child(3){ top:0; right:15%; background:var(--act-accent); animation-duration:17s; animation-delay:-7s; }
  @keyframes fxaurora { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(14%,6%) scale(1.2)} }
  /* Floating particles — ambient motes */
  .fx-particles .p { width:4px; height:4px; border-radius:50%; background:var(--act-accent-strong);
    opacity:.22; animation:fxfloat ease-in-out infinite; }
  @keyframes fxfloat { 0%{transform:translate(0,0);opacity:0} 25%{opacity:.3} 75%{opacity:.3} 100%{transform:translate(10px,-26px);opacity:0} }
  /* Frost — soft specks drifting down (cool air) */
  .fx-frost .p { width:6px; height:6px; border-radius:50%; background:#fff; opacity:.2; filter:blur(.4px);
    animation:fxfall linear infinite; }
  @keyframes fxfall { 0%{top:-20%;opacity:0} 20%{opacity:.26} 100%{top:120%;opacity:0} }
  /* The FX lives INSIDE the colored fill, so the animation only plays on the
     progressing line and shrinks with it; the static track stays clean. */
  .acd-bar .cap-track { z-index:0; } .acd-bar .cap-fill { z-index:1; }
  .acd-vertical .liquid { z-index:1; overflow:hidden; }
  .acd-stepper .sline-fill { z-index:1; overflow:hidden; } .acd-stepper .sline-dot { z-index:3; }
  .acd-dial svg { position:relative; z-index:1; } .acd-dial .center { z-index:2; }
  .acd-dial .fx { z-index:0; -webkit-mask:radial-gradient(circle closest-side at 50% 50%, transparent 0 66%, #000 71% 86%, transparent 91%);
    mask:radial-gradient(circle closest-side at 50% 50%, transparent 0 66%, #000 71% 86%, transparent 91%); }

  @media (prefers-reduced-motion: reduce) {
    .cap-fill,.cap-handle,.liquid,.d-prog,.d-knob,.sline-fill,.sline-dot { transition:none !important; }
    .acd.pulse .cap-handle,.acd.pulse .cap-fill,.acd.pulse .liquid,.acd.pulse .d-prog,.acd.pulse .d-knob,
    .acd.pulse .sline-fill,.acd.pulse .sline-dot,
    .liquid::before, .fx .p, .cap-hint span { animation:none !important; }
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
    // When the timer returns to idle (cancelled or finished), forget any pending
    // value so the card resets to a clean zero instead of the last-set position.
    const running = this._isActive() || this._isPaused();
    if (this._wasRunning && !running && !this._adjusting) this._pendingMinutes = null;
    this._wasRunning = running;
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

  // ---- finish action ----
  _hasFinish() {
    return !!(this._config && (this._config.finish_entity || this._config.finish_action));
  }
  _maybeSubscribeFinish() {
    if (this._eventUnsub) return;
    if (!this._hasFinish()) return;
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
    // Simple path: a picked script / scene / automation entity.
    const ent = this._config.finish_entity;
    if (ent && ent.includes(".")) {
      const domain = ent.split(".")[0];
      const service = domain === "automation" ? "trigger" : "turn_on";
      this._hass.callService(domain, service, {}, { entity_id: ent });
    }
    // Advanced path: explicit service-call action(s) via YAML.
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
      frac = minutesToPos(minutes, c);
      endsAtMs = Date.now() + remainingSec * 1000;
      mode = "adjusting";
    } else if (running || paused) {
      remainingSec = this._remainingSeconds();
      // Absolute scale: the fill maps remaining minutes onto the 0..max range,
      // so a timer started at 60 (of 120) begins at the 60 mark and counts down
      // from there — it stays where the handle was released.
      frac = minutesToPos(remainingSec / 60, c);
      minutes = Math.ceil(remainingSec / 60);
      endsAtMs = running ? Date.now() + remainingSec * 1000 : null;
      mode = running ? "running" : "paused";
    } else if (this._pendingMinutes != null) {
      // user picked a value but hasn't started yet
      minutes = this._pendingMinutes;
      remainingSec = minutes * 60;
      frac = minutesToPos(minutes, c);
      endsAtMs = Date.now() + remainingSec * 1000;
      mode = "idle";
    } else {
      // untouched idle — start clean at zero, no projected end time
      minutes = 0;
      remainingSec = 0;
      frac = 0;
      endsAtMs = null;
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
      hasPending: this._pendingMinutes != null,
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
        <div id="root">
          ${design.html(this._config)}
          ${presetsHtml(this._config)}
          ${cancelHtml()}
        </div>
      </ha-card>`;
    this._applyColors();
    this._hintEl = this.shadowRoot.getElementById("hint");
    this._rootWrap = this.shadowRoot.getElementById("root");
    this._designEls = design.wire(this.shadowRoot, this._makeApi(), this._config);

    // Shared, design-agnostic controls: favorite-time presets + cancel.
    this._cancelEl = this.shadowRoot.getElementById("cancel");
    if (this._cancelEl) this._cancelEl.addEventListener("click", () => this._cancelTimer());
    this._presetEls = Array.from(this.shadowRoot.querySelectorAll(".preset"));
    for (const b of this._presetEls) {
      b.addEventListener("click", () => {
        this._pendingMinutes = clampMinutes(Number(b.dataset.min), this._config);
        this._commit();
      });
    }
    this._updateView();
  }
  _applyColors() {
    const colors = this._config.colors || {};
    const host = this.shadowRoot.host;
    for (const [slot, cssVar] of Object.entries(COLOR_VARS)) {
      // Color may live under `colors:` (Colors section) or at the top level
      // (the contextual pickers in Appearance / Favorite times).
      const raw = colors[slot] != null ? colors[slot] : this._config[slot];
      const css = colorToCss(raw);
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

    // Shared controls: cancel visibility + highlight the active favorite.
    if (this._cancelEl) this._cancelEl.style.display = snap.running || snap.paused ? "" : "none";
    if (this._presetEls && this._presetEls.length) {
      const activeMin = snap.running || snap.paused ? Math.round(this._configuredSeconds() / 60) : null;
      for (const b of this._presetEls) {
        b.classList.toggle("sel", activeMin != null && Number(b.dataset.min) === activeMin);
      }
    }
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
const STYLE_OPTIONS = STYLES.map((value) => ({ value, label: STYLE_LABELS[value] }));

// Editor layout: a few essentials up top, the rest grouped into clearly
// titled, collapsible sections (the convention for HA custom-card editors).
const EDITOR_SCHEMA = [
  { name: "timer_entity", selector: { entity: { domain: "timer" } } },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "design", selector: { select: { mode: "dropdown", options: DESIGN_OPTIONS } } },
      { name: "style", selector: { select: { mode: "dropdown", options: STYLE_OPTIONS } } },
    ],
  },
  { name: "finish_entity", selector: { entity: { domain: ["script", "scene", "automation"] } } },
  {
    type: "expandable",
    title: "Appearance",
    icon: "mdi:eye-outline",
    schema: [
      { name: "title", selector: { text: {} } },
      { name: "label_show", selector: { boolean: {} } },
      { name: "label", selector: { text: {} } },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "direction", selector: { select: { mode: "dropdown", options: [
            { value: "rtl", label: "Right → Left" },
            { value: "ltr", label: "Left → Right" },
          ] } } },
          { name: "handle_style", selector: { select: { mode: "dropdown", options: [
            { value: "none", label: "None" },
            { value: "line", label: "Line" },
            { value: "pill", label: "Pill" },
            { value: "dot", label: "Dot" },
            { value: "ring", label: "Ring" },
            { value: "diamond", label: "Diamond" },
            { value: "glow", label: "Glow" },
          ] } } },
        ],
      },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "slide_hint_show", selector: { boolean: {} } },
          { name: "slide_hint", selector: { text: {} } },
        ],
      },
      { name: "ends_show", selector: { boolean: {} } },
      { name: "ends_label", selector: { text: {} } },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "ends_width", selector: { select: { mode: "dropdown", options: [
            { value: "chip", label: "Small chip" },
            { value: "full", label: "Full width" },
          ] } } },
          { name: "ends_size", selector: { number: { min: 10, max: 48, mode: "slider", unit_of_measurement: "px" } } },
        ],
      },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "ends_icon_show", selector: { boolean: {} } },
          { name: "ends_icon", selector: { icon: {} } },
        ],
      },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "ends_time", selector: { color_rgb: {} } },
          { name: "ends_icon_color", selector: { color_rgb: {} } },
        ],
      },
    ],
  },
  {
    type: "expandable",
    title: "Timing",
    icon: "mdi:timer-cog-outline",
    schema: [
      {
        name: "",
        type: "grid",
        schema: [
          { name: "max_minutes", selector: { number: { min: 1, max: 1440, mode: "box", unit_of_measurement: "min" } } },
          { name: "min_minutes", selector: { number: { min: 1, max: 240, mode: "box", unit_of_measurement: "min" } } },
          { name: "step", selector: { number: { min: 1, max: 60, mode: "box", unit_of_measurement: "min" } } },
        ],
      },
      { name: "scale", selector: { select: { mode: "dropdown", options: [
        { value: "even", label: "Even (linear)" },
        { value: "short", label: "Favor short times" },
        { value: "strong", label: "Strongly favor short" },
      ] } } },
    ],
  },
  {
    type: "expandable",
    title: "Favorite times",
    icon: "mdi:star-outline",
    schema: [
      { name: "presets_show", selector: { boolean: {} } },
      { name: "presets", selector: { select: { multiple: true, custom_value: true, options: [
        { value: "5", label: "5" }, { value: "10", label: "10" }, { value: "15", label: "15" },
        { value: "20", label: "20" }, { value: "30", label: "30" }, { value: "45", label: "45" },
        { value: "60", label: "60" }, { value: "90", label: "90" }, { value: "120", label: "120" },
      ] } } },
      {
        name: "",
        type: "grid",
        schema: [
          { name: "preset_text", selector: { color_rgb: {} } },
          { name: "preset_bg", selector: { color_rgb: {} } },
          { name: "preset_border", selector: { color_rgb: {} } },
        ],
      },
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
  {
    type: "expandable",
    title: "Advanced",
    icon: "mdi:cog-outline",
    schema: [
      { name: "finish_action", selector: { object: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  timer_entity: "Timer entity",
  design: "Design",
  style: "Style",
  title: "Title",
  label_show: "Show label",
  label: "Label",
  direction: "Direction",
  handle_style: "Handle",
  scale: "Scale",
  slide_hint_show: "Show hint",
  slide_hint: "Hint text",
  ends_label: "“Ends at” text",
  ends_icon_show: "Show icon",
  ends_icon: "Icon",
  ends_icon_color: "Icon color",
  finish_entity: "Run on finish",
  finish_action: "Custom action (YAML)",
  max_minutes: "Max minutes",
  min_minutes: "Min minutes",
  step: "Minute step",
  presets_show: "Show favorite times",
  presets: "Favorite times (min)",
  preset_text: "Chip number",
  preset_bg: "Chip background",
  preset_border: "Chip border",
  ends_time: "“Ends at” time color",
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
  design: "Shape of the timer (bar, ring, etc.).",
  style: "Ambient animation behind the timer.",
  title: "Name shown on the card.",
  label_show: "Show the small label under the title.",
  label: "Small label under the title (e.g. Runs in). Hebrew flows right-to-left automatically.",
  direction: "Which side is zero for the bar fill.",
  handle_style: "Marker on the bar's leading edge (Horizontal bar).",
  scale: "How minutes map to the bar. 'Favor short' makes short times take up more of the bar (good for a wide 0–240 range).",
  slide_hint_show: "Show a faint hint in the empty bar.",
  slide_hint: "Faint shimmering hint shown when idle (e.g. “Slide ←”).",
  ends_label: "Text before the end time (e.g. “Ends at”, or Hebrew like “כיבוי בשעה”).",
  ends_icon_show: "Show the icon next to the end time.",
  ends_icon: "Icon shown next to the end time.",
  ends_icon_color: "Color of that icon.",
  finish_entity: "Script, scene, or automation to run when the timer ends.",
  finish_action: "Optional: explicit service-call action(s) in YAML, instead of the entity above.",
  max_minutes: "Longest time you can set.",
  min_minutes: "Shortest time that starts it.",
  step: "Drag snap, in minutes.",
  presets_show: "Show the favorite-time chips below the timer.",
  presets: "Tap a chip to start that time instantly. Type any number to add your own.",
  preset_text: "Number color on the favorite chips.",
  preset_bg: "Background of the favorite chips.",
  preset_border: "Border of the favorite chips.",
  ends_time: "Color of the end-time number (e.g. 21:17). Defaults to the accent.",
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

// Theme default colors as [r,g,b], so the editor's color pickers show the real
// color in use instead of an empty/black swatch. Split by where they're stored.
const NS_COLOR_DEFAULTS = {
  accent: [155, 111, 212],
  accent_strong: [201, 168, 255],
  card_grad_start: [32, 36, 52],
  card_grad_end: [70, 88, 120],
  card_border: [255, 255, 255],
  text: [235, 235, 243],
  text_secondary: [174, 182, 198],
  track: [255, 255, 255],
  warning: [242, 193, 78],
  danger: [226, 104, 95],
};
const TOP_COLOR_DEFAULTS = {
  ends_time: [155, 111, 212],
  ends_icon_color: [155, 111, 212],
  preset_text: [235, 235, 243],
  preset_bg: [255, 255, 255],
  preset_border: [255, 255, 255],
};
const sameColor = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

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
        const v = { ...ev.detail.value };
        // Drop color values that equal the theme default, so they stay linked to
        // the theme (and the config stays clean) rather than being frozen.
        if (v.colors) {
          const c = {};
          for (const [k, val] of Object.entries(v.colors)) {
            if (!sameColor(val, NS_COLOR_DEFAULTS[k])) c[k] = val;
          }
          if (Object.keys(c).length) v.colors = c;
          else delete v.colors;
        }
        for (const k of Object.keys(TOP_COLOR_DEFAULTS)) {
          if (k in v && sameColor(v[k], TOP_COLOR_DEFAULTS[k])) delete v[k];
        }
        this.dispatchEvent(new CustomEvent("config-changed", {
          detail: { config: v },
          bubbles: true,
          composed: true,
        }));
      });
      this.shadowRoot.innerHTML = "";
      this.shadowRoot.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    // Show real defaults in every field/swatch (the card applies these anyway).
    const data = { ...DEFAULT_CONFIG, ...this._config };
    data.colors = { ...NS_COLOR_DEFAULTS, ...(this._config.colors || {}) };
    for (const k of Object.keys(TOP_COLOR_DEFAULTS)) {
      if (data[k] == null) data[k] = TOP_COLOR_DEFAULTS[k];
    }
    this._form.data = data;
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
  "color: white; background: #9B6FD4; font-weight: 700;",
  "color: #9B6FD4; background: #1c1c1c;"
);
