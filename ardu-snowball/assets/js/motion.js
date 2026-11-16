// Modulino controller: aiming (turning) from the Modulino Movement gyroscope,
// snowball gestures (scoop / pack / throw / run) classified by Edge Impulse
// (the App Lab Motion detection brick or a model on the UNO Q MCU, chosen by
// Python: see controller.py), the Modulino Buttons and the Pixels. Everything
// travels through the WebUI brick: the board streams "imu" / "ml" / "btn" /
// "hw" to the Socket.IO room "motion".
//
// Aiming works in any mounting: calibration records gravity with the
// controller pointing straight ahead and tilted right, which gives the
// rotation axis, its sign and the full-tilt angle. A complementary filter
// fuses the gyro rate around that axis with the angle seen by the
// accelerometer. The tilt turns the player (like a steering wheel).
import { el, clamp } from './util.js';

export const ACTIONS = [
  { value: 'none', label: 'NOTHING' },
  { value: 'scoop', label: 'SCOOP' },
  { value: 'pack', label: 'PACK' },
  { value: 'throw', label: 'THROW' },
  { value: 'run', label: 'RUN' },
  { value: 'pause', label: 'PAUSE' },
];
export const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.value, a.label]));
export const DEFAULT_LABELS = ['idle', 'scoop', 'pack', 'throw', 'run'];

// edge actions fire once per gesture, held actions last while the class is seen
const EDGE = new Set(['scoop', 'pack', 'throw', 'pause']);
const HOLD_MS = { run: 600 };
const EDGE_COOLDOWN_MS = 700;
const DEG = Math.PI / 180;
const DEFAULT_RANGE = 35 * DEG;
const ONLINE_MS = 3000;
const ML_STALE_MS = 1500;
// HUD controller icon: a mitten holding a snowball
const ICON_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 58 L18 30 Q18 14 32 14 Q46 14 46 30 L46 58 Z" fill="#2f6bff" stroke="#e9edff" stroke-width="3"/>'
  + '<path d="M18 34 Q8 30 10 22 Q13 16 20 24" fill="#2f6bff" stroke="#e9edff" stroke-width="3"/><rect x="16" y="50" width="32" height="8" rx="2" fill="#ffcf26"/>'
  + '<circle cx="32" cy="10" r="8" fill="#f4fbff" stroke="#9ad8ff" stroke-width="2"/></svg>';
export const ENGINE_LABEL = { brick: 'MOTION DETECTION BRICK', mcu: 'MODEL ON THE MCU' };

// Same keywords as gestureIconFor() in sketch/led_frames.h
export function defaultAction(label) {
  const l = String(label).toLowerCase();
  if (/idle|noise|none|rest|still|background|unknown|repos/.test(l)) return 'none';
  if (/scoop|dig|grab|recull|recoll|recog|pala|shovel/.test(l)) return 'scoop';
  if (/pack|press|squeez|compact|prem|apret|clap/.test(l)) return 'pack';
  if (/throw|launch|shoot|llan|lanz|tir|flick|punch/.test(l)) return 'throw';
  if (/run|sprint|dash|corr|jog|shake/.test(l)) return 'run';
  if (/pause|menu/.test(l)) return 'pause';
  return 'none';
}

export function defaultMotionSettings() {
  return { enabled: 'auto', sensitivity: 0.5, deadzone: 0.15, invert: false, threshold: 0.7, map: {}, cal: null };
}

// --- tiny vector helpers (arrays of 3)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const reject = (v, axis) => sub(v, scale(axis, dot(v, axis)));   // component perpendicular to axis

// Signed board rotation about `axis` that takes gravity from `ref` to `g`.
// Gravity rotates the opposite way in the board frame, hence the minus.
function angleAbout(ref, g, axis) {
  const r = norm(reject(ref, axis)), p = norm(reject(g, axis));
  return -Math.atan2(dot(axis, cross(r, p)), dot(r, p));
}

