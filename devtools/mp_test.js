// N headless browsers (default 2, up to 20) join the lobby, race, and report sync state.
// node mp_test.js [port] [players]
const puppeteer = require('puppeteer-core');
const path = require('path');
const port = process.argv[2] || 7111;
const N = Math.min(20, +process.argv[3] || 2);
const small = N > 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const pages = [];
  for (let i = 0; i < N; i++) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport(small ? (i > 0 ? { width: 320, height: 180 } : { width: 1280, height: 720 }) : { width: 960, height: 540 });
    p.on('pageerror', (e) => console.log(`[p${i} pageerror]`, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[p${i} err]`, m.text().slice(0, 300)); });
    await p.goto(`http://localhost:${port}/`);
    await p.waitForFunction('window.ardukart && window.ardukart.state === "menu"', { timeout: 60000 });
    pages.push(p);
  }
  const ev = (i, fn, ...a) => pages[i].evaluate(fn, ...a);
  for (let i = 0; i < N; i++) {
    await ev(i, (n) => { const a = window.ardukart; a.settings.name = 'Player' + n; a.settings.character = n * 3; a.ui.show('lobby'); }, i + 1);
    await sleep(small ? 150 : 500);
    console.log('join', i, JSON.stringify(await ev(i, () => window.ardukart.net.request('lobby_join', { name: window.ardukart.settings.name, character: window.ardukart.settings.character }))));
  }
  await sleep(500);
  await ev(0, () => { const l = document.querySelector('.lobby-list'); if (l) l.scrollIntoView(); });
  await pages[0].screenshot({ path: path.join(__dirname, `shots/mp_lobby_${N}.png`) });
  await ev(0, () => window.ardukart.net.request('lobby_settings', { track: 'neon', laps: 1, bots: 4, cc: 150 }));
  for (let i = 1; i < N; i++) await ev(i, () => window.ardukart.net.request('lobby_update', { ready: true }));
  await sleep(300);
  console.log('start', JSON.stringify(await ev(0, () => window.ardukart.net.request('lobby_start', {}))));
  await sleep(2500);
  await pages[0].screenshot({ path: path.join(__dirname, 'shots/mp_p0_start_' + N + '.png') });
  // let both players be AI-driven
  for (let i = 0; i < N; i++) await ev(i, () => { const r = window.ardukart.race; if (r) r.ai.set(r.player.id, r.autoDriver); });
  for (let t = 0; t < (N > 8 ? 60 : 30); t++) {
    await sleep(2000);
    const s = [];
    for (let i = 0; i < N; i++) s.push(await ev(i, () => {
      const a = window.ardukart, r = a.race;
      if (!r) return { st: a.state, scr: a.ui.screen && a.ui.screen.name };
      const me = r.player, other = r.karts.find((k) => !k.local && !k.isBot);
      return { st: a.state, scr: a.ui.screen && a.ui.screen.name, t: +r.raceTime.toFixed(1), n: r.karts.length, hz: r.netHz, fps: a.fps ? Math.round(a.fps) : undefined, me: [me.pos.x.toFixed(1), me.pos.z.toFixed(1)], other: other && [other.pos.x.toFixed(1), other.pos.z.toFixed(1)], place: me.place };
    }));
    // compare where each client sees the other's kart vs where it really is
    console.log('QK', JSON.stringify(N > 2 ? s.slice(0, 2).concat({ screens: s.map((x) => x.scr || x.st).join(',') }) : s));
    if (t === 8) await pages[0].screenshot({ path: path.join(__dirname, `shots/mp_p0_mid_${N}.png`) });
    if (s.every((x) => x.scr === 'results')) break;
  }
  await pages[0].screenshot({ path: path.join(__dirname, `shots/mp_p0_end${N > 2 ? '_' + N : ''}.png`) });
  await browser.close();
})();
