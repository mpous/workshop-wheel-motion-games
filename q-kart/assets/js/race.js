// A race session: owns the track, scenery, karts, AI, items, HUD and per-race audio.
// Modes: 'attract' (menu backdrop), 'race' (quick race / GP), 'tt' (time trial), 'mp' (LAN).
import * as THREE from '../libs/three.bundle.js';
import { clamp, lerp, makeRng, formatTime } from './util.js';
import { TRACK_BY_ID, CC } from './tracks.js';
import { Track } from './track.js';
import { Scenery } from './scenery.js';
import { Particles } from './particles.js';
import { Kart, KART_RADIUS } from './kart.js';
import { AIDriver, buildRacingLine } from './ai.js';
import { ItemSystem, ITEM_LABEL } from './items.js';
import { HUD } from './hud.js';
import { ChaseCamera, FlybyCamera } from './camera.js';
import { CHARACTERS, buildKart } from './kartModel.js';

const NAMES = ['Turbo Tofu', 'Nitro Noodle', 'Captain Drift', 'Pixel Pete', 'Volt Viper', 'Sprocket', 'Zippy Zara', 'Gizmo Gus', 'Rocket Rosa', 'Comet Cleo'];
const BOT_COUNT = 7;
const SNAPSHOT_DELAY = 110; // ms of interpolation delay for remote karts

export class Race {
  constructor(app, opts) {
    this.app = app;
    this.opts = opts;
    this.mode = opts.mode; // attract | race | tt | mp
    this.laps = opts.laps || 3;
    this.cc = CC[opts.cc || 100];
    const q = (this.quality = app.moduleQuality);
    this.scene = app.scene;
    const def = TRACK_BY_ID[opts.track] || TRACK_BY_ID.sunset;
    this.def = def;
    this.track = new Track(def, { quality: q });
    this.scene.add(this.track.group);
    this.scenery = new Scenery(this.scene, app.renderer, this.track, { quality: q });
    this.particles = new Particles(this.scene, { quality: q });
    this.particles.setViewport(app.renderer.domElement.height);
    this.items = new ItemSystem(this, this.scene, this.track, { quality: q, boxes: this.mode !== 'tt' });
    this.line = buildRacingLine(this.track);
    this.karts = [];
    this.ai = new Map();
    this.time = 0; // wall time inside the race
    this.raceTime = -4; // seconds relative to GO
    this.started = false;
    this.done = false;
    this.localId = app.net.id || 'local';
    this.eventLog = [];
    this.rng = makeRng(opts.seed || 1234);
    this.sendAcc = 0;
    this.soloAcc = 0;
    this.lastCount = null;
    this.camMode = 0;
    this._buildGrid();
    this.camera = new ChaseCamera(app.camera);
    if (this.mode === 'attract') {
      this.flyby = new FlybyCamera(app.camera, this.track);
      this.raceTime = 0;
      this.started = true;
    } else {
      this.camera.startIntro(this.mode === 'mp' ? 2.6 : 2.4);
      this.hud = new HUD(app.hudRoot, { track: this.track, karts: this.karts, player: this.player, laps: this.laps, mode: this.mode, portraits: app.portraits });
      this.hud.onRouletteTick = () => app.audio.play('roulette', { vol: 0.5 });
      this._setupAudio();
      if (this.mode === 'tt') this._setupGhost();
    }
    this.countdownStart = performance.now();
  }

