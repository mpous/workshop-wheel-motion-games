// Ardu Snowball — in-match HUD (DOM over the canvas): team score + clock,
// star status, killfeed, minimap, snowballs in hand, scoop / pack progress,
// crosshair + hit marker, star markers projected to the screen, frozen
// overlay, countdown, banners, contextual prompts and the Tab scoreboard.
import * as THREE from '../libs/three.bundle.js';
import { el, $, clamp } from './util.js';
import { ARENA, TEAM_CSS, TEAM_NAME, teamSign, starHome } from './world.js';
import { MAX_BALLS, MAX_HANDFULS } from './game.js';

const MAP_W = 150, MAP_H = 250, MAP_PAD = 4;
const FEED_MS = 6500;
const _p = new THREE.Vector3();

const KEYS = {
  keyboard: { throw: 'CLICK', scoop: 'F', pack: 'R', snow: 'C', run: 'SHIFT' },
  gamepad: { throw: 'A', scoop: 'LB', pack: 'Y', snow: 'X', run: 'B' },
  touch: { throw: '❄', scoop: 'SNOW', pack: 'SNOW', snow: 'SNOW', run: 'RUN' },
  motion: { throw: 'THROW · A', scoop: 'SCOOP · C', pack: 'PACK · C', snow: 'C', run: 'RUN · B' },
};

const nameEl = (p) => el('b', { style: { color: p ? TEAM_CSS[p.team] : '#fff' } }, p ? p.name : '?');
const starEl = (team) => el('b', { style: { color: TEAM_CSS[team] } }, `${TEAM_NAME[team]} ★`);

