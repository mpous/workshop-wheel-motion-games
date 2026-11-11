import puppeteer from 'puppeteer-core';
const [,, inp, out] = process.argv;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage(); await p.setViewport({ width: 1040, height: 1040 });
await p.goto('file://' + process.cwd() + '/' + inp); await p.screenshot({ path: out }); await b.close();
