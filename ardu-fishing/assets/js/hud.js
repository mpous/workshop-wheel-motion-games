// In-match heads-up display (DOM overlay): clock, countdown, catch count,
// tournament board, fish finder, the prompt for the next gesture, line tension,
// catch cards and banners.
import { el, clamp, ordinal } from './util.js';
import { RARITY } from './fish.js';

const DEG = Math.PI / 180;
const FINDER_RANGE = 50 * DEG;
const SIGN_ICON = { ripples: '◎', bubbles: '∘', jump: '⤴', shadow: '●', golden: '✦' };

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// how to trigger each action with the device in use
function keysFor(app, action) {
  const dev = app.input.lastDevice;
  const m = app.motion;
  const gest = m.hasModel && m.active ? m.labelsFor(action).map((l) => l.toUpperCase()) : [];
  const btn = { cast: 'A', reel: 'B', unhook: 'C' }[action];
  if (dev === 'rod' || (m.active && m.owned)) {
    const parts = [];
    if (gest.length) parts.push(gest.join(' / '));
    if (m.hasButtons) parts.push(`button ${btn}`);
    return parts.length ? parts.join(' or ') : { cast: 'SPACE', reel: 'S', unhook: 'W' }[action];
  }
  if (dev === 'gamepad') return { cast: 'Ⓐ', reel: 'Ⓧ / RT', unhook: 'Ⓨ' }[action];
  if (dev === 'touch') return { cast: 'CAST', reel: 'REEL', unhook: 'UNHOOK' }[action];
  return { cast: 'SPACE', reel: 'S / ↓', unhook: 'W / ↑' }[action];
}

export class Hud {
  constructor(app, game) {
    this.app = app;
    this.g = game;
    const root = (this.root = document.getElementById('hud'));
    root.innerHTML = '';
    root.classList.remove('hidden');
    // top: clock
    this.elClock = el('div', { class: 'fh-clock' });
    // top-left: my catch
    this.elFish = el('b', {}, '0');
    this.elKg = el('span', { class: 'fh-kg' }, '0.00 kg');
    this.elBig = el('div', { class: 'fh-big' });
    this.elScore = el('div', { class: 'fh-score' },
      el('div', { class: 'fh-count' }, el('span', { class: 'fh-ico' }, '🐟'), this.elFish, this.elKg), this.elBig);
    // top-right: tournament board
    this.elBoard = el('div', { class: 'fh-board hidden' });
    // centre
    this.elCount = el('div', { class: 'fh-countdown' });
    this.elBanner = el('div', { class: 'fh-banner' });
    this.elFlash = el('div', { class: 'fh-flash' });
    this.elCard = el('div', { class: 'fh-card hidden' });
    // bottom: finder, prompt, tension
    this.elFinder = el('div', { class: 'fh-finder' }, el('div', { class: 'ff-scale' }), (this.elAim = el('div', { class: 'ff-aim' })));
    this.finderDots = new Map();
    this.elPrompt = el('div', { class: 'fh-prompt' });
    this.elTenFill = el('i');
    this.elTension = el('div', { class: 'fh-tension hidden' },
      el('div', { class: 'ft-label' }, 'LINE TENSION'),
      el('div', { class: 'ft-bar' }, this.elTenFill, el('u')),
      (this.elDist = el('div', { class: 'ft-dist' })));
    this.elRun = el('div', { class: 'fh-run hidden' });
    this.elUnhook = el('div', { class: 'fh-unhook hidden' }, el('div', { class: 'fu-ring' }), el('span', {}, 'UNHOOK!'));
    this.elFeed = el('div', { class: 'fh-feed' });
    this.elVignette = el('div', { class: 'fh-vignette' });
    root.append(this.elVignette, this.elClock, this.elScore, this.elBoard, this.elFeed, this.elCount, this.elBanner, this.elFlash,
      this.elCard, this.elRun, this.elUnhook, this.elFinder, this.elTension, this.elPrompt);
    this._promptKey = '';
    this._boardKey = '';
    this.feedSeen = new Set();
  }

  destroy() {
    this.root.innerHTML = '';
    this.root.classList.add('hidden');
  }

