/* ======================================================================
   Preface. Scrolling opens a book, turns the title leaf, lets the
   epigraph's letters fall into the plate, then the camera zooms into the
   plate until it sits exactly on the studio canvas, and the page dissolves
   into the studio underneath.
   ====================================================================== */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const root = document.documentElement;
const intro = $('intro'), cam = $('cam'), book = $('book'), bookWrap = $('bookWrap');
const epiBy = document.querySelector('.epi-by');
const cover = $('cover'), leaf = $('leafTitle'), pageCh = $('pageCh'), frameEl = $('plateFrame'), plate = $('plate'), epi = $('epi');
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
const easeIO = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeO = t => 1 - Math.pow(1 - t, 3);
const easeIOs = t => t * t * (3 - 2 * t);
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/* ---------- the epigraph becomes loose letters ---------- */
const chars = [];
(function split() {
  const nodes = [...epi.childNodes];
  epi.textContent = '';
  for (const n of nodes) {
    if (n.nodeType !== 3) { epi.appendChild(n); continue; }
    for (const ch of n.textContent) {
      const s = document.createElement('span'); s.className = 'ch'; s.textContent = ch; epi.appendChild(s);
      if (/\S/.test(ch)) chars.push({ el: s, delay: rnd() * 0.5, drift: (rnd() - .5) * 26, rot: (rnd() - .5) * 2.6, tx: rnd(), ty: .25 + rnd() * .7, dx: 0, dy: 0 });
    }
  }
})();
function layoutChars() {
  // where each letter will land inside the plate, in page coordinates
  const fx = frameEl.offsetLeft, fy = frameEl.offsetTop, fw = frameEl.offsetWidth, fh = frameEl.offsetHeight;
  for (const c of chars) {
    const x0 = c.el.offsetLeft + c.el.offsetWidth / 2, y0 = c.el.offsetTop + c.el.offsetHeight / 2;
    c.dx = fx + fw * (.08 + .84 * c.tx) - x0; c.dy = fy + fh * c.ty - y0;
  }
}

/* ---------- plate: a finished picture, painted once with the same idea ---------- */
function paintPlate() {
  if (!window.Sediment) return;
  const src = window.Sediment.makeSample('sunset'), W = 800, H = 600;
  const d = src.getContext('2d').getImageData(0, 0, W, H).data;
  const x = plate.getContext('2d');
  x.fillStyle = '#0a0a0b'; x.fillRect(0, 0, W, H);
  const txt = 'AllthatweseeorseemIsbutadreamwithinadream';
  const lum = (i, j) => { const k = (clamp(j, 0, H - 1) * W + clamp(i, 0, W - 1)) * 4; return .299 * d[k] + .587 * d[k + 1] + .114 * d[k + 2]; };
  const L = [];
  for (let n = 0; n < 7000; n++) {
    const i = (rnd() * W) | 0, j = (rnd() * H) | 0;
    const g = Math.abs(lum(i + 5, j) - lum(i - 5, j)) + Math.abs(lum(i, j + 5) - lum(i, j - 5));
    const size = clamp(30 - g * .35, 7, 30) * (.75 + rnd() * .4);
    L.push({ i, j, size, ch: txt[n % txt.length], a: (rnd() - .5) * 1.1 });
  }
  L.sort((p, q) => q.size - p.size);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  for (const l of L) {
    const k = (l.j * W + l.i) * 4;
    x.save(); x.translate(l.i, l.j); x.rotate(l.a);
    x.font = `bold ${l.size.toFixed(1)}px "Playfair Display", "Bodoni MT", Didot, "Bodoni 72", Georgia, serif`;
    x.fillStyle = `rgb(${d[k]},${d[k + 1]},${d[k + 2]})`;
    x.fillText(l.ch, 0, 0); x.restore();
  }
}

/* ---------- endpaper: tiny letters, settling thicker towards the bottom ---------- */
function paintEndpaper() {
  const c = $('endpaper'), w = c.offsetWidth, h = c.offsetHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  const abc = 'abcdefghijklmnopqrstuvwxyzetaoinshrdlu&';
  let s2 = 5; const r2 = () => (s2 = (s2 * 16807) % 2147483647) / 2147483647;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  const n = Math.round(w * h / 38);
  for (let i = 0; i < n; i++) {
    const y = h * (1 - Math.pow(r2(), 2.6)), depth = y / h;
    x.save(); x.translate(r2() * w, y); x.rotate((r2() - .5) * Math.PI * (1.4 - depth));
    x.font = `${(4 + r2() * 7 + depth * 3).toFixed(1)}px "Figtree", sans-serif`;
    x.fillStyle = `rgba(128,118,104,${(.16 + depth * .34).toFixed(3)})`;
    x.fillText(abc[(r2() * abc.length) | 0], 0, 0); x.restore();
  }
}

