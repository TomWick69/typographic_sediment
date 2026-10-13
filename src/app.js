/* ======================================================================
   Main thread: interface, coordination, display, time-lapse, export.
   ====================================================================== */
(() => {
'use strict';
const $ = id => document.getElementById(id);

const FONTS = {
  didone: '"Playfair Display", "Bodoni MT", Didot, "Bodoni 72", Georgia, serif',
  serif: 'Georgia, "Times New Roman", serif',
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  mono: '"Courier New", Courier, monospace',
  heavy: 'Impact, "Arial Black", "Helvetica Neue", sans-serif'
};
const LEVELS = [
  { label: 'one at a time, slow motion', maxAnim: 1, rate: 0.5 },
  { label: 'a couple at a time', maxAnim: 2, rate: 1 },
  { label: 'a few', maxAnim: 4, rate: 1 },
  { label: 'several', maxAnim: 8, rate: 2 },
  { label: 'a dozen or more', maxAnim: 20, rate: 3 },
  { label: 'dozens', maxAnim: 60, rate: 4 },
  { label: 'a flood', maxAnim: 200, rate: 6 },
  { label: 'instant, no falling', maxAnim: Infinity, rate: 0 }
];
const G = 12;                       // error-grid cell size in px
const BATCH = 3;                    // jobs per message
const WT = [1.0, 1.5, 0.5, 1.0];    // channel weights (r, g, b, alpha), must match the worker
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const runBtns = [$('btnRun'), $('hudPause')];
const maxSizePx = () => Math.round(24 + (+$('maxS').value) * 1.16);   // the Letter size slider, 0 to 100, as pixels
function setRunDisabled(v) { runBtns.forEach(b => b.disabled = !!v); }
function setRunLabel(txt) {
  $('genLabel').textContent = txt === 'Start' ? 'Generate' : txt;
  runBtns.forEach(b => b.classList.toggle('running', txt === 'Pause'));
}

const view = $('view'), vx = view.getContext('2d');
const curC = document.createElement('canvas'), curX = curC.getContext('2d');
const tgtC = document.createElement('canvas'), tgtX = tgtC.getContext('2d', { willReadFrequently: true });
const baseC = document.createElement('canvas'), baseX = baseC.getContext('2d');
const bgC = document.createElement('canvas'), bgX = bgC.getContext('2d', { willReadFrequently: true });
const thumb = $('thumb'), thumbX = thumb.getContext('2d');

const S = {
  W: 0, H: 0, mode: 'idle', done: false, ready: false, src: null, epoch: 0,
  tgt: null, cur: null, L: [], aabb: [], anim: [],
  cols: 0, rows: 0, cellErr: null, sizeMap: null, wts: null, block: null, exhausted: false,
  totalSq: 0, charIdx: 0, retry: [], rejected: 0, stale: 0, rejectStreak: 0, inflight: 0,
  bg: '#000', bgSoft: false, placed: '', fc: 0, txt: null, chars: ['•'],
  rateT: 0, rateN: 0, rate: 0
};

/* ---------- worker pool ---------- */
let pool = [], poolKind = 'none', matterInline = null;

function getMatterInline() {
  if (!matterInline) {
    matterInline = (new Function($('matter-src').textContent + '\n;return (typeof Matter!=="undefined")?Matter:this.Matter;')).call({});
  }
  return matterInline;
}
class LocalWorker {
  constructor() {
    this.q = []; this.scheduled = false; this.onmessage = null; this.out = 0;
    const me = this;
    this.inner = { onmessage: null, postMessage(m) { setTimeout(() => { if (me.onmessage) me.onmessage({ data: m }); }, 0); } };
    workerMain(this.inner, getMatterInline(), (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
  }
  postMessage(m) { this.q.push(m); if (!this.scheduled) { this.scheduled = true; setTimeout(() => this.run(), 0); } }
  run() {
    this.scheduled = false;
    const m = this.q.shift();
    if (m) this.inner.onmessage({ data: m });
    if (this.q.length) { this.scheduled = true; setTimeout(() => this.run(), 0); }
  }
  terminate() { this.q = []; this.onmessage = null; }
}
function destroyPool() { for (const w of pool) { try { w.terminate(); } catch (e) {} } pool = []; }

function createPool(n) {
  return new Promise(resolve => {
    destroyPool();
    const finish = (ws, kind) => {
      pool = ws; poolKind = kind;
      ws.forEach(w => { w.out = 0; w.onmessage = e => onWorkerMsg(w, e.data); });
      resolve();
    };
    const fallback = () => finish([new LocalWorker()], 'inline');
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof Blob === 'undefined' || !URL.createObjectURL) return fallback();
    let ws = [], ready = 0, failed = false, timer = null;
    const fail = () => { if (failed) return; failed = true; clearTimeout(timer); ws.forEach(w => { try { w.terminate(); } catch (e) {} }); fallback(); };
    try {
      const code = $('matter-src').textContent + '\n;(' + workerMain.toString() + ')(self, Matter, function(w,h){return new OffscreenCanvas(w,h);});';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        w.onerror = fail;
        w.onmessage = e => {
          if (e.data.t !== 'ready') return;
          if (!e.data.ok) return fail();
          if (++ready === n && !failed) { clearTimeout(timer); finish(ws, 'threads'); }
        };
        ws.push(w);
        w.postMessage({ t: 'ping' });
      }
      timer = setTimeout(fail, 5000);
    } catch (e) { fail(); }
  });
}
function wantedWorkers() {
  const v = $('workers').value;
  // every worker holds its own copy of the picture (about 88 MB at 4K), so big canvases get fewer of them
  const res = +$('res').value, cap = res >= 3000 ? 4 : res >= 2000 ? 6 : 8;
  return v === 'auto' ? Math.max(1, Math.min(cap, (navigator.hardwareConcurrency || 4) - 1)) : +v;
}

/* ---------- sample image ---------- */
function makeSunset() {
  const c = document.createElement('canvas'); c.width = 800; c.height = 600;
  const x = c.getContext('2d');
  let g = x.createLinearGradient(0, 0, 0, 600);
  g.addColorStop(0, '#101c52'); g.addColorStop(.42, '#b53f6e'); g.addColorStop(.68, '#f7945a'); g.addColorStop(1, '#ffd98a');
  x.fillStyle = g; x.fillRect(0, 0, 800, 600);
  g = x.createRadialGradient(560, 360, 10, 560, 360, 230);
  g.addColorStop(0, 'rgba(255,251,224,1)'); g.addColorStop(.35, 'rgba(255,209,102,.7)'); g.addColorStop(1, 'rgba(255,209,102,0)');
  x.fillStyle = g; x.fillRect(0, 0, 800, 600);
  x.fillStyle = '#fff3c4'; x.beginPath(); x.arc(560, 360, 74, 0, 7); x.fill();
  const mt = (col, pts) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, 600); pts.forEach(p => x.lineTo(p[0], p[1])); x.lineTo(800, 600); x.closePath(); x.fill(); };
  mt('#6a2d63', [[0,400],[120,340],[230,395],[340,320],[470,410],[620,350],[800,420]]);
  mt('#401f55', [[0,450],[150,400],[300,455],[430,390],[600,470],[760,410],[800,430]]);
  mt('#1a1038', [[0,520],[180,470],[360,530],[520,480],[700,540],[800,500]]);
  g = x.createLinearGradient(0, 520, 0, 600);
  g.addColorStop(0, '#2c2a66'); g.addColorStop(1, '#0d0a24');
  x.fillStyle = g; x.fillRect(0, 530, 800, 70);
  x.fillStyle = 'rgba(255,214,130,.75)';
  for (let i = 0; i < 9; i++) x.fillRect(560 - 60 + i * 4, 535 + i * 7, 120 - i * 8, 4);
  return c;
}

