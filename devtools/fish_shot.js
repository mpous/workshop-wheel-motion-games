// Drives Ardu Fishing in headless Chrome and saves screenshots.
// usage: node fish_shot.js [menus|play] [port]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const scenario = process.argv[2] || 'menus';
const port = process.argv[3] || 7311;
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const outDir = path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (['error', 'warning', 'warn'].includes(m.type()) || t.startsWith('AF ')) { console.log('[console.' + m.type() + ']', t.slice(0, 400)); if (m.type() === 'error') errors.push(t); }
  });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')); errors.push(e.message); });
  const shot = async (name) => { const f = path.join(outDir, `fish_${scenario}_${name}.png`); await page.screenshot({ path: f }); console.log('saved', f); };
  const evalq = (fn, ...a) => page.evaluate(fn, ...a);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.ardufish && window.ardufish.state === "menu"', { timeout: 60000 });
  await sleep(1500);
  const steps = {
    async menus() {
      await shot('title');
      await page.keyboard.press('Enter');
      await sleep(800);
      await shot('main');
      for (const s of ['tourney', 'motion', 'records', 'settings', 'help']) {
        await evalq((n) => window.ardufish.ui.show(n), s);
        await sleep(900);
        await shot(s);
      }
      await evalq(() => window.ardufish.ui.show('tourney'));
      await sleep(300);
      await evalq(() => document.querySelector('.tn-card .btn.primary').click());
      await sleep(1500);
      await shot('lobby');
    },
    // an autopilot plays a solo match through the keyboard state
    async play() {
      await evalq(() => {
        const a = window.ardufish, inp = a.input;
        const orig = inp.poll.bind(inp);
        window.botLog = [];
        inp.poll = (dt) => {
          orig(dt);
          const g = a.game, s = inp.state;
          if (!g) return;
          if (g.phase === 'aim') {
            const t = g.signs.active.find((x) => !x.taken);
            if (t) s.aim = Math.max(-1, Math.min(1, t.a / (50 * Math.PI / 180)));
            if (g.lock && Math.abs(g.aim - s.aim) < 0.02) s.cast = 0.9;
          }
          if (g.phase === 'bite') s.reel = true;
          if (g.phase === 'fight') { s.reel = g.T < 0.7 && !(g.f && g.f.run && g.T > 0.5); s.aim = g.f && g.f.run ? -g.f.runDir * 0.8 : 0; }
          if (g.phase === 'unhook') s.unhook = Math.random() < 0.15;
          if (g.phase !== window._lastPh) { window.botLog.push(g.phase + '@' + g.elapsed.toFixed(1)); window._lastPh = g.phase; }
        };
        a.startSolo();
      });
      await sleep(1200);
      await shot('countdown');
      const seen = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < +(process.env.PLAY_MS || 60000)) {
        await sleep(250);
        const ph = await evalq(() => window.ardufish.game && window.ardufish.game.phase);
        if (ph && !seen.has(ph)) { seen.add(ph); await sleep(ph === 'fight' ? 900 : 200); await shot('ph_' + ph); }
      }
      console.log('AF', await evalq(() => JSON.stringify({ fish: window.ardufish.game.fish, kg: window.ardufish.game.kg, stats: window.ardufish.game.stats, fps: Math.round(window.ardufish.fps), log: window.botLog.slice(-40) })));
      await shot('late');
      // jump to the end of the match
      await evalq(() => { const g = window.ardufish.game; g.startAt -= g.durationMs; });
      await sleep(4000);
      await shot('results');
    },
  };
  try { await steps[scenario](); } catch (e) { console.log('step failed', e.message); }
  console.log(errors.length ? `ERRORS: ${errors.length}` : 'no errors');
  await browser.close();
})();