/* ---------- light and shade on turning leaves ---------- */
const shades = [];
for (const f of [...cover.children, ...leaf.children]) { const s = document.createElement('div'); s.className = 'shade'; f.appendChild(s); shades.push(s); }

/* ---------- the timeline ---------- */
const CHAPTERS = [[.2, 'Cover'], [.43, 'Title page'], [.6, 'Chapter I'], [.9, 'Plate I'], [2, 'The studio']];
let lastChapter = '';
function render(p) {
  const pw = bookWrap.offsetWidth / 2;
  // 1. the cover opens and the book comes round to face us
  const o = easeIO(seg(p, .035, .27)), t = 1 - easeIOs(seg(p, 0, .5));
  const lf = easeIO(seg(p, .25, .45));
  const ca = -179 * o, la = -177.5 * lf;
  // a leaf swings up on the block's top edge, then settles down onto the table on the left,
  // so the open cover and the turned page lie a book's thickness below the right-hand pages
  const T = pw * .09, drop = a => T * easeIOs(clamp((-a - 70) / 110, 0, 1));
  cover.style.transform = `translateZ(${-drop(ca)}px) rotateY(${ca}deg) translateZ(2px)`;
  leaf.style.transform = `translateZ(${-drop(la) * .96}px) rotateY(${la}deg) translateZ(1px)`;
  const sc = Math.abs(Math.sin(ca * Math.PI / 180)), sl = Math.abs(Math.sin(la * Math.PI / 180));
  shades[0].style.opacity = shades[1].style.opacity = (sc * .45).toFixed(3);
  shades[2].style.opacity = shades[3].style.opacity = (sl * .32).toFixed(3);
  // closed, the book sits at a three-quarter angle showing its page edges; it squares up as it opens
  const shift = -pw / 2 * (1 - o);
  book.style.transformOrigin = `${pw * (1.5 - o * .5)}px 50%`;
  book.style.transform = `translate3d(${shift}px, ${t * 14}px, 0) rotateX(${t * 34}deg) rotateY(${-t * 24}deg) rotateZ(${-t * 9}deg) scale(${.86 + .14 * (1 - t)})`;

  // 2. the epigraph's letters fall into the plate, which fills from the bottom up
  const f = seg(p, .43, .63);
  for (const c of chars) {
    const k = clamp((f - c.delay) / .5, 0, 1), q = k * k;
    c.el.style.transform = k ? `translate(${(c.dx + c.drift * Math.sin(k * 3)) * q}px, ${c.dy * q}px) rotate(${c.rot * k}rad)` : '';
    c.el.style.opacity = k ? (1 - seg(k, .82, 1)).toFixed(3) : '';
  }
  epiBy.style.opacity = (1 - seg(p, .5, .62)).toFixed(3);
  // everything but the plate fades as the camera closes in, so only paper and picture meet the studio
  intro.style.setProperty('--quiet', (1 - seg(p, .74, .88)).toFixed(3));
  const dev = easeO(seg(p, .47, .66));
  plate.style.clipPath = `inset(${((1 - dev) * 100).toFixed(2)}% 0 0 0)`;

  // 3. the camera zooms until the plate sits exactly on the studio canvas
  const z = easeIO(seg(p, .58, .92));
  if (z > 0) {
    const v = window.Sediment.view.getBoundingClientRect();
    const px = bookWrap.offsetLeft + pageCh.offsetLeft + frameEl.offsetLeft, py = bookWrap.offsetTop + pageCh.offsetTop + frameEl.offsetTop;
    const fw = frameEl.offsetWidth, fh = frameEl.offsetHeight;
    const S = Math.min(v.width / fw, v.height / fh), s = Math.exp(Math.log(S) * z);
    const k = Math.abs(S - 1) < 1e-3 ? z : (s - 1) / (S - 1);
    const c0x = px + fw / 2, c0y = py + fh / 2, c1x = v.left + v.width / 2, c1y = v.top + v.height / 2;
    const cxp = c0x + (c1x - c0x) * k, cyp = c0y + (c1y - c0y) * k;
    cam.style.transform = `translate(${(cxp - c0x * s).toFixed(2)}px, ${(cyp - c0y * s).toFixed(2)}px) scale(${s.toFixed(4)})`;
  } else cam.style.transform = '';

  // 4. the page dissolves into the studio
  const fade = seg(p, .9, .99);
  intro.style.opacity = (1 - easeIOs(fade)).toFixed(3);
  intro.style.pointerEvents = fade > .5 ? 'none' : '';
  if (p > .9) root.classList.add('landed'); else if (p < .86) root.classList.remove('landed');
  if (p > .93 && !autostarted) { autostarted = true; window.Sediment.autostart(); }

  // interface around the book
  $('cue').style.opacity = (1 - seg(p, 0, .03)).toFixed(3);
  $('chapterFill').style.width = (p * 100).toFixed(1) + '%';
  const name = CHAPTERS.find(c => p < c[0])[1];
  if (name !== lastChapter) { lastChapter = name; $('chapterName').textContent = name; }
}
let autostarted = false;

