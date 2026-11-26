/*
 * PaperSnap image pipeline. Pure functions over OpenCV.js + RGBA buffers.
 * Loaded by cv-worker.js (browser Web Worker) and by tests/run-pipeline.mjs (Node).
 * Every Mat is deleted in a finally block — Safari crashes fast on leaked wasm memory.
 *
 * Image shape everywhere: { data: Uint8ClampedArray (RGBA), width, height }
 * Quad: [{x,y} TL, TR, BR, BL], normalized 0..1 relative to the source image.
 */
(function (global) {
  'use strict';

  var MAX_SIDE = 4096;
  var FILTERS = ['original', 'enhance', 'gray', 'bw', 'inksaver'];

  function toMat(cv, img) {
    return cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
  }

  function fromMat(cv, mat) {
    var rgba = mat;
    var tmp = null;
    if (mat.channels() === 1) { tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_GRAY2RGBA); rgba = tmp; }
    else if (mat.channels() === 3) { tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_RGB2RGBA); rgba = tmp; }
    var out = { data: new Uint8ClampedArray(rgba.data), width: rgba.cols, height: rgba.rows };
    if (tmp) tmp.delete();
    return out;
  }

  function fullQuad() {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  }

  // Order 4 points TL, TR, BR, BL. Sorting by angle around the centroid can never
  // produce a self-crossing outline (the old sum/difference trick could for tilted pages).
  function orderPoints(pts) {
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p.x / pts.length; cy += p.y / pts.length; });
    var ring = pts.slice().sort(function (a, b) { return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx); });
    // atan2 order with y pointing down = clockwise on screen. Start at the top-left-most point.
    var start = 0;
    for (var i = 1; i < 4; i++) if (ring[i].x + ring[i].y < ring[start].x + ring[start].y) start = i;
    return [ring[start], ring[(start + 1) % 4], ring[(start + 2) % 4], ring[(start + 3) % 4]];
  }

  function polyArea(p) {
    var a = 0;
    for (var i = 0; i < p.length; i++) { var j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; }
    return Math.abs(a) / 2;
  }

  function matToPoints(m) {
    var pts = [];
    for (var i = 0; i < m.rows; i++) pts.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] });
    return pts;
  }

  // Collect every convex 4-corner shape found among a binary map's contours.
  function quadsFromBinary(cv, bin, mode, minArea, out) {
    var contours = new cv.MatVector(), hierarchy = new cv.Mat();
    try {
      cv.findContours(bin, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        if (cv.contourArea(c) < minArea) { c.delete(); continue; }
        var hull = new cv.Mat();
        cv.convexHull(c, hull, false, true);
        var peri = cv.arcLength(hull, true);
        var eps = [0.015, 0.025, 0.04, 0.06];
        for (var k = 0; k < eps.length; k++) {
          var approx = new cv.Mat();
          cv.approxPolyDP(hull, approx, eps[k] * peri, true);
          var ok = approx.rows === 4 && cv.isContourConvex(approx);
          if (ok) out.push(matToPoints(approx));
          approx.delete();
          if (ok) break;
        }
        hull.delete(); c.delete();
      }
    } finally { contours.delete(); hierarchy.delete(); }
  }

  // Fraction of points along each side (corners excluded) that sit on an edge pixel.
  function sideSupport(edges, W, H, q) {
    var d = edges.data, res = [];
    for (var s = 0; s < 4; s++) {
      var a = q[s], b = q[(s + 1) % 4], hit = 0, n = 0;
      for (var t = 0.08; t <= 0.92; t += 0.02) {
        var x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
        n++;
        if (x >= 0 && y >= 0 && x < W && y < H && d[y * W + x]) hit++;
      }
      res.push(hit / n);
    }
    return res;
  }

  function interiorAnglesOk(q) {
    for (var i = 0; i < 4; i++) {
      var p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      var v1x = p.x - c.x, v1y = p.y - c.y, v2x = n.x - c.x, v2y = n.y - c.y;
      var cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
      var deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (deg < 50 || deg > 130) return false;
    }
    return true;
  }

  // A side lying along the picture border is the frame itself, not the paper.
  function onBorder(q, W, H) {
    var m = 0.015;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      if ((a.x < W * m && b.x < W * m) || (a.x > W * (1 - m) && b.x > W * (1 - m)) ||
          (a.y < H * m && b.y < H * m) || (a.y > H * (1 - m) && b.y > H * (1 - m))) return true;
    }
    return false;
  }

  /*
   * Edge detection: downscale → blur → Canny on brightness AND colour (Lab L, a, b) → dilate
   * → findContours → approxPolyDP, plus Otsu segmentation of each channel. Every 4-corner
   * candidate is then checked: sane angles, not the frame border, and each of its four sides
   * must actually run along a detected edge. Largest well-supported shape wins.
   * Colour matters: a green folder on a brown sheet has almost no brightness contrast.
   */
  function detectQuad(cv, img, opts) {
    opts = opts || {};
    var target = opts.maxSide || 500;
    var src = toMat(cv, img);
    var small = new cv.Mat(), rgb = new cv.Mat(), lab = new cv.Mat(), chans = new cv.MatVector();
    var edges = new cv.Mat(), tmp = new cv.Mat(), support = new cv.Mat(), dil = new cv.Mat(), bin = new cv.Mat();
    var k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    var k5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    var blurred = [];
    try {
      var scale = Math.min(1, target / Math.max(img.width, img.height));
      cv.resize(src, small, new cv.Size(Math.round(img.width * scale), Math.round(img.height * scale)), 0, 0, cv.INTER_AREA);
      cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      cv.split(lab, chans);
      var W = small.cols, H = small.rows, frame = W * H, minArea = frame * 0.1;

      // Edge map from brightness + both colour axes.
      edges.create(H, W, cv.CV_8UC1); edges.setTo(new cv.Scalar(0));
      var cannyTh = [[30, 90], [12, 36], [12, 36]];
      for (var c = 0; c < 3; c++) {
        var b = new cv.Mat();
        cv.GaussianBlur(chans.get(c), b, new cv.Size(5, 5), 0);
        blurred.push(b);
        cv.Canny(b, tmp, cannyTh[c][0], cannyTh[c][1]);
        cv.bitwise_or(edges, tmp, edges);
      }
      cv.dilate(edges, support, k3, new cv.Point(-1, -1), 2); // tolerance for side checks

      var cands = [];
      cv.dilate(edges, dil, k3, new cv.Point(-1, -1), 1);
      quadsFromBinary(cv, dil, cv.RETR_LIST, minArea, cands);
      // Region pass: paper usually differs from the surface in brightness or colour.
      for (var ch = 0; ch < 3; ch++) {
        for (var inv = 0; inv < 2; inv++) {
          cv.threshold(blurred[ch], bin, 0, 255, (inv ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU);
          cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k5, new cv.Point(-1, -1), 1);
          cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k5, new cv.Point(-1, -1), 2);
          quadsFromBinary(cv, bin, cv.RETR_EXTERNAL, minArea, cands);
        }
      }

      var best = null, bestScore = 0;
      for (var i = 0; i < cands.length; i++) {
        var q = orderPoints(cands[i]);
        var area = polyArea(q);
        var sup = sideSupport(support, W, H, q);
        if (opts.debug) opts.debug.push({ cov: +(area / frame).toFixed(2), ang: interiorAnglesOk(q), border: onBorder(q, W, H), sup: sup.map(function (v) { return +v.toFixed(2); }), q: q.map(function (p) { return [p.x, p.y]; }) });
        if (area < minArea || area > frame * 0.95) continue;
        if (!interiorAnglesOk(q) || onBorder(q, W, H)) continue;
        // One side may be weak (in shadow, under a finger, running off the picture);
        // the other three must clearly follow real edges.
        var sorted = sup.slice().sort(function (a, b) { return b - a; });
        var meanSup = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
        if (sorted[2] < 0.65 || meanSup < 0.7) continue;
        var score = Math.sqrt(area / frame) * meanSup * meanSup * (0.5 + sorted[2]);
        if (score > bestScore) { bestScore = score; best = { q: q, area: area }; }
      }
      if (!best) return { found: false, quad: fullQuad() };
      var quad = best.q.map(function (p) { return { x: clamp01(p.x / W), y: clamp01(p.y / H) }; });
      return { found: true, quad: quad, coverage: best.area / frame, score: bestScore };
    } finally {
      src.delete(); small.delete(); rgb.delete(); lab.delete(); chans.delete();
      edges.delete(); tmp.delete(); support.delete(); dil.delete(); bin.delete(); k3.delete(); k5.delete();
      blurred.forEach(function (m) { m.delete(); });
    }
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* Perspective-correct at source resolution. aspect: 'auto' follows the quad, 'a4' forces 1:√2. */
  function warp(cv, img, quad, opts) {
    opts = opts || {};
    var maxSide = Math.min(opts.maxSide || MAX_SIDE, MAX_SIDE);
    var p = quad.map(function (q) { return { x: q.x * img.width, y: q.y * img.height }; });
    var w = Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
    var h = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
    if (opts.aspect === 'a4') {
      if (h >= w) w = h / Math.SQRT2; else h = w / Math.SQRT2;
    }
    var s = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(16, Math.round(w * s)); h = Math.max(16, Math.round(h * s));

    var src = toMat(cv, img), dst = new cv.Mat();
    var sp = cv.matFromArray(4, 1, cv.CV_32FC2, [p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y]);
    var dp = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    var M = cv.getPerspectiveTransform(sp, dp);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      return fromMat(cv, dst);
    } finally { src.delete(); dst.delete(); sp.delete(); dp.delete(); M.delete(); }
  }

  function rotate(cv, img, quarterTurns) {
    var q = ((quarterTurns % 4) + 4) % 4;
    if (!q) return img;
    var src = toMat(cv, img), dst = new cv.Mat();
    try {
      var code = q === 1 ? cv.ROTATE_90_CLOCKWISE : q === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
      cv.rotate(src, dst, code);
      return fromMat(cv, dst);
    } finally { src.delete(); dst.delete(); }
  }

  // Percentile from a 256-bin histogram.
  function pct(hist, total, p) {
    var target = total * p, acc = 0;
    for (var i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  }

  function stretchLut(lo, hi, gamma) {
    var lut = new Uint8ClampedArray(256);
    var range = Math.max(1, hi - lo);
    for (var i = 0; i < 256; i++) {
      var v = (i - lo) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      lut[i] = Math.round(Math.pow(v, gamma || 1) * 255);
    }
    return lut;
  }

  /* Background field (paper + lighting + shadows) of a gray Mat, at full size. Caller deletes. */
  function estimateBackground(cv, gray) {
    var W = gray.cols, H = gray.rows;
    var s = Math.min(1, 800 / Math.max(W, H));
    var small = new cv.Mat(), bg = new cv.Mat(), bgFull = new cv.Mat();
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    try {
      cv.resize(gray, small, new cv.Size(Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))), 0, 0, cv.INTER_AREA);
      cv.dilate(small, bg, k, new cv.Point(-1, -1), 2);   // erase dark text strokes
      cv.medianBlur(bg, bg, 21);                         // smooth into a lighting field
      cv.resize(bg, bgFull, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      return bgFull;
    } finally { small.delete(); bg.delete(); k.delete(); }
  }

  /* Shadow-free gray: gray / background. Caller deletes. */
  function flattenShadows(cv, gray) {
    var bg = estimateBackground(cv, gray), flat = new cv.Mat();
    try { cv.divide(gray, bg, flat, 255, -1); return flat; } finally { bg.delete(); }
  }

  /* Enhanced colour: relight by the background field (removes shadows and colour cast = white balance),
     then per-channel contrast stretch and a mild saturation boost. */
  function enhance(cv, img) {
    var src = toMat(cv, img), gray = new cv.Mat(), bg = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      bg = estimateBackground(cv, gray);
      var d = img.data, b = bg.data, n = d.length / 4;
      var relit = new Uint8ClampedArray(d.length);
      for (var i = 0, o = 0; i < n; i++, o += 4) {
        var g = 240 / Math.max(b[i], 16); if (g > 4) g = 4; if (g < 1) g = 1;
        relit[o] = d[o] * g; relit[o + 1] = d[o + 1] * g; relit[o + 2] = d[o + 2] * g; relit[o + 3] = 255;
      }
      var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
      var step = Math.max(1, Math.floor(n / 250000)), count = 0;
      for (var j = 0; j < n; j += step) { var q = j * 4; hr[relit[q]]++; hg[relit[q + 1]]++; hb[relit[q + 2]]++; count++; }
      var lr = stretchLut(pct(hr, count, 0.01), pct(hr, count, 0.97), 1.1);
      var lg = stretchLut(pct(hg, count, 0.01), pct(hg, count, 0.97), 1.1);
      var lb = stretchLut(pct(hb, count, 0.01), pct(hb, count, 0.97), 1.1);
      for (var k = 0; k < relit.length; k += 4) {
        var r = lr[relit[k]], gg = lg[relit[k + 1]], bb = lb[relit[k + 2]];
        var y = 0.299 * r + 0.587 * gg + 0.114 * bb;
        relit[k] = y + (r - y) * 1.2; relit[k + 1] = y + (gg - y) * 1.2; relit[k + 2] = y + (bb - y) * 1.2;
      }
      return { data: relit, width: img.width, height: img.height };
    } finally { src.delete(); gray.delete(); if (bg) bg.delete(); }
  }

  function grayStretch(cv, gray) {
    // In-place-ish contrast stretch on a gray Mat via JS LUT.
    var d = gray.data, hist = new Uint32Array(256), step = Math.max(1, Math.floor(d.length / 250000)), c = 0;
    for (var i = 0; i < d.length; i += step) { hist[d[i]]++; c++; }
    var lut = stretchLut(pct(hist, c, 0.01), pct(hist, c, 0.99), 1);
    for (var j = 0; j < d.length; j++) d[j] = lut[d[j]];
  }

  function documentBW(cv, img, light) {
    var src = toMat(cv, img), gray = new cv.Mat(), bin = new cv.Mat(), flat = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      flat = flattenShadows(cv, gray);
      cv.GaussianBlur(flat, flat, new cv.Size(3, 3), 0);  // tame sensor noise (low light)
      var minSide = Math.min(img.width, img.height);
      var block = Math.max(15, Math.round(minSide / 45)) | 1;
      cv.adaptiveThreshold(flat, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, light ? 18 : 12);
      cv.medianBlur(bin, bin, 3); // speckle clean-up
      // Paper edges / leftover desk at the border read as black bars — whiten a thin margin.
      var m = Math.max(2, Math.round(minSide * 0.006));
      cv.rectangle(bin, new cv.Point(0, 0), new cv.Point(bin.cols - 1, bin.rows - 1), new cv.Scalar(255), m);
      if (light) {
        var b = bin.data;
        for (var i = 0; i < b.length; i++) if (b[i] < 128) b[i] = 120; // lighter ink
      }
      return fromMat(cv, bin);
    } finally { src.delete(); gray.delete(); bin.delete(); if (flat) flat.delete(); }
  }

  function grayscale(cv, img) {
    var src = toMat(cv, img), gray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      grayStretch(cv, gray);
      return fromMat(cv, gray);
    } finally { src.delete(); gray.delete(); }
  }

  function applyFilter(cv, img, filter) {
    switch (filter) {
      case 'enhance': return enhance(cv, img);
      case 'gray': return grayscale(cv, img);
      case 'bw': return documentBW(cv, img, false);
      case 'inksaver': return documentBW(cv, img, true);
      default: return img;
    }
  }

  /* Whole page: warp → filter → rotate. */
  function processPage(cv, img, opts) {
    var warped = warp(cv, img, opts.quad || fullQuad(), { aspect: opts.aspect, maxSide: opts.maxSide });
    var filtered = applyFilter(cv, warped, opts.filter || 'original');
    return rotate(cv, filtered, opts.rotation || 0);
  }

  function resizeImg(cv, img, maxSide) {
    var s = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (s >= 1) return img;
    var src = toMat(cv, img), dst = new cv.Mat();
    try {
      cv.resize(src, dst, new cv.Size(Math.round(img.width * s), Math.round(img.height * s)), 0, 0, cv.INTER_AREA);
      return fromMat(cv, dst);
    } finally { src.delete(); dst.delete(); }
  }

  var api = {
    FILTERS: FILTERS, MAX_SIDE: MAX_SIDE,
    detectQuad: detectQuad, warp: warp, rotate: rotate, applyFilter: applyFilter,
    processPage: processPage, _debug: function (cv, img) { var d = []; detectQuad(cv, img, { maxSide: 360, debug: d }); return d; }, resizeImg: resizeImg, fullQuad: fullQuad, orderPoints: orderPoints
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PaperSnapProc = api;
})(typeof self !== 'undefined' ? self : globalThis);