export class MotionController {
  constructor(app) {
    this.app = app;
    this.settings = app.settings.motion;
    this.hw = null;          // last hardware heartbeat (parsed by Python)
    this.hwAt = 0;
    this.installed = null;
    this.engine = null;      // {pref, active: 'brick' | 'mcu' | null, labels, name, brick}
    this.owner = undefined;
    this.ownerKind = null;   // 'game' | 'lab'
    this.ownerVisible = false;
    this.turnRate = 0;       // gyro rate about the aim axis, rad/s, + = right
    this.labels = [];
    this.probs = [];
    this.mlAt = 0;
    this.timing = null;
    // aim state
    this.angle = 0;          // filtered board angle about the aim axis (rad, + = right)
    this.rawAngle = 0;
    this.steer = 0;          // game convention: + = left
    this.acc = [0, 1, 0];
    this.gyro = [0, 0, 0];
    this.bias = [0, 0, 0];
    this.samples = 0;
    this.autoRef = null;     // uncalibrated: gravity at start-up acts as "centre"
    this.autoAcc = [0, 0, 0];
    this.autoN = 0;
    this.imuAt = 0;
    this.imuRate = 0;
    this._rateN = 0; this._rateT = 0;
    this.capture = null;     // calibration capture in progress
    // gestures / buttons
    this.until = {};         // held action -> timestamp
    this.armed = {};         // label -> can fire again
    this.lastFire = {};      // action -> timestamp
    this.pulses = new Map(); // one-frame actions waiting for poll(): action -> confidence
    this.buttons = [false, false, false];
    this.lastGesture = null; // {label, action, at, p}
    this.listeners = new Set();
    this.lastInputAt = 0;
    this._pixAt = 0;
    this._pixKey = '';
    this._ledMask = -1;
    this._buildHud();
    // coming back from the Motion Lab tab: this tab drives the controller again
    window.addEventListener('focus', () => this._autoClaim());
    document.addEventListener('visibilitychange', () => {
      // a hidden tab lets a game tab on screen take the controller
      if (this.owned) app.net.send('motion_visible', { visible: !document.hidden });
      this._autoClaim();
    });

    const n = app.net;
    n.on('connect', () => this._onConnect());
    n.on('hw', (st) => this._onStatus(st));
    n.on('motion_owner', (m) => {
      this._setOwner(m);
      if (!this.owned) this.buttons.fill(false);
      this._autoClaim(); this._emit('owner');
    });
    n.on('imu', (m) => this._onImu(m));
    n.on('ml', (m) => this._onMl(m));
    n.on('btn', (m) => this._onButton(m.i, m.p));
  }

  // ------------------------------------------------------------------ status
  get online() { return !!this.hw && performance.now() - this.hwAt < ONLINE_MS && !!this.hw.movement; }
  // a gesture model is running (brick or MCU)
  get hasModel() { return this.engine ? !!this.engine.active : !!(this.hw && this.hw.model); }
  get hasButtons() { return !!(this.hw && this.hw.buttons); }
  get engineName() { return (this.engine && this.engine.name) || (this.hw && this.hw.name) || 'Edge Impulse'; }
  get owned() { return !!this.app.net.id && this.owner === this.app.net.id; }
  get calibrated() { return !!this.settings.cal; }
  // aim & gestures drive the game only in the tab that owns the controller
  get active() {
    const m = this.settings.enabled;
    if (m === 'off' || !this.online) return false;
    return this.owned || this.owner == null;
  }
  // classes of the running model mapped to each action (for hints)
  labelsFor(action) { return this.labels.filter((l) => this.actionFor(l) === action); }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(what) { for (const fn of this.listeners) { try { fn(what, this); } catch (e) { console.error(e); } } }

  _onConnect() {
    const n = this.app.net;
    n.joinRoom('motion');   // rooms do not survive a reconnect
    n.request('motion_status', {}).then((st) => {
      if (!st) return;
      this._onStatus(st);
      if (st.ml) this._onMl(st.ml, true);
    });
  }

  _onStatus(st) {
    if (!st) return;
    if (st.hw) { this.hw = st.hw; this.hwAt = st.online ? performance.now() : 0; }
    this.installed = st.installed;
    if ('owner' in st) this._setOwner({ id: st.owner, kind: st.ownerKind, visible: st.ownerVisible });
    if (st.engine) {
      if (this.engine && this.engine.active !== st.engine.active) this.probs = [];
      this.engine = st.engine;
    }
    const labels = this.engine ? this.engine.labels : this.hw && this.hw.labels;
    if (Array.isArray(labels) && labels.length) this.labels = labels;
    this._autoClaim();
    this._emit('status');
  }

  _setOwner(m) {
    this.owner = m ? m.id : null;
    this.ownerKind = (m && m.kind) || null;
    this.ownerVisible = !!(m && m.visible);
  }

