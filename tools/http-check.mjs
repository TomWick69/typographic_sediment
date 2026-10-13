// Loads the built site over HTTP (as a host would serve it) and reports the worker mode: node tools/http-check.mjs <url>
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: process.env.CHROME || 'chromium' });
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto(process.argv[2] + '#studio'); await page.waitForTimeout(6000);
console.log(await page.evaluate(() => `workers=${window.__sediment.pool().length} kind=${window.__sediment.kind()} placed=${window.__sediment.S.L.length}`));
console.log(errs.length ? errs.join('\n') : 'no errors');
await browser.close();
