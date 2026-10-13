// Loads dist/index.html with the network cut off and checks the embedded font is in use: node tools/offline-check.mjs
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
const browser = await chromium.launch({ executablePath: process.env.CHROME || 'chromium' });
const ctx = await browser.newContext();
const outside = [];
await ctx.route('**/*', r => { const u = r.request().url(); if (/^(file|data|blob):/.test(u)) return r.continue(); outside.push(u); return r.abort(); });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('file://' + resolve('dist/index.html') + '#studio');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(3000);
const r = await page.evaluate(() => ({
  loadedFaces: [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight} ${f.unicodeRange.slice(0, 12)}`),
  bodyFont: getComputedStyle(document.body).fontFamily.split(',')[0],
  titleRendersFigtree: document.fonts.check('600 20px Figtree'),
  placed: window.__sediment.S.L.length
}));
console.log(JSON.stringify(r, null, 1));
console.log('requests to the outside:', outside.length ? outside : 'none');
console.log(errs.length ? errs.join('\n') : 'no errors');
await browser.close();
