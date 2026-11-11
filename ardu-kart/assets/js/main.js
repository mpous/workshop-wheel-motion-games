// Ardu Kart entry point: renderer + post-processing, the main loop, game flow
// (attract mode, solo races, Grand Prix, time trial, LAN multiplayer) and glue
// between the UI, the race session, the Modulino wheel and the UNO Q server.
import * as THREE from '../libs/three.bundle.js';
import { $, el, clamp, formatTime } from './util.js';
import { TRACKS } from './tracks.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Race } from './race.js';
import { UI, GP_POINTS } from './ui.js';
import { Preview } from './preview.js';
import { CHARACTERS } from './kartModel.js';
import { MotionController, defaultMotionSettings } from './motion.js';

const VERSION = '1.1.0';
const SETTINGS_KEY = 'ardukart.settings';
const LOCAL_REC_KEY = 'ardukart.records';

// the game was called Q-Kart: carry saved data over to the new keys once
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('qkart.') && localStorage.getItem('ardu' + k) === null) localStorage.setItem('ardu' + k, localStorage.getItem(k));
  }
} catch (e) { /* storage disabled */ }

const QUALITY = {
  low: { pr: 0.75, maxPr: 1, shadows: false, post: false, bloom: false },
  medium: { pr: 1, maxPr: 1.25, shadows: true, shadowSize: 1024, post: true, bloom: true },
  high: { pr: 1, maxPr: 1.5, shadows: true, shadowSize: 2048, post: true, bloom: true },
  ultra: { pr: 1, maxPr: 2, shadows: true, shadowSize: 4096, post: true, bloom: true },
};

function defaultQuality() {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1 && window.innerWidth < 1100;
  return mobile ? 'medium' : 'high';
}

