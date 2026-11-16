// One 3 minute fishing match (solo or tournament): the seeded fish signs,
// aiming and casting, the bite, the fight against a running fish, unhooking
// and scoring. Also the attract mode behind the menus.
import * as THREE from '../libs/three.bundle.js';
import { clamp, lerp, damp, dampAngle, makeRng } from './util.js';
import { shoreDist, DOCK_Y } from './world.js';
import { rollSpecies, rollWeight, FishModel } from './fish.js';
import { Rod } from './rod.js';
import { Hud } from './hud.js';

export const MATCH_MS = 180000;
const DEG = Math.PI / 180;
const AIM_RANGE = 50 * DEG;
const LOCK_CONE = 12 * DEG;
const DEFAULT_DIST = 22;
const HOOK_RADIUS = 4.5;
const UNHOOK_S = 6;
const MAX_LINE = 55;
export const EYE = new THREE.Vector3(0, DOCK_Y + 1.62, 0.5);

// local phase -> phase name the server / LED matrix knows
const SERVER_PHASE = { countdown: 'aim', aim: 'aim', flight: 'wait', wait: 'wait', bite: 'bite', fight: 'fight', unhook: 'unhook', caught: 'caught', lost: 'aim', over: 'aim' };

const polar = (a, d, out = new THREE.Vector3()) => out.set(-Math.sin(a) * d, 0, -Math.cos(a) * d);
const angleOf = (p) => Math.atan2(-p.x, -p.z);
const flatDist = (p) => Math.hypot(p.x, p.z);

// keep a point on the water, well away from the shore
function intoLake(p) {
  for (let k = 0; k < 12 && shoreDist(p.x, p.z) > -4; k++) p.multiplyScalar(0.9);
  return p;
}

// Every board in a tournament builds the same schedule from the match seed.
export function buildSchedule(seed, durS) {
  const rng = makeRng(seed);
  const out = [];
  const ends = [];
  let t = 1.2;
  while (t < durS - 3) {
    const life = rng.range(9, 13);
    const live = ends.filter((e) => e > t).length;
    const golden = rng() < 0.05;
    const r = rng();
    const kind = golden ? 'golden' : r < 0.36 ? 'ripples' : r < 0.62 ? 'bubbles' : r < 0.84 ? 'jump' : 'shadow';
    const a = rng.range(-45, 45) * DEG;
    const d = rng.range(10, 38);
    const sp = rollSpecies(rng, { kind });
    const s = { id: out.length, t, a, d, life, kind, sp, kg: rollWeight(rng, sp), nibbles: rng.int(1, 3), delay: rng.range(0.8, 2) };
    if (live < 3) { out.push(s); ends.push(t + life); }
    t += rng.range(3, 6);
  }
  for (const s of out) {
    s.pos = intoLake(polar(s.a, s.d));
    s.a = angleOf(s.pos); s.d = flatDist(s.pos);
  }
  return out;
}

// dark blurred shape for the "shadow" sign
let shadowTex = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 32, 4, 64, 32, 60);
  gr.addColorStop(0, 'rgba(5,12,14,0.85)'); gr.addColorStop(0.6, 'rgba(5,12,14,0.35)'); gr.addColorStop(1, 'rgba(5,12,14,0)');
  g.fillStyle = gr;
  g.save(); g.scale(1, 0.5); g.beginPath(); g.arc(64, 64, 62, 0, 7); g.fill(); g.restore();
  return (shadowTex = new THREE.CanvasTexture(c));
}

