// Modulino wheel: steering from the Modulino Movement, gestures classified by
// Edge Impulse (the App Lab Motion detection brick or a model on the UNO Q
// MCU, chosen by Python: see controller.py), the Modulino Buttons and the
// Pixels shift lights. Everything travels through the WebUI brick: the board
// streams "imu" / "ml" / "btn" / "hw" to the Socket.IO room "motion".
//
// Steering works in any mounting: calibration records gravity with the wheel
// centred and turned right, which gives the rotation axis, its sign and the
// full-lock angle. A complementary filter fuses the gyro rate around that axis
// with the angle seen by the accelerometer.
import { el, clamp } from './util.js';

export const ACTIONS = [
  { value: 'none', label: 'NOTHING' },
  { value: 'accelerate', label: 'ACCELERATE' },
  { value: 'brake', label: 'BRAKE' },
  { value: 'item', label: 'USE ITEM' },
  { value: 'camera', label: 'CHANGE CAMERA' },
  { value: 'lookBack', label: 'LOOK BACK' },
  { value: 'drift', label: 'DRIFT' },
  { value: 'pause', label: 'PAUSE' },
];
export const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a.value, a.label]));
export const DEFAULT_LABELS = ['idle', 'accelerate', 'brake', 'use_item', 'change_camera'];

// edge actions fire once per gesture, held actions last while the class is seen
const EDGE = new Set(['accelerate', 'item', 'camera', 'pause']);
const HOLD_MS = { brake: 600, lookBack: 450, drift: 450 };
const EDGE_COOLDOWN_MS = 500;
const DEG = Math.PI / 180;
const DEFAULT_RANGE = 35 * DEG;
const ONLINE_MS = 3000;
const ML_STALE_MS = 1500;
export const ENGINE_LABEL = { brick: 'MOTION DETECTION BRICK', mcu: 'MODEL ON THE MCU' };

export function defaultAction(label) {
  const l = String(label).toLowerCase();
  if (/idle|noise|none|rest|still|background|unknown/.test(l)) return 'none';
  if (/brake|break|stop|slow/.test(l)) return 'brake';
  if (/accel|gas|forward|throttle|^go$|faster|updown|up_down|up-down/.test(l)) return 'accelerate';
  if (/item|use|fire|throw|shoot|punch|wave/.test(l)) return 'item';
  if (/cam|view|snake|circle/.test(l)) return 'camera';
  if (/back|look|behind/.test(l)) return 'lookBack';
  if (/drift|hop|jump/.test(l)) return 'drift';
  if (/pause|menu/.test(l)) return 'pause';
  return 'none';
}