  // ------------------------------------------------------------------ setup
  _buildGrid() {
    const o = this.opts, tr = this.track, q = this.quality;
    let grid;
    if (this.mode === 'mp') {
      grid = o.grid.map((g) => ({ ...g, local: g.owner === this.app.net.id, isPlayer: g.id === this.app.net.id }));
    } else if (this.mode === 'tt') {
      grid = [{ id: 'player', name: o.playerName, character: o.character, isBot: false, local: true, isPlayer: true }];
    } else {
      grid = [];
      const used = new Set(this.mode === 'attract' ? [] : [o.character]);
      const rng = makeRng(o.seed || 99);
      const names = [...NAMES].sort(() => rng() - 0.5);
      const chars = [];
      for (let c = 0; c < CHARACTERS.length; c++) if (!used.has(c)) chars.push(c);
      const n = this.mode === 'attract' ? 8 : BOT_COUNT;
      for (let i = 0; i < n; i++) grid.push({ id: 'bot' + i, name: names[i % names.length], character: chars[i % chars.length], isBot: true, local: true });
      if (this.mode !== 'attract') {
        // the player starts at the back half in GP race 1, else mid-pack based on GP standing
        const slot = o.gridSlot != null ? o.gridSlot : 4;
        grid.splice(Math.min(slot, grid.length), 0, { id: 'player', name: o.playerName, character: o.character, isBot: false, local: true, isPlayer: true });
      }
      if (o.gridOrder) {
        // GP: order the grid by reverse standings (leader starts last)
        grid.sort((a, b) => o.gridOrder.indexOf(a.id) - o.gridOrder.indexOf(b.id));
      }
    }
    grid.forEach((g, slot) => {
      const k = new Kart({ id: g.id, name: g.name, charIndex: g.character, isBot: g.isBot, local: g.local, track: tr, cc: this.cc, quality: q, isPlayer: g.isPlayer });
      k.laps = this.laps;
      k.reset(slot);
      k.slot = slot;
      this.scene.add(k.root);
      this.karts.push(k);
      if (g.isPlayer) this.player = k;
      if (g.local && (g.isBot || this.mode === 'attract')) this._addAI(k, slot);
    });
    if (!this.player) this.player = this.karts[0];
    // the player kart gets an AI to drive it after the finish line
    if (this.mode !== 'attract') this.autoDriver = new AIDriver(this.player, tr, this.line, { level: 0.9, seed: 7 });
  }

  _addAI(k, slot) {
    const lvl = this.mode === 'attract' ? 0.95 : this.cc.ai;
    this.ai.set(k.id, new AIDriver(k, this.track, this.line, { level: lvl, seed: (this.opts.seed || 1) * 31 + slot * 7 + 1 }));
  }

  _setupAudio() {
    const a = this.app.audio;
    this.engines = new Map();
    for (const k of this.karts) {
      // only the closest few karts get engine voices; the audio engine caps voices itself
      this.engines.set(k.id, a.createEngine({ character: k.char.id }));
    }
    a.playMusic(this.track.theme.music, { intensity: 0.35 });
  }

  _setupGhost() {
    const key = 'qkart.ghost.' + this.def.id;
    this.ghostRec = [];
    this.ghostAcc = 0;
    try {
      const g = JSON.parse(localStorage.getItem(key) || 'null');
      if (g && g.frames && g.frames.length) {
        this.ghostData = g;
        const m = buildKart(CHARACTERS[g.character % CHARACTERS.length].id, { quality: 'low' });
        m.traverse((o) => {
          if (o.material) {
            o.material = o.material.clone();
            o.material.transparent = true;
            o.material.opacity = 0.35;
            o.material.depthWrite = false;
            o.castShadow = false;
          }
        });
        this.ghostMesh = m;
        this.scene.add(m);
      }
    } catch { /* corrupt ghost */ }
  }

  // ------------------------------------------------------------------ helpers used by items / AI
  kartById(id) { return this.karts.find((k) => k.id === id); }
  localKarts() { return this.karts.filter((k) => k.local); }

  kartAheadOf(k) {
    let best = null;
    for (const o of this.karts) if (o !== k && o.place === k.place - 1) best = o;
    if (!best && k.place === 1) {
      // leader fires a seeker at nobody — target the second instead so it isn't wasted
      best = this.karts.find((o) => o.place === 2) || null;
    }
    return best;
  }

  _rel(k, other) {
    const dx = other.pos.x - k.pos.x, dz = other.pos.z - k.pos.z;
    const dist = Math.hypot(dx, dz);
    const fwd = (dx * Math.sin(k.heading) + dz * Math.cos(k.heading)) / (dist || 1);
    return { dist, fwd, angle: Math.acos(clamp(fwd, -1, 1)) };
  }