// ------------------------------------------------------------------ signs, shared by matches and attract mode
class SignField {
  constructor(game) {
    this.g = game;
    this.world = game.world;
    this.active = [];
    this.leaps = [];
    this.shadows = Array.from({ length: 3 }, () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, fog: true }));
      m.visible = false;
      m.renderOrder = 1;
      game.app.scene.add(m);
      return m;
    });
  }

  spawn(s) {
    s.age = 0; s.emit = 0; s.taken = false;
    this.active.push(s);
    if (s.kind === 'jump') this.leap(s.pos, s.sp, s.kg);
    if (s.kind === 'shadow') {
      const m = this.shadows.find((x) => !x.visible);
      if (m) { s.shadow = m; m.visible = true; m.material.opacity = 0; }
    }
    if (s.kind === 'golden') this.world.sparkle(new THREE.Vector3(s.pos.x, 0.3, s.pos.z), 30, [1, 0.82, 0.3], 0.8, 2);
  }

  leap(pos, sp, kg, { power = 1, dir = Math.random() * Math.PI * 2 } = {}) {
    const model = new FishModel(sp, kg);
    this.g.app.scene.add(model.root);
    const L = model.len;
    const h = (0.6 + L * 1.6) * power;
    const run = (1.2 + L * 2) * power;
    this.leaps.push({ model, from: pos.clone(), dx: Math.cos(dir) * run, dz: Math.sin(dir) * run, dir, h, t: 0, dur: 0.55 + Math.sqrt(h) * 0.35 });
    this.world.splashAt(pos.x, pos.z, 0.35 + L * 0.5);
    this.g.app.audio.play('jump');
  }

  update(dt) {
    const w = this.world;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i];
      s.age += dt;
      const fading = s.age > s.life - 1;
      if (s.age > s.life || s.taken) {
        if (s.shadow) { s.shadow.visible = false; s.shadow = null; }
        this.active.splice(i, 1);
        continue;
      }
      s.emit -= dt;
      const p = s.pos;
      if (s.shadow) {
        const m = s.shadow;
        const a = s.age * 0.35 + s.id;
        m.position.set(p.x + Math.cos(a) * 1.2, 0.025, p.z + Math.sin(a) * 1.2);
        m.rotation.y = -a - Math.PI / 2;
        m.material.opacity = Math.min(1, s.age * 0.8, (s.life - s.age) * 0.8) * 0.9;
        m.scale.setScalar(0.6 + s.sp.len * 0.9);
      }
      if (s.emit > 0 || fading) continue;
      switch (s.kind) {
        case 'ripples': w.ripples.add(p.x + (Math.random() - 0.5), p.z + (Math.random() - 0.5), 1.4 + Math.random(), 1.8, 0.55); s.emit = 0.8; break;
        case 'bubbles': w.bubble(p.x, p.z); s.emit = 0.22 + Math.random() * 0.2; break;
        case 'jump': w.ripples.add(p.x, p.z, 1.8, 2, 0.5); s.emit = 1.3; if (Math.random() < 0.18) this.leap(p, s.sp, s.kg, { power: 0.8 }); break;
        case 'shadow': if (s.shadow) w.ripples.add(s.shadow.position.x, s.shadow.position.z, 0.9, 1.4, 0.35); s.emit = 1.1; break;
        case 'golden':
          w.ripples.add(p.x, p.z, 1.6, 1.8, 0.75, 0xffd66b);
          w.sparkle(new THREE.Vector3(p.x, 0.1, p.z), 4, [1, 0.8, 0.3], 0.7, 1.4);
          s.emit = 0.5; break;
      }
    }
    for (let i = this.leaps.length - 1; i >= 0; i--) {
      const l = this.leaps[i];
      l.t += dt;
      const u = l.t / l.dur;
      if (u >= 1) {
        w.splashAt(l.from.x + l.dx, l.from.z + l.dz, 0.3 + l.model.len * 0.4);
        this.g.app.scene.remove(l.model.root);
        l.model.dispose();
        this.leaps.splice(i, 1);
        continue;
      }
      const m = l.model;
      m.root.position.set(l.from.x + l.dx * u, -0.2 + l.h * 4 * u * (1 - u), l.from.z + l.dz * u);
      m.root.rotation.set(0, -l.dir, 0);
      m.body.rotation.z = (0.5 - u) * 2.2;           // nose up, then down
      m.update(dt, 1);
    }
  }

  dispose() {
    for (const l of this.leaps) { this.g.app.scene.remove(l.model.root); l.model.dispose(); }
    for (const m of this.shadows) { this.g.app.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this.leaps = [];
    this.active = [];
  }
}

// ------------------------------------------------------------------ attract mode (behind the menus)
export class Attract {
  constructor(app) {
    this.app = app;
    this.world = app.world;
    this.signs = new SignField(this);
    this.t = 0;
    this.next = 1;
    this.rng = makeRng((Math.random() * 1e9) | 0);
  }