  // Take the controller when it is free, or, when this tab has the focus, from the
  // Motion Lab or from a game tab nobody can see (background or old tab).
  _autoClaim() {
    if (this.settings.enabled === 'off' || !this.online || !this.app.net.connected || this.owned) return;
    if (this.owner === null) this.claim(false);
    else if (!document.hidden && document.hasFocus() && (this.ownerKind === 'lab' || !this.ownerVisible)) this.claim(false, true);
  }

  // "USE THE CONTROLLER HERE"
  takeController() { return this.claim(true); }

  claim(force = true, focused = false) {
    return this.app.net.request('motion_claim', { force, focused, visible: !document.hidden }).then((r) => {
      if (r) this._setOwner({ id: r.owner, kind: r.kind, visible: r.visible });
      this._ledMask = -1;
      this._pixKey = '';
      this._emit('owner');
      return this.owned;
    });
  }

  release() {
    if (this.owned) this.app.net.send('motion_claim', { release: true });
  }

  // 'auto' | 'brick' | 'mcu' (saved on the board, shared by every browser)
  setEngine(engine) {
    return this.app.net.request('motion_engine', { engine }).then((r) => {
      if (r && r.ok) this._onStatus({ engine: r.engine });
      return r;
    });
  }

  // ------------------------------------------------------------------ steering
  _onImu(m) {
    const dt = (m.i || 16) / 1000;
    const t = performance.now();
    this._rateN += m.s.length;
    if (t - this._rateT > 1000) { this.imuRate = this._rateN * 1000 / (t - this._rateT || 1); this._rateN = 0; this._rateT = t; }
    this.imuAt = t;
    this.hwAt = Math.max(this.hwAt, t - ONLINE_MS + 1500);   // data flowing = online
    for (const s of m.s) this._sample(s, dt);
    this._updateSteer();
    if (this.capture) this._captureStep();
    this._emit('imu');
  }

  _sample(s, dt) {
    const acc = [s[0], s[1], s[2]];
    const gyro = [s[3], s[4], s[5]];
    this.acc = acc;
    this.gyro = gyro;
    this.samples++;
    if (this.capture) this.capture.buf.push(s);

    const cal = this.settings.cal;
    let ref, axis, bias;
    if (cal) {
      ({ ref, axis, bias } = cal);
    } else {
      // no calibration yet: average the first half second as the centre and
      // guess the axis (upright controller tilts about z, a flat board about y)
      if (this.autoN < 30) {
        this.autoAcc = this.autoAcc.map((v, i) => v + acc[i]);
        this.bias = this.bias.map((v, i) => v + gyro[i] / 30);
        if (++this.autoN === 30) this.autoRef = norm(this.autoAcc);
        return;
      }
      ref = this.autoRef;
      axis = Math.abs(ref[2]) < 0.75 ? [0, 0, -1] : [0, -1, 0];
      bias = this.bias;
    }
    const rate = dot(sub(gyro, bias), axis) * DEG;     // rad/s about the axis, + = right
    this.turnRate = rate;
    const g = len(acc);
    const accAngle = angleAbout(ref, acc, axis);
    this.rawAngle = accAngle;
    // trust the accelerometer only when it measures (mostly) gravity
    const shaking = Math.abs(g - 1) > 0.22 || len(reject(acc, axis)) < 0.35;
    const k = shaking ? 1 : 0.96;
    let a = this.angle + rate * dt;
    if (!shaking) {
      // unwrap so the blend never crosses ±180°
      let d = accAngle - a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      a = a + (1 - k) * d;
    }
    this.angle = a;
    // slow gyro bias tracking while the controller rests
    if (!cal && !shaking && Math.abs(rate) < 3 * DEG) this.bias = this.bias.map((v, i) => v + (gyro[i] - v) * 0.002);
  }

  _updateSteer() {
    const s = this.settings;
    const range = (s.cal && s.cal.range) || DEFAULT_RANGE;
    const gain = 0.5 + s.sensitivity;
    let x = clamp((this.angle / range) * gain, -1, 1);
    const dz = s.deadzone * 0.3;
    const ax = Math.abs(x);
    x = ax <= dz ? 0 : Math.sign(x) * Math.pow((ax - dz) / (1 - dz), 1.15);
    if (s.invert) x = -x;
    this.steer = -x;                // game: + = left (turn)
  }