  // ------------------------------------------------------------------ one-shot messages
  banner(text, cls = '') {
    const b = this.elBanner;
    b.textContent = text;
    b.className = 'fh-banner show ' + cls;
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('show'), 1500);
  }

  flash(title, sub = '', cls = '') {
    const f = this.elFlash;
    f.replaceChildren(...[el('b', {}, title), sub ? el('span', {}, sub) : null].filter(Boolean));
    f.className = 'fh-flash ' + cls;
    void f.offsetWidth;
    f.classList.add('show');
  }

  catchCard(c) {
    const r = RARITY[c.rarity] || RARITY.common;
    const isBig = this.g.biggest === c && this.g.catches.length > 1;
    const k = this.elCard;
    // replaceChildren() would print a null child as the text "null"
    k.replaceChildren(...[
      el('div', { class: 'fc-rarity', style: { color: r.color } }, r.label),
      el('div', { class: 'fc-name' }, c.species),
      el('div', { class: 'fc-kg' }, c.kg.toFixed(2), el('small', {}, ' kg')),
      isBig ? el('div', { class: 'fc-big' }, 'BIGGEST TODAY!') : null].filter(Boolean));
    k.style.setProperty('--rc', r.color);
    k.className = 'fh-card show r-' + c.rarity;
    clearTimeout(this._cardT);
    this._cardT = setTimeout(() => k.classList.add('hidden'), 2500);
  }

  feedLocal(text, cls = '') { this._feedRow(text, cls); }

  _feedRow(text, cls = '') {
    const row = el('div', { class: 'feed-row ' + cls }, text);
    this.elFeed.prepend(row);
    while (this.elFeed.children.length > 4) this.elFeed.lastChild.remove();
    setTimeout(() => row.classList.add('out'), 4500);
    setTimeout(() => row.remove(), 5200);
  }

  // ------------------------------------------------------------------ tournament
  // rows: [{id, name, board, fish, kg, biggest, phase, left, place}] · feed: [{species, kg, rarity, name, t}]
  setBoard(rows, myId) {
    const b = this.elBoard;
    b.classList.remove('hidden');
    const key = JSON.stringify(rows.map((r) => [r.id, r.fish, r.kg, r.phase, r.left]));
    if (key === this._boardKey) return;
    this._boardKey = key;
    b.replaceChildren(el('div', { class: 'fb-head' }, 'TOURNAMENT'), ...rows.slice(0, 8).map((r) =>
      el('div', { class: 'fb-row' + (r.id === myId ? ' me' : '') + (r.left ? ' left' : '') + (r.phase === 'fight' ? ' fight' : '') },
        el('span', { class: 'fb-pl' }, r.place),
        el('span', { class: 'fb-name' }, r.name),
        el('span', { class: 'fb-st' }, r.left ? 'left' : r.phase === 'fight' ? '⚡' : r.phase === 'unhook' ? '✋' : ''),
        el('span', { class: 'fb-fish' }, r.fish),
        el('span', { class: 'fb-kg' }, (r.kg || 0).toFixed(1)))));
    const me = rows.find((r) => r.id === myId);
    if (me) this.g.place = me.place;
  }

  setFeed(feed, myName) {
    for (const f of feed) {
      const k = `${f.t}|${f.name}|${f.species}`;
      if (this.feedSeen.has(k)) continue;
      this.feedSeen.add(k);
      if (f.name === myName) continue;
      const r = RARITY[f.rarity] || RARITY.common;
      this._feedRow(`${f.name} landed a ${f.species} · ${(+f.kg).toFixed(2)} kg`, f.rarity === 'legendary' || f.rarity === 'epic' ? 'hot' : '');
      void r;
    }
  }

  // ------------------------------------------------------------------ per frame
  update() {
    const g = this.g, a = this.app;
    // clock / countdown
    const rem = g.remaining;
    const clock = g.phase === 'countdown' ? mmss(g.durationMs / 1000) : mmss(Math.ceil(rem));
    if (this.elClock.textContent !== clock) this.elClock.textContent = clock;
    this.elClock.classList.toggle('low', g.phase !== 'countdown' && rem <= 30);
    if (g.phase !== 'countdown' && g.phase !== 'over' && rem <= 10 && Math.ceil(rem) !== this._lastTick) {
      this._lastTick = Math.ceil(rem);
      a.audio.play('tick');
    }
    const cd = g.phase === 'countdown' && g.count > 0 ? String(g.count) : '';
    if (this.elCount.textContent !== cd) {
      this.elCount.textContent = cd;
      this.elCount.classList.remove('pop'); void this.elCount.offsetWidth; if (cd) this.elCount.classList.add('pop');
    }
    // my catch
    const f = String(g.fish);
    if (this.elFish.textContent !== f) { this.elFish.textContent = f; this.elScore.classList.remove('bump'); void this.elScore.offsetWidth; this.elScore.classList.add('bump'); }
    this.elKg.textContent = `${g.kg.toFixed(2)} kg`;
    this.elBig.textContent = g.biggest ? `Biggest: ${g.biggest.species} ${g.biggest.kg.toFixed(2)} kg` : g.mode === 'tourney' && g.place ? `${ordinal(g.place)} place` : '';
    this._finder();
    this._fight();
    this._prompt();
  }

  _finder() {
    const g = this.g;
    const show = g.phase === 'aim' || g.phase === 'countdown' || g.phase === 'flight' || g.phase === 'wait';
    this.elFinder.classList.toggle('hidden', !show);
    if (!show) return;
    const x = (ang) => clamp(50 - (ang / FINDER_RANGE) * 50, 0, 100);
    this.elAim.style.left = x(g.aimAngle) + '%';
    this.elAim.classList.toggle('lock', !!g.lock);
    const seen = new Set();
    for (const s of g.signs.active) {
      if (s.taken) continue;
      seen.add(s);
      let d = this.finderDots.get(s);
      if (!d) {
        d = el('div', { class: 'ff-dot k-' + s.kind }, SIGN_ICON[s.kind] || '•');
        this.elFinder.append(d);
        this.finderDots.set(s, d);
      }
      d.style.left = x(s.a) + '%';
      d.style.opacity = clamp(Math.min(s.age * 2, s.life - s.age), 0, 1).toFixed(2);
      d.style.setProperty('--d', clamp(1 - s.d / 45, 0.2, 1).toFixed(2));
      d.classList.toggle('lock', g.lock === s);
    }
    for (const [s, d] of this.finderDots) if (!seen.has(s)) { d.remove(); this.finderDots.delete(s); }
  }

  _fight() {
    const g = this.g;
    const fight = g.phase === 'fight' || g.phase === 'bite';
    this.elTension.classList.toggle('hidden', !fight);
    this.elVignette.style.opacity = fight ? (0.25 + Math.max(0, g.T - 0.6) * 1.6).toFixed(2) : '0.2';
    this.elVignette.classList.toggle('danger', fight && g.T > 0.8);
    if (fight && g.f) {
      this.elTenFill.style.width = (g.T * 100).toFixed(1) + '%';
      this.elTension.classList.toggle('hot', g.T > 0.8);
      this.elTension.classList.toggle('slack', g.f.slack > 2.5);
      const d = `${g.f.r.toFixed(1)} m` + (g.f.slack > 2.5 ? ' · SLACK LINE — REEL!' : '');
      if (this.elDist.textContent !== d) this.elDist.textContent = d;
    }
    const run = g.phase === 'fight' && g.f && g.f.run && g.T > 0.35;
    this.elRun.classList.toggle('hidden', !run);
    if (run) {
      // tilt the rod against the run to tire the fish
      const t = g.f.runDir > 0 ? 'TILT RIGHT ▶' : '◀ TILT LEFT';
      if (this.elRun.textContent !== t) this.elRun.textContent = t;
      this.elRun.classList.toggle('good', g.good > 0.5);
    }
    const uh = g.phase === 'unhook';
    this.elUnhook.classList.toggle('hidden', !uh);
    if (uh) this.elUnhook.style.setProperty('--p', clamp(g.timer / 6, 0, 1).toFixed(3));
  }

  _prompt() {
    const g = this.g, a = this.app;
    let text = '', cls = '';
    switch (g.phase) {
      case 'countdown': text = 'Get ready · aim with the rod'; break;
      case 'aim': text = g.lock ? `Fish spotted! CAST: ${keysFor(a, 'cast')}` : `Aim at a sign on the water · CAST: ${keysFor(a, 'cast')}`; cls = g.lock ? 'hot' : ''; break;
      case 'flight': text = ''; break;
      case 'wait': text = g.bite && !g.bite.wander ? 'Wait for the bite…' : `Waiting… recast: ${keysFor(a, 'cast')} · reel in: ${keysFor(a, 'reel')}`; break;
      case 'bite': text = `FISH ON! REEL: ${keysFor(a, 'reel')}`; cls = 'hot'; break;
      case 'fight':
        text = g.T > 0.8 ? 'TOO MUCH TENSION — stop reeling!' : g.f && g.f.slack > 2.5 ? `REEL! ${keysFor(a, 'reel')}` : g.f && g.f.run ? 'It runs! Ease off or tilt against it' : `REEL: ${keysFor(a, 'reel')}`;
        cls = g.T > 0.8 ? 'bad' : ''; break;
      case 'unhook': text = `UNHOOK: ${keysFor(a, 'unhook')}`; cls = 'hot'; break;
      case 'caught': text = ''; break;
      case 'lost': text = ''; break;
      case 'over': text = ''; break;
    }
    const key = text + cls;
    if (key === this._promptKey) return;
    this._promptKey = key;
    this.elPrompt.textContent = text;
    this.elPrompt.className = 'fh-prompt ' + cls + (text ? '' : ' empty');
  }
}
