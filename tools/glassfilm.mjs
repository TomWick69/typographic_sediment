// Steps the glass switch physics frame by frame and saves a film strip: node tools/glassfilm.mjs <outdir> [frames]
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] || '/tmp/ts-film'); mkdirSync(out, { recursive: true });
const N = +(process.argv[3] || 48);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2, colorScheme: process.env.THEME || 'light' })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
await page.goto('file://' + resolve('dist/index.html') + '#studio');
await page.waitForTimeout(1200);
const frames = await page.evaluate(N => {
  const G = window.GlassToggle, cv = document.getElementById('glassCanvas'), shots = [], log = [];
  G.P.target = G.P.target > (G.XL + G.XR) / 2 ? G.XL : G.XR;
  for (let f = 0; f < N; f++) {
    for (let i = 0; i < 4; i++) G.step(1 / 240);
    G.draw();
    // composite onto the page colour so the strip shows what a viewer sees
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d'); x.fillStyle = getComputedStyle(document.body).backgroundColor; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0);
    shots.push(c.toDataURL('image/png'));
    const P = G.P; log.push([f, P.x.toFixed(1), P.v.toFixed(0), P.s.toFixed(3), P.b.toFixed(3), P.w.toFixed(3), document.documentElement.dataset.theme[0]].join(' '));
  }
  return { shots, log };
}, N);
frames.shots.forEach((d, i) => writeFileSync(`${out}/f${String(i).padStart(3, '0')}.png`, Buffer.from(d.split(',')[1], 'base64')));
console.log(frames.log.join('\n'));
console.log(errs.length ? errs.join('\n') : 'no errors');
await browser.close();
