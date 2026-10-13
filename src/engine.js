/* ======================================================================
   Worker engine. This function is stringified and run inside Web Workers
   (or directly on the main thread as a fallback), so it must not refer to
   anything outside itself except its three arguments.
   Each worker keeps a full replica of the picture and of every kept letter,
   searches for good placements, runs the physics, and reports the result.
   ====================================================================== */
function workerMain(self, Matter, mkCanvas) {
  var Engine = Matter.Engine, Bodies = Matter.Bodies, Body = Matter.Body, Composite = Matter.Composite;
  var WT0 = 1.0, WT1 = 1.5, WT2 = 0.5;     // channel weights (sum = 3)
  var WTA = 1.0;                           // alpha weight; colours are premultiplied, so on an opaque canvas alpha never differs

  var ASTEP = 0.1, HS = 48;
  var W = 0, H = 0, tgt = null, cur = null, epoch = 0;
  var L = [], hash = new Map(), engine = null, inWorld = [];
  var glyphCache = new Map();
  var scratch = null, sctx = null, sw = 0, sh = 0;
  var EV = { gain: 0, r: 0, g: 0, b: 0 };
  var cmode = 0;   // 0 image colours, 1 grayscale, 2 warm tone
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function ensureScratch(w, h) {
    if (!scratch || sw < w || sh < h) {
      sw = Math.max(sw, w, 64); sh = Math.max(sh, h, 64);
      scratch = mkCanvas(sw, sh);
      sctx = scratch.getContext('2d', { willReadFrequently: true });
    }
  }

  function glyphInfo(ch, font) {
    var key = font + '|' + ch, g = glyphCache.get(key);
    if (g) return g;
    ensureScratch(8, 8);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.font = font;
    var m = sctx.measureText(ch);
    var left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight, asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
    g = { ch: ch, font: font, gw: Math.max(1, left + right), gh: Math.max(1, asc + desc),
          ox: (left - right) / 2, oy: (asc - desc) / 2, masks: new Map(), hull: undefined };
    if (glyphCache.size > 6000) glyphCache.clear();
    glyphCache.set(key, g);
    return g;
  }

  // alpha mask of a glyph rotated by bi*ASTEP, origin at integer pixel anchor (ax, ay)
  function bucket(g, bi) {
    var m = g.masks.get(bi);
    if (m) return m;
    var a = bi * ASTEP, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    var hx = (g.gw / 2 + 2) * cs + (g.gh / 2 + 2) * sn, hy = (g.gw / 2 + 2) * sn + (g.gh / 2 + 2) * cs;
    var ax = Math.ceil(hx) + 1, ay = Math.ceil(hy) + 1, mw = 2 * ax, mh = 2 * ay;
    ensureScratch(mw, mh);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, mw, mh);
    sctx.translate(ax, ay); sctx.rotate(a);
    sctx.font = g.font; sctx.textAlign = 'center'; sctx.textBaseline = 'alphabetic'; sctx.fillStyle = '#fff';
    sctx.fillText(g.ch, g.ox, g.oy);
    var d = sctx.getImageData(0, 0, mw, mh).data;
    var ii = [], jj = [], aa = [], sumA = 0;
    for (var j = 0; j < mh; j++) for (var i = 0; i < mw; i++) {
      var al = d[(j * mw + i) * 4 + 3];
      if (al >= 6) { ii.push(i); jj.push(j); aa.push(al / 255); sumA += al / 255; }
    }
    m = { ax: ax, ay: ay, hx: hx, hy: hy, n: ii.length, ii: Int16Array.from(ii), jj: Int16Array.from(jj), aa: Float32Array.from(aa), sumA: sumA };
    g.masks.set(bi, m);
    return m;
  }

  function convexHull(P) {
    var seen = new Set(), Q = [];
    for (var i = 0; i < P.length; i++) { var k = P[i][0] + ',' + P[i][1]; if (!seen.has(k)) { seen.add(k); Q.push(P[i]); } }
    Q.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], p, n;
    for (n = 0; n < Q.length; n++) { p = Q[n]; while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (n = Q.length - 1; n >= 0; n--) { p = Q[n]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  function polyArea(h) { var A = 0; for (var i = 0; i < h.length; i++) { var p = h[i], q = h[(i + 1) % h.length]; A += p[0] * q[1] - q[0] * p[1]; } return A / 2; }

  // convex hull of the glyph (relative to glyph origin), used as the collision shape
  function getHull(g, size) {
    if (g.hull !== undefined) return g.hull;
    g.hull = null;
    var m = bucket(g, 0), rowMin = new Map(), rowMax = new Map(), k;
    for (k = 0; k < m.n; k++) {
      if (m.aa[k] < 0.25) continue;
      var j = m.jj[k], i = m.ii[k], lo = rowMin.get(j), hi = rowMax.get(j);
      if (lo === undefined || i < lo) rowMin.set(j, i);
      if (hi === undefined || i > hi) rowMax.set(j, i);
    }
    var P = [];
    rowMin.forEach(function (lo, j) {
      var hi = rowMax.get(j);
      P.push([lo - m.ax, j - m.ay], [lo - m.ax, j + 1 - m.ay], [hi + 1 - m.ax, j - m.ay], [hi + 1 - m.ax, j + 1 - m.ay]);
    });
    if (P.length < 3) return null;
    var hull = convexHull(P);
    if (hull.length < 3) return null;
    if (polyArea(hull) < 0) hull.reverse();
    while (hull.length > 12) {
      var bi = 0, ba = Infinity, n = hull.length;
      for (var q = 0; q < n; q++) {
        var a = hull[(q + n - 1) % n], b = hull[q], c = hull[(q + 1) % n];
        var ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
        if (ar < ba) { ba = ar; bi = q; }
      }
      hull.splice(bi, 1);
    }
    var A = polyArea(hull), cx = 0, cy = 0;
    for (var t = 0; t < hull.length; t++) {
      var p0 = hull[t], p1 = hull[(t + 1) % hull.length], cr = p0[0] * p1[1] - p1[0] * p0[1];
      cx += (p0[0] + p1[0]) * cr; cy += (p0[1] + p1[1]) * cr;
    }
    cx /= 6 * A; cy /= 6 * A;
    var xs = hull.map(function (p) { return p[0]; }), ys = hull.map(function (p) { return p[1]; });
    var w = Math.max.apply(null, xs) - Math.min.apply(null, xs), h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    if (Math.abs(A) < 8 || Math.min(w, h) < 0.2 * size) return null;
    g.hull = { pts: hull, cx: cx, cy: cy };
    return g.hull;
  }

  function makeBody(sh, bx, by, ang, isStatic) {
    var opt = { friction: 0.6, frictionStatic: 0.8, restitution: 0.1, frictionAir: 0.02, density: 0.002, slop: 0.02, isStatic: !!isStatic };
    var b;
    if (sh.t === 'h') {
      opt.position = { x: bx, y: by };
      opt.vertices = sh.pts.map(function (p) { return { x: p[0] - sh.cx, y: p[1] - sh.cy }; });
      b = Body.create(opt);
    } else {
      b = Bodies.rectangle(bx, by, sh.bw, sh.bh, opt);
    }
    if (ang) Body.setAngle(b, ang);
    return b;
  }

  function hashAdd(i, b) {
    var bd = b.bounds;
    for (var gx = Math.floor(bd.min.x / HS); gx <= Math.floor(bd.max.x / HS); gx++)
      for (var gy = Math.floor(bd.min.y / HS); gy <= Math.floor(bd.max.y / HS); gy++) {
        var k = (gx + 4) * 8192 + (gy + 4), a = hash.get(k);
        if (!a) hash.set(k, a = []);
        a.push(i);
      }
  }
  function hashQuery(x0, y0, x1, y1) {
    var out = new Set();
    for (var gx = Math.floor(x0 / HS); gx <= Math.floor(x1 / HS); gx++)
      for (var gy = Math.floor(y0 / HS); gy <= Math.floor(y1 / HS); gy++) {
        var a = hash.get((gx + 4) * 8192 + (gy + 4));
        if (a) for (var k = 0; k < a.length; k++) out.add(a[k]);
      }
    return out;
  }

  function isFree(x0, y0, x1, y1) {
    var free = true;
    hashQuery(x0, y0, x1, y1).forEach(function (i) {
      var b = L[i].body.bounds;
      if (b.max.x > x0 && b.min.x < x1 && b.max.y > y0 && b.min.y < y1) free = false;
    });
    return free;
  }

  // best solid colour for a glyph with coverage a over old pixels, by least squares, then the weighted error gain
  function evalAt(bm, X, Y) {
    var x0 = X - bm.ax, y0 = Y - bm.ay, ii = bm.ii, jj = bm.jj, aa = bm.aa, n = bm.n;
    var sr = 0, sg = 0, sb = 0, saa = 0, k, px, py, a, ia, ti;
    for (k = 0; k < n; k++) {
      px = x0 + ii[k]; py = y0 + jj[k];
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      a = aa[k]; ia = 1 - a; ti = (py * W + px) * 4;
      sr += a * (tgt[ti] - cur[ti] * ia); sg += a * (tgt[ti + 1] - cur[ti + 1] * ia); sb += a * (tgt[ti + 2] - cur[ti + 2] * ia); saa += a * a;
    }
    if (saa < 1e-6) { EV.gain = 0; return EV; }
    var cr = clamp(sr / saa, 0, 255), cg = clamp(sg / saa, 0, 255), cb = clamp(sb / saa, 0, 255), gain = 0;
    if (cmode) { var lm = 0.299 * cr + 0.587 * cg + 0.114 * cb; if (cmode === 1) { cr = cg = cb = lm; } else { var wsc = lm / 232.3; cr = Math.min(255, 255 * wsc); cg = Math.min(255, 226 * wsc); cb = Math.min(255, 205 * wsc); } }
    for (k = 0; k < n; k++) {
      px = x0 + ii[k]; py = y0 + jj[k];
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      a = aa[k]; ia = 1 - a; ti = (py * W + px) * 4;
      var o0 = cur[ti], o1 = cur[ti + 1], o2 = cur[ti + 2];
      var d0 = o0 - tgt[ti], d1 = o1 - tgt[ti + 1], d2 = o2 - tgt[ti + 2];
      var e0 = o0 * ia + cr * a - tgt[ti], e1 = o1 * ia + cg * a - tgt[ti + 1], e2 = o2 * ia + cb * a - tgt[ti + 2];
      var oA = cur[ti + 3], dA = oA - tgt[ti + 3], eA = oA + (255 - oA) * a - tgt[ti + 3];
      gain += WT0 * (d0 * d0 - e0 * e0) + WT1 * (d1 * d1 - e1 * e1) + WT2 * (d2 * d2 - e2 * e2) + WTA * (dA * dA - eA * eA);
    }
    EV.gain = gain; EV.r = cr; EV.g = cg; EV.b = cb;
    return EV;
  }

  function renderMask(g, fx, fy, fa, rx, ry, rw, rh) {
    ensureScratch(rw, rh);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, rw, rh);
    sctx.translate(fx - rx, fy - ry); sctx.rotate(fa);
    sctx.font = g.font; sctx.textAlign = 'center'; sctx.textBaseline = 'alphabetic'; sctx.fillStyle = '#fff';
    sctx.fillText(g.ch, g.ox, g.oy);
    var d = sctx.getImageData(0, 0, rw, rh).data, mask = new Uint8Array(rw * rh), sumA = 0;
    for (var k = 0, p = 3; k < mask.length; k++, p += 4) { var a = d[p]; if (a >= 6) { mask[k] = a; sumA += a; } }
    return { mask: mask, sumA: sumA / 255 };
  }

  function evalMask(mask, rx, ry, rw, rh) {
    var sr = 0, sg = 0, sb = 0, saa = 0, i, j, a, ia, ti;
    for (j = 0; j < rh; j++) for (i = 0; i < rw; i++) {
      var a8 = mask[j * rw + i]; if (!a8) continue;
      a = a8 / 255; ia = 1 - a; ti = ((ry + j) * W + rx + i) * 4;
      sr += a * (tgt[ti] - cur[ti] * ia); sg += a * (tgt[ti + 1] - cur[ti + 1] * ia); sb += a * (tgt[ti + 2] - cur[ti + 2] * ia); saa += a * a;
    }
    if (saa < 1e-6) { EV.gain = 0; return EV; }
    var cr = clamp(sr / saa, 0, 255), cg = clamp(sg / saa, 0, 255), cb = clamp(sb / saa, 0, 255), gain = 0;
    if (cmode) { var lm = 0.299 * cr + 0.587 * cg + 0.114 * cb; if (cmode === 1) { cr = cg = cb = lm; } else { var wsc = lm / 232.3; cr = Math.min(255, 255 * wsc); cg = Math.min(255, 226 * wsc); cb = Math.min(255, 205 * wsc); } }
    cr = Math.round(cr); cg = Math.round(cg); cb = Math.round(cb);
    for (j = 0; j < rh; j++) for (i = 0; i < rw; i++) {
      var b8 = mask[j * rw + i]; if (!b8) continue;
      a = b8 / 255; ia = 1 - a; ti = ((ry + j) * W + rx + i) * 4;
      var o0 = cur[ti], o1 = cur[ti + 1], o2 = cur[ti + 2];
      var d0 = o0 - tgt[ti], d1 = o1 - tgt[ti + 1], d2 = o2 - tgt[ti + 2];
      var e0 = o0 + (cr - o0) * a - tgt[ti], e1 = o1 + (cg - o1) * a - tgt[ti + 1], e2 = o2 + (cb - o2) * a - tgt[ti + 2];
      var oA = cur[ti + 3], dA = oA - tgt[ti + 3], eA = oA + (255 - oA) * a - tgt[ti + 3];
      gain += WT0 * (d0 * d0 - e0 * e0) + WT1 * (d1 * d1 - e1 * e1) + WT2 * (d2 * d2 - e2 * e2) + WTA * (dA * dA - eA * eA);
    }
    EV.gain = gain; EV.r = cr; EV.g = cg; EV.b = cb;
    return EV;
  }

  function applyAccept(m) {
    var mask = m.mask, rx = m.rx, ry = m.ry, rw = m.rw, rh = m.rh, c0 = m.fill[0], c1 = m.fill[1], c2 = m.fill[2];
    for (var j = 0; j < rh; j++) for (var i = 0; i < rw; i++) {
      var a8 = mask[j * rw + i]; if (!a8) continue;
      var a = a8 / 255, ti = ((ry + j) * W + rx + i) * 4;
      cur[ti] = cur[ti] + (c0 - cur[ti]) * a;
      cur[ti + 1] = cur[ti + 1] + (c1 - cur[ti + 1]) * a;
      cur[ti + 2] = cur[ti + 2] + (c2 - cur[ti + 2]) * a;
      cur[ti + 3] = cur[ti + 3] + (255 - cur[ti + 3]) * a;
    }
    var body = makeBody(m.shape, m.bx, m.by, m.a, true);
    L.push({ body: body });
    hashAdd(L.length - 1, body);
  }

  // pose helpers: a letter's body is positioned at its centroid, the glyph origin is offset from it
  function bodyAt(shape, X, Y, a, isStatic) {
    var c = Math.cos(a), s = Math.sin(a);
    return makeBody(shape, X + c * shape.cx - s * shape.cy, Y + s * shape.cx + c * shape.cy, a, isStatic);
  }
  // is the glyph-origin pose (X, Y, a) free of overlap with kept letters?
  function poseFree(shape, X, Y, a, hx, hy, tol) {
    var tb = bodyAt(shape, X, Y, a, false), ok = true;
    hashQuery(X - hx, Y - hy, X + hx, Y + hy).forEach(function (i) {
      if (!ok) return;
      var nb = L[i].body, bd = nb.bounds;
      if (bd.max.x < tb.bounds.min.x || bd.min.x > tb.bounds.max.x || bd.max.y < tb.bounds.min.y || bd.min.y > tb.bounds.max.y) return;
      var col = Matter.Collision.collides(tb, nb);
      if (col && (col.collided === undefined || col.collided) && col.depth > tol) ok = false;
    });
    return ok;
  }
  // judge a final pose using the real glyph pixels; returns a result object or null
  function judge(g, job, fx, fy, fa) {
    var acs = Math.abs(Math.cos(fa)), asn = Math.abs(Math.sin(fa));
    var ex = (g.gw / 2 + 2) * acs + (g.gh / 2 + 2) * asn, ey = (g.gw / 2 + 2) * asn + (g.gh / 2 + 2) * acs;
    var rx = Math.max(0, Math.floor(fx - ex)), ry = Math.max(0, Math.floor(fy - ey));
    var rw = Math.min(W, Math.ceil(fx + ex)) - rx, rh = Math.min(H, Math.ceil(fy + ey)) - ry;
    if (rw < 2 || rh < 2) return null;
    var mk = renderMask(g, fx, fy, fa, rx, ry, rw, rh);
    var fe = evalMask(mk.mask, rx, ry, rw, rh);
    if (!(fe.gain > job.strictK * mk.sumA)) return null;
    return { rx: rx, ry: ry, rw: rw, rh: rh, mask: mk.mask, fill: [fe.r, fe.g, fe.b], gain: fe.gain };
  }

  function runJob(job) {
    var size = job.size, ch = job.ch, chaos = job.chaos, k;
    cmode = job.cm | 0;
    var REJ = { st: 'rej', c: job.c, size: size, ch: ch };
    var g = glyphInfo(ch, 'bold ' + size + 'px ' + job.fam);
    var hull = getHull(g, size);
    var shape = hull ? { t: 'h', pts: hull.pts, cx: hull.cx, cy: hull.cy }
                     : { t: 'r', bw: Math.max(g.gw, size * 0.28), bh: Math.max(g.gh, size * 0.28), cx: 0, cy: 0 };

    // 1. look for useful spots and tilts, ignoring collisions
    var cands = [];
    for (k = 0; k < job.tries; k++) {
      var bi = k === 0 ? 0 : Math.round((Math.random() - 0.5) * 2 * chaos * 0.7 / ASTEP);
      var bm = bucket(g, bi), spread = job.G + size * 0.8;
      var X = Math.round(job.cx + (k === 0 ? 0 : (Math.random() - 0.5) * spread));
      var Y = Math.round(job.cy + (k === 0 ? 0 : (Math.random() - 0.5) * spread));
      X = clamp(X, Math.ceil(bm.hx), Math.floor(W - bm.hx)); Y = clamp(Y, Math.ceil(bm.hy), Math.floor(H - bm.hy));
      var ev = evalAt(bm, X, Y);
      if (ev.gain >= 0.4 * job.strictK * bm.sumA) cands.push({ bi: bi, bm: bm, X: X, Y: Y, gain: ev.gain });
    }
    if (!cands.length) return REJ;
    cands.sort(function (p, q) { return q.gain - p.gain; });

    // 2. the best spot that is actually free of kept letters
    var best = null, tol = 0.5 + job.ov * size * 0.4;
    for (k = 0; k < cands.length && k < 6; k++) {
      var cd = cands[k];
      if (poseFree(shape, cd.X, cd.Y, cd.bi * ASTEP, cd.bm.hx, cd.bm.hy, tol)) { best = cd; break; }
    }
    if (!best) return REJ;
    var cx = shape.cx, cy = shape.cy, a0 = best.bi * ASTEP, hx0 = best.bm.hx, hy0 = best.bm.hy;

    // 3. physics: throw the letter in from free space above and let it settle
    var sp = Math.PI * (0.12 + 0.88 * chaos), sx = 0, sy = 0, found = false, tryN;
    for (tryN = 0; tryN < 10 && !found; tryN++) {
      var dist = (size * (0.8 + 1.2 * Math.random()) + 8 + chaos * size * 0.8) * (1 + tryN * 0.25);
      var an = tryN < 4 ? -Math.PI / 2 + (Math.random() - 0.5) * 2 * sp : -Math.PI / 2 + (Math.random() - 0.5) * 2 * Math.PI;
      sx = clamp(best.X + Math.cos(an) * dist, hx0, W - hx0);
      sy = clamp(best.Y + Math.sin(an) * dist, hy0, H - hy0);
      found = isFree(sx - hx0, sy - hy0, sx + hx0, sy + hy0);
    }
    var res = null;
    if (found) {
      for (k = 0; k < inWorld.length; k++) Composite.remove(engine.world, inWorld[k]);
      inWorld = [];
      var pad = size * 2 + 10;
      hashQuery(Math.min(best.X, sx) - pad, Math.min(best.Y, sy) - pad, Math.max(best.X, sx) + pad, Math.max(best.Y, sy) + pad)
        .forEach(function (i) { inWorld.push(L[i].body); });
      var body = bodyAt(shape, sx, sy, a0, false);
      Body.setAngularVelocity(body, (Math.random() - 0.5) * chaos * 0.3);
      inWorld.push(body);
      Composite.add(engine.world, inWorld);

      var traj = job.traj ? [sx, sy, a0] : null;
      var cap = Math.max(2.5, 0.3 * Math.min(size * 0.5, 40));
      var steps = 0, still = 0, lx = body.position.x, ly = body.position.y, cs, sn;
      while (steps < 200) {
        cs = Math.cos(body.angle); sn = Math.sin(body.angle);
        var ox = body.position.x - (cs * cx - sn * cy), oy = body.position.y - (sn * cx + cs * cy);
        var vx = body.velocity.x * 0.9 + (best.X - ox) * 0.006;
        var vy = body.velocity.y * 0.9 + (best.Y - oy) * 0.006 + 0.006;
        var spd = Math.hypot(vx, vy);
        if (spd > cap) { vx *= cap / spd; vy *= cap / spd; }
        Body.setVelocity(body, { x: vx, y: vy });
        Body.setAngularVelocity(body, body.angularVelocity * 0.93);
        Engine.update(engine, 1000 / 60);
        steps++;
        var moved = Math.hypot(body.position.x - lx, body.position.y - ly);
        lx = body.position.x; ly = body.position.y;
        if (moved < 0.05 && Math.abs(body.angularVelocity) < 0.003) still++; else still = 0;
        if (traj && (steps & 1) === 0) {
          cs = Math.cos(body.angle); sn = Math.sin(body.angle);
          traj.push(body.position.x - (cs * cx - sn * cy), body.position.y - (sn * cx + cs * cy), body.angle);
        }
        if (still >= 10 && steps > 20) break;
      }
      // release the spring and let contacts push the letter clear of any overlap
      for (k = 0; k < 24; k++) {
        Body.setVelocity(body, { x: body.velocity.x * 0.5, y: body.velocity.y * 0.5 });
        Body.setAngularVelocity(body, body.angularVelocity * 0.5);
        Engine.update(engine, 1000 / 60);
      }
      var pen = 0;
      for (k = 0; k < inWorld.length - 1; k++) {
        var col = Matter.Collision.collides(body, inWorld[k]);
        if (col && (col.collided === undefined || col.collided) && col.depth > pen) pen = col.depth;
      }
      if (pen <= 1 + 0.05 * size + job.ov * size * 0.4) {
        var fa = body.angle; cs = Math.cos(fa); sn = Math.sin(fa);
        var fx = body.position.x - (cs * cx - sn * cy), fy = body.position.y - (sn * cx + cs * cy);
        var jd = judge(g, job, fx, fy, fa);
        if (jd) {
          if (traj) traj.push(fx, fy, fa);
          res = { x: fx, y: fy, a: fa, bx: body.position.x, by: body.position.y, sx: sx, sy: sy, a0: a0, traj: traj, jd: jd };
        }
      }
    }

    // 4. fallback: the spot was verified free, so place the letter there directly (tight gaps)
    if (!res) {
      var jd2 = judge(g, job, best.X, best.Y, a0);
      if (!jd2) return REJ;
      var c1 = Math.cos(a0), s1 = Math.sin(a0);
      var vsx = clamp(best.X, hx0, W - hx0), vsy = clamp(best.Y - size * 2 - 10, hy0, H - hy0), tj = null;
      if (job.traj) {
        tj = [];
        for (k = 0; k <= 20; k++) { var tt = k / 20, q = tt * tt; tj.push(vsx + (best.X - vsx) * q, vsy + (best.Y - vsy) * q, a0 + (1 - tt) * (Math.random() - 0.5) * chaos * 1.2); }
        tj[tj.length - 1] = a0;
      }
      res = { x: best.X, y: best.Y, a: a0, bx: best.X + c1 * cx - s1 * cy, by: best.Y + s1 * cx + c1 * cy, sx: vsx, sy: vsy, a0: tj ? tj[2] : a0, traj: tj, jd: jd2 };
    }
    var j = res.jd;
    return {
      st: 'acc', c: job.c, size: size, ch: ch, font: g.font, ox: g.ox, oy: g.oy,
      x: res.x, y: res.y, a: res.a, bx: res.bx, by: res.by,
      fill: j.fill, rx: j.rx, ry: j.ry, rw: j.rw, rh: j.rh, mask: j.mask, shape: shape,
      sx: res.sx, sy: res.sy, a0: res.a0, traj: res.traj ? Float32Array.from(res.traj) : null, gain: j.gain
    };
  }

  self.onmessage = function (ev) {
    var m = ev.data;
    if (m.t === 'ping') {
      var ok = false;
      try {
        var c = mkCanvas(16, 16), x = c.getContext('2d', { willReadFrequently: true });
        x.font = 'bold 12px Georgia'; var mm = x.measureText('A'); x.fillText('A', 2, 12); x.getImageData(0, 0, 4, 4);
        ok = typeof mm.actualBoundingBoxAscent === 'number';
      } catch (e) { ok = false; }
      self.postMessage({ t: 'ready', ok: ok });
    } else if (m.t === 'init') {
      epoch = m.epoch; W = m.W; H = m.H; tgt = m.tgt;
      cur = new Uint8ClampedArray(m.cur);
      L = []; hash = new Map(); inWorld = [];
      engine = Engine.create({ enableSleeping: false });
      engine.gravity.x = 0; engine.gravity.y = 0; engine.gravity.scale = 0;
      var T = 400;
      Composite.add(engine.world, [
        Bodies.rectangle(W / 2, -T / 2, W + 2 * T, T, { isStatic: true }),
        Bodies.rectangle(W / 2, H + T / 2, W + 2 * T, T, { isStatic: true }),
        Bodies.rectangle(-T / 2, H / 2, T, H + 2 * T, { isStatic: true }),
        Bodies.rectangle(W + T / 2, H / 2, T, H + 2 * T, { isStatic: true })
      ]);
    } else if (m.t === 'accept') {
      if (m.epoch === epoch) applyAccept(m);
    } else if (m.t === 'jobs') {
      var results = [], transfer = [];
      if (m.epoch === epoch) {
        for (var q = 0; q < m.list.length; q++) {
          var r = runJob(m.list[q]);
          results.push(r);
          if (r.st === 'acc') { transfer.push(r.mask.buffer); if (r.traj) transfer.push(r.traj.buffer); }
        }
      }
      self.postMessage({ t: 'res', epoch: m.epoch, ver: m.ver, results: results }, transfer);
    }
  };
}

