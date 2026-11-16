// Socket.IO link to an Ardu Fishing server (WebUI brick): this board, or the
// board hosting a tournament (the WebUI brick allows cross-origin sockets).
// Handles clock sync, request/response helpers and degrades gracefully when offline.

export class Net {
  constructor(url = null) {
    this.url = url;           // null: the page's own board
    this.socket = null;
    this.connected = false;
    this.id = null;
    this.offset = 0; // serverTime - performance-based local time
    this.rtt = 0;
    this.handlers = {};
    this.pending = {};
    this.records = null;
    this.lobby = null;
  }

  now() { return performance.now() + this.offset; }

  on(name, fn) { (this.handlers[name] ||= []).push(fn); }
  _fire(name, data) { for (const fn of this.handlers[name] || []) { try { fn(data); } catch (e) { console.error(e); } } }

  connect(name) {
    if (typeof io !== 'function') { console.warn('socket.io not available — offline mode'); return; }
    const s = (this.socket = this.url ? io(this.url, { transports: ['websocket', 'polling'], reconnection: true })
      : io({ transports: ['websocket', 'polling'], reconnection: true }));
    this.name = name;
    s.on('connect', () => {
      this.connected = true;
      this.id = s.id;
      this.request('hello', { name: this.name }).then((r) => {
        if (!r) return;
        this.id = r.id || s.id;
        this.records = r.records;
        this.lobby = r.lobby;
        this.board = r.board;
        this._fire('hello', r);
        if (r.records) this._fire('records', r.records);
        if (r.lobby) this._fire('tourney_lobby', r.lobby);
      });
      this.syncClock();
      this._fire('connect');
    });
    s.on('disconnect', () => { this.connected = false; this._fire('disconnect'); });
    for (const ev of ['tourney_lobby', 'tourney_start', 'tourney_scores', 'tourney_results', 'records',
      'imu', 'ml', 'btn', 'hw', 'motion_owner', 'motion_record_done', 'ei_job_progress']) {
      s.on(ev, (d) => {
        if (ev === 'records') this.records = d;
        if (ev === 'tourney_lobby') this.lobby = d;
        this._fire(ev, d);
      });
    }
    // generic responses: '<name>_response'
    s.onAny((ev, data) => {
      if (ev.endsWith('_response')) {
        const n = ev.slice(0, -9);
        const q = this.pending[n];
        if (q && q.length) q.shift()(data);
      }
    });
    clearInterval(this._clockTimer);
    this._clockTimer = setInterval(() => this.syncClock(), 5000);
  }

  close() {
    clearInterval(this._clockTimer);
    if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); }
    this.socket = null;
    this.connected = false;
  }

  send(name, data = {}) {
    if (this.socket && this.connected) this.socket.emit(name, data);
  }

  request(name, data = {}, timeout = 3000) {
    return new Promise((resolve) => {
      if (!this.socket || !this.connected) return resolve(null);
      (this.pending[name] ||= []).push(resolve);
      this.socket.emit(name, data);
      setTimeout(() => {
        const q = this.pending[name];
        const i = q ? q.indexOf(resolve) : -1;
        if (i >= 0) { q.splice(i, 1); resolve(null); }
      }, timeout);
    });
  }

  joinRoom(room) { if (this.socket) this.socket.emit('enter_room', room); }
  leaveRoom(room) { if (this.socket) this.socket.emit('leave_room', room); }

  async syncClock() {
    // take the best of a few samples (lowest RTT)
    let best = null;
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now();
      const r = await this.request('clock', { t: t0 }, 1500);
      const t1 = performance.now();
      if (!r || typeof r.serverTime !== 'number') continue;
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: r.serverTime - (t0 + rtt / 2) };
    }
    if (best) {
      // smooth after the first sample to avoid jumps mid-match
      this.offset = this.synced ? this.offset * 0.7 + best.offset * 0.3 : best.offset;
      this.rtt = best.rtt;
      this.synced = true;
    }
  }
}