export class HUD {
  constructor(app) {
    this.app = app;
    this.root = $('#hud');
    this.match = null;
    this._cache = {};
    this._bannerT = null;
    this._hintT = null;
    this._hintText = '';
    this._boardHeld = false;
    this._build();
    window.addEventListener('keydown', (e) => { if (e.code === 'Tab' && this.match) { e.preventDefault(); this._boardHeld = true; } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Tab') this._boardHeld = false; });
    window.addEventListener('blur', () => { this._boardHeld = false; });
  }

  _build() {
    const r = this.root;
    r.innerHTML = '';
    this.vig = el('div', { class: 'sh-vig' });
    this.frost = el('div', { class: 'sh-frost hidden' }, el('div', { class: 'sh-frost-txt' }, el('b', {}, 'FROZEN!'), el('span', {}, 'thawing at your base…')), el('div', { class: 'sh-frost-bar' }, el('i')));
    // top: score + clock + star status
    this.sBlue = el('b', {}, '0');
    this.sRed = el('b', {}, '0');
    this.hBlue = el('small', {}, '0 hits');
    this.hRed = el('small', {}, '0 hits');
    this.clock = el('div', { class: 'sh-clock' }, '3:00');
    this.starPills = [0, 1].map((t) => el('span', { class: 'sh-pill', style: { '--c': TEAM_CSS[t] } }, '★ HOME'));
    this.top = el('div', { class: 'sh-top' },
      el('div', { class: 'sh-score' },
        el('div', { class: 'sh-team t0' }, el('span', { class: 'sh-tn' }, 'BLUE'), this.sBlue, this.hBlue),
        this.clock,
        el('div', { class: 'sh-team t1' }, el('span', { class: 'sh-tn' }, 'RED'), this.sRed, this.hRed)),
      el('div', { class: 'sh-stars' }, this.starPills[0], this.starPills[1]));
    this.feedBox = el('div', { class: 'sh-feed' });
    // minimap
    this.map = el('canvas', { class: 'sh-mini', width: MAP_W * 2, height: MAP_H * 2 });
    this.mapCtx = this.map.getContext('2d');
    this.mapBg = null;
    // crosshair
    this.cross = el('div', { class: 'sh-cross' }, el('i', { class: 'c1' }), el('i', { class: 'c2' }), el('i', { class: 'c3' }), el('i', { class: 'c4' }), el('u'));
    // star markers (enemy star, own star, own base while carrying)
    this.marks = [0, 1, 2].map(() => el('div', { class: 'sh-mark hidden' }, el('span', { class: 'mk-ico' }, '★'), el('span', { class: 'mk-txt' }), el('span', { class: 'mk-d' })));
    // bottom: snow in hand
    this.balls = Array.from({ length: MAX_BALLS }, () => el('i', { class: 'inv-ball' }));
    this.snows = Array.from({ length: MAX_HANDFULS }, () => el('i', { class: 'inv-snow' }));
    this.actBar = el('i');
    this.actLbl = el('span', { class: 'act-lbl' });
    this.act = el('div', { class: 'sh-act hidden' }, this.actLbl, el('div', { class: 'act-bar' }, this.actBar));
    this.inv = el('div', { class: 'sh-inv' },
      el('div', { class: 'inv-row' }, this.balls, el('em', { class: 'inv-sep' }), this.snows),
      el('div', { class: 'inv-lbl' }, el('span', { class: 'inv-n' }, '0'), el('span', { class: 'inv-w' }, ' SNOWBALLS')));
    this.prompt = el('div', { class: 'sh-prompt empty' });
    this.carry = el('div', { class: 'sh-carry hidden' }, '★ YOU HAVE THE STAR · RUN HOME!');
    this.hintEl = el('div', { class: 'sh-hint' });
    this.bannerEl = el('div', { class: 'sh-banner' }, el('b'), el('span'));
    this.countEl = el('div', { class: 'sh-count hidden' });
    this.board = el('div', { class: 'sh-board hidden' });
    this.keysEl = el('div', { class: 'sh-keys hidden' });
    r.append(this.vig, this.frost, this.top, this.feedBox, this.map, this.cross, ...this.marks, this.act, this.inv,
      this.prompt, this.carry, this.hintEl, this.bannerEl, this.countEl, this.keysEl, this.board);
  }

  // ------------------------------------------------------------------ lifecycle
  show(match) {
    this.match = match;
    this._cache = {};
    this.feedBox.innerHTML = '';
    this.bannerEl.classList.remove('show');
    this.hintEl.classList.remove('show');
    this.root.classList.remove('hidden');
    this.root.style.setProperty('--mine', TEAM_CSS[match.myTeam]);
    this.root.classList.toggle('team-red', match.myTeam === 1);
    this._buildMapBg();
    this._showKeys();
  }

  hide() {
    this.root.classList.add('hidden');
    this.match = null;
    this._boardHeld = false;
  }

  _showKeys() {
    const dev = this.app.input.lastDevice;
    const m = this.app.motion;
    const txt = m && m.active ? 'TILT the controller to aim · gestures SCOOP · PACK · THROW · RUN · buttons A throw · B run · C snow'
      : dev === 'gamepad' ? 'L-STICK move · R-STICK aim · A throw · X snow · B run · START menu'
        : dev === 'touch' ? 'Left pad move · drag right to aim · ❄ throw · SNOW scoop / pack · RUN'
          : 'WASD move · MOUSE aim (click the game) · CLICK / SPACE throw · F scoop · R pack · SHIFT run · TAB scores';
    this.keysEl.textContent = txt;
    this.keysEl.classList.remove('hidden', 'out');
    clearTimeout(this._keysT);
    this._keysT = setTimeout(() => this.keysEl.classList.add('out'), 11000);
  }

  // ------------------------------------------------------------------ messages
  banner(text, cls = '', sub = '') {
    const b = this.bannerEl;
    b.className = 'sh-banner ' + cls;
    b.firstChild.textContent = text;
    b.lastChild.textContent = sub || '';
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('show'), cls.includes('big') ? 2400 : 1800);
  }

  hint(text, cls = '') {
    const h = this.hintEl;
    if (this._hintText === text && h.classList.contains('show')) { clearTimeout(this._hintT); this._hintT = setTimeout(() => h.classList.remove('show'), 1300); return; }
    this._hintText = text;
    h.className = 'sh-hint ' + cls;
    h.textContent = text;
    void h.offsetWidth;
    h.classList.add('show');
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => h.classList.remove('show'), 1300);
  }