function makeMoon() {
  const c = document.createElement('canvas'); c.width = 800; c.height = 600;
  const x = c.getContext('2d');
  let g = x.createLinearGradient(0, 0, 0, 600);
  g.addColorStop(0, '#03050d'); g.addColorStop(1, '#101c3c');
  x.fillStyle = g; x.fillRect(0, 0, 800, 600);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 160; i++) { x.fillStyle = `rgba(255,255,255,${.25 + rnd() * .6})`; x.beginPath(); x.arc(rnd() * 800, rnd() * 600, .4 + rnd() * 1.3, 0, 7); x.fill(); }
  g = x.createRadialGradient(470, 270, 60, 470, 270, 300);
  g.addColorStop(0, 'rgba(190,210,255,.5)'); g.addColorStop(1, 'rgba(190,210,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 800, 600);
  g = x.createRadialGradient(445, 245, 10, 470, 270, 135);
  g.addColorStop(0, '#fffef7'); g.addColorStop(1, '#c9d2e6');
  x.fillStyle = g; x.beginPath(); x.arc(470, 270, 135, 0, 7); x.fill();
  x.fillStyle = 'rgba(110,122,150,.38)';
  [[430, 235, 34], [505, 300, 26], [455, 320, 18], [515, 225, 14], [395, 290, 12], [490, 255, 9]].forEach(([a, b, r]) => { x.beginPath(); x.arc(a, b, r, 0, 7); x.fill(); });
  x.fillStyle = '#05070f';
  x.beginPath(); x.moveTo(0, 600); [[0,520],[120,490],[260,540],[400,500],[560,545],[700,505],[800,530],[800,600]].forEach(p => x.lineTo(p[0], p[1])); x.closePath(); x.fill();
  return c;
}
function makeWaves() {
  const c = document.createElement('canvas'); c.width = 800; c.height = 600;
  const x = c.getContext('2d');
  x.fillStyle = '#060e16'; x.fillRect(0, 0, 800, 600);
  const cols = ['#0e5e73', '#12808a', '#2aa59a', '#6cc7a3', '#f2c078', '#f08f63', '#e2606a', '#a8456f', '#5e2f68'];
  for (let i = 0; i < cols.length; i++) {
    const base = 120 + i * 52, amp = 26 + i * 4, ph = i * 0.9;
    x.fillStyle = cols[i]; x.beginPath(); x.moveTo(0, 600);
    for (let px = 0; px <= 800; px += 10) x.lineTo(px, base + Math.sin(px / 85 + ph) * amp + Math.sin(px / 33 + ph * 2) * 7);
    x.lineTo(800, 600); x.closePath(); x.fill();
  }
  return c;
}
function makeSample(kind) { return kind === 'moon' ? makeMoon() : kind === 'waves' ? makeWaves() : makeSunset(); }

