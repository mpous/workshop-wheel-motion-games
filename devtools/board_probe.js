// Read the wheel state the game sees on a running board: node board_probe.js [url]
const puppeteer = require('puppeteer-core');
const BASE = process.argv[2] || 'http://127.0.0.1:7000';
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 6000));
  console.log(JSON.stringify(await p.evaluate(() => {
    const a = window.ardukart, m = a.motion;
    return { netId: a.net.id, socketId: a.net.socket && a.net.socket.id, owner: m.owner, ownerKind: m.ownerKind, owned: m.owned, online: m.online, active: m.active,
      hw: m.hw, engine: m.engine && m.engine.active, labels: m.labels, hasModel: m.hasModel, enabled: m.settings.enabled, steer: m.steer };
  }), null, 1));
  await browser.close();
})();