export function defaultMotionSettings() {
  return { enabled: 'auto', sensitivity: 0.5, deadzone: 0.25, invert: false, threshold: 0.7, menuTilt: true, map: {}, cal: null };
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
    this.labels = [];
    this.probs = [];
    this.mlAt = 0;
    this.timing = null;
    // steering state
    this.angle = 0;          // filtered board angle about the steering axis (rad, + = right)
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
    this.cruise = false;
    this.until = {};         // held action -> timestamp
    this.armed = {};         // label -> can fire again
    this.lastFire = {};      // action -> timestamp
    this.pulses = new Set(); // one-frame actions waiting for poll()
    this.buttons = [false, false, false];
    this.lastGesture = null; // {label, action, at}
    this.listeners = new Set();
    this.lastInputAt = 0;
    this._menuTiltArmed = true;
    this._menuTiltAt = 0;
    this._revAt = 0;
    this._ledMask = -1;
    this._buildHud();
    // coming back from the Motion Lab tab: this tab drives the wheel again
    window.addEventListener('focus', () => this._autoClaim());
    document.addEventListener('visibilitychange', () => this._autoClaim());

    const n = app.net;
    n.on('connect', () => this._onConnect());
    n.on('hw', (st) => this._onStatus(st));
    n.on('motion_owner', (m) => {
      this.owner = m ? m.id : null; this.ownerKind = m ? m.kind : null;
      // the release of a held button goes to the new owner, so forget it here
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
  get engineName() { return (this.engine && this.engine.name) || (this.hw && this.hw.name) || 'Edge Impulse'; }
  get owned() { return !!this.app.net.id && this.owner === this.app.net.id; }
  get calibrated() { return !!this.settings.cal; }
  // steering & gestures drive the kart only in the tab that owns the wheel
  get active() {
    const m = this.settings.enabled;
    if (m === 'off' || !this.online) return false;
    return this.owned || this.owner == null;
  }

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
    if ('owner' in st) { this.owner = st.owner; this.ownerKind = st.ownerKind || null; }
    if (st.engine) {
      if (this.engine && this.engine.active !== st.engine.active) this.probs = [];
      this.engine = st.engine;
    }
    const labels = this.engine ? this.engine.labels : this.hw && this.hw.labels;
    if (Array.isArray(labels) && labels.length) this.labels = labels;
    this._autoClaim();
    this._emit('status');
  }

  // Take the wheel when it is free, or from the Motion Lab when this tab has
  // the focus. Game tabs never take it from each other (LAN players' screens).
  _autoClaim() {
    if (this.settings.enabled === 'off' || !this.online || !this.app.net.connected || this.owned) return;
    if (this.owner === null) this.claim(false);
    else if (this.ownerKind === 'lab' && !document.hidden && document.hasFocus()) this.claim(false, true);
  }

  claim(force = true, fromLab = false) {
    return this.app.net.request('motion_claim', { force, fromLab }).then((r) => {
      if (r) { this.owner = r.owner; this.ownerKind = r.kind || null; }
      this._ledMask = -1;
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
      // guess the axis (upright wheel turns about z, a flat board about y)
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
    // slow gyro bias tracking while the wheel rests
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
    this.steer = -x;                // game: + = left
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
    // right: wait until the wheel is clearly turned and held still
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
    this._gesture(label, action);
  }

  _gesture(label, action) {
    const now = performance.now();
    if (EDGE.has(action)) {
      if (this.armed[label] === false || now - (this.lastFire[action] || 0) < EDGE_COOLDOWN_MS) return;
      this.armed[label] = false;
      this.lastFire[action] = now;
      if (action === 'accelerate') this.cruise = true;
      else this.pulses.add(action);
    } else {
      const fresh = (this.until[action] || 0) < now;
      this.until[action] = now + HOLD_MS[action];
      if (action === 'brake') {
        this.cruise = false;
        // a brake gesture while moving stops the kart; one made at a standstill reverses
        if (fresh) { const k = this.app.race && this.app.race.player; this._brakeToStop = !!k && k.speed > 1; }
      }
      if (!fresh) return;
    }
    this.lastInputAt = now;
    this.app.input.lastDevice = 'wheel';
    this.lastGesture = { label, action, at: now };
    this._flash(ACTION_LABEL[action] || label);
    this._emit('gesture');
  }

  // ------------------------------------------------------------------ buttons
  _onButton(i, pressed) {
    if (!(i >= 0 && i <= 2)) return;
    if (!this.active) return;
    this.buttons[i] = !!pressed;
    if (!pressed) return;
    const a = this.app;
    this.lastInputAt = performance.now();
    a.input.lastDevice = 'wheel';
    a.audio.unlock();
    this._emit('button');
    if (a.state === 'race') {
      if (i === 1) this.pulses.add('item');
      return;                         // A or C (held) = accelerate, read in poll()
    }
    const scr = a.ui.screen && a.ui.screen.name;
    if (scr === 'title') { a.audio.play('menuSelect'); a.startPressed(); return; }
    if (scr === 'main') {
      // A Start (quick race) · B Grand Prix · C LAN
      a.audio.play('menuSelect');
      if (i === 0) a.ui.show('chars', { next: 'race' });
      else if (i === 1) a.ui.show('chars', { next: 'gp' });
      else if (a.net.connected) a.ui.show('chars', { next: 'mp' });
      else a.ui.toast('Not connected to the UNO Q server', 'warn');
      return;
    }
    a.input.menuQueue.push(['ok', 'back', 'down'][i]);
  }

  // ------------------------------------------------------------------ per frame
  // merged into Input.poll(): returns null when the wheel is not in use
  poll() {
    const now = performance.now();
    if (!this.active) { this.pulses.clear(); return null; }
    const held = (a) => (this.until[a] || 0) > now;
    const r = {
      steer: this.steer,
      throttle: 0, brake: 0,
      drift: held('drift'),
      lookBack: held('lookBack'),
      item: this.pulses.has('item'),
      camera: this.pulses.has('camera'),
      pause: this.pulses.has('pause'),
    };
    const k = this.app.race && this.app.race.player;
    if (held('brake')) r.brake = this._brakeToStop && k && k.speed <= 0.5 ? 0 : 1;
    else if (this.gasHeld || this.cruise || this.autoGas) r.throttle = 1;
    this.pulses.clear();

    // menus: tilt the wheel to move left / right
    const a = this.app;
    if (a.state !== 'race' && a.ui.visible && this.settings.menuTilt && a.ui.screen.name !== 'motionCal') {
      const s = this.steer;
      if (Math.abs(s) < 0.35) this._menuTiltArmed = true;
      else if (Math.abs(s) > 0.7 && (this._menuTiltArmed || now - this._menuTiltAt > 650)) {
        a.input.menuQueue.push(s > 0 ? 'left' : 'right');
        this._menuTiltArmed = false;
        this._menuTiltAt = now;
      }
    }
    return r;
  }

  // buttons A and C are the gas pedal
  get gasHeld() { return this.buttons[0] || this.buttons[2]; }
  // no Buttons module and no model: nothing could accelerate, so the wheel keeps the throttle down
  get autoGas() { return !this.hasModel && !(this.hw && this.hw.buttons); }

  // reset the latched throttle so a held gesture cannot flood the rocket start
  resetRace() { this.cruise = false; this.until = {}; this.pulses.clear(); this._autoClaim(); }

  // called every frame by the app: shift lights, button LEDs, HUD
  update() {
    const a = this.app, now = performance.now();
    if (!this.active || !this.owned) { this._hud.classList.add('hidden'); return; }
    const r = a.race;
    const racing = a.state === 'race' && r && r.mode !== 'attract' && r.player;
    if (racing && now - this._revAt > 66) {
      this._revAt = now;
      const k = r.player;
      const speed = Math.round(clamp(Math.abs(k.speed) / (k.maxSpeed || 1), 0, 1.5) * 100);
      const flags = 1 | (k.boostT > 0 ? 2 : 0) | ((clamp(k.driftLevel | 0, 0, 3)) << 2) | (k.finished ? 16 : 0);
      a.net.send('rev', { speed, flags });
    }
    const scr = a.ui.screen && a.ui.screen.name;
    const mask = scr === 'title' ? (now % 1000 < 600 ? 1 : 0) : 7;
    if (mask !== this._ledMask) { this._ledMask = mask; a.net.send('ctl_leds', { mask }); }
    this._updateHud(racing);
  }

  // ------------------------------------------------------------------ HUD
  _buildHud() {
    this._hudWheel = el('div', { class: 'mh-wheel' }, el('i'));
    this._hudLabel = el('div', { class: 'mh-label' });
    this._hudState = el('div', { class: 'mh-state' });
    this._hudEngine = el('div', { class: 'mh-engine' });
    this._hudClasses = el('div', { class: 'mh-classes' });
    this._hudKey = '';
    this._hudMlAt = -1;
    this._hud = el('div', { id: 'motion-hud', class: 'hidden' },
      el('div', { class: 'mh-head' }, this._hudWheel, el('div', { class: 'mh-text' }, this._hudState, this._hudLabel)),
      this._hudEngine, this._hudClasses);
    document.body.append(this._hud);
  }

  // live class probabilities (bottom-left while racing)
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
        return el('div', { class: 'mh-cls' + (act === 'none' ? ' idle' : '') },
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

  _updateHud(racing) {
    this._hud.classList.toggle('hidden', !racing);
    if (!racing) return;
    this._hudWheel.style.transform = `rotate(${(-this.steer * 90).toFixed(1)}deg)`;
    const held = (k) => (this.until[k] || 0) > performance.now();
    const on = this.gasHeld || this.cruise || this.autoGas;
    const st = held('brake') ? 'BRAKE' : this.gasHeld ? 'GAS' : this.cruise ? 'CRUISE'
      : this.autoGas ? 'AUTO-ACCEL · NO MODEL' : this.hw && this.hw.buttons ? 'HOLD A OR C TO ACCELERATE' : 'COAST · ACCELERATE!';
    if (this._hudState.textContent !== st) this._hudState.textContent = st;
    this._hudState.className = 'mh-state' + (held('brake') ? ' brake' : on ? ' on' : '');
    this._updateClasses();
  }
}