  feed(item, match) {
    const me = match.me;
    const mine = (p) => p && me && p.id === me.id;
    let row;
    switch (item.kind) {
      case 'hit': {
        const d = Number(item.dist) || 0;
        row = el('div', { class: 'feed-row' }, nameEl(item.by), el('span', { class: 'fd-ico' }, ' ❄ '), nameEl(item.target),
          d >= 20 ? el('em', {}, ` ${Math.round(d)} m SNIPE`) : d ? el('small', {}, ` ${Math.round(d)} m`) : null);
        if (mine(item.by)) row.classList.add('me');
        if (mine(item.target)) row.classList.add('hurt');
        break;
      }
      case 'grab': row = el('div', { class: 'feed-row' }, nameEl(item.by), ' took the ', starEl(item.team)); break;
      case 'drop': row = el('div', { class: 'feed-row' }, starEl(item.team), ' dropped'); break;
      case 'return': row = el('div', { class: 'feed-row' }, starEl(item.team), ' returned', item.by ? el('span', {}, ' by ', nameEl(item.by)) : null); break;
      case 'cap': row = el('div', { class: 'feed-row hot' }, nameEl(item.by), ' CAPTURED the ', starEl(item.team)); break;
      case 'left': row = el('div', { class: 'feed-row dim' }, nameEl(item.by), ' left the match'); break;
      default: return;
    }
    if (item.kind !== 'hit' && mine(item.by)) row.classList.add('me');
    this.feedBox.prepend(row);
    while (this.feedBox.children.length > 5) this.feedBox.lastChild.remove();
    setTimeout(() => row.classList.add('out'), FEED_MS);
    setTimeout(() => row.remove(), FEED_MS + 700);
  }

  _set(key, node, prop, val) {
    if (this._cache[key] === val) return;
    this._cache[key] = val;
    if (prop === 'text') node.textContent = val;
    else if (prop === 'class') node.className = val;
    else node.style[prop] = val;
  }

