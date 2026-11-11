// Kart: arcade physics (for locally simulated karts), remote interpolation and all per-kart visuals.
import * as THREE from '../libs/three.bundle.js';
import { clamp, lerp, damp, wrapAngle, dampAngle } from './util.js';
import { CHARACTERS, buildKart, buildItemMesh } from './kartModel.js';

export const DRIFT_LEVELS = [0.9, 1.9, 3.0]; // seconds of charge for blue / orange / purple
const MT_BOOST = [0.6, 1.1, 1.6];
const GRAVITY = 32;
const KART_RADIUS = 1.15;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export function charStats(charIndex) {
  const c = CHARACTERS[charIndex % CHARACTERS.length];
  return c.stats;
}

export class Kart {
  constructor({ id, name, charIndex = 0, isBot = false, local = true, track, cc, quality = 'high', isPlayer = false }) {
    this.id = id;
    this.name = name;
    this.charIndex = charIndex;
    this.char = CHARACTERS[charIndex % CHARACTERS.length];
    this.isBot = isBot;
    this.local = local; // simulated on this client
    this.isPlayer = isPlayer; // the human driving on this client
    this.track = track;
    const st = this.char.stats;
    this.stats = st;
    this.baseMax = cc.maxSpeed * (0.955 + 0.018 * st.speed);
    this.accel = 15 + st.accel * 3.2;
    this.turnRate = 1.75 + st.handling * 0.13;
    this.weight = 0.75 + st.weight * 0.12;
    this.grip = 7.5 + st.handling * 0.6;

    this.model = buildKart(this.char.id, { quality });
    this.ud = this.model.userData;
    this.root = new THREE.Group();
    this.root.add(this.model);
    this.root.name = 'kart-' + id;

    // shield bubble
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.9, 24, 16),
      new THREE.MeshPhysicalMaterial({ color: 0x66ddff, emissive: 0x2299ff, emissiveIntensity: 0.6, transparent: true, opacity: 0.28, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.shieldMesh.position.y = 0.9;
    this.shieldMesh.visible = false;
    this.root.add(this.shieldMesh);
    // held item visual (orb / bomb trailing behind)
    this.heldMesh = null;

    this.q = {}; // track query scratch
    this.reset(0);
  }

  reset(slot) {
    const tr = this.track;
    const s = tr.gridSlot(slot);
    const p = tr.point(s.idx, s.lat);
    this.pos = new THREE.Vector3(p.x, p.y + 0.02, p.z);
    this.heading = tr.heading(s.idx);
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.speed = 0; // forward speed (signed)
    this.grounded = true;
    this.airTime = 0;
    this.hint = Math.floor(s.idx);
    this.totalIdx = s.idx - tr.N; // negative before the line
    this.maxTotal = this.totalIdx;
    this.lap = 0; // laps completed
    this.lapStart = 0;
    this.lapTimes = [];
    this.finished = false;
    this.finishTime = null;
    this.place = slot + 1;
    this.drift = 0; // -1/0/1 direction
    this.driftCharge = 0;
    this.driftLevel = 0;
    this.hopT = 0;
    this.boostT = 0;
    this.boostPower = 1;
    this.padCooldown = 0;
    this.spinT = 0;
    this.spinDur = 1;
    this.tumble = false;
    this.squash = 0;
    this.shrinkT = 0;
    this.megaT = 0;
    this.shieldT = 0;
    this.starT = 0;
    this.invulnT = 0;
    this.coins = 0;
    this.item = null;
    this.itemCount = 0;
    this.rouletteT = 0;
    this.trickT = 0;
    this.trickArmed = false;
    this.trickDone = false;
    this.wrongWayT = 0;
    this.offroad = false;
    this.onBoostPad = false;
    this.steerVis = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this.visYaw = 0;
    this.spinYaw = 0;
    this.wheelRot = 0;
    this.rocket = { pressedAt: null, result: null };
    this.lastWallHit = 0;
    this.events = []; // emitted to the game each frame (sounds / fx)
    // remote interpolation buffer
    this.buf = [];
    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.heading, 0);
    this.ground = p.y;
    this.slopeX = 0;
  }

