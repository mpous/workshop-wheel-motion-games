// Chase camera with speed-dependent FOV, drift swing, look-back, shake and cinematic modes.
import * as THREE from '../libs/three.bundle.js';
import { clamp, damp, dampAngle, lerp } from './util.js';

export class ChaseCamera {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.yaw = 0;
    this.shakeT = 0;
    this.shakeAmp = 0;
    this.fovKick = 0;
    this.mode = 'chase'; // chase | far | orbit | flyby | intro
    this.distMode = 0; // toggled with C
    this.first = true;
    this.t = 0;
  }

  shake(amp = 0.3, dur = 0.3) {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeT = Math.max(this.shakeT, dur);
  }

  snap() { this.first = true; }

  update(dt, kart, { lookBack = false, track } = {}) {
    this.t += dt;
    const cam = this.cam;
    if (this.mode === 'orbit') return this._orbit(dt, kart);
    if (this.mode === 'intro') return this._intro(dt, kart, track);

    const far = this.distMode === 1;
    const speed = Math.max(0, kart.speed);
    const sc = kart.visScale || 1;
    const dist = (far ? 8.2 : 6.4) * (0.85 + 0.15 * sc) + speed * 0.03;
    const height = (far ? 3.6 : 2.7) * (0.8 + 0.2 * sc);
    // follow the travel heading, swinging a little into drifts
    const target = kart.heading + (kart.visYaw || 0) * 0.5 + (lookBack ? Math.PI : 0);
    this.yaw = this.first ? target : dampAngle(this.yaw, target, lookBack ? 30 : kart.grounded ? 6.5 : 3.5, dt);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const want = new THREE.Vector3(kart.pos.x - fx * dist, kart.pos.y + height, kart.pos.z - fz * dist);
    // never dip below the ground near the camera
    if (track) {
      const q = track.query(want.x, want.y, want.z, kart.hint, this._q || (this._q = {}));
      const gy = Math.max(q.ground, q.centerY) + 1.2;
      if (want.y < gy) want.y = gy;
    }
    if (this.first) { this.pos.copy(want); this.first = false; }
    else {
      const k = 1 - Math.exp(-(kart.grounded ? 10 : 6) * dt);
      this.pos.x = lerp(this.pos.x, want.x, k);
      this.pos.z = lerp(this.pos.z, want.z, k);
      this.pos.y = lerp(this.pos.y, want.y, 1 - Math.exp(-5 * dt));
    }
    const lookAhead = 4 + speed * 0.05;
    this.look.set(kart.pos.x + fx * lookAhead, kart.pos.y + 1.1 * sc, kart.pos.z + fz * lookAhead);

    // shake
    let sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const a = this.shakeAmp * clamp(this.shakeT / 0.3, 0, 1);
      sx = (Math.random() - 0.5) * a;
      sy = (Math.random() - 0.5) * a;
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }
    // subtle rumble at high speed / off-road
    const rumble = (kart.offroad ? 0.05 : 0) + (kart.boosting ? 0.03 : 0);
    sx += (Math.random() - 0.5) * rumble;
    sy += (Math.random() - 0.5) * rumble;

    cam.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z);
    cam.lookAt(this.look);
    // roll slightly with steering / drift
    cam.rotateZ(-(kart.visYaw || 0) * 0.06);
    const baseFov = 68;
    const fovT = baseFov + clamp(speed / 33, 0, 1.3) * 8 + (kart.boosting ? 9 : 0);
    cam.fov = damp(cam.fov, fovT, 4, dt);
    cam.updateProjectionMatrix();
  }

  _orbit(dt, kart) {
    // slow orbit for results / podium
    const a = this.t * 0.25;
    const r = 9;
    this.cam.position.set(kart.pos.x + Math.sin(a) * r, kart.pos.y + 3.2, kart.pos.z + Math.cos(a) * r);
    this.cam.lookAt(kart.pos.x, kart.pos.y + 0.9, kart.pos.z);
    this.cam.fov = damp(this.cam.fov, 55, 3, dt);
    this.cam.updateProjectionMatrix();
  }

  // pre-race sweep: start high and wide, settle behind the player during the countdown
  _intro(dt, kart, track) {
    const k = clamp(this.introT / this.introDur, 0, 1);
    this.introT += dt;
    const e = 1 - Math.pow(1 - k, 3);
    const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
    const startP = new THREE.Vector3(kart.pos.x + fx * 26 + fz * 14, kart.pos.y + 14, kart.pos.z + fz * 26 - fx * 14);
    const endP = new THREE.Vector3(kart.pos.x - fx * 6.4, kart.pos.y + 2.7, kart.pos.z - fz * 6.4);
    this.cam.position.lerpVectors(startP, endP, e);
    const look = new THREE.Vector3(kart.pos.x + fx * 4 * e, kart.pos.y + 1, kart.pos.z + fz * 4 * e);
    this.cam.lookAt(look);
    this.cam.fov = 60 + 8 * e;
    this.cam.updateProjectionMatrix();
    if (k >= 1) {
      this.mode = 'chase';
      this.pos.copy(endP);
      this.yaw = kart.heading;
      this.first = false;
    }
  }

  startIntro(dur = 3) {
    this.mode = 'intro';
    this.introT = 0;
    this.introDur = dur;
  }
}

// Free-flying camera used for the attract-mode backdrop behind the menus.
export class FlybyCamera {
  constructor(camera, track) {
    this.cam = camera;
    this.track = track;
    this.t = 0;
    this.shot = 0;
    this.shotT = 0;
    this.shotDur = 7;
    this._newShot();
  }

  _newShot() {
    const tr = this.track;
    this.shot++;
    this.startIdx = Math.random() * tr.N;
    this.kind = this.shot % 3;
    this.shotT = 0;
  }

  update(dt, focusKart) {
    const tr = this.track, cam = this.cam;
    this.shotT += dt;
    if (this.shotT > this.shotDur) this._newShot();
    const k = this.shotT / this.shotDur;
    if (focusKart && this.kind !== 2) {
      // tracking shots of the lead AI kart
      const p = focusKart.pos, h = focusKart.heading;
      const side = this.kind === 0 ? 1 : -1;
      const a = h + side * (1.2 - k * 0.9);
      const r = 7 + k * 3;
      cam.position.set(p.x + Math.sin(a) * r, p.y + 2 + k * 1.5, p.z + Math.cos(a) * r);
      cam.lookAt(p.x, p.y + 0.8, p.z);
      cam.fov = 50;
    } else {
      const i = this.startIdx + this.shotT * 6;
      const p = tr.point(i, 0);
      const ahead = tr.point(i + 12, 0);
      const lat = tr.def.width * 0.9;
      cam.position.set(p.x + tr.lx[Math.floor(i) % tr.N] * lat, p.y + 9 + Math.sin(this.shotT * 0.4) * 2, p.z + tr.lz[Math.floor(i) % tr.N] * lat);
      cam.lookAt(ahead.x, ahead.y + 1, ahead.z);
      cam.fov = 58;
    }
    cam.updateProjectionMatrix();
  }
}