  // --- calibration: centre, then full right
  startCalibration() { this.capture = null; this.calStep = 'centre'; this._emit('cal'); }
  cancelCalibration() { this.capture = null; this.calStep = null; this._emit('cal'); }

  captureCentre() {
    return new Promise((resolve) => {
      this.capture = { kind: 'centre', buf: [], need: 45, resolve };
    });
  }

  captureRight() {
    return new Promise((resolve) => {
      this.capture = { kind: 'right', buf: [], need: 45, resolve, still: 0 };
    });
  }

  _captureStep() {
    const c = this.capture;
    if (c.kind === 'centre') {
      if (c.buf.length < c.need) return;
      const mean = (i) => c.buf.reduce((t, s) => t + s[i], 0) / c.buf.length;
      const accM = [mean(0), mean(1), mean(2)];
      const gyrM = [mean(3), mean(4), mean(5)];
      const spread = Math.max(...c.buf.map((s) => len(sub([s[0], s[1], s[2]], accM))));
      if (spread > 0.12) { c.buf = []; this._emit('cal-move'); return; }   // keep still
      this.capture = null;
      this._calCentre = { ref: norm(accM), bias: gyrM };
      c.resolve(this._calCentre);
      return;
    }
    // right: wait until the controller is clearly tilted and held still
    const centre = this._calCentre;
    const last = c.buf.slice(-20);
    if (last.length < 20) return;
    const accM = norm([0, 1, 2].map((i) => last.reduce((t, s) => t + s[i], 0) / last.length));
    const turned = Math.acos(clamp(dot(accM, centre.ref), -1, 1));
    const spread = Math.max(...last.map((s) => len(sub(norm([s[0], s[1], s[2]]), accM))));
    c.progress = clamp(turned / (25 * DEG), 0, 1);
    if (turned < 15 * DEG || spread > 0.06) { c.buf = c.buf.slice(-40); return; }
    this.capture = null;
    const axis = norm(cross(accM, centre.ref));      // positive rotation about it = right turn
    const range = clamp(turned * 0.85, 12 * DEG, 80 * DEG);
    const cal = { ref: centre.ref, axis, bias: centre.bias, range, at: Date.now() };
    this.settings.cal = cal;
    this.angle = angleAbout(cal.ref, accM, cal.axis);
    this.app.saveSettings();
    c.resolve(cal);
  }

  resetCalibration() {
    this.settings.cal = null;
    this.autoN = 0; this.autoAcc = [0, 0, 0]; this.bias = [0, 0, 0]; this.angle = 0;
    this.app.saveSettings();
  }

  recentre() {
    // keep the axis, take the current pose as straight ahead
    const cal = this.settings.cal;
    if (cal) { cal.ref = norm(this.acc); this.app.saveSettings(); } else { this.autoRef = norm(this.acc); }
    this.angle = 0;
  }

  // ------------------------------------------------------------------ gestures
  actionFor(label) {
    const m = this.settings.map;
    return m && m[label] ? m[label] : defaultAction(label);
  }

  _onMl(m, replay = false) {
    if (!m || !Array.isArray(m.p)) return;
    if (Array.isArray(m.labels) && m.labels.length) this.labels = m.labels;
    this.probs = m.p;
    this.mlAt = performance.now();
    this.timing = { dsp: m.dsp, nn: m.nn, src: m.src };
    this._emit('ml');
    if (replay || !this.active) return;
    const th = this.settings.threshold;
    let best = -1;
    m.p.forEach((p, i) => { if (best < 0 || p > m.p[best]) best = i; });
    this.labels.forEach((label, i) => {
      if ((m.p[i] || 0) < th * 0.6) this.armed[label] = true;   // re-arm once the class fades
    });
    if (best < 0 || m.p[best] < th) return;
    const label = this.labels[best];
    const action = this.actionFor(label);
    if (!label || action === 'none') return;
    this._gesture(label, action, m.p[best]);
  }

