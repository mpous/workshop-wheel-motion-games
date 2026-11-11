// In-race heads-up display (DOM overlay): place, laps, timer, item slot with roulette,
// coins, speed / drift gauge, live standings, minimap, countdown and banner messages.
import { el, formatTime, ordinal, clamp } from './util.js';
import { buildItemIcon, CHARACTERS } from './kartModel.js';
import { ITEMS } from './items.js';

// Speed lines baked once into a transparent image (a CSS mask over a full-screen
// animated gradient is too heavy for some compositors and blanks the WebGL canvas).
let speedLinesURL = null;
function speedLinesImage() {
  if (speedLinesURL) return speedLinesURL;
  const W = 1024, H = 576, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const cx = W / 2, cy = H * 0.52, R = Math.hypot(W, H) * 0.6;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2 + rnd() * 0.05;
    const r0 = R * (0.42 + rnd() * 0.2), w = 0.004 + rnd() * 0.006;
    const g = x.createRadialGradient(cx, cy, r0, cx, cy, R);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${0.18 + rnd() * 0.22})`);
    g.addColorStop(1, 'rgba(255,255,255,0.05)');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(cx + Math.cos(a - w) * r0, cy + Math.sin(a - w) * r0);
    x.lineTo(cx + Math.cos(a - w * 2.5) * R, cy + Math.sin(a - w * 2.5) * R);
    x.lineTo(cx + Math.cos(a + w * 2.5) * R, cy + Math.sin(a + w * 2.5) * R);
    x.lineTo(cx + Math.cos(a + w) * r0, cy + Math.sin(a + w) * r0);
    x.fill();
  }
  speedLinesURL = c.toDataURL('image/png');
  return speedLinesURL;
}

const iconCache = new Map();
export function itemIconURL(name, size = 128) {
  const key = name + size;
  if (!iconCache.has(key)) {
    try {
      iconCache.set(key, buildItemIcon(name, size).toDataURL());
    } catch {
      iconCache.set(key, '');
    }
  }
  return iconCache.get(key);
}

const hex = (c) => '#' + c.toString(16).padStart(6, '0');

export class HUD {
  constructor(root, { track, karts, player, laps, mode, portraits = {} }) {
    this.root = root;
    this.track = track;
    this.karts = karts;
    this.player = player;
    this.laps = laps;
    this.mode = mode;
    this.portraits = portraits;
    root.innerHTML = '';
    root.classList.remove('hidden');

    this.elItem = el('div', { class: 'hud-item' }, el('div', { class: 'hud-item-frame' }, (this.elItemImg = el('img', { alt: '' }))), (this.elItemCount = el('div', { class: 'hud-item-count' })));
    this.elCoins = el('div', { class: 'hud-coins' }, el('span', { class: 'coin-ico' }), (this.elCoinN = el('span', {}, '0')));
    this.elTopLeft = el('div', { class: 'hud-tl' }, this.elItem, this.elCoins);

    this.elLap = el('div', { class: 'hud-lap' });
    this.elTime = el('div', { class: 'hud-time' });
    this.elSplits = el('div', { class: 'hud-splits' });
    this.elTopRight = el('div', { class: 'hud-tr' }, this.elLap, this.elTime, this.elSplits);

    this.elPos = el('div', { class: 'hud-pos' });
    this.elPosSuf = el('span', { class: 'suf' });
    this.elPosWrap = el('div', { class: 'hud-pos-wrap' }, this.elPos);

    this.elSpeed = el('div', { class: 'hud-speed' });
    this.elSpeedArc = el('div', { class: 'hud-speed-arc' });
    this.elDrift = el('div', { class: 'hud-drift' }, el('div', { class: 'hud-drift-fill' }));
    this.elGauge = el('div', { class: 'hud-gauge' }, this.elSpeedArc, this.elSpeed, el('div', { class: 'hud-kmh' }, 'KM/H'), this.elDrift);

    this.elStand = el('div', { class: 'hud-stand' });
    this.standRows = new Map();

    this.map = el('canvas', { class: 'hud-map', width: 220, height: 220 });
    this.mapCtx = this.map.getContext('2d');
    this._prepMap();

    this.elCenter = el('div', { class: 'hud-center' });
    this.elMsg = el('div', { class: 'hud-msg' });
    this.elWrong = el('div', { class: 'hud-wrong hidden' }, el('div', { class: 'ww-ico' }, '⟲'), 'WRONG WAY');
    this.elFlash = el('div', { class: 'hud-flash' });
    this.elVignette = el('div', { class: 'hud-vignette' });
    this.elSpeedLines = el('div', { class: 'hud-speedlines', style: { backgroundImage: `url(${speedLinesImage()})` } });
    this.elLookBack = el('div', { class: 'hud-lookback hidden' }, 'REAR VIEW');
    this.elFeed = el('div', { class: 'hud-feed' });

    root.append(this.elSpeedLines, this.elVignette, this.elFlash, this.elTopLeft, this.elTopRight, this.elPosWrap, this.elGauge, this.elStand, this.map, this.elCenter, this.elMsg, this.elWrong, this.elLookBack, this.elFeed);
    if (mode === 'tt') { this.elStand.classList.add('hidden'); this.elPosWrap.classList.add('hidden'); }

    this.lastPlace = 0;
    this.rouletteIdx = 0;
    this.rouletteAcc = 0;
    this.msgTimer = 0;
  }

  _prepMap() {
    const tr = this.track;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < tr.N; i++) {
      minX = Math.min(minX, tr.px[i]); maxX = Math.max(maxX, tr.px[i]);
      minZ = Math.min(minZ, tr.pz[i]); maxZ = Math.max(maxZ, tr.pz[i]);
    }
    const W = 220, pad = 18;
    const s = (W - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    const ox = (W - (maxX - minX) * s) / 2, oz = (W - (maxZ - minZ) * s) / 2;
    // world x flips so the map matches the driver's left/right when looking from above (north up = -z)
    this.mapTf = (x, z) => [W - (ox + (x - minX) * s), W - (oz + (z - minZ) * s)];
    const off = document.createElement('canvas');
    off.width = off.height = W;
    const c = off.getContext('2d');
    const path = () => {
      c.beginPath();
      for (let i = 0; i <= tr.N; i++) {
        const [x, y] = this.mapTf(tr.px[i % tr.N], tr.pz[i % tr.N]);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
    };
    c.lineJoin = c.lineCap = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 14; path(); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.95)'; c.lineWidth = 9; path(); c.stroke();
    c.strokeStyle = 'rgba(60,70,90,0.9)'; c.lineWidth = 6; path(); c.stroke();
    // bridge shading: higher sections drawn on top lighter
    if (!tr.def.skirt) {
      c.strokeStyle = 'rgba(120,140,200,0.9)'; c.lineWidth = 6;
      c.beginPath();
      for (let i = 0; i < tr.N; i++) {
        const [x, y] = this.mapTf(tr.px[i], tr.pz[i]);
        if (tr.py[i] > 8) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke();
    }
    // start line
    const [sx, sy] = this.mapTf(tr.px[0], tr.pz[0]);
    c.fillStyle = '#fff';
    c.fillRect(sx - 5, sy - 5, 10, 10);
    c.fillStyle = '#111';
    c.fillRect(sx - 5, sy - 5, 5, 5); c.fillRect(sx, sy, 5, 5);
    this.mapBase = off;
  }

  setKarts(karts) { this.karts = karts; this.standRows.clear(); this.elStand.innerHTML = ''; }

  countdown(n) {
    // n: 3,2,1,0(GO)
    const text = n > 0 ? String(n) : 'GO!';
    const d = el('div', { class: 'cd ' + (n > 0 ? 'cd-n' : 'cd-go') }, text);
    this.elCenter.innerHTML = '';
    this.elCenter.append(d);
    setTimeout(() => d.remove(), n > 0 ? 950 : 1200);
  }

  message(text, cls = '', dur = 1.8) {
    const d = el('div', { class: 'msg ' + cls }, text);
    this.elMsg.innerHTML = '';
    this.elMsg.append(d);
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => d.classList.add('out'), dur * 1000);
    setTimeout(() => d.remove(), dur * 1000 + 600);
  }

  feed(html) {
    const d = el('div', { class: 'feed-row', html });
    this.elFeed.prepend(d);
    while (this.elFeed.children.length > 4) this.elFeed.lastChild.remove();
    setTimeout(() => d.classList.add('out'), 3500);
    setTimeout(() => d.remove(), 4200);
  }

  flash(color = '#fff', strength = 0.6) {
    this.elFlash.style.background = color;
    this.elFlash.style.transition = 'none';
    this.elFlash.style.opacity = strength;
    requestAnimationFrame(() => {
      this.elFlash.style.transition = 'opacity 0.5s ease-out';
      this.elFlash.style.opacity = 0;
    });
  }

  pulse(cls) {
    this.root.classList.remove(cls);
    void this.root.offsetWidth;
    this.root.classList.add(cls);
  }

  update(dt, { raceTime, standings, lookBack }) {
    const p = this.player;
    // lap & time
    const lapN = clamp(p.lap + 1, 1, this.laps);
    this.elLap.innerHTML = `<span class="lbl">LAP</span><b>${lapN}</b><span class="of">/${this.laps}</span>`;
    const t = p.finished ? p.finishTime : Math.max(0, raceTime) * 1000;
    this.elTime.textContent = formatTime(t);
    const splits = p.lapTimes.map((lt, i) => `<div><span>L${i + 1}</span>${formatTime(lt)}</div>`).join('');
    if (this._splitsHTML !== splits) { this.elSplits.innerHTML = splits; this._splitsHTML = splits; }

    // place
    if (this.mode !== 'tt') {
      const place = p.place;
      if (place !== this.lastPlace) {
        const suffix = ordinal(place).replace(String(place), '');
        this.elPos.innerHTML = `${place}<span class="suf">${suffix}</span>`;
        this.elPos.className = 'hud-pos p' + Math.min(place, 4);
        this.elPosWrap.classList.remove('bump');
        void this.elPosWrap.offsetWidth;
        this.elPosWrap.classList.add('bump');
        this.lastPlace = place;
      }
    }

    // item slot
    if (p.rouletteT > 0) {
      this.rouletteAcc += dt;
      const rate = p.rouletteT > 0.5 ? 0.07 : 0.14;
      if (this.rouletteAcc > rate) {
        this.rouletteAcc = 0;
        this.rouletteIdx = (this.rouletteIdx + 1) % ITEMS.length;
        this.elItemImg.src = itemIconURL(ITEMS[this.rouletteIdx]);
        this.onRouletteTick?.();
      }
      this.elItem.className = 'hud-item rolling';
      this.elItemCount.textContent = '';
    } else if (p.item) {
      const src = itemIconURL(p.item);
      if (this.elItemImg.getAttribute('src') !== src) {
        this.elItemImg.src = src;
        this.elItem.className = 'hud-item got';
      }
      this.elItemCount.textContent = p.itemCount > 1 ? '×' + p.itemCount : '';
    } else {
      if (this.elItemImg.getAttribute('src')) this.elItemImg.removeAttribute('src');
      this.elItem.className = 'hud-item empty';
      this.elItemCount.textContent = '';
    }
    this.elCoinN.textContent = p.coins;
    this.elCoins.classList.toggle('max', p.coins >= 10);

    // speed gauge
    const kmh = Math.round(Math.max(0, p.speed) * 3.6 * 1.25);
    this.elSpeed.textContent = kmh;
    const sp01 = clamp(p.speed / (p.baseMax * 1.35), 0, 1);
    this.elSpeedArc.style.setProperty('--v', sp01.toFixed(3));
    const d = p.drift !== 0 ? clamp(p.driftCharge / 3.0, 0, 1) : 0;
    this.elDrift.style.setProperty('--d', d.toFixed(3));
    this.elDrift.dataset.level = p.driftLevel;
    this.elGauge.classList.toggle('boost', p.boosting);

    // screen-space effects
    const fast = clamp((p.speed - p.baseMax * 0.9) / (p.baseMax * 0.4), 0, 1);
    this.elSpeedLines.style.opacity = (p.boosting ? 0.85 : fast * 0.5).toFixed(2);
    this.elVignette.style.opacity = (0.35 + (p.boosting ? 0.35 : 0) + (p.shrinkT > 0 ? 0.3 : 0)).toFixed(2);
    this.elVignette.classList.toggle('mega', p.megaT > 0);
    this.elWrong.classList.toggle('hidden', !(p.wrongWayT > 1.2));
    this.elLookBack.classList.toggle('hidden', !lookBack);

    // standings
    if (this.mode !== 'tt' && standings) this._standings(standings);
    this._drawMap();
  }

  _standings(list) {
    const rowH = 34;
    list.forEach((k, i) => {
      let row = this.standRows.get(k.id);
      if (!row) {
        const ch = CHARACTERS[k.charIndex % CHARACTERS.length];
        const img = this.portraits[ch.id];
        row = el('div', { class: 'st-row' + (k === this.player ? ' me' : '') },
          el('span', { class: 'st-n' }),
          img ? el('img', { class: 'st-face', src: img }) : el('span', { class: 'st-face', style: { background: hex(ch.color) } }),
          el('span', { class: 'st-name' }, k.name));
        row.style.setProperty('--c', hex(ch.color));
        this.elStand.append(row);
        this.standRows.set(k.id, row);
      }
      row.firstChild.textContent = i + 1;
      row.style.transform = `translateY(${i * rowH}px)`;
      row.classList.toggle('fin', k.finished);
    });
  }

  _drawMap() {
    const c = this.mapCtx;
    c.clearRect(0, 0, 220, 220);
    c.drawImage(this.mapBase, 0, 0);
    const list = [...this.karts].sort((a, b) => (a === this.player) - (b === this.player));
    for (const k of list) {
      const [x, y] = this.mapTf(k.pos.x, k.pos.z);
      const me = k === this.player;
      const col = hex(k.char.color);
      c.beginPath();
      c.arc(x, y, me ? 7 : 5, 0, Math.PI * 2);
      c.fillStyle = col;
      c.fill();
      c.lineWidth = me ? 3 : 2;
      c.strokeStyle = me ? '#fff' : 'rgba(0,0,0,0.7)';
      c.stroke();
      if (me) {
        // heading arrow
        const h = k.heading;
        const [ax, ay] = this.mapTf(k.pos.x + Math.sin(h) * 14, k.pos.z + Math.cos(h) * 14);
        const dx = ax - x, dy = ay - y, l = Math.hypot(dx, dy) || 1;
        c.beginPath();
        c.moveTo(x + (dx / l) * 13, y + (dy / l) * 13);
        c.lineTo(x + (dx / l) * 7 - (dy / l) * 5, y + (dy / l) * 7 + (dx / l) * 5);
        c.lineTo(x + (dx / l) * 7 + (dy / l) * 5, y + (dy / l) * 7 - (dx / l) * 5);
        c.closePath();
        c.fillStyle = '#fff';
        c.fill();
      }
    }
  }

  hide() { this.root.classList.add('hidden'); }
  destroy() { this.root.innerHTML = ''; this.root.classList.add('hidden'); }
}