  // ------------------------------------------------------------------ per frame
  update(dt, m) {
    if (!m || m !== this.match) return;
    const me = m.me;
    const now = m.now();
    // score + clock
    this._set('sb', this.sBlue, 'text', String(m.score[0]));
    this._set('sr', this.sRed, 'text', String(m.score[1]));
    this._set('hb', this.hBlue, 'text', `${m.hits[0]} hit${m.hits[0] === 1 ? '' : 's'}`);
    this._set('hr', this.hRed, 'text', `${m.hits[1]} hit${m.hits[1] === 1 ? '' : 's'}`);
    const left = m.phase === 'countdown' ? m.durationMs : m.timeLeft();
    const secs = Math.ceil(left / 1000);
    this._set('clk', this.clock, 'text', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    this._set('clkc', this.clock, 'class', 'sh-clock' + (m.phase === 'playing' && secs <= 30 ? ' low' : ''));
    if (this._cache.capAt !== m.lastCapAt) { this._cache.capAt = m.lastCapAt; if (m.lastCapAt > 0) { this.top.classList.remove('bump'); void this.top.offsetWidth; this.top.classList.add('bump'); } }
    for (const s of m.stars) {
      const c = m.players.get(s.by);
      const txt = s.s === 'home' ? '★ HOME' : s.s === 'carried' ? `★ ${c ? c.name : '?'}` : '★ DROPPED';
      this._set('pill' + s.team, this.starPills[s.team], 'text', txt);
      this._set('pillc' + s.team, this.starPills[s.team], 'class', 'sh-pill ' + s.s);
    }
    // countdown
    if (m.phase === 'countdown') {
      const c = m.countdown();
      const txt = c > 3 ? 'GET READY' : String(Math.max(1, c));
      if (this._cache.count !== txt) {
        this._cache.count = txt;
        this.countEl.textContent = txt;
        this.countEl.className = 'sh-count' + (c > 3 ? ' ready' : '');
        void this.countEl.offsetWidth;
        this.countEl.classList.add('pop');
      }
    } else if (this._cache.count) { this._cache.count = ''; this.countEl.className = 'sh-count hidden'; }
    if (m.phase === 'finished' && !this._cache.fin) { this._cache.fin = true; this.banner("TIME'S UP!", 'big'); }

    const playing = m.phase === 'playing';
    const frozen = me && me.frozenUntil > now;
    // frozen overlay + hurt flash
    this._set('frz', this.frost, 'class', 'sh-frost' + (frozen ? '' : ' hidden'));
    if (frozen) this.frost.lastChild.firstChild.style.width = clamp(1 - (me.frozenUntil - now) / 3500, 0, 1) * 100 + '%';
    const hurt = now - m.lastHurtAt < 450;
    this._set('vig', this.vig, 'class', 'sh-vig' + (hurt ? ' hurt' : frozen ? ' frozen' : ''));
    // crosshair
    const hitM = now - m.hitMarkerAt < 380;
    this._set('cross', this.cross, 'class', 'sh-cross' + (hitM ? ' hit' : '') + (m.aimLock ? ' lock' : '') + (!playing || frozen || !me ? ' hidden' : ''));
    // inventory
    if (me) {
      const key = me.ammo + ':' + me.handfuls;
      if (this._cache.inv !== key) {
        this._cache.inv = key;
        this.balls.forEach((b, i) => b.classList.toggle('on', i < me.ammo));
        this.snows.forEach((b, i) => b.classList.toggle('on', i < me.handfuls));
        this.inv.querySelector('.inv-n').textContent = me.ammo;
        this.inv.querySelector('.inv-w').textContent = me.ammo === 1 ? ' SNOWBALL' : ' SNOWBALLS';
        this.inv.classList.toggle('empty', me.ammo === 0);
      }
      const busy = me.action === 'scoop' || me.action === 'pack';
      this._set('act', this.act, 'class', 'sh-act' + (busy ? ' ' + me.action : ' hidden'));
      if (busy) {
        this._set('actl', this.actLbl, 'text', me.action === 'scoop' ? 'SCOOPING SNOW…' : 'PACKING A SNOWBALL…');
        this.actBar.style.width = clamp(me.actionT / (me.actionDur || 1), 0, 1) * 100 + '%';
      }
      const carrying = m.carrying(me) >= 0;
      this._set('carry', this.carry, 'class', 'sh-carry' + (carrying && playing ? '' : ' hidden'));
      this._prompt(m, me, playing && !frozen);
    }
    this._markers(m, me);
    this._drawMap(m, me);
    // scoreboard
    const showBoard = this._boardHeld || m.phase === 'finished';
    this.board.classList.toggle('hidden', !showBoard);
    if (showBoard) {
      this._boardT = (this._boardT || 0) - dt;
      if (this._boardT <= 0) { this._boardT = 0.25; this._renderBoard(m); }
    }
  }

  _prompt(m, me, active) {
    let txt = '', cls = 'sh-prompt';
    if (active) {
      const dev = this.app.motion && this.app.motion.active ? 'motion' : this.app.input.lastDevice;
      const k = KEYS[dev] || KEYS.keyboard;
      const want = m.wantedAction();
      const early = m.durationMs - m.timeLeft() < 25000;
      if (want === 'run' && m.carrying(me) >= 0) { txt = `RUN HOME WITH THE STAR  [${k.run}]`; cls += ' hot'; }
      else if (want === 'pack') txt = `PACK A SNOWBALL  [${dev === 'keyboard' ? k.pack + ' / ' + k.snow : k.pack}]`;
      else if (want === 'scoop') txt = `SCOOP SNOW  [${dev === 'keyboard' ? k.scoop + ' / ' + k.snow : k.scoop}]`;
      else if (want === 'run') txt = 'NO SNOW HERE · MOVE OFF THE ICE';
      else if (want === 'throw' && early) txt = `THROW  [${k.throw}]  ·  GRAB THE RED STAR`.replace('RED', TEAM_NAME[1 - m.myTeam]);
    }
    if (!txt) cls += ' empty';
    this._set('pr', this.prompt, 'text', txt || this._cache.pr || '');
    this._set('prc', this.prompt, 'class', cls);
  }

  // stars (and the own base while carrying) projected to the screen, clamped to the edges
  _markers(m, me) {
    const cam = this.app.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const items = [];
    if (me && m.phase !== 'finished') {
      const enemy = m.stars[1 - m.myTeam], own = m.stars[m.myTeam];
      const posOf = (s) => {
        if (s.s === 'carried') { const c = m.players.get(s.by); return c ? _p.set(c.pos.x, 2.6, c.pos.z).clone() : s.p.clone(); }
        return s.s === 'home' ? starHome(s.team) : s.p.clone().setY(0.9);
      };
      const carrying = m.carrying(me) >= 0;
      if (!carrying) items.push({ pos: posOf(enemy), team: enemy.team, txt: enemy.s === 'carried' ? (enemy.by === me.id ? '' : 'ESCORT') : 'TAKE', cls: 'enemy' });
      if (own.s !== 'home') items.push({ pos: posOf(own), team: own.team, txt: own.s === 'carried' ? 'STOP THEM' : 'RETURN', cls: 'own alert' });
      if (carrying) items.push({ pos: new THREE.Vector3(0, 1.4, teamSign(m.myTeam) * 50), team: m.myTeam, txt: 'HOME', cls: 'home' });
    }
    for (let i = 0; i < this.marks.length; i++) {
      const mk = this.marks[i], it = items[i];
      if (!it || !it.txt) { this._set('mk' + i, mk, 'class', 'sh-mark hidden'); continue; }
      const d = me ? Math.hypot(it.pos.x - me.pos.x, it.pos.z - me.pos.z) : 0;
      _p.copy(it.pos).project(cam);
      let x = _p.x, y = _p.y;
      const behind = _p.z > 1;
      if (behind) { x = -x; y = -y; }
      let off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.86;
      if (off) {
        const s = 1 / Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.86, 1e-3);
        x *= s; y *= s;
        if (behind && Math.abs(y) > 0.8) y = Math.sign(y) * 0.8;
      }
      if (!off && d < 4) { this._set('mk' + i, mk, 'class', 'sh-mark hidden'); continue; }
      this._set('mk' + i, mk, 'class', 'sh-mark ' + it.cls + (off ? ' off' : ''));
      mk.style.setProperty('--c', TEAM_CSS[it.team]);
      mk.style.transform = `translate(${((x * 0.5 + 0.5) * W).toFixed(0)}px, ${((-y * 0.5 + 0.5) * H).toFixed(0)}px) translate(-50%, -50%)`;
      this._set('mkt' + i, mk.children[1], 'text', it.txt);
      this._set('mkd' + i, mk.children[2], 'text', `${Math.round(d)} m`);
    }
  }