class App {
  constructor() {
    this.version = VERSION;
    this.settings = this.loadSettings();
    this.canvas = $('#game');
    this.hudRoot = $('#hud');
    this.fpsEl = $('#fps');
    this.audio = new AudioEngine();
    this.audio.setVolumes(this.settings.volume);
    this.input = new Input();
    this.input.autoAccel = !!this.settings.autoAccel;
    this.net = new Net();
    this.ui = new UI(this);
    this.motion = new MotionController(this);
    this.input.motion = this.motion;
    this.portraits = {};
    this.state = 'boot';
    this.race = null;
    this.gp = null;
    this.last = performance.now();
    this.fpsAcc = 0; this.fpsFrames = 0; this.fps = 60;
    this.dynScale = 1;
    this._initRenderer();
    this._initNet();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'race' && this.race && this.race.mode !== 'mp' && !this.race.paused) this.pause();
    });
    // first interaction unlocks audio
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
  }

  // ------------------------------------------------------------------ settings / storage
  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { s = {}; }
    const names = ['Racer', 'Speedy', 'Ace', 'Blaze', 'Flash', 'Rookie', 'Zoom', 'Dash'];
    return {
      name: s.name || names[Math.floor(Math.random() * names.length)] + Math.floor(10 + Math.random() * 89),
      character: s.character ?? 0,
      quality: s.quality || defaultQuality(),
      volume: { master: 0.8, music: 0.6, sfx: 0.9, ...(s.volume || {}) },
      autoAccel: s.autoAccel ?? false,
      touch: s.touch || 'auto',
      cc: s.cc || 100,
      lastTrack: s.lastTrack || 'sunset',
      fps: !!s.fps,
      trophies: s.trophies || {},
      motion: { ...defaultMotionSettings(), ...(s.motion || {}) },
    };
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  get moduleQuality() { return this.settings.quality === 'ultra' ? 'high' : this.settings.quality; }

  localRecords(trackId) {
    try {
      const all = JSON.parse(localStorage.getItem(LOCAL_REC_KEY) || '{}');
      return all[trackId] || { laps: [], races: [] };
    } catch { return { laps: [], races: [] }; }
  }

  addLocalRecord(trackId, kind, entry) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(LOCAL_REC_KEY) || '{}'); } catch { all = {}; }
    const t = (all[trackId] ||= { laps: [], races: [] });
    t[kind].push(entry);
    t[kind].sort((a, b) => a.time - b.time);
    t[kind].length = Math.min(t[kind].length, 10);
    try { localStorage.setItem(LOCAL_REC_KEY, JSON.stringify(all)); } catch { /* full */ }
    return t[kind].indexOf(entry) + 1;
  }

  bestLap(trackId) {
    const srv = this.net.records && this.net.records.tracks && this.net.records.tracks[trackId];
    const a = srv && srv.laps && srv.laps[0];
    const b = this.localRecords(trackId).laps[0];
    if (a && b) return a.time <= b.time ? a : b;
    return a || b || null;
  }

  gpTrophy() {
    const t = this.settings.trophies || {};
    const best = ['gold', 'silver', 'bronze'].find((k) => Object.values(t).includes(k));
    return best ? best.toUpperCase() : null;
  }

  clearLocalData() {
    try {
      localStorage.removeItem(LOCAL_REC_KEY);
      for (const t of TRACKS) localStorage.removeItem('ardukart.ghost.' + t.id);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ rendering
  _initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false }));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.3, 1400);
    this.applyQuality(true);
  }

  applyQuality(initial = false) {
    const q = QUALITY[this.settings.quality] || QUALITY.high;
    this.q = q;
    const r = this.renderer;
    r.shadowMap.enabled = q.shadows;
    this.dynScale = 1;
    this._buildComposer();
    this.resize();
    if (!initial) {
      // rebuild the current scene so geometry detail follows the preset
      if (this.state === 'menu') this.startAttract();
      else if (this.race) this.ui.toast('Graphics change applies to the next race');
    }
  }

  _buildComposer() {
    const q = this.q;
    if (this.composer) { this.composer.dispose?.(); this.composer = null; }
    if (!q.post) return;
    const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
    const c = (this.composer = new THREE.EffectComposer(this.renderer, rt));
    c.addPass(new THREE.RenderPass(this.scene, this.camera));
    if (q.bloom) {
      this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.42, 0.55, 0.86);
      c.addPass(this.bloom);
    }
    c.addPass(new THREE.OutputPass());
    this.fxaa = new THREE.ShaderPass(THREE.FXAAShader);
    c.addPass(this.fxaa);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const q = this.q;
    const pr = clamp((window.devicePixelRatio || 1) * q.pr, 0.5, q.maxPr) * this.dynScale;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(pr);
      this.composer.setSize(w, h);
      if (this.fxaa) this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    }
    if (this.race) this.race.particles.setViewport(h * pr);
    this.preview?.resize();
  }

  // dynamic resolution: keep the frame rate up on weaker GPUs
  _adaptResolution(dt) {
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc < 1) return;
    this.fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0; this.fpsFrames = 0;
    if (this.settings.fps) { this.fpsEl.textContent = `${Math.round(this.fps)} fps · ${(this.pixelRatio || 1).toFixed(2)}x`; this.fpsEl.classList.remove('hidden'); }
    else this.fpsEl.classList.add('hidden');
    if (this.state !== 'race' && this.state !== 'menu') return;
    let s = this.dynScale;
    if (this.fps < 48 && s > 0.6) s = Math.max(0.6, s - 0.1);
    else if (this.fps > 58 && s < 1) s = Math.min(1, s + 0.05);
    if (s !== this.dynScale) { this.dynScale = s; this.resize(); }
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------------ network
  _initNet() {
    const n = this.net;
    n.on('connect', () => { this._updateConn(); });
    n.on('disconnect', () => {
      this._updateConn();
      if (this.race && this.race.mode === 'mp') { this.ui.toast('Lost connection to the UNO Q', 'warn'); }
    });
    n.on('hello', () => { this._updateConn(); if (this.ui.screen && this.ui.screen.name === 'main') this.ui.show('main', {}, { push: false }); });
    n.on('lobby', () => this.ui.onLobby());
    n.on('race_start', (msg) => this._onRaceStart(msg));
    n.on('snapshot', (s) => { if (this.race && this.race.mode === 'mp') this.race.onSnapshot(s); });
    n.on('event', (e) => { if (this.race && this.race.mode === 'mp') this.race.onRemoteEvent(e); });
    n.on('player_left', (m) => { if (this.race && this.race.mode === 'mp') this.race.onPlayerLeft(m); });
    n.on('race_results', (m) => this._onRaceResults(m));
    n.connect(this.settings.name);
  }

  _updateConn() {
    const c = $('.conn');
    if (c) { c.className = 'conn ' + (this.net.connected ? 'on' : 'off'); c.textContent = this.net.connected ? '● Connected to UNO Q' : '○ Offline'; }
  }

  _onRaceStart(msg) {
    const mine = msg.grid.some((g) => g.owner === this.net.id);
    if (!mine) return;
    this.mpRaceId = msg.raceId;
    this.net.joinRoom('race');
    this._startRace({ mode: 'mp', track: msg.track, cc: msg.cc, laps: msg.laps, seed: msg.seed, grid: msg.grid, startAt: msg.startAt, hostId: msg.hostId, netHz: msg.netHz, character: this.settings.character, playerName: this.settings.name });
  }

  _onRaceResults(msg) {
    if (!this.race || this.race.mode !== 'mp' || msg.raceId !== this.mpRaceId) return;
    const r = this.race;
    const rows = msg.results.map((x) => ({ ...x, isPlayer: x.id === this.net.id }));
    const me = rows.find((x) => x.isPlayer);
    // snapshots stop once the server closes the race; keep remote karts cruising behind the results
    for (const k of r.karts) {
      if (k.local) continue;
      k.local = true;
      k.finished = true;
      k.prevPos = null;
      k.hint = -1;
      r._addAI(k, k.slot || 0);
    }
    const doShow = () => {
      if (this.race !== r) return;
      this.ui.show('results', {
        rows, mode: 'mp', trackName: r.def.name, title: me && me.place === 1 ? 'VICTORY!' : 'RESULTS',
        onContinue: () => { this.net.leaveRoom('race'); this.quitToMenu('lobby'); },
      });
      this.audio.playMusic('results', { fade: 1 });
      this.state = 'results';
    };
    // give the finish moment a beat before covering it with the table
    setTimeout(doShow, r.player.finished ? 1500 : 200);
  }

  // ------------------------------------------------------------------ boot & flow
  async boot() {
    const bar = $('#loader-bar');
    const step = (p, label) => { if (bar) bar.style.width = p * 100 + '%'; const l = $('#loader-label'); if (l) l.textContent = label; return new Promise((r) => setTimeout(r, 0)); };
    await step(0.15, 'Building karts…');
    try {
      this.preview = new Preview();
      this.portraits = this.preview.bakePortraits(128);
    } catch (e) { console.error('portraits failed', e); }
    await step(0.45, 'Painting tracks…');
    this.startAttract();
    await step(0.85, 'Warming up engines…');
    // compile shaders up front so the first race does not hitch
    this.renderer.compile(this.scene, this.camera);
    await step(1, 'Ready');
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    setTimeout(() => $('#loader')?.classList.add('done'), 250);
    setTimeout(() => $('#loader')?.remove(), 1200);
    this.ui.reset('title');
    this.state = 'menu';
    setInterval(() => { if (this.state === 'menu') this.net.send('solo_status', { state: 'menu' }); }, 3000);
  }

  startPressed() {
    this.audio.unlock();
    this.audio.playMusic('menu', { fade: 1.5 });
    this.ui.show('main');
  }

  startAttract() {
    this.disposeRace();
    const t = TRACKS[Math.floor(Math.random() * TRACKS.length)];
    this.race = new Race(this, { mode: 'attract', track: t.id, cc: 150, laps: 99, seed: (Math.random() * 1e6) | 0 });
    this.state = 'menu';
    this.updateTouch();
  }

  disposeRace() {
    if (this.race) {
      const r = this.race;
      if (r.podium) for (const k of r.podium) { this.scene.remove(k.root); k.dispose(); }
      if (r._podiumGroup) this.scene.remove(r._podiumGroup);
      r.dispose();
      this.race = null;
    }
    // drop anything a previous scene left behind (lights, fog, environment)
    this.scene.fog = null;
    this.scene.environment = null;
    this.scene.background = null;
  }

  startSolo({ mode, track, cc, laps }) {
    this.gp = null;
    this.lastSolo = { mode, track, cc, laps };
    this._startRace({ mode, track, cc, laps: mode === 'tt' ? 3 : laps, seed: (Math.random() * 1e6) | 0, character: this.settings.character, playerName: this.settings.name });
  }

  startGP({ cc }) {
    this.gp = {
      cc, index: 0, tracks: TRACKS.map((t) => t.id),
      standings: null, // [{id,name,character,isPlayer,points}]
    };
    this._startGPRace();
  }

  _startGPRace() {
    const g = this.gp;
    // the same seed every round keeps the CPU roster (names / characters) stable across the cup
    if (g.seed == null) g.seed = (Math.random() * 1e6) | 0;
    const opts = { mode: 'race', track: g.tracks[g.index], cc: g.cc, laps: 3, seed: g.seed, character: this.settings.character, playerName: this.settings.name };
    if (g.standings) {
      // reverse-standings grid: the leader starts at the back
      opts.gridOrder = [...g.standings].reverse().map((s) => s.id);
    }
    this._startRace(opts);
    if (!g.roster) g.roster = this.race.karts.map((k) => ({ id: k.id, name: k.name, character: k.charIndex, isPlayer: k === this.race.player }));
  }

  _startRace(opts) {
    this.ui.hide();
    this.disposeRace();
    this.raceOpts = opts;
    this.motion.resetRace();
    this.race = new Race(this, opts);
    this.state = 'race';
    this.resize();
    this.updateTouch();
    this.audio.duck(0, 0);
  }

  restartRace() {
    if (!this.raceOpts || this.raceOpts.mode === 'mp') return;
    if (this.gp) { this._startGPRace(); return; }
    this._startRace({ ...this.raceOpts, seed: (Math.random() * 1e6) | 0 });
  }

  quitToMenu(screen = 'main') {
    if (this.race && this.race.mode === 'mp') { this.net.leaveRoom('race'); }
    this.gp = null;
    this.startAttract();
    this.audio.playMusic('menu', { fade: 1 });
    this.ui.reset('main');
    if (screen === 'lobby') this.ui.show('lobby');
  }

  pause() {
    if (!this.race || this.state !== 'race') return;
    if (this.race.mode !== 'mp') this.race.pause(true);
    this.state = 'paused';
    this.audio.duck(0.75, 0.2);
    this.audio.play('menuBack');
    this.ui.reset('pause');
    this.updateTouch();
  }

  resume() {
    if (!this.race) return;
    this.race.pause(false);
    this.state = 'race';
    this.audio.duck(0, 0.2);
    this.ui.hide();
    this.updateTouch();
  }

  updateTouch() {
    const t = $('#touch');
    if (!t) return;
    const mode = this.settings.touch || 'auto';
    const want = this.state === 'race' && this.race && this.race.mode !== 'attract' && (mode === 'on' || (mode === 'auto' && this.input.isTouch()));
    t.classList.toggle('hidden', !want);
  }

  onScreen(name) {
    document.body.dataset.screen = name;
  }

  // ------------------------------------------------------------------ race callbacks
  onPlayerFinished(race) {
    const p = race.player;
    if (race.mode === 'mp') return;
    // submit to the board-wide leaderboard
    const best = p.lapTimes.length ? Math.min(...p.lapTimes) : null;
    const mode = race.mode === 'tt' ? 'tt' : this.gp ? 'gp' : 'race';
    const entry = { name: this.settings.name, character: p.charIndex, date: Date.now(), mode };
    const before = this.bestLap(race.def.id);
    if (best) this.addLocalRecord(race.def.id, 'laps', { ...entry, time: best });
    this.addLocalRecord(race.def.id, 'races', { ...entry, time: p.finishTime });
    if (best && (!before || best < before.time)) race.newRecord = `NEW TRACK RECORD · ${formatTime(best)}`;
    this.net.request('record', { track: race.def.id, name: this.settings.name, character: p.charIndex, lapTime: best, raceTime: p.finishTime, mode })
      .then((r) => { if (r && r.ok && r.rankLap === 1 && !race.newRecord) race.newRecord = `BOARD RECORD LAP · ${formatTime(best)}`; });
  }

  onRaceComplete(race, rows) {
    if (race !== this.race) return;
    const ghostSaved = race.saveGhostIfBest();
    this.state = 'results';
    this.updateTouch();
    this.audio.playMusic('results', { fade: 1.2 });
    if (this.gp) return this._gpAfterRace(rows, race);
    this.ui.reset('results', {
      rows, mode: race.mode, trackName: `${race.def.name} · ${race.cc.label}`,
      title: race.mode === 'tt' ? 'TIME TRIAL' : rows.find((r) => r.isPlayer)?.place === 1 ? 'VICTORY!' : 'RESULTS',
      newRecord: race.newRecord, ghostSaved,
      onContinue: () => this.quitToMenu(),
    });
  }

  _gpAfterRace(rows, race) {
    const g = this.gp;
    if (!g.standings) g.standings = g.roster.map((r) => ({ ...r, points: 0 }));
    for (const s of g.standings) s.gain = 0;
    for (const r of rows) {
      const s = g.standings.find((x) => x.id === r.id);
      if (s) { s.gain = GP_POINTS[r.place - 1] || 0; s.points += s.gain; }
    }
    g.standings.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
    const final = g.index >= g.tracks.length - 1;
    this.ui.reset('results', {
      rows, mode: 'race', gp: true, trackName: `${race.def.name} · Race ${g.index + 1}/${g.tracks.length}`,
      title: rows.find((r) => r.isPlayer)?.place === 1 ? 'VICTORY!' : 'RESULTS', newRecord: race.newRecord,
      onContinue: () => this.ui.reset('gpStandings', {
        standings: g.standings, raceIndex: g.index, total: g.tracks.length, final,
        onContinue: () => {
          if (!final) { g.index++; this._startGPRace(); return; }
          this._podium();
        },
      }),
    });
  }

  _podium() {
    const g = this.gp;
    const place = g.standings.findIndex((s) => s.isPlayer) + 1;
    if (place <= 3) {
      const medal = ['gold', 'silver', 'bronze'][place - 1];
      const prev = this.settings.trophies[g.cc];
      const rank = (m) => ['gold', 'silver', 'bronze'].indexOf(m);
      if (!prev || rank(medal) < rank(prev)) { this.settings.trophies[g.cc] = medal; this.saveSettings(); }
    }
    this.disposeRace();
    // ceremony: the top three stand on a podium on the last track
    this.race = new Race(this, { mode: 'attract', track: g.tracks[g.tracks.length - 1], cc: g.cc, laps: 99, seed: 5 });
    this._setupPodiumScene(g.standings.slice(0, 3));
    this.state = 'podium';
    this.audio.play('finish', { good: place <= 3 });
    this.ui.reset('podium', { place, standings: g.standings, onContinue: () => this.quitToMenu() });
  }

  _setupPodiumScene(top) {
    const r = this.race;
    // freeze the attract karts, hide all but the top three and arrange them on blocks
    const tr = r.track;
    const base = tr.point(tr.N * 0.02, 0);
    const h = tr.heading(tr.N * 0.02);
    const fx = Math.sin(h), fz = Math.cos(h), lx = Math.cos(h), lz = -Math.sin(h);
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshStandardMaterial({ color: c, metalness: 0.4, roughness: 0.35 });
    const blocks = [[0, 2.2, 0xffd34d], [-1, 1.5, 0xd7dde8], [1, 1.0, 0xcd8a4a]];
    blocks.forEach(([side, height, col]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(3, height, 3), mat(col));
      m.position.set(base.x + lx * side * 3.2, base.y + height / 2, base.z + lz * side * 3.2);
      m.rotation.y = h;
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    });
    r.scene.add(group);
    r._podiumGroup = group;
    r.ai.clear();
    r.karts.forEach((k) => (k.root.visible = false));
    const show = top.map((s, i) => {
      const k = r.karts[i];
      k.root.visible = true;
      // swap the model to the standing's character
      return { k, s, side: blocks[i][0], height: blocks[i][1] };
    });
    // rebuild the three podium karts with the right characters
    r.podium = show.map(({ s, side, height }, i) => {
      const old = r.karts[i];
      r.scene.remove(old.root);
      const K = old.constructor;
      const k = new K({ id: 'pod' + i, name: s.name, charIndex: s.character, isBot: true, local: true, track: tr, cc: r.cc, quality: this.moduleQuality });
      k.pos.set(base.x + lx * side * 3.2, base.y + height, base.z + lz * side * 3.2);
      k.heading = h + Math.PI; // face the camera
      k.root.position.copy(k.pos);
      k.root.rotation.y = k.heading;
      r.scene.add(k.root);
      return k;
    });
    r.update = (dt) => {
      r.time += dt;
      const t = r.time;
      r.podium.forEach((k, i) => {
        k.root.position.y = k.pos.y + Math.abs(Math.sin(t * 3 + i)) * (i === 0 ? 0.25 : 0.12);
        k.root.rotation.y = k.heading + Math.sin(t * 1.3 + i) * 0.25;
      });
      if (Math.random() < dt * 8) {
        const p = r.podium[0].pos.clone(); p.y += 4;
        r.particles.confetti(p, 25);
      }
      r.particles.update(dt);
      r.track.update(t, dt);
      r.scenery.update(t, dt);
      const a = t * 0.18;
      this.camera.position.set(base.x - fx * 13 + Math.sin(a) * 4, base.y + 5.5, base.z - fz * 13 + Math.cos(a) * 2);
      this.camera.lookAt(base.x, base.y + 2.2, base.z);
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
      r.scenery.follow(base);
    };
  }

  // ------------------------------------------------------------------ main loop
  loop(now) {
    requestAnimationFrame(this.loop);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 1 / 20);
    this.input.poll();
    const actions = this.input.menuActions();
    const inp = this.input.state;
    if (this.state === 'race') {
      if (inp.pause) this.pause();
    } else if (this.ui.visible) {
      this.ui.handle(actions);
    }
    if (this.race) {
      if (this.state === 'paused' && this.race.mode !== 'mp') {
        // keep the frame alive but frozen; the scenery may still animate gently
      } else {
        this.race.update(dt);
      }
    }
    if (this.ui.screen && this.ui.screen.name === 'chars') this.preview?.render(dt);
    this.motion.update();
    this.render();
    this._adaptResolution(dt);
  }
}

const app = new App();
window.ardukart = app; // handy for debugging from the console
app.boot().catch((e) => {
  console.error(e);
  const l = $('#loader-label');
  if (l) l.textContent = 'Failed to start: ' + e.message;
});
void el; void CHARACTERS;
