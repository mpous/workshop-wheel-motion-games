const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist'] });
  const p = await b.newPage(); await p.setViewport({ width: 1280, height: 720 });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  p.on('console', (m) => { if (m.type()==='error') console.log('[err]', m.text()); });
  await p.goto('http://localhost:' + (process.argv[3]||7111) + '/');
  await p.waitForFunction('window.ardukart && window.ardukart.state === "menu"', { timeout: 60000 });
  const code = process.argv[2];
  for (let i = 0; i < +(process.env.N || 1); i++) {
    await new Promise(r => setTimeout(r, +(process.env.DT || 1000)));
    console.log(await p.evaluate("(()=>{" + code + "})()"));
  }
  await b.close();
})();