  get maxSpeed() {
    let m = this.baseMax * (1 + Math.min(10, this.coins) * 0.01);
    if (this.shrinkT > 0) m *= 0.72;
    if (this.megaT > 0) m *= 1.12;
    if (this.aiScale) m *= this.aiScale;
    return m;
  }

  get boosting() { return this.boostT > 0; }
  get spinning() { return this.spinT > 0; }
  get immune() { return this.megaT > 0 || this.starT > 0; }
  get progress() { return this.finished ? 1e9 - this.place : this.totalIdx; }

  emit(type, data) { this.events.push({ type, ...data }); }

  // -------------------------------------------------------------- physics
  // input: {throttle 0..1, brake 0..1, steer -1..1, drift bool, driftPressed bool}
  // racing: false during countdown
  simulate(dt, input, racing, raceTime) {
    const tr = this.track;
    const q = tr.query(this.pos.x, this.pos.y, this.pos.z, this.hint, this.q);
    this.hint = q.idx;

    // progress along the lap, continuous across the start line
    const pos = q.pos;
    let d = pos - this.prevPos;
    if (this.prevPos == null || !isFinite(d)) d = 0;
    if (d > tr.N / 2) d -= tr.N;
    if (d < -tr.N / 2) d += tr.N;
    this.totalIdx += d;
    this.prevPos = pos;

    // timers
    this.boostT = Math.max(0, this.boostT - dt);
    this.padCooldown = Math.max(0, this.padCooldown - dt);
    this.shrinkT = Math.max(0, this.shrinkT - dt);
    this.megaT = Math.max(0, this.megaT - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.squash = damp(this.squash, 0, 9, dt);

    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const lx = fz, lz = -fx; // left
    let vF = this.vx * fx + this.vz * fz;
    let vL = this.vx * lx + this.vz * lz;

    const canDrive = racing && !this.finished && this.spinT <= 0;
    const ctrl = this.finished && this.isBot === false && this.autoInput ? this.autoInput : input;
    let throttle = canDrive || (this.finished && racing) ? ctrl.throttle : 0;
    let brake = canDrive || (this.finished && racing) ? ctrl.brake : 0;
    let steer = this.spinT > 0 ? 0 : ctrl.steer;

    // pre-race: rocket start timing
    if (!racing) {
      if (input.throttle > 0.5 && this.rocket.pressedAt == null) this.rocket.pressedAt = raceTime; // raceTime < 0 during countdown
      if (input.throttle < 0.5 && raceTime < -0.2) this.rocket.pressedAt = null;
    }

    // spin-out
    if (this.spinT > 0) {
      this.spinT -= dt;
      const k = this.spinT / this.spinDur;
      this.spinYaw = (1 - k) * Math.PI * (this.tumble ? 2 : 4);
      if (this.spinT <= 0) { this.spinYaw = 0; this.tumble = false; this.invulnT = 1.2; }
      vF *= Math.exp(-2.2 * dt);
    }

    const max = this.maxSpeed * (this.boostT > 0 ? 1.32 * this.boostPower : 1);
    let target = max * throttle;
    const surfaceSlow = this.offroad && this.boostT <= 0 && this.megaT <= 0;
    if (surfaceSlow) target *= 0.52;
    if (brake > 0.1) target = vF > 1 ? 0 : -max * 0.35 * brake;

    // longitudinal
    if (this.grounded) {
      if (this.boostT > 0 && throttle > 0.1) {
        vF = Math.min(vF + 70 * dt, max);
      } else if (brake > 0.1 && vF > 0.5) {
        vF -= 42 * brake * dt;
      } else if (vF < target) {
        const a = this.accel * (1.15 - 0.6 * clamp(vF / max, 0, 1));
        vF = Math.min(target, vF + a * dt);
      } else {
        const decel = surfaceSlow ? 36 : throttle > 0.1 ? 14 : 9;
        vF = Math.max(target, vF - decel * dt);
      }
      // slope
      vF -= q.slope * 9 * dt * (this.boostT > 0 ? 0.3 : 1);
    }

    // steering
    const speed01 = clamp(Math.abs(vF) / this.baseMax, 0, 1.4);
    const steerAuth = clamp(Math.abs(vF) / 6, 0, 1) * (1 - 0.25 * clamp(speed01 - 0.6, 0, 1));
    let yawRate;
    if (this.drift !== 0) {
      // steering adjusts drift tightness: outward = wide, inward = tight
      const s = steer * this.drift; // -1..1
      const tight = 0.62 + 0.5 * s;
      yawRate = this.drift * this.turnRate * tight * 1.08 * clamp(Math.abs(vF) / 10, 0.3, 1);
    } else {
      yawRate = steer * this.turnRate * steerAuth * Math.sign(vF || 1);
    }
    if (!this.grounded) yawRate *= 0.45;
    if (this.spinT > 0) yawRate = 0;
    this.heading = wrapAngle(this.heading + yawRate * dt);

    // drift state machine
    if (canDrive && this.grounded && ctrl.driftPressed && this.hopT <= 0) {
      this.hopT = 0.0001;
      this.vy = 5.2;
      this.grounded = false;
      this.emit('hop');
    }
    if (this.drift !== 0) {
      const hold = ctrl.drift && canDrive && vF > 8;
      if (!hold) {
        this._releaseDrift();
      } else if (this.grounded) {
        const s = steer * this.drift;
        this.driftCharge += dt * (0.75 + 0.5 * Math.max(0, s)) * (this.offroad ? 0.4 : 1);
        const lvl = this.driftCharge >= DRIFT_LEVELS[2] ? 3 : this.driftCharge >= DRIFT_LEVELS[1] ? 2 : this.driftCharge >= DRIFT_LEVELS[0] ? 1 : 0;
        if (lvl > this.driftLevel) { this.driftLevel = lvl; this.emit('driftLevel', { level: lvl }); }
      }
    }

    // re-project velocity on the new heading: grip pulls velocity toward the facing direction
    const nfx = Math.sin(this.heading), nfz = Math.cos(this.heading);
    const nlx = nfz, nlz = -nfx;
    const vx0 = nfx * vF + lx * vL * 0 + this.vx * 0, vz0 = nfz * vF;
    // lateral slide: carry part of old lateral velocity
    const oldLat = this.vx * nlx + this.vz * nlz + 0;
    const newF = this.vx * nfx + this.vz * nfz;
    let lat = (this.grounded ? oldLat * Math.exp(-(this.drift ? this.grip * 0.35 : this.grip) * dt) : oldLat);
    if (this.drift !== 0 && this.grounded) lat += -this.drift * Math.abs(vF) * 0.9 * dt; // slide outward
    // forward uses vF integrated above (keeps accel model), small blend with projected for momentum
    const fwd = this.grounded ? vF : lerp(newF, vF, 0.5);
    this.vx = nfx * fwd + nlx * lat;
    this.vz = nfz * fwd + nlz * lat;
    void vx0; void vz0;
    this.speed = fwd;

    // integrate horizontal
    this.pos.x += this.vx * dt;
    this.pos.z += this.vz * dt;

    // ground & walls
    const q2 = tr.query(this.pos.x, this.pos.y, this.pos.z, this.hint, this.q);
    this.hint = q2.idx;
    const wallLimit = q2.wall - KART_RADIUS * 0.8;
    if (Math.abs(q2.lat) > wallLimit) {
      const sgn = Math.sign(q2.lat);
      const pen = Math.abs(q2.lat) - wallLimit;
      const wlx = q2.tz, wlz = -q2.tx; // track left
      this.pos.x -= wlx * sgn * pen;
      this.pos.z -= wlz * sgn * pen;
      const vn = (this.vx * wlx + this.vz * wlz) * sgn; // into wall > 0
      if (vn > 0) {
        this.vx -= wlx * sgn * vn * 1.6;
        this.vz -= wlz * sgn * vn * 1.6;
        const loss = clamp(vn / 25, 0, 0.45);
        this.vx *= 1 - loss; this.vz *= 1 - loss;
        this.speed *= 1 - loss;
        // turn the kart slightly away from the wall
        const away = Math.atan2(q2.tx, q2.tz);
        this.heading = dampAngle(this.heading, away, 3 * clamp(vn / 8, 0, 1), 0.1);
        if (vn > 3 && raceTime - this.lastWallHit > 0.25) {
          this.lastWallHit = raceTime;
          this.emit('wall', { strength: clamp(vn / 18, 0.2, 1) });
        }
      }
    }
    this.offroad = !q2.onRoad && this.grounded;
    const g = q2.ground;
    const prevGround = this.ground;
    this.ground = g;
    this.slopeX = q2.slope;

    if (this.grounded) {
      if (g < this.pos.y - 0.45 && this.hopT <= 0) {
        // ground fell away (ramp lip / crest): ballistic flight
        this.grounded = false;
        this.vy = Math.max(this.groundVy || 0, 0) + (q.onRamp ? 2.5 : 0);
        this.airTime = 0;
        this.trickArmed = q.onRamp || this.vy > 4;
        this.trickDone = false;
        if (this.trickArmed) this.emit('launch');
      } else {
        this.groundVy = clamp((g - prevGround) / Math.max(dt, 1e-3), -20, 25);
        this.pos.y = g;
        this.vy = 0;
      }
    }
    if (!this.grounded) {
      this.airTime += dt;
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (this.trickArmed && !this.trickDone && ctrl.driftPressed && this.airTime < 0.6 && canDrive) {
        this.trickDone = true;
        this.trickT = 0.45;
        this.emit('trick');
      }
      if (this.pos.y <= g && this.vy <= 0) {
        this.pos.y = g;
        const impact = -this.vy;
        this.vy = 0;
        this.grounded = true;
        this.groundVy = 0;
        if (this.hopT > 0) {
          this.hopT = 0;
          // start drift if steering when landing from the hop
          if (ctrl.drift && Math.abs(steer) > 0.25 && vF > 10 && canDrive && this.drift === 0) {
            this.drift = Math.sign(steer);
            this.driftCharge = 0;
            this.driftLevel = 0;
            this.emit('driftStart', { dir: this.drift });
          }
        }
        if (this.airTime > 0.25 || impact > 6) {
          this.squash = clamp(impact / 25, 0.12, 0.45);
          this.emit('land', { strength: clamp(impact / 20, 0.2, 1) });
        }
        if (this.trickDone) {
          this.trickDone = false;
          this.giveBoost(0.75, 'trick');
        }
        this.trickArmed = false;
        this.airTime = 0;
      }
    }
    if (this.hopT > 0) this.hopT += dt;
    this.trickT = Math.max(0, this.trickT - dt);

    // boost pads
    if (q2.boost && this.padCooldown <= 0) {
      this.padCooldown = 0.3;
      this.giveBoost(1.1, 'pad');
    }

    // wrong way detection
    const dotT = Math.sin(this.heading) * q2.tx + Math.cos(this.heading) * q2.tz;
    if (racing && !this.finished && dotT < -0.35 && Math.abs(this.speed) > 4) this.wrongWayT += dt;
    else this.wrongWayT = Math.max(0, this.wrongWayT - dt * 2);

    // safety respawn (fell through / stuck outside world)
    if (this.pos.y < g - 12 || !isFinite(this.pos.x)) this.respawn();

    // laps
    if (this.totalIdx > this.maxTotal) this.maxTotal = this.totalIdx;
  }

  _releaseDrift() {
    if (this.driftLevel > 0) {
      const lvl = this.driftLevel;
      this.giveBoost(MT_BOOST[lvl - 1], 'mt' + lvl);
      this.emit('miniTurbo', { level: lvl });
    }
    this.drift = 0;
    this.driftCharge = 0;
    this.driftLevel = 0;
  }

  giveBoost(t, kind = 'item') {
    this.boostT = Math.max(this.boostT, t);
    this.boostPower = 1;
    if (this.speed < this.maxSpeed) this.speed = Math.max(this.speed, this.maxSpeed * 0.9);
    this.emit('boost', { kind });
  }

  rocketStart() {
    const p = this.rocket.pressedAt;
    if (p == null) return null;
    // good window: pressed between 1.15 s and 0.45 s before GO
    if (p >= -1.15 && p <= -0.45) {
      this.giveBoost(1.3, 'rocket');
      this.emit('rocket');
      return 'good';
    }
    if (p < -1.6) {
      // flooded the engine
      this.spinT = 0.7; this.spinDur = 0.7; this.tumble = false;
      this.emit('stall');
      return 'stall';
    }
    return null;
  }

  // effect: 'spin' | 'tumble' | 'shrink' | 'squash'; returns false when blocked
  hit(effect, { from } = {}) {
    if (this.finished) return false;
    if (this.immune && effect !== 'shrink') return false;
    if (this.invulnT > 0 && effect !== 'shrink') return false;
    if (this.shieldT > 0) {
      this.shieldT = 0;
      this.emit('shieldBreak');
      return false;
    }
    if (effect === 'shrink') {
      if (this.megaT > 0) { this.megaT = 0; }
      this.shrinkT = 4.5;
      this.item = null; this.itemCount = 0; this.rouletteT = 0;
      this._releaseDriftSilently();
      this.emit('shrunk');
      return true;
    }
    this._releaseDriftSilently();
    this.boostT = 0;
    const lose = Math.min(this.coins, effect === 'tumble' ? 3 : 2);
    this.coins -= lose;
    if (lose) this.emit('coinsLost', { n: lose });
    if (effect === 'tumble') {
      this.spinT = this.spinDur = 1.5;
      this.tumble = true;
      this.vy = 9;
      this.grounded = false;
      this.hopT = 0;
    } else if (effect === 'bump') {
      this.spinT = this.spinDur = 0.5;
      this.tumble = false;
    } else {
      this.spinT = this.spinDur = 1.15;
      this.tumble = false;
    }
    this.emit('hit', { effect, from });
    return true;
  }

  _releaseDriftSilently() { this.drift = 0; this.driftCharge = 0; this.driftLevel = 0; }

  respawn() {
    const tr = this.track;
    const i = this.hint;
    const p = tr.point(i, 0);
    this.pos.set(p.x, p.y + 3, p.z);
    this.heading = tr.heading(i);
    this.vx = this.vz = this.vy = 0;
    this.speed = 0;
    this.grounded = false;
    this.invulnT = 2;
    this.emit('respawn');
  }

  // -------------------------------------------------------------- network
  serialize() {
    return {
      id: this.id,
      x: +this.pos.x.toFixed(2), y: +this.pos.y.toFixed(2), z: +this.pos.z.toFixed(2),
      h: +this.heading.toFixed(3), s: +this.speed.toFixed(1),
      vx: +this.vx.toFixed(1), vz: +this.vz.toFixed(1),
      d: this.drift, dl: this.driftLevel, b: this.boostT > 0 ? 1 : 0,
      sp: +this.spinT.toFixed(2), tu: this.tumble ? 1 : 0, g: this.grounded ? 1 : 0,
      sh: this.shieldT > 0 ? 1 : 0, mg: +this.megaT.toFixed(1), sr: +this.shrinkT.toFixed(1),
      tr: this.trickT > 0 ? 1 : 0, c: this.coins, it: this.item, ic: this.itemCount,
      prog: +this.totalIdx.toFixed(2), lap: Math.min(this.laps || 3, this.lap + 1), f: this.finished ? 1 : 0, st: this.steerVis.toFixed ? +this.steerVis.toFixed(2) : 0,
      hint: this.hint,
    };
  }

  pushRemote(s, t) {
    this.buf.push({ t, s });
    if (this.buf.length > 30) this.buf.shift();
  }

  // interpolate remote kart at render time (renderT in server ms, already delayed)
  interpolate(renderT, dt) {
    const b = this.buf;
    if (!b.length) return;
    let a = b[0], c = b[b.length - 1];
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i].t <= renderT && b[i + 1].t >= renderT) { a = b[i]; c = b[i + 1]; break; }
    }
    let k = c.t === a.t ? 1 : clamp((renderT - a.t) / (c.t - a.t), 0, 1);
    let x, y, z, h;
    if (renderT > c.t) {
      // extrapolate briefly using velocity
      const ex = Math.min((renderT - c.t) / 1000, 0.25);
      x = c.s.x + c.s.vx * ex; y = c.s.y; z = c.s.z + c.s.vz * ex; h = c.s.h;
      a = c;
      k = 1;
    } else {
      x = lerp(a.s.x, c.s.x, k); y = lerp(a.s.y, c.s.y, k); z = lerp(a.s.z, c.s.z, k);
      h = a.s.h + wrapAngle(c.s.h - a.s.h) * k;
    }
    const s = c.s;
    // smooth toward the target to hide jitter
    const tp = _v.set(x, y, z);
    if (this.pos.distanceToSquared(tp) > 100) this.pos.copy(tp);
    else this.pos.lerp(tp, 1 - Math.exp(-25 * dt));
    this.heading = dampAngle(this.heading, h, 25, dt);
    this.speed = s.s; this.vx = s.vx; this.vz = s.vz;
    this.drift = s.d; this.driftLevel = s.dl; this.boostT = s.b ? 0.1 : 0;
    this.spinT = s.sp; this.tumble = !!s.tu; this.grounded = !!s.g;
    this.shieldT = s.sh ? 1 : 0; this.megaT = s.mg; this.shrinkT = s.sr; this.trickT = s.tr ? 0.3 : 0;
    this.coins = s.c; this.item = s.it; this.itemCount = s.ic;
    this.totalIdx = s.prog; this.finished = !!s.f;
    this.steerRemote = s.st || 0;
    if (s.hint != null) this.hint = s.hint;
    if (this.spinT > 0) {
      this.spinYaw = (this.spinYaw || 0) + dt * (this.tumble ? 9 : 14);
    } else this.spinYaw = 0;
    this.lap = Math.max(0, (s.lap || 1) - 1);
    const q = this.track.query(this.pos.x, this.pos.y, this.pos.z, this.hint, this.q);
    this.hint = q.idx;
    this.offroad = !q.onRoad && this.grounded;
    this.slopeX = q.slope;
    this.ground = q.ground;
  }

  // -------------------------------------------------------------- visuals
  updateVisual(dt, t, input, particles) {
    const ud = this.ud;
    const steerIn = this.local ? (this.spinT > 0 ? 0 : input ? input.steer : 0) : this.steerRemote || 0;
    this.steerVis = damp(this.steerVis, steerIn, 12, dt);
    this.root.position.copy(this.pos);

    // body attitude
    const driftYaw = this.drift * 0.42;
    this.visYaw = damp(this.visYaw, driftYaw, 8, dt);
    const tumbleSpin = this.tumble ? this.spinYaw : 0;
    const flatSpin = this.tumble ? 0 : this.spinYaw;
    const trickRoll = this.trickT > 0 ? (1 - this.trickT / 0.45) * Math.PI * 2 : 0;
    const latAcc = this.speed * this.steerVis;
    this.bodyRoll = damp(this.bodyRoll, -clamp(latAcc / 60, -0.12, 0.12) + this.drift * 0.06, 6, dt);
    const pitchTarget = this.grounded ? -Math.atan(this.slopeX) : clamp(-this.vy * 0.02, -0.35, 0.35);
    this.bodyPitch = damp(this.bodyPitch, pitchTarget, this.grounded ? 10 : 4, dt);
    _e.set(this.bodyPitch + tumbleSpin, this.heading + this.visYaw + flatSpin, this.bodyRoll + trickRoll);
    this.root.quaternion.setFromEuler(_e);

    // scale: mega / shrink / squash & stretch
    let sc = 1;
    if (this.megaT > 0) sc = this.megaT > 6.6 ? lerp(1, 1.9, (7 - this.megaT) / 0.4) : this.megaT < 0.5 ? lerp(1, 1.9, this.megaT / 0.5) : 1.9;
    if (this.shrinkT > 0) sc *= this.shrinkT > 4.2 ? lerp(1, 0.55, (4.5 - this.shrinkT) / 0.3) : this.shrinkT < 0.4 ? lerp(1, 0.55, this.shrinkT / 0.4) : 0.55;
    this.visScale = damp(this.visScale || 1, sc, 10, dt);
    const sq = this.squash;
    const hopStretch = this.hopT > 0 ? 0.08 : 0;
    this.model.scale.set(this.visScale * (1 + sq * 0.5), this.visScale * (1 - sq + hopStretch), this.visScale * (1 + sq * 0.3));

    // wheels
    this.wheelRot += (this.speed * dt) / 0.36;
    if (ud.wheels) for (const w of Object.values(ud.wheels)) if (w) w.rotation.x = this.wheelRot;
    const steerA = this.steerVis * 0.45 + (this.drift ? -this.drift * 0.25 : 0);
    if (ud.steerFL) ud.steerFL.rotation.y = steerA;
    if (ud.steerFR) ud.steerFR.rotation.y = steerA;
    if (ud.driver) {
      ud.driver.rotation.z = damp(ud.driver.rotation.z, -this.steerVis * 0.18 - this.drift * 0.1, 8, dt);
      ud.driver.position.y = (ud.driverBaseY ??= ud.driver.position.y) + Math.sin(t * 22) * 0.012 * clamp(Math.abs(this.speed) / 20, 0, 1) * (this.offroad ? 3 : 1);
    }
    if (ud.head) ud.head.rotation.y = damp(ud.head.rotation.y, this.steerVis * 0.35, 6, dt);
    if (ud.setBrake) ud.setBrake(input && input.brake > 0.1 && this.speed > 1);

    // shield bubble
    this.shieldMesh.visible = this.shieldT > 0;
    if (this.shieldMesh.visible) {
      const pulse = 1 + Math.sin(t * 8) * 0.04;
      this.shieldMesh.scale.setScalar(pulse * (this.visScale || 1));
      this.shieldMesh.material.opacity = this.shieldT < 2 ? 0.15 + 0.15 * (Math.sin(t * 20) > 0 ? 1 : 0) : 0.28;
    }
    // invulnerability blink
    this.model.visible = !(this.invulnT > 0 && Math.sin(t * 40) > 0.3);
    if (ud.glowMaterials) {
      const mega = this.megaT > 0;
      for (const m of ud.glowMaterials) m.emissiveIntensity = mega ? 2.5 + Math.sin(t * 15) : m.userData.baseIntensity ?? (m.userData.baseIntensity = m.emissiveIntensity);
    }

    if (!particles) return;
    this.root.updateMatrixWorld(true);
    // drift sparks
    if (this.drift !== 0 && this.grounded && ud.driftSparkPoints) {
      for (const sp of ud.driftSparkPoints) {
        _v.copy(sp).applyMatrix4(this.model.matrixWorld);
        particles.driftSpark(_v, this.driftLevel, this.drift, this.heading);
        if (this.driftLevel === 0 && Math.random() < 0.3) particles.tireSmoke(_v);
      }
    }
    // skid marks from the rear wheels while drifting or hard turning
    const skid = this.grounded && !this.offroad && (this.drift !== 0 || (this.spinT > 0 && Math.abs(this.speed) > 3));
    if (ud.driftSparkPoints) {
      ud.driftSparkPoints.forEach((sp, k) => {
        _v.copy(sp).applyMatrix4(this.model.matrixWorld);
        particles.skids.add(this.id + ':' + k, _v.x, this.pos.y, _v.z, this.heading, skid, 1);
      });
    }
    // boost flames
    const flames = ud.boostFlames || [];
    const boosting = this.boostT > 0;
    for (const f of flames) {
      f.visible = boosting;
      if (boosting) {
        const s = 0.8 + Math.random() * 0.5;
        f.scale.set(s, s, s * (1.2 + Math.random() * 0.8));
      }
    }
    if (ud.exhausts) {
      for (const ex of ud.exhausts) {
        _v.copy(ex).applyMatrix4(this.model.matrixWorld);
        if (boosting) particles.boostFlame(_v, this.heading, this.visScale || 1, this.megaT > 0 ? 0xff40ff : 0xff8a2a);
        else particles.exhaust(_v, this.heading);
      }
    }
    // off-road dust / snow / sand
    if (this.offroad && Math.abs(this.speed) > 6) {
      const col = { sunset: 0xe8d8b0, neon: 0x7755ff, frost: 0xffffff, dunes: 0xe8c890 }[this.track.def.theme];
      particles.dust(this.pos, col, 0.8, this.vx, this.vz);
    }
    if (this.megaT > 0 && Math.random() < 0.5) particles.sparkle(this.pos, 0xff80ff);
    if (this.trickT > 0 && Math.random() < 0.6) particles.sparkle(_v.copy(this.pos).setY(this.pos.y + 1), 0xffffff);
  }

  setHeldItem(name) {
    if (this.heldName === name) return;
    this.heldName = name;
    if (this.heldMesh) { this.root.remove(this.heldMesh); this.heldMesh = null; }
    if (!name) return;
    const m = buildItemMesh(name);
    if (!m) return;
    m.position.set(0, 0.6, -1.9);
    m.scale.setScalar(0.8);
    this.heldMesh = m;
    this.root.add(m);
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
  }
}

export { KART_RADIUS };
