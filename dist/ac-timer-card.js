/**
 * AC Timer Card — a draggable countdown card for Home Assistant.
 *
 * Design 1: horizontal RTL drag track.
 *   - Drag the handle to set the number of minutes.
 *   - Release to start a server-side `timer` entity (timer.start).
 *   - While running, the bar shrinks and the label counts down live.
 *   - Tap "ביטול" to cancel the timer (timer.cancel).
 *
 * Two ways to run something when the countdown ends:
 *   1. finish_action (in the card config) — fired client-side when the timer
 *      finishes WHILE THE APP IS OPEN. Great for reusing one card for many
 *      purposes (AC, boiler, lights…). Supports any service call(s).
 *   2. A server-side automation on the `timer.finished` event — fires even
 *      when the app/phone is closed. The guaranteed path. See README.md.
 *   Use ONE of them per timer to avoid double-firing.
 *
 * Full color control is available via the visual editor or the `colors:`
 * config block.
 *
 * No build step required: this is a plain custom element.
 */

const CARD_VERSION = "0.2.0";

const DEFAULT_CONFIG = {
  title: "טיימר כיבוי מזגן",
  max_minutes: 120,
  min_minutes: 1,
  step: 1,
};

// Color slot -> CSS custom property used in the styles below.
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

class AcTimerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._dragging = false;
    this._dragMinutes = null;
    this._tickHandle = null;
    this._eventUnsub = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  // ---- Lovelace config ----
  setConfig(config) {
    if (!config.timer_entity) {
      throw new Error("חובה להגדיר 'timer_entity' (ישות מסוג timer)");
    }
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._render();
  }

  static getConfigElement() {
    return document.createElement("ac-timer-card-editor");
  }

  static getStubConfig() {
    return { timer_entity: "timer.ac_off", max_minutes: 120 };
  }

  getCardSize() {
    return 3;
  }

  // ---- hass updates ----
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

  // ---- finish_action (client-side firing on timer.finished) ----
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
      .then((unsub) => {
        this._eventUnsub = unsub;
      })
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

  // Supports a single service-call action or a list of them, in either the
  // new `action: domain.service` form or the legacy `service:` form.
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

  // ---- Timer state helpers ----
  _stateObj() {
    if (!this._hass || !this._config) return null;
    return this._hass.states[this._config.timer_entity] || null;
  }

  _isActive() {
    const s = this._stateObj();
    return s && s.state === "active";
  }

  _isPaused() {
    const s = this._stateObj();
    return s && s.state === "paused";
  }

  _remainingSeconds() {
    const s = this._stateObj();
    if (!s) return 0;
    if (s.state === "active" && s.attributes.finishes_at) {
      const finishes = new Date(s.attributes.finishes_at).getTime();
      return Math.max(0, Math.round((finishes - Date.now()) / 1000));
    }
    if (s.state === "paused" && s.attributes.remaining) {
      return this._durationToSeconds(s.attributes.remaining);
    }
    return 0;
  }

  _configuredSeconds() {
    const s = this._stateObj();
    if (s && s.attributes.duration) {
      return this._durationToSeconds(s.attributes.duration);
    }
    return this._config.max_minutes * 60;
  }

  _durationToSeconds(str) {
    const parts = String(str).split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(str) || 0;
  }

  _secondsToHMS(total) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  // ---- Rendering ----
  _render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="title">${this._escape(this._config.title)}</div>

        <div class="track" id="track">
          <div class="fill" id="fill"></div>
          <div class="handle" id="handle">
            <div class="handle-grip"></div>
          </div>
          <div class="ticks" id="ticks"></div>
        </div>

        <div class="readout">
          <div class="big" id="big">--</div>
          <div class="sub" id="sub"></div>
        </div>

        <div class="actions">
          <button class="btn cancel" id="cancel">ביטול</button>
        </div>
      </ha-card>
    `;

    this._els = {
      track: this.shadowRoot.getElementById("track"),
      fill: this.shadowRoot.getElementById("fill"),
      handle: this.shadowRoot.getElementById("handle"),
      ticks: this.shadowRoot.getElementById("ticks"),
      big: this.shadowRoot.getElementById("big"),
      sub: this.shadowRoot.getElementById("sub"),
      cancel: this.shadowRoot.getElementById("cancel"),
    };

    this._applyColors();
    this._renderTicks();

    this._els.track.addEventListener("pointerdown", this._onPointerDown);
    this._els.cancel.addEventListener("click", () => this._cancelTimer());

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

  _renderTicks() {
    const max = this._config.max_minutes;
    const stepCount = 6;
    let html = "";
    for (let i = 0; i <= stepCount; i++) {
      const minutes = Math.round((max / stepCount) * i);
      const rightPct = (i / stepCount) * 100;
      html += `<span class="tick" style="right:${rightPct}%">${minutes}</span>`;
    }
    this._els.ticks.innerHTML = html;
  }

  _displayMinutes() {
    if (this._dragging && this._dragMinutes != null) return this._dragMinutes;
    if (this._isActive() || this._isPaused()) {
      return Math.ceil(this._remainingSeconds() / 60);
    }
    return this._lastIdleMinutes != null ? this._lastIdleMinutes : 30;
  }

  _updateView() {
    if (!this._els) return;
    const max = this._config.max_minutes;
    const active = this._isActive();
    const paused = this._isPaused();
    const running = active || paused;

    let minutes;
    let fillPct;

    if (this._dragging) {
      minutes = this._dragMinutes;
      fillPct = (minutes / max) * 100;
    } else if (running) {
      const remaining = this._remainingSeconds();
      fillPct = (remaining / Math.max(1, this._configuredSeconds())) * 100;
      minutes = Math.ceil(remaining / 60);
    } else {
      minutes = this._displayMinutes();
      fillPct = (minutes / max) * 100;
    }

    fillPct = Math.max(0, Math.min(100, fillPct));

    this._els.fill.style.width = `${fillPct}%`;
    this._els.handle.style.right = `${fillPct}%`;

    if (running) {
      const remaining = this._remainingSeconds();
      this._els.big.textContent = this._secondsToHMS(remaining);
      this._els.sub.textContent = paused ? "מושהה" : "כיבוי בעוד";
      this.shadowRoot.host.classList.add("is-running");
      this._els.cancel.style.display = "";
    } else {
      this._els.big.textContent = `${minutes} דק׳`;
      this._els.sub.textContent = this._dragging
        ? "שחרר כדי להפעיל"
        : "גרור כדי להגדיר";
      this.shadowRoot.host.classList.remove("is-running");
      this._els.cancel.style.display = "none";
    }
  }

  // ---- Ticking ----
  _startTicking() {
    this._stopTicking();
    this._tickHandle = setInterval(() => {
      if (this._isActive() && !this._dragging) this._updateView();
    }, 1000);
  }

  _stopTicking() {
    if (this._tickHandle) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
  }

  // ---- Drag handling ----
  _minutesFromEvent(ev) {
    const rect = this._els.track.getBoundingClientRect();
    const fromRight = rect.right - ev.clientX;
    let ratio = fromRight / rect.width;
    ratio = Math.max(0, Math.min(1, ratio));
    let minutes =
      Math.round((ratio * this._config.max_minutes) / this._config.step) *
      this._config.step;
    minutes = Math.max(
      this._config.min_minutes,
      Math.min(this._config.max_minutes, minutes)
    );
    return minutes;
  }

  _onPointerDown(ev) {
    if (!this._hass) return;
    ev.preventDefault();
    this._dragging = true;
    this._dragMinutes = this._minutesFromEvent(ev);
    this._els.track.setPointerCapture(ev.pointerId);
    this._els.track.addEventListener("pointermove", this._onPointerMove);
    this._els.track.addEventListener("pointerup", this._onPointerUp);
    this._els.track.addEventListener("pointercancel", this._onPointerUp);
    this.shadowRoot.host.classList.add("is-dragging");
    this._updateView();
  }

  _onPointerMove(ev) {
    if (!this._dragging) return;
    this._dragMinutes = this._minutesFromEvent(ev);
    this._updateView();
  }

  _onPointerUp() {
    if (!this._dragging) return;
    const minutes = this._dragMinutes;
    this._dragging = false;
    this._lastIdleMinutes = minutes;
    this.shadowRoot.host.classList.remove("is-dragging");
    this._els.track.removeEventListener("pointermove", this._onPointerMove);
    this._els.track.removeEventListener("pointerup", this._onPointerUp);
    this._els.track.removeEventListener("pointercancel", this._onPointerUp);

    if (minutes >= this._config.min_minutes) {
      this._startTimer(minutes);
    }
    this._dragMinutes = null;
    this._updateView();
  }

  // ---- Service calls ----
  _startTimer(minutes) {
    const duration = this._secondsToHMS(minutes * 60);
    this._hass.callService("timer", "start", {
      entity_id: this._config.timer_entity,
      duration,
    });
  }

  _cancelTimer() {
    this._hass.callService("timer", "cancel", {
      entity_id: this._config.timer_entity,
    });
  }

  // ---- utils ----
  _escape(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  _styles() {
    return `
      :host { direction: rtl; }
      ha-card {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .title {
        font-size: 1.05rem;
        font-weight: 600;
        color: var(--ac-title, var(--primary-text-color));
      }
      .track {
        position: relative;
        height: 56px;
        border-radius: 14px;
        background: var(--ac-track,
          color-mix(in srgb, var(--primary-text-color) 8%, transparent));
        overflow: visible;
        touch-action: none;
        cursor: pointer;
        user-select: none;
      }
      .fill {
        position: absolute;
        top: 0;
        right: 0;
        height: 100%;
        width: 0%;
        border-radius: 14px;
        background: linear-gradient(90deg,
          var(--ac-acc, var(--primary-color, #3f9eff)),
          var(--ac-acc2, #7b61ff));
        transition: width 0.12s ease-out;
      }
      :host(.is-running) .fill {
        background: linear-gradient(90deg,
          var(--ac-run-from, #2e7d6b),
          var(--ac-run-to, #3f9eff));
        transition: width 0.5s linear;
      }
      :host(.is-dragging) .fill { transition: none; }
      .handle {
        position: absolute;
        top: 50%;
        right: 0%;
        transform: translate(50%, -50%);
        width: 24px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
      .handle-grip {
        width: 8px;
        height: 40px;
        border-radius: 6px;
        background: var(--ac-handle, #fff);
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      }
      :host(.is-running) .handle { display: none; }
      .ticks {
        position: absolute;
        left: 0; right: 0; bottom: -20px;
        height: 16px;
        pointer-events: none;
      }
      .tick {
        position: absolute;
        transform: translateX(50%);
        font-size: 0.7rem;
        color: var(--ac-sub, var(--secondary-text-color));
      }
      .readout {
        text-align: center;
        margin-top: 10px;
      }
      .readout .big {
        font-size: 2.1rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--ac-value, var(--primary-text-color));
      }
      .readout .sub {
        font-size: 0.85rem;
        color: var(--ac-sub, var(--secondary-text-color));
        margin-top: 2px;
      }
      .actions {
        display: flex;
        justify-content: center;
      }
      .btn {
        border: none;
        border-radius: 12px;
        padding: 10px 28px;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      .btn.cancel {
        background: color-mix(in srgb,
          var(--ac-cancel, #ff5252) 18%, transparent);
        color: var(--ac-cancel, #ff5252);
      }
      .btn.cancel:hover {
        background: color-mix(in srgb,
          var(--ac-cancel, #ff5252) 28%, transparent);
      }
    `;
  }
}

customElements.define("ac-timer-card", AcTimerCard);

/* ============================================================
 * Visual config editor — colors + finish action + basics.
 * Uses Home Assistant's <ha-form> so it works without a build step.
 * ============================================================ */

const EDITOR_SCHEMA = [
  { name: "timer_entity", required: true, selector: { entity: { domain: "timer" } } },
  { name: "title", selector: { text: {} } },
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
    name: "finish_action",
    selector: { action: {} },
  },
  {
    name: "colors",
    type: "expandable",
    title: "צבעים",
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
  timer_entity: "ישות הטיימר (timer)",
  title: "כותרת",
  max_minutes: "דקות מקסימום",
  min_minutes: "דקות מינימום",
  step: "קפיצת דקות",
  finish_action: "פעולה בסיום הספירה",
  colors: "צבעים",
  accent: "מילוי — צבע א׳",
  accent2: "מילוי — צבע ב׳",
  running_from: "ספירה פעילה — צבע א׳",
  running_to: "ספירה פעילה — צבע ב׳",
  track_bg: "רקע הפס",
  handle: "ידית הגרירה",
  value: "צבע המספר",
  title_color: "צבע הכותרת",
  sub: "צבע טקסט משני",
  cancel: "כפתור ביטול",
};

class AcTimerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
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

// Register with the Lovelace card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "ac-timer-card",
  name: "AC Timer Card",
  description: "טיימר כיבוי הניתן לגרירה, עם שליטה בצבעים ופעולת סיום מתכווננת",
  preview: false,
});

console.info(
  `%c AC-TIMER-CARD %c v${CARD_VERSION} `,
  "color: white; background: #3f9eff; font-weight: 700;",
  "color: #3f9eff; background: #1c1c1c;"
);
