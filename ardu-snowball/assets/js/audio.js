// Ardu Snowball — fully procedural Web Audio (no audio files): alpine wind,
// an adaptive wintry soundtrack (glockenspiel, sleigh bells, pizzicato bass)
// and every sound effect. 3D-ish: effects can be panned and attenuated by
// distance from the listener.
// Every public method is a safe no-op when Web Audio is unavailable or locked.

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
const MAX_SFX = 40;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// C major / A minor loops
const SONGS = {
  menu: { bpm: 96, chords: [[48, 52, 55, 60], [45, 48, 52, 57], [41, 45, 48, 53], [43, 47, 50, 55]], scale: [72, 74, 76, 79, 81, 84, 86, 88], drums: false },
  match: { bpm: 128, chords: [[45, 48, 52, 57], [41, 45, 48, 53], [48, 52, 55, 60], [43, 47, 50, 55]], scale: [69, 72, 74, 76, 79, 81, 84], drums: true },
  results: { bpm: 112, chords: [[41, 45, 48, 53], [43, 47, 50, 55], [48, 52, 55, 60], [48, 52, 55, 60]], scale: [72, 76, 79, 84, 88, 91], drums: true },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.vol = { master: 0.8, music: 0.6, sfx: 0.9 };
    this.active = 0;
    this.song = null;
    this.intensity = 0;     // 0 calm .. 1 frantic (star carried, last seconds)
    this._ambience = null;
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this._build();
      this.ok = true;
      this._timer = setInterval(() => this._schedule(), TICK_MS);
      if (this._wantSong) this.playMusic(this._wantSong.id, this._wantSong.opts);
      this._startAmbience();
    } catch (e) { console.warn('audio disabled', e); this.ctx = null; }
  }

  _build() {
    const c = this.ctx;
    this.master = c.createGain();
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 4;
    this.master.connect(this.comp).connect(c.destination);
    this.musicBus = c.createGain();
    this.sfxBus = c.createGain();
    this.ambBus = c.createGain();
    this.duckGain = c.createGain();
    this.musicBus.connect(this.duckGain).connect(this.master);
    this.sfxBus.connect(this.master);
    this.ambBus.connect(this.master);
    // shared reverb (mountain echo)
    this.verb = c.createConvolver();
    this.verb.buffer = this._ir(3.2);
    this.verbSend = c.createGain();
    this.verbSend.gain.value = 0.3;
    this.verbSend.connect(this.verb).connect(this.master);
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this._applyVolumes();
  }

  _ir(sec) {
    const c = this.ctx, n = Math.floor(c.sampleRate * sec);
    const b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.6);
    }
    return b;
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, v = this.vol;
    this.master.gain.setTargetAtTime(v.master, t, 0.03);
    this.musicBus.gain.setTargetAtTime(v.music * 0.5, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(v.sfx, t, 0.03);
    this.ambBus.gain.setTargetAtTime(v.sfx * 0.6, t, 0.03);
  }

  setVolumes(v = {}) { this.vol = { ...this.vol, ...v }; this._applyVolumes(); }

  duck(amount = 0.5, sec = 1) {
    if (!this.ctx) return;
    this.duckGain.gain.setTargetAtTime(1 - amount, this.ctx.currentTime, Math.max(0.01, sec / 3));
  }

  setIntensity(x) { this.intensity = clamp(x, 0, 1); }

  // ------------------------------------------------------------------ voices
  _env(g, t, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dur);
  }

  _tone(dest, t, { f = 440, f2 = null, type = 'sine', a = 0.005, dur = 0.2, vol = 0.3, rev = 0, detune = 0 }) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + a + dur);
    o.detune.value = detune;
    this._env(g, t, a, vol, dur);
    o.connect(g).connect(dest);
    if (rev) { const s = c.createGain(); s.gain.value = rev; g.connect(s).connect(this.verbSend); }
    o.start(t); o.stop(t + a + dur + 0.05);
    return o;
  }

  _noise(dest, t, { dur = 0.3, a = 0.005, vol = 0.3, type = 'bandpass', f = 1000, f2 = null, q = 1, rev = 0 }) {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf;
    s.loop = true;
    fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + a + dur);
    this._env(g, t, a, vol, dur);
    s.connect(fl).connect(g).connect(dest);
    if (rev) { const r = c.createGain(); r.gain.value = rev; g.connect(r).connect(this.verbSend); }
    s.start(t, Math.random()); s.stop(t + a + dur + 0.05);
  }

  // glockenspiel / celesta: bright sine partials with fast decay
  _bell(dest, t, midi, vol = 0.12, dur = 1.0) {
    const f = mtof(midi);
    this._tone(dest, t, { f, type: 'sine', a: 0.002, dur, vol, rev: 0.5 });
    this._tone(dest, t, { f: f * 2.76, type: 'sine', a: 0.002, dur: dur * 0.35, vol: vol * 0.3, rev: 0.4 });
    this._tone(dest, t, { f: f * 5.4, type: 'sine', a: 0.001, dur: dur * 0.12, vol: vol * 0.12 });
  }

  // sleigh bells: a few jingles of high band-passed noise + metallic partials
  _jingle(dest, t, vol = 0.05) {
    for (let i = 0; i < 3; i++) {
      const s = t + i * 0.012;
      this._noise(dest, s, { dur: 0.06, a: 0.001, vol, type: 'bandpass', f: 7000 + i * 900, q: 9 });
    }
  }

  _pizz(dest, t, midi, vol = 0.14, dur = 0.3) {
    const f = mtof(midi);
    this._tone(dest, t, { f, type: 'triangle', a: 0.003, dur, vol });
    this._noise(dest, t, { dur: 0.02, vol: vol * 0.3, f: f * 4, q: 3 });
  }

  // snow crunch: short bursts of low/mid noise
  _crunch(dest, t, vol = 0.2, n = 3, f = 900) {
    for (let i = 0; i < n; i++) {
      const s = t + i * (0.025 + Math.random() * 0.03);
      this._noise(dest, s, { dur: 0.04 + Math.random() * 0.04, a: 0.002, vol: vol * (0.6 + Math.random() * 0.4), type: 'bandpass', f: f * (0.7 + Math.random() * 0.8), q: 1.2 });
    }
  }

  // Spatial sends: pan -1..1 and distance gain (0..1). Returns a destination node.
  _spatial(o) {
    if (o.pan == null && o.dist == null) return this.sfxBus;
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = o.dist == null ? 1 : clamp(1 / (1 + o.dist * 0.08), 0.05, 1);
    let out = g;
    if (c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = clamp(o.pan || 0, -1, 1);
      g.connect(p); p.connect(this.sfxBus);
      out = g;
    } else g.connect(this.sfxBus);
    setTimeout(() => g.disconnect(), 3000);
    return out;
  }

  play(name, opts = {}) {
    if (!this.ok || this.active > MAX_SFX) return;
    const fn = this['_s_' + name];
    if (!fn) return;
    this.active++;
    setTimeout(() => this.active--, 1500);
    try { fn.call(this, this.ctx.currentTime + 0.005, opts, this._spatial(opts)); } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------------ sfx
  _s_menuMove(t) { this._bell(this.sfxBus, t, 88, 0.05, 0.12); }
  _s_menuSelect(t) { this._bell(this.sfxBus, t, 84, 0.1, 0.4); this._bell(this.sfxBus, t + 0.06, 91, 0.08, 0.5); this._jingle(this.sfxBus, t, 0.03); }
  _s_menuBack(t) { this._bell(this.sfxBus, t, 81, 0.08, 0.3); this._bell(this.sfxBus, t + 0.05, 76, 0.07, 0.4); }
  _s_countdown(t) { this._tone(this.sfxBus, t, { f: 784, type: 'square', dur: 0.14, vol: 0.08, rev: 0.2 }); }
  _s_go(t) { [72, 76, 79, 84].forEach((m, i) => this._bell(this.sfxBus, t + i * 0.05, m, 0.13, 0.9)); this._jingle(this.sfxBus, t, 0.08); this._jingle(this.sfxBus, t + 0.15, 0.06); }
  _s_tick(t) { this._tone(this.sfxBus, t, { f: 1500, type: 'square', dur: 0.03, vol: 0.06 }); }
  _s_scoop(t, o, d) {
    this._crunch(d, t, 0.32, 4, 700);
    this._noise(d, t + 0.05, { dur: 0.25, a: 0.04, vol: 0.12, type: 'lowpass', f: 1800, f2: 500 });
  }
  _s_pack(t, o, d) {
    this._crunch(d, t, 0.28, 3, 1300);
    this._crunch(d, t + 0.14, 0.24, 3, 1600);
    this._tone(d, t + 0.25, { f: 220, f2: 160, type: 'sine', dur: 0.06, vol: 0.12 });
  }
  _s_noSnow(t) { this._tone(this.sfxBus, t, { f: 240, f2: 180, type: 'square', dur: 0.12, vol: 0.06 }); }
  _s_throw(t, o, d) {
    const p = o.power ?? 0.8;
    this._noise(d, t, { dur: 0.22 + p * 0.12, a: 0.03, vol: 0.28, type: 'bandpass', f: 600, f2: 2800, q: 0.9 });
    this._tone(d, t, { f: 180, f2: 90, type: 'sine', dur: 0.08, vol: 0.06 });
  }
  _s_splat(t, o, d) {
    // snowball hitting snow / wall: soft poof
    this._noise(d, t, { dur: 0.2, a: 0.002, vol: 0.3, type: 'lowpass', f: 2400, f2: 300, q: 0.6, rev: 0.2 });
    this._crunch(d, t, 0.12, 2, 1100);
  }
  _s_hit(t, o, d) {
    // you hit someone: thud + happy ding
    this._noise(d, t, { dur: 0.18, a: 0.002, vol: 0.4, type: 'lowpass', f: 1800, f2: 200 });
    this._tone(d, t, { f: 160, f2: 60, type: 'sine', dur: 0.15, vol: 0.25 });
    this._bell(this.sfxBus, t + 0.04, 91, 0.1, 0.35);
    this._bell(this.sfxBus, t + 0.1, 96, 0.08, 0.4);
  }
  _s_hurt(t) {
    // you got hit: heavy thump + ice crackle
    this._noise(this.sfxBus, t, { dur: 0.3, a: 0.002, vol: 0.5, type: 'lowpass', f: 1200, f2: 120 });
    this._tone(this.sfxBus, t, { f: 110, f2: 40, type: 'sine', dur: 0.3, vol: 0.35 });
    for (let i = 0; i < 8; i++) this._noise(this.sfxBus, t + 0.1 + i * 0.04, { dur: 0.03, a: 0.001, vol: 0.08, type: 'highpass', f: 5000 + Math.random() * 3000 });
    [96, 91, 88].forEach((m, i) => this._tone(this.sfxBus, t + 0.15 + i * 0.07, { f: mtof(m), type: 'sine', dur: 0.4, vol: 0.04, rev: 0.8 }));
  }
  _s_thaw(t) {
    [76, 79, 84].forEach((m, i) => this._bell(this.sfxBus, t + i * 0.06, m, 0.07, 0.4));
    this._noise(this.sfxBus, t, { dur: 0.3, a: 0.05, vol: 0.1, type: 'bandpass', f: 3000, f2: 900, q: 1 });
  }
  _s_step(t, o, d) {
    const run = o.run ? 1 : 0;
    this._crunch(d, t, 0.06 + run * 0.03, 2, 600 + Math.random() * 300);
  }
  _s_grab(t, o, d) {
    [79, 83, 86, 91].forEach((m, i) => this._bell(d, t + i * 0.05, m, 0.12, 0.6));
    this._jingle(d, t, 0.07);
  }
  _s_stolen(t) {
    // alarm: our star was taken
    for (let i = 0; i < 3; i++) {
      this._tone(this.sfxBus, t + i * 0.18, { f: 880, type: 'square', dur: 0.08, vol: 0.07 });
      this._tone(this.sfxBus, t + i * 0.18 + 0.09, { f: 660, type: 'square', dur: 0.08, vol: 0.07 });
    }
  }
  _s_drop(t, o, d) { [84, 79, 76].forEach((m, i) => this._bell(d, t + i * 0.06, m, 0.08, 0.4)); }
  _s_return(t) { [72, 79, 84].forEach((m, i) => this._bell(this.sfxBus, t + i * 0.07, m, 0.09, 0.6)); }
  _s_capture(t, o) {
    const good = o.good !== false;
    const seq = good ? [72, 76, 79, 84, 88, 91, 96] : [76, 72, 67, 64];
    seq.forEach((m, i) => this._bell(this.sfxBus, t + i * 0.08, m, 0.14, 1.0));
    if (good) {
      for (let i = 0; i < 8; i++) this._jingle(this.sfxBus, t + i * 0.09, 0.06);
      this._tone(this.sfxBus, t, { f: mtof(36), type: 'sine', dur: 1.2, vol: 0.2 });
    } else {
      this._tone(this.sfxBus, t, { f: mtof(40), f2: mtof(33), type: 'sawtooth', dur: 0.9, vol: 0.05 });
    }
  }
  _s_respawn(t) { this._noise(this.sfxBus, t, { dur: 0.4, a: 0.1, vol: 0.12, type: 'bandpass', f: 600, f2: 3000, q: 1.5 }); this._bell(this.sfxBus, t + 0.3, 84, 0.08, 0.5); }
  _s_record(t) { [79, 83, 86, 91].forEach((m, i) => this._bell(this.sfxBus, t + i * 0.1, m, 0.13, 1.4)); }
  _s_finish(t, o) {
    const good = o.good !== false;
    const seq = good ? [72, 76, 79, 84, 88, 91, 96] : [72, 75, 79, 84];
    seq.forEach((m, i) => this._bell(this.sfxBus, t + i * 0.11, m, 0.14, 1.6));
    if (good) for (let i = 0; i < 10; i++) this._jingle(this.sfxBus, t + i * 0.1, 0.05);
    this._tone(this.sfxBus, t, { f: mtof(36), type: 'sine', dur: 1.8, vol: 0.2 });
  }

  // ------------------------------------------------------------------ ambience: alpine wind
  _startAmbience() {
    if (this._ambience || !this.ok) return;
    const c = this.ctx;
    const n = c.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
    const fl = c.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 420; fl.Q.value = 1.4;
    const g = c.createGain(); g.gain.value = 0.11;
    // gusts: slow LFOs on the level and the howl pitch
    const lfo = c.createOscillator(); lfo.frequency.value = 0.09;
    const lg = c.createGain(); lg.gain.value = 0.07;
    lfo.connect(lg).connect(g.gain);
    const lfo2 = c.createOscillator(); lfo2.frequency.value = 0.05;
    const lg2 = c.createGain(); lg2.gain.value = 220;
    lfo2.connect(lg2).connect(fl.frequency);
    n.connect(fl).connect(g).connect(this.ambBus);
    n.start(); lfo.start(); lfo2.start();
    this._ambience = { nextCrow: c.currentTime + 6 };
  }

  _ambienceTick(t) {
    const a = this._ambience;
    if (!a) return;
    if (t > a.nextCrow) {
      // distant bird call echoing in the valley
      const base = 1200 + Math.random() * 600;
      for (let i = 0; i < 2; i++) this._tone(this.ambBus, t + i * 0.22, { f: base, f2: base * 0.8, type: 'sine', a: 0.02, dur: 0.14, vol: 0.02, rev: 0.9 });
      a.nextCrow = t + 8 + Math.random() * 12;
    }
  }

  // ------------------------------------------------------------------ music
  playMusic(id, opts = {}) {
    this._wantSong = { id, opts };
    if (!this.ok) return;
    const def = SONGS[id];
    if (!def) return;
    if (this.song && this.song.id === id) return;
    const fade = opts.fade ?? 0.8;
    const c = this.ctx, t = c.currentTime;
    if (this.song) {
      const old = this.song.bus;
      old.gain.setTargetAtTime(0.0001, t, fade / 3);
      setTimeout(() => old.disconnect(), fade * 2000 + 200);
    }
    const bus = c.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.setTargetAtTime(1, t, fade / 3);
    bus.connect(this.musicBus);
    this.song = { id, def, bus, step: 0, next: t + 0.1 };
  }

  stopMusic(fadeSec = 0.8) {
    if (!this.song || !this.ctx) return;
    const old = this.song.bus;
    old.gain.setTargetAtTime(0.0001, this.ctx.currentTime, fadeSec / 3);
    setTimeout(() => old.disconnect(), fadeSec * 2000 + 200);
    this.song = null;
    this._wantSong = null;
  }

  _schedule() {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    this._ambienceTick(t);
    const s = this.song;
    if (!s) return;
    const d = s.def;
    const bpm = d.bpm * (1 + this.intensity * 0.12);
    const stepDur = 60 / bpm / 4;  // sixteenth
    while (s.next < t + LOOKAHEAD) {
      this._step(s, s.next, stepDur);
      s.next += stepDur;
      s.step++;
    }
  }

  _step(s, t, sd) {
    const d = s.def, b = s.bus;
    const st = s.step % 16;
    const bar = Math.floor(s.step / 16);
    const ch = d.chords[bar % d.chords.length];
    const I = this.intensity;
    // celesta arpeggio
    const pat = [0, 1, 2, 3, 2, 1, 3, 2];
    if (st % 2 === 0) this._bell(b, t, ch[pat[(st / 2) % 8]] + 24, 0.045, 0.5);
    // pizzicato bass
    if (st === 0 || st === 8 || (I > 0.4 && (st === 6 || st === 14))) this._pizz(b, t, ch[0] - 12, 0.16, sd * 3);
    if (st === 4 || st === 12) this._pizz(b, t, ch[2] - 12, 0.1, sd * 2);
    // string pad at bar start
    if (st === 0) for (const m of ch) this._tone(b, t, { f: mtof(m), type: 'sawtooth', a: 0.5, dur: sd * 15, vol: 0.006, rev: 0.6, detune: (Math.random() - 0.5) * 14 });
    // melody seeded by step for a stable phrase per bar
    const rnd = Math.sin((bar % 8) * 12.9898 + st * 78.233) * 43758.5453;
    const r = rnd - Math.floor(rnd);
    if ((st === 2 || st === 6 || st === 10 || (I > 0.3 && st === 14)) && r > 0.4) {
      const m = d.scale[Math.floor(r * d.scale.length)];
      this._bell(b, t, m, 0.06, 0.6);
    }
    if (!d.drums) { if (st === 0 || st === 8) this._jingle(b, t, 0.015); return; }
    // sleigh bells on the off-beats, kick and snare growing with intensity
    if (st % 2 === 1 || (I > 0.5 && st % 2 === 0)) this._jingle(b, t, 0.018 + I * 0.02);
    if (st === 0 || st === 8 || (I > 0.4 && st === 11)) this._tone(b, t, { f: 120, f2: 45, type: 'sine', a: 0.002, dur: 0.18, vol: 0.12 + I * 0.12 });
    if (st === 4 || st === 12) this._noise(b, t, { dur: 0.1, vol: 0.05 + I * 0.05, type: 'bandpass', f: 1900, q: 0.8 });
  }
}
