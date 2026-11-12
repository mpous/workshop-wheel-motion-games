// Headless check of the Motion Lab page and the wheel in the game (needs ARDUKART_SIM_BOARD=1 ARDUKART_DEBUG=1)
const puppeteer = require('puppeteer-core');
const BASE = process.env.ARDUKART_URL || 'http://localhost:7123';
const OUT = process.env.SHOTS || __dirname + '/shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sim = (q) => fetch(BASE + '/api/debug/sim?' + q).then((r) => r.text());
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const errs = [];
  const watch = (p, tag) => {
    p.on('pageerror', (e) => errs.push(tag + ' pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(tag + ' console: ' + m.text()); });
  };
  // ---- Motion Lab
  const lab = await browser.newPage(); watch(lab, 'lab');
  await lab.setViewport({ width: 1440, height: 1100 });
  await lab.goto(BASE + '/train.html', { waitUntil: 'load' });
  await sleep(2500);
  console.log('chips:', await lab.$eval('#board-chips', (e) => e.textContent));
  console.log('rate:', await lab.$eval('#rate', (e) => e.textContent));
  await sim('gesture=use_item');
  await sleep(1500);
  console.log('top label:', await lab.$eval('#top-label', (e) => e.textContent), '| bars:', await lab.$$eval('#test-bars .bar', (b) => b.length));
  await lab.select('#length', '2000');
  await lab.select('#after', 'review');
  await lab.click('#record');
  await sleep(1200);
  await lab.screenshot({ path: OUT + '/lab_countdown.png' });
  await sleep(5000);
  console.log('review visible:', await lab.$eval('#review', (e) => !e.classList.contains('hidden')), await lab.$eval('#review-info', (e) => e.textContent));
  await lab.screenshot({ path: OUT + '/lab.png', fullPage: true });
  // keep the lab open in its own tab, as the main menu's TRAIN button does
  // ---- Game
  await sim('tilt=0');
  const game = await browser.newPage(); watch(game, 'game');
  await game.setViewport({ width: 1600, height: 900 });
  await game.goto(BASE + '/', { waitUntil: 'load' });
  await game.waitForFunction(() => window.ardukart && window.ardukart.motion && window.ardukart.motion.online, { timeout: 30000 });
  const st = () => game.evaluate(() => { const a = window.ardukart, m = a.motion, k = a.race && a.race.player; return { online: m.online, owned: m.owned, active: m.active, steer: +m.steer.toFixed(2), cruise: m.cruise, screen: a.ui.screen && a.ui.screen.name, state: a.state, speed: k ? +k.speed.toFixed(1) : null, item: k ? k.item : null, cal: !!m.settings.cal, ownerKind: m.ownerKind, gas: m.gasHeld }; });
  console.log('game motion (lab still owns it):', JSON.stringify(await st()));
  await game.bringToFront(); await game.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(800);
  console.log('game focused, takes the wheel from the lab:', JSON.stringify(await st()));
  await game.evaluate(() => window.ardukart.ui.show('main'));
  await sleep(900);
  await game.screenshot({ path: OUT + '/game_main_menu.png' });
  console.log('main menu buttons:', await game.$$eval('.menu-grid .btn .btn-label', (b) => b.map((x) => x.textContent).join(' | ')));
  await game.evaluate(() => window.ardukart.ui.show('title', {}, { push: false }));
  await sleep(500);
  await sim('button=0'); await sleep(800);
  console.log('after A on title:', JSON.stringify(await st()));
  await sim('tilt=0.5'); await sleep(800);
  console.log('tilt left:', JSON.stringify(await st()));
  await sim('tilt=-0.5'); await sleep(800);
  console.log('tilt right:', JSON.stringify(await st()));
  await sim('tilt=0'); await sleep(600);
  // calibration wizard: START, hold straight, turn right
  await game.evaluate(() => window.ardukart.ui.show('motionCal'));
  await sleep(500);
  await sim('button=0'); await sleep(2500);
  console.log('cal step:', await game.$eval('.cal-text h3', (e) => e.textContent));
  await sim('tilt=-0.6'); await sleep(2500);
  console.log('cal step:', await game.$eval('.cal-text h3', (e) => e.textContent), JSON.stringify(await st()));
  await game.screenshot({ path: OUT + '/game_motion_cal.png' });
  await sim('tilt=0'); await sleep(800);
  console.log('centred after cal:', JSON.stringify(await st()));
  await sim('tilt=0.3'); await sleep(800);
  console.log('left 0.3 after cal:', JSON.stringify(await st()));
  await sim('tilt=0'); await sleep(500);
  await game.evaluate(() => window.ardukart.ui.show('motion'));
  await sleep(1200);
  await game.screenshot({ path: OUT + '/game_motion_settings.png' });
  // race
  await game.evaluate(() => window.ardukart.startSolo({ mode: 'race', track: 'sunset', cc: 100, laps: 3 }));
  await sleep(2500);
  await sim('gesture=accelerate'); await sleep(1500);
  console.log('accel in countdown:', JSON.stringify(await st()));
  await sleep(4500);
  console.log('racing:', JSON.stringify(await st()));
  await game.evaluate(() => { const k = window.ardukart.race.player; k.item = 'orb'; k.itemCount = 1; });
  await sim('gesture=use_item'); await sleep(1500);
  console.log('after use_item:', JSON.stringify(await st()));
  for (let i = 0; i < 3; i++) { await sleep(400); console.log('rev:', await (await fetch(BASE + '/api/debug/mcu')).text(), JSON.stringify(await game.evaluate(() => { const k = window.ardukart.race.player; return [k.speed, k.maxSpeed]; }))); }
  await sim('tilt=0.4'); await sleep(1000);
  await game.screenshot({ path: OUT + '/game_race_wheel.png' });
  console.log('HUD classes:', await game.$$eval('#motion-hud .mh-cls', (r) => r.map((x) => x.textContent).join(' | ')), '| engine:', await game.$eval('#motion-hud .mh-engine', (e) => e.textContent));
  console.log('MCU:', await (await fetch(BASE + '/api/debug/mcu')).text());
  await sim('tilt=0&gesture=brake'); await sleep(1200);
  console.log('after brake:', JSON.stringify(await st()));
  await sleep(1500);
  console.log('stopped after brake:', JSON.stringify(await st()));
  await sim('button=0&hold=2.5'); await sleep(2000);
  console.log('holding A:', JSON.stringify(await st()), '| engine:', await game.$eval('#motion-hud .mh-engine', (e) => e.textContent));
  await sleep(1500);
  console.log('A released:', JSON.stringify(await st()));
  await sim('button=2&hold=2'); await sleep(1600);
  console.log('holding C:', JSON.stringify(await st()), '| paused:', await game.evaluate(() => window.ardukart.state));
  await game.screenshot({ path: OUT + '/game_race_gas.png' });
  // the lab tab gets the focus back and reclaims the wheel
  await lab.bringToFront(); await lab.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(800);
  console.log('lab focused again:', JSON.stringify(await st()));
  await game.bringToFront(); await game.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(800);
  console.log('game focused again:', JSON.stringify(await st()));
  // ---- a second game tab while the first one is on screen and owns the wheel (e.g. an old tab App Lab opened)
  const game2 = await browser.newPage(); watch(game2, 'game2');
  await game2.setViewport({ width: 1600, height: 900 });
  await game2.goto(BASE + '/', { waitUntil: 'load' });
  await game2.waitForFunction(() => window.ardukart && window.ardukart.motion && window.ardukart.motion.online, { timeout: 30000 });
  await game2.evaluate(() => window.ardukart.startSolo({ mode: 'race', track: 'sunset', cc: 100, laps: 3 }));
  await sleep(7000);
  const hud2 = () => game2.evaluate(() => { const m = window.ardukart.motion, h = document.getElementById('motion-hud');
    return { owned: m.owned, hud: !h.classList.contains('hidden'), take: !h.querySelector('.mh-take').classList.contains('hidden'),
      state: h.querySelector('.mh-state').textContent, dir: h.querySelector('.mh-dir').textContent, gyro: h.querySelector('.mh-gyro').textContent,
      classes: h.querySelectorAll('.mh-cls').length }; });
  console.log('game2 opened, game1 went to the background, game2 owns the wheel:', (await hud2()).owned);
  // game1 stays on screen (a second window) and takes the wheel back
  await game.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); return window.ardukart.motion.takeWheel(); });
  await sleep(600);
  await sim('tilt=0.4'); await sleep(900);
  console.log('game2, wheel on the other screen:', JSON.stringify(await hud2()));
  await game2.screenshot({ path: OUT + '/game_race_other_screen.png' });
  await game2.click('#motion-hud .mh-take'); await sleep(800);
  console.log('game2 after USE THE WHEEL HERE:', JSON.stringify(await hud2()), '| game1 owned:', (await st()).owned);
  await sim('tilt=-0.4'); await sleep(900);
  console.log('game2 turning right:', JSON.stringify(await hud2()));
  await game2.screenshot({ path: OUT + '/game_race_wheel_hud.png' });
  // game2 goes to the background: the focused game1 takes the wheel by itself
  await game2.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(300);
  await game.bringToFront(); await game.evaluate(() => window.dispatchEvent(new Event('focus'))); await sleep(800);
  console.log('game2 hidden, game1 focused:', JSON.stringify(await st()), '| game2 owned:', (await hud2()).owned);
  await sim('tilt=0');
  await game.evaluate(() => { const m = window.ardukart.motion; m.resetCalibration(); });
  console.log('ERRORS:', errs.length ? '\n' + errs.join('\n') : 'none');
  await browser.close();
})();