/* ---------- loading ---------- */
function setSource(el, w, h, name) { S.src = { el, w, h, name }; applySource(); }
let applySource = function () {
  const { el, w, h } = S.src;
  const res = +$('res').value, sc = res / Math.max(w, h);
  const W = Math.max(32, Math.round(w * sc)), H = Math.max(32, Math.round(h * sc));
  S.W = W; S.H = H;
  for (const c of [tgtC, curC, baseC, bgC, view]) { c.width = W; c.height = H; }
  S.alpha = $('bg').value === 'clear';
  tgtX.clearRect(0, 0, W, H);
  if (!S.alpha) { tgtX.fillStyle = '#fff'; tgtX.fillRect(0, 0, W, H); }
  tgtX.drawImage(el, 0, 0, W, H);
  // the engine works in premultiplied colour, so a transparent pixel is (0, 0, 0, 0) whatever its hidden colour
  const td = tgtX.getImageData(0, 0, W, H).data;
  if (S.alpha) for (let i = 0; i < td.length; i += 4) { const a = td[i + 3] / 255; td[i] = Math.round(td[i] * a); td[i + 1] = Math.round(td[i + 1] * a); td[i + 2] = Math.round(td[i + 2] * a); }
  S.tgt = td;
  const ts = Math.min(1, 640 / W);   // the preview never needs more than this
  thumb.width = Math.round(W * ts); thumb.height = Math.round(H * ts);
  thumbX.clearRect(0, 0, thumb.width, thumb.height); thumbX.drawImage(tgtC, 0, 0, thumb.width, thumb.height);
  S.srcName = S.src.name || 'image';
  if (pool.length) reset();
};
function loadFile(f) {
  if (!f || !f.type.startsWith('image/')) { msg('that file is not an image'); return; }
  const url = URL.createObjectURL(f), img = new Image();
  const nm = f.name.replace(/\.[^.]+$/, '');
  img.onload = () => {
    URL.revokeObjectURL(url);
    try { setSource(img, img.naturalWidth, img.naturalHeight, nm); }
    catch (e) { setSource(makeSample('sunset'), 800, 600, 'Sunset'); msg('that image could not be read, so the sample is back'); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); msg('could not read that image'); };
  img.src = url;
}

/* ---------- reset ---------- */
function cellError(cx, cy) {
  const W = S.W, x0 = cx * G, y0 = cy * G, x1 = Math.min(S.W, x0 + G), y1 = Math.min(S.H, y0 + G);
  let s = 0, k = 0; const a = S.cur, t = S.tgt;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 4;
    const d0 = a[i] - t[i], d1 = a[i + 1] - t[i + 1], d2 = a[i + 2] - t[i + 2], d3 = a[i + 3] - t[i + 3];
    s += WT[0] * d0 * d0 + WT[1] * d1 * d1 + WT[2] * d2 * d2 + WT[3] * d3 * d3; k++;
  }
  return k ? s / (3 * k) : 0;
}