/* ---------- scroll, smoothed ---------- */
let target = 0, cur = 0, raf = 0, last = 0, returning = false, tween = null;
const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
const readScroll = () => { target = clamp(scrollY / maxScroll(), 0, 1); };
function loop(now) {
  raf = 0;
  if (root.classList.contains('entered')) return;
  const dt = Math.min(.05, (now - last) / 1000 || .016); last = now;
  if (tween) {
    const k = clamp((now - tween.t0) / tween.dur, 0, 1);
    window.scrollTo(0, tween.from + (tween.to - tween.from) * easeIO(k));
    if (k >= 1) tween = null;
  }
  readScroll();
  cur += (target - cur) * (1 - Math.exp(-dt * 6.5));
  if (Math.abs(target - cur) < 1e-4) cur = target;
  render(cur);
  if (returning && target < .85) returning = false;
  if (!returning && cur > .993 && target > .993) { enter(); return; }
  raf = requestAnimationFrame(loop);
}
function run() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } }
function scrollTween(to, dur) { tween = { from: scrollY, to, dur, t0: performance.now() }; run(); }
// the reader taking over cancels any automatic scroll, and lets them land again if they head back down
for (const ev of ['wheel', 'touchstart', 'keydown']) window.addEventListener(ev, e => { if (ev === 'keydown' && e.key === 'Enter') return; tween = null; returning = false; }, { passive: true });

function enter() {
  tween = null;
  root.classList.add('entered', 'landed');
  window.scrollTo(0, 0);
  intro.style.opacity = ''; cam.style.transform = '';
  if (location.hash !== '#studio') history.replaceState(null, '', '#studio');
  window.Sediment.fit();
  if (!autostarted) { autostarted = true; window.Sediment.autostart(); }
}
function backToBook() {
  window.Sediment.showView('create');
  root.classList.remove('entered');
  history.replaceState(null, '', location.pathname + location.search);
  const m = maxScroll();
  window.scrollTo(0, m);
  target = cur = 1; returning = true;
  layoutChars();
  render(1);
  scrollTween(0, 3200);
}
$('btnSkip').addEventListener('click', () => scrollTween(maxScroll(), Math.max(900, (1 - target) * 2600)));
window.addEventListener('keydown', e => { if (e.key === 'Enter' && !root.classList.contains('entered') && document.activeElement === document.body) scrollTween(maxScroll(), Math.max(900, (1 - target) * 2600)); });
$('btnBook').addEventListener('click', backToBook);
$('btnPreface').addEventListener('click', backToBook);
window.addEventListener('scroll', run, { passive: true });
window.addEventListener('resize', () => { layoutChars(); paintEndpaper(); run(); });

/* ---------- start ---------- */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
paintPlate();
const boot = () => { layoutChars(); paintEndpaper(); if (!root.classList.contains('entered')) { window.scrollTo(0, 0); target = cur = 0; render(0); run(); } else { render(1); autostarted = true; window.Sediment.autostart(); } };
if (document.fonts && document.fonts.ready) document.fonts.ready.then(boot); else boot();
render(0);
})();
