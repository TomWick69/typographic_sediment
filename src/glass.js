/* ======================================================================
   Liquid-glass theme switch.
   The knob is a soft bag of glass: a damped spring carries it along the
   track, the liquid inside lags behind every acceleration (slosh), it
   stretches with speed, flattens against the end of the track and wobbles
   back. A WebGL shader refracts and magnifies whatever lies underneath it.
   ====================================================================== */
(() => {
'use strict';
const btn = document.getElementById('themeToggle'), cv = document.getElementById('glassCanvas');
const root = document.documentElement;
const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

// geometry in CSS pixels
const CW = 112, CH = 64, TW = 80, TH = 30;
const TX = (CW - TW) / 2, TY = (CH - TH) / 2, CY = CH / 2;
const R = 17.5;                                  // knob radius, a little taller than the track
const XL = TX + TH / 2, XR = TX + TW - TH / 2, MID = (XL + XR) / 2;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const mixc = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const rgba = c => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(3)})`;
const smooth = t => t * t * (3 - 2 * t);

let dpr = 1;
const content = document.createElement('canvas'), cx = content.getContext('2d');
const icon = document.createElement('canvas'), ix = icon.getContext('2d');

/* ---------- physics state ---------- */
const isDark = () => root.dataset.theme !== 'light';
const P = {
  x: isDark() ? XR : XL, v: 0, target: isDark() ? XR : XL,
  s: 0, sv: 0,        // slosh: how far the liquid's middle lags, as a fraction of R
  b: 0, bv: 0,        // breathing: + is wider and flatter, - is narrower and taller
  w: 0, wv: 0, wph: 0, // three-lobed wobble after an impact
  g: 1, gv: 0,        // overall scale (hover and press swell it)
  pressed: false, drag: false, hover: false, wasIn: false, lastA: 0
};

function step(dt) {
  const k = P.drag ? 1500 : 430, c = 2 * Math.sqrt(k) * (P.drag ? 0.85 : 0.5);
  let a = k * (P.target - P.x) - c * P.v;
  // the ends of the track are stiff but springy walls
  const pen = P.x > XR ? P.x - XR : (P.x < XL ? P.x - XL : 0);
  if (pen) {
    a += -7000 * pen - 30 * P.v;
    if (!P.wasIn) { P.wv += Math.min(Math.abs(P.v), 900) * 0.0011; P.wph = pen > 0 ? Math.PI : 0; P.bv -= Math.min(Math.abs(P.v), 900) * 0.0045; }
  }
  P.wasIn = !!pen;
  P.v += a * dt; P.x += P.v * dt;
  // the liquid lags behind acceleration, overshoots, and sloshes back and forth
  const ks = 300, sa = -ks * P.s - 2 * Math.sqrt(ks) * 0.14 * P.sv - a * 0.0055;
  P.sv += sa * dt; P.s += P.sv * dt;
  // stretch with speed, flatten against a wall, squash a little when pressed
  const bt = clamp(Math.abs(P.v) / 1100, 0, 0.26) - Math.abs(pen) / R * 0.9 + (P.pressed ? 0.07 : 0);
  const kb = 520, ba = kb * (bt - P.b) - 2 * Math.sqrt(kb) * 0.16 * P.bv;
  P.bv += ba * dt; P.b += P.bv * dt;
  const kw = 1100, wa = -kw * P.w - 2 * Math.sqrt(kw) * 0.12 * P.wv + P.sv * 0.04;
  P.wv += wa * dt; P.w += P.wv * dt;
  const gt = 1 + (P.hover ? 0.04 : 0) + (P.pressed ? 0.1 : 0), kg = 600, ga = kg * (gt - P.g) - 2 * Math.sqrt(kg) * 0.35 * P.gv;
  P.gv += ga * dt; P.g += P.gv * dt;
  P.lastA = a;
  // the theme follows the bag across the middle of the track
  const dark = P.x > MID;
  if (dark !== isDark()) setTheme(dark ? 'dark' : 'light');
}
function settled() {
  const gt = 1 + (P.hover ? 0.04 : 0) + (P.pressed ? 0.1 : 0);
  return !P.pressed && Math.abs(P.v) < 0.5 && Math.abs(P.x - P.target) < 0.05 && Math.abs(P.s) + Math.abs(P.sv) * 0.05 < 0.002 &&
    Math.abs(P.b) + Math.abs(P.bv) * 0.05 < 0.002 && Math.abs(P.w) + Math.abs(P.wv) * 0.05 < 0.002 && Math.abs(P.g - gt) + Math.abs(P.gv) * 0.05 < 0.001;
}
function snapToRest() {
  P.x = P.target; P.v = P.s = P.sv = P.b = P.bv = P.w = P.wv = P.gv = 0;
  P.g = 1 + (P.hover ? 0.04 : 0);
}

function setTheme(t) {
  root.dataset.theme = t;
  try { localStorage.setItem('ts-theme', t); } catch (e) {}
  btn.setAttribute('aria-checked', t === 'dark');
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = t === 'dark' ? '#0b0b0c' : '#f3f0e9';
}

/* ---------- what lies under the glass: track, labels, sun/moon ---------- */
const COL = {
  track: [[27, 26, 23, .075], [255, 255, 255, .055]],
  inset: [[60, 45, 25, .22], [0, 0, 0, .75]],
  lip:   [[255, 255, 255, .95], [255, 255, 255, .07]],
  label: [[106, 101, 92, 1], [143, 138, 130, 1]],
  disc:  [[255, 255, 255, 1], [26, 26, 29, 1]],
  icon:  [[27, 26, 23, 1], [234, 214, 195, 1]]
};
const col = (k, m) => rgba(mixc(COL[k][0], COL[k][1], m));
const pillPath = (c, x, y, w, h) => { const r = h / 2; c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
const pill = (c, x, y, w, h) => { c.beginPath(); pillPath(c, x, y, w, h); };
const FONT = '500 11.5px "Figtree", system-ui, -apple-system, "Segoe UI", sans-serif';

function drawIcon(u, m) {
  const S = 32;
  ix.setTransform(dpr, 0, 0, dpr, 0, 0);
  ix.clearRect(0, 0, S, S);
  const e = smooth(clamp(u, 0, 1));
  ix.save();
  ix.translate(S / 2, S / 2); ix.rotate(-e * Math.PI * 0.5);
  ix.strokeStyle = ix.fillStyle = col('icon', m);
  ix.lineCap = 'round'; ix.lineWidth = 1.5;
  const rc = mix(3.5, 6.1, e), ray = (1 - e) * 2.3;
  if (ray > 0.05) for (let i = 0; i < 8; i++) {
    const an = i * Math.PI / 4, r0 = 5.6 + e * 2;
    ix.beginPath(); ix.moveTo(Math.cos(an) * r0, Math.sin(an) * r0); ix.lineTo(Math.cos(an) * (r0 + ray), Math.sin(an) * (r0 + ray)); ix.stroke();
  }
  ix.beginPath(); ix.arc(0, 0, rc, 0, Math.PI * 2); ix.fill();
  ix.globalCompositeOperation = 'destination-out';
  ix.beginPath(); ix.arc(mix(rc * 2.3, rc * 0.62, e), mix(-rc * 2.3, -rc * 0.5, e), rc * 0.86, 0, Math.PI * 2); ix.fill();
  ix.restore();
}

function drawContent(kx, u) {
  const m = clamp(u, 0, 1);
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, CW, CH);
  // track with a soft inset shadow and a bright lower lip
  pill(cx, TX, TY, TW, TH); cx.fillStyle = col('track', m); cx.fill();
  cx.save();
  pill(cx, TX, TY, TW, TH); cx.clip();
  cx.beginPath(); cx.rect(TX - 40, TY - 40, TW + 80, TH + 80); pillPath(cx, TX, TY, TW, TH);
  cx.shadowColor = col('inset', m); cx.shadowBlur = 5; cx.shadowOffsetY = 1.5;
  cx.fillStyle = '#000'; cx.fill('evenodd');
  cx.restore();
  cx.save();
  pill(cx, TX + .5, TY + .5, TW - 1, TH - 1); cx.clip();
  pill(cx, TX - .5, TY - 1.5, TW + 1, TH + 1); cx.lineWidth = 1; cx.strokeStyle = col('lip', m); cx.stroke();
  cx.restore();
  // labels trade places as the bag crosses
  cx.font = FONT; cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillStyle = col('label', m);
  const aL = clamp(1 - m * 1.8, 0, 1), aD = clamp((m - 0.45) * 1.8, 0, 1);
  if (aL > 0) { cx.globalAlpha = aL; cx.fillText('Light', mix(XL + R + (TX + TW - XL - R) / 2 - 1, XR + 6, smooth(m) * 0.35), CY + .5); }
  if (aD > 0) { cx.globalAlpha = aD; cx.fillText('Dark', mix(XL - 6, TX + (XR - R - TX) / 2 + 1, 0.65 + smooth(m) * 0.35), CY + .5); }
  cx.globalAlpha = 1;
  // the dish under the icon, and the icon itself
  cx.beginPath(); cx.arc(kx, CY, 10, 0, Math.PI * 2);
  cx.fillStyle = col('disc', m);
  cx.shadowColor = `rgba(0,0,0,${mix(.12, .5, m)})`; cx.shadowBlur = 4; cx.shadowOffsetY = 1;
  cx.fill(); cx.shadowColor = 'transparent';
  drawIcon(u, m);
  cx.save();
  if (m > 0.5) { cx.shadowColor = `rgba(234,214,195,${((m - .5) * 1.1).toFixed(3)})`; cx.shadowBlur = 8; }
  cx.drawImage(icon, kx - 16, CY - 16, 32, 32);
  cx.restore();
}

/* ---------- glass: WebGL ---------- */
const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const FS = `precision highp float;
uniform sampler2D uTex; uniform vec2 uRes; uniform float uDpr;
uniform vec2 uC; uniform float uR; uniform vec2 uS; uniform float uSlosh; uniform float uW3; uniform float uPh; uniform float uDark;
float sdf(vec2 p){
  vec2 q = p / uS;
  float yy = clamp(q.y / uR, -1.0, 1.0);
  q.x -= uSlosh * uR * (1.0 - yy * yy);
  float r = uR * (1.0 + uW3 * cos(3.0 * atan(q.y, q.x) + uPh));
  vec2 a = abs(q) / r;
  float l = pow(pow(a.x, 2.35) + pow(a.y, 2.35), 1.0 / 2.35);
  return (l - 1.0) * r * min(uS.x, uS.y);
}
vec4 tex(vec2 p){
  vec2 uv = p * uDpr / uRes; uv.y = 1.0 - uv.y;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture2D(uTex, uv);
}
void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 p = px - uC;
  float d = sdf(p);
  vec4 base = tex(px);
  float ds = sdf((p - vec2(0.0, uR * 0.24)) / 1.04);
  float shA = (1.0 - smoothstep(-uR * 0.45, uR * 0.6, ds)) * mix(0.13, 0.42, uDark);
  vec4 outside = base + vec4(0.0, 0.0, 0.0, shA) * (1.0 - base.a);
  if (d > 1.0) { gl_FragColor = outside; return; }
  vec2 e = vec2(0.5, 0.0);
  vec2 n = normalize(vec2(sdf(p + e.xy) - sdf(p - e.xy), sdf(p + e.yx) - sdf(p - e.yx)) + 1e-6);
  float depth = clamp(-d / (uR * 0.6), 0.0, 1.0);
  float rim = pow(1.0 - depth, 2.4);
  // refraction: magnify the middle, bend hard at the rim, split the colours a touch
  vec2 off = -n * rim * uR * 0.5;
  vec2 sp = uC + p * 0.86 + off;
  vec4 cR = tex(sp + off * 0.09), cG = tex(sp), cB = tex(sp - off * 0.09);
  vec4 refr = vec4(cR.r, cG.g, cB.b, max(cG.a, max(cR.a, cB.a)));
  vec3 tint = mix(vec3(1.0), vec3(0.66, 0.69, 0.76), uDark);
  float bodyA = mix(0.18, 0.06, uDark) + rim * mix(0.16, 0.09, uDark);
  vec4 glass = refr * (1.0 - bodyA) + vec4(tint * bodyA, bodyA);
  vec2 L = normalize(vec2(-0.5, -0.86));
  float ndl = dot(n, L);
  float band = exp(-pow((d + 1.5) / 1.25, 2.0));
  float spec = band * (0.35 + 0.65 * max(ndl, 0.0)) + band * 0.55 * max(-ndl, 0.0);
  float sheen = rim * max(ndl, 0.0) * 0.32 + pow(max(-ndl, 0.0), 3.0) * rim * 0.25;
  float hA = clamp(spec * mix(0.95, 0.7, uDark) + sheen * mix(1.0, 0.55, uDark), 0.0, 1.0);
  glass = glass * (1.0 - hA) + vec4(vec3(hA), hA);
  float eA = exp(-pow((d + 0.25) / 0.7, 2.0)) * mix(0.22, 0.30, uDark);
  glass = glass * (1.0 - eA) + vec4(mix(vec3(0.0), vec3(0.85), uDark) * eA, eA);
  gl_FragColor = mix(outside, glass, smoothstep(0.8, -0.8, d));
}`;
let gl = null, prog = null, U = {}, texObj = null;
function initGL() {
  try {
    gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return false;
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uTex', 'uRes', 'uDpr', 'uC', 'uR', 'uS', 'uSlosh', 'uW3', 'uPh', 'uDark']) U[n] = gl.getUniformLocation(prog, n);
    texObj = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texObj);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.uniform1i(U.uTex, 0);
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); gl = null; ctx2d = cv.getContext('2d'); kick(); });
    return true;
  } catch (err) { console.warn('glass switch: falling back to 2D', err); gl = null; return false; }
}
let ctx2d = null;

function pose() {
  const sx = P.g * (1 + P.b), sy = P.g / (1 + P.b);
  return { sx, sy, sl: Math.tanh(P.s / 0.24) * 0.24, w3: clamp(P.w, -0.09, 0.09) };
}
function draw() {
  const u = (P.x - XL) / (XR - XL), o = pose();
  drawContent(P.x, u);
  if (gl) {
    gl.viewport(0, 0, cv.width, cv.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, content);
    gl.uniform2f(U.uRes, cv.width, cv.height); gl.uniform1f(U.uDpr, dpr);
    gl.uniform2f(U.uC, P.x, CY); gl.uniform1f(U.uR, R);
    gl.uniform2f(U.uS, o.sx, o.sy); gl.uniform1f(U.uSlosh, o.sl);
    gl.uniform1f(U.uW3, o.w3); gl.uniform1f(U.uPh, P.wph); gl.uniform1f(U.uDark, clamp(u, 0, 1));
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  } else drawFallback(u, o);
}
// without WebGL: magnify the content inside an ellipse and paint the highlights
function drawFallback(u, o) {
  const c = ctx2d, m = clamp(u, 0, 1);
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(content, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rx = R * o.sx, ry = R * o.sy, kx = P.x + o.sl * R * 0.5;
  c.save();
  c.beginPath(); c.ellipse(kx, CY + R * 0.25, rx, ry, 0, 0, Math.PI * 2); c.fillStyle = `rgba(0,0,0,${mix(.08, .3, m)})`; c.filter = 'blur(4px)'; c.fill(); c.filter = 'none';
  c.beginPath(); c.ellipse(kx, CY, rx, ry, 0, 0, Math.PI * 2); c.clip();
  c.clearRect(0, 0, CW, CH);
  c.translate(P.x, CY); c.scale(1.22, 1.22); c.translate(-P.x, -CY);
  c.drawImage(content, 0, 0, CW, CH);
  c.restore();
  c.save();
  c.beginPath(); c.ellipse(kx, CY, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = `rgba(255,255,255,${mix(.16, .06, m)})`; c.fill();
  const gr = c.createLinearGradient(kx - rx, CY - ry, kx + rx, CY + ry);
  gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(.5, 'rgba(255,255,255,.1)'); gr.addColorStop(1, 'rgba(255,255,255,.6)');
  c.lineWidth = 1.3; c.strokeStyle = gr; c.stroke();
  c.restore();
}

/* ---------- loop ---------- */
let raf = 0, last = 0;
function frame(now) {
  raf = 0;
  let dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
  if (reduce) snapToRest();
  else { const n = Math.ceil(dt / (1 / 240)); for (let i = 0; i < n; i++) step(dt / n); }
  const done = settled();
  if (done) snapToRest();
  draw();
  if (!done) raf = requestAnimationFrame(frame);
}
function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

/* ---------- input: click, drag, keyboard ---------- */
const local = e => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) * CW / r.width; };
let downX = 0, grab = 0, pid = null;
btn.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  pid = e.pointerId; btn.setPointerCapture(pid);
  P.pressed = true; downX = e.clientX;
  const lx = local(e);
  grab = Math.abs(lx - P.x) < R * 1.2 ? lx - P.x : 0;
  kick();
});
btn.addEventListener('pointermove', e => {
  if (!P.pressed || e.pointerId !== pid) return;
  if (!P.drag && Math.abs(e.clientX - downX) > 3) P.drag = true;
  if (P.drag) { P.target = clamp(local(e) - grab, XL - 14, XR + 14); kick(); }
});
const release = e => {
  if (!P.pressed || (e && e.pointerId !== pid)) return;
  P.pressed = false;
  if (P.drag) P.target = P.x + P.v * 0.06 > MID ? XR : XL;     // a flick carries it over
  else P.target = P.target > MID ? XL : XR;
  P.drag = false; pid = null; kick();
};
btn.addEventListener('pointerup', release);
btn.addEventListener('pointercancel', e => { if (P.pressed) { P.pressed = false; P.drag = false; P.target = P.x > MID ? XR : XL; kick(); } });
btn.addEventListener('click', e => { if (e.detail === 0) { P.target = P.target > MID ? XL : XR; kick(); } });   // keyboard
btn.addEventListener('pointerenter', () => { P.hover = true; kick(); });
btn.addEventListener('pointerleave', () => { P.hover = false; kick(); });

/* ---------- sizing ---------- */
function resize() {
  dpr = Math.min(3, window.devicePixelRatio || 1);
  for (const c of [cv, content]) { c.width = Math.round(CW * dpr); c.height = Math.round(CH * dpr); }
  icon.width = icon.height = Math.round(32 * dpr);
  if (!gl && !ctx2d && !initGL()) ctx2d = cv.getContext('2d');
  draw();
}
resize();
setTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
window.addEventListener('resize', () => { if (Math.min(3, window.devicePixelRatio || 1) !== dpr) resize(); });
if (document.fonts) document.fonts.ready.then(draw);
window.GlassToggle = { P, kick, draw, step, XL, XR };   // for poking at it from the console
})();