function reset() {
  if (!S.src || !pool.length) return;
  replayToken++; S.epoch++;
  S.mode = 'idle'; S.done = false; S.anim = []; S.inflight = 0; $('stage').classList.remove('running');
  const W = S.W, H = S.H, tg = S.tgt;
  const minS = +$('minS').value, maxS = Math.max(maxSizePx(), minS + 2);

  let r = 0, g = 0, b = 0; const n = W * H;
  for (let i = 0; i < tg.length; i += 4) { r += tg[i]; g += tg[i + 1]; b += tg[i + 2]; }
  const bgk = $('bg').value;
  S.bgSoft = bgk === 'soft';
  bgX.clearRect(0, 0, W, H);
  if (S.alpha) {
    // transparent: nothing underneath, so every kept letter adds coverage and the gaps stay clear
    S.bg = 'transparent';
    S.cur = new Uint8ClampedArray(W * H * 4);
  } else if (S.bgSoft) {
    // blur by shrinking twice and enlarging smoothly, which works in every browser
    const s1 = document.createElement('canvas'), s2 = document.createElement('canvas');
    s1.width = Math.max(2, Math.round(W / 16)); s1.height = Math.max(2, Math.round(H / 16));
    s2.width = Math.max(2, Math.round(W / 5)); s2.height = Math.max(2, Math.round(H / 5));
    const x1 = s1.getContext('2d'), x2 = s2.getContext('2d');
    x1.imageSmoothingQuality = x2.imageSmoothingQuality = bgX.imageSmoothingQuality = 'high';
    x1.drawImage(tgtC, 0, 0, s1.width, s1.height);
    x2.drawImage(s1, 0, 0, s2.width, s2.height);
    bgX.drawImage(s2, 0, 0, W, H);
    S.bg = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
    bgX.globalAlpha = 0.6; bgX.fillStyle = S.bg; bgX.fillRect(0, 0, W, H); bgX.globalAlpha = 1;   // fade it so letters stay visible
    S.cur = new Uint8ClampedArray(bgX.getImageData(0, 0, W, H).data);
    for (let i = 3; i < S.cur.length; i += 4) S.cur[i] = 255;
  } else {
    const rgb = bgk === 'avg' ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
              : bgk === 'black' ? [10, 10, 11] : bgk === 'white' ? [251, 251, 248] : [238, 229, 207];
    S.bg = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    bgX.fillStyle = S.bg; bgX.fillRect(0, 0, W, H);
    S.cur = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < S.cur.length; i += 4) { S.cur[i] = rgb[0]; S.cur[i + 1] = rgb[1]; S.cur[i + 2] = rgb[2]; S.cur[i + 3] = 255; }
  }
  curX.clearRect(0, 0, W, H); curX.drawImage(bgC, 0, 0);
  baseX.clearRect(0, 0, W, H); baseX.drawImage(bgC, 0, 0);
  $('view').classList.toggle('clear', S.alpha);

  let tot = 0;
  for (let i = 0; i < tg.length; i += 4) {
    const d0 = S.cur[i] - tg[i], d1 = S.cur[i + 1] - tg[i + 1], d2 = S.cur[i + 2] - tg[i + 2], d3 = S.cur[i + 3] - tg[i + 3];
    tot += WT[0] * d0 * d0 + WT[1] * d1 * d1 + WT[2] * d2 * d2 + WT[3] * d3 * d3;
  }
  S.totalSq = tot; S.err0 = errPct();

  const cols = Math.ceil(W / G), rows = Math.ceil(H / G);
  S.cols = cols; S.rows = rows;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = 0.299 * tg[p] + 0.587 * tg[p + 1] + 0.114 * tg[p + 2];
  const grad = new Float32Array(cols * rows), cnt = new Float32Array(cols * rows);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const i = y * W + x, c = ((y / G) | 0) * cols + ((x / G) | 0);
    grad[c] += Math.abs(lum[i + 1] - lum[i]) + Math.abs(lum[i + W] - lum[i]);
    if (S.alpha) grad[c] += 0.5 * (Math.abs(tg[i * 4 + 7] - tg[i * 4 + 3]) + Math.abs(tg[(i + W) * 4 + 3] - tg[i * 4 + 3]));
    cnt[c]++;
  }
  for (let c = 0; c < grad.length; c++) grad[c] = cnt[c] ? grad[c] / cnt[c] : 0;
  const sorted = Array.from(grad).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] + 1e-6;
  S.sizeMap = new Float32Array(cols * rows); S.cellErr = new Float32Array(cols * rows);
  S.wts = new Float32Array(cols * rows); S.block = new Int16Array(cols * rows);
  for (let c = 0; c < grad.length; c++) {
    const d = Math.pow(Math.min(1, grad[c] / p90), 0.7);
    S.sizeMap[c] = Math.max(minS, maxS * (1 - 0.85 * d));
  }
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) S.cellErr[cy * cols + cx] = cellError(cx, cy);

  S.L = []; S.aabb = []; S.charIdx = 0; S.retry = []; S.rejected = 0; S.stale = 0; S.rejectStreak = 0;
  S.placed = ''; S.exhausted = false; S.rateT = performance.now(); S.rateN = 0; S.rate = 0;
  for (const w of pool) {
    w.out = 0;
    w.postMessage({ t: 'init', epoch: S.epoch, W, H, tgt: S.tgt, cur: S.cur });
  }
  S.ready = true;
  setRunLabel('Start'); setRunDisabled(false);
  msg('ready'); updateStats(); render();
}

/* ---------- dispatching jobs ---------- */
function refreshChars() {
  const v = $('text').value;
  if (v !== S.txt) { S.txt = v; const c = Array.from(v).filter(ch => /\S/.test(ch) && !/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/.test(ch)); S.chars = c.length ? c : ['•']; }
}
function nextChar() {
  if (S.retry.length) return S.retry.pop();
  const ch = S.chars[S.charIdx % S.chars.length]; S.charIdx++; return ch;
}
function pickCell() {
  const w = S.wts, e = S.cellErr, sm = S.sizeMap, bl = S.block;
  let tAll = 0, tFree = 0;
  for (let i = 0; i < w.length; i++) {
    const v = (sm[i] > 0 && e[i] > 25) ? Math.pow(e[i], 1.5) : 0;
    tAll += v;
    if (bl[i] > 0) { w[i] = 0; } else { w[i] = v; tFree += v; }
  }
  S.exhausted = tAll <= 0;
  if (tFree <= 0) return -1;
  let r = Math.random() * tFree, last = -1;
  for (let i = 0; i < w.length; i++) { if (w[i] > 0) { last = i; r -= w[i]; if (r <= 0) return i; } }
  return last;
}
function blockRadius(size) { return Math.ceil(size / (2 * G)) + 1; }
function markBlock(c, size, d) {
  const rr = blockRadius(size), cx = c % S.cols, cy = (c / S.cols) | 0;
  for (let y = Math.max(0, cy - rr); y <= Math.min(S.rows - 1, cy + rr); y++)
    for (let x = Math.max(0, cx - rr); x <= Math.min(S.cols - 1, cx + rr); x++) S.block[y * S.cols + x] += d;
}

function pump() {
  if (S.mode !== 'run' || S.done || !S.ready) return;
  const lvl = LEVELS[+$('speed').value];
  refreshChars();
  const s = +$('strict').value / 100;
  const common = { fam: FONTS[$('font').value], chaos: +$('chaos').value / 100, tries: +$('tries').value, strictK: s * s * 5000, traj: lvl.rate > 0, cm: +$('cmode').value, G, ov: +$('overlap').value / 100 };
  const minS = +$('minS').value;
  for (const w of pool) {
    while (w.out < 2 && S.anim.length < lvl.maxAnim) {
      const list = [];
      for (let k = 0; k < BATCH; k++) {
        const c = pickCell(); if (c < 0) break;
        const size = Math.max(minS, Math.round(S.sizeMap[c] * (0.8 + Math.random() * 0.35)));
        markBlock(c, size, 1);
        list.push(Object.assign({ c, cx: ((c % S.cols) + 0.5) * G, cy: (((c / S.cols) | 0) + 0.5) * G, size, ch: nextChar() }, common));
      }
      if (!list.length) break;
      w.out++; S.inflight += list.length;
      w.postMessage({ t: 'jobs', epoch: S.epoch, ver: S.L.length, list });
    }
  }
  if (S.exhausted && S.inflight === 0) finish('every area is as good as it can get');
}