  _worldFor(k) {
    const self = this;
    return {
      refProgress: this.refProgress,
      hazards: this.items.hazards(),
      kartAhead: () => {
        let best = null;
        for (const o of self.karts) {
          if (o === k) continue;
          const r = self._rel(k, o);
          if (r.fwd > 0.85 && (!best || r.dist < best.dist)) best = { ...r, kart: o };
        }
        return best;
      },
      kartBehind: () => {
        let best = null;
        for (const o of self.karts) {
          if (o === k) continue;
          const r = self._rel(k, o);
          if (r.fwd < -0.7 && (!best || r.dist < best.dist)) best = { ...r, kart: o };
        }
        return best;
      },
      threatTo: (kk) => {
        for (const p of self.items.projectiles.values()) if (p.kind === 'seeker' && p.target === kk.id) return true;
        return false;
      },
    };
  }

  // credit for hits (feed + stats)
  credit(fromId, victimId, kind) {
    if (!this.hud) return;
    const a = this.kartById(fromId), b = this.kartById(victimId);
    if (!a || !b) return;
    if (a === this.player || b === this.player) {
      const icon = { orb: '🟢', seeker: '🎯', slick: '🛢', bomb: '💣', storm: '⚡', mega: '⭐' }[kind] || '💥';
      this.hud.feed(`<b style="color:#${a.char.color.toString(16).padStart(6, '0')}">${a.name}</b> ${icon} <b style="color:#${b.char.color.toString(16).padStart(6, '0')}">${b.name}</b>`);
    }
  }

  // events are applied locally and relayed to the others in multiplayer
  emitEvent(ev) {
    this.items.applyEvent(ev);
    if (this.mode === 'mp') this.app.net.send('event', ev);
  }

  onRemoteEvent(ev) {
    if (ev.from === this.app.net.id) return;
    this.items.applyEvent(ev);
  }

  onExplosion(pos) {
    if (!this.hud) return;
    const d = pos.distanceTo(this.player.pos);
    this.app.audio.play('explosion', { vol: clamp(1.2 - d / 70, 0.1, 1), pan: this._pan(pos) });
    if (d < 30) this.camera.shake(0.9 * (1 - d / 30), 0.5);
  }

  onStorm(ev) {
    if (!this.hud) return;
    this.app.audio.play('storm');
    this.hud.flash('#cfe6ff', 0.85);
    this.camera.shake(0.5, 0.4);
    for (const k of this.karts) {
      if (k.id === ev.owner) continue;
      const p = k.pos.clone(); p.y += 2;
      this.particles.burst(p, 0xbfe4ff, 30, 12, { size: 0.6, life: 0.5, grav: -2 });
    }
  }

  onSeekerLock(p, target) {
    if (target === this.player) {
      this.app.audio.play('seekerLock');
      this.hud?.message('INCOMING!', 'warn', 1);
    }
  }

  audio3d(name, pos, vol = 1) {
    if (!this.hud) return;
    const d = pos.distanceTo(this.player.pos);
    if (d > 70) return;
    this.app.audio.play(name, { vol: vol * (1 - d / 70), pan: this._pan(pos) });
  }

  _pan(pos) {
    const cam = this.app.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const d = pos.clone().sub(cam.position);
    const l = d.length() || 1;
    return clamp(d.dot(right) / l, -1, 1);
  }

  // ------------------------------------------------------------------ network
  onSnapshot(snap) {
    for (const s of snap.karts || []) {
      const k = this.kartById(s.id);
      if (!k || k.local) continue;
      k.pushRemote(s, snap.t);
    }
  }

  onPlayerLeft(msg) {
    const k = this.kartById(msg.id);
    if (k) {
      this.scene.remove(k.root);
      this.karts = this.karts.filter((x) => x !== k);
      this.engines?.get(k.id)?.stop();
      this.hud?.setKarts(this.karts);
      this.hud?.feed(`<b>${k.name}</b> left the race`);
    }
    if (msg.botsOwner === this.app.net.id) {
      for (const b of this.karts) {
        if (b.isBot && !b.local) {
          b.local = true;
          b.prevPos = null;
          b.hint = -1;
          this._addAI(b, b.slot || 0);
        }
      }
    }
  }

