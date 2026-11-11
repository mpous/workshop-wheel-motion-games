// Item boxes, coins, projectiles and hazards. All clients simulate projectiles from the same
// spawn events; the client that owns a kart decides whether that kart was hit and broadcasts it.
import * as THREE from '../libs/three.bundle.js';
import { clamp, wrapAngle, makeRng } from './util.js';
import * as TEX from './textures.js';
import { buildItemMesh } from './kartModel.js';

export const ITEMS = ['turbo', 'triple', 'orb', 'seeker', 'slick', 'shield', 'bomb', 'mega', 'storm'];
export const ITEM_LABEL = {
  turbo: 'Turbo', triple: 'Triple Turbo', orb: 'Plasma Orb', seeker: 'Seeker', slick: 'Oil Slick',
  shield: 'Shield', bomb: 'Bomb', mega: 'Mega', storm: 'Storm',
};

// Weights by normalised race position r (0 = leader, 1 = last).
export function itemWeights(r, n) {
  if (n <= 1) r = 0.5;
  return {
    slick: 28 * (1 - r) + 2,
    orb: 28 * (1 - r * 0.55),
    shield: 14 * (1 - r) + 4,
    bomb: 30 * r * (1 - r) + 1,
    turbo: 8 + 22 * r,
    triple: 32 * r * r,
    seeker: r > 0.15 ? 20 * r : 0,
    mega: 26 * Math.max(0, r - 0.5) / 0.5,
    storm: r > 0.65 ? 10 * (r - 0.65) / 0.35 : 0,
  };
}

export function rollItem(rng, place, total) {
  const r = total > 1 ? (place - 1) / (total - 1) : 0.5;
  const w = itemWeights(r, total);
  let sum = 0;
  for (const k in w) sum += w[k];
  let x = rng() * sum;
  for (const k in w) {
    x -= w[k];
    if (x <= 0) return k;
  }
  return 'turbo';
}

const PROJ_SPEED = { orb: 56, seeker: 62 };
const LIFETIME = { orb: 7, seeker: 14, slick: 60, bomb: 2.4 };

export class ItemSystem {
  constructor(game, scene, track, { quality = 'high', boxes = true } = {}) {
    this.game = game;
    this.scene = scene;
    this.track = track;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.boxes = [];
    this.coins = [];
    this.projectiles = new Map();
    this.pidSeq = 0;
    this.rng = makeRng((Math.random() * 1e9) | 0);
    this.quality = quality;
    if (boxes) this._buildBoxes();
    this._buildCoins();
  }

