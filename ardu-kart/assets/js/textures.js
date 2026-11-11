// Procedural canvas textures. Everything is generated at load time so the app ships no image assets.
import * as THREE from '../libs/three.bundle.js';
import { makeRng } from './util.js';

const cache = new Map();
let maxAniso = 4;
export function setMaxAnisotropy(a) { maxAniso = a; }

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c, { repeat = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

function speckle(ctx, w, h, count, colors, rng, sizeMin = 1, sizeMax = 2.5) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(rng() * colors.length) | 0];
    const s = sizeMin + rng() * (sizeMax - sizeMin);
    ctx.fillRect(rng() * w, rng() * h, s, s);
  }
}

// Asphalt with painted edge lines; u = across road (0..1), v = along road.
export function roadTexture(theme) {
  return cached('road:' + theme, () => {
    const W = 512, H = 512;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');
    const rng = makeRng(11);
    const base = {
      sunset: '#4a4b52', neon: '#1b1c27', frost: '#55606e', dunes: '#6d5a48',
    }[theme] || '#4a4b52';
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    // aggregate grain
    speckle(ctx, W, H, 26000, ['rgba(255,255,255,0.06)', 'rgba(0,0,0,0.12)', 'rgba(255,255,255,0.03)', 'rgba(0,0,0,0.2)'], rng, 1, 2.2);
    // tyre-worn racing line darkening
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.3, 'rgba(0,0,0,0.12)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.04)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // cracks / patches
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 14; i++) {
      let x = rng() * W, y = rng() * H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (rng() - 0.5) * 40;
        y += (rng() - 0.5) * 40;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // edge lines
    const lineCol = theme === 'neon' ? '#33f0ff' : theme === 'dunes' ? '#f4e2b8' : '#f2f2f2';
    ctx.fillStyle = lineCol;
    ctx.fillRect(W * 0.035, 0, W * 0.018, H);
    ctx.fillRect(W * (1 - 0.053), 0, W * 0.018, H);
    // dashed centre line
    ctx.fillStyle = theme === 'neon' ? 'rgba(255,60,200,0.9)' : 'rgba(255,255,255,0.55)';
    for (let y = 0; y < H; y += 128) ctx.fillRect(W * 0.494, y, W * 0.012, 64);
    return toTexture(c);
  });
}

// Emissive map for neon road lines (black elsewhere).
export function roadEmissiveTexture() {
  return cached('roadEmissive', () => {
    const W = 512, H = 512;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#33f0ff';
    ctx.fillRect(W * 0.035, 0, W * 0.018, H);
    ctx.fillRect(W * (1 - 0.053), 0, W * 0.018, H);
    ctx.fillStyle = '#ff3cc8';
    for (let y = 0; y < H; y += 128) ctx.fillRect(W * 0.494, y, W * 0.012, 64);
    return toTexture(c);
  });
}

export function curbTexture(theme) {
  return cached('curb:' + theme, () => {
    const c = canvas(64, 256);
    const ctx = c.getContext('2d');
    const [a, b] = {
      neon: ['#ff2fd0', '#1a1a2e'], frost: ['#e33b3b', '#f4f8ff'], dunes: ['#c8452c', '#f6ead0'],
    }[theme] || ['#e8322b', '#f7f7f7'];
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? b : a;
      ctx.fillRect(0, i * 64, 64, 64);
    }
    // bevel shading across width
    const g = ctx.createLinearGradient(0, 0, 64, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.25)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.1)');
    g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 256);
    return toTexture(c);
  });
}

