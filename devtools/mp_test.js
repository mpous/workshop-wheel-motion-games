// Two headless browsers join the lobby, race, and report sync state.
const puppeteer = require('puppeteer-core');
const path = require('path');
const port = process.argv[2] || 7111;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 960, height: 540 });
    p.on('pageerror', (e) => console.log(`[p${i} pageerror]`, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log(`[p${i} err]`, m.text().slice(0, 300)); });
    await p.goto(`http://localhost:${port}/`);
    await p.waitForFunction('window.qkart && window.qkart.state === "menu"', { timeout: 60000 });
    pages.push(p);
  }
  const ev = (i, fn, ...a) => pages[i].evaluate(fn, ...a);
  for (let i = 0; i < 2; i++) {
    await ev(i, (n) => { const a = window.qkart; a.settings.name = 'Player' + n; a.settings.character = n * 3; a.ui.show('lobby'); }, i + 1);
    await sleep(500);
    console.log('join', i, JSON.stringify(await ev(i, () => window.qkart.net.request('lobby_join', { name: window.qkart.settings.name, character: window.qkart.settings.character }))));
  }
  await sleep(500);
  await ev(0, () => window.qkart.net.request('lobby_settings', { track: 'neon', laps: 1, bots: 4, cc: 150 }));
  for (let i = 0; i < 2; i++) await ev(i, () => window.qkart.net.request('lobby_update', { ready: true }));
  await sleep(300);
  console.log('start', JSON.stringify(await ev(0, () => window.qkart.net.request('lobby_start', {}))));
  await sleep(2500);
  await pages[0].screenshot({ path: path.join(__dirname, 'shots/mp_p0_start.png') });
  // let both players be AI-driven
  for (let i = 0; i < 2; i++) await ev(i, () => { const r = window.qkart.race; if (r) r.ai.set(r.player.id, r.autoDriver); });
  for (let t = 0; t < 30; t++) {
    await sleep(2000);
    const s = [];
    for (let i = 0; i < 2; i++) s.push(await ev(i, () => {
      const a = window.qkart, r = a.race;
      if (!r) return { st: a.state, scr: a.ui.screen && a.ui.screen.name };
      const me = r.player, other = r.karts.find((k) => !k.local && !k.isBot);
      return { st: a.state, scr: a.ui.screen && a.ui.screen.name, t: +r.raceTime.toFixed(1), n: r.karts.length, me: [me.pos.x.toFixed(1), me.pos.z.toFixed(1)], other: other && [other.pos.x.toFixed(1), other.pos.z.toFixed(1)], place: me.place };
    }));
    // compare where each client sees the other's kart vs where it really is
    console.log('QK', JSON.stringify(s));
    if (s.every((x) => x.scr === 'results')) break;
  }
  await pages[1].screenshot({ path: path.join(__dirname, 'shots/mp_p1_end.png') });
  await browser.close();
})();