  update(dt) {
    this.t += dt;
    this.next -= dt;
    if (this.next <= 0) {
      const s = buildSchedule(this.rng.int(1, 1e9), 8)[0];
      if (s) { s.life = 8; this.signs.spawn(s); }
      this.next = 2.5 + Math.random() * 2.5;
    }
    this.signs.update(dt);
    const c = this.app.camera;
    c.position.set(EYE.x + Math.sin(this.t * 0.05) * 0.4, EYE.y + 0.6 + Math.sin(this.t * 0.3) * 0.05, EYE.z + 3);
    c.rotation.set(-0.06 + Math.sin(this.t * 0.11) * 0.02, Math.sin(this.t * 0.06) * 0.55, 0, 'YXZ');
  }

  dispose() { this.signs.dispose(); }
}

// ------------------------------------------------------------------ the match
export class Game {
  // mode 'solo' | 'tourney' · startAt: performance.now() when the clock starts
  constructor(app, { mode = 'solo', seed = 1, startAt = performance.now() + 3000, durationMs = MATCH_MS, players = null } = {}) {
    this.app = app;
    this.world = app.world;
    this.mode = mode;
    this.seed = seed;
    this.startAt = startAt;
    this.durationMs = durationMs;
    this.players = players;
    this.schedule = buildSchedule(seed, durationMs / 1000);
    this.nextSign = 0;
    this.signs = new SignField(this);
    this.phase = 'countdown';
    this.count = 0;
    this.paused = false;
    // score
    this.fish = 0;
    this.kg = 0;
    this.catches = [];
    this.biggest = null;
    this.place = 0;
    // aim / view
    this.aim = 0;               // -1..1, + = left
    this.yaw = 0;
    this.pitch = -0.1;
    this.lock = null;           // sign the aim ring locked on
    this.targetDist = DEFAULT_DIST;
    this.lure = null;           // world position of the end of the line
    this.T = 0;                 // line tension 0..1
    this.reeling = 0;
    this.f = null;              // the fish on the line
    this.bite = null;           // a fish interested in the lure
    this.timer = 0;             // phase timer (s)
    this.stats = { casts: 0, perfect: 0, snapped: 0, escaped: 0 };
    this.rod = new Rod(app);
    this._buildRing();
    this.hud = new Hud(app, this);
    this.bob = { pos: new THREE.Vector3(), tiltX: 0, tiltZ: 0, dip: 0 };
  }