  // ------------------------------------------------------------------ minimap
  _mapXY(x, z) {
    const ss = teamSign(this.match ? this.match.myTeam : 0);
    const k = Math.min((MAP_W / 2 - MAP_PAD) / ARENA.halfW, (MAP_H / 2 - MAP_PAD) / ARENA.halfL);
    return [MAP_W / 2 + x * ss * k, MAP_H / 2 + z * ss * k, k];
  }

  _buildMapBg() {
    const w = this.app.world, m = this.match;
    if (!w || !m) return;
    const c = document.createElement('canvas');
    c.width = MAP_W * 2; c.height = MAP_H * 2;
    const g = c.getContext('2d');
    g.scale(2, 2);
    const [x0, y0, k] = this._mapXY(-ARENA.halfW, -ARENA.halfL);
    const [x1, y1] = this._mapXY(ARENA.halfW, ARENA.halfL);
    g.fillStyle = 'rgba(225, 238, 255, 0.82)';
    g.beginPath();
    g.roundRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 8);
    g.fill();
    // bases
    for (const team of [0, 1]) {
      const s = teamSign(team);
      const [a, b] = this._mapXY(-8.6, s * 44.9), [cx, cy] = this._mapXY(8.6, s * 55.4);
      g.fillStyle = team === 0 ? 'rgba(47, 139, 255, 0.35)' : 'rgba(255, 65, 65, 0.35)';
      g.fillRect(Math.min(a, cx), Math.min(b, cy), Math.abs(cx - a), Math.abs(cy - b));
    }
    g.fillStyle = 'rgba(120, 190, 240, 0.75)';
    for (const p of w.ice) { const [x, y] = this._mapXY(p.x, p.z); g.beginPath(); g.arc(x, y, p.r * k, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = 'rgba(160, 120, 80, 0.6)';
    for (const d of w.decks) { const [a, b] = this._mapXY(d.x - d.hw, d.z - d.hd), [cx, cy] = this._mapXY(d.x + d.hw, d.z + d.hd); g.fillRect(Math.min(a, cx), Math.min(b, cy), Math.abs(cx - a), Math.abs(cy - b)); }
    g.fillStyle = 'rgba(70, 90, 130, 0.85)';
    for (const b of w.boxes) {
      const cs = Math.cos(b.rot || 0), sn = Math.sin(b.rot || 0);
      g.beginPath();
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, v], i) => {
        const lx = u * b.hw, lz = v * b.hd;
        const [x, y] = this._mapXY(b.x + lx * cs + lz * sn, b.z - lx * sn + lz * cs);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.fill();
    }
    g.fillStyle = 'rgba(40, 90, 60, 0.75)';
    for (const r of w.circles) { const [x, y] = this._mapXY(r.x, r.z); g.beginPath(); g.arc(x, y, Math.max(1.2, r.r * k), 0, Math.PI * 2); g.fill(); }
    this.mapBg = c;
  }

