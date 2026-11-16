// Ardu Snowball entry point: renderer + post-processing, the main loop, game
// flow (attract demo, solo 3v3 against bots, LAN tournaments between boards)
// and the glue between the UI, the HUD, the match, the Modulino controller and
// the UNO Q server.
import * as THREE from '../libs/three.bundle.js';
import { $, clamp } from './util.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { UI } from './ui.js';
import { HUD } from './hud.js';
import { World } from './world.js';
import { Match, MATCH_MS, soloRoster, attractRoster } from './game.js';
import { Lan } from './lan.js';
import { MotionController, defaultMotionSettings } from './motion.js';

const VERSION = '1.0.0';
const SETTINGS_KEY = 'ardusnow.settings';
const LOCAL_REC_KEY = 'ardusnow.records';
const SOLO_COUNTDOWN_MS = 4000;
const END_PAUSE_MS = 1800;

const QUALITY = {
  low: { pr: 0.75, maxPr: 1, shadows: false, post: false, bloom: false, trees: 0.45, snowfall: 0.4 },
  medium: { pr: 1, maxPr: 1.25, shadows: true, shadowSize: 1024, post: true, bloom: true, trees: 0.7, snowfall: 0.7 },
  high: { pr: 1, maxPr: 1.5, shadows: true, shadowSize: 2048, post: true, bloom: true, trees: 1, snowfall: 1 },
  ultra: { pr: 1, maxPr: 2, shadows: true, shadowSize: 4096, post: true, bloom: true, trees: 1.3, snowfall: 1.3 },
};

function defaultQuality() {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1100);
  return mobile ? 'medium' : 'high';
}

const matchPoints = (caps, hits, result) => caps * 100 + hits * 10 + (result === 'win' ? 50 : result === 'draw' ? 20 : 0);