function onWorkerMsg(w, d) {
  if (d.t !== 'res' || d.epoch !== S.epoch) return;
  w.out--; S.inflight -= d.results.length;
  const live = S.mode === 'run' && !S.done;
  for (const r of d.results) {
    markBlock(r.c, r.size, -1);
    if (!live) continue;
    if (r.st === 'acc') acceptResult(r, d.ver); else rejectResult(r);
  }
  if (S.mode === 'run') pump();
}

function rejectResult(r) {
  S.rejected++; S.rejectStreak++; S.retry.push(r.ch);
  const minS = +$('minS').value, sm = S.sizeMap;
  if (sm[r.c] <= minS * 1.001) sm[r.c] = 0; else sm[r.c] = Math.max(minS, sm[r.c] * 0.8);
  if (S.rejectStreak > 1500) finish('no more improvements found');
}

function acceptResult(r, ver) {
  const x0 = r.rx - 2, y0 = r.ry - 2, x1 = r.rx + r.rw + 2, y1 = r.ry + r.rh + 2;
  for (let i = ver; i < S.aabb.length; i++) {
    const A = S.aabb[i];
    if (!(A[2] <= x0 || A[0] >= x1 || A[3] <= y0 || A[1] >= y1)) { S.stale++; S.retry.push(r.ch); return; }
  }
  // composite into the main replica and measure the real change in error
  const W = S.W, cur = S.cur, tg = S.tgt, mask = r.mask, c0 = r.fill[0], c1 = r.fill[1], c2 = r.fill[2];
  let delta = 0;
  for (let j = 0; j < r.rh; j++) for (let i = 0; i < r.rw; i++) {
    const a8 = mask[j * r.rw + i]; if (!a8) continue;
    const a = a8 / 255, ti = ((r.ry + j) * W + r.rx + i) * 4;
    const o0 = cur[ti], o1 = cur[ti + 1], o2 = cur[ti + 2];
    const o3 = cur[ti + 3];
    cur[ti] = o0 + (c0 - o0) * a; cur[ti + 1] = o1 + (c1 - o1) * a; cur[ti + 2] = o2 + (c2 - o2) * a; cur[ti + 3] = o3 + (255 - o3) * a;
    const p0 = o0 - tg[ti], p1 = o1 - tg[ti + 1], p2 = o2 - tg[ti + 2], p3 = o3 - tg[ti + 3];
    const q0 = cur[ti] - tg[ti], q1 = cur[ti + 1] - tg[ti + 1], q2 = cur[ti + 2] - tg[ti + 2], q3 = cur[ti + 3] - tg[ti + 3];
    delta += WT[0] * (p0 * p0 - q0 * q0) + WT[1] * (p1 * p1 - q1 * q1) + WT[2] * (p2 * p2 - q2 * q2) + WT[3] * (p3 * p3 - q3 * q3);
  }
  S.totalSq -= delta;
  for (let cy = Math.floor(r.ry / G); cy <= Math.floor((r.ry + r.rh - 1) / G); cy++)
    for (let cx = Math.floor(r.rx / G); cx <= Math.floor((r.rx + r.rw - 1) / G); cx++)
      S.cellErr[cy * S.cols + cx] = cellError(cx, cy);

  const entry = {
    ch: r.ch, font: r.font, size: r.size, x: r.x, y: r.y, a: r.a, ox: r.ox, oy: r.oy,
    fill: `rgb(${r.fill[0]},${r.fill[1]},${r.fill[2]})`, sx: r.sx, sy: r.sy, a0: r.a0
  };
  S.L.push(entry); S.aabb.push([r.rx, r.ry, r.rx + r.rw, r.ry + r.rh]);
  const am = { t: 'accept', epoch: S.epoch, mask: r.mask, rx: r.rx, ry: r.ry, rw: r.rw, rh: r.rh, fill: r.fill, shape: r.shape, bx: r.bx, by: r.by, a: r.a };
  for (const w of pool) w.postMessage(am);
  S.rejectStreak = 0; S.placed += r.ch;
  if (S.placed.length > 400) S.placed = S.placed.slice(-200);

  const lvl = LEVELS[+$('speed').value];
  if (r.traj && lvl.rate > 0) S.anim.push({ e: entry, traj: r.traj, i: 0 });
  else drawLetter(curX, entry);
  checkStop();
}

const errPct = () => Math.sqrt(Math.max(0, S.totalSq) / (S.W * S.H * (S.alpha ? 4 : 3))) / 255 * 100;
function checkStop() {
  const stop = +$('stopErr').value;
  if (stop > 0 && errPct() <= stop) finish('reached target difference');
  else if (S.L.length >= +$('cap').value) finish('reached letter limit');
}
function flushAnims() { for (const a of S.anim) drawLetter(curX, a.e); S.anim = []; }
function finish(why) {
  if (S.done) return;
  S.done = true; S.mode = 'idle'; flushAnims(); $('stage').classList.remove('running');
  setRunLabel('Finished'); setRunDisabled(true);
  msg('done: ' + why); updateStats(); render();
}

