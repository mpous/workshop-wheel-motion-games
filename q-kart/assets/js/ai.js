// AI drivers: follow a precomputed racing line, drift through corners, use items sensibly and
// rubber-band gently around the human players so races stay close.
import { clamp, lerp, wrapAngle, makeRng } from './util.js';

// Racing line: an offset from the centre line per sample, pulled to the inside of corners.
export function buildRacingLine(track) {
  const N = track.N;
  const line = new Float32Array(N);
  const hw = track.def.width / 2;
  for (let i = 0; i < N; i++) {
    // look ahead/behind for upcoming curvature (apex slightly ahead)
    let c = 0;
    for (let k = -6; k <= 14; k++) c += track.curv[(i + k + N) % N] * (k < 0 ? 0.5 : 1);
    c /= 17;
    line[i] = clamp(c * 28, -1, 1) * hw * 0.62; // +curv (left turn) -> stay left (+lat)
  }
  // smooth
  const out = new Float32Array(N);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -5; k <= 5; k++) s += line[(i + k + N) % N];
      out[i] = s / 11;
    }
    line.set(out);
  }
  return line;
}

export class AIDriver {
  constructor(kart, track, line, { level = 1, seed = 1 } = {}) {
    this.kart = kart;
    this.track = track;
    this.line = line;
    this.level = level; // cc skill 0.82..1
    this.rng = makeRng(seed);
    this.personal = this.rng.range(-0.25, 0.25); // personal lateral bias
    this.skill = this.rng.range(0.94, 1.02);
    this.mistakeT = 0;
    this.mistakeSteer = 0;
    this.itemDelay = this.rng.range(1, 3);
    this.dodge = 0;
    this.driftHold = false;
    this.input = { throttle: 1, brake: 0, steer: 0, drift: false, driftPressed: false, item: false, itemBack: false };
  }

  // leader/human context for rubber banding: refProgress = progress of best human
  update(dt, world) {
    const k = this.kart, tr = this.track, N = tr.N, inp = this.input;
    inp.driftPressed = false;
    inp.item = false;
    inp.itemBack = false;
    const speed = Math.max(8, k.speed);
    const look = 5 + speed * 0.24;
    const idx = k.hint + look;
    const i0 = Math.floor(idx) % N;
    let lat = this.line[i0] + this.personal * tr.def.width * 0.25 + this.dodge;
    lat = clamp(lat, -tr.def.width / 2 + 1.5, tr.def.width / 2 - 1.5);
    const target = tr.point(idx, lat);
    const dx = target.x - k.pos.x, dz = target.z - k.pos.z;
    const want = Math.atan2(dx, dz);
    let err = wrapAngle(want - k.heading);

    // mistakes: occasional wobble (more on lower difficulty)
    this.mistakeT -= dt;
    if (this.mistakeT <= 0) {
      this.mistakeT = this.rng.range(2, 6);
      this.mistakeSteer = this.rng() < (1.15 - this.level) * 1.5 ? this.rng.range(-0.5, 0.5) : 0;
    }
    if (this.mistakeT < 0.5) this.mistakeSteer *= 0.9;

    // upcoming curvature decides drifting
    let cAhead = 0;
    for (let s = 4; s < 22; s++) cAhead += tr.curv[(k.hint + s) % N];
    cAhead /= 18;
    const sharp = Math.abs(cAhead) > 0.016;
    if (!this.driftHold && sharp && k.speed > 15 && k.grounded && k.drift === 0 && Math.abs(err) < 0.6) {
      this.driftHold = true;
      inp.driftPressed = true;
      this.driftDir = Math.sign(cAhead);
    }
    if (this.driftHold) {
      // release when the corner ends or we are drifting the wrong way
      const ending = Math.abs(cAhead) < 0.008;
      if ((ending && k.driftLevel >= 1) || (k.drift !== 0 && k.drift !== this.driftDir) || (k.drift === 0 && !k.hopT && k.grounded && !inp.driftPressed && this._hopWait > 0.5)) {
        this.driftHold = false;
      }
      this._hopWait = k.drift === 0 ? (this._hopWait || 0) + dt : 0;
    }
    inp.drift = this.driftHold;

    let steer = clamp(err * 2.6, -1, 1) + this.mistakeSteer;
    if (this.driftHold) {
      // during a drift steer toward the drift side to modulate the arc
      const s = clamp(err * 3 * this.driftDir, -1, 1);
      steer = this.driftDir * s;
      if (k.drift === 0) steer = this.driftDir; // hold direction while hopping
    }
    inp.steer = clamp(steer, -1, 1);

    // speed control: lift slightly for very tight corners when not drifting
    inp.throttle = !this.driftHold && Math.abs(err) > 0.9 ? 0.55 : 1;
    inp.brake = 0;
    if (k.speed < 2 && Math.abs(err) > 2.2) { inp.throttle = 0; inp.brake = 1; } // reverse out when stuck backwards

    // rubber banding relative to the best human (gentle)
    const ref = world.refProgress;
    if (ref != null && !k.finished) {
      const gap = (k.totalIdx - ref) / N; // laps ahead of the human
      let rb = 1;
      if (gap > 0.04) rb = lerp(1, 0.9, clamp((gap - 0.04) / 0.25, 0, 1));
      else if (gap < -0.04) rb = lerp(1, 1.1, clamp((-gap - 0.04) / 0.3, 0, 1));
      k.aiScale = rb * this.level * this.skill;
    } else k.aiScale = this.level * this.skill;

    // dodge hazards in front (slicks / bombs)
    this.dodge *= Math.exp(-2 * dt);
    if (world.hazards) {
      for (const h of world.hazards) {
        const hx = h.pos.x - k.pos.x, hz = h.pos.z - k.pos.z;
        const fwd = hx * Math.sin(k.heading) + hz * Math.cos(k.heading);
        if (fwd < 2 || fwd > 22) continue;
        const side = hx * Math.cos(k.heading) - hz * Math.sin(k.heading);
        if (Math.abs(side) < 2.6) this.dodge = clamp(this.dodge + (side > 0 ? -1 : 1) * 6 * dt * 4, -5, 5);
      }
    }

    this._items(dt, world);
    return inp;
  }

  _items(dt, world) {
    const k = this.kart, inp = this.input;
    if (!k.item || k.rouletteT > 0) { this.itemDelay = this.rng.range(0.6, 2.5); return; }
    this.itemDelay -= dt;
    if (this.itemDelay > 0) return;
    const it = k.item;
    const ahead = world.kartAhead(k), behind = world.kartBehind(k);
    let use = false, back = false;
    switch (it) {
      case 'turbo': case 'triple':
        use = k.grounded && !k.offroad ? Math.abs(k.steerVis) < 0.4 : k.offroad; break;
      case 'orb':
        if (ahead && ahead.dist < 45 && ahead.angle < 0.25) use = true;
        else if (behind && behind.dist < 14) { use = true; back = true; }
        else use = this.itemDelay < -6;
        break;
      case 'seeker': use = k.place > 1 || this.itemDelay < -4; break;
      case 'slick': case 'bomb':
        if (behind && behind.dist < 25) { use = true; back = it === 'slick' || behind.dist < 10; }
        else use = this.itemDelay < -5;
        if (it === 'bomb' && ahead && ahead.dist < 30) { use = true; back = false; }
        break;
      case 'shield': use = this.itemDelay < -8 || world.threatTo(k); break;
      case 'mega': case 'storm': use = true; break;
      default: use = true;
    }
    if (use) {
      inp.item = true;
      inp.itemBack = back;
      this.itemDelay = this.rng.range(0.4, 1.5);
    }
  }
}