  // ------------------------------------------------------------------ main update
  update(dt) {
    const app = this.app;
    this.time += dt;
    const input = this.mode === 'attract' ? null : app.input.state;

    // race clock
    if (this.mode === 'mp') {
      this.raceTime = (app.net.now() - this.opts.startAt) / 1000;
    } else if (this.mode !== 'attract' && !this.paused) {
      this.raceTime += dt;
    }
    const racing = this.raceTime >= 0;
    if (racing && !this.started) {
      this.started = true;
      for (const k of this.karts) if (k.local) {
        const r = k.isPlayer ? k.rocketStart() : (this.rng() < 0.45 ? (k.giveBoost(1.0, 'rocket'), 'good') : null);
        if (k.isPlayer && r === 'good') this.hud?.message('ROCKET START!', 'good', 1.2);
      }
      if (this.mode === 'tt') this.player.item = 'triple', this.player.itemCount = 3;
    }
    this._countdown();

    // reference progress for rubber banding: best human (or player)
    const humans = this.karts.filter((k) => !k.isBot);
    this.refProgress = humans.length ? Math.max(...humans.map((k) => k.totalIdx)) : null;
    if (this.mode === 'attract') this.refProgress = null;

    // simulate local karts
    for (const k of this.karts) {
      if (!k.local) continue;
      let inp;
      if (this.ai.has(k.id)) inp = this.ai.get(k.id).update(dt, this._worldFor(k));
      else if (k.finished && this.autoDriver) inp = this.autoDriver.update(dt, this._worldFor(k));
      else inp = input;
      k.lastInput = inp;
      k.simulate(dt, inp, racing, this.raceTime);
      if (racing) {
        this.items.tickRoulette(k, dt);
        if (inp.item && !k.finished) this.items.useItem(k, inp.itemBack);
        this.items.checkKart(k);
        this._laps(k);
      }
    }
    // remote karts
    if (this.mode === 'mp') {
      const rt = app.net.now() - SNAPSHOT_DELAY;
      for (const k of this.karts) if (!k.local) k.interpolate(rt, dt);
    }
    this._collisions(dt);
    this._standings();
    this.items.update(dt, this.time);

    // visuals
    for (const k of this.karts) k.updateVisual(dt, this.time, k.lastInput, this.particles);
    this.particles.update(dt);
    this.track.update(this.time, dt);
    this.scenery.update(this.time, dt);
    this._ghost(dt);

    // camera
    if (this.mode === 'attract') {
      const lead = this.karts.reduce((a, b) => (b.totalIdx > a.totalIdx ? b : a));
      this.flyby.update(dt, lead);
    } else {
      if (input.camera) this.camera.distMode = 1 - this.camera.distMode;
      this.camera.update(dt, this.player, { lookBack: input.lookBack && racing, track: this.track });
    }
    this.scenery.follow(this.mode === 'attract' ? app.camera.position.clone().setY(0) : this.player.pos);

    // feedback for the player
    if (this.hud) {
      this._feedback();
      this.hud.update(dt, { raceTime: this.raceTime, standings: this.standings, lookBack: input.lookBack });
      this._audio(dt);
    } else {
      for (const k of this.karts) k.events.length = 0;
    }

    // network
    if (this.mode === 'mp') {
      this.sendAcc += dt;
      if (this.sendAcc >= 0.05) {
        this.sendAcc = 0;
        app.net.send('state', { karts: this.localKarts().map((k) => k.serialize()) });
      }
    } else if (this.mode !== 'attract') {
      this._soloStatus(dt);
    }

    this._checkEnd(dt);
  }

  _countdown() {
    if (this.mode === 'attract') return;
    const t = this.raceTime;
    let n = null;
    if (t < 0 && t >= -3) n = Math.ceil(-t); // 3,2,1
    else if (t >= 0 && t < 0.2) n = 0;
    if (n !== null && n !== this.lastCount) {
      this.lastCount = n;
      this.hud.countdown(n);
      this.track.setStartLights(n === 0 ? 4 : 4 - n);
      this.app.audio.play(n === 0 ? 'go' : 'countdown');
      if (n === 0) this.app.audio.setMusicIntensity(0.7);
    }
    if (t > 2.5 && this.lastCount === 0) { this.track.setStartLights(-1); this.lastCount = -1; }
  }