/* ---------- drawing ---------- */
let dirty = true;
function drawLetter(ctx, e) {
  if (ctx === curX) dirty = true;
  ctx.save();
  ctx.translate(e.x, e.y); ctx.rotate(e.a);
  ctx.font = e.font; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = e.fill;
  ctx.fillText(e.ch, e.ox, e.oy);
  ctx.restore();
}
const tmp = {};
function render() {
  if (S.mode === 'replay') return;
  dirty = false;
  vx.clearRect(0, 0, S.W, S.H);
  vx.drawImage(curC, 0, 0);
  for (const a of S.anim) {
    const n = a.traj.length / 3, f = Math.min(a.i, n - 1), k = f | 0, t = f - k, k2 = Math.min(k + 1, n - 1);
    const p = a.traj, e = a.e;
    tmp.ch = e.ch; tmp.font = e.font; tmp.ox = e.ox; tmp.oy = e.oy; tmp.fill = e.fill;
    tmp.x = p[k * 3] + (p[k2 * 3] - p[k * 3]) * t;
    tmp.y = p[k * 3 + 1] + (p[k2 * 3 + 1] - p[k * 3 + 1]) * t;
    tmp.a = p[k * 3 + 2] + (p[k2 * 3 + 2] - p[k * 3 + 2]) * t;
    drawLetter(vx, tmp);
  }
}
function frame(now) {
  const lvl = LEVELS[+$('speed').value];
  if (S.anim.length) {
    if (lvl.rate === 0) flushAnims();
    else {
      const keep = [];
      for (const a of S.anim) { a.i += lvl.rate; if (a.i >= a.traj.length / 3 - 1) drawLetter(curX, a.e); else keep.push(a); }
      S.anim = keep;
    }
  }
  if (S.mode === 'run') pump();
  if (S.anim.length || dirty) render();
  if (now - S.rateT > 700) {
    const n = S.L.length;
    S.rate = Math.round((n - S.rateN) / ((now - S.rateT) / 1000));
    S.rateN = n; S.rateT = now;
  }
  if ((S.fc++ & 7) === 0) updateStats();
  requestAnimationFrame(frame);
}
function msg(t) { $('s_msg').textContent = t; }
function updateStats() {
  const n = S.L.length, e = errPct(), stop = +$('stopErr').value;
  let p = 0;
  if (S.done) p = 1; else if (S.err0 - stop > 0.01) p = clamp((S.err0 - e) / (S.err0 - stop), 0, 1);
  $('hudFill').style.width = (p * 100).toFixed(1) + '%';
  $('hudPct').textContent = Math.round(p * 100) + '%';
  $('hudPlaced').textContent = n.toLocaleString('en-US') + ' placed';
  $('hud').title = `difference ${e.toFixed(1)}%  ·  dropped ${S.rejected}  ·  ${S.mode === 'run' ? S.rate : 0} letters/s`;
  $('ticker').textContent = S.placed.slice(-90);
}
function setRun(on) {
  if (S.done || !S.ready) return;
  if (S.mode === 'replay') stopReplay();
  S.mode = on ? 'run' : 'idle';
  $('stage').classList.toggle('running', on);
  setRunLabel(on ? 'Pause' : (S.L.length ? 'Resume' : 'Start'));
  msg(on ? `dropping letters (${pool.length} ${pool.length > 1 ? 'workers' : 'worker'}${poolKind === 'inline' ? ', single-thread mode' : ''})` : 'paused');
  if (on) { S.rateT = performance.now(); S.rateN = S.L.length; pump(); }
}