  _buildRing() {
    const g = new THREE.Group();
    const mk = (r0, r1, op) => new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: op, depthWrite: false, fog: false }));
    this.ringOuter = mk(0.92, 1, 0.75);
    this.ringInner = mk(0.08, 0.16, 0.9);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3, 6, 1, true).translate(0, 1.5, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending }));
    g.add(this.ringOuter, this.ringInner, beam);
    g.position.y = 0.05;
    g.renderOrder = 3;
    this.ring = g;
    this.ringBeam = beam;
    this.app.scene.add(g);
  }

  // ------------------------------------------------------------------ clock
  get elapsed() { return ((this.paused ? this.pausedAt : performance.now()) - this.startAt) / 1000; }
  get remaining() { return clamp(this.durationMs / 1000 - this.elapsed, 0, this.durationMs / 1000); }
  get aimAngle() { return this.aim * AIM_RANGE; }

  pause(on) {
    if (this.mode !== 'solo' || on === this.paused) return;
    if (on) { this.pausedAt = performance.now(); this.paused = true; }
    else { this.startAt += performance.now() - this.pausedAt; this.paused = false; }
  }

  // ------------------------------------------------------------------ board feedback (motion.js)
  pixels() {
    switch (this.phase) {
      case 'aim': return [1, Math.round(-this.aim * 100)];
      case 'flight': case 'wait': return [2, 0];
      case 'bite': return [3, 0];
      case 'fight': return [4, Math.round(this.T * 100)];
      case 'unhook': return [5, Math.round((this.timer / UNHOOK_S) * 100)];
      case 'caught': return [6, 0];
      case 'lost': return [7, 0];
      default: return [0, 0];
    }
  }

  // LEDs of the buttons that do something now: A cast · B reel · C unhook
  buttonMask() { return { aim: 1, wait: 3, fight: 2, unhook: 4 }[this.phase] || 0; }

  wantedAction() { return { aim: 'cast', fight: 'reel', unhook: 'unhook' }[this.phase] || null; }

  serverPhase() { return SERVER_PHASE[this.phase] || 'aim'; }

  status() {
    const state = this.phase === 'countdown' ? 'countdown' : this.phase === 'over' ? 'finished' : 'fishing';
    return { state, count: this.count, secs: Math.ceil(this.remaining), fish: this.fish, phase: this.serverPhase(), place: this.place };
  }

  score() { return { fish: this.fish, kg: Math.round(this.kg * 100) / 100, phase: this.serverPhase() }; }

  // ------------------------------------------------------------------ per frame
  update(dt, inp) {
    if (this.paused) { this.hud.update(dt); return; }
    const el = this.elapsed;
    const a = this.app.audio;
    this.aim = damp(this.aim, inp.aim, 14, dt);
    if (this.phase === 'countdown') {
      const c = Math.ceil(-el);
      if (c !== this.count && c >= 1 && c <= 3) a.play('countdown');
      this.count = Math.max(0, c);
      if (el >= 0) {
        this.phase = 'aim';
        this.count = 0;
        a.play('go');
        a.playMusic('fishing', { fade: 1.5 });
        this.hud.banner('GO!', 'go');
      }
    } else if (this.phase !== 'over' && el >= this.durationMs / 1000) {
      this._end();
    }
    if (this.phase !== 'countdown' && this.phase !== 'over') {
      while (this.nextSign < this.schedule.length && this.schedule[this.nextSign].t <= el) this.signs.spawn(this.schedule[this.nextSign++]);
    }
    this.signs.update(dt);
    this.timer -= dt;
    switch (this.phase) {
      case 'countdown': case 'aim': this._aim(dt, inp); break;
      case 'flight': this._flight(dt); break;
      case 'wait': this._wait(dt, inp); break;
      case 'bite': this._biting(dt); break;
      case 'fight': this._fight(dt, inp); break;
      case 'unhook': this._unhook(dt, inp); break;
      case 'caught': if (this.timer <= 0) this._reset(); else this._showFish(dt, true); break;
      case 'lost': if (this.timer <= 0) this._reset(); break;
    }
    this._camera(dt);
    this._ringUpdate(dt);
    const reel = this.phase === 'fight' || this.phase === 'wait' ? (inp.reel ? 1 : 0) : 0;
    this.reeling = reel;
    const sideA = this.f ? clamp((this.f.a - this.yaw) * 2.5, -1, 1) : 0;
    this.rod.update(dt, {
      tension: this.phase === 'fight' || this.phase === 'bite' ? this.T : this.phase === 'unhook' || this.phase === 'caught' ? 0.25 : 0,
      side: sideA, reeling: reel, lure: this.lure, slack: this.f ? clamp(this.f.slack / 4, 0, 1) : this.phase === 'wait' ? 0.4 : 0,
      bobber: this.phase === 'flight' || this.phase === 'wait' || this.phase === 'bite' ? this.bob : null,
    });
    a.setReel(reel ? (this.phase === 'fight' && this.f && this.f.run ? 0.55 : 1) : 0, this.phase === 'fight' ? this.T : 0);
    a.setIntensity(this.phase === 'fight' ? 0.45 + this.T * 0.55 : this.phase === 'bite' ? 0.6 : this.phase === 'wait' ? 0.15 : 0);
    this.hud.update(dt);
  }

  // ------------------------------------------------------------------ aim & cast
  _aim(dt, inp) {
    const ang = this.aimAngle;
    // auto-range: lock on the nearest sign inside the aim cone
    let best = null, bestD = LOCK_CONE;
    for (const s of this.signs.active) {
      const d = Math.abs(s.a - ang);
      if (d < bestD && !s.taken && s.age < s.life - 0.5) { bestD = d; best = s; }
    }
    this.lock = best;
    this.targetDist = damp(this.targetDist, best ? best.d : DEFAULT_DIST, 6, dt);
    if (this.phase === 'aim' && inp.cast > 0) this._cast(inp.cast);
  }

  _cast(p) {
    const ang = this.aimAngle;
    const q = clamp((p - 0.5) / 0.5, 0, 1);
    const scatter = lerp(4.5, 0.6, q);
    const r = Math.sqrt(Math.random()) * scatter, th = Math.random() * Math.PI * 2;
    const to = polar(ang, this.targetDist).add(new THREE.Vector3(Math.cos(th) * r, 0, Math.sin(th) * r));
    intoLake(to);
    if (flatDist(to) < 6) to.setLength(6);
    const d = flatDist(to);
    this.flight = { to, t: -0.3, dur: 0.75 + d * 0.014, h: 3 + d * 0.16, from: null };
    this.castQuality = p;
    this.stats.casts++;
    if (p >= 0.9) this.stats.perfect++;
    this.phase = 'flight';
    this.lock = null;
    this.rod.startCast();
    this.app.audio.play('whoosh', { power: p });
    this.app.input.rumble(0.25, 80);
    this.hud.flash(p >= 0.9 ? 'PERFECT CAST' : p >= 0.75 ? 'GREAT CAST' : 'CAST', `${Math.round(p * 100)}%`, p >= 0.9 ? 'gold' : '');
  }

  _flight(dt) {
    const f = this.flight;
    f.t += dt;
    if (f.t < 0) { this.lure = null; return; }
    if (!f.from) f.from = this.rod.tipPosition().clone();
    const u = clamp(f.t / f.dur, 0, 1);
    const p = (this.lure ||= new THREE.Vector3());
    p.lerpVectors(f.from, f.to, u);
    p.y = lerp(f.from.y, 0.02, u) + f.h * 4 * u * (1 - u);
    this.bob.pos.copy(p);
    this.bob.tiltX = u * 6;
    if (u >= 1) this._land();
  }

  _land() {
    const p = this.lure;
    p.y = 0.02;
    this.world.splashAt(p.x, p.z, 0.3);
    this.app.audio.play('splash', { big: 0.15 });
    this.app.audio.play('plop');
    this.phase = 'wait';
    this.retrieving = false;
    this._pickBite();
  }

  // a sign near the lure commits its fish; otherwise a wandering fish shows up later
  _pickBite() {
    const p = this.lure;
    let best = null, bestD = HOOK_RADIUS;
    for (const s of this.signs.active) {
      if (s.taken || s.age > s.life - 0.3) continue;
      const d = Math.hypot(s.pos.x - p.x, s.pos.z - p.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best) {
      best.taken = true;
      // a good cast gets a quicker, more decided bite
      const q = clamp(this.castQuality || 0.8, 0, 1);
      this.bite = { sp: best.sp, kg: best.kg, nibbles: best.nibbles, next: best.delay * lerp(1.2, 0.7, q), sign: best.kind };
      if (best.kind === 'golden') this.hud.flash('SOMETHING SHINY…', '', 'gold');
    } else {
      this.bite = { sp: null, kg: 0, nibbles: 1 + ((Math.random() * 3) | 0), next: 6 + Math.random() * 5, wander: true };
    }
  }

  _wait(dt, inp) {
    const p = this.lure;
    const b = this.bob;
    const t = performance.now() / 1000;
    b.dip = Math.max(0, b.dip - dt * 5);
    b.pos.set(p.x, 0.03 + Math.sin(t * 2.3) * 0.025 - b.dip * 0.14, p.z);
    b.tiltX = Math.sin(t * 1.7) * 0.08;
    b.tiltZ = Math.cos(t * 1.3) * 0.08 + b.dip * 0.4;
    if (inp.cast > 0) { this._cast(inp.cast); return; }      // recast straight away
    if (inp.reel) {
      // retrieving scares the fish off; the lure skims back
      if (!this.retrieving && this.bite && !this.bite.wander) this.hud.flash('SPOOKED IT', '', 'warn');
      this.retrieving = true;
      this.bite = null;
      const d = flatDist(p);
      const nd = d - 7 * dt;
      if (nd < 3) { this._reset(); return; }
      p.x *= nd / d; p.z *= nd / d;
      if (Math.random() < dt * 10) this.world.ripples.add(p.x, p.z, 0.4, 0.8, 0.5);
      return;
    }
    if (this.retrieving) { this.retrieving = false; this._pickBite(); }
    const bt = this.bite;
    if (!bt) return;
    bt.next -= dt;
    if (bt.next > 0) return;
    if (bt.wander && !bt.sp) {
      const r = makeRng((Math.random() * 1e9) | 0);
      bt.sp = rollSpecies(r, { kind: 'wander' });
      bt.kg = rollWeight(r, bt.sp);
    }
    if (bt.nibbles > 0) {
      bt.nibbles--;
      bt.next = 0.5 + Math.random() * 0.5;
      b.dip = 1;
      this.world.ripples.add(p.x, p.z, 0.7, 1, 0.7);
      this.app.audio.play('nibble');
      return;
    }
    this._bite();
  }

  _bite() {
    const bt = this.bite;
    this.bite = null;
    const p = this.lure;
    this.phase = 'bite';
    this.timer = 1;
    this.T = 0.3;
    this.world.splashAt(p.x, p.z, 0.8);
    this.app.audio.play('bite');
    this.app.audio.play('hook');
    this.app.input.rumble(0.8, 260);
    this.hud.banner('FISH ON!', 'hot');
    const sp = bt.sp;
    const big = clamp((bt.kg - sp.kg[0]) / (sp.kg[1] - sp.kg[0]), 0, 1);
    this.f = {
      sp, kg: bt.kg, r: flatDist(p), a: angleOf(p),
      strength: sp.strength * (0.75 + 0.5 * big),
      run: false, runT: 0.4, runDir: 1, speed: 0, stamina: 1,
      slack: 0, over: 0, wake: 0, jumpCd: 2,
      model: new FishModel(sp, bt.kg),
    };
    this.f.model.root.visible = false;
    this.app.scene.add(this.f.model.root);
  }

  _biting(dt) {
    const f = this.f;
    this.T = damp(this.T, 0.45, 4, dt);
    this.bob.pos.y = -0.3;
    polar(f.a, f.r, this.lure);
    if (this.timer <= 0) this.phase = 'fight';
  }

  // ------------------------------------------------------------------ the fight
  _fight(dt, inp) {
    const f = this.f, sp = f.sp;
    f.runT -= dt;
    if (f.runT <= 0) {
      f.run = !f.run;
      if (f.run) {
        f.runT = (1.2 + Math.random() * 1.6) * (0.6 + 0.4 * f.stamina);
        f.runDir = Math.abs(f.a) > 40 * DEG ? -Math.sign(f.a) : Math.random() < 0.5 ? -1 : 1;
        f.speed = (0.9 + f.strength * 1.2) * (0.45 + 0.55 * f.stamina);
        if (sp.jumpy > 0 && f.jumpCd <= 0 && Math.random() < sp.jumpy * 0.6 && f.r > 5) {
          f.jumpCd = 4;
          this.signs.leap(polar(f.a, f.r), sp, f.kg, { power: 0.9, dir: -f.a + Math.PI / 2 * f.runDir });
        }
      } else {
        f.runT = 0.8 + Math.random() * 1.2 + (1 - f.stamina) * 1.2;
      }
    }
    f.jumpCd -= dt;
    const reel = !!inp.reel;
    // tilting the rod against the run (opposite side) absorbs it
    const good = f.run ? clamp(-f.runDir * this.aim * 1.4, 0, 1) : 0;
    this.good = good;
    let dr = 0;
    if (f.run) dr += f.speed * (reel ? 0.35 : 0.9) * dt;
    if (reel) dr -= 3.4 * (f.run ? 0.45 + 0.4 * good : 1) * dt;
    f.r = clamp(f.r + dr, 0, MAX_LINE);
    if (f.run) f.a = clamp(f.a + (f.runDir * f.speed / Math.max(6, f.r)) * 0.55 * dt, -60 * DEG, 60 * DEG);
    let T = this.T;
    if (reel && f.run) T += (0.55 + 0.45 * f.strength) * (1 - 0.75 * good) * dt;
    else if (reel) T = damp(T, 0.28 + 0.1 * f.strength, 2.5, dt);
    else if (f.run) T = damp(T, 0.16, 1.5, dt);
    else T -= 0.5 * dt;
    if (f.r >= MAX_LINE - 0.1 && f.run) T += 0.8 * dt;          // spool empty
    this.T = T = clamp(T, 0, 1);
    if (f.run) f.stamina = Math.max(0.15, f.stamina - dt * (0.1 + 0.1 * T) / sp.stamina);
    // the line breaks if held at full tension
    if (T >= 0.99) { f.over += dt; if (f.over > 1.2) { this._lose('snap'); return; } } else f.over = Math.max(0, f.over - dt * 2);
    // or the fish shakes the hook off a slack line
    if (!reel && T < 0.1) f.slack += dt; else f.slack = Math.max(0, f.slack - dt * 3);
    if (f.slack >= 6) { this._lose('escape'); return; }
    polar(f.a, f.r, this.lure);
    this.lure.y = 0;
    // surface wake and thrashing near the dock
    f.wake -= dt;
    if (f.wake <= 0) {
      f.wake = f.run ? 0.14 : 0.45;
      this.world.ripples.add(this.lure.x, this.lure.z, f.run ? 0.9 : 0.6, 1.1, f.run ? 0.6 : 0.4);
      if (f.run && T > 0.55) this.world.splashAt(this.lure.x, this.lure.z, 0.15);
    }
    const m = f.model;
    if (f.r < 7) {
      m.root.visible = true;
      m.root.position.set(this.lure.x, -0.04, this.lure.z);
      m.root.rotation.set(0, Math.PI / 2 - f.a + (f.run ? f.runDir * 1.2 : 0), 0);
      m.body.rotation.set(Math.sin(performance.now() * 0.02) * 0.3, 0, 0);
      m.update(dt, f.run ? 1 : 0.6);
    } else m.root.visible = false;
    if (f.r < 2.5) this._toUnhook();
  }

  _toUnhook() {
    const f = this.f;
    this.phase = 'unhook';
    this.timer = UNHOOK_S;
    this.T = 0.2;
    const m = f.model;
    this.app.scene.remove(m.root);
    this.app.camera.add(m.root);
    m.root.visible = true;
    this.world.splashAt(this.lure.x, this.lure.z, 0.6);
    this.app.audio.play('splash', { big: 0.5 });
    this.hud.banner('UNHOOK IT!', 'good');
  }

  _showFish(dt, still) {
    const m = this.f.model;
    const s = clamp(m.len, 0.3, 0.62);
    m.root.scale.setScalar(s);
    const t = performance.now() / 1000;
    if (still) {
      // holding the catch up to the camera, side on
      m.root.position.set(0, -0.08, -0.85);
      m.root.rotation.set(0, Math.sin(t * 1.4) * 0.35, 0.12);
      m.body.rotation.set(0, 0, 0);
      m.update(dt, 0.15);
    } else {
      // hanging from the hook, wriggling
      m.root.position.set(0.05, -0.02 - s * 0.35, -0.9);
      m.root.rotation.set(0, Math.sin(t * 2) * 0.4, 1.25);
      m.body.rotation.set(Math.sin(t * 11) * 0.35, 0, 0);
      m.update(dt, 0.9);
    }
    m.root.updateWorldMatrix(true, true);
    // the line ends at the mouth
    const mouth = new THREE.Vector3(0.5, 0, 0).applyMatrix4(m.root.matrixWorld);
    this.lure = (this.lure || new THREE.Vector3()).copy(mouth);
  }

  _unhook(dt, inp) {
    this._showFish(dt, false);
    if (inp.unhook) { this._caught(); return; }
    if (this.timer <= 0) this._lose('escape');
  }

  _caught() {
    const f = this.f;
    this.phase = 'caught';
    this.timer = 2.6;
    this.fish++;
    this.kg += f.kg;
    const c = { species: f.sp.name, kg: f.kg, rarity: f.sp.rarity, id: f.sp.id };
    this.catches.push(c);
    if (!this.biggest || c.kg > this.biggest.kg) this.biggest = c;
    this.app.audio.play('unhook');
    this.app.audio.play('catch', { rarity: f.sp.rarity });
    this.app.input.rumble(0.4, 120);
    const p = new THREE.Vector3(0, -0.05, -0.85).applyMatrix4(this.app.camera.matrixWorld);
    this.world.sparkle(p, f.sp.rarity === 'legendary' ? 60 : f.sp.rarity === 'epic' ? 40 : 20, f.sp.rarity === 'legendary' ? [1, 0.8, 0.3] : [0.7, 0.95, 1], 0.4, 0.8);
    this.hud.catchCard(c);
    this.app.onCatch?.(this, c);
  }

  _lose(kind) {
    const f = this.f;
    if (kind === 'snap') { this.stats.snapped++; this.app.audio.play('snap'); this.hud.banner('LINE SNAPPED!', 'bad'); this.app.input.rumble(1, 300); }
    else {
      this.stats.escaped++;
      this.app.audio.play('escape');
      this.hud.banner('IT GOT AWAY…', 'bad');
      if (this.lure) this.world.splashAt(this.lure.x, Math.min(this.lure.z, -2), 0.5);
    }
    if (f) this.hud.feedLocal(`${kind === 'snap' ? 'Snapped' : 'Lost'}: ${f.sp.name} ${f.kg.toFixed(2)} kg`);
    this._dropFish();
    this.phase = 'lost';
    this.timer = 1.6;
    this.lure = null;
    this.T = 0;
  }

  _dropFish() {
    const f = this.f;
    if (!f) return;
    f.model.root.parent?.remove(f.model.root);
    f.model.dispose();
    this.f = null;
  }

  _reset() {
    this._dropFish();
    this.phase = 'aim';
    this.lure = null;
    this.bite = null;
    this.T = 0;
  }

  _end() {
    if (this.phase === 'fight' || this.phase === 'unhook' || this.phase === 'bite') this.hud.feedLocal('Time up with a fish on the line!');
    this._dropFish();
    this.phase = 'over';
    this.lure = null;
    this.bite = null;
    this.T = 0;
    this.app.audio.setReel(0, 0);
    this.app.audio.play('finish', { good: this.fish > 0 });
    this.hud.banner("TIME'S UP!", 'go');
    this.app.onMatchEnd?.(this);
  }

  // ------------------------------------------------------------------ view
  _camera(dt) {
    let yaw = this.aimAngle * 0.8, pitch = -0.1;
    const ph = this.phase;
    if (ph === 'flight' || ph === 'wait' || ph === 'bite') {
      const p = this.lure || (this.flight && this.flight.to);
      if (p) { yaw = angleOf(p) * 0.85; pitch = -Math.atan2(EYE.y, Math.max(4, flatDist(p))) * 0.8; }
    } else if (ph === 'fight') {
      yaw = this.f.a * 0.85;
      pitch = -Math.atan2(EYE.y, Math.max(3, this.f.r)) * 0.85;
    } else if (ph === 'unhook' || ph === 'caught') {
      yaw = this.yaw; pitch = -0.18;
    } else if (ph === 'aim' || ph === 'countdown') {
      pitch = -Math.atan2(EYE.y, this.targetDist) * 0.6 - 0.02;
    }
    this.yaw = dampAngle(this.yaw, yaw, 5, dt);
    this.pitch = damp(this.pitch, pitch, 4, dt);
    const c = this.app.camera;
    const t = performance.now() / 1000;
    // breathing + a shake under heavy tension
    const shake = ph === 'fight' ? Math.max(0, this.T - 0.6) * 0.01 : 0;
    c.position.set(EYE.x, EYE.y + Math.sin(t * 1.1) * 0.012, EYE.z);
    c.rotation.set(this.pitch + Math.sin(t * 0.7) * 0.004 + (Math.random() - 0.5) * shake, this.yaw + (Math.random() - 0.5) * shake, 0, 'YXZ');
    if (c.fov !== 62) { c.fov = 62; c.updateProjectionMatrix(); }
  }

  _ringUpdate(dt) {
    const show = this.phase === 'aim' || this.phase === 'countdown';
    this.ring.visible = show;
    if (!show) return;
    polar(this.aimAngle, this.targetDist, this.ring.position);
    this.ring.position.y = 0.05;
    const locked = !!this.lock;
    const pulse = 1 + Math.sin(performance.now() * 0.008) * 0.06;
    this.ring.scale.setScalar((locked ? 1.8 : 2.4) * pulse);
    const col = locked ? 0xffcf26 : 0x9ff6ff;
    this.ringOuter.material.color.setHex(col);
    this.ringInner.material.color.setHex(col);
    this.ringBeam.material.color.setHex(col);
    this.ringBeam.scale.set(1, 1 / this.ring.scale.x, 1);
  }

  dispose() {
    this._dropFish();
    this.signs.dispose();
    this.rod.dispose();
    this.app.scene.remove(this.ring);
    this.ring.traverse((o) => { if (o.geometry) { o.geometry.dispose(); o.material.dispose(); } });
    this.hud.destroy();
    this.app.audio.setReel(0, 0);
    this.app.audio.setIntensity(0);
  }
}
