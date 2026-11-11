// Q-Kart — fully procedural Web Audio engine (no audio files).
// Plain ES module, no dependencies. Every public method is a safe no-op when
// Web Audio is unavailable or not yet unlocked.

const LOOKAHEAD = 0.12;      // seconds scheduled ahead
const TICK_MS = 25;          // scheduler interval
const MAX_SFX = 40;          // simultaneous one-shot cap
const MAX_ENGINES = 8;       // simultaneous engine voices cap

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

const PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteToMidi(s) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(s);
  if (!m) return null;
  let pc = PCS[m[1].toUpperCase()];
  if (m[2] === '#') pc++;
  else if (m[2] === 'b') pc--;
  return 12 * (parseInt(m[3], 10) + 1) + pc;
}
const nf = (s) => mtof(noteToMidi(s));

const CHORD_Q = {
  '': [0, 4, 7], m: [0, 3, 7], '5': [0, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10], sus4: [0, 5, 7], sus2: [0, 2, 7], '7sus4': [0, 5, 7, 10],
  dim: [0, 3, 6], aug: [0, 4, 8], add9: [0, 4, 7, 14], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 14], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
  '7b9': [0, 4, 7, 10, 13], m7b5: [0, 3, 6, 10],
};

function parseChord(name) {
  const m = /^([A-G][#b]?)(.*)$/.exec(name.trim());
  if (!m) return parseChord('C');
  const pc = (((noteToMidi(m[1] + '4') - 60) % 12) + 12) % 12;
  const iv = CHORD_Q[m[2]] || CHORD_Q[''];
  const base = 48 + pc;
  const tones = [...new Set(iv.map((i) => {
    let n = base + i;
    while (n < 55) n += 12;
    while (n > 74) n -= 12;
    return n;
  }))].sort((a, b) => a - b);
  let bass = 36 + pc;
  if (bass > 43) bass -= 12;
  return { pc, tones, bass };
}

function parseDrum(str) {
  const s = (str || '').replace(/\s+/g, '');
  const a = new Float32Array(16);
  for (let i = 0; i < 16; i++) {
    const ch = s[i];
    a[i] = ch === 'X' ? 1.25 : ch === 'x' ? 1 : ch === 'o' ? 0.45 : 0;
  }
  return a;
}

// Token line: notes ("C#5") or numbers (intervals / indices), "." sustain, "-" rest.
// Token count 4/8/16 => quarter/eighth/sixteenth resolution.
function parseLine(str, numeric) {
  const out = new Array(16).fill(null);
  if (!str) return out;
  const toks = str.trim().split(/\s+/);
  const spt = 16 / toks.length;
  let last = null;
  toks.forEach((tk, i) => {
    const st = Math.round(i * spt);
    if (st > 15) return;
    if (tk === '.') { if (last) last.len += spt; return; }
    if (tk === '-') { last = null; return; }
    const v = numeric ? parseFloat(tk) : noteToMidi(tk);
    if (v == null || Number.isNaN(v)) { last = null; return; }
    last = { v, len: spt };
    out[st] = last;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Hand-authored songs
// ---------------------------------------------------------------------------
const TRACKS = {
  menu: {
    bpm: 118, swing: 0.16,
    lead: { type: 'square', vol: 0.12, cutoff: 3000, vib: 14, delay: 0.2, dbl: 12, oct: 0 },
    bass: { type: 'square', vol: 0.3, cutoff: 650, q: 5, pattern: '0 . - 0 12 - 0 - - 0 7 - 12 - 7 -' },
    pad: { vol: 0.022, cutoff: 1300, attack: 0.04 },
    stab: { pattern: '..x...x...x...x.', vol: 0.05, cutoff: 2600, type: 'square' },
    arp: { pattern: '0 - 1 - 2 - 1 - 3 - 2 - 1 - 2 -', type: 'pluck', vol: 0.05, oct: 12, min: 0.55 },
    drums: { kick: 'x..x....x.x..x..', snare: '....x..o....x..o', hatC: 'xoxoxoxoxoxoxoxo', hatO: '......x.......x.' },
    sections: {
      A: { chords: ['Cmaj7', 'Am7', 'Dm7', 'G7'],
        lead: ['E5 - G5 A5 - G5 E5 -', 'C5 . D5 E5 . . - -', 'F5 - A5 C6 - A5 F5 E5', 'D5 . . . B4 . G4 -'] },
      A2: { chords: ['Cmaj7', 'Am7', 'Fmaj7', 'G7'],
        lead: ['E5 - G5 A5 - G5 E5 -', 'C6 . B5 A5 . G5 - -', 'F5 - E5 D5 - F5 A5 -', 'G5 . . . . - - -'] },
      B: { chords: ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'],
        lead: ['A5 . . G5 A5 . C6 .', 'B5 . G5 . E5 . . -', 'F5 . . E5 F5 . A5 .', 'G5 . . . . . - -'],
        drums: { kick: 'x..x..x...x..x..' } },
      B2: { chords: ['Fmaj7', 'Em7', 'Dm7', 'G7sus4|G7'],
        lead: ['A5 . . G5 A5 . C6 .', 'D6 . C6 . B5 . G5 .', 'A5 . F5 . D5 . F5 .', 'G5 . A5 . B5 . D6 .'],
        drums: { kick: 'x..x..x...x..x..' } },
    },
    form: ['A', 'A2', 'B', 'B2'],
  },

  sunset: {
    bpm: 140, swing: 0,
    lead: { type: 'saw', vol: 0.1, cutoff: 3800, vib: 10, delay: 0.18, dbl: 12, oct: -12 },
    bass: { type: 'sawtooth', vol: 0.3, cutoff: 900, q: 4, pattern: '0 - 0 0 - 0 7 - 0 - 0 0 - 12 7 -' },
    pad: { vol: 0.02, cutoff: 1800, attack: 0.06 },
    arp: { pattern: '0 1 2 1 3 2 1 2', type: 'pluck', vol: 0.055, oct: 12, min: 0.4 },
    drums: { kick: 'x.....x.x.....x.', snare: '....x.......x...', hatC: 'x.x.x.x.x.x.x.x.', hatO: '..............x.', shaker: '.o.o.o.o.o.o.o.o' },
    sections: {
      A: { chords: ['D', 'A', 'Bm', 'G'],
        lead: ['A5 . F#5 A5 - B5 A5 F#5', 'E5 . . C#5 E5 . - -', 'D5 . F#5 . B5 . A5 F#5', 'G5 . . F#5 E5 . D5 .'] },
      A2: { chords: ['D', 'A', 'Bm', 'G|A'],
        lead: ['A5 . F#5 A5 - B5 A5 F#5', 'E5 . . A5 C#6 . - -', 'D6 . C#6 . B5 . A5 .', 'G5 . F#5 . E5 . . .'] },
      B: { chords: ['Gmaj7', 'A', 'F#m7', 'Bm7'],
        lead: ['B5 . . . D6 . B5 .', 'C#6 . . . E6 . C#6 .', 'A5 . . F#5 A5 . C#6 .', 'B5 . . . . . - -'],
        drums: { kick: 'x...x...x...x...', snare: '....x.......x.x.' } },
      B2: { chords: ['Gmaj7', 'A', 'Bm7|G', 'Asus4|A'],
        lead: ['B5 . . . D6 . B5 .', 'C#6 . . . E6 . F#6 .', 'D6 . C#6 B5 . . A5 G5', 'A5 . . . C#6 . E6 .'],
        drums: { kick: 'x...x...x...x...', snare: '....x.......x.x.' } },
    },
    form: ['A', 'A2', 'B', 'B2'],
  },

  neon: {
    bpm: 128, swing: 0, pump: 0.6,
    lead: { type: 'saw', vol: 0.11, cutoff: 3200, vib: 8, delay: 0.32, dbl: 12, oct: -12 },
    bass: { type: 'sawtooth', vol: 0.28, cutoff: 600, q: 6, pattern: '0 0 12 0 0 0 12 0 0 0 12 0 0 12 0 12' },
    pad: { vol: 0.03, cutoff: 1100, attack: 0.25, det: 14 },
    arp: { pattern: '0 1 2 3 4 3 2 1 0 1 2 3 4 3 2 1', type: 'pluck', vol: 0.055, oct: 0, min: 0.35, delay: true },
    drums: { kick: 'x...x...x...x...', snare: '....x.......x...', clap: '....x.......x...', hatC: 'x.x.x.x.x.x.x.x.', hatO: '..x...x...x...x.' },
    sections: {
      A: { chords: ['Am', 'F', 'C', 'G'],
        lead: ['A5 . . . C6 . B5 .', 'A5 . . . . . G5 .', 'E5 . . . G5 . C6 .', 'B5 . . . . . D6 .'] },
      A2: { chords: ['Am', 'F', 'G', 'E'],
        lead: ['A5 . . . C6 . B5 .', 'A5 . . . C6 . D6 .', 'B5 . . . D6 . G5 .', 'G#5 . . . . . B5 .'] },
      B: { chords: ['F', 'G', 'Em', 'Am'],
        lead: ['C6 . A5 . F5 . A5 C6', 'D6 . B5 . G5 . B5 D6', 'E6 . . D6 B5 . G5 .', 'A5 . . . . . - -'],
        drums: { hatC: 'xoxoxoxoxoxoxoxo' } },
      B2: { chords: ['F', 'G', 'Am', 'E'],
        lead: ['C6 . A5 . F5 . A5 C6', 'D6 . B5 . G5 . B5 D6', 'E6 . . . C6 . A5 .', 'B5 . . . G#5 . E5 .'],
        drums: { hatC: 'xoxoxoxoxoxoxoxo' } },
    },
    form: ['A', 'A2', 'B', 'B2'],
  },

  frost: {
    bpm: 150, swing: 0,
    lead: { type: 'bell', vol: 0.2, delay: 0.22, dbl: 12, oct: -12 },
    bass: { type: 'square', vol: 0.2, cutoff: 1400, q: 1, sub: 0.7, pattern: '0 - 12 - 0 - 12 - 0 - 12 - 7 - 12 -' },
    pad: { vol: 0.045, cutoff: 2400, attack: 0.1, type: 'triangle' },
    arp: { pattern: '0 1 2 3 0 1 2 3 1 2 3 4 1 2 3 4', type: 'chip', vol: 0.035, oct: 12, min: 0.3 },
    drums: { kick: 'x.......x.x.....', snare: '....x.......x...', hatC: 'xoxoxoxoxoxoxoxo' },
    sections: {
      A: { chords: ['G', 'D', 'Em', 'C'],
        lead: ['B5 . D6 . G6 . D6 .', 'F#6 . . E6 D6 . A5 .', 'G5 . B5 . E6 . D6 B5', 'C6 . . . E6 . . .'] },
      A2: { chords: ['G', 'D', 'C', 'D'],
        lead: ['B5 . D6 . G6 . D6 .', 'F#6 . . E6 D6 . F#6 .', 'G6 . E6 . C6 . E6 .', 'D6 . . . . . - -'] },
      B: { chords: ['C', 'D', 'Bm', 'Em'],
        lead: ['E6 . G6 . E6 . C6 .', 'F#6 . A6 . F#6 . D6 .', 'D6 . F#6 . B5 . D6 .', 'E6 . . . . . B5 .'],
        drums: { kick: 'x.....x.x.....x.', hatO: '..x...x...x...x.' } },
      B2: { chords: ['Am', 'D', 'G', 'D7'],
        lead: ['C6 . E6 . A6 . E6 .', 'F#6 . A6 . D6 . F#6 .', 'G6 . . . D6 . B5 .', 'C6 . . . A5 . F#5 .'],
        drums: { kick: 'x.....x.x.....x.', hatO: '..x...x...x...x.' } },
    },
    form: ['A', 'A2', 'B', 'B2'],
  },

  dunes: {
    bpm: 132, swing: 0.06,
    lead: { type: 'reed', vol: 0.13, cutoff: 3600, vib: 28, delay: 0.15, dbl: -12, oct: 0 },
    bass: { type: 'sawtooth', vol: 0.3, cutoff: 700, q: 4, pattern: '0 . - 0 . - 7 - 0 . - 0 - 7 12 -' },
    pad: { vol: 0.02, cutoff: 900, attack: 0.3 },
    arp: { pattern: '0 - 1 2 - 1 0 - 2 - 1 2 - 3 2 1', type: 'pluck', vol: 0.06, oct: 0, min: 0.45 },
    drums: { kick: 'x.......x.......', doum: 'x.......x.......', tek: '..x...x.o...x.o.', clap: '....x.......x...', shaker: 'xoxoxoxoxoxoxoxo' },
    sections: {
      A: { chords: ['E', 'F', 'Dm', 'E'],
        lead: ['E5 . F5 E5 G#5 . . . B5 . A5 G#5 F5 . E5 .', 'F5 . . . A5 G#5 F5 E5', 'D5 . F5 . A5 . C6 B5', 'G#5 . . F5 E5 . . .'] },
      A2: { chords: ['E', 'F', 'G|F', 'E'],
        lead: ['E5 . F5 E5 G#5 . . . B5 . C6 B5 A5 . G#5 .', 'A5 . C6 . F6 . E6 .', 'D6 . B5 . C6 . A5 .', 'B5 . G#5 . F5 . E5 .'] },
      B: { chords: ['Am', 'Dm', 'F', 'E'],
        lead: ['A5 . . . C6 B5 A5 G#5', 'A5 . . . F5 . D5 .', 'C6 . . . A5 C6 B5 A5', 'G#5 . . . B5 . . .'],
        drums: { doum: 'x.....x.x.......', tek: '..x.x.x...x.x.xx' } },
      B2: { chords: ['Am', 'G', 'F', 'E7'],
        lead: ['E6 . . . C6 . A5 .', 'D6 . . . B5 . G5 .', 'C6 . A5 . F5 . A5 .', 'B5 . G#5 . F5 . E5 .'],
        drums: { doum: 'x.....x.x.......', tek: '..x.x.x...x.x.xx' } },
    },
    form: ['A', 'A2', 'B', 'B2'],
  },

  results: {
    bpm: 100, swing: 0.28,
    lead: { type: 'ep', vol: 0.2, delay: 0.2, dbl: 12, oct: -12 },
    bass: { type: 'triangle', vol: 0.42, cutoff: 900, q: 2, sub: 0.8, pattern: '0 . . - - 0 7 . 12 . - 7 - - 0 -' },
    pad: { vol: 0.025, cutoff: 1200, attack: 0.12 },
    stab: { pattern: '...x.....x.x....', vol: 0.035, cutoff: 1800, type: 'triangle' },
    arp: { pattern: '0 - 2 - 1 - 3 - 2 - 4 - 3 - 1 -', type: 'pluck', vol: 0.035, oct: 12, min: 0.5 },
    drums: { kick: 'x......x..x.....', snare: '....x.......x...', hatC: 'x.x.x.x.x.x.x.x.' },
    sections: {
      A: { chords: ['Fmaj7', 'Am7', 'Bbmaj7', 'C7'],
        lead: ['C6 . A5 . F5 . G5 A5', 'G5 . E5 . . . - -', 'F5 . D5 . F5 . A5 .', 'G5 . . . E5 . . .'] },
      A2: { chords: ['Fmaj7', 'Am7', 'Bbmaj7', 'C7'],
        lead: ['C6 . A5 . F5 . G5 A5', 'C6 . E6 . D6 . C6 .', 'D6 . . . A5 . F5 .', 'E5 . G5 . Bb5 . . .'] },
      B: { chords: ['Dm7', 'Gm7', 'Bbmaj7', 'C7sus4|C7'],
        lead: ['A5 . . F5 A5 . C6 .', 'Bb5 . . . D6 . . .', 'A5 . . . F5 . D5 .', 'F5 . . . E5 . G5 .'] },
      B2: { chords: ['Dm7', 'Gm7', 'Bbmaj7', 'C7'],
        lead: ['A5 . . F5 A5 . D6 .', 'D6 . C6 . Bb5 . G5 .', 'A5 . . . . . F5 .', 'G5 . . . . . - -'] },
    },
    form: ['A', 'A2', 'B', 'B2'],
  },
};

const DRUM_KEYS = ['kick', 'snare', 'clap', 'hatC', 'hatO', 'shaker', 'doum', 'tek'];

function buildTrack(def) {
  const sections = {};
  for (const name of Object.keys(def.sections)) {
    const sec = def.sections[name];
    const dsrc = Object.assign({}, def.drums, sec.drums || {});
    const drums = {};
    for (const k of DRUM_KEYS) drums[k] = parseDrum(dsrc[k]);
    const bars = sec.chords.map((cs, i) => {
      const parts = cs.split('|');
      const chords = parts.map((p, j) => ({ at: (j * 16) / parts.length, ch: parseChord(p) }));
      return {
        chords,
        lead: parseLine(sec.lead && sec.lead[i]),
        bass: parseLine((sec.bass && sec.bass[i]) || def.bass.pattern, true),
      };
    });
    sections[name] = { bars, drums };
  }
  return {
    def,
    sections,
    arp: def.arp ? parseLine(def.arp.pattern, true) : null,
    stab: def.stab ? parseDrum(def.stab.pattern) : null,
  };
}

// Engine gear map (speed01 thresholds)
const GEARS = [0, 0.2, 0.42, 0.66, 0.9, 1.5];

function disc(...nodes) {
  for (const n of nodes) { try { n && n.disconnect(); } catch (e) { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Engine voice
// ---------------------------------------------------------------------------
class EngineVoice {
  constructor(eng, opts, dead = false) {
    this._e = eng;
    this._ch = (((num(opts && opts.character, 0) | 0) % 8) + 8) % 8;
    this._n = null;
    this._dead = dead;
    this._lt = -1;
    this._gear = 0;
    this._shiftUntil = 0;
  }

  _build() {
    const e = this._e, c = e._ctx;
    if (!c || !e._engineBus) return false;
    if (this._n) return true;
    const ch = this._ch;
    const n = { base: 34 + ch * 3.3 };
    n.out = c.createGain(); n.out.gain.value = 0;
    n.tail = n.out;
    if (c.createStereoPanner) { n.pan = c.createStereoPanner(); n.out.connect(n.pan); n.tail = n.pan; }
    n.tail.connect(e._engineBus);

    // Tonal core: detuned saws + square sub -> waveshaper -> lowpass
    n.mix = c.createGain(); n.mix.gain.value = 0.6;
    n.ws = c.createWaveShaper(); n.ws.curve = e._curve(2.2 + ch * 0.45); n.ws.oversample = '2x';
    n.lp = c.createBiquadFilter(); n.lp.type = 'lowpass'; n.lp.frequency.value = 600; n.lp.Q.value = 1.4 + (ch % 3) * 0.6;
    n.amp = c.createGain(); n.amp.gain.value = 0;
    n.mix.connect(n.ws); n.ws.connect(n.lp); n.lp.connect(n.amp); n.amp.connect(n.out);
    const mk = (type, gain, detune) => {
      const o = c.createOscillator(); o.type = type; o.frequency.value = n.base * 1.5; o.detune.value = detune;
      const g = c.createGain(); g.gain.value = gain; o.connect(g); g.connect(n.mix);
      return o;
    };
    n.o1 = mk('sawtooth', 0.5, -4);
    n.o2 = mk(ch % 2 ? 'square' : 'sawtooth', 0.38, 8 + ch * 2);
    n.o3 = mk('square', 0.34, 0);
    // "chug" amplitude modulation at firing rate
    n.lfo = c.createOscillator(); n.lfo.type = 'sine'; n.lfo.frequency.value = 20;
    n.lfoG = c.createGain(); n.lfoG.gain.value = 0.22 + (ch % 4) * 0.03;
    n.lfo.connect(n.lfoG); n.lfoG.connect(n.mix.gain);

    // Shared noise source for all noisy layers
    n.noise = c.createBufferSource(); n.noise.buffer = e._noiseBuf; n.noise.loop = true;
    // Rumble
    n.rlp = c.createBiquadFilter(); n.rlp.type = 'lowpass'; n.rlp.frequency.value = 150;
    n.rg = c.createGain(); n.rg.gain.value = 0;
    n.noise.connect(n.rlp); n.rlp.connect(n.rg); n.rg.connect(n.out);
    // Gravel (offroad), amplitude-chopped for crunch
    n.gbp = c.createBiquadFilter(); n.gbp.type = 'bandpass'; n.gbp.frequency.value = 900; n.gbp.Q.value = 0.6;
    n.gmod = c.createGain(); n.gmod.gain.value = 1;
    n.glfo = c.createOscillator(); n.glfo.type = 'square'; n.glfo.frequency.value = 17 + ch;
    n.glfoG = c.createGain(); n.glfoG.gain.value = 0.45;
    n.glfo.connect(n.glfoG); n.glfoG.connect(n.gmod.gain);
    n.gg = c.createGain(); n.gg.gain.value = 0;
    n.noise.connect(n.gbp); n.gbp.connect(n.gmod); n.gmod.connect(n.gg); n.gg.connect(n.out);
    // Tire squeal: resonant noise + wobbly triangle
    n.sbp = c.createBiquadFilter(); n.sbp.type = 'bandpass'; n.sbp.frequency.value = 2500 + ch * 70; n.sbp.Q.value = 10;
    n.slfo = c.createOscillator(); n.slfo.type = 'sine'; n.slfo.frequency.value = 6.5 + ch * 0.2;
    n.slfoG = c.createGain(); n.slfoG.gain.value = 320;
    n.slfo.connect(n.slfoG); n.slfoG.connect(n.sbp.frequency);
    n.tri = c.createOscillator(); n.tri.type = 'triangle'; n.tri.frequency.value = 1500 + ch * 45;
    n.slfoG2 = c.createGain(); n.slfoG2.gain.value = 55;
    n.slfo.connect(n.slfoG2); n.slfoG2.connect(n.tri.frequency);
    n.triG = c.createGain(); n.triG.gain.value = 0.25;
    n.sg = c.createGain(); n.sg.gain.value = 0;
    n.noise.connect(n.sbp); n.sbp.connect(n.sg); n.tri.connect(n.triG); n.triG.connect(n.sg); n.sg.connect(n.out);
    // Boost jet / whoosh
    n.bbp = c.createBiquadFilter(); n.bbp.type = 'bandpass'; n.bbp.frequency.value = 1200; n.bbp.Q.value = 0.7;
    n.blp = c.createBiquadFilter(); n.blp.type = 'lowpass'; n.blp.frequency.value = 320;
    n.bg = c.createGain(); n.bg.gain.value = 0;
    n.noise.connect(n.bbp); n.bbp.connect(n.bg); n.noise.connect(n.blp); n.blp.connect(n.bg); n.bg.connect(n.out);

    const t = c.currentTime;
    n.srcs = [n.o1, n.o2, n.o3, n.lfo, n.glfo, n.slfo, n.tri, n.noise];
    for (const s of n.srcs) {
      if (s === n.noise) s.start(t, Math.random() * 1.5); else s.start(t);
    }
    this._n = n;
    return true;
  }

  update(p = {}) {
    if (this._dead) return;
    const c = this._e._ctx;
    if (!c) return;
    try {
      if (!this._n && !this._build()) return;
      const now = c.currentTime;
      if (now - this._lt < 0.025) return;
      this._lt = now;
      const n = this._n;
      p = p || {};
      const speed = clamp(num(p.speed01, 0), 0, 1.4);
      const thr = clamp(num(p.throttle, 0), -1, 1), th = Math.max(0, thr);
      const boost = !!p.boosting, drift = !!p.drifting, air = !!p.airborne, off = !!p.offroad;
      const gain = clamp(num(p.gain, 1), 0, 1.5), pan = clamp(num(p.pan, 0), -1, 1);

      // Gear selection with hysteresis
      let g = 0;
      while (g < GEARS.length - 2 && speed >= GEARS[g + 1]) g++;
      if (g < this._gear && speed > GEARS[this._gear] - 0.035) g = this._gear;
      const lo = GEARS[g], hi = GEARS[g + 1];
      const frac = clamp((speed - lo) / (hi - lo), 0, 1);
      let rpm = g === 0 ? 0.18 + frac * 0.82 : 0.42 + frac * 0.58;
      if (speed < 0.03) rpm = 0.14 + th * 0.3;
      rpm += th * 0.06;
      if (air) rpm += 0.22 * th + 0.05;
      if (boost) rpm += 0.12;
      if (thr < 0) rpm -= 0.05 * -thr;
      let tc = 0.06;
      if (g > this._gear && speed > 0.05) this._shiftUntil = now + 0.08;
      this._gear = g;
      const shifting = now < this._shiftUntil;
      if (shifting) tc = 0.09;

      const f = n.base * (1 + rpm * 2.5) * (boost ? 1.06 : 1);
      n.o1.frequency.setTargetAtTime(f, now, tc);
      n.o2.frequency.setTargetAtTime(f * 1.003, now, tc);
      n.o3.frequency.setTargetAtTime(f * 0.5, now, tc);
      n.lfo.frequency.setTargetAtTime(f * 0.5, now, tc);

      const cutoff = (350 + 3200 * rpm * (0.35 + 0.65 * th) + (boost ? 1800 : 0)) * (air ? 0.72 : 1);
      n.lp.frequency.setTargetAtTime(clamp(cutoff, 120, 9000), now, 0.06);
      const ampv = (0.1 + 0.13 * th + 0.06 * Math.min(speed, 1)) * (shifting ? 0.5 : 1) * (boost ? 1.2 : 1);
      n.amp.gain.setTargetAtTime(ampv, now, shifting ? 0.02 : 0.05);
      n.rg.gain.setTargetAtTime(air ? 0 : 0.1 + 0.2 * Math.min(speed, 1), now, 0.08);
      n.gg.gain.setTargetAtTime(off && !air ? 0.3 * Math.min(1, speed * 1.6 + 0.1) : 0, now, 0.06);
      n.gbp.frequency.setTargetAtTime(700 + speed * 900, now, 0.1);
      n.sg.gain.setTargetAtTime(drift && !air && speed > 0.15 ? 0.12 : 0, now, 0.07);
      n.bg.gain.setTargetAtTime(boost ? 0.24 : 0, now, boost ? 0.04 : 0.15);
      n.bbp.frequency.setTargetAtTime(900 + speed * 1400, now, 0.1);
      n.out.gain.setTargetAtTime(gain, now, 0.08);
      if (n.pan) n.pan.pan.setTargetAtTime(pan, now, 0.06);
    } catch (err) { this._e._report(err); }
  }

  stop() {
    if (this._dead) return;
    this._dead = true;
    this._e._engines.delete(this);
    const n = this._n, c = this._e._ctx;
    if (!n || !c) return;
    try {
      n.out.gain.setTargetAtTime(0, c.currentTime, 0.04);
      setTimeout(() => {
        for (const s of n.srcs) { try { s.stop(); } catch (e) { /* ignore */ } }
        disc(n.out, n.pan);
      }, 350);
    } catch (err) { this._e._report(err); }
  }
}

// ---------------------------------------------------------------------------
// Audio engine
// ---------------------------------------------------------------------------
export class AudioEngine {
  constructor() {
    this._ctx = null;
    this._vol = { master: 0.85, music: 0.55, sfx: 0.9 };
    this._intensity = 0.7;
    this._tempoScale = 1;
    this._songs = [];
    this._timer = null;
    this._engines = new Set();
    this._activeSfx = 0;
    this._rou = 0;
    this._pendingMusic = null;
    this._trackCache = {};
    this._curves = {};
  }

  get ctx() { return this._ctx; }

  _report(e) {
    try { if (typeof AudioEngine.onError === 'function') AudioEngine.onError(e); } catch (x) { /* ignore */ }
  }

  unlock() {
    try {
      if (this._ctx) {
        if (this._ctx.state === 'suspended' && this._ctx.resume) {
          const pr = this._ctx.resume(); if (pr && pr.catch) pr.catch(() => {});
        }
        return;
      }
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      let ctx;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      this._ctx = ctx;
      try { this._build(); } catch (e) { this._ctx = null; this._report(e); try { ctx.close && ctx.close(); } catch (x) { /* */ } return; }
      if (ctx.state === 'suspended' && ctx.resume) {
        const pr = ctx.resume(); if (pr && pr.catch) pr.catch(() => {});
      }
      if (this._pendingMusic) {
        const p = this._pendingMusic; this._pendingMusic = null;
        this.playMusic(p.id, p.opts);
      }
    } catch (e) { this._report(e); }
  }

  _build() {
    const c = this._ctx;
    this._master = c.createGain();
    this._comp = c.createDynamicsCompressor();
    this._comp.threshold.value = -14; this._comp.knee.value = 18; this._comp.ratio.value = 4;
    this._comp.attack.value = 0.004; this._comp.release.value = 0.22;
    this._master.connect(this._comp); this._comp.connect(c.destination);

    this._musicGain = c.createGain();
    this._duck = c.createGain(); this._duck.gain.value = 1;
    this._duck.connect(this._musicGain); this._musicGain.connect(this._master);

    this._sfxGain = c.createGain(); this._sfxGain.connect(this._master);
    this._engineBus = c.createGain(); this._engineBus.gain.value = 0.6; this._engineBus.connect(this._sfxGain);

    // Noise + reverb
    const len = Math.floor(c.sampleRate * 2);
    this._noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this._rev = c.createConvolver();
    this._rev.buffer = this._makeIR(2.2);
    this._revIn = c.createGain();
    this._revOut = c.createGain(); this._revOut.gain.value = 0.32;
    this._revIn.connect(this._rev); this._rev.connect(this._revOut); this._revOut.connect(this._master);
    // music send is post-fader; sfx sends pass a pre-scaled bus that tracks sfx volume
    this._musicSend = c.createGain(); this._musicSend.gain.value = 0.22;
    this._musicGain.connect(this._musicSend); this._musicSend.connect(this._revIn);
    this._sfxRevPre = c.createGain(); this._sfxRevPre.connect(this._revIn);

    this._applyVolumes(0);
  }

  _makeIR(sec) {
    const c = this._ctx, rate = c.sampleRate, len = Math.floor(rate * sec);
    const buf = c.createBuffer(2, len, rate);
    const pre = Math.floor(rate * 0.012);
    for (let chn = 0; chn < 2; chn++) {
      const d = buf.getChannelData(chn);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        if (i < pre) { d[i] = 0; continue; }
        const tt = i / len;
        const env = Math.pow(1 - tt, 3.2) * Math.min(1, (i - pre) / (rate * 0.008));
        lp += (Math.random() * 2 - 1 - lp) * (0.18 + 0.7 * (1 - tt));
        d[i] = lp * env;
      }
    }
    return buf;
  }

  _curve(k) {
    const key = Math.round(k * 10);
    if (this._curves[key]) return this._curves[key];
    const n = 1024, cv = new Float32Array(n), kk = key / 10;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      cv[i] = ((1 + kk) * x) / (1 + kk * Math.abs(x));
    }
    this._curves[key] = cv;
    return cv;
  }

  _applyVolumes(tc = 0.03) {
    const c = this._ctx; if (!c || !this._master) return;
    const now = c.currentTime, v = this._vol;
    const set = (p, x) => { if (tc > 0) p.setTargetAtTime(x, now, tc); else p.value = x; };
    set(this._master.gain, v.master);
    set(this._musicGain.gain, v.music);
    set(this._sfxGain.gain, v.sfx);
    set(this._sfxRevPre.gain, v.sfx);
  }

  setVolumes(v = {}) {
    try {
      v = v || {};
      for (const k of ['master', 'music', 'sfx']) {
        if (typeof v[k] === 'number' && Number.isFinite(v[k])) this._vol[k] = clamp(v[k], 0, 1);
      }
      this._applyVolumes();
    } catch (e) { this._report(e); }
  }

  // ------------------------------------------------------------------ engines
  createEngine(opts = { character: 0 }) {
    try {
      if (this._engines.size >= MAX_ENGINES) return new EngineVoice(this, opts, true);
      const v = new EngineVoice(this, opts || {});
      this._engines.add(v);
      return v;
    } catch (e) {
      this._report(e);
      return { update() {}, stop() {} };
    }
  }

  // ------------------------------------------------------------------ primitives
  _shaper(k) {
    const ws = this._ctx.createWaveShaper(); ws.curve = this._curve(k); ws.oversample = '2x';
    return ws;
  }

  _env(param, t, a, peak, dur) {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    param.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, a + 0.01));
  }

  _vib(o, t, rate, cents, dur, delay = 0) {
    const c = this._ctx;
    const l = c.createOscillator(); l.type = 'sine'; l.frequency.value = rate;
    const lg = c.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(cents, t + Math.max(0.01, delay));
    l.connect(lg); lg.connect(o.detune);
    l.start(t); l.stop(t + dur + 0.1);
    l.onended = () => disc(lg);
    return l;
  }

  _osc(dest, t, p) {
    const c = this._ctx;
    const o = c.createOscillator(); o.type = p.type || 'sine';
    const dur = p.dur || 0.2;
    o.frequency.setValueAtTime(p.f, t);
    if (p.f2) o.frequency.exponentialRampToValueAtTime(p.f2, t + (p.glide || dur));
    if (p.detune) o.detune.value = p.detune;
    const g = c.createGain();
    this._env(g.gain, t, p.a == null ? 0.004 : p.a, p.vol == null ? 0.3 : p.vol, dur);
    let node = o, flt = null;
    if (p.lp) { flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = p.lp; flt.Q.value = p.q || 0.7; o.connect(flt); node = flt; }
    if (p.shape) { const ws = this._shaper(p.shape); node.connect(ws); node = ws; }
    node.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
    o.onended = () => disc(g, flt);
    if (p.vib) this._vib(o, t, p.vibRate || 6, p.vib, dur, p.vibDelay || 0);
    return o;
  }

  _noise(dest, t, p) {
    const c = this._ctx;
    const src = c.createBufferSource(); src.buffer = this._noiseBuf; src.loop = true;
    const dur = p.dur || 0.2;
    let node = src, f = null;
    if (p.ft) {
      f = c.createBiquadFilter(); f.type = p.ft;
      f.frequency.setValueAtTime(p.f || 1000, t);
      if (p.f2) f.frequency.exponentialRampToValueAtTime(p.f2, t + (p.glide || dur));
      f.Q.value = p.q == null ? 0.8 : p.q;
      src.connect(f); node = f;
    }
    if (p.shape) { const ws = this._shaper(p.shape); node.connect(ws); node = ws; }
    const g = c.createGain();
    this._env(g.gain, t, p.a == null ? 0.003 : p.a, p.vol == null ? 0.3 : p.vol, dur);
    node.connect(g); g.connect(dest);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
    src.onended = () => disc(g, f);
    return { src, f, g };
  }

  _bell(dest, t, f, dur, vol, ratio = 3.5, index = 1.6) {
    const c = this._ctx;
    const car = c.createOscillator(); car.type = 'sine'; car.frequency.value = f;
    const mod = c.createOscillator(); mod.type = 'sine'; mod.frequency.value = f * ratio;
    const mg = c.createGain();
    mg.gain.setValueAtTime(f * index, t);
    mg.gain.exponentialRampToValueAtTime(f * index * 0.03 + 0.01, t + dur * 0.7);
    mod.connect(mg); mg.connect(car.frequency);
    const g = c.createGain(); this._env(g.gain, t, 0.002, vol, dur);
    car.connect(g); g.connect(dest);
    car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
    car.onended = () => disc(g, mg);
  }

  _brass(dest, t, f, dur, vol) {
    const c = this._ctx;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = 2;
    flt.frequency.setValueAtTime(f * 1.5, t);
    flt.frequency.linearRampToValueAtTime(Math.min(9000, f * 7), t + 0.05);
    flt.frequency.setTargetAtTime(Math.min(6000, f * 4), t + 0.06, 0.15);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.025);
    g.gain.setTargetAtTime(vol * 0.75, t + 0.05, 0.1);
    g.gain.setTargetAtTime(0.0001, t + dur, 0.06);
    flt.connect(g); g.connect(dest);
    let last;
    for (const dt of [-7, 6]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = dt;
      o.connect(flt); o.start(t); o.stop(t + dur + 0.45);
      if (dur > 0.3) this._vib(o, t, 5.5, 12, dur, 0.25);
      last = o;
    }
    last.onended = () => disc(g, flt);
  }

  _begin(o, rev, dur) {
    const c = this._ctx;
    if (!c || !this._sfxGain || this._activeSfx >= MAX_SFX) return null;
    const out = c.createGain(); out.gain.value = clamp(num(o.vol, 1), 0, 2);
    let tail = out;
    if (c.createStereoPanner) {
      const p = c.createStereoPanner(); p.pan.value = clamp(num(o.pan, 0), -1, 1);
      out.connect(p); tail = p;
    }
    tail.connect(this._sfxGain);
    let send = null;
    if (rev > 0) { send = c.createGain(); send.gain.value = rev; tail.connect(send); send.connect(this._sfxRevPre); }
    this._activeSfx++;
    setTimeout(() => { this._activeSfx--; disc(out, tail !== out ? tail : null, send); }, (dur + 0.6) * 1000);
    return { t: c.currentTime + 0.01, out };
  }

  // ------------------------------------------------------------------ SFX
  play(name, opts = {}) {
    try {
      if (!this._ctx || !this._sfxGain) return;
      const fn = this['_s_' + name];
      if (typeof fn === 'function') fn.call(this, opts || {});
    } catch (e) { this._report(e); }
  }

  _s_countdown(o) {
    const S = this._begin(o, 0.12, 0.5); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'square', f: 587.33, dur: 0.3, vol: 0.16, lp: 3500 });
    this._osc(out, t, { type: 'sine', f: 587.33, dur: 0.36, vol: 0.32 });
    this._osc(out, t, { type: 'sine', f: 1174.66, dur: 0.12, vol: 0.08 });
  }

  _s_go(o) {
    const S = this._begin(o, 0.25, 1.3); if (!S) return; const { t, out } = S;
    for (const f of [1174.66, 1479.98, 1760]) this._osc(out, t, { type: 'square', f, dur: 0.95, vol: 0.075, lp: 5200, vib: 10, vibDelay: 0.3 });
    this._osc(out, t, { type: 'sine', f: 587.33, dur: 1.05, vol: 0.3 });
    this._osc(out, t, { type: 'sawtooth', f: 293.66, dur: 0.7, vol: 0.08, lp: 1500 });
    this._noise(out, t, { ft: 'highpass', f: 6000, dur: 0.45, vol: 0.07 });
  }

  _s_itemBox(o) {
    const S = this._begin(o, 0.3, 0.9); if (!S) return; const { t, out } = S;
    this._noise(out, t, { ft: 'highpass', f: 3500, dur: 0.35, vol: 0.3, a: 0.001 });
    this._osc(out, t, { type: 'sine', f: 300, f2: 120, dur: 0.1, vol: 0.2 });
    const shards = [2380, 3170, 4410, 2890, 5230, 3720, 6080, 2610];
    shards.forEach((f, i) => this._osc(out, t + i * 0.012, { type: i % 2 ? 'triangle' : 'sine', f, f2: f * 0.96, dur: 0.08 + (i % 3) * 0.07, vol: 0.07 }));
    ['C6', 'E6', 'G6', 'C7', 'E7'].forEach((n, i) => this._bell(out, t + 0.05 + i * 0.035, nf(n), 0.4, 0.1, 3.01, 1.2));
  }

  _s_roulette(o) {
    const S = this._begin(o, 0.05, 0.1); if (!S) return; const { t, out } = S;
    const fs = [1568, 1760, 2093, 1760];
    const f = fs[this._rou++ % fs.length];
    this._osc(out, t, { type: 'square', f, dur: 0.035, vol: 0.08, lp: 6000, a: 0.001 });
    this._osc(out, t, { type: 'sine', f: f * 2, dur: 0.02, vol: 0.04, a: 0.001 });
  }

  _s_itemGet(o) {
    const S = this._begin(o, 0.3, 0.9); if (!S) return; const { t, out } = S;
    ['G5', 'D6', 'G6'].forEach((n, i) => {
      this._bell(out, t + i * 0.06, nf(n), 0.6, 0.13, 3.5, 1.1);
      this._osc(out, t + i * 0.06, { type: 'triangle', f: nf(n), dur: 0.35, vol: 0.06 });
    });
  }

  _s_boost(o) {
    const S = this._begin(o, 0.15, 1.1); if (!S) return; const { t, out } = S;
    this._noise(out, t, { ft: 'bandpass', f: 300, f2: 2800, glide: 0.35, q: 1.2, dur: 0.9, vol: 0.45, a: 0.02 });
    this._noise(out, t, { ft: 'lowpass', f: 400, dur: 0.8, vol: 0.35, a: 0.01 });
    this._osc(out, t, { type: 'sawtooth', f: 70, f2: 140, dur: 0.7, vol: 0.2, lp: 600, shape: 3 });
    this._osc(out, t, { type: 'sine', f: 200, f2: 70, dur: 0.3, vol: 0.32 });
  }

  _miniTurbo(o, lvl) {
    const S = this._begin(o, 0.12 + lvl * 0.04, 1.2); if (!S) return; const { t, out } = S;
    const k = 0.75 + lvl * 0.25;
    this._noise(out, t, { ft: 'lowpass', f: 2500 + lvl * 800, dur: 0.07, vol: 0.45 * k, a: 0.001 });
    this._osc(out, t, { type: 'sine', f: 160 + lvl * 25, f2: 55, dur: 0.15 + lvl * 0.03, vol: 0.45 * k });
    this._noise(out, t + 0.02, { ft: 'bandpass', f: 500, f2: 1500 + lvl * 800, q: 1.4, dur: 0.25 + lvl * 0.15, vol: 0.22 + 0.1 * lvl, a: 0.02 });
    if (lvl >= 2) this._osc(out, t, { type: 'sawtooth', f: 90, f2: 200, dur: 0.35 + lvl * 0.1, vol: 0.12, lp: 900, shape: 3 });
    if (lvl >= 3) {
      this._bell(out, t + 0.03, nf('C7'), 0.35, 0.07, 3.01, 1);
      this._bell(out, t + 0.07, nf('G7'), 0.35, 0.05, 3.01, 1);
    }
  }
  _s_miniTurbo1(o) { this._miniTurbo(o, 1); }
  _s_miniTurbo2(o) { this._miniTurbo(o, 2); }
  _s_miniTurbo3(o) { this._miniTurbo(o, 3); }

  _s_driftSpark(o) {
    const lvl = clamp(num(o.level, 1) | 0, 1, 3);
    const S = this._begin(o, 0.2, 0.5); if (!S) return; const { t, out } = S;
    const f = [0, 1318.5, 1760, 2349.3][lvl];
    this._bell(out, t, f, 0.32, 0.13, 3.0, 1.0);
    this._osc(out, t, { type: 'sine', f: f * 1.5, dur: 0.15, vol: 0.05 });
    this._noise(out, t, { ft: 'highpass', f: 5000, dur: 0.08, vol: 0.09, a: 0.001 });
    if (lvl === 3) this._bell(out, t + 0.05, f * 1.335, 0.3, 0.09, 3.0, 1.0);
  }

  _s_throw(o) {
    const S = this._begin(o, 0.1, 0.4); if (!S) return; const { t, out } = S;
    this._noise(out, t, { ft: 'bandpass', f: 700, f2: 2600, glide: 0.22, q: 2, dur: 0.3, vol: 0.35, a: 0.01 });
    this._osc(out, t, { type: 'sine', f: 350, f2: 900, dur: 0.15, vol: 0.12 });
  }

  _s_drop(o) {
    const S = this._begin(o, 0.1, 0.35); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sine', f: 700, f2: 140, glide: 0.12, dur: 0.18, vol: 0.4 });
    this._noise(out, t, { ft: 'lowpass', f: 800, dur: 0.06, vol: 0.15 });
    this._osc(out, t + 0.08, { type: 'sine', f: 300, f2: 500, dur: 0.08, vol: 0.1 });
  }

  _s_hit(o) {
    const S = this._begin(o, 0.15, 1.2); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sine', f: 170, f2: 45, dur: 0.25, vol: 0.7 });
    this._noise(out, t, { ft: 'lowpass', f: 1800, f2: 300, dur: 0.25, vol: 0.5, a: 0.001 });
    this._osc(out, t, { type: 'square', f: 520, f2: 260, dur: 0.12, vol: 0.14, lp: 2000 });
    this._osc(out, t + 0.06, { type: 'triangle', f: 1100, f2: 280, glide: 0.9, dur: 1.0, vol: 0.14, vib: 80, vibRate: 11 });
  }

  _s_explosion(o) {
    const S = this._begin(o, 0.35, 1.9); if (!S) return; const { t, out } = S;
    this._noise(out, t, { ft: 'lowpass', f: 3500, f2: 150, glide: 1.2, dur: 1.6, vol: 0.85, a: 0.003, shape: 4 });
    this._osc(out, t, { type: 'sine', f: 110, f2: 30, dur: 0.9, vol: 0.9 });
    this._osc(out, t + 0.06, { type: 'sine', f: 80, f2: 28, dur: 0.7, vol: 0.5 });
    this._noise(out, t, { ft: 'highpass', f: 3000, dur: 0.2, vol: 0.3, a: 0.001 });
    for (let i = 0; i < 5; i++) this._noise(out, t + 0.15 + i * 0.09, { ft: 'highpass', f: 2500, dur: 0.04, vol: 0.12 / (1 + i * 0.4), a: 0.001 });
    this.duck(0.35, 0.5);
  }

  _s_shield(o) {
    const S = this._begin(o, 0.4, 1.0); if (!S) return; const { t, out } = S;
    [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568].forEach((f, i) => this._bell(out, t + i * 0.04, f, 0.5, 0.06, 2.0, 0.8));
    this._osc(out, t, { type: 'sine', f: 400, f2: 1600, glide: 0.5, dur: 0.6, vol: 0.08, vib: 30, vibRate: 14 });
    this._noise(out, t, { ft: 'highpass', f: 6000, dur: 0.6, vol: 0.05, a: 0.15 });
  }

  _s_shieldBreak(o) {
    const S = this._begin(o, 0.35, 0.8); if (!S) return; const { t, out } = S;
    [2637, 2093, 1568, 1175].forEach((f, i) => this._bell(out, t + i * 0.03, f, 0.35, 0.08, 3.7, 1.8));
    this._noise(out, t, { ft: 'highpass', f: 2500, dur: 0.4, vol: 0.3, a: 0.001 });
    this._osc(out, t, { type: 'sine', f: 900, f2: 200, dur: 0.3, vol: 0.1 });
  }

  _s_mega(o) {
    const S = this._begin(o, 0.3, 1.6); if (!S) return; const { t, out } = S;
    this.duck(0.5, 1.3);
    this._osc(out, t, { type: 'sawtooth', f: 200, f2: 800, glide: 0.25, dur: 0.3, vol: 0.14, lp: 3000 });
    for (const n of ['G4', 'C5', 'E5']) this._brass(out, t + 0.25, nf(n), 0.2, 0.07);
    for (const n of ['C5', 'E5', 'G5', 'C6']) this._brass(out, t + 0.5, nf(n), 0.85, 0.07);
    this._osc(out, t + 0.5, { type: 'sine', f: 98, f2: 70, dur: 0.6, vol: 0.5 });
    this._noise(out, t + 0.5, { ft: 'highpass', f: 4500, dur: 1.0, vol: 0.12 });
  }

  _s_storm(o) {
    const S = this._begin(o, 0.4, 2.0); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sawtooth', f: 4000, f2: 80, glide: 0.15, dur: 0.18, vol: 0.22, shape: 5 });
    this._noise(out, t, { ft: 'highpass', f: 2000, dur: 0.12, vol: 0.6, a: 0.001 });
    this._noise(out, t + 0.03, { ft: 'highpass', f: 1500, dur: 0.06, vol: 0.4, a: 0.001 });
    this._noise(out, t + 0.07, { ft: 'highpass', f: 1200, dur: 0.08, vol: 0.35, a: 0.001 });
    this._noise(out, t + 0.05, { ft: 'lowpass', f: 250, dur: 1.8, vol: 0.5, a: 0.05 });
    this._osc(out, t + 0.04, { type: 'sine', f: 55, f2: 38, dur: 1.2, vol: 0.3 });
    this.duck(0.4, 0.8);
  }

  _s_bump(o) {
    const S = this._begin(o, 0.06, 0.3); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sine', f: 130, f2: 55, dur: 0.16, vol: 0.6 });
    this._noise(out, t, { ft: 'lowpass', f: 700, dur: 0.07, vol: 0.35, a: 0.001 });
    this._osc(out, t, { type: 'square', f: 220, f2: 150, dur: 0.06, vol: 0.1, lp: 900 });
  }

  _s_wall(o) {
    const S = this._begin(o, 0.12, 0.5); if (!S) return; const { t, out } = S;
    this._noise(out, t, { ft: 'bandpass', f: 900, q: 0.9, dur: 0.35, vol: 0.55, a: 0.001, shape: 6 });
    this._noise(out, t + 0.02, { ft: 'highpass', f: 3000, dur: 0.25, vol: 0.15 });
    this._osc(out, t, { type: 'sine', f: 100, f2: 40, dur: 0.2, vol: 0.6 });
    this._osc(out, t, { type: 'square', f: 380, dur: 0.08, vol: 0.07, lp: 2500 });
    this._osc(out, t, { type: 'square', f: 571, dur: 0.07, vol: 0.05, lp: 2500 });
  }

  _s_lap(o) {
    const S = this._begin(o, 0.35, 1.4); if (!S) return; const { t, out } = S;
    this._bell(out, t, 1318.5, 1.1, 0.17, 3.5, 1.2);
    this._bell(out, t + 0.11, 1760, 1.1, 0.17, 3.5, 1.2);
    this._osc(out, t + 0.11, { type: 'triangle', f: 880, dur: 0.6, vol: 0.06 });
  }

  _s_finalLap(o) {
    const S = this._begin(o, 0.3, 1.9); if (!S) return; const { t, out } = S;
    this.duck(0.6, 1.6);
    const seq = [['G4', 0, 0.08], ['G4', 0.1, 0.08], ['G4', 0.2, 0.08], ['C5', 0.3, 0.22], ['E5', 0.55, 0.13], ['G5', 0.7, 0.75]];
    for (const [n, dt, d] of seq) {
      this._brass(out, t + dt, nf(n), d, 0.11);
      this._osc(out, t + dt, { type: 'square', f: nf(n) * 2, dur: d + 0.05, vol: 0.03, lp: 5000 });
    }
    for (const n of ['C4', 'E4', 'G4', 'C5']) this._brass(out, t + 0.7, nf(n), 0.75, 0.045);
    for (const dt of [0, 0.1, 0.2]) this._noise(out, t + dt, { ft: 'highpass', f: 1500, dur: 0.07, vol: 0.12 });
    this._osc(out, t + 0.3, { type: 'sine', f: 98, f2: 65, dur: 0.4, vol: 0.45 });
    this._osc(out, t + 0.7, { type: 'sine', f: 130.8, f2: 65, dur: 0.6, vol: 0.55 });
    this._noise(out, t + 0.7, { ft: 'highpass', f: 5000, dur: 1.0, vol: 0.18 });
  }

  _s_finish(o) {
    const good = !!o.good;
    const S = this._begin(o, 0.35, 3.6); if (!S) return; const { t, out } = S;
    if (good) {
      this.duck(0.85, 3.0);
      const lead = [['G4', 0, 0.14], ['C5', 0.15, 0.14], ['E5', 0.3, 0.14], ['G5', 0.45, 0.28], ['E5', 0.75, 0.13],
        ['G5', 0.9, 0.55], ['A5', 1.5, 0.13], ['B5', 1.65, 0.13], ['C6', 1.8, 1.15]];
      for (const [n, dt, d] of lead) {
        this._brass(out, t + dt, nf(n), d, 0.12);
        this._osc(out, t + dt, { type: 'square', f: nf(n), dur: d + 0.06, vol: 0.035, lp: 4500 });
      }
      const chords = [[['C4', 'E4', 'G4'], 0, 0.85], [['F4', 'A4', 'C5'], 0.9, 0.58], [['G4', 'B4', 'D5'], 1.5, 0.28], [['C4', 'E4', 'G4', 'C5'], 1.8, 1.2]];
      for (const [ns, dt, d] of chords) for (const n of ns) this._brass(out, t + dt, nf(n), d, 0.04);
      const bass = [['C3', 0, 0.8], ['F2', 0.9, 0.55], ['G2', 1.5, 0.28], ['C2', 1.8, 1.3]];
      for (const [n, dt, d] of bass) {
        this._osc(out, t + dt, { type: 'triangle', f: nf(n), dur: d + 0.1, vol: 0.32 });
        this._osc(out, t + dt, { type: 'sine', f: 95, f2: 58, dur: 0.5, vol: 0.45 });
      }
      for (let i = 0; i < 8; i++) this._noise(out, t + 1.5 + i * 0.036, { ft: 'highpass', f: 1500, dur: 0.06, vol: 0.06 + i * 0.015 });
      this._noise(out, t + 1.8, { ft: 'highpass', f: 4500, dur: 1.8, vol: 0.24 });
      ['C7', 'E7', 'G7', 'C8'].forEach((n, i) => this._bell(out, t + 2.0 + i * 0.08, nf(n), 0.7, 0.05, 3.01, 1));
    } else {
      this.duck(0.6, 2.8);
      for (const n of ['F4', 'A4', 'C5', 'E5']) this._osc(out, t, { type: 'triangle', f: nf(n), dur: 1.6, a: 0.25, vol: 0.05 });
      for (const n of ['C4', 'E4', 'G4', 'D5']) this._osc(out, t + 1.4, { type: 'triangle', f: nf(n), dur: 1.9, a: 0.3, vol: 0.05 });
      this._osc(out, t, { type: 'sine', f: nf('F2'), dur: 1.5, a: 0.05, vol: 0.25 });
      this._osc(out, t + 1.4, { type: 'sine', f: nf('C2'), dur: 1.9, a: 0.05, vol: 0.25 });
      const mel = [['E5', 0, 0.9], ['F5', 0.3, 0.9], ['E5', 0.6, 0.9], ['C5', 0.9, 1.0], ['D5', 1.4, 1.0], ['E5', 1.9, 1.4]];
      for (const [n, dt, d] of mel) this._bell(out, t + dt, nf(n), d, 0.12, 1.0, 1.2);
    }
  }

  _s_land(o) {
    const S = this._begin(o, 0.05, 0.3); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sine', f: 110, f2: 45, dur: 0.18, vol: 0.55 });
    this._noise(out, t, { ft: 'lowpass', f: 500, dur: 0.12, vol: 0.3, a: 0.001 });
  }

  _s_trick(o) {
    const S = this._begin(o, 0.25, 0.8); if (!S) return; const { t, out } = S;
    this._noise(out, t, { ft: 'bandpass', f: 400, f2: 3000, glide: 0.2, q: 1.5, dur: 0.28, vol: 0.3, a: 0.02 });
    this._bell(out, t + 0.12, 1568, 0.5, 0.13, 3.5, 1.2);
    this._bell(out, t + 0.16, 2093, 0.5, 0.1, 3.5, 1.2);
  }

  _s_jump(o) {
    const S = this._begin(o, 0.05, 0.3); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sine', f: 260, f2: 620, glide: 0.12, dur: 0.14, vol: 0.18 });
    this._noise(out, t, { ft: 'bandpass', f: 1000, f2: 2000, dur: 0.15, vol: 0.12 });
  }

  _s_menuMove(o) {
    const S = this._begin(o, 0.05, 0.1); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'triangle', f: 1320, dur: 0.05, vol: 0.14, a: 0.001 });
    this._osc(out, t, { type: 'sine', f: 2640, dur: 0.025, vol: 0.04, a: 0.001 });
  }

  _s_menuSelect(o) {
    const S = this._begin(o, 0.2, 0.5); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'square', f: 1046.5, dur: 0.08, vol: 0.09, lp: 4000 });
    this._osc(out, t + 0.07, { type: 'square', f: 1568, dur: 0.22, vol: 0.09, lp: 4000 });
    this._bell(out, t + 0.07, 1568, 0.4, 0.07, 3.5, 1);
  }

  _s_menuBack(o) {
    const S = this._begin(o, 0.12, 0.3); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'triangle', f: 784, dur: 0.12, vol: 0.14 });
    this._osc(out, t + 0.07, { type: 'triangle', f: 523.25, dur: 0.14, vol: 0.14 });
  }

  _s_rocketStart(o) {
    const S = this._begin(o, 0.2, 1.4); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'sawtooth', f: 90, f2: 420, glide: 0.25, dur: 0.5, vol: 0.22, lp: 1800, shape: 3 });
    this._noise(out, t, { ft: 'lowpass', f: 3000, dur: 0.08, vol: 0.5, a: 0.001 });
    this._osc(out, t, { type: 'sine', f: 80, f2: 40, dur: 0.4, vol: 0.6 });
    this._noise(out, t + 0.03, { ft: 'bandpass', f: 300, f2: 3500, glide: 0.4, q: 1.1, dur: 1.1, vol: 0.5, a: 0.02 });
    this._bell(out, t + 0.05, nf('C7'), 0.4, 0.06, 3.01, 1);
    this.duck(0.2, 0.6);
  }

  _s_spinout(o) {
    const S = this._begin(o, 0.12, 1.1); if (!S) return; const { t, out } = S;
    const sq = this._noise(out, t, { ft: 'bandpass', f: 2200, q: 8, dur: 0.9, vol: 0.28, a: 0.02 });
    const c = this._ctx;
    const l = c.createOscillator(); l.frequency.value = 9;
    const lg = c.createGain(); lg.gain.value = 500;
    l.connect(lg); lg.connect(sq.f.frequency); l.start(t); l.stop(t + 0.95);
    l.onended = () => disc(lg);
    this._osc(out, t, { type: 'triangle', f: 900, f2: 250, glide: 0.9, dur: 0.9, vol: 0.12, vib: 90, vibRate: 10 });
    for (let i = 0; i < 3; i++) this._noise(out, t + i * 0.25, { ft: 'lowpass', f: 900, dur: 0.12, vol: 0.12 });
  }

  _s_coin(o) {
    const S = this._begin(o, 0.18, 0.5); if (!S) return; const { t, out } = S;
    this._osc(out, t, { type: 'square', f: 1046.5, dur: 0.07, vol: 0.09, lp: 5000, a: 0.001 });
    this._osc(out, t + 0.06, { type: 'square', f: 1568, dur: 0.35, vol: 0.09, lp: 5000 });
    this._osc(out, t + 0.06, { type: 'sine', f: 1568, dur: 0.35, vol: 0.08 });
    this._bell(out, t + 0.06, 3136, 0.25, 0.03, 3.01, 0.8);
  }

  _s_wrongWay(o) {
    const S = this._begin(o, 0.08, 0.5); if (!S) return; const { t, out } = S;
    for (const dt of [0, 0.2]) {
      this._osc(out, t + dt, { type: 'square', f: 440, f2: 415, dur: 0.14, vol: 0.14, lp: 1500 });
      this._osc(out, t + dt, { type: 'sine', f: 220, dur: 0.14, vol: 0.12 });
    }
  }

  _s_seekerLock(o) {
    const S = this._begin(o, 0.06, 0.5); if (!S) return; const { t, out } = S;
    for (let i = 0; i < 4; i++) this._osc(out, t + i * 0.09, { type: 'square', f: i % 2 ? 1320 : 1760, dur: 0.05, vol: 0.09, lp: 5000, a: 0.001 });
  }

  // ------------------------------------------------------------------ music
  setMusicIntensity(x) {
    this._intensity = clamp(num(x, this._intensity), 0, 1);
  }

  setMusicTempoScale(s) {
    this._tempoScale = clamp(num(s, 1), 0.5, 2);
  }

  duck(amount = 0.5, sec = 1) {
    try {
      const c = this._ctx; if (!c || !this._duck) return;
      const g = this._duck.gain, now = c.currentTime;
      const lvl = clamp(1 - num(amount, 0.5), 0.0001, 1);
      const hold = Math.max(0.05, num(sec, 1));
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(lvl, now + 0.08);
      g.setValueAtTime(lvl, now + hold);
      g.linearRampToValueAtTime(1, now + hold + 0.5);
    } catch (e) { this._report(e); }
  }

  playMusic(trackId, opts = {}) {
    try {
      opts = opts || {};
      const def = TRACKS[trackId];
      if (!def) return;
      if (typeof opts.intensity === 'number') this.setMusicIntensity(opts.intensity);
      if (typeof opts.tempoScale === 'number') this.setMusicTempoScale(opts.tempoScale);
      if (!this._ctx || !this._duck) { this._pendingMusic = { id: trackId, opts }; return; }
      const cur = this._songs.find((s) => !s.stopping);
      if (cur && cur.id === trackId && !opts.restart) return;
      const fade = Math.max(0.05, num(opts.fade, 0.8));
      for (const s of this._songs) if (!s.stopping) this._fadeSong(s, fade);
      const song = this._makeSong(trackId, fade);
      this._songs.push(song);
      if (!this._timer) this._timer = setInterval(() => this._tick(), TICK_MS);
      this._tick();
    } catch (e) { this._report(e); }
  }

  stopMusic(fadeSec = 0.8) {
    try {
      this._pendingMusic = null;
      const f = Math.max(0.02, num(fadeSec, 0.8));
      for (const s of this._songs) if (!s.stopping) this._fadeSong(s, f);
    } catch (e) { this._report(e); }
  }

  _makeSong(id, fade) {
    const c = this._ctx;
    if (!this._trackCache[id]) this._trackCache[id] = buildTrack(TRACKS[id]);
    const data = this._trackCache[id], def = data.def;
    const now = c.currentTime;
    const s = { id, data, def, bar: 0, step: 0, stopping: false, endAt: Infinity };
    s.out = c.createGain();
    s.out.gain.setValueAtTime(0.0001, now);
    s.out.gain.linearRampToValueAtTime(1, now + fade);
    s.out.connect(this._duck);
    s.pump = c.createGain(); s.pump.connect(s.out);
    s.drums = c.createGain(); s.drums.connect(s.out);
    s.lead = c.createGain(); s.lead.connect(s.out);
    s.dsend = c.createGain(); s.dsend.gain.value = (def.lead && def.lead.delay) || 0;
    s.delay = c.createDelay(2);
    s.fb = c.createGain(); s.fb.gain.value = 0.33;
    s.dlp = c.createBiquadFilter(); s.dlp.type = 'lowpass'; s.dlp.frequency.value = 2800;
    s.lead.connect(s.dsend); s.dsend.connect(s.delay); s.delay.connect(s.fb); s.fb.connect(s.delay);
    s.delay.connect(s.dlp); s.dlp.connect(s.out);
    s.tempoScale = this._tempoScale;
    s.stepDur = 60 / (def.bpm * s.tempoScale) / 4;
    s.delay.delayTime.value = s.stepDur * 3;
    s.nextTime = now + 0.06;
    return s;
  }

  _fadeSong(s, fade) {
    const c = this._ctx;
    s.stopping = true;
    const now = c.currentTime, g = s.out.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(Math.max(0.0001, g.value), now);
      g.linearRampToValueAtTime(0.0001, now + fade);
    } catch (e) { this._report(e); }
    s.endAt = now + fade;
    setTimeout(() => {
      const i = this._songs.indexOf(s);
      if (i >= 0) this._songs.splice(i, 1);
      disc(s.out, s.pump, s.drums, s.lead, s.dsend, s.delay, s.fb, s.dlp);
    }, (fade + 2.5) * 1000);
  }

  _tick() {
    const c = this._ctx;
    if (!c) return;
    if (!this._songs.length) { clearInterval(this._timer); this._timer = null; return; }
    const now = c.currentTime;
    for (const s of this._songs) {
      if (s.stopping && s.nextTime > s.endAt) continue;
      if (s.nextTime < now - 0.3) s.nextTime = now + 0.02; // resync after tab throttling
      let guard = 0;
      while (s.nextTime < now + LOOKAHEAD && guard++ < 64) {
        if (s.step === 0 && s.tempoScale !== this._tempoScale) {
          s.tempoScale = this._tempoScale;
          s.stepDur = 60 / (s.def.bpm * s.tempoScale) / 4;
          try { s.delay.delayTime.setTargetAtTime(s.stepDur * 3, s.nextTime, 0.05); } catch (e) { /* */ }
        }
        const sw = s.step & 1 ? (s.def.swing || 0) * s.stepDur : 0;
        try { this._schedStep(s, s.nextTime + sw, s.step); } catch (e) { this._report(e); }
        s.nextTime += s.stepDur;
        if (++s.step >= 16) { s.step = 0; s.bar++; }
      }
    }
  }

  _schedStep(s, t, step) {
    const def = s.def, data = s.data, I = this._intensity, sd = s.stepDur;
    const form = def.form;
    const secIdx = Math.floor(s.bar / 4) % form.length;
    const sec = data.sections[form[secIdx]];
    const barIn = s.bar % 4;
    const bar = sec.bars[barIn % sec.bars.length];
    const dr = sec.drums;

    // current chord
    let chord = bar.chords[0].ch, cStart = 0;
    for (const cc of bar.chords) if (cc.at <= step) { chord = cc.ch; cStart = cc.at; }
    let cEnd = 16;
    for (const cc of bar.chords) if (cc.at > cStart) { cEnd = cc.at; break; }

    // ---- drums
    const fill = barIn === 3 && secIdx % 2 === 1 && I >= 0.3 && step >= 12;
    if (step === 0 && barIn === 0 && s.bar > 0 && I >= 0.5) this._mCrash(s, t);
    if (dr.kick[step]) this._mKick(s, t, dr.kick[step]);
    if (fill) {
      this._mSnare(s, t, 0.45 + 0.15 * (step - 12));
      if (step === 12 || step === 14) this._mTom(s, t, 0.7, step === 12 ? 190 : 140);
    } else if (dr.snare[step]) this._mSnare(s, t, dr.snare[step]);
    if (dr.clap[step] && I >= 0.25) this._mClap(s, t, dr.clap[step]);
    if (I >= 0.2) {
      if (dr.hatO[step] && I >= 0.5) this._mHat(s, t, dr.hatO[step], true);
      else if (dr.hatC[step]) this._mHat(s, t, dr.hatC[step], false);
    }
    if (dr.shaker[step] && I >= 0.35) this._mShaker(s, t, dr.shaker[step]);
    if (dr.doum[step]) this._mDoum(s, t, dr.doum[step]);
    if (dr.tek[step] && I >= 0.15) this._mTek(s, t, dr.tek[step]);

    // ---- harmony
    if (step === cStart && def.pad) this._mPad(s, t, chord.tones, (cEnd - cStart) * sd + 0.04);
    if (data.stab && data.stab[step]) this._mStab(s, t, chord.tones, data.stab[step]);
    const b = bar.bass[step];
    if (b) this._mBass(s, t, chord.bass + b.v, b.len * sd * 0.92);
    if (data.arp && I >= (def.arp.min == null ? 0.4 : def.arp.min)) {
      const a = data.arp[step];
      if (a) {
        const tones = chord.tones, n = tones.length, i = Math.round(a.v);
        const midi = tones[((i % n) + n) % n] + 12 * Math.floor(i / n) + (def.arp.oct || 0);
        this._mArp(s, t, midi, a.len * sd);
      }
    }

    // ---- lead
    const L = bar.lead[step];
    if (L) {
      const cfg = def.lead, midi = L.v + (cfg.oct || 0), dur = L.len * sd * 0.95;
      const vol = cfg.vol * (0.8 + 0.2 * I);
      this._mLead(s, t, midi, dur, vol);
      if (cfg.dbl && I >= 0.85) this._mLead(s, t, midi + cfg.dbl, dur, vol * 0.33);
    }
  }

  // ---- music voices
  _mKick(s, t, v) {
    const c = this._ctx;
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.95 * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    o.connect(g); g.connect(s.drums);
    o.start(t); o.stop(t + 0.45);
    o.onended = () => disc(g);
    this._noise(s.drums, t, { ft: 'highpass', f: 3000, dur: 0.015, vol: 0.22 * v, a: 0.0005 });
    if (s.def.pump) {
      const p = s.pump.gain;
      p.setTargetAtTime(1 - s.def.pump, t, 0.008);
      p.setTargetAtTime(1, t + 0.05, 0.09);
    }
  }

  _mSnare(s, t, v) {
    this._noise(s.drums, t, { ft: 'highpass', f: 1500, dur: 0.19, vol: 0.38 * v, a: 0.001 });
    this._noise(s.drums, t, { ft: 'bandpass', f: 3500, q: 0.8, dur: 0.1, vol: 0.18 * v, a: 0.001 });
    this._osc(s.drums, t, { type: 'triangle', f: 240, f2: 170, glide: 0.06, dur: 0.11, vol: 0.32 * v, a: 0.001 });
  }

  _mClap(s, t, v) {
    [0, 0.011, 0.022].forEach((dt, i) => this._noise(s.drums, t + dt, { ft: 'bandpass', f: 1300, q: 1.2, dur: i === 2 ? 0.18 : 0.02, vol: 0.32 * v, a: 0.0008 }));
  }

  _mHat(s, t, v, open) {
    this._noise(s.drums, t, { ft: 'highpass', f: 7800, dur: open ? 0.3 : 0.045, vol: (open ? 0.14 : 0.12) * v, a: 0.001 });
  }

  _mShaker(s, t, v) {
    this._noise(s.drums, t, { ft: 'bandpass', f: 6500, q: 1.5, dur: 0.07, vol: 0.09 * v, a: 0.012 });
  }

  _mDoum(s, t, v) {
    this._osc(s.drums, t, { type: 'sine', f: 105, f2: 68, glide: 0.25, dur: 0.32, vol: 0.5 * v, a: 0.002 });
    this._noise(s.drums, t, { ft: 'lowpass', f: 400, dur: 0.05, vol: 0.2 * v, a: 0.001 });
  }

  _mTek(s, t, v) {
    this._noise(s.drums, t, { ft: 'bandpass', f: 2800, q: 2.5, dur: 0.06, vol: 0.32 * v, a: 0.0008 });
    this._osc(s.drums, t, { type: 'sine', f: 520, f2: 420, dur: 0.05, vol: 0.14 * v, a: 0.001 });
  }

  _mTom(s, t, v, f) {
    this._osc(s.drums, t, { type: 'sine', f, f2: f * 0.6, dur: 0.22, vol: 0.45 * v, a: 0.002 });
  }

  _mCrash(s, t) {
    this._noise(s.drums, t, { ft: 'highpass', f: 4500, dur: 1.4, vol: 0.15, a: 0.002 });
    this._noise(s.drums, t, { ft: 'bandpass', f: 7000, q: 0.6, dur: 0.8, vol: 0.07, a: 0.002 });
  }

  _mBass(s, t, midi, dur) {
    const cfg = s.def.bass, c = this._ctx, f = mtof(midi);
    const o = c.createOscillator(); o.type = cfg.type || 'sawtooth'; o.frequency.value = f;
    const sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.value = f;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = cfg.q == null ? 4 : cfg.q;
    const co = cfg.cutoff || 800;
    flt.frequency.setValueAtTime(co * 3.2, t);
    flt.frequency.setTargetAtTime(co, t, 0.06);
    const g = c.createGain(), vol = cfg.vol == null ? 0.3 : cfg.vol;
    const end = t + Math.max(0.05, dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.setTargetAtTime(vol * 0.75, t + 0.01, 0.12);
    g.gain.setTargetAtTime(0.0001, end, 0.025);
    const sg = c.createGain(); sg.gain.value = cfg.sub == null ? 0.6 : cfg.sub;
    o.connect(flt); flt.connect(g); sub.connect(sg); sg.connect(g); g.connect(s.pump);
    o.start(t); sub.start(t); o.stop(end + 0.15); sub.stop(end + 0.15);
    o.onended = () => disc(g, flt, sg);
  }

  _mPad(s, t, tones, dur) {
    const cfg = s.def.pad, c = this._ctx;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = 0.5;
    const co = cfg.cutoff || 1500, a = cfg.attack || 0.08;
    flt.frequency.setValueAtTime(co * 0.6, t);
    flt.frequency.linearRampToValueAtTime(co, t + a * 3);
    const g = c.createGain(), vol = cfg.vol || 0.025;
    const end = t + Math.max(dur, a + 0.02);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + a);
    g.gain.setValueAtTime(vol, end);
    g.gain.setTargetAtTime(0.0001, end, 0.08);
    flt.connect(g); g.connect(s.pump);
    const det = cfg.det || 9;
    let last;
    for (const m of tones) {
      for (const d of [-det, det]) {
        const o = c.createOscillator(); o.type = cfg.type || 'sawtooth';
        o.frequency.value = mtof(m); o.detune.value = d;
        o.connect(flt); o.start(t); o.stop(end + 0.45);
        last = o;
      }
    }
    if (last) last.onended = () => disc(g, flt);
  }

  _mStab(s, t, tones, v) {
    const cfg = s.def.stab, c = this._ctx;
    const co = cfg.cutoff || 2400;
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = 1.5;
    flt.frequency.setValueAtTime(co * 1.5, t);
    flt.frequency.setTargetAtTime(co * 0.4, t, 0.05);
    const g = c.createGain();
    this._env(g.gain, t, 0.003, (cfg.vol || 0.05) * v, 0.16);
    flt.connect(g); g.connect(s.pump);
    let last;
    for (const m of tones) {
      const o = c.createOscillator(); o.type = cfg.type || 'square'; o.frequency.value = mtof(m + 12);
      o.connect(flt); o.start(t); o.stop(t + 0.2); last = o;
    }
    if (last) last.onended = () => disc(g, flt);
  }

  _mArp(s, t, midi, len) {
    const cfg = s.def.arp, c = this._ctx, f = mtof(midi);
    const o = c.createOscillator();
    const g = c.createGain();
    let flt = null, dur;
    if (cfg.type === 'chip') {
      o.type = 'square'; dur = Math.min(0.09, len);
      this._env(g.gain, t, 0.001, cfg.vol || 0.04, dur);
      o.connect(g);
    } else {
      o.type = 'sawtooth'; dur = Math.min(0.28, Math.max(0.12, len * 1.5));
      flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = 3;
      flt.frequency.setValueAtTime(3800, t);
      flt.frequency.setTargetAtTime(500, t, 0.05);
      this._env(g.gain, t, 0.003, cfg.vol || 0.05, dur);
      o.connect(flt); flt.connect(g);
    }
    o.frequency.value = f;
    g.connect(s.pump);
    if (cfg.delay) g.connect(s.dsend);
    o.start(t); o.stop(t + dur + 0.05);
    o.onended = () => disc(g, flt);
  }

  _mLead(s, t, midi, dur, vol) {
    const cfg = s.def.lead, c = this._ctx, f = mtof(midi);
    const dest = s.lead;
    const type = cfg.type;
    if (type === 'bell') {
      const d = Math.max(0.6, dur + 0.5);
      this._bell(dest, t, f, d, vol * 0.7, 3.0, 1.3);
      this._osc(dest, t, { type: 'sine', f, dur: d * 0.8, vol: vol * 0.35, a: 0.002 });
      this._osc(dest, t, { type: 'sine', f: f * 2, dur: 0.25, vol: vol * 0.2, a: 0.001 });
      return;
    }
    if (type === 'ep') {
      const d = Math.max(0.5, dur + 0.35);
      this._bell(dest, t, f, d, vol * 0.55, 1.0, 1.1);
      this._osc(dest, t, { type: 'sine', f, dur: d, vol: vol * 0.45, a: 0.004, vib: 6, vibRate: 4.5, vibDelay: 0.3 });
      this._osc(dest, t, { type: 'triangle', f: f * 2, dur: 0.12, vol: vol * 0.12, a: 0.001 });
      return;
    }
    const end = t + Math.max(0.05, dur);
    const flt = c.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = 1;
    const co = cfg.cutoff || 3000;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + (type === 'reed' ? 0.03 : 0.008));
    g.gain.setTargetAtTime(vol * 0.72, t + 0.03, 0.12);
    g.gain.setTargetAtTime(0.0001, end, 0.045);
    flt.connect(g); g.connect(dest);
    const oscs = [];
    let pre = flt;
    if (type === 'reed') {
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 1.2;
      bp.connect(flt); pre = bp;
      flt.frequency.value = co;
      const o1 = c.createOscillator(); o1.type = 'sawtooth';
      const o2 = c.createOscillator(); o2.type = 'square';
      const g2 = c.createGain(); g2.gain.value = 0.5;
      o1.connect(pre); o2.connect(g2); g2.connect(pre);
      oscs.push(o1, o2);
    } else if (type === 'saw') {
      flt.frequency.setValueAtTime(co * 0.35, t);
      flt.frequency.setTargetAtTime(co, t, 0.03);
      flt.frequency.setTargetAtTime(co * 0.7, t + 0.12, 0.2);
      for (const d of [-14, 0, 14]) {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.detune.value = d; o.connect(flt); oscs.push(o);
      }
    } else if (type === 'triangle') {
      flt.frequency.value = co;
      const o = c.createOscillator(); o.type = 'triangle'; o.connect(flt); oscs.push(o);
    } else { // square
      flt.frequency.value = co;
      for (const d of [-5, 5]) {
        const o = c.createOscillator(); o.type = 'square'; o.detune.value = d; o.connect(flt); oscs.push(o);
      }
    }
    // vibrato (delayed) shared by all oscs
    const vib = cfg.vib || 0;
    let lfo = null, lg = null;
    if (vib > 0 && dur > 0.18) {
      lfo = c.createOscillator(); lfo.frequency.value = type === 'reed' ? 6 : 5.5;
      lg = c.createGain();
      lg.gain.setValueAtTime(0, t);
      lg.gain.setValueAtTime(0, t + 0.15);
      lg.gain.linearRampToValueAtTime(vib, t + 0.4);
      lfo.connect(lg);
      lfo.start(t); lfo.stop(end + 0.3);
    }
    for (const o of oscs) {
      o.frequency.value = f;
      if (type === 'reed') { o.detune.setValueAtTime(o.detune.value - 80, t); o.detune.linearRampToValueAtTime(0, t + 0.06); }
      if (lg) lg.connect(o.detune);
      o.start(t); o.stop(end + 0.3);
    }
    oscs[0].onended = () => disc(g, flt, pre !== flt ? pre : null, lg);
  }
}

export const MUSIC_TRACKS = Object.keys(TRACKS);
export default AudioEngine;