  // p: model confidence, 0..1 (a cleaner throw flies further and straighter)
  _gesture(label, action, p = 1) {
    const now = performance.now();
    if (EDGE.has(action)) {
      if (this.armed[label] === false || now - (this.lastFire[action] || 0) < EDGE_COOLDOWN_MS) return;
      this.armed[label] = false;
      this.lastFire[action] = now;
      this.pulses.set(action, p);
    } else {
      const fresh = (this.until[action] || 0) < now;
      this.until[action] = now + HOLD_MS[action];
      this.pulses.set(action + 'Tick', p);
      if (!fresh) return;
    }
    this.lastInputAt = now;
    this.app.input.lastDevice = 'motion';
    this.lastGesture = { label, action, at: now, p };
    this._flash(`${ACTION_LABEL[action] || label} ${Math.round(p * 100)}%`);
    this._emit('gesture');
  }

  // ------------------------------------------------------------------ buttons
  // A throw · B run (hold) · C scoop + pack in game; ok / back / next in the menus
  _onButton(i, pressed) {
    if (!(i >= 0 && i <= 2)) return;
    if (!this.active) return;
    this.buttons[i] = !!pressed;
    if (!pressed) return;
    const a = this.app;
    this.lastInputAt = performance.now();
    a.input.lastDevice = 'motion';
    a.audio.unlock();
    this._emit('button');
    if (a.state === 'playing') {
      if (i === 0) this.pulses.set('throw', a.settings.buttonThrow);
      else if (i === 2) this.pulses.set('snow', 1);
      return;                         // B (held) = run, read in poll()
    }
    a.input.menuQueue.push(['ok', 'back', 'next'][i]);
  }

  // ------------------------------------------------------------------ per frame
  // merged into Input.poll(): returns null when the controller is not in use
  poll() {
    const now = performance.now();
    if (!this.active) { this.pulses.clear(); return null; }
    const r = {
      turn: this.steer,
      throw: this.pulses.has('throw') ? this.pulses.get('throw') : 0,
      scoop: this.pulses.has('scoop'),
      pack: this.pulses.has('pack'),
      snow: this.pulses.has('snow'),        // button C: scoop or pack, whatever makes sense
      pause: this.pulses.has('pause'),
      run: (this.until.run || 0) > now || this.buttons[1],
      runGesture: (this.until.run || 0) > now,
    };
    this.pulses.clear();
    return r;
  }

  // called every frame by the app: Pixels, button LEDs, HUD
  update() {
    const a = this.app, now = performance.now();
    const g = a.game;
    const playing = a.state === 'playing' && g;
    if (!this.active || !this.owned) { this._updateHud(playing && this.online && this.settings.enabled !== 'off'); return; }
    if (now - this._pixAt > 60) {
      const [mode, value] = playing ? g.pixels() : [0, 0];
      const key = mode + ':' + value;
      if (key !== this._pixKey || now - this._pixAt > 400) {
        this._pixKey = key;
        this._pixAt = now;
        a.net.send('pix', { mode, value });
      }
    }
    const scr = a.ui.screen && a.ui.screen.name;
    // in game: the LEDs of the buttons that do something now; menus: all on, title: A blinks
    const mask = playing ? g.buttonMask() : scr === 'title' ? (now % 1000 < 600 ? 1 : 0) : 7;
    if (mask !== this._ledMask) { this._ledMask = mask; a.net.send('ctl_leds', { mask }); }
    this._updateHud(playing);
  }

  // ------------------------------------------------------------------ HUD
  _buildHud() {
    this._hudIcon = el('div', { class: 'mh-wheel', html: ICON_SVG });
    this._hudLabel = el('div', { class: 'mh-label' });
    this._hudState = el('div', { class: 'mh-state' });
    this._hudDir = el('div', { class: 'mh-dir' });
    this._hudBar = el('i');
    this._hudGyro = el('div', { class: 'mh-gyro' });
    this._hudTake = el('button', { class: 'mh-take hidden', type: 'button', onclick: (e) => { e.currentTarget.blur(); this.takeController(); } }, 'USE THE CONTROLLER HERE');
    this._hudEngine = el('div', { class: 'mh-engine' });
    this._hudClasses = el('div', { class: 'mh-classes' });
    this._hudKey = '';
    this._hudMlAt = -1;
    this._hud = el('div', { id: 'motion-hud', class: 'hidden' },
      el('div', { class: 'mh-head' }, this._hudIcon,
        el('div', { class: 'mh-text' }, this._hudState, this._hudDir, el('div', { class: 'mh-bar' }, this._hudBar), this._hudGyro)),
      this._hudLabel, this._hudTake, this._hudEngine, this._hudClasses);
    document.body.append(this._hud);
  }

