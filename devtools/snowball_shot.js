// Drives Ardu Snowball in headless Chrome: screenshots of the menus, a solo
// match and the results, plus the simulated Modulino gesture flow and the
// LED matrix state reported by the board (needs run_snowball.sh with
// ARDUKART_SIM_BOARD=1 ARDUSNOW_DEBUG=1).
// usage: node snowball_shot.js [all|menus|play|lan] [port]
//   lan: two isolated players in one LAN match (start the server with
//   ARDUSNOW_MATCH_MS=30000 for a short match)
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const scenario = process.argv[2] || 'all';
const port = process.argv[3] || 7000;
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const outDir = path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://localhost:${port}`;
const api = async (p) => { try { const r = await fetch(base + p); return await r.json(); } catch (e) { return { error: String(e) }; } };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (['error', 'warning', 'warn'].includes(m.type())) { console.log('[console.' + m.type() + ']', t.slice(0, 400)); if (m.type() === 'error') errors.push(t); }
  });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')); errors.push(e.message); });
  const shot = async (name) => { const f = path.join(outDir, `snow_${name}.png`); await page.screenshot({ path: f }); console.log('saved', f); };
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const led = async (tag) => { const r = await api('/api/debug/led'); console.log(`led[${tag}]`, JSON.stringify(r.led)); return r.led; };

  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction('window.ardusnow && window.ardusnow.state === "menu"', { timeout: 60000 });
  await sleep(2500);
  const fails = [];
  const expect = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails.push(what); };

  if (scenario === 'all' || scenario === 'menus') {
    await shot('title');
    await page.keyboard.press('Enter');
    await sleep(1200);
    expect(await ev(() => window.ardusnow.ui.screen && window.ardusnow.ui.screen.name === 'main'), 'Enter opens the main menu');
    await shot('main');
    await sleep(3200);   // menu status goes out every 3 s
    await led('menu');
    for (const [scr, name] of [['help', 'help'], ['records', 'records'], ['settings', 'settings'], ['tourney', 'tourney']]) {
      await ev((s) => window.ardusnow.ui.show(s), scr);
      await sleep(900);
      await shot(name);
    }
    await ev(() => window.ardusnow.ui.reset('main'));
    await sleep(500);
  }

  if (scenario === 'all' || scenario === 'play') {
    await api('/api/debug/sim?tilt=0');   // hold the simulated controller level
    await ev(() => window.ardusnow.startSolo());
    await sleep(1500);
    expect(await ev(() => window.ardusnow.game && window.ardusnow.game.phase === 'countdown'), 'solo match starts with a countdown');
    await shot('countdown');
    await led('countdown');
    await page.waitForFunction('window.ardusnow.game.phase === "playing"', { timeout: 10000 });
    // walk forward a bit and look around so the shot shows the arena
    await page.keyboard.down('KeyW'); await sleep(1500); await page.keyboard.up('KeyW');
    // then stand on the open field facing the enemy fort for the showcase shot
    await ev(() => { const m = window.ardusnow.game.me; m.pos.x = 1.5; m.pos.z = -34; m.yaw = Math.PI; });
    await sleep(2500);
    await shot('ingame');
    await led('playing');

    // -------- gesture flow through the simulated Modulino controller
    const me = () => ev(() => { const g = window.ardusnow.game, p = g.me; return { ammo: p.ammo, handfuls: p.handfuls, action: p.action, snow: g.world.isSnow(p.pos.x, p.pos.z), owned: window.ardusnow.motion.owned, frozen: p.frozenUntil > g.now() }; });
    // fresh state: no balls, standing on open snow (the base deck has none)
    const toSnow = () => ev(() => {
      const g = window.ardusnow.game, p = g.me, w = g.world;
      for (let r = 2; r < 40; r += 1) for (let a = 0; a < 6.28; a += 0.4) {
        const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
        if (w.isSnow(x, z) && !w.solidAt(x, 0.6, z, 0.6)) { p.pos.x = x; p.pos.z = z; p.ammo = 0; p.handfuls = 0; return true; }
      }
      return false;
    });
    expect(await toSnow(), 'found open snow near the spawn');
    let s = await me();
    console.log('before gestures', JSON.stringify(s));
    expect(s.owned, 'the match owns the motion controller');
    const gesture = async (g, wait = 1700) => { const r = await api('/api/debug/sim?gesture=' + g); if (!r.ok) console.log('sim', JSON.stringify(r)); await sleep(wait); return me(); };
    s = await gesture('scoop');
    console.log('after scoop', JSON.stringify(s));
    s = await gesture('scoop');
    console.log('after 2nd scoop', JSON.stringify(s));
    expect(s.handfuls > 0 || s.ammo > 0, 'scoop gesture gathers snow');
    s = await gesture('pack');
    console.log('after pack', JSON.stringify(s));
    expect(s.ammo >= 1, 'pack gesture makes a snowball');
    await shot('gesture_ball');
    const before = s.ammo;
    s = await gesture('throw', 600);
    await shot('gesture_throw');
    await sleep(800);
    s = await me();
    console.log('after throw', JSON.stringify(s));
    expect(s.ammo === before - 1, 'throw gesture throws a snowball');
    const runOk = await (async () => {
      await api('/api/debug/sim?gesture=run');
      for (let i = 0; i < 20; i++) { await sleep(100); if (await ev(() => window.ardusnow.input.state.runGesture || window.ardusnow.input.state.run)) return true; }
      return false;
    })();
    expect(runOk, 'run gesture makes the player sprint');
    // Modulino buttons: C scoops / packs, A throws
    await toSnow();
    for (let i = 0; i < 3; i++) { await api('/api/debug/sim?button=2'); await sleep(1300); }
    s = await me();
    console.log('after button C x3', JSON.stringify(s));
    expect(s.ammo >= 1 || s.handfuls >= 1, 'button C scoops / packs');
    const mcu = await api('/api/debug/mcu');
    console.log('mcu', JSON.stringify(mcu).slice(0, 600));

    // -------- end of the match: force the clock
    await ev(() => { const g = window.ardusnow.game; g.endAt = g.now() + 50; });
    await page.waitForFunction('window.ardusnow.state === "results"', { timeout: 15000 });
    await sleep(2500);
    expect(await ev(() => window.ardusnow.ui.screen && window.ardusnow.ui.screen.name === 'results'), 'results screen after the clock runs out');
    await shot('results');
    await sleep(1500);
    await led('results');
    await page.keyboard.press('Escape');
    await sleep(800);
  }

  if (scenario === 'lan') {
    // second player in its own browser context (own localStorage / socket)
    const ctx = await browser.createBrowserContext();
    const p2 = await ctx.newPage();
    await p2.setViewport({ width: W, height: H });
    p2.on('pageerror', (e) => { console.log('[p2 pageerror]', e.message); errors.push(e.message); });
    p2.on('console', (m) => { if (m.type() === 'error') { console.log('[p2 console.error]', m.text().slice(0, 300)); errors.push(m.text()); } });
    await p2.goto(base + '/', { waitUntil: 'load' });
    await p2.waitForFunction('window.ardusnow && window.ardusnow.state === "menu"', { timeout: 60000 });
    const ev2 = (fn, ...a) => p2.evaluate(fn, ...a);
    await ev(() => { window.ardusnow.settings.name = 'Host'; });
    await ev2(() => { window.ardusnow.settings.name = 'Guest'; });
    await ev(() => window.ardusnow.ui.show('main'));
    await ev(() => window.ardusnow.ui.show('tourney'));
    const r1 = await ev(() => window.ardusnow.lan.connect(null).then((r) => { if (r.ok) window.ardusnow.ui.show('lobby'); return r; }));
    const r2 = await ev2(() => window.ardusnow.lan.connect(null).then((r) => { if (r.ok) window.ardusnow.ui.show('lobby'); return r; }));
    expect(r1.ok && r2.ok, 'both players join the lobby');
    expect(await ev(() => window.ardusnow.lan.isHost) && !(await ev2(() => window.ardusnow.lan.isHost)), 'first player is the host');
    await ev2(() => window.ardusnow.lan.setTeam(1));
    await sleep(600);
    const notReady = await ev(() => window.ardusnow.lan.start());
    expect(notReady && !notReady.ok, 'host cannot start before everyone is ready');
    await ev2(() => window.ardusnow.lan.setReady(true));
    await sleep(800);
    await shot('lobby');
    const st = await ev(() => window.ardusnow.lan.start());
    expect(st && st.ok, 'host starts the match');
    await Promise.all([page, p2].map((pg) => pg.waitForFunction('window.ardusnow.game && window.ardusnow.game.lan', { timeout: 8000 })));
    const info = await Promise.all([ev, ev2].map((f) => f(() => { const g = window.ardusnow.game; return { n: g.players.size, team: g.myTeam, start: Math.round(g.startAt - performance.now()), bots: [...g.players.values()].filter((p) => p.isBot).length }; })));
    console.log('lan match', JSON.stringify(info));
    expect(info[0].n === 6 && info[1].n === 6 && info[0].bots === 4, 'bots fill the empty slots (3 v 3)');
    expect(info[0].team !== info[1].team, 'team choice is honoured');
    expect(Math.abs(info[0].start - info[1].start) < 400, 'synced countdown on both browsers');
    await Promise.all([page, p2].map((pg) => pg.waitForFunction('window.ardusnow.game.phase === "playing"', { timeout: 12000 })));
    await page.keyboard.down('KeyW'); await sleep(1600); await page.keyboard.up('KeyW');
    await sleep(600);
    const seen = await ev2(() => { const g = window.ardusnow.game; return [...g.players.values()].filter((p) => p.id !== g.myId).map((p) => [p.name, +p.pos.x.toFixed(1), +p.pos.z.toFixed(1)]); });
    const hostPos = await ev(() => { const m = window.ardusnow.game.me; return [+m.pos.x.toFixed(1), +m.pos.z.toFixed(1)]; });
    console.log('guest sees', JSON.stringify(seen), 'host at', JSON.stringify(hostPos));
    const h = seen.find((x) => x[0] === 'Host');
    expect(h && Math.hypot(h[1] - hostPos[0], h[2] - hostPos[1]) < 1.5, 'guest sees the host move');
    const botsMove = seen.filter((x) => x[0] !== 'Host').some((x) => Math.abs(x[2]) < 50);
    expect(botsMove, 'host-simulated bots move on the guest screen');
    await shot('lan_host');
    await p2.screenshot({ path: path.join(outDir, 'snow_lan_guest.png') }); console.log('saved', path.join(outDir, 'snow_lan_guest.png'));
    const left = await ev(() => window.ardusnow.game.timeLeft());
    console.log('waiting for the end of the match', Math.round(left / 1000), 's');
    await Promise.all([page, p2].map((pg) => pg.waitForFunction('window.ardusnow.state === "results" && window.ardusnow.ui.screen && window.ardusnow.ui.screen.name === "results"', { timeout: left + 20000 })));
    const res = await Promise.all([ev, ev2].map((f) => f(() => { const a = window.ardusnow.ui.screen.args; return { est: a.estimated, score: a.res.score, rows: a.res.rows.length }; })));
    console.log('results', JSON.stringify(res));
    expect(!res[0].est && !res[1].est, 'final table comes from the host board');
    expect(JSON.stringify(res[0].score) === JSON.stringify(res[1].score), 'both players get the same score');
    await sleep(1200);
    await shot('lan_results');
    await led('lan results');
    await ev2(() => window.ardusnow.backToLobby());
    await sleep(800);
    expect(await ev2(() => window.ardusnow.lan.joined && window.ardusnow.ui.screen.name === 'lobby'), 'back to the lobby after the match');
    await ctx.close();
  }

  console.log(errors.length ? `${errors.length} console errors` : 'no console errors');
  console.log(fails.length ? `FAILED: ${fails.join('; ')}` : 'all checks passed');
  await browser.close();
  process.exit(errors.length || fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