export function groundTexture(kind) {
  return cached('ground:' + kind, () => {
    const W = 512;
    const c = canvas(W);
    const ctx = c.getContext('2d');
    const rng = makeRng(kind.length * 97 + 3);
    const pal = {
      grass: { base: '#4f8f34', dots: ['#5fa53d', '#3f7a2a', '#6db347', '#447f2c', '#83c25a'] },
      sand: { base: '#e2c48d', dots: ['#d6b47a', '#ecd3a0', '#cfa86b', '#f2dcae'] },
      snow: { base: '#e9f0f8', dots: ['#ffffff', '#d7e3f0', '#c9d8ea', '#f4f8fc'] },
      neon: { base: '#10101c', dots: ['#181830', '#0a0a14', '#1e1e3a'] },
      beach: { base: '#ecd39e', dots: ['#e0c48a', '#f5e2b8', '#d9b77a'] },
      rock: { base: '#8a7466', dots: ['#7a6457', '#9c8577', '#6c574b'] },
    }[kind] || { base: '#4f8f34', dots: ['#5fa53d'] };
    ctx.fillStyle = pal.base;
    ctx.fillRect(0, 0, W, W);
    // large soft blotches for macro variation
    for (let i = 0; i < 60; i++) {
      const x = rng() * W, y = rng() * W, r = 20 + rng() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const col = pal.dots[(rng() * pal.dots.length) | 0];
      g.addColorStop(0, col + '88');
      g.addColorStop(1, col + '00');
      ctx.fillStyle = g;
      for (const ox of [-W, 0, W]) for (const oy of [-W, 0, W]) {
        ctx.save();
        ctx.translate(ox, oy);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    speckle(ctx, W, W, 22000, pal.dots, rng, 1, 3);
    if (kind === 'grass') {
      // grass blades
      for (let i = 0; i < 5000; i++) {
        const x = rng() * W, y = rng() * W;
        ctx.strokeStyle = rng() < 0.5 ? 'rgba(120,190,80,0.5)' : 'rgba(40,90,25,0.5)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 3, y - 3 - rng() * 4);
        ctx.stroke();
      }
    }
    if (kind === 'sand' || kind === 'beach') {
      // wind ripples
      ctx.strokeStyle = 'rgba(160,120,70,0.18)';
      ctx.lineWidth = 2;
      for (let y = 0; y < W; y += 14) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.04 + y) * 4);
        ctx.stroke();
      }
    }
    if (kind === 'neon') {
      ctx.strokeStyle = 'rgba(80,60,255,0.35)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= W; i += 64) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, W); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke();
      }
    }
    return toTexture(c);
  });
}

export function neonGridEmissive() {
  return cached('neonGridE', () => {
    const W = 512;
    const c = canvas(W);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, W);
    ctx.strokeStyle = '#5a3cff';
    ctx.lineWidth = 3;
    for (let i = 0; i <= W; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, W); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke();
    }
    return toTexture(c);
  });
}

export function wallTexture(theme) {
  return cached('wall:' + theme, () => {
    const W = 256, H = 64;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');
    if (theme === 'neon') {
      ctx.fillStyle = '#14142a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#ff2fd0';
      ctx.fillRect(0, 4, W, 6);
      ctx.fillStyle = '#33f0ff';
      ctx.fillRect(0, H - 12, W, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      for (let x = 0; x < W; x += 32) ctx.fillRect(x, 10, 2, H - 22);
    } else if (theme === 'frost') {
      ctx.fillStyle = '#dfe9f5';
      ctx.fillRect(0, 0, W, H);
      const rng = makeRng(5);
      speckle(ctx, W, H, 3000, ['#ffffff', '#c6d6ea', '#b4c8e2'], rng, 1, 3);
      ctx.fillStyle = 'rgba(120,150,190,0.25)';
      ctx.fillRect(0, H - 14, W, 14);
    } else if (theme === 'dunes') {
      ctx.fillStyle = '#c99a62';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(90,55,25,0.45)';
      ctx.lineWidth = 2;
      for (let y = 0; y < H; y += 16) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        for (let x = (y / 16) % 2 ? 0 : 24; x < W; x += 48) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 16); ctx.stroke();
        }
      }
      const rng = makeRng(9);
      speckle(ctx, W, H, 2500, ['rgba(255,240,200,0.2)', 'rgba(80,50,20,0.2)'], rng, 1, 2);
    } else {
      // sunset: red/white armco barrier with sponsor-ish blocks
      for (let x = 0; x < W; x += 64) {
        ctx.fillStyle = (x / 64) % 2 ? '#f4f4f4' : '#d8262b';
        ctx.fillRect(x, 0, 64, H);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, H * 0.45, W, 3);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    return toTexture(c);
  });
}

export function checkerTexture(n = 8) {
  return cached('checker' + n, () => {
    const c = canvas(256, 64);
    const ctx = c.getContext('2d');
    const s = 256 / (n * 2);
    for (let y = 0; y < 64 / s; y++)
      for (let x = 0; x < n * 2; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f5f5f5';
        ctx.fillRect(x * s, y * s, s, s);
      }
    return toTexture(c);
  });
}

export function boostPadTexture() {
  return cached('boostpad', () => {
    const c = canvas(128, 256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff7a00';
    ctx.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 2; i++) {
      const y0 = i * 128;
      const g = ctx.createLinearGradient(0, y0, 0, y0 + 128);
      g.addColorStop(0, '#fff6a0');
      g.addColorStop(1, '#ffb300');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(10, y0 + 110);
      ctx.lineTo(64, y0 + 30);
      ctx.lineTo(118, y0 + 110);
      ctx.lineTo(96, y0 + 110);
      ctx.lineTo(64, y0 + 62);
      ctx.lineTo(32, y0 + 110);
      ctx.closePath();
      ctx.fill();
    }
    return toTexture(c);
  });
}

