// Menu screens (DOM): title, main menu, character / track select, lobby, pause,
// results, Grand Prix standings, podium, leaderboards, settings and the
// Modulino wheel (motion controller) setup.
// Navigation works with mouse / touch directly and with keyboard / gamepad via
// spatial focus movement over elements marked `.nav`.
import { el, $, $$, formatTime, ordinal, clamp } from './util.js';
import { TRACKS, CC } from './tracks.js';
import { CHARACTERS } from './kartModel.js';
import { ACTIONS, DEFAULT_LABELS } from './motion.js';

const ENGINES = [
  { value: 'auto', label: 'AUTO' },
  { value: 'brick', label: 'APP LAB BRICK' },
  { value: 'mcu', label: 'MODEL ON THE MCU' },
];

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
export const GP_POINTS = [15, 12, 10, 8, 6, 4, 2, 1];

// track outline thumbnails drawn from the control points
const thumbCache = new Map();
export function trackThumb(def, size = 200, color = '#fff') {
  const key = def.id + size + color;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const pts = def.points;
  // Catmull-Rom through the control points
  const sm = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let t = 0; t < 1; t += 0.1) {
      const t2 = t * t, t3 = t2 * t;
      const f = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
      sm.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of sm) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  const pad = size * 0.1;
  const s = (size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
  const ox = (size - (maxX - minX) * s) / 2, oz = (size - (maxZ - minZ) * s) / 2;
  const tf = ([x, z]) => [size - (ox + (x - minX) * s), size - (oz + (z - minZ) * s)];
  g.lineJoin = g.lineCap = 'round';
  const path = () => { g.beginPath(); sm.forEach((p, i) => { const [x, y] = tf(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };
  g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = size * 0.07; path(); g.stroke();
  g.strokeStyle = color; g.lineWidth = size * 0.035; path(); g.stroke();
  const [sx, sy] = tf(sm[0]);
  g.fillStyle = '#ffd400'; g.beginPath(); g.arc(sx, sy, size * 0.03, 0, Math.PI * 2); g.fill();
  const url = c.toDataURL();
  thumbCache.set(key, url);
  return url;
}

function statBars(stats) {
  const rows = [['SPEED', stats.speed], ['ACCEL', stats.accel], ['WEIGHT', stats.weight], ['HANDLING', stats.handling]];
  return el('div', { class: 'stats' }, rows.map(([l, v]) =>
    el('div', { class: 'stat' }, el('span', {}, l), el('div', { class: 'bar' }, el('i', { style: { width: (v / 5) * 100 + '%' } })))));
}

export class UI {
  constructor(app) {
    this.app = app;
    this.root = $('#menus');
    this.screen = null;
    this.stack = [];
    this.focusEl = null;
    this.toastEl = $('#toast');
  }

  // ------------------------------------------------------------------ navigation core
  show(name, args = {}, { push = true } = {}) {
    if (push && this.screen && this.screen.name !== name) this.stack.push({ name: this.screen.name, args: this.screen.args });
    const build = this['_' + name];
    if (!build) throw new Error('no screen ' + name);
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');
    const node = build.call(this, args);
    node.classList.add('screen', 'screen-' + name);
    this.root.append(node);
    this.screen = { name, args, node, back: node._back };
    this.app.onScreen?.(name);
    const first = $('[autofocus]', node) || $('.nav', node);
    this.focus(first);
  }

  back() {
    const s = this.screen;
    if (s && s.back) { this.app.audio.play('menuBack'); s.back(); return; }
    if (!this.stack.length) return;
    this.app.audio.play('menuBack');
    const prev = this.stack.pop();
    this.show(prev.name, prev.args, { push: false });
  }

  reset(name, args) { this.stack = []; this.show(name, args, { push: false }); }

  hide() { this.root.classList.add('hidden'); this.root.innerHTML = ''; this.screen = null; this.app.preview?.canvas.remove(); }

  get visible() { return !!this.screen; }

  focus(e) {
    if (this.focusEl) this.focusEl.classList.remove('focus');
    this.focusEl = e || null;
    if (e) {
      e.classList.add('focus');
      if (e.tagName === 'INPUT') e.focus({ preventScroll: true });
      else if (document.activeElement && document.activeElement.tagName === 'INPUT') document.activeElement.blur();
      e.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      e.dispatchEvent(new CustomEvent('navfocus'));
    }
  }

  move(dir) {
    const cur = this.focusEl;
    const all = $$('.nav', this.root).filter((e) => e.offsetParent !== null && !e.disabled);
    if (!all.length) return;
    if (!cur || !all.includes(cur)) return this.focus(all[0]);
    // sliders / selectors consume left/right themselves
    if ((dir === 'left' || dir === 'right') && cur._lr) { cur._lr(dir === 'left' ? -1 : 1); this.app.audio.play('menuMove'); return; }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestScore = Infinity;
    for (const e of all) {
      if (e === cur) continue;
      const b = e.getBoundingClientRect();
      const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
      const dx = ex - cx, dy = ey - cy;
      let primary, secondary;
      if (dir === 'up') { if (dy >= -2) continue; primary = -dy; secondary = Math.abs(dx); }
      if (dir === 'down') { if (dy <= 2) continue; primary = dy; secondary = Math.abs(dx); }
      if (dir === 'left') { if (dx >= -2) continue; primary = -dx; secondary = Math.abs(dy); }
      if (dir === 'right') { if (dx <= 2) continue; primary = dx; secondary = Math.abs(dy); }
      const score = primary + secondary * 2.2;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) { this.focus(best); this.app.audio.play('menuMove'); }
  }

  handle(actions) {
    if (!this.screen) return;
    for (const a of actions) {
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') this.move(a);
      else if (a === 'ok') {
        if (this.focusEl && this.focusEl.tagName !== 'INPUT') this.focusEl.click();
        else if (this.focusEl && this.focusEl.tagName === 'INPUT') this.move('down');
      } else if (a === 'back') this.back();
      else if (a === 'prevTab' || a === 'nextTab') this.screen.node._tab?.(a === 'prevTab' ? -1 : 1);
    }
  }

  toast(text, cls = '') {
    const t = el('div', { class: 'toast-row ' + cls }, text);
    this.toastEl.append(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
  }

  // a clickable, focusable button
  btn(label, onClick, { cls = '', sub = '', icon = '', attrs = {} } = {}) {
    const b = el('button', { class: 'nav btn ' + cls, ...attrs },
      icon ? el('span', { class: 'btn-ico' }, icon) : null,
      el('span', { class: 'btn-label' }, label),
      sub ? el('span', { class: 'btn-sub' }, sub) : null);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      this.app.audio.unlock();
      this.app.audio.play('menuSelect');
      onClick?.(e);
    });
    b.addEventListener('mouseenter', () => { if (this.focusEl !== b) { this.focus(b); } });
    return b;
  }

  // a left/right option selector
  selector(label, options, value, onChange) {
    let i = Math.max(0, options.findIndex((o) => o.value === value));
    const valEl = el('span', { class: 'sel-val' });
    const render = () => { valEl.textContent = options[i].label; };
    const change = (d) => { i = (i + d + options.length) % options.length; render(); onChange(options[i].value); };
    const left = el('span', { class: 'sel-arrow', onclick: (e) => { e.stopPropagation(); change(-1); this.app.audio.play('menuMove'); } }, '‹');
    const right = el('span', { class: 'sel-arrow', onclick: (e) => { e.stopPropagation(); change(1); this.app.audio.play('menuMove'); } }, '›');
    const row = el('div', { class: 'nav selector' }, el('span', { class: 'sel-label' }, label), el('span', { class: 'sel-box' }, left, valEl, right));
    row._lr = change;
    row.addEventListener('click', () => { change(1); this.app.audio.play('menuMove'); });
    row.addEventListener('mouseenter', () => this.focus(row));
    render();
    return row;
  }

  slider(label, value, onChange) {
    const fill = el('i');
    const valEl = el('span', { class: 'sl-val' });
    let v = value;
    const render = () => { fill.style.width = v * 100 + '%'; valEl.textContent = Math.round(v * 100); };
    const set = (nv) => { v = clamp(Math.round(nv * 20) / 20, 0, 1); render(); onChange(v); };
    const track = el('div', { class: 'sl-track' }, fill);
    const row = el('div', { class: 'nav slider' }, el('span', { class: 'sel-label' }, label), track, valEl);
    row._lr = (d) => set(v + d * 0.05);
    const drag = (e) => {
      const r = track.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      set(x / r.width);
    };
    track.addEventListener('pointerdown', (e) => { drag(e); const mv = (ev) => drag(ev); window.addEventListener('pointermove', mv); window.addEventListener('pointerup', () => window.removeEventListener('pointermove', mv), { once: true }); });
    row.addEventListener('mouseenter', () => this.focus(row));
    render();
    return row;
  }

  header(title, sub) {
    return el('div', { class: 'scr-head' },
      el('button', { class: 'back-btn', onclick: () => this.back(), title: 'Back' }, '‹'),
      el('div', {}, el('h2', {}, title), sub ? el('div', { class: 'scr-sub' }, sub) : null));
  }

  footer(hints) {
    const dev = this.app.input.lastDevice;
    const map = dev === 'gamepad'
      ? { ok: 'Ⓐ', back: 'Ⓑ', tab: 'LB/RB' }
      : dev === 'wheel' ? { ok: 'A', back: 'B', tab: '' }
      : dev === 'touch' ? { ok: 'Tap', back: '‹', tab: '' } : { ok: 'Enter', back: 'Esc', tab: '' };
    return el('div', { class: 'scr-foot' }, hints.map(([k, t]) => el('span', { class: 'hint' }, el('kbd', {}, map[k] || k), t)));
  }

  // ------------------------------------------------------------------ screens
  _title() {
    const s = this.app.settings;
    const node = el('div', {},
      el('div', { class: 'logo' },
        el('div', { class: 'logo-ardu' }, 'ARDU'),
        el('div', { class: 'logo-kart' }, 'KART'),
        el('div', { class: 'logo-sub' }, 'RACING ON THE ARDUINO UNO Q')),
      this.btn('PRESS START', () => this.app.startPressed(), { cls: 'start-btn pulse', attrs: { autofocus: '' } }),
      el('div', { class: 'title-foot' },
        el('span', { class: 'conn ' + (this.app.net.connected ? 'on' : 'off') }, this.app.net.connected ? '● Connected to UNO Q' : '○ Offline'),
        el('span', {}, `v${this.app.version}`)));
    void s;
    node._back = () => {};
    return node;
  }

  _main() {
    const a = this.app;
    const mp = a.net.connected;
    const lob = a.net.lobby;
    const node = el('div', {},
      el('div', { class: 'logo small' }, el('div', { class: 'logo-ardu' }, 'ARDU'), el('div', { class: 'logo-kart' }, 'KART')),
      el('div', { class: 'menu-grid' },
        this.btn('GRAND PRIX', () => this.show('chars', { next: 'gp' }), { cls: 'big gp', icon: '🏆', sub: '4 tracks · points · podium', attrs: { autofocus: '' } }),
        this.btn('QUICK RACE', () => this.show('chars', { next: 'race' }), { cls: 'big', icon: '🏁', sub: 'One race vs 7 rivals' }),
        this.btn('TIME TRIAL', () => this.show('chars', { next: 'tt' }), { cls: 'big', icon: '⏱', sub: 'Beat your ghost' }),
        this.btn('MULTIPLAYER', () => (mp ? this.show('chars', { next: 'mp' }) : this.toast('Not connected to the UNO Q server', 'warn')), {
          cls: 'big mp' + (mp ? '' : ' dim'), icon: '📡',
          sub: mp ? `LAN · ${lob ? lob.members.length : 0}/${(lob && lob.max) || 20} in lobby${lob && lob.racing ? ' · racing' : ''}` : 'Server offline',
        }),
        this.btn('TRAIN YOUR MOTION CONTROLLER', () => this.show('motion'), {
          cls: 'motion-main', icon: '🎡',
          sub: a.motion.online ? `Wheel connected · ${a.motion.hasModel ? 'model running' : 'no model yet'}`
            : 'Modulino wheel · record gestures · train with Edge Impulse',
        }),
        this.btn('RECORDS', () => this.show('records'), { icon: '📜' }),
        this.btn('SETTINGS', () => this.show('settings'), { icon: '⚙' }),
        this.btn('HOW TO PLAY', () => this.show('help'), { icon: '🎮' })),
      el('div', { class: 'player-tag' }, el('span', {}, 'Racing as '), el('b', {}, a.settings.name)));
    node._back = () => this.show('title', {}, { push: false });
    return node;
  }

  _chars({ next }) {
    const a = this.app;
    let sel = a.settings.character;
    const prevBox = el('div', { class: 'char-preview' });
    const nameEl = el('div', { class: 'char-name' });
    const tagEl = el('div', { class: 'char-tag' });
    const classEl = el('div', { class: 'char-class' });
    const statsBox = el('div', {});
    const update = () => {
      const ch = CHARACTERS[sel];
      nameEl.textContent = ch.name;
      nameEl.style.color = hex(ch.color);
      tagEl.textContent = ch.tagline;
      classEl.textContent = (ch.weightClass || '').toUpperCase() + ' CLASS';
      statsBox.innerHTML = '';
      statsBox.append(statBars(ch.stats));
      a.preview?.show(sel);
      for (const c of cards) c.classList.toggle('sel', +c.dataset.i === sel);
    };
    const cards = CHARACTERS.map((ch, i) => {
      const card = el('button', { class: 'nav char-card', 'data-i': i, style: { '--c': hex(ch.color) } },
        el('img', { src: a.portraits[ch.id] || '', alt: ch.name }),
        el('span', {}, ch.name));
      card.addEventListener('navfocus', () => { if (sel !== i) { sel = i; update(); } });
      card.addEventListener('mouseenter', () => this.focus(card));
      card.addEventListener('click', () => {
        a.audio.unlock();
        a.audio.play('menuSelect');
        sel = i;
        a.settings.character = i;
        a.saveSettings();
        if (next === 'mp') this.show('lobby');
        else this.show('tracks', { next });
      });
      return card;
    });
    const node = el('div', {},
      this.header('CHOOSE YOUR DRIVER', { gp: 'Grand Prix', race: 'Quick Race', tt: 'Time Trial', mp: 'Multiplayer' }[next]),
      el('div', { class: 'char-layout' },
        el('div', { class: 'char-grid' }, cards),
        el('div', { class: 'char-info' }, prevBox, nameEl, classEl, tagEl, statsBox)),
      this.footer([['ok', 'Select'], ['back', 'Back']]));
    requestAnimationFrame(() => {
      a.preview?.attach(prevBox);
      update();
      this.focus(cards[sel]);
    });
    return node;
  }

  _tracks({ next }) {
    const a = this.app, s = a.settings;
    const opts = { cc: s.cc || 100, laps: 3 };
    let ccSel, lapsSel;
    const cards = (next === 'gp' ? [] : TRACKS).map((t) => {
      const best = a.bestLap(t.id);
      const card = el('button', { class: 'nav track-card theme-' + t.theme },
        el('img', { class: 'track-map', src: trackThumb(t, 220) }),
        el('div', { class: 'track-name' }, t.name),
        el('div', { class: 'track-sub' }, t.subtitle),
        el('div', { class: 'track-diff' }, '★'.repeat(t.difficulty) + '☆'.repeat(4 - t.difficulty)),
        el('div', { class: 'track-best' }, best ? `Best lap ${formatTime(best.time)} · ${best.name}` : 'No record yet'));
      card.addEventListener('mouseenter', () => this.focus(card));
      card.addEventListener('click', () => {
        a.audio.unlock(); a.audio.play('menuSelect');
        s.cc = opts.cc; s.lastTrack = t.id; a.saveSettings();
        a.startSolo({ mode: next, track: t.id, cc: opts.cc, laps: opts.laps });
      });
      return card;
    });
    if (next === 'gp') {
      // a single "cup" card covering all tracks
      const cup = el('button', { class: 'nav track-card cup', autofocus: '' },
        el('div', { class: 'cup-maps' }, TRACKS.map((t) => el('img', { src: trackThumb(t, 110) }))),
        el('div', { class: 'track-name' }, 'Q CUP'),
        el('div', { class: 'track-sub' }, TRACKS.map((t) => t.name).join(' · ')),
        el('div', { class: 'track-best' }, a.gpTrophy() ? `Best: ${a.gpTrophy()}` : 'Win the gold trophy!'));
      cup.addEventListener('click', () => { s.cc = opts.cc; a.saveSettings(); a.startGP({ cc: opts.cc }); });
      cards.push(cup);
    }
    ccSel = this.selector('CLASS', Object.keys(CC).map((k) => ({ value: +k, label: CC[k].label })), opts.cc, (v) => (opts.cc = v));
    lapsSel = this.selector('LAPS', [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })), 3, (v) => (opts.laps = v));
    const node = el('div', {},
      this.header(next === 'gp' ? 'GRAND PRIX' : 'SELECT TRACK', next === 'tt' ? 'Time Trial · no items, 3 turbos' : ''),
      el('div', { class: 'track-grid' + (next === 'gp' ? ' single' : '') }, cards),
      el('div', { class: 'opt-row' }, next === 'tt' ? null : ccSel, next === 'gp' ? null : lapsSel),
      this.footer([['ok', 'Race!'], ['back', 'Back']]));
    const lastIdx = TRACKS.findIndex((t) => t.id === s.lastTrack);
    if (next !== 'gp' && lastIdx >= 0) cards[lastIdx].setAttribute('autofocus', '');
    return node;
  }

  _lobby() {
    const a = this.app, net = a.net;
    const node = el('div', {});
    let joined = false;
    let ready = false;
    const list = el('div', { class: 'lobby-list' });
    const settingsBox = el('div', { class: 'lobby-settings' });
    const actions = el('div', { class: 'lobby-actions' });
    const status = el('div', { class: 'lobby-status' });
    const render = () => {
      const lob = net.lobby;
      if (!lob) return;
      const me = lob.members.find((m) => m.id === net.id);
      const isHost = lob.hostId === net.id;
      list.innerHTML = '';
      // 8 slots, growing with the lobby (one open slot) up to the server's limit
      const max = lob.max || 20;
      const slots = Math.min(max, Math.max(8, lob.members.length + 1));
      list.classList.toggle('many', slots > 8);
      for (let i = 0; i < slots; i++) {
        const m = lob.members[i];
        if (!m) { list.append(el('div', { class: 'lobby-slot empty' }, el('span', { class: 'ls-n' }, i + 1), el('span', {}, lob.settings.bots && i < 8 ? 'CPU' : 'Open'))); continue; }
        const ch = CHARACTERS[m.character % 8];
        list.append(el('div', { class: 'lobby-slot' + (m.id === net.id ? ' me' : ''), style: { '--c': hex(ch.color) } },
          el('span', { class: 'ls-n' }, i + 1),
          el('img', { src: a.portraits[ch.id] || '' }),
          el('span', { class: 'ls-name' }, m.name, m.isHost ? el('em', {}, ' HOST') : null),
          el('span', { class: 'ls-ready ' + (m.ready || m.isHost ? 'on' : '') }, m.isHost ? '★' : m.ready ? 'READY' : '…')));
      }
      const t = TRACKS.find((x) => x.id === lob.settings.track) || TRACKS[0];
      // settings (editable for host)
      const keep = this.focusEl && settingsBox.contains(this.focusEl) ? $$('.nav', settingsBox).indexOf(this.focusEl) : -1;
      settingsBox.innerHTML = '';
      settingsBox.append(el('img', { class: 'lobby-map', src: trackThumb(t, 200) }));
      if (isHost && !lob.racing) {
        const push = (patch) => net.request('lobby_settings', { ...lob.settings, ...patch });
        settingsBox.append(
          this.selector('TRACK', TRACKS.map((x) => ({ value: x.id, label: x.name })), lob.settings.track, (v) => push({ track: v })),
          this.selector('CLASS', Object.keys(CC).map((k) => ({ value: +k, label: CC[k].label })), lob.settings.cc, (v) => push({ cc: v })),
          this.selector('LAPS', [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) })), lob.settings.laps, (v) => push({ laps: v })),
          this.selector('CPU RIVALS', [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }], lob.settings.bots, (v) => push({ bots: v })));
      } else {
        settingsBox.append(el('div', { class: 'lobby-info' },
          el('div', { class: 'track-name' }, t.name),
          el('div', {}, `${CC[lob.settings.cc].label} · ${lob.settings.laps} laps · CPU ${lob.settings.bots ? 'on' : 'off'}`)));
      }
      if (keep >= 0) { const n = $$('.nav', settingsBox)[keep]; if (n) this.focus(n); }
      // actions
      const focusedAction = this.focusEl && actions.contains(this.focusEl);
      actions.innerHTML = '';
      if (!me) {
        actions.append(this.btn(lob.racing ? 'RACE IN PROGRESS…' : 'JOIN LOBBY', () => join(), { cls: 'primary' + (lob.racing ? ' dim' : '') }));
      } else if (isHost) {
        const others = lob.members.filter((m) => !m.isHost);
        const allReady = others.every((m) => m.ready);
        actions.append(this.btn('START RACE', async () => {
          const r = await net.request('lobby_start', {});
          if (r && !r.ok) this.toast({ not_ready: 'Waiting for everyone to be ready', not_host: 'Only the host can start', race_in_progress: 'A race is already running' }[r.reason] || r.reason, 'warn');
        }, { cls: 'primary' + (allReady ? '' : ' dim'), sub: allReady ? `${lob.members.length} player${lob.members.length > 1 ? 's' : ''}` : 'Waiting for ready' }));
      } else {
        ready = me.ready;
        actions.append(this.btn(ready ? 'NOT READY' : 'READY!', () => net.request('lobby_update', { ready: !ready }), { cls: ready ? '' : 'primary' }));
      }
      if (me) actions.append(this.btn('LEAVE', () => leave()));
      if (focusedAction || !this.focusEl || !this.root.contains(this.focusEl)) this.focus($('.nav', actions));
      status.textContent = lob.racing ? 'A race is running — you can join the next one.' : me ? (isHost ? 'You are the host. Pick the track and start when ready.' : 'Waiting for the host to start…') : `Share this address with friends on your network: ${location.host}`;
    };
    const join = async () => {
      if (net.lobby && net.lobby.racing) return;
      const r = await net.request('lobby_join', { name: a.settings.name, character: a.settings.character });
      if (r && r.ok) { joined = true; a.audio.play('itemGet'); }
      else this.toast(r ? ({ lobby_full: `Lobby is full (${(net.lobby && net.lobby.max) || 20} players)`, race_in_progress: 'A race is in progress' }[r.reason] || r.reason) : 'No response from the UNO Q', 'warn');
    };
    const leave = () => { net.request('lobby_leave', {}); joined = false; };
    node.append(
      this.header('LAN LOBBY', `UNO Q · ${location.host}`),
      el('div', { class: 'lobby-layout' }, list, el('div', { class: 'lobby-side' }, settingsBox, actions, status)),
      this.footer([['ok', 'Select'], ['back', 'Leave']]));
    this._lobbyRender = render;
    node._back = () => { if (joined) leave(); this._lobbyRender = null; this.stack.pop(); this.show('main', {}, { push: false }); };
    requestAnimationFrame(async () => { render(); if (!net.lobby?.racing) await join(); render(); });
    return node;
  }

  onLobby() { if (this.screen && this.screen.name === 'lobby' && this._lobbyRender) this._lobbyRender(); }

  _pause() {
    const a = this.app, r = a.race;
    const node = el('div', { class: 'pause-box' },
      el('h2', {}, 'PAUSED'),
      el('div', { class: 'pause-track' }, r ? r.def.name : ''),
      this.btn('RESUME', () => a.resume(), { attrs: { autofocus: '' } }),
      r && r.mode !== 'mp' ? this.btn('RESTART', () => a.restartRace()) : null,
      this.btn('SETTINGS', () => this.show('settings')),
      this.btn(r && r.mode === 'mp' ? 'LEAVE RACE' : 'QUIT TO MENU', () => a.quitToMenu(), { cls: 'danger' }));
    node._back = () => a.resume();
    return node;
  }

  _results({ rows, mode, title, gp, trackName, onContinue, newRecord, ghostSaved }) {
    const a = this.app;
    const table = el('div', { class: 'res-table' + (rows.length > 10 ? ' many' : '') });
    rows.forEach((r, i) => {
      const ch = CHARACTERS[r.character % 8];
      const row = el('div', { class: 'res-row' + (r.isPlayer || r.id === a.net.id ? ' me' : '') + (r.place <= 3 ? ' top' + r.place : ''), style: { '--c': hex(ch.color), animationDelay: Math.min(i, 10) * 0.07 + 's' } },
        el('span', { class: 'res-place' }, ordinal(r.place)),
        el('img', { src: a.portraits[ch.id] || '' }),
        el('span', { class: 'res-name' }, r.name, r.isBot ? el('em', {}, ' CPU') : null),
        el('span', { class: 'res-time' }, r.time == null ? 'DNF' : (r.estimated ? '~' : '') + formatTime(r.time)),
        el('span', { class: 'res-lap' }, r.bestLap ? 'best ' + formatTime(r.bestLap) : ''),
        gp ? el('span', { class: 'res-pts' }, '+' + (GP_POINTS[r.place - 1] || 0)) : null);
      table.append(row);
    });
    const node = el('div', {},
      el('div', { class: 'res-head' }, el('h2', {}, title || 'RESULTS'), el('div', { class: 'scr-sub' }, trackName || '')),
      newRecord ? el('div', { class: 'record-banner' }, newRecord) : null,
      ghostSaved ? el('div', { class: 'record-banner ghost' }, 'New personal best — ghost saved!') : null,
      table,
      el('div', { class: 'res-actions' },
        this.btn(gp ? 'NEXT' : 'CONTINUE', () => onContinue(), { cls: 'primary', attrs: { autofocus: '' } }),
        mode !== 'mp' && !gp ? this.btn('RETRY', () => a.restartRace()) : null,
        !gp ? this.btn('MENU', () => a.quitToMenu()) : null));
    node._back = () => onContinue();
    return node;
  }

  _gpStandings({ standings, raceIndex, total, onContinue, final }) {
    const a = this.app;
    const table = el('div', { class: 'res-table' });
    standings.forEach((r, i) => {
      const ch = CHARACTERS[r.character % 8];
      table.append(el('div', { class: 'res-row' + (r.isPlayer ? ' me' : '') + (i < 3 ? ' top' + (i + 1) : ''), style: { '--c': hex(ch.color), animationDelay: i * 0.07 + 's' } },
        el('span', { class: 'res-place' }, ordinal(i + 1)),
        el('img', { src: a.portraits[ch.id] || '' }),
        el('span', { class: 'res-name' }, r.name),
        el('span', { class: 'res-gain' }, r.gain ? '+' + r.gain : ''),
        el('span', { class: 'res-pts big' }, r.points)));
    });
    const node = el('div', {},
      el('div', { class: 'res-head' }, el('h2', {}, final ? 'FINAL STANDINGS' : 'GRAND PRIX'), el('div', { class: 'scr-sub' }, `Race ${raceIndex + 1} of ${total}`)),
      el('div', { class: 'gp-dots' }, Array.from({ length: total }, (_, i) => el('i', { class: i <= raceIndex ? 'on' : '' }))),
      table,
      el('div', { class: 'res-actions' }, this.btn(final ? 'AWARD CEREMONY' : 'NEXT RACE', () => onContinue(), { cls: 'primary', attrs: { autofocus: '' } }),
        !final ? this.btn('QUIT GP', () => a.quitToMenu()) : null));
    node._back = () => {};
    return node;
  }

  _podium({ place, standings, onContinue }) {
    const a = this.app;
    const trophy = place === 1 ? 'GOLD' : place === 2 ? 'SILVER' : place === 3 ? 'BRONZE' : null;
    const node = el('div', { class: 'podium-ui' },
      el('h2', { class: 'podium-title ' + (trophy ? trophy.toLowerCase() : '') }, trophy ? `${trophy} TROPHY!` : `${ordinal(place)} PLACE`),
      el('div', { class: 'scr-sub' }, trophy ? 'Q Cup champion material.' : 'Keep practicing — the podium awaits.'),
      el('div', { class: 'podium-names' }, standings.slice(0, 3).map((r, i) => el('div', { class: 'pn p' + (i + 1) }, el('b', {}, ordinal(i + 1)), r.name))),
      el('div', { class: 'res-actions' }, this.btn('CONTINUE', () => onContinue(), { cls: 'primary', attrs: { autofocus: '' } })));
    node._back = () => onContinue();
    void a;
    return node;
  }

  _records() {
    const a = this.app;
    let tab = 0;
    const body = el('div', { class: 'rec-body' });
    const tabs = TRACKS.map((t, i) => {
      const b = el('button', { class: 'nav rec-tab', onclick: () => { tab = i; render(); } }, t.name);
      b.addEventListener('mouseenter', () => this.focus(b));
      b.addEventListener('navfocus', () => { if (tab !== i) { tab = i; render(); } });
      return b;
    });
    const render = () => {
      tabs.forEach((b, i) => b.classList.toggle('sel', i === tab));
      const t = TRACKS[tab];
      const rec = (a.net.records && a.net.records.tracks && a.net.records.tracks[t.id]) || { laps: [], races: [] };
      const local = a.localRecords(t.id);
      const col = (title, list) => el('div', { class: 'rec-col' }, el('h3', {}, title),
        list.length ? list.slice(0, 10).map((r, i) => {
          const ch = CHARACTERS[(r.character || 0) % 8];
          return el('div', { class: 'rec-row', style: { '--c': hex(ch.color) } },
            el('span', { class: 'rec-n' }, i + 1), el('img', { src: a.portraits[ch.id] || '' }), el('span', { class: 'rec-name' }, r.name),
            el('span', { class: 'rec-mode' }, (r.mode || '').toUpperCase()), el('span', { class: 'rec-time' }, formatTime(r.time)));
        }) : el('div', { class: 'rec-empty' }, 'No times yet — be the first!'));
      body.innerHTML = '';
      body.append(
        el('div', { class: 'rec-track' }, el('img', { src: trackThumb(t, 160) }), el('div', {}, el('div', { class: 'track-name' }, t.name), el('div', { class: 'track-sub' }, a.net.connected ? 'Board-wide records stored on the UNO Q' : 'Offline — showing this browser only'))),
        el('div', { class: 'rec-cols' },
          col('BEST LAPS', a.net.connected ? rec.laps : local.laps),
          col('BEST RACES', a.net.connected ? rec.races : local.races)));
    };
    const node = el('div', {}, this.header('RECORDS'), el('div', { class: 'rec-tabs' }, tabs), body, this.footer([['back', 'Back']]));
    node._tab = (d) => { tab = (tab + d + TRACKS.length) % TRACKS.length; render(); this.focus(tabs[tab]); };
    a.net.request('get_records', {}).then((r) => { if (r) { a.net.records = r.records || r; if (this.screen && this.screen.name === 'records') render(); } });
    render();
    return node;
  }

  _settings() {
    const a = this.app, s = a.settings;
    const name = el('input', { class: 'nav name-input', type: 'text', maxlength: 14, value: s.name, spellcheck: 'false' });
    name.addEventListener('change', () => { s.name = (name.value || '').trim().slice(0, 14) || 'Racer'; a.saveSettings(); a.net.send('hello', { name: s.name }); });
    name.addEventListener('mouseenter', () => this.focus(name));
    const vol = (k) => this.slider({ master: 'MASTER', music: 'MUSIC', sfx: 'EFFECTS' }[k], s.volume[k], (v) => { s.volume[k] = v; a.audio.setVolumes(s.volume); a.saveSettings(); if (k === 'sfx') a.audio.play('coin'); });
    const node = el('div', {},
      this.header('SETTINGS'),
      el('div', { class: 'settings-list' },
        el('label', { class: 'set-row' }, el('span', { class: 'sel-label' }, 'NAME'), name),
        this.selector('GRAPHICS', [{ value: 'low', label: 'LOW' }, { value: 'medium', label: 'MEDIUM' }, { value: 'high', label: 'HIGH' }, { value: 'ultra', label: 'ULTRA' }], s.quality, (v) => { s.quality = v; a.saveSettings(); a.applyQuality(); }),
        vol('master'), vol('music'), vol('sfx'),
        this.selector('AUTO-ACCELERATE', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], !!s.autoAccel, (v) => { s.autoAccel = v; a.input.autoAccel = v; a.saveSettings(); }),
        this.selector('TOUCH CONTROLS', [{ value: 'auto', label: 'AUTO' }, { value: 'on', label: 'ALWAYS' }, { value: 'off', label: 'OFF' }], s.touch || 'auto', (v) => { s.touch = v; a.saveSettings(); a.updateTouch(); }),
        this.selector('SHOW FPS', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], !!s.fps, (v) => { s.fps = v; a.saveSettings(); }),
        this.btn('RESET GHOSTS & LOCAL TIMES', () => { a.clearLocalData(); this.toast('Local data cleared'); }, { cls: 'danger small' })),
      this.footer([['back', 'Back']]));
    return node;
  }

  _help() {
    const row = (k, t) => el('div', { class: 'help-row' }, el('kbd', {}, k), el('span', {}, t));
    const node = el('div', {},
      this.header('HOW TO PLAY'),
      el('div', { class: 'help-cols' },
        el('div', { class: 'help-col' }, el('h3', {}, 'KEYBOARD'),
          row('↑ / W', 'Accelerate'), row('↓ / S', 'Brake / reverse'), row('← → / A D', 'Steer'),
          row('SPACE / SHIFT', 'Hop & drift'), row('E / J / X', 'Use item'), row('↓ + item', 'Throw backwards'),
          row('Q', 'Look back'), row('C', 'Camera distance'), row('ESC', 'Pause')),
        el('div', { class: 'help-col' }, el('h3', {}, 'GAMEPAD'),
          row('A / RT', 'Accelerate'), row('B / LT', 'Brake'), row('Stick', 'Steer'), row('LB / RB', 'Hop & drift'),
          row('X', 'Use item'), row('Y', 'Look back'), row('START', 'Pause')),
        el('div', { class: 'help-col' }, el('h3', {}, 'MODULINO WHEEL'),
          row('Turn', 'Steer'), row('Gestures', 'Accelerate, brake, item, camera'), row('A', 'Hop & drift (hold)'),
          row('B', 'Use item'), row('C', 'Pause'), row('Menus', 'A Start · B Grand Prix · C LAN'),
          el('p', { class: 'help-note' }, 'Map the Edge Impulse classes to actions in Train your motion controller (main menu).')),
        el('div', { class: 'help-col' }, el('h3', {}, 'PRO TIPS'),
          el('p', {}, 'Hold drift through corners: sparks go blue → orange → purple. Release for a mini-turbo.'),
          el('p', {}, 'Hit accelerate right as the countdown shows 1 for a rocket start. Hold it from 3 and you stall! On the wheel, do the accelerate gesture on 1.'),
          el('p', {}, 'Press drift as you leave a ramp to do a trick — you get a boost when you land.'),
          el('p', {}, 'Coins raise your top speed (max 10). Getting hit drops them.'),
          el('p', {}, 'Items: Turbo, Triple Turbo, Orb, Seeker, Slick, Shield, Bomb, Mega and Storm.'))),
      this.footer([['back', 'Back']]));
    return node;
  }

  // ------------------------------------------------------------------ Modulino wheel
  _motion() {
    const a = this.app, m = a.motion, ms = a.settings.motion;
    const save = () => a.saveSettings();
    const status = el('div', { class: 'mo-status' });
    const dial = el('div', { class: 'mo-dial' }, el('div', { class: 'mo-wheel' }, el('i'), el('b')));
    const steerVal = el('div', { class: 'mo-steer-val' });
    const bars = el('div', { class: 'mo-bars' });
    const mapBox = el('div', { class: 'mo-map' });
    const ownBtn = this.btn('USE THE WHEEL ON THIS SCREEN', () => m.claim(true).then((ok) => this.toast(ok ? 'This screen now drives the wheel' : 'Could not claim the wheel', ok ? '' : 'warn')), { cls: 'small' });
    let labelsKey = '';

    const renderStatus = () => {
      const hw = m.hw;
      const chip = (on, text) => el('span', { class: 'mo-chip ' + (on ? 'on' : 'off') }, (on ? '● ' : '○ ') + text);
      status.innerHTML = '';
      if (!a.net.connected) { status.append(chip(false, 'Not connected to the UNO Q')); ownBtn.classList.add('hidden'); return; }
      if (!m.online) {
        status.append(chip(false, 'No Modulino Movement detected'), el('div', { class: 'mo-hint' }, 'Plug the Modulino wheel into the Qwiic connector. Missing Modulinos are picked up automatically.'));
        ownBtn.classList.add('hidden');
        return;
      }
      const eng = m.engine || {};
      const brick = eng.brick || {};
      status.append(
        chip(hw.movement, 'Movement'), chip(hw.buttons, 'Buttons'), chip(hw.pixels, 'Pixels'),
        chip(m.hasModel, m.hasModel ? `${eng.active === 'brick' ? 'Brick' : 'MCU'} model: ${m.engineName}` : 'No gesture model running'),
        el('div', { class: 'mo-hint' },
          m.owned ? 'This screen drives the wheel.' : m.owner ? 'Another screen is driving the wheel.' : 'The wheel is free.',
          m.hasModel ? '' : eng.pref && eng.pref !== 'auto' ? ` The ${eng.pref === 'brick' ? 'Motion detection brick' : 'MCU model'} is not available — pick AUTO or another engine.`
            : ' Train one in the Motion Lab — until then the wheel keeps the throttle down for you.',
          brick.state === 'error' ? ` Brick: ${brick.error}` : '',
          hw.sim ? ' (simulated board)' : ''));
      ownBtn.classList.toggle('hidden', m.owned || ms.enabled === 'off');
    };

    const renderMap = () => {
      const labels = m.labels.length ? m.labels : DEFAULT_LABELS;
      labelsKey = labels.join('|');
      mapBox.innerHTML = '';
      mapBox.append(el('div', { class: 'mo-sub' }, m.labels.length ? 'GESTURE → ACTION' : 'GESTURE → ACTION (default classes, no model yet)'));
      for (const label of labels) {
        mapBox.append(this.selector(label.toUpperCase(), ACTIONS, m.actionFor(label), (v) => { ms.map = { ...ms.map, [label]: v }; save(); }));
      }
      bars.innerHTML = '';
      for (const label of labels) {
        bars.append(el('div', { class: 'mo-bar', 'data-l': label }, el('span', {}, label), el('div', {}, el('i'), el('u', { style: { left: ms.threshold * 100 + '%' } })), el('b', {}, '–')));
      }
    };

    const renderLive = () => {
      const deg = -m.steer * 90;
      dial.firstChild.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      steerVal.textContent = m.online ? `${m.steer > 0.02 ? '◀ LEFT' : m.steer < -0.02 ? 'RIGHT ▶' : 'STRAIGHT'} · ${Math.round(Math.abs(m.steer) * 100)}%${m.calibrated ? '' : ' · not calibrated'}` : 'waiting for the wheel…';
      const fresh = performance.now() - m.mlAt < 1500;
      const best = m.probs.reduce((b, p, i) => (p > (m.probs[b] ?? -1) ? i : b), 0);
      for (const row of bars.children) {
        const i = m.labels.indexOf(row.dataset.l);
        const p = fresh && i >= 0 ? m.probs[i] || 0 : 0;
        row.querySelector('i').style.width = p * 100 + '%';
        row.querySelector('b').textContent = fresh && i >= 0 ? Math.round(p * 100) + '%' : '–';
        row.classList.toggle('top', fresh && i === best && p >= ms.threshold);
      }
    };

    const node = el('div', {},
      this.header('MOTION CONTROLLER', 'Modulino wheel · Edge Impulse'),
      el('div', { class: 'mo-layout' },
        el('div', { class: 'settings-list' },
          this.btn('TRAIN YOUR GESTURES', () => window.open('train.html', '_blank'), { cls: 'motion-link mo-train', icon: '🧪', sub: 'Motion Lab: record, train with Edge Impulse, deploy', attrs: { autofocus: '' } }),
          this.selector('GESTURE ENGINE', ENGINES, (m.engine && m.engine.pref) || 'auto', (v) => m.setEngine(v).then((r) => { if (!r || !r.ok) this.toast('Could not change the engine', 'warn'); })),
          this.selector('WHEEL', [{ value: 'auto', label: 'ON WHEN CONNECTED' }, { value: 'off', label: 'OFF' }], ms.enabled, (v) => { ms.enabled = v; save(); if (v === 'off') m.release(); else m.claim(false); renderStatus(); }),
          el('div', { class: 'mo-row' },
            this.btn('CALIBRATE', () => this.show('motionCal'), { cls: 'small', icon: '🎯' }),
            this.btn('RE-CENTRE', () => { m.recentre(); this.toast('Straight ahead set'); }, { cls: 'small' })),
          this.slider('SENSITIVITY', ms.sensitivity, (v) => { ms.sensitivity = v; save(); }),
          this.slider('DEADZONE', ms.deadzone, (v) => { ms.deadzone = v; save(); }),
          this.selector('INVERT STEERING', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], !!ms.invert, (v) => { ms.invert = v; save(); }),
          this.selector('TILT TO NAVIGATE MENUS', [{ value: true, label: 'ON' }, { value: false, label: 'OFF' }], ms.menuTilt !== false, (v) => { ms.menuTilt = v; save(); }),
          this.slider('GESTURE CONFIDENCE', ms.threshold, (v) => { ms.threshold = clamp(v, 0.3, 0.98); save(); for (const u of bars.querySelectorAll('u')) u.style.left = ms.threshold * 100 + '%'; }),
          mapBox),
        el('div', { class: 'mo-live' }, status, ownBtn, dial, steerVal, el('div', { class: 'mo-sub' }, 'LIVE CLASSIFICATION'), bars)),
      this.footer([['ok', 'Change'], ['back', 'Back']]));

    renderStatus();
    renderMap();
    renderLive();
    const off = m.on((what) => {
      if (!node.isConnected) { off(); return; }
      if (what === 'status' || what === 'owner') {
        renderStatus();
        const key = (m.labels.length ? m.labels : DEFAULT_LABELS).join('|');
        if (key !== labelsKey) { const f = this.focusEl; renderMap(); if (f && !f.isConnected) this.focus($('.nav', node)); }
      }
      if (what === 'imu' || what === 'ml') renderLive();
    });
    return node;
  }

  _motionCal() {
    const a = this.app, m = a.motion;
    const title = el('h3', {});
    const text = el('p', {});
    const prog = el('div', { class: 'cal-prog' }, el('i'));
    const dial = el('div', { class: 'mo-dial big' }, el('div', { class: 'mo-wheel' }, el('i'), el('b')));
    const actions = el('div', { class: 'mo-row' });
    let step = 'intro', alive = true;

    const set = (t, p, btns = []) => { title.textContent = t; text.textContent = p; actions.innerHTML = ''; actions.append(...btns); const f = btns[0]; if (f) this.focus(f); };
    const go = async () => {
      if (!m.online) { set('NO WHEEL', 'Connect the Modulino Movement first.', [this.btn('BACK', () => this.back())]); return; }
      step = 'centre';
      set('1 · HOLD IT STRAIGHT', 'Hold the wheel in your normal driving position, straight ahead, and keep it still…', [this.btn('CANCEL', () => this.back(), { cls: 'small' })]);
      await new Promise((r) => setTimeout(r, 800));
      if (!alive) return;
      await m.captureCentre();
      if (!alive) return;
      a.audio.play('menuSelect');
      step = 'right';
      set('2 · TURN FULLY RIGHT', 'Now turn the wheel all the way to the RIGHT, as far as you would steer in a hairpin, and hold it there.', [this.btn('CANCEL', () => this.back(), { cls: 'small' })]);
      const cal = await m.captureRight();
      if (!alive) return;
      a.audio.play('coin');
      step = 'done';
      set('CALIBRATED ✓', `Full lock at ${Math.round(cal.range * 180 / Math.PI)}°. Turn the wheel to check the dial, then tweak sensitivity and deadzone in the settings.`,
        [this.btn('DONE', () => this.back()), this.btn('AGAIN', () => go(), { cls: 'small' })]);
    };

    const node = el('div', { class: 'cal-box' },
      this.header('CALIBRATE THE WHEEL'),
      el('div', { class: 'cal-body' }, dial, el('div', { class: 'cal-text' }, title, text, prog, actions)),
      this.footer([['ok', 'Select'], ['back', 'Cancel']]));
    node._back = () => {
      alive = false;
      m.cancelCalibration();
      const prev = this.stack.pop();
      if (prev) this.show(prev.name, prev.args, { push: false });
      else this.reset('main');
    };
    const off = m.on((what) => {
      if (!node.isConnected) { off(); if (alive) { alive = false; m.cancelCalibration(); } return; }
      if (what === 'imu') {
        dial.firstChild.style.transform = `rotate(${(-m.steer * 90).toFixed(1)}deg)`;
        const c = m.capture;
        const p = step === 'centre' && c ? c.buf.length / c.need : step === 'right' && c ? c.progress || 0 : step === 'done' ? 1 : 0;
        prog.firstChild.style.width = clamp(p, 0, 1) * 100 + '%';
      }
      if (what === 'cal-move') text.textContent = 'Keep it still — hold the wheel straight ahead…';
    });
    set('READY?', 'Two quick steps: hold the wheel straight, then turn it fully right. Works with any mounting.', [this.btn('START', () => go()), this.btn('RESET TO DEFAULT', () => { m.resetCalibration(); this.toast('Calibration cleared'); }, { cls: 'small' })]);
    return node;
  }
}