  _laps(k) {
    const N = this.track.N;
    const done = Math.floor(k.maxTotal / N);
    if (done > k.lap && !k.finished && this.raceTime > 0) {
      const now = this.raceTime * 1000;
      const lapTime = now - k.lapStart;
      if (done >= 1) k.lapTimes.push(lapTime);
      k.lapStart = now;
      k.lap = done;
      if (k.lap >= this.laps) {
        k.finished = true;
        k.finishTime = now;
        k.finishOrder = (this.finishCount = (this.finishCount || 0) + 1);
        k.emit('finish');
        if (this.mode === 'mp') {
          this.app.net.request('finish', { id: k.id, time: Math.round(now), bestLap: Math.round(Math.min(...k.lapTimes)) });
        }
      } else if (k.lap >= 1) {
        k.emit(k.lap === this.laps - 1 ? 'finalLap' : 'lap', { lapTime });
      }
    }
  }

  _collisions(dt) {
    const ks = this.karts;
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        const a = ks[i], b = ks[j];
        if (!a.local && !b.local) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, dy = b.pos.y - a.pos.y;
        if (Math.abs(dy) > 2) continue;
        const ra = KART_RADIUS * (a.visScale || 1), rb = KART_RADIUS * (b.visScale || 1);
        const d2 = dx * dx + dz * dz, rr = ra + rb;
        if (d2 >= rr * rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = rr - d;
        // mega karts flatten others
        if (a.megaT > 0 && b.megaT <= 0 && b.local) { if (b.hit('tumble', { from: a.id })) this.credit(a.id, b.id, 'mega'); }
        if (b.megaT > 0 && a.megaT <= 0 && a.local) { if (a.hit('tumble', { from: b.id })) this.credit(b.id, a.id, 'mega'); }
        const wa = a.weight * (a.visScale || 1) ** 2, wb = b.weight * (b.visScale || 1) ** 2;
        const fa = wb / (wa + wb), fb = wa / (wa + wb);
        if (a.local) { a.pos.x -= nx * pen * fa; a.pos.z -= nz * pen * fa; }
        if (b.local) { b.pos.x += nx * pen * fb; b.pos.z += nz * pen * fb; }
        // exchange normal velocity
        const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (rv < 0) {
          const imp = -rv * 1.25;
          if (a.local) { a.vx -= nx * imp * fa; a.vz -= nz * imp * fa; }
          if (b.local) { b.vx += nx * imp * fb; b.vz += nz * imp * fb; }
          if (imp > 4) {
            if (a.local) a.emit('bump', { strength: clamp(imp / 20, 0.2, 1) });
            else if (b.local) b.emit('bump', { strength: clamp(imp / 20, 0.2, 1) });
            const mid = a.pos.clone().lerp(b.pos, 0.5); mid.y += 0.6;
            this.particles.burst(mid, 0xffe9a8, 10, 6, { size: 0.35, life: 0.3 });
          }
        }
      }
    }
  }

  _standings() {
    const list = [...this.karts].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.totalIdx - a.totalIdx;
    });
    list.forEach((k, i) => (k.place = i + 1));
    this.standings = list;
  }

  _feedback() {
    const p = this.player, a = this.app.audio, hud = this.hud, inp = this.app.input;
    for (const k of this.karts) {
      const mine = k === p;
      const dist = mine ? 0 : k.pos.distanceTo(p.pos);
      const vol = mine ? 1 : clamp(1 - dist / 55, 0, 1) * 0.7;
      const pan = mine ? 0 : this._pan(k.pos);
      for (const ev of k.events) {
        if (vol <= 0.02) continue;
        switch (ev.type) {
          case 'hop': a.play('jump', { vol: vol * 0.6, pan }); break;
          case 'driftLevel': a.play('driftSpark', { level: ev.level, vol, pan }); break;
          case 'miniTurbo': a.play('miniTurbo' + ev.level, { vol, pan }); if (mine) { this.camera.shake(0.15, 0.2); hud.pulse('boostPulse'); } break;
          case 'boost':
            if (ev.kind === 'pad') a.play('boost', { vol, pan });
            if (mine && ev.kind === 'trick') hud.message('NICE!', 'good small', 0.8);
            break;
          case 'turbo': a.play('boost', { vol, pan }); if (mine) hud.pulse('boostPulse'); break;
          case 'wall': a.play('wall', { vol: vol * ev.strength, pan }); if (mine) { this.camera.shake(0.35 * ev.strength, 0.25); inp.rumble(0.5 * ev.strength, 100); } break;
          case 'bump': a.play('bump', { vol: vol * ev.strength, pan }); if (mine) { this.camera.shake(0.25, 0.2); inp.rumble(0.4, 80); } break;
          case 'land': a.play('land', { vol: vol * ev.strength, pan }); if (mine) this.camera.shake(0.2 * ev.strength, 0.2); break;
          case 'launch': if (mine && k.trickArmed) hud.message('TRICK!', 'hint small', 0.6); break;
          case 'trick': a.play('trick', { vol, pan }); break;
          case 'itemBox': a.play('itemBox', { vol, pan }); break;
          case 'itemBoxEmpty': a.play('itemBox', { vol: vol * 0.4, pan }); break;
          case 'itemGet': if (mine) { a.play('itemGet'); } break;
          case 'throw': a.play('throw', { vol, pan }); break;
          case 'drop': a.play('drop', { vol, pan }); break;
          case 'shield': a.play('shield', { vol, pan }); break;
          case 'shieldBreak': a.play('shieldBreak', { vol, pan }); break;
          case 'mega': a.play('mega', { vol, pan }); if (mine) { hud.message('MEGA!', 'mega', 1.2); a.setMusicTempoScale(1.12); } break;
          case 'stormCast': break;
          case 'shrunk': if (mine) hud.message('ZAPPED!', 'warn', 1); break;
          case 'coin': a.play('coin', { vol: vol * 0.8, pan }); break;
          case 'coinsLost': break;
          case 'hit':
            a.play(ev.effect === 'tumble' ? 'hit' : 'spinout', { vol, pan });
            if (mine) { this.camera.shake(ev.effect === 'tumble' ? 0.8 : 0.4, 0.4); inp.rumble(0.9, 300); hud.flash('#ff3050', 0.25); }
            break;
          case 'rocket': a.play('rocketStart', { vol, pan }); break;
          case 'stall': if (mine) hud.message('STALLED!', 'warn', 1); break;
          case 'lap':
            if (mine) { a.play('lap'); hud.message(`LAP ${k.lap + 1}`, 'lap', 1.4); }
            break;
          case 'finalLap':
            if (mine) { a.play('finalLap'); hud.message('FINAL LAP!', 'final', 2); a.setMusicTempoScale(1.08); a.setMusicIntensity(1); }
            break;
          case 'finish':
            if (mine) this._playerFinished();
            break;
          case 'respawn': break;
        }
      }
      k.events.length = 0;
    }
    if (p.megaT <= 0 && this._wasMega) a.setMusicTempoScale(p.lap === this.laps - 1 ? 1.08 : 1);
    this._wasMega = p.megaT > 0;
    // wrong way chirp
    if (p.wrongWayT > 1.2 && !this._ww) { a.play('wrongWay'); this._ww = true; }
    if (p.wrongWayT <= 0.2) this._ww = false;
  }

  _playerFinished() {
    const p = this.player, a = this.app.audio;
    const good = p.place <= 3 || this.mode === 'tt';
    a.play('finish', { good });
    a.setMusicIntensity(0.4);
    a.setMusicTempoScale(1);
    this.hud.message(this.mode === 'tt' ? formatTime(p.finishTime) : 'FINISH!', 'finish', 3);
    this.particles.confetti(p.pos, 120);
    this.camera.mode = 'orbit';
    this.camera.t = 0;
    this.playerFinishedAt = this.time;
    this.app.onPlayerFinished?.(this);
  }

  _audio(dt) {
    const p = this.player;
    for (const k of this.karts) {
      const e = this.engines.get(k.id);
      if (!e) continue;
      const mine = k === p;
      const dist = mine ? 0 : k.pos.distanceTo(this.app.camera.position);
      const gain = mine ? 1 : clamp(1 - dist / 45, 0, 1) * 0.45;
      e.update({
        speed01: clamp(Math.abs(k.speed) / (k.baseMax * 1.3), 0, 1),
        throttle: k.lastInput ? k.lastInput.throttle : k.speed > 1 ? 1 : 0,
        boosting: k.boosting, drifting: k.drift !== 0 && k.grounded, airborne: !k.grounded,
        offroad: k.offroad, gain, pan: mine ? 0 : this._pan(k.pos),
      });
    }
  }

  _soloStatus(dt) {
    this.soloAcc += dt;
    if (this.soloAcc < 0.25) return;
    this.soloAcc = 0;
    const p = this.player;
    const state = p.finished ? 'finished' : this.raceTime < 0 ? 'countdown' : 'race';
    this.app.net.send('solo_status', {
      state, count: Math.max(0, Math.ceil(-this.raceTime)), lap: Math.min(this.laps, p.lap + 1), laps: this.laps,
      pos: p.place, total: this.karts.length,
    });
  }

  _ghost(dt) {
    if (this.mode !== 'tt' || this.raceTime < 0) return;
    const p = this.player;
    if (!p.finished) {
      this.ghostAcc += dt;
      if (this.ghostAcc >= 0.1) {
        this.ghostAcc = 0;
        this.ghostRec.push([+p.pos.x.toFixed(2), +p.pos.y.toFixed(2), +p.pos.z.toFixed(2), +(p.heading + (p.visYaw || 0)).toFixed(3)]);
      }
    }
    if (this.ghostMesh && this.ghostData) {
      const f = this.ghostData.frames;
      const t = this.raceTime / 0.1;
      const i = Math.floor(t);
      if (i >= f.length - 1) { this.ghostMesh.visible = false; return; }
      const a = f[i], b = f[i + 1], k = t - i;
      this.ghostMesh.position.set(lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k));
      let dh = b[3] - a[3];
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      this.ghostMesh.rotation.y = a[3] + dh * k;
    }
  }

  saveGhostIfBest() {
    if (this.mode !== 'tt' || !this.player.finished) return false;
    const key = 'qkart.ghost.' + this.def.id;
    const prev = this.ghostData;
    if (!prev || this.player.finishTime < prev.time) {
      try {
        localStorage.setItem(key, JSON.stringify({ time: this.player.finishTime, character: this.player.charIndex, frames: this.ghostRec }));
      } catch { /* storage full */ }
      return true;
    }
    return false;
  }

  _checkEnd(dt) {
    if (this.done || this.mode === 'attract' || this.mode === 'mp') return;
    const p = this.player;
    if (!p.finished) return;
    const allDone = this.karts.every((k) => k.finished);
    const waited = this.time - this.playerFinishedAt;
    if (allDone || waited > (this.mode === 'tt' ? 3.5 : 9)) {
      this.done = true;
      this.app.onRaceComplete?.(this, this.results());
    }
  }

  // final classification (solo modes); unfinished karts get an estimated time
  results() {
    const N = this.track.N;
    const now = this.raceTime * 1000;
    const rows = this.standings.map((k) => {
      let time = k.finishTime;
      let estimated = false;
      if (!k.finished) {
        const remaining = this.laps * N - k.totalIdx; // samples
        const avg = Math.max(8, k.totalIdx > 0 ? (k.totalIdx * 2) / Math.max(1, this.raceTime) : 20);
        time = now + ((remaining * 2) / avg) * 1000;
        estimated = true;
      }
      return { id: k.id, name: k.name, character: k.charIndex, isBot: k.isBot, time, estimated, bestLap: k.lapTimes.length ? Math.min(...k.lapTimes) : null, isPlayer: k === this.player };
    });
    rows.sort((a, b) => a.time - b.time);
    rows.forEach((r, i) => (r.place = i + 1));
    return rows;
  }

  pause(on) {
    this.paused = on;
  }

  dispose() {
    for (const k of this.karts) { this.scene.remove(k.root); k.dispose(); }
    if (this.engines) for (const e of this.engines.values()) e.stop();
    if (this.ghostMesh) this.scene.remove(this.ghostMesh);
    this.items.dispose();
    this.particles.dispose(this.scene);
    this.scenery.dispose();
    this.scene.remove(this.track.group);
    this.track.dispose();
    this.hud?.destroy();
  }
}