export function itemBoxTexture() {
  return cached('itembox', () => {
    const S = 256;
    const c = canvas(S);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, 'rgba(255,90,200,0.9)');
    g.addColorStop(0.33, 'rgba(255,220,60,0.9)');
    g.addColorStop(0.66, 'rgba(60,230,255,0.9)');
    g.addColorStop(1, 'rgba(140,90,255,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.clearRect(14, 14, S - 28, S - 28);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(14, 14, S - 28, S - 28);
    ctx.font = 'bold 170px "Arial Black", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(40,20,80,0.9)';
    ctx.strokeText('?', S / 2, S / 2 + 10);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('?', S / 2, S / 2 + 10);
    return toTexture(c, { repeat: false });
  });
}

export function billboardTexture(lines, { bg = '#0f62fe', fg = '#ffffff', accent = '#ffd400', w = 512, h = 256 } = {}) {
  const key = 'bb:' + lines.join('|') + bg + fg;
  return cached(key, () => {
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, bg);
    g.addColorStop(1, shade(bg, -40));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = accent;
    ctx.fillRect(0, h - 22, w, 22);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.floor(h * 0.3)}px "Arial Black", Arial, sans-serif`;
    ctx.fillText(lines[0], w / 2, lines[1] ? h * 0.36 : h * 0.47, w * 0.92);
    if (lines[1]) {
      ctx.font = `700 ${Math.floor(h * 0.16)}px Arial, sans-serif`;
      ctx.fillText(lines[1], w / 2, h * 0.7, w * 0.9);
    }
    return toTexture(c, { repeat: false });
  });
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

// Building facade: random lit windows. Returns { map, emissive }.
export function windowsTexture(seed, night) {
  return cached('win:' + seed + night, () => {
    const W = 256, H = 512;
    const c = canvas(W, H), e = canvas(W, H);
    const ctx = c.getContext('2d'), ex = e.getContext('2d');
    const rng = makeRng(seed);
    const baseCols = night ? ['#1d1f33', '#24203a', '#1a2433'] : ['#c9b8a0', '#a9b6c4', '#d6c7b0'];
    ctx.fillStyle = rng.pick(baseCols);
    ctx.fillRect(0, 0, W, H);
    ex.fillStyle = '#000';
    ex.fillRect(0, 0, W, H);
    const lit = night ? ['#ffd88a', '#8ae8ff', '#ff9ae6', '#fff3c4'] : ['#7fa8c9'];
    for (let y = 12; y < H - 12; y += 24)
      for (let x = 10; x < W - 10; x += 22) {
        const on = rng() < (night ? 0.45 : 1);
        ctx.fillStyle = on && night ? rng.pick(lit) : night ? '#0b0c16' : '#5b7a95';
        ctx.fillRect(x, y, 14, 16);
        if (on && night) {
          ex.fillStyle = ctx.fillStyle;
          ex.fillRect(x, y, 14, 16);
        }
      }
    const map = toTexture(c);
    const emissive = toTexture(e);
    return { map, emissive };
  });
}

export function cloudTexture() {
  return cached('cloud', () => {
    const S = 256;
    const c = canvas(S);
    const ctx = c.getContext('2d');
    const rng = makeRng(42);
    for (let i = 0; i < 26; i++) {
      const x = S * 0.2 + rng() * S * 0.6, y = S * 0.35 + rng() * S * 0.3, r = 25 + rng() * 45;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return toTexture(c, { repeat: false });
  });
}

export function softDotTexture() {
  return cached('softdot', () => {
    const S = 64;
    const c = canvas(S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return toTexture(c, { repeat: false, srgb: false });
  });
}

export function smokeTexture() {
  return cached('smoke', () => {
    const S = 128;
    const c = canvas(S);
    const ctx = c.getContext('2d');
    const rng = makeRng(3);
    for (let i = 0; i < 18; i++) {
      const x = S / 2 + (rng() - 0.5) * S * 0.4, y = S / 2 + (rng() - 0.5) * S * 0.4, r = S * (0.15 + rng() * 0.2);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
    return toTexture(c, { repeat: false, srgb: false });
  });
}

export function starTexture() {
  return cached('star', () => {
    const S = 64;
    const c = canvas(S);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.15, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.15)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(S / 2 - 0.75, 4, 1.5, S - 8);
    ctx.fillRect(4, S / 2 - 0.75, S - 8, 1.5);
    return toTexture(c, { repeat: false, srgb: false });
  });
}
