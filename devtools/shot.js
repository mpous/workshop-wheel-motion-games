const puppeteer = require('puppeteer-core');
const path = require('path');
(async () => {
  const views = process.argv.slice(2).length ? process.argv.slice(2) : ['front', 'rear', 'close', 'items'];
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  page.on('console', (m) => { if (m.text().startsWith('BR ') || ['error', 'warning', 'warn'].includes(m.type())) console.log('[console.' + m.type() + ']', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  for (const v of views) {
    const qs = v.includes('=') ? v : 'view=' + v;
    const name = qs.replace(/[^a-z0-9]+/gi, '_');
    await page.goto('http://localhost:8765/devtools/kart_preview/index.html?' + qs, { waitUntil: 'load' });
    await page.waitForFunction('window.__ready === true', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 400));
    const out = path.join(__dirname, 'kart_preview', 'shot_' + name + '.png');
    await page.screenshot({ path: out });
    console.log('saved', out, await page.$eval('#info', (e) => e.textContent));
  }
  await browser.close();
})();