/* ---------- time-lapse replay ---------- */
let replayToken = 0;
function stopReplay() { replayToken++; dirty = true; if (S.mode === 'replay') S.mode = 'idle'; setRunDisabled(S.done || !S.ready); }
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function replay(record) {
  flushAnims();
  const L = S.L, N = L.length;
  if (!N) { msg('nothing to replay yet'); return; }
  if (record && !window.MediaRecorder) { msg('video recording is not supported in this browser'); return; }
  if (S.mode === 'run') setRun(false);
  const my = ++replayToken;
  S.mode = 'replay'; setRunDisabled(true);
  const T = +$('dur').value * 1000, F = 450, HOLD = 1500, P = 2.2;
  baseX.clearRect(0, 0, S.W, S.H); baseX.drawImage(bgC, 0, 0);
  let rec = null; const chunks = [];
  if (record) {
    const stream = view.captureStream(30);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m));
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
      download(new Blob(chunks, { type }), 'typographic-sediment.' + (type.includes('mp4') ? 'mp4' : 'webm'));
    };
    rec.start();
  }
  const startOf = i => T * Math.pow(i / N, 1 / P);
  let settled = 0, endAt = 0;
  const t0 = performance.now();
  msg(record ? 'recording time-lapse' : 'replaying');
  const finishReplay = () => {
    if (rec && rec.state !== 'inactive') rec.stop();
    dirty = true;
    if (my === replayToken) { S.mode = 'idle'; setRunDisabled(S.done || !S.ready); msg(S.done ? 'done' : 'paused'); }
  };
  function tick(now) {
    if (my !== replayToken) { if (rec && rec.state !== 'inactive') rec.stop(); return; }
    const t = now - t0, u = Math.min(1, t / T);
    const released = Math.min(N, Math.floor(N * Math.pow(u, P)) + 1);
    while (settled < released && startOf(settled) + F <= t) { drawLetter(baseX, L[settled]); settled++; }
    vx.clearRect(0, 0, S.W, S.H);
    vx.drawImage(baseC, 0, 0);
    for (let i = settled; i < released; i++) {
      const e = L[i], tau = clamp((t - startOf(i)) / F, 0, 1), q = tau * tau;
      tmp.ch = e.ch; tmp.font = e.font; tmp.ox = e.ox; tmp.oy = e.oy; tmp.fill = e.fill;
      tmp.x = e.sx + (e.x - e.sx) * q; tmp.y = e.sy + (e.y - e.sy) * q; tmp.a = e.a0 + (e.a - e.a0) * q;
      drawLetter(vx, tmp);
    }
    if (settled >= N) { if (!endAt) endAt = now; if (now - endAt > HOLD) { finishReplay(); return; } }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- export ---------- */
function savePng() { flushAnims(); render(); curC.toBlob(b => download(b, 'typographic-sediment.png')); }
function saveSvg() {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bgTag = S.alpha ? '' : S.bgSoft
    ? `<image width="${S.W}" height="${S.H}" href="${bgC.toDataURL('image/jpeg', 0.85)}" xlink:href="${bgC.toDataURL('image/jpeg', 0.85)}"/>`
    : `<rect width="100%" height="100%" fill="${S.bg}"/>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S.W}" height="${S.H}" viewBox="0 0 ${S.W} ${S.H}">`, bgTag];
  for (const e of S.L) {
    const fam = e.font.replace(/^bold [\d.]+px /, '').replace(/"/g, "'");
    parts.push(`<g transform="translate(${e.x.toFixed(2)} ${e.y.toFixed(2)}) rotate(${(e.a * 180 / Math.PI).toFixed(2)})">` +
      `<text x="${e.ox.toFixed(2)}" y="${e.oy.toFixed(2)}" text-anchor="middle" font-weight="bold" font-size="${e.size}" font-family="${fam}" fill="${e.fill}">${esc(e.ch)}</text></g>`);
  }
  parts.push('</svg>');
  download(new Blob([parts.join('\n')], { type: 'image/svg+xml' }), 'typographic-sediment.svg');
}

/* ---------- wiring ---------- */
const bindOut = (id, out, fmt) => {
  const el = $(id), o = $(out);
  const f = () => { o.textContent = fmt(el.value); el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); };
  el.addEventListener('input', f); f();
};
const d2 = v => (v / 100).toFixed(2);
bindOut('maxS', 'o_max', d2); bindOut('minS', 'o_min', v => v + ' px');
bindOut('chaos', 'o_chaos', d2); bindOut('strict', 'o_strict', d2); bindOut('tries', 'o_tries', v => v);
bindOut('overlap', 'o_ov', d2); bindOut('stopErr', 'o_stop', v => +v ? v + '%' : 'never'); bindOut('cap', 'o_cap', v => (+v).toLocaleString('en-US'));
bindOut('speed', 'o_speed', v => LEVELS[+v].label); bindOut('dur', 'o_dur', v => v + ' s');

(() => {
  const sel = $('workers'), cores = navigator.hardwareConcurrency || 4;
  sel.innerHTML = `<option value="auto">Auto (${Math.max(1, Math.min(8, cores - 1))})</option>` +
    [1, 2, 3, 4, 6, 8, 12].map(n => `<option value="${n}">${n}</option>`).join('');
})();

