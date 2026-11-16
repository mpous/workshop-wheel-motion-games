// Ardu Snowball — a match of Capture the Star: players, CPU bots, snowballs,
// stars, scoring, the first-person camera and the LAN sync.
//
// Authority model (LAN): each client simulates its own player; the host
// browser also simulates the bots and owns the stars and the score. Owners
// stream their entities at 20 Hz through the board ("state" -> "snapshot");
// remote entities are interpolated ~120 ms in the past. Gameplay moments are
// events relayed by the board: the thrower's owner reports "hit", the
// target's owner validates it and announces "frozen"; the host announces
// "star" changes (grab / drop / return / capture). Solo and the attract demo
// run the very same code with every entity local.
import * as THREE from '../libs/three.bundle.js';
import { World, ARENA, TEAM_NAME, TEAM_CSS, teamSign, starHome, spawnPoint, inBase } from './world.js';
import { Avatar, Hands } from './models.js';
import { Particles, BallPool, AimGuide, GRAVITY } from './fx.js';
import { clamp, lerp, damp, dampAngle, wrapAngle, makeRng } from './util.js';

export const MATCH_MS = 180000;
const FREEZE_MS = 3500;
const SHIELD_MS = 2000;
const STAR_RETURN_MS = 15000;
const WALK = 5.5, RUN = 8.5, CARRY = 0.85, BUSY = 0.35;
const TURN_RATE = 2.4;
const SCOOP_S = 0.5, PACK_S = 0.45, THROW_ANIM_S = 0.5, THROW_CD = 0.45;
export const MAX_BALLS = 3;
export const MAX_HANDFULS = 2;
const RADIUS = 0.42, EYE = 1.55, BODY_H = 1.95, HIT_R = 0.5;
const TOUCH_STAR = 1.7;
const NET_MS = 50, INTERP_MS = 120;
const ACT_CODE = { scoop: 1, pack: 2, throw: 3 };
const CODE_ACT = [null, 'scoop', 'pack', 'throw'];
const BOT_NAMES = ['Frosty', 'Blizzard', 'Flurry', 'Icicle', 'Yeti', 'Sleet', 'Avalanche', 'Glacier', 'Snowdrift', 'Tundra', 'Penguin', 'Husky', 'Polar', 'Mitten'];
const SKILL = { easy: 0.6, normal: 1, hard: 1.45 };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

export function soloRoster(name, perTeam = 3, seed = 1) {
  const rng = makeRng(seed);
  const names = [...BOT_NAMES].sort(() => rng() - 0.5);
  const roster = [{ id: 'me', name, team: 0, slot: 0, isBot: false, owner: 'me' }];
  let b = 0;
  for (let team = 0; team < 2; team++)
    for (let slot = team === 0 ? 1 : 0; slot < perTeam; slot++)
      roster.push({ id: 'bot' + b, name: names[b++ % names.length], team, slot, isBot: true, owner: 'me' });
  return roster;
}

export function attractRoster(perTeam = 3) {
  const roster = [];
  let b = 0;
  for (let team = 0; team < 2; team++)
    for (let slot = 0; slot < perTeam; slot++)
      roster.push({ id: 'bot' + b, name: BOT_NAMES[(b++ + 3) % BOT_NAMES.length], team, slot, isBot: true, owner: 'demo' });
  return roster;
}

// low-arc launch angle to reach horizontal distance d and height h at speed v (null if out of range)
function solveAngle(d, h, v) {
  const g = GRAVITY, v2 = v * v;
  const disc = v2 * v2 - g * (g * d * d + 2 * h * v2);
  if (disc < 0 || d < 0.01) return null;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * d));
}
const throwSpeed = (p) => 18 + 12 * clamp(p, 0, 1);

class Player {
  constructor(r, local) {
    Object.assign(this, { id: r.id, name: r.name, team: r.team, slot: r.slot, isBot: !!r.isBot, owner: r.owner, board: r.board || '' });
    this.local = local;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.ammo = 1;
    this.handfuls = 0;
    this.action = null;
    this.actionT = 0;
    this.actionDur = 0;
    this.cooldown = 0;
    this.frozenUntil = 0;
    this.respawnPending = false;
    this.shieldUntil = 0;
    this.stats = { hits: 0, caps: 0, outs: 0 };
    this.bestSnipe = 0;
    this.left = false;
    this.buf = [];          // remote: [{t, p, yaw, pitch, ...}]
    this.speed = 0;
    this.stepDist = 0;
    this.avatar = null;
    this.brain = null;
  }
}

