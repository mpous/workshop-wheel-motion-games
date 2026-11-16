// Two browser players in one tournament on the local server: join, ready, synced
// start, live scoreboard, results. Run the server with ARDUFISH_MATCH_MS=40000.
// usage: node fish_tourney.js [port]
const puppeteer = require('puppeteer-core');
const path = require('path');
const port = process.argv[2] || 7311;
const outDir = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the same autopilot as fish_shot.js "play"
function autopilot() {
  const a = window.ardufish, inp = a.input, orig = inp.poll.bind(inp);
  inp.poll = (dt) => {
    orig(dt);
    const g = a.game, s = inp.state;
    if (!g || a.state !== 'fishing') return;
    if (g.phase === 'aim') {
      const t = g.signs.active.filter((x) => !x.taken).sort((p, q) => p.d - q.d)[0];
      if (t) s.aim = Math.max(-1, Math.min(1, t.a / (50 * Math.PI / 180)));
      if (g.lock && Math.abs(g.aim - s.aim) < 0.02) s.cast = 0.9;
    }
    if (g.phase === 'bite') s.reel = true;
    if (g.phase === 'fight') { s.reel = g.T < 0.7 && !(g.f && g.f.run && g.T > 0.5); s.aim = g.f && g.f.run ? -g.f.runDir * 0.8 : 0; }
    if (g.phase === 'unhook') s.unhook = true;
  };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  const open = async (name, bot) => {
    // separate contexts so each player has its own localStorage (name, settings)
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 1280, height: 720 });
    p.on('pageerror', (e) => { console.log(`[${name} pageerror]`, e.message); errors.push(e.message); });
    p.on('console', (m) => { if (m.type() === 'error') { console.log(`[${name} error]`, m.text().slice(0, 300)); errors.push(m.text()); } });
    await p.evaluateOnNewDocument((n) => localStorage.setItem('ardufish.settings', JSON.stringify({ name: n, quality: 'low' })), name);
    await p.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
    await p.waitForFunction('window.ardufish && window.ardufish.state === "menu" && window.ardufish.net.connected', { timeout: 60000 });
    if (bot) await p.evaluate(autopilot);
    return p;
  };
  const host = await open('HostHana', true);
  const guest = await open('GuestGil', true);
  const shot = (p, n) => p.screenshot({ path: path.join(outDir, `fish_tourney_${n}.png`) });

  const hj = await host.evaluate(async () => { const a = window.ardufish; a.ui.show('main'); const r = await a.tourney.connect(null); a.ui.show('lobby'); return r; });
  console.log('host join', JSON.stringify(hj && { ok: hj.ok, reason: hj.reason }));
  const gj = await guest.evaluate(async () => { const a = window.ardufish; a.ui.show('main'); const r = await a.tourney.connect(null); a.ui.show('lobby'); return r; });
  console.log('guest join', JSON.stringify(gj && { ok: gj.ok, reason: gj.reason }));
  console.log('guest ready', JSON.stringify(await guest.evaluate(() => window.ardufish.tourney.setReady(true))));
  await sleep(800);
  console.log('lobby', JSON.stringify(await host.evaluate(() => { const l = window.ardufish.tourney.lobby; return l && { host: l.hostId === window.ardufish.tourney.myId, members: (l.members || []).map((m) => [m.name, m.ready, m.isHost]) }; })));
  await shot(host, 'lobby_host'); await shot(guest, 'lobby_guest');
  console.log('start', JSON.stringify(await host.evaluate(() => window.ardufish.tourney.start())));
  await sleep(1500);
  const info = (p) => p.evaluate(() => { const a = window.ardufish, g = a.game; return g && { mode: g.mode, seed: g.seed, startIn: Math.round(g.startAt - performance.now()), phase: g.phase, state: a.state }; });
  console.log('host game', JSON.stringify(await info(host)), 'guest game', JSON.stringify(await info(guest)));
  await sleep(22000);
  await shot(host, 'mid_host'); await shot(guest, 'mid_guest');
  console.log('board', JSON.stringify(await guest.evaluate(() => (window.ardufish.tourney.lastScores?.rows || []).map((r) => [r.place, r.name, r.fish, r.kg, r.phase]))));
  await host.waitForFunction('window.ardufish.ui.screen && window.ardufish.ui.screen.name === "results"', { timeout: 60000 });
  await guest.waitForFunction('window.ardufish.ui.screen && window.ardufish.ui.screen.name === "results"', { timeout: 60000 });
  await sleep(1200);
  await shot(host, 'results_host'); await shot(guest, 'results_guest');
  console.log('results', JSON.stringify(await host.evaluate(() => (window.ardufish.tourney.results?.rows || []).map((r) => [r.place, r.name, r.fish, r.kg]))), 'estimated', await guest.evaluate(() => !window.ardufish.tourney.results));
  console.log(errors.length ? `${errors.length} errors` : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
