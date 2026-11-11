// Unified input: keyboard, standard gamepads, an on-screen touch layout and
// the Modulino wheel (motion.js).
// Produces a driving state each frame and edge-triggered menu actions.
import { clamp } from './util.js';

const KEYMAP = {
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  drift: ['Space', 'ShiftLeft', 'ShiftRight', 'KeyK'],
  item: ['KeyE', 'KeyJ', 'ControlLeft', 'KeyX', 'Enter'],
  back: ['KeyQ', 'KeyL'],
  pause: ['Escape', 'KeyP'],
  camera: ['KeyC'],
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // codes pressed this frame
    this.menuQueue = [];
    this.state = { throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, item: false, itemBack: false, lookBack: false, pause: false };
    this.prevDrift = false;
    this.prevItem = false;
    this.padPrev = {};
    this.touch = { active: false, steer: 0, drift: false, item: false, brake: false, accel: true };
    this.lastDevice = 'keyboard';
    this.autoAccel = false;
    this.motion = null; // MotionController, set by the app
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
        if (e.code === 'Escape') this.menuQueue.push('back');
        return;
      }
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      const m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', Enter: 'ok', Space: 'ok', Escape: 'back', Backspace: 'back' }[e.code];
      if (m) this.menuQueue.push(m);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this._setupTouch();
  }

  isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  any(name) {
    return KEYMAP[name].some((c) => this.keys.has(c));
  }
  anyPressed(name) {
    return KEYMAP[name].some((c) => this.pressed.has(c));
  }

  _setupTouch() {
    const root = document.getElementById('touch');
    if (!root) return;
    const stick = root.querySelector('.t-stick');
    const knob = root.querySelector('.t-knob');
    const btn = (sel, prop) => {
      const b = root.querySelector(sel);
      if (!b) return;
      const on = (e) => { e.preventDefault(); this.touch[prop] = true; b.classList.add('on'); this.lastDevice = 'touch'; };
      const off = (e) => { e.preventDefault(); this.touch[prop] = false; b.classList.remove('on'); };
      b.addEventListener('touchstart', on, { passive: false });
      b.addEventListener('touchend', off, { passive: false });
      b.addEventListener('touchcancel', off, { passive: false });
    };
    btn('.t-drift', 'drift');
    btn('.t-item', 'item');
    btn('.t-brake', 'brake');
    btn('.t-back', 'lookBack');
    if (stick) {
      let id = null, cx = 0;
      const move = (t) => {
        const r = stick.getBoundingClientRect();
        const dx = clamp((t.clientX - cx) / (r.width * 0.42), -1, 1);
        this.touch.steer = Math.sign(dx) * Math.pow(Math.abs(dx), 1.3);
        knob.style.transform = `translate(${dx * r.width * 0.32}px, 0)`;
      };
      stick.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        id = t.identifier;
        const r = stick.getBoundingClientRect();
        cx = r.left + r.width / 2;
        this.touch.active = true;
        this.lastDevice = 'touch';
        move(t);
      }, { passive: false });
      stick.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) if (t.identifier === id) move(t);
      }, { passive: false });
      const end = (e) => {
        for (const t of e.changedTouches) if (t.identifier === id) {
          id = null;
          this.touch.steer = 0;
          knob.style.transform = '';
        }
      };
      stick.addEventListener('touchend', end);
      stick.addEventListener('touchcancel', end);
    }
  }

  _pads() {
    const out = [];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) out.push(p);
    return out;
  }

  // called once per frame
  poll() {
    const s = this.state;
    let throttle = this.any('up') ? 1 : 0;
    let brake = this.any('down') ? 1 : 0;
    let steer = (this.any('left') ? 1 : 0) - (this.any('right') ? 1 : 0);
    let drift = this.any('drift');
    let item = this.any('item');
    let lookBack = this.any('back');
    let pause = this.anyPressed('pause');
    let itemBack = brake > 0 || lookBack;

    for (const p of this._pads()) {
      const b = (i) => p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
      const v = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      const ax = p.axes[0] || 0;
      const dz = Math.abs(ax) > 0.15 ? (ax - Math.sign(ax) * 0.15) / 0.85 : 0;
      const prev = this.padPrev[p.index] || {};
      const now = {
        a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rb: b(5), lt: v(6), rt: v(7), start: b(9), back: b(8),
        up: b(12) || (p.axes[1] || 0) < -0.6, down: b(13) || (p.axes[1] || 0) > 0.6,
        left: b(14) || ax < -0.6, right: b(15) || ax > 0.6,
      };
      const any = now.a || now.b || now.x || now.rt > 0.2 || Math.abs(dz) > 0.2;
      if (any) this.lastDevice = 'gamepad';
      throttle = Math.max(throttle, now.a ? 1 : 0, now.rt);
      brake = Math.max(brake, now.b ? 1 : 0, now.lt);
      if (Math.abs(dz) > Math.abs(steer)) steer = -dz;
      if (now.left) steer = 1;
      if (now.right) steer = -1;
      drift = drift || now.rb || now.lb;
      item = item || now.x;
      lookBack = lookBack || now.y;
      if (now.down && (p.axes[1] || 0) > 0.6) itemBack = true;
      if (now.start && !prev.start) pause = true;
      // menu edges
      const edge = (k, m) => { if (now[k] && !prev[k]) this.menuQueue.push(m); };
      edge('up', 'up'); edge('down', 'down'); edge('left', 'left'); edge('right', 'right');
      edge('a', 'ok'); edge('b', 'back'); edge('start', 'ok');
      edge('lb', 'prevTab'); edge('rb', 'nextTab');
      this.padPrev[p.index] = now;
    }

    const t = this.touch;
    if (this.lastDevice === 'touch') {
      throttle = t.brake ? 0 : 1;
      brake = t.brake ? 1 : 0;
      steer = -t.steer;
      drift = drift || t.drift;
      item = item || t.item;
      lookBack = lookBack || t.lookBack;
    }
    let camera = this.anyPressed('camera');
    const m = this.motion && this.motion.poll();
    if (m) {
      // the wheel steers unless another device is actively steering
      if (Math.abs(steer) < 0.05) steer = m.steer;
      throttle = Math.max(throttle, m.throttle);
      brake = Math.max(brake, m.brake);
      if (m.brake) throttle = 0;
      drift = drift || m.drift;
      item = item || m.item;
      lookBack = lookBack || m.lookBack;
      pause = pause || m.pause;
      camera = camera || m.camera;
      itemBack = itemBack || m.brake > 0 || m.lookBack;
    }
    if (this.autoAccel && !brake) throttle = 1;

    s.throttle = throttle;
    s.brake = brake;
    s.steer = clamp(steer, -1, 1);
    s.driftPressed = drift && !this.prevDrift;
    s.drift = drift;
    s.item = item && !this.prevItem;
    s.itemBack = itemBack;
    s.lookBack = lookBack;
    s.pause = pause;
    s.camera = camera;
    this.prevDrift = drift;
    this.prevItem = item;
    this.pressed.clear();
    return s;
  }

  // edge-triggered menu actions since the last call
  menuActions() {
    const q = this.menuQueue;
    this.menuQueue = [];
    return q;
  }

  rumble(strength = 0.5, ms = 120) {
    for (const p of this._pads()) {
      const a = p.vibrationActuator;
      if (a && a.playEffect) a.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
    }
    if (this.lastDevice === 'touch' && navigator.vibrate) navigator.vibrate(Math.min(ms, 60));
  }
}
