// Unified input: keyboard, standard gamepads, on-screen touch buttons and the
// Modulino rod (motion.js). Produces a fishing state each frame and
// edge-triggered menu actions.
import { clamp } from './util.js';

const KEYMAP = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  cast: ['Space', 'Enter', 'KeyJ'],
  reel: ['KeyR', 'KeyK', 'ArrowDown', 'KeyS'],
  unhook: ['KeyU', 'KeyL', 'ArrowUp', 'KeyW'],
  pause: ['Escape', 'KeyP'],
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // codes pressed this frame
    this.menuQueue = [];
    // aim: -1..1, + = left · cast: 0 or the throw quality 0..1 (one frame) · reel: held
    this.state = { aim: 0, aimFromRod: false, cast: 0, reel: false, reelGesture: false, unhook: false, pause: false };
    this.padPrev = {};
    this.touch = { aim: 0, cast: false, reel: false, unhook: false };
    this._touchPrev = { cast: false, unhook: false };
    this.lastDevice = 'keyboard';
    this.keyAim = 0;
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
      if (m && !e.repeat) this.menuQueue.push(m);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this._setupTouch();
  }

  isTouch() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  }

  any(name) { return KEYMAP[name].some((c) => this.keys.has(c)); }
  anyPressed(name) { return KEYMAP[name].some((c) => this.pressed.has(c)); }

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
    btn('.t-cast', 'cast');
    btn('.t-reel', 'reel');
    btn('.t-unhook', 'unhook');
    // drag anywhere on the aim strip
    const strip = root.querySelector('.t-aim');
    const knob = root.querySelector('.t-knob');
    if (strip) {
      const move = (t) => {
        const r = strip.getBoundingClientRect();
        const x = clamp(((t.clientX - r.left) / r.width) * 2 - 1, -1, 1);
        this.touch.aim = -x;
        knob.style.left = `${(x + 1) * 50}%`;
      };
      strip.addEventListener('touchstart', (e) => { e.preventDefault(); this.lastDevice = 'touch'; move(e.changedTouches[0]); }, { passive: false });
      strip.addEventListener('touchmove', (e) => { e.preventDefault(); move(e.changedTouches[0]); }, { passive: false });
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
    // keyboard aim sweeps smoothly and stays where you leave it
    const kd = (this.any('left') ? 1 : 0) - (this.any('right') ? 1 : 0);
    if (kd) this.keyAim = clamp(this.keyAim + kd * dt * 1.1, -1, 1);
    let aim = this.keyAim;
    let aimFromRod = false;
    let cast = this.anyPressed('cast') ? this.buttonCast ?? 0.8 : 0;
    let reel = this.any('reel');
    let reelGesture = false;
    let unhook = this.anyPressed('unhook');
    let pause = this.anyPressed('pause');
    let padAim = false;

    for (const p of this._pads()) {
      const b = (i) => p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > 0.5);
      const v = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      const ax = p.axes[0] || 0;
      const prev = this.padPrev[p.index] || {};
      const now = {
        a: b(0), b: b(1), x: b(2), y: b(3), rt: v(7), start: b(9),
        up: b(12) || (p.axes[1] || 0) < -0.6, down: b(13) || (p.axes[1] || 0) > 0.6,
        left: b(14) || ax < -0.6, right: b(15) || ax > 0.6,
      };
      if (Math.abs(ax) > 0.15) { padAim = true; this.lastDevice = 'gamepad'; this.keyAim = -ax; aim = this.keyAim; }
      if (now.a && !prev.a) cast = this.buttonCast ?? 0.8;
      reel = reel || now.x || now.rt > 0.3;
      if (now.y && !prev.y) unhook = true;
      if (now.start && !prev.start) pause = true;
      if (now.a || now.x || now.y) this.lastDevice = 'gamepad';
      const edge = (k, m) => { if (now[k] && !prev[k]) this.menuQueue.push(m); };
      edge('up', 'up'); edge('down', 'down'); edge('left', 'left'); edge('right', 'right');
      edge('a', 'ok'); edge('b', 'back'); edge('start', 'ok');
      this.padPrev[p.index] = now;
    }

    const t = this.touch;
    if (this.lastDevice === 'touch') {
      aim = t.aim;
      if (t.cast && !this._touchPrev.cast) cast = this.buttonCast ?? 0.8;
      reel = reel || t.reel;
      if (t.unhook && !this._touchPrev.unhook) unhook = true;
    }
    this._touchPrev.cast = t.cast;
    this._touchPrev.unhook = t.unhook;

    const m = this.motion && this.motion.poll();
    if (m) {
      // the rod aims unless the keyboard / pad / touch is being used right now
      if (!kd && !padAim && this.lastDevice !== 'touch') {
        aim = m.aim;
        aimFromRod = true;
        this.keyAim = m.aim;
      }
      if (m.cast) cast = Math.max(cast, m.cast);
      reel = reel || m.reel;
      reelGesture = m.reelGesture;
      unhook = unhook || m.unhook;
      pause = pause || m.pause;
    }

    s.aim = clamp(aim, -1, 1);
    s.aimFromRod = aimFromRod;
    s.cast = cast;
    s.reel = reel;
    s.reelGesture = reelGesture;
    s.unhook = unhook;
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