  // live class probabilities (bottom-left while playing)
  _updateClasses() {
    const show = this.hasModel && this.labels.length > 0;
    this._hudEngine.classList.toggle('hidden', !show);
    this._hudClasses.classList.toggle('hidden', !show);
    if (!show) return;
    const key = this.labels.join('|') + '|' + this.settings.threshold + '|' + JSON.stringify(this.settings.map);
    if (key !== this._hudKey) {
      this._hudKey = key;
      this._hudMlAt = -1;
      const th = `${Math.round(this.settings.threshold * 100)}%`;
      this._hudClasses.replaceChildren(...this.labels.map((label) => {
        const act = this.actionFor(label);
        return el('div', { class: 'mh-cls' + (act === 'none' ? ' idle' : ''), 'data-act': act },
          el('span', { title: act !== 'none' ? `${label} → ${ACTION_LABEL[act] || act}` : label }, label),
          el('div', {}, el('i'), el('u', { style: { left: th } })),
          el('b', {}, '–'));
      }));
    }
    const eng = this.engine && this.engine.active;
    const head = `${ENGINE_LABEL[eng] || 'EDGE IMPULSE'} · ${this.engineName}`;
    if (this._hudEngine.textContent !== head) this._hudEngine.textContent = head;
    const stale = performance.now() - this.mlAt > ML_STALE_MS;
    this._hudClasses.classList.toggle('stale', stale);
    // the class the game is waiting for glows
    const want = this.app.game ? this.app.game.wantedAction() : null;
    for (const row of this._hudClasses.children) row.classList.toggle('want', !!want && row.dataset.act === want);
    if (this.mlAt === this._hudMlAt) return;
    this._hudMlAt = this.mlAt;
    const p = this.probs;
    let best = -1;
    p.forEach((v, i) => { if (best < 0 || v > p[best]) best = i; });
    [...this._hudClasses.children].forEach((row, i) => {
      const v = p[i] || 0;
      row.children[1].firstChild.style.width = `${(v * 100).toFixed(0)}%`;
      row.children[2].textContent = `${Math.round(v * 100)}%`;
      row.classList.toggle('top', i === best && v >= this.settings.threshold);
    });
  }

  _flash(text) {
    const l = this._hudLabel;
    l.textContent = text;
    l.classList.remove('pop');
    void l.offsetWidth;
    l.classList.add('pop');
  }

  _updateHud(playing) {
    this._hud.classList.toggle('hidden', !playing);
    if (!playing) return;
    this._updateIcon();
    const driving = this.owned;
    this._hudTake.classList.toggle('hidden', driving);
    this._hud.classList.toggle('idle', !driving);
    const st = !driving ? (this.ownerKind === 'lab' ? 'CONTROLLER IN THE MOTION LAB' : 'CONTROLLER ON ANOTHER SCREEN')
      : !this.hasModel ? (this.hasButtons ? 'NO MODEL · BUTTONS A B C' : 'NO MODEL · KEYBOARD')
        : this.calibrated ? 'MODULINO CONTROLLER' : 'MODULINO CONTROLLER · NOT CALIBRATED';
    if (this._hudState.textContent !== st) this._hudState.textContent = st;
    this._hudState.className = 'mh-state' + (!driving ? ' warn' : this.hasModel ? ' on' : ' warn');
    this._updateClasses();
  }

  // controller icon, tilt angle and gyro rate (live even on a screen that does not drive)
  _updateIcon() {
    const s = this.steer;               // + = left
    this._hudIcon.style.transform = `rotate(${(-s * 50).toFixed(1)}deg)`;
    const deg = Math.round(Math.abs(this.angle) / DEG);
    const dir = s > 0.02 ? `◀ TURN LEFT ${deg}°` : s < -0.02 ? `TURN RIGHT ${deg}° ▶` : `AHEAD ${deg}°`;
    if (this._hudDir.textContent !== dir) this._hudDir.textContent = dir;
    const b = this._hudBar.style, w = Math.abs(s) * 50;
    b.left = `${s > 0 ? 50 - w : 50}%`;
    b.width = `${w}%`;
    const g = this.gyro || [0, 0, 0];
    const rate = Math.round(this.turnRate / DEG);
    this._hudGyro.textContent = `GYRO ${rate > 0 ? '+' : ''}${rate}°/s · ${g.map((v) => Math.round(v)).join(' ')}`;
  }
}
