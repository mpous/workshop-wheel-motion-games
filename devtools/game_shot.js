// Drives the game in headless Chrome and saves screenshots.
// usage: node game_shot.js [scenario] [port]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const scenario = process.argv[2] || 'basic';
const port = process.argv[3] || 7111;
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
    if (['error', 'warning', 'warn'].includes(m.type()) || t.startsWith('QK ')) { console.log('[console.' + m.type() + ']', t.slice(0, 400)); if (m.type() === 'error') errors.push(t); }
  });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')); errors.push(e.message); });
  const shot = async (name) => { const f = path.join(outDir, `${scenario}_${name}.png`); await page.screenshot({ path: f }); console.log('saved', f); };
  const evalq = (fn, ...a) => page.evaluate(fn, ...a);
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.ardukart && window.ardukart.state === "menu"', { timeout: 60000 });
  await sleep(1500);
  const steps = {
    async basic() {
      await shot('title');
      await page.keyboard.press('Enter');
      await sleep(800);
      await shot('main');
      await evalq(() => window.ardukart.ui.show('chars', { next: 'race' }));
      await sleep(1200);
      await shot('chars');
      await evalq(() => window.ardukart.ui.show('tracks', { next: 'race' }));
      await sleep(600);
      await shot('tracks');
    },
    async race() {
      const track = process.env.TRACK || 'sunset';
      await evalq((t) => window.ardukart.startSolo({ mode: 'race', track: t, cc: 150, laps: 3 }), track);
      await sleep(1500);
      await shot('intro');
      await sleep(2000);
      await page.keyboard.down('ArrowUp');
      await sleep(1500);
      await shot('go');
      // let the AI drive the player to see mid-race views
      await evalq(() => { const r = window.ardukart.race; r.ai.set(r.player.id, r.autoDriver); });
      for (let i = 0; i < 4; i++) {
        await sleep(3500);
        await shot('drive' + i);
        console.log('QK', await evalq(() => { const r = window.ardukart.race, p = r.player; return JSON.stringify({ t: r.raceTime.toFixed(1), place: p.place, lap: p.lap, spd: p.speed.toFixed(1), fps: window.ardukart.fps.toFixed(0), item: p.item }); }));
      }
      await page.keyboard.up('ArrowUp');
    },
    async go() {
      await evalq(() => window.ardukart.startSolo({ mode: 'race', track: 'sunset', cc: 150, laps: 3 }));
      await evalq(() => { const r = window.ardukart.race; r.ai.set(r.player.id, r.autoDriver); r.player.rocket.pressedAt = -0.8; });
      await page.waitForFunction('window.ardukart.race.raceTime > -0.3', { timeout: 20000 });
      const toggles = (process.env.TOGGLES || '').split(',');
      for (let i = 0; i < 8; i++) {
        if (toggles[i]) { console.log('toggle', toggles[i]); await evalq((t) => { const a = window.ardukart, r = a.race; ({
          hud: () => { document.getElementById('hud').style.display = 'none'; },
          bloom: () => { a.bloom.enabled = false; },
          flames: () => { for (const k of r.karts) for (const f of k.model.userData.boostFlames) f.material.visible = false; },
          particles: () => { r.particles.group.visible = false; },
          composer: () => { a.composer = null; },
          mask: () => { const s = document.querySelector('.hud-speedlines'); s.style.mask = s.style.webkitMask = 'none'; },
          lines: () => { document.querySelector('.hud-speedlines').style.display = 'none'; },
          vignette: () => { document.querySelector('.hud-vignette').style.display = 'none'; },
        })[t](); }, toggles[i]); await sleep(100); }
        await shot('go' + i);
        console.log('QK', await evalq(() => { const r = window.ardukart.race, c = r.camera.cam; const a = window.ardukart, cv = a.renderer.domElement, e = c.matrixWorldInverse.elements.concat(c.projectionMatrix.elements); return JSON.stringify({ t: r.raceTime.toFixed(2), fov: c.fov.toFixed(1), cv: [cv.width, cv.height, getComputedStyle(cv).opacity, getComputedStyle(cv).display], camNaN: e.some((v) => !Number.isFinite(v)), tris: a.renderer.info.render.triangles, calls: a.renderer.info.render.calls, nanKarts: r.karts.filter((k) => !Number.isFinite(k.model.matrixWorld.elements[12] + k.model.matrixWorld.elements[0])).map((k) => k.name) }); }));
        await sleep(250);
      }
    },
    async full() {
      // fast-forward a full race with the AI driving the player
      const track = process.env.TRACK || 'sunset';
      await evalq((t) => window.ardukart.startSolo({ mode: 'race', track: t, cc: 150, laps: 1 }), track);
      await evalq(() => { const r = window.ardukart.race; r.ai.set(r.player.id, r.autoDriver); });
      for (let i = 0; i < 40; i++) {
        await sleep(2000);
        const s = await evalq(() => { const a = window.ardukart; const r = a.race; return JSON.stringify({ st: a.state, t: r && r.raceTime && r.raceTime.toFixed(1), place: r && r.player.place, lap: r && r.player.lap, scr: a.ui.screen && a.ui.screen.name }); });
        console.log('QK', s);
        if (s.includes('"scr":"results"')) break;
      }
      await shot('results');
    },
  };
  for (const s of scenario.split(',')) await steps[s]();
  console.log('errors:', errors.length);
  await browser.close();
})();
