// Menu screens (DOM): title, main menu, tournament (host / join / lobby),
// pause, results, records, settings, help and the Modulino rod (motion
// controller) setup and calibration.
// Navigation works with mouse / touch directly and with keyboard / gamepad /
// Modulino buttons via spatial focus movement over elements marked `.nav`.
import { el, $, $$, ordinal, clamp } from './util.js';
import { ACTIONS, DEFAULT_LABELS } from './motion.js';
import { RARITY } from './fish.js';

const ENGINES = [
  { value: 'auto', label: 'AUTO' },
  { value: 'brick', label: 'APP LAB BRICK' },
  { value: 'mcu', label: 'MODEL ON THE MCU' },
];

const REASONS = {
  match_in_progress: 'A tournament is already running on that board',
  lobby_full: 'The lobby is full',
  not_host: 'Only the host can start',
  not_ready: 'Waiting for everyone to be ready',
  not_in_lobby: 'You are not in the lobby',
  unreachable: 'Could not reach that board',
  bad_address: 'Type the IP address of the host board',
  offline: 'Not connected to the UNO Q',
  no_response: 'No response from the board',
};

const kg = (v) => `${(+v || 0).toFixed(2)} kg`;

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

  hide() { this.root.classList.add('hidden'); this.root.innerHTML = ''; this.screen = null; this.app.onScreen?.(''); }

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

  // Modulino button C: next item in reading order, wrapping around
  next() {
    const all = $$('.nav', this.root).filter((e) => e.offsetParent !== null && !e.disabled);
    if (!all.length) return;
    const i = all.indexOf(this.focusEl);
    this.focus(all[(i + 1) % all.length]);
    this.app.audio.play('menuMove');
  }

  handle(actions) {
    if (!this.screen) return;
    for (const a of actions) {
      if (a === 'up' || a === 'down' || a === 'left' || a === 'right') this.move(a);
      else if (a === 'next') this.next();
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
      // Enter / Space on a natively focused button: the menu queue already handles it
      if (e.isTrusted && e.detail === 0) return;
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
      : dev === 'rod' ? { ok: 'A', back: 'B', next: 'C' }
        : dev === 'touch' ? { ok: 'Tap', back: '‹', tab: '' } : { ok: 'Enter', back: 'Esc', tab: '' };
    return el('div', { class: 'scr-foot' }, hints.map(([k, t]) => el('span', { class: 'hint' }, el('kbd', {}, map[k] || k), t)));
  }

  logo(small = false) {
    return el('div', { class: 'logo' + (small ? ' small' : '') },
      el('div', { class: 'logo-ardu' }, 'ARDU'),
      el('div', { class: 'logo-kart' }, 'FISHING'),
      small ? null : el('div', { class: 'logo-sub' }, 'A 3-MINUTE FISHING TOURNAMENT ON THE ARDUINO UNO Q'));
  }

  // ------------------------------------------------------------------ screens
  _title() {
    const node = el('div', {},
      this.logo(),
      this.btn('PRESS START', () => this.app.startPressed(), { cls: 'start-btn pulse', attrs: { autofocus: '' } }),
      el('div', { class: 'title-foot' },
        el('span', { class: 'conn ' + (this.app.net.connected ? 'on' : 'off') }, this.app.net.connected ? '● Connected to UNO Q' : '○ Offline'),
        el('span', {}, `v${this.app.version}`)));
    node._back = () => {};
    return node;
  }

  _main() {
    const a = this.app;
    const m = a.motion;
    const node = el('div', {},
      this.logo(true),
      el('div', { class: 'menu-grid' },
        this.btn('SOLO MATCH', () => a.startSolo(), { cls: 'big gp', icon: '🎣', sub: '3 minutes · catch as many fish as you can', attrs: { autofocus: '' } }),
        this.btn('TOURNAMENT', () => (a.net.connected ? this.show('tourney') : this.toast(REASONS.offline, 'warn')), {
          cls: 'big mp' + (a.net.connected ? '' : ' dim'), icon: '🏆',
          sub: a.net.connected ? 'Board vs board · live scoreboard' : 'Server offline',
        }),
        this.btn('TRAIN YOUR MOTION CONTROLLER', () => this.show('motion'), {
          cls: 'motion-main', icon: '🧪',
          sub: m.online ? `Rod connected · ${m.hasModel ? 'model running' : 'no model yet'}` : 'Modulino rod · record gestures · train with Edge Impulse',
        }),
        this.btn('RECORDS', () => this.show('records'), { icon: '📜' }),
        this.btn('SETTINGS', () => this.show('settings'), { icon: '⚙' }),
        this.btn('HOW TO PLAY', () => this.show('help'), { icon: '❓' })),
      el('div', { class: 'player-tag' }, el('span', {}, 'Fishing as '), el('b', {}, a.settings.name)));
    node._back = () => this.show('title', {}, { push: false });
    return node;
  }

  // host on this board or join another board
  _tourney() {
    const a = this.app, t = a.tourney;
    const me = a.net.board || location.hostname;
    const ip = el('input', { class: 'nav name-input ip-input', type: 'text', maxlength: 40, placeholder: '192.168.1.42', spellcheck: 'false', value: t.recentHosts()[0] || '' });
    ip.addEventListener('mouseenter', () => this.focus(ip));
    ip.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(ip.value); } });
    const busy = el('div', { class: 'lobby-status' });
    const go = async (addr) => {
      busy.textContent = addr ? `Connecting to ${addr}…` : 'Opening the lobby on this board…';
      const r = await t.connect(addr || null);
      if (r && r.ok) { a.audio.play('menuSelect'); this.show('lobby'); return; }
      busy.textContent = '';
      this.toast(REASONS[r && r.reason] || (r && r.reason) || REASONS.no_response, 'warn');
    };
    const recents = t.recentHosts().filter((h) => h !== me).slice(0, 3);
    const node = el('div', {},
      this.header('TOURNAMENT', 'Every player fishes on their own UNO Q · one board hosts'),
      el('div', { class: 'tn-layout' },
        el('div', { class: 'tn-card' },
          el('h3', {}, 'HOST HERE'),
          el('p', {}, 'Players on other boards join with this address:'),
          el('div', { class: 'tn-ip' }, me),
          this.btn('HOST ON THIS BOARD', () => go(null), { cls: 'primary', icon: '📡', attrs: { autofocus: '' } })),
        el('div', { class: 'tn-card' },
          el('h3', {}, 'JOIN ANOTHER BOARD'),
          el('p', {}, 'Type the IP address shown on the host screen:'),
          ip,
          this.btn('JOIN', () => go(ip.value.trim()), { cls: 'primary', icon: '🔗' }),
          recents.length ? el('div', { class: 'tn-recent' }, recents.map((h) => this.btn(h, () => go(h), { cls: 'small' }))) : null)),
      busy,
      this.footer([['ok', 'Select'], ['back', 'Back']]));
    return node;
  }

  _lobby() {
    const a = this.app, t = a.tourney;
    const list = el('div', { class: 'lobby-list' });
    const info = el('div', { class: 'lobby-info' });
    const actions = el('div', { class: 'lobby-actions' });
    const status = el('div', { class: 'lobby-status' });
    const render = () => {
      const lob = t.lobby;
      if (!lob) { status.textContent = 'Waiting for the host board…'; return; }
      const me = lob.members.find((m) => m.id === t.myId);
      const isHost = lob.hostId === t.myId;
      list.innerHTML = '';
      const slots = Math.min(lob.max || 20, Math.max(8, lob.members.length + 1));
      list.classList.toggle('many', slots > 8);
      for (let i = 0; i < slots; i++) {
        const m = lob.members[i];
        if (!m) { list.append(el('div', { class: 'lobby-slot empty' }, el('span', { class: 'ls-n' }, i + 1), el('span', {}, 'Open'))); continue; }
        list.append(el('div', { class: 'lobby-slot' + (m.id === t.myId ? ' me' : '') },
          el('span', { class: 'ls-n' }, i + 1),
          el('span', { class: 'ls-name' }, m.name, m.isHost ? el('em', {}, ' HOST') : null, el('small', {}, ' · ' + m.board)),
          el('span', { class: 'ls-ready ' + (m.ready || m.isHost ? 'on' : '') }, m.isHost ? '★' : m.ready ? 'READY' : '…')));
      }
      info.replaceChildren(
        el('div', { class: 'track-name' }, (lob.durationMs || 180000) % 60000 ? `${Math.round((lob.durationMs || 180000) / 1000)}-SECOND MATCH` : `${(lob.durationMs || 180000) / 60000}-MINUTE MATCH`),
        el('div', {}, t.remote ? `Hosted by ${t.addr}` : `Hosted on this board · ${t.addr}`),
        el('div', { class: 'lobby-rules' }, 'Most fish wins · ties go to total weight. Every board gets the same fish at the same time.'));
      const focusedAction = this.focusEl && actions.contains(this.focusEl);
      actions.innerHTML = '';
      if (!t.connected) {
        actions.append(this.btn('RECONNECT', () => t.connect(t.remote ? t.addr : null), { cls: 'primary' }));
      } else if (!me) {
        actions.append(this.btn(lob.playing ? 'MATCH IN PROGRESS…' : 'JOIN LOBBY', () => t.join().then((r) => { if (!r.ok) this.toast(REASONS[r.reason] || r.reason, 'warn'); }), { cls: 'primary' + (lob.playing ? ' dim' : '') }));
      } else if (isHost) {
        const others = lob.members.filter((m) => !m.isHost);
        const allReady = others.every((m) => m.ready);
        actions.append(this.btn('START MATCH', async () => {
          const r = await t.start();
          if (r && !r.ok) this.toast(REASONS[r.reason] || r.reason, 'warn');
        }, { cls: 'primary' + (allReady ? '' : ' dim'), sub: allReady ? `${lob.members.length} angler${lob.members.length > 1 ? 's' : ''}` : 'Waiting for ready' }));
      } else {
        actions.append(this.btn(me.ready ? 'NOT READY' : 'READY!', () => t.setReady(!me.ready), { cls: me.ready ? '' : 'primary' }));
      }
      actions.append(this.btn('LEAVE', () => node._back()));
      if (focusedAction || !this.focusEl || !this.root.contains(this.focusEl)) this.focus($('.nav', actions));
      status.textContent = !t.connected ? 'Disconnected from the host board.'
        : lob.playing ? 'A match is running — you can join the next one.'
          : me ? (isHost ? 'You are the host. Start when everyone is ready.' : 'Waiting for the host to start…') : '';
    };
    const node = el('div', {},
      this.header('TOURNAMENT LOBBY', t.remote ? `Host board ${t.addr}` : `This board · ${t.addr}`),
      el('div', { class: 'lobby-layout' }, list, el('div', { class: 'lobby-side' }, info, actions, status)),
      this.footer([['ok', 'Select'], ['back', 'Leave']]));
    this._lobbyRender = render;
    node._back = () => { t.disconnect(); this._lobbyRender = null; this.reset('main'); };
    requestAnimationFrame(render);
    return node;
  }

  onLobby() { if (this.screen && this.screen.name === 'lobby' && this._lobbyRender) this._lobbyRender(); }

  _pause() {
    const a = this.app, g = a.game;
    const tourney = g && g.mode === 'tourney';
    const node = el('div', { class: 'pause-box' },
      el('h2', {}, tourney ? 'MENU' : 'PAUSED'),
      el('div', { class: 'pause-track' }, tourney ? 'The tournament clock keeps running!' : `${g ? g.fish : 0} fish · ${kg(g ? g.kg : 0)}`),
      this.btn('RESUME', () => a.resume(), { attrs: { autofocus: '' } }),
      tourney ? null : this.btn('RESTART', () => a.startSolo()),
      this.btn('SETTINGS', () => this.show('settings')),
      this.btn(tourney ? 'LEAVE TOURNAMENT' : 'QUIT TO MENU', () => a.quitToMenu(), { cls: 'danger' }));
    node._back = () => a.resume();
    return node;
  }

  _waiting() {
    const node = el('div', { class: 'pause-box' },
      el('h2', {}, "TIME'S UP!"),
      el('div', { class: 'pause-track' }, 'Collecting the scores from every board…'),
      el('div', { class: 'spinner' }));
    node._back = () => {};
    return node;
  }

  // solo: {game, rankMatch, rankFish} · tourney: {game, rows, estimated}
  _results({ game, rows = null, estimated = false, rankMatch = null, rankFish = null }) {
    const a = this.app, g = game;
    const tourney = !!rows;
    const myId = a.tourney.myId;
    const me = tourney ? rows.find((r) => r.id === myId) : null;
    const title = tourney ? (me && me.place === 1 ? 'CHAMPION!' : 'RESULTS') : g.fish ? 'NICE FISHING!' : 'TIME\'S UP';
    let body;
    if (tourney) {
      body = el('div', { class: 'res-table' + (rows.length > 10 ? ' many' : '') }, rows.map((r, i) =>
        el('div', { class: 'res-row' + (r.id === myId ? ' me' : '') + (r.place <= 3 ? ' top' + r.place : ''), style: { animationDelay: Math.min(i, 10) * 0.07 + 's' } },
          el('span', { class: 'res-place' }, ordinal(r.place)),
          el('span', { class: 'res-name' }, r.name, r.left ? el('em', {}, ' LEFT') : null, el('small', {}, r.board)),
          el('span', { class: 'res-time' }, `${r.fish} 🐟`),
          el('span', { class: 'res-lap' }, kg(r.kg)),
          el('span', { class: 'res-lap' }, r.biggest ? `${r.biggest.species} ${kg(r.biggest.kg)}` : ''))));
    } else {
      const s = g.stats;
      body = el('div', { class: 'solo-res' },
        el('div', { class: 'sr-big' }, el('b', {}, g.fish), el('span', {}, g.fish === 1 ? 'FISH' : 'FISH'), el('em', {}, kg(g.kg))),
        el('div', { class: 'sr-stats' },
          el('span', {}, `${s.casts} casts`), el('span', {}, `${s.perfect} perfect`), el('span', {}, `${s.snapped} snapped`), el('span', {}, `${s.escaped} got away`)),
        el('div', { class: 'sr-list' }, g.catches.length ? g.catches.map((c) => {
          const r = RARITY[c.rarity] || RARITY.common;
          return el('div', { class: 'sr-fish' + (c === g.biggest ? ' best' : ''), style: { '--rc': r.color } },
            el('span', { class: 'sr-r' }, r.label), el('span', {}, c.species), el('b', {}, kg(c.kg)));
        }) : el('div', { class: 'rec-empty' }, 'No fish this time — aim at the signs on the water and cast close to them!')));
    }
    const banner = rankMatch === 1 ? 'NEW BOARD RECORD!' : rankMatch ? `#${rankMatch} on this board` : rankFish === 1 ? 'BIGGEST FISH EVER ON THIS BOARD!' : null;
    const node = el('div', {},
      el('div', { class: 'res-head' }, el('h2', {}, title), el('div', { class: 'scr-sub' }, tourney ? (estimated ? 'Provisional — the host did not answer' : 'Tournament') : 'Solo · 3 minutes')),
      banner ? el('div', { class: 'record-banner' }, banner) : null,
      body,
      el('div', { class: 'res-actions' },
        tourney ? this.btn('BACK TO LOBBY', () => a.backToLobby(), { cls: 'primary', attrs: { autofocus: '' } })
          : this.btn('PLAY AGAIN', () => a.startSolo(), { cls: 'primary', attrs: { autofocus: '' } }),
        this.btn('MENU', () => a.quitToMenu())));
    node._back = () => (tourney ? a.backToLobby() : a.quitToMenu());
    return node;
  }

  _records() {
    const a = this.app;
    let tab = 0;
    const TABS = ['BEST MATCHES', 'BIGGEST FISH'];
    const body = el('div', { class: 'rec-body' });
    const tabs = TABS.map((name, i) => {
      const b = el('button', { class: 'nav rec-tab', onclick: () => { tab = i; render(); } }, name);
      b.addEventListener('mouseenter', () => this.focus(b));
      b.addEventListener('navfocus', () => { if (tab !== i) { tab = i; render(); } });
      return b;
    });
    const render = () => {
      tabs.forEach((b, i) => b.classList.toggle('sel', i === tab));
      const src = a.net.connected && a.net.records ? a.net.records : a.localRecords();
      const list = (tab === 0 ? src.matches : src.fish) || [];
      body.innerHTML = '';
      body.append(
        el('div', { class: 'track-sub' }, a.net.connected ? 'Board-wide records stored on the UNO Q' : 'Offline — showing this browser only'),
        el('div', { class: 'rec-col' }, list.length ? list.slice(0, 10).map((r, i) => tab === 0
          ? el('div', { class: 'rec-row' }, el('span', { class: 'rec-n' }, i + 1), el('span', { class: 'rec-name' }, r.name),
            el('span', { class: 'rec-mode' }, (r.mode || '').toUpperCase()), el('span', { class: 'rec-time' }, `${r.fish} 🐟 · ${kg(r.kg)}`))
          : el('div', { class: 'rec-row', style: { '--c': (RARITY[r.rarity] || RARITY.common).color } }, el('span', { class: 'rec-n' }, i + 1), el('span', { class: 'rec-name' }, r.name),
            el('span', { class: 'rec-mode' }, r.species), el('span', { class: 'rec-time' }, kg(r.kg))))
          : el('div', { class: 'rec-empty' }, 'No records yet — be the first!')));
    };
    const node = el('div', {}, this.header('RECORDS'), el('div', { class: 'rec-tabs' }, tabs), body, this.footer([['back', 'Back']]));
    node._tab = (d) => { tab = (tab + d + TABS.length) % TABS.length; render(); this.focus(tabs[tab]); };
    a.net.request('get_records', {}).then((r) => { if (r) { a.net.records = r; if (this.screen && this.screen.name === 'records') render(); } });
    render();
    return node;
  }

  _settings() {
    const a = this.app, s = a.settings;
    const name = el('input', { class: 'nav name-input', type: 'text', maxlength: 14, value: s.name, spellcheck: 'false' });
    name.addEventListener('change', () => { s.name = (name.value || '').trim().slice(0, 14) || 'Angler'; a.saveSettings(); a.net.send('hello', { name: s.name }); });
    name.addEventListener('mouseenter', () => this.focus(name));
    const vol = (k) => this.slider({ master: 'MASTER', music: 'MUSIC', sfx: 'EFFECTS' }[k], s.volume[k], (v) => { s.volume[k] = v; a.audio.setVolumes(s.volume); a.saveSettings(); if (k === 'sfx') a.audio.play('plop'); });
    const node = el('div', {},
      this.header('SETTINGS'),
      el('div', { class: 'settings-list' },
        el('label', { class: 'set-row' }, el('span', { class: 'sel-label' }, 'NAME'), name),
        this.selector('GRAPHICS', [{ value: 'low', label: 'LOW' }, { value: 'medium', label: 'MEDIUM' }, { value: 'high', label: 'HIGH' }, { value: 'ultra', label: 'ULTRA' }], s.quality, (v) => { s.quality = v; a.saveSettings(); a.applyQuality(); }),
        vol('master'), vol('music'), vol('sfx'),
        this.slider('BUTTON CAST STRENGTH', s.buttonCast, (v) => { s.buttonCast = clamp(v, 0.5, 1); a.saveSettings(); }),
        this.selector('TOUCH CONTROLS', [{ value: 'auto', label: 'AUTO' }, { value: 'on', label: 'ALWAYS' }, { value: 'off', label: 'OFF' }], s.touch || 'auto', (v) => { s.touch = v; a.saveSettings(); a.updateTouch(); }),
        this.selector('SHOW FPS', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], !!s.fps, (v) => { s.fps = v; a.saveSettings(); }),
        this.btn('CLEAR LOCAL RECORDS', () => { a.clearLocalData(); this.toast('Local records cleared'); }, { cls: 'danger small' })),
      this.footer([['back', 'Back']]));
    return node;
  }

  _help() {
    const row = (k, t) => el('div', { class: 'help-row' }, el('kbd', {}, k), el('span', {}, t));
    const node = el('div', {},
      this.header('HOW TO PLAY'),
      el('div', { class: 'help-cols' },
        el('div', { class: 'help-col' }, el('h3', {}, 'MODULINO ROD'),
          row('Turn', 'Aim the cast (gyroscope)'), row('Cast gesture', 'Cast · a cleaner gesture lands closer'),
          row('Reel gesture', 'Reel the fish in'), row('Unhook gesture', 'Take the fish off the hook'),
          row('A · B · C', 'Cast · reel (hold) · unhook'),
          el('p', { class: 'help-note' }, 'Record and train the gestures in the Motion Lab (Train your motion controller).')),
        el('div', { class: 'help-col' }, el('h3', {}, 'KEYBOARD'),
          row('← → / A D', 'Aim'), row('SPACE / ENTER', 'Cast'), row('S / ↓ (hold)', 'Reel'), row('W / ↑', 'Unhook'), row('ESC', 'Menu')),
        el('div', { class: 'help-col' }, el('h3', {}, 'GAMEPAD'),
          row('Stick', 'Aim'), row('A', 'Cast'), row('X / RT', 'Reel'), row('Y', 'Unhook'), row('START', 'Menu')),
        el('div', { class: 'help-col' }, el('h3', {}, 'TIPS'),
          el('p', {}, 'Watch the water: ripples, bubbles, jumps and dark shadows show where fish are. The fish finder at the bottom shows them too.'),
          el('p', {}, 'Aim at a sign until the ring turns gold, then cast. Shadows hide the big ones, and a golden shimmer means a Golden Koi.'),
          el('p', {}, 'When the fish runs, stop reeling or tilt the rod to the other side. Keep reeling at full tension and the line snaps; leave it slack and it gets away.'),
          el('p', {}, 'Most fish in 3 minutes wins. Ties go to total weight.'))),
      this.footer([['back', 'Back']]));
    return node;
  }

  // ------------------------------------------------------------------ Modulino rod
  _motion() {
    const a = this.app, m = a.motion, ms = a.settings.motion;
    const save = () => a.saveSettings();
    const status = el('div', { class: 'mo-status' });
    const dial = el('div', { class: 'mo-dial rod' }, el('div', { class: 'mo-wheel' }, el('i'), el('b')));
    const steerVal = el('div', { class: 'mo-steer-val' });
    const bars = el('div', { class: 'mo-bars' });
    const mapBox = el('div', { class: 'mo-map' });
    const ownBtn = this.btn('USE THE ROD ON THIS SCREEN', () => m.claim(true).then((ok) => this.toast(ok ? 'This screen now uses the rod' : 'Could not claim the rod', ok ? '' : 'warn')), { cls: 'small' });
    let labelsKey = '';

    const renderStatus = () => {
      const hw = m.hw || {};
      const chip = (on, text) => el('span', { class: 'mo-chip ' + (on ? 'on' : 'off') }, (on ? '● ' : '○ ') + text);
      status.innerHTML = '';
      if (!a.net.connected) { status.append(chip(false, 'Not connected to the UNO Q')); ownBtn.classList.add('hidden'); return; }
      if (!m.online) {
        status.append(chip(false, 'No Modulino Movement detected'), el('div', { class: 'mo-hint' }, 'Plug the Modulino Movement into the Qwiic connector. Missing Modulinos are picked up automatically.'));
        ownBtn.classList.add('hidden');
        return;
      }
      const eng = m.engine || {};
      const brick = eng.brick || {};
      status.append(
        chip(hw.movement, 'Movement'), chip(hw.buttons, 'Buttons'), chip(hw.pixels, 'Pixels'),
        chip(m.hasModel, m.hasModel ? `${eng.active === 'brick' ? 'Brick' : 'MCU'} model: ${m.engineName}` : 'No gesture model running'),
        el('div', { class: 'mo-hint' },
          m.owned ? 'This screen uses the rod.' : m.owner ? 'Another screen is using the rod.' : 'The rod is free.',
          m.hasModel ? '' : eng.pref && eng.pref !== 'auto' ? ` The ${eng.pref === 'brick' ? 'Motion detection brick' : 'MCU model'} is not available — pick AUTO or another engine.`
            : ' Train one in the Motion Lab. Until then, use the buttons: A cast, B reel, C unhook.',
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
      dial.firstChild.style.transform = `rotate(${(-m.steer * 50).toFixed(1)}deg)`;
      steerVal.textContent = m.online ? `${m.steer > 0.02 ? '◀ AIM LEFT' : m.steer < -0.02 ? 'AIM RIGHT ▶' : 'AHEAD'} · ${Math.round(Math.abs(m.steer) * 100)}%${m.calibrated ? '' : ' · not calibrated'}` : 'waiting for the rod…';
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
      this.header('MOTION CONTROLLER', 'Modulino rod · Edge Impulse'),
      el('div', { class: 'mo-layout' },
        el('div', { class: 'settings-list' },
          this.btn('TRAIN YOUR GESTURES', () => window.open('train.html', '_blank'), { cls: 'motion-link mo-train', icon: '🧪', sub: 'Motion Lab: record cast / reel / unhook, train with Edge Impulse, deploy', attrs: { autofocus: '' } }),
          this.selector('GESTURE ENGINE', ENGINES, (m.engine && m.engine.pref) || 'auto', (v) => m.setEngine(v).then((r) => { if (!r || !r.ok) this.toast('Could not change the engine', 'warn'); })),
          this.selector('ROD', [{ value: 'auto', label: 'ON WHEN CONNECTED' }, { value: 'off', label: 'OFF' }], ms.enabled, (v) => { ms.enabled = v; save(); if (v === 'off') m.release(); else m.claim(false); renderStatus(); }),
          el('div', { class: 'mo-row' },
            this.btn('CALIBRATE', () => this.show('motionCal'), { cls: 'small', icon: '🎯' }),
            this.btn('RE-CENTRE', () => { m.recentre(); this.toast('Straight ahead set'); }, { cls: 'small' })),
          this.slider('AIM SENSITIVITY', ms.sensitivity, (v) => { ms.sensitivity = v; save(); }),
          this.slider('DEADZONE', ms.deadzone, (v) => { ms.deadzone = v; save(); }),
          this.selector('INVERT AIM', [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }], !!ms.invert, (v) => { ms.invert = v; save(); }),
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
    const dial = el('div', { class: 'mo-dial big rod' }, el('div', { class: 'mo-wheel' }, el('i'), el('b')));
    const actions = el('div', { class: 'mo-row' });
    let step = 'intro', alive = true;

    const set = (t, p, btns = []) => { title.textContent = t; text.textContent = p; actions.innerHTML = ''; actions.append(...btns); const f = btns[0]; if (f) this.focus(f); };
    const go = async () => {
      if (!m.online) { set('NO ROD', 'Connect the Modulino Movement first.', [this.btn('BACK', () => this.back())]); return; }
      step = 'centre';
      m.startCalibration();
      set('1 · POINT IT AHEAD', 'Hold the rod as you would to cast, pointing straight at the lake, and keep it still…', [this.btn('CANCEL', () => this.back(), { cls: 'small' })]);
      await new Promise((r) => setTimeout(r, 800));
      if (!alive) return;
      await m.captureCentre();
      if (!alive) return;
      a.audio.play('menuSelect');
      step = 'right';
      set('2 · TURN FULLY RIGHT', 'Now turn the rod as far RIGHT as you want to aim, and hold it there.', [this.btn('CANCEL', () => this.back(), { cls: 'small' })]);
      const cal = await m.captureRight();
      if (!alive) return;
      a.audio.play('catch', { rarity: 'common' });
      step = 'done';
      set('CALIBRATED ✓', `Full aim at ${Math.round(cal.range * 180 / Math.PI)}°. Turn the rod to check the dial, then tweak sensitivity and deadzone in the settings.`,
        [this.btn('DONE', () => this.back()), this.btn('AGAIN', () => go(), { cls: 'small' })]);
    };

    const node = el('div', { class: 'cal-box' },
      this.header('CALIBRATE THE ROD'),
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
        dial.firstChild.style.transform = `rotate(${(-m.steer * 50).toFixed(1)}deg)`;
        const c = m.capture;
        const p = step === 'centre' && c ? c.buf.length / c.need : step === 'right' && c ? c.progress || 0 : step === 'done' ? 1 : 0;
        prog.firstChild.style.width = clamp(p, 0, 1) * 100 + '%';
      }
      if (what === 'cal-move') text.textContent = 'Keep it still — hold the rod straight ahead…';
    });
    set('READY?', 'Two quick steps: point the rod straight ahead, then turn it fully right. Works with any mounting.', [this.btn('START', () => go()), this.btn('RESET TO DEFAULT', () => { m.resetCalibration(); this.toast('Calibration cleared'); }, { cls: 'small' })]);
    return node;
  }
}
