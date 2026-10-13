// Screenshot harness: node tools/shot.mjs <scenario> [outdir]
// scenarios: intro, studio, toggle, clear, mobile
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const scenario = process.argv[2] || 'intro';
const out = resolve(process.argv[3] || '/tmp/ts-shots');
mkdirSync(out, { recursive: true });
const url = 'file://' + resolve('dist/index.html');
const theme = process.env.THEME || 'dark';
const mobile = scenario === 'mobile';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: mobile ? 2 : 1, colorScheme: theme });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto(url + (scenario === 'studio' || scenario === 'clear' || scenario === 'toggle' || scenario === 'big' || scenario === 'upload' ? '#studio' : ''));
await page.waitForTimeout(1500);
const snap = async name => { await page.screenshot({ path: `${out}/${scenario}-${name}.png` }); };

async function scrollTo(p) {
  await page.evaluate(p => { const m = document.documentElement.scrollHeight - innerHeight; window.scrollTo(0, m * p); }, p);
  await page.waitForTimeout(1400);
}

if (scenario === 'intro' || scenario === 'mobile') {
  for (const p of [0, .12, .2, .32, .4, .5, .56, .62, .7, .8, .88, .93]) { await scrollTo(p); await snap(String(Math.round(p * 100)).padStart(3, '0')); }
  await scrollTo(1); await page.waitForTimeout(2500); await snap('landed');
  console.log('entered:', await page.evaluate(() => document.documentElement.className));
  console.log('running:', await page.evaluate(() => window.__sediment.S.mode), 'placed', await page.evaluate(() => window.__sediment.S.L.length));
} else if (scenario === 'studio') {
  await snap('start');
  await page.waitForTimeout(6000); await snap('running');
  console.log('placed', await page.evaluate(() => window.__sediment.S.L.length), 'kind', await page.evaluate(() => window.__sediment.kind()));
  await page.click('[data-view="explore"]'); await page.waitForTimeout(900); await snap('presets');
  await page.click('[data-view="about"]'); await page.waitForTimeout(900); await snap('colophon');
} else if (scenario === 'clear') {
  await page.click('[data-v="clear"]'); await page.waitForTimeout(800);
  await page.click('#btnRun'); await page.waitForTimeout(9000); await snap('clear');
  const info = await page.evaluate(() => { const S = window.__sediment.S; let z = 0, f = 0; for (let i = 3; i < S.cur.length; i += 4) { if (S.cur[i] === 0) z++; else if (S.cur[i] === 255) f++; } return { alpha: S.alpha, placed: S.L.length, transparentPx: z, opaquePx: f, total: S.cur.length / 4 }; });
  console.log(JSON.stringify(info));
} else if (scenario === 'flows') {
  await page.click('#btnSkip'); await page.waitForTimeout(4500);
  console.log('after skip:', await page.evaluate(() => document.documentElement.className + ' mode=' + window.__sediment.S.mode));
  await page.click('#btnBook'); await page.waitForTimeout(1200); await snap('returning');
  console.log('returning:', await page.evaluate(() => document.documentElement.className + ' scrollY=' + Math.round(scrollY)));
  await page.waitForTimeout(4000); await snap('back-at-cover');
  console.log('back:', await page.evaluate(() => document.documentElement.className + ' scrollY=' + Math.round(scrollY)));
  await page.click('#btnSkip'); await page.waitForTimeout(4500);
  await page.click('[data-v="clear"]'); await page.waitForTimeout(600); await page.click('#btnRun'); await page.waitForTimeout(3000);
  const a = await page.evaluate(() => new Promise(res => { const S = window.__sediment.S; document.querySelector('#view'); 
    // read back the PNG that Save PNG would download
    const c = document.createElement('canvas'); c.width = S.W; c.height = S.H; const x = c.getContext('2d');
    const img = new Image(); img.onload = () => { x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, S.W, S.H).data; let z = 0, o = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] === 0) z++; else if (d[i] === 255) o++; } res({ placed: S.L.length, clear: z, solid: o }); };
    img.src = document.querySelector('#view').toDataURL('image/png'); }));
  console.log('png alpha:', JSON.stringify(a));
  const svg = await page.evaluate(() => { let out = ''; const U = URL.createObjectURL; URL.createObjectURL = b => { b.text().then(t => out = t); return 'blob:x'; }; document.getElementById('btnSvg').click(); URL.createObjectURL = U; return new Promise(r => setTimeout(() => r(out.slice(0, 260)), 300)); });
  console.log('svg head:', svg.replace(/\n/g, ' '));
} else if (scenario === 'big') {
  const res = process.env.RES || '3840';
  await page.evaluate(() => { const c = document.getElementById('cap'); c.value = 50000; c.dispatchEvent(new Event('input')); });
  if (process.env.SPEED) await page.evaluate(v => { const c = document.getElementById('speed'); c.value = v; c.dispatchEvent(new Event('input')); }, process.env.SPEED);
  console.log('cap label:', await page.textContent('#o_cap'), 'cap max:', await page.getAttribute('#cap', 'max'));
  await page.evaluate(res => { const r = document.getElementById('res'); r.value = res; r.dispatchEvent(new Event('change')); }, res);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => window.__sediment.S.ready && !document.getElementById('btnRun').disabled, null, { timeout: 60000 });
  const S0 = await page.evaluate(() => ({ W: window.__sediment.S.W, H: window.__sediment.S.H, workers: window.__sediment.pool().length, kind: window.__sediment.kind() }));
  console.log('canvas', JSON.stringify(S0));
  if (await page.evaluate(() => window.__sediment.S.mode) !== 'run') await page.click('#btnRun');
  for (let i = 1; i <= 4; i++) {
    await page.waitForTimeout(10000);
    console.log(`t=${i * 10}s`, await page.evaluate(() => { const S = window.__sediment.S; return `placed ${S.L.length} rate ${S.rate}/s mode ${S.mode} heap ${Math.round(performance.memory.usedJSHeapSize / 1e6)}MB`; }));
  }
  await snap('big');
  const png = await page.evaluate(() => new Promise(r => { const c = document.querySelector('#view'); r(c.width + 'x' + c.height); }));
  console.log('view canvas', png);
} else if (scenario === 'upload') {
  let dialogs = 0; page.on('dialog', d => { dialogs++; d.dismiss(); });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEgARQOAP3JAgRb4fXkAAAAAElFTkSuQmCC', 'base64');
  await page.setInputFiles('#file', { name: '<img src=x onerror=alert(1)>.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(1500);
  console.log('caption:', JSON.stringify(await page.textContent('#capName')), 'img tags in caption:', await page.locator('#capName img').count());
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><script>alert(2)</script><rect width="40" height="30" fill="tomato"/></svg>';
  await page.setInputFiles('#file', { name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await page.waitForTimeout(1500);
  console.log('after svg:', JSON.stringify(await page.textContent('#capName')), await page.textContent('#s_msg'));
  await page.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await page.waitForTimeout(500);
  console.log('after txt:', await page.textContent('#s_msg'), '| dialogs fired:', dialogs);
} else if (scenario === 'toggle') {
  const box = await page.locator('#themeToggle').boundingBox();
  const clip = { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 };
  const zoom = async name => page.screenshot({ path: `${out}/toggle-${name}.png`, clip });
  await zoom('rest');
  await page.evaluate(() => { const G = window.GlassToggle; G.P.target = G.P.target > 60 ? 31 : 81; G.kick(); });
  const t0 = Date.now();
  for (let i = 0; i < 14; i++) { await zoom('t' + String(i).padStart(2, '0')); await page.waitForTimeout(25); }
  console.log('frames over ms', Date.now() - t0);
  await page.waitForTimeout(1500); await zoom('after'); await snap('page-after');
  console.log('theme', await page.evaluate(() => document.documentElement.dataset.theme));
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