export class Match {
  // cfg: {mode: 'solo'|'lan'|'attract', roster, myId, hostId, startAt (performance ms), durationMs, seed, net, skill}
  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.attract = cfg.mode === 'attract';
    this.lan = cfg.mode === 'lan';
    this.net = cfg.net || null;
    this.myId = cfg.myId;
    this.hostId = cfg.hostId || cfg.myId;
    this.startAt = cfg.startAt;
    this.durationMs = cfg.durationMs || MATCH_MS;
    this.endAt = this.startAt + this.durationMs;
    this.skill = SKILL[cfg.skill] || 1;
    this.rng = makeRng(cfg.seed || 1);
    this.scene = app.scene;
    this.world = app.world;
    this.camera = app.camera;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.particles = new Particles(this.group, 1800);
    this.sparkles = new Particles(this.group, 500, { additive: true });
    this.balls = [];
    this.ballPool = new BallPool(this.group);
    this.guide = new AimGuide(this.group);
    this.score = [0, 0];
    this.hits = [0, 0];
    this.phase = 'countdown';
    this.paused = false;
    this._pauseAt = 0;
    this._queue = [];
    this._netAt = 0;
    this._statusAt = 0;
    this._lastCount = -1;
    this._lastTick = -1;
    this.results = null;
    this.finishedAt = 0;
    this.shake = 0;
    this.fovKick = 0;
    this.lastHitAt = -1e9;
    this.lastCapAt = -1e9;
    this.lastHurtAt = -1e9;
    this.hitMarkerAt = -1e9;
    this.camYaw = 0;
    this.time = 0;
    this.players = new Map();
    for (const r of cfg.roster) {
      const local = r.owner === this.myId;
      const p = new Player(r, local);
      const sp = spawnPoint(p.team, p.slot);
      p.pos.set(sp.x, 0, sp.z);
      p.yaw = sp.yaw;
      if (p.id !== this.myId) {
        p.avatar = new Avatar({ team: p.team, name: p.name, isBot: p.isBot, seed: p.slot * 7 + p.team * 3 + (p.name.length || 0) });
        this.group.add(p.avatar.root);
        p.avatar.root.position.copy(p.pos);
        p.avatar.root.rotation.y = p.yaw;
      }
      if (p.isBot && local) p.brain = new Brain(this, p);
      this.players.set(p.id, p);
    }
    this.me = this.players.get(this.myId) || null;
    this.myTeam = this.me ? this.me.team : 0;
    if (this.me) {
      this.hands = new Hands(this.me.team);
      this.camera.add(this.hands.group);
    }
    this.stars = [0, 1].map((team) => ({ team, s: 'home', by: null, p: starHome(team), t: 0 }));
    this.feedLog = [];
    this._orbit = 0;
    // attract: start straight into the action
    if (this.attract) { this.startAt = performance.now() - 1; this.endAt = this.startAt + 1e9; this.phase = 'playing'; }
    this._placeCamera(0);
  }

  get isHost() { return !this.lan || this.hostId === this.myId; }
  now() { return (this.paused ? this._pauseAt : performance.now()); }
  timeLeft() { return clamp(this.endAt - this.now(), 0, this.durationMs); }
  countdown() { return Math.ceil((this.startAt - this.now()) / 1000); }

  pause() {
    if (this.lan || this.paused) return;
    this.paused = true;
    this._pauseAt = performance.now();
  }

  resume() {
    if (!this.paused) return;
    const d = performance.now() - this._pauseAt;
    this.paused = false;
    // shift every match clock by the pause
    this.startAt += d; this.endAt += d;
    for (const p of this.players.values()) {
      if (p.frozenUntil) p.frozenUntil += d;
      if (p.shieldUntil) p.shieldUntil += d;
    }
    for (const s of this.stars) if (s.t) s.t += d;
  }

  dispose() {
    for (const p of this.players.values()) if (p.avatar) p.avatar.dispose();
    if (this.hands) this.hands.group.removeFromParent();
    this.group.removeFromParent();
    this.group.traverse((o) => { if (o.geometry && !o.isInstancedMesh) o.geometry.dispose?.(); });
  }

  // ------------------------------------------------------------------ events
  emit(type, data) {
    const ev = { type, ...data, from: this.myId, local: true };
    this._queue.push(ev);
    if (this.lan && this.net) this.net.send('event', { type, ...data });
  }

  onNetEvent(ev) {
    if (!ev || ev.from === this.myId) return;
    this._queue.push(ev);
  }

  _processEvents() {
    const q = this._queue;
    this._queue = [];
    for (const ev of q) {
      try { this._handle(ev); } catch (e) { console.warn('event', ev, e); }
    }
  }

  _handle(ev) {
    const P = this.players;
    switch (ev.type) {
      case 'throw': {
        if (ev.local) return;   // already flying here
        const by = P.get(ev.by);
        if (!by || !Array.isArray(ev.p) || !Array.isArray(ev.v)) return;
        this._spawnBall(by, new THREE.Vector3(...ev.p), new THREE.Vector3(...ev.v), false);
        if (!by.local) { by.action = 'throw'; by.actionT = 0; by.actionDur = THROW_ANIM_S; }
        return;
      }
      case 'hit': {
        const t = P.get(ev.target);
        if (!t || !t.local || !this._canFreeze(t)) return;
        this._freezeLocal(t);
        this.emit('frozen', { target: t.id, by: ev.by, dist: ev.dist });
        return;
      }
      case 'frozen': {
        const t = P.get(ev.target), by = P.get(ev.by);
        if (!t) return;
        const now = this.now();
        if (!t.local) { t.frozenUntil = now + FREEZE_MS; t._frozeAt = now; }
        if (this.isHost) {
          if (by) { this.hits[by.team]++; by.stats.hits++; }
          t.stats.outs++;
          for (const s of this.stars) if (s.s === 'carried' && s.by === t.id) this._dropStar(s, t.pos);
        }
        if (by && by.id === this.myId) {
          this.lastHitAt = now;
          this.hitMarkerAt = now;
          by.bestSnipe = Math.max(by.bestSnipe, Number(ev.dist) || 0);
          this._sfx('hit');
          this.app.input.rumble(0.3, 80);
        }
        if (t.id === this.myId) {
          this.lastHurtAt = now;
          this.shake = 0.5;
          this._sfx('hurt');
          this.app.input.rumble(0.8, 260);
        }
        this._burstAt(t.pos, 1.1, 34, [0.8, 0.93, 1]);
        this._feed({ kind: 'hit', by, target: t, dist: ev.dist });
        return;
      }
      case 'star': {
        const s = this.stars[ev.team];
        if (!s) return;
        if (!ev.local) {
          s.s = ev.state;
          s.by = ev.by || null;
          if (Array.isArray(ev.p)) s.p = new THREE.Vector3(...ev.p);
          if (ev.state === 'home') s.p = starHome(ev.team);
          if (ev.state === 'dropped') s.t = this.now();
          if (ev.kind === 'cap' && Array.isArray(ev.score)) this.score = ev.score.slice(0, 2);
        }
        this._starFx(ev);
        return;
      }
      default:
    }
  }

  _feed(item) {
    this.feedLog.push({ ...item, at: this.now() });
    if (this.feedLog.length > 6) this.feedLog.shift();
    if (!this.attract && this.app.hud) this.app.hud.feed(item, this);
  }

  _sfx(name, opts = {}) {
    if (this.attract) return;
    this.app.audio.play(name, opts);
  }

  // positional sfx: pan/attenuation relative to the camera
  _sfxAt(name, pos, opts = {}) {
    if (this.attract) return;
    const c = this.camera;
    _v.copy(pos).sub(c.position);
    const dist = _v.length();
    if (dist > 70) return;
    const right = _v2.set(1, 0, 0).applyQuaternion(c.quaternion);
    const pan = dist > 0.1 ? clamp(_v.dot(right) / dist, -1, 1) : 0;
    this.app.audio.play(name, { ...opts, pan, dist });
  }

  _burstAt(pos, y, n, color = [1, 1, 1]) {
    this.particles.burst(_v.set(pos.x, pos.y + y, pos.z), n, { speed: 3.5, up: 2.6, size: 0.18, life: 0.9, color });
    this.sparkles.burst(_v.set(pos.x, pos.y + y, pos.z), Math.ceil(n / 3), { speed: 2.5, up: 2, size: 0.08, life: 0.6, color: [0.6, 0.85, 1], gravity: 0.2 });
  }

  _starFx(ev) {
    const team = ev.team, by = this.players.get(ev.by);
    const mine = team === this.myTeam;            // our own star
    if (ev.kind === 'grab') {
      this._sfx(mine ? 'stolen' : 'grab');
      if (this.app.hud && !this.attract) this.app.hud.banner(mine ? 'OUR STAR IS STOLEN!' : by && by.id === this.myId ? 'YOU HAVE THE STAR · RUN HOME!' : `${TEAM_NAME[team]} STAR TAKEN`, mine ? 'bad' : 'good');
    } else if (ev.kind === 'drop') this._sfxAt('drop', this.stars[team].p);
    else if (ev.kind === 'return') {
      this._sfx('return');
      if (this.app.hud && !this.attract) this.app.hud.banner(`${TEAM_NAME[team]} STAR RETURNED`, mine ? 'good' : '');
    } else if (ev.kind === 'cap') {
      this.lastCapAt = this.now();
      const good = !mine;
      this._sfx('capture', { good });
      const home = starHome(1 - team);
      for (let i = 0; i < 4; i++) this.sparkles.burst(_v.set(home.x, 1.5 + i * 0.5, home.z), 30, { speed: 6, up: 5, size: 0.14, life: 1.4, color: team === 0 ? [0.4, 0.7, 1] : [1, 0.45, 0.4], gravity: 0.4 });
      if (this.app.hud && !this.attract) this.app.hud.banner(good ? 'STAR CAPTURED!' : `${TEAM_NAME[1 - team]} CAPTURED OUR STAR`, good ? 'good big' : 'bad big', by ? by.name : '');
      if (by && by.id === this.myId) this.app.input.rumble(0.6, 300);
    }
    this._feed({ kind: ev.kind, by, team });
  }

  // ------------------------------------------------------------------ stars (authority)
  _setStar(s, state, by, pos, kind, extra = {}) {
    s.s = state;
    s.by = by ? by.id : null;
    s.p = state === 'home' ? starHome(s.team) : pos.clone();
    if (state === 'dropped') s.t = this.now();
    this.emit('star', { kind, team: s.team, by: s.by, state, p: [r2(s.p.x), r2(s.p.y), r2(s.p.z)], ...extra });
  }

  _dropStar(s, pos) {
    const p = new THREE.Vector3(clamp(pos.x, -ARENA.halfW + 1, ARENA.halfW - 1), 0.7, clamp(pos.z, -ARENA.halfL + 1, ARENA.halfL - 1));
    this.world.resolveCircle(p, 0.6);
    this._setStar(s, 'dropped', this.players.get(s.by), p, 'drop');
  }

  _updateStars() {
    const now = this.now();
    for (const s of this.stars) {
      if (s.s === 'carried') {
        const c = this.players.get(s.by);
        if (!c || c.left) { this._dropStar(s, c ? c.pos : s.p); continue; }
        if (this._isFrozen(c)) { this._dropStar(s, c.pos); continue; }
        if (inBase(c.team, c.pos.x, c.pos.z)) {
          this.score[c.team]++;
          c.stats.caps++;
          this._setStar(s, 'home', c, null, 'cap', { score: this.score.slice() });
        }
        continue;
      }
      if (s.s === 'dropped' && now - s.t > STAR_RETURN_MS) { this._setStar(s, 'home', null, null, 'return'); continue; }
      for (const p of this.players.values()) {
        if (p.left || this._isFrozen(p)) continue;
        const dx = p.pos.x - s.p.x, dz = p.pos.z - s.p.z;
        if (dx * dx + dz * dz > TOUCH_STAR * TOUCH_STAR) continue;
        if (p.team !== s.team) {
          if (this.stars.some((o) => o.s === 'carried' && o.by === p.id)) continue;
          this._setStar(s, 'carried', p, p.pos, 'grab');
          break;
        } else if (s.s === 'dropped') {
          this._setStar(s, 'home', p, null, 'return');
          break;
        }
      }
    }
  }

  carrying(p) { return this.stars.findIndex((s) => s.s === 'carried' && s.by === p.id); }

  // ------------------------------------------------------------------ helpers
  _isFrozen(p) { return p.frozenUntil > this.now(); }
  _isShielded(p) { return p.shieldUntil > this.now(); }
  _canFreeze(p) { return !p.left && !this._isFrozen(p) && !this._isShielded(p) && !p.respawnPending; }

  _freezeLocal(p) {
    p.frozenUntil = this.now() + FREEZE_MS;
    p.respawnPending = true;
    p.action = null;
    p.vel.set(0, 0, 0);
  }

  _respawn(p) {
    const sp = spawnPoint(p.team, p.slot);
    p.pos.set(sp.x, 0, sp.z);
    p.vel.set(0, 0, 0);
    p.yaw = sp.yaw;
    p.pitch = 0;
    p.respawnPending = false;
    p.shieldUntil = this.now() + SHIELD_MS;
    p.ammo = Math.max(p.ammo, 1);
    p.handfuls = 0;
    p.action = null;
    if (p.brain) p.brain.reset();
    if (p.id === this.myId) {
      this._sfx('respawn');
      this.camYaw = p.yaw;
    }
  }

  _startAction(p, action) {
    p.action = action;
    p.actionT = 0;
    p.actionDur = action === 'scoop' ? SCOOP_S : action === 'pack' ? PACK_S : THROW_ANIM_S;
  }

  // smart snow button: pack if there is loose snow, otherwise scoop
  trySnow(p, kind = 'snow') {
    if (this._isFrozen(p) || (p.action && p.action !== 'throw')) return false;
    const onSnow = this.world.isSnow(p.pos.x, p.pos.z);
    const canPack = p.handfuls > 0 && p.ammo < MAX_BALLS;
    const canScoop = onSnow && p.handfuls < MAX_HANDFULS && p.ammo + p.handfuls < MAX_BALLS;
    if ((kind === 'pack' || kind === 'snow') && canPack) {
      this._startAction(p, 'pack');
      if (p.id === this.myId) this._sfx('pack');
      return true;
    }
    if ((kind === 'scoop' || kind === 'snow') && canScoop) {
      this._startAction(p, 'scoop');
      if (p.id === this.myId) this._sfx('scoop');
      else this._sfxAt('scoop', p.pos);
      return true;
    }
    if (p.id === this.myId) {
      this._sfx('noSnow');
      const why = p.ammo >= MAX_BALLS ? 'HANDS FULL · THROW!' : !onSnow ? (this.world.isIce(p.pos.x, p.pos.z) ? 'NO SNOW ON THE ICE' : 'NO SNOW ON THE DECK') : kind === 'pack' ? 'SCOOP SNOW FIRST' : 'HANDS FULL';
      if (this.app.hud) this.app.hud.hint(why, 'warn');
    }
    return false;
  }

  _finishAction(p) {
    if (p.action === 'scoop') p.handfuls = Math.min(MAX_HANDFULS, p.handfuls + 1);
    else if (p.action === 'pack' && p.handfuls > 0) { p.handfuls--; p.ammo = Math.min(MAX_BALLS, p.ammo + 1); }
    p.action = null;
  }

  // launch from p's hand along yaw/pitch at power 0..1 (bots pass an explicit velocity)
  throwBall(p, vel, power = 0.85) {
    if (p.ammo <= 0 || p.cooldown > 0 || this._isFrozen(p) || (p.action && p.action !== 'throw')) return false;
    p.ammo--;
    p.cooldown = THROW_CD;
    p.shieldUntil = 0;                // throwing ends the spawn shield
    this._startAction(p, 'throw');
    const f = _v.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const origin = new THREE.Vector3(p.pos.x + f.x * 0.35 + f.z * 0.18, p.pos.y + 1.55, p.pos.z + f.z * 0.35 - f.x * 0.18);
    this._spawnBall(p, origin, vel.clone(), true);
    if (p.id === this.myId) { this._sfx('throw', { power }); this.fovKick = 0.6; }
    else this._sfxAt('throw', origin, { power });
    if (this.lan) this.emit('throw', { by: p.id, p: [r3(origin.x), r3(origin.y), r3(origin.z)], v: [r3(vel.x), r3(vel.y), r3(vel.z)] });
    return true;
  }

  _spawnBall(by, p, v, judge) {
    // the thrower's owner judges the hits
    this.balls.push({ by: by.id, team: by.team, p, v, age: 0, judge: judge && by.owner === this.myId, o: p.clone() });
  }

  _updateBalls(dt) {
    const out = [];
    for (const b of this.balls) {
      b.age += dt;
      const steps = 3, h = dt / steps;
      let done = false;
      for (let k = 0; k < steps && !done; k++) {
        b.v.y -= GRAVITY * h;
        b.p.addScaledVector(b.v, h);
        // players
        for (const q of this.players.values()) {
          if (q.left || q.id === b.by || b.age < 0.05) continue;
          const pos = q.pos;
          const dx = b.p.x - pos.x, dz = b.p.z - pos.z;
          if (dx * dx + dz * dz > HIT_R * HIT_R || b.p.y < pos.y || b.p.y > pos.y + BODY_H) continue;
          done = true;
          this._splat(b.p, q.team !== b.team && this._canFreeze(q));
          if (b.judge && q.team !== b.team && this._canFreeze(q)) {
            const dist = Math.hypot(b.p.x - b.o.x, b.p.z - b.o.z);
            this._reportHit(q, b.by, dist);
          }
          break;
        }
        if (!done && (this.world.solidAt(b.p.x, b.p.y, b.p.z) || b.age > 6)) { done = true; this._splat(b.p, false); }
      }
      if (!done) out.push(b);
    }
    this.balls = out;
    this.ballPool.draw(this.balls);
  }

  _splat(p, onPlayer) {
    this.particles.burst(p, onPlayer ? 26 : 16, { speed: onPlayer ? 3 : 2.2, up: 1.8, size: 0.13, life: 0.7 });
    this._sfxAt('splat', p);
  }

  _reportHit(target, byId, dist) {
    dist = Math.round(clamp(dist, 0, 200) * 10) / 10;
    if (this.lan) {
      if (target.local) {
        // our own entity (host bot / me): validate right here
        this._freezeLocal(target);
        this.emit('frozen', { target: target.id, by: byId, dist });
      } else this.emit('hit', { target: target.id, by: byId, dist });
    } else {
      this._freezeLocal(target);
      this.emit('frozen', { target: target.id, by: byId, dist });
    }
  }

  // ------------------------------------------------------------------ aiming
  // velocity for a throw by p at power; assist: snap to a target in a cone
  aimVelocity(p, power, { assist = true, spread = true } = {}) {
    const v = throwSpeed(power);
    let yaw = p.yaw, pitch = p.pitch + 0.12;
    let lock = null;
    if (assist) {
      lock = this._assistTarget(p, 14 * Math.PI / 180, 50);
      if (lock) {
        const sol = this._ballistic(p, lock, v);
        if (sol) { yaw = sol.yaw; pitch = sol.pitch; } else lock = null;
      }
      if (!lock) pitch = Math.max(pitch, p.pitch + 0.18);
    }
    if (spread) {
      const s = (1 - clamp(power, 0, 1)) * 0.08;
      yaw += (Math.random() * 2 - 1) * s;
      pitch += (Math.random() * 2 - 1) * s * 0.6;
    }
    const c = Math.cos(pitch);
    return { vel: new THREE.Vector3(-Math.sin(yaw) * c * v, Math.sin(pitch) * v, -Math.cos(yaw) * c * v), lock };
  }

  _assistTarget(p, cone, range) {
    let best = null, bestA = cone;
    for (const q of this.players.values()) {
      if (q.team === p.team || q.left || this._isFrozen(q)) continue;
      const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z, d = Math.hypot(dx, dz);
      if (d > range || d < 1) continue;
      const a = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - p.yaw));
      if (a < bestA) { bestA = a; best = q; }
    }
    return best;
  }

  _ballistic(p, q, v) {
    const ox = p.pos.x, oz = p.pos.z, oy = p.pos.y + 1.55;
    let tx = q.pos.x, tz = q.pos.z;
    const ty = q.pos.y + 1.0;
    let ang = null;
    for (let i = 0; i < 2; i++) {
      const d = Math.hypot(tx - ox, tz - oz);
      ang = solveAngle(d, ty - oy, v);
      if (ang == null) return null;
      const t = d / (v * Math.cos(ang));
      tx = q.pos.x + q.vel.x * t * 0.8;
      tz = q.pos.z + q.vel.z * t * 0.8;
    }
    return { yaw: Math.atan2(-(tx - ox), -(tz - oz)), pitch: ang };
  }

  // ------------------------------------------------------------------ movement
  _move(p, dt, wx, wz, speed) {
    const onIce = this.world.isIce(p.pos.x, p.pos.z);
    const k = onIce ? 1.6 : 11;
    p.vel.x = damp(p.vel.x, wx * speed, k, dt);
    p.vel.z = damp(p.vel.z, wz * speed, k, dt);
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    // keep apart from other players
    for (const q of this.players.values()) {
      if (q === p || q.left) continue;
      const dx = p.pos.x - q.pos.x, dz = p.pos.z - q.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.0001 || d2 > 0.8 * 0.8) continue;
      const d = Math.sqrt(d2), push = (0.8 - d) * (q.local ? 0.5 : 1);
      p.pos.x += (dx / d) * push; p.pos.z += (dz / d) * push;
    }
    const before = p.pos.clone();
    if (this.world.resolveCircle(p.pos, RADIUS)) {
      // slide: drop the velocity that went into the wall
      const nx = p.pos.x - before.x, nz = p.pos.z - before.z, nl = Math.hypot(nx, nz);
      if (nl > 1e-4) {
        const dot = (p.vel.x * nx + p.vel.z * nz) / nl;
        if (dot < 0) { p.vel.x -= (dot * nx) / nl; p.vel.z -= (dot * nz) / nl; }
      }
    }
    p.pos.y = 0;
    p.speed = Math.hypot(p.vel.x, p.vel.z);
  }

  _updateLocalPlayer(p, dt, inp) {
    const now = this.now();
    if (p.respawnPending && now >= p.frozenUntil) this._respawn(p);
    const frozen = this._isFrozen(p);
    const playing = this.phase === 'playing';
    p.cooldown = Math.max(0, p.cooldown - dt);
    if (p.action) {
      p.actionT += dt;
      if (p.actionT >= p.actionDur) this._finishAction(p);
    }
    if (!playing || frozen) {
      this._move(p, dt, 0, 0, 0);
      if (frozen) return;
    }
    // turning: controller tilt / keys (rate) and mouse (absolute)
    p.yaw = wrapAngle(p.yaw + inp.turn * TURN_RATE * dt - inp.lookX);
    p.pitch = clamp(p.pitch - inp.lookY, -0.75, 0.9);
    if (!playing) return;
    if (inp.fromMotion && !inp.lookY) p.pitch = damp(p.pitch, 0, 1.5, dt);
    let mx = inp.moveX, my = inp.moveY;
    const sprint = inp.runGesture || (inp.run && !mx && !my);
    if (sprint && !mx && !my) my = 1;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    let wx = fx * my + -fz * mx, wz = fz * my + fx * mx;
    const l = Math.hypot(wx, wz);
    if (l > 1) { wx /= l; wz /= l; }
    let speed = inp.run || sprint ? RUN : WALK;
    if (this.carrying(p) >= 0) speed *= CARRY;
    if (p.action === 'scoop' || p.action === 'pack') speed *= BUSY;
    this._move(p, dt, wx, wz, speed);
    // footsteps
    p.stepDist += p.speed * dt;
    const stride = speed > WALK ? 2.1 : 1.6;
    if (p.stepDist > stride) { p.stepDist = 0; this._sfx('step', { run: speed > WALK }); }
    // actions
    if (inp.snow) this.trySnow(p, 'snow');
    else if (inp.scoop) this.trySnow(p, 'scoop');
    else if (inp.pack) this.trySnow(p, 'pack');
    if (inp.throw > 0) {
      if (p.ammo <= 0) {
        if (!p.action) { this._sfx('noSnow'); if (this.app.hud) this.app.hud.hint(p.handfuls ? 'PACK A SNOWBALL FIRST' : 'NO SNOWBALLS · SCOOP SNOW', 'warn'); }
      } else {
        const mouse = !!document.pointerLockElement && this.app.input.lastDevice === 'keyboard';
        const { vel } = this.aimVelocity(p, inp.throw, { assist: !mouse });
        this.throwBall(p, vel, inp.throw);
      }
    }
  }

  _updateBot(p, dt) {
    const now = this.now();
    if (p.respawnPending && now >= p.frozenUntil) this._respawn(p);
    p.cooldown = Math.max(0, p.cooldown - dt);
    if (p.action) {
      p.actionT += dt;
      if (p.actionT >= p.actionDur) this._finishAction(p);
    }
    if (this.phase !== 'playing' || this._isFrozen(p)) { this._move(p, dt, 0, 0, 0); return; }
    p.brain.update(dt);
  }

  // ------------------------------------------------------------------ remote entities
  onSnapshot(s) {
    if (!s || !Array.isArray(s.ents)) return;
    if (s.hostId && s.hostId !== this.hostId) this._setHost(s.hostId);
    for (const e of s.ents) {
      const p = this.players.get(e.id);
      if (!p || p.local || !Array.isArray(e.p)) continue;
      const last = p.buf[p.buf.length - 1];
      if (last && last.st >= e.st) continue;     // duplicate (the board re-sends the latest state)
      p.buf.push({ t: s.t, st: e.st || s.t, p: e.p, yaw: e.yaw || 0, pitch: e.pitch || 0 });
      if (p.buf.length > 30) p.buf.shift();
      p.ammo = e.a | 0;
      p.handfuls = e.h | 0;
      const act = CODE_ACT[e.an | 0] || null;
      if (act !== p.action && act !== 'throw') { p.action = act; p.actionT = 0; p.actionDur = act === 'scoop' ? SCOOP_S : PACK_S; }
      const now = this.now();
      if (e.f > 0) p.frozenUntil = now + e.f;
      else if (now - (p._frozeAt || -1e9) > 600) p.frozenUntil = Math.min(p.frozenUntil, now);
      p.shieldUntil = e.sh > 0 ? now + e.sh : 0;
    }
    const g = s.game;
    if (g && !this.isHost) {
      if (Array.isArray(g.score)) this.score = g.score.slice(0, 2).map((x) => x | 0);
      if (Array.isArray(g.hits)) this.hits = g.hits.slice(0, 2).map((x) => x | 0);
      if (g.stats) for (const [id, v] of Object.entries(g.stats)) {
        const p = this.players.get(id);
        if (p && Array.isArray(v)) p.stats = { hits: v[0] | 0, caps: v[1] | 0, outs: v[2] | 0 };
      }
      if (Array.isArray(g.stars)) g.stars.forEach((st, i) => {
        const s0 = this.stars[i];
        if (!s0 || !st) return;
        s0.s = st.s; s0.by = st.by || null;
        s0.p = st.s === 'home' ? starHome(i) : Array.isArray(st.p) ? new THREE.Vector3(...st.p) : s0.p;
      });
    }
  }

  onPlayerLeft(d) {
    const p = this.players.get(d.id);
    if (p && !p.left) {
      p.left = true;
      if (p.avatar) p.avatar.root.visible = false;
      this._feed({ kind: 'left', by: p });
    }
    if (d.hostId) this._setHost(d.hostId);
  }

  _setHost(hostId) {
    if (hostId === this.hostId) return;
    this.hostId = hostId;
    for (const p of this.players.values()) {
      if (!p.isBot) continue;
      p.owner = hostId;
      const local = hostId === this.myId;
      if (local && !p.local) {
        // take over the bots where they are now
        p.local = true;
        p.buf = [];
        p.brain = new Brain(this, p);
      } else if (!local) { p.local = false; p.brain = null; }
    }
  }

  _interpolate(p, dt) {
    const b = p.buf;
    if (!b.length) return;
    const rt = (this.net ? this.net.now() : performance.now()) - INTERP_MS;
    while (b.length > 2 && b[1].t <= rt) b.shift();
    let x, z, yaw, pitch;
    const a = b[0], c = b[1];
    if (c && rt >= a.t && c.t > a.t) {
      const k = clamp((rt - a.t) / (c.t - a.t), 0, 1.2);
      const jump = Math.hypot(c.p[0] - a.p[0], c.p[2] - a.p[2]) > 6;
      const kk = jump ? (k < 1 ? 0 : 1) : k;
      x = lerp(a.p[0], c.p[0], kk); z = lerp(a.p[2], c.p[2], kk);
      yaw = a.yaw + wrapAngle(c.yaw - a.yaw) * clamp(kk, 0, 1);
      pitch = lerp(a.pitch, c.pitch, clamp(kk, 0, 1));
    } else {
      const l = c || a;
      x = l.p[0]; z = l.p[2]; yaw = l.yaw; pitch = l.pitch;
    }
    const ox = p.pos.x, oz = p.pos.z;
    if (Math.hypot(x - ox, z - oz) > 6) { p.vel.set(0, 0, 0); }
    else if (dt > 0) { p.vel.x = damp(p.vel.x, (x - ox) / dt, 8, dt); p.vel.z = damp(p.vel.z, (z - oz) / dt, 8, dt); }
    p.pos.set(x, 0, z);
    p.yaw = yaw;
    p.pitch = pitch;
    p.speed = Math.hypot(p.vel.x, p.vel.z);
    if (p.action) { p.actionT += dt; if (p.action === 'throw' && p.actionT > p.actionDur) p.action = null; }
  }

  _sendState() {
    if (!this.lan || !this.net) return;
    const now = this.now();
    const ents = [];
    for (const p of this.players.values()) {
      if (!p.local || p.left) continue;
      ents.push({
        id: p.id, st: Math.round(performance.now()), p: [r2(p.pos.x), 0, r2(p.pos.z)], yaw: r3(p.yaw), pitch: r2(p.pitch),
        a: p.ammo, h: p.handfuls, an: ACT_CODE[p.action] || 0,
        f: Math.max(0, Math.round(p.frozenUntil - now)), sh: Math.max(0, Math.round(p.shieldUntil - now)),
      });
    }
    const msg = { ents };
    if (this.isHost) {
      const stats = {};
      for (const p of this.players.values()) stats[p.id] = [p.stats.hits, p.stats.caps, p.stats.outs];
      msg.game = {
        score: this.score, hits: this.hits, stats,
        stars: this.stars.map((s) => ({ s: s.s, by: s.by, p: [r2(s.p.x), r2(s.p.y), r2(s.p.z)] })),
      };
    }
    this.net.send('state', msg);
  }

  // ------------------------------------------------------------------ results
  localResults() {
    const winner = this.score[0] !== this.score[1] ? (this.score[0] > this.score[1] ? 0 : 1) : this.hits[0] !== this.hits[1] ? (this.hits[0] > this.hits[1] ? 0 : 1) : -1;
    const rows = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, isBot: p.isBot, hits: p.stats.hits, caps: p.stats.caps, outs: p.stats.outs, left: p.left }));
    return { score: this.score.slice(), hits: this.hits.slice(), winner, rows };
  }

  // ------------------------------------------------------------------ board feedback
  myResult() {
    const r = this.results;
    if (!r) return 2;
    return r.winner < 0 ? 2 : r.winner === this.myTeam ? 1 : 0;
  }

  snowLevel() {
    const p = this.me;
    if (!p) return 0;
    let v = p.handfuls * 50;
    if (p.action === 'scoop' || p.action === 'pack') v += (p.actionT / p.actionDur) * 50 * (p.action === 'pack' ? -1 : 1);
    return clamp(Math.round(v), 0, 100);
  }

  flags() {
    const p = this.me;
    if (!p) return 0;
    let f = 0;
    if (this.carrying(p) >= 0) f |= 1;
    if (this._isFrozen(p)) f |= 2;
    if (this.stars[this.myTeam].s === 'carried') f |= 4;
    if (p.handfuls > 0) f |= 8;
    return f;
  }

  _sendStatus() {
    if (this.attract || !this.app.net) return;
    const now = this.now();
    if (now - this._statusAt < 250) return;
    this._statusAt = now;
    const p = this.me;
    const st = this.phase === 'countdown' ? 'countdown' : this.phase;
    this.app.net.send('solo_status', {
      state: st, count: clamp(this.countdown(), 0, 3), secs: Math.ceil(this.timeLeft() / 1000), ammo: p ? p.ammo : 0,
      snow: this.snowLevel(), flags: this.flags(), my: this.score[this.myTeam], their: this.score[1 - this.myTeam], result: this.myResult(),
    });
  }

  // Modulino Pixels: [mode, value] (see sketch.ino)
  pixels() {
    const p = this.me;
    if (!p) return [0, 0];
    const now = this.now();
    if (this.phase === 'countdown') return [7, clamp(this.countdown(), 0, 9)];
    if (this.phase !== 'playing') return [0, 0];
    if (this._isFrozen(p)) return [3, clamp(Math.round(((p.frozenUntil - now) / FREEZE_MS) * 100), 0, 100)];
    if (now - this.lastCapAt < 1800) return [5, 0];
    if (now - this.lastHitAt < 600) return [4, 0];
    const v = p.ammo * 10 + clamp(Math.round(this.snowLevel() / 11), 0, 9);
    if (this.carrying(p) >= 0) return [2, v];
    if (this.stars[this.myTeam].s === 'carried') return [6, v];
    return [1, v];
  }

  // Modulino Buttons LEDs: bit0 A throw · bit1 B run · bit2 C snow
  buttonMask() {
    const p = this.me;
    if (!p || this.phase !== 'playing' || this._isFrozen(p)) return 0;
    let m = 0;
    if (p.ammo > 0 && p.cooldown <= 0) m |= 1;
    if (this.carrying(p) >= 0 || this.stars[this.myTeam].s !== 'home' || this.stars[1 - this.myTeam].s === 'dropped') m |= 2;
    const onSnow = this.world.isSnow(p.pos.x, p.pos.z);
    if ((p.handfuls > 0 && p.ammo < MAX_BALLS) || (onSnow && p.ammo < MAX_BALLS && p.handfuls < MAX_HANDFULS)) m |= 4;
    return m;
  }

  // the gesture that makes sense right now (glows in the motion HUD)
  wantedAction() {
    const p = this.me;
    if (!p || this.phase !== 'playing' || this._isFrozen(p)) return null;
    if (this.carrying(p) >= 0) return 'run';
    if (p.handfuls > 0 && p.ammo < MAX_BALLS) return 'pack';
    if (p.ammo === 0) return this.world.isSnow(p.pos.x, p.pos.z) ? 'scoop' : 'run';
    return 'throw';
  }

  // ------------------------------------------------------------------ per frame
  update(dt, inp) {
    this.time += dt;
    if (this.paused) { this._render(0); return; }
    const now = this.now();
    // phase
    if (this.phase === 'countdown') {
      const c = this.countdown();
      if (c !== this._lastCount && !this.attract) {
        this._lastCount = c;
        if (c >= 1 && c <= 3) this._sfx('countdown');
      }
      if (now >= this.startAt) {
        this.phase = 'playing';
        this._sfx('go');
        if (this.app.hud && !this.attract) this.app.hud.banner('GO!', 'go big');
      }
    } else if (this.phase === 'playing' && now >= this.endAt) {
      this.phase = 'finished';
      this.finishedAt = now;
      this.guide.set(false);
      if (!this.lan) this.results = this.localResults();
      this._sfx('finish', { good: this.score[this.myTeam] >= this.score[1 - this.myTeam] });
    }
    if (this.phase === 'playing' && !this.attract) {
      const left = Math.ceil(this.timeLeft() / 1000);
      if (left <= 10 && left !== this._lastTick) { this._lastTick = left; this._sfx('tick'); }
      const carried = this.stars.some((s) => s.s === 'carried');
      this.app.audio.setIntensity((carried ? 0.6 : 0.15) + (left < 30 ? 0.4 : 0));
    }
    // entities
    for (const p of this.players.values()) {
      if (p.left) continue;
      if (p.id === this.myId) this._updateLocalPlayer(p, dt, inp);
      else if (p.local && p.brain) this._updateBot(p, dt);
      else if (!p.local) this._interpolate(p, dt);
    }
    if (this.isHost && this.phase === 'playing') this._updateStars();
    this._updateBalls(dt);
    this._processEvents();
    if (this.lan && now - this._netAt >= NET_MS && this.phase !== 'finished') { this._netAt = now; this._sendState(); }
    else if (this.lan && this.phase === 'finished' && now - this._netAt >= 250) { this._netAt = now; this._sendState(); }
    this._sendStatus();
    this._render(dt);
  }

  // ------------------------------------------------------------------ visuals
  resize(h) { this.particles.setScale(h); this.sparkles.setScale(h); }

  _render(dt) {
    const t = this.time;
    for (const p of this.players.values()) {
      if (!p.avatar || p.left) continue;
      const a = p.avatar;
      a.root.position.copy(p.pos);
      a.root.rotation.y = p.yaw;
      a.update(dt, { speed: p.speed, action: p.action, actionT: p.actionDur ? p.actionT / p.actionDur : 1, frozen: this._isFrozen(p), shield: this._isShielded(p), ammo: p.ammo, t });
      // footstep dust
      if (p.speed > 2 && Math.random() < dt * p.speed * 0.8) this.particles.spawn(p.pos.x, 0.05, p.pos.z, (Math.random() - 0.5) * 0.6, 0.6, (Math.random() - 0.5) * 0.6, { size: 0.12, life: 0.5, alpha: 0.6 });
    }
    // stars
    for (const s of this.stars) {
      let pos;
      if (s.s === 'carried') {
        const c = this.players.get(s.by);
        pos = c ? _v.set(c.pos.x, c.pos.y + (c.id === this.myId ? 2.35 : 2.55), c.pos.z) : s.p;
      } else pos = s.s === 'home' ? starHome(s.team) : _v.copy(s.p).setY(0.75);
      this.world.setStar(s.team, s.s, pos);
      if (s.s === 'carried' && Math.random() < dt * 30) this.sparkles.spawn(pos.x, pos.y, pos.z, (Math.random() - 0.5), -0.5, (Math.random() - 0.5), { size: 0.09, life: 0.8, color: s.team === 0 ? [0.4, 0.7, 1] : [1, 0.5, 0.4], gravity: 0.2 });
    }
    this.particles.update(dt);
    this.sparkles.update(dt);
    this._placeCamera(dt);
    // first-person hands and the aiming guide
    const me = this.me;
    if (me && this.hands) {
      this.hands.update(dt, { speed: me.speed, run: me.speed > WALK + 0.5, ammo: me.ammo, handfuls: me.handfuls, action: me.action, actionT: me.actionDur ? me.actionT / me.actionDur : 1, frozen: this._isFrozen(me) });
      const show = this.phase === 'playing' && me.ammo > 0 && !this._isFrozen(me) && this.app.settings.guide !== false;
      this.guide.set(show);
      if (show) {
        const mouse = !!document.pointerLockElement && this.app.input.lastDevice === 'keyboard';
        const { vel, lock } = this.aimVelocity(me, this.app.input.lastDevice === 'motion' ? 0.85 : 0.85, { assist: !mouse, spread: false });
        const f = _v2.set(-Math.sin(me.yaw), 0, -Math.cos(me.yaw));
        const origin = new THREE.Vector3(me.pos.x + f.x * 0.35 + f.z * 0.18, 1.55, me.pos.z + f.z * 0.35 - f.x * 0.18);
        this.guide.update(this.world, origin, vel, t, !!lock);
        this.aimLock = lock;
      } else this.aimLock = null;
    }
  }

  _placeCamera(dt) {
    const cam = this.camera;
    const me = this.me;
    if (!me) {
      // attract: slow orbit high above the arena, gently following the action
      this._orbit += dt * 0.05;
      const r = 62, a = this._orbit;
      cam.position.set(Math.sin(a) * r * 0.75, 21 + Math.sin(a * 0.7) * 4, Math.cos(a) * r);
      const s0 = this.stars.find((s) => s.s === 'carried');
      const look = s0 ? this.players.get(s0.by)?.pos || _v.set(0, 0, 0) : _v.set(0, 0, 0);
      this._look = this._look || new THREE.Vector3();
      this._look.lerp(_v2.set(look.x * 0.5, 1, look.z * 0.5), 1 - Math.exp(-dt * 1.5));
      cam.lookAt(this._look);
      if (cam.fov !== 55) { cam.fov = 55; cam.updateProjectionMatrix(); }
      return;
    }
    const frozen = this._isFrozen(me);
    const bob = me.speed > 0.3 ? Math.sin(this.hands ? this.hands.bob * 2 : 0) * 0.035 * Math.min(1, me.speed / 6) : 0;
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const sh = this.shake * this.shake;
    cam.position.set(me.pos.x + (Math.random() - 0.5) * sh * 0.2, EYE + bob + (frozen ? -0.12 : 0), me.pos.z + (Math.random() - 0.5) * sh * 0.2);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = me.yaw;
    cam.rotation.x = me.pitch + (frozen ? -0.1 : 0);
    cam.rotation.z = frozen ? Math.sin(this.time * 2) * 0.03 : -me.vel.dot(_v.set(Math.cos(me.yaw), 0, -Math.sin(me.yaw))) * 0.004;
    this.fovKick = Math.max(0, this.fovKick - dt * 3);
    const fov = 72 + (me.speed > WALK + 0.5 ? 7 : 0) + this.fovKick * 2;
    cam.fov = damp(cam.fov, fov, 6, dt || 1);
    cam.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- bot AI
class Brain {
  constructor(match, p) {
    this.m = match;
    this.p = p;
    this.role = p.slot % 3 === 2 ? 'defend' : 'attack';
    this.think = Math.random() * 0.3;
    this.steerT = 0;
    this.goal = new THREE.Vector3();
    this.run = false;
    this.wantGather = false;
    this.target = null;
    this.aimDelay = 0.5;
    this.dir = 0;
    this.moveDir = null;
    this.stuckT = 0;
    this.stuckPos = p.pos.clone();
    this.sideUntil = 0;
    this.sideDir = 0;
    this.patrol = Math.random() * 10;
  }

  reset() { this.target = null; this.think = 0; this.aimDelay = 0.6 / this.m.skill; }

  update(dt) {
    const m = this.m, p = this.p;
    this.think -= dt;
    if (this.think <= 0) { this.think = 0.25 + Math.random() * 0.1; this._decide(); }
    // gathering: stand still and work the snow
    if (this.wantGather && !this.target) {
      if (!p.action) {
        if (p.handfuls > 0) m.trySnow(p, 'pack');
        else if (m.world.isSnow(p.pos.x, p.pos.z)) m.trySnow(p, 'scoop');
      }
      if (p.action === 'scoop' || p.action === 'pack') { m._move(p, dt, 0, 0, 0); return; }
    }
    // engage
    if (this.target && p.ammo > 0) {
      const q = this.target;
      const v = throwSpeed(this._power(q));
      const sol = m._ballistic(p, q, v);
      if (sol) {
        p.yaw = dampAngle(p.yaw, sol.yaw, 8, dt);
        this.aimDelay -= dt;
        if (this.aimDelay <= 0 && Math.abs(wrapAngle(sol.yaw - p.yaw)) < 0.25 && p.cooldown <= 0 && !p.action) {
          const err = 0.07 / m.skill;
          const yaw = sol.yaw + (Math.random() * 2 - 1) * err;
          const pitch = sol.pitch + (Math.random() * 2 - 1) * err * 0.7;
          const c = Math.cos(pitch);
          m.throwBall(p, new THREE.Vector3(-Math.sin(yaw) * c * v, Math.sin(pitch) * v, -Math.cos(yaw) * c * v), 0.8);
          this.aimDelay = (0.55 + Math.random() * 0.7) / m.skill;
        }
      }
    }
    // steering
    this.steerT -= dt;
    if (this.steerT <= 0) { this.steerT = 0.12; this._steer(); }
    const now = performance.now();
    let wx = 0, wz = 0;
    if (now < this.sideUntil) { wx = Math.cos(this.sideDir); wz = Math.sin(this.sideDir); }
    else if (this.moveDir != null) { wx = -Math.sin(this.moveDir); wz = -Math.cos(this.moveDir); }
    let speed = this.run ? RUN : WALK * 0.95;
    if (m.carrying(p) >= 0) speed *= CARRY;
    if (p.action === 'scoop' || p.action === 'pack') speed *= BUSY;
    m._move(p, dt, wx, wz, speed);
    if (!this.target || p.ammo === 0) {
      if (p.speed > 0.5) p.yaw = dampAngle(p.yaw, Math.atan2(-p.vel.x, -p.vel.z), 6, dt);
    }
    // stuck detection
    this.stuckT += dt;
    if (this.stuckT > 1) {
      if (this.moveDir != null && p.pos.distanceTo(this.stuckPos) < 0.6 && !p.action) {
        this.sideUntil = now + 700;
        this.sideDir = Math.random() * Math.PI * 2;
      }
      this.stuckT = 0;
      this.stuckPos.copy(p.pos);
    }
  }

  _power(q) {
    const d = q.pos.distanceTo(this.p.pos);
    return clamp(0.45 + d / 45, 0.45, 1);
  }

  _decide() {
    const m = this.m, p = this.p, s = teamSign(p.team);
    const myStar = m.stars[p.team], theirStar = m.stars[1 - p.team];
    const carryingIdx = m.carrying(p);
    const mates = [...m.players.values()].filter((q) => q.team === p.team && !q.left && q !== p);
    const enemies = [...m.players.values()].filter((q) => q.team !== p.team && !q.left && !m._isFrozen(q));
    const dist = (a) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z);
    const nearestTo = (pt) => [p, ...mates].filter((q) => !m._isFrozen(q)).sort((a, b) => Math.hypot(a.pos.x - pt.x, a.pos.z - pt.z) - Math.hypot(b.pos.x - pt.x, b.pos.z - pt.z))[0];
    this.run = false;
    let goal = null;
    // 1. carrying their star: home!
    if (carryingIdx >= 0) { goal = starHome(p.team); this.run = true; }
    // 2. our star carried: chase the thief
    if (!goal && myStar.s === 'carried') {
      const thief = m.players.get(myStar.by);
      if (thief && (this.role === 'defend' || dist(thief.pos) < 35 || nearestTo(thief.pos) === p)) { goal = thief.pos.clone(); this.run = true; }
    }
    // 3. our star dropped: return it
    if (!goal && myStar.s === 'dropped' && (nearestTo(myStar.p) === p || dist(myStar.p) < 20)) { goal = myStar.p.clone(); this.run = true; }
    // ammo
    const threat = enemies.some((q) => dist(q.pos) < 14);
    this.wantGather = !goal && (p.ammo === 0 || (p.ammo < 2 && !threat) || (p.handfuls > 0 && p.ammo < MAX_BALLS && !threat));
    if (this.wantGather && p.handfuls === 0 && !m.world.isSnow(p.pos.x, p.pos.z)) {
      // step off the deck / ice onto the snow
      goal = m.world.onDeck(p.pos.x, p.pos.z) ? new THREE.Vector3(p.pos.x * 0.3, 0, s * 41) : new THREE.Vector3(p.pos.x * 1.5 + 0.1, 0, p.pos.z * 1.4 + 0.1);
    } else if (this.wantGather) goal = p.pos.clone();
    // 4. attack: go for their star, escort a carrier
    if (!goal && this.role === 'attack') {
      const carrier = theirStar.s === 'carried' ? m.players.get(theirStar.by) : null;
      if (carrier && carrier !== p) {
        goal = carrier.pos.clone().add(new THREE.Vector3((p.slot - 1) * 3, 0, -s * 4));
        this.run = true;
      } else goal = theirStar.p.clone();
      if (dist(goal) > 25 && !threat) this.run = Math.random() < 0.7;
    }
    // 5. defend: patrol in front of the fort
    if (!goal) {
      this.patrol += 0.25;
      const near = enemies.filter((q) => Math.abs(q.pos.z) * Math.sign(q.pos.z) * s > 15 && dist(q.pos) < 30).sort((a, b) => dist(a.pos) - dist(b.pos))[0];
      goal = near ? near.pos.clone().lerp(starHome(p.team), 0.45) : new THREE.Vector3(Math.sin(this.patrol * 0.35) * 9, 0, s * (38 + Math.sin(this.patrol * 0.2) * 3));
    }
    this.goal.copy(goal);
    // pick a target to throw at
    this.target = null;
    if (p.ammo > 0) {
      const eye = _v.set(p.pos.x, 1.7, p.pos.z);
      let best = null, bd = 30 * (0.8 + m.skill * 0.2);
      for (const q of enemies) {
        if (m._isShielded(q)) continue;
        const d = dist(q.pos);
        const carrierBonus = m.carrying(q) >= 0 ? 10 : 0;
        if (d - carrierBonus < bd && !m.world.segmentBlocked(eye, _v2.set(q.pos.x, 1.7, q.pos.z))) { bd = d - carrierBonus; best = q; }
      }
      if (best && best !== this.target) this.aimDelay = Math.max(this.aimDelay, (0.25 + Math.random() * 0.35) / m.skill);
      this.target = best;
    }
  }

  // next waypoint (through the fort gates) and an obstacle-free heading
  _route() {
    const p = this.p.pos, g = this.goal;
    for (const team of [0, 1]) {
      const s = teamSign(team);
      const gIn = Math.abs(g.x) < 9 && g.z * s > 44.2, pIn = Math.abs(p.x) < 9.6 && p.z * s > 44.0;
      if (gIn && !pIn) {
        // approach the gate from the front
        if (p.z * s > 42.8 || Math.abs(p.x) > 9.6) {
          if (Math.abs(p.x) > 2.2 || p.z * s > 43.2) return new THREE.Vector3(0, 0, s * 41.5);
        }
        return new THREE.Vector3(0, 0, s * 46.5);
      }
      if (pIn && !gIn) {
        if (p.z * s > 45.6 || Math.abs(p.x) > 2.2) return new THREE.Vector3(0, 0, s * 45.2);
        return new THREE.Vector3(0, 0, s * 41.5);
      }
    }
    return g;
  }

  _steer() {
    const m = this.m, p = this.p;
    const wp = this._route();
    const dx = wp.x - p.pos.x, dz = wp.z - p.pos.z, d = Math.hypot(dx, dz);
    if (d < (wp === this.goal ? 1.0 : 0.8) || (this.wantGather && wp === this.goal && d < 1.5)) { this.moveDir = null; return; }
    const base = Math.atan2(-dx, -dz);
    const look = Math.min(2.4, d);
    for (const off of [0, 0.35, -0.35, 0.75, -0.75, 1.15, -1.15, 1.6, -1.6, 2.2, -2.2, 3.0]) {
      const a = base + off * (this.dir || 1);
      const x1 = p.pos.x - Math.sin(a) * look, z1 = p.pos.z - Math.cos(a) * look;
      if (!m.world.walkBlocked(p.pos.x, p.pos.z, x1, z1, RADIUS + 0.05)) {
        this.moveDir = a;
        if (off !== 0 && !this.dir) this.dir = Math.sign(off);
        if (off === 0) this.dir = 0;
        return;
      }
    }
    this.moveDir = base;
  }
}

export { TEAM_NAME, TEAM_CSS, World };
