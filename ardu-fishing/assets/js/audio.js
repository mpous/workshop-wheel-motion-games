// Ardu Fishing — fully procedural Web Audio (no audio files): lake ambience,
// an adaptive acoustic soundtrack and every sound effect.
// Every public method is a safe no-op when Web Audio is unavailable or locked.

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
const MAX_SFX = 32;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// D major pentatonic over a gentle I–vi–IV–V style loop
const SONGS = {
  menu: { bpm: 84, chords: [[50, 54, 57, 62], [47, 50, 54, 59], [43, 47, 50, 55], [45, 49, 52, 57]], scale: [62, 64, 66, 69, 71, 74, 76, 78], drums: false },
  fishing: { bpm: 92, chords: [[50, 54, 57, 62], [45, 49, 52, 57], [47, 50, 54, 59], [43, 47, 50, 55]], scale: [62, 64, 66, 69, 71, 74, 76], drums: true },
  results: { bpm: 100, chords: [[43, 47, 50, 55], [45, 49, 52, 57], [50, 54, 57, 62], [50, 54, 57, 62]], scale: [67, 69, 71, 74, 76, 79], drums: true },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.vol = { master: 0.8, music: 0.6, sfx: 0.9 };
    this.active = 0;
    this.song = null;
    this.intensity = 0;     // 0 calm .. 1 fighting a fish
    this._reel = null;
    this._tension = null;
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
    // shared reverb (lake echo)
    this.verb = c.createConvolver();
    this.verb.buffer = this._ir(2.6);
    this.verbSend = c.createGain();
    this.verbSend.gain.value = 0.32;
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
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2);
    }
    return b;
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, v = this.vol;
    this.master.gain.setTargetAtTime(v.master, t, 0.03);
    this.musicBus.gain.setTargetAtTime(v.music * 0.55, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(v.sfx, t, 0.03);
    this.ambBus.gain.setTargetAtTime(v.sfx * 0.55, t, 0.03);
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

  // Karplus-like plucked string from a filtered noise burst + sine body
  _pluck(dest, t, midi, vol = 0.18, dur = 1.2) {
    const f = mtof(midi);
    this._tone(dest, t, { f, type: 'triangle', a: 0.002, dur, vol, rev: 0.5 });
    this._tone(dest, t, { f: f * 2, type: 'sine', a: 0.002, dur: dur * 0.4, vol: vol * 0.35, rev: 0.3 });
    this._noise(dest, t, { dur: 0.03, vol: vol * 0.5, f: f * 3, q: 4 });
  }

  play(name, opts = {}) {
    if (!this.ok || this.active > MAX_SFX) return;
    const fn = this['_s_' + name];
    if (!fn) return;
    this.active++;
    setTimeout(() => this.active--, 1500);
    try { fn.call(this, this.ctx.currentTime + 0.005, opts); } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------------ sfx
  _s_menuMove(t) { this._tone(this.sfxBus, t, { f: 880, type: 'sine', dur: 0.05, vol: 0.08 }); }
  _s_menuSelect(t) { this._pluck(this.sfxBus, t, 74, 0.14, 0.4); this._pluck(this.sfxBus, t + 0.06, 81, 0.12, 0.5); }
  _s_menuBack(t) { this._pluck(this.sfxBus, t, 69, 0.12, 0.3); this._pluck(this.sfxBus, t + 0.05, 62, 0.1, 0.4); }
  _s_countdown(t) { this._tone(this.sfxBus, t, { f: 660, type: 'square', dur: 0.14, vol: 0.09, rev: 0.2 }); }
  _s_go(t) { [74, 78, 81, 86].forEach((m, i) => this._pluck(this.sfxBus, t + i * 0.05, m, 0.16, 0.9)); }
  _s_tick(t) { this._tone(this.sfxBus, t, { f: 1500, type: 'square', dur: 0.03, vol: 0.06 }); }
  _s_whoosh(t, o) {
    const p = o.power ?? 0.7;
    this._noise(this.sfxBus, t, { dur: 0.35 + p * 0.2, a: 0.08, vol: 0.32, type: 'bandpass', f: 500, f2: 2600, q: 0.8 });
    // line zipping off the spool
    this._noise(this.sfxBus, t + 0.05, { dur: 0.6 + p * 0.4, a: 0.02, vol: 0.08, type: 'highpass', f: 4000, q: 0.5 });
  }
  _s_splash(t, o) {
    const big = o.big ?? 0.5;
    this._noise(this.sfxBus, t, { dur: 0.25 + big * 0.5, a: 0.004, vol: 0.25 + big * 0.25, type: 'lowpass', f: 2600, f2: 300, q: 0.7, rev: 0.4 });
    this._tone(this.sfxBus, t, { f: 300 + 200 * (1 - big), f2: 90, type: 'sine', dur: 0.18, vol: 0.18 });
  }
  _s_plop(t) {
    this._tone(this.sfxBus, t, { f: 520, f2: 1100, type: 'sine', a: 0.002, dur: 0.07, vol: 0.18, rev: 0.4 });
  }
  _s_nibble(t) {
    this._tone(this.sfxBus, t, { f: 900, f2: 600, type: 'sine', dur: 0.05, vol: 0.12 });
    this._tone(this.sfxBus, t + 0.09, { f: 820, f2: 560, type: 'sine', dur: 0.05, vol: 0.1 });
  }
  _s_bite(t) {
    // strike alarm: rising stab + bell
    this._noise(this.sfxBus, t, { dur: 0.3, vol: 0.35, type: 'lowpass', f: 3000, f2: 400, rev: 0.3 });
    [69, 76, 81].forEach((m, i) => this._tone(this.sfxBus, t + i * 0.07, { f: mtof(m), type: 'square', dur: 0.16, vol: 0.08, rev: 0.4 }));
  }
  _s_hook(t) { this._tone(this.sfxBus, t, { f: 200, f2: 60, type: 'sawtooth', dur: 0.2, vol: 0.2 }); this._s_splash(t, { big: 0.6 }); }
  _s_snap(t) {
    this._noise(this.sfxBus, t, { dur: 0.05, a: 0.001, vol: 0.55, type: 'highpass', f: 3000 });
    this._tone(this.sfxBus, t, { f: 1800, f2: 200, type: 'sawtooth', dur: 0.25, vol: 0.12, rev: 0.4 });
    [62, 61, 60].forEach((m, i) => this._tone(this.sfxBus, t + 0.25 + i * 0.16, { f: mtof(m), type: 'triangle', dur: 0.3, vol: 0.14 }));
  }
  _s_escape(t) {
    this._s_splash(t, { big: 0.4 });
    [64, 62, 57].forEach((m, i) => this._pluck(this.sfxBus, t + 0.15 + i * 0.13, m, 0.13, 0.6));
  }
  _s_unhook(t) {
    this._noise(this.sfxBus, t, { dur: 0.08, vol: 0.2, type: 'bandpass', f: 1800, q: 3 });
    this._tone(this.sfxBus, t + 0.02, { f: 2400, type: 'sine', dur: 0.12, vol: 0.08 });
  }
  _s_catch(t, o) {
    const r = o.rarity || 'common';
    const lead = { common: [74, 78, 81], uncommon: [74, 78, 81, 86], rare: [74, 78, 81, 86, 90], epic: [69, 74, 78, 81, 86, 90], legendary: [74, 78, 81, 86, 90, 93, 98] }[r] || [74, 78, 81];
    lead.forEach((m, i) => this._pluck(this.sfxBus, t + i * 0.08, m, 0.16, 1.1));
    if (r === 'epic' || r === 'legendary') {
      // shimmer
      for (let i = 0; i < 12; i++) this._tone(this.sfxBus, t + 0.4 + i * 0.05, { f: mtof(98 + (i % 4) * 2), type: 'sine', dur: 0.2, vol: 0.04, rev: 0.8 });
    }
  }
  _s_record(t) { [79, 83, 86, 91].forEach((m, i) => this._pluck(this.sfxBus, t + i * 0.1, m, 0.15, 1.4)); }
  _s_finish(t, o) {
    const good = o.good !== false;
    const seq = good ? [62, 66, 69, 74, 78, 81, 86] : [62, 65, 69, 74];
    seq.forEach((m, i) => this._pluck(this.sfxBus, t + i * 0.11, m, 0.17, 1.6));
    this._tone(this.sfxBus, t, { f: mtof(38), type: 'sine', dur: 1.8, vol: 0.2 });
  }
  _s_jump(t) { this._s_splash(t, { big: 0.3 }); }

  // ------------------------------------------------------------------ continuous: reel and line
  // speed 0..1 (crank rate), tension 0..1
  setReel(speed, tension) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    if (!this._reel) {
      // clicking ratchet: a pulse train through a resonant band
      const o = c.createOscillator(); o.type = 'square'; o.frequency.value = 20;
      const fl = c.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 3200; fl.Q.value = 6;
      const g = c.createGain(); g.gain.value = 0;
      o.connect(fl).connect(g).connect(this.sfxBus); o.start();
      // line strain: filtered noise rising with tension
      const n = c.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
      const nf = c.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 400; nf.Q.value = 8;
      const ng = c.createGain(); ng.gain.value = 0;
      n.connect(nf).connect(ng).connect(this.sfxBus); n.start();
      this._reel = { o, g, nf, ng };
    }
    const r = this._reel;
    r.o.frequency.setTargetAtTime(12 + speed * 38, t, 0.05);
    r.g.gain.setTargetAtTime(speed > 0.02 ? 0.05 + speed * 0.07 : 0, t, 0.04);
    r.nf.frequency.setTargetAtTime(300 + tension * 1400, t, 0.08);
    r.ng.gain.setTargetAtTime(tension > 0.35 ? (tension - 0.35) * 0.28 : 0, t, 0.08);
  }

  // ------------------------------------------------------------------ ambience
  _startAmbience() {
    if (this._ambience || !this.ok) return;
    const c = this.ctx;
    // lapping water: low-passed noise with a slow swell
    const n = c.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
    const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 520; fl.Q.value = 0.6;
    const g = c.createGain(); g.gain.value = 0.12;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.17;
    const lg = c.createGain(); lg.gain.value = 0.07;
    lfo.connect(lg).connect(g.gain);
    n.connect(fl).connect(g).connect(this.ambBus);
    n.start(); lfo.start();
    this._ambience = { nextBird: c.currentTime + 2, nextCricket: c.currentTime + 1 };
  }

  _ambienceTick(t) {
    const a = this._ambience;
    if (!a) return;
    if (t > a.nextBird) {
      // a little chirp phrase
      const base = 2400 + Math.random() * 1600, n = 2 + (Math.random() * 4 | 0);
      for (let i = 0; i < n; i++) {
        const s = t + i * (0.09 + Math.random() * 0.05);
        this._tone(this.ambBus, s, { f: base * (1 + Math.random() * 0.2), f2: base * (0.7 + Math.random() * 0.6), type: 'sine', a: 0.01, dur: 0.06, vol: 0.035, rev: 0.6 });
      }
      a.nextBird = t + 3 + Math.random() * 7;
    }
    if (t > a.nextCricket) {
      for (let i = 0; i < 3; i++) this._tone(this.ambBus, t + i * 0.045, { f: 4700, type: 'sine', a: 0.004, dur: 0.02, vol: 0.012 });
      a.nextCricket = t + 0.6 + Math.random() * 1.6;
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
    const bpm = d.bpm * (1 + this.intensity * 0.18);
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
    // fingerpicked guitar arpeggio
    const pat = [0, 2, 1, 3, 2, 1, 3, 2];
    if (st % 2 === 0) this._pluck(b, t, ch[pat[(st / 2) % 8]] + 12, 0.07, 0.9);
    // bass on 1 and the "and" of 2
    if (st === 0 || st === 6 || (I > 0.5 && st === 10)) this._tone(b, t, { f: mtof(ch[0] - 12), type: 'triangle', a: 0.01, dur: sd * 5, vol: 0.16 });
    // warm pad at bar start
    if (st === 0) for (const m of ch) this._tone(b, t, { f: mtof(m), type: 'sine', a: 0.4, dur: sd * 15, vol: 0.022, rev: 0.6, detune: (Math.random() - 0.5) * 10 });
    // little melody: seeded by step for a stable phrase per bar
    const rnd = Math.sin((bar % 8) * 12.9898 + st * 78.233) * 43758.5453;
    const r = rnd - Math.floor(rnd);
    if ((st === 4 || st === 12 || (I > 0.3 && st === 14)) && r > 0.35) {
      const m = d.scale[Math.floor(r * d.scale.length)];
      this._tone(b, t, { f: mtof(m), type: 'sine', a: 0.01, dur: sd * 4, vol: 0.05, rev: 0.7 });
    }
    if (!d.drums) return;
    // soft brush / shaker and a kick that grows with the fight
    if (st % 2 === 1 || I > 0.6) this._noise(b, t, { dur: 0.04, vol: 0.025 + I * 0.03, type: 'highpass', f: 6000 });
    if (st === 0 || st === 8 || (I > 0.4 && st === 11)) this._tone(b, t, { f: 120, f2: 45, type: 'sine', a: 0.002, dur: 0.18, vol: 0.12 + I * 0.15 });
    if (I > 0.25 && (st === 4 || st === 12)) this._noise(b, t, { dur: 0.12, vol: 0.06 + I * 0.06, type: 'bandpass', f: 1800, q: 0.8 });
  }
}