class App {
  constructor() {
    this.version = VERSION;
    this.settings = this.loadSettings();
    this.canvas = $('#game');
    this.fpsEl = $('#fps');
    this.audio = new AudioEngine();
    this.audio.setVolumes(this.settings.volume);
    this.input = new Input();
    this.applyInputSettings();
    this.net = new Net();
    this.ui = new UI(this);
    this.hud = new HUD(this);
    this.motion = new MotionController(this);
    this.input.motion = this.motion;
    this.lan = new Lan(this);
    this.state = 'boot';     // 'menu' | 'playing' | 'paused' | 'results'
    this.game = null;        // the real match (solo / lan)
    this.attract = null;     // demo match behind the menus
    this.last = performance.now();
    this.fpsAcc = 0; this.fpsFrames = 0; this.fps = 60;
    this.dynScale = 1;
    this._initRenderer();
    this._initNet();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing' && this.game && !this.game.lan) this.pause();
    });
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // mouse aim: click the game to lock the pointer
    this.canvas.addEventListener('click', () => { if (this.state === 'playing') this.input.lockPointer(this.canvas); });
    $('#hud').addEventListener('click', () => { if (this.state === 'playing') this.input.lockPointer(this.canvas); });
    // Esc while the pointer is locked only releases the lock (no keydown): treat it as pause
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) { this._locked = true; return; }
      if (this._locked && this.state === 'playing' && this.game && this.game.phase !== 'finished') this.pause();
      this._locked = false;
    });
  }

  // ------------------------------------------------------------------ settings / storage
  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { s = {}; }
    const names = ['Frosty', 'Yeti', 'Flurry', 'Blizzard', 'Igloo', 'Sleet', 'Penguin', 'Avalanche', 'Icicle'];
    return {
      name: s.name || names[Math.floor(Math.random() * names.length)] + Math.floor(10 + Math.random() * 89),
      quality: QUALITY[s.quality] ? s.quality : defaultQuality(),
      volume: { master: 0.8, music: 0.55, sfx: 0.9, ...(s.volume || {}) },
      touch: s.touch || 'auto',
      fps: !!s.fps,
      skill: s.skill || 'normal',
      guide: s.guide !== false,
      invertY: !!s.invertY,
      mouseSens: s.mouseSens ?? 0.5,
      buttonThrow: s.buttonThrow ?? 0.85,
      motion: { ...defaultMotionSettings(), ...(s.motion || {}) },
    };
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  applyInputSettings() {
    this.input.mouseSens = 0.0008 + this.settings.mouseSens * 0.0032;
  }

  localRecords() {
    try {
      const r = JSON.parse(localStorage.getItem(LOCAL_REC_KEY) || '{}');
      return { matches: r.matches || [], snipes: r.snipes || [] };
    } catch { return { matches: [], snipes: [] }; }
  }

  _addLocalRecords(entry, snipe) {
    const r = this.localRecords();
    const date = Date.now();
    let rankMatch = null, rankSnipe = null;
    if (entry.caps || entry.hits) {
      const e = { ...entry, points: matchPoints(entry.caps, entry.hits, entry.result), date };
      r.matches.push(e);
      r.matches.sort((a, b) => b.points - a.points || a.date - b.date);
      r.matches.length = Math.min(r.matches.length, 10);
      rankMatch = r.matches.indexOf(e) + 1 || null;
    }
    if (snipe > 0) {
      const e = { name: entry.name, dist: Math.round(snipe * 10) / 10, date };
      r.snipes.push(e);
      r.snipes.sort((a, b) => b.dist - a.dist || a.date - b.date);
      r.snipes.length = Math.min(r.snipes.length, 10);
      rankSnipe = r.snipes.indexOf(e) + 1 || null;
    }
    try { localStorage.setItem(LOCAL_REC_KEY, JSON.stringify(r)); } catch { /* full */ }
    return { rankMatch, rankSnipe };
  }

  clearLocalData() {
    try { localStorage.removeItem(LOCAL_REC_KEY); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ rendering
  _initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false }));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.03, 900);
    this.scene.add(this.camera);   // the gloved hands hang off the camera
    this.applyQuality(true);
  }

  applyQuality(initial = false) {
    const q = QUALITY[this.settings.quality] || QUALITY.high;
    const changed = this.q && this.q !== q;
    this.q = q;
    this.renderer.shadowMap.enabled = q.shadows;
    this.dynScale = 1;
    this._buildComposer();
    this.resize();
    // the arena is built once for a detail level: a new one needs a fresh page
    if (!initial && changed) {
      if (this.state === 'menu') { this.saveSettings(); location.reload(); }
      else this.ui.toast('Graphics change applies after the match');
      this._reloadAfterMatch = true;
    }
  }

  _buildComposer() {
    const q = this.q;
    if (this.composer) { this.composer.dispose?.(); this.composer = null; }
    this.bloom = null;
    if (!q.post) return;
    const size = new THREE.Vector2(window.innerWidth, window.innerHeight);
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
    const c = (this.composer = new THREE.EffectComposer(this.renderer, rt));
    c.addPass(new THREE.RenderPass(this.scene, this.camera));
    if (q.bloom) {
      this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.38, 0.5, this.world ? this.world.bloomThreshold : 1.15);
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
    for (const m of [this.game, this.attract]) if (m) m.resize(h * pr);
  }

  // dynamic resolution: keep the frame rate up on weaker GPUs
  _adaptResolution(dt) {
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc < 1) return;
    this.fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0; this.fpsFrames = 0;
    if (this.settings.fps) { this.fpsEl.textContent = `${Math.round(this.fps)} fps · ${(this.pixelRatio || 1).toFixed(2)}x`; this.fpsEl.classList.remove('hidden'); }
    else this.fpsEl.classList.add('hidden');
    if (this.state !== 'playing' && this.state !== 'menu') return;
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
    n.on('connect', () => this._updateConn());
    n.on('disconnect', () => this._updateConn());
    n.on('hello', () => { this._updateConn(); if (this.ui.screen && this.ui.screen.name === 'main') this.ui.show('main', {}, { push: false }); });
    n.connect(this.settings.name);
  }

  _updateConn() {
    const c = $('.conn');
    if (c) { c.className = 'conn ' + (this.net.connected ? 'on' : 'off'); c.textContent = this.net.connected ? '● Connected to UNO Q' : '○ Offline'; }
  }

  // LED matrix while no match runs (the match sends its own status at 4 Hz)
  _sendMenuStatus() {
    const g = this.game;
    if (g && this.state === 'results') {
      this.net.send('solo_status', { state: 'finished', count: 0, secs: 0, ammo: 0, snow: 0, flags: 0, my: g.score[g.myTeam], their: g.score[1 - g.myTeam], result: g.myResult() });
    } else if (!g || this.state === 'menu') {
      this.net.send('solo_status', { state: 'menu' });
    }
  }

  // ------------------------------------------------------------------ boot & flow
  async boot() {
    const bar = $('#loader-bar');
    const step = (p, label) => { if (bar) bar.style.width = p * 100 + '%'; const l = $('#loader-label'); if (l) l.textContent = label; return new Promise((r) => setTimeout(r, 0)); };
    await step(0.15, 'Shovelling the snow…');
    this.world = new World(this);
    if (this.bloom) this.bloom.threshold = this.world.bloomThreshold;
    this.resize();
    await step(0.6, 'Building the snow forts…');
    this.startAttract();
    this.world.update(0.016, this.camera);
    this.attract.update(0.016, this._quietInput());
    await step(0.85, 'Packing snowballs…');
    this.renderer.compile(this.scene, this.camera);
    await step(1, 'Ready');
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    setTimeout(() => $('#loader')?.classList.add('done'), 250);
    setTimeout(() => $('#loader')?.remove(), 1200);
    this.ui.reset('title');
    this.state = 'menu';
    this._statusT = 0;
  }

  _quietInput() {
    return { moveX: 0, moveY: 0, turn: 0, lookX: 0, lookY: 0, fromMotion: false, throw: 0, scoop: false, pack: false, snow: false, run: false, runGesture: false, pause: false };
  }

  startPressed() {
    this.audio.unlock();
    this.audio.playMusic('menu', { fade: 1.5 });
    this.ui.show('main');
  }

  startAttract() {
    this._disposeGame();
    this.hud.hide();
    this.input.unlockPointer();
    if (!this.attract) {
      this.attract = new Match(this, { mode: 'attract', roster: attractRoster(), myId: 'demo', hostId: 'demo', startAt: performance.now(), seed: (Math.random() * 1e9) | 0, skill: 'normal' });
      this.attract.resize(window.innerHeight * (this.pixelRatio || 1));
    }
    this.state = 'menu';
    this.updateTouch();
  }

  _disposeGame() {
    if (this.game) { this.game.dispose(); this.game = null; }
    this._ending = null;
  }

  _startGame(cfg) {
    this.ui.hide();
    this._disposeGame();
    if (this.attract) { this.attract.dispose(); this.attract = null; }
    this.game = new Match(this, cfg);
    this.game.resize(window.innerHeight * (this.pixelRatio || 1));
    this.hud.show(this.game);
    this.state = 'playing';
    this.resize();
    this.updateTouch();
    this.audio.duck(0, 0);
    this.audio.playMusic('match', { fade: 1.2 });
    this.motion.claim(false);
    if (!this.input.isTouch() && document.hasFocus()) this.input.lockPointer(this.canvas);
  }

  startSolo() {
    if (this.lan.match) this.lan.quitMatch();
    const seed = (Math.random() * 1e9) | 0;
    this._startGame({
      mode: 'solo', roster: soloRoster(this.settings.name, 3, seed), myId: 'me', hostId: 'me',
      startAt: performance.now() + SOLO_COUNTDOWN_MS, durationMs: MATCH_MS, seed, skill: this.settings.skill,
    });
  }

  // called by Lan when the host board broadcasts the synced start
  startLan({ roster, myId, hostId, startAt, durationMs, seed, net }) {
    this._startGame({ mode: 'lan', roster, myId, hostId, startAt, durationMs: durationMs || MATCH_MS, seed, net, skill: 'normal' });
  }

  // the link to the host board dropped mid-match
  lanLost() {
    if (!this.game || !this.game.lan) return;
    this.ui.toast('The match was interrupted', 'warn');
    this.quitToMenu();
  }

  quitToMenu() {
    if (this.game && this.game.lan) this.lan.quitMatch();
    if (this._reloadAfterMatch) { location.reload(); return; }
    this.startAttract();
    this.audio.duck(0, 0.2);
    this.audio.playMusic('menu', { fade: 1 });
    this.ui.reset('main');
  }

  backToLobby() {
    if (this._reloadAfterMatch) { location.reload(); return; }
    this.startAttract();
    this.audio.playMusic('menu', { fade: 1 });
    this.ui.reset('main');
    if (this.lan.connected) { this.lan.afterMatch(); this.ui.show('lobby'); }
    else this.ui.show('tourney');
  }

  pause() {
    if (!this.game || this.state !== 'playing') return;
    this.game.pause();   // no-op in LAN: the match keeps running
    this.state = 'paused';
    this.input.unlockPointer();
    this.audio.duck(0.75, 0.2);
    this.audio.play('menuBack');
    this.ui.reset('pause');
    this.updateTouch();
  }

  resume() {
    if (!this.game || this.state !== 'paused') return;
    this.game.resume();
    this.state = 'playing';
    this.audio.duck(0, 0.2);
    this.ui.hide();
    this.updateTouch();
    if (!this.input.isTouch()) this.input.lockPointer(this.canvas);
  }

  updateTouch() {
    const t = $('#touch');
    if (!t) return;
    const mode = this.settings.touch || 'auto';
    const want = this.state === 'playing' && this.game && (mode === 'on' || (mode === 'auto' && this.input.isTouch()));
    t.classList.toggle('hidden', !want);
    document.body.classList.toggle('touch-on', !!want);
  }

  onScreen(name) {
    document.body.dataset.screen = name || (this.state === 'playing' ? 'game' : '');
  }

  // ------------------------------------------------------------------ match end
  async _onMatchEnd(game) {
    this._ending = game;
    this.input.unlockPointer();
    await new Promise((r) => setTimeout(r, END_PAUSE_MS));
    if (game !== this.game) return;
    if (this.state === 'paused') game.resume();
    this.state = 'results';
    this.updateTouch();
    this._statusT = 0;
    const me = game.me;
    const snipe = me ? me.bestSnipe : 0;
    if (game.lan) {
      this.ui.reset('waiting');
      const res = await this.lan.finish();
      if (game !== this.game) return;
      this.hud.hide();
      const r = res || { ...game.localResults(), estimated: true };
      game.results = r;
      const mine = r.rows.find((x) => x.id === game.myId) || { caps: 0, hits: 0 };
      const result = r.winner < 0 ? 'draw' : r.winner === game.myTeam ? 'win' : 'loss';
      const local = this._addLocalRecords({ name: this.settings.name, caps: mine.caps, hits: mine.hits, result, mode: 'lan' }, snipe);
      this.audio.playMusic('results', { fade: 1.2 });
      if (result === 'win') this.audio.play('record');
      this.ui.reset('results', { res: r, myId: game.myId, myTeam: game.myTeam, lan: true, estimated: !!r.estimated, snipe, ...local });
      return;
    }
    // solo: board-wide leaderboard + this browser
    this.hud.hide();
    const res = game.results || game.localResults();
    const mine = res.rows.find((x) => x.id === game.myId) || { caps: 0, hits: 0 };
    const result = res.winner < 0 ? 'draw' : res.winner === game.myTeam ? 'win' : 'loss';
    const entry = { name: this.settings.name, caps: mine.caps, hits: mine.hits, result, mode: 'solo' };
    const local = this._addLocalRecords(entry, snipe);
    this.audio.playMusic('results', { fade: 1.2 });
    const show = (r) => {
      if (game !== this.game || this.state !== 'results') return;
      if (r.rankMatch === 1 || r.rankSnipe === 1) this.audio.play('record');
      this.ui.reset('results', { res, myId: game.myId, myTeam: game.myTeam, lan: false, rankMatch: r.rankMatch, rankSnipe: r.rankSnipe, snipe });
    };
    if (!this.net.connected) { show(local); return; }
    const r = await this.net.request('record', { name: entry.name, caps: entry.caps, hits: entry.hits, result, snipe: Math.round(snipe * 10) / 10 });
    show(r && r.ok ? r : local);
    this.net.request('get_records', {}).then((x) => { if (x) this.net.records = x; });
  }

  // ------------------------------------------------------------------ main loop
  loop(now) {
    requestAnimationFrame(this.loop);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 1 / 20);
    this.input.poll(dt);
    const actions = this.input.menuActions();
    const inp = this.input.state;
    if (this.settings.invertY) inp.lookY = -inp.lookY;
    if (this.state === 'playing') {
      if (inp.pause) this.pause();
    } else if (this.ui.visible) {
      this.ui.handle(actions);
    }
    const g = this.game;
    if (g) {
      // a paused LAN match keeps running underneath the menu (the clock is shared)
      g.update(dt, this.state === 'playing' ? inp : this._quietInput());
      if (this.state !== 'results') this.hud.update(dt, g);
      if (g.phase === 'finished' && this._ending !== g && (this.state === 'playing' || this.state === 'paused')) this._onMatchEnd(g);
    } else if (this.attract) {
      this.attract.update(dt, this._quietInput());
    }
    this.world.update(dt, this.camera);
    this.motion.update();
    this._statusT -= dt;
    if (this._statusT <= 0) {
      this._sendMenuStatus();
      this._statusT = this.state === 'results' ? 1 : 3;
    }
    this.render();
    this._adaptResolution(dt);
  }
}

const app = new App();
window.ardusnow = app; // handy for debugging from the console
app.boot().catch((e) => {
  console.error(e);
  const l = $('#loader-label');
  if (l) l.textContent = 'Failed to start: ' + e.message;
});
