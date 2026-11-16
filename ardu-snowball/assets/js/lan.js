// LAN / tournament play: one UNO Q hosts the lobby (this page's own board or
// another one reached by IP — the WebUI brick accepts cross-origin sockets).
// The host board relays player states and events; the host *browser* (first
// player in the lobby) simulates the bots and the stars. The motion controller
// and the LED matrix always stay on the local board.
import { Net } from './net.js';

const RESULTS_WAIT_MS = 8000;
const RECENT_KEY = 'ardusnow.hosts';

export function hostUrl(addr) {
  let a = String(addr || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!a) return null;
  if (!/:\d+$/.test(a)) a += ':' + (location.port || '7000');
  return `${location.protocol === 'https:' ? 'https' : 'http'}://${a}`;
}

export class Lan {
  constructor(app) {
    this.app = app;
    this.net = null;          // Net to the hosting board
    this.remote = false;
    this.addr = null;
    this.joined = false;
    this.match = null;        // match_start payload
    this.results = null;
    this._resultsWaiter = null;
  }

  get lobby() { return this.net && this.net.lobby; }
  get myId() { return this.net && this.net.id; }
  get connected() { return !!(this.net && this.net.connected); }
  get isHost() { const l = this.lobby; return !!(l && l.hostId === this.myId); }
  get me() { const l = this.lobby; return l && l.members ? l.members.find((m) => m.id === this.myId) : null; }

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
    if (n._lanWired) return;
    n._lanWired = true;
    const mine = () => this.net === n;
    const game = () => { const g = this.app.game; return g && g.lan && g.net === n ? g : null; };
    n.on('connect', () => { if (mine() && this.joined && !this.match) this.join(); });
    n.on('disconnect', () => {
      if (!mine()) return;
      this.app.ui.toast(this.remote ? `Lost the host board ${this.addr}` : 'Lost connection to the UNO Q', 'warn');
      if (this.match && game()) this.app.lanLost();
      this.joined = false;
      this.app.ui.onLobby();
    });
    n.on('lobby', () => { if (mine()) this.app.ui.onLobby(); });
    n.on('match_start', (m) => { if (mine()) this._onStart(m); });
    n.on('snapshot', (s) => { const g = game(); if (g) g.onSnapshot(s); });
    n.on('event', (e) => { const g = game(); if (g) g.onNetEvent(e); });
    n.on('player_left', (d) => {
      const g = game();
      if (!g) return;
      g.onPlayerLeft(d);
      if (d && d.hostId === this.myId && !g._wasHost) { g._wasHost = true; this.app.ui.toast('The host left · your browser now runs the bots', 'warn'); }
    });
    n.on('match_results', (r) => { if (mine()) this._onResults(r); });
  }

  async join() {
    const n = this.net, a = this.app;
    if (!n || !n.connected) return { ok: false, reason: 'offline' };
    n.joinRoom('lobby');  // lobby + match_start broadcasts go to this room only
    const r = await n.request('lobby_join', { name: a.settings.name, board: a.net.board || location.hostname });
    if (r && r.ok) { this.joined = true; n.lobby = r.lobby; a.ui.onLobby(); }
    return r || { ok: false, reason: 'no_response' };
  }

  setReady(ready) { return this.net ? this.net.request('lobby_update', { ready: !!ready }) : Promise.resolve(null); }
  setTeam(team) { return this.net ? this.net.request('lobby_update', { team }) : Promise.resolve(null); }
  start() { return this.net ? this.net.request('lobby_start', {}) : Promise.resolve(null); }

  leave() {
    if (this.net && this.joined) {
      this.net.request('lobby_leave', {});
      this.net.leaveRoom('lobby');
      this.net.leaveRoom('match');
    }
    this.joined = false;
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
    if (!m || !Array.isArray(m.roster) || !m.roster.some((p) => p.id === this.myId)) return;
    this.match = m;
    this.results = null;
    this.net.joinRoom('match');
    // host board clock -> this page's clock
    const startAt = performance.now() + (m.startAt - this.net.now());
    this.app.startLan({ roster: m.roster, myId: this.myId, hostId: m.hostId, startAt, durationMs: m.durationMs, seed: m.seed, net: this.net, matchId: m.matchId });
  }

  _onResults(r) {
    if (!r || (this.match && r.matchId !== this.match.matchId)) return;
    this.results = r;
    this.net.leaveRoom('match');
    if (this._resultsWaiter) this._resultsWaiter(r);
  }

  // the local clock ran out: wait for the host board's final table
  finish() {
    if (this.results) return Promise.resolve(this.results);
    return new Promise((res) => {
      const t = setTimeout(() => {
        this._resultsWaiter = null;
        const g = this.app.game;
        res(g ? { ...g.localResults(), matchId: this.match && this.match.matchId, estimated: true } : null);
      }, RESULTS_WAIT_MS);
      this._resultsWaiter = (r) => { clearTimeout(t); this._resultsWaiter = null; res(r); };
    });
  }

  // after the results: stay in the lobby (the server keeps the members)
  afterMatch() {
    this.match = null;
    this.results = null;
    if (this.net && this.net.connected) this.join();
  }

  // quit the match early (pause menu): the host board marks this player as left
  quitMatch() {
    this.match = null;
    this.leave();
  }
}