  _drawMap(m, me) {
    const g = this.mapCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.map.width, this.map.height);
    if (this.mapBg) g.drawImage(this.mapBg, 0, 0);
    g.setTransform(2, 0, 0, 2, 0, 0);
    const ss = teamSign(m.myTeam);
    const now = m.now();
    // stars
    for (const s of m.stars) {
      if (s.s === 'carried') continue;
      const p = s.s === 'home' ? starHome(s.team) : s.p;
      const [x, y] = this._mapXY(p.x, p.z);
      g.font = '900 13px system-ui';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = TEAM_CSS[s.team];
      g.strokeStyle = '#fff'; g.lineWidth = 2.5;
      g.strokeText('★', x, y); g.fillText('★', x, y);
    }
    for (const p of m.players.values()) {
      if (p.left) continue;
      const enemy = p.team !== m.myTeam;
      const carrying = m.carrying(p) >= 0;
      if (enemy && !carrying && me) {
        const d = Math.hypot(p.pos.x - me.pos.x, p.pos.z - me.pos.z);
        if (d > 24) continue;
      }
      const [x, y] = this._mapXY(p.pos.x, p.pos.z);
      const frozen = p.frozenUntil > now;
      if (p === me) {
        const fx = -Math.sin(p.yaw) * ss, fy = -Math.cos(p.yaw) * ss;
        g.save();
        g.translate(x, y);
        g.rotate(Math.atan2(fy, fx) + Math.PI / 2);
        g.fillStyle = '#ffcf26'; g.strokeStyle = '#000'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2.5); g.lineTo(-5, 5); g.closePath();
        g.fill(); g.stroke();
        g.restore();
      } else {
        g.beginPath();
        g.arc(x, y, carrying ? 4.5 : 3.4, 0, Math.PI * 2);
        g.fillStyle = frozen ? 'rgba(200, 235, 255, 0.95)' : TEAM_CSS[p.team];
        g.fill();
        g.lineWidth = 1.2; g.strokeStyle = frozen ? TEAM_CSS[p.team] : '#fff';
        g.stroke();
      }
      if (carrying) {
        const st = m.stars[m.carrying(p)];
        g.font = '900 12px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = TEAM_CSS[st.team]; g.strokeStyle = '#fff'; g.lineWidth = 2.5;
        g.strokeText('★', x, y - 9); g.fillText('★', x, y - 9);
      }
    }
  }

  // ------------------------------------------------------------------ scoreboard
  _renderBoard(m) {
    const rows = [...m.players.values()].sort((a, b) => a.team - b.team || b.stats.caps - a.stats.caps || b.stats.hits - a.stats.hits);
    const col = (team) => el('div', { class: 'sb-col', style: { '--c': TEAM_CSS[team] } },
      el('div', { class: 'sb-head' }, el('b', {}, TEAM_NAME[team]), el('span', {}, `${m.score[team]} ★ · ${m.hits[team]} hits`)),
      el('div', { class: 'sb-row sb-lbl' }, el('span', {}, 'PLAYER'), el('span', {}, '★'), el('span', {}, 'HITS'), el('span', {}, 'OUTS')),
      rows.filter((p) => p.team === team).map((p) => el('div', { class: 'sb-row' + (p === m.me ? ' me' : '') + (p.left ? ' left' : '') },
        el('span', { class: 'sb-name' }, p.isBot ? el('small', {}, 'BOT ') : null, p.name), el('span', {}, p.stats.caps), el('span', {}, p.stats.hits), el('span', {}, p.stats.outs))));
    this.board.replaceChildren(el('div', { class: 'sb-title' }, 'SCOREBOARD'), el('div', { class: 'sb-cols' }, col(0), col(1)));
  }
}
