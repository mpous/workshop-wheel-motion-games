// Unified input: keyboard + mouse (pointer lock), standard gamepads, on-screen
// touch controls and the Modulino controller (motion.js). Produces one player
// command per frame and edge-triggered menu actions.
import { clamp } from './util.js';

const KEYMAP = {
  fwd: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA'],
  right: ['KeyD'],
  turnL: ['ArrowLeft', 'KeyQ'],
  turnR: ['ArrowRight', 'KeyE'],
  throw: ['Space', 'KeyJ'],
  scoop: ['KeyF'],
  pack: ['KeyR'],
  snow: ['KeyK', 'KeyC'],
  run: ['ShiftLeft', 'ShiftRight', 'KeyL'],
  pause: ['Escape', 'KeyP'],
};
const KEY_THROW = 0.85;      // throw quality of a key / button press (gestures use the model confidence)

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // codes pressed this frame
    this.menuQueue = [];
    // move: x strafe (+ right), y forward · turn: rate -1..1 (+ = left) · look: mouse radians this frame
    this.state = {
      moveX: 0, moveY: 0, turn: 0, lookX: 0, lookY: 0, fromMotion: false,
      throw: 0, scoop: false, pack: false, snow: false, run: false, runGesture: false, pause: false,
    };
    this.padPrev = {};
    this.touch = { x: 0, y: 0, lookX: 0, lookY: 0, throw: false, snow: false, run: false };
    this._touchPrev = { throw: false, snow: false };
    this.lastDevice = 'keyboard';
    this.motion = null; // MotionController, set by the app
    this.mouse = { dx: 0, dy: 0, click: false, right: false };
    this.mouseSens = 0.0024;
    this.pointerTarget = null;
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
        if (e.code === 'Escape') this.menuQueue.push('back');
        return;
      }
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
      const m = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', Enter: 'ok', Space: 'ok', Escape: 'back', Backspace: 'back' }[e.code];
      if (m && !e.repeat) this.menuQueue.push(m);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
        this.lastDevice = 'keyboard';
      }
    });
    window.addEventListener('mousedown', (e) => {
      if (!document.pointerLockElement) return;
      if (e.button === 0) this.mouse.click = true;
      if (e.button === 2) this.mouse.right = true;
    });
    window.addEventListener('contextmenu', (e) => { if (document.pointerLockElement) e.preventDefault(); });
    this._setupTouch();
  }

  isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  any(name) { return KEYMAP[name].some((c) => this.keys.has(c)); }
  anyPressed(name) { return KEYMAP[name].some((c) => this.pressed.has(c)); }

  lockPointer(elm) {
    if (this.isTouch() || !elm || !elm.requestPointerLock) return;
    try { const p = elm.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed now */ }
  }

  unlockPointer() { if (document.pointerLockElement) document.exitPointerLock(); }

  _setupTouch() {
    const root = document.getElementById('touch');
    if (!root) return;
    const btn = (sel, prop) => {
      const b = root.querySelector(sel);
      if (!b) return;
      const on = (e) => { e.preventDefault(); this.touch[prop] = true; b.classList.add('on'); this.lastDevice = 'touch'; };
      const off = (e) => { e.preventDefault(); this.touch[prop] = false; b.classList.remove('on'); };
      b.addEventListener('touchstart', on, { passive: false });
      b.addEventListener('touchend', off, { passive: false });
      b.addEventListener('touchcancel', off, { passive: false });
    };
    btn('.t-throw', 'throw');
    btn('.t-snow', 'snow');
    btn('.t-run', 'run');
    // virtual stick (left) and look pad (right)
    const stick = root.querySelector('.t-stick');
    const knob = root.querySelector('.t-knob');
    if (stick) {
      let id = null;
      const move = (t) => {
        const r = stick.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
        let x = (t.clientX - cx) / R, y = (t.clientY - cy) / R;
        const l = Math.hypot(x, y);
        if (l > 1) { x /= l; y /= l; }
        this.touch.x = x; this.touch.y = -y;
        knob.style.transform = `translate(${x * R * 0.6}px, ${y * R * 0.6}px)`;
      };
      const end = () => { id = null; this.touch.x = 0; this.touch.y = 0; knob.style.transform = ''; };
      stick.addEventListener('touchstart', (e) => { e.preventDefault(); this.lastDevice = 'touch'; id = e.changedTouches[0].identifier; move(e.changedTouches[0]); }, { passive: false });
      stick.addEventListener('touchmove', (e) => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === id) move(t); }, { passive: false });
      stick.addEventListener('touchend', (e) => { e.preventDefault(); end(); }, { passive: false });
      stick.addEventListener('touchcancel', end);
    }
    const look = root.querySelector('.t-look');
    if (look) {
      let last = null, id = null;
      look.addEventListener('touchstart', (e) => { e.preventDefault(); this.lastDevice = 'touch'; const t = e.changedTouches[0]; id = t.identifier; last = [t.clientX, t.clientY]; }, { passive: false });
      look.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier !== id || !last) continue;
          this.touch.lookX += t.clientX - last[0];
          this.touch.lookY += t.clientY - last[1];
          last = [t.clientX, t.clientY];
        }
      }, { passive: false });
      look.addEventListener('touchend', () => { last = null; id = null; });
    }
  }

  _pads() {
    const out = [];
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) out.push(p);
    return out;
  }

  // called once per frame
  poll(dt = 1 / 60) {
    const s = this.state;
    let mx = (this.any('right') ? 1 : 0) - (this.any('left') ? 1 : 0);
    let my = (this.any('fwd') ? 1 : 0) - (this.any('back') ? 1 : 0);
    let turn = (this.any('turnL') ? 1 : 0) - (this.any('turnR') ? 1 : 0);
    let lookX = this.mouse.dx * this.mouseSens;
    let lookY = this.mouse.dy * this.mouseSens;
    let thr = this.anyPressed('throw') || this.mouse.click ? KEY_THROW : 0;
    let scoop = this.anyPressed('scoop');
    let pack = this.anyPressed('pack');
    let snow = this.anyPressed('snow') || this.mouse.right;
    let run = this.any('run');
    let runGesture = false;
    let pause = this.anyPressed('pause');
    let fromMotion = false;
    this.mouse.dx = this.mouse.dy = 0;
    this.mouse.click = this.mouse.right = false;

    for (const p of this._pads()) {
      const b = (i) => p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
      const v = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      const dz = (x) => (Math.abs(x) < 0.15 ? 0 : x);
      const ax = dz(p.axes[0] || 0), ay = dz(p.axes[1] || 0), rx = dz(p.axes[2] || 0), ry = dz(p.axes[3] || 0);
      const prev = this.padPrev[p.index] || {};
      const now = {
        a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rt: v(7) > 0.5, lt: v(6) > 0.5, l3: b(10), start: b(9),
        up: b(12) || (p.axes[1] || 0) < -0.6, down: b(13) || (p.axes[1] || 0) > 0.6,
        left: b(14) || (p.axes[0] || 0) < -0.6, right: b(15) || (p.axes[0] || 0) > 0.6,
      };
      if (ax || ay || rx || ry) this.lastDevice = 'gamepad';
      if (ax || ay) { mx = ax; my = -ay; }
      if (rx) lookX += rx * dt * 2.6;
      if (ry) lookY += ry * dt * 1.8;
      if ((now.a && !prev.a) || (now.rt && !prev.rt)) thr = KEY_THROW;
      if (now.x && !prev.x) snow = true;
      if (now.y && !prev.y) pack = true;
      if (now.lb && !prev.lb) scoop = true;
      run = run || now.b || now.lt || now.l3;
      if (now.start && !prev.start) pause = true;
      if (now.a || now.x || now.y || now.b) this.lastDevice = 'gamepad';
      const edge = (k, m) => { if (now[k] && !prev[k]) this.menuQueue.push(m); };
      edge('up', 'up'); edge('down', 'down'); edge('left', 'left'); edge('right', 'right');
      edge('a', 'ok'); edge('b', 'back'); edge('start', 'ok');
      this.padPrev[p.index] = now;
    }

    const t = this.touch;
    if (this.lastDevice === 'touch') {
      if (t.x || t.y) { mx = t.x; my = t.y; }
      lookX += t.lookX * 0.006;
      lookY += t.lookY * 0.004;
      if (t.throw && !this._touchPrev.throw) thr = KEY_THROW;
      if (t.snow && !this._touchPrev.snow) snow = true;
      run = run || t.run;
    }
    t.lookX = t.lookY = 0;
    this._touchPrev.throw = t.throw;
    this._touchPrev.snow = t.snow;

    const m = this.motion && this.motion.poll();
    if (m) {
      // the controller tilt turns unless the keyboard / pad / touch is turning right now
      if (!turn && !lookX && this.lastDevice === 'motion') { turn = m.turn; fromMotion = true; }
      else if (!turn && !lookX && Math.abs(m.turn) > 0.05) { turn = m.turn; fromMotion = true; }
      if (m.throw) thr = Math.max(thr, m.throw);
      scoop = scoop || m.scoop;
      pack = pack || m.pack;
      snow = snow || m.snow;
      run = run || m.run;
      runGesture = m.runGesture;
      pause = pause || m.pause;
    }

    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    s.moveX = mx;
    s.moveY = my;
    s.turn = clamp(turn, -1, 1);
    s.lookX = lookX;
    s.lookY = lookY;
    s.fromMotion = fromMotion;
    s.throw = thr;
    s.scoop = scoop;
    s.pack = pack;
    s.snow = snow;
    s.run = run;
    s.runGesture = runGesture;
    s.pause = pause;
    this.pressed.clear();
    return s;
  }

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
