// Track definitions. Pure data: closed centre-line control points [x, z, y(elevation), width?].
// Feature positions are given as fractions of the lap (0..1), measured from the start line.

function lemniscate(A, B, H, n, jitter = []) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const j = jitter[i] || 0;
    pts.push([A * Math.sin(t), B * Math.sin(t) * Math.cos(t) + j, H * (0.5 + 0.5 * Math.cos(t))]);
  }
  return pts;
}

export const TRACKS = [
  {
    id: 'sunset',
    name: 'Sunset Shores',
    subtitle: 'Palm-lined seaside sprint',
    theme: 'sunset',
    difficulty: 1,
    width: 20,
    shoulder: 9,
    offroad: 'beach',
    terrain: 'grass',
    skirt: true,
    points: [
      [0, 0, 0], [70, -2, 0], [125, 6, 0.5], [165, 35, 1.5], [178, 85, 2.5], [160, 130, 3.5],
      [118, 150, 4], [78, 138, 4], [52, 108, 3.5], [20, 98, 3], [-12, 120, 3], [-30, 160, 3.5],
      [-68, 182, 4], [-112, 170, 3.5], [-140, 132, 2.5], [-150, 82, 1.5], [-138, 36, 0.5], [-92, 4, 0], [-45, -2, 0],
    ],
    boostPads: [{ t: 0.33, off: -4 }, { t: 0.6, off: 5 }, { t: 0.875, off: 0 }],
    ramps: [{ t: 0.47, len: 12, h: 2.6 }],
    itemRows: [0.12, 0.42, 0.72],
    coins: [0.2, 0.52, 0.8],
  },
  {
    id: 'neon',
    name: 'Neon Nexus',
    subtitle: 'Figure-eight through a cyber city',
    theme: 'neon',
    difficulty: 2,
    width: 19,
    shoulder: 2.5,
    offroad: 'neon',
    terrain: 'neon',
    skirt: false,
    points: lemniscate(190, 125, 14, 20, [0, 0, 8, -6, 0, 0, 0, 6, -8, 0, 0, 0, 8, -6, 0, 0, 0, 6, -8, 0]),
    boostPads: [{ t: 0.02, off: 0 }, { t: 0.27, off: -4 }, { t: 0.52, off: 0 }, { t: 0.77, off: 4 }],
    ramps: [],
    itemRows: [0.1, 0.36, 0.6, 0.86],
    coins: [0.18, 0.44, 0.68, 0.94],
  },
  {
    id: 'frost',
    name: 'Frostbite Pass',
    subtitle: 'Alpine climbs under the aurora',
    theme: 'frost',
    difficulty: 3,
    width: 19,
    shoulder: 8,
    offroad: 'snow',
    terrain: 'snow',
    skirt: true,
    points: [
      [0, 0, 0], [60, 0, 0], [110, -15, 3], [140, -55, 8], [128, -100, 13], [90, -112, 16], [58, -90, 18],
      [40, -55, 19], [8, -48, 20], [-20, -75, 21], [-30, -118, 22], [-62, -146, 22], [-105, -140, 20],
      [-128, -104, 16], [-120, -64, 11], [-142, -28, 7], [-130, 10, 4], [-96, 28, 2], [-55, 8, 0.5],
    ],
    boostPads: [{ t: 0.16, off: 0 }, { t: 0.66, off: -4 }],
    ramps: [{ t: 0.38, len: 11, h: 2.4 }, { t: 0.9, len: 12, h: 2.8 }],
    itemRows: [0.1, 0.33, 0.58, 0.8],
    coins: [0.24, 0.5, 0.72],
  },
  {
    id: 'dunes',
    name: 'Dune Raceway',
    subtitle: 'Sweeping desert canyon',
    theme: 'dunes',
    difficulty: 2,
    width: 21,
    shoulder: 10,
    offroad: 'sand',
    terrain: 'sand',
    skirt: true,
    points: [
      [0, 0, 0], [80, 0, 0], [150, -10, 2], [205, -52, 5], [210, -112, 7], [170, -150, 6], [112, -140, 4],
      [72, -170, 6], [20, -200, 9], [-40, -190, 9], [-70, -150, 7], [-60, -100, 4], [-100, -70, 3],
      [-150, -80, 5], [-190, -50, 6], [-180, 0, 4], [-130, 18, 2], [-60, 10, 0],
    ],
    boostPads: [{ t: 0.08, off: -4 }, { t: 0.4, off: 0 }, { t: 0.7, off: 4 }],
    ramps: [{ t: 0.2, len: 14, h: 3.2 }, { t: 0.56, len: 12, h: 2.6 }],
    itemRows: [0.14, 0.34, 0.62, 0.84],
    coins: [0.26, 0.47, 0.77, 0.94],
  },
];

export const TRACK_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

export const THEMES = {
  sunset: {
    music: 'sunset',
    skyTop: 0x2b4b8f, skyMid: 0xff8a5c, skyBottom: 0xffd39b,
    sunColor: 0xffc58a, sunIntensity: 3.2, sunDir: [-0.55, 0.32, -0.75],
    hemiSky: 0xffd2b0, hemiGround: 0x4a6b3a, hemiIntensity: 1.1,
    fog: 0xf3a77f, fogDensity: 0.0026, exposure: 1.0, night: false, water: 0x2a6f9e,
  },
  neon: {
    music: 'neon',
    skyTop: 0x05020f, skyMid: 0x2a0b4a, skyBottom: 0xb3207a,
    sunColor: 0x9bb6ff, sunIntensity: 1.1, sunDir: [0.3, 0.8, 0.4],
    hemiSky: 0x6b5bff, hemiGround: 0x220833, hemiIntensity: 0.9,
    fog: 0x2a0b3e, fogDensity: 0.0032, exposure: 1.15, night: true,
  },
  frost: {
    music: 'frost',
    skyTop: 0x0d1d45, skyMid: 0x3a6fb0, skyBottom: 0xc6e2ff,
    sunColor: 0xe6f0ff, sunIntensity: 2.6, sunDir: [0.5, 0.45, -0.6],
    hemiSky: 0xcfe4ff, hemiGround: 0x8899aa, hemiIntensity: 1.2,
    fog: 0xc0d6ee, fogDensity: 0.0028, exposure: 0.95, night: false, aurora: true,
  },
  dunes: {
    music: 'dunes',
    skyTop: 0x3a7bd5, skyMid: 0x9cc7ef, skyBottom: 0xf6dcae,
    sunColor: 0xfff1d6, sunIntensity: 3.6, sunDir: [0.4, 0.75, 0.35],
    hemiSky: 0xbfdcff, hemiGround: 0xc29b62, hemiIntensity: 1.0,
    fog: 0xeccf9e, fogDensity: 0.0022, exposure: 1.0, night: false,
  },
};

export const CC = {
  50: { label: '50cc', maxSpeed: 25, ai: 0.82 },
  100: { label: '100cc', maxSpeed: 29, ai: 0.92 },
  150: { label: '150cc', maxSpeed: 33, ai: 1.0 },
};