// visual pickers drive the hidden selects, so the rest of the code keeps reading select values
document.querySelectorAll('.pick').forEach(pk => {
  const sel = $(pk.dataset.for), btns = [...pk.querySelectorAll('button')];
  const name = document.querySelector(`[data-name-for="${pk.dataset.for}"]`);
  let ind = null;
  if (pk.classList.contains('seg')) { ind = document.createElement('i'); ind.className = 'seg-ind'; pk.prepend(ind); }
  const sync = () => {
    btns.forEach(b => { const on = b.dataset.v === sel.value; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
      if (on && ind) { ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft}px)`; } });
    if (name) name.textContent = sel.options[sel.selectedIndex].text;
  };
  const choose = b => { if (sel.value === b.dataset.v) return; sel.value = b.dataset.v; sel.dispatchEvent(new Event('change')); sync(); };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => choose(b));
    b.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return; e.preventDefault(); const nb = btns[(i + d + btns.length) % btns.length]; choose(nb); nb.focus();
    });
  });
  sel.addEventListener('change', sync);
  sync();
  if (ind) { requestAnimationFrame(sync); if (document.fonts) document.fonts.ready.then(sync); }
});

for (const id of ['bg', 'maxS', 'minS']) $(id).addEventListener('change', () => S.src && applySource());
// at 2K/4K the canvas is shown shrunk, the falling animation is barely visible and it throttles the engine,
// so switch to instant placement unless the speed was set by hand
let speedTouched = false;
$('speed').addEventListener('input', e => { if (e.isTrusted) speedTouched = true; });
$('res').addEventListener('change', () => {
  if (!S.src) return;
  if (!speedTouched) { const sp = $('speed'); sp.value = +$('res').value >= 2000 ? 7 : 4; sp.dispatchEvent(new Event('input')); }
  if (wantedWorkers() === pool.length) { applySource(); return; }
  S.ready = false; setRunDisabled(true); msg('starting workers');
  createPool(wantedWorkers()).then(() => applySource());
});
$('workers').addEventListener('change', () => { S.ready = false; setRunDisabled(true); msg('starting workers'); createPool(wantedWorkers()).then(() => reset()); });
$('btnRun').onclick = () => setRun(S.mode !== 'run');
$('btnReset').onclick = () => { stopReplay(); reset(); };
$('btnLoad').onclick = () => $('file').click();
$('file').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
const SAMPLE_NAMES = { sunset: 'Sunset', moon: 'Moon', waves: 'Waves' };
document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => {
  const v = b.dataset.sample; stopReplay(); setSource(makeSample(v), 800, 600, SAMPLE_NAMES[v]);
}));
$('btnClear').onclick = () => { stopReplay(); setSource(makeSample('sunset'), 800, 600, 'Sunset'); };
$('btnReplay').onclick = () => replay(false);
$('btnRecord').onclick = () => replay(true);
$('btnPng').onclick = savePng; $('btnSvg').onclick = saveSvg;
const inStudio = () => document.documentElement.classList.contains('entered');
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && inStudio() && !/TEXTAREA|SELECT|INPUT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); $('btnRun').click(); }
});
const app = $('app');
window.addEventListener('dragover', e => { e.preventDefault(); if (inStudio()) app.classList.add('drop-on'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) app.classList.remove('drop-on'); });
window.addEventListener('drop', e => { e.preventDefault(); app.classList.remove('drop-on'); if (!inStudio()) return; stopReplay(); loadFile(e.dataTransfer.files[0]); });

function fitView() {
  const area = $('stageCanvas');
  if (!area || !S.W) return;
  const aw = area.clientWidth, ah = area.clientHeight - 26;   // room for the caption
  const sc = Math.min(aw / S.W, ah / S.H);
  view.style.width = Math.max(120, Math.floor(S.W * Math.min(sc, 2))) + 'px';
}
new ResizeObserver(fitView).observe($('stageCanvas'));
const _apply = applySource;
applySource = function () {
  _apply(); fitView();
  const lab = document.createElement('i'); lab.textContent = 'Plate I.';
  $('capName').replaceChildren(lab, ' ' + (S.src.name || 'Untitled'));
  $('capDims').textContent = S.W + ' × ' + S.H + (S.alpha ? ' · transparent' : '');
};

/* ---------- chrome: navigation, menus ---------- */
const sheets = { explore: $('sheet-explore'), about: $('sheet-about') };
function showView(v) {
  for (const k in sheets) sheets[k].classList.toggle('open', k === v);
  document.querySelectorAll('.nav').forEach(b => b.setAttribute('aria-current', b.dataset.view === v ? 'page' : 'false'));
  $('exportMenu').classList.remove('open');
}
document.querySelectorAll('.nav').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
window.addEventListener('keydown', e => { if (e.key === 'Escape') showView('create'); });

$('btnExport').onclick = e => { e.stopPropagation(); $('exportMenu').classList.toggle('open'); };
document.addEventListener('click', e => { if (!e.target.closest('#exportMenu')) $('exportMenu').classList.remove('open'); });
if (!document.fullscreenEnabled) { $('btnFull').style.display = 'none'; $('stage').classList.add('no-fs'); }
$('btnFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else $('stage').requestFullscreen(); };
$('hudPause').onclick = () => $('btnRun').click();

const countChars = () => { const n = $('text').value.length; $('charCount').textContent = n.toLocaleString('en-US') + (n === 1 ? ' character' : ' characters'); };
$('text').addEventListener('input', countChars); countChars();
$('btnShuffle').onclick = () => {
  // shuffle the words but keep the shape of the lines
  const lines = $('text').value.split('\n').map(l => l.split(/\s+/).filter(Boolean));
  const w = lines.flat();
  for (let i = w.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [w[i], w[j]] = [w[j], w[i]]; }
  let k = 0;
  $('text').value = lines.map(l => l.map(() => w[k++]).join(' ')).join('\n'); countChars();
};

const PRESETS = {
  portrait: { chaos: 25, strict: 35, maxS: 22, overlap: 10, minS: 5, tries: 24 },
  rain:     { chaos: 90, strict: 20, maxS: 50, overlap: 0,  minS: 7, tries: 10 },
  large:    { chaos: 55, strict: 50, maxS: 75, overlap: 0,  minS: 12, tries: 14 },
  paint:    { chaos: 35, strict: 25, maxS: 40, overlap: 45, minS: 6, tries: 20 }
};
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = PRESETS[b.dataset.preset];
  for (const k in p) { const el = $(k); el.value = p[k]; el.dispatchEvent(new Event('input')); }
  showView('create'); stopReplay(); reset();
}));

/* ---------- hooks for the preface ---------- */
let readyFns = [];
const _reset = reset;
reset = function () { _reset(); if (S.ready) { const f = readyFns; readyFns = []; f.forEach(fn => fn()); } };
window.Sediment = {
  makeSample,
  view,
  fit: fitView,
  showView,
  // start the picture the first time someone arrives, unless they already started one
  autostart() {
    const go = () => { if (!S.done && S.mode === 'idle' && !S.L.length) setRun(true); };
    if (S.ready) go(); else readyFns.push(go);
  }
};
window.__sediment = { S, pool: () => pool, kind: () => poolKind };   // handy for debugging in the console
msg('starting workers');
setSource(makeSample('sunset'), 800, 600, 'Sunset');
createPool(wantedWorkers()).then(() => reset());
requestAnimationFrame(frame);
})();
