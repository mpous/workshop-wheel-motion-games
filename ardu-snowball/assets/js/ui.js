// Menu screens (DOM): title, main menu, LAN tournament (host / join / lobby),
// pause, results, records, settings, help and the Modulino controller
// (motion) setup and calibration.
// Navigation works with mouse / touch directly and with keyboard / gamepad /
// Modulino buttons via spatial focus movement over elements marked `.nav`.
import { el, $, $$, clamp } from './util.js';
import { ACTIONS, DEFAULT_LABELS } from './motion.js';
import { TEAM_CSS, TEAM_NAME } from './world.js';

const ENGINES = [
  { value: 'auto', label: 'AUTO' },
  { value: 'brick', label: 'APP LAB BRICK' },
  { value: 'mcu', label: 'MODEL ON THE MCU' },
];

const REASONS = {
  match_in_progress: 'A match is already running on that board',
  lobby_full: 'The lobby is full (8 players)',
  not_host: 'Only the host can start',
  not_ready: 'Waiting for everyone to be ready',
  not_in_lobby: 'You are not in the lobby',
  unreachable: 'Could not reach that board',
  bad_address: 'Type the IP address of the host board',
  offline: 'Not connected to the UNO Q',
  no_response: 'No response from the board',
};

const SKILLS = [{ value: 'easy', label: 'EASY' }, { value: 'normal', label: 'NORMAL' }, { value: 'hard', label: 'HARD' }];
const RESULT_LBL = { win: 'WIN', loss: 'LOSS', draw: 'DRAW' };

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

  btn(label, onClick, { cls = '', sub = '', icon = '', attrs = {} } = {}) {
    const b = el('button', { class: 'nav btn ' + cls, ...attrs },
      icon ? el('span', { class: 'btn-ico' }, icon) : null,
      el('span', { class: 'btn-label' }, label),
      sub ? el('span', { class: 'btn-sub' }, sub) : null);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.isTrusted && e.detail === 0) return; // Enter / Space: the menu queue already handles it
      this.app.audio.unlock();
      this.app.audio.play('menuSelect');
      onClick?.(e);
    });
    b.addEventListener('mouseenter', () => { if (this.focusEl !== b) this.focus(b); });
    return b;
  }

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

  slider(label, value, onChange, { min = 0, max = 1 } = {}) {
    const fill = el('i');
    const valEl = el('span', { class: 'sl-val' });
    let v = value;
    const render = () => { fill.style.width = ((v - min) / (max - min)) * 100 + '%'; valEl.textContent = Math.round(v * 100); };
    const set = (nv) => { v = clamp(Math.round(nv * 20) / 20, min, max); render(); onChange(v); };
    const track = el('div', { class: 'sl-track' }, fill);
    const row = el('div', { class: 'nav slider' }, el('span', { class: 'sel-label' }, label), track, valEl);
    row._lr = (d) => set(v + d * 0.05);
    const drag = (e) => {
      const r = track.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      set(min + (x / r.width) * (max - min));
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
      : dev === 'motion' ? { ok: 'A', back: 'B', next: 'C' }
        : dev === 'touch' ? { ok: 'Tap', back: '‹', tab: '' } : { ok: 'Enter', back: 'Esc', tab: '' };
    return el('div', { class: 'scr-foot' }, hints.map(([k, t]) => el('span', { class: 'hint' }, el('kbd', {}, map[k] || k), t)));
  }

  logo(small = false) {
    return el('div', { class: 'logo' + (small ? ' small' : '') },
      el('div', { class: 'logo-ardu' }, 'ARDU'),
      el('div', { class: 'logo-kart' }, 'SNOWBALL'),
      small ? null : el('div', { class: 'logo-sub' }, 'CAPTURE THE STAR · 3-MINUTE SNOWBALL FIGHTS ON THE ARDUINO UNO Q'));
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
        this.btn('SOLO 3 v 3', () => a.startSolo(), { cls: 'big gp', icon: '❄', sub: 'You + 2 bots vs 3 bots · 3 minutes', attrs: { autofocus: '' } }),
        this.btn('TOURNAMENT', () => (a.net.connected ? this.show('tourney') : this.toast(REASONS.offline, 'warn')), {
          cls: 'big mp' + (a.net.connected ? '' : ' dim'), icon: '🏆',
          sub: a.net.connected ? 'LAN match between boards · bots fill gaps' : 'Server offline',
        }),
        this.btn('TRAIN YOUR MOTION CONTROLLER', () => this.show('motion'), {
          cls: 'motion-main', icon: '🧪',
          sub: m.online ? `Controller connected · ${m.hasModel ? 'model running' : 'no model yet'}` : 'Modulino controller · record gestures · train with Edge Impulse',
        }),
        this.btn('RECORDS', () => this.show('records'), { icon: '📜' }),
        this.btn('SETTINGS', () => this.show('settings'), { icon: '⚙' }),
        this.btn('HOW TO PLAY', () => this.show('help'), { icon: '❓' })),
      el('div', { class: 'player-tag' }, el('span', {}, 'Playing as '), el('b', {}, a.settings.name)));
    node._back = () => this.show('title', {}, { push: false });
    return node;
  }

  // host on this board or join another board
  _tourney() {
    const a = this.app, t = a.lan;
    const me = a.net.board || location.hostname;
    const ip = el('input', { class: 'nav name-input ip-input', type: 'text', maxlength: 40, placeholder: '192.168.1.42', spellcheck: 'false', value: t.recentHosts()[0] || '' });
    ip.addEventListener('mouseenter', () => this.focus(ip));
    ip.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(ip.value); } });
    const busy = el('div', { class: 'lobby-status' });
    const go = async (addr) => {
      busy.replaceChildren(el('span', { class: 'spinner small' }), addr ? ` Connecting to ${addr}…` : ' Opening the lobby on this board…');
      const r = await t.connect(addr || null);
      if (r && r.ok) { a.audio.play('menuSelect'); this.show('lobby'); return; }
      busy.textContent = '';
      this.toast(REASONS[r && r.reason] || (r && r.reason) || REASONS.no_response, 'warn');
    };
    const recents = t.recentHosts().filter((h) => h !== me).slice(0, 3);
    const node = el('div', {},
      this.header('TOURNAMENT', 'Every player plays on their own UNO Q · one board hosts the match'),
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
    const a = this.app, t = a.lan;
    const cols = el('div', { class: 'lobby-teams' });
    const info = el('div', { class: 'lobby-info' });
    const actions = el('div', { class: 'lobby-actions' });
    const status = el('div', { class: 'lobby-status' });
    const render = () => {
      const lob = t.lobby;
      if (!lob) { status.textContent = 'Waiting for the host board…'; return; }
      const me = lob.members.find((m) => m.id === t.myId);
      const isHost = lob.hostId === t.myId;
      const groups = { 0: [], 1: [], '-1': [] };
      for (const m of lob.members) (groups[m.team] || groups[-1]).push(m);
      const slot = (m) => el('div', { class: 'lobby-slot' + (m.id === t.myId ? ' me' : '') },
        el('span', { class: 'ls-name' }, m.name, m.isHost ? el('em', {}, ' HOST') : null, el('small', {}, ' · ' + m.board)),
        el('span', { class: 'ls-ready ' + (m.ready || m.isHost ? 'on' : '') }, m.isHost ? '★' : m.ready ? 'READY' : '…'));
      const col = (team, title) => el('div', { class: 'lobby-team', style: { '--c': team >= 0 ? TEAM_CSS[team] : '#9fb7d8' } },
        el('h3', {}, title, el('small', {}, ` ${groups[team].length}`)),
        groups[team].length ? groups[team].map(slot) : el('div', { class: 'lobby-slot empty' }, team >= 0 ? 'Bots will play here' : 'Nobody'));
      cols.replaceChildren(col(0, 'BLUE TEAM'), col(-1, 'AUTO'), col(1, 'RED TEAM'));
      info.replaceChildren(
        el('div', { class: 'track-name' }, `${Math.round((lob.durationMs || 180000) / 60000)}-MINUTE CAPTURE THE STAR`),
        el('div', {}, t.remote ? `Hosted by ${t.addr}` : `Hosted on this board · ${t.addr}`),
        el('div', { class: 'lobby-rules' }, 'Grab the enemy star and bring it to your base. Most captures wins · ties go to hits. Empty slots are filled with bots (at least 3 v 3).'));
      const focusedAction = this.focusEl && actions.contains(this.focusEl);
      actions.innerHTML = '';
      if (!t.connected) {
        actions.append(this.btn('RECONNECT', () => t.connect(t.remote ? t.addr : null), { cls: 'primary' }));
      } else if (!me) {
        actions.append(this.btn(lob.playing ? 'MATCH IN PROGRESS…' : 'JOIN LOBBY', () => t.join().then((r) => { if (!r.ok) this.toast(REASONS[r.reason] || r.reason, 'warn'); }), { cls: 'primary' + (lob.playing ? ' dim' : '') }));
      } else {
        if (isHost) {
          const others = lob.members.filter((m) => !m.isHost);
          const allReady = others.every((m) => m.ready);
          actions.append(this.btn('START MATCH', async () => {
            const r = await t.start();
            if (r && !r.ok) this.toast(REASONS[r.reason] || r.reason, 'warn');
          }, { cls: 'primary' + (allReady && !lob.playing ? '' : ' dim'), sub: allReady ? `${lob.members.length} player${lob.members.length > 1 ? 's' : ''} + bots` : 'Waiting for ready' }));
        } else {
          actions.append(this.btn(me.ready ? 'NOT READY' : 'READY!', () => t.setReady(!me.ready), { cls: me.ready ? '' : 'primary' }));
        }
        actions.append(this.selector('TEAM', [{ value: -1, label: 'AUTO' }, { value: 0, label: 'BLUE' }, { value: 1, label: 'RED' }], me.team, (v) => t.setTeam(v)));
      }
      actions.append(this.btn('LEAVE', () => node._back()));
      if (focusedAction || !this.focusEl || !this.root.contains(this.focusEl)) {
        const sel = focusedAction && this.focusEl.classList.contains('selector') ? $('.selector', actions) : $('.nav', actions);
        this.focus(sel);
      }
      status.textContent = !t.connected ? 'Disconnected from the host board.'
        : lob.playing ? 'A match is running — you can join the next one.'
          : me ? (isHost ? 'You are the host: your browser runs the bots. Start when everyone is ready.' : 'Waiting for the host to start…') : '';
    };
    const node = el('div', {},
      this.header('TOURNAMENT LOBBY', t.remote ? `Host board ${t.addr}` : `This board · ${t.addr}`),
      el('div', { class: 'lobby-layout' }, cols, el('div', { class: 'lobby-side' }, info, actions, status)),
      this.footer([['ok', 'Select'], ['back', 'Leave']]));
    this._lobbyRender = render;
    node._back = () => { t.disconnect(); this._lobbyRender = null; this.reset('main'); };
    requestAnimationFrame(render);
    return node;
  }

  onLobby() { if (this.screen && this.screen.name === 'lobby' && this._lobbyRender) this._lobbyRender(); }

  _pause() {
    const a = this.app, g = a.game;
    const lan = g && g.lan;
    const node = el('div', { class: 'pause-box' },
      el('h2', {}, lan ? 'MENU' : 'PAUSED'),
      el('div', { class: 'pause-track' }, lan ? 'The match keeps running!' : g ? `${TEAM_NAME[0]} ${g.score[0]} – ${g.score[1]} ${TEAM_NAME[1]}` : ''),
      this.btn('RESUME', () => a.resume(), { attrs: { autofocus: '' } }),
      lan ? null : this.btn('RESTART', () => a.startSolo()),
      this.btn('SETTINGS', () => this.show('settings')),
      this.btn(lan ? 'LEAVE MATCH' : 'QUIT TO MENU', () => a.quitToMenu(), { cls: 'danger' }));
    node._back = () => a.resume();
    return node;
  }

  _waiting() {
    const node = el('div', { class: 'pause-box' },
      el('h2', {}, "TIME'S UP!"),
      el('div', { class: 'pause-track' }, 'Collecting the final score from the host board…'),
      el('div', { class: 'spinner' }));
    node._back = () => {};
    return node;
  }

  // {res: {score, hits, winner, rows}, myId, myTeam, lan, estimated, rankMatch, rankSnipe, snipe}
  _results({ res, myId, myTeam = 0, lan = false, estimated = false, rankMatch = null, rankSnipe = null, snipe = 0 }) {
    const a = this.app;
    const won = res.winner === myTeam, tie = res.winner < 0;
    const title = tie ? 'DRAW!' : won ? 'VICTORY!' : 'DEFEAT';
    const why = res.score[0] !== res.score[1] ? 'on captures' : res.hits[0] !== res.hits[1] ? 'on hits' : '';
    const sub = tie ? 'Same captures and same hits' : `${TEAM_NAME[res.winner]} team wins ${why}`;
    const rows = [...res.rows].sort((x, y) => x.team - y.team || y.caps - x.caps || y.hits - x.hits);
    const col = (team) => el('div', { class: 'res-team', style: { '--c': TEAM_CSS[team] } },
      el('div', { class: 'rt-head' }, el('b', {}, TEAM_NAME[team]), el('span', { class: 'rt-score' }, `${res.score[team]} ★`), el('small', {}, `${res.hits[team]} hits`), res.winner === team ? el('em', {}, 'WINNER') : null),
      el('div', { class: 'res-row lbl' }, el('span', { class: 'res-name' }, 'PLAYER'), el('span', {}, '★'), el('span', {}, 'HITS'), el('span', {}, 'OUTS')),
      rows.filter((r) => r.team === team).map((r, i) => el('div', { class: 'res-row' + (r.id === myId ? ' me' : ''), style: { animationDelay: i * 0.08 + 's' } },
        el('span', { class: 'res-name' }, r.isBot ? el('small', {}, 'BOT ') : null, r.name, r.left ? el('em', {}, ' LEFT') : null),
        el('span', {}, r.caps), el('span', {}, r.hits), el('span', {}, r.outs))));
    const banners = [];
    if (rankMatch === 1) banners.push('NEW BOARD RECORD!');
    else if (rankMatch) banners.push(`#${rankMatch} best match on this board`);
    if (rankSnipe === 1) banners.push(`LONGEST HIT EVER · ${Math.round(snipe)} m`);
    else if (rankSnipe) banners.push(`#${rankSnipe} longest hit · ${Math.round(snipe)} m`);
    const node = el('div', {},
      el('div', { class: 'res-head ' + (tie ? 'tie' : won ? 'win' : 'loss') },
        el('h2', {}, title),
        el('div', { class: 'res-score' }, el('b', { style: { color: TEAM_CSS[0] } }, res.score[0]), el('span', {}, '–'), el('b', { style: { color: TEAM_CSS[1] } }, res.score[1])),
        el('div', { class: 'scr-sub' }, sub + (lan ? (estimated ? ' · provisional, the host board did not answer' : ' · tournament') : ' · solo'))),
      banners.map((b) => el('div', { class: 'record-banner' }, b)),
      el('div', { class: 'res-teams' }, col(0), col(1)),
      el('div', { class: 'res-actions' },
        lan ? this.btn('BACK TO LOBBY', () => a.backToLobby(), { cls: 'primary', attrs: { autofocus: '' } })
          : this.btn('PLAY AGAIN', () => a.startSolo(), { cls: 'primary', attrs: { autofocus: '' } }),
        this.btn('MENU', () => a.quitToMenu())));
    node._back = () => (lan ? a.backToLobby() : a.quitToMenu());
    return node;
  }

  _records() {
    const a = this.app;
    let tab = 0;
    const TABS = ['BEST MATCHES', 'LONGEST HITS'];
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
      const list = (tab === 0 ? src.matches : src.snipes) || [];
      body.innerHTML = '';
      body.append(
        el('div', { class: 'track-sub' }, a.net.connected ? 'Board-wide records stored on the UNO Q' : 'Offline — showing this browser only'),
        el('div', { class: 'rec-col' }, list.length ? list.slice(0, 10).map((r, i) => tab === 0
          ? el('div', { class: 'rec-row' }, el('span', { class: 'rec-n' }, i + 1), el('span', { class: 'rec-name' }, r.name),
            el('span', { class: 'rec-mode' }, `${(r.mode || '').toUpperCase()} · ${RESULT_LBL[r.result] || ''}`), el('span', { class: 'rec-time' }, `${r.caps} ★ · ${r.hits} hits`))
          : el('div', { class: 'rec-row' }, el('span', { class: 'rec-n' }, i + 1), el('span', { class: 'rec-name' }, r.name),
            el('span', { class: 'rec-mode' }, 'SNOWBALL HIT'), el('span', { class: 'rec-time' }, `${(+r.dist || 0).toFixed(1)} m`)))
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
    name.addEventListener('change', () => { s.name = (name.value || '').trim().slice(0, 14) || 'Player'; a.saveSettings(); a.net.send('hello', { name: s.name }); });
    name.addEventListener('mouseenter', () => this.focus(name));
    const vol = (k) => this.slider({ master: 'MASTER', music: 'MUSIC', sfx: 'EFFECTS' }[k], s.volume[k], (v) => { s.volume[k] = v; a.audio.setVolumes(s.volume); a.saveSettings(); if (k === 'sfx') a.audio.play('splat'); });
    const onOff = [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }];
    const node = el('div', {},
      this.header('SETTINGS'),
      el('div', { class: 'settings-list' },
        el('label', { class: 'set-row' }, el('span', { class: 'sel-label' }, 'NAME'), name),
        this.selector('GRAPHICS', [{ value: 'low', label: 'LOW' }, { value: 'medium', label: 'MEDIUM' }, { value: 'high', label: 'HIGH' }, { value: 'ultra', label: 'ULTRA' }], s.quality, (v) => { s.quality = v; a.saveSettings(); a.applyQuality(); }),
        vol('master'), vol('music'), vol('sfx'),
        this.selector('BOT SKILL (SOLO)', SKILLS, s.skill || 'normal', (v) => { s.skill = v; a.saveSettings(); }),
        this.slider('BUTTON THROW POWER', s.buttonThrow, (v) => { s.buttonThrow = clamp(v, 0.5, 1); a.saveSettings(); }),
        this.slider('MOUSE SENSITIVITY', s.mouseSens, (v) => { s.mouseSens = clamp(v, 0.1, 1); a.saveSettings(); a.applyInputSettings(); }),
        this.selector('INVERT LOOK', onOff, !!s.invertY, (v) => { s.invertY = v; a.saveSettings(); }),
        this.selector('THROW GUIDE', onOff, s.guide !== false, (v) => { s.guide = v; a.saveSettings(); }),
        this.selector('TOUCH CONTROLS', [{ value: 'auto', label: 'AUTO' }, { value: 'on', label: 'ALWAYS' }, { value: 'off', label: 'OFF' }], s.touch || 'auto', (v) => { s.touch = v; a.saveSettings(); a.updateTouch(); }),
        this.selector('SHOW FPS', onOff, !!s.fps, (v) => { s.fps = v; a.saveSettings(); }),
        this.btn('CLEAR LOCAL RECORDS', () => { a.clearLocalData(); this.toast('Local records cleared'); }, { cls: 'danger small' })),
      this.footer([['back', 'Back']]));
    return node;
  }

  _help() {
    const row = (k, t) => el('div', { class: 'help-row' }, el('kbd', {}, k), el('span', {}, t));
    const node = el('div', {},
      this.header('HOW TO PLAY'),
      el('div', { class: 'help-cols' },
        el('div', { class: 'help-col' }, el('h3', {}, 'MODULINO CONTROLLER'),
          row('Tilt', 'Aim left / right (gyroscope)'), row('Scoop gesture', 'Scoop a handful of snow'),
          row('Pack gesture', 'Press it into a snowball'), row('Throw gesture', 'Throw · a cleaner throw flies further'),
          row('Run gesture', 'Run forward (about 0.6 s per gesture)'),
          row('A · B · C', 'Throw · run (hold) · scoop / pack'),
          el('p', { class: 'help-note' }, 'Record and train the gestures in the Motion Lab (Train your motion controller).')),
        el('div', { class: 'help-col' }, el('h3', {}, 'KEYBOARD + MOUSE'),
          row('W A S D', 'Move'), row('Mouse', 'Aim (click the game first)'), row('Click / SPACE', 'Throw'),
          row('F · R', 'Scoop · pack'), row('C / right-click', 'Scoop or pack, whichever fits'), row('SHIFT', 'Run'), row('TAB', 'Scoreboard'), row('ESC', 'Menu')),
        el('div', { class: 'help-col' }, el('h3', {}, 'GAMEPAD · TOUCH'),
          row('L-stick · R-stick', 'Move · aim'), row('A / RT', 'Throw'), row('X', 'Scoop / pack'), row('B / LT', 'Run'), row('START', 'Menu'),
          el('p', { class: 'help-note' }, 'Touch: left pad moves, drag on the right to aim, ❄ throws, SNOW scoops and packs, RUN sprints.')),
        el('div', { class: 'help-col' }, el('h3', {}, 'RULES'),
          el('p', {}, 'Scoop snow (not on the frozen ponds or wooden decks), pack it into snowballs — up to 3 in hand — and throw. Snowballs fly in an arc: aim above far targets.'),
          el('p', {}, 'A hit freezes the target in an ice block: they drop the star and respawn at their base after a few seconds.'),
          el('p', {}, 'Take the enemy star and run it back to your base. Touch your own dropped star to send it home.'),
          el('p', {}, '3 minutes. Most captures wins; ties go to the team with more hits.'))),
      this.footer([['back', 'Back']]));
    return node;
  }

  // ------------------------------------------------------------------ Modulino controller
  _motion() {
    const a = this.app, m = a.motion, ms = a.settings.motion;
    const save = () => a.saveSettings();
    const status = el('div', { class: 'mo-status' });
    const dial = el('div', { class: 'mo-dial' }, el('div', { class: 'mo-wheel' }, el('i'), el('b')));
    const steerVal = el('div', { class: 'mo-steer-val' });
    const bars = el('div', { class: 'mo-bars' });
    const mapBox = el('div', { class: 'mo-map' });
    const ownBtn = this.btn('USE THE CONTROLLER ON THIS SCREEN', () => m.claim(true).then((ok) => this.toast(ok ? 'This screen now uses the controller' : 'Could not claim the controller', ok ? '' : 'warn')), { cls: 'small' });
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
          m.owned ? 'This screen uses the controller.' : m.owner ? 'Another screen is using the controller.' : 'The controller is free.',
          m.hasModel ? '' : eng.pref && eng.pref !== 'auto' ? ` The ${eng.pref === 'brick' ? 'Motion detection brick' : 'MCU model'} is not available — pick AUTO or another engine.`
            : ' Train one in the Motion Lab. Until then, use the buttons: A throw, B run, C scoop / pack.',
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
      steerVal.textContent = m.online ? `${m.steer > 0.02 ? '◀ AIM LEFT' : m.steer < -0.02 ? 'AIM RIGHT ▶' : 'AHEAD'} · ${Math.round(Math.abs(m.steer) * 100)}%${m.calibrated ? '' : ' · not calibrated'}` : 'waiting for the controller…';
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
      this.header('MOTION CONTROLLER', 'Modulino controller · Edge Impulse'),
      el('div', { class: 'mo-layout' },
        el('div', { class: 'settings-list' },
          this.btn('TRAIN YOUR GESTURES', () => window.open('train.html', '_blank'), { cls: 'motion-link mo-train', icon: '🧪', sub: 'Motion Lab: record scoop / pack / throw / run, train with Edge Impulse, deploy', attrs: { autofocus: '' } }),
          this.selector('GESTURE ENGINE', ENGINES, (m.engine && m.engine.pref) || 'auto', (v) => m.setEngine(v).then((r) => { if (!r || !r.ok) this.toast('Could not change the engine', 'warn'); })),
          this.selector('CONTROLLER', [{ value: 'auto', label: 'ON WHEN CONNECTED' }, { value: 'off', label: 'OFF' }], ms.enabled, (v) => { ms.enabled = v; save(); if (v === 'off') m.release(); else m.claim(false); renderStatus(); }),
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
    const dial = el('div', { class: 'mo-dial big' }, el('div', { class: 'mo-wheel' }, el('i'), el('b')));
    const actions = el('div', { class: 'mo-row' });
    let step = 'intro', alive = true;

    const set = (t, p, btns = []) => { title.textContent = t; text.textContent = p; actions.innerHTML = ''; actions.append(...btns); const f = btns[0]; if (f) this.focus(f); };
    const go = async () => {
      if (!m.online) { set('NO CONTROLLER', 'Connect the Modulino Movement first.', [this.btn('BACK', () => this.back())]); return; }
      step = 'centre';
      m.startCalibration();
      set('1 · HOLD IT AHEAD', 'Hold the controller as you would to throw, pointing straight ahead, and keep it still…', [this.btn('CANCEL', () => this.back(), { cls: 'small' })]);
      await new Promise((r) => setTimeout(r, 800));
      if (!alive) return;
      await m.captureCentre();
      if (!alive) return;
      a.audio.play('menuSelect');
      step = 'right';
      set('2 · TILT FULLY RIGHT', 'Now tilt the controller as far RIGHT as you want to aim, and hold it there.', [this.btn('CANCEL', () => this.back(), { cls: 'small' })]);
      const cal = await m.captureRight();
      if (!alive) return;
      a.audio.play('record');
      step = 'done';
      set('CALIBRATED ✓', `Full aim at ${Math.round(cal.range * 180 / Math.PI)}°. Tilt the controller to check the dial, then tweak sensitivity and deadzone in the settings.`,
        [this.btn('DONE', () => this.back()), this.btn('AGAIN', () => go(), { cls: 'small' })]);
    };

    const node = el('div', { class: 'cal-box' },
      this.header('CALIBRATE THE CONTROLLER'),
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
      if (what === 'cal-move') text.textContent = 'Keep it still — hold the controller straight ahead…';
    });
    set('READY?', 'Two quick steps: hold the controller straight ahead, then tilt it fully right. Works with any mounting.', [this.btn('START', () => go()), this.btn('RESET TO DEFAULT', () => { m.resetCalibration(); this.toast('Calibration cleared'); }, { cls: 'small' })]);
    return node;
  }
}
