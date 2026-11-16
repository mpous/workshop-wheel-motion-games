// Tournament between boards: every player fishes on their own UNO Q while one
// board hosts the lobby, the synced start and the live scoreboard. The host is
// this page's own board or another one reached by IP (the WebUI brick accepts
// cross-origin sockets). The motion controller always stays on the local board.
import { Net } from './net.js';

const SCORE_MS = 500;
const RESULTS_WAIT_MS = 7000;
const RECENT_KEY = 'ardufish.hosts';

export function hostUrl(addr) {
  let a = String(addr || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!a) return null;
  if (!/:\d+$/.test(a)) a += ':' + (location.port || '7000');
  return `${location.protocol === 'https:' ? 'https' : 'http'}://${a}`;
}

export class Tourney {
  constructor(app) {
    this.app = app;
    this.net = null;          // Net to the hosting board
    this.remote = false;
    this.addr = null;
    this.joined = false;
    this.match = null;
    this.lastScores = null;
    this.results = null;
    this._scoreT = null;
  }

  get lobby() { return this.net && this.net.lobby; }
  get myId() { return this.net && this.net.id; }
  get connected() { return !!(this.net && this.net.connected); }
  get isHost() { const l = this.lobby; return !!(l && l.hostId === this.myId); }

  recentHosts() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } }
  _remember(addr) {
    const list = [addr, ...this.recentHosts().filter((x) => x !== addr)].slice(0, 4);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage off */ }
  }

  // addr: null / '' = this board, otherwise "ip" or "ip:port" of the host board
  async connect(addr = null) {
    this.disconnect();
    const a = this.app;
    const local = !addr || addr === a.net.board || addr === location.host || addr === location.hostname;
    this.remote = !local;
    this.addr = local ? (a.net.board || location.hostname) : addr;
    if (local) {
      this.net = a.net;
      if (!this.net.connected) return { ok: false, reason: 'offline' };
    } else {
      const url = hostUrl(addr);
      if (!url) return { ok: false, reason: 'bad_address' };
      this.net = new Net(url);
      const up = new Promise((res) => {
        const t = setTimeout(() => res(false), 5000);
        this.net.on('hello', () => { clearTimeout(t); res(true); });
      });
      this.net.connect(a.settings.name);
      if (!(await up)) { this.disconnect(); return { ok: false, reason: 'unreachable' }; }
      this._remember(addr);
    }
    this._wire();
    return this.join();
  }

  _wire() {
    const n = this.net;
    if (n._tourneyWired) return;
    n._tourneyWired = true;
    n.on('connect', () => { if (this.net === n && this.joined) { n.joinRoom('tourney'); this.join(); } });
    n.on('disconnect', () => {
      if (this.net !== n) return;
      this.app.ui.toast(this.remote ? `Lost the host board ${this.addr}` : 'Lost connection to the UNO Q', 'warn');
      this.app.ui.onLobby();
    });
    n.on('tourney_lobby', () => { if (this.net === n) this.app.ui.onLobby(); });
    n.on('tourney_start', (m) => { if (this.net === n) this._onStart(m); });
    n.on('tourney_scores', (s) => { if (this.net === n) this._onScores(s); });
    n.on('tourney_results', (r) => { if (this.net === n) this._onResults(r); });
  }

  async join() {
    const n = this.net, a = this.app;
    if (!n || !n.connected) return { ok: false, reason: 'offline' };
    n.joinRoom('tourney');  // the lobby broadcasts go to this room only
    const r = await n.request('tourney_join', { name: a.settings.name, board: a.net.board || location.hostname });
    if (r && r.ok) { this.joined = true; n.lobby = r.lobby; a.ui.onLobby(); }
    return r || { ok: false, reason: 'no_response' };
  }

  setReady(ready) { return this.net ? this.net.request('tourney_ready', { ready }) : Promise.resolve(null); }
  start() { return this.net ? this.net.request('tourney_start', {}) : Promise.resolve(null); }

  leave() {
    if (this.net && this.joined) { this.net.request('tourney_leave', {}); this.net.leaveRoom('tourney'); }
    this.joined = false;
    this._stopScores();
    this.match = null;
  }

  disconnect() {
    this.leave();
    if (this.net && this.remote) this.net.close();
    this.net = null;
    this.remote = false;
  }

  // ------------------------------------------------------------------ match
  _onStart(m) {
    if (!m.players.some((p) => p.id === this.myId)) return;
    this.match = m;
    this.results = null;
    this.lastScores = null;
    // host clock -> this page's clock
    const localStart = performance.now() + (m.startAt - this.net.now());
    this.app.startTourney({ seed: m.seed, startAt: localStart, durationMs: m.durationMs, players: m.players, matchId: m.matchId });
    this._stopScores();
    this._scoreT = setInterval(() => this._sendScore(), SCORE_MS);
  }

  _sendScore() {
    const g = this.app.game;
    if (!g || g.mode !== 'tourney' || !this.net) return;
    if (g.phase === 'countdown') return;
    this.net.send('tourney_score', g.score());
  }

  _stopScores() { clearInterval(this._scoreT); this._scoreT = null; }

  onCatch(c) {
    if (this.net && this.match) this.net.send('tourney_catch', { species: c.species, kg: c.kg, rarity: c.rarity });
    this._sendScore();
  }

  _onScores(s) {
    if (!this.match || s.matchId !== this.match.matchId) return;
    this.lastScores = s;
    const g = this.app.game;
    if (g && g.mode === 'tourney') {
      g.hud.setBoard(s.rows, this.myId);
      g.hud.setFeed(s.feed || [], this.app.settings.name);
    }
  }

  _onResults(r) {
    if (!this.match || r.matchId !== this.match.matchId) return;
    this._stopScores();
    this.results = r;
    this._resultsWaiter?.(r);
  }

  // the local clock ran out: send the final score and wait for the host's table
  finish() {
    this._sendScore();
    if (this.results) return Promise.resolve(this.results);
    return new Promise((res) => {
      const t = setTimeout(() => { this._resultsWaiter = null; res(this.lastScores ? { matchId: this.match && this.match.matchId, rows: this.lastScores.rows, estimated: true } : null); }, RESULTS_WAIT_MS);
      this._resultsWaiter = (r) => { clearTimeout(t); this._resultsWaiter = null; res(r); };
    });
  }

  // quit the match early (pause menu): the host marks this player as left
  quitMatch() {
    this._stopScores();
    this.match = null;
    this.leave();
  }
}