  // ------------------------------------------------------------ static pickups
  _buildBoxes() {
    const tr = this.track;
    const tex = TEX.itemBoxTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.55, transparent: true, opacity: 0.88,
      roughness: 0.15, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false,
    });
    const geo = new THREE.BoxGeometry(1.7, 1.7, 1.7);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreGeo = new THREE.IcosahedronGeometry(0.55, 1);
    tr.itemRows.forEach((i, row) => {
      const n = 5;
      for (let k = 0; k < n; k++) {
        const lat = ((k - (n - 1) / 2) / (n - 1)) * tr.def.width * 0.72;
        const p = tr.point(i, lat);
        const m = new THREE.Mesh(geo, mat);
        m.add(new THREE.Mesh(coreGeo, coreMat));
        m.position.set(p.x, p.y + 1.35, p.z);
        m.renderOrder = 2;
        this.group.add(m);
        this.boxes.push({ row, k, mesh: m, base: p.clone(), respawn: 0, phase: k * 0.7 + row });
      }
    });
  }

  _buildCoins() {
    const tr = this.track;
    const geo = new THREE.CylinderGeometry(0.55, 0.55, 0.14, 20).rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffc928, metalness: 1, roughness: 0.22, emissive: 0x6a4400, emissiveIntensity: 0.6 });
    this.coinMesh = new THREE.InstancedMesh(geo, mat, Math.max(1, tr.coinRows.length * 6));
    this.coinMesh.castShadow = this.quality !== 'low';
    let n = 0;
    tr.coinRows.forEach((i, row) => {
      const side = row % 2 ? -1 : 1;
      for (let k = 0; k < 6; k++) {
        const idx = i + k * 2.2;
        const lat = side * tr.def.width * (0.3 - k * 0.03) * Math.sin((k / 5) * Math.PI) + side * 1.5;
        const p = tr.point(idx, lat);
        this.coins.push({ row, k, pos: new THREE.Vector3(p.x, p.y + 1.0, p.z), respawn: 0, slot: n++ });
      }
    });
    this.coinMesh.count = n;
    this.group.add(this.coinMesh);
  }

  // ------------------------------------------------------------ per frame
  update(dt, t) {
    // boxes spin / respawn
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        b.mesh.visible = b.respawn <= 0.4;
        const s = b.respawn > 0 ? clamp(1 - b.respawn / 0.4, 0.01, 1) : 1;
        b.mesh.scale.setScalar(s);
      } else {
        b.mesh.visible = true;
        b.mesh.scale.setScalar(1);
      }
      b.mesh.rotation.set(t * 0.9 + b.phase, t * 1.3 + b.phase, 0.3);
      b.mesh.position.y = b.base.y + 1.35 + Math.sin(t * 2.2 + b.phase) * 0.18;
    }
    // coins
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const c of this.coins) {
      if (c.respawn > 0) c.respawn -= dt;
      const vis = c.respawn <= 0;
      q.setFromAxisAngle(up, t * 3 + c.k * 0.4);
      s.setScalar(vis ? 1 : 0.0001);
      const p = c.pos.clone();
      p.y += Math.sin(t * 3 + c.k) * 0.12;
      m.compose(p, q, s);
      this.coinMesh.setMatrixAt(c.slot, m);
    }
    this.coinMesh.instanceMatrix.needsUpdate = true;

    // projectiles
    for (const p of this.projectiles.values()) this._stepProjectile(p, dt, t);
  }

  hazards() {
    const out = [];
    for (const p of this.projectiles.values()) if (p.kind === 'slick' || p.kind === 'bomb') out.push(p);
    return out;
  }

  // local kart picks up boxes / coins / collides with projectiles
  checkKart(kart) {
    if (kart.finished) return;
    const g = this.game;
    for (const b of this.boxes) {
      if (b.respawn > 0) continue;
      const dx = kart.pos.x - b.mesh.position.x, dz = kart.pos.z - b.mesh.position.z, dy = kart.pos.y + 0.8 - b.mesh.position.y;
      const r = 2.1 * (kart.visScale || 1);
      if (dx * dx + dz * dz < r * r && Math.abs(dy) < 2.5) {
        g.emitEvent({ type: 'box', row: b.row, k: b.k, kart: kart.id });
        if (!kart.item && kart.rouletteT <= 0) {
          kart.rouletteT = kart.isBot ? 1.1 : 1.7;
          kart.pendingItem = rollItem(this.rng, kart.place, g.karts.length);
          kart.emit('itemBox');
        } else kart.emit('itemBoxEmpty');
      }
    }
    for (const c of this.coins) {
      if (c.respawn > 0) continue;
      const dx = kart.pos.x - c.pos.x, dz = kart.pos.z - c.pos.z, dy = kart.pos.y + 0.8 - c.pos.y;
      if (dx * dx + dz * dz < 3.4 && Math.abs(dy) < 2.2) {
        g.emitEvent({ type: 'coin', row: c.row, k: c.k, kart: kart.id });
        if (kart.coins < 10) kart.coins++;
        kart.boostT = Math.max(kart.boostT, 0.12);
        kart.emit('coin');
      }
    }
    for (const p of this.projectiles.values()) {
      if (p.dead) continue;
      if (p.owner === kart.id && p.age < (p.kind === 'slick' || p.kind === 'bomb' ? 0.9 : 0.35)) continue;
      const r = (p.kind === 'slick' ? 2.0 : 1.7) * (kart.visScale || 1);
      const dx = kart.pos.x - p.pos.x, dz = kart.pos.z - p.pos.z, dy = kart.pos.y - p.pos.y;
      if (dx * dx + dz * dz < r * r && Math.abs(dy) < 2.5) {
        if (p.kind === 'bomb') {
          g.emitEvent({ type: 'boom', pid: p.pid, x: p.pos.x, y: p.pos.y, z: p.pos.z });
          continue;
        }
        const effect = p.kind === 'seeker' ? 'tumble' : 'spin';
        const took = kart.hit(effect, { from: p.owner });
        g.emitEvent({ type: 'phit', pid: p.pid, victim: kart.id, took, x: p.pos.x, y: p.pos.y, z: p.pos.z, kind: p.kind });
        if (took) g.credit(p.owner, kart.id, p.kind);
      }
    }
  }

  // roulette countdown for local karts
  tickRoulette(kart, dt) {
    if (kart.rouletteT > 0) {
      kart.rouletteT -= dt;
      if (kart.rouletteT <= 0) {
        kart.rouletteT = 0;
        kart.item = kart.pendingItem || 'turbo';
        kart.itemCount = kart.item === 'triple' ? 3 : 1;
        kart.emit('itemGet', { item: kart.item });
      }
    }
  }

  // ------------------------------------------------------------ using items
  useItem(kart, back = false) {
    if (!kart.item || kart.rouletteT > 0 || kart.spinT > 0) return;
    const it = kart.item;
    const g = this.game;
    const consume = () => {
      kart.itemCount--;
      if (kart.itemCount <= 0) { kart.item = null; kart.itemCount = 0; }
    };
    const fx = Math.sin(kart.heading), fz = Math.cos(kart.heading);
    const spawn = (kind, extra = {}) => {
      const pid = `${g.localId || 'L'}:${kart.id}:${++this.pidSeq}`;
      const dir = back ? -1 : 1;
      const off = back ? -2.4 : 2.4;
      const ev = {
        type: 'spawn', pid, kind, owner: kart.id,
        x: +(kart.pos.x + fx * off).toFixed(2), y: +(kart.pos.y + 0.6).toFixed(2), z: +(kart.pos.z + fz * off).toFixed(2),
        h: +(back ? wrapAngle(kart.heading + Math.PI) : kart.heading).toFixed(3),
        sp: kind === 'orb' ? PROJ_SPEED.orb + Math.max(0, kart.speed * dir) * 0.3 : kind === 'seeker' ? PROJ_SPEED.seeker : 0,
        hint: kart.hint, back, ...extra,
      };
      g.emitEvent(ev);
    };
    switch (it) {
      case 'turbo':
      case 'triple':
        kart.giveBoost(1.25, 'item');
        kart.emit('turbo');
        consume();
        break;
      case 'orb':
        spawn('orb');
        kart.emit('throw');
        consume();
        break;
      case 'seeker': {
        const target = g.kartAheadOf(kart);
        spawn('seeker', { target: target ? target.id : null });
        kart.emit('throw');
        consume();
        break;
      }
      case 'slick':
        if (back || true) {
          // drops behind, or lobbed forward when aiming ahead
          spawn('slick', { vf: back ? 0 : 1 });
        }
        kart.emit('drop');
        consume();
        break;
      case 'bomb':
        spawn('bomb', { vf: back ? 0 : 1, vs: Math.max(0, kart.speed) });
        kart.emit(back ? 'drop' : 'throw');
        consume();
        break;
      case 'shield':
        kart.shieldT = 12;
        kart.emit('shield');
        consume();
        break;
      case 'mega':
        kart.megaT = 7;
        kart.shrinkT = 0;
        kart.giveBoost(0.6, 'mega');
        kart.emit('mega');
        consume();
        break;
      case 'storm':
        g.emitEvent({ type: 'storm', owner: kart.id, prog: kart.totalIdx });
        kart.emit('stormCast');
        consume();
        break;
    }
  }

  // ------------------------------------------------------------ events (local & remote)
  applyEvent(ev) {
    const g = this.game;
    switch (ev.type) {
      case 'box': {
        const b = this.boxes.find((x) => x.row === ev.row && x.k === ev.k);
        if (b && b.respawn <= 0) {
          b.respawn = 2.2;
          g.particles.burst(b.mesh.position, 0xffffff, 24, 9, { size: 0.5, life: 0.5 });
          g.particles.burst(b.mesh.position, 0x66e0ff, 14, 7, { size: 0.4, life: 0.4, glow: false });
        }
        break;
      }
      case 'coin': {
        const c = this.coins.find((x) => x.row === ev.row && x.k === ev.k);
        if (c && c.respawn <= 0) {
          c.respawn = 9;
          g.particles.burst(c.pos, 0xffd84d, 10, 5, { size: 0.35, life: 0.35 });
        }
        break;
      }
      case 'spawn': this._spawn(ev); break;
      case 'phit': {
        const p = this.projectiles.get(ev.pid);
        if (p) this._kill(p, ev.took ? 'hit' : 'block');
        else g.particles.burst(new THREE.Vector3(ev.x, ev.y, ev.z), 0xffffff, 20, 8);
        break;
      }
      case 'boom': {
        const p = this.projectiles.get(ev.pid);
        if (p && !p.dead) this._explode(p);
        break;
      }
      case 'storm': this._storm(ev); break;
    }
  }

  _spawn(ev) {
    if (this.projectiles.has(ev.pid)) return;
    const mesh = buildItemMesh(ev.kind) || new THREE.Mesh(new THREE.SphereGeometry(0.6), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
    const p = {
      pid: ev.pid, kind: ev.kind, owner: ev.owner, target: ev.target, mesh,
      pos: new THREE.Vector3(ev.x, ev.y, ev.z), h: ev.h, sp: ev.sp, age: 0, hint: ev.hint ?? -1,
      vy: 0, grounded: true, bounces: 0, dead: false, deathT: 0, q: {},
    };
    if (ev.kind === 'slick') {
      if (ev.vf) { p.vx = Math.sin(ev.h) * 22; p.vz = Math.cos(ev.h) * 22; p.vy = 9; p.grounded = false; }
      else { p.vx = 0; p.vz = 0; }
    }
    if (ev.kind === 'bomb') {
      const f = ev.vf ? 26 + (ev.vs || 0) * 0.6 : 2;
      p.vx = Math.sin(ev.h) * f; p.vz = Math.cos(ev.h) * f; p.vy = ev.vf ? 11 : 3; p.grounded = false;
    }
    if (ev.kind === 'orb' || ev.kind === 'seeker') { p.vx = Math.sin(ev.h) * ev.sp; p.vz = Math.cos(ev.h) * ev.sp; }
    mesh.position.copy(p.pos);
    this.group.add(mesh);
    this.projectiles.set(p.pid, p);
    if (ev.kind === 'seeker') this.game.onSeekerLaunched?.(p);
  }

  _stepProjectile(p, dt, t) {
    const tr = this.track, g = this.game;
    p.age += dt;
    if (p.dead) {
      p.deathT -= dt;
      p.mesh.scale.setScalar(Math.max(0.001, p.deathT * 3));
      if (p.deathT <= 0) this._remove(p);
      return;
    }
    const q = tr.query(p.pos.x, p.pos.y, p.pos.z, p.hint, p.q);
    p.hint = q.idx;
    switch (p.kind) {
      case 'orb': {
        p.pos.x += p.vx * dt; p.pos.z += p.vz * dt;
        const q2 = tr.query(p.pos.x, p.pos.y, p.pos.z, p.hint, p.q);
        p.hint = q2.idx;
        const lim = q2.wall - 0.7;
        if (Math.abs(q2.lat) > lim) {
          const sgn = Math.sign(q2.lat), wlx = q2.tz, wlz = -q2.tx;
          p.pos.x -= wlx * sgn * (Math.abs(q2.lat) - lim);
          p.pos.z -= wlz * sgn * (Math.abs(q2.lat) - lim);
          const vn = p.vx * wlx + p.vz * wlz;
          p.vx -= 2 * vn * wlx; p.vz -= 2 * vn * wlz;
          p.bounces++;
          g.particles.burst(p.pos, 0x55ffd0, 10, 6, { size: 0.35, life: 0.3 });
          g.audio3d?.('bump', p.pos, 0.5);
        }
        p.pos.y = q2.ground + 0.65;
        p.mesh.rotation.y += dt * 8;
        if (Math.random() < 0.7) g.particles.glow.emit(p.pos.x, p.pos.y, p.pos.z, 0, 0.3, 0, 0.3, 1, 0.75, { life: 0.35, size: 0.9, size1: 0.1 });
        if (p.age > LIFETIME.orb || p.bounces > 6) this._kill(p, 'fizzle');
        break;
      }
      case 'seeker': {
        const target = p.target ? g.kartById(p.target) : null;
        let desired;
        const dTarget = target ? target.pos.distanceTo(p.pos) : Infinity;
        if (target && (dTarget < 22 || p.age > 9)) {
          desired = Math.atan2(target.pos.x - p.pos.x, target.pos.z - p.pos.z);
          if (!p.locked) { p.locked = true; g.onSeekerLock?.(p, target); }
        } else {
          const look = tr.point(p.hint + 6, 0);
          desired = Math.atan2(look.x - p.pos.x, look.z - p.pos.z);
        }
        p.h = p.h + clamp(wrapAngle(desired - p.h), -5 * dt, 5 * dt);
        const sp = target && dTarget < 22 ? Math.max(PROJ_SPEED.seeker, target.speed + 12) : PROJ_SPEED.seeker;
        p.pos.x += Math.sin(p.h) * sp * dt;
        p.pos.z += Math.cos(p.h) * sp * dt;
        const q2 = tr.query(p.pos.x, p.pos.y, p.pos.z, p.hint, p.q);
        p.hint = q2.idx;
        p.pos.y = q2.ground + 1.4 + Math.sin(p.age * 6) * 0.15;
        p.mesh.rotation.set(0, p.h, Math.sin(p.age * 10) * 0.2);
        g.particles.glow.emit(p.pos.x - Math.sin(p.h) * 0.8, p.pos.y, p.pos.z - Math.cos(p.h) * 0.8, 0, 0, 0, 1, 0.35, 0.2, { life: 0.4, size: 1.0, size1: 0.1 });
        if (p.age > LIFETIME.seeker || (target && target.finished)) this._kill(p, 'fizzle');
        break;
      }
      case 'slick': {
        if (!p.grounded) {
          p.vy -= 32 * dt;
          p.pos.x += p.vx * dt; p.pos.z += p.vz * dt; p.pos.y += p.vy * dt;
          if (p.pos.y <= q.ground + 0.05) { p.pos.y = q.ground + 0.05; p.grounded = true; this._clampToTrack(p); }
        } else p.pos.y = q.ground + 0.05;
        p.mesh.rotation.y += dt * 0.2;
        if (p.age > LIFETIME.slick) this._kill(p, 'fizzle');
        break;
      }
      case 'bomb': {
        if (!p.grounded) {
          p.vy -= 30 * dt;
          p.pos.x += p.vx * dt; p.pos.z += p.vz * dt; p.pos.y += p.vy * dt;
          this._clampToTrack(p);
          if (p.pos.y <= q.ground + 0.7) { p.pos.y = q.ground + 0.7; p.grounded = true; p.landT = p.age; g.audio3d?.('bump', p.pos, 0.6); }
        } else p.pos.y = q.ground + 0.7;
        const flash = p.age > 1.2 ? (Math.sin(p.age * 30) > 0 ? 1 : 0) : 0;
        p.mesh.scale.setScalar(1 + flash * 0.15);
        if (p.age > LIFETIME.bomb + 0.6) this._explode(p);
        break;
      }
    }
    p.mesh.position.copy(p.pos);
  }

  _clampToTrack(p) {
    const q = this.track.query(p.pos.x, p.pos.y, p.pos.z, p.hint, p.q);
    const lim = q.wall - 0.8;
    if (Math.abs(q.lat) > lim) {
      const sgn = Math.sign(q.lat), wlx = q.tz, wlz = -q.tx;
      p.pos.x -= wlx * sgn * (Math.abs(q.lat) - lim);
      p.pos.z -= wlz * sgn * (Math.abs(q.lat) - lim);
      if (p.vx != null) { const vn = p.vx * wlx + p.vz * wlz; p.vx -= 1.5 * vn * wlx; p.vz -= 1.5 * vn * wlz; }
    }
  }

  _explode(p) {
    const g = this.game;
    if (p.dead) return;
    g.particles.explosion(p.pos);
    g.onExplosion?.(p.pos);
    // every client tests its own karts against the blast
    for (const k of g.localKarts()) {
      const d = k.pos.distanceTo(p.pos);
      if (d < 8.5 * (k.visScale > 1.2 ? 1.2 : 1)) {
        const took = k.hit('tumble', { from: p.owner });
        if (took) g.credit(p.owner, k.id, 'bomb');
      }
    }
    this._kill(p, 'boom');
  }

  _storm(ev) {
    const g = this.game;
    g.onStorm?.(ev);
    for (const k of g.localKarts()) {
      if (k.id === ev.owner || k.finished) continue;
      if (k.totalIdx > ev.prog || g.karts.length <= 2) {
        if (k.hit('shrink', { from: ev.owner })) g.credit(ev.owner, k.id, 'storm');
      }
    }
  }

  _kill(p, how) {
    if (p.dead) return;
    p.dead = true;
    p.deathT = 0.25;
    const col = { orb: 0x55ffd0, seeker: 0xff5a2a, slick: 0x6a4cff, bomb: 0xffa040 }[p.kind] || 0xffffff;
    if (how !== 'boom') this.game.particles.burst(p.pos, col, how === 'fizzle' ? 12 : 26, how === 'fizzle' ? 5 : 10, { size: 0.5, life: 0.5 });
  }

  _remove(p) {
    this.group.remove(p.mesh);
    p.mesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.projectiles.delete(p.pid);
  }

  dispose() {
    for (const p of [...this.projectiles.values()]) this._remove(p);
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}
