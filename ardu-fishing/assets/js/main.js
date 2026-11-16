// Ardu Fishing entry point: renderer + post-processing, the main loop, game flow
// (attract mode, solo matches, board-vs-board tournaments) and glue between the
// UI, the match, the Modulino rod and the UNO Q server.
import * as THREE from '../libs/three.bundle.js';
import { $, clamp } from './util.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { UI } from './ui.js';
import { World } from './world.js';
import { Game, Attract, MATCH_MS } from './game.js';
import { Tourney } from './tourney.js';
import { MotionController, defaultMotionSettings } from './motion.js';

const VERSION = '1.0.0';
const SETTINGS_KEY = 'ardufish.settings';
const LOCAL_REC_KEY = 'ardufish.records';
const SOLO_COUNTDOWN_MS = 3500;

// mirror: reflection texture size (0 = cheap normal-mapped water)
const QUALITY = {
  low: { pr: 0.75, maxPr: 1, shadows: false, post: false, bloom: false, mirror: 0, terrain: 90, trees: 220, reeds: 500, fireflies: 60 },
  medium: { pr: 1, maxPr: 1.25, shadows: true, shadowSize: 1024, post: true, bloom: true, mirror: 256, terrain: 140, trees: 420, reeds: 1000, fireflies: 120 },
  high: { pr: 1, maxPr: 1.5, shadows: true, shadowSize: 2048, post: true, bloom: true, mirror: 512, terrain: 180, trees: 600, reeds: 1400, fireflies: 160 },
  ultra: { pr: 1, maxPr: 2, shadows: true, shadowSize: 4096, post: true, bloom: true, mirror: 1024, terrain: 240, trees: 900, reeds: 2000, fireflies: 220 },
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
    this.fpsEl = $('#fps');
    this.audio = new AudioEngine();
    this.audio.setVolumes(this.settings.volume);
    this.input = new Input();
    this.net = new Net();
    this.ui = new UI(this);
    this.motion = new MotionController(this);
    this.input.motion = this.motion;
    this.tourney = new Tourney(this);
    this.state = 'boot';     // 'menu' | 'fishing' | 'paused' | 'results'
    this.game = null;
    this.attract = null;
    this.last = performance.now();
    this.fpsAcc = 0; this.fpsFrames = 0; this.fps = 60;
    this.dynScale = 1;
    this._initRenderer();
    this._initNet();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'fishing' && this.game && this.game.mode === 'solo') this.pause();
    });
    // first interaction unlocks audio
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  // ------------------------------------------------------------------ settings / storage
  loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { s = {}; }
    const names = ['Angler', 'Pike', 'Trout', 'Reel', 'Bobber', 'Hook', 'Carp', 'Marlin'];
    return {
      name: s.name || names[Math.floor(Math.random() * names.length)] + Math.floor(10 + Math.random() * 89),
      quality: s.quality || defaultQuality(),
      volume: { master: 0.8, music: 0.6, sfx: 0.9, ...(s.volume || {}) },
      touch: s.touch || 'auto',
      fps: !!s.fps,
      buttonCast: s.buttonCast ?? 0.8,
      motion: { ...defaultMotionSettings(), ...(s.motion || {}) },
    };
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* private mode */ }
  }

  localRecords() {
    try {
      const r = JSON.parse(localStorage.getItem(LOCAL_REC_KEY) || '{}');
      return { matches: r.matches || [], fish: r.fish || [] };
    } catch { return { matches: [], fish: [] }; }
  }

  _addLocalRecords(g) {
    const r = this.localRecords();
    const date = Date.now();
    const name = this.settings.name;
    let rankMatch = null, rankFish = null;
    if (g.fish > 0) {
      const e = { name, fish: g.fish, kg: Math.round(g.kg * 100) / 100, date, mode: g.mode };
      r.matches.push(e);
      r.matches.sort((a, b) => b.fish - a.fish || b.kg - a.kg || a.date - b.date);
      r.matches.length = Math.min(r.matches.length, 10);
      rankMatch = r.matches.indexOf(e) + 1 || null;
    }
    for (const c of g.catches) {
      const e = { species: c.species, kg: c.kg, rarity: c.rarity, name, date };
      r.fish.push(e);
      r.fish.sort((a, b) => b.kg - a.kg || a.date - b.date);
      r.fish.length = Math.min(r.fish.length, 10);
      const k = r.fish.indexOf(e) + 1;
      if (k && (!rankFish || k < rankFish)) rankFish = k;
    }
    try { localStorage.setItem(LOCAL_REC_KEY, JSON.stringify(r)); } catch { /* full */ }
    return { rankMatch, rankFish };
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
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 3000);
    this.scene.add(this.camera);   // the rod hangs off the camera
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
    // the lake geometry is built once; a new detail level needs a fresh page
    if (!initial && changed) {
      if (this.state === 'menu') { this.saveSettings(); location.reload(); }
      else this.ui.toast('Graphics change applies after the match');
      this._reloadAfterMatch = true;
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
    this.world?.setViewport(h * pr);
  }

  // dynamic resolution: keep the frame rate up on weaker GPUs
  _adaptResolution(dt) {
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc < 1) return;
    this.fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0; this.fpsFrames = 0;
    if (this.settings.fps) { this.fpsEl.textContent = `${Math.round(this.fps)} fps · ${(this.pixelRatio || 1).toFixed(2)}x`; this.fpsEl.classList.remove('hidden'); }
    else this.fpsEl.classList.add('hidden');
    if (this.state !== 'fishing' && this.state !== 'menu') return;
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

  _sendStatus() {
    const g = this.game;
    if (g && (this.state === 'fishing' || this.state === 'paused')) this.net.send('solo_status', g.status());
    else if (this.state === 'results' && g) this.net.send('solo_status', { ...g.status(), state: 'finished' });
    else this.net.send('solo_status', { state: 'menu' });
  }

  // ------------------------------------------------------------------ boot & flow
  async boot() {
    const bar = $('#loader-bar');
    const step = (p, label) => { if (bar) bar.style.width = p * 100 + '%'; const l = $('#loader-label'); if (l) l.textContent = label; return new Promise((r) => setTimeout(r, 0)); };
    await step(0.15, 'Filling the lake…');
    this.world = new World(this);
    this.resize();
    await step(0.6, 'Stocking the fish…');
    this.startAttract();
    this.world.update(0.016);
    this.attract.update(0.016);
    await step(0.85, 'Waxing the line…');
    // compile shaders up front so the first match does not hitch
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

  startPressed() {
    this.audio.unlock();
    this.audio.playMusic('menu', { fade: 1.5 });
    this.ui.show('main');
  }

  startAttract() {
    this._disposeGame();
    if (!this.attract) this.attract = new Attract(this);
    this.state = 'menu';
    this.updateTouch();
  }

  _disposeGame() {
    if (this.game) { this.game.dispose(); this.game = null; }
  }

  _startGame(opts) {
    this.ui.hide();
    this._disposeGame();
    if (this.attract) { this.attract.dispose(); this.attract = null; }
    this.game = new Game(this, opts);
    this.state = 'fishing';
    this.resize();
    this.updateTouch();
    this.audio.duck(0, 0);
    this.audio.stopMusic(0.6);
    this.motion.claim(false);
    this._sendStatus();
  }

  startSolo() {
    if (this.tourney.match) this.tourney.quitMatch();
    this._startGame({ mode: 'solo', seed: (Math.random() * 1e9) | 0, startAt: performance.now() + SOLO_COUNTDOWN_MS, durationMs: MATCH_MS });
  }

  // called by Tourney when the host broadcasts the synced start
  startTourney({ seed, startAt, durationMs, players }) {
    this._startGame({ mode: 'tourney', seed, startAt, durationMs: durationMs || MATCH_MS, players });
  }

  quitToMenu() {
    if (this.game && this.game.mode === 'tourney') this.tourney.quitMatch();
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
    if (this.tourney.connected && this.tourney.joined) this.ui.show('lobby');
    else this.ui.show('tourney');
  }

  pause() {
    if (!this.game || this.state !== 'fishing') return;
    this.game.pause(true);   // only freezes the clock in solo
    this.state = 'paused';
    this.audio.duck(0.75, 0.2);
    this.audio.play('menuBack');
    this.ui.reset('pause');
    this.updateTouch();
  }

  resume() {
    if (!this.game || this.game.phase === 'over') return;
    this.game.pause(false);
    this.state = 'fishing';
    this.audio.duck(0, 0.2);
    this.ui.hide();
    this.updateTouch();
  }

  updateTouch() {
    const t = $('#touch');
    if (!t) return;
    const mode = this.settings.touch || 'auto';
    const want = this.state === 'fishing' && this.game && (mode === 'on' || (mode === 'auto' && this.input.isTouch()));
    t.classList.toggle('hidden', !want);
  }

  onScreen(name) {
    document.body.dataset.screen = name;
  }

  // ------------------------------------------------------------------ match callbacks
  onCatch(game, c) {
    if (game !== this.game) return;
    if (game.mode === 'tourney') this.tourney.onCatch(c);
    this._sendStatus();
  }

  async onMatchEnd(game) {
    if (game !== this.game) return;
    this.updateTouch();
    if (this.state === 'paused') { this.game.pause(false); }
    // let the "time's up" moment breathe before covering it
    await new Promise((r) => setTimeout(r, 1800));
    if (game !== this.game) return;
    this.state = 'results';
    this.updateTouch();
    this._sendStatus();
    if (game.mode === 'tourney') {
      this.ui.reset('waiting');
      const res = await this.tourney.finish();
      if (game !== this.game) return;
      this._addLocalRecords(game);
      this.audio.playMusic('results', { fade: 1.2 });
      if (res && res.rows) {
        const me = res.rows.find((r) => r.id === this.tourney.myId);
        if (me && me.place === 1) this.audio.play('record');
        this.ui.reset('results', { game, rows: res.rows, estimated: !!res.estimated });
      } else {
        this.ui.reset('results', { game });
      }
      this.tourney.match = null;
      return;
    }
    // solo: board-wide leaderboard + this browser
    const local = this._addLocalRecords(game);
    this.audio.playMusic('results', { fade: 1.2 });
    const show = (r) => {
      if (game !== this.game || this.state !== 'results') return;
      if ((r.rankMatch === 1 || r.rankFish === 1) && game.fish) this.audio.play('record');
      this.ui.reset('results', { game, rankMatch: r.rankMatch, rankFish: r.rankFish });
    };
    if (!this.net.connected) { show(local); return; }
    const r = await this.net.request('record', { name: this.settings.name, fish: game.fish, kg: Math.round(game.kg * 100) / 100, catches: game.catches.map((c) => ({ species: c.species, kg: c.kg, rarity: c.rarity })) });
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
    this.input.buttonCast = this.settings.buttonCast;
    this.input.poll(dt);
    const actions = this.input.menuActions();
    const inp = this.input.state;
    if (this.state === 'fishing') {
      if (inp.pause) this.pause();
    } else if (this.ui.visible) {
      this.ui.handle(actions);
    }
    if (this.game) {
      // a paused tournament keeps fishing underneath the menu (the clock is shared)
      const live = this.state === 'fishing' || (this.state === 'paused' && this.game.mode === 'tourney') || this.state === 'results';
      const quiet = { ...inp, cast: 0, reel: false, unhook: false, reelGesture: false };
      this.game.update(dt, live && this.state === 'fishing' ? inp : quiet);
    } else if (this.attract) {
      this.attract.update(dt);
    }
    this.world.update(dt);
    this.motion.update();
    this._statusT -= dt;
    if (this._statusT <= 0) {
      this._sendStatus();
      this._statusT = this.state === 'fishing' || this.state === 'paused' ? 0.5 : 3;
    }
    this.render();
    this._adaptResolution(dt);
  }
}

const app = new App();
window.ardufish = app; // handy for debugging from the console
app.boot().catch((e) => {
  console.error(e);
  const l = $('#loader-label');
  if (l) l.textContent = 'Failed to start: ' + e.message;
});
